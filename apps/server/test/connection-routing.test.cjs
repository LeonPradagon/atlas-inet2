"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildConnectionGraph,
  shortestConnection,
  meters,
  connectionGeometryKey,
  isShallowConnectionVariant,
} = require("../src/atlas/connection-graph");
const {
  ConnectionService,
  validateConnectionInput,
} = require("../src/atlas/connection.service");
const { AtlasService } = require("../src/atlas/atlas.service");
const { AtlasController } = require("../src/atlas/atlas.controller");
const terminal = (id, x, y = 0) => ({
  coordinate: [x, y],
  id,
  name: `ODC ${id}`,
});
const segment = (id, coordinates, company) => ({
  available: 0,
  company,
  geometry: { coordinates, type: "LineString" },
  id,
  name: id,
});
const a = terminal("a", 0),
  j = terminal("j", 0.001),
  b = terminal("b", 0.002);
const segments = [
  segment("s1", [
    [0, 0],
    [0.0005, 0.0005],
    [0.001, 0],
  ]),
  segment("s2", [
    [0.001, 0],
    [0.002, 0],
  ]),
];
const attachments = [
  { recorded: true, segmentId: "s1", terminalId: "a" },
  { recorded: true, segmentId: "s1", terminalId: "j" },
  { recorded: true, segmentId: "s2", terminalId: "j" },
  { recorded: true, segmentId: "s2", terminalId: "b" },
];
const mapping = {
  coreA: "1",
  coreB: "2",
  segmentA: "s1",
  segmentB: "s2",
  terminalId: "j",
};

