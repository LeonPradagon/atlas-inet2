import { BadRequestException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { Database } from '../database/database'
import { NetworkImportService } from '../network/network-import.service'
import { GeocodingService, type StructuredAddress } from '../geospatial/geocoding.service'
import { RoutingService } from '../geospatial/routing.service'
import { AtlasService } from './atlas.service'

type InputRow = { row: number; address: string; latitude: number | null; longitude: number | null; structured?: StructuredAddress; inputError?: string }

@Injectable()
export class BulkAnalysisService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout
  private activeWorkers = 0
  // ponytail: two rows per process; raise only after measuring Photon, GraphHopper, and database capacity.
  private readonly maxConcurrentRows = 2
  private lastRecoveryAt = 0

  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(NetworkImportService) private readonly imports: NetworkImportService,
    @Inject(GeocodingService) private readonly geocoding: GeocodingService,
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(AtlasService) private readonly atlas: AtlasService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.workOne(), 500)
    this.timer.unref()
    void this.workOne()
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer) }

  async create(userId: string, fileName: string, buffer: Buffer) {
    if (!/\.xlsx$/i.test(fileName)) throw new BadRequestException({ message: 'Pilih file Excel .xlsx.' })
    const rows = await this.imports.analyzeWorkbook(buffer, { maxBytes: 15 * 1024 * 1024, maxRows: 5000 }) as InputRow[]
    const jobId = randomUUID()
    const historyId = await this.db.transaction(async (client) => {
      const { rows: history } = await client.query(`INSERT INTO analysis_history(user_id,analysis_type,title,input,result)
        VALUES($1,'BULK',$2,$3::jsonb,$4::jsonb) RETURNING id`, [userId,fileName.slice(0,300),JSON.stringify({ fileName, bulkJobId: jobId, rowCount: rows.length }),JSON.stringify({ status: 'QUEUED', jobId, rows: [] })])
      const id = history[0].id as string
      await client.query(`INSERT INTO analysis_bulk_jobs(id,user_id,history_id,file_name,total_rows) VALUES($1,$2,$3,$4,$5)`, [jobId,userId,id,fileName.slice(0,300),rows.length])
      await client.query(`INSERT INTO analysis_bulk_job_rows(job_id,row_number,input,status,error_message,processed_at)
        SELECT $1,x.row,x.input::jsonb,CASE WHEN x.input->>'inputError' IS NULL THEN 'QUEUED' ELSE 'ERROR' END,
          x.input->>'inputError',CASE WHEN x.input->>'inputError' IS NULL THEN NULL ELSE now() END
        FROM jsonb_to_recordset($2::jsonb) AS x(row integer,input jsonb)`, [jobId,JSON.stringify(rows.map((row) => ({ row: row.row, input: row })))])
      const invalid = rows.filter((row) => row.inputError).length
      if (invalid) {
        await client.query(`UPDATE analysis_bulk_jobs SET processed_rows=$2::integer,failed_rows=$2::integer,status=CASE WHEN $2::integer=$3::integer THEN 'COMPLETED_WITH_ERRORS' ELSE 'QUEUED' END WHERE id=$1`, [jobId,invalid,rows.length])
        if (invalid === rows.length) await client.query("UPDATE analysis_history SET result=jsonb_set(result,'{status}','\"COMPLETED_WITH_ERRORS\"'::jsonb,true) WHERE id=$1", [id])
      }
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'BULK_ANALYSIS_QUEUED','ANALYSIS_BULK_JOB',$2,$3::jsonb)`, [userId,jobId,JSON.stringify({ fileName, rowCount: rows.length })])
      return id
    })
    return this.progress(userId, jobId).then((progress) => ({ ...progress, historyId }))
  }

  async progress(userId: string, jobId: string) {
    const { rows } = await this.db.query(`SELECT j.id AS "jobId",j.history_id AS "historyId",j.file_name AS "fileName",j.status,
      j.total_rows AS total,j.processed_rows AS processed,j.succeeded_rows AS succeeded,j.failed_rows AS failed,
      j.cancel_requested_at IS NOT NULL AS "cancelRequested",j.created_at AS "createdAt",j.updated_at AS "updatedAt",
      ARRAY(SELECT DISTINCT (d.input->>'sourceRow')::integer
        FROM analysis_history d
        WHERE d.user_id=j.user_id AND d.analysis_type='FTTH_DESIGN'
          AND d.input->>'sourceAnalysisId'=j.history_id::text
          AND COALESCE(d.input->>'sourceRow','') ~ '^[1-9][0-9]*$'
        ORDER BY 1) AS "savedDraftRows"
      FROM analysis_bulk_jobs j WHERE j.id=$1 AND j.user_id=$2`, [jobId,userId])
    if (!rows[0]) throw new NotFoundException({ message: 'Pekerjaan analisis tidak ditemukan.' })
    return rows[0]
  }

  async page(userId: string, jobId: string, page = 1, pageSize = 50, search = '', status = '') {
    await this.progress(userId, jobId)
    const safePage = Math.max(1, Math.floor(page) || 1)
    const safeSize = Math.max(1, Math.min(100, Math.floor(pageSize) || 50))
    const { rows: items } = await this.db.query(`SELECT row_number AS row,input->>'address' AS address,
      COALESCE(NULLIF(result->>'latitude','')::double precision,NULLIF(input->>'latitude','')::double precision) AS latitude,
      COALESCE(NULLIF(result->>'longitude','')::double precision,NULLIF(input->>'longitude','')::double precision) AS longitude,
      result->'network' AS network,NULLIF(result->>'distanceMeters','')::double precision AS "distanceMeters",
      COALESCE(result->>'status',status) AS status,COALESCE(error_message,result->>'message') AS message,result
      FROM analysis_bulk_job_rows WHERE job_id=$1 AND ($2='' OR input->>'address' ILIKE '%'||$2||'%') AND ($3='' OR ($3='ERROR' AND status='ERROR') OR COALESCE(result->>'status',status)=$3)
      ORDER BY row_number LIMIT $4 OFFSET $5`, [jobId,search.trim().slice(0,200),status, safeSize, (safePage - 1) * safeSize])
    const { rows: count } = await this.db.query(`SELECT count(*)::int AS total FROM analysis_bulk_job_rows WHERE job_id=$1 AND ($2='' OR input->>'address' ILIKE '%'||$2||'%') AND ($3='' OR ($3='ERROR' AND status='ERROR') OR COALESCE(result->>'status',status)=$3)`, [jobId,search.trim().slice(0,200),status])
    return { rows: items, page: safePage, pageSize: safeSize, total: count[0].total }
  }

  async mapPoints(userId: string, jobId: string) {
    await this.progress(userId,jobId)
    const { rows } = await this.db.query(`SELECT row_number AS row,input->>'address' AS address,
      COALESCE(NULLIF(result->>'latitude','')::double precision,NULLIF(input->>'latitude','')::double precision) AS latitude,
      COALESCE(NULLIF(result->>'longitude','')::double precision,NULLIF(input->>'longitude','')::double precision) AS longitude,
      COALESCE(result->>'status',status) AS status FROM analysis_bulk_job_rows WHERE job_id=$1 ORDER BY row_number`, [jobId])
    return rows.filter((row) => row.latitude != null && row.longitude != null)
  }

  async cancel(userId: string, jobId: string) {
    await this.db.transaction(async (client) => {
      const { rows } = await client.query(`UPDATE analysis_bulk_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,now()),updated_at=now()
        WHERE id=$1 AND user_id=$2 AND status IN ('QUEUED','RUNNING') RETURNING id`, [jobId,userId])
      if (rows.length) await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'BULK_ANALYSIS_CANCEL_REQUESTED','ANALYSIS_BULK_JOB',$2,'{}'::jsonb)`, [userId,jobId])
    })
    return this.progress(userId,jobId)
  }

  private async workOne() {
    if (this.activeWorkers >= this.maxConcurrentRows) return
    this.activeWorkers += 1
    try {
      if (Date.now() - this.lastRecoveryAt > 15_000) {
        this.lastRecoveryAt = Date.now()
        await this.recoverStaleRows()
      }
      const claim = await this.db.transaction(async (client) => {
        const { rows } = await client.query(`WITH candidate AS (
          SELECT r.id,r.job_id,r.row_number,r.input,j.user_id,j.history_id
          FROM analysis_bulk_job_rows r JOIN analysis_bulk_jobs j ON j.id=r.job_id
          WHERE r.status='QUEUED' AND j.cancel_requested_at IS NULL
          ORDER BY r.row_number,j.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED
        ) UPDATE analysis_bulk_job_rows r SET status='PROCESSING',attempts=attempts+1,processing_started_at=now()
          FROM candidate c WHERE r.id=c.id
          RETURNING r.id,r.attempts,c.job_id,c.row_number,c.input,c.user_id,c.history_id`)
        if (!rows[0]) {
          await client.query(`UPDATE analysis_bulk_job_rows r SET status='CANCELLED',error_message='Pekerjaan dibatalkan sebelum baris diproses.',processed_at=now()
            FROM analysis_bulk_jobs j WHERE r.job_id=j.id AND j.cancel_requested_at IS NOT NULL AND r.status='QUEUED'`)
          await client.query(`UPDATE analysis_bulk_jobs j SET status=CASE WHEN j.cancel_requested_at IS NOT NULL THEN 'CANCELLED'
            WHEN EXISTS(SELECT 1 FROM analysis_bulk_job_rows r WHERE r.job_id=j.id AND r.status='QUEUED') THEN 'QUEUED'
            WHEN EXISTS(SELECT 1 FROM analysis_bulk_job_rows r WHERE r.job_id=j.id AND r.status='PROCESSING') THEN 'RUNNING'
            WHEN j.failed_rows>0 THEN 'COMPLETED_WITH_ERRORS' ELSE 'COMPLETED' END,updated_at=now()
            WHERE j.status IN ('QUEUED','RUNNING') AND NOT EXISTS(SELECT 1 FROM analysis_bulk_job_rows r WHERE r.job_id=j.id AND r.status='PROCESSING')`)
          await client.query(`UPDATE analysis_history h SET result=jsonb_set(h.result,'{status}',to_jsonb(j.status),true)
            FROM analysis_bulk_jobs j WHERE h.id=j.history_id AND j.status IN ('COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED','FAILED')`)
          return null
        }
        await client.query(`UPDATE analysis_bulk_jobs SET status='RUNNING',updated_at=now() WHERE id=$1`, [rows[0].job_id])
        return rows[0]
      })
      if (!claim) return
      const input = claim.input as InputRow
      let result: Record<string, unknown>
      try {
        let longitude = input.longitude, latitude = input.latitude
        let geocodingProvider: string | undefined, geocodingMatch: string | undefined, matchedStreet: string | undefined
        if (longitude === null || latitude === null) {
          const geocoded = await this.geocoding.geocodeStructured(input.structured ?? { street: input.address })
          ;[longitude, latitude] = geocoded.coordinates
          geocodingProvider = geocoded.provider; geocodingMatch = geocoded.matchQuality; matchedStreet = geocoded.matchedStreet
        }
        const nearest = await this.atlas.nearestNetwork(longitude!,latitude!)
        if (!nearest?.nearestPoint?.coordinates) result = { address: input.address, longitude, latitude, network: nearest ?? null, distanceMeters: null, status: 'NETWORK_NOT_FOUND', geocodingProvider, geocodingMatch, matchedStreet }
        else {
          try {
            const route = await this.routing.preview([[longitude!,latitude!], nearest.nearestPoint.coordinates as [number,number]])
            result = { address: input.address, longitude, latitude, network: nearest, distanceMeters: route.distanceMeters, routeGeometry: route.geometry, status: 'OK', geocodingProvider, geocodingMatch, matchedStreet }
          } catch { result = { address: input.address, longitude, latitude, network: nearest, distanceMeters: null, status: 'ROUTING_UNAVAILABLE', message: 'Rute jalan belum tersedia; jarak penarikan tidak ditampilkan.', geocodingProvider, geocodingMatch, matchedStreet } }
        }
        await this.finishRow(claim, result, result.status === 'OK' ? 'OK' : 'ERROR')
      } catch (error) {
        const response = error && typeof error === 'object' && 'getResponse' in error ? (error as { getResponse(): unknown }).getResponse() : null
        const payload = response && typeof response === 'object' ? response as { code?: string; message?: string } : {}
        const message = typeof payload.message === 'string' ? payload.message : error instanceof Error ? error.message : 'Lokasi tidak dapat dianalisis.'
        await this.finishRow(claim, { address: input.address, latitude: input.latitude, longitude: input.longitude, status: payload.code ?? 'ANALYSIS_FAILED', message }, 'ERROR')
      }
    } catch (error) { console.error('Bulk analysis worker failed', error) }
    finally { this.activeWorkers -= 1 }
  }

  private async recoverStaleRows() {
    await this.db.transaction(async (client) => {
      await client.query(`UPDATE analysis_bulk_job_rows SET status='QUEUED',processing_started_at=NULL
        WHERE status='PROCESSING' AND attempts<3 AND processing_started_at<now()-interval '2 minutes'`)
      await client.query(`WITH failed AS (
          UPDATE analysis_bulk_job_rows SET status='ERROR',result='{"status":"ANALYSIS_INTERRUPTED","message":"Worker berhenti sebelum baris selesai diproses."}'::jsonb,
            error_message='Worker berhenti sebelum baris selesai diproses.',processed_at=now(),processing_started_at=NULL
          WHERE status='PROCESSING' AND attempts>=3 AND processing_started_at<now()-interval '2 minutes' RETURNING job_id
        ), counts AS (SELECT job_id,count(*)::integer AS amount FROM failed GROUP BY job_id)
        UPDATE analysis_bulk_jobs j SET processed_rows=processed_rows+c.amount,failed_rows=failed_rows+c.amount,updated_at=now()
        FROM counts c WHERE j.id=c.job_id`)
    })
  }

  private async finishRow(claim: { id: string; attempts: number; job_id: string; row_number: number; history_id: string; user_id: string }, result: Record<string, unknown>, status: 'OK' | 'ERROR') {
    await this.db.transaction(async (client) => {
      const retryable = status === 'ERROR' && claim.attempts < 3 && ['GEOCODING_UNAVAILABLE','SERVICE_UNAVAILABLE','ROUTING_UNAVAILABLE'].includes(String(result.status))
      if (retryable) {
        await client.query(`UPDATE analysis_bulk_job_rows SET status='QUEUED',result=$2::jsonb,error_message=$3,processing_started_at=NULL WHERE id=$1`, [claim.id,JSON.stringify(result),result.message ?? result.status])
        await client.query(`UPDATE analysis_bulk_jobs SET status='QUEUED',updated_at=now() WHERE id=$1`, [claim.job_id])
        return
      }
      await client.query(`UPDATE analysis_bulk_job_rows SET status=$2,result=$3::jsonb,error_message=$4,processed_at=now(),processing_started_at=NULL WHERE id=$1`, [claim.id,status,JSON.stringify(result),status === 'ERROR' ? result.message ?? result.status : null])
      await client.query(`UPDATE analysis_bulk_jobs SET processed_rows=processed_rows+1,succeeded_rows=succeeded_rows+$2,failed_rows=failed_rows+$3,updated_at=now() WHERE id=$1`, [claim.job_id,status === 'OK' ? 1 : 0,status === 'ERROR' ? 1 : 0])
      await client.query(`UPDATE analysis_history SET result=jsonb_set(result,'{status}',to_jsonb((SELECT status FROM analysis_bulk_jobs WHERE id=$1)),true) WHERE id=$2`, [claim.job_id,claim.history_id])
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'BULK_ANALYSIS_ROW_COMPLETED','ANALYSIS_BULK_JOB',$2,$3::jsonb)`, [claim.user_id,claim.job_id,JSON.stringify({ row: claim.row_number, status })])
    })
  }
}
