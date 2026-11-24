CREATE TABLE IF NOT EXISTS booking_core_path_requests (
  booking_id text PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  start_node_id text NOT NULL REFERENCES network_assets(id) ON DELETE RESTRICT,
  end_node_id text NOT NULL REFERENCES network_assets(id) ON DELETE RESTRICT,
  route_key text NOT NULL,
  route_cable_ids jsonb NOT NULL CHECK (jsonb_typeof(route_cable_ids) = 'array'),
  requested_cores integer NOT NULL CHECK (requested_cores > 0),
  route_length_m numeric(12,3) NOT NULL CHECK (route_length_m > 0),
  proposed_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_node_id <> end_node_id),
  CHECK (jsonb_typeof(proposed_allocations) = 'array')
);

CREATE INDEX IF NOT EXISTS booking_core_path_requests_endpoints_idx
  ON booking_core_path_requests (start_node_id, end_node_id);

-- Whole-cable summaries must conservatively show a partially reserved core as
-- unavailable, while route search still reads network_cores.status directly
-- and evaluates the actual allocated intervals.
CREATE OR REPLACE VIEW network_core_booking_status AS
SELECT core.id,core.asset_id,core.core_number,
  CASE
    WHEN core.status='Used' OR EXISTS (
      SELECT 1 FROM booking_core_sections section
      WHERE section.core_id=core.id AND section.status='Used'
    ) THEN 'Used'
    WHEN core.status='Booked' OR EXISTS (
      SELECT 1 FROM booking_core_sections section
      WHERE section.core_id=core.id AND section.status='Booked'
    ) THEN 'Booked'
    ELSE core.status
  END AS status
FROM network_cores core;
