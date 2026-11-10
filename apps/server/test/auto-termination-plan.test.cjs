"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AtlasController } = require("../src/atlas/atlas.controller");

function controller(distance, routingFails = false) {
  const atlas = {
    cableEndsAlongRoute: async () => [],
    terminationPatterns: async () => [{ type: "ODP", sampleSize: 10, medianMeters: 31 }],
    nearbyTerminations: async () => ({ points: [], searchRadiusMeters: 500 }),
    nearestNetwork: async () => ({
      id: "target",
      nearestPoint: { coordinates: [106.01, -6] },
      straightDistanceMeters: distance,
    }),
    terminationsAlongRoute: async () => [
      {
        distanceToRouteMeters: 3,
        id: "odp",
        latitude: -6,
        longitude: 106.005,
        name: "ODP A",
        recordedCables: 1,
        type: "ODP",
      },
    ],
  };
  const routing = {
    previewNetwork: async () => {
      if (routingFails) {
        throw new Error("route unavailable");
      }
      return {
        distanceMeters: 1200,
        geometry: {
          coordinates: [
            [106, -6],
            [106.01, -6],
          ],
          type: "LineString",
        },
      };
    },
  };
  return new AtlasController(atlas, {}, {}, routing, {}, {});
}

test("service demand alone does not determine distribution core capacity", async () => {
  const result = await controller(1000).analyzeCoordinates(
    106,
    -6,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    { reserve: 2, services: 4 }
  );
  assert.equal(result.proposal.kind, "ODP");
  assert.equal(result.proposal.cores, null);
  assert.equal(result.terminationPlan.targetId, "target");
  assert.equal(result.terminationPlan.cables[0].cores, null);
  assert.deepEqual(result.terminationPlan.requirement, {
    assumed: false,
    requiredCores: null,
    reserve: 2,
    services: 4,
  });
  assert.equal(result.terminationPlan.points.length, 0);
  assert.equal(result.terminationPlan.cables.length, 1);
  assert.equal(result.terminationPlan.routeEvidence[0].type, "ODP");
  assert.equal(result.terminationPlan.routeEvidence[0].recordedCables, 1);
  assert.ok(
    Math.abs(
      result.terminationPlan.cables.reduce(
        (sum, cable) => sum + cable.distanceMeters,
        0
      ) - 1200
    ) < 0.01
  );
  assert.equal(result.terminationPlan.routeEvidenceIncomplete, false);
});

test("nearby existing termination is reused and missing route makes no draft", async () => {
  assert.equal(
    (await controller(10).analyzeCoordinates(106, -6)).proposal.kind,
    "ODP"
  );
  const unavailable = await controller(100, true).analyzeCoordinates(106, -6);
  assert.equal(unavailable.status, "ROUTING_UNAVAILABLE");
  assert.equal(unavailable.terminationPlan, undefined);
});

test("route length alone does not create a closure", () => {
  const { buildTerminationPlan } = require("../src/atlas/termination-plan");
  const long = buildTerminationPlan(
    "x",
    {
      coordinates: [
        [0, 0],
        [0.01, 0],
        [0.03, 0],
      ],
      type: "LineString",
    },
    3336
  );
  assert.equal(long.points.length, 0);
  assert.equal(long.cables.length, 1);
  assert.equal(long.cables[0].distanceMeters, 3336);
});

