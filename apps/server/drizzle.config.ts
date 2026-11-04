import { defineConfig } from "drizzle-kit";

// Schema-first: edit src/database/schema.ts, then `npm run db:generate` writes a
// timestamped SQL file into src/database/migrations. migration-runner.ts applies
// it on startup alongside the older hand-written files. Do not use
// `drizzle-kit migrate` or `push`; they bypass schema_migrations.
export default defineConfig({
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  dialect: "postgresql",
  extensionsFilters: ["postgis"],
  migrations: { prefix: "timestamp" },
  out: "./src/database/migrations",
  schema: "./src/database/schema.ts",
  schemaFilter: ["public"],
  tablesFilter: ["!schema_migrations"],
});
