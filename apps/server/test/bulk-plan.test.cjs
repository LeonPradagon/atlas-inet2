"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BulkAnalysisService } = require("../src/atlas/bulk-analysis.service.ts");
const { analyzeCoordinates } = require("../src/atlas/address-analysis.ts");

test("bulk worker stores the same termination plan as single analysis", async () => {
  const cable = { id: "c", name: "Kabel 96", recorded: true, verified: true, totalCores: 96, available: Array.from({ length: 94 }, (_, i) => i + 3) };
  const point = { id: "n", name: "Closure", type: "Closure", cables: [cable], relatedDevices: [] };
  const atlas = {
    nearbyTerminations: async () => ({ points: [point] }),
    nearestNetwork: async () => ({ id: "n", nearestPoint: { coordinates: [0.001, 0] } }),
    terminationsAlongRoute: async () => [], cableEndsAlongRoute: async () => [],
    terminationPatterns: async () => [{ type: "ODP", sampleSize: 5, medianMeters: 27 }],
  };
  const routing = { previewNetwork: async () => ({ distanceMeters: 111, geometry: { type: "LineString", coordinates: [[0, 0], [0.001, 0]] } }) };
  const claim = { id: "r", job_id: "j", row_number: 1, attempts: 1, input: { address: "A", longitude: 0, latitude: 0 } };
  const db = { transaction: async (fn) => fn({ query: async (sql) => ({ rows: sql.includes("WITH candidate") ? [claim] : [] }) }) };
  const bulk = new BulkAnalysisService(db, {}, {}, routing, atlas);
  bulk.recoverStaleRows = async () => {};
  let saved;
  bulk.finishRow = async (_claim, result) => { saved = result; };
  await bulk.workOne();
  const single = await analyzeCoordinates(atlas, routing, 0, 0, "A");
  assert.equal(saved.status, "OK");
  assert.deepEqual(saved.terminationPlan, single.terminationPlan);
  assert.equal(saved.terminationPlan.sourceCable.availableCount, 94);
  assert.ok(saved.terminationPlan.deviceCandidates.some((p) => p.kind === "ODP"));
});
