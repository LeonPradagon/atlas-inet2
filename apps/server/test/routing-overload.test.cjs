const { test } = require("node:test");
const assert = require("node:assert/strict");
const { RoutingService } = require("../src/geospatial/routing.service");
const { ServiceUnavailableException } = require("@nestjs/common");
const path = {
  distance: 123,
  time: 1000,
  points: {
    type: "LineString",
    coordinates: [
      [106, -6],
      [106.01, -6],
    ],
  },
};
test("routing retries provider rate limiting instead of dropping a reachable candidate", async () => {
  const original = global.fetch,
    url = process.env.ROUTING_URL;
  process.env.ROUTING_URL = "http://routing.test";
  let calls = 0;
  global.fetch = async () =>
    ++calls === 1
      ? new Response("busy", { status: 503 })
      : new Response(JSON.stringify({ paths: [path] }));
  try {
    const routes = await new RoutingService().previewNetworkAlternatives([
      [106, -6],
      [106.01, -6],
    ]);
    assert.equal(calls, 2);
    assert.equal(routes[0].distanceMeters, 123);
  } finally {
    global.fetch = original;
    if (url === undefined) delete process.env.ROUTING_URL;
    else process.env.ROUTING_URL = url;
  }
});
test("persistent provider overload is an unavailable service, never an unreachable destination", async () => {
  const original = global.fetch,
    url = process.env.ROUTING_URL;
  process.env.ROUTING_URL = "http://routing.test";
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response("busy", { status: 503 });
  };
  try {
    await assert.rejects(
      new RoutingService().previewNetworkAlternatives([
        [106, -6],
        [106.01, -6],
      ]),
      ServiceUnavailableException
    );
    assert.equal(calls, 4);
  } finally {
    global.fetch = original;
    if (url === undefined) delete process.env.ROUTING_URL;
    else process.env.ROUTING_URL = url;
  }
});
