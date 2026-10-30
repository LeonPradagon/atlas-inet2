require('reflect-metadata');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Database } = require('../dist/database/database');
const { AtlasService } = require('../dist/atlas/atlas.service');
const { RoutingService } = require('../dist/geospatial/routing.service');

async function main() {
  const db = new Database();
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const atlas = new AtlasService({ query: (sql, values) => client.query(sql, values) });
    const add = async (meters, type = 'asset', attributes = {}) => {
      const id = randomUUID();
      await client.query(`INSERT INTO network_assets(id,name,asset_type,source,geometry,attributes)
        VALUES($1,'radius verification',$2,'managed',ST_Project(ST_SetSRID(ST_MakePoint(-150,0),4326)::geography,$3::float8,0::float8)::geometry,$4::jsonb)`, [id,type,meters,JSON.stringify(attributes)]);
      return id;
    };
    const near = await add(400);
    const middle = await add(800);
    const far = await add(1500);
    await add(100, 'asset', { source: 'ftth-design' });
    assert.equal((await atlas.nearestNetwork(-150, 0)).id, near);
    assert.equal((await atlas.nearestNetwork(-150, 0)).searchRadiusMeters, 500);
    await client.query('DELETE FROM network_assets WHERE id=$1', [near]);
    assert.equal((await atlas.nearestNetwork(-150, 0)).id, middle);
    assert.equal((await atlas.nearestNetwork(-150, 0)).searchRadiusMeters, 1000);
    await client.query('DELETE FROM network_assets WHERE id=$1', [middle]);
    assert.equal(await atlas.nearestNetwork(-150, 0), null, '2km requires explicit approval');
    assert.equal((await atlas.nearestNetwork(-150, 0, true)).id, far);
    assert.equal((await atlas.nearestNetwork(-150, 0, true)).searchRadiusMeters, 2000);
    await client.query('DELETE FROM network_assets WHERE id=$1', [far]);
    await add(2500);
    assert.equal(await atlas.nearestNetwork(-150, 0, true), null);

    const unknown = await add(100, 'asset', { 'Tipe Perangkat': 'HANDHOLE' });
    const full = await add(200);
    const available = await add(450, 'asset', { 'Tipe Perangkat': 'ODC', 'Jumlah Core': '1', Splitter: 'SPL-1:8' });
    await client.query('UPDATE network_assets SET total_cores=1 WHERE id=ANY($1::text[])', [[full,available]]);
    await client.query(`INSERT INTO network_cores(asset_id,core_number,status) VALUES($1,1,'Used'),($2,1,'Available')`, [full,available]);
    const chosen = await atlas.nearestNetwork(-150,0);
    assert.equal(chosen.id,available,'verified available capacity is preferred within search radius');
    assert.equal(chosen.capacity.totalCores,1);
    assert.equal(chosen.capacity.availableCores,1);
    assert.equal(chosen.capacity.recommendation,'CAPACITY_AVAILABLE');
    assert(chosen.capacity.fields.some(field => field.label === 'Splitter' && field.value === 'SPL-1:8'));
    await client.query('DELETE FROM network_assets WHERE id=$1',[available]);
    const chamber = await atlas.nearestNetwork(-150,0);
    assert.equal(chamber.id,unknown);
    assert.equal(chamber.capacity.totalCores,null);
    assert.equal(chamber.capacity.recommendation,'NO_CABLE_RELATION');
    await client.query('DELETE FROM network_assets WHERE id=$1',[unknown]);
    assert.equal((await atlas.nearestNetwork(-150,0)).capacity.recommendation,'CORE_FULL');

    const originalFetch = global.fetch;
    const originalUrl = process.env.ROUTING_URL;
    try {
      process.env.ROUTING_URL = 'http://routing.test';
      global.fetch = async (url) => {
        assert.equal(new URL(url).searchParams.get('profile'), 'car');
        return { ok: true, json: async () => ({ paths: [{ distance: 1234, time: 90000, points: { type: 'LineString', coordinates: [[106,-6],[106.01,-6]] } }] }) };
      };
      assert.equal((await new RoutingService().previewNetwork([[106,-6],[106.01,-6]])).distanceMeters, 1234);
    } finally {
      global.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.ROUTING_URL;
      else process.env.ROUTING_URL = originalUrl;
    }
    console.log('PASS: 500m → 1km, explicit 2km approval, 2km limit, draft exclusion, car routing and cable length.');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.pool.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

