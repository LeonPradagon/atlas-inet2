import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { Database } from '../database/database'

type AssetRecord = {
  id: string; name: string; area: string; assetType: string; source: string; cableType: string; installation: string; side: string;
  pole: string; poleHeight: string | null; odc: string; odp: string; totalCores: number; usedCores: number; bookedCores: number; idleCores: number;
  geometry: unknown; attributes: Record<string, unknown>
}

@Injectable()
export class AtlasService implements OnModuleInit, OnModuleDestroy {
  private expiryTimer?: NodeJS.Timeout
  constructor(@Inject(Database) private readonly db: Database) {}

  private async audit(client: PoolClient, actorId: string | null, action: string, entityType: string, entityId: string | null, details: Record<string, unknown>) {
    await client.query('INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)', [actorId,action,entityType,entityId,JSON.stringify(details)])
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
      COALESCE(a.source_geometry,ST_AsGeoJSON(a.geometry)::jsonb) AS geometry,a.attributes
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE $1='' OR a.name ILIKE '%'||$1||'%' OR a.area ILIKE '%'||$1||'%'
      GROUP BY a.id ORDER BY a.name`, [search])
    const pattern = new RegExp((await this.getCableNamePattern()).pattern)
    return rows.map((asset) => ({ ...asset, nameValid: pattern.test(asset.name) }))
  }

  async updateAsset(id: string, body: Record<string, unknown>, userId: string) {
    const validInstallation = ['Aerial', 'Burial'].includes(String(body.installation))
    const validSide = ['Kiri', 'Kanan'].includes(String(body.side))
    const total = Number(body.totalCores)
    if (body.installation !== undefined && !validInstallation) throw new BadRequestException({ message: 'Metode instalasi harus Aerial atau Burial.' })
    if (body.side !== undefined && !validSide) throw new BadRequestException({ message: 'Sisi jalan harus Kiri atau Kanan.' })
    if (body.poleHeight !== undefined && body.poleHeight !== null && !['7 m', '9 m'].includes(String(body.poleHeight))) throw new BadRequestException({ message: 'Tinggi tiang harus 7 m atau 9 m.' })
    if (body.totalCores !== undefined && (!Number.isInteger(total) || total < 0 || total > 4096)) throw new BadRequestException({ message: 'Jumlah core harus bilangan bulat 0–4096.' })
    const { rows } = await this.db.query(`UPDATE network_assets SET
      name=COALESCE($2,name), area=COALESCE($3,area), cable_type=COALESCE($4,cable_type),
      installation=CASE WHEN $5 THEN $6 ELSE installation END, road_side=CASE WHEN $7 THEN $8 ELSE road_side END,
      pole=COALESCE($9,pole), pole_height=CASE WHEN $10 THEN $11 ELSE pole_height END,
      odc=COALESCE($12,odc), odp=COALESCE($13,odp), updated_at=now()
      WHERE id=$1 RETURNING id`, [id,body.name ?? null,body.area ?? null,body.cableType ?? null,body.installation !== undefined,validInstallation ? body.installation : 'Aerial',body.side !== undefined,validSide ? body.side : 'Kiri',body.pole ?? null,body.poleHeight !== undefined,body.poleHeight ?? null,body.odc ?? null,body.odp ?? null])
    if (!rows.length) throw new NotFoundException({ message: 'Aset tidak ditemukan.' })
    if (body.totalCores !== undefined) await this.db.transaction(async (client) => this.setCoreCount(client, id, total))
    await this.db.query("INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'ASSET_UPDATED','ASSET',$2,$3::jsonb)", [userId,id,JSON.stringify({ fields: Object.keys(body) })])
    return (await this.listAssets()).find((asset) => asset.id === id)
  }

  async listCores(assetId: string) {
    const { rows } = await this.db.query(`SELECT c.core_number AS "coreNumber",c.status,b.id AS "bookingId",b.customer,b.expires_at AS "expiresAt"
      FROM network_cores c LEFT JOIN booking_cores bc ON bc.core_id=c.id LEFT JOIN bookings b ON b.id=bc.booking_id
      WHERE c.asset_id=$1 ORDER BY c.core_number`, [assetId])
    return rows
  }

  private async setCoreCount(client: PoolClient, assetId: string, total: number) {
    await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [assetId])
    const { rows: active } = await client.query(`SELECT count(*)::int AS count FROM network_cores WHERE asset_id=$1 AND status <> 'Available'`, [assetId])
    if (active[0].count > total) throw new ConflictException({ message: 'Jumlah core tidak boleh lebih kecil dari core yang sudah digunakan atau dibooking.' })
    await client.query(`DELETE FROM network_cores WHERE asset_id=$1 AND core_number > $2 AND status='Available'`, [assetId,total])
    await client.query(`INSERT INTO network_cores(asset_id,core_number) SELECT $1,n FROM generate_series(1,$2) n ON CONFLICT DO NOTHING`, [assetId,total])
    await client.query('UPDATE network_assets SET total_cores=$2,updated_at=now() WHERE id=$1', [assetId,total])
  }

  async setCoreStatus(assetId: string, coreNumber: number, status: string | undefined, userId: string) {
    if (!Number.isInteger(coreNumber) || coreNumber < 1 || !['Available','Used'].includes(String(status))) throw new BadRequestException({ message: 'Status core harus Available atau Used.' })
    return this.db.transaction(async (client) => {
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [assetId])
      const { rows } = await client.query('SELECT id,status FROM network_cores WHERE asset_id=$1 AND core_number=$2 FOR UPDATE', [assetId,coreNumber])
      if (!rows.length) throw new NotFoundException({ message: 'Core tidak ditemukan.' })
      if (rows[0].status === 'Booked') throw new ConflictException({ message: 'Core yang sedang dibooking tidak dapat diubah.' })
      await client.query('UPDATE network_cores SET status=$3 WHERE asset_id=$1 AND core_number=$2', [assetId,coreNumber,status])
      if (status === 'Available') {
        const allocation = await this.allocateWaiting(client,assetId)
        if (allocation) await this.notifyPresales(client,'Kapasitas core tersedia',`${allocation.customer} dialokasikan dari waiting list.`,userId)
      }
      await this.audit(client,userId,'CORE_STATUS_CHANGED','CORE',`${assetId}:${coreNumber}`,{ assetId,coreNumber,status })
      return { assetId, coreNumber, status }
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
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.asset_type='segment' GROUP BY a.id ORDER BY a.area,a.name`)
    return rows
  }

  async listBookings() {
    const { rows } = await this.db.query(`SELECT b.id,b.customer,b.pic_customer AS "picCustomer",b.pic_presales AS "picPresales",
      b.segment_id AS "segmentId",b.cores,b.status,b.requested_at AS "requestedAt",b.expires_at AS "expiresAt",a.name AS "segmentName",a.area
      FROM bookings b JOIN network_assets a ON a.id=b.segment_id ORDER BY b.requested_at DESC`)
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
      const { rows: assets } = await client.query('SELECT total_cores FROM network_assets WHERE id=$1 FOR UPDATE', [segmentId])
      if (!assets.length) throw new NotFoundException({ message: 'Segmen tidak ditemukan.' })
      if (cores > assets[0].total_cores) throw new BadRequestException({ message: 'Jumlah booking melebihi kapasitas total segmen.' })
      const { rows: available } = await client.query(`SELECT id FROM network_cores WHERE asset_id=$1 AND status='Available' ORDER BY core_number LIMIT $2 FOR UPDATE`, [segmentId,cores])
      const status = available.length === cores ? 'Booked' : 'Waiting List'
      const id = `BKG-${randomUUID().slice(0,8).toUpperCase()}`
      const { days } = await this.getBookingDuration()
      await client.query(`INSERT INTO bookings(id,customer,pic_customer,pic_presales,segment_id,cores,status,requested_by,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $7='Booked' THEN now()+($9||' days')::interval ELSE NULL END)`,
        [id,customer,picCustomer,picPresales,segmentId,cores,status,userId,days])
      if (status === 'Booked') await this.assignCores(client,id,available.map((row) => row.id))
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
      const { rows } = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [id])
      if (!rows.length) throw new NotFoundException({ message: 'Booking tidak ditemukan.' })
      const booking = rows[0]
      if (booking.status !== 'Booked') throw new ConflictException({ message: 'Hanya booking aktif yang dapat dilepas.' })
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [booking.segment_id])
      await client.query("UPDATE network_cores SET status='Available' WHERE id IN (SELECT core_id FROM booking_cores WHERE booking_id=$1)", [id])
      await client.query('DELETE FROM booking_cores WHERE booking_id=$1', [id])
      await client.query("UPDATE bookings SET status='Released',released_at=now() WHERE id=$1", [id])
      const allocation = await this.allocateWaiting(client, booking.segment_id)
      await this.audit(client,userId,'BOOKING_RELEASED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores,allocatedBookingId: allocation?.id ?? null })
      await this.notifyPresales(client, 'Booking core dilepas', allocation ? `${allocation.customer} dialokasikan ke segmen setelah kapasitas dilepas.` : `${booking.cores} core kembali tersedia.`, allocation?.requested_by ?? userId)
      return { released: id, allocated: allocation?.id ?? null }
    })
  }

  private async allocateWaiting(client: PoolClient, segmentId: string) {
    const { rows: queue } = await client.query("SELECT * FROM bookings WHERE segment_id=$1 AND status='Waiting List' ORDER BY requested_at,id LIMIT 1 FOR UPDATE", [segmentId])
    if (!queue.length) return null
    const booking = queue[0]
    const { rows: available } = await client.query("SELECT id FROM network_cores WHERE asset_id=$1 AND status='Available' ORDER BY core_number LIMIT $2 FOR UPDATE", [segmentId,booking.cores])
    if (available.length !== booking.cores) return null
    const { days } = await this.getBookingDuration()
    await this.assignCores(client,booking.id,available.map((row) => row.id))
    await client.query("UPDATE bookings SET status='Booked',expires_at=now()+($2||' days')::interval WHERE id=$1", [booking.id,days])
    return booking
  }

  private async notifyPresales(client: PoolClient, title: string, message: string, requestorId?: string) {
    await client.query(`INSERT INTO notifications(user_id,title,message)
      SELECT id,$1,$2 FROM "user" WHERE role='PRESALES' OR id=$3`, [title,message,requestorId ?? ''])
  }

  private async expireBookings() {
    const { rows } = await this.db.query("SELECT id FROM bookings WHERE status='Booked' AND expires_at <= now() ORDER BY expires_at LIMIT 50")
    for (const { id } of rows) await this.db.transaction(async (client) => {
      const { rows: locked } = await client.query('SELECT * FROM bookings WHERE id=$1 AND status=\'Booked\' FOR UPDATE', [id])
      if (!locked.length) return
      const booking = locked[0]
      await client.query('SELECT id FROM network_assets WHERE id=$1 FOR UPDATE', [booking.segment_id])
      await client.query("UPDATE network_cores SET status='Available' WHERE id IN (SELECT core_id FROM booking_cores WHERE booking_id=$1)", [id])
      await client.query('DELETE FROM booking_cores WHERE booking_id=$1', [id])
      await client.query("UPDATE bookings SET status='Expired',released_at=now() WHERE id=$1", [id])
      const allocation = await this.allocateWaiting(client,booking.segment_id)
      await this.audit(client,null,'BOOKING_EXPIRED','BOOKING',id,{ segmentId: booking.segment_id,cores: booking.cores,allocatedBookingId: allocation?.id ?? null })
      if (allocation) await this.notifyPresales(client,'Kapasitas core tersedia',`${allocation.customer} dialokasikan dari waiting list.`)
    })
  }

  async nearestNetwork(longitude: number, latitude: number) {
    const { rows } = await this.db.query(`SELECT a.id,a.name,a.area,a.cable_type AS "cableType",
      ST_AsGeoJSON(ST_ClosestPoint(a.geometry,ST_SetSRID(ST_MakePoint($1,$2),4326)))::json AS "nearestPoint",
      ST_Distance(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)::int AS "straightDistanceMeters"
      FROM network_assets a WHERE a.geometry IS NOT NULL ORDER BY a.geometry <-> ST_SetSRID(ST_MakePoint($1,$2),4326) LIMIT 1`, [longitude,latitude])
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
