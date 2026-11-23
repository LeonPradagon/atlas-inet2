import type { Feature, Polygon } from "geojson";
import { kmzLegend } from "../map/kmzLegend";

export const analysisMapStyle = {
  searchRadiusColor: "#3454d1",
  searchRadiusFillOpacity: 0.08,
  searchRadiusLineWidth: 2,
  locationColor: "#e53935",
  locationRadius: 8,
  locationStrokeColor: "#ffffff",
  locationStrokeWidth: 2,
  locationLabelColor: "#202124",
  locationLabelHaloColor: "#ffffff",
  locationLabelHaloWidth: 2,
  locationLabelSize: 12,
  locationLabelOffset: [0, 1.5] as [number, number],
  proposedCableColor:
    kmzLegend.find((rule) => rule.category === "DROP")?.color ?? "#9000FF",
  proposedCableLineWidth: 2,
  proposedCableDash: [3, 2] as number[],
};

export function searchRadiusFeature(
  longitude: number,
  latitude: number,
  radiusMeters: number
): Feature<Polygon, { kind: "radius" }> {
  const distance = radiusMeters / 6_371_008.8;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;
  const ring = Array.from({ length: 65 }, (_, index) => {
    const bearing = (index / 64) * Math.PI * 2;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distance) +
        Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1),
        Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI] as [number, number];
  });
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [ring] },
    properties: { kind: "radius" },
  };
}