test("unverified recorded cable can inform capacity without claiming a free core", () => {
  const { recommendSourceCable } = require("../src/atlas/termination-plan");
  const nearby = {
    available: [1],
    id: "1",
    name: "A",
    recorded: false,
    totalCores: 24,
    verified: true,
  };
  const unknown = {
    available: null,
    id: "2",
    name: "B",
    recorded: true,
    totalCores: 24,
    verified: false,
  };
  const full = {
    available: [],
    id: "3",
    name: "C",
    recorded: true,
    totalCores: 24,
    verified: true,
  };
  assert.equal(recommendSourceCable([nearby, full]), null);
  const close = {
    ...nearby,
    available: null,
    distanceMeters: 1,
    verified: false,
  };
  assert.deepEqual(recommendSourceCable([close]), {
    availableCount: null,
    coreNumber: null,
    coreNumbers: [],
    id: "1",
    name: "A",
    recorded: false,
    totalCores: 24,
    verified: false,
  });
  assert.equal(recommendSourceCable([{ ...close, distanceMeters: 21 }]), null);
  assert.deepEqual(recommendSourceCable([unknown]), {
    availableCount: null,
    coreNumber: null,
    coreNumbers: [],
    id: "2",
    name: "B",
    recorded: true,
    totalCores: 24,
    verified: false,
  });
  const good = {
    available: [3, 7],
    id: "4",
    name: "D",
    recorded: true,
    totalCores: 24,
    verified: true,
  };
  assert.deepEqual(
    recommendSourceCable([unknown, good], 2).coreNumbers,
    [3, 7]
  );
  assert.equal(recommendSourceCable([good], 3), null);
  const unsupported = { ...good, id: "a", name: "A", totalCores: 7 };
  const supported = { ...good, id: "z", name: "Z", totalCores: 48 };
  assert.equal(recommendSourceCable([unsupported, supported], 2).id, "z");
});

test("unavailable route evidence does not falsely remove the road route", async () => {
  const instance = controller(1000);
  instance.atlas.terminationsAlongRoute = async () => {
    throw new Error("unavailable");
  };
  const result = await instance.analyzeCoordinates(106, -6);
  assert.equal(result.status, "OK");
  assert.equal(result.terminationPlan.routeEvidenceIncomplete, true);
  assert.deepEqual(result.terminationPlan.routeEvidence, []);
  assert.equal(result.terminationPlan.points.length, 0);
});

test("service count does not imply a cable capacity without topology", () => {
  const { buildTerminationPlan } = require("../src/atlas/termination-plan");
  const geometry = {
    coordinates: [
      [0, 0],
      [0.001, 0],
    ],
    type: "LineString",
  };
  for (const [services, reserve] of [
    [1, 0], [5, 0], [12, 1], [48, 1], [288, 1],
  ]) {
    assert.equal(
      buildTerminationPlan("target", geometry, 100, { reserve, services })
        .cables[0].cores,
      null
    );
  }
  assert.equal(
    buildTerminationPlan("target", geometry, 100).cables[0].cores,
    null
  );
});

test("analysis rejects malformed demand before processing", async () => {
  const instance = controller(10);
  instance.auth = { requireUser: async () => ({ id: "presales" }) };
  for (const coreRequirement of [
    { reserve: 0, services: 0 },
    { reserve: -1, services: 1 },
    { reserve: 0, services: 1.5 },
    { reserve: 1, services: 4096 },
  ]) {
    await assert.rejects(() =>
      instance.analyzeAddress({}, { address: "Test", coreRequirement })
    );
  }
});

test("service demand is retained without inferring distribution cores", async () => {
  const instance = controller(1000);
  instance.auth = { requireUser: async () => ({ id: "presales" }) };
  instance.atlas.saveAnalysisHistory = async () => "history-id";
  const body = {
    address: "Test",
    coordinateConfirmed: true,
    coordinates: { latitude: -6, longitude: 106 },
  };
  const automatic = await instance.analyzeAddress({}, body);
  assert.equal(automatic.terminationPlan.requirement, null);
  assert.equal(automatic.terminationPlan.cables[0].cores, null);
  assert.equal(automatic.terminationPlan.capacityBasis, "SOURCE_UNKNOWN");
  const explicit = await instance.analyzeAddress(
    {},
    { ...body, coreRequirement: { reserve: 1, services: 13 } }
  );
  assert.deepEqual(explicit.terminationPlan.requirement, {
    assumed: false,
    requiredCores: null,
    reserve: 1,
    services: 13,
  });
  assert.equal(explicit.terminationPlan.cables[0].cores, null);
});

