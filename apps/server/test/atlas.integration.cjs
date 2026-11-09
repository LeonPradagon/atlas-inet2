"use strict";
const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");

// Creates and drops only a uniquely named test database. Application data is never modified.
async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be configured to create the isolated test database."
    );
  }
  const testName = `atlas_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString() });
  let db,
    app,
    created = false;
  const testPools = [];
  const pg = require("pg");
  const OriginalPool = pg.Pool;
  try {
    await admin.query(`CREATE DATABASE "${testName}"`);
    created = true;
    const testUrl = new URL(process.env.DATABASE_URL);
    testUrl.pathname = `/${testName}`;
    process.env.DATABASE_URL = testUrl.toString();
    pg.Pool = class TestPool extends OriginalPool {
      constructor(options) {
        super(options);
        testPools.push(this);
      }
    };
    const { Database } = require("../dist/database/database");
    const { AtlasService } = require("../dist/atlas/atlas.service");
    const { BookingService } = require("../dist/booking/booking.service");
    const { migrateDatabase } = require("../dist/database/migration-runner");
    db = new Database();
    await migrateDatabase(db.pool);
    await assert.doesNotReject(
      async () =>
        db.query(
          await readFile("src/database/migrations/001-initial.sql", "utf8")
        ),
      "001-initial.sql re-applies cleanly on a migrated database"
    );
    await db.query(
      `INSERT INTO "user"(id,name,email,role) VALUES('admin','Test Admin','admin@atlas.test','ADMIN'),('presales','Test Presales','presales@atlas.test','PRESALES')`
    );
    const bookings = new BookingService(db);
    const atlas = new AtlasService(db, bookings);
    const q = (sql, values) => db.query(sql, values);
    await q(`INSERT INTO audit_logs(action,entity_type,entity_id,details) VALUES
      ('NETWORK_IMPORTED','NETWORK_IMPORT','import-active','{"fileName":"active.kmz"}'),
      ('NETWORK_IMPORTED','NETWORK_IMPORT','import-empty','{"fileName":"deleted.kmz"}')`);
    await q(`INSERT INTO network_assets(id,name,asset_type,source,attributes) VALUES
      ('imported-asset','Imported','asset','kml','{"__atlasImportId":"import-active","Company":"THC"}')`);
    const imports = await atlas.listAssetImports();
    assert.deepEqual(
      imports.map((item) => item.id),
      ["import-active"]
    );
    assert.deepEqual(imports[0].companies, ["THC"]);
    console.log("PASS: map imports exclude empty packages and retain company");
    await q(`INSERT INTO network_assets(id,name,asset_type,source,total_cores,geometry,attributes) VALUES
      ('term-a','ODC A','asset','kml',0,ST_SetSRID(ST_MakePoint(0,0),4326),'{}'),
      ('term-b','ODP B','asset','kml',0,ST_SetSRID(ST_MakePoint(0.001,0),4326),'{}'),
      ('term-far','Closure C','asset','kml',0,ST_SetSRID(ST_MakePoint(0.006,0),4326),'{}'),
      ('term-non','Tiang','asset','kml',0,ST_SetSRID(ST_MakePoint(0.00001,0),4326),'{}'),
      ('cable-a','Kabel A','segment','managed',3,ST_GeomFromText('LINESTRING(0 0,0.001 0)',4326),'{}'),
      ('cable-b','Kabel B','segment','kml',1,ST_GeomFromText('LINESTRING(0 0,0.002 0)',4326),'{}')`);
    await q(`INSERT INTO network_cores(asset_id,core_number,status) VALUES
      ('cable-a',1,'Used'),('cable-a',2,'Booked'),('cable-a',3,'Available'),('cable-b',1,'Available')`);
    await q(
      "INSERT INTO network_asset_relations(segment_id,asset_id,kind) VALUES('cable-a','term-a','ODC')"
    );
    const along = await atlas.terminationsAlongRoute({
      coordinates: [
        [0, 0],
        [0.001, 0],
      ],
      type: "LineString",
    });
    assert.deepEqual(
      along.map((p) => p.id),
      ["term-a", "term-b"]
    );
    assert.equal(along[0].type, "ODC");
    assert.equal(along[0].recordedCables, 1);
    assert.equal(along[1].type, "ODP");
    assert.equal(along[1].recordedCables, 0);
    console.log(
      "PASS: route evidence uses existing nearby devices and recorded cable relations"
    );
    const found = await atlas.nearbyTerminations(0, 0);
    assert.equal(found.searchRadiusMeters, 500);
    assert.deepEqual(
      found.points.map((p) => p.id),
      ["term-a", "term-b"]
    );
    const recorded = found.points[0].cables.find((c) => c.id === "cable-a");
    assert.equal(recorded.recorded, true);
    assert.deepEqual(recorded.available, [3]);
    assert.equal(recorded.used, 1);
    assert.deepEqual(recorded.usedNumbers, [1]);
    assert.deepEqual(recorded.bookedNumbers, [2]);
    assert.equal(recorded.booked, 1);
    assert.equal(recorded.start.pointId, "term-a");
    assert.equal(recorded.end.pointId, "term-b");
    const candidate = found.points[0].cables.find((c) => c.id === "cable-b");
    assert.equal(candidate.recorded, false);
    assert.equal(candidate.available, null);
    assert.equal(candidate.end, null);
    await q(
      `INSERT INTO network_assets(id,name,asset_type,source,total_cores,geometry) VALUES ('near-unverified-source','Kabel 24C','segment','kml',24,ST_GeomFromText('LINESTRING(0 0,0.001 0)',4326))`
    );
    await q(
      `INSERT INTO network_cores(asset_id,core_number) SELECT 'near-unverified-source', generate_series(1,24)`
    );
    const unverifiedTarget = (await atlas.nearbyTerminations(0, 0)).points.find(
      (p) => p.id === "term-a"
    );
    const { recommendSourceCable } = require("../dist/atlas/termination-plan");
    const sourceCandidate = recommendSourceCable(unverifiedTarget.cables, 1);
    assert.equal(sourceCandidate.id, "near-unverified-source");
    assert.equal(sourceCandidate.totalCores, 24);
    assert.equal(sourceCandidate.verified, false);
    assert.equal(sourceCandidate.recorded, false);
    assert.equal(sourceCandidate.coreNumber, null);
    console.log(
      "PASS: nearby unverified cable provides capacity without claiming an available core"
    );
    assert.equal(
      (await atlas.nearbyTerminations(0.01, 0)).searchRadiusMeters,
      500
    );
    assert.equal(
      (await atlas.nearbyTerminations(0.015, 0)).searchRadiusMeters,
      1000
    );
    assert.equal(
      (await atlas.nearbyTerminations(0.025, 0, true)).searchRadiusMeters,
      2000
    );
    assert.equal((await atlas.nearbyTerminations(10, 10)).points.length, 0);
    console.log(
      "PASS: nearby terminations, cables, verified cores, endpoints and radius"
    );
    const savedDesign = await atlas.saveFtthDesign(
      [
        {
          designAnchor: true,
          geometry: { coordinates: [106.8, -6.2], type: "Point" },
          kind: "HANDHOLE",
          name: "Handhole anchor",
        },
        {
          geometry: { coordinates: [106.801, -6.201], type: "Point" },
          kind: "ODC",
          name: "ODC test",
        },
        {
          geometry: {
            coordinates: [
              [106.8, -6.2],
              [106.801, -6.201],
            ],
            type: "LineString",
          },
          kind: "ROUTE",
          name: "Kabel test",
          routeType: "FEEDER",
        },
      ],
      "admin",
      "Test Area"
    );
    const savedAnchor = await q(
      "SELECT attributes FROM network_assets WHERE attributes->>'ftthDesignId'=$1 AND attributes->>'designAnchor'='true'",
      [savedDesign.designId]
    );
    assert.equal(savedAnchor.rows.length, 1);
    assert.equal(savedAnchor.rows[0].attributes.coverageRadiusMeters, 500);
    console.log(
      "PASS: FTTH design persists its selected anchor and coverage radius"
    );
    const requestBooking = async (segmentId, cores) => {
      const pending = await bookings.createBooking(
        {
          cores,
          customer: `Customer ${randomBytes(4).toString("hex")}`,
          picCustomer: "Customer PIC",
          picPresales: "Presales PIC",
          segmentId,
        },
        "presales"
      );
      assert.equal(
        pending.status,
        "Pending Approval",
        "a new booking waits for ADMIN approval"
      );
      return pending.id;
    };
    const booking = async (segmentId, cores) =>
      bookings.approveBooking(await requestBooking(segmentId, cores), "admin");
    const status = async (id) =>
      (await q("SELECT status FROM bookings WHERE id=$1", [id])).rows[0].status;
    const segment = async (id, count, verified = true) => {
      await q(
        `INSERT INTO network_assets(id,name,asset_type,source,area,geometry,source_geometry,attributes) VALUES($1,$1,'segment','kml','Original area',ST_GeomFromText('LINESTRING(106.8 -6.2,106.81 -6.21)',4326),'{"type":"LineString","coordinates":[[106.8,-6.2,12],[106.81,-6.21,13]]}','{"__kmlStyle":{"lineColor":"#ff0000"},"name":"Original KML"}')`,
        [id]
      );
      await atlas.updateAsset(id, { totalCores: count }, "admin");
      if (verified) {
        await atlas.verifyCoreUsage(id, "Survei lapangan", "", "admin");
      }
    };
    await segment("multi", 6);
    const hold = await booking("multi", 6);
    const queue = await Promise.all([
      booking("multi", 2),
      booking("multi", 2),
      booking("multi", 2),
    ]);
    assert(queue.every((b) => b.status === "Waiting List"));
    const before = Number(
      (await q("SELECT count(*) AS n FROM notifications")).rows[0].n
    );
    const released = await bookings.releaseBooking(hold.id, "presales");
    assert.equal(released.allocatedBookingIds.length, 3);
    assert.equal(released.allocated, released.allocatedBookingIds[0]);
    for (const b of queue) {
      assert.equal(await status(b.id), "Booked");
    }
    assert.equal(
      Number((await q("SELECT count(*) AS n FROM notifications")).rows[0].n) -
        before,
      4
    );
    assert.equal(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_logs WHERE action='WAITING_LIST_ALLOCATED' AND details->>'segmentId'='multi'"
        )
      ).rows[0].n,
      4
    );
    console.log(
      "PASS: one release allocates multiple requests, with notifications and audit"
    );

    await segment("fifo", 6);
    for (const n of [1, 2, 3]) {
      await atlas.setCoreStatus("fifo", n, "Used", "admin");
    }
    await atlas.verifyCoreUsage("fifo", "Survei lapangan", "", "admin");
    const tailRequest = await requestBooking("fifo", 2);
    const head = await booking("fifo", 4),
      tail = await bookings.approveBooking(tailRequest, "admin");
    assert.equal(head.status, "Waiting List");
    assert.equal(
      tail.status,
      "Waiting List",
      "an earlier request approved later queues behind the head"
    );
    assert.equal(
      (await atlas.listCores("fifo")).filter((c) => c.status === "Available")
        .length,
      3
    );
    const changed = await atlas.setCoreStatus("fifo", 1, "Available", "admin");
    assert.equal(changed.status, "Booked");
    assert.equal(await status(head.id), "Booked");
    assert.equal(await status(tail.id), "Waiting List");
    await atlas.setCoreStatus("fifo", 2, "Available", "admin");
    assert.equal(await status(tail.id), "Waiting List");
    await atlas.setCoreStatus("fifo", 3, "Available", "admin");
    assert.equal(await status(tail.id), "Booked");
    console.log(
      "PASS: strict FIFO by approval order, no later approval bypass, Available status triggers allocation"
    );

    await segment("capacity", 4);
    await booking("capacity", 4);
    const capacityHead = await booking("capacity", 4),
      capacityTail = await booking("capacity", 2);
    await atlas.updateAsset("capacity", { totalCores: 6 }, "admin");
    assert.equal(await status(capacityTail.id), "Waiting List");
    await atlas.updateAsset(
      "capacity",
      { area: "Updated area", totalCores: 10 },
      "admin"
    );
    assert.equal(await status(capacityHead.id), "Booked");
    assert.equal(await status(capacityTail.id), "Booked");
    await segment("rollback", 8);
    await atlas.setCoreStatus("rollback", 8, "Used", "admin");
    const snapshot = (
      await q("SELECT * FROM network_assets WHERE id=$1", ["rollback"])
    ).rows[0];
    const auditBefore = Number(
      (await q("SELECT count(*) AS n FROM audit_logs")).rows[0].n
    );
    await assert.rejects(
      atlas.updateAsset(
        "rollback",
        { area: "Must rollback", totalCores: 2 },
        "admin"
      ),
      (e) => e.getStatus() === 409
    );
    const unchanged = (
      await q("SELECT * FROM network_assets WHERE id=$1", ["rollback"])
    ).rows[0];
    assert.equal(unchanged.area, snapshot.area);
    assert.equal(unchanged.total_cores, 8);
    assert.equal(
      Number((await q("SELECT count(*) AS n FROM audit_logs")).rows[0].n),
      auditBefore
    );
    await atlas.setCoreStatus("rollback", 8, "Available", "admin");
    await atlas.updateAsset("rollback", { totalCores: 2 }, "admin");
    assert.equal((await atlas.listCores("rollback")).length, 2);
    console.log(
      "PASS: capacity growth allocates FIFO; occupied high core blocks reduction with full rollback"
    );

    await segment("expiry", 4);
    const expiring = await booking("expiry", 4);
    const expiryQueue = [
      await booking("expiry", 2),
      await booking("expiry", 2),
    ];
    await q(
      "UPDATE bookings SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expiring.id]
    );
    await Promise.all([bookings.expireBookings(), bookings.expireBookings()]);
    assert.equal(await status(expiring.id), "Expired");
    for (const b of expiryQueue) {
      assert.equal(await status(b.id), "Booked");
    }
    assert.equal(
      (
        await q(
          "SELECT count(*)::int AS n FROM audit_logs WHERE entity_id=$1 AND action='BOOKING_EXPIRED'",
          [expiring.id]
        )
      ).rows[0].n,
      1
    );
    console.log(
      "PASS: concurrent expiry runs release and allocate exactly once"
    );

    await segment("concurrent", 8);
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, () => booking("concurrent", 1))
    );
    assert.equal(concurrent.filter((b) => b.status === "Booked").length, 8);
    const active = concurrent.filter((b) => b.status === "Booked");
    const outcomes = await Promise.allSettled([
      bookings.releaseBooking(active[0].id, "presales"),
      bookings.releaseBooking(active[0].id, "presales"),
    ]);
    assert.equal(
      outcomes.filter((result) => result.status === "fulfilled").length,
      1
    );
    await Promise.all(
      active.slice(1, 5).map((b) => bookings.releaseBooking(b.id, "presales"))
    );
    const consistency = (
      await q(`SELECT (SELECT count(*) FROM network_cores WHERE asset_id='concurrent' AND status='Booked') AS cores,
      (SELECT sum(cores) FROM bookings WHERE segment_id='concurrent' AND status='Booked') AS booked,
      (SELECT count(*) FROM booking_cores bc JOIN network_cores c ON c.id=bc.core_id WHERE c.asset_id='concurrent') AS assignments`)
    ).rows[0];
    assert.equal(Number(consistency.cores), 8);
    assert.equal(Number(consistency.booked), 8);
    assert.equal(Number(consistency.assignments), 8);
    assert.equal(
      (
        await q(
          "SELECT core_id FROM booking_cores GROUP BY core_id HAVING count(*)>1"
        )
      ).rows.length,
      0
    );
    console.log(
      "PASS: concurrent bookings/releases cannot double-assign cores"
    );

    await segment("related", 4);
    await segment("shared", 4);
    for (const id of ["pole-a", "pole-b", "odc-a", "odp-a"]) {
      await q(
        `INSERT INTO network_assets(id,name,asset_type,source,geometry,attributes) VALUES($1,$1,'asset','kml',ST_SetSRID(ST_MakePoint(106.8,-6.2),4326),'{"__kmlStyle":{"iconColor":"#00ff00"}}')`,
        [id]
      );
    }
    const relatedSource = (
      await q(
        "SELECT geometry,source_geometry,attributes FROM network_assets WHERE id=$1",
        ["related"]
      )
    ).rows[0];
    const poleSource = (
      await q("SELECT geometry,attributes FROM network_assets WHERE id=$1", [
        "pole-a",
      ])
    ).rows[0];
    await atlas.updateAsset(
      "related",
      { cableType: "Feeder", installation: "Burial", side: "Kanan" },
      "admin"
    );
    const relations = [
      { assetId: "pole-a", kind: "POLE" },
      { assetId: "pole-b", kind: "POLE" },
      { assetId: "odc-a", kind: "ODC" },
      { assetId: "odp-a", kind: "ODP" },
    ];
    await atlas.saveRelations("related", relations, "admin");
    await atlas.saveRelations("shared", [relations[0]], "admin");
    await atlas.updateAsset("pole-a", { poleHeight: "9 m" }, "admin");
    assert.equal((await atlas.listRelations("shared"))[0].poleHeight, "9 m");
    assert.equal((await atlas.listRelations("related")).length, 4);
    assert.equal(
      (await atlas.networkUsageReport())
        .find((row) => row.id === "related")
        .relatedAssets.find((r) => r.assetId === "pole-a").poleHeight,
      "9 m"
    );
    await assert.rejects(
      atlas.saveRelations("related", [relations[0], relations[0]], "admin"),
      (e) => e.getStatus() === 400
    );
    await assert.rejects(
      atlas.saveRelations(
        "related",
        [{ assetId: "shared", kind: "POLE" }],
        "admin"
      ),
      (e) => e.getStatus() === 400
    );
    await assert.rejects(
      atlas.saveRelations(
        "related",
        [{ assetId: "missing", kind: "ODC" }],
        "admin"
      ),
      (e) => e.getStatus() === 400
    );
    assert.equal((await atlas.listRelations("related")).length, 4);
    const db2 = new Database(),
      atlas2 = new AtlasService(db2, new BookingService(db2));
    assert.equal((await atlas2.listRelations("related")).length, 4);
    await db2.onModuleDestroy();
    await atlas.saveRelations("related", [], "admin");
    assert.equal((await atlas.listRelations("related")).length, 0);
    assert.deepEqual(
      (
        await q(
          "SELECT geometry,source_geometry,attributes FROM network_assets WHERE id=$1",
          ["related"]
        )
      ).rows[0],
      relatedSource
    );
    assert.deepEqual(
      (
        await q("SELECT geometry,attributes FROM network_assets WHERE id=$1", [
          "pole-a",
        ])
      ).rows[0],
      poleSource
    );
    const sourceAfter = (
      await q("SELECT * FROM network_assets WHERE id=$1", ["rollback"])
    ).rows[0];
    assert.deepEqual(sourceAfter.source_geometry, snapshot.source_geometry);
    assert.deepEqual(sourceAfter.attributes, snapshot.attributes);
    assert.equal(sourceAfter.geometry, snapshot.geometry);
    console.log(
      "PASS: multi-asset relations, shared heights, removal, persistence, exports, unchanged source geometry/style"
    );

    for (const [id, offset] of [
      ["near-unverified", 0.0001],
      ["far-verified", 0.002],
    ]) {
      await q(
        "INSERT INTO network_assets(id,name,asset_type,source,geometry) VALUES($1,$1,'segment','kml',ST_SetSRID(ST_MakeLine(ST_MakePoint(110+$2::float8,-7),ST_MakePoint(110+$2::float8,-7.01)),4326))",
        [id, offset]
      );
      await atlas.updateAsset(id, { totalCores: 2 }, "admin");
    }
    await atlas.verifyCoreUsage("far-verified", "Survei lapangan", "", "admin");
    await q(`INSERT INTO network_assets(id,name,asset_type,source,geometry) VALUES
      ('near-point','ODP Terdekat','asset','kml',ST_SetSRID(ST_MakePoint(110.001,-7.005),4326)),
      ('far-point','ODC Jauh','asset','kml',ST_SetSRID(ST_MakePoint(110.003,-7.005),4326))`);
    assert.equal((await atlas.nearestNetwork(110, -7.005)).id, "near-point");
    console.log(
      "PASS: nearest analysis selects the nearest termination rather than a cable"
    );
    const proposalHistory = await atlas.saveAnalysisHistory(
      "presales",
      "ADDRESS",
      "Test proposal",
      {},
      { latitude: -7.005, longitude: 110, network: { id: "near-point" } }
    );
    await assert.rejects(() =>
      atlas.createSurvey("presales", proposalHistory, 0, {
        cores: 0,
        kind: "ODP",
        latitude: -7.005,
        longitude: 110,
      })
    );
    const createdSurvey = await atlas.createSurvey(
      "presales",
      proposalHistory,
      0,
      { cores: 24, kind: "ODP", latitude: -7.005, longitude: 110 }
    );
    const savedSurvey = await q(
      "SELECT analysis FROM network_surveys WHERE id=$1",
      [createdSurvey.id]
    );
    assert.deepEqual(savedSurvey.rows[0].analysis.proposal, {
      cores: 24,
      kind: "ODP",
      latitude: -7.005,
      longitude: 110,
    });
    assert.equal(
      (
        await q(
          "SELECT count(*)::int AS n FROM network_assets WHERE attributes->>'surveyId'=$1",
          [createdSurvey.id]
        )
      ).rows[0].n,
      0
    );
    const planHistory = await atlas.saveAnalysisHistory(
      "admin",
      "ADDRESS",
      "Rencana",
      {},
      { latitude: -7.005, longitude: 110, network: { id: "near-point" } }
    );
    const plan = {
      cables: [
        {
          cores: null,
          distanceMeters: 55,
          geometry: {
            coordinates: [
              [110, -7.005],
              [110.0005, -7.005],
            ],
            type: "LineString",
          },
          type: "Drop",
        },
        {
          cores: 24,
          distanceMeters: 55,
          geometry: {
            coordinates: [
              [110.0005, -7.005],
              [110.001, -7.005],
            ],
            type: "LineString",
          },
          type: "Distribusi",
        },
      ],
      points: [{ kind: "ODP", latitude: -7.005, longitude: 110.0005 }],
      targetId: "near-point",
    };
    await assert.rejects(() =>
      atlas.createSurvey("admin", planHistory, 0, undefined, {
        ...plan,
        targetId: "wrong",
      })
    );
    await assert.rejects(() =>
      atlas.createSurvey("admin", planHistory, 0, undefined, {
        ...plan,
        cables: plan.cables.slice(1),
      })
    );
    const plannedSurvey = await atlas.createSurvey(
      "admin",
      planHistory,
      0,
      undefined,
      plan
    );
    const plannedResult = await q(
      "SELECT analysis FROM network_surveys WHERE id=$1",
      [plannedSurvey.id]
    );
    assert.deepEqual(plannedResult.rows[0].analysis.terminationPlan, plan);
    const canonicalSource = { coreNumber: 3, id: "cable-a", name: "Kabel A" };
    const sourceHistory = await atlas.saveAnalysisHistory(
      "admin",
      "ADDRESS",
      "Rencana sumber",
      {},
      {
        latitude: -7.006,
        longitude: 110,
        network: { id: "near-point" },
        terminationPlan: {
          ...plan,
          routeEvidence: [{ id: "term-a", type: "ODC" }],
          routeEvidenceIncomplete: false,
          sourceCable: canonicalSource,
        },
      }
    );
    const sourceSurvey = await atlas.createSurvey(
      "admin",
      sourceHistory,
      0,
      undefined,
      {
        ...plan,
        routeEvidence: [{ id: "fake" }],
        routeEvidenceIncomplete: true,
        sourceCable: { coreNumber: 99, id: "fake", name: "fake" },
      }
    );
    const sourceResult = await q(
      "SELECT analysis FROM network_surveys WHERE id=$1",
      [sourceSurvey.id]
    );
    assert.deepEqual(
      sourceResult.rows[0].analysis.terminationPlan.sourceCable,
      canonicalSource
    );
    assert.deepEqual(
      sourceResult.rows[0].analysis.terminationPlan.routeEvidence,
      [{ id: "term-a", type: "ODC" }]
    );
    assert.equal(
      sourceResult.rows[0].analysis.terminationPlan.routeEvidenceIncomplete,
      false
    );
    const requirement = { requiredCores: 6, reserve: 2, services: 4 };
    const canonicalPlan = {
      ...plan,
      requirement,
      sourceCable: canonicalSource,
    };
    const demandHistory = await atlas.saveAnalysisHistory(
      "admin",
      "ADDRESS",
      "Kebutuhan core",
      {},
      {
        latitude: -7.007,
        longitude: 110,
        network: { id: "near-point" },
        terminationPlan: canonicalPlan,
      }
    );
    const forged = {
      ...canonicalPlan,
      cables: canonicalPlan.cables.map((cable) => ({ ...cable, cores: 1 })),
      requirement: { requiredCores: 1, reserve: 0, services: 1 },
    };
    const demandSurvey = await atlas.createSurvey(
      "admin",
      demandHistory,
      0,
      undefined,
      forged
    );
    const demandResult = await q(
      "SELECT analysis FROM network_surveys WHERE id=$1",
      [demandSurvey.id]
    );
    assert.deepEqual(
      demandResult.rows[0].analysis.terminationPlan,
      canonicalPlan
    );

    console.log("PASS: survey retains a validated termination and cable plan");
    console.log(
      "PASS: survey proposal persists validated core count without creating active assets"
    );
    const emptyHistory = await atlas.saveAnalysisHistory(
      "presales",
      "ADDRESS",
      "No termination",
      {},
      { latitude: -7.1, longitude: 110, network: null }
    );
    const emptySurvey = await atlas.createSurvey("presales", emptyHistory, 0, {
      cores: 12,
      kind: "ODC",
      latitude: -7.1,
      longitude: 110,
    });
    assert.ok(
      emptySurvey.id,
      "proposal can be submitted without an existing termination"
    );

    // Exercise real controller routes and RBAC with isolated test sessions, not application accounts.
    const { NestFactory } = require("@nestjs/core");
    const { AppModule } = require("../dist/app.module");
    const { AuthService } = require("../dist/auth/auth.service");
    const { auth, adminAuth } = require("../dist/auth/auth");
    await Promise.all([auth.$context, adminAuth.$context]);
    app = await NestFactory.create(AppModule, { logger: ["error"] });
    app.setGlobalPrefix("api");
    app.get(AuthService).session = async (req) => {
      const id = req.headers["x-atlas-test-user"];
      return ["admin", "presales"].includes(id)
        ? { user: { id, role: id === "admin" ? "ADMIN" : "PRESALES" } }
        : null;
    };
    await app.listen(0, "127.0.0.1");
    const origin = await app.getUrl();
    const request = (path, user, method = "GET", data) =>
      fetch(`${origin}/api${path}`, {
        body: data ? JSON.stringify(data) : undefined,
        headers: {
          ...(user ? { "x-atlas-test-user": user } : {}),
          "Content-Type": "application/json",
        },
        method,
      });
    assert.equal((await request("/assets/shared/relations")).status, 401);
    assert.equal(
      (await request("/assets/shared/relations", "presales")).status,
      200
    );
    assert.equal(
      (
        await request("/assets/shared/relations", "presales", "PUT", {
          relations: [],
        })
      ).status,
      403
    );
    assert.equal(
      (
        await request("/assets/shared/relations", "admin", "PUT", {
          relations: [relations[0]],
        })
      ).status,
      200
    );
    assert.equal(
      (
        await request("/assets/pole-a", "presales", "PATCH", {
          poleHeight: "7 m",
        })
      ).status,
      403
    );
    assert.equal(
      (await request("/assets/pole-a", "admin", "PATCH", { poleHeight: "7 m" }))
        .status,
      200
    );
    assert.equal(
      (
        await request("/assets/shared/cores/1", "presales", "PATCH", {
          status: "Used",
        })
      ).status,
      403
    );
    console.log(
      "PASS: HTTP authentication and ADMIN/PRESALES access boundaries"
    );

    const call = async (path, user, method, data) => {
      const response = await request(path, user, method, data);
      return { body: await response.json(), status: response.status };
    };
    const signIn = {
      body: { message: "Silakan masuk untuk melanjutkan." },
      status: 401,
    };
    const adminOnly = {
      body: { message: "Akses ini hanya tersedia untuk ADMIN." },
      status: 403,
    };
    const missingBooking = {
      body: { message: "Booking tidak ditemukan." },
      status: 404,
    };
    const bookingInput = (customer, cores, segmentId = "http-booking") => ({
      cores,
      customer,
      picCustomer: "Customer PIC",
      picPresales: "Presales PIC",
      segmentId,
    });
    const createOverHttp = async (user, customer, cores) => {
      const response = await call(
        "/bookings",
        user,
        "POST",
        bookingInput(customer, cores)
      );
      assert.equal(response.status, 201);
      return response.body.id;
    };
    const iso = async (column, id) =>
      (
        await q(`SELECT ${column} AS value FROM bookings WHERE id=$1`, [id])
      ).rows[0].value?.toISOString() ?? null;
    const trail = async (id) => ({
      audit: (
        await q(
          "SELECT actor_id AS actor,action,details FROM audit_logs WHERE entity_id=$1 ORDER BY id",
          [id]
        )
      ).rows,
      notifications: (
        await q(
          'SELECT user_id AS "user",title,message FROM notifications WHERE booking_id=$1 ORDER BY id',
          [id]
        )
      ).rows,
    });
    await segment("http-booking", 2);
    await segment("http-empty", 0, false);
    await segment("http-unverified", 2, false);

    assert.deepEqual(await call("/assets/bookable-segments"), signIn);
    const bookable = await call("/assets/bookable-segments", "presales");
    assert.equal(bookable.status, 200);
    assert.deepEqual(
      bookable.body.find((s) => s.id === "http-booking"),
      {
        area: "Original area",
        assetType: "segment",
        id: "http-booking",
        idleCores: 2,
        name: "http-booking",
        totalCores: 2,
      }
    );
    assert.equal(
      bookable.body.some((s) => s.id === "http-empty"),
      false,
      "a segment without capacity is not bookable"
    );
    assert.equal(
      bookable.body.some((s) => s.id === "http-unverified"),
      false
    );

    assert.deepEqual(await call("/settings/booking-duration"), signIn);
    assert.deepEqual(await call("/settings/booking-duration", "presales"), {
      body: { days: 30 },
      status: 200,
    });
    assert.deepEqual(
      await call("/settings/booking-duration", "presales", "PATCH", {
        days: 14,
      }),
      adminOnly
    );
    assert.deepEqual(
      await call("/settings/booking-duration", "admin", "PATCH", { days: 0 }),
      { body: { message: "Durasi booking harus 1–365 hari." }, status: 400 }
    );
    assert.deepEqual(
      await call("/settings/booking-duration", "admin", "PATCH", { days: 14 }),
      { body: { days: 14 }, status: 200 }
    );
    assert.deepEqual(await call("/settings/booking-duration", "presales"), {
      body: { days: 14 },
      status: 200,
    });
    assert.deepEqual(
      (
        await q(
          'SELECT actor_id AS actor,entity_type AS "entityType",entity_id AS "entityId",details FROM audit_logs WHERE action=\'BOOKING_DURATION_UPDATED\''
        )
      ).rows,
      [
        {
          actor: "admin",
          details: { days: 14 },
          entityId: "booking_duration_days",
          entityType: "SETTING",
        },
      ]
    );

    assert.deepEqual(
      await call("/bookings", undefined, "POST", bookingInput("HTTP A", 1)),
      signIn
    );
    const required = {
      body: { message: "Pelanggan, PIC, segmen, dan jumlah core wajib diisi." },
      status: 400,
    };
    assert.deepEqual(
      await call("/bookings", "presales", "POST", {
        ...bookingInput("HTTP A", 1),
        picCustomer: " ",
      }),
      required
    );
    assert.deepEqual(
      await call("/bookings", "presales", "POST", bookingInput("HTTP A", 0)),
      required
    );
    assert.deepEqual(
      await call(
        "/bookings",
        "presales",
        "POST",
        bookingInput("HTTP A", 1, "missing-segment")
      ),
      { body: { message: "Segmen tidak ditemukan." }, status: 404 }
    );
    assert.deepEqual(
      await call(
        "/bookings",
        "presales",
        "POST",
        bookingInput("HTTP A", 1, "http-empty")
      ),
      {
        body: {
          message:
            "Kapasitas belum diisi. Minta ADMIN melengkapi jumlah core segmen.",
        },
        status: 400,
      }
    );
    assert.deepEqual(
      await call(
        "/bookings",
        "presales",
        "POST",
        bookingInput("HTTP A", 1, "http-unverified")
      ),
      {
        body: {
          message:
            "Pemakaian core segmen belum terverifikasi. Minta ADMIN memverifikasi segmen pada halaman peta jaringan.",
        },
        status: 400,
      }
    );
    assert.deepEqual(
      await call("/bookings", "presales", "POST", bookingInput("HTTP A", 3)),
      {
        body: { message: "Jumlah booking melebihi kapasitas total segmen." },
        status: 400,
      }
    );
    const firstCreated = await call("/bookings", "presales", "POST", {
      ...bookingInput(" HTTP A ", 1),
      picCustomer: " Customer PIC ",
    });
    const first = firstCreated.body.id;
    assert.match(
      first,
      /^BKG-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u
    );
    assert.deepEqual(firstCreated, {
      body: {
        cores: 1,
        customer: "HTTP A",
        id: first,
        picCustomer: "Customer PIC",
        picPresales: "Presales PIC",
        segmentId: "http-booking",
        status: "Pending Approval",
      },
      status: 201,
    });
    const second = await createOverHttp("admin", "HTTP B", 1);

    assert.deepEqual(await call("/bookings"), signIn);
    const listed = await call("/bookings", "presales");
    assert.equal(listed.status, 200);
    assert.deepEqual(await call("/bookings", "admin"), listed);
    const listedIds = listed.body.map((b) => b.id);
    assert(
      listedIds.indexOf(second) < listedIds.indexOf(first),
      "the newest booking is listed first"
    );
    assert.deepEqual(
      listed.body.find((b) => b.id === first),
      {
        approvedAt: null,
        area: "Original area",
        cores: 1,
        customer: "HTTP A",
        expiresAt: null,
        id: first,
        picCustomer: "Customer PIC",
        picPresales: "Presales PIC",
        rejectedAt: null,
        requestedAt: await iso("requested_at", first),
        segmentId: "http-booking",
        segmentName: "http-booking",
        status: "Pending Approval",
      }
    );

    assert.deepEqual(
      await call(`/bookings/${first}/approve`, undefined, "POST"),
      signIn
    );
    assert.deepEqual(
      await call(`/bookings/${first}/approve`, "presales", "POST"),
      adminOnly
    );
    assert.deepEqual(
      await call("/bookings/BKG-MISSING/approve", "admin", "POST"),
      missingBooking
    );
    assert.deepEqual(
      await call(`/bookings/${first}/approve`, "admin", "POST"),
      {
        body: { allocatedBookingIds: [first], id: first, status: "Booked" },
        status: 201,
      }
    );
    assert.deepEqual(
      await call(`/bookings/${first}/approve`, "admin", "POST"),
      {
        body: {
          message:
            "Hanya booking yang menunggu persetujuan yang dapat disetujui.",
        },
        status: 409,
      }
    );
    assert.equal(
      (
        await q(
          "SELECT round(extract(epoch FROM expires_at-approved_at)/86400)::int AS days FROM bookings WHERE id=$1",
          [first]
        )
      ).rows[0].days,
      14,
      "an allocated booking expires after the configured duration"
    );
    assert.deepEqual(
      await call(`/bookings/${second}/approve`, "admin", "POST"),
      {
        body: { allocatedBookingIds: [second], id: second, status: "Booked" },
        status: 201,
      }
    );
    const waiting = await createOverHttp("presales", "HTTP D", 2);
    assert.deepEqual(
      await call(`/bookings/${waiting}/approve`, "admin", "POST"),
      {
        body: { allocatedBookingIds: [], id: waiting, status: "Waiting List" },
        status: 201,
      }
    );

    assert.deepEqual(
      await call(`/bookings/${first}/release`, undefined, "POST"),
      signIn
    );
    assert.deepEqual(
      await call("/bookings/BKG-MISSING/release", "presales", "POST"),
      missingBooking
    );
    const inactive = {
      body: { message: "Hanya booking aktif yang dapat dilepas." },
      status: 409,
    };
    assert.deepEqual(
      await call(`/bookings/${waiting}/release`, "presales", "POST"),
      inactive
    );
    assert.deepEqual(
      await call(`/bookings/${first}/release`, "presales", "POST"),
      {
        body: { allocated: null, allocatedBookingIds: [], released: first },
        status: 201,
      }
    );
    assert.deepEqual(
      await call(`/bookings/${first}/release`, "presales", "POST"),
      inactive
    );
    assert.deepEqual(
      await call(`/bookings/${second}/release`, "presales", "POST"),
      {
        body: {
          allocated: waiting,
          allocatedBookingIds: [waiting],
          released: second,
        },
        status: 201,
      }
    );
    const httpSegment = "http-booking";
    assert.deepEqual(await trail(first), {
      audit: [
        {
          action: "BOOKING_CREATED",
          actor: "presales",
          details: {
            cores: 1,
            segmentId: httpSegment,
            status: "Pending Approval",
          },
        },
        {
          action: "WAITING_LIST_ALLOCATED",
          actor: "admin",
          details: { cores: 1, segmentId: httpSegment },
        },
        {
          action: "BOOKING_APPROVED",
          actor: "admin",
          details: {
            allocatedBookingIds: [first],
            cores: 1,
            segmentId: httpSegment,
            status: "Booked",
          },
        },
        {
          action: "BOOKING_RELEASED",
          actor: "presales",
          details: {
            allocatedBookingIds: [],
            cores: 1,
            segmentId: httpSegment,
          },
        },
      ],
      notifications: [
        {
          message: "HTTP A meminta 1 core pada segmen http-booking.",
          title: "Persetujuan booking core diperlukan",
          user: "admin",
        },
        {
          message: `HTTP A: 1 core tersedia dan booking ${first} aktif.`,
          title: "Waiting list dialokasikan",
          user: "presales",
        },
        {
          message: `Booking ${first} disetujui dan 1 core telah dialokasikan.`,
          title: "Booking core disetujui",
          user: "presales",
        },
        {
          message:
            "HTTP A: 1 core dilepas. 0 permintaan waiting list dialokasikan.",
          title: "Booking core dilepas",
          user: "presales",
        },
      ],
    });
    const secondTrail = await trail(second);
    assert.deepEqual(secondTrail.audit.at(-1), {
      action: "BOOKING_RELEASED",
      actor: "presales",
      details: {
        allocatedBookingIds: [waiting],
        cores: 1,
        segmentId: httpSegment,
      },
    });
    assert.deepEqual(
      secondTrail.notifications
        .filter((n) => n.title === "Booking core dilepas")
        .map((n) => n.user)
        .sort(),
      ["admin", "presales"],
      "a release notifies PRESALES users and the requester"
    );
    assert.deepEqual((await trail(waiting)).audit.at(-1), {
      action: "WAITING_LIST_ALLOCATED",
      actor: "presales",
      details: { cores: 2, segmentId: httpSegment },
    });
    assert.deepEqual(
      (await call("/bookings", "presales")).body.find((b) => b.id === waiting),
      {
        approvedAt: await iso("approved_at", waiting),
        area: "Original area",
        cores: 2,
        customer: "HTTP D",
        expiresAt: await iso("expires_at", waiting),
        id: waiting,
        picCustomer: "Customer PIC",
        picPresales: "Presales PIC",
        rejectedAt: null,
        requestedAt: await iso("requested_at", waiting),
        segmentId: httpSegment,
        segmentName: "http-booking",
        status: "Booked",
      }
    );
    assert.deepEqual(
      (await call("/assets/bookable-segments", "presales")).body.find(
        (s) => s.id === "http-booking"
      ).idleCores,
      0
    );
    console.log(
      "PASS: HTTP booking routes list, create, approve and release with ADMIN/PRESALES boundaries, duration and bookable segments"
    );

    const rejected = await createOverHttp("presales", "HTTP C", 2);
    assert.deepEqual(
      await call(`/bookings/${rejected}/reject`, undefined, "POST"),
      signIn
    );
    assert.deepEqual(
      await call(`/bookings/${rejected}/reject`, "presales", "POST"),
      adminOnly
    );
    assert.deepEqual(
      await call("/bookings/BKG-MISSING/reject", "admin", "POST"),
      missingBooking
    );
    assert.deepEqual(
      await call(`/bookings/${rejected}/reject`, "admin", "POST"),
      { body: { id: rejected, status: "Rejected" }, status: 201 }
    );
    const notPending = {
      body: {
        message: "Hanya booking yang menunggu persetujuan yang dapat ditolak.",
      },
      status: 409,
    };
    assert.deepEqual(
      await call(`/bookings/${rejected}/reject`, "admin", "POST"),
      notPending
    );
    assert.deepEqual(
      await call(`/bookings/${waiting}/reject`, "admin", "POST"),
      notPending
    );
    assert.equal(
      (await call(`/bookings/${rejected}/approve`, "admin", "POST")).status,
      409
    );
    assert.deepEqual(
      (
        await q(
          'SELECT status,rejected_by AS "rejectedBy",approved_by AS "approvedBy",approved_at AS "approvedAt",expires_at AS "expiresAt",(SELECT count(*)::int FROM booking_cores WHERE booking_id=$1) AS "heldCores" FROM bookings WHERE id=$1',
          [rejected]
        )
      ).rows[0],
      {
        approvedAt: null,
        approvedBy: null,
        expiresAt: null,
        heldCores: 0,
        rejectedBy: "admin",
        status: "Rejected",
      }
    );
    assert.deepEqual(await trail(rejected), {
      audit: [
        {
          action: "BOOKING_CREATED",
          actor: "presales",
          details: {
            cores: 2,
            segmentId: httpSegment,
            status: "Pending Approval",
          },
        },
        {
          action: "BOOKING_REJECTED",
          actor: "admin",
          details: { cores: 2, segmentId: httpSegment },
        },
      ],
      notifications: [
        {
          message: "HTTP C meminta 2 core pada segmen http-booking.",
          title: "Persetujuan booking core diperlukan",
          user: "admin",
        },
        {
          message: `Permintaan booking ${rejected} untuk HTTP C ditolak oleh ADMIN.`,
          title: "Booking core ditolak",
          user: "presales",
        },
      ],
    });
    const rejectedRow = (await call("/bookings", "admin")).body.find(
      (b) => b.id === rejected
    );
    assert.equal(rejectedRow.status, "Rejected");
    assert.equal(rejectedRow.rejectedAt, await iso("rejected_at", rejected));
    console.log(
      "PASS: HTTP booking rejection sets status, audit and PRESALES notification without holding cores"
    );

    const ExcelJS = require("exceljs");
    const {
      NetworkImportService,
    } = require("../dist/network/network-import.service");
    const workbookImport = new NetworkImportService(db);
    await assert.rejects(
      workbookImport.analyzeWorkbook(Buffer.alloc(15 * 1024 * 1024 + 1), {
        maxBytes: 15 * 1024 * 1024,
        maxRows: 5000,
      }),
      (error) => error.getStatus() === 400
    );
    const tooMany = new ExcelJS.Workbook();
    const tooManySheet = tooMany.addWorksheet("Lokasi");
    tooManySheet.addRow(["Alamat", "Latitude", "Longitude"]);
    for (let row = 0; row < 5001; row++) {
      tooManySheet.addRow(["", -6.2, 106.8]);
    }
    await assert.rejects(
      workbookImport.analyzeWorkbook(
        Buffer.from(await tooMany.xlsx.writeBuffer()),
        { maxBytes: 15 * 1024 * 1024, maxRows: 5000 }
      ),
      (error) => error.getStatus() === 400
    );
    console.log("PASS: 15 MB upload boundary and 5,000-row input limit");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Lokasi");
    sheet.addRow([
      "Alamat",
      "Provinsi",
      "Kabupaten/Kota",
      "Kecamatan",
      "Kelurahan/Desa",
      "Nomor Rumah",
      "Kode Pos",
      "Latitude",
      "Longitude",
    ]);
    sheet.addRow(["", "", "", "", "", "", "", -6.2, 106.8]);
    sheet.addRow(["", "", "", "", "", "", "", -6.21, 106.81]);
    sheet.addRow(["", "", "", "", "", "", "", -6.2, ""]);
    sheet.addRow([
      "Jl. Contoh No. 1",
      "DKI Jakarta",
      "Kota Administrasi Jakarta Barat",
      "",
      "",
      "",
      "",
      "",
      "",
    ]);
    const file = new Blob([await workbook.xlsx.writeBuffer()], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const form = new FormData();
    form.append("file", file, "bulk-test.xlsx");
    const upload = await fetch(`${origin}/api/analysis/bulk/jobs`, {
      body: form,
      headers: { "x-atlas-test-user": "admin" },
      method: "POST",
    });
    const uploaded = await upload.json();
    assert.equal(upload.status, 201, JSON.stringify(uploaded));
    const job = uploaded;
    assert.equal(job.total, 4);
    assert.equal(
      (await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}`)).status,
      401
    );
    assert.equal(
      (
        await fetch(`${origin}/api/analysis/bulk/jobs/${job.jobId}`, {
          headers: { "x-atlas-test-user": "presales" },
        })
      ).status,
      404
    );
    let progress = job;
    for (
      let attempt = 0;
      attempt < 30 &&
      !["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED", "FAILED"].includes(
        progress.status
      );
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const response = await fetch(
        `${origin}/api/analysis/bulk/jobs/${job.jobId}`,
        { headers: { "x-atlas-test-user": "admin" } }
      );
      progress = await response.json();
    }
    assert.equal(progress.processed, 4);
    assert.ok(progress.failed >= 2);
    const terminalRows = await fetch(
      `${origin}/api/analysis/bulk/jobs/${job.jobId}/rows?page=1&pageSize=50`,
      { headers: { "x-atlas-test-user": "admin" } }
    ).then((response) => response.json());
    assert.ok(
      terminalRows.rows.every(
        (row) => !["QUEUED", "PROCESSING"].includes(row.status)
      )
    );
    const resultPage = await fetch(
      `${origin}/api/analysis/bulk/jobs/${job.jobId}/rows?page=2&pageSize=2`,
      { headers: { "x-atlas-test-user": "admin" } }
    ).then((response) => response.json());
    assert.equal(resultPage.total, 4);
    assert.equal(resultPage.rows.length, 2);
    assert.ok(
      resultPage.rows.some(
        (row) =>
          row.message === "Latitude dan Longitude harus diisi berpasangan."
      )
    );
    assert.ok(
      resultPage.rows.some(
        (row) =>
          row.message ===
          "Alamat tanpa koordinat wajib memiliki Alamat, Provinsi, Kabupaten/Kota, dan Kecamatan."
      )
    );
    const failedPage = await fetch(
      `${origin}/api/analysis/bulk/jobs/${job.jobId}/rows?page=1&pageSize=100&status=ERROR`,
      { headers: { "x-atlas-test-user": "admin" } }
    ).then((response) => response.json());
    assert.ok(failedPage.total >= 2);
    const history = await db.query(
      "SELECT input->>'bulkJobId' AS job FROM analysis_history WHERE id=$1",
      [job.historyId]
    );
    assert.equal(history.rows[0].job, job.jobId);
    console.log(
      "PASS: async XLSX job, row validation, persisted progress, pagination, and owner-only access"
    );
    console.log("All ATLAS integration scenarios passed in isolated database.");
  } finally {
    if (app) {
      await app.close();
    }
    if (db) {
      await db.onModuleDestroy();
    }
    await Promise.all(
      testPools.filter((pool) => !pool.ending).map((pool) => pool.end())
    );
    pg.Pool = OriginalPool;
    if (created) {
      await admin.query(`DROP DATABASE "${testName}"`);
    }
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
