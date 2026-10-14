INSERT INTO network_asset_relations(segment_id,asset_id,kind)
SELECT route.id, point.id, point.attributes->>'assetKind'
FROM network_assets route
JOIN network_assets point
  ON point.attributes->>'ftthDesignId'=route.attributes->>'ftthDesignId'
  AND point.attributes->>'assetKind' IN ('POLE','ODC','ODP')
  AND ST_DWithin(route.geometry::geography,point.geometry::geography,1)
WHERE route.attributes->>'source'='ftth-design'
  AND route.attributes->>'assetKind'='ROUTE'
ON CONFLICT DO NOTHING;
