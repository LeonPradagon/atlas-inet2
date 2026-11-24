ALTER TABLE booking_core_path_requests
  ADD COLUMN IF NOT EXISTS span_core_counts jsonb NOT NULL DEFAULT '[]'::jsonb;
