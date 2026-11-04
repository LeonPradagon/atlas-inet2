-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
/*
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'PRESALES' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_key" UNIQUE("email"),
	CONSTRAINT "user_role_check" CHECK (role = ANY (ARRAY['ADMIN'::text, 'PRESALES'::text]))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	CONSTRAINT "session_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"asset_type" text DEFAULT 'segment' NOT NULL,
	"source" text DEFAULT 'managed' NOT NULL,
	"area" text DEFAULT '' NOT NULL,
	"cable_type" text DEFAULT 'Fiber Optic' NOT NULL,
	"total_cores" integer DEFAULT 0 NOT NULL,
	"installation" text DEFAULT 'Aerial' NOT NULL,
	"road_side" text DEFAULT 'Kiri' NOT NULL,
	"pole" text DEFAULT '' NOT NULL,
	"pole_height" text,
	"odc" text DEFAULT '' NOT NULL,
	"odp" text DEFAULT '' NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"geometry" geometry(Geometry,4326),
	"source_geometry" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_assets_total_cores_check" CHECK (total_cores >= 0),
	CONSTRAINT "network_assets_installation_check" CHECK (installation = ANY (ARRAY['Aerial'::text, 'Burial'::text])),
	CONSTRAINT "network_assets_road_side_check" CHECK (road_side = ANY (ARRAY['Kiri'::text, 'Kanan'::text])),
	CONSTRAINT "network_assets_source_check" CHECK (source = ANY (ARRAY['managed'::text, 'kml'::text, 'xlsx'::text])),
	CONSTRAINT "network_assets_pole_height_check" CHECK ((pole_height IS NULL) OR (pole_height = ANY (ARRAY['7 m'::text, '9 m'::text])))
);
--> statement-breakpoint
CREATE TABLE "network_cores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"core_number" integer NOT NULL,
	"status" text DEFAULT 'Available' NOT NULL,
	CONSTRAINT "network_cores_asset_id_core_number_key" UNIQUE("asset_id","core_number"),
	CONSTRAINT "network_cores_status_check" CHECK (status = ANY (ARRAY['Available'::text, 'Booked'::text, 'Used'::text]))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"booking_id" text
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indonesia_provinces" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indonesia_cities" (
	"code" text PRIMARY KEY NOT NULL,
	"province_code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indonesia_districts" (
	"code" text PRIMARY KEY NOT NULL,
	"city_code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"customer" text NOT NULL,
	"pic_customer" text NOT NULL,
	"pic_presales" text NOT NULL,
	"segment_id" text NOT NULL,
	"cores" integer NOT NULL,
	"status" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	CONSTRAINT "bookings_cores_check" CHECK (cores > 0),
	CONSTRAINT "bookings_status_check" CHECK (status = ANY (ARRAY['Pending Approval'::text, 'Booked'::text, 'Waiting List'::text, 'Rejected'::text, 'Released'::text, 'Expired'::text]))
);
--> statement-breakpoint
CREATE TABLE "indonesia_subdistricts" (
	"code" text PRIMARY KEY NOT NULL,
	"district_code" text NOT NULL,
	"name" text NOT NULL,
	"postal_code" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_kml_icons" (
	"id" text PRIMARY KEY NOT NULL,
	"mime_type" text NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"analysis_type" text NOT NULL,
	"title" text NOT NULL,
	"input" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_history_analysis_type_check" CHECK (analysis_type = ANY (ARRAY['ADDRESS'::text, 'BULK'::text, 'FTTH_DESIGN'::text]))
);
--> statement-breakpoint
CREATE TABLE "analysis_bulk_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"history_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"total_rows" integer NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"succeeded_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_bulk_jobs_history_id_key" UNIQUE("history_id"),
	CONSTRAINT "analysis_bulk_jobs_status_check" CHECK (status = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'COMPLETED'::text, 'COMPLETED_WITH_ERRORS'::text, 'CANCELLED'::text, 'FAILED'::text])),
	CONSTRAINT "analysis_bulk_jobs_total_rows_check" CHECK ((total_rows >= 1) AND (total_rows <= 5000))
);
--> statement-breakpoint
CREATE TABLE "analysis_bulk_job_rows" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	CONSTRAINT "analysis_bulk_job_rows_job_id_row_number_key" UNIQUE("job_id","row_number"),
	CONSTRAINT "analysis_bulk_job_rows_status_check" CHECK (status = ANY (ARRAY['QUEUED'::text, 'PROCESSING'::text, 'OK'::text, 'ERROR'::text, 'CANCELLED'::text]))
);
--> statement-breakpoint
CREATE TABLE "network_surveys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requested_by" text NOT NULL,
	"history_id" uuid NOT NULL,
	"row_number" integer DEFAULT 0 NOT NULL,
	"address" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"status" text DEFAULT 'WAITING' NOT NULL,
	"findings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_surveys_requested_by_history_id_row_number_key" UNIQUE("requested_by","history_id","row_number"),
	CONSTRAINT "network_surveys_status_check" CHECK (status = ANY (ARRAY['WAITING'::text, 'IN_PROGRESS'::text, 'REVIEW'::text, 'VERIFIED'::text, 'REVISION'::text]))
);
--> statement-breakpoint
CREATE TABLE "booking_cores" (
	"booking_id" text NOT NULL,
	"core_id" bigint NOT NULL,
	CONSTRAINT "booking_cores_pkey" PRIMARY KEY("booking_id","core_id")
);
--> statement-breakpoint
CREATE TABLE "network_asset_relations" (
	"segment_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "network_asset_relations_pkey" PRIMARY KEY("segment_id","asset_id","kind"),
	CONSTRAINT "network_asset_relations_kind_check" CHECK (kind = ANY (ARRAY['POLE'::text, 'ODC'::text, 'ODP'::text])),
	CONSTRAINT "network_asset_relations_check" CHECK (segment_id <> asset_id)
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_cores" ADD CONSTRAINT "network_cores_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."network_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indonesia_cities" ADD CONSTRAINT "indonesia_cities_province_code_fkey" FOREIGN KEY ("province_code") REFERENCES "public"."indonesia_provinces"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indonesia_districts" ADD CONSTRAINT "indonesia_districts_city_code_fkey" FOREIGN KEY ("city_code") REFERENCES "public"."indonesia_cities"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."network_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_rejected_by_fkey" FOREIGN KEY ("rejected_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indonesia_subdistricts" ADD CONSTRAINT "indonesia_subdistricts_district_code_fkey" FOREIGN KEY ("district_code") REFERENCES "public"."indonesia_districts"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_history" ADD CONSTRAINT "analysis_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_bulk_jobs" ADD CONSTRAINT "analysis_bulk_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_bulk_jobs" ADD CONSTRAINT "analysis_bulk_jobs_history_id_fkey" FOREIGN KEY ("history_id") REFERENCES "public"."analysis_history"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_bulk_job_rows" ADD CONSTRAINT "analysis_bulk_job_rows_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."analysis_bulk_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_surveys" ADD CONSTRAINT "network_surveys_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_surveys" ADD CONSTRAINT "network_surveys_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cores" ADD CONSTRAINT "booking_cores_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_cores" ADD CONSTRAINT "booking_cores_core_id_fkey" FOREIGN KEY ("core_id") REFERENCES "public"."network_cores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_asset_relations" ADD CONSTRAINT "network_asset_relations_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "public"."network_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_asset_relations" ADD CONSTRAINT "network_asset_relations_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."network_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("userId" text_ops);--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("userId" text_ops);--> statement-breakpoint
CREATE INDEX "network_assets_geom_idx" ON "network_assets" USING gist ("geometry" gist_geometry_ops_2d);--> statement-breakpoint
CREATE INDEX "network_assets_name_idx" ON "network_assets" USING gin (to_tsvector('simple'::regconfig, name) tsvector_ops);--> statement-breakpoint
CREATE INDEX "network_cores_available_idx" ON "network_cores" USING btree ("asset_id" int4_ops,"core_number" int4_ops) WHERE (status = 'Available'::text);--> statement-breakpoint
CREATE INDEX "notifications_booking_idx" ON "notifications" USING btree ("booking_id" text_ops) WHERE (booking_id IS NOT NULL);--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id" text_ops,"created_at" text_ops) WHERE (read_at IS NULL);--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at" int8_ops,"id" int8_ops);--> statement-breakpoint
CREATE INDEX "indonesia_cities_province_idx" ON "indonesia_cities" USING btree ("province_code" text_ops,"name" text_ops);--> statement-breakpoint
CREATE INDEX "indonesia_districts_city_idx" ON "indonesia_districts" USING btree ("city_code" text_ops,"name" text_ops);--> statement-breakpoint
CREATE INDEX "bookings_pending_approval_idx" ON "bookings" USING btree ("requested_at" timestamptz_ops) WHERE (status = 'Pending Approval'::text);--> statement-breakpoint
CREATE INDEX "bookings_waiting_idx" ON "bookings" USING btree ("segment_id" text_ops,"requested_at" text_ops) WHERE (status = 'Waiting List'::text);--> statement-breakpoint
CREATE INDEX "indonesia_subdistricts_district_idx" ON "indonesia_subdistricts" USING btree ("district_code" text_ops,"name" text_ops);--> statement-breakpoint
CREATE INDEX "analysis_history_user_created_idx" ON "analysis_history" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "analysis_bulk_jobs_owner_created_idx" ON "analysis_bulk_jobs" USING btree ("user_id" text_ops,"created_at" text_ops);--> statement-breakpoint
CREATE INDEX "analysis_bulk_job_rows_page_idx" ON "analysis_bulk_job_rows" USING btree ("job_id" int4_ops,"row_number" uuid_ops);--> statement-breakpoint
CREATE INDEX "analysis_bulk_job_rows_queue_idx" ON "analysis_bulk_job_rows" USING btree ("status" uuid_ops,"job_id" uuid_ops,"row_number" int4_ops);--> statement-breakpoint
CREATE INDEX "network_asset_relations_asset_idx" ON "network_asset_relations" USING btree ("asset_id" text_ops);
*/