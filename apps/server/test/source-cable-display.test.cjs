"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");

test("source cable detail does not select cores when demand is unknown", async () => {
  const { describeSourceCable } = await import(
    "../../web/src/features/analysis/terminationPlan.ts"
  );
  const sourceCable = {
    availableCount: 3,
    coreNumber: 4,
    coreNumbers: [4],
    id: "x",
    name: "Kabel A",
    recorded: true,
    verified: true,
  };
  assert.match(
    describeSourceCable({ sourceCable }),
    /3 core tersedia tercatat.*nomor core belum dipilih/
  );
  assert.doesNotMatch(describeSourceCable({ sourceCable }), /core 4/);
  assert.doesNotMatch(
    describeSourceCable({ requirement: { assumed: true }, sourceCable }),
    /core 4/
  );
  assert.match(
    describeSourceCable({ requirement: { assumed: false }, sourceCable }),
    /core 4/
  );
  assert.match(
    describeSourceCable({
      sourceCable: { ...sourceCable, recorded: false, verified: false },
    }),
    /relasi belum tercatat.*belum terverifikasi/
  );
});