test("automatic capacity follows recorded sources with explicit verification state", async () => {
  const instance = controller(1000);
  instance.auth = { requireUser: async () => ({ id: "presales" }) };
  instance.atlas.saveAnalysisHistory = async () => "history-id";
  const body = {
    address: "Test",
    coordinateConfirmed: true,
    coordinates: { latitude: -6, longitude: 106 },
  };
  const cable = {
    available: [2, 4],
    id: "c",
    name: "Sumber",
    recorded: true,
    totalCores: 24,
    verified: true,
  };
  instance.atlas.nearbyTerminations = async () => ({
    points: [{ cables: [cable], id: "target" }],
  });
  const result = await instance.analyzeAddress({}, body);
  assert.equal(result.terminationPlan.cables[0].cores, 24);
  assert.equal(result.terminationPlan.capacityBasis, "VERIFIED_SOURCE");
  assert.equal(result.terminationPlan.sourceCable.totalCores, 24);
  assert.equal(result.terminationPlan.requirement, null);
  assert.equal(result.terminationPlan.sourceCable.coreNumber, null);
  assert.deepEqual(result.terminationPlan.sourceCable.coreNumbers, []);
  assert.equal(result.terminationPlan.sourceCable.availableCount, 2);
  instance.atlas.nearbyTerminations = async () => ({
    points: [
      {
        cables: [
          {
            ...cable,
            available: null,
            distanceMeters: 1,
            recorded: false,
            verified: false,
          },
        ],
        id: "target",
      },
    ],
  });
  const nearby = await instance.analyzeAddress({}, body);
  assert.equal(nearby.terminationPlan.cables[0].cores, 24);
  assert.equal(nearby.terminationPlan.capacityBasis, "UNVERIFIED_SOURCE");
  assert.equal(nearby.terminationPlan.sourceCable.recorded, false);
  assert.equal(nearby.terminationPlan.sourceCable.coreNumber, null);
  instance.atlas.nearbyTerminations = async () => ({
    points: [{ cables: [{ ...cable, verified: false }], id: "target" }],
  });
  const unverified = await instance.analyzeAddress({}, body);
  assert.equal(unverified.terminationPlan.cables[0].cores, 24);
  assert.equal(unverified.terminationPlan.capacityBasis, "UNVERIFIED_SOURCE");
  assert.equal(unverified.terminationPlan.sourceCable.coreNumber, null);
  assert.deepEqual(unverified.terminationPlan.sourceCable.coreNumbers, []);
  assert.equal(unverified.terminationPlan.sourceCable.verified, false);
  instance.atlas.nearbyTerminations = async () => ({
    points: [{ cables: [{ ...cable, totalCores: 7 }], id: "target" }],
  });
  const unsupported = await instance.analyzeAddress({}, body);
  assert.equal(unsupported.terminationPlan.cables[0].cores, null);
  assert.equal(unsupported.terminationPlan.capacityBasis, "SOURCE_UNKNOWN");
});

test("cable ends recommend closure only as a conditional connection option", async () => {
  const instance = controller(1000);
  instance.atlas.cableEndsAlongRoute = async () => [
    {
      cableId: "c1",
      cableName: "Kabel A",
      distanceMeters: 2,
      latitude: -6,
      longitude: 106.007,
    },
    {
      cableId: "c2",
      cableName: "Kabel B",
      distanceMeters: 3,
      latitude: -6,
      longitude: 106.007_01,
    },
    {
      cableId: "c3",
      cableName: "Kabel C",
      distanceMeters: 0,
      latitude: -6,
      longitude: 106.005,
    },
  ];
  const result = await instance.analyzeCoordinates(106, -6);
  assert.equal(result.terminationPlan.connectionCandidates.length, 1);
  assert.equal(
    result.terminationPlan.connectionCandidates[0].cableName,
    "Kabel A"
  );
  assert.equal(result.terminationPlan.points.length, 0);
  assert.equal(
    result.terminationPlan.connectionCandidates[0].recommendedKind,
    "Closure"
  );
  assert.equal(result.terminationPlan.connectionCandidatesIncomplete, false);
});

