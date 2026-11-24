ALTER TABLE booking_core_path_requests
  ADD COLUMN IF NOT EXISTS route_cable_ids jsonb,
  ADD COLUMN IF NOT EXISTS route_length_m numeric(12,3);

WITH recovered AS (
  SELECT request.booking_id,
    jsonb_agg(part.value->>0 ORDER BY part.ordinality) AS cable_ids,
    sum((part.value->>2)::numeric - (part.value->>1)::numeric) AS length_m
  FROM booking_core_path_requests request
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN left(request.route_key, 2) = '[[' THEN request.route_key::jsonb ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS part(value, ordinality)
  WHERE request.route_cable_ids IS NULL OR request.route_length_m IS NULL
  GROUP BY request.booking_id
)
UPDATE booking_core_path_requests request
SET route_cable_ids = COALESCE(request.route_cable_ids, recovered.cable_ids),
    route_length_m = COALESCE(request.route_length_m, recovered.length_m)
FROM recovered WHERE recovered.booking_id = request.booking_id;

ALTER TABLE booking_core_path_requests
  ALTER COLUMN route_cable_ids SET NOT NULL,
  ALTER COLUMN route_length_m SET NOT NULL;
