import type { Feature, Geometry } from "geojson";
import {
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef, useState } from "react";
import { api, type NetworkAsset } from "../../lib/api";
import { kmzLegend } from "../map/kmzLegend";
import {
  addAtlasMapIcons,
  assetFeatures,
  cableLengthMeters,
  loadNetworkMapIcons,
} from "../map/networkMap";
import type { NetworkCapacity } from "./NetworkCapacityDetail";
import { CablePlanDetails } from "./CablePlanDetails";
import {
  type TerminationResults,
  uniqueTerminationCables,
} from "./TerminationDetail";
import { cableName, describeCableSpans, candidateName, connectionName, describeNodeCableRows, describeSourceCable, type TerminationPlan } from "./terminationPlan";

function terminationDetails(kind: string): [string, unknown][] {
  const category = kind === "Closure" ? "JC" : kind === "Slack / Coil" ? "SLACK" : kind;
  const choices = kmzLegend.filter((item) => item.category === category && item.termination === "Terminasi");
  if (!choices.length) return [];
  return [
    ["Pilihan sesuai legenda KMZ", choices.map((item) => category === "ODP" ? item.folder : `${item.name} (${item.folder})`).join(" · ")],
    ["Spesifikasi", choices.length === 1 ? choices[0].folder : "Kapasitas belum ditentukan · perlu verifikasi"],
  ];
}

