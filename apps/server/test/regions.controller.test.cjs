"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { RegionsController } = require("../src/database/regions.controller");

test("postal lookup fills only administrative levels shared by every match", async () => {
  const matches = [
    { provinceCode: "36", cityCode: "3604", districtCode: "360401", subdistrictCode: "1", postalCode: "42184" },
    { provinceCode: "36", cityCode: "3604", districtCode: "360401", subdistrictCode: "2", postalCode: "42184" },
  ];
  const controller = new RegionsController({
    query: async (_sql, [cities, , , postal]) => {
      assert.deepEqual(cities, []);
      assert.equal(postal, "42184");
      return { rows: matches };
    },
  });
  assert.deepEqual(await controller.resolve(undefined, undefined, undefined, "42184"), {
    provinceCode: "36", cityCode: "3604", districtCode: "360401", subdistrictCode: null, postalCode: "42184",
  });
});

test("postal lookup refuses ambiguous cities and incomplete postal codes", async () => {
  let calls = 0;
  const controller = new RegionsController({
    query: async () => {
      calls += 1;
      return { rows: [
        { provinceCode: "36", cityCode: "a", districtCode: "1", subdistrictCode: "1", postalCode: "12345" },
        { provinceCode: "36", cityCode: "b", districtCode: "2", subdistrictCode: "2", postalCode: "12345" },
      ] };
    },
  });
  assert.equal(await controller.resolve(undefined, undefined, undefined, "123"), null);
  assert.equal(calls, 0);
  assert.equal(await controller.resolve(undefined, undefined, undefined, "12345"), null);
});
