import provinceBoundaries from '../database/regions/province-boundaries.json'
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Database } from '../database/database'

type AssetRecord = {
  id: string; name: string; area: string; assetType: string; source: string; cableType: string; installation: string; side: string;
  pole: string; poleHeight: string | null; odc: string; odp: string; totalCores: number; usedCores: number; bookedCores: number; idleCores: number;
  geometry: unknown; attributes: Record<string, unknown>; createdAt: string
}

const provinceMatch = (provinceParam: number) => `a.attributes->>'__atlasProvinceCode'=$${provinceParam}`

type RegionName = { provinceCode: string; name: string; level: number }
type KmzProvinceAsset = { id: string; name: string; area: string; folderPath: string }
type KmzProvinceBoundary = { provinceCode: string; provinceName: string; geometry: unknown }

const normalizeRegionText = (value: string) => value
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('id-ID')
  .replace(/\b(provinsi|province|kabupaten|kab\.?|kota|kotamadya|kecamatan|district|desa|kelurahan)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')

const kmzGroup = (path: string) => {
  const folders = path.split('/').map((part) => part.trim()).filter(Boolean)
  const popIndex = folders.findIndex((part) => /^POP\s+/i.test(part))
  if (popIndex >= 0) return folders[popIndex].replace(/^POP\s+/i, '').trim()
  const boundaryIndex = folders.findIndex((part) => normalizeRegionText(part) === 'full boundry' || normalizeRegionText(part) === 'full boundary')
  if (boundaryIndex >= 0 && folders[boundaryIndex + 1]) return folders[boundaryIndex + 1]
  return folders[1] ?? folders[0] ?? ''
}

@Injectable()
export class AtlasService implements OnModuleInit, OnModuleDestroy {
  private expiryTimer?: NodeJS.Timeout
  constructor(@Inject(Database) private readonly db: Database) {}

  private async audit(client: PoolClient, actorId: string | null, action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) {
    await client.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)', [actorId,action,entityType,entityId,JSON.stringify(details)])
  }

  async recordAudit(actorId: string | null, action: string, details: Record<string, unknown>) {
    await this.db.transaction((client) => this.audit(client,actorId,action,'PROCESS',null,details))
  }

  async recordApiRequest(actorId: string | null, method: string, path: string, statusCode: number, durationMs: number) {
    const action = statusCode >= 400 ? 'API_REQUEST_FAILED' : 'API_REQUEST'
    await this.db.transaction((client) => this.audit(client,actorId,action,'API',`${method} ${path}`,{ method,path,statusCode,durationMs }))
  }

  async saveAnalysisHistory(userId: string, type: 'ADDRESS' | 'BULK', title: string, input: unknown, result: unknown) {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query(`INSERT INTO analysis_history(user_id,analysis_type,title,input,result)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
      RETURNING id`, [userId, type, title.slice(0, 300), JSON.stringify(input), JSON.stringify(result)])
      const id = rows[0].id as string
      const payload = result && typeof result === 'object' ? result as { status?: string; rows?: { status?: string }[] } : {}
      const statusCounts = (payload.rows ?? []).reduce<Record<string, number>>((counts, row) => {
        const status = row.status ?? 'UNKNOWN'
        counts[status] = (counts[status] ?? 0) + 1
        return counts
      }, {})
      const details = type === 'BULK'
        ? { rowCount: payload.rows?.length ?? 0, statusCounts }
        : { status: payload.status ?? 'COMPLETED' }
      await this.audit(client,userId,type === 'BULK' ? 'BULK_ANALYSIS_COMPLETED' : 'ADDRESS_ANALYSIS_COMPLETED','ANALYSIS_HISTORY',id,details)
      return id
    })
  }

  async listAnalysisHistory(userId: string, type?: 'ADDRESS' | 'BULK' | 'FTTH_DESIGN', page = 1, pageSize = 25) {
    const { rows } = await this.db.query(`WITH filtered AS (
        SELECT h.id,h.analysis_type AS "analysisType",h.title,h.result->>'status' AS status,
          CASE WHEN h.analysis_type='BULK' THEN COALESCE(j.total_rows,jsonb_array_length(COALESCE(h.result->'rows','[]'::jsonb)))
               WHEN h.analysis_type='FTTH_DESIGN' THEN COALESCE((h.result->>'savedCount')::int,0)
               ELSE 1 END AS "itemCount",
          h.created_at AS "createdAt",j.id AS "bulkJobId",j.status AS "jobStatus",j.processed_rows AS "processedRows",
          j.succeeded_rows AS "succeededRows",j.failed_rows AS "failedRows"
        FROM analysis_history h LEFT JOIN analysis_bulk_jobs j ON j.history_id=h.id
        WHERE h.user_id=$1 AND ($2::text IS NULL OR h.analysis_type=$2)
          AND NOT (h.analysis_type='FTTH_DESIGN' AND EXISTS (
            SELECT 1 FROM analysis_history a
            WHERE a.user_id=h.user_id AND a.analysis_type IN ('ADDRESS','BULK')
              AND (h.input->>'sourceAnalysisId'=a.id::text OR (a.analysis_type='ADDRESS' AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(h.result->'features','[]'::jsonb)) f
                CROSS JOIN LATERAL (SELECT CASE WHEN f->>'kind'='OLT' THEN f->'geometry'->'coordinates'
                  ELSE f->'geometry'->'coordinates'->0 END AS point) p
                WHERE (f->>'kind'='OLT' OR (f->>'kind'='ROUTE' AND f->>'routeType'='FEEDER'))
                  AND jsonb_typeof(p.point)='array' AND jsonb_array_length(p.point)>=2
                  AND ST_DistanceSphere(ST_MakePoint((p.point->>0)::float8,(p.point->>1)::float8),
                    ST_MakePoint((a.result->>'longitude')::float8,(a.result->>'latitude')::float8))<=5
              )))
          ))
      ), page_rows AS (
        SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT $3 OFFSET $4
      ), total_rows AS (
        SELECT count(*)::int AS total FROM filtered
      )
      SELECT page_rows.*,total_rows.total FROM total_rows LEFT JOIN page_rows ON TRUE
      ORDER BY page_rows."createdAt" DESC NULLS LAST,page_rows.id DESC NULLS LAST`, [userId, type ?? null, pageSize, (page - 1) * pageSize])
    return { items: rows.filter((row) => row.id), total: rows[0]?.total ?? 0, page, pageSize }
  }

  async getAnalysisHistory(userId: string, id: string) {
    const { rows } = await this.db.query(`SELECT h.id,h.analysis_type AS "analysisType",h.title,h.input,h.result,h.created_at AS "createdAt",
      j.id AS "bulkJobId",j.status AS "jobStatus",j.total_rows AS "totalRows",j.processed_rows AS "processedRows",
      j.succeeded_rows AS "succeededRows",j.failed_rows AS "failedRows"
      FROM analysis_history h LEFT JOIN analysis_bulk_jobs j ON j.history_id=h.id WHERE h.user_id=$1 AND h.id=$2`, [userId, id])
    if (!rows[0]) throw new NotFoundException({ message: 'Riwayat analisis tidak ditemukan.' })
    if (!['BULK', 'ADDRESS'].includes(rows[0].analysisType)) return rows[0]
    const { rows: drafts } = await this.db.query(`SELECT id,title,input,result,created_at AS "createdAt"
      FROM analysis_history WHERE user_id=$1 AND analysis_type='FTTH_DESIGN'
        AND (input->>'sourceAnalysisId'=$2 OR input->>'sourceAnalysisId' IS NULL)
      ORDER BY created_at DESC`, [userId, id])
    const latitude = Number(rows[0].result?.latitude)
    const longitude = Number(rows[0].result?.longitude)
    const relatedDrafts = drafts.filter((draft) => {
      if (draft.input?.sourceAnalysisId === id) return true
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false
      const features = draft.result?.features ?? []
      return features.some((feature: { kind?: string; routeType?: string; geometry?: { coordinates?: unknown } }) => {
        if (feature.kind !== 'OLT' && !(feature.kind === 'ROUTE' && feature.routeType === 'FEEDER')) return false
        const geometryCoordinates = feature.geometry?.coordinates
        if (!Array.isArray(geometryCoordinates) || geometryCoordinates.length < 2) return false
        const coordinates = Array.isArray(geometryCoordinates[0]) ? geometryCoordinates[0] : geometryCoordinates
        const dx = (Number(coordinates[0]) - longitude) * 111_320 * Math.cos(latitude * Math.PI / 180)
        const dy = (Number(coordinates[1]) - latitude) * 111_320
        return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) <= 5
      })
    })
    return { ...rows[0], relatedDrafts }
  }

  async deleteAnalysisHistory(userId: string, id: string) {
    await this.db.transaction(async (client) => {
      const { rows } = await client.query('SELECT analysis_type AS type FROM analysis_history WHERE user_id=$1 AND id=$2 FOR UPDATE', [userId,id])
      if (!rows.length) throw new NotFoundException({ message: 'Riwayat analisis tidak ditemukan.' })
      await client.query('DELETE FROM analysis_history WHERE user_id=$1 AND id=$2', [userId,id])
      await this.audit(client,userId,'ANALYSIS_HISTORY_DELETED','ANALYSIS_HISTORY',id,{ type: rows[0].type })
    })
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

  async listAssetPage(search = '', page = 1, pageSize = 50, coreFilter = 'all', provinceCode?: string) {
    const filter = search.trim()
    const match = `%${filter}%`
    const provinceCondition = provinceMatch(4)
    const conditions = `($1='' OR a.name ILIKE $2 OR a.area ILIKE $2 OR a.cable_type ILIKE $2 OR a.asset_type ILIKE $2 OR a.attributes::text ILIKE $2)
      AND ($3='all' OR a.asset_type='segment')
      AND ($3<>'filled' OR a.total_cores>0)
      AND ($3<>'empty' OR a.total_cores=0)
      AND ($4::text IS NULL OR ${provinceCondition})`
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM network_assets a
        WHERE ${conditions}`, [filter, match, coreFilter, provinceCode ?? null]),
      this.db.query<AssetRecord>(`WITH page AS (
          SELECT a.id,a.name FROM network_assets a
          WHERE ${conditions}
          ORDER BY a.name,a.id LIMIT $5 OFFSET $6
        )
        SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
          a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
          count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
          count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
          count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
          GeometryType(a.geometry) AS "geometryType",NULL::jsonb AS geometry,a.attributes,a.created_at AS "createdAt"
        FROM page p JOIN network_assets a ON a.id=p.id LEFT JOIN network_cores c ON c.asset_id=a.id
        GROUP BY a.id ORDER BY a.name,a.id`, [filter, match, coreFilter, provinceCode ?? null, pageSize, (page - 1) * pageSize]),
    ])
    const pattern = new RegExp((await this.getCableNamePattern()).pattern)
    return { items: rows.map((asset) => ({ ...asset, nameValid: pattern.test(asset.name) })), total: countRows[0].total, page, pageSize }
  }

  async listDashboardSegments() {
    const { rows } = await this.db.query<AssetRecord>(`SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      NULL::text AS "geometryType",NULL::jsonb AS geometry,a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.asset_type='segment' GROUP BY a.id ORDER BY a.name,a.id LIMIT 8`)
    const pattern = new RegExp((await this.getCableNamePattern()).pattern)
    return rows.map((asset) => ({ ...asset, nameValid: pattern.test(asset.name) }))
  }

  async listBookableSegments() {
    const { rows } = await this.db.query(`SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.asset_type='segment' AND a.total_cores>0
      GROUP BY a.id ORDER BY a.name,a.id`)
    return rows
  }

  async mapBounds(provinceCode?: string) {
    const provinceCondition = provinceMatch(1)
    const { rows } = await this.db.query(`SELECT ST_XMin(extent) AS west,ST_YMin(extent) AS south,ST_XMax(extent) AS east,ST_YMax(extent) AS north
      FROM (SELECT ST_Extent(geometry) AS extent FROM network_assets a WHERE ($1::text IS NULL OR ${provinceCondition})) bounds`, [provinceCode ?? null])
    const { west, south, east, north } = rows[0]
    return { bounds: west === null ? null : [west, south, east, north] }
  }

  async listKmzProvinces() {
    const { rows: assets } = await this.db.query<KmzProvinceAsset>(`SELECT id,name,COALESCE(area,'') AS area,
        COALESCE(attributes->>'folderPath','') AS "folderPath"
      FROM network_assets WHERE source='kml' AND attributes ? 'folderPath' AND COALESCE(attributes->>'__atlasProvinceSource','') <> 'geometry-boundary'`)
    const { rows: regions } = await this.db.query<RegionName>(`SELECT p.code AS "provinceCode",btrim(p.name) AS name,4 AS level FROM indonesia_provinces p
      UNION ALL SELECT c.province_code,btrim(c.name),3 FROM indonesia_cities c
      UNION ALL SELECT c.province_code,btrim(d.name),2 FROM indonesia_districts d JOIN indonesia_cities c ON c.code=d.city_code
      UNION ALL SELECT c.province_code,btrim(s.name),1 FROM indonesia_subdistricts s
        JOIN indonesia_districts d ON d.code=s.district_code JOIN indonesia_cities c ON c.code=d.city_code`)

    const assetGroups = new Map<string, KmzProvinceAsset[]>()
    const folderNamesByGroup = new Map<string, Set<string>>()
    for (const asset of assets) {
      const group = kmzGroup(asset.folderPath)
      if (!group) continue
      const key = normalizeRegionText(group)
      const groupAssets = assetGroups.get(key) ?? []
      groupAssets.push(asset)
      assetGroups.set(key, groupAssets)
      const folders = folderNamesByGroup.get(key) ?? new Set<string>()
      folders.add(asset.folderPath)
      folderNamesByGroup.set(key, folders)
    }

    const { rows: boundaries } = await this.db.query<{ folderPath: string; village: string }>(`SELECT DISTINCT
        COALESCE(attributes->>'folderPath','') AS "folderPath",
        btrim(split_part(name,' · ',3)) AS village
      FROM network_assets WHERE source='kml' AND attributes->>'folderPath' ILIKE '%FULL BOUNDRY%' AND name LIKE '% · % · %'`)
    const villagesByGroup = new Map<string, Set<string>>()
    for (const boundary of boundaries) {
      const group = normalizeRegionText(kmzGroup(boundary.folderPath))
      const village = normalizeRegionText(boundary.village)
      if (!group || !village) continue
      const villages = villagesByGroup.get(group) ?? new Set<string>()
      villages.add(village)
      villagesByGroup.set(group, villages)
    }

    const regionsByName = new Map<string, RegionName[]>()
    for (const region of regions) {
      const normalized = normalizeRegionText(region.name)
      if (!normalized) continue
      const matches = regionsByName.get(normalized) ?? []
      matches.push(region)
      regionsByName.set(normalized, matches)
    }
    const subdistrictsByName = new Map([...regionsByName.entries()].map(([name, matches]) => [name, matches.filter((region) => region.level === 1)]))
    const provinceByGroup = new Map<string, { code: string; source: string }>()
    for (const [group, groupAssets] of assetGroups) {
      const areaNames = [...new Set(groupAssets.map((asset) => normalizeRegionText(asset.area)).filter(Boolean))]
      const villages = [...(villagesByGroup.get(group) ?? [])]
      const votes = new Map<string, number>()
      for (const village of villages) {
        const matches = subdistrictsByName.get(village) ?? []
        const codes = new Set(matches.map((region) => region.provinceCode))
        if (codes.size === 1) {
          const code = [...codes][0]
          votes.set(code, (votes.get(code) ?? 0) + 1)
        }
      }
      const voteRanking = [...votes.entries()].sort((left, right) => right[1] - left[1])
      const [winner, winnerVotes] = voteRanking[0] ?? []
      const runnerUpVotes = voteRanking[1]?.[1] ?? 0
      if (winner && winnerVotes >= 3 && winnerVotes >= runnerUpVotes + 2 && winnerVotes / villages.length >= 0.6) {
        provinceByGroup.set(group, { code: winner, source: 'village-boundary-consensus' })
        continue
      }

      const areaCandidates = areaNames.flatMap((area) => regionsByName.get(area) ?? [])
      const areaCodes = new Set(areaCandidates.map((region) => region.provinceCode))
      if (areaCodes.size === 1 && areaCandidates.length) {
        provinceByGroup.set(group, { code: [...areaCodes][0], source: 'kmz-area-hierarchy' })
        continue
      }

      const exactFolderNames = new Set<string>([group])
      for (const folderPath of folderNamesByGroup.get(group) ?? []) {
        for (const folder of folderPath.split('/')) {
          const cleaned = folder.replace(/^\s*POP\s+/i, '').trim()
          for (const part of [cleaned, ...cleaned.split(/\s*[-–—,;|]\s*/)]) {
            const normalized = normalizeRegionText(part)
            if (normalized) exactFolderNames.add(normalized)
          }
        }
      }
      const candidates = [...exactFolderNames].flatMap((name) => regionsByName.get(name) ?? []).filter((region) => region.level >= 2)
      if (!candidates.length) continue
      const bestLevel = Math.max(...candidates.map((region) => region.level))
      const bestCandidates = candidates.filter((region) => region.level === bestLevel)
      const codes = new Set(bestCandidates.map((region) => region.provinceCode))
      if (codes.size === 1) provinceByGroup.set(group, { code: [...codes][0], source: 'kmz-folder-hierarchy' })
    }

    const updatesByValue = new Map<string, { code: string; source: string; ids: string[] }>()
    const unresolvedIds: string[] = []
    for (const [group, groupAssets] of assetGroups) {
      const assignment = provinceByGroup.get(group)
      if (!assignment) unresolvedIds.push(...groupAssets.map((asset) => asset.id))
      else {
        const key = `${assignment.code}:${assignment.source}`
        const update = updatesByValue.get(key) ?? { ...assignment, ids: [] }
        update.ids.push(...groupAssets.map((asset) => asset.id))
        updatesByValue.set(key, update)
      }
    }
    for (const { code, source, ids } of updatesByValue.values()) {
      await this.db.query(`UPDATE network_assets SET attributes=COALESCE(attributes,'{}'::jsonb)||jsonb_build_object('__atlasProvinceCode',$2,'__atlasProvinceSource',$3)
        WHERE id=ANY($1::text[]) AND (attributes->>'__atlasProvinceCode' IS DISTINCT FROM $2 OR attributes->>'__atlasProvinceSource' IS DISTINCT FROM $3)`, [ids, code, source])
    }
    if (unresolvedIds.length) await this.db.query(`UPDATE network_assets SET attributes=COALESCE(attributes,'{}'::jsonb)-'__atlasProvinceCode'-'__atlasProvinceSource'
      WHERE id=ANY($1::text[]) AND attributes ? '__atlasProvinceCode'`, [unresolvedIds])

    // Coordinates are authoritative when folder names do not identify a province.
    const provinceNames = regions.filter((region) => region.level === 4);
    const spatialProvinces = provinceBoundaries.features.flatMap((feature) => {
      const name = normalizeRegionText(({ PROBANTEN: 'Banten', 'DKI JAKARTA': 'Daerah Khusus Ibukota Jakarta', 'DI. ACEH': 'Aceh', 'NUSATENGGARA BARAT': 'Nusa Tenggara Barat' } as Record<string, string>)[feature.properties.Propinsi] ?? feature.properties.Propinsi);
      const province = provinceNames.find((region) => normalizeRegionText(region.name) === name);
      return province ? [{ code: province.provinceCode, geometry: feature.geometry }] : [];
    });
    await this.db.query(`WITH boundaries AS MATERIALIZED (
      SELECT value->>'code' AS code, ST_SetSRID(ST_GeomFromGeoJSON(value->'geometry'),4326) AS geometry
      FROM jsonb_array_elements($1::jsonb)
    ), assigned AS (
      SELECT DISTINCT ON (a.id) a.id,b.code FROM network_assets a JOIN boundaries b
        ON a.geometry && b.geometry AND ST_Covers(b.geometry,ST_PointOnSurface(a.geometry))
      WHERE a.source='kml' ORDER BY a.id,b.code
    ) UPDATE network_assets a SET attributes=COALESCE(a.attributes,'{}'::jsonb)||jsonb_build_object('__atlasProvinceCode',assigned.code,'__atlasProvinceSource','geometry-boundary')
      FROM assigned WHERE a.id=assigned.id AND (a.attributes->>'__atlasProvinceCode' IS DISTINCT FROM assigned.code OR a.attributes->>'__atlasProvinceSource' IS DISTINCT FROM 'geometry-boundary')`, [JSON.stringify(spatialProvinces)]);

    const { rows: spatialGroups } = await this.db.query<{ id: string; folderPath: string; code: string | null }>(`SELECT id,attributes->>'folderPath' AS "folderPath",attributes->>'__atlasProvinceCode' AS code FROM network_assets WHERE source='kml' AND attributes ? 'folderPath'`);
    const groupCodes = new Map<string, Set<string>>();
    for (const asset of spatialGroups) {
      if (!asset.code) continue;
      const group = normalizeRegionText(kmzGroup(asset.folderPath));
      const codes = groupCodes.get(group) ?? new Set<string>();
      codes.add(asset.code);
      groupCodes.set(group, codes);
    }
    for (const asset of spatialGroups) {
      if (asset.code) continue;
      const codes = groupCodes.get(normalizeRegionText(kmzGroup(asset.folderPath)));
      if (codes?.size !== 1) continue;
      await this.db.query(`UPDATE network_assets SET attributes=attributes||jsonb_build_object('__atlasProvinceCode',$2::text,'__atlasProvinceSource','kmz-group-spatial-consensus') WHERE id=$1`, [asset.id, [...codes][0]]);
    }

    const { rows } = await this.db.query(`SELECT p.code,btrim(p.name) AS name,count(DISTINCT a.id)::int AS "assetCount",
        count(DISTINCT a.attributes->>'folderPath')::int AS "folderCount",
        ST_XMin(ST_Extent(a.geometry)) AS west,ST_YMin(ST_Extent(a.geometry)) AS south,
        ST_XMax(ST_Extent(a.geometry)) AS east,ST_YMax(ST_Extent(a.geometry)) AS north
      FROM indonesia_provinces p JOIN network_assets a ON a.attributes->>'__atlasProvinceCode'=p.code AND a.source='kml'
      GROUP BY p.code,p.name ORDER BY p.name`)
    const { rows: unresolved } = await this.db.query(`SELECT count(*)::int AS "assetCount",count(DISTINCT attributes->>'folderPath')::int AS "folderCount"
      FROM network_assets WHERE source='kml' AND attributes ? 'folderPath' AND NOT (attributes ? '__atlasProvinceCode')`)
    return {
      items: rows.map(({ west, south, east, north, ...province }) => ({ ...province, bounds: west === null ? null : [west, south, east, north] })),
      unassigned: unresolved[0] ?? { assetCount: 0, folderCount: 0 },
    }
  }

  async listKmzProvinceBoundaries() {
    const { rows } = await this.db.query<KmzProvinceBoundary>(`SELECT a.attributes->>'__atlasProvinceCode' AS "provinceCode",btrim(p.name) AS "provinceName",
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(a.geometry,0.0005),5)::json AS geometry
      FROM network_assets a JOIN indonesia_provinces p ON p.code=a.attributes->>'__atlasProvinceCode'
      WHERE a.source='kml' AND a.attributes->>'folderPath' ~* 'FULL[ _]BOUNDRY|FULL[ _]BOUNDARY'
        AND GeometryType(a.geometry) IN ('POLYGON','MULTIPOLYGON')
      ORDER BY p.name,a.name`)
    return { type: 'FeatureCollection', features: rows.map(({ provinceCode, provinceName, geometry }) => ({ type: 'Feature', geometry, properties: { provinceCode, provinceName } })) }
  }

  async getKmzIcon(id: string) {
    const { rows } = await this.db.query<{ mimeType: string; content: Buffer }>('SELECT mime_type AS "mimeType",content FROM network_kml_icons WHERE id=$1', [id])
    const icon = rows[0]
    if (!icon) throw new NotFoundException('Ikon KMZ tidak ditemukan.')
    return { mimeType: icon.mimeType, data: icon.content.toString('base64') }
  }

  async listMapAssets(bounds: [number, number, number, number], zoom = 16, provinceCode?: string) {
    // Display geometry only; original geometry stays available for editing and exports.
    const tolerance = zoom >= 16 ? 0 : 360 / (512 * 2 ** zoom)
    const { rows } = await this.db.query<AssetRecord>(`SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      ST_AsGeoJSON(CASE WHEN $5::float8 > 0 AND a.source<>'kml' THEN ST_SimplifyPreserveTopology(a.geometry,$5::float8) ELSE a.geometry END,6)::json AS geometry,
      GeometryType(a.geometry) AS "geometryType",a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.geometry && ST_MakeEnvelope($1,$2,$3,$4,4326)
        AND ST_Intersects(a.geometry,ST_MakeEnvelope($1,$2,$3,$4,4326))
        AND ($6::text IS NULL OR ${provinceMatch(6)})
      GROUP BY a.id ORDER BY a.name`, [...bounds, tolerance, provinceCode ?? null])
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
    if ((!sourceAnalysisId && sourceInput?.row !== undefined) || (sourceInput?.row !== undefined && (!Number.isInteger(sourceRow) || sourceRow < 1))) throw new BadRequestException({ message: 'Asal draft analisis tidak valid.' })
    const kinds = ['OLT','JOINT_CLOSURE','HANDHOLE','ODC','ODP','POLE','ROUTE']
    const designId = randomUUID()
    const features = input.map((value) => {
      if (!value || typeof value !== 'object') throw new BadRequestException({ message: 'Fitur desain tidak valid.' })
      const feature = value as { kind?: unknown; name?: unknown; poleHeight?: unknown; routeType?: unknown; designAnchor?: unknown; geometry?: unknown }
      const kind = String(feature.kind ?? '')
      const name = String(feature.name ?? '').trim()
      const poleHeight = feature.poleHeight === '7 m' || feature.poleHeight === '9 m' ? feature.poleHeight : null
      const geometry = feature.geometry as { type?: unknown; coordinates?: unknown } | undefined
      if (!kinds.includes(kind) || !name || name.length > 150 || !geometry || !['Point','LineString'].includes(String(geometry.type)) || !Array.isArray(geometry.coordinates)) throw new BadRequestException({ message: 'Jenis, nama, atau geometri desain tidak valid.' })
      const coordinates = geometry.coordinates as unknown[]
      const points = geometry.type === 'Point' ? [coordinates] : coordinates
      if ((geometry.type === 'Point' && coordinates.length < 2) || (geometry.type === 'LineString' && (coordinates.length < 2 || coordinates.length > 2000)) || points.some((point) => !Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number' || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90)) throw new BadRequestException({ message: 'Koordinat desain tidak valid.' })
      if ((kind === 'ROUTE') !== (geometry.type === 'LineString')) throw new BadRequestException({ message: 'Fitur kabel harus berupa jalur garis; aset perangkat harus berupa titik.' })
      if (feature.designAnchor === true && (kind === 'ROUTE' || geometry.type !== 'Point')) throw new BadRequestException({ message: 'Titik pusat radius desain harus berupa aset titik.' })
      if (kind === 'POLE' && !poleHeight) throw new BadRequestException({ message: 'Setiap tiang draft harus memiliki tinggi 7 m atau 9 m.' })
      const routeType = kind === 'ROUTE' && (feature.routeType === 'FEEDER' || feature.routeType === 'DISTRIBUTION') ? feature.routeType : null
      if (kind === 'ROUTE' && !routeType) throw new BadRequestException({ message: 'Jenis jalur FTTH harus feeder atau distribusi.' })
      const category = kind === 'JOINT_CLOSURE' ? 'JC' : kind === 'HANDHOLE' ? 'HANDHOLE' : kind
      const attributes = { folderPath: `FTTH Draft / ${designId} / ${category}`, ftthDesignId: designId, assetKind: kind, source: 'ftth-design', designAnchor: feature.designAnchor === true || undefined, poleHeight, routeType, coverageRadiusMeters: feature.designAnchor === true || kind === 'OLT' ? 500 : undefined, lineColor: routeType === 'FEEDER' ? '#ff0000' : routeType === 'DISTRIBUTION' ? '#a000ff' : undefined }
      return { id: randomUUID(),kind,name,poleHeight,routeType,designAnchor: feature.designAnchor === true,geometry,geometryJson: JSON.stringify({ type: geometry.type, coordinates }),attributes: JSON.stringify(attributes) }
    })
    const historyId = await this.db.transaction(async (client) => {
      if (sourceAnalysisId) {
        const { rows: parent } = await client.query("SELECT h.analysis_type,h.result,j.id AS job_id FROM analysis_history h LEFT JOIN analysis_bulk_jobs j ON j.history_id=h.id WHERE h.id=$1 AND h.user_id=$2 AND h.analysis_type IN ('ADDRESS','BULK') FOR UPDATE OF h", [sourceAnalysisId,userId])
        if (!parent.length) throw new NotFoundException({ message: 'Riwayat analisis tidak ditemukan.' })
        if (parent[0].analysis_type === 'ADDRESS' && sourceInput?.row !== undefined) throw new BadRequestException({ message: 'Analisis alamat tunggal tidak memakai nomor baris.' })
        if (parent[0].analysis_type === 'BULK') {
          if (!Number.isInteger(sourceRow) || sourceRow < 1) throw new BadRequestException({ message: 'Nomor baris analisis massal tidak valid.' })
          const asyncRow = parent[0].job_id ? await client.query("SELECT 1 FROM analysis_bulk_job_rows WHERE job_id=$1 AND row_number=$2 AND status='OK'", [parent[0].job_id,sourceRow]) : { rows: [] }
          if (!asyncRow.rows.length && (!Array.isArray(parent[0].result?.rows) || !parent[0].result.rows.some((row: { row?: number }) => Number(row.row) === sourceRow))) throw new NotFoundException({ message: 'Baris analisis massal tidak ditemukan atau belum berhasil.' })
        }
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
        features: features.map(({ kind, name, poleHeight, routeType, designAnchor, geometry }) => ({ kind, name, poleHeight, routeType, designAnchor, geometry })),
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
    const [assets, bookings, topSegments] = await Promise.all([
      this.db.query(`SELECT (SELECT count(*)::int FROM network_assets WHERE asset_type='segment') AS segments,
       COALESCE((SELECT sum(total_cores)::int FROM network_assets WHERE asset_type='segment'),0) AS "totalCores",
       (SELECT count(*)::int FROM network_cores c JOIN network_assets a ON a.id=c.asset_id WHERE a.asset_type='segment' AND c.status='Used') AS "usedCores",
       (SELECT count(*)::int FROM network_cores c JOIN network_assets a ON a.id=c.asset_id WHERE a.asset_type='segment' AND c.status='Booked') AS "bookedCores"`),
      this.listBookings(),
      this.listDashboardSegments(),
    ])
    return { ...assets.rows[0], waitingCount: bookings.filter((item) => item.status === 'Waiting List').length, recentBookings: bookings.slice(0, 4), topSegments }
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
      b.segment_id AS "segmentId",b.cores,b.status,b.requested_at AS "requestedAt",b.expires_at AS "expiresAt",
      b.approved_at AS "approvedAt",b.rejected_at AS "rejectedAt",a.name AS "segmentName",a.area
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
        VALUES($1,$2,$3,$4,$5,$6,'Pending Approval',$7,clock_timestamp())`, [id,customer,picCustomer,picPresales,segmentId,cores,userId])
      await this.notifyAdmins(client,'Persetujuan booking core diperlukan',`${customer} meminta ${cores} core pada segmen ${segmentId}.`,id)
      await this.audit(client,userId,'BOOKING_CREATED','BOOKING',id,{ segmentId,cores,status:'Pending Approval' })
      return { id, customer, picCustomer, picPresales, segmentId, cores, status: 'Pending Approval' }
    })
  }

  async approveBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const { rows: targets } = await client.query('SELECT segment_id FROM bookings WHERE id=$1', [id])
      if (!targets.length) throw new NotFoundException({ message: 'Booking tidak ditemukan.' })
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [targets[0].segment_id])
      const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])
      const booking = rows[0]
      if (booking.status !== 'Pending Approval') throw new ConflictException({ message: 'Hanya booking yang menunggu persetujuan yang dapat disetujui.' })
      await client.query("UPDATE bookings SET status='Waiting List',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1", [id,userId])
      const allocatedBookingIds = await this.allocateWaiting(client,booking.segment_id,userId)
      const { rows: result } = await client.query('SELECT status FROM bookings WHERE id=$1', [id])
      const status = result[0].status as string
      await this.audit(client,userId,'BOOKING_APPROVED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores,status,allocatedBookingIds })
      const message = status === 'Booked'
        ? `Booking ${id} disetujui dan ${booking.cores} core telah dialokasikan.`
        : `Booking ${id} disetujui dan masuk waiting list karena kapasitas belum mencukupi.`
      await this.notifyPresales(client,'Booking core disetujui',message,booking.requested_by,id)
      return { id,status,allocatedBookingIds }
    })
  }

  async rejectBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const { rows: targets } = await client.query('SELECT segment_id FROM bookings WHERE id=$1', [id])
      if (!targets.length) throw new NotFoundException({ message: 'Booking tidak ditemukan.' })
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [targets[0].segment_id])
      const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])
      const booking = rows[0]
      if (booking.status !== 'Pending Approval') throw new ConflictException({ message: 'Hanya booking yang menunggu persetujuan yang dapat ditolak.' })
      await client.query("UPDATE bookings SET status='Rejected',rejected_by=$2,rejected_at=clock_timestamp() WHERE id=$1", [id,userId])
      await this.audit(client,userId,'BOOKING_REJECTED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores })
      await this.notifyPresales(client,'Booking core ditolak',`Permintaan booking ${id} untuk ${booking.customer} ditolak oleh ADMIN.`,booking.requested_by,id)
      return { id,status:'Rejected' }
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
      await this.notifyPresales(client,'Booking core dilepas',`${booking.customer}: ${booking.cores} core dilepas. ${allocatedBookingIds.length} permintaan waiting list dialokasikan.`,booking.requested_by ?? userId,id)
      return { released: id, allocated: allocatedBookingIds[0] ?? null, allocatedBookingIds }
    })
  }

  // All callers hold the segment lock; the first unfulfilled request blocks later requests.
  private async allocateWaiting(client: PoolClient, segmentId: string, actorId: string | null = null) {
    const { rows: queue } = await client.query("SELECT * FROM bookings WHERE segment_id=$1 AND status='Waiting List' ORDER BY COALESCE(approved_at,requested_at),requested_at,id FOR UPDATE", [segmentId])
    const { rows: settings } = await client.query("SELECT value FROM app_settings WHERE key='booking_duration_days'")
    const days = Number(settings[0]?.value ?? 30)
    const allocated: string[] = []
    for (const booking of queue) {
      const { rows: available } = await client.query("SELECT id FROM network_cores WHERE asset_id=$1 AND status='Available' ORDER BY core_number LIMIT $2 FOR UPDATE", [segmentId,booking.cores])
      if (available.length !== booking.cores) break
      await this.assignCores(client,booking.id,available.map((row) => row.id))
      await client.query("UPDATE bookings SET status='Booked',expires_at=now()+($2||' days')::interval WHERE id=$1", [booking.id,days])
      await this.audit(client,actorId,'WAITING_LIST_ALLOCATED','BOOKING',booking.id,{ segmentId,cores: booking.cores })
      await this.notifyPresales(client,'Waiting list dialokasikan',`${booking.customer}: ${booking.cores} core tersedia dan booking ${booking.id} aktif.`,booking.requested_by,booking.id)
      allocated.push(booking.id)
    }
    return allocated
  }

  private async notifyPresales(client: PoolClient, title: string, message: string, requestorId?: string, bookingId?: string) {
    await client.query(`INSERT INTO notifications(user_id,title,message,booking_id)
      SELECT id,$1,$2,$4 FROM "user" WHERE role='PRESALES' OR id=$3`, [title,message,requestorId ?? '',bookingId ?? null])
  }

  private async notifyAdmins(client: PoolClient, title: string, message: string, bookingId?: string) {
    await client.query(`INSERT INTO notifications(user_id,title,message,booking_id)
      SELECT id,$1,$2,$3 FROM "user" WHERE role='ADMIN'`, [title,message,bookingId ?? null])
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
      await this.notifyPresales(client,'Booking core kedaluwarsa',`${booking.customer}: masa booking ${booking.id} berakhir dan ${booking.cores} core dilepas.`,booking.requested_by,id)
      const allocatedBookingIds = await this.allocateWaiting(client,booking.segment_id)
      await this.audit(client,null,'BOOKING_EXPIRED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores,allocatedBookingIds })
    })
  }

  async nearestNetwork(longitude: number, latitude: number, allowExpand2km = false) {
    for (const radius of (allowExpand2km ? [500, 1000, 2000] : [500, 1000])) {
      const { rows } = await this.db.query<{ id: string; name: string; area: string; cableType: string; assetType: string; totalCores: number; attributes: Record<string, unknown>; source: string; nearestPoint: { coordinates: [number,number] }; straightDistanceMeters: number; searchRadiusMeters: number; geometry: unknown }>(`SELECT a.id,a.name,a.area,a.cable_type AS "cableType",a.asset_type AS "assetType",a.total_cores AS "totalCores",a.attributes,a.source,
        ST_AsGeoJSON(a.geometry)::json AS geometry,
        ST_AsGeoJSON(ST_ClosestPoint(a.geometry,ST_SetSRID(ST_MakePoint($1,$2),4326)))::json AS "nearestPoint",
        ST_Distance(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS "straightDistanceMeters",
        $3::int AS "searchRadiusMeters"
        FROM network_assets a
        WHERE GeometryType(a.geometry) IN ('POINT','MULTIPOINT','LINESTRING','MULTILINESTRING')
          AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
          AND ST_DWithin(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3)
        ORDER BY CASE
          WHEN a.total_cores>0 AND (a.source='managed' OR a.attributes->>'__coreUsageVerified'='true') AND EXISTS(SELECT 1 FROM network_cores c WHERE c.asset_id=a.id AND c.status='Available') THEN 0
          WHEN a.total_cores>0 AND (SELECT count(*) FROM network_cores c WHERE c.asset_id=a.id AND c.status IN ('Used','Booked'))>=a.total_cores THEN 2
          ELSE 1 END,
        ST_Distance(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography),a.id LIMIT 1`, [longitude,latitude,radius]);
      if (rows[0]) {
        const asset = rows[0];
        const { rows: counts } = await this.db.query(`SELECT count(*) FILTER(WHERE status='Used')::int AS used,count(*) FILTER(WHERE status='Booked')::int AS booked,count(*) FILTER(WHERE status='Available')::int AS available FROM network_cores WHERE asset_id=$1`, [asset.id]);
        const { rows: connectedCables } = await this.db.query(`SELECT DISTINCT a.id,a.name,a.total_cores AS "totalCores" FROM network_asset_relations r JOIN network_assets a ON a.id=r.segment_id WHERE r.asset_id=$1 ORDER BY a.name`, [asset.id]);
        const attributes = asset.attributes ?? {};
        const deviceType = Object.entries(attributes).find(([key]) => /^(tipe[ _]?perangkat|assetKind)$/i.test(key))?.[1] ?? (asset.assetType === 'segment' ? 'Kabel' : 'Aset jaringan');
        const capacityFields = Object.entries(attributes).filter(([key]) => !key.startsWith('__') && /core|port|splitter|spesifikasi|kapasitas/i.test(key)).map(([label,value]) => ({ label, value }));
        const verified = asset.source === 'managed' || attributes.__coreUsageVerified === true;
        const full = asset.totalCores > 0 && (counts[0]?.used ?? 0) + (counts[0]?.booked ?? 0) >= asset.totalCores;
        const chamber = /handhole|manhole|^(HH|MH)$/i.test(String(deviceType));
        const recommendation = full ? 'CORE_FULL' : chamber && !connectedCables.length ? 'NO_CABLE_RELATION' : verified && asset.totalCores > 0 && counts[0]?.available > 0 ? 'CAPACITY_AVAILABLE' : 'SURVEY_REQUIRED';
        const recommendationReason = full ? 'Core tercatat penuh. Titik ini tidak direkomendasikan untuk sambungan baru.' : chamber && !connectedCables.length ? 'Aset akses kabel belum memiliki relasi kabel. Titik sambung perlu diperiksa.' : recommendation === 'CAPACITY_AVAILABLE' ? 'Core tersedia tercatat dan diprioritaskan di antara kandidat dalam radius pencarian. Kelayakan fisik tetap perlu diperiksa.' : 'Kapasitas atau pemakaian belum terverifikasi. Jalur kabel merupakan estimasi untuk survei.';
        return { ...asset, capacity: { deviceType: String(deviceType), totalCores: asset.totalCores > 0 ? asset.totalCores : null, usedCores: counts[0]?.used ?? 0, bookedCores: counts[0]?.booked ?? 0, availableCores: counts[0]?.available ?? 0,
          recommendation, recommendationReason, usageVerified: asset.source === 'managed' || attributes.__coreUsageVerified === true, fields: capacityFields, connectedCables } };
      }
    }
    return null;
  }

  async notifications(userId: string) {
    const { rows } = await this.db.query('SELECT id,title,message,booking_id AS "bookingId",read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [userId])
    return rows
  }
  async markNotificationRead(id: string, userId: string) {
    await this.db.transaction(async (client) => {
      const { rowCount } = await client.query('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [id,userId])
      if (!rowCount) throw new NotFoundException({ message: 'Notifikasi tidak ditemukan.' })
      await this.audit(client,userId,'NOTIFICATION_READ','NOTIFICATION',id,{ read: true })
    })
    return { id, read: true }
  }
}
