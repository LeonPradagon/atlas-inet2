const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { randomBytes } = require('node:crypto')
const { Pool } = require('pg')

// Creates and drops only a uniquely named test database. Application data is never modified.
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be configured to create the isolated test database.')
  const testName = `atlas_test_${Date.now()}_${randomBytes(4).toString('hex')}`
  const adminUrl = new URL(process.env.DATABASE_URL)
  adminUrl.pathname = '/postgres'
  const admin = new Pool({ connectionString: adminUrl.toString() })
  let db, app, created = false
  const testPools = []
  const pg = require('pg')
  const OriginalPool = pg.Pool
  try {
    await admin.query(`CREATE DATABASE "${testName}"`)
    created = true
    const testUrl = new URL(process.env.DATABASE_URL)
    testUrl.pathname = `/${testName}`
    process.env.DATABASE_URL = testUrl.toString()
    pg.Pool = class TestPool extends OriginalPool {
      constructor(options) { super(options); testPools.push(this) }
    }
    const { Database } = require('../dist/database/database')
    const { AtlasService } = require('../dist/atlas/atlas.service')
    db = new Database()
    await db.query(await readFile('src/database/migrations/001-initial.sql', 'utf8'))
    // Prove the new migration is idempotent.
    await db.query(await readFile('src/database/migrations/001-initial.sql', 'utf8'))
    await db.query(await readFile('src/database/migrations/003-analysis-history.sql', 'utf8'))
    await db.query(await readFile('src/database/migrations/007-bulk-analysis-jobs.sql', 'utf8'))
    await db.query(`INSERT INTO "user"(id,name,email,role) VALUES('admin','Test Admin','admin@atlas.test','ADMIN'),('presales','Test Presales','presales@atlas.test','PRESALES')`)
    const atlas = new AtlasService(db)
    const q = (sql, values) => db.query(sql, values)
    const savedDesign = await atlas.saveFtthDesign([
      { kind:'HANDHOLE',name:'Handhole anchor',designAnchor:true,geometry:{ type:'Point',coordinates:[106.8,-6.2] } },
      { kind:'ODC',name:'ODC test',geometry:{ type:'Point',coordinates:[106.801,-6.201] } },
      { kind:'ROUTE',name:'Kabel test',routeType:'FEEDER',geometry:{ type:'LineString',coordinates:[[106.8,-6.2],[106.801,-6.201]] } },
    ],'admin','Test Area')
    const savedAnchor = await q("SELECT attributes FROM network_assets WHERE attributes->>'ftthDesignId'=$1 AND attributes->>'designAnchor'='true'",[savedDesign.designId])
    assert.equal(savedAnchor.rows.length,1)
    assert.equal(savedAnchor.rows[0].attributes.coverageRadiusMeters,500)
    console.log('PASS: FTTH design persists its selected anchor and coverage radius')
    const booking = (segmentId, cores) => atlas.createBooking({ segmentId, cores, customer: `Customer ${randomBytes(4).toString('hex')}`, picCustomer: 'Customer PIC', picPresales: 'Presales PIC' }, 'presales')
    const status = async (id) => (await q('SELECT status FROM bookings WHERE id=$1',[id])).rows[0].status
    async function segment(id, count) {
      await q(`INSERT INTO network_assets(id,name,asset_type,source,area,geometry,source_geometry,attributes) VALUES($1,$1,'segment','kml','Original area',ST_GeomFromText('LINESTRING(106.8 -6.2,106.81 -6.21)',4326),'{"type":"LineString","coordinates":[[106.8,-6.2,12],[106.81,-6.21,13]]}','{"__kmlStyle":{"lineColor":"#ff0000"},"name":"Original KML"}')`,[id])
      await atlas.updateAsset(id,{ totalCores: count },'admin')
    }
    await segment('multi',6)
    const hold = await booking('multi',6)
    const queue = await Promise.all([booking('multi',2),booking('multi',2),booking('multi',2)])
    assert(queue.every((b) => b.status === 'Waiting List'))
    const before = Number((await q('SELECT count(*) AS n FROM notifications')).rows[0].n)
    const released = await atlas.releaseBooking(hold.id,'presales')
    assert.equal(released.allocatedBookingIds.length,3)
    assert.equal(released.allocated,released.allocatedBookingIds[0])
    for (const b of queue) assert.equal(await status(b.id),'Booked')
    assert.equal(Number((await q('SELECT count(*) AS n FROM notifications')).rows[0].n)-before,4)
    assert.equal((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action='WAITING_LIST_ALLOCATED' AND details->>'segmentId'='multi'")).rows[0].n,4)
    console.log('PASS: one release allocates multiple requests, with notifications and audit')

    await segment('fifo',6)
    for (const n of [1,2,3]) await atlas.setCoreStatus('fifo',n,'Used','admin')
    const head = await booking('fifo',4), tail = await booking('fifo',2)
    assert.equal(head.status,'Waiting List'); assert.equal(tail.status,'Waiting List')
    assert.equal((await atlas.listCores('fifo')).filter((c) => c.status === 'Available').length,3)
    const changed = await atlas.setCoreStatus('fifo',1,'Available','admin')
    assert.equal(changed.status,'Booked')
    assert.equal(await status(head.id),'Booked'); assert.equal(await status(tail.id),'Waiting List')
    await atlas.setCoreStatus('fifo',2,'Available','admin')
    assert.equal(await status(tail.id),'Waiting List')
    await atlas.setCoreStatus('fifo',3,'Available','admin')
    assert.equal(await status(tail.id),'Booked')
    console.log('PASS: strict FIFO, no new request bypass, Available status triggers allocation')

    await segment('capacity',4)
    await booking('capacity',4)
    const capacityHead = await booking('capacity',4), capacityTail = await booking('capacity',2)
    await atlas.updateAsset('capacity',{ totalCores: 6 },'admin')
    assert.equal(await status(capacityTail.id),'Waiting List')
    await atlas.updateAsset('capacity',{ totalCores: 10, area: 'Updated area' },'admin')
    assert.equal(await status(capacityHead.id),'Booked'); assert.equal(await status(capacityTail.id),'Booked')
    await segment('rollback',8)
    await atlas.setCoreStatus('rollback',8,'Used','admin')
    const snapshot = (await q('SELECT * FROM network_assets WHERE id=$1',['rollback'])).rows[0]
    const auditBefore = Number((await q('SELECT count(*) AS n FROM audit_logs')).rows[0].n)
    await assert.rejects(atlas.updateAsset('rollback',{ area:'Must rollback',totalCores:2 },'admin'),(e) => e.getStatus() === 409)
    const unchanged = (await q('SELECT * FROM network_assets WHERE id=$1',['rollback'])).rows[0]
    assert.equal(unchanged.area,snapshot.area); assert.equal(unchanged.total_cores,8)
    assert.equal(Number((await q('SELECT count(*) AS n FROM audit_logs')).rows[0].n),auditBefore)
    await atlas.setCoreStatus('rollback',8,'Available','admin')
    await atlas.updateAsset('rollback',{ totalCores:2 },'admin')
    assert.equal((await atlas.listCores('rollback')).length,2)
    console.log('PASS: capacity growth allocates FIFO; occupied high core blocks reduction with full rollback')

    await segment('expiry',4)
    const expiring = await booking('expiry',4)
    const expiryQueue = [await booking('expiry',2),await booking('expiry',2)]
    await q("UPDATE bookings SET expires_at=now()-interval '1 second' WHERE id=$1",[expiring.id])
    await Promise.all([atlas.expireBookings(),atlas.expireBookings()])
    assert.equal(await status(expiring.id),'Expired')
    for (const b of expiryQueue) assert.equal(await status(b.id),'Booked')
    assert.equal((await q("SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='BOOKING_EXPIRED'",[expiring.id])).rows[0].n,1)
    console.log('PASS: concurrent expiry runs release and allocate exactly once')

    await segment('concurrent',8)
    const concurrent = await Promise.all(Array.from({ length:20 },() => booking('concurrent',1)))
    assert.equal(concurrent.filter((b) => b.status === 'Booked').length,8)
    const active = concurrent.filter((b) => b.status === 'Booked')
    const outcomes = await Promise.allSettled([atlas.releaseBooking(active[0].id,'presales'),atlas.releaseBooking(active[0].id,'presales')])
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length,1)
    await Promise.all(active.slice(1,5).map((b) => atlas.releaseBooking(b.id,'presales')))
    const consistency = (await q(`SELECT (SELECT count(*) FROM network_cores WHERE asset_id='concurrent' AND status='Booked') AS cores,
      (SELECT sum(cores) FROM bookings WHERE segment_id='concurrent' AND status='Booked') AS booked,
      (SELECT count(*) FROM booking_cores bc JOIN network_cores c ON c.id=bc.core_id WHERE c.asset_id='concurrent') AS assignments`)).rows[0]
    assert.equal(Number(consistency.cores),8); assert.equal(Number(consistency.booked),8); assert.equal(Number(consistency.assignments),8)
    assert.equal((await q('SELECT core_id FROM booking_cores GROUP BY core_id HAVING count(*)>1')).rows.length,0)
    console.log('PASS: concurrent bookings/releases cannot double-assign cores')

    await segment('related',4)
    await segment('shared',4)
    for (const id of ['pole-a','pole-b','odc-a','odp-a']) await q(`INSERT INTO network_assets(id,name,asset_type,source,geometry,attributes) VALUES($1,$1,'asset','kml',ST_SetSRID(ST_MakePoint(106.8,-6.2),4326),'{"__kmlStyle":{"iconColor":"#00ff00"}}')`,[id])
    const relatedSource = (await q('SELECT geometry,source_geometry,attributes FROM network_assets WHERE id=$1',['related'])).rows[0]
    const poleSource = (await q('SELECT geometry,attributes FROM network_assets WHERE id=$1',['pole-a'])).rows[0]
    await atlas.updateAsset('related',{ cableType:'Feeder',installation:'Burial',side:'Kanan' },'admin')
    const relations = [{ assetId:'pole-a',kind:'POLE' },{ assetId:'pole-b',kind:'POLE' },{ assetId:'odc-a',kind:'ODC' },{ assetId:'odp-a',kind:'ODP' }]
    await atlas.saveRelations('related',relations,'admin')
    await atlas.saveRelations('shared',[relations[0]],'admin')
    await atlas.updateAsset('pole-a',{ poleHeight:'9 m' },'admin')
    assert.equal((await atlas.listRelations('shared'))[0].poleHeight,'9 m')
    assert.equal((await atlas.listRelations('related')).length,4)
    assert.equal((await atlas.networkUsageReport()).find((row) => row.id === 'related').relatedAssets.find((r) => r.assetId === 'pole-a').poleHeight,'9 m')
    await assert.rejects(atlas.saveRelations('related',[relations[0],relations[0]],'admin'),(e) => e.getStatus() === 400)
    await assert.rejects(atlas.saveRelations('related',[{ assetId:'shared',kind:'POLE' }],'admin'),(e) => e.getStatus() === 400)
    await assert.rejects(atlas.saveRelations('related',[{ assetId:'missing',kind:'ODC' }],'admin'),(e) => e.getStatus() === 400)
    assert.equal((await atlas.listRelations('related')).length,4)
    const db2 = new Database(), atlas2 = new AtlasService(db2)
    assert.equal((await atlas2.listRelations('related')).length,4)
    await db2.onModuleDestroy()
    await atlas.saveRelations('related',[],'admin')
    assert.equal((await atlas.listRelations('related')).length,0)
    assert.deepEqual((await q('SELECT geometry,source_geometry,attributes FROM network_assets WHERE id=$1',['related'])).rows[0],relatedSource)
    assert.deepEqual((await q('SELECT geometry,attributes FROM network_assets WHERE id=$1',['pole-a'])).rows[0],poleSource)
    const sourceAfter = (await q('SELECT * FROM network_assets WHERE id=$1',['rollback'])).rows[0]
    assert.deepEqual(sourceAfter.source_geometry,snapshot.source_geometry)
    assert.deepEqual(sourceAfter.attributes,snapshot.attributes)
    assert.equal(sourceAfter.geometry,snapshot.geometry)
    console.log('PASS: multi-asset relations, shared heights, removal, persistence, exports, unchanged source geometry/style')

    // Exercise real controller routes and RBAC with isolated test sessions, not application accounts.
    const { NestFactory } = require('@nestjs/core')
    const { AppModule } = require('../dist/app.module')
    const { AuthService } = require('../dist/auth/auth.service')
    const { auth, adminAuth } = require('../dist/auth/auth')
    await Promise.all([auth.$context,adminAuth.$context])
    app = await NestFactory.create(AppModule,{ logger:['error'] })
    app.setGlobalPrefix('api')
    app.get(AuthService).session = async (req) => {
      const id = req.headers['x-atlas-test-user']
      return ['admin','presales'].includes(id) ? { user: { id,role:id === 'admin' ? 'ADMIN' : 'PRESALES' } } : null
    }
    await app.listen(0,'127.0.0.1')
    const origin = await app.getUrl()
    const request = (path,user,method='GET',data) => fetch(`${origin}/api${path}`,{ method,headers:{ ...(user ? { 'x-atlas-test-user':user } : {}),'Content-Type':'application/json' },body:data ? JSON.stringify(data) : undefined })
    assert.equal((await request('/assets/shared/relations')).status,401)
    assert.equal((await request('/assets/shared/relations','presales')).status,200)
    assert.equal((await request('/assets/shared/relations','presales','PUT',{ relations:[] })).status,403)
    assert.equal((await request('/assets/shared/relations','admin','PUT',{ relations:[relations[0]] })).status,200)
    assert.equal((await request('/assets/pole-a','presales','PATCH',{ poleHeight:'7 m' })).status,403)
    assert.equal((await request('/assets/pole-a','admin','PATCH',{ poleHeight:'7 m' })).status,200)
    assert.equal((await request('/assets/shared/cores/1','presales','PATCH',{ status:'Used' })).status,403)
    console.log('PASS: HTTP authentication and ADMIN/PRESALES access boundaries')

    const ExcelJS = require('exceljs')
    const { NetworkImportService } = require('../dist/network/network-import.service')
    const workbookImport = new NetworkImportService(db)
    await assert.rejects(workbookImport.analyzeWorkbook(Buffer.alloc(15 * 1024 * 1024 + 1),{ maxBytes:15 * 1024 * 1024,maxRows:5000 }),(error) => error.getStatus() === 400)
    const tooMany = new ExcelJS.Workbook()
    const tooManySheet = tooMany.addWorksheet('Lokasi')
    tooManySheet.addRow(['Alamat','Latitude','Longitude'])
    for (let row = 0; row < 5001; row++) tooManySheet.addRow(['',-6.2,106.8])
    await assert.rejects(workbookImport.analyzeWorkbook(Buffer.from(await tooMany.xlsx.writeBuffer()),{ maxBytes:15 * 1024 * 1024,maxRows:5000 }),(error) => error.getStatus() === 400)
    console.log('PASS: 15 MB upload boundary and 5,000-row input limit')

    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Lokasi')
    sheet.addRow(['Alamat','Provinsi','Kabupaten/Kota','Kecamatan','Kelurahan/Desa','Nomor Rumah','Kode Pos','Latitude','Longitude'])
    sheet.addRow(['','', '', '', '', '', '',-6.2,106.8])
    sheet.addRow(['','','','','','','',-6.21,106.81])
    sheet.addRow(['','','','','','','',-6.2,''])
    sheet.addRow(['Jl. Contoh No. 1','DKI Jakarta','Kota Administrasi Jakarta Barat','','','','','',''])
    const file = new Blob([await workbook.xlsx.writeBuffer()],{ type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const form = new FormData()
    form.append('file',file,'bulk-test.xlsx')
    const upload = await fetch(`${origin}/api/analysis/bulk/jobs`,{ method:'POST',headers:{ 'x-atlas-test-user':'admin' },body:form })
    const uploaded = await upload.json()
    assert.equal(upload.status,201,JSON.stringify(uploaded))
    const job = uploaded
    assert.equal(job.total,4)
    assert.equal((await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}`)).status,401)
    assert.equal((await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}`,{ headers:{ 'x-atlas-test-user':'presales' } })).status,404)
    let progress = job
    for (let attempt = 0; attempt < 30 && !['COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED','FAILED'].includes(progress.status); attempt++) {
      await new Promise((resolve) => setTimeout(resolve,500))
      const response = await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}`,{ headers:{ 'x-atlas-test-user':'admin' } })
      progress = await response.json()
    }
    assert.equal(progress.processed,4)
    assert.ok(progress.failed >= 2)
    const terminalRows = await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}/rows?page=1&pageSize=50`,{ headers:{ 'x-atlas-test-user':'admin' } }).then((response) => response.json())
    assert.ok(terminalRows.rows.every((row) => !['QUEUED','PROCESSING'].includes(row.status)))
    const resultPage = await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}/rows?page=2&pageSize=2`,{ headers:{ 'x-atlas-test-user':'admin' } }).then((response) => response.json())
    assert.equal(resultPage.total,4)
    assert.equal(resultPage.rows.length,2)
    assert.ok(resultPage.rows.some((row) => row.message === 'Latitude dan Longitude harus diisi berpasangan.'))
    assert.ok(resultPage.rows.some((row) => row.message === 'Alamat tanpa koordinat wajib memiliki Alamat, Provinsi, Kabupaten/Kota, dan Kecamatan.'))
    const failedPage = await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}/rows?page=1&pageSize=100&status=ERROR`,{ headers:{ 'x-atlas-test-user':'admin' } }).then((response) => response.json())
    assert.ok(failedPage.total >= 2)
    const history = await db.query('SELECT input->>\'bulkJobId\' AS job FROM analysis_history WHERE id=$1',[job.historyId])
    assert.equal(history.rows[0].job,job.jobId)
    console.log('PASS: async XLSX job, row validation, persisted progress, pagination, and owner-only access')
    console.log('All ATLAS integration scenarios passed in isolated database.')
  } finally {
    if (app) await app.close()
    if (db) await db.onModuleDestroy()
    await Promise.all(testPools.filter((pool) => !pool.ending).map((pool) => pool.end()))
    pg.Pool = OriginalPool
    if (created) await admin.query(`DROP DATABASE "${testName}"`)
    await admin.end()
  }
}
main().catch((error) => { console.error(error.stack ?? error.message); process.exitCode=1 })