test("analysis reuses the nearest ODP and retains recorded device relations", async () => {
  const instance = controller(1000);
  instance.atlas.nearbyTerminations = async () => ({
    points: [
      {
        cables: [],
        id: "target",
        name: "ODP A",
        relatedDevices: [
          { cableId: "c1", id: "odc", kind: "ODC", name: "ODC A" },
        ],
        type: "ODP",
      },
    ],
    searchRadiusMeters: 500,
  });
  const result = await instance.analyzeCoordinates(106, -6);
  assert.equal(result.terminationPlan.deviceRecommendation.kind, "REUSE_ODP");
  assert.equal(
    result.terminationPlan.deviceRecommendation.relatedDevices[0].name,
    "ODC A"
  );
  assert.equal(result.proposal, undefined);
});

test("planner proposes distribution cable to a new ODP and drop from an existing ODP", () => {
  const {
    buildTerminationPlan,
    recommendSourceCable,
  } = require("../src/atlas/termination-plan");
  const geometry = {
    coordinates: [
      [106, -6],
      [106.01, -6],
    ],
    type: "LineString",
  };
  const source = recommendSourceCable([
    {
      available: null,
      distanceMeters: 2,
      id: "c",
      name: "Cable",
      recorded: false,
      totalCores: 96,
      verified: false,
    },
  ]);
  const distribution = buildTerminationPlan(
    "target",
    geometry,
    500,
    undefined,
    source,
    "Closure"
  );
  assert.equal(distribution.cables[0].type, "Distribusi");
  assert.equal(distribution.cables[0].cores, 96);
  assert.equal(distribution.capacityBasis, "UNVERIFIED_SOURCE");
  const withDemand = buildTerminationPlan("target", geometry, 500, { services: 2, reserve: 0 }, source, "Closure");
  assert.equal(withDemand.cables[0].cores, 96);
  assert.equal(withDemand.requirement.requiredCores, null);
  assert.equal(withDemand.capacityBasis, "UNVERIFIED_SOURCE");
  assert.equal(
    buildTerminationPlan("target", geometry, 500, undefined, source, "ODP")
      .cables[0].type,
    "Drop"
  );
});

test("planning identifies all supported network asset types without requiring verification", async () => {
  for (const type of ["OLT", "OTB", "ODP", "ODC", "Closure", "Slack / Coil"]) {
    const instance = controller(1000);
    instance.atlas.nearbyTerminations = async () => ({
      points: [
        {
          cables: [
            {
              available: null,
              id: "c",
              name: "Cable",
              recorded: true,
              totalCores: 24,
              verified: false,
            },
          ],
          id: "target",
          name: `${type} A`,
          relatedDevices: [],
          type,
        },
      ],
      searchRadiusMeters: 500,
    });
    const result = await instance.analyzeCoordinates(106, -6);
    assert.equal(result.terminationPlan.upstreamRecommendation.type, type);
    assert.equal(
      result.terminationPlan.upstreamRecommendation.recordedCables,
      1
    );
    assert.equal(result.terminationPlan.cables[0].cores, 24);
    assert.equal(
      result.terminationPlan.cables[0].type,
      type === "ODP" ? "Drop" : "Distribusi"
    );
    assert.equal(result.proposal?.kind, type === "ODP" ? undefined : "ODP");
  }
});

