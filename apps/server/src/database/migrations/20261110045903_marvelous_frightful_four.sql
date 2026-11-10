CREATE TABLE "network_core_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_asset_id" text NOT NULL,
	"core_a_id" bigint NOT NULL,
	"core_b_id" bigint,
	"splitter_input" text,
	"source" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "network_core_mappings_splice_unique" UNIQUE("node_asset_id","core_a_id","core_b_id"),
	CONSTRAINT "network_core_mappings_splitter_unique" UNIQUE("node_asset_id","splitter_input"),
	CONSTRAINT "network_core_mappings_endpoint_check" CHECK ((core_b_id IS NOT NULL AND splitter_input IS NULL AND core_a_id < core_b_id) OR (core_b_id IS NULL AND splitter_input IS NOT NULL AND length(trim(splitter_input)) > 0))
);
--> statement-breakpoint
ALTER TABLE "network_core_mappings" ADD CONSTRAINT "network_core_mappings_node_asset_id_network_assets_id_fk" FOREIGN KEY ("node_asset_id") REFERENCES "public"."network_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_core_mappings" ADD CONSTRAINT "network_core_mappings_core_a_id_network_cores_id_fk" FOREIGN KEY ("core_a_id") REFERENCES "public"."network_cores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "network_core_mappings" ADD CONSTRAINT "network_core_mappings_core_b_id_network_cores_id_fk" FOREIGN KEY ("core_b_id") REFERENCES "public"."network_cores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "network_core_mappings_node_idx" ON "network_core_mappings" USING btree ("node_asset_id");--> statement-breakpoint
CREATE INDEX "network_core_mappings_core_a_idx" ON "network_core_mappings" USING btree ("core_a_id");--> statement-breakpoint
CREATE INDEX "network_core_mappings_core_b_idx" ON "network_core_mappings" USING btree ("core_b_id");