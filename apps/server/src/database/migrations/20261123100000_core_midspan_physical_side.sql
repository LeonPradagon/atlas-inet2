-- A mid-span record describes a position but older data does not identify
-- which physical side of the fibre is attached. Preserve that uncertainty.
ALTER TABLE network_core_end_connections
  ADD COLUMN IF NOT EXISTS route_physical_side text,
  ADD COLUMN IF NOT EXISTS peer_route_physical_side text;

ALTER TABLE network_core_end_connections
  ADD CONSTRAINT network_core_end_connections_physical_side_check
  CHECK (
    (route_physical_side IS NULL OR
      (side = 'R' AND route_physical_side IN ('toward_A', 'toward_B')))
    AND
    (peer_route_physical_side IS NULL OR
      (peer_side IS NOT DISTINCT FROM 'R' AND peer_route_physical_side IN ('toward_A', 'toward_B')))
  );
