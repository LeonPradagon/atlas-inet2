-- The topology migration was edited after being applied in some local databases.
-- Bring those already-created tables up to the current topology schema.
ALTER TABLE network_core_end_connections
  ADD COLUMN IF NOT EXISTS node_asset_id text,
  ADD COLUMN IF NOT EXISTS route_measure_m numeric(10,2),
  ADD COLUMN IF NOT EXISTS peer_route_measure_m numeric(10,2);

-- Preserve any connections written by the earlier schema by resolving their
-- junction from explicit endpoint records, legacy mappings, or core metadata.
UPDATE network_core_end_connections connection
SET node_asset_id = COALESCE(
  (
    SELECT endpoint.node_asset_id
    FROM network_cores core
    JOIN network_segment_endpoints endpoint
      ON endpoint.segment_id=core.asset_id AND endpoint.side=connection.side
    WHERE core.id=connection.core_id
    LIMIT 1
  ),
  (
    SELECT mapping.node_asset_id
    FROM network_core_mappings mapping
    WHERE mapping.core_a_id=connection.core_id OR mapping.core_b_id=connection.core_id
    ORDER BY mapping.created_at DESC
    LIMIT 1
  ),
  (
    SELECT core.connected_asset_id
    FROM network_cores core
    WHERE core.id=connection.core_id AND core.connected_side=connection.side
  )
)
WHERE connection.node_asset_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM network_core_end_connections WHERE node_asset_id IS NULL) THEN
    RAISE EXCEPTION 'Core topology upgrade cannot resolve node_asset_id for existing connections; data was preserved.';
  END IF;
END $$;

ALTER TABLE network_core_end_connections
  ALTER COLUMN node_asset_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='network_core_end_connections_node_asset_id_network_assets_id_fk'
      AND conrelid='network_core_end_connections'::regclass
  ) THEN
    ALTER TABLE network_core_end_connections
      ADD CONSTRAINT network_core_end_connections_node_asset_id_network_assets_id_fk
      FOREIGN KEY (node_asset_id) REFERENCES network_assets(id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE network_core_end_connections
  DROP CONSTRAINT IF EXISTS network_core_end_connections_side_check,
  DROP CONSTRAINT IF EXISTS network_core_end_connections_peer_side_check,
  DROP CONSTRAINT IF EXISTS network_core_end_connections_type_check,
  DROP CONSTRAINT IF EXISTS network_core_end_connections_route_measure_check,
  DROP CONSTRAINT IF EXISTS network_core_end_connections_peer_route_measure_check;

ALTER TABLE network_core_end_connections
  ADD CONSTRAINT network_core_end_connections_side_check
    CHECK (side = ANY (ARRAY['A'::text, 'B'::text, 'R'::text])),
  ADD CONSTRAINT network_core_end_connections_peer_side_check
    CHECK (peer_side IS NULL OR peer_side = ANY (ARRAY['A'::text, 'B'::text, 'R'::text])),
  ADD CONSTRAINT network_core_end_connections_type_check
    CHECK (
      (connection_type='splice' AND peer_core_id IS NOT NULL AND peer_side IS NOT NULL AND port_reference IS NULL)
      OR (connection_type='termination' AND peer_core_id IS NULL AND peer_side IS NULL AND peer_route_measure_m IS NULL AND port_reference IS NULL)
      OR (connection_type='device_port' AND peer_core_id IS NULL AND peer_side IS NULL AND peer_route_measure_m IS NULL AND length(trim(COALESCE(port_reference,'')))>0)
    ),
  ADD CONSTRAINT network_core_end_connections_route_measure_check
    CHECK ((side='R' AND route_measure_m IS NOT NULL AND route_measure_m>=0) OR (side<>'R' AND route_measure_m IS NULL)),
  ADD CONSTRAINT network_core_end_connections_peer_route_measure_check
    CHECK ((peer_side='R' AND peer_route_measure_m IS NOT NULL AND peer_route_measure_m>=0) OR (peer_side IS DISTINCT FROM 'R' AND peer_route_measure_m IS NULL));

ALTER TABLE network_core_end_connections
  DROP CONSTRAINT IF EXISTS network_core_end_connections_core_side_key;
DROP INDEX IF EXISTS network_core_end_connections_core_side_key;

CREATE INDEX IF NOT EXISTS network_core_end_connections_node_idx
  ON network_core_end_connections(node_asset_id);
CREATE INDEX IF NOT EXISTS network_core_end_connections_group_idx
  ON network_core_end_connections(connection_group_id);
CREATE INDEX IF NOT EXISTS network_core_end_connections_peer_idx
  ON network_core_end_connections(peer_core_id);
CREATE UNIQUE INDEX IF NOT EXISTS network_core_end_connections_core_side_key
  ON network_core_end_connections(core_id,side) WHERE side IN ('A','B');
CREATE UNIQUE INDEX IF NOT EXISTS network_core_end_connections_route_node_key
  ON network_core_end_connections(core_id,node_asset_id,route_measure_m) WHERE side='R';