test("device candidates use mapped evidence, suppress existing devices and avoid incomplete data", () => {
  const {
    recommendDeviceCandidates,
  } = require("../src/atlas/termination-plan");
  const point = (type, longitude) => ({
    latitude: 0,
    longitude,
    name: type,
    type,
  });
  const evidence = [
    point("POP", 0.001),
    point("OLT", 0.003),
    point("Closure", 0.005),
  ];
  const ends = [
    { cableId: "a", cableName: "A", latitude: 0, longitude: 0.007 },
    { cableId: "b", cableName: "B", latitude: 0, longitude: 0.007_01 },
  ];
  const candidates = recommendDeviceCandidates(evidence, ends, false);
  assert.deepEqual(
    candidates.map((item) => item.kind).sort(),
    ["ODC", "OLT", "OTB", "Slack / Coil"].sort()
  );
  assert.ok(
    candidates.every(
      (item) => item.reason.includes("Opsi") || item.reason.includes("opsi")
    )
  );
  assert.deepEqual(recommendDeviceCandidates([], [], false), []);
  assert.deepEqual(recommendDeviceCandidates(evidence, ends, true), []);
  assert.ok(
    !recommendDeviceCandidates(
      [...evidence, point("OTB", 0.003_01)],
      ends,
      false
    ).some((item) => item.kind === "OTB")
  );
  assert.ok(
    !recommendDeviceCandidates([], [ends[0], { ...ends[0] }], false).some(
      (item) => item.kind === "ODC"
    )
  );
});

test("device suggestions are placed on the route and exclude its endpoints", () => {
  const { placeAlongRoute } = require("../src/atlas/termination-plan");
  const route = {
    coordinates: [
      [0, 0],
      [0.005, 0],
      [0.005, 0.005],
    ],
    type: "LineString",
  };
  const points = [
    { kind: "OTB", latitude: 0.000_05, longitude: 0.002 },
    { kind: "ODC", latitude: 0.003, longitude: 0.005_05 },
    { kind: "Slack / Coil", latitude: 0.005, longitude: 0.005 },
  ];
  const result = placeAlongRoute(points, route);
  assert.equal(result.length, 2);
  assert.equal(result[0].latitude, 0);
  assert.equal(result[1].longitude, 0.005);
  assert.ok(result[0].distanceToEvidenceMeters > 5);
  assert.deepEqual(
    placeAlongRoute(points, { coordinates: [[0, 0]], type: "LineString" }),
    []
  );
});

test("analysis suggests devices from route evidence, not an automatic slack", async () => {
  const instance = controller(1000);
  const withoutEvidence = await instance.analyzeCoordinates(106, -6);
  assert.ok(withoutEvidence.terminationPlan.deviceCandidates.every((p) => p.kind === "ODP"));
  assert.ok(withoutEvidence.terminationPlan.deviceCandidates.length > 1);

  instance.atlas.terminationsAlongRoute = async () => [
    { type: "OLT", name: "OLT A", latitude: -6, longitude: 106.005 },
  ];
  const withOlt = await instance.analyzeCoordinates(106, -6);
  assert.ok(withOlt.terminationPlan.deviceCandidates.some((p) => p.kind === "OTB"));
  assert.ok(withOlt.terminationPlan.deviceCandidates.every((p) => p.kind !== "Slack / Coil"));
});

test("ODP estimates follow KMZ spacing, avoid existing ODP and endpoints", () => {
  const { estimateOdpLocations } = require("../src/atlas/termination-plan");
  const geometry = { type: "LineString", coordinates: [[0, 0], [0.001, 0]] };
  const estimates = estimateOdpLocations(geometry, [], 31);
  assert.equal(estimates.length, 2);
  assert.ok(Math.abs(estimates[0].longitude * 111320 - 31) < 0.01);
  assert.equal(estimateOdpLocations(geometry, [{ ...estimates[0], type: "ODP" }], 31).length, 1);
  assert.equal(estimateOdpLocations(geometry, [], 45).length, 2);
  assert.equal(estimateOdpLocations(geometry, [], 0).length, 0);
});

test("analysis uses current local pattern and suppresses simulation when samples are insufficient", async () => {
  const instance = controller(1000);
  instance.atlas.terminationPatterns = async () => [{ type: "ODP", sampleSize: 5, medianMeters: 60 }];
  const result = await instance.analyzeCoordinates(106, -6);
  assert.ok(result.terminationPlan.deviceCandidates[0].reason.includes("60 m"));
  instance.atlas.terminationPatterns = async () => [{ type: "ODP", sampleSize: 4, medianMeters: 60 }];
  assert.equal((await instance.analyzeCoordinates(106, -6)).terminationPlan.deviceCandidates.length, 0);
});

