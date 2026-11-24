"use strict";
require("reflect-metadata");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NestFactory } = require("@nestjs/core");
const { DocumentBuilder, SwaggerModule } = require("@nestjs/swagger");
const { AppModule } = require("../src/app.module");
const { addResponseSchemas } = require("../src/openapi/responses");

test("every Nest endpoint documents its successful JSON response", async () => {
  const app = await NestFactory.create(AppModule, { logger: false });
  try {
    app.setGlobalPrefix("api");
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build()
    );
    addResponseSchemas(document);
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        assert.ok(
          Object.keys(operation.responses).some((status) =>
            /^2\d\d$/.test(status)
          ),
          `${method} ${path}: missing success response`
        );
        for (const [status, response] of Object.entries(operation.responses)) {
          if (/^2\d\d$/.test(status)) {
            assert.ok(
              response.content?.["application/json"]?.schema,
              `${method} ${path}: ${status}`
            );
          }
        }
      }
    }
    const getSchema = (path, method) =>
      document.paths[path][method].responses[method === "post" ? "201" : "200"]
        .content["application/json"].schema;
    assert.equal(getSchema("/api/bookings", "get").type, "array");
    assert.equal(
      getSchema("/api/surveys", "post").properties.id.type,
      "string"
    );
    assert.equal(
      getSchema("/api/analysis/address/reverse", "get").nullable,
      true
    );
  } finally {
    await app.close();
  }
});
