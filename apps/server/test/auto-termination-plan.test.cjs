"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AtlasController } = require("../src/atlas/atlas.controller");

function controller(distance, routingFails = false) {
  const atlas = {
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

test("analysis uses demand and reserve to recommend capacity", async () => {
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
  assert.equal(result.proposal.cores, 12);
  assert.equal(result.terminationPlan.targetId, "target");
  assert.equal(result.terminationPlan.cables[0].cores, 12);
  assert.deepEqual(result.terminationPlan.requirement, {
    assumed: false,
    requiredCores: 6,
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
    (await controller(10).analyzeCoordinates(106, -6)).proposal,
    undefined
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

test("capacity rounds demand to the supplied company sizes without exceeding the list", () => {
  const { buildTerminationPlan } = require("../src/atlas/termination-plan");
  const geometry = {
    coordinates: [
      [0, 0],
      [0.001, 0],
    ],
    type: "LineString",
  };
  for (const [services, reserve, expected] of [
    [1, 0, 12],
    [5, 0, 12],
    [12, 0, 12],
    [12, 1, 24],
    [24, 1, 48],
    [48, 1, 96],
    [96, 1, 144],
    [144, 1, 288],
    [288, 1, null],
  ]) {
    assert.equal(
      buildTerminationPlan("target", geometry, 100, { reserve, services })
        .cables[0].cores,
      expected
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

test("single address defaults to a visible one-service assumption while explicit needs still work", async () => {
  const instance = controller(1000);
  instance.auth = { requireUser: async () => ({ id: "presales" }) };
  instance.atlas.saveAnalysisHistory = async () => "history-id";
  const body = {
    address: "Test",
    coordinateConfirmed: true,
    coordinates: { latitude: -6, longitude: 106 },
  };
  const automatic = await instance.analyzeAddress({}, body);
  assert.deepEqual(automatic.terminationPlan.requirement, {
    assumed: true,
    requiredCores: 1,
    reserve: 0,
    services: 1,
  });
  assert.equal(automatic.terminationPlan.cables[0].cores, null);
  assert.equal(automatic.terminationPlan.capacityBasis, "SOURCE_UNKNOWN");
  const explicit = await instance.analyzeAddress(
    {},
    { ...body, coreRequirement: { reserve: 1, services: 13 } }
  );
  assert.deepEqual(explicit.terminationPlan.requirement, {
    assumed: false,
    requiredCores: 14,
    reserve: 1,
    services: 13,
  });
  assert.equal(explicit.terminationPlan.cables[0].cores, 24);
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
