ALTER TABLE network_cores
  ADD COLUMN connected_asset_id text REFERENCES network_assets(id) ON DELETE RESTRICT,
  ADD COLUMN connected_side text,
  ADD CONSTRAINT network_cores_connected_side_check
    CHECK (connected_side IS NULL OR connected_side IN ('A', 'B')),
  ADD CONSTRAINT network_cores_destination_pair_check
    CHECK ((connected_asset_id IS NULL) = (connected_side IS NULL));
