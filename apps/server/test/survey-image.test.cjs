"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BadRequestException } = require("@nestjs/common");
const { AtlasService } = require("../src/atlas/atlas.service");

function setup(findings = {}) {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: sql.startsWith("SELECT * FROM network_surveys") ? [{ status: "IN_PROGRESS", findings }] : [] };
  } };
  return { service: new AtlasService({ transaction: (work) => work(client) }, {}), calls };
}

test("survey images are saved, preserved on later updates, and omitted from audit", async () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  for (const body of [{ status: "IN_PROGRESS", image }, { status: "IN_PROGRESS" }]) {
    const { service, calls } = setup({ image });
    await service.updateSurvey("user", false, "survey", body);
    const saved = calls.find((call) => call.sql.startsWith("UPDATE network_surveys"));
    assert.equal(JSON.parse(saved.params[2]).image, image);
    const audit = calls.find((call) => call.sql.startsWith("INSERT INTO audit_logs"));
    assert.ok(!audit.params[4].includes(image));
  }
});

test("survey rejects invalid image content", async () => {
  const { service } = setup();
  await assert.rejects(service.updateSurvey("user", false, "survey", {
    status: "IN_PROGRESS", image: "data:image/png;base64,SGVsbG8=",
  }), BadRequestException);
});

function imageWithGps() {
  const tiff = Buffer.alloc(128);
  tiff.write("II");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(4, 26);
  function entry(offset, tag, type, count, value) {
    tiff.writeUInt16LE(tag, offset);
    tiff.writeUInt16LE(type, offset + 2);
    tiff.writeUInt32LE(count, offset + 4);
    tiff.writeUInt32LE(value, offset + 8);
  }
  entry(28, 1, 2, 2, 83);
  entry(40, 2, 5, 3, 80);
  entry(52, 3, 2, 2, 69);
  entry(64, 4, 5, 3, 104);
  for (const [offset, value] of [[80, 6], [88, 10], [96, 0], [104, 106], [112, 48], [120, 0]]) {
    tiff.writeUInt32LE(value, offset);
    tiff.writeUInt32LE(1, offset + 4);
  }
  const exif = Buffer.concat([Buffer.from("Exif\0\0"), tiff]);
  const header = Buffer.alloc(6);
  header.set([0xff, 0xd8, 0xff, 0xe1]);
  header.writeUInt16BE(exif.length + 2, 4);
  return `data:image/jpeg;base64,${Buffer.concat([header, exif, Buffer.from([0xff, 0xd9])]).toString("base64")}`;
}

test("new survey images must contain GPS coordinates", async () => {
  const noGps = setup();
  await assert.rejects(noGps.service.updateSurvey("user", false, "survey", {
    status: "IN_PROGRESS", image: "data:image/png;base64,iVBORw0KGgo=",
  }), BadRequestException);
  const withGps = setup();
  await withGps.service.updateSurvey("user", false, "survey", {
    status: "IN_PROGRESS", image: imageWithGps(),
  });
  const saved = JSON.parse(withGps.calls.find((call) => call.sql.startsWith("UPDATE network_surveys")).params[2]);
  assert.ok(Math.abs(Number(saved.imageLatitude) - (-6 - 10 / 60)) < 0.00001);
  assert.ok(Math.abs(Number(saved.imageLongitude) - 106.8) < 0.00001);
});