test("inferred shared termination path preserves bends; allocation zero never means disconnected", () => {
  const graph = buildConnectionGraph(segments, [a, j, b], [], []);
  const route = shortestConnection(graph, a, b);
  assert.ok(route);
  assert.equal(route.recorded, false);
  assert.deepEqual(
    route.legs[0].geometry.coordinates,
    segments[0].geometry.coordinates
  );
  assert.ok(route.distanceMeters > meters(a.coordinate, b.coordinate));
  assert.equal(shortestConnection(graph, a, b, true), null);
  assert.equal(route.links[0].confirmation, "survey_required");
});
test("simple crossings and disjoint segments do not connect without a termination", () => {
  const end = terminal("end", 0.0005, 0.001);
  const graph = buildConnectionGraph(
    [
      segments[0],
      segment("cross", [
        [0.0005, -0.001],
        [0.0005, 0.001],
      ]),
    ],
    [a, end],
    [],
    []
  );
  assert.equal(shortestConnection(graph, a, end), null);
});
test("recorded mapping connects reversed traversal and preserves core strand continuity", () => {
  const graph = buildConnectionGraph(segments, [a, j, b], attachments, [
    mapping,
  ]);
  assert.equal(shortestConnection(graph, a, b, true).recorded, true);
  assert.deepEqual(
    shortestConnection(graph, b, a, true).legs[0].geometry.coordinates,
    [
      [0.002, 0],
      [0.001, 0],
    ]
  );
  const c = terminal("c", 0.003);
  const s3 = segment("s3", [
    [0.002, 0],
    [0.003, 0],
  ]);
  const extra = [
    { recorded: true, segmentId: "s3", terminalId: "b" },
    { recorded: true, segmentId: "s3", terminalId: "c" },
  ];
  const wrong = {
    coreA: "99",
    coreB: "3",
    segmentA: "s2",
    segmentB: "s3",
    terminalId: "b",
  };
  const broken = buildConnectionGraph(
    [...segments, s3],
    [a, j, b, c],
    [...attachments, ...extra],
    [mapping, wrong]
  );
  assert.equal(shortestConnection(broken, a, c, true), null);
  assert.equal(shortestConnection(broken, a, c).recorded, false);
  const good = buildConnectionGraph(
    [...segments, s3],
    [a, j, b, c],
    [...attachments, ...extra],
    [mapping, { ...wrong, coreA: "2" }]
  );
  assert.equal(shortestConnection(good, a, c, true).recorded, true);
});
test("relations without core mappings never establish a multi-cable splice", () => {
  const graph = buildConnectionGraph(segments, [a, j, b], attachments, []);
  assert.equal(shortestConnection(graph, a, b).recorded, false);
});
test("cross-company proximity is blocked; an explicit mapping permits it", () => {
  const owned = [
    { ...segments[0], company: "one" },
    { ...segments[1], company: "two" },
  ];
  assert.equal(
    shortestConnection(buildConnectionGraph(owned, [a, j, b], [], []), a, b),
    null
  );
  assert.ok(
    shortestConnection(
      buildConnectionGraph(owned, [a, j, b], attachments, [mapping]),
      a,
      b,
      true
    )
  );
});
test("shortest path selects actual geometry distance; midspan slices retain internal vertices", () => {
  const straight = segment("short", [
    [0, 0],
    [0.001, 0],
    [0.002, 0],
  ]);
  const route = shortestConnection(
    buildConnectionGraph([...segments, straight], [a, j, b], [], []),
    a,
    b
  );
  assert.deepEqual(
    route.legs.map((l) => l.segmentId),
    ["short"]
  );
  assert.deepEqual(
    route.legs[0].geometry.coordinates,
    straight.geometry.coordinates
  );
});
test("terminal connector gaps have explicit geometry and distance", () => {
  const off = terminal("j", 0.001, 0.000_05);
  const route = shortestConnection(
    buildConnectionGraph(segments, [a, off, b], [], []),
    a,
    b
  );
  assert.ok(route.links[0].gapMeters > 0);
  assert.deepEqual(route.links[0].geometry.coordinates[1], off.coordinate);
});
test("duplicate termination vertices produce one normalized geometry key", () => {
  const one = {
    confirmation: "survey_required",
    distanceMeters: 100,
    geometry: {
      coordinates: [
        [0, 0],
        [0, 0],
        [0.001, 0],
      ],
      type: "LineString",
    },
    kind: "existing",
    name: "s",
    segmentId: "s",
  };
  const two = {
    ...one,
    geometry: {
      coordinates: [
        [0, 0],
        [0.001, 0],
      ],
      type: "LineString",
    },
  };
  assert.equal(
    connectionGeometryKey(a, b, [one]),
    connectionGeometryKey({ ...a, id: "duplicate" }, b, [two])
  );
});
test("same segment sequence with access terminals within 20m is a shallow variant, not B", () => {
  const leg = {
    confirmation: "survey_required",
    distanceMeters: 100,
    geometry: {
      coordinates: [
        [0, 0],
        [0.001, 0],
      ],
      type: "LineString",
    },
    kind: "existing",
    name: "s1",
    segmentId: "s1",
  };
  const original = {
    destination: b,
    legs: [leg, { ...leg, segmentId: "s2" }],
    source: a,
  };
  const nearby = {
    ...original,
    destination: terminal("near-b", 0.0021),
    source: terminal("near-a", 0.0001),
  };
  assert.equal(isShallowConnectionVariant(original, nearby), true);
  assert.equal(
    isShallowConnectionVariant(original, {
      ...nearby,
      source: terminal("far-a", 0.0003),
    }),
    false
  );
  assert.equal(
    isShallowConnectionVariant(original, {
      ...nearby,
      legs: [leg, { ...leg, segmentId: "other" }],
    }),
    false
  );
});
test("invalid and equal coordinates, malformed requirements are rejected", () => {
  for (const input of [
    null,
    {},
    {
      end: { latitude: 0, longitude: 0 },
      start: { latitude: 0, longitude: 0 },
    },
    {
      end: { latitude: 0, longitude: 1 },
      start: { latitude: 0, longitude: Number.NaN },
    },
    {
      end: { latitude: 0, longitude: 181 },
      start: { latitude: 0, longitude: 0 },
    },
    {
      coreRequirement: { reserve: -1, services: 1 },
      end: { latitude: 0, longitude: 1 },
      start: { latitude: 0, longitude: 0 },
    },
  ]) {
    assert.throws(() => validateConnectionInput(input));
  }
});
const input = {
  end: { latitude: 0, longitude: 0.0021 },
  start: { latitude: 0, longitude: -0.0001 },
};
function createService(router) {
  const connectionService = new ConnectionService({}, router);
  connectionService.analyzePoint = async (point) => {
    const target = point.longitude < 0 ? a : b;
    try {
      const coordinates = [
        [point.longitude, point.latitude],
        target.coordinate,
      ];
      const routes = router.previewNetworkAlternatives
        ? await router.previewNetworkAlternatives(coordinates)
        : [await router.previewNetwork(coordinates)];
      return {
        routeGeometry: routes[0].geometry,
        routes: routes.map((route, index) => ({
          id: index ? "B" : "A",
          destination: {
            ...target,
            longitude: target.coordinate[0],
            latitude: target.coordinate[1],
          },
          ...(index ? { routeGeometry: route.geometry } : {}),
        })),
      };
    } catch {
      return { routes: [] };
    }
  };
  connectionService.loadGraph = async () => ({
    attachments: [],
    mappings: [],
    segments,
    terminals: [a, j, b],
  });
  return connectionService;
}
test("access routing failure returns no synthetic cable fallback", async () => {
  const result = await createService({
    previewNetwork: async () => {
      throw new Error("offline");
    },
  }).analyze(input);
  assert.equal(result.status, "ACCESS_ROUTING_UNAVAILABLE");
  assert.deepEqual(result.routes, []);
});
test("routed access plan includes only new cables, gaps reconcile totals and duplicate terminals deduplicate", async () => {
  const s = createService({
    previewNetwork: async (coordinates) => ({
      distanceMeters: 1,
      geometry: { coordinates, type: "LineString" },
    }),
  });
  s.loadGraph = async () => ({
    attachments: [],
    mappings: [],
    segments,
    terminals: [a, { ...a, id: "a-copy" }, j, b, { ...b, id: "b-copy" }],
  });
  const result = await s.analyze(input);
  assert.equal(result.mode, "connection");
  assert.equal(result.status, "PLANNING_CONNECTION");
  const route = result.routes[0];
  assert.equal(route.terminationPlan.cables.length, 2);
  assert.deepEqual(route.terminationPlan.points, []);
  assert.ok(
    Math.abs(
      route.distanceMeters -
        route.newCableMeters -
        route.existingNetworkMeters -
        route.unverifiedGapMeters
    ) < 1e-8
  );
  const keys = result.routes.map((r) =>
    connectionGeometryKey(r.source, r.destination, r.legs)
  );
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(
    route.legs.filter((l) => l.kind === "existing").map((l) => l.segmentId),
    ["s1", "s2"]
  );
});
test("route A and B keep the same terminations and existing network while access cable path changes", async () => {
  const router = {
    previewNetwork: async (coordinates) => ({
      distanceMeters: 10,
      geometry: { coordinates, type: "LineString" },
    }),
    previewNetworkAlternatives: async (coordinates) => {
      const [from, to] = coordinates;
      if (from[0] < 0) {
        return [
          {
            distanceMeters: 10,
            geometry: {
              coordinates: [from, [-0.000_05, 0], to],
              type: "LineString",
            },
          },
          {
            distanceMeters: 12,
            geometry: {
              coordinates: [from, [-0.000_05, 0.000_05], to],
              type: "LineString",
            },
          },
        ];
      }
      return [
        {
          distanceMeters: 10,
          geometry: { coordinates: [from, to], type: "LineString" },
        },
      ];
    },
  };
  const result = await createService(router).analyze(input);
  assert.deepEqual(
    result.routes.map((route) => route.id),
    ["A", "B"]
  );
  const [routeA, routeB] = result.routes;
  assert.equal(routeA.source.id, routeB.source.id);
  assert.equal(routeA.destination.id, routeB.destination.id);
  assert.deepEqual(
    routeA.legs
      .filter((leg) => leg.kind === "existing")
      .map((leg) => [leg.segmentId, leg.geometry.coordinates]),
    routeB.legs
      .filter((leg) => leg.kind === "existing")
      .map((leg) => [leg.segmentId, leg.geometry.coordinates])
  );
  assert.notDeepEqual(
    routeA.legs
      .filter((leg) => leg.kind === "new")
      .map((leg) => leg.geometry.coordinates),
    routeB.legs
      .filter((leg) => leg.kind === "new")
      .map((leg) => leg.geometry.coordinates)
  );
});
test("connection endpoint requires authentication before analysis; saves ADDRESS input mode", async () => {
  let called = false;
  const rejected = new AtlasController(
    {},
    {
      requireUser: async () => {
        throw new Error("unauthorized");
      },
    },
    {},
    {},
    {},
    {},
    {
      analyze: () => {
        called = true;
      },
    }
  );
  await assert.rejects(rejected.analyzeConnection({}, input));
  assert.equal(called, false);
  let saved;
  const controller = new AtlasController(
    {
      saveAnalysisHistory: async (...args) => {
        saved = args;
        return "history";
      },
    },
    { requireUser: async () => ({ id: "user" }) },
    {},
    {},
    {},
    {},
    { analyze: async () => ({ address: "A → B", routes: [] }) }
  );
  const result = await controller.analyzeConnection({}, input);
  assert.equal(saved[1], "ADDRESS");
  assert.equal(saved[3].inputMode, "connection");
  assert.equal(result.historyId, "history");
});
test("survey selects only persisted route and rejects geometry, missing or invalid route id", async () => {
  const result = await createService({
    previewNetwork: async (coordinates) => ({
      distanceMeters: 1,
      geometry: { coordinates, type: "LineString" },
    }),
  }).analyze(input);
  const calls = [];
  const db = {
    query: async () => ({
      rows: [{ address: result.address, analysis: structuredClone(result) }],
    }),
    transaction: async (work) =>
      work({
        query: async (sql, params) => {
          calls.push({ params, sql });
          return {
            rows: sql.startsWith("INSERT INTO network_surveys")
              ? [{ id: "survey" }]
              : [],
          };
        },
      }),
  };
  const atlas = new AtlasService(db, {}),
    id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  for (const route of [undefined, "C", {}, 1]) {
    await assert.rejects(
      atlas.createSurvey("user", id, 0, undefined, undefined, route)
    );
  }
  await assert.rejects(
    atlas.createSurvey("user", id, 0, undefined, { geometry: "client" }, "A")
  );
  await atlas.createSurvey("user", id, 0, undefined, undefined, "A");
  const saved = JSON.parse(
    calls.find((c) => c.sql.startsWith("INSERT INTO network_surveys")).params[4]
  );
  assert.equal(saved.selectedRouteId, "A");
  assert.equal(saved.terminationPlan.cables.length, 2);
  assert.ok(saved.routes[0].legs.some((l) => l.kind === "existing"));
  const duplicate = calls.find((c) =>
    c.sql.startsWith("SELECT id FROM network_surveys")
  );
  assert.ok(duplicate.sql.includes("analysis->'start'"));
  assert.ok(duplicate.sql.includes("analysis->'end'"));
});

test("two points preserve independently selected terminations and their single-point access geometry", async () => {
  const service = createService({});
  const selected = [];
  service.analyzePoint = async (point) => {
    const t = point.longitude < 0 ? a : b;
    const geometry = {
      type: "LineString",
      coordinates: [
        [point.longitude, point.latitude],
        [0.01, 0.01],
        t.coordinate,
      ],
    };
    selected.push({ t, geometry });
    return {
      routeGeometry: geometry,
      routes: [
        {
          id: "A",
          destination: {
            ...t,
            longitude: t.coordinate[0],
            latitude: t.coordinate[1],
          },
        },
      ],
    };
  };
  const result = await service.analyze(input);
  assert.equal(
    result.selectionStrategy,
    "independent_single_point_terminations"
  );
  assert.equal(result.routes[0].source.id, a.id);
  assert.equal(result.routes[0].destination.id, b.id);
  assert.deepEqual(result.routes[0].legs[0].geometry, selected[0].geometry);
  assert.deepEqual(
    result.routes[0].legs.at(-1).geometry.coordinates,
    [...selected[1].geometry.coordinates].reverse()
  );
});
