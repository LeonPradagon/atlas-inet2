"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { describeCableSpans, describeNodeCableRows } = require("../../web/src/features/analysis/terminationPlan.ts");

test("route spans retain bends, consistent ODP names and total route length", () => {
  const plan = {
    cables: [{ type: "Distribusi", cores: 96, distanceMeters: 200, geometry: { type: "LineString", coordinates: [[0, 0], [0.001, 0], [0.001, 0.001]] } }],
    deviceRecommendation: { kind: "NEW_ODP" },
    upstreamRecommendation: { name: "Closure A" },
    deviceCandidates: [
      { kind: "OTB", latitude: 0, longitude: 0.0001 },
      { kind: "ODP", basis: "PLANNING", latitude: 0, longitude: 0.0005 },
      { kind: "ODP", basis: "PLANNING", latitude: 0.0005, longitude: 0.001 },
      { kind: "ODP", basis: "PLANNING", latitude: 0.01, longitude: 0.01 },
    ],
  };
  const spans = describeCableSpans(plan);
  assert.equal(spans.length, 3);
  assert.deepEqual(spans.map((s) => [s.from, s.to]), [
    ["Closure A", "Simulasi ODP 03"],
    ["Simulasi ODP 03", "Simulasi ODP 02"],
    ["Simulasi ODP 02", "Usulan ODP pelanggan"],
  ]);
  assert.deepEqual(spans[1].geometry.coordinates, [[0.001, 0.0005], [0.001, 0], [0.0005, 0]]);
  assert.ok(Math.abs(spans.reduce((sum, span) => sum + span.distanceMeters, 0) - 200) < 1e-6);
  plan.requirement = { services: 2, reserve: 1, requiredCores: 3 };
  plan.odpDemands = { "Simulasi ODP 02": 5 };
  const rows = Object.fromEntries(describeNodeCableRows(plan, "Simulasi ODP 02"));
  assert.match(rows["Ruas masuk"], /Ruas 02.*Simulasi ODP 03.*100 m/);
  assert.match(rows["Ruas keluar"], /Ruas 03.*Usulan ODP pelanggan.*50 m/);
  assert.match(rows["Kabel usulan"], /96 core/);
  assert.match(rows["Core distribusi dibutuhkan"], /Belum dapat ditentukan/);
  assert.deepEqual(describeNodeCableRows(plan, "Titik tidak ada"), []);
  assert.deepEqual(describeCableSpans({ ...plan, cables: [...plan.cables, plan.cables[0]] }), []);
});
