CREATE TABLE "booking_segments" (
	"booking_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"cores" integer NOT NULL,
	CONSTRAINT "booking_segments_booking_id_segment_id_pk" PRIMARY KEY("booking_id","segment_id"),
	CONSTRAINT "booking_segments_cores_check" CHECK ("booking_segments"."cores" > 0)
);
--> statement-breakpoint
ALTER TABLE "booking_segments" ADD CONSTRAINT "booking_segments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_segments" ADD CONSTRAINT "booking_segments_segment_id_network_assets_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."network_assets"("id") ON DELETE no action ON UPDATE no action;