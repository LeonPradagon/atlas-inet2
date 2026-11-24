-- Additive storage for a future section-based booking flow. Existing bookings
-- continue to use booking_cores until migration and all callers are integrated.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS booking_core_sections (
  id bigserial PRIMARY KEY,
  booking_id text NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
  core_id bigint NOT NULL REFERENCES network_cores(id) ON DELETE RESTRICT,
  start_m numeric(12, 3) NOT NULL,
  end_m numeric(12, 3) NOT NULL,
  status text NOT NULL CHECK (status IN ('Booked', 'Used', 'Released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_m >= 0 AND end_m > start_m)
);

CREATE INDEX IF NOT EXISTS booking_core_sections_booking_idx
  ON booking_core_sections (booking_id);

-- Adjacent ranges still need a separate physical connectivity check.
ALTER TABLE booking_core_sections
  ADD CONSTRAINT booking_core_sections_no_overlap
  EXCLUDE USING gist (
    core_id WITH =,
    numrange(start_m, end_m, '[)') WITH &&
  ) WHERE (status IN ('Booked', 'Used'));
