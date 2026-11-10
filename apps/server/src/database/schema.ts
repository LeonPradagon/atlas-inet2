import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
// ponytail: read back as raw EWKB hex. Select sql`ST_AsGeoJSON(...)` when the shape is needed.
const geometry = customType<{ data: string }>({
  dataType: () => "geometry(Geometry,4326)",
});

export const user = pgTable(
  "user",
  {
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    email: text().notNull(),
    emailVerified: boolean().default(false).notNull(),
    id: text().primaryKey().notNull(),
    image: text(),
    name: text().notNull(),
    role: text().default("PRESALES").notNull(),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("user_email_key").on(table.email),
    check(
      "user_role_check",
      sql`role = ANY (ARRAY['ADMIN'::text, 'PRESALES'::text])`
    ),
  ]
);

export const session = pgTable(
  "session",
  {
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp({ mode: "date", withTimezone: true }).notNull(),
    id: text().primaryKey().notNull(),
    ipAddress: text(),
    token: text().notNull(),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    userAgent: text(),
    userId: text().notNull(),
  },
  (table) => [
    index("session_user_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "session_userId_fkey",
    }).onDelete("cascade"),
    unique("session_token_key").on(table.token),
  ]
);

export const account = pgTable(
  "account",
  {
    accessToken: text(),
    accessTokenExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    accountId: text().notNull(),
    createdAt: timestamp({ mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    id: text().primaryKey().notNull(),
    idToken: text(),
    password: text(),
    providerId: text().notNull(),
    refreshToken: text(),
    refreshTokenExpiresAt: timestamp({ mode: "date", withTimezone: true }),
    scope: text(),
    updatedAt: timestamp({ mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    userId: text().notNull(),
  },
  (table) => [
    index("account_user_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "account_userId_fkey",
    }).onDelete("cascade"),
  ]
);

export const verification = pgTable("verification", {
  createdAt: timestamp({ mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  expiresAt: timestamp({ mode: "date", withTimezone: true }).notNull(),
  id: text().primaryKey().notNull(),
  identifier: text().notNull(),
  updatedAt: timestamp({ mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  value: text().notNull(),
});

export const networkAssets = pgTable(
  "network_assets",
  {
    area: text().default("").notNull(),
    assetType: text("asset_type").default("segment").notNull(),
    attributes: jsonb().default({}).notNull(),
    cableType: text("cable_type").default("Fiber Optic").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    geometry: geometry(),
    id: text().primaryKey().notNull(),
    installation: text().default("Aerial").notNull(),
    name: text().notNull(),
    odc: text().default("").notNull(),
    odp: text().default("").notNull(),
    pole: text().default("").notNull(),
    poleHeight: text("pole_height"),
    roadSide: text("road_side").default("Kiri").notNull(),
    source: text().default("managed").notNull(),
    sourceGeometry: jsonb("source_geometry"),
    totalCores: integer("total_cores").default(0).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("network_assets_geom_idx").using(
      "gist",
      table.geometry.asc().nullsLast()
    ),
    index("network_assets_name_idx").using(
      "gin",
      sql`to_tsvector('simple'::regconfig, name)`
    ),
    check("network_assets_total_cores_check", sql`total_cores >= 0`),
    check(
      "network_assets_installation_check",
      sql`installation = ANY (ARRAY['Aerial'::text, 'Burial'::text])`
    ),
    check(
      "network_assets_road_side_check",
      sql`road_side = ANY (ARRAY['Kiri'::text, 'Kanan'::text])`
    ),
    check(
      "network_assets_source_check",
      sql`source = ANY (ARRAY['managed'::text, 'kml'::text, 'xlsx'::text])`
    ),
    check(
      "network_assets_pole_height_check",
      sql`(pole_height IS NULL) OR (pole_height = ANY (ARRAY['7 m'::text, '9 m'::text]))`
    ),
  ]
);

export const networkCores = pgTable(
  "network_cores",
  {
    assetId: text("asset_id").notNull(),
    coreNumber: integer("core_number").notNull(),
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    status: text().default("Available").notNull(),
  },
  (table) => [
    index("network_cores_available_idx")
      .using(
        "btree",
        table.assetId.asc().nullsLast(),
        table.coreNumber.asc().nullsLast()
      )
      .where(sql`(status = 'Available'::text)`),
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [networkAssets.id],
      name: "network_cores_asset_id_fkey",
    }).onDelete("cascade"),
    unique("network_cores_asset_id_core_number_key").on(
      table.assetId,
      table.coreNumber
    ),
    check(
      "network_cores_status_check",
      sql`status = ANY (ARRAY['Available'::text, 'Booked'::text, 'Used'::text])`
    ),
  ]
);

export const notifications = pgTable(
  "notifications",
  {
    bookingId: text("booking_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    message: text().notNull(),
    readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
    title: text().notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("notifications_booking_idx")
      .using("btree", table.bookingId.asc().nullsLast())
      .where(sql`(booking_id IS NOT NULL)`),
    index("notifications_unread_idx")
      .using(
        "btree",
        table.userId.asc().nullsLast(),
        table.createdAt.desc().nullsFirst()
      )
      .where(sql`(read_at IS NULL)`),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "notifications_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bookings.id],
      name: "notifications_booking_id_fkey",
    }).onDelete("set null"),
  ]
);

export const appSettings = pgTable("app_settings", {
  key: text().primaryKey().notNull(),
  value: jsonb().notNull(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    action: text().notNull(),
    actorId: text("actor_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    details: jsonb().default({}).notNull(),
    entityId: text("entity_id"),
    entityType: text("entity_type").notNull(),
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
  },
  (table) => [
    index("audit_logs_created_idx").using(
      "btree",
      table.createdAt.desc().nullsFirst(),
      table.id.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [user.id],
      name: "audit_logs_actor_id_fkey",
    }).onDelete("set null"),
  ]
);

export const indonesiaProvinces = pgTable("indonesia_provinces", {
  code: text().primaryKey().notNull(),
  name: text().notNull(),
});

export const indonesiaCities = pgTable(
  "indonesia_cities",
  {
    code: text().primaryKey().notNull(),
    name: text().notNull(),
    provinceCode: text("province_code").notNull(),
  },
  (table) => [
    index("indonesia_cities_province_idx").using(
      "btree",
      table.provinceCode.asc().nullsLast(),
      table.name.asc().nullsLast()
    ),
    foreignKey({
      columns: [table.provinceCode],
      foreignColumns: [indonesiaProvinces.code],
      name: "indonesia_cities_province_code_fkey",
    }),
  ]
);

export const indonesiaDistricts = pgTable(
  "indonesia_districts",
  {
    cityCode: text("city_code").notNull(),
    code: text().primaryKey().notNull(),
    name: text().notNull(),
  },
  (table) => [
    index("indonesia_districts_city_idx").using(
      "btree",
      table.cityCode.asc().nullsLast(),
      table.name.asc().nullsLast()
    ),
    foreignKey({
      columns: [table.cityCode],
      foreignColumns: [indonesiaCities.code],
      name: "indonesia_districts_city_code_fkey",
    }),
  ]
);

export const bookings = pgTable(
  "bookings",
  {
    approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
    approvedBy: text("approved_by"),
    cores: integer().notNull(),
    customer: text().notNull(),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
    id: text().primaryKey().notNull(),
    picCustomer: text("pic_customer").notNull(),
    picPresales: text("pic_presales").notNull(),
    rejectedAt: timestamp("rejected_at", { mode: "date", withTimezone: true }),
    rejectedBy: text("rejected_by"),
    releasedAt: timestamp("released_at", { mode: "date", withTimezone: true }),
    requestedAt: timestamp("requested_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    requestedBy: text("requested_by"),
    segmentId: text("segment_id").notNull(),
    status: text().notNull(),
  },
  (table) => [
    index("bookings_pending_approval_idx")
      .using("btree", table.requestedAt.asc().nullsLast())
      .where(sql`(status = 'Pending Approval'::text)`),
    index("bookings_waiting_idx")
      .using(
        "btree",
        table.segmentId.asc().nullsLast(),
        table.requestedAt.asc().nullsLast()
      )
      .where(sql`(status = 'Waiting List'::text)`),
    foreignKey({
      columns: [table.segmentId],
      foreignColumns: [networkAssets.id],
      name: "bookings_segment_id_fkey",
    }),
    foreignKey({
      columns: [table.requestedBy],
      foreignColumns: [user.id],
      name: "bookings_requested_by_fkey",
    }),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [user.id],
      name: "bookings_approved_by_fkey",
    }),
    foreignKey({
      columns: [table.rejectedBy],
      foreignColumns: [user.id],
      name: "bookings_rejected_by_fkey",
    }),
    check("bookings_cores_check", sql`cores > 0`),
    check(
      "bookings_status_check",
      sql`status = ANY (ARRAY['Pending Approval'::text, 'Booked'::text, 'Waiting List'::text, 'Rejected'::text, 'Released'::text, 'Expired'::text])`
    ),
  ]
);

export const indonesiaSubdistricts = pgTable(
  "indonesia_subdistricts",
  {
    code: text().primaryKey().notNull(),
    districtCode: text("district_code").notNull(),
    name: text().notNull(),
    postalCode: text("postal_code").default("").notNull(),
  },
  (table) => [
    index("indonesia_subdistricts_district_idx").using(
      "btree",
      table.districtCode.asc().nullsLast(),
      table.name.asc().nullsLast()
    ),
    foreignKey({
      columns: [table.districtCode],
      foreignColumns: [indonesiaDistricts.code],
      name: "indonesia_subdistricts_district_code_fkey",
    }),
  ]
);

export const networkKmlIcons = pgTable("network_kml_icons", {
  content: bytea("content").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  id: text().primaryKey().notNull(),
  mimeType: text("mime_type").notNull(),
});

export const analysisHistory = pgTable(
  "analysis_history",
  {
    analysisType: text("analysis_type").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid().defaultRandom().primaryKey().notNull(),
    input: jsonb().notNull(),
    result: jsonb().notNull(),
    title: text().notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("analysis_history_user_created_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "analysis_history_user_id_fkey",
    }).onDelete("cascade"),
    check(
      "analysis_history_analysis_type_check",
      sql`analysis_type = ANY (ARRAY['ADDRESS'::text, 'BULK'::text, 'FTTH_DESIGN'::text])`
    ),
  ]
);

export const analysisBulkJobs = pgTable(
  "analysis_bulk_jobs",
  {
    cancelRequestedAt: timestamp("cancel_requested_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    failedRows: integer("failed_rows").default(0).notNull(),
    fileName: text("file_name").notNull(),
    historyId: uuid("history_id").notNull(),
    id: uuid().defaultRandom().primaryKey().notNull(),
    processedRows: integer("processed_rows").default(0).notNull(),
    status: text().default("QUEUED").notNull(),
    succeededRows: integer("succeeded_rows").default(0).notNull(),
    totalRows: integer("total_rows").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("analysis_bulk_jobs_owner_created_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.createdAt.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "analysis_bulk_jobs_user_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.historyId],
      foreignColumns: [analysisHistory.id],
      name: "analysis_bulk_jobs_history_id_fkey",
    }).onDelete("cascade"),
    unique("analysis_bulk_jobs_history_id_key").on(table.historyId),
    check(
      "analysis_bulk_jobs_status_check",
      sql`status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'COMPLETED'::text, 'COMPLETED_WITH_ERRORS'::text, 'CANCELLED'::text, 'FAILED'::text])`
    ),
    check(
      "analysis_bulk_jobs_total_rows_check",
      sql`(total_rows >= 1) AND (total_rows <= 5000)`
    ),
  ]
);

export const analysisBulkJobRows = pgTable(
  "analysis_bulk_job_rows",
  {
    attempts: integer().default(0).notNull(),
    errorMessage: text("error_message"),
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    input: jsonb().notNull(),
    jobId: uuid("job_id").notNull(),
    processedAt: timestamp("processed_at", {
      mode: "date",
      withTimezone: true,
    }),
    processingStartedAt: timestamp("processing_started_at", {
      mode: "date",
      withTimezone: true,
    }),
    result: jsonb(),
    rowNumber: integer("row_number").notNull(),
    status: text().default("QUEUED").notNull(),
  },
  (table) => [
    index("analysis_bulk_job_rows_page_idx").using(
      "btree",
      table.jobId.asc().nullsLast(),
      table.rowNumber.asc().nullsLast()
    ),
    index("analysis_bulk_job_rows_queue_idx").using(
      "btree",
      table.status.asc().nullsLast(),
      table.jobId.asc().nullsLast(),
      table.rowNumber.asc().nullsLast()
    ),
    foreignKey({
      columns: [table.jobId],
      foreignColumns: [analysisBulkJobs.id],
      name: "analysis_bulk_job_rows_job_id_fkey",
    }).onDelete("cascade"),
    unique("analysis_bulk_job_rows_job_id_row_number_key").on(
      table.jobId,
      table.rowNumber
    ),
    check(
      "analysis_bulk_job_rows_status_check",
      sql`status = ANY (ARRAY['QUEUED'::text, 'PROCESSING'::text, 'OK'::text, 'ERROR'::text, 'CANCELLED'::text])`
    ),
  ]
);

export const networkSurveys = pgTable(
  "network_surveys",
  {
    address: text().notNull(),
    analysis: jsonb().notNull(),
    findings: jsonb().default({}).notNull(),
    historyId: uuid("history_id").notNull(),
    id: uuid().defaultRandom().primaryKey().notNull(),
    requestedBy: text("requested_by").notNull(),
    rowNumber: integer("row_number").default(0).notNull(),
    status: text().default("WAITING").notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    verifiedAt: timestamp("verified_at", { mode: "date", withTimezone: true }),
    verifiedBy: text("verified_by"),
  },
  (table) => [
    foreignKey({
      columns: [table.requestedBy],
      foreignColumns: [user.id],
      name: "network_surveys_requested_by_fkey",
    }),
    foreignKey({
      columns: [table.verifiedBy],
      foreignColumns: [user.id],
      name: "network_surveys_verified_by_fkey",
    }),
    unique("network_surveys_requested_by_history_id_row_number_key").on(
      table.requestedBy,
      table.historyId,
      table.rowNumber
    ),
    check(
      "network_surveys_status_check",
      sql`status = ANY (ARRAY['WAITING'::text, 'IN_PROGRESS'::text, 'REVIEW'::text, 'VERIFIED'::text, 'REVISION'::text])`
    ),
  ]
);

export const bookingCores = pgTable(
  "booking_cores",
  {
    bookingId: text("booking_id").notNull(),
    coreId: bigint("core_id", { mode: "number" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.bookingId],
      foreignColumns: [bookings.id],
      name: "booking_cores_booking_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.coreId],
      foreignColumns: [networkCores.id],
      name: "booking_cores_core_id_fkey",
    }),
    primaryKey({
      columns: [table.bookingId, table.coreId],
      name: "booking_cores_pkey",
    }),
  ]
);

export const networkAssetRelations = pgTable(
  "network_asset_relations",
  {
    assetId: text("asset_id").notNull(),
    kind: text().notNull(),
    segmentId: text("segment_id").notNull(),
  },
  (table) => [
    index("network_asset_relations_asset_idx").using(
      "btree",
      table.assetId.asc().nullsLast()
    ),
    foreignKey({
      columns: [table.segmentId],
      foreignColumns: [networkAssets.id],
      name: "network_asset_relations_segment_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [networkAssets.id],
      name: "network_asset_relations_asset_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.segmentId, table.assetId, table.kind],
      name: "network_asset_relations_pkey",
    }),
    check(
      "network_asset_relations_kind_check",
      sql`kind = ANY (ARRAY['POLE'::text, 'ODC'::text, 'ODP'::text])`
    ),
    check("network_asset_relations_check", sql`segment_id <> asset_id`),
  ]
);

export const networkCoreMappings = pgTable("network_core_mappings", {
  id: uuid().defaultRandom().primaryKey(),
  nodeAssetId: text("node_asset_id").notNull().references(() => networkAssets.id, { onDelete: "restrict" }),
  coreAId: bigint("core_a_id", { mode: "number" }).notNull().references(() => networkCores.id, { onDelete: "restrict" }),
  coreBId: bigint("core_b_id", { mode: "number" }).references(() => networkCores.id, { onDelete: "restrict" }),
  splitterInput: text("splitter_input"),
  source: text().notNull(),
  note: text().notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("network_core_mappings_node_idx").on(table.nodeAssetId),
  index("network_core_mappings_core_a_idx").on(table.coreAId),
  index("network_core_mappings_core_b_idx").on(table.coreBId),
  unique("network_core_mappings_splice_unique").on(table.nodeAssetId, table.coreAId, table.coreBId),
  unique("network_core_mappings_splitter_unique").on(table.nodeAssetId, table.splitterInput),
  check("network_core_mappings_endpoint_check", sql`(core_b_id IS NOT NULL AND splitter_input IS NULL AND core_a_id < core_b_id) OR (core_b_id IS NULL AND splitter_input IS NOT NULL AND length(trim(splitter_input)) > 0)`),
]);
