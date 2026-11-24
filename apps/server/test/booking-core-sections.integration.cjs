"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = `booking_sections_test_${randomBytes(6).toString("hex")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    await client.query("CREATE TABLE bookings (id text PRIMARY KEY, status text)");
    await client.query("CREATE TABLE network_assets (id text PRIMARY KEY, geometry geometry(Geometry,4326))");
    await client.query("CREATE TABLE network_cores (id bigint PRIMARY KEY, asset_id text, status text)");
    await client.query("CREATE TABLE booking_cores (booking_id text, core_id bigint)");
    await client.query("INSERT INTO bookings VALUES ('one','Booked'), ('two','Pending Approval'), ('legacy','Booked')");
    await client.query("INSERT INTO network_assets VALUES ('cable', ST_GeomFromText('LINESTRING(106.3 -6.1,106.301 -6.1)',4326))");
    await client.query("INSERT INTO network_cores VALUES (1,'cable','Available'), (2,'cable','Booked')");
    await client.query("INSERT INTO booking_cores VALUES ('legacy', 2)");
    const migration = await readFile("src/database/migrations/20261123090000_booking_core_sections.sql", "utf8");
    // Keep the migration and any extension changes isolated in this transaction.
    await client.query(migration);
    const backfill = await readFile("src/database/migrations/20261123110000_backfill_legacy_booking_sections.sql", "utf8");
    await client.query(backfill);
    const legacy = await client.query("SELECT start_m, end_m, status FROM booking_core_sections WHERE booking_id='legacy'");
    assert.equal(legacy.rowCount, 1);
    assert.equal(Number(legacy.rows[0].start_m), 0);
    assert.ok(Number(legacy.rows[0].end_m) > 0);
    assert.equal(legacy.rows[0].status, "Booked");
    await client.query("INSERT INTO booking_core_sections (booking_id, core_id, start_m, end_m, status) VALUES ('one', 1, 0, 100, 'Booked')");
    await client.query("SAVEPOINT before_overlap");
    await assert.rejects(
      client.query("INSERT INTO booking_core_sections (booking_id, core_id, start_m, end_m, status) VALUES ('two', 1, 50, 150, 'Booked')"),
      (error) => error.code === "23P01"
    );
    await client.query("ROLLBACK TO SAVEPOINT before_overlap");
    await client.query("INSERT INTO booking_core_sections (booking_id, core_id, start_m, end_m, status) VALUES ('two', 1, 100, 150, 'Booked')");
    await client.query("UPDATE booking_core_sections SET status='Released' WHERE booking_id='one'");
    await client.query("INSERT INTO booking_core_sections (booking_id, core_id, start_m, end_m, status) VALUES ('two', 1, 0, 100, 'Used')");
    console.log("PASS: overlapping allocations rejected; adjacent and released ranges accepted");
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
