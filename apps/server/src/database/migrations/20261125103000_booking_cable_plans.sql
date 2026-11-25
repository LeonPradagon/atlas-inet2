CREATE TABLE IF NOT EXISTS booking_cable_plans (
  id uuid PRIMARY KEY,
  booking_id text UNIQUE REFERENCES bookings(id) ON DELETE SET NULL,
  requested_by text NOT NULL,
  customer text NOT NULL,
  estimate jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