function cableDisplayDetails(name: string) {
  const parts = name
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean);
  const category = parts[0]?.toUpperCase() ?? "";
  const type = category.includes("SUB-DISTRIBUSI")
    ? "Sub-distribusi"
    : category.includes("DISTRIBUSI")
      ? "Distribusi"
      : category.includes("FEEDER")
        ? "Feeder"
        : category.includes("BACKBONE")
          ? "Backbone"
          : "Kabel jaringan";
  const variant = parts[1] ?? "";
  const coreMatch =
    variant.match(/(?:_|-)(\d+)C\b/i) ?? name.match(/\b(\d+)\s*core\b/i);
  return {
    type,
    capacity: coreMatch ? `${coreMatch[1]} Core` : "Belum diketahui",
    code: parts[2] ?? parts[1] ?? name,
  };
}
export type NetworkSearchResult = {
  terminations?: TerminationResults;
  terminationPlan?: TerminationPlan;
  proposal?: {
    kind: string;
    cores: number | null;
    latitude: number;
    longitude: number;
  };
  latitude: number;
  longitude: number;
  searchRadiusMeters?: number;
  expansionAvailable?: boolean;
  network: {
    capacity?: NetworkCapacity;
    id?: string;
    name: string;
    area?: string;
    cableType?: string;
    searchRadiusMeters?: number;
    straightDistanceMeters?: number;
    nearestPoint?: {
      coordinates: [number, number];
    };
    geometry?: Geometry;
  } | null;
  routeGeometry?: Geometry;
  distanceMeters: number | null;
};
function offsetCoordinate(
  [longitude, latitude]: [number, number],
  meters: number,
  bearing: number
): [number, number] {
  const distance = meters / 6_371_008.8;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;
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
  return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI];
}
export function NetworkLocationsMap({
  points,
  onSelect,
}: {
  points: {
    row: number;
    latitude: number;
    longitude: number;
  }[];
  onSelect: (row: number) => void;
}) {
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!(element.current && points.length)) {
      return;
    }
    setWorkerUrl(workerUrl);
    const map = new MapLibreMap({
      container: element.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [118, -2.5],
      zoom: 4,
    });
    map.addControl(new NavigationControl(), "top-right");
    map.on("load", () => {
      map.addSource("locations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: points.map((point) => ({
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [point.longitude, point.latitude],
            },
            properties: { row: point.row },
          })),
        },
      });
      map.addLayer({
        id: "locations",
        type: "circle",
        source: "locations",
        paint: {
          "circle-radius": 7,
          "circle-color": "#3454d1",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
      map.on("mouseenter", "locations", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "locations", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", "locations", (event) => {
        const row = Number(event.features?.[0]?.properties?.row);
        if (Number.isInteger(row)) {
          onSelect(row);
        }
      });
      const bounds = points.reduce(
        (extent, point) => extent.extend([point.longitude, point.latitude]),
        new LngLatBounds()
      );
      map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 });
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(element.current);
    return () => {
      observer.disconnect();
      map.remove();
    };
  }, [points, onSelect]);
  return (
    <section
      aria-label="Peta seluruh lokasi analisis massal"
      ref={element}
      style={{ height: 360, borderRadius: 8 }}
    />
  );
}
export function NearestNetworkMap({
  result,
  streetViewUrl,
}: {
  result: NetworkSearchResult;
  streetViewUrl?: string;
}) {
  const [assetError, setAssetError] = useState("");
  const [assetCount, setAssetCount] = useState(0);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [streetViewLocation, setStreetViewLocation] = useState<
    [number, number] | null
  >(null);
  const streetViewMarker = useRef<Marker | null>(null);
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!element.current) {
      return;
    }
    setAssetError("");
    let request: AbortController | undefined;
    let requestVersion = 0;
    let viewportTimer: ReturnType<typeof setTimeout> | undefined;
    let loadedBounds: number[] | undefined;
    let requestedBounds: number[] | undefined;
    let stopIcons: (() => void) | undefined;
    let streetViewDropTarget: HTMLElement | undefined;
    let onStreetViewDragOver: ((event: DragEvent) => void) | undefined;
    let onStreetViewDrop: ((event: DragEvent) => void) | undefined;
    let active = true;
    const assetsById = new Map<string, NetworkAsset>();
    setWorkerUrl(workerUrl);
    const center: [number, number] = [result.longitude, result.latitude];
    const radius =
      result.network?.searchRadiusMeters ?? result.searchRadiusMeters ?? 1000;
    const ring = Array.from({ length: 65 }, (_, i) =>
      offsetCoordinate(center, radius, (i / 64) * Math.PI * 2)
    );
    const features: Feature[] = [
      {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { kind: "radius" },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: center },
        properties: { kind: "location", label: "Titik lokasi" },
      },
    ];
    for (const evidence of result.terminationPlan?.routeEvidence ?? []) {
      if (evidence.id !== result.terminationPlan?.targetId) {
        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [evidence.longitude, evidence.latitude],
          },
          properties: {
            kind: "route-evidence",
            id: evidence.id,
            label: evidence.name,
            deviceType: evidence.type,
            distance: evidence.distanceToRouteMeters,
            recordedCables: evidence.recordedCables,
          },
        });
      }
    }
    for (const [index, point] of (
      (result.terminationPlan?.deviceCandidates ?? []).filter((point) => point.kind !== "Tiang")
    ).entries()) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [point.longitude, point.latitude],
        },
        properties: {
          kind: "device-candidate",
          label: candidateName(point, index),
          basis: point.basis ?? "EVIDENCE",
          deviceType: point.kind,
          reason: point.reason,
          evidenceDistance: point.distanceToEvidenceMeters ?? 0,
        },
      });
    }
    for (const [index, point] of (
      result.terminationPlan?.connectionCandidates ?? []
    ).entries()) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [point.longitude, point.latitude],
        },
        properties: {
          kind: "connection-candidate",
          label: connectionName(index),
          recommendedKind: point.recommendedKind ?? "",
          cableName: point.cableName,
          distance: point.distanceMeters,
        },
      });
    }
    for (const [index, point] of (
      result.terminationPlan?.points ?? []
    ).entries()) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [point.longitude, point.latitude],
        },
        properties: {
          kind: "plan",
          label: `Kandidat closure ${index + 1}`,
          deviceType: "Closure",
        },
      });
    }
    for (const [index, cable] of (result.terminationPlan?.cables ?? []).entries()) {
      const spans = result.terminationPlan ? describeCableSpans(result.terminationPlan, result.network?.name) : [];
      const parts = spans.length ? spans : [{ geometry: cable.geometry, distanceMeters: cable.distanceMeters, from: "Belum ditentukan", to: "Belum ditentukan", name: cableName(index), requiredCores: null }];
      for (const part of parts) features.push({
        type: "Feature",
        geometry: part.geometry,
        properties: {
          kind: "plan-route",
          label: `${part.name} · ${cable.type}`,
          from: part.from,
          to: part.to,
          distance: part.distanceMeters,
          cableType: cable.type,
          cores: cable.cores ?? "Belum ditentukan",
          requiredCores: part.requiredCores,
        },
      });
    }
    if (result.proposal) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [result.proposal.longitude, result.proposal.latitude],
        },
        properties: {
          kind: "proposal",
          label: `Usulan ${result.proposal.kind} pelanggan`,
          deviceType: result.proposal.kind,
        },
      });
    }
    if (result.network?.geometry) {
      features.push({
        type: "Feature",
        geometry: result.network.geometry,
        properties: { kind: "network", label: result.network.name },
      });
    }
    if (result.network?.nearestPoint) {
      features.push({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: result.network.nearestPoint.coordinates,
        },
        properties: { kind: "target", label: result.network.name },
      });
    }
    if (result.routeGeometry && !result.terminationPlan) {
      features.push({
        type: "Feature",
        geometry: result.routeGeometry,
        properties: { kind: "route" },
      });
    }
    const map = new MapLibreMap({
      container: element.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center,
      zoom: 14,
    });
    map.addControl(new NavigationControl(), "top-right");
    if (streetViewUrl) {
      const controlGroup = map
        .getContainer()
        .querySelector<HTMLDivElement>(
          ".maplibregl-ctrl-top-right .maplibregl-ctrl-group"
        );
      if (controlGroup) {
        const button = document.createElement("button");
        button.setAttribute(
          "aria-label",
          "Seret Pegman ke titik peta untuk Street View"
        );
        button.title = "Seret Pegman ke titik peta untuk Street View";
        button.type = "button";
        button.draggable = true;
        button.style.cursor = "pointer";
        button.innerHTML =
          '<i class="bi bi-person-standing" aria-hidden="true" style="color:#f4b400;font-size:20px"></i>';
        button.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData(
            "application/x-atlas-street-view",
            "street-view"
          );
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "copy";
          }
        });
        controlGroup.append(button);
        streetViewDropTarget = map.getCanvasContainer();
        onStreetViewDragOver = (event) => {
          if (
            !event.dataTransfer?.types.includes(
              "application/x-atlas-street-view"
            )
          ) {
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        };
        onStreetViewDrop = (event) => {
          if (
            event.dataTransfer?.getData("application/x-atlas-street-view") !==
            "street-view"
          ) {
            return;
          }
          event.preventDefault();
          const bounds = map.getCanvas().getBoundingClientRect();
          const point = map.unproject([
            event.clientX - bounds.left,
            event.clientY - bounds.top,
          ]);
          streetViewMarker.current?.remove();
          streetViewMarker.current = new Marker({ color: "#f4b400" })
            .setLngLat(point)
            .addTo(map);
          streetViewMarker.current.getElement().title =
            "Lokasi Street View yang dipilih";
          setStreetViewLocation([point.lat, point.lng]);
        };
        streetViewDropTarget.addEventListener("dragover", onStreetViewDragOver);
        streetViewDropTarget.addEventListener("drop", onStreetViewDrop);
      }
    }
    map.on("load", () => {
      map.addSource("search", {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });
      map.addLayer({
        id: "radius-fill",
        type: "fill",
        source: "search",
        filter: ["==", "kind", "radius"],
        paint: { "fill-color": "#3454d1", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "radius-line",
        type: "line",
        source: "search",
        filter: ["==", "kind", "radius"],
        paint: {
          "line-color": "#3454d1",
          "line-width": 2,
          "line-dasharray": [3, 2],
        },
      });
      map.addLayer({
        id: "cable-route",
        type: "line",
        source: "search",
        filter: ["in", "kind", "route", "plan-route"],
        paint: {
          "line-color": kmzLegend.find((rule) => rule.category === "DROP")!
            .color,
          "line-width": 2,
          "line-dasharray": [3, 2],
        },
      });
      map.addLayer({
        id: "locations",
        type: "circle",
        source: "search",
        filter: [
          "all",
          ["==", "$type", "Point"],
          ["!=", "kind", "route-evidence"],
        ],
        paint: {
          "circle-radius": 8,
          "circle-color": [
            "match",
            ["get", "kind"],
            "location",
            "#e53935",
            "proposal",
            "#e77a12",
            "plan",
            "#e77a12",
            "connection-candidate",
            "#e77a12",
            "device-candidate",
            "#e77a12",
            "#3454d1",
          ],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "labels",
        type: "symbol",
        source: "search",
        filter: [
          "all",
          ["==", "$type", "Point"],
          ["!=", "kind", "proposal"],
          ["!=", "kind", "plan"],
          ["!=", "kind", "connection-candidate"],
          ["!=", "kind", "device-candidate"],
          ["!=", "kind", "route-evidence"],
        ],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 12,
          "text-offset": [0, 1.5],
        },
        paint: { "text-halo-color": "#fff", "text-halo-width": 2 },
      });
      map.addLayer({
        id: "proposal-label",
        type: "symbol",
        source: "search",
        filter: [
          "in",
          "kind",
          "proposal",
          "plan",
          "connection-candidate",
          "device-candidate",
        ],
        layout: {
          "text-field": ["get", "label"],
          "text-size": 13,
          "text-offset": [0, -1.5],
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": "#a64b00",
          "text-halo-color": "#fff",
          "text-halo-width": 2,
        },
      });
      addAtlasMapIcons(map);
      map.addSource("nearby-assets", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer(
        {
          id: "asset-areas",
          type: "fill",
          source: "nearby-assets",
          filter: [
            "all",
            ["==", ["geometry-type"], "Polygon"],
            ["!=", ["get", "fillEnabled"], false],
          ],
          paint: {
            "fill-color": ["get", "fillColor"],
            "fill-opacity": ["min", ["get", "fillOpacity"], 0.15],
          },
        },
        "cable-route"
      );
      map.addLayer(
        {
          id: "asset-lines",
          type: "line",
          source: "nearby-assets",
          filter: [
            "any",
            ["==", ["geometry-type"], "LineString"],
            [
              "all",
              ["==", ["geometry-type"], "Polygon"],
              ["!=", ["get", "outlineEnabled"], false],
            ],
          ],
          paint: {
            "line-color": ["get", "lineColor"],
            "line-width": ["get", "lineWidth"],
            "line-opacity": ["get", "lineOpacity"],
          },
        },
        "cable-route"
      );
      map.addLayer({
        id: "asset-icons",
        type: "symbol",
        source: "nearby-assets",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "icon-image": [
            "coalesce",
            ["image", ["get", "iconImageId"]],
            ["image", ["get", "fallbackIconImageId"]],
            ["image", ["get", "atlasIconId"]],
          ],
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            12,
            ["*", ["get", "legendIconScale"], 0.35],
            14,
            ["*", ["get", "legendIconScale"], 0.5],
            16,
            ["*", ["get", "legendIconScale"], 0.75],
            18,
            ["get", "legendIconScale"],
          ],
          "icon-anchor": ["get", "iconAnchor"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["get", "iconOpacity"] },
      });
      map.addLayer({
        id: "asset-labels",
        minzoom: 17,
        type: "symbol",
        source: "nearby-assets",
        filter: [
          "all",
          ["==", ["geometry-type"], "Point"],
          [">", ["get", "legendLabelSize"], 0],
        ],
        layout: {
          "text-field": ["get", "sourceLabel"],
          "text-size": ["*", ["get", "legendLabelSize"], 10],
          "text-offset": [0, 1.5],
          "text-padding": 8,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": ["get", "labelColor"],
          "text-opacity": ["get", "labelOpacity"],
          "text-halo-color": [
            "match",
            ["get", "labelColor"],
            "#ffffff",
            "#263238",
            "#ffffff",
          ],
          "text-halo-width": 1.5,
        },
      });
      map.addLayer({
        id: "asset-line-hit",
        type: "line",
        source: "nearby-assets",
        filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-width": 18, "line-opacity": 0 },
      });
      map.addLayer({
        id: "asset-point-hit",
        type: "circle",
        source: "nearby-assets",
        filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 16, "circle-opacity": 0 },
      });
      map.addSource("terminations", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: (result.terminations?.points ?? [])
            .filter(
              (point) =>
                Number.isFinite(point.longitude) &&
                Number.isFinite(point.latitude)
            )
            .map((point) => ({
              type: "Feature",
              geometry: {
                type: "Point",
                coordinates: [point.longitude, point.latitude],
              },
              properties: {
                id: point.id,
                label: point.name,
                deviceType: point.type,
                distance: point.distance,
              },
            })),
        },
      });
      map.addLayer(
        {
          id: "termination-markers",
          type: "circle",
          source: "terminations",
          paint: {
            "circle-radius": 15,
            "circle-color": "#e77a12",
            "circle-opacity": 0,
            "circle-stroke-color": "#e77a12",
            "circle-stroke-width": 3,
          },
        },
        "asset-icons"
      );
      map.addLayer(
        {
          id: "route-evidence-markers",
          type: "circle",
          source: "search",
          filter: ["==", "kind", "route-evidence"],
          paint: {
            "circle-radius": 19,
            "circle-opacity": 0,
            "circle-stroke-color": "#00a6b2",
            "circle-stroke-width": 3,
          },
        },
        "asset-icons"
      );
      const containsBounds = (outer: number[] | undefined, inner: number[]) =>
        Boolean(
          outer &&
            inner[0] >= outer[0] &&
            inner[1] >= outer[1] &&
            inner[2] <= outer[2] &&
            inner[3] <= outer[3]
        );
      const loadViewport = async () => {
        const bounds = map.getBounds();
        const bbox = [
          Math.max(-180, bounds.getWest()),
          Math.max(-90, bounds.getSouth()),
          Math.min(180, bounds.getEast()),
          Math.min(90, bounds.getNorth()),
        ];
        if (containsBounds(requestedBounds, bbox)) {
          return;
        }
        if (containsBounds(loadedBounds, bbox)) {
          request?.abort();
          request = undefined;
          requestVersion += 1;
          requestedBounds = undefined;
          stopIcons?.();
          stopIcons = undefined;
          setAssetError("");
          setAssetsLoading(false);
          return;
        }
        const version = ++requestVersion;
        request?.abort();
        stopIcons?.();
        stopIcons = undefined;
        requestedBounds = bbox;
        request = new AbortController();
        const source = map.getSource(
          "nearby-assets"
        ) as import("maplibre-gl").GeoJSONSource;
        setAssetsLoading(true);
        try {
          const assets = await api<NetworkAsset[]>(
            "/assets/map?bbox=" + bbox.join(",") + "&zoom=24",
            { signal: request.signal, timeout: 30_000 }
          );
          if (!active || version !== requestVersion) {
            return;
          }
          const unique = new Map<string, NetworkAsset>();
          for (const asset of assets) {
            unique.set(
              JSON.stringify([
                asset.source,
                asset.name,
                asset.geometry,
                asset.attributes,
              ]),
              asset
            );
          }
          const visible = [...unique.values()];
          const visibleFeatures = assetFeatures(visible);
          await new Promise<void>((resolve) => {
            stopIcons = loadNetworkMapIcons(map, visibleFeatures, resolve);
          });
          if (!active || version !== requestVersion) {
            return;
          }
          assetsById.clear();
          for (const asset of visible) {
            assetsById.set(asset.id, asset);
          }
          source.setData({
            type: "FeatureCollection",
            features: visibleFeatures,
          });
          loadedBounds = bbox;
          requestedBounds = undefined;
          setAssetCount(visible.length);
          setAssetError("");
        } catch {
          if (active && version === requestVersion) {
            requestedBounds = undefined;
            setAssetError(
              "Aset pada area peta gagal dimuat. Geser atau zoom peta untuk mencoba lagi."
            );
          }
        } finally {
          if (active && version === requestVersion) {
            setAssetsLoading(false);
          }
        }
      };
      map.on("moveend", () => {
        clearTimeout(viewportTimer);
        viewportTimer = setTimeout(() => void loadViewport(), 350);
      });
      const popup = new Popup({
        maxWidth: "460px",
        closeButton: true,
        className: "analysis-asset-popup",
      });
      const hitLayers = [
        "route-evidence-markers",
        "termination-markers",
        "asset-point-hit",
        "asset-line-hit",
        "asset-areas",
        "cable-route",
        "locations",
      ];
      map.on("mousemove", (event) => {
        map.getCanvas().style.cursor = map.queryRenderedFeatures(event.point, {
          layers: hitLayers,
        }).length
          ? "pointer"
          : "";
      });
      map.on("click", (event) => {
        const hits = map.queryRenderedFeatures(event.point, {
          layers: hitLayers,
        });
        const feature =
          hits.find(
            (f) =>
              f.layer.id === "locations" &&
              (f.properties?.kind === "proposal" ||
                f.properties?.kind === "plan" ||
                f.properties?.kind === "connection-candidate" ||
                f.properties?.kind === "device-candidate")
          ) ??
          hits.find((f) => f.layer.id === "route-evidence-markers") ??
          hits.find((f) => f.layer.id === "termination-markers") ??
          hits.find((f) => f.layer.id === "asset-point-hit") ??
          hits.find((f) => f.layer.id === "asset-line-hit") ??
          hits.find((f) => f.layer.id === "cable-route") ??
          hits[0];
        if (!feature) {
          return;
        }
        const asset =
          (["termination-markers", "route-evidence-markers"].includes(
            feature.layer.id
          )
            ? undefined
            : assetsById.get(String(feature.properties?.id ?? ""))) ??
          (feature.properties?.kind === "target" && result.network?.id
            ? assetsById.get(result.network.id)
            : undefined);
        const content = document.createElement("div");
        content.className = "analysis-asset-popup-body";
        const title = document.createElement("strong");
        title.textContent = asset
          ? String(asset.attributes?.name ?? asset.name)
          : feature.layer.id === "cable-route"
            ? String(
                feature.properties?.label ??
                  "Usulan jalur kabel mengikuti jalan mobil"
              )
            : String(feature.properties?.label ?? "Detail lokasi");
        content.append(title);
        const formatLength = (meters: number) =>
          meters >= 1000
            ? (meters / 1000).toLocaleString("id-ID", {
                maximumFractionDigits: 2,
              }) +
              " km (" +
              meters.toLocaleString("id-ID", { maximumFractionDigits: 1 }) +
              " m)"
            : meters.toLocaleString("id-ID", { maximumFractionDigits: 1 }) +
              " m";
        const cableGeometry =
          asset?.geometry ??
          (feature.properties?.kind === "target"
            ? (result.network?.geometry ?? null)
            : null);
        const cableLength = cableLengthMeters(cableGeometry);
        const lengths: [string, string][] = [];
        if (cableLength !== null) {
          lengths.push([
            "Panjang total kabel eksisting",
            formatLength(cableLength),
          ]);
        }
        if (
          (feature.layer.id === "cable-route" &&
            feature.properties?.kind !== "plan-route") ||
          feature.properties?.kind === "target" ||
          (asset?.id && asset.id === result.network?.id)
        ) {
          lengths.push([
            "Estimasi kabel baru melalui jalan mobil",
            result.distanceMeters === null
              ? "Rute belum tersedia"
              : formatLength(result.distanceMeters),
          ]);
        }
        if (lengths.length) {
          const summary = document.createElement("section");
          summary.className = "analysis-cable-length";
          summary.setAttribute("aria-label", "Panjang kabel");
          for (const [label, value] of lengths) {
            const row = document.createElement("div");
            const heading = document.createElement("small");
            const length = document.createElement("strong");
            heading.textContent = label;
            length.textContent = value;
            row.append(heading, length);
            summary.append(row);
          }
          const note = document.createElement("small");
          note.textContent =
            "Kabel eksisting dihitung dari geometri KMZ. Estimasi kabel baru mengikuti rute jalan dan belum termasuk cadangan/slack.";
          summary.append(note);
          content.append(summary);
        }
        const table = document.createElement("table");
        table.className = "map-asset-popup-table";
        const body = document.createElement("tbody");
        const attrs = asset?.attributes ?? {};
        const saved = attrs.__kmlDetailFields;
        const rows: [string, unknown][] = asset
          ? Array.isArray(saved)
            ? saved.filter(
                (row): row is [string, unknown] =>
                  Array.isArray(row) &&
                  row.length === 2 &&
                  typeof row[0] === "string"
              )
            : Object.entries(attrs).filter(
                ([key]) => !key.startsWith("__") && key !== "name"
              )
          : feature.layer.id === "route-evidence-markers"
            ? [
                ["Jenis aset terdata", feature.properties?.deviceType],
                [
                  "Jarak dari jalur",
                  `${Math.round(Number(feature.properties?.distance))} m`,
                ],
                [
                  "Kabel dengan relasi tercatat",
                  feature.properties?.recordedCables,
                ],
                [
                  "Kebutuhan sambungan",
                  "Belum diketahui · periksa saat survei",
                ],
                [
                  "Catatan",
                  "Dekat jalur tidak memastikan aset tersambung atau memiliki kapasitas yang dapat dipakai.",
                ],
              ]
            : feature.layer.id === "termination-markers"
              ? [
                  ["Jenis terminasi", feature.properties?.deviceType],
                  [
                    "Jarak dari lokasi",
                    `${Math.round(Number(feature.properties?.distance))} m`,
                  ],
                  [
                    "Koordinat",
                    `${event.lngLat.lat.toFixed(6)}, ${event.lngLat.lng.toFixed(6)}`,
                  ],
                ]
              : feature.properties?.kind === "proposal"
                ? [
                    ["Nama", feature.properties.label],
                    ["Jenis terminasi", feature.properties.deviceType],
                    ...(result.terminationPlan ? describeNodeCableRows(result.terminationPlan, String(feature.properties.label), result.network?.name) : []),
                    ...terminationDetails(String(feature.properties.deviceType)),
                    ["Status", "Usulan awal · perlu survei"],
                    ["Lokasi", "Titik pelanggan"],
                    [
                      "Dasar",
                      "Terminasi terdekat bukan ODP; ODP diusulkan sebagai titik distribusi ke lokasi pelanggan.",
                    ],
                    [
                      "Catatan",
                      "Belum menjadi aset aktif. Kebutuhan terminasi perlu diverifikasi.",
                    ],
                  ]
                : feature.properties?.kind === "device-candidate"
                  ? [
                      ["Nama", feature.properties.label],
                      ["Jenis usulan", feature.properties.deviceType],
                      ...(result.terminationPlan && feature.properties.basis === "PLANNING" && feature.properties.deviceType === "ODP" ? describeNodeCableRows(result.terminationPlan, String(feature.properties.label), result.network?.name) : []),
                      ...terminationDetails(String(feature.properties.deviceType)),
                      ["Dasar", feature.properties.reason],
                      [
                        "Posisi pada jalur",
                        feature.properties.basis === "PLANNING"
                          ? "Posisi awal pada jalur, dapat berubah setelah peninjauan"
                          : `Titik terdekat di garis usulan; ${Math.round(Number(feature.properties.evidenceDistance))} m dari aset acuan`,
                      ],
                      [
                        "Status",
                        feature.properties.basis === "PLANNING"
                          ? "Usulan awal · perlu survei"
                          : "Opsi berdasarkan aset terdata; kebutuhan dan sambungan belum dipastikan.",
                      ],
                    ]
                  : feature.properties?.kind === "connection-candidate"
                    ? [
                        ["Nama", feature.properties.label],
                        ["Kabel terdekat", feature.properties.cableName],
                        ...terminationDetails("Closure"),
                        [
                          "Jarak ujung kabel ke jalur",
                          `${Math.round(Number(feature.properties.distance))} m`,
                        ],
                        [
                          "Rekomendasi",
                          feature.properties.recommendedKind
                            ? "Closure jika kabel disambungkan"
                            : "Jenis belum ditentukan",
                        ],
                        [
                          "Dasar",
                          "Ujung kabel eksisting berada dekat jalur. Closure merupakan opsi untuk melindungi sambungan serat jika kabel ini dipakai; kedekatan saja tidak berarti kabel harus disambungkan.",
                        ],
                      ]
                    : feature.properties?.kind === "plan"
                      ? [
                          ["Jenis", "Kandidat closure"],
                          [
                            "Status",
                            "Usulan berdasarkan jarak jalur · perlu survei",
                          ],
                          [
                            "Koordinat",
                            `${event.lngLat.lat.toFixed(6)}, ${event.lngLat.lng.toFixed(6)}`,
                          ],
                          [
                            "Catatan",
                            "Jarak saja tidak memastikan closure dibutuhkan; periksa sambungan dan kondisi lapangan.",
                          ],
                        ]
                      : feature.properties?.kind === "plan-route"
                        ? [
                            ["Nama", feature.properties.label],
                            ["Dari", feature.properties.from],
                            ["Ke", feature.properties.to],
                            ["Jenis kabel", feature.properties.cableType],
                            ["Panjang estimasi", `${Math.round(Number(feature.properties.distance))} m`],
                            ["Kapasitas kabel", feature.properties.cores === "Belum ditentukan" ? "Belum ditentukan" : `${feature.properties.cores} core`],
                            ["Core rencana", feature.properties.requiredCores == null ? "Belum dapat ditentukan" : `${feature.properties.requiredCores} core`],
                            ["Kabel sumber", result.terminationPlan ? describeSourceCable(result.terminationPlan) : "Belum dapat ditentukan"],
                            ["Status", "Ruas simulasi dari satu kabel; sambungan dan kebutuhan core perlu survei, belum dibooking"],
                          ]
                        : feature.layer.id === "cable-route"
                          ? [
                              [
                                "Estimasi panjang kabel",
                                result.distanceMeters == null
                                  ? "Belum tersedia"
                                  : Math.round(result.distanceMeters) + " m",
                              ],
                              ["Acuan jalur", "Jalan yang dapat dilalui mobil"],
                              [
                                "Tampilan",
                                "Legenda drop: garis ungu putus-putus (usulan)",
                              ],
                            ]
                          : [
                              ["Latitude", event.lngLat.lat],
                              ["Longitude", event.lngLat.lng],
                            ];
        const appendTableRow = (
          label: string,
          value: unknown,
          valueClass = ""
        ) => {
          const tr = document.createElement("tr");
          const th = document.createElement("th");
          const td = document.createElement("td");
          th.scope = "row";
          th.textContent = label;
          td.className = `text-break ${valueClass}`.trim();
          td.textContent = String(value ?? "");
          tr.append(th, td);
          body.append(tr);
        };
        for (const [label, value] of rows) {
          appendTableRow(label, value);
        }
        if (feature.layer.id === "termination-markers") {
          const point = result.terminations?.points.find(
            (item) => item.id === String(feature.properties?.id ?? "")
          );
          if (point) {
            const upstream = result.terminationPlan?.upstreamRecommendation;
            if (upstream?.id === point.id) {
              appendTableRow(
                "Rekomendasi",
                upstream.type === "ODP"
                  ? "Gunakan ODP terdekat sebagai tujuan kabel drop"
                  : upstream.type === "ODC"
                    ? "Gunakan ODC terdekat sebagai sumber ke ODP usulan"
                    : upstream.type === "Closure"
                      ? "Gunakan closure terdekat sebagai opsi titik sambungan ke ODP usulan"
                      : upstream.type === "Slack / Coil"
                        ? "Slack/coil adalah cadangan kabel; lokasi sambungan belum dapat ditentukan dari titik ini"
                        : `Gunakan ${upstream.type} terdekat sebagai titik acuan jaringan; perangkat perantara belum ditentukan`
              );
              appendTableRow(
                "Dasar",
                `${upstream.recordedCables} kabel dengan relasi tercatat; data yang belum diverifikasi tetap dapat digunakan dalam rencana.`
              );
            }
            appendTableRow(
              "Perangkat melalui kabel tercatat",
              point.relatedDevices
                ?.map((device) => `${device.name} (${device.kind})`)
                .join(", ") || "Belum ada relasi tercatat"
            );
            if (point.cables.length === 0) {
              appendTableRow(
                "Kabel",
                "Belum ada kabel tercatat atau kandidat dalam 20 m."
              );
            }
            for (const cable of uniqueTerminationCables(point.cables)) {
              appendTableRow("Kabel", cable.name);
              appendTableRow(
                "Hubungan",
                cable.recorded
                  ? "Relasi tercatat"
                  : `Kabel dekat pada peta · perlu verifikasi · ${Math.round(cable.distanceMeters)} m`
              );
              appendTableRow(
                "Total core",
                cable.totalCores || "Belum diketahui"
              );
              appendTableRow(
                "Core terpakai",
                `${cable.used} (nomor: ${cable.usedNumbers?.join(", ") || (cable.usedNumbers ? "—" : "jalankan analisis ulang")})`
              );
              appendTableRow(
                "Core booked",
                `${cable.booked} (nomor: ${cable.bookedNumbers?.join(", ") || (cable.bookedNumbers ? "—" : "jalankan analisis ulang")})`
              );
              appendTableRow(
                "Core tersedia",
                cable.verified && cable.totalCores > 0 && cable.available
                  ? `${cable.available.length} (nomor: ${cable.available.join(", ") || "—"})`
                  : "Belum terverifikasi atau kapasitas belum diketahui"
              );
              appendTableRow(
                "Titik terdekat dari awal kabel",
                cable.start
                  ? `${cable.start.name} (${Math.round(cable.start.distanceMeters)} m)`
                  : "Belum diketahui"
              );
              appendTableRow(
                "Titik terdekat dari ujung kabel",
                cable.end
                  ? `${cable.end.name} (${Math.round(cable.end.distanceMeters)} m)`
                  : "Belum diketahui"
              );
            }
            if (point.cables.length > 0) {
              appendTableRow(
                "Catatan",
                "Perkiraan ujung berdasarkan posisi peta, bukan arah layanan. Sambungan fisik perlu diverifikasi."
              );
            }
          }
        }
        if (
          feature.layer.id === "cable-route" &&
          feature.properties?.kind !== "plan-route" &&
          result.network?.name
        ) {
          const display = cableDisplayDetails(result.network.name);
          const capacity = result.network.capacity;
          const recommendationHeading = document.createElement("tr");
          const recommendationCell = document.createElement("th");
          recommendationCell.colSpan = 2;
          recommendationCell.textContent = "Rekomendasi kabel";
          recommendationHeading.append(recommendationCell);
          body.append(recommendationHeading);
          appendTableRow("Jenis kabel", display.type);
          appendTableRow("Kapasitas", display.capacity);
          appendTableRow("Kode aset", display.code);
          if (
            !capacity ||
            capacity.totalCores === null ||
            !capacity.usageVerified
          ) {
            appendTableRow("Ketersediaan", "Belum diketahui", "text-secondary");
            appendTableRow(
              "Status",
              capacity?.totalCores === null || !capacity
                ? "Perlu verifikasi kapasitas"
                : "Belum terverifikasi",
              "text-warning"
            );
          } else {
            const available = `${capacity.availableCores.toLocaleString("id-ID")} dari ${capacity.totalCores.toLocaleString("id-ID")} core tercatat tersedia`;
            const status =
              capacity.availableCores > 0
                ? capacity.usageVerified
                  ? "Tersedia"
                  : "Perlu verifikasi"
                : capacity.usageVerified
                  ? "Penuh"
                  : "Ketersediaan perlu diverifikasi";
            const statusClass =
              capacity.availableCores === 0 && capacity.usageVerified
                ? "text-danger"
                : capacity.availableCores > 0 && capacity.usageVerified
                  ? "text-success"
                  : "text-warning";
            appendTableRow("Ketersediaan", available, statusClass);
            appendTableRow("Status", status, statusClass);
          }
        }
        table.append(body);
        content.append(table);
        popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
      });
      const bounds = ring.reduce(
        (b, point) => b.extend(point),
        new LngLatBounds()
      );
      for (const point of result.terminations?.points ?? []) {
        if (
          Number.isFinite(point.longitude) &&
          Number.isFinite(point.latitude)
        ) {
          bounds.extend([point.longitude, point.latitude]);
        }
      }
      if (result.routeGeometry?.type === "LineString") {
        for (const p of result.routeGeometry.coordinates) {
          bounds.extend([p[0], p[1]]);
        }
      }
      map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 });
      clearTimeout(viewportTimer);
      void loadViewport();
    });
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(element.current);
    return () => {
      active = false;
      clearTimeout(viewportTimer);
      request?.abort();
      stopIcons?.();
      streetViewMarker.current?.remove();
      streetViewMarker.current = null;
      if (streetViewDropTarget && onStreetViewDragOver) {
        streetViewDropTarget.removeEventListener(
          "dragover",
          onStreetViewDragOver
        );
      }
      if (streetViewDropTarget && onStreetViewDrop) {
        streetViewDropTarget.removeEventListener("drop", onStreetViewDrop);
      }
      observer.disconnect();
      map.remove();
    };
  }, [result, streetViewUrl]);
  return (
    <>
      <small className="d-block text-secondary mb-2" role="status">
        {assetsLoading
          ? "Memuat aset pada area peta…"
          : assetCount.toLocaleString("id-ID") + " aset pada area peta"}{" "}
        · Perbesar peta untuk menampilkan label. Aset duplikat identik
        ditampilkan satu kali.
      </small>
      {assetError && <div className="alert alert-warning">{assetError}</div>}
      {result.terminationPlan?.routeEvidenceIncomplete && (
        <div className="alert alert-warning">
          Data aset di sepanjang jalur belum lengkap; periksa di Peta Jaringan
          dan saat survei.
        </div>
      )}
      {result.terminationPlan?.connectionCandidatesIncomplete && (
        <div className="alert alert-warning">
          Data ujung kabel atau terminasi di sepanjang jalur belum lengkap.
        </div>
      )}
      {result.terminationPlan && result.terminationPlan.cables.length > 0 && (
        <div className="alert alert-info">
          <strong className="d-block mb-2">Usulan sambungan kabel</strong>
          <CablePlanDetails plan={result.terminationPlan} networkName={result.network?.name} />
        </div>
      )}
      <section
        aria-label="Peta jaringan terdekat dan estimasi jalur kabel mengikuti jalan mobil"
        ref={element}
        style={{ height: 500, borderRadius: 8 }}
      />
      {streetViewLocation && (
        <section aria-label="Street View lokasi survei" className="card mt-3">
          <div className="card-header d-flex align-items-center justify-content-between gap-2">
            <strong>Street View</strong>
            <button
              aria-label="Tutup Street View"
              className="btn btn-sm btn-outline-secondary ms-auto"
              onClick={() => {
                streetViewMarker.current?.remove();
                streetViewMarker.current = null;
                setStreetViewLocation(null);
              }}
              type="button"
            >
              Tutup
            </button>
          </div>
          <iframe
            allowFullScreen
            className="w-100 border-0"
            height="420"
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            src={`https://maps.google.com/maps?${new URLSearchParams({
              layer: "c",
              cbll: streetViewLocation.join(","),
              cbp: "12,0,,0,0",
              source: "embed",
              output: "svembed",
            })}`}
            title="Street View pada titik peta yang dipilih"
          />
        </section>
      )}
      <small className="d-block text-secondary mt-2">
        {result.terminationPlan?.terminationPatterns && (
          <span className="d-block mb-1">
            Pola KMZ dalam radius 2 km (median jarak lurus ke terminasi sejenis terdekat, bukan standar pemasangan):{" "}
            {["OLT", "OTB", "ODC", "ODP", "Closure", "Slack / Coil"].map((type) => {
              const pattern = result.terminationPlan?.terminationPatterns?.find((p) => p.type === type);
              return pattern && pattern.sampleSize >= 5
                ? `${type}: ${Math.round(pattern.medianMeters)} m (${pattern.sampleSize} titik)`
                : `${type}: data belum cukup`;
            }).join(" · ")}
          </span>
        )}
        {result.terminationPlan && (
          result.terminationPlan.terminationPatterns === null
            ? "Pola terminasi KMZ belum dapat dihitung. "
            : result.terminationPlan.terminationPatterns && !result.terminationPlan.terminationPatterns.some((p) => p.type === "ODP" && p.sampleSize >= 5)
              ? "Data ODP KMZ di sekitar lokasi belum cukup untuk simulasi jarak. "
              : ""
        )}
        {result.terminationPlan?.deviceCandidates?.some(
          (point) => point.kind === "ODP" && point.basis === "PLANNING"
        ) && "Titik ODP adalah simulasi berdasarkan pola KMZ, bukan kebutuhan atau jumlah pemasangan yang sudah pasti. "}
        Lingkaran oranye menandai terminasi di sekitar lokasi. Penanda oranye
        dan garis ungu putus-putus adalah rencana. Lingkaran biru kehijauan
        menunjukkan aset terdata dalam 20 m dari jalur; kedekatan tidak
        memastikan sambungan. Jenis dan kebutuhan perangkat tambahan belum dapat
        dipastikan dari data ini; periksa saat survei. Klik untuk melihat
        detail. Klik ikon atau kabel untuk detail KMZ. Garis ungu putus-putus
        adalah usulan jalur penarikan; ikon dan kabel eksisting mengikuti style
        KMZ atau fallback legend.
      </small>
    </>
  );
}
