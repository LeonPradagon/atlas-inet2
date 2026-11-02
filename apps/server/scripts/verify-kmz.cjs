const fs = require('node:fs');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { Pool } = require('pg');
const { parseKml } = require('../dist/network/network-import.service');

const canonical = (value) => JSON.stringify(value, (_, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

async function main() {
  assert(process.argv[2], 'Pass the original KMZ path');
  const zip = await JSZip.loadAsync(fs.readFileSync(process.argv[2]));
  const features = [];
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir && /\.kml$/i.test(entry.name)) {
      features.push(...parseKml(await entry.async('string'), entry.name));
    }
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query("SELECT name,attributes,source_geometry FROM network_assets WHERE source='kml'");
    const stored = new Map();
    for (const row of rows) {
      const key = canonical([row.name, row.attributes.folderPath, row.source_geometry, row.attributes.__kmlStyle]);
      stored.set(key, (stored.get(key) ?? 0) + 1);
    }
    let mismatches = 0;
    for (const feature of features) {
      const key = canonical([feature.name, feature.properties.folderPath, feature.geometry, feature.style]);
      const count = stored.get(key) ?? 0;
      if (!count) mismatches++;
      else stored.set(key, count - 1);
    }
    console.log(JSON.stringify({ sourceObjects: features.length, matchedGeometryAndStyle: features.length - mismatches, mismatches }, null, 2));
    assert.equal(mismatches, 0, 'KMZ objects, original geometry, or parsed styles differ from database');
  } finally {
    await pool.end();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
