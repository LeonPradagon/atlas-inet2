"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildCoreSections, findCorePaths, groupCorePaths, selectDisjointCorePaths } = require("../dist/booking/core-paths.js");
const { BookingService } = require("../dist/booking/booking.service.js");

const part = (id, coreId, from, to, lengthMeters = 10, available = true) =>
  ({ id, cableId: id, coreId, from, to, lengthMeters, available });

test("requires a recorded link between distinct core ends", () => {
  const sections = [part("one", 1, "A", "X1"), part("two", 7, "X2", "B")];
  assert.deepEqual(findCorePaths(sections, [], ["A"], ["B"]), []);
  const paths = findCorePaths(sections, [{ from: "X1", to: "X2" }], ["A"], ["B"]);
  assert.deepEqual(paths[0].sections.map((item) => item.coreId), [1, 7]);
  assert.equal(paths[0].lengthMeters, 20);
});

test("excludes unavailable sections and supports reverse direction", () => {
  const sections = [part("first", 1, "A", "M"), part("second", 1, "M", "B")];
  assert.equal(findCorePaths(sections, [], ["B"], ["A"])[0].lengthMeters, 20);
  sections[1].available = false;
  assert.deepEqual(findCorePaths(sections, [], ["A"], ["B"]), []);
});

test("orders alternatives by cable length", () => {
  const sections = [part("long", 1, "A", "B", 30), part("short", 2, "A", "B", 10)];
  assert.deepEqual(findCorePaths(sections, [], ["A"], ["B"]).map((path) => path.lengthMeters), [10, 30]);
});

test("groups by cable route and finds distinct fibre sections", () => {
  const sections = [
    { ...part("a1", 1, "A1", "M1"), cableId: "cable-a" },
    { ...part("b1", 4, "M1", "B1"), cableId: "cable-b" },
    { ...part("a2", 2, "A2", "M2"), cableId: "cable-a" },
    { ...part("b2", 5, "M2", "B2"), cableId: "cable-b" },
  ];
  const paths = findCorePaths(sections, [], ["A1", "A2"], ["B1", "B2"]);
  const options = groupCorePaths(paths);
  assert.deepEqual(options.map((option) => option.cableIds), [["cable-a", "cable-b"]]);
  assert.equal(selectDisjointCorePaths(options[0].paths, 2).length, 2);
  assert.equal(selectDisjointCorePaths([paths[0], paths[0]], 2), null);
});

test("preview requires reciprocal splice records on the same asset", async () => {
  const cores = [
    { coreId: 1, cableId: "one", lengthMeters: 100, available: true },
    { coreId: 2, cableId: "two", lengthMeters: 200, available: true },
  ];
  const record = (coreId, side, nodeId, type, groupId, peerCoreId = null, peerSide = null) =>
    ({ coreId, side, nodeId, type, groupId, peerCoreId, peerSide,
      positionMeters: null, physicalSide: null, peerPositionMeters: null, peerPhysicalSide: null, confirmed: true });
  const connections = [
    record(1, "A", "start", "termination", "start"),
    record(1, "B", "middle", "splice", "splice", 2, "A"),
    record(2, "A", "middle", "splice", "splice", 1, "B"),
    record(2, "B", "end", "termination", "end"),
  ];
  const db = { query: async (sql) => ({ rows: sql.includes("SELECT e.core_id") ? connections : sql.includes("FROM booking_core_sections") ? [] : cores }) };
  const service = new BookingService(db);
  const result = await service.previewConfirmedCorePaths("start", "end", 1);
  assert.deepEqual(result.options.map((option) => option.cableIds), [["one", "two"]]);
  assert.equal(result.options[0].meetsRequest, true);
  connections[2].peerCoreId = null;
  assert.deepEqual((await service.previewConfirmedCorePaths("start", "end", 1)).options, []);
  connections[2].peerCoreId = 1;
  connections[0].type = "splice";
  assert.deepEqual((await service.previewConfirmedCorePaths("start", "end", 1)).options, []);
});

test("midspan cut separates the two fibre sides", () => {
  const sections = buildCoreSections({
    coreId: 9, cableId: "cable", lengthMeters: 100, available: true,
    cuts: [{ positionMeters: 40, physicalSide: "toward_A", confirmed: true }],
  });
  assert.deepEqual(sections.map((section) => section.lengthMeters), [40, 60]);
  assert.deepEqual(findCorePaths(sections, [], ["9:A"], ["9:B"]), []);
  assert.equal(findCorePaths(sections, [], ["9:A"], ["9:R:40:toward_A"])[0].lengthMeters, 40);
  assert.equal(findCorePaths(sections, [], ["9:R:40:toward_B"], ["9:B"])[0].lengthMeters, 60);
});

test("unknown or unconfirmed midspan cuts do not produce bookable sections", () => {
  const cable = { coreId: 1, cableId: "cable", lengthMeters: 100, available: true };
  assert.deepEqual(buildCoreSections({ ...cable, cuts: [{ positionMeters: 50, physicalSide: null, confirmed: true }] }), []);
  assert.deepEqual(buildCoreSections({ ...cable, cuts: [{ positionMeters: 50, physicalSide: "toward_A", confirmed: false }] }), []);
});

test("preview reaches a verified termination on the correct midspan side", async () => {
  const cores = [{ coreId: 1, cableId: "cable", lengthMeters: 100, available: true }];
  const base = { coreId: 1, confirmed: true, peerCoreId: null, peerSide: null,
    peerPositionMeters: null, peerPhysicalSide: null };
  const connections = [
    { ...base, side: "A", positionMeters: null, physicalSide: null, nodeId: "start", type: "termination", groupId: "a" },
    { ...base, side: "R", positionMeters: 40, physicalSide: "toward_A", nodeId: "middle", type: "termination", groupId: "r" },
    { ...base, side: "B", positionMeters: null, physicalSide: null, nodeId: "end", type: "termination", groupId: "b" },
  ];
  const service = new BookingService({ query: async (sql) => ({ rows: sql.includes("SELECT e.core_id") ? connections : sql.includes("FROM booking_core_sections") ? [] : cores }) });
  assert.equal((await service.previewConfirmedCorePaths("start", "middle", 1)).options[0].lengthMeters, 40);
  assert.deepEqual((await service.previewConfirmedCorePaths("start", "end", 1)).options, []);
  connections[1].physicalSide = null;
  assert.deepEqual((await service.previewConfirmedCorePaths("start", "middle", 1)).options, []);
});

test("partial allocations block only overlapping physical sections", () => {
  const { buildRecordedTopology } = require("../dist/booking/core-paths.js");
  const cores = [{ coreId: 1, cableId: "cable", lengthMeters: 100, available: true }];
  const connections = [{ coreId: 1, side: "R", positionMeters: 40, physicalSide: "toward_A",
    nodeId: "middle", type: "termination", groupId: "r", confirmed: true }];
  const topology = buildRecordedTopology(cores, connections, [{ coreId: 1, startMeters: 0, endMeters: 40 }]);
  assert.deepEqual(topology.sections.map((section) => section.available), [false, true]);
});
