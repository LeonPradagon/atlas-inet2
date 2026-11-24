"use strict";
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { Pool } = require("pg");

async function main() {
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString() });
  const name = `atlas_route_booking_${randomBytes(6).toString("hex")}`;
  let db;
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const testUrl = new URL(process.env.DATABASE_URL);
    testUrl.pathname = `/${name}`;
    process.env.DATABASE_URL = testUrl.toString();
    const { Database } = require("../dist/database/database");
    const { migrateDatabase } = require("../dist/database/migration-runner");
    const { BookingService } = require("../dist/booking/booking.service");
    const { AtlasService } = require("../dist/atlas/atlas.service");
    db = new Database();
    await migrateDatabase(db.pool);
    const q = (sql, values) => db.query(sql, values);
    await q(`INSERT INTO "user"(id,name,email,role) VALUES ('admin','Admin','admin@test.local','ADMIN'),('presales','Presales','presales@test.local','PRESALES')`);
    await q(`
      INSERT INTO network_assets(id,name,asset_type,source,total_cores,attributes,geometry)
      VALUES
        ('cable-a','Cable A','segment','managed',2,'{}',ST_GeomFromText('LINESTRING(106  -6,106.001 -6)',4326)),
        ('cable-b','Cable B','segment','managed',2,'{}',ST_GeomFromText('LINESTRING(106.001 -6,106.002 -6)',4326)),
        ('device-start','ODC Start','asset','managed',0,'{"Tipe Perangkat":"ODC"}',ST_GeomFromText('POINT(106 -6)',4326)),
        ('device-mid','Closure Mid','asset','managed',0,'{"Tipe Perangkat":"CLOSURE"}',ST_GeomFromText('POINT(106.001 -6)',4326)),
        ('device-end','ODP End','asset','managed',0,'{"Tipe Perangkat":"ODP"}',ST_GeomFromText('POINT(106.002 -6)',4326))
    `);
    const coreRows = (await q(`
      INSERT INTO network_cores(asset_id,core_number,status) VALUES
        ('cable-a',1,'Available'),('cable-a',2,'Available'),('cable-b',1,'Available'),('cable-b',2,'Available')
      RETURNING id,asset_id,core_number
    `)).rows;
    const byKey = new Map(coreRows.map((row) => [`${row.asset_id}:${row.core_number}`, row.id]));
    const insertTermination = async (coreId, side, nodeId) => q(`
      INSERT INTO network_core_end_connections(connection_group_id,connection_type,core_id,side,node_asset_id,verification_status,source)
      VALUES($1,'termination',$2,$3,$4,'confirmed','Dokumen inventaris')
    `, [randomUUID(), coreId, side, nodeId]);
    const insertSplicePair = async (left, right) => {
      const group = randomUUID();
      await q(`INSERT INTO network_core_end_connections(connection_group_id,connection_type,core_id,side,node_asset_id,peer_core_id,peer_side,verification_status,source)
        VALUES($1,'splice',$2,'B','device-mid',$3,'A','confirmed','Dokumen inventaris')`, [group,left,right]);
      await q(`INSERT INTO network_core_end_connections(connection_group_id,connection_type,core_id,side,node_asset_id,peer_core_id,peer_side,verification_status,source)
        VALUES($1,'splice',$2,'A','device-mid',$3,'B','confirmed','Dokumen inventaris')`, [group,right,left]);
    };
    const service = new BookingService(db);
    const nearbyCandidate = (await service.previewConfirmedCorePaths("device-start", "device-end", 1)).options[0];
    assert.equal(nearbyCandidate.needsVerification, true);
    const rejectedCandidate = await service.createPathBooking({
      customer: "Unusable Route", picCustomer: "PIC", picPresales: "Presales",
      startNodeId: "device-start", endNodeId: "device-end", requestedCores: 1, routeKey: nearbyCandidate.routeKey,
    }, "presales");
    assert.equal((await service.rejectBooking(rejectedCandidate.id, "admin")).status, "Rejected");
    await q(`INSERT INTO network_segment_endpoints(segment_id,side,node_asset_id,source)
      VALUES ('cable-a','A','device-start','Dokumen inventaris'),
        ('cable-a','B','device-mid','Dokumen inventaris'),
        ('cable-b','A','device-mid','Dokumen inventaris'),
        ('cable-b','B','device-end','Dokumen inventaris')`);
    const candidate = (await service.previewConfirmedCorePaths("device-start", "device-end", 1)).options[0];
    assert.equal(candidate.needsVerification, true);
    const verificationBooking = await service.createPathBooking({
      customer: "Verification Customer", picCustomer: "PIC", picPresales: "Presales",
      startNodeId: "device-start", endNodeId: "device-end", requestedCores: 1, routeKey: candidate.routeKey,
    }, "presales");
    assert.equal(verificationBooking.needsVerification, true);
    await assert.rejects(() => service.approveBooking(verificationBooking.id, "admin"));
    await assert.rejects(() => service.resubmitBooking(verificationBooking.id, "presales"));
    for (const suffix of [1, 2]) {
      const left = byKey.get(`cable-a:${suffix}`);
      const right = byKey.get(`cable-b:${suffix}`);
      await insertTermination(left, "A", "device-start");
      await insertSplicePair(left, right);
      await insertTermination(right, "B", "device-end");
    }

    assert.deepEqual((await service.listBookableDevices()).map((device) => device.id), ["device-mid", "device-start", "device-end"]);
    await q(`INSERT INTO network_assets(id,name,asset_type,source,total_cores,attributes,geometry)
      VALUES ('device-tap','Closure Tap','asset','managed',0,'{"Tipe Perangkat":"CLOSURE"}',ST_GeomFromText('POINT(106.0005 -6)',4326))`);
    assert((await service.listBookableDevices()).some((device) => device.id === "device-tap"));
    const tap = (await service.previewConfirmedCorePaths("device-start", "device-tap", 1)).options[0];
    assert.equal(tap.needsVerification, true);
    assert.deepEqual(tap.cableIds, ["cable-a"]);
    assert(tap.lengthMeters > 50 && tap.lengthMeters < 60);
    assert.equal((await service.resubmitBooking(verificationBooking.id, "presales")).status, "Pending Approval");
    const preview = await service.previewConfirmedCorePaths("device-start", "device-end", 1);
    assert.equal(preview.options.length, 1);
    assert.equal(preview.options[0].meetsRequest, true);
    assert.deepEqual(preview.options[0].cableNames, ["Cable A", "Cable B"]);

    const request = await service.createPathBooking({
      customer: "Route Customer", picCustomer: "PIC", picCustomerEmail: "pic@test.local",
      picCustomerPhone: "123", picPresales: "Presales", startNodeId: "device-start",
      endNodeId: "device-end", requestedCores: 1, routeKey: preview.options[0].routeKey,
    }, "presales");
    assert.equal(request.status, "Pending Approval");
    assert.equal(request.route.allocations.length, 2);
    assert.equal((await q("SELECT count(*)::int AS n FROM booking_core_sections WHERE booking_id=$1", [request.id])).rows[0].n, 0);

    const allocatedFirstCable = request.route.allocations.find((allocation) => allocation.cableId === "cable-a");
    await q(`INSERT INTO bookings(id,customer,pic_customer,pic_customer_email,pic_customer_phone,pic_presales,segment_id,cores,status)
      VALUES('OTHER','Other','Other PIC','','','Admin','cable-a',1,'Booked')`);
    await q("INSERT INTO booking_core_sections(booking_id,core_id,start_m,end_m,status) VALUES('OTHER',$1,$2,$3,'Booked')",
      [allocatedFirstCable.coreId, allocatedFirstCable.startMeters, allocatedFirstCable.endMeters]);

    const refresh = await service.approveBooking(request.id, "admin");
    assert.equal(refresh.reviewUpdated, true, "Admin approval must stop when the proposed core changes");
    assert.equal((await q("SELECT status FROM bookings WHERE id=$1", [request.id])).rows[0].status, "Pending Approval");
    const refreshed = (await service.listBookings(true)).find((booking) => booking.id === request.id);
    assert.notEqual(refreshed.pathRequest.proposedAllocations[0].coreId, allocatedFirstCable.coreId);

    assert.equal((await service.approveBooking(request.id, "admin")).status, "Booked");
    const full = (await service.previewConfirmedCorePaths("device-start", "device-end", 1)).options[0];
    assert.equal(full.routeKey, preview.options[0].routeKey);
    assert.equal(full.availableCores, 0);
    const waiter = await service.createPathBooking({
      customer: "Waiting Customer", picCustomer: "PIC", picPresales: "Presales",
      startNodeId: "device-start", endNodeId: "device-end", requestedCores: 1, routeKey: full.routeKey,
    }, "presales");
    assert.equal(waiter.status, "Waiting List");
    await assert.rejects(() => service.resubmitBooking(waiter.id, "presales"));
    assert.equal((await q("SELECT count(*)::int AS n FROM booking_core_sections WHERE booking_id=$1 AND status='Booked'", [request.id])).rows[0].n, 2);
    assert.equal((await q("SELECT count(*)::int AS n FROM booking_cores WHERE booking_id=$1", [request.id])).rows[0].n, 0);
    const approved = (await service.listBookings(true)).find((booking) => booking.id === request.id);
    assert.deepEqual(
      [...new Set(approved.pathRequest.proposedAllocations.map((allocation) => allocation.pathIndex))],
      [0],
      "Each requested end-to-end path keeps its core path index after approval"
    );
    const atlas = new AtlasService(db);
    const activeAllocation = approved.pathRequest.proposedAllocations[0];
    await assert.rejects(
      () => atlas.verifyCoreUsage(activeAllocation.cableId, "Survei lapangan", "", "admin", [], { A: "device-mid" }),
      /alokasi booking aktif/i,
      "A physical cable endpoint cannot move while a route section is active"
    );
    await assert.rejects(
      () => atlas.verifyCoreUsage(activeAllocation.cableId, "Survei lapangan", "", "admin", [{ coreNumber: activeAllocation.coreNumber, status: "Available", midspanConnections: [] }]),
      /alokasi booking aktif/i,
      "A splice on an allocated core cannot be changed while the route is active"
    );
    assert.equal((await service.markPurchaseOrderIssued(request.id, "admin")).status, "Used");
    assert.equal((await q("SELECT count(*)::int AS n FROM booking_core_sections WHERE booking_id=$1 AND status='Used'", [request.id])).rows[0].n, 2);
    await assert.rejects(() => service.releaseBooking(request.id, "presales"));
    await service.releaseBooking(request.id, "admin", true);
    assert.equal((await service.resubmitBooking(waiter.id, "presales")).status, "Pending Approval");
    assert.equal((await q("SELECT count(*)::int AS n FROM booking_core_sections WHERE booking_id=$1 AND status='Released'", [request.id])).rows[0].n, 2);
    assert.equal((await q("SELECT count(*)::int AS n FROM network_cores WHERE status='Available' AND asset_id IN ('cable-a','cable-b')")).rows[0].n, 4, "partial route reservations do not change the whole-core status");
    console.log("PASS: connected device path, proposed core review, section approval, PO, and admin release");
  } finally {
    if (db) await db.pool.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
