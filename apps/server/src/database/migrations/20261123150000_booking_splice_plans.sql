ALTER TABLE booking_core_path_requests
  ADD COLUMN IF NOT EXISTS planned_splices jsonb NOT NULL DEFAULT '[]'::jsonb;
