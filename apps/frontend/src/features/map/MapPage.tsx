import { useEffect, useMemo, useRef, useState } from "react";
import ExcelJS from "exceljs";
import { LngLatBounds, Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl, type FilterSpecification, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon } from "geojson";
import { SegmentRelations } from "./SegmentRelations";
import { PageHeader } from "../../components/PageHeader";
import { api, networkQueryKeys, type Booking, type NetworkAsset } from "../../lib/api";

type Coordinate = [number, number];
type RouteLine = Feature<LineString, { id: string; name: string; status: "preview" | "saved" }>;
type SelectMode = "idle" | "start" | "waypoint" | "end";
type ImportedStyle = {
  lineColor?: string;
  lineOpacity?: number;
  lineWidth?: number;
  fillColor?: string;
  fillOpacity?: number;
  fillEnabled?: boolean;
  outlineEnabled?: boolean;
  iconColor?: string;
  iconOpacity?: number;
  iconScale?: number;
  iconHref?: string;
  iconAnchor?: "center" | "bottom" | "bottom-right";
  iconOffset?: [number, number];
};

function getIconCategory(folderPath: unknown, assetName: unknown) {
  const folders = String(folderPath ?? "")
    .split("/")
    .filter(Boolean)
    .reverse();
  const name = String(assetName ?? "");
  const categories: [string, RegExp][] = [
    ["OLT", /(^|[^A-Z0-9])OLT(?=$|[^A-Z0-9]|\d)/i],
    ["ODP", /(^|[^A-Z0-9])ODP(?=$|[^A-Z0-9]|\d)/i],
    ["ODC", /(^|[^A-Z0-9])ODC(?=$|[^A-Z0-9]|\d)/i],
    ["FDT", /(^|[^A-Z0-9])FDT(?=$|[^A-Z0-9]|\d)/i],
    ["POLE", /(^|[^A-Z0-9])(?:POLE|PL)(?=$|[^A-Z0-9]|\d)/i],
    ["JC", /(^|[^A-Z0-9])(?:JC|JOINT\s*CLOSURE)(?=$|[^A-Z0-9]|\d)/i],
    ["OFP", /(^|[^A-Z0-9])OFP(?=$|[^A-Z0-9]|\d)/i],
    ["POP", /(^|[^A-Z0-9])POP(?=$|[^A-Z0-9]|\d)/i],
    ["ODF", /(^|[^A-Z0-9])ODF(?=$|[^A-Z0-9]|\d)/i],
    ["SLACK", /(^|[^A-Z0-9])SLACK(?=$|[^A-Z0-9]|\d)/i],
    ["HANDHOLE", /(^|[^A-Z0-9])(?:HH|HANDHOLE)(?=$|[^A-Z0-9]|\d)/i],
    ["TERMINAL BOX", /(^|[^A-Z0-9])(?:TB|TERMINAL\s*BOX)(?=$|[^A-Z0-9]|\d)/i],
  ];
  for (const folder of folders) {
    const category = categories.find(([, pattern]) => pattern.test(folder));
    if (category) return category[0];
  }
  for (const [category, pattern] of categories) if (pattern.test(name)) return category;
  return "LAINNYA";
}

function ftthDesignGroupId(asset: NetworkAsset) {
  if (typeof asset.attributes?.ftthDesignId === "string") return asset.attributes.ftthDesignId;
  return asset.attributes?.source === "ftth-design" && asset.createdAt ? `legacy:${asset.createdAt}` : undefined;
}

function assetIconCategory(asset: NetworkAsset) {
  const assetKind = String(asset.attributes?.assetKind ?? "").toUpperCase();
  const categories: Record<string, string> = {
    JOINT_CLOSURE: "JC",
    HANDHOLE: "HANDHOLE",
  };
  if (["OLT", "ODC", "ODP", "POLE", "FDT", "OFP", "POP", "ODF", "SLACK"].includes(assetKind)) return assetKind;
  return categories[assetKind] ?? getIconCategory(asset.attributes?.folderPath, asset.attributes?.name ?? asset.name);
}

