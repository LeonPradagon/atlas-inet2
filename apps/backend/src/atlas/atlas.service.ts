import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Database } from '../database/database'

type AssetRecord = {
  id: string; name: string; area: string; assetType: string; source: string; cableType: string; installation: string; side: string;
  pole: string; poleHeight: string | null; odc: string; odp: string; totalCores: number; usedCores: number; bookedCores: number; idleCores: number;
  geometry: unknown; attributes: Record<string, unknown>; createdAt: string
}

@Injectable()
export class AtlasService implements OnModuleInit, OnModuleDestroy {
  private expiryTimer?: NodeJS.Timeout
  constructor(@Inject(Database) private readonly db: Database) {}

  private async audit(client: PoolClient, actorId: string | null, action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) {
    await client.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)', [actorId,action,entityType,entityId,JSON.stringify(details)])
  }

  async saveAnalysisHistory(userId: string, type: 'ADDRESS' | 'BULK', title: string, input: unknown, result: unknown) {
    const { rows } = await this.db.query(`INSERT INTO analysis_history(user_id,analysis_type,title,input,result)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
      RETURNING id,analysis_type AS "analysisType",title,created_at AS "createdAt"`,
    [userId, type, title.slice(0, 300), JSON.stringify(input), JSON.stringify(result)])
    return rows[0].id as string
  }

  async listAnalysisHistory(userId: string, type?: 'ADDRESS' | 'BULK' | 'FTTH_DESIGN') {
    const { rows } = await this.db.query(`SELECT id,analysis_type AS "analysisType",title,
      result->>'status' AS status,
      CASE WHEN analysis_type='BULK' THEN jsonb_array_length(COALESCE(result->'rows','[]'::jsonb))
           WHEN analysis_type='FTTH_DESIGN' THEN COALESCE((result->>'savedCount')::int,0)
           ELSE 1 END AS "itemCount",
      created_at AS "createdAt"
      FROM analysis_history WHERE user_id=$1 AND ($2::text IS NULL OR analysis_type=$2)
      ORDER BY created_at DESC LIMIT 200`, [userId, type ?? null])
    return rows
  }

  async getAnalysisHistory(userId: string, id: string) {
    const { rows } = await this.db.query(`SELECT id,analysis_type AS "analysisType",title,input,result,created_at AS "createdAt"
      FROM analysis_history WHERE user_id=$1 AND id=$2`, [userId, id])
    if (!rows[0]) throw new NotFoundException({ message: 'Riwayat analisis tidak ditemukan.' })
    if (rows[0].analysisType !== 'BULK') return rows[0]
    const { rows: drafts } = await this.db.query(`SELECT id,title,input,result,created_at AS "createdAt"
      FROM analysis_history WHERE user_id=$1 AND analysis_type='FTTH_DESIGN' AND input->>'sourceAnalysisId'=$2
      ORDER BY created_at`, [userId, id])
    return { ...rows[0], relatedDrafts: drafts }
  }

  async deleteAnalysisHistory(userId: string, id: string) {
    const { rowCount } = await this.db.query('DELETE FROM analysis_history WHERE user_id=$1 AND id=$2', [userId, id])
    if (!rowCount) throw new NotFoundException({ message: 'Riwayat analisis tidak ditemukan.' })
  }

  async listAuditTrails(search = '', limit = 100) {
    const { rows } = await this.db.query(`SELECT l.id,l.action,l.entity_type AS "entityType",l.entity_id AS "entityId",l.details,
      l.created_at AS "createdAt",u.name AS "actorName",u.email AS "actorEmail"
      FROM audit_logs l LEFT JOIN "user" u ON u.id=l.actor_id
      WHERE $1='' OR l.action ILIKE '%'||$1||'%' OR l.entity_type ILIKE '%'||$1||'%' OR l.entity_id ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%'
      ORDER BY l.created_at DESC,l.id DESC LIMIT $2`, [search.trim(), Math.max(1, Math.min(250, limit))])
    return rows
  }

  onModuleInit() {
    this.expiryTimer = setInterval(() => void this.expireBookings().catch((error) => console.error('Booking expiry failed', error)), 60_000)
    this.expiryTimer.unref()
  }
  onModuleDestroy() { if (this.expiryTimer) clearInterval(this.expiryTimer) }

  async listAssets(search = '') {
    const { rows } = await this.db.query<AssetRecord>(`SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      GeometryType(a.geometry) AS "geometryType",NULL::jsonb AS geometry,a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE $1='' OR a.name ILIKE '%'||$1||'%' OR a.area ILIKE '%'||$1||'%'
      GROUP BY a.id ORDER BY a.name`, [search])
    const pattern = new RegExp((await this.getCableNamePattern()).pattern)
    return rows.map((asset) => ({ ...asset, nameValid: pattern.test(asset.name) }))
  }

  async listMapAssets(bounds: [number, number, number, number]) {
    const { rows } = await this.db.query<AssetRecord>(`SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      COALESCE(a.source_geometry,ST_AsGeoJSON(a.geometry)::jsonb) AS geometry,GeometryType(a.geometry) AS "geometryType",a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.geometry && ST_MakeEnvelope($1,$2,$3,$4,4326)
        AND ST_Intersects(a.geometry,ST_MakeEnvelope($1,$2,$3,$4,4326))
      GROUP BY a.id ORDER BY a.name`, bounds)
    const pattern = new RegExp((await this.getCableNamePattern()).pattern)
    return rows.map((asset) => ({ ...asset, nameValid: pattern.test(asset.name) }))
  }

  async createPointAsset(body: { name?: unknown; kind?: unknown; longitude?: unknown; latitude?: unknown; area?: unknown; poleHeight?: unknown }, userId: string) {
    const kinds = ['OLT', 'JOINT_CLOSURE', 'HANDHOLE', 'ODC', 'ODP', 'POLE']
    const kind = typeof body.kind === 'string' ? body.kind : ''
    const longitude = body.longitude
    const latitude = body.latitude
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const area = typeof body.area === 'string' ? body.area.trim() : ''
    const poleHeight = body.poleHeight === '7 m' || body.poleHeight === '9 m' ? body.poleHeight : null
    if (!kinds.includes(kind)) throw new BadRequestException({ message: 'Jenis aset FTTH tidak valid.' })
    if (kind === 'POLE' && !poleHeight) throw new BadRequestException({ message: 'Tinggi tiang harus 7 m atau 9 m.' })
    if (!name || name.length > 150) throw new BadRequestException({ message: 'Nama aset wajib diisi, maksimal 150 karakter.' })
    if (area.length > 300) throw new BadRequestException({ message: 'Wilayah maksimal 300 karakter.' })
    if (typeof longitude !== 'number' || typeof latitude !== 'number' || !Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new BadRequestException({ message: 'Koordinat aset tidak valid.' })
    const id = randomUUID()
    const category = kind === 'JOINT_CLOSURE' ? 'JC' : kind === 'HANDHOLE' ? 'HANDHOLE' : kind
    const attributes = { folderPath: `FTTH / ${category}`, assetKind: kind, source: 'address-analysis' }
    await this.db.transaction(async (client) => {
      await client.query(`INSERT INTO network_assets(id,name,asset_type,source,area,cable_type,installation,road_side,pole,pole_height,attributes,geometry,source_geometry)
        VALUES($1,$2,'asset','managed',$3,'Fiber Optic','Aerial','Kiri',$4,$5,$6::jsonb,ST_SetSRID(ST_MakePoint($7,$8),4326),$9::jsonb)`,
      [id,name,area,kind === 'POLE' ? name : '',poleHeight,JSON.stringify(attributes),longitude,latitude,JSON.stringify({ type: 'Point', coordinates: [longitude,latitude] })])
      await this.audit(client,userId,'FTTH_ASSET_CREATED','ASSET',id,{ kind,longitude,latitude,area,poleHeight })
    })
    return { id,name,kind,area,longitude,latitude,poleHeight }
  }

  async saveFtthDesign(input: unknown, userId: string, areaInput: unknown, sourceInput?: { analysisId?: unknown; row?: unknown }) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 500) throw new BadRequestException({ message: 'Desain harus memiliki 1–500 fitur.' })
    const area = typeof areaInput === 'string' ? areaInput.trim() : ''
    if (area.length > 300) throw new BadRequestException({ message: 'Wilayah maksimal 300 karakter.' })
    const sourceAnalysisId = typeof sourceInput?.analysisId === 'string' ? sourceInput.analysisId : ''
    const sourceRow = Number(sourceInput?.row)
    if ((sourceAnalysisId && (!Number.isInteger(sourceRow) || sourceRow < 1)) || (!sourceAnalysisId && sourceInput?.row !== undefined)) throw new BadRequestException({ message: 'Asal draft analisis massal tidak valid.' })
    const kinds = ['OLT','JOINT_CLOSURE','HANDHOLE','ODC','ODP','POLE','ROUTE']
    const designId = randomUUID()
    const features = input.map((value) => {
      if (!value || typeof value !== 'object') throw new BadRequestException({ message: 'Fitur desain tidak valid.' })
      const feature = value as { kind?: unknown; name?: unknown; poleHeight?: unknown; routeType?: unknown; geometry?: unknown }
      const kind = String(feature.kind ?? '')
      const name = String(feature.name ?? '').trim()
      const poleHeight = feature.poleHeight === '7 m' || feature.poleHeight === '9 m' ? feature.poleHeight : null
      const geometry = feature.geometry as { type?: unknown; coordinates?: unknown } | undefined
      if (!kinds.includes(kind) || !name || name.length > 150 || !geometry || !['Point','LineString'].includes(String(geometry.type)) || !Array.isArray(geometry.coordinates)) throw new BadRequestException({ message: 'Jenis, nama, atau geometri desain tidak valid.' })
      const coordinates = geometry.coordinates as unknown[]
      const points = geometry.type === 'Point' ? [coordinates] : coordinates
      if ((geometry.type === 'Point' && coordinates.length < 2) || (geometry.type === 'LineString' && (coordinates.length < 2 || coordinates.length > 2000)) || points.some((point) => !Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number' || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) throw new BadRequestException({ message: 'Koordinat desain tidak valid.' })
      if ((kind === 'ROUTE') !== (geometry.type === 'LineString')) throw new BadRequestException({ message: 'Fitur kabel harus berupa jalur garis; aset perangkat harus berupa titik.' })
      if (kind === 'POLE' && !poleHeight) throw new BadRequestException({ message: 'Setiap tiang draft harus memiliki tinggi 7 m atau 9 m.' })
      const routeType = kind === 'ROUTE' && (feature.routeType === 'FEEDER' || feature.routeType === 'DISTRIBUTION') ? feature.routeType : null
      if (kind === 'ROUTE' && !routeType) throw new BadRequestException({ message: 'Jenis jalur FTTH harus feeder atau distribusi.' })
      const category = kind === 'JOINT_CLOSURE' ? 'JC' : kind === 'HANDHOLE' ? 'HANDHOLE' : kind
      const attributes = { folderPath: `FTTH Draft / ${designId} / ${category}`, ftthDesignId: designId, assetKind: kind, source: 'ftth-design', poleHeight, routeType, lineColor: routeType === 'FEEDER' ? '#ff0000' : routeType === 'DISTRIBUTION' ? '#a000ff' : undefined }
      return { id: randomUUID(),kind,name,poleHeight,routeType,geometry,geometryJson: JSON.stringify({ type: geometry.type, coordinates }),attributes: JSON.stringify(attributes) }
    })
    const historyId = await this.db.transaction(async (client) => {
      if (sourceAnalysisId) {
        const { rows: parent } = await client.query("SELECT result FROM analysis_history WHERE id=$1 AND user_id=$2 AND analysis_type='BULK' FOR UPDATE", [sourceAnalysisId,userId])
        if (!parent.length || !Array.isArray(parent[0].result?.rows) || !parent[0].result.rows.some((row: { row?: number }) => Number(row.row) === sourceRow)) throw new NotFoundException({ message: 'Baris analisis massal tidak ditemukan.' })
      }
      for (const feature of features) {
        const isRoute = feature.kind === 'ROUTE'
        await client.query(`INSERT INTO network_assets(id,name,asset_type,source,area,cable_type,installation,road_side,pole_height,attributes,geometry,source_geometry)
          VALUES($1,$2,$3,'managed',$4,'Fiber Optic','Aerial','Kiri',$5,$6::jsonb,ST_SetSRID(ST_GeomFromGeoJSON($7),4326),$7::jsonb)`,
        [feature.id,feature.name,isRoute ? 'segment' : 'asset',area,feature.poleHeight,feature.attributes,feature.geometryJson])
      }
      await client.query(`INSERT INTO network_asset_relations(segment_id,asset_id,kind)
        SELECT route.id, point.id, point.attributes->>'assetKind'
        FROM network_assets route
        JOIN network_assets point ON point.attributes->>'ftthDesignId'=route.attributes->>'ftthDesignId'
          AND point.attributes->>'assetKind' IN ('POLE','ODC','ODP')
          AND ST_DWithin(route.geometry::geography,point.geometry::geography,1)
        WHERE route.attributes->>'ftthDesignId'=$1 AND route.attributes->>'assetKind'='ROUTE'
        ON CONFLICT DO NOTHING`, [designId])
      const historyTitle = `Draft FTTH · ${area || 'Lokasi analisis'}`.slice(0, 300)
      const historyInput = { area, designId, ...(sourceAnalysisId ? { sourceAnalysisId, sourceRow } : {}) }
      const historyResult = {
        designId,
        savedCount: features.length,
        assetCount: features.filter((feature) => feature.kind !== 'ROUTE').length,
        routeCount: features.filter((feature) => feature.kind === 'ROUTE').length,
        features: features.map(({ kind, name, poleHeight, routeType, geometry }) => ({ kind, name, poleHeight, routeType, geometry })),
      }
      const { rows: historyRows } = await client.query(`INSERT INTO analysis_history(user_id,analysis_type,title,input,result)
        VALUES($1,'FTTH_DESIGN',$2,$3::jsonb,$4::jsonb) RETURNING id`,
      [userId, historyTitle, JSON.stringify(historyInput), JSON.stringify(historyResult)])
      await this.audit(client,userId,'FTTH_DESIGN_CREATED','FTTH_DESIGN',features[0].id,{ featureCount: features.length, kinds: [...new Set(features.map((feature) => feature.kind))] })
      return historyRows[0].id as string
    })
    return { savedCount: features.length, designId, historyId }
  }

  async assetGeometry(id: string) {
    const { rows } = await this.db.query(`SELECT COALESCE(source_geometry,ST_AsGeoJSON(geometry)::jsonb) AS geometry FROM network_assets WHERE id=$1`, [id])
    if (!rows.length) throw new NotFoundException({ message: 'Aset tidak ditemukan.' })
    return rows[0]
  }

  async updateAsset(id: string, body: Record<string, unknown>, userId: string) {
    const validInstallation = ['Aerial', 'Burial'].includes(String(body.installation))
    const validSide = ['Kiri', 'Kanan'].includes(String(body.side))
    const total = Number(body.totalCores)
    if (body.installation !== undefined && !validInstallation) throw new BadRequestException({ message: 'Metode instalasi harus Aerial atau Burial.' })
    if (body.side !== undefined && !validSide) throw new BadRequestException({ message: 'Sisi jalan harus Kiri atau Kanan.' })
    if (body.poleHeight !== undefined && body.poleHeight !== null && !['7 m', '9 m'].includes(String(body.poleHeight))) throw new BadRequestException({ message: 'Tinggi tiang harus 7 m atau 9 m.' })
    if (body.totalCores !== undefined && (!Number.isInteger(total) || total < 0 || total > 4096)) throw new BadRequestException({ message: 'Jumlah core harus bilangan bulat 0–4096.' })
    for (const key of ['name','area','cableType','pole','odc','odp']) {
      if (body[key] !== undefined && (typeof body[key] !== 'string' || String(body[key]).length > 500)) throw new BadRequestException({ message: 'Informasi aset harus berupa teks maksimal 500 karakter.' })
    }
    await this.db.transaction(async (client) => {
      const { rows: locked } = await client.query('SELECT id,asset_type FROM network_assets WHERE id=$1 FOR UPDATE', [id])
      if (!locked.length) throw new NotFoundException({ message: 'Aset tidak ditemukan.' })
      if (body.totalCores !== undefined && locked[0].asset_type !== 'segment') throw new BadRequestException({ message: 'Kapasitas core hanya dapat diatur pada segmen kabel.' })
      await client.query(`UPDATE network_assets SET
        name=COALESCE($2,name), area=COALESCE($3,area), cable_type=COALESCE($4,cable_type),
        installation=CASE WHEN $5 THEN $6 ELSE installation END, road_side=CASE WHEN $7 THEN $8 ELSE road_side END,
        pole=COALESCE($9,pole), pole_height=CASE WHEN $10 THEN $11 ELSE pole_height END,
        odc=COALESCE($12,odc), odp=COALESCE($13,odp), updated_at=now()
        WHERE id=$1`, [id,body.name ?? null,body.area ?? null,body.cableType ?? null,body.installation !== undefined,validInstallation ? body.installation : 'Aerial',body.side !== undefined,validSide ? body.side : 'Kiri',body.pole ?? null,body.poleHeight !== undefined,body.poleHeight ?? null,body.odc ?? null,body.odp ?? null])
      if (body.totalCores !== undefined) {
        await this.setCoreCount(client, id, total)
        await this.allocateWaiting(client, id, userId)
      }
      await this.audit(client,userId,'ASSET_UPDATED','ASSET',id,{ fields: Object.keys(body) })
    })
    return (await this.listAssets()).find((asset) => asset.id === id)
  }

  async listRelations(segmentId: string) {
    const { rows: segment } = await this.db.query("SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment'", [segmentId])
    if (!segment.length) throw new NotFoundException({ message: 'Segmen tidak ditemukan.' })
    const { rows } = await this.db.query(`SELECT r.asset_id AS "assetId",r.kind,a.name,a.area,a.pole_height AS "poleHeight"
      FROM network_asset_relations r JOIN network_assets a ON a.id=r.asset_id
      WHERE r.segment_id=$1 ORDER BY r.kind,a.name,a.id`, [segmentId])
    return rows
  }

  async saveRelations(segmentId: string, input: unknown, userId: string) {
    if (!Array.isArray(input) || input.length > 1000) throw new BadRequestException({ message: 'Relasi harus berupa daftar, maksimal 1.000 aset.' })
    const relations = input.map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.assetId !== 'string' || !['POLE','ODC','ODP'].includes(entry.kind)) throw new BadRequestException({ message: 'Relasi harus memiliki assetId dan jenis POLE, ODC, atau ODP.' })
      return { assetId: entry.assetId as string, kind: entry.kind as string }
    })
    if (new Set(relations.map((entry) => `${entry.kind}:${entry.assetId}`)).size !== relations.length) throw new BadRequestException({ message: 'Relasi aset tidak boleh duplikat.' })
    await this.db.transaction(async (client) => {
      const { rows: segment } = await client.query("SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' FOR UPDATE", [segmentId])
      if (!segment.length) throw new NotFoundException({ message: 'Segmen tidak ditemukan.' })
      const ids = [...new Set(relations.map((entry) => entry.assetId))].sort()
      if (ids.length) {
        const { rows: points } = await client.query("SELECT id FROM network_assets WHERE id=ANY($1::text[]) AND asset_type='asset' AND GeometryType(geometry)='POINT' ORDER BY id FOR UPDATE", [ids])
        if (points.length !== ids.length) throw new BadRequestException({ message: 'Pilih aset titik yang masih tersedia; segmen dan boundary tidak dapat dijadikan relasi.' })
      }
      await client.query('DELETE FROM network_asset_relations WHERE segment_id=$1', [segmentId])
      for (const entry of relations) await client.query('INSERT INTO network_asset_relations(segment_id,asset_id,kind) VALUES($1,$2,$3)', [segmentId,entry.assetId,entry.kind])
      await this.audit(client,userId,'ASSET_RELATIONS_UPDATED','ASSET',segmentId,{ relations })
    })
    return this.listRelations(segmentId)
  }

  async listCores(assetId: string) {
    const { rows: segment } = await this.db.query("SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment'", [assetId])
    if (!segment.length) throw new NotFoundException({ message: 'Segmen tidak ditemukan.' })
    const { rows } = await this.db.query(`SELECT c.core_number AS "coreNumber",c.status,b.id AS "bookingId",b.customer,b.pic_customer AS "picCustomer",b.pic_presales AS "picPresales",b.expires_at AS "expiresAt"
      FROM network_cores c LEFT JOIN booking_cores bc ON bc.core_id=c.id LEFT JOIN bookings b ON b.id=bc.booking_id
      WHERE c.asset_id=$1 ORDER BY c.core_number`, [assetId])
    return rows
  }

  private async setCoreCount(client: PoolClient, assetId: string, total: number) {
    await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [assetId])
    const { rows: active } = await client.query(`SELECT id FROM network_cores WHERE asset_id=$1 AND core_number > $2 AND status <> 'Available' LIMIT 1`, [assetId,total])
    if (active.length) throw new ConflictException({ message: 'Kapasitas tidak dapat dikurangi karena nomor core yang akan dihapus masih Used atau Booked.' })
    await client.query(`DELETE FROM network_cores WHERE asset_id=$1 AND core_number > $2 AND status='Available'`, [assetId,total])
    await client.query(`INSERT INTO network_cores(asset_id,core_number) SELECT $1,n FROM generate_series(1,$2) n ON CONFLICT DO NOTHING`, [assetId,total])
    await client.query('UPDATE network_assets SET total_cores=$2,updated_at=now() WHERE id=$1', [assetId,total])
  }

  async setCoreStatus(assetId: string, coreNumber: number, status: string | undefined, userId: string) {
    if (!Number.isInteger(coreNumber) || coreNumber < 1 || !['Available','Used'].includes(String(status))) throw new BadRequestException({ message: 'Status core harus Available atau Used.' })
    return this.db.transaction(async (client) => {
      const { rows: segment } = await client.query("SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' FOR UPDATE", [assetId])
      if (!segment.length) throw new NotFoundException({ message: 'Segmen tidak ditemukan.' })
      const { rows } = await client.query('SELECT id,status FROM network_cores WHERE asset_id=$1 AND core_number=$2 FOR UPDATE', [assetId,coreNumber])
      if (!rows.length) throw new NotFoundException({ message: 'Core tidak ditemukan.' })
      if (rows[0].status === 'Booked') throw new ConflictException({ message: 'Core yang sedang dibooking tidak dapat diubah.' })
      await client.query('UPDATE network_cores SET status=$3 WHERE asset_id=$1 AND core_number=$2', [assetId,coreNumber,status])
      await this.audit(client,userId,'CORE_STATUS_CHANGED','CORE',`${assetId}:${coreNumber}`,{ assetId,coreNumber,status })
      if (status === 'Available') {
        await this.allocateWaiting(client,assetId,userId)
      }
      const { rows: current } = await client.query('SELECT status FROM network_cores WHERE asset_id=$1 AND core_number=$2', [assetId,coreNumber])
      return { assetId, coreNumber, status: current[0].status }
    })
  }

  async dashboard() {
    const [assets, bookings] = await Promise.all([
      this.db.query(`SELECT (SELECT count(*)::int FROM network_assets WHERE asset_type='segment') AS segments,
       COALESCE((SELECT sum(total_cores)::int FROM network_assets WHERE asset_type='segment'),0) AS "totalCores",
       (SELECT count(*)::int FROM network_cores c JOIN network_assets a ON a.id=c.asset_id WHERE a.asset_type='segment' AND c.status='Used') AS "usedCores",
       (SELECT count(*)::int FROM network_cores c JOIN network_assets a ON a.id=c.asset_id WHERE a.asset_type='segment' AND c.status='Booked') AS "bookedCores"`),
      this.listBookings(),
    ])
    return { ...assets.rows[0], waitingCount: bookings.filter((item) => item.status === 'Waiting List').length, recentBookings: bookings.slice(0, 4) }
  }

  async networkUsageReport() {
    const { rows } = await this.db.query(`SELECT a.id,a.name,a.area,a.cable_type AS "cableType",a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "availableCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      (SELECT count(*)::int FROM bookings b WHERE b.segment_id=a.id AND b.status='Waiting List') AS "waitingList",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('assetId',linked.id,'kind',r.kind,'name',linked.name,'poleHeight',linked.pole_height) ORDER BY r.kind,linked.name)
        FROM network_asset_relations r JOIN network_assets linked ON linked.id=r.asset_id WHERE r.segment_id=a.id),'[]'::jsonb) AS "relatedAssets"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.asset_type='segment' GROUP BY a.id ORDER BY a.area,a.name`)
    return rows
  }

  async listBookings() {
    const { rows } = await this.db.query(`SELECT b.id,b.customer,b.pic_customer AS "picCustomer",b.pic_presales AS "picPresales",
      b.segment_id AS "segmentId",b.cores,b.status,b.requested_at AS "requestedAt",b.expires_at AS "expiresAt",a.name AS "segmentName",a.area
      FROM bookings b JOIN network_assets a ON a.id=b.segment_id ORDER BY b.requested_at DESC,b.id DESC`)
    return rows
  }

  async getBookingDuration() {
    const { rows } = await this.db.query("SELECT value FROM app_settings WHERE key='booking_duration_days'")
    return { days: Number(rows[0]?.value ?? 30) }
  }
  async setBookingDuration(days: number, userId: string) {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequestException({ message: 'Durasi booking harus 1–365 hari.' })
    await this.db.query("INSERT INTO app_settings(key,value) VALUES('booking_duration_days',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(days)])
    await this.db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'BOOKING_DURATION_UPDATED','SETTING','booking_duration_days',$2::jsonb)", [userId,JSON.stringify({ days })])
    return { days }
  }

  async getCableNamePattern() {
    const { rows } = await this.db.query("SELECT value FROM app_settings WHERE key='cable_name_pattern'")
    return { pattern: String(rows[0]?.value ?? '^AT-[A-Z]{3}-[A-Z]{3}-FO-[0-9]{3}$') }
  }
  async setCableNamePattern(pattern: string, userId: string) {
    if (!pattern || pattern.length > 200) throw new BadRequestException({ message: 'Pola nama kabel wajib diisi (maksimal 200 karakter).' })
    try { new RegExp(pattern) } catch { throw new BadRequestException({ message: 'Pola nama kabel bukan regular expression yang valid.' }) }
    await this.db.query("INSERT INTO app_settings(key,value) VALUES('cable_name_pattern',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(pattern)])
    await this.db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'CABLE_NAME_PATTERN_UPDATED','SETTING','cable_name_pattern',$2::jsonb)", [userId,JSON.stringify({ pattern })])
    return { pattern }
  }

  async createBooking(input: { customer?: string; picCustomer?: string; picPresales?: string; segmentId?: string; cores?: number }, userId: string) {
    const customer = input.customer?.trim(), picCustomer = input.picCustomer?.trim(), picPresales = input.picPresales?.trim()
    const cores = Number(input.cores), segmentId = input.segmentId
    if (!customer || !picCustomer || !picPresales || !segmentId || !Number.isInteger(cores) || cores < 1) throw new BadRequestException({ message: 'Pelanggan, PIC, segmen, dan jumlah core wajib diisi.' })
    return this.db.transaction(async (client) => {
      const { rows: assets } = await client.query("SELECT total_cores FROM network_assets WHERE id=$1 AND asset_type='segment' FOR UPDATE", [segmentId])
      if (!assets.length) throw new NotFoundException({ message: 'Segmen tidak ditemukan.' })
      if (!assets[0].total_cores) throw new BadRequestException({ message: 'Kapasitas belum diisi. Minta ADMIN melengkapi jumlah core segmen.' })
      if (cores > assets[0].total_cores) throw new BadRequestException({ message: 'Jumlah booking melebihi kapasitas total segmen.' })
      const id = `BKG-${randomUUID().toUpperCase()}`
      await client.query(`INSERT INTO bookings(id,customer,pic_customer,pic_presales,segment_id,cores,status,requested_by,requested_at)
        VALUES($1,$2,$3,$4,$5,$6,'Waiting List',$7,clock_timestamp())`, [id,customer,picCustomer,picPresales,segmentId,cores,userId])
      await this.allocateWaiting(client,segmentId,userId)
      const { rows } = await client.query('SELECT status FROM bookings WHERE id=$1', [id])
      const status = rows[0].status
      await this.audit(client,userId,'BOOKING_CREATED','BOOKING',id,{ segmentId,cores,status })
      return { id, customer, picCustomer, picPresales, segmentId, cores, status }
    })
  }

  private async assignCores(client: PoolClient, bookingId: string, coreIds: number[]) {
    for (const coreId of coreIds) {
      await client.query("UPDATE network_cores SET status='Booked' WHERE id=$1", [coreId])
      await client.query('INSERT INTO booking_cores(booking_id,core_id) VALUES($1,$2)', [bookingId,coreId])
    }
  }

  async releaseBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const { rows: targets } = await client.query('SELECT segment_id FROM bookings WHERE id=$1', [id])
      if (!targets.length) throw new NotFoundException({ message: 'Booking tidak ditemukan.' })
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [targets[0].segment_id])
      const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])
      const booking = rows[0]
      if (booking.status !== 'Booked') throw new ConflictException({ message: 'Hanya booking aktif yang dapat dilepas.' })
      await client.query("UPDATE network_cores SET status='Available' WHERE id IN (SELECT core_id FROM booking_cores WHERE booking_id=$1)", [id])
      await client.query('DELETE FROM booking_cores WHERE booking_id=$1', [id])
      await client.query("UPDATE bookings SET status='Released',released_at=now() WHERE id=$1", [id])
      const allocatedBookingIds = await this.allocateWaiting(client,booking.segment_id,userId)
      await this.audit(client,userId,'BOOKING_RELEASED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores,allocatedBookingIds })
      await this.notifyPresales(client,'Booking core dilepas',`${booking.customer}: ${booking.cores} core dilepas. ${allocatedBookingIds.length} permintaan waiting list dialokasikan.`,booking.requested_by ?? userId)
      return { released: id, allocated: allocatedBookingIds[0] ?? null, allocatedBookingIds }
    })
  }

  // All callers hold the segment lock; the first unfulfilled request blocks later requests.
  private async allocateWaiting(client: PoolClient, segmentId: string, actorId: string | null = null) {
    const { rows: queue } = await client.query("SELECT * FROM bookings WHERE segment_id=$1 AND status='Waiting List' ORDER BY requested_at,id FOR UPDATE", [segmentId])
    const { rows: settings } = await client.query("SELECT value FROM app_settings WHERE key='booking_duration_days'")
    const days = Number(settings[0]?.value ?? 30)
    const allocated: string[] = []
    for (const booking of queue) {
      const { rows: available } = await client.query("SELECT id FROM network_cores WHERE asset_id=$1 AND status='Available' ORDER BY core_number LIMIT $2 FOR UPDATE", [segmentId,booking.cores])
      if (available.length !== booking.cores) break
      await this.assignCores(client,booking.id,available.map((row) => row.id))
      await client.query("UPDATE bookings SET status='Booked',expires_at=now()+($2||' days')::interval WHERE id=$1", [booking.id,days])
      await this.audit(client,actorId,'WAITING_LIST_ALLOCATED','BOOKING',booking.id,{ segmentId,cores: booking.cores })
      await this.notifyPresales(client,'Waiting list dialokasikan',`${booking.customer}: ${booking.cores} core tersedia dan booking ${booking.id} aktif.`,booking.requested_by)
      allocated.push(booking.id)
    }
    return allocated
  }

  private async notifyPresales(client: PoolClient, title: string, message: string, requestorId?: string) {
    await client.query(`INSERT INTO notifications(user_id,title,message)
      SELECT id,$1,$2 FROM "user" WHERE role='PRESALES' OR id=$3`, [title,message,requestorId ?? ''])
  }

  async expireBookings() {
    const { rows } = await this.db.query("SELECT id,segment_id FROM bookings WHERE status='Booked' AND expires_at <= now() ORDER BY expires_at LIMIT 50")
    for (const { id, segment_id } of rows) await this.db.transaction(async (client) => {
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [segment_id])
      const { rows: locked } = await client.query('SELECT * FROM bookings WHERE id=$1 AND status=\'Booked\' AND expires_at <= now() FOR UPDATE', [id])
      if (!locked.length) return
      const booking = locked[0]
      await client.query("UPDATE network_cores SET status='Available' WHERE id IN (SELECT core_id FROM booking_cores WHERE booking_id=$1)", [id])
      await client.query('DELETE FROM booking_cores WHERE booking_id=$1', [id])
      await client.query("UPDATE bookings SET status='Expired',released_at=now() WHERE id=$1", [id])
      const allocatedBookingIds = await this.allocateWaiting(client,booking.segment_id)
      await this.audit(client,null,'BOOKING_EXPIRED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores,allocatedBookingIds })
    })
  }

  async nearestNetwork(longitude: number, latitude: number) {
    const { rows } = await this.db.query(`SELECT a.id,a.name,a.area,a.cable_type AS "cableType",
      ST_AsGeoJSON(ST_ClosestPoint(a.geometry,ST_SetSRID(ST_MakePoint($1,$2),4326)))::json AS "nearestPoint",
      ST_Distance(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)::int AS "straightDistanceMeters"
      FROM network_assets a
      WHERE a.asset_type='segment' AND GeometryType(a.geometry) IN ('LINESTRING','MULTILINESTRING')
      ORDER BY a.geometry <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`, [longitude,latitude])
    return rows[0] ?? null
  }

  async notifications(userId: string) {
    const { rows } = await this.db.query('SELECT id,title,message,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId])
    return rows
  }
  async markNotificationRead(id: string, userId: string) {
    const { rowCount } = await this.db.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [id,userId])
    if (!rowCount) throw new NotFoundException({ message: 'Notifikasi tidak ditemukan.' })
    return { id, read: true }
  }
}
