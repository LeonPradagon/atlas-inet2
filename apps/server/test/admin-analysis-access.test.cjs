"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { AtlasController } = require("../src/atlas/atlas.controller");
const { AtlasService } = require("../src/atlas/atlas.service");

test("analysis read endpoints grant cross-user access only to admins", async () => {
  const calls = [];
  const record = (name) => async (...args) => { calls.push([name, ...args]); };
  const atlas = { listAnalysisHistory: record("list"), getAnalysisHistory: record("detail") };
  const bulk = { progress: record("progress"), page: record("page"), mapPoints: record("map") };
  const auth = { requireUser: async (req) => req.user };
  const controller = new AtlasController(atlas, auth, {}, {}, {}, bulk);
  for (const role of ["ADMIN", "PRESALES"]) {
    const req = { user: { id: "viewer", role } };
    await controller.analysisHistory(req);
    await controller.analysisHistoryDetail(req, "history");
    await controller.bulkJobProgress(req, "job");
    await controller.bulkJobRows(req, "job");
    await controller.bulkJobMapPoints(req, "job");
    for (const call of calls.splice(0)) assert.equal(call.at(-1), role === "ADMIN", call[0]);
  }
});

test("admin viewing another user's history finds drafts belonging to that user", async () => {
  const queries = [];
  const db = { query: async (_sql, params) => {
    queries.push(params);
    return queries.length === 1
      ? { rows: [{ id: "history", ownerId: "owner", analysisType: "BULK", result: {} }] }
      : { rows: [] };
  } };
  const result = await new AtlasService(db, {}).getAnalysisHistory("admin", "history", true);
  assert.deepEqual(queries, [["admin", "history", true], ["owner", "history"]]);
  assert.equal(result.ownerId, undefined);
});
