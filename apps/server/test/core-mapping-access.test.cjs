"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AtlasController } = require("../src/atlas/atlas.controller");

test("core mapping reads require a user and writes require an admin", async () => {
  let reads = 0;
  let writes = 0;
  const atlas = {
    listCoreMappings: async () => { reads++; return []; },
    createCoreMapping: async () => { writes++; },
    deleteCoreMapping: async () => { writes++; },
  };
  const auth = {
    requireUser: async (req) => { if (!req.user) throw new Error("unauthenticated"); return req.user; },
    requireAdmin: async (req) => { if (req.user?.role !== "ADMIN") throw new Error("forbidden"); return req.user; },
  };
  const controller = new AtlasController(atlas, auth, {}, {}, {}, {});
  await assert.rejects(() => controller.coreMappings({}, "cable"));
  await controller.coreMappings({ user: { role: "PRESALES" } }, "cable");
  await assert.rejects(() => controller.createCoreMapping({ user: { role: "PRESALES" } }, "cable", {}));
  await assert.rejects(() => controller.deleteCoreMapping({ user: { role: "PRESALES" } }, "cable", "id"));
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  await controller.createCoreMapping({ user: { id: "admin", role: "ADMIN" } }, "cable", {});
  await controller.deleteCoreMapping({ user: { id: "admin", role: "ADMIN" } }, "cable", "id");
  assert.equal(writes, 2);
});
