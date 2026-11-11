"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AtlasService } = require("../src/atlas/atlas.service");

test("listCores fills missing core records up to the cable capacity", async () => {
  const cores = [{ coreNumber: 1, status: "Used" }];
  const statements = [];
  const db = {
    async query(sql, values = []) {
      statements.push(sql);
      if (sql.includes("FROM network_assets") && sql.includes("asset_type='segment'")) {
        return { rows: [{ id: values[0], totalCores: 24 }] };
      }
      if (sql.includes("INSERT INTO network_cores") && sql.includes("generate_series")) {
        for (let coreNumber = 1; coreNumber <= values[1]; coreNumber += 1) {
          if (!cores.some((core) => core.coreNumber === coreNumber)) {
            cores.push({ coreNumber, status: "Available" });
          }
        }
        return { rows: [], rowCount: values[1] - cores.length + 1 };
      }
      if (sql.includes("FROM network_cores c") && sql.includes("ORDER BY c.core_number")) {
        return { rows: cores.sort((a, b) => a.coreNumber - b.coreNumber) };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const service = new AtlasService(db, {});
  const result = await service.listCores("segment-24");

  assert.equal(result.length, 24);
  assert.equal(result[0].status, "Used");
  assert.deepEqual(result.map((core) => core.coreNumber), Array.from({ length: 24 }, (_, index) => index + 1));
  assert.ok(statements.some((sql) => sql.includes("generate_series")));
});
