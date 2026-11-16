ALTER TABLE "bookings" DROP CONSTRAINT "bookings_status_check";--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "pic_customer_email" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "pic_customer_phone" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_status_check" CHECK (status = ANY (ARRAY['Pending Approval'::text, 'Booked'::text, 'Waiting List'::text, 'Rejected'::text, 'Released'::text, 'Expired'::text, 'Used'::text]));
