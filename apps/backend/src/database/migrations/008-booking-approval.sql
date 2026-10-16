ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('Pending Approval','Booked','Waiting List','Rejected','Released','Expired'));
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS approved_by text REFERENCES "user"(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by text REFERENCES "user"(id),
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

CREATE INDEX IF NOT EXISTS bookings_pending_approval_idx
  ON bookings(requested_at) WHERE status='Pending Approval';