const assetFeatures = (items: NetworkAsset[]): Feature<Geometry, Record<string, unknown>>[] =>
  items.reduce<Feature<Geometry, Record<string, unknown>>[]>((features, item) => {
    if (item.geometry) {
      const style = item.attributes?.__kmlStyle as ImportedStyle | undefined;
      const iconUrl = style?.iconHref?.replace(/^http:\/\//i, "https://");
      const googlePushpin = /\/pushpin\/ylw-pushpin\.png(?:$|[?#])/i.test(style?.iconHref ?? "");
      const iconCategory = assetIconCategory(item);
      const routeType = item.attributes?.routeType ?? (item.name.startsWith("Kabel feeder") ? "FEEDER" : item.name.startsWith("Kabel ODC") ? "DISTRIBUTION" : undefined);
      features.push({
        type: "Feature",
        id: item.id,
        properties: {
          id: item.id,
          name: item.name,
          area: item.area,
          source: item.source,
          imported: item.source !== "managed",
          geometryType: item.geometry.type,
          iconCategory,
          atlasIconId: !iconUrl && ["OLT", "ODC", "ODP", "POLE", "JC", "HANDHOLE", "FDT", "OFP", "POP", "ODF", "SLACK", "TERMINAL BOX"].includes(iconCategory) ? `atlas-icon-${iconCategory.toLowerCase().replace(/\s+/g, "-")}` : "",
          routeType,
          lineColor: style?.lineColor ?? String(item.attributes?.lineColor ?? (routeType === "FEEDER" ? "#ff0000" : routeType === "DISTRIBUTION" ? "#a000ff" : item.source === "kml" ? "#ffffff" : "#3454d1")),
          lineOpacity: style?.lineOpacity ?? 1,
          lineWidth: style?.lineWidth ?? (routeType ? 5 : item.source === "kml" ? 1 : 3),
          fillColor: style?.fillColor ?? (item.source === "kml" ? "#ffffff" : "#3454d1"),
          fillOpacity: style?.fillOpacity ?? (item.source === "kml" ? 1 : 0.25),
          fillEnabled: style?.fillEnabled ?? item.source === "kml",
          outlineEnabled: style?.outlineEnabled ?? ((item.geometry.type !== "Polygon" && item.geometry.type !== "MultiPolygon") || item.source === "kml"),
          iconColor: style?.iconColor ?? "#ffffff",
          markerColor: style?.iconColor ?? ({ OLT: "#e8b500", ODC: "#ff0000", ODP: "#0000ff", POLE: "#536177", JC: "#a000ff", HANDHOLE: "#536177" } as Record<string, string>)[iconCategory] ?? "#3454d1",
          isManagedFtth: item.attributes?.source === "ftth-design",
          iconOpacity: style?.iconOpacity ?? 1,
          iconScale: style?.iconScale ?? 1,
          iconAnchor: style?.iconAnchor ?? (googlePushpin ? "bottom-right" : "center"),
          iconOffset: style?.iconOffset ?? (googlePushpin ? [12 / 32, 2 / 32] : [0, 0]),
          iconImageId: iconUrl ? `kml-${encodeURIComponent(iconUrl)}-${(style?.iconColor ?? "#ffffff").slice(1)}` : "",
        },
        geometry: item.geometry,
      });
    }
    return features;
  }, []);

function addAtlasMapIcons(map: MapLibreMap) {
  const icons: Record<string, string> = { OLT: "#e8b500", ODC: "#ff0000", ODP: "#0000ff", POLE: "#536177", JC: "#a000ff", HANDHOLE: "#536177", FDT: "#e75b3c", OFP: "#178c80", POP: "#e8b500", ODF: "#684fc7", SLACK: "#64748b", "TERMINAL BOX": "#3280c8" };
  for (const [category, color] of Object.entries(icons)) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.scale(2, 2);
    if (category === "ODC" || category === "ODP") {
      context.fillStyle = color;
      context.beginPath(); context.moveTo(16, 4); context.lineTo(28, 27); context.lineTo(4, 27); context.closePath(); context.fill();
      context.globalCompositeOperation = "destination-out";
      context.beginPath(); context.arc(16, 19, 3.5, 0, 2 * Math.PI); context.fill();
      context.globalCompositeOperation = "source-over";
    } else if (category === "OLT") {
      context.fillStyle = "#fff"; context.strokeStyle = "#d9a400"; context.lineWidth = 1.5;
      context.beginPath(); context.roundRect(5, 7, 22, 20, 2); context.fill(); context.stroke();
      for (const y of [12, 18, 24]) { context.fillStyle = "#e8b500"; context.fillRect(8, y - 1, 16, 3); context.fillStyle = "#fff"; context.fillRect(10, y, 2, 1); }
    } else if (category === "POLE") {
      context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 2.5;
      context.beginPath(); context.moveTo(16, 4); context.lineTo(16, 29); context.moveTo(8, 10); context.lineTo(24, 10); context.moveTo(10, 15); context.lineTo(22, 15); context.moveTo(13, 7); context.lineTo(13, 11); context.moveTo(19, 7); context.lineTo(19, 11); context.stroke();
      context.beginPath(); context.moveTo(11, 29); context.lineTo(21, 29); context.stroke();
    } else if (category === "JC" || category === "HANDHOLE") {
      context.beginPath(); context.roundRect(3, 5, 26, 22, 5); context.fill(); context.stroke();
      context.fillStyle = "#fff"; context.font = "bold 8px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(category === "JC" ? "JC" : "HH", 16, 16);
    } else {
      context.beginPath(); context.arc(16, 16, 14, 0, 2 * Math.PI); context.fill(); context.stroke();
      context.fillStyle = "#fff"; context.font = "bold 8px sans-serif"; context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(category === "TERMINAL BOX" ? "TB" : category, 16, 17, 26);
    }
    map.addImage(`atlas-icon-${category.toLowerCase().replace(/\s+/g, "-")}`, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  }
}
const lineCollection = (features: Feature<Geometry, Record<string, unknown>>[]): FeatureCollection<Geometry> => ({ type: "FeatureCollection", features });
const routeCollection = (features: RouteLine[]): FeatureCollection<LineString> => ({ type: "FeatureCollection", features });
const pointCollection = (points: Coordinate[]): FeatureCollection<Point> => ({
  type: "FeatureCollection",
  features: points.map((coordinates, index) => ({ type: "Feature", properties: { index }, geometry: { type: "Point", coordinates } })),
});
function addBoundsCoordinates(bounds: LngLatBounds, coordinates: unknown) {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") bounds.extend([coordinates[0], coordinates[1]]);
  else coordinates.forEach((entry) => addBoundsCoordinates(bounds, entry));
}
function geometryBounds(geometry: Geometry, bounds: LngLatBounds) {
  if (geometry.type === "GeometryCollection") geometry.geometries.forEach((child) => geometryBounds(child, bounds));
  else addBoundsCoordinates(bounds, geometry.coordinates);
}
function nearestPointFeature(map: MapLibreMap, point: { x: number; y: number }) {
  const nearby = map.queryRenderedFeatures([point.x, point.y], { layers: ["network-point-hit", "network-icons", "network-points"] });
  const points = nearby.filter((feature): feature is (typeof nearby)[number] & { geometry: Point } => feature.geometry.type === "Point");
  return points.sort((a, b) => {
    const distance = (feature: typeof a) => {
      const projected = map.project(feature.geometry.coordinates as Coordinate);
      return (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
    };
    return distance(a) - distance(b);
  })[0];
}
function pointFeatureAtCursor(map: MapLibreMap, point: { x: number; y: number }) {
  const features = map.queryRenderedFeatures([point.x, point.y], { layers: ["network-icons", "network-points"] }).filter((feature): feature is typeof feature & { geometry: Point } => feature.geometry.type === "Point");
  return features.sort((a, b) => {
    const distance = (feature: typeof a) => {
      const projected = map.project(feature.geometry.coordinates as Coordinate);
      return (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
    };
    return distance(a) - distance(b);
  })[0];
}
function tintKmlIcon(source: HTMLImageElement | ImageBitmap, color?: string) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.drawImage(source, 0, 0);
  if (color && color.toLowerCase() !== "#ffffff") {
    context.globalCompositeOperation = "multiply";
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(source, 0, 0);
  }
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
function firstCoordinate(geometry: NetworkAsset["geometry"]): Coordinate {
  if (!geometry) return [106.79, -6.26];
  if (geometry.type === "Point") return geometry.coordinates as Coordinate;
  if (geometry.type === "LineString") return geometry.coordinates[0] as Coordinate;
  if (geometry.type === "MultiLineString") return (geometry.coordinates[0]?.[0] as Coordinate) ?? [106.79, -6.26];
  if (geometry.type === "Polygon") return (geometry.coordinates[0]?.[0] as Coordinate) ?? [106.79, -6.26];
  if (geometry.type === "MultiPoint") return (geometry.coordinates[0] as Coordinate) ?? [106.79, -6.26];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates[0]?.[0]?.[0] as Coordinate) ?? [106.79, -6.26];
  const child = geometry.geometries.find((item) => item.type !== "GeometryCollection");
  return child ? firstCoordinate(child) : [106.79, -6.26];
}

export function MapPage() {
  const { data: networkSegments = [] } = useQuery({ queryKey: ["segments"], queryFn: () => api<NetworkAsset[]>("/assets"), refetchInterval: 30_000 });
  const [mapBounds, setMapBounds] = useState<[number, number, number, number] | null>(null);
  const mapAssetsQuery = useQuery({
    queryKey: ["map-assets", mapBounds],
    queryFn: () => api<NetworkAsset[]>(`/assets/map?bbox=${mapBounds!.join(",")}`),
    enabled: Boolean(mapBounds),
    staleTime: 20_000,
    placeholderData: (previous) => previous,
  });
  const { data: bookings = [], isPending: bookingsPending, isError: bookingsError } = useQuery({ queryKey: ["bookings"], queryFn: () => api<Booking[]>("/bookings"), refetchInterval: 30_000 });
  const queryClient = useQueryClient();
  const invalidateNetwork = () => Promise.all(networkQueryKeys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  const mapElement = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const hoverPopup = useRef<Popup | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const xlsxImportInput = useRef<HTMLInputElement>(null);
  const iconFilter = useRef<HTMLDetailsElement>(null);
  const modeRef = useRef<SelectMode>("idle");
  const pointsRef = useRef<Coordinate[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [confirmedRoutes, setConfirmedRoutes] = useState<RouteLine[]>([]);
  const [routePreview, setRoutePreview] = useState<RouteLine | null>(null);
  const [routePoints, setRoutePoints] = useState<Coordinate[]>([]);
  const [mode, setMode] = useState<SelectMode>("idle");
  const [mapError, setMapError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [selectedIconCategories, setSelectedIconCategories] = useState<string[] | null>(() => {
    try {
      const saved = localStorage.getItem("atlas-map-icon-categories-v2");
      if (saved === null) return null;
      const parsed: unknown = JSON.parse(saved);
      return Array.isArray(parsed) && parsed.every((category) => typeof category === "string") ? parsed : null;
    } catch {
      return null;
    }
  });
  const [iconCategorySearch, setIconCategorySearch] = useState("");
  const [fileError, setFileError] = useState("");
  const [importing, setImporting] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [fileName, setFileName] = useState("");
  const [search, setSearch] = useState("");
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeDistance, setRouteDistance] = useState<number | null>(null);
  const [fileModal, setFileModal] = useState<"import" | "download" | null>(null);
  const { data: user } = useQuery({ queryKey: ["me"], queryFn: () => api<{ role: string }>("/me") });

  const allNetworkFeatures = useMemo(() => assetFeatures(mapAssetsQuery.data ?? []), [mapAssetsQuery.data]);
  const iconCategoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of networkSegments)
      if (asset.geometryType?.toUpperCase() === "POINT") {
        const category = assetIconCategory(asset);
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    return [...counts].sort(([a], [b]) => a.localeCompare(b, "id"));
  }, [networkSegments]);
  const activeIconCategories = useMemo(() => selectedIconCategories ?? iconCategoryCounts.map(([category]) => category), [selectedIconCategories, iconCategoryCounts]);
  useEffect(() => {
    if (selectedIconCategories === null) localStorage.removeItem("atlas-map-icon-categories-v2");
    else localStorage.setItem("atlas-map-icon-categories-v2", JSON.stringify(selectedIconCategories));
  }, [selectedIconCategories]);
  const shapeFeatures = useMemo(() => lineCollection(allNetworkFeatures.filter((feature) => feature.geometry.type !== "Point")), [allNetworkFeatures]);
  const pointFeatures = useMemo(() => lineCollection(allNetworkFeatures.filter((feature) => feature.geometry.type === "Point" && activeIconCategories.includes(String(feature.properties.iconCategory)))), [allNetworkFeatures, activeIconCategories]);
  const routeFeatures = useMemo(() => routeCollection([...confirmedRoutes, ...(routePreview ? [routePreview] : [])]), [confirmedRoutes, routePreview]);
  const routePointFeatures = useMemo(() => pointCollection(routePoints), [routePoints]);
  const selectedAsset = networkSegments.find((item) => item.id === selectedId)
    ?? networkSegments.find((item) => ftthDesignGroupId(item))
    ?? networkSegments[0];
  const selectedDraftId = selectedAsset ? ftthDesignGroupId(selectedAsset) : undefined;
  const selectedDraftOlt = selectedDraftId ? networkSegments.find((asset) =>
    ftthDesignGroupId(asset) === selectedDraftId
    && (String(asset.attributes?.assetKind ?? "").toUpperCase() === "OLT" || /^OLT(?:\b|\s|·)/i.test(asset.name)),
  ) : undefined;
  const selectedDraftAnchor = selectedDraftOlt ?? (selectedDraftId ? selectedAsset : undefined);
  const selectedDraftOltGeometry = useQuery({
    queryKey: ["asset-geometry", selectedDraftAnchor?.id],
    queryFn: () => api<{ geometry: Geometry | null }>(`/assets/${selectedDraftAnchor!.id}/geometry`),
    enabled: Boolean(selectedDraftAnchor),
    staleTime: 60_000,
  });
  const draftRadiusMeters = Number(selectedDraftOlt?.attributes?.coverageRadiusMeters) || 500;
  const draftBoundary = useMemo<Feature<Polygon, Record<string, unknown>> | null>(() => {
    const geometry = selectedDraftAnchor?.geometry ?? selectedDraftOltGeometry.data?.geometry;
    if (!geometry) return null;
    const [longitude, latitude] = firstCoordinate(geometry);
    const coordinates = Array.from({ length: 65 }, (_, index) => {
      const bearing = index / 64 * 2 * Math.PI, distance = draftRadiusMeters / 6371008.8;
      const lat1 = latitude * Math.PI / 180, lon1 = longitude * Math.PI / 180;
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing));
      const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2));
      return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI] as Coordinate;
    });
    coordinates[64] = coordinates[0];
    return { type: "Feature", properties: { radiusMeters: draftRadiusMeters }, geometry: { type: "Polygon", coordinates: [coordinates] } };
  }, [selectedDraftAnchor, selectedDraftOltGeometry.data?.geometry, draftRadiusMeters]);
  const selectedSegment = selectedAsset?.assetType === "segment" ? selectedAsset : undefined;
  const selectedImported = selectedAsset && selectedAsset.assetType !== "segment" ? selectedAsset : undefined;
  const imported = networkSegments.filter((item) => item.source !== "managed");
  const selectedName = selectedAsset?.name ?? "Pilih aset jaringan";
  const utilization = (item: NetworkAsset) => (item.totalCores ? Math.round(((item.usedCores + item.bookedCores) / item.totalCores) * 100) : 0);
  const coresQuery = useQuery({
    queryKey: ["cores", selectedSegment?.id],
    queryFn: () => api<{ coreNumber: number; status: "Available" | "Booked" | "Used"; customer?: string; picCustomer?: string; picPresales?: string; expiresAt?: string }[]>(`/assets/${selectedSegment?.id}/cores`),
    enabled: Boolean(selectedSegment),
    refetchInterval: 30_000,
  });
  const updateCore = useMutation({
    mutationFn: ({ coreNumber, status }: { coreNumber: number; status: "Available" | "Used" }) => api(`/assets/${selectedSegment?.id}/cores/${coreNumber}`, { method: "PATCH", data: { status } }),
    onSuccess: invalidateNetwork,
  });
  const updateAsset = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => api(`/assets/${id}`, { method: "PATCH", data }),
    onSuccess: invalidateNetwork,
  });
  useEffect(() => {
    updateCore.reset();
    updateAsset.reset();
  }, [selectedSegment?.id, updateCore.reset, updateAsset.reset]);
  const filteredSegments = networkSegments.filter((item) => item.source !== "kml" && item.assetType === "segment" && `${item.name} ${item.area}`.toLowerCase().includes(search.toLowerCase()));
  const ftthDraftGroups = new Map<string, typeof filteredSegments>();
  const standaloneSegments = filteredSegments.filter((segment) => {
    const groupId = ftthDesignGroupId(segment);
    if (!groupId) return true;
    const group = ftthDraftGroups.get(groupId) ?? [];
    group.push(segment);
    ftthDraftGroups.set(groupId, group);
    return false;
  });
  const getDraftFeatureCount = (groupId: string) => networkSegments.filter((asset) => ftthDesignGroupId(asset) === groupId).length;
  const matchedImported = imported.filter((item) => (item.source === "kml" || item.assetType !== "segment") && item.name.toLowerCase().includes(search.toLowerCase()));
  const filteredImported = matchedImported.slice(0, 100);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !iconFilter.current?.contains(event.target)) iconFilter.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick, true);
  }, []);

  function setSelectionMode(value: SelectMode) {
    modeRef.current = value;
    setMode(value);
  }

  function setPoints(value: Coordinate[]) {
    pointsRef.current = value;
    setRoutePoints(value);
  }

  useEffect(() => {
    if (!mapElement.current || map.current) return;
    setWorkerUrl(workerUrl);
    let focus: Coordinate | null = null;
    try {
      const savedFocus = JSON.parse(localStorage.getItem("atlas-map-focus") ?? "null");
      if (Array.isArray(savedFocus) && savedFocus.length === 2 && savedFocus.every((value) => typeof value === "number" && Number.isFinite(value))) focus = savedFocus as Coordinate;
    } catch { /* Ignore an invalid saved map position. */ }
    const instance = new MapLibreMap({ container: mapElement.current, style: "https://tiles.openfreemap.org/styles/liberty", center: focus ?? [106.79, -6.26], zoom: focus ? 15 : 11.2 });
    map.current = instance;
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(mapElement.current);
    instance.addControl(new NavigationControl(), "top-right");
    instance.on("error", () => setMapError(true));
    instance.on("load", () => {
      if (focus) localStorage.removeItem("atlas-map-focus");
      addAtlasMapIcons(instance);
      const updateBounds = () => {
        const bounds = instance.getBounds();
        setMapBounds([bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value) => Number(value.toFixed(4))) as [number, number, number, number]);
      };
      instance.on("moveend", updateBounds);
      updateBounds();
      instance.addSource("network-shapes", { type: "geojson", data: shapeFeatures });
      instance.addSource("network-points-data", { type: "geojson", data: pointFeatures, cluster: true, clusterMaxZoom: 14, clusterRadius: 28 });
      instance.addSource("selected-ftth-boundary", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      instance.addLayer({ id: "selected-ftth-boundary-fill", type: "fill", source: "selected-ftth-boundary", paint: { "fill-color": "#3454d8", "fill-opacity": 0.12 } });
      instance.addLayer({ id: "selected-ftth-boundary-line", type: "line", source: "selected-ftth-boundary", paint: { "line-color": "#3454d8", "line-width": 2, "line-dasharray": [2, 2] } });
      instance.addLayer({
        id: "network-polygons",
        type: "fill",
        source: "network-shapes",
        filter: ["!=", ["get", "fillEnabled"], false],
        paint: { "fill-color": ["coalesce", ["get", "fillColor"], "#3454d1"], "fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.25] },
      });
      const visibleLineFilter: FilterSpecification = ["any", ["==", ["get", "geometryType"], "LineString"], ["all", ["in", ["get", "geometryType"], ["literal", ["Polygon", "MultiPolygon"]]], ["!=", ["get", "outlineEnabled"], false]]];
      instance.addLayer({
        id: "network-lines",
        type: "line",
        source: "network-shapes",
        filter: visibleLineFilter,
        paint: { "line-color": ["coalesce", ["get", "lineColor"], "#3454d1"], "line-width": ["coalesce", ["get", "lineWidth"], 4], "line-opacity": ["coalesce", ["get", "lineOpacity"], 0.9] },
      });
      instance.addLayer({ id: "network-hit", type: "line", source: "network-shapes", filter: visibleLineFilter, paint: { "line-color": "#3454d1", "line-width": 18, "line-opacity": 0 } });
      instance.addLayer({
        id: "network-clusters",
        type: "circle",
        source: "network-points-data",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#3454d1",
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 50, 28, 200, 34],
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 2,
          "circle-opacity": 0.94,
        },
      });
      instance.addLayer({
        id: "network-cluster-count",
        type: "symbol",
        source: "network-points-data",
        filter: ["has", "point_count"],
        layout: { "text-field": ["to-string", ["get", "point_count"]], "text-size": 13, "text-font": ["Open Sans Bold"], "text-allow-overlap": true },
        paint: { "text-color": "#fff" },
      });
      instance.addLayer({
        id: "network-points",
        type: "circle",
        source: "network-points-data",
        filter: ["all", ["!", ["has", "point_count"]], ["all", ["any", ["!", ["has", "iconImageId"]], ["==", ["get", "iconImageId"], ""]], ["any", ["!", ["has", "atlasIconId"]], ["==", ["get", "atlasIconId"], ""]]]],
        paint: { "circle-radius": ["case", ["in", ["get", "iconCategory"], ["literal", ["OLT", "ODC", "ODP", "POLE", "JC", "HANDHOLE"]]], 9, 3], "circle-color": ["coalesce", ["get", "markerColor"], "#3454d1"], "circle-opacity": ["coalesce", ["get", "iconOpacity"], 1], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 },
      });
      instance.addLayer({
        id: "network-icons",
        type: "symbol",
        source: "network-points-data",
        filter: ["all", ["!", ["has", "point_count"]], ["any", ["!", ["has", "atlasIconId"]], ["==", ["get", "atlasIconId"], ""], ["!", ["has", "iconImageId"]], ["==", ["get", "iconImageId"], ""]]],
        layout: {
          "icon-image": ["case", ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]], ["get", "atlasIconId"], ["get", "iconImageId"]],
          "icon-size": ["case", ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]], ["match", ["get", "iconCategory"], "POLE", 0.62, "OLT", 0.8, "ODC", 0.8, "ODP", 0.8, 0.8], ["min", ["max", ["*", ["coalesce", ["get", "iconScale"], 1], 0.9], 0.9], 1]],
          "icon-anchor": ["get", "iconAnchor"],
          "icon-offset": ["get", "iconOffset"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["coalesce", ["get", "iconOpacity"], 1] },
      });
      instance.addLayer({ id: "network-point-hit", type: "circle", source: "network-points-data", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 18, "circle-color": "#000", "circle-opacity": 0 } });
      instance.addSource("route-lines", { type: "geojson", data: routeFeatures });
      instance.addLayer({ id: "saved-routes", type: "line", source: "route-lines", filter: ["==", ["get", "status"], "saved"], paint: { "line-color": "#f29b38", "line-width": 5 } });
      instance.addLayer({ id: "preview-route", type: "line", source: "route-lines", filter: ["==", ["get", "status"], "preview"], paint: { "line-color": "#f29b38", "line-width": 5, "line-dasharray": [2, 1] } });
      instance.addSource("route-points", { type: "geojson", data: routePointFeatures });
      instance.addLayer({ id: "route-markers", type: "circle", source: "route-points", paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-width": 3, "circle-stroke-color": "#f29b38" } });
      instance.moveLayer("selected-ftth-boundary-fill");
      instance.moveLayer("selected-ftth-boundary-line");
      instance.on("click", (event) => {
        if (modeRef.current !== "idle") return;
        const cluster = instance.queryRenderedFeatures(event.point, { layers: ["network-clusters"] })[0];
        if (cluster) {
          const clusterId = Number(cluster.properties?.cluster_id);
          const source = instance.getSource("network-points-data") as GeoJSONSource;
          void source.getClusterExpansionZoom(clusterId).then((zoom) => {
            const coordinates = (cluster.geometry as Point).coordinates as Coordinate;
            instance.easeTo({ center: coordinates, zoom: Math.min(zoom, 18), duration: 450 });
          });
          return;
        }
        const features = instance.queryRenderedFeatures(event.point, { layers: ["network-icons", "network-points", "network-polygons", "network-lines", "network-hit"] });
        const boundary = features.find((item) => item.layer.id === "network-polygons") ?? features.find((item) => ["network-lines", "network-hit"].includes(item.layer.id));
        const feature = pointFeatureAtCursor(instance, event.point) ?? boundary ?? nearestPointFeature(instance, event.point) ?? features[0];
        const id = String(feature?.properties?.id ?? "");
        if (id) setSelectedId(id);
      });
      hoverPopup.current = new Popup({ closeButton: false, closeOnClick: false, anchor: "bottom", offset: 12, maxWidth: "180px", className: "network-hover-popup" });
      instance.on("mousemove", (event) => {
        const clusterFeature = instance.queryRenderedFeatures(event.point, { layers: ["network-clusters"] })[0];
        const pointFeature = pointFeatureAtCursor(instance, event.point);
        const lineFeature = clusterFeature || pointFeature
          ? undefined
          : instance.queryRenderedFeatures(event.point, { layers: ["network-lines", "network-hit"] }).find((item) => ["LineString", "MultiLineString"].includes(String(item.properties?.geometryType)));
        const feature = clusterFeature ?? pointFeature ?? lineFeature;
        if (!feature) {
          instance.getCanvas().style.cursor = "";
          hoverPopup.current?.remove();
          return;
        }
        instance.getCanvas().style.cursor = "pointer";
        const content = document.createElement("div");
        const title = document.createElement("strong");
        const detail = document.createElement("small");
        const isCluster = Boolean(clusterFeature);
        title.textContent = isCluster ? `${Number(feature.properties?.point_count ?? 0).toLocaleString("id-ID")} aset titik` : String(feature.properties?.name ?? "Aset jaringan");
        const sourceLabel = feature.properties?.source === "kml" ? "KML/KMZ" : feature.properties?.source === "xlsx" ? "Excel" : String(feature.properties?.area ?? "Jaringan");
        detail.textContent = isCluster ? "Klik untuk melihat lebih dekat" : `${sourceLabel} · ${String(feature.properties?.geometryType ?? "Segmen")} · Klik untuk detail`;
        content.append(title, document.createElement("br"), detail);
        const coordinates: Coordinate = isCluster || pointFeature ? (feature.geometry as Point).coordinates as Coordinate : [event.lngLat.lng, event.lngLat.lat];
        hoverPopup.current?.setLngLat(coordinates).setDOMContent(content).addTo(instance);
      });
      setMapReady(true);
    });
    instance.on("click", (event) => {
      if (modeRef.current === "idle") return;
      const nextPoint: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      if (modeRef.current === "start") {
        setPoints([nextPoint]);
        setSelectionMode("end");
        setRouteError("");
      } else if (modeRef.current === "waypoint") {
        setPoints([...pointsRef.current, nextPoint]);
        setSelectionMode("end");
      } else if (modeRef.current === "end") {
        setPoints([...pointsRef.current, nextPoint]);
        setSelectionMode("idle");
      }
    });
    return () => {
      resizeObserver.disconnect();
      hoverPopup.current?.remove();
      hoverPopup.current = null;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    (map.current?.getSource("network-shapes") as GeoJSONSource | undefined)?.setData(shapeFeatures);
    (map.current?.getSource("network-points-data") as GeoJSONSource | undefined)?.setData(pointFeatures);
  }, [shapeFeatures, pointFeatures]);
  useEffect(() => {
    (map.current?.getSource("selected-ftth-boundary") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: draftBoundary ? [draftBoundary] : [] });
  }, [draftBoundary, mapReady]);
  useEffect(() => {
    const designId = localStorage.getItem("atlas-map-focus-design");
    if (!designId) return;
    const target = networkSegments.find((asset) => asset.attributes?.ftthDesignId === designId && asset.attributes?.assetKind === "ROUTE")
      ?? networkSegments.find((asset) => asset.attributes?.ftthDesignId === designId);
    if (target) {
      setSelectedId(target.id);
      localStorage.removeItem("atlas-map-focus-design");
    }
  }, [networkSegments]);
  useEffect(() => {
    if (!draftBoundary || !mapReady || !map.current) return;
    const bounds = draftBoundary.geometry.coordinates[0].reduce((value, coordinate) => value.extend(coordinate as Coordinate), new LngLatBounds());
    map.current.fitBounds(bounds, { padding: 72, maxZoom: 16, duration: 450 });
  }, [draftBoundary, mapReady]);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !mapReady) return;
    const categoryFilter: FilterSpecification = activeIconCategories.length ? ["in", ["get", "iconCategory"], ["literal", activeIconCategories]] : ["==", ["get", "iconCategory"], "__NO_ICON_CATEGORY_SELECTED__"];
    instance.setFilter("network-icons", ["all", ["any", ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]], ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]]], categoryFilter]);
    instance.setFilter("network-points", ["all", ["any", ["!", ["has", "iconImageId"]], ["==", ["get", "iconImageId"], ""]], ["any", ["!", ["has", "atlasIconId"]], ["==", ["get", "atlasIconId"], ""]], categoryFilter]);
    instance.setFilter("network-point-hit", categoryFilter);
    if (!activeIconCategories.length) {
      instance.getCanvas().style.cursor = "";
      hoverPopup.current?.remove();
    }
  }, [mapReady, activeIconCategories]);
  useEffect(() => {
    (map.current?.getSource("route-lines") as GeoJSONSource | undefined)?.setData(routeFeatures);
  }, [routeFeatures]);
  useEffect(() => {
    (map.current?.getSource("route-points") as GeoJSONSource | undefined)?.setData(routePointFeatures);
  }, [routePointFeatures]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !mapReady) return;
    const icons = new Map<string, { url: string; color: string }>();
    const assetsById = new Map(networkSegments.map((asset) => [asset.id, asset]));
    for (const feature of allNetworkFeatures) {
      const url = String(feature.properties?.iconImageId ?? "");
      if (url) {
        const style = assetsById.get(String(feature.properties?.id))?.attributes?.__kmlStyle as ImportedStyle | undefined;
        if (style?.iconHref) icons.set(url, { url: style.iconHref.replace(/^http:\/\//i, "https://"), color: style.iconColor ?? "#ffffff" });
      }
    }
    for (const [id, { url, color }] of icons) {
      if (instance.hasImage(id)) continue;
      instance
        .loadImage(url)
        .then(({ data }) => {
          if (instance.hasImage(id)) return;
          let image: HTMLImageElement | ImageBitmap | ImageData = data;
          try {
            image = tintKmlIcon(data, color);
          } catch {
            /* use the original Google Earth icon if canvas tinting is blocked */
          }
          const pixelRatio = Math.max(0.5, Math.max(data.width, data.height) / 34);
          instance.addImage(id, image, { pixelRatio });
        })
        .catch(() => undefined);
    }
  }, [allNetworkFeatures, mapReady, mapAssetsQuery.data]);

  async function importFile(file?: File) {
    if (!file) return;
    setImporting(true);
    try {
      setFileError("");
      const form = new FormData();
      form.append("file", file);
      const response = await api<{ importedCount: number; segmentCount: number; firstId?: string }>("/assets/import", { method: "POST", data: form });
      await invalidateNetwork();
      setFileName(file.name);
      setSelectedId(response.firstId ?? "");
      if (response.firstId) await focusGeometry(response.firstId);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "File tidak dapat dibaca.");
    } finally { setImporting(false); }
  }

  async function importNetworkXlsx(file?: File) {
    if (!file) return
    setImporting(true)
    try {
      setFileError("")
      if (!/\.xlsx$/i.test(file.name)) throw new Error("Pilih file Excel .xlsx.")
      const form = new FormData()
      form.append("file", file)
      const result = await api<{ importedCount: number; segmentCount: number }>("/assets/import/xlsx", { method: "POST", data: form })
      await invalidateNetwork()
      setFileName(`${file.name} · ${result.importedCount} aset (${result.segmentCount} segmen)`)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "File Excel jaringan tidak dapat dibaca.")
    } finally { setImporting(false) }
  }

  function downloadNetworkTemplate() {
    const workbook = new ExcelJS.Workbook()
    const data = workbook.addWorksheet("Data Jaringan")
    data.addRow(["Nama", "Tipe Aset", "Area", "Tipe Kabel", "Jumlah Core", "Metode Instalasi", "Sisi Jalan", "Tinggi Tiang", "Nomor Tiang", "ODC", "ODP", "Geometry GeoJSON"])
    data.columns = [{ width: 32 }, { width: 16 }, { width: 22 }, { width: 20 }, { width: 14 }, { width: 20 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 68 }]
    data.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }
    data.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3454D1" } }
    const guide = workbook.addWorksheet("Petunjuk")
    guide.addRows([
      ["Impor Jaringan ATLAS"],
      ["Isi satu baris untuk setiap aset. Kolom Nama dan Geometry GeoJSON wajib."],
      ["Tipe Aset: Segmen untuk kabel, Aset untuk tiang/ODC/ODP. Jika kosong, tipe geometri menentukan jenis."],
      ["Geometry GeoJSON wajib berupa geometri GeoJSON; semua koordinat memakai urutan longitude, latitude."],
      ['Contoh titik: {"type":"Point","coordinates":[106.8,-6.2]}'],
      ['Contoh kabel: {"type":"LineString","coordinates":[[106.8,-6.2],[106.81,-6.21]]}'],
      ["Jumlah Core berupa bilangan 0–4096. Metode Instalasi: Aerial atau Burial. Sisi Jalan: Kiri atau Kanan."],
      ["Tinggi Tiang: 7 m atau 9 m. Ukuran file maksimal 10 MB dan 10.000 aset."],
    ])
    guide.getColumn(1).width = 112
    void workbook.xlsx.writeBuffer().then((buffer) => {
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }))
      const link = document.createElement("a")
      link.href = url
      link.download = "template-impor-jaringan-atlas.xlsx"
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  function saveAssetDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedSegment) return
    const form = new FormData(event.currentTarget)
    updateAsset.mutate({ id: selectedSegment.id, data: {
      area: String(form.get("area")), cableType: String(form.get("cableType")), totalCores: Number(form.get("totalCores")),
      installation: String(form.get("installation")), side: String(form.get("side")),
    } })
  }

  async function previewRoute() {
    if (routePoints.length < 2) return;
    setRouteLoading(true);
    setRouteError("");
    try {
      const payload = await api<{ geometry?: LineString; distanceMeters?: number }>("/routes/preview", { method: "POST", data: { coordinates: routePoints } });
      if (!payload.geometry) throw new Error("Rute jalan tidak dapat dihitung.");
      setRoutePreview({ type: "Feature", id: "route-preview", properties: { id: "route-preview", name: `Pratinjau rute ${confirmedRoutes.length + 1}`, status: "preview" }, geometry: payload.geometry });
      setRouteDistance(payload.distanceMeters ?? null);
      setRouteError("");
      const coordinates = payload.geometry.coordinates;
      const first = coordinates[0] as Coordinate;
      map.current?.fitBounds(
        coordinates.reduce((bounds, point) => bounds.extend(point as Coordinate), new LngLatBounds(first, first)),
        { padding: 50, maxZoom: 15 },
      );
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Layanan routing tidak tersedia.");
    } finally {
      setRouteLoading(false);
    }
  }

  function confirmRoute() {
    if (!routePreview) return;
    const id = `route-${Date.now()}`;
    setConfirmedRoutes((current) => [...current, { ...routePreview, id, properties: { ...routePreview.properties, id, name: `Rute ${current.length + 1}`, status: "saved" } }]);
    setRoutePreview(null);
    setPoints([]);
    setRouteDistance(null);
  }

  const focusGeometry = async (id: string, existing?: Geometry | null) => {
    if (!map.current) return;
    try {
      const geometry = existing ?? (await api<{ geometry: Geometry | null }>(`/assets/${id}/geometry`)).geometry;
      if (!geometry) return;
      if (geometry.type === "Point") {
        map.current.flyTo({ center: firstCoordinate(geometry), zoom: 16, essential: true });
        return;
      }
      const bounds = new LngLatBounds();
      geometryBounds(geometry, bounds);
      if (!bounds.isEmpty()) map.current.fitBounds(bounds, { padding: 64, maxZoom: 14, duration: 500 });
    } catch {
      setMapError(true);
    }
  };

  const focusAsset = async (asset: NetworkAsset) => {
    setSelectedId(asset.id);
    await focusGeometry(asset.id, asset.geometry);
  };

  return (
    <>
      <PageHeader
        title="Peta jaringan"
        subtitle="Jelajahi aset, impor data jaringan, dan rencanakan jalur kabel mengikuti jalan."
        action={
          <span className="map-legend">
            <span /> Jaringan <span className="imported-legend" /> Data impor <span className="route-legend" /> Rute jalan
          </span>
        }
      />
      <div className="map-layout">
        <section className="map-canvas-wrap">
          <div ref={mapElement} className={`map-canvas ${mode !== "idle" ? "map-picking" : ""}`} aria-label="Peta jaringan ATLAS" />
          <div className="map-overlay-label">
            <i className="bi bi-broadcast-pin" /> Cakupan routing Pulau Jawa
          </div>
          <div className="map-top-actions">
            {user?.role === "ADMIN" && <div className="map-file-actions">
              <button className="btn btn-light" onClick={() => setFileModal("import")} disabled={importing} aria-busy={importing}>{importing ? <><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" />Mengimpor...</> : <><i className="bi bi-upload me-1" />Impor</>}</button>
              <button className="btn btn-light" onClick={() => setFileModal("download")}><i className="bi bi-download me-1" />Unduh</button>
            </div>}
            <details ref={iconFilter} className="map-icon-filter">
              <summary><i className="bi bi-funnel" /><span>Filter ikon</span><b>{activeIconCategories.length}/{iconCategoryCounts.length}</b></summary>
              <div className="map-icon-filter-menu">
                <div className="map-icon-filter-actions">
                  <button type="button" onClick={() => setSelectedIconCategories(iconCategoryCounts.map(([category]) => category))}>Pilih semua</button>
                  <button type="button" onClick={() => setSelectedIconCategories([])}>Bersihkan</button>
                </div>
                <input aria-label="Cari kategori ikon" placeholder="Cari jenis ikon" value={iconCategorySearch} onChange={(event) => setIconCategorySearch(event.target.value)} />
                <div className="map-icon-filter-list">
                  {iconCategoryCounts.filter(([category]) => category.toLowerCase().includes(iconCategorySearch.toLowerCase())).map(([category, count]) => (
                    <label key={category}><input type="checkbox" checked={activeIconCategories.includes(category)} onChange={(event) => setSelectedIconCategories((current) => (event.target.checked ? [...(current ?? activeIconCategories), category] : (current ?? activeIconCategories).filter((item) => item !== category)))} /><span>{category}</span><small>{count.toLocaleString("id-ID")}</small></label>
                  ))}
                </div>
                {!iconCategoryCounts.length && <small className="map-icon-filter-empty">Belum ada ikon titik.</small>}
              </div>
            </details>
          </div>
          {(mode !== "idle" || routeError) && (
            <div className="route-map-message" role="status">
              {mode === "start" ? "Klik peta untuk memilih titik awal." : mode === "waypoint" ? "Klik peta untuk menambah waypoint." : mode === "end" ? "Klik peta untuk memilih titik akhir." : routeError}
            </div>
          )}
          {mapError && (
            <div className="map-error">
              <i className="bi bi-wifi-off me-2" />
              Peta tidak dapat dimuat. Periksa koneksi internet Anda.
            </div>
          )}
        </section>
        <aside className="map-sidebar">
          <div className="map-tools">
            <div className="map-search">
              <label className="form-label fw-semibold">
                Daftar segmen <span className="text-muted fw-normal">({standaloneSegments.length + ftthDraftGroups.size + filteredImported.length})</span>
              </label>
              <div className="input-group">
                <span className="input-group-text bg-white">
                  <i className="bi bi-search" />
                </span>
                <input className="form-control" placeholder="Cari nama kabel atau area" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
            </div>
            <div className="map-tool-actions">
              {user?.role === "ADMIN" && <>
                <input ref={importInput} className="d-none" type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <input ref={xlsxImportInput} className="d-none" type="file" accept=".xlsx" onChange={(event) => { void importNetworkXlsx(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              </>}
            </div>
            {fileName && (
              <div className="map-file-status">
                <i className="bi bi-check-circle-fill" /> {fileName} · {imported.length} aset tersimpan
              </div>
            )}
            {fileError && <div className="alert alert-danger py-2 px-3 mb-0 map-alert">{fileError}</div>}
            {(mode !== "idle" || routePoints.length > 0 || routePreview) && (
              <div className="route-planner">
                <div className="route-planner-title">
                  <b>
                    <i className="bi bi-signpost-2 me-2" />
                    Rute feeder/distribusi
                  </b>
                  <button
                    className="btn btn-sm btn-link"
                    onClick={() => {
                      setSelectionMode("idle");
                      setPoints([]);
                      setRoutePreview(null);
                      setRouteDistance(null);
                      setRouteError("");
                    }}
                  >
                    Batal
                  </button>
                </div>
                <div className="route-point-count">
                  {routePoints.length} titik dipilih · {routeDistance !== null ? `Jarak jalan ${(routeDistance / 1000).toFixed(2)} km` : "Jalur akan dihitung dari jalan OSM"}
                </div>
                <div className="route-actions">
                  {routePoints.length > 0 && routePoints.length < 9 && (
                    <button className="btn btn-sm btn-light" onClick={() => setSelectionMode("waypoint")}>
                      <i className="bi bi-plus-circle me-1" />
                      Waypoint
                    </button>
                  )}
                  {routePoints.length > 0 && routePoints.length < 10 && (
                    <button className="btn btn-sm btn-light" onClick={() => setSelectionMode("end")}>
                      <i className="bi bi-geo-alt me-1" />
                      Pilih titik akhir
                    </button>
                  )}
                  {routePoints.length >= 2 && (
                    <button className="btn btn-sm btn-primary" onClick={() => void previewRoute()} disabled={routeLoading}>
                      {routeLoading ? (
                        <>
                          <span className="spinner-border spinner-border-sm me-1" />
                          Menghitung
                        </>
                      ) : (
                        "Pratinjau rute"
                      )}
                    </button>
                  )}
                  {routePreview && (
                    <button className="btn btn-sm btn-success" onClick={confirmRoute}>
                      Tambahkan ke peta
                    </button>
                  )}
                </div>
                {routeError && mode === "idle" && (
                  <div className="route-error" role="alert">
                    {routeError}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="segment-list">
            {standaloneSegments.map((segment) => (
              <button key={segment.id} className={`segment-item ${selectedId === segment.id ? "selected" : ""}`} onClick={() => focusAsset(segment)}>
                <span className="segment-dot" />
                <span className="segment-meta">
                  <b>{segment.name}</b>
                  <small>
                    {segment.area} · {segment.totalCores} core
                  </small>
                </span>
                <i className="bi bi-chevron-right" />
              </button>
            ))}
            {[...ftthDraftGroups].map(([groupId, segments]) => (
              <details key={groupId} className="ftth-design-group" onToggle={(event) => { if (event.currentTarget.open && segments[0]) void focusAsset(segments[0]); }}>
                <summary><span className="segment-dot" /><span className="segment-meta"><b>Draft FTTH · {segments[0]?.area || "Area desain"}</b><small>{segments.length} jalur · {getDraftFeatureCount(groupId)} aset dalam satu desain</small></span><i className="bi bi-chevron-down" /></summary>
                <div>{segments.map((segment) => (
                  <button key={segment.id} className={`segment-item ${selectedId === segment.id ? "selected" : ""}`} onClick={() => focusAsset(segment)}>
                    <span className="segment-dot" style={{ background: segment.attributes?.routeType === "FEEDER" ? "#ff0000" : "#a000ff" }} />
                    <span className="segment-meta"><b>{segment.name}</b><small>{segment.attributes?.routeType === "FEEDER" ? "Kabel feeder" : "Kabel distribusi"} · {segment.area}</small></span>
                    <i className="bi bi-chevron-right" />
                  </button>
                ))}</div>
              </details>
            ))}
            {filteredImported.map((line) => (
              <button key={line.id} className={`segment-item imported-item ${selectedId === line.id ? "selected" : ""}`} onClick={() => focusAsset(line)}>
                <span className="segment-dot" />
                <span className="segment-meta">
                  <b>{line.name}</b>
                  <small>{line.source === "kml" ? "KML/KMZ" : "Excel"} · {line.geometry?.type ?? "aset"}</small>
                </span>
                <i className="bi bi-chevron-right" />
              </button>
            ))}
            {matchedImported.length > filteredImported.length && <div className="map-empty-list">Menampilkan 100 dari {matchedImported.length} aset impor. Gunakan pencarian untuk mempersempit daftar.</div>}
            {filteredSegments.length + matchedImported.length === 0 && <div className="map-empty-list">Tidak ada segmen yang cocok.</div>}
          </div>
          <div className="segment-detail">
            <div className="detail-label">{selectedSegment ? "DETAIL SEGMEN" : "DETAIL DATA IMPOR"}</div>
            <h3>{selectedName}</h3>
            {selectedSegment ? (
              <>
                <p className="text-secondary">
                  {selectedSegment.area} · {selectedSegment.cableType}
                </p>
                {selectedDraftId && <div className="alert alert-primary py-2"><i className="bi bi-bounding-box-circles me-2" />Radius desain FTTH {draftRadiusMeters} m ditampilkan pada peta.</div>}
                {selectedSegment.totalCores === 0 && <div className="alert alert-info py-2">Kapasitas belum diisi. ADMIN perlu melengkapi jumlah core sebelum segmen dapat dibooking.</div>}
                {selectedSegment.source !== "kml" && selectedSegment.nameValid === false && <div className="alert alert-warning py-2">Nama kabel belum sesuai pola standar.</div>}
                <div className="core-summary">
                  <div>
                    <small>Core terpasang</small>
                    <b>{selectedSegment.totalCores}</b>
                  </div>
                  <div>
                    <small>Utilisasi</small>
                    <b>{utilization(selectedSegment)}%</b>
                  </div>
                </div>
                <div className="progress mb-3">
                  <div className="progress-bar" style={{ width: `${utilization(selectedSegment)}%` }} />
                </div>
                <div className="core-breakdown">
                  {[
                    ["Used", selectedSegment.usedCores, "used"],
                    ["Booked", selectedSegment.bookedCores, "booked"],
                    ["Idle / tersedia", selectedSegment.idleCores, "available"],
                    ["Waiting list", bookings.filter((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List").length, "booked"],
                  ].map(([label, value, tone]) => (
                    <div key={String(label)}>
                      <span>
                        <i className={`dot ${tone}`} />
                        {label}
                      </span>
                      <b>{value}</b>
                    </div>
                  ))}
                </div>
                <details className="core-list-details">
                  <summary>Rincian {selectedSegment.totalCores} core</summary>
                  {coresQuery.isPending ? (
                    <small>Memuat status core...</small>
                  ) : coresQuery.isError ? <small className="text-danger">Status core tidak dapat dimuat.</small> : !coresQuery.data?.length ? <small className="text-secondary">Belum ada core terpasang.</small> : (
                    <div className="core-status-list">
                      {coresQuery.data?.map((core) => (
                        <div key={core.coreNumber}>
                          <span>Core {core.coreNumber}</span>
                          {core.status === "Booked" ? (
                            <span className="status-pill is-booked" title={`PIC customer: ${core.picCustomer ?? '—'} · PIC presales: ${core.picPresales ?? '—'}`}>Booked · {core.customer}</span>
                          ) : user?.role === "ADMIN" ? (
                            <select
                              className="form-select form-select-sm"
                              value={core.status}
                              disabled={updateCore.isPending}
                              onChange={(event) => updateCore.mutate({ coreNumber: core.coreNumber, status: event.target.value as "Available" | "Used" })}
                            >
                              <option value="Available">Available</option>
                              <option value="Used">Used</option>
                            </select>
                          ) : (
                            <span className={`status-pill ${core.status === "Used" ? "is-released" : "is-waiting"}`}>{core.status}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {updateCore.error && <small className="text-danger">{updateCore.error instanceof Error ? updateCore.error.message : "Status core tidak dapat diubah."}</small>}
                </details>
                <details className="core-list-details"><summary>Waiting list · {bookings.filter((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List").length}</summary>
                  {bookingsPending ? <small role="status">Memuat antrean...</small> : bookingsError ? <small className="text-danger">Antrean tidak dapat dimuat.</small> : <div className="segment-waiting-list">
                    {bookings.filter((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List").sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || a.id.localeCompare(b.id)).map((booking, index) => <div className="segment-waiting-item" key={booking.id}><b>{index + 1}. {booking.customer} · {booking.cores} core</b><small>PIC customer: {booking.picCustomer}<br />PIC presales: {booking.picPresales}<br />{new Date(booking.requestedAt).toLocaleString('id-ID')}</small></div>)}
                    {!bookings.some((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List") && <small className="text-secondary">Belum ada permintaan waiting list.</small>}
                    <small className="text-secondary d-block mt-2">FIFO ketat: permintaan berikutnya menunggu jika kapasitas belum cukup untuk antrean pertama.</small>
                  </div>}
                </details>
                <hr />
                <div className="asset-info">
                  <div className="asset-info-group"><b>Detail kabel</b><div className="asset-info">
                    {[["Tipe kabel", selectedSegment.cableType], ["Metode instalasi", selectedSegment.installation], ["Sisi jalan", `Sisi ${selectedSegment.side.toLowerCase()}`]].map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
                  </div></div>
                  {(selectedSegment.pole || selectedSegment.poleHeight || selectedSegment.odc || selectedSegment.odp) && <div className="asset-info-group"><b>{selectedSegment.source === "managed" ? "Informasi aset" : "Data aset dari sumber impor"}</b><div className="asset-info">
                    {([["Tiang", selectedSegment.pole], ["Tinggi tiang", selectedSegment.poleHeight], ["ODC", selectedSegment.odc], ["ODP", selectedSegment.odp]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
                  </div></div>}
                </div>
                <SegmentRelations key={selectedSegment.id} segmentId={selectedSegment.id} isAdmin={user?.role === "ADMIN"} />
                {selectedSegment.source !== "managed" && <details className="admin-settings mt-3"><summary>Atribut sumber impor</summary><div className="import-detail-list mt-2">{Object.entries(selectedSegment.attributes ?? {}).filter(([key]) => key !== "__kmlStyle").map(([key, value]) => <div key={key}><span>{key}</span><b>{String(value)}</b></div>)}</div></details>}
                {user?.role === "ADMIN" && <details className="admin-settings mt-4">
                  <summary><i className="bi bi-pencil-square me-2" />Ubah detail aset</summary>
                  <form key={selectedSegment.id} className="mt-3" onSubmit={saveAssetDetails}>
                    <label className="form-label">Area</label><input name="area" className="form-control form-control-sm mb-2" defaultValue={selectedSegment.area} />
                    <label className="form-label">Tipe kabel</label><input name="cableType" className="form-control form-control-sm mb-2" defaultValue={selectedSegment.cableType} />
                    <label className="form-label">Jumlah core</label><input name="totalCores" type="number" min="0" max="4096" required className="form-control form-control-sm mb-2" defaultValue={selectedSegment.totalCores} />
                    <label className="form-label">Metode instalasi</label><select name="installation" className="form-select form-select-sm mb-2" defaultValue={selectedSegment.installation}><option value="Aerial">Aerial</option><option value="Burial">Burial</option></select>
                    <label className="form-label">Sisi jalan</label><select name="side" className="form-select form-select-sm mb-2" defaultValue={selectedSegment.side}><option value="Kiri">Kiri</option><option value="Kanan">Kanan</option></select>
                    <button className="btn btn-sm btn-outline-primary" disabled={updateAsset.isPending}>{updateAsset.isPending ? "Menyimpan..." : "Simpan detail"}</button>
                    {updateAsset.isSuccess && <small className="d-block text-success mt-2" role="status">Detail aset tersimpan.</small>}
                    {updateAsset.error && <small className="d-block text-danger mt-2">{updateAsset.error instanceof Error ? updateAsset.error.message : "Detail aset tidak dapat disimpan."}</small>}
                  </form>
                </details>}
                <Link to="/booking-core" className="btn btn-primary w-100 mt-4">
                  <i className="bi bi-diagram-3 me-2" />
                  Kelola booking core
                </Link>
              </>
            ) : selectedImported ? (
              <>
                <p className="text-secondary">Geometri sumber dipertahankan tanpa perubahan.</p>
                <div className="import-detail-list">
                  {Object.entries(selectedImported.attributes ?? {})
                    .filter(([key]) => key !== "__kmlStyle")
                    .map(([key, value]) => (
                      <div key={key}>
                        <span>{key}</span>
                        <b>{String(value)}</b>
                      </div>
                    ))}
                  {(selectedImported.geometryType || selectedImported.geometry?.type) && (
                    <div>
                      <span>Tipe geometri</span>
                      <b>{selectedImported.geometryType ?? selectedImported.geometry?.type}</b>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-secondary">Pilih segmen untuk melihat detail aset.</p>
            )}
          </div>
        </aside>
      </div>
      {fileModal && <div className="file-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setFileModal(null); }}>
        <section className="file-modal" role="dialog" aria-modal="true" aria-labelledby="file-modal-title">
          <header><div><h2 id="file-modal-title">{fileModal === "import" ? "Impor data jaringan" : "Unduh template"}</h2><p>{fileModal === "import" ? "Pilih format file yang ingin diunggah." : "Pilih file template untuk menyiapkan data jaringan."}</p></div><button className="btn-close" aria-label="Tutup" onClick={() => setFileModal(null)} /></header>
          <div className="file-modal-options">{fileModal === "import" ? <>
            <button className="file-modal-option" onClick={() => { setFileModal(null); importInput.current?.click(); }}><span><i className="bi bi-globe2" /></span><div><b>KML / KMZ</b><small>Impor geometri, ikon, warna, dan atribut dari Google Earth.</small></div><i className="bi bi-chevron-right" /></button>
            <button className="file-modal-option" onClick={() => { setFileModal(null); xlsxImportInput.current?.click(); }}><span><i className="bi bi-file-earmark-spreadsheet" /></span><div><b>Excel (.xlsx)</b><small>Impor aset jaringan memakai template ATLAS.</small></div><i className="bi bi-chevron-right" /></button>
          </> : <button className="file-modal-option" onClick={() => { setFileModal(null); downloadNetworkTemplate(); }}><span><i className="bi bi-file-earmark-arrow-down" /></span><div><b>Template Excel jaringan</b><small>Unduh format Excel beserta petunjuk pengisian.</small></div><i className="bi bi-download" /></button>}</div>
          <footer><button className="btn btn-light" onClick={() => setFileModal(null)}>Tutup</button></footer>
        </section>
      </div>}
    </>
  );
}
