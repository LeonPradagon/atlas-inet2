ALTER TABLE booking_core_path_requests
  ADD COLUMN IF NOT EXISTS price_snapshot jsonb NOT NULL DEFAULT '{"configured":false,"currency":"IDR","unit":"core","items":[],"coreRateCents":0,"allocationCount":0,"totalCents":0,"capturedAt":""}'::jsonb;
