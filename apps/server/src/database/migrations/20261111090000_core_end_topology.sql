CREATE TABLE "network_segment_endpoints" (
	"segment_id" text NOT NULL,
	"side" text NOT NULL,
	"node_asset_id" text NOT NULL,
	"verification_status" text DEFAULT 'confirmed' NOT NULL,
	"source" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_segment_endpoints_pk" PRIMARY KEY("segment_id","side"),
	CONSTRAINT "network_segment_endpoints_side_check" CHECK ("side" = ANY (ARRAY['A'::text, 'B'::text])),
	CONSTRAINT "network_segment_endpoints_verification_check" CHECK ("verification_status" = ANY (ARRAY['confirmed'::text, 'needs_review'::text])),
	CONSTRAINT "network_segment_endpoints_source_check" CHECK ("source" = ANY (ARRAY['Survei lapangan'::text, 'Data operasional'::text, 'Dokumen inventaris'::text]))
);
--> statement-breakpoint
ALTER TABLE "network_segment_endpoints" ADD CONSTRAINT "network_segment_endpoints_segment_id_network_assets_id_fk"
	FOREIGN KEY ("segment_id") REFERENCES "public"."network_assets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "network_segment_endpoints" ADD CONSTRAINT "network_segment_endpoints_node_asset_id_network_assets_id_fk"
	FOREIGN KEY ("node_asset_id") REFERENCES "public"."network_assets"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "network_segment_endpoints_node_idx" ON "network_segment_endpoints" USING btree ("node_asset_id");
--> statement-breakpoint
CREATE TABLE "network_core_end_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_group_id" uuid NOT NULL,
	"connection_type" text NOT NULL,
	"core_id" bigint NOT NULL,
	"side" text NOT NULL,
	"node_asset_id" text NOT NULL,
	"route_measure_m" numeric(10,2),
	"peer_core_id" bigint,
	"peer_side" text,
	"peer_route_measure_m" numeric(10,2),
	"port_reference" text,
	"verification_status" text DEFAULT 'confirmed' NOT NULL,
	"source" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_core_end_connections_side_check" CHECK ("side" = ANY (ARRAY['A'::text, 'B'::text, 'R'::text])),
	CONSTRAINT "network_core_end_connections_peer_pair_check" CHECK (("peer_core_id" IS NULL) = ("peer_side" IS NULL)),
	CONSTRAINT "network_core_end_connections_peer_side_check" CHECK ("peer_side" IS NULL OR "peer_side" = ANY (ARRAY['A'::text, 'B'::text, 'R'::text])),
	CONSTRAINT "network_core_end_connections_type_check" CHECK (("connection_type" = 'splice' AND "peer_core_id" IS NOT NULL AND "peer_side" IS NOT NULL AND "port_reference" IS NULL) OR ("connection_type" = 'termination' AND "peer_core_id" IS NULL AND "peer_side" IS NULL AND "peer_route_measure_m" IS NULL AND "port_reference" IS NULL) OR ("connection_type" = 'device_port' AND "peer_core_id" IS NULL AND "peer_side" IS NULL AND "peer_route_measure_m" IS NULL AND length(trim(COALESCE("port_reference", ''))) > 0)),
	CONSTRAINT "network_core_end_connections_route_measure_check" CHECK (("side" = 'R'::text AND "route_measure_m" IS NOT NULL AND "route_measure_m" >= 0) OR ("side" <> 'R'::text AND "route_measure_m" IS NULL)),
	CONSTRAINT "network_core_end_connections_peer_route_measure_check" CHECK (("peer_side" = 'R'::text AND "peer_route_measure_m" IS NOT NULL AND "peer_route_measure_m" >= 0) OR ("peer_side" IS DISTINCT FROM 'R'::text AND "peer_route_measure_m" IS NULL)),
	CONSTRAINT "network_core_end_connections_verification_check" CHECK ("verification_status" = ANY (ARRAY['confirmed'::text, 'needs_review'::text])),
	CONSTRAINT "network_core_end_connections_source_check" CHECK ("source" = ANY (ARRAY['Survei lapangan'::text, 'Data operasional'::text, 'Dokumen inventaris'::text])),
	CONSTRAINT "network_core_end_connections_not_self_check" CHECK ("peer_core_id" IS NULL OR "peer_core_id" <> "core_id" OR "peer_side" <> "side")
);
--> statement-breakpoint
ALTER TABLE "network_core_end_connections" ADD CONSTRAINT "network_core_end_connections_core_id_network_cores_id_fk"
	FOREIGN KEY ("core_id") REFERENCES "public"."network_cores"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "network_core_end_connections" ADD CONSTRAINT "network_core_end_connections_node_asset_id_network_assets_id_fk"
	FOREIGN KEY ("node_asset_id") REFERENCES "public"."network_assets"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "network_core_end_connections" ADD CONSTRAINT "network_core_end_connections_peer_core_id_network_cores_id_fk"
	FOREIGN KEY ("peer_core_id") REFERENCES "public"."network_cores"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "network_core_end_connections_node_idx" ON "network_core_end_connections" USING btree ("node_asset_id");
--> statement-breakpoint
CREATE INDEX "network_core_end_connections_group_idx" ON "network_core_end_connections" USING btree ("connection_group_id");
--> statement-breakpoint
CREATE INDEX "network_core_end_connections_peer_idx" ON "network_core_end_connections" USING btree ("peer_core_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "network_core_end_connections_core_side_key" ON "network_core_end_connections" USING btree ("core_id", "side") WHERE "side" = ANY (ARRAY['A'::text, 'B'::text]);
--> statement-breakpoint
CREATE UNIQUE INDEX "network_core_end_connections_route_node_key" ON "network_core_end_connections" USING btree ("core_id", "node_asset_id", "route_measure_m") WHERE "side" = 'R'::text;
