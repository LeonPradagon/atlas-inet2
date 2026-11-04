ALTER TABLE notifications ADD COLUMN booking_id text REFERENCES bookings(id) ON DELETE SET NULL;
CREATE INDEX notifications_booking_idx ON notifications(booking_id) WHERE booking_id IS NOT NULL;

UPDATE notifications
SET booking_id = (regexp_match(message, '(BKG-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12})'))[1]
WHERE booking_id IS NULL
  AND message ~ 'BKG-[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}';
