"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ForbiddenException } = require("@nestjs/common");
const { AtlasService } = require("../src/atlas/atlas.service");

function serviceFor(assetType) {
  const statements = [];
  const client = {
    query: async (sql) => {
      statements.push(sql);
      return { rows: sql.startsWith("SELECT id,asset_type") ? [{ id: "asset-1", asset_type: assetType }] : [] };
    },
  };
  const service = new AtlasService({ transaction: (work) => work(client) }, {});
  service.listAssets = async () => [{ id: "asset-1" }];
  return { service, statements };
}

test("non-admin can update allowed cable details", async () => {
  const { service, statements } = serviceFor("segment");
  assert.deepEqual(await service.updateAsset("asset-1", { area: "Banten", cableType: "FO" }, "presales", true), { id: "asset-1" });
  assert.ok(statements.some((sql) => sql.includes("UPDATE network_assets")));
});

test("non-admin cannot edit point assets or unrelated fields", async () => {
  const point = serviceFor("point");
  await assert.rejects(point.service.updateAsset("asset-1", { area: "Banten" }, "presales", true), ForbiddenException);
  assert.ok(!point.statements.some((sql) => sql.includes("UPDATE network_assets")));
  const cable = serviceFor("segment");
  await assert.rejects(cable.service.updateAsset("asset-1", { name: "changed" }, "presales", true), ForbiddenException);
  assert.equal(cable.statements.length, 0);
});

test("admin keeps access to existing asset fields", async () => {
  const { service, statements } = serviceFor("point");
  await service.updateAsset("asset-1", { name: "New name" }, "admin");
  assert.ok(statements.some((sql) => sql.includes("UPDATE network_assets")));
});
