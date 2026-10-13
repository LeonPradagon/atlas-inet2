-- Backfill saved drafts created before FTTH_DESIGN history entries were added.
-- Rollback: remove FTTH_DESIGN rows with result.designId beginning `legacy:` before reverting migration 004.
WITH ftth_assets AS (
  SELECT a.*,
         COALESCE(NULLIF(a.attributes->>'ftthDesignId', ''), 'legacy:' || a.created_at::text) AS design_id
  FROM network_assets a
  WHERE a.attributes->>'source' = 'ftth-design'
), draft_groups AS (
  SELECT design_id,
         MIN(area) AS area,
         COUNT(*) FILTER (WHERE attributes->>'assetKind' <> 'ROUTE')::int AS asset_count,
         COUNT(*) FILTER (WHERE attributes->>'assetKind' = 'ROUTE')::int AS route_count,
         jsonb_agg(jsonb_build_object(
           'kind', attributes->>'assetKind',
           'name', name,
           'poleHeight', attributes->>'poleHeight',
           'routeType', attributes->>'routeType',
           'geometry', COALESCE(source_geometry, ST_AsGeoJSON(geometry)::jsonb)
         ) ORDER BY name) AS features,
         MIN(created_at) AS created_at
  FROM ftth_assets
  GROUP BY design_id
), draft_owners AS (
  SELECT DISTINCT ON (a.design_id) a.design_id, l.actor_id, l.created_at
  FROM ftth_assets a
  JOIN audit_logs l ON l.entity_id = a.id AND l.entity_type = 'FTTH_DESIGN' AND l.action = 'FTTH_DESIGN_CREATED'
  ORDER BY a.design_id, l.created_at
)
INSERT INTO analysis_history(user_id, analysis_type, title, input, result, created_at)
SELECT o.actor_id,
       'FTTH_DESIGN',
       LEFT('Draft FTTH · ' || COALESCE(NULLIF(g.area, ''), 'Lokasi analisis'), 300),
       jsonb_build_object('area', g.area, 'designId', g.design_id),
       jsonb_build_object('designId', g.design_id, 'savedCount', g.asset_count + g.route_count,
                          'assetCount', g.asset_count, 'routeCount', g.route_count, 'features', g.features),
       COALESCE(o.created_at, g.created_at, now())
FROM draft_groups g
JOIN draft_owners o USING (design_id)
WHERE o.actor_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM analysis_history h
    WHERE h.user_id = o.actor_id AND h.analysis_type = 'FTTH_DESIGN'
      AND h.result->>'designId' = g.design_id
  );
