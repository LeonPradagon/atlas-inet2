ALTER TABLE network_cores DROP CONSTRAINT IF EXISTS network_cores_connected_side_check;

ALTER TABLE network_cores
  ADD CONSTRAINT network_cores_connected_side_check
    CHECK (connected_side IS NULL OR connected_side IN ('A', 'B', 'R'));
