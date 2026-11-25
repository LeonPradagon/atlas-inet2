import type { Feature, FeatureCollection, LineString, MultiLineString } from "geojson";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  type GeoJSONSource,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { api, type NetworkAsset } from "../../lib/api";
import { registerSatelliteTiles } from "../map/satelliteTiles";

const indonesiaBounds = "94,-12,142,7";
const emptyCollection: FeatureCollection = { type: "FeatureCollection", features: [] };
const routeColors = {
  BACKBONE: "#f3f6ff",
  FEEDER: "#ff6b7a",
  DISTRIBUTION: "#48e18b",
  DROP: "#f5d34f",
  SUBMARINE: "#48d8f2",
  OTHER: "#b69cff",
} as const;

function routeType(asset: NetworkAsset) {
  const text = `${asset.name} ${asset.cableType} ${String(asset.attributes?.routeType ?? "")}`;
  if (/SUBMARINE|SUBSEA|UNDERSEA/iu.test(text)) return "SUBMARINE";
  if (/BACKBONE|\bBB[-_ ]/iu.test(text)) return "BACKBONE";
  if (/FEEDER|\bFDR\b/iu.test(text)) return "FEEDER";
  if (/DISTRIB|\b(?:DST|DTB)[-_]/iu.test(text)) return "DISTRIBUTION";
  if (/DROP/iu.test(text)) return "DROP";
  return "OTHER";
}

function cableColor(asset: NetworkAsset) {
  return routeColors[routeType(asset)];
}

export function DashboardNetworkMap({ company }: { company: string }) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [satelliteEnabled, setSatelliteEnabled] = useState(false);
  const assetsQuery = useQuery({
    queryKey: ["dashboard-map-assets", company],
    queryFn: () =>
      api<NetworkAsset[]>(
        `/assets/map?bbox=${indonesiaBounds}&zoom=5${company ? `&company=${encodeURIComponent(company)}` : ""}`
      ),
    staleTime: 30_000,
    retry: 0,
  });
  const features = useMemo<Feature<LineString | MultiLineString>[]>(
    () =>
      (assetsQuery.data ?? []).flatMap((asset) =>
        asset.assetType === "segment" &&
        asset.geometry &&
        (asset.geometry.type === "LineString" || asset.geometry.type === "MultiLineString")
          ? [{
              type: "Feature",
              geometry: asset.geometry,
              properties: {
                id: asset.id,
                name: asset.name,
                cableType: asset.cableType,
                lineColor: cableColor(asset),
              },
            }]
          : []
      ),
    [assetsQuery.data]
  );

  useEffect(() => {
    if (!container.current || map.current) return;
    setWorkerUrl(workerUrl);
    registerSatelliteTiles();
    const instance = new MapLibreMap({
      container: container.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [118, -2.5],
      zoom: 3,
    });
    map.current = instance;
    instance.addControl(new NavigationControl(), "top-right");
    instance.on("load", () => {
      instance.setProjection({ type: "globe" });
      instance.addSource("satellite-imagery", {
        type: "raster",
        tiles: ["atlas-satellite://{z}/{x}/{y}"],
        tileSize: 256,
        maxzoom: 23,
        attribution:
          "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      });
      const firstLabelLayer = instance
        .getStyle()
        .layers?.find((layer) => layer.type === "symbol")?.id;
      instance.addLayer({
        id: "satellite-imagery",
        type: "raster",
        source: "satellite-imagery",
        layout: { visibility: "none" },
      }, firstLabelLayer);
      instance.addSource("dashboard-network", {
        type: "geojson",
        data: emptyCollection,
      });
      instance.addLayer({
        id: "dashboard-network-glow",
        type: "line",
        source: "dashboard-network",
        paint: {
          "line-color": ["get", "lineColor"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 3, 8, 6],
          "line-opacity": 0.35,
          "line-blur": 2,
        },
      }, firstLabelLayer);
      instance.addLayer({
        id: "dashboard-network-lines",
        type: "line",
        source: "dashboard-network",
        filter: ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false],
        paint: {
          "line-color": ["get", "lineColor"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 2, 1, 8, 2.5],
          "line-opacity": 0.98,
        },
      }, firstLabelLayer);
      setMapReady(true);
    });
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(container.current);
    return () => {
      resizeObserver.disconnect();
      instance.remove();
      map.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const source = map.current?.getSource("dashboard-network") as GeoJSONSource | undefined;
    if (!mapReady || !source) return;
    const collection: FeatureCollection<LineString | MultiLineString> = {
      type: "FeatureCollection",
      features,
    };
    source.setData(collection);
    if (!features.length) return;
    const bounds = new LngLatBounds();
    const includeCoordinates = (coordinates: unknown) => {
      if (!Array.isArray(coordinates)) return;
      if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
        bounds.extend([coordinates[0], coordinates[1]]);
        return;
      }
      coordinates.forEach(includeCoordinates);
    };
    features.forEach((feature) => includeCoordinates(feature.geometry.coordinates));
    if (!bounds.isEmpty()) map.current?.fitBounds(bounds, { padding: 52, maxZoom: 9, duration: 500 });
  }, [features, mapReady]);

  return (
    <div className="dashboard-network-map-wrap">
      <div aria-label="Peta jaringan fiber optik" className="dashboard-network-map" ref={container} />
      <button
        aria-pressed={satelliteEnabled}
        className="btn btn-light atlas-choice dashboard-map-style-toggle"
        disabled={!mapReady}
        onClick={() => {
          const next = !satelliteEnabled;
          map.current?.setLayoutProperty(
            "satellite-imagery",
            "visibility",
            next ? "visible" : "none"
          );
          setSatelliteEnabled(next);
        }}
        type="button"
      >
        <i aria-hidden="true" className="bi bi-layers me-1" />
        Satelit
      </button>
      {assetsQuery.isPending && <div className="dashboard-map-message"><span className="spinner-border spinner-border-sm" /> Memuat jalur jaringan...</div>}
      {assetsQuery.isError && <div className="dashboard-map-message">Peta jaringan tidak dapat dimuat.</div>}
      {!assetsQuery.isPending && !assetsQuery.isError && !features.length && (
        <div className="dashboard-map-message">Belum ada geometri jalur untuk perusahaan ini.</div>
      )}
    </div>
  );
}
