import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import ExcelJS from "exceljs";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  Point,
  Polygon,
  Position,
} from "geojson";
import JSZip from "jszip";
import {
  type FilterSpecification,
  type GeoJSONSource,
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import {
  api,
  type Booking,
  type NetworkAsset,
  type NetworkAssetPage,
  networkQueryKeys,
} from "../../lib/api";
import {
  addAtlasMapIcons,
  assetFeatures,
  assetIconCategory,
  cableLengthMeters,
  legendStyle,
  loadNetworkMapIcons,
} from "./networkMap";
import { SegmentRelations } from "./SegmentRelations";
import { registerSatelliteTiles } from "./satelliteTiles";

type Coordinate = [number, number];
const indonesiaBounds: [[number, number], [number, number]] = [
  [94, -12],
  [142, 7],
];
type MapProvinceOption = {
  code: string;
  name: string;
  assetCount: number;
  folderCount: number;
  bounds: [number, number, number, number] | null;
};
type MapProvinceResponse = {
  items: MapProvinceOption[];
};
type MapImportPackage = {
  id: string;
  name: string;
  importedCount: number;
  segmentCount: number;
  ftthFolderCount: number;
  folderPaths: string[];
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
};
type RouteLine = Feature<
  LineString,
  {
    id: string;
    name: string;
    status: "preview" | "saved";
  }
>;
type SelectMode = "idle" | "start" | "waypoint" | "end";
const networkXlsxHeaders = [
  "Nama",
  "Tipe Aset",
  "Area",
  "Tipe Kabel",
  "Jumlah Core",
  "Metode Instalasi",
  "Sisi Jalan",
  "Tinggi Tiang",
  "Nomor Tiang",
  "ODC",
  "ODP",
  "Geometry GeoJSON",
];
function buildNetworkWorkbook(assets: NetworkAsset[] = []) {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("Data Jaringan");
  data.addRow(networkXlsxHeaders);
  data.columns = [
    { width: 32 },
    { width: 16 },
    { width: 22 },
    { width: 20 },
    { width: 14 },
    { width: 20 },
    { width: 14 },
    { width: 14 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 68 },
  ];
  data.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  data.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF3454D1" },
  };
  for (const asset of assets) {
    if (!asset.geometry) {
      continue;
    }
    data.addRow([
      asset.name,
      asset.assetType === "segment" ? "Segmen" : "Aset",
      asset.area,
      asset.cableType,
      asset.totalCores,
      asset.installation,
      asset.side,
      asset.poleHeight,
      asset.pole,
      asset.odc,
      asset.odp,
      JSON.stringify(asset.geometry),
    ]);
  }
  const guide = workbook.addWorksheet("Petunjuk");
  guide.addRows([
    ["Impor Jaringan ATLAS"],
    [
      "Isi satu baris untuk setiap aset. Kolom Nama dan Geometry GeoJSON wajib.",
    ],
    [
      "Tipe Aset: Segmen untuk kabel, Aset untuk tiang/ODC/ODP. Jika kosong, tipe geometri menentukan jenis.",
    ],
    [
      "Geometry GeoJSON wajib berupa geometri GeoJSON; semua koordinat memakai urutan longitude, latitude.",
    ],
    ['Contoh titik: {"type":"Point","coordinates":[106.8,-6.2]}'],
    [
      'Contoh kabel: {"type":"LineString","coordinates":[[106.8,-6.2],[106.81,-6.21]]}',
    ],
    [
      "Jumlah Core berupa bilangan 0–4096. Metode Instalasi: Aerial atau Burial. Sisi Jalan: Kiri atau Kanan.",
    ],
    ["Tinggi Tiang: 7 m atau 9 m. Ukuran file maksimal 10 MB dan 10.000 aset."],
  ]);
  guide.getColumn(1).width = 112;
  return workbook;
}
function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function xmlEscape(value: unknown) {
  return String(value ?? "").replace(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[char]!
  );
}
function kmlCoordinate(position: Position) {
  return position.join(",");
}
function kmlCoordinates(positions: Position[]) {
  return positions.map(kmlCoordinate).join(" ");
}
function kmlPolygon(rings: Position[][]) {
  const [outer, ...inner] = rings;
  if (!outer) {
    return "";
  }
  const ring = (points: Position[]) =>
    `<LinearRing><coordinates>${kmlCoordinates(points)}</coordinates></LinearRing>`;
  return `<Polygon><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${inner.map((points) => `<innerBoundaryIs>${ring(points)}</innerBoundaryIs>`).join("")}</Polygon>`;
}
function kmlGeometry(geometry: Geometry): string {
  switch (geometry.type) {
    case "Point":
      return `<Point><coordinates>${kmlCoordinate(geometry.coordinates)}</coordinates></Point>`;
    case "MultiPoint":
      return `<MultiGeometry>${geometry.coordinates.map((coordinates) => kmlGeometry({ type: "Point", coordinates })).join("")}</MultiGeometry>`;
    case "LineString":
      return `<LineString><coordinates>${kmlCoordinates(geometry.coordinates)}</coordinates></LineString>`;
    case "MultiLineString":
      return `<MultiGeometry>${geometry.coordinates.map((coordinates) => kmlGeometry({ type: "LineString", coordinates })).join("")}</MultiGeometry>`;
    case "Polygon":
      return kmlPolygon(geometry.coordinates);
    case "MultiPolygon":
      return `<MultiGeometry>${geometry.coordinates.map(kmlPolygon).join("")}</MultiGeometry>`;
    case "GeometryCollection":
      return `<MultiGeometry>${geometry.geometries.map(kmlGeometry).join("")}</MultiGeometry>`;
  }
}
function networkKml(assets: NetworkAsset[]) {
  const placemarks = assets
    .flatMap((asset) => {
      if (!asset.geometry) {
        return [];
      }
      const fields: Array<[string, unknown]> = [
        ["asset_type", asset.assetType],
        ["area", asset.area],
        ["source", asset.source],
        ["cable_type", asset.cableType],
        ["total_cores", asset.totalCores],
        ["installation", asset.installation],
        ["side", asset.side],
        ["pole", asset.pole],
        ["pole_height", asset.poleHeight],
        ["odc", asset.odc],
        ["odp", asset.odp],
      ];
      const data = fields
        .filter(
          ([, value]) => value !== null && value !== undefined && value !== ""
        )
        .map(
          ([name, value]) =>
            `<Data name="${name}"><value>${xmlEscape(value)}</value></Data>`
        )
        .join("");
      return [
        `<Placemark><name>${xmlEscape(asset.name)}</name><ExtendedData>${data}</ExtendedData>${kmlGeometry(asset.geometry)}</Placemark>`,
      ];
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>ATLAS - Data Jaringan</name>${placemarks}</Document></kml>`;
}
function ftthDesignGroupId(asset: NetworkAsset) {
  if (typeof asset.attributes?.ftthDesignId === "string") {
    return asset.attributes.ftthDesignId;
  }
  return asset.attributes?.source === "ftth-design" && asset.createdAt
    ? `legacy:${asset.createdAt}`
    : undefined;
}
function iconPreview(category: string) {
  const shapes: Record<string, string> = {
    POLE: "shaded_dot.png",
    POP: "arrow.png",
    OLT: "arrow.png",
    OTB: "arrow.png",
    ODC: "square.png",
    ODP: "triangle.png",
    JC: "forbidden.png",
    SLACK: "target.png",
    HANDHOLE: "square.png",
    MANHOLE: "square.png",
  };
  if (shapes[category]) {
    return (
      <img
        alt=""
        className="map-icon-preview"
        height={18}
        src={`https://maps.google.com/mapfiles/kml/shapes/${shapes[category]}`}
        width={18}
      />
    );
  }
  const icons: Record<string, [string, string]> = {
    OLT: ["bi-hdd-network-fill", "#2864d7"],
    OTB: ["bi-box-fill", "#00aabb"],
    ODC: ["bi-square-fill", "#f28c28"],
    ODP: ["bi-triangle-fill", "#8b4513"],
    POLE: ["bi-signpost-2-fill", "#c5a900"],
    JC: ["bi-record-circle-fill", "#f28c28"],
    HANDHOLE: ["bi-square-fill", "#8993a3"],
    MANHOLE: ["bi-square-fill", "#202124"],
    POP: ["bi-arrow-up-right-circle-fill", "#e8b500"],
    ODF: ["bi-grid-3x3-gap-fill", "#684fc7"],
    SLACK: ["bi-bullseye", "#e53935"],
    FDT: ["bi-diagram-3-fill", "#e75b3c"],
    OFP: ["bi-box-fill", "#178c80"],
    "TERMINAL BOX": ["bi-box-fill", "#3280c8"],
    LAINNYA: ["bi-geo-alt-fill", "#3454d1"],
  };
  const [icon, color] = icons[category] ?? ["bi-geo-alt-fill", "#3454d1"];
  return (
    <i
      aria-hidden="true"
      className={`bi ${icon} map-icon-preview`}
      style={{ color }}
    />
  );
}
const lineCollection = (
  features: Feature<Geometry, Record<string, unknown>>[]
): FeatureCollection<Geometry> => ({ type: "FeatureCollection", features });
const routeCollection = (
  features: RouteLine[]
): FeatureCollection<LineString> => ({ type: "FeatureCollection", features });
const normalizeProvinceBoundaryName = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLocaleLowerCase("id-ID")
    .replace(/^(provinsi|province|propinsi)\s+/iu, "")
    .replace(/\s+(province|provinsi|propinsi)$/iu, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "");
const provinceBoundaryAliases: Record<string, string[]> = {
  "12": ["sumatera utara", "north sumatra", "north sumatera"],
  "36": ["banten", "probanten"],
  "31": ["dki jakarta", "jakarta", "daerah khusus ibukota jakarta"],
  "32": ["jawa barat", "west java"],
};
const pointCollection = (points: Coordinate[]): FeatureCollection<Point> => ({
  type: "FeatureCollection",
  features: points.map((coordinates, index) => ({
    type: "Feature",
    properties: { index },
    geometry: { type: "Point", coordinates },
  })),
});
function addBoundsCoordinates(bounds: LngLatBounds, coordinates: unknown) {
  if (!Array.isArray(coordinates)) {
    return;
  }
  if (
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
  ) {
    bounds.extend([coordinates[0], coordinates[1]]);
  } else {
    for (const entry of coordinates) {
      addBoundsCoordinates(bounds, entry);
    }
  }
}
function geometryBounds(geometry: Geometry, bounds: LngLatBounds) {
  if (geometry.type === "GeometryCollection") {
    for (const child of geometry.geometries) {
      geometryBounds(child, bounds);
    }
  } else {
    addBoundsCoordinates(bounds, geometry.coordinates);
  }
}
function nearestPointFeature(
  map: MapLibreMap,
  point: {
    x: number;
    y: number;
  }
) {
  const nearby = map.queryRenderedFeatures([point.x, point.y], {
    layers: ["network-point-hit", "network-icons"],
  });
  const points = nearby.filter(
    (
      feature
    ): feature is (typeof nearby)[number] & {
      geometry: Point;
    } => feature.geometry.type === "Point"
  );
  return points.sort((a, b) => {
    const distance = (feature: typeof a) => {
      const projected = map.project(feature.geometry.coordinates as Coordinate);
      return (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
    };
    return distance(a) - distance(b);
  })[0];
}
function pointFeatureAtCursor(
  map: MapLibreMap,
  point: {
    x: number;
    y: number;
  }
) {
  const features = map
    .queryRenderedFeatures([point.x, point.y], { layers: ["network-icons"] })
    .filter(
      (
        feature
      ): feature is typeof feature & {
        geometry: Point;
      } => feature.geometry.type === "Point"
    );
  return features.sort((a, b) => {
    const distance = (feature: typeof a) => {
      const projected = map.project(feature.geometry.coordinates as Coordinate);
      return (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
    };
    return distance(a) - distance(b);
  })[0];
}
function firstCoordinate(geometry: NetworkAsset["geometry"]): Coordinate {
  if (!geometry) {
    return [106.79, -6.26];
  }
  if (geometry.type === "Point") {
    return geometry.coordinates as Coordinate;
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates[0] as Coordinate;
  }
  if (geometry.type === "MultiLineString") {
    return (geometry.coordinates[0]?.[0] as Coordinate) ?? [106.79, -6.26];
  }
  if (geometry.type === "Polygon") {
    return (geometry.coordinates[0]?.[0] as Coordinate) ?? [106.79, -6.26];
  }
  if (geometry.type === "MultiPoint") {
    return (geometry.coordinates[0] as Coordinate) ?? [106.79, -6.26];
  }
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates[0]?.[0]?.[0] as Coordinate) ?? [106.79, -6.26];
  }
  const child = geometry.geometries.find(
    (item) => item.type !== "GeometryCollection"
  );
  return child ? firstCoordinate(child) : [106.79, -6.26];
}
function matchesAssetSearch(asset: NetworkAsset, query: string) {
  if (!query) {
    return true;
  }
  const searchable = [
    asset.name,
    asset.area,
    asset.cableType,
    asset.assetType,
    asset.pole,
    asset.odc,
    asset.odp,
    ...Object.entries(asset.attributes ?? {})
      .flatMap(([key, value]) => [key, value])
      .filter(
        (value) => typeof value === "string" || typeof value === "number"
      ),
  ]
    .map((value) => String(value ?? "").toLocaleLowerCase("id-ID"))
    .join(" ");
  return searchable.includes(query);
}
function SegmentCoreSummary({ asset }: { asset: NetworkAsset }) {
  if (asset.assetType !== "segment") {
    return null;
  }
  if (!asset.totalCores) {
    return <small className="segment-core-empty">Core belum diisi</small>;
  }
  const verified = isCoreUsageVerified(asset);
  return (
    <span className="segment-core-summary">
      <span>{asset.totalCores.toLocaleString("id-ID")} total</span>
      <span className="core-used">
        {asset.usedCores.toLocaleString("id-ID")} terpakai
      </span>
      <span className="core-booked">
        {asset.bookedCores.toLocaleString("id-ID")} dibooking
      </span>
      {verified && (
        <span className="core-available">
          {asset.idleCores.toLocaleString("id-ID")} tersedia
        </span>
      )}
    </span>
  );
}
function isCoreUsageVerified(asset: NetworkAsset) {
  const verification = asset.attributes?.__coreUsageVerification;
  return (
    asset.source === "managed" ||
    (verification &&
      typeof verification === "object" &&
      (verification as Record<string, unknown>).verified === true) ||
    asset.attributes?.__coreUsageVerified === true
  );
}
function VerificationStatus({ asset }: { asset: NetworkAsset }) {
  if (asset.assetType !== "segment") {
    return null;
  }
  const verified = isCoreUsageVerified(asset);
  return (
    <small className={`ms-2 ${verified ? "text-success" : "text-warning"}`}>
      {verified ? "Terverifikasi" : "Belum terverifikasi"}
    </small>
  );
}
export function MapPage() {
  const mapImportsQuery = useQuery({
    queryKey: ["network-map-imports"],
    queryFn: () => api<MapImportPackage[]>("/assets/imports"),
    staleTime: 30_000,
  });
  const mapProvincesQuery = useQuery({
    queryKey: ["network-map-provinces"],
    queryFn: () =>
      api<MapProvinceResponse>("/assets/provinces", { timeout: 30_000 }),
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const [provinceCode, setProvinceCode] = useState("");
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([]);
  const [activeImportId, setActiveImportId] = useState("");
  const [globeEnabled, setGlobeEnabled] = useState(true);
  const [satelliteEnabled, setSatelliteEnabled] = useState(false);
  const previousMapView = useRef<{
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } | null>({ center: [118, -2.5], zoom: 5.3, bearing: 0, pitch: 0 });
  const packageMenuRef = useRef<HTMLDetailsElement>(null);
  const packageBoundsRequest = useRef(0);
  const selectedImportPackages = (mapImportsQuery.data ?? []).filter((item) =>
    selectedImportIds.includes(item.id)
  );
  const activeImportPackage =
    selectedImportPackages.find((item) => item.id === activeImportId) ??
    selectedImportPackages[selectedImportPackages.length - 1];
  const [provincePickMessage, setProvincePickMessage] = useState("");
  const provinces = mapProvincesQuery.data?.items ?? [];
  const selectedProvince = provinces.find(
    (province) => province.code === provinceCode
  );
  const selectedProvinceCodeRef = useRef(provinceCode);
  selectedProvinceCodeRef.current = provinceCode;
  const [assetPage, setAssetPage] = useState(1);
  const [search, setSearch] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [coreFilter, setCoreFilter] = useState("all");
  const [coreVerificationSource, setCoreVerificationSource] =
    useState("Survei lapangan");
  const [coreVerificationNote, setCoreVerificationNote] = useState("");
  const catalogQuery = useQuery({
    queryKey: [
      "segment-catalog",
      assetPage,
      catalogSearch,
      coreFilter,
      provinceCode,
      selectedImportIds,
    ],
    queryFn: () =>
      api<NetworkAssetPage>(
        `/assets/catalog?page=${assetPage}&pageSize=50&search=${encodeURIComponent(catalogSearch)}&coreFilter=${coreFilter}${selectedImportIds.length ? `&importIds=${selectedImportIds.join(",")}` : ""}${provinceCode ? `&provinceCode=${provinceCode}` : ""}`
      ),
    enabled: Boolean(provinceCode && selectedImportIds.length),
    refetchInterval: 30_000,
  });
  const networkSegments =
    provinceCode && selectedImportIds.length
      ? (catalogQuery.data?.items ?? [])
      : [];
  const [mapBounds, setMapBounds] = useState<
    [number, number, number, number] | null
  >(null);
  const [mapZoom, setMapZoom] = useState(4);
  const mapAssetsQuery = useQuery({
    queryKey: [
      "map-assets",
      mapBounds,
      mapZoom,
      provinceCode,
      selectedImportIds,
    ],
    queryFn: ({ signal }) =>
      api<NetworkAsset[]>(
        `/assets/map?bbox=${mapBounds!.join(",")}&zoom=${mapZoom}${selectedImportIds.length ? `&importIds=${selectedImportIds.join(",")}` : ""}${provinceCode ? `&provinceCode=${provinceCode}` : ""}`,
        { signal, timeout: 30_000 }
      ),
    retry: 0,
    enabled: Boolean(mapBounds && provinceCode && selectedImportIds.length),
    staleTime: 20_000,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[3] === provinceCode &&
      JSON.stringify(previousQuery?.queryKey[4]) ===
        JSON.stringify(selectedImportIds)
        ? previousData
        : undefined,
  });
  const {
    data: bookings = [],
    isPending: bookingsPending,
    isError: bookingsError,
  } = useQuery({
    queryKey: ["bookings"],
    queryFn: () => api<Booking[]>("/bookings"),
    refetchInterval: 30_000,
  });
  const queryClient = useQueryClient();
  const invalidateNetwork = () =>
    Promise.all(
      networkQueryKeys.map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] })
      )
    );
  const mapElement = useRef<HTMLElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const skipProvinceFitRef = useRef(false);
  const hoverPopup = useRef<Popup | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const iconFilter = useRef<HTMLDetailsElement>(null);
  const assetDetails = useRef<HTMLDetailsElement>(null);
  const modeRef = useRef<SelectMode>("idle");
  const pointsRef = useRef<Coordinate[]>([]);
  const provincesRef = useRef(provinces);
  provincesRef.current = provinces;
  const [selectedId, setSelectedId] = useState<string>("");
  const [confirmedRoutes, setConfirmedRoutes] = useState<RouteLine[]>([]);
  const [routePreview, setRoutePreview] = useState<RouteLine | null>(null);
  const [routePoints, setRoutePoints] = useState<Coordinate[]>([]);
  const [mode, setMode] = useState<SelectMode>("idle");
  const [mapError, setMapError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [selectedIconCategories, setSelectedIconCategories] = useState<
    string[] | null
  >(() => {
    try {
      const saved = localStorage.getItem("atlas-map-icon-categories-v2");
      if (saved === null) {
        return null;
      }
      const parsed: unknown = JSON.parse(saved);
      return Array.isArray(parsed) &&
        parsed.every((category) => typeof category === "string")
        ? parsed
        : null;
    } catch {
      return null;
    }
  });
  const [iconCategorySearch, setIconCategorySearch] = useState("");
  const [fileError, setFileError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importAttemptName, setImportAttemptName] = useState("");
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileImportCount, setFileImportCount] = useState<number | null>(null);
  const [fileImportSegmentCount, setFileImportSegmentCount] = useState<
    number | null
  >(null);
  const [fileImportFolderCount, setFileImportFolderCount] = useState<
    number | null
  >(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeDistance, setRouteDistance] = useState<number | null>(null);
  const [assetPopup, setAssetPopup] = useState<NetworkAsset | null>(null);
  const [popupAnchor, setPopupAnchor] = useState<Coordinate | null>(null);
  const [popupPosition, setPopupPosition] = useState({ left: 12, top: 54 });
  const popupElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const instance = map.current;
    const element = popupElement.current;
    if (!(instance && element && assetPopup && popupAnchor)) {
      return;
    }
    const position = () => {
      const point = instance.project(popupAnchor);
      const container = instance.getContainer();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left =
        point.x + width + 20 < container.clientWidth
          ? point.x + 18
          : point.x - width - 18;
      setPopupPosition({
        left: Math.max(12, Math.min(left, container.clientWidth - width - 12)),
        top: Math.max(
          54,
          Math.min(point.y - height / 2, container.clientHeight - height - 12)
        ),
      });
    };
    position();
    instance.on("move", position);
    instance.on("resize", position);
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => {
      instance.off("move", position);
      instance.off("resize", position);
      observer.disconnect();
    };
  }, [assetPopup, popupAnchor]);
  const [fileModal, setFileModal] = useState<"import" | "download" | null>(
    null
  );
  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: () =>
      api<{
        role: string;
      }>("/me"),
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAssetPage(1);
      setCatalogSearch(search.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const knownAssets = useMemo(
    () => [
      ...new Map(
        [...networkSegments, ...(mapAssetsQuery.data ?? [])].map((asset) => [
          asset.id,
          asset,
        ])
      ).values(),
    ],
    [networkSegments, mapAssetsQuery.data]
  );
  const knownAssetsRef = useRef(knownAssets);
  knownAssetsRef.current = knownAssets;
  const allNetworkFeatures = useMemo(
    () =>
      assetFeatures(
        provinceCode && selectedImportIds.length
          ? (mapAssetsQuery.data ?? [])
          : []
      ),
    [mapAssetsQuery.data, selectedImportIds.length, provinceCode]
  );
  const iconCategoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of mapAssetsQuery.data ?? []) {
      if (asset.geometryType?.toUpperCase() === "POINT") {
        const category = assetIconCategory(asset);
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b, "id"));
  }, [mapAssetsQuery.data]);
  const activeIconCategories = useMemo(
    () =>
      selectedIconCategories ??
      iconCategoryCounts.map(([category]) => category),
    [selectedIconCategories, iconCategoryCounts]
  );
  useEffect(() => {
    if (selectedIconCategories === null) {
      localStorage.removeItem("atlas-map-icon-categories-v2");
    } else {
      localStorage.setItem(
        "atlas-map-icon-categories-v2",
        JSON.stringify(selectedIconCategories)
      );
    }
  }, [selectedIconCategories]);
  const shapeFeatures = useMemo(
    () =>
      lineCollection(
        allNetworkFeatures.filter(
          (feature) => feature.geometry.type !== "Point"
        )
      ),
    [allNetworkFeatures]
  );
  const pointFeatures = useMemo(
    () =>
      lineCollection(
        allNetworkFeatures.filter(
          (feature) =>
            feature.geometry.type === "Point" &&
            activeIconCategories.includes(
              String(feature.properties.iconCategory)
            )
        )
      ),
    [allNetworkFeatures, activeIconCategories]
  );
  const routeFeatures = useMemo(
    () =>
      routeCollection([
        ...confirmedRoutes,
        ...(routePreview ? [routePreview] : []),
      ]),
    [confirmedRoutes, routePreview]
  );
  const routePointFeatures = useMemo(
    () => pointCollection(routePoints),
    [routePoints]
  );
  const selectedAsset =
    knownAssets.find((item) => item.id === selectedId) ??
    knownAssets.find((item) => ftthDesignGroupId(item)) ??
    networkSegments[0];
  const selectedDraftId = selectedAsset
    ? ftthDesignGroupId(selectedAsset)
    : undefined;
  const selectedDraftDesignAnchor = selectedDraftId
    ? knownAssets.find(
        (asset) =>
          ftthDesignGroupId(asset) === selectedDraftId &&
          asset.attributes?.designAnchor === true
      )
    : undefined;
  const selectedDraftOlt = selectedDraftId
    ? knownAssets.find(
        (asset) =>
          ftthDesignGroupId(asset) === selectedDraftId &&
          (String(asset.attributes?.assetKind ?? "").toUpperCase() === "OLT" ||
            /^OLT(?:\b|\s|·)/iu.test(asset.name))
      )
    : undefined;
  const selectedDraftAnchor =
    selectedDraftDesignAnchor ??
    selectedDraftOlt ??
    (selectedDraftId ? selectedAsset : undefined);
  const selectedDraftOltGeometry = useQuery({
    queryKey: ["asset-geometry", selectedDraftAnchor?.id],
    queryFn: () =>
      api<{
        geometry: Geometry | null;
      }>(`/assets/${selectedDraftAnchor!.id}/geometry`),
    enabled: Boolean(selectedDraftAnchor),
    staleTime: 60_000,
  });
  const draftRadiusMeters =
    Number(
      selectedDraftDesignAnchor?.attributes?.coverageRadiusMeters ??
        selectedDraftOlt?.attributes?.coverageRadiusMeters
    ) || 500;
  const draftBoundary = useMemo<Feature<
    Polygon,
    Record<string, unknown>
  > | null>(() => {
    const geometry =
      selectedDraftAnchor?.geometry ?? selectedDraftOltGeometry.data?.geometry;
    if (!geometry) {
      return null;
    }
    const [longitude, latitude] = firstCoordinate(geometry);
    const coordinates = Array.from({ length: 65 }, (_, index) => {
      const bearing = (index / 64) * 2 * Math.PI,
        distance = draftRadiusMeters / 6_371_008.8;
      const lat1 = (latitude * Math.PI) / 180,
        lon1 = (longitude * Math.PI) / 180;
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
      return [(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI] as Coordinate;
    });
    coordinates[64] = coordinates[0];
    return {
      type: "Feature",
      properties: { radiusMeters: draftRadiusMeters },
      geometry: { type: "Polygon", coordinates: [coordinates] },
    };
  }, [
    selectedDraftAnchor,
    selectedDraftOltGeometry.data?.geometry,
    draftRadiusMeters,
  ]);
  const selectedSegment =
    selectedAsset?.assetType === "segment" ? selectedAsset : undefined;
  const selectedLegend = selectedAsset ? legendStyle(selectedAsset) : undefined;
  const selectedSegmentGeometry = useQuery({
    queryKey: ["asset-geometry", selectedSegment?.id],
    queryFn: () =>
      api<{
        geometry: Geometry | null;
      }>(`/assets/${selectedSegment!.id}/geometry`),
    enabled: Boolean(selectedSegment),
    staleTime: 60_000,
  });
  const selectedCableGeometry =
    selectedSegmentGeometry.data?.geometry ?? selectedSegment?.geometry ?? null;
  const selectedImported =
    selectedAsset && selectedAsset.assetType !== "segment"
      ? selectedAsset
      : undefined;
  const imported = networkSegments.filter((item) => item.source !== "managed");
  const selectedName = selectedAsset?.name ?? "Pilih aset jaringan";
  const utilization = (item: NetworkAsset) =>
    item.totalCores
      ? Math.round(
          ((item.usedCores + item.bookedCores) / item.totalCores) * 100
        )
      : 0;
  const coresQuery = useQuery({
    queryKey: ["cores", selectedSegment?.id],
    queryFn: () =>
      api<
        {
          coreNumber: number;
          status: "Available" | "Booked" | "Used";
          customer?: string;
          picCustomer?: string;
          picPresales?: string;
          expiresAt?: string;
        }[]
      >(`/assets/${selectedSegment?.id}/cores`),
    enabled: Boolean(selectedSegment),
    refetchInterval: 30_000,
  });
  const updateCore = useMutation({
    mutationFn: ({
      coreNumber,
      status,
    }: {
      coreNumber: number;
      status: "Available" | "Used";
    }) =>
      api(`/assets/${selectedSegment?.id}/cores/${coreNumber}`, {
        method: "PATCH",
        data: { status },
      }),
    onSuccess: async () =>
      Promise.all([
        invalidateNetwork(),
        queryClient.invalidateQueries({
          queryKey: ["cores", selectedSegment?.id],
        }),
      ]),
  });
  const verifyCoreUsage = useMutation({
    mutationFn: () =>
      api<{
        verifiedAt: string;
      }>(`/assets/${selectedSegment?.id}/cores/verify`, {
        method: "POST",
        data: { source: coreVerificationSource, note: coreVerificationNote },
      }),
    onSuccess: async () => {
      setCoreVerificationNote("");
      await Promise.all([
        invalidateNetwork(),
        queryClient.invalidateQueries({
          queryKey: ["cores", selectedSegment?.id],
        }),
      ]);
    },
  });
  const updateAsset = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api(`/assets/${id}`, { method: "PATCH", data }),
    onSuccess: (_, { id }) => {
      if (selectedSegment?.id === id && assetDetails.current) {
        assetDetails.current.open = false;
      }
      return invalidateNetwork();
    },
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedSegment?.id is the trigger: clear mutation state when the selection changes
  useEffect(() => {
    updateCore.reset();
    updateAsset.reset();
  }, [selectedSegment?.id, updateCore.reset, updateAsset.reset]);
  const normalizedSearch = search.trim().toLocaleLowerCase("id-ID");
  const filteredSegments = networkSegments.filter(
    (item) =>
      item.source !== "kml" &&
      item.assetType === "segment" &&
      matchesAssetSearch(item, normalizedSearch)
  );
  const ftthDraftGroups = new Map<string, typeof filteredSegments>();
  const standaloneSegments = filteredSegments.filter((segment) => {
    const groupId = ftthDesignGroupId(segment);
    if (!groupId) {
      return true;
    }
    const group = ftthDraftGroups.get(groupId) ?? [];
    group.push(segment);
    ftthDraftGroups.set(groupId, group);
    return false;
  });
  const getDraftFeatureCount = (groupId: string) =>
    knownAssets.filter((asset) => ftthDesignGroupId(asset) === groupId).length;
  const matchedImported = imported.filter(
    (item) =>
      (item.source === "kml" || item.assetType !== "segment") &&
      matchesAssetSearch(item, normalizedSearch)
  );
  const filteredImported = matchedImported.slice(0, 100);
  const catalogPageCount = Math.max(
    1,
    Math.ceil(
      (catalogQuery.data?.total ?? 0) / (catalogQuery.data?.pageSize ?? 50)
    )
  );
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !iconFilter.current?.contains(event.target)
      ) {
        iconFilter.current?.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick, true);
  }, []);
  function setSelectionMode(value: SelectMode) {
    modeRef.current = value;
    setMode(value);
  }
  function setPoints(value: Coordinate[]) {
    pointsRef.current = value;
    setRoutePoints(value);
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: create the map once; data reaches its sources through the setData effects below
  useEffect(() => {
    if (!mapElement.current || map.current) {
      return;
    }
    setWorkerUrl(workerUrl);
    registerSatelliteTiles();
    localStorage.removeItem("atlas-map-focus");
    localStorage.removeItem("atlas-map-focus-design");
    const instance = new MapLibreMap({
      container: mapElement.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [118, -2.5],
      zoom: 1.5,
    });
    map.current = instance;
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(mapElement.current);
    instance.addControl(new NavigationControl(), "top-right");
    instance.on("error", () => setMapError(true));
    instance.on("load", () => {
      instance.setProjection({ type: "globe" });
      addAtlasMapIcons(instance);
      const updateBounds = () => {
        const bounds = instance.getBounds();
        const nextBounds = [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ].map((value) => Number(value.toFixed(4))) as [
          number,
          number,
          number,
          number,
        ];
        const nextZoom = Math.floor(instance.getZoom());
        setMapBounds((previous) =>
          previous?.every((value, index) => value === nextBounds[index])
            ? previous
            : nextBounds
        );
        setMapZoom((previous) => (previous === nextZoom ? previous : nextZoom));
      };
      instance.on("moveend", () => {
        clearTimeout(boundsTimer);
        boundsTimer = setTimeout(updateBounds, 450);
      });
      updateBounds();
      instance.addSource("network-shapes", {
        type: "geojson",
        data: shapeFeatures,
      });
      instance.addSource("network-points-data", {
        type: "geojson",
        data: pointFeatures,
        cluster: false,
      });
      instance.addSource("selected-ftth-boundary", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "selected-ftth-boundary-fill",
        type: "fill",
        source: "selected-ftth-boundary",
        paint: { "fill-color": "#3454d8", "fill-opacity": 0.12 },
      });
      instance.addSource("satellite-imagery", {
        type: "raster",
        tiles: ["atlas-satellite://{z}/{x}/{y}"],
        tileSize: 256,
        maxzoom: 23,
        attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      });
      instance.addLayer(
        {
          id: "satellite-imagery",
          type: "raster",
          source: "satellite-imagery",
          layout: { visibility: "none" },
        },
        "selected-ftth-boundary-fill"
      );
      instance.addLayer({
        id: "selected-ftth-boundary-line",
        type: "line",
        source: "selected-ftth-boundary",
        paint: {
          "line-color": "#3454d8",
          "line-width": 2,
          "line-dasharray": [2, 2],
        },
      });
      instance.addLayer({
        id: "network-polygons",
        type: "fill",
        source: "network-shapes",
        filter: [
          "all",
          ["==", ["geometry-type"], "Polygon"],
          ["!=", ["get", "fillEnabled"], false],
        ],
        paint: {
          "fill-color": ["coalesce", ["get", "fillColor"], "#3454d1"],
          "fill-opacity": ["coalesce", ["get", "fillOpacity"], 0.25],
        },
      });
      const visibleLineFilter: FilterSpecification = [
        "any",
        ["==", ["get", "geometryType"], "LineString"],
        [
          "all",
          [
            "in",
            ["get", "geometryType"],
            ["literal", ["Polygon", "MultiPolygon"]],
          ],
          ["!=", ["get", "outlineEnabled"], false],
        ],
      ];
      instance.addLayer({
        id: "network-lines",
        type: "line",
        source: "network-shapes",
        filter: visibleLineFilter,
        paint: {
          "line-color": ["coalesce", ["get", "lineColor"], "#3454d1"],
          "line-width": ["coalesce", ["get", "lineWidth"], 4],
          "line-opacity": ["coalesce", ["get", "lineOpacity"], 0.9],
        },
      });
      instance.addLayer({
        id: "network-hit",
        type: "line",
        source: "network-shapes",
        filter: visibleLineFilter,
        paint: { "line-color": "#3454d1", "line-width": 18, "line-opacity": 0 },
      });
      instance.addLayer({
        id: "network-icons",
        type: "symbol",
        source: "network-points-data",
        filter: [
          "all",
          ["!", ["has", "point_count"]],
          [
            "any",
            ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]],
            ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]],
          ],
        ],
        layout: {
          "icon-image": [
            "coalesce",
            ["image", ["get", "iconImageId"]],
            ["image", ["get", "fallbackIconImageId"]],
            ["image", ["get", "atlasIconId"]],
          ],
          "icon-size": [
            "case",
            ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]],
            ["get", "legendIconScale"],
            ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]],
            [
              "match",
              ["get", "iconCategory"],
              "POLE",
              0.62,
              "OLT",
              0.8,
              "ODC",
              0.8,
              "ODP",
              0.8,
              0.8,
            ],
            [
              "min",
              ["max", ["*", ["coalesce", ["get", "iconScale"], 1], 0.9], 0.9],
              1,
            ],
          ],
          "icon-anchor": ["get", "iconAnchor"],
          "icon-offset": ["get", "iconOffset"],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: { "icon-opacity": ["coalesce", ["get", "iconOpacity"], 1] },
      });
      instance.addLayer({
        id: "network-labels",
        type: "symbol",
        source: "network-points-data",
        filter: [
          "all",
          ["!", ["has", "point_count"]],
          [">", ["get", "legendLabelSize"], 0],
        ],
        layout: {
          "text-field": ["get", "sourceLabel"],
          "text-size": ["*", ["get", "legendLabelSize"], 10],
          "text-font": ["Open Sans Semibold"],
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-allow-overlap": false,
          "text-ignore-placement": false,
        },
        paint: {
          "text-color": ["get", "labelColor"],
          "text-opacity": ["get", "labelOpacity"],
          "text-halo-color": "#333",
          "text-halo-width": 1.5,
        },
      });
      instance.addLayer({
        id: "network-point-hit",
        type: "circle",
        source: "network-points-data",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": 18,
          "circle-color": "#000",
          "circle-opacity": 0,
        },
      });
      instance.addSource("route-lines", {
        type: "geojson",
        data: routeFeatures,
      });
      instance.addLayer({
        id: "saved-routes",
        type: "line",
        source: "route-lines",
        filter: ["==", ["get", "status"], "saved"],
        paint: { "line-color": "#f29b38", "line-width": 5 },
      });
      instance.addLayer({
        id: "preview-route",
        type: "line",
        source: "route-lines",
        filter: ["==", ["get", "status"], "preview"],
        paint: {
          "line-color": "#f29b38",
          "line-width": 5,
          "line-dasharray": [2, 1],
        },
      });
      instance.addSource("route-points", {
        type: "geojson",
        data: routePointFeatures,
      });
      instance.addLayer({
        id: "route-markers",
        type: "circle",
        source: "route-points",
        paint: {
          "circle-radius": 7,
          "circle-color": "#fff",
          "circle-stroke-width": 3,
          "circle-stroke-color": "#f29b38",
        },
      });
      void fetch("/data/indonesia-provinces.geojson")
        .then((response) => response.json())
        .then((data) => {
          if (!map.current || map.current !== instance) {
            return;
          }
          instance.addSource("indonesia-provinces", { type: "geojson", data });
          instance.addLayer({
            id: "province-selection-fill",
            type: "fill",
            source: "indonesia-provinces",
            paint: { "fill-color": "#64748b", "fill-opacity": 0.22 },
          });
          instance.addLayer({
            id: "province-selection-border",
            type: "line",
            source: "indonesia-provinces",
            paint: { "line-color": "#ffffff", "line-width": 2 },
          });
          instance.moveLayer("province-selection-fill", "network-polygons");
          instance.moveLayer("province-selection-border", "network-polygons");
          instance.on("click", "province-selection-fill", (event) => {
            if (modeRef.current !== "idle") {
              return;
            }
            if (
              instance.queryRenderedFeatures(event.point, {
                layers: [
                  "network-icons",
                  "network-lines",
                  "network-hit",
                  "network-polygons",
                  "network-point-hit",
                ],
              }).length
            ) {
              return;
            }
            packageBoundsRequest.current += 1;
            const name = normalizeProvinceBoundaryName(
              String(event.features?.[0]?.properties?.Propinsi ?? "")
            );
            const province = provincesRef.current.find((item) =>
              [item.name, ...(provinceBoundaryAliases[item.code] ?? [])].some(
                (value) => normalizeProvinceBoundaryName(value) === name
              )
            );
            if (!province) {
              setProvincePickMessage(
                "Belum ada aset KMZ yang terpetakan ke provinsi ini. Silakan pilih provinsi lain."
              );
              return;
            }
            setProvincePickMessage("");
            if (province.code === selectedProvinceCodeRef.current) {
              setMapBounds(province.bounds);
              return;
            }
            setSelectedIconCategories(null);
            setMapBounds(province.bounds);
            setSelectedImportIds([]);
            setActiveImportId("");
            setProvinceCode(province.code);
            instance.setPaintProperty(
              "province-selection-fill",
              "fill-opacity",
              [
                "case",
                [
                  "==",
                  ["get", "Propinsi"],
                  event.features?.[0]?.properties?.Propinsi,
                ],
                0,
                0.3,
              ]
            );
          });
          instance.on("mouseenter", "province-selection-fill", () => {
            instance.getCanvas().style.cursor = "pointer";
          });
          instance.on("mouseleave", "province-selection-fill", () => {
            instance.getCanvas().style.cursor = "";
          });
        })
        .catch(() => setMapError(true));
      if (instance.isStyleLoaded()) {
        instance.moveLayer("selected-ftth-boundary-fill");
        instance.moveLayer("selected-ftth-boundary-line");
      }
      instance.on("click", (event) => {
        if (modeRef.current !== "idle") {
          return;
        }
        const features = instance.queryRenderedFeatures(event.point, {
          layers: [
            "network-icons",
            "network-polygons",
            "network-lines",
            "network-hit",
          ],
        });
        const cable = features.find(
          (item) =>
            ["network-lines", "network-hit"].includes(item.layer.id) &&
            ["LineString", "MultiLineString"].includes(
              String(item.properties?.geometryType)
            )
        );
        const boundary = features.find(
          (item) => item.layer.id === "network-polygons"
        );
        const feature =
          cable ??
          pointFeatureAtCursor(instance, event.point) ??
          boundary ??
          nearestPointFeature(instance, event.point) ??
          features[0];
        const id = String(feature?.properties?.id ?? "");
        if (id) {
          setSelectedId(id);
          setPopupAnchor([event.lngLat.lng, event.lngLat.lat]);
          setAssetPopup(
            knownAssetsRef.current.find((asset) => asset.id === id) ?? null
          );
        }
      });
      hoverPopup.current = new Popup({
        closeButton: false,
        closeOnClick: false,
        anchor: "bottom",
        offset: 12,
        maxWidth: "260px",
        className: "network-hover-popup",
      });
      instance.on("mousemove", (event) => {
        const pointFeature = pointFeatureAtCursor(instance, event.point);
        const lineFeature = pointFeature
          ? undefined
          : instance
              .queryRenderedFeatures(event.point, {
                layers: ["network-lines", "network-hit"],
              })
              .find((item) =>
                ["LineString", "MultiLineString"].includes(
                  String(item.properties?.geometryType)
                )
              );
        const feature = pointFeature ?? lineFeature;
        if (!feature) {
          instance.getCanvas().style.cursor = "";
          hoverPopup.current?.remove();
          return;
        }
        instance.getCanvas().style.cursor = "pointer";
        const content = document.createElement("div");
        const title = document.createElement("strong");
        const detail = document.createElement("small");
        const isCluster = false;
        title.textContent = String(feature.properties?.name ?? "Aset jaringan");
        const sourceLabel =
          feature.properties?.source === "kml"
            ? "KML/KMZ"
            : feature.properties?.source === "xlsx"
              ? "Excel"
              : String(feature.properties?.area ?? "Jaringan");
        detail.textContent = isCluster
          ? "Klik untuk melihat lebih dekat"
          : `${sourceLabel} · ${String(feature.properties?.geometryType ?? "Segmen")} · Klik untuk detail`;
        content.append(title, document.createElement("br"), detail);
        if (!isCluster && feature.properties?.assetType === "segment") {
          const cores = document.createElement("small");
          const total = Number(feature.properties.totalCores ?? 0);
          cores.textContent =
            total > 0
              ? `${total} core total · ${Number(feature.properties.usedCores ?? 0)} terpakai · ${Number(feature.properties.bookedCores ?? 0)} dibooking · ${Number(feature.properties.idleCores ?? 0)} tersedia`
              : "Core belum diisi";
          content.append(document.createElement("br"), cores);
        }
        const coordinates: Coordinate =
          isCluster || pointFeature
            ? ((feature.geometry as Point).coordinates as Coordinate)
            : [event.lngLat.lng, event.lngLat.lat];
        hoverPopup.current
          ?.setLngLat(coordinates)
          .setDOMContent(content)
          .addTo(instance);
      });
      setMapReady(true);
    });
    instance.on("click", (event) => {
      if (modeRef.current === "idle") {
        return;
      }
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
      clearTimeout(boundsTimer);
      resizeObserver.disconnect();
      hoverPopup.current?.remove();
      hoverPopup.current = null;
      map.current?.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    const province = provincesRef.current.find(
      (item) => item.code === provinceCode
    );
    if (!(mapReady && province?.bounds)) {
      return;
    }
    if (skipProvinceFitRef.current) {
      skipProvinceFitRef.current = false;
      setAssetPage(1);
      return;
    }
    map.current?.fitBounds(province.bounds, {
      padding: 48,
      maxZoom: 10,
      duration: 1200,
    });
    setAssetPage(1);
    setSelectedId("");
    setAssetPopup(null);
  }, [mapReady, provinceCode]);
  useEffect(() => {
    (
      map.current?.getSource("network-shapes") as GeoJSONSource | undefined
    )?.setData(shapeFeatures);
    (
      map.current?.getSource("network-points-data") as GeoJSONSource | undefined
    )?.setData(pointFeatures);
  }, [shapeFeatures, pointFeatures]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mapReady is the trigger: push a boundary set before the map finished loading
  useEffect(() => {
    (
      map.current?.getSource("selected-ftth-boundary") as
        | GeoJSONSource
        | undefined
    )?.setData({
      type: "FeatureCollection",
      features: draftBoundary ? [draftBoundary] : [],
    });
  }, [draftBoundary, mapReady]);
  useEffect(() => {
    const instance = map.current;
    if (!(instance && mapReady)) {
      return;
    }
    const categoryFilter: FilterSpecification = activeIconCategories.length
      ? ["in", ["get", "iconCategory"], ["literal", activeIconCategories]]
      : ["==", ["get", "iconCategory"], "__NO_ICON_CATEGORY_SELECTED__"];
    const applyFilters = () => {
      if (!instance.isStyleLoaded()) {
        return;
      }
      if (instance.getLayer("network-icons")) {
        instance.setFilter("network-icons", [
          "all",
          [
            "any",
            ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]],
            ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]],
          ],
          categoryFilter,
        ]);
      }
      if (instance.getLayer("network-point-hit")) {
        instance.setFilter("network-point-hit", categoryFilter);
      }
      if (instance.getLayer("network-labels")) {
        instance.setFilter("network-labels", [
          "all",
          [">", ["get", "legendLabelSize"], 0],
          categoryFilter,
        ]);
      }
    };
    if (instance.isStyleLoaded()) {
      applyFilters();
    } else {
      instance.once("idle", applyFilters);
    }
    return () => {
      instance.off("idle", applyFilters);
    };
  }, [mapReady, activeIconCategories]);
  useEffect(() => {
    if (!activeIconCategories.length) {
      const instance = map.current;
      if (!instance) {
        return;
      }
      instance.getCanvas().style.cursor = "";
      hoverPopup.current?.remove();
    }
  }, [activeIconCategories]);
  useEffect(() => {
    (
      map.current?.getSource("route-lines") as GeoJSONSource | undefined
    )?.setData(routeFeatures);
  }, [routeFeatures]);
  useEffect(() => {
    (
      map.current?.getSource("route-points") as GeoJSONSource | undefined
    )?.setData(routePointFeatures);
  }, [routePointFeatures]);
  useEffect(() => {
    const instance = map.current;
    if (!(instance && mapReady)) {
      return;
    }
    return loadNetworkMapIcons(instance, allNetworkFeatures);
  }, [allNetworkFeatures, mapReady]);
  async function importFile(file?: File) {
    if (!file) {
      return;
    }
    setImporting(true);
    setImportAttemptName(file.name);
    try {
      setFileError("");
      const form = new FormData();
      form.append("file", file);
      const response = await api<{
        importedCount: number;
        segmentCount: number;
        ftthFolderCount: number;
        folderPaths: string[];
        firstId?: string;
        importId: string;
        bounds: [number, number, number, number] | null;
      }>("/assets/import", { method: "POST", data: form });
      setFileName(file.name);
      setFileImportCount(response.importedCount);
      setFileImportSegmentCount(response.segmentCount);
      setFileImportFolderCount(response.folderPaths.length);
      const packageIds = [
        ...new Set([...selectedImportIds, response.importId]),
      ];
      setSelectedImportIds(packageIds);
      setActiveImportId(response.importId);
      await queryClient.invalidateQueries({
        queryKey: ["network-map-imports"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["network-map-provinces"],
      });
      await invalidateNetwork();
      setSelectedId(response.firstId ?? "");
      if (response.firstId) {
        const { bounds } = await api<{
          bounds: [number, number, number, number] | null;
        }>(
          `/assets/bounds?importIds=${packageIds.join(",")}${provinceCode ? `&provinceCode=${provinceCode}` : ""}`
        );
        if (bounds && map.current) {
          setMapBounds(bounds);
          map.current.fitBounds(bounds, {
            padding: 64,
            maxZoom: 12,
            duration: 500,
          });
        } else {
          await focusGeometry(response.firstId);
        }
      }
    } catch (error) {
      setFileError(
        error instanceof Error ? error.message : "File tidak dapat dibaca."
      );
    } finally {
      setImporting(false);
    }
  }
  function toggleMapPackage(id: string) {
    const request = ++packageBoundsRequest.current;
    const isSelected = selectedImportIds.includes(id);
    const next = isSelected
      ? selectedImportIds.filter((item) => item !== id)
      : [...selectedImportIds, id];
    setSelectedImportIds(next);
    setSelectedId("");
    setAssetPopup(null);
    setSelectedIconCategories(null);
    setAssetPage(1);
    if (isSelected) {
      if (activeImportId === id) {
        setActiveImportId(next[next.length - 1] ?? "");
      }
    } else {
      setActiveImportId(id);
    }
    if (!next.length) {
      setMapBounds(null);
      return;
    }
    void api<{
      bounds: [number, number, number, number] | null;
    }>(
      `/assets/bounds?importIds=${next.join(",")}${provinceCode ? `&provinceCode=${provinceCode}` : ""}`
    )
      .then(({ bounds }) => {
        if (request === packageBoundsRequest.current && bounds && map.current) {
          setMapBounds(bounds);
          map.current.fitBounds(bounds, {
            padding: 64,
            maxZoom: 12,
            duration: 500,
          });
        }
      })
      .catch(() => {
        if (request === packageBoundsRequest.current) {
          setFileError("Batas paket peta gagal dimuat.");
        }
      });
  }
  async function downloadNetworkFile(format: "kml" | "kmz" | "xlsx") {
    setExporting(true);
    setFileError("");
    try {
      const boundsQuery = activeImportId
        ? `?importId=${encodeURIComponent(activeImportId)}`
        : provinceCode
          ? `?provinceCode=${encodeURIComponent(provinceCode)}`
          : "";
      const { bounds } = await api<{
        bounds: [number, number, number, number] | null;
      }>(`/assets/bounds${boundsQuery}`);
      if (!bounds) {
        throw new Error("Belum ada aset jaringan untuk diunduh.");
      }
      const padding = 0.000_001;
      const bbox = [
        Math.max(-180, bounds[0] - padding),
        Math.max(-90, bounds[1] - padding),
        Math.min(180, bounds[2] + padding),
        Math.min(90, bounds[3] + padding),
      ].join(",");
      const assets = await api<NetworkAsset[]>(
        `/assets/map?bbox=${bbox}&zoom=24${activeImportId ? `&importId=${encodeURIComponent(activeImportId)}` : provinceCode ? `&provinceCode=${encodeURIComponent(provinceCode)}` : ""}`
      );
      if (!assets.some((asset) => asset.geometry)) {
        throw new Error("Belum ada geometri aset jaringan untuk diunduh.");
      }
      const baseName = `atlas-data-jaringan${
        selectedProvince
          ? `-${selectedProvince.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/gu, "-")
              .replace(/^-|-$/gu, "")}`
          : ""
      }`;
      if (format === "xlsx") {
        const buffer = await buildNetworkWorkbook(assets).xlsx.writeBuffer();
        downloadBlob(
          new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
          `${baseName}.xlsx`
        );
      } else {
        const kml = networkKml(assets);
        if (format === "kml") {
          downloadBlob(
            new Blob([kml], {
              type: "application/vnd.google-earth.kml+xml;charset=utf-8",
            }),
            `${baseName}.kml`
          );
        } else {
          const archive = new JSZip();
          archive.file("doc.kml", kml);
          downloadBlob(
            await archive.generateAsync({
              type: "blob",
              compression: "DEFLATE",
            }),
            `${baseName}.kmz`
          );
        }
      }
      setFileModal(null);
    } catch (error) {
      setFileError(
        error instanceof Error ? error.message : "File peta tidak dapat dibuat."
      );
    } finally {
      setExporting(false);
    }
  }
  function saveAssetDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSegment) {
      return;
    }
    const form = new FormData(event.currentTarget);
    updateAsset.mutate({
      id: selectedSegment.id,
      data: {
        area: String(form.get("area")),
        cableType: String(form.get("cableType")),
        totalCores: Number(form.get("totalCores")),
        installation: String(form.get("installation")),
        side: String(form.get("side")),
      },
    });
  }
  async function previewRoute() {
    if (routePoints.length < 2) {
      return;
    }
    setRouteLoading(true);
    setRouteError("");
    try {
      const payload = await api<{
        geometry?: LineString;
        distanceMeters?: number;
      }>("/routes/preview", {
        method: "POST",
        data: { coordinates: routePoints },
      });
      if (!payload.geometry) {
        throw new Error("Rute jalan tidak dapat dihitung.");
      }
      setRoutePreview({
        type: "Feature",
        id: "route-preview",
        properties: {
          id: "route-preview",
          name: `Pratinjau rute ${confirmedRoutes.length + 1}`,
          status: "preview",
        },
        geometry: payload.geometry,
      });
      setRouteDistance(payload.distanceMeters ?? null);
      setRouteError("");
      const coordinates = payload.geometry.coordinates;
      const first = coordinates[0] as Coordinate;
      map.current?.fitBounds(
        coordinates.reduce(
          (bounds, point) => bounds.extend(point as Coordinate),
          new LngLatBounds(first, first)
        ),
        { padding: 50, maxZoom: 15 }
      );
    } catch (error) {
      setRouteError(
        error instanceof Error
          ? error.message
          : "Layanan routing tidak tersedia."
      );
    } finally {
      setRouteLoading(false);
    }
  }
  function confirmRoute() {
    if (!routePreview) {
      return;
    }
    const id = `route-${Date.now()}`;
    setConfirmedRoutes((current) => [
      ...current,
      {
        ...routePreview,
        id,
        properties: {
          ...routePreview.properties,
          id,
          name: `Rute ${current.length + 1}`,
          status: "saved",
        },
      },
    ]);
    setRoutePreview(null);
    setPoints([]);
    setRouteDistance(null);
  }
  const focusGeometry = async (id: string, existing?: Geometry | null) => {
    if (!map.current) {
      return;
    }
    try {
      const geometry =
        existing ??
        (
          await api<{
            geometry: Geometry | null;
          }>(`/assets/${id}/geometry`)
        ).geometry;
      if (!geometry) {
        return;
      }
      if (geometry.type === "Point") {
        map.current.flyTo({
          center: firstCoordinate(geometry),
          zoom: Math.max(map.current.getZoom(), 16),
          essential: true,
        });
        return;
      }
      const bounds = new LngLatBounds();
      geometryBounds(geometry, bounds);
      if (!bounds.isEmpty()) {
        const camera = map.current.cameraForBounds(bounds, { padding: 64 });
        const currentZoom = map.current.getZoom();
        if (camera) {
          map.current.easeTo({
            ...camera,
            zoom: Math.max(
              currentZoom,
              Math.min(camera.zoom ?? currentZoom, 14)
            ),
            duration: 500,
          });
        }
      }
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
        action={
          <span className="map-legend">
            <span /> Jaringan <span className="imported-legend" /> Data impor{" "}
            <span className="route-legend" /> Rute jalan
          </span>
        }
        subtitle="Jelajahi aset, impor data jaringan, dan rencanakan jalur kabel mengikuti jalan."
        title="Peta jaringan"
      />
      <div className="map-layout">
        <section
          aria-busy={
            !(mapReady || mapError) ||
            (Boolean(provinceCode || selectedImportIds.length) &&
              mapAssetsQuery.isLoading)
          }
          className="map-canvas-wrap"
        >
          <section
            aria-label="Peta jaringan ATLAS"
            className={`map-canvas ${mode === "idle" ? "" : "map-picking"}`}
            ref={mapElement}
          />
          <div
            className="map-province-filter"
          >
            <label
              className="form-label fw-semibold text-uppercase mb-1"
              htmlFor="map-province-filter"
            >
              Pilih provinsi
            </label>
            <select
              className="form-select form-select-sm mb-2"
              disabled={mapProvincesQuery.isPending}
              id="map-province-filter"
              onChange={(event) => {
                const nextProvince = provinces.find(
                  (province) => province.code === event.target.value
                );
                packageBoundsRequest.current += 1;
                setProvincePickMessage("");
                setSelectedIconCategories(null);
                setMapBounds(nextProvince?.bounds ?? null);
                setSelectedImportIds([]);
                setActiveImportId("");
                setProvinceCode(event.target.value);
                if (!nextProvince) {
                  map.current?.flyTo({ center: [118, -2.5], zoom: 5.3 });
                }
                const instance = map.current;
                if (instance?.getLayer("province-selection-fill")) {
                  instance.setPaintProperty(
                    "province-selection-fill",
                    "fill-opacity",
                    nextProvince
                      ? [
                          "case",
                          [
                            "in",
                            ["upcase", ["get", "Propinsi"]],
                            [
                              "literal",
                              [
                                nextProvince.name,
                                ...(provinceBoundaryAliases[
                                  nextProvince.code
                                ] ?? []),
                              ].map((name) => name.toUpperCase()),
                            ],
                          ],
                          0,
                          0.3,
                        ]
                      : 0.22
                  );
                }
              }}
              value={provinceCode}
            >
              <option value="">
                {mapProvincesQuery.isPending
                  ? "Memuat provinsi…"
                  : "Pilih provinsi untuk melihat aset"}
              </option>
              {provinces.map((province) => (
                <option key={province.code} value={province.code}>
                  {province.name} ·{" "}
                  {province.assetCount.toLocaleString("id-ID")} aset
                </option>
              ))}
            </select>
            <small className="d-block">
              Pilih provinsi terlebih dahulu, lalu pilih Map Package untuk
              menampilkan aset.
            </small>
            {provincePickMessage && (
              <small className="text-warning d-block mt-1" role="status">
                {provincePickMessage}
              </small>
            )}
            {selectedProvince && !selectedImportIds.length && (
              <small className="text-muted d-block mt-1">
                {selectedProvince.assetCount.toLocaleString("id-ID")} aset ·{" "}
                {selectedProvince.folderCount.toLocaleString("id-ID")} folder
                KMZ
              </small>
            )}
            {!provinceCode &&
              !selectedImportIds.length &&
              provinces.length > 0 && (
                <small className="text-muted d-block mt-1">
                  Aset jaringan dimuat setelah wilayah provinsi diklik.
                </small>
              )}
            {!mapProvincesQuery.isPending &&
              !mapProvincesQuery.isError &&
              !provinces.length && (
                <small className="text-warning d-block mt-1">
                  Belum ada provinsi yang cocok dengan data KMZ.
                </small>
              )}
            {mapProvincesQuery.isError && (
              <small className="text-danger d-block mt-1">
                Daftar provinsi KMZ gagal dimuat.
              </small>
            )}
          </div>
          {provinceCode && (
            <section aria-label="Map Package" className="map-package-picker">
              <header>
                <b>Map Package</b>
                <button
                  aria-label="Riwayat proses impor"
                  className="map-package-history"
                  onClick={() => {
                    setShowImportHistory(true);
                    void mapImportsQuery.refetch();
                  }}
                  title="Riwayat proses impor"
                  type="button"
                >
                  <i aria-hidden="true" className="bi bi-clock-history" />
                </button>
              </header>
              <p>
                Tampilkan beberapa paket bersama. Pilihan terakhir aktif untuk
                edit dan ekspor.
              </p>
              <details ref={packageMenuRef}>
                <summary>
                  <span title={activeImportPackage?.name}>
                    {activeImportPackage?.name ?? "Pilih paket KMZ"}
                  </span>
                  <i aria-hidden="true" className="bi bi-chevron-down" />
                </summary>
                <div className="map-package-menu">
                  {mapImportsQuery.isPending && <small>Memuat paket…</small>}
                  {mapImportsQuery.isError && (
                    <small className="text-danger">
                      Daftar paket gagal dimuat.
                    </small>
                  )}
                  {!(
                    mapImportsQuery.isPending ||
                    mapImportsQuery.isError ||
                    mapImportsQuery.data?.length
                  ) && (
                    <small>
                      Belum ada paket. Impor file KML/KMZ untuk memulai.
                    </small>
                  )}
                  {mapImportsQuery.data?.map((item) => {
                    const selected = selectedImportIds.includes(item.id);
                    const active = activeImportId === item.id;
                    return (
                      <div
                        className={`map-package-option ${selected ? "selected" : ""}`}
                        key={item.id}
                      >
                        <input
                          aria-label={`Tampilkan ${item.name}`}
                          checked={selected}
                          onChange={() => {
                            toggleMapPackage(item.id);
                            if (packageMenuRef.current) {
                              packageMenuRef.current.open = false;
                            }
                          }}
                          type="checkbox"
                        />
                        <button
                          onClick={() => {
                            if (!selected) {
                              toggleMapPackage(item.id);
                            }
                            setActiveImportId(item.id);
                            if (packageMenuRef.current) {
                              packageMenuRef.current.open = false;
                            }
                          }}
                          type="button"
                        >
                          <span>
                            <b title={item.name}>{item.name}</b>
                            <small>
                              {item.importedCount.toLocaleString("id-ID")} objek
                              ·{" "}
                              {item.folderPaths.length.toLocaleString("id-ID")}{" "}
                              folder KMZ
                            </small>
                          </span>
                          {active && <b>AKTIF</b>}
                        </button>
                        {item.folderPaths.length > 0 && (
                          <details className="map-package-folder-list">
                            <summary
                              aria-label={`Lihat ${item.folderPaths.length} folder KMZ`}
                              title="Lihat folder KMZ"
                            >
                              <i className="bi bi-folder2-open" />
                            </summary>
                            <div>
                              <b>
                                Folder dalam KMZ · {item.folderPaths.length}
                              </b>
                              {item.folderPaths.map((name) => (
                                <small key={name} title={name}>
                                  {name}
                                </small>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
              {selectedImportPackages.length > 0 && (
                <small className="map-package-summary">
                  {selectedImportPackages.length} paket ditampilkan bersama
                </small>
              )}
            </section>
          )}
          {showImportHistory && (
            <div className="map-import-history-backdrop">
              <section
                aria-labelledby="map-import-history-title"
                aria-modal="true"
                className="map-import-history"
                role="dialog"
              >
                <header>
                  <div>
                    <h2 id="map-import-history-title">Riwayat proses impor</h2>
                    <p>Hasil dan akun yang mengimpor paket KML/KMZ.</p>
                  </div>
                  <button
                    aria-label="Tutup"
                    className="btn-close"
                    onClick={() => setShowImportHistory(false)}
                    type="button"
                  />
                </header>
                <div aria-live="polite" className="map-import-history-list">
                  {importing && (
                    <div className="map-import-history-item is-running">
                      <b>
                        <span className="spinner-border spinner-border-sm me-2" />
                        Sedang diproses
                      </b>
                      <small>{importAttemptName}</small>
                    </div>
                  )}
                  {fileError && (
                    <div className="map-import-history-item is-failed">
                      <b>Impor gagal</b>
                      <small>
                        {importAttemptName} · {fileError}
                      </small>
                    </div>
                  )}
                  {mapImportsQuery.isPending && (
                    <small>Memuat riwayat impor…</small>
                  )}
                  {mapImportsQuery.isError && (
                    <small className="text-danger">
                      Riwayat impor gagal dimuat.
                    </small>
                  )}
                  {mapImportsQuery.data?.map((item) => (
                    <article className="map-import-history-item" key={item.id}>
                      <b>
                        {item.name}
                        <span>Berhasil</span>
                      </b>
                      <small>
                        {item.importedCount.toLocaleString("id-ID")} objek ·{" "}
                        {item.segmentCount.toLocaleString("id-ID")} kabel ·{" "}
                        {item.folderPaths.length.toLocaleString("id-ID")} folder
                        KMZ
                      </small>
                      <small>
                        Diimpor oleh{" "}
                        {item.actorName ||
                          item.actorEmail ||
                          "Akun tidak diketahui"}
                        {item.actorName && item.actorEmail
                          ? ` · ${item.actorEmail}`
                          : ""}
                      </small>
                      <small>
                        {new Date(item.createdAt).toLocaleString("id-ID", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </small>
                    </article>
                  ))}
                  {!importing &&
                    !fileError &&
                    !mapImportsQuery.isPending &&
                    !mapImportsQuery.isError &&
                    !mapImportsQuery.data?.length && (
                      <small>Belum ada riwayat impor.</small>
                    )}
                </div>
                <footer>
                  <button
                    className="btn btn-light"
                    onClick={() => setShowImportHistory(false)}
                    type="button"
                  >
                    Tutup
                  </button>
                </footer>
              </section>
            </div>
          )}
          {((!mapReady && !mapError) ||
            (Boolean(provinceCode || selectedImportIds.length) &&
              mapAssetsQuery.isLoading)) && (
            <div
              aria-live="polite"
              className="position-absolute translate-middle d-flex align-items-center bg-body rounded-3 start-50 top-50 gap-3 border px-4 py-3 shadow"
              role="status"
              style={{ zIndex: 5, pointerEvents: "none" }}
            >
              <span
                aria-hidden="true"
                className="spinner-border spinner-border-sm text-primary"
              />
              <span className="text-nowrap">Memuat data peta…</span>
            </div>
          )}
          {mapAssetsQuery.isError && (
            <div className="map-error" role="alert">
              Aset provinsi gagal dimuat.{" "}
              <button
                className="btn btn-sm btn-outline-danger ms-2"
                onClick={() => void mapAssetsQuery.refetch()}
                type="button"
              >
                Coba lagi
              </button>
            </div>
          )}
          <div className="map-top-actions">
            <button
              aria-pressed={satelliteEnabled}
              className={`btn ${satelliteEnabled ? "btn-primary" : "btn-light"}`}
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
            <button
              aria-pressed={globeEnabled}
              className="btn btn-light"
              disabled={!mapReady}
              onClick={() => {
                const instance = map.current;
                if (!instance) {
                  return;
                }
                if (!globeEnabled) {
                  const center = instance.getCenter();
                  previousMapView.current = {
                    center: [center.lng, center.lat],
                    zoom: instance.getZoom(),
                    bearing: instance.getBearing(),
                    pitch: instance.getPitch(),
                  };
                  instance.setMaxBounds(null);
                  instance.setProjection({ type: "globe" });
                  instance.flyTo({
                    center: [118, -2.5],
                    zoom: 1.5,
                    pitch: 0,
                    bearing: 0,
                  });
                } else {
                  instance.setProjection({ type: "mercator" });
                  instance.setMaxBounds(indonesiaBounds);
                  if (previousMapView.current) {
                    instance.flyTo(previousMapView.current);
                  }
                }
                setGlobeEnabled(!globeEnabled);
              }}
              type="button"
            >
              <i aria-hidden="true" className="bi bi-globe2 me-1" />
              {globeEnabled ? "Peta" : "Globe"}
            </button>
            {user?.role === "ADMIN" && (
              <div className="map-file-actions">
                <button
                  aria-busy={importing}
                  className="btn btn-light"
                  disabled={importing}
                  onClick={() => setFileModal("import")}
                  type="button"
                >
                  {importing ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="spinner-border spinner-border-sm me-1"
                        role="status"
                      />
                      Mengimpor...
                    </>
                  ) : (
                    <>
                      <i className="bi bi-upload me-1" />
                      Impor
                    </>
                  )}
                </button>
                <button
                  className="btn btn-light"
                  onClick={() => setFileModal("download")}
                  type="button"
                >
                  <i className="bi bi-download me-1" />
                  Unduh
                </button>
              </div>
            )}
            {provinceCode && (
              <details className="map-icon-filter" ref={iconFilter}>
                <summary>
                  <i className="bi bi-funnel" />
                  <span>Filter ikon</span>
                  <b>
                    {activeIconCategories.length}/{iconCategoryCounts.length}
                  </b>
                </summary>
                <div className="map-icon-filter-menu">
                  <div className="map-icon-filter-actions">
                    <button
                      onClick={() =>
                        setSelectedIconCategories(
                          iconCategoryCounts.map(([category]) => category)
                        )
                      }
                      type="button"
                    >
                      Pilih semua
                    </button>
                    <button
                      onClick={() => setSelectedIconCategories([])}
                      type="button"
                    >
                      Bersihkan
                    </button>
                  </div>
                  <input
                    aria-label="Cari kategori ikon"
                    onChange={(event) =>
                      setIconCategorySearch(event.target.value)
                    }
                    placeholder="Cari jenis ikon"
                    value={iconCategorySearch}
                  />
                  <div className="map-icon-filter-list">
                    {iconCategoryCounts
                      .filter(([category]) =>
                        category
                          .toLowerCase()
                          .includes(iconCategorySearch.toLowerCase())
                      )
                      .map(([category, count]) => (
                        <label key={category}>
                          <input
                            checked={activeIconCategories.includes(category)}
                            onChange={(event) =>
                              setSelectedIconCategories((current) =>
                                event.target.checked
                                  ? [
                                      ...(current ?? activeIconCategories),
                                      category,
                                    ]
                                  : (current ?? activeIconCategories).filter(
                                      (item) => item !== category
                                    )
                              )
                            }
                            type="checkbox"
                          />
                          {iconPreview(category)}
                          <span>{category}</span>
                          <small>{count.toLocaleString("id-ID")}</small>
                        </label>
                      ))}
                  </div>
                  {!iconCategoryCounts.length && (
                    <small className="map-icon-filter-empty">
                      Belum ada ikon titik.
                    </small>
                  )}
                </div>
              </details>
            )}
          </div>
          {(mode !== "idle" || routeError) && (
            <div className="route-map-message" role="status">
              {mode === "start"
                ? "Klik peta untuk memilih titik awal."
                : mode === "waypoint"
                  ? "Klik peta untuk menambah waypoint."
                  : mode === "end"
                    ? "Klik peta untuk memilih titik akhir."
                    : routeError}
            </div>
          )}
          {mapError && (
            <div className="map-error">
              <i className="bi bi-wifi-off me-2" />
              Peta tidak dapat dimuat. Periksa koneksi internet Anda.
            </div>
          )}
          {assetPopup &&
            (() => {
              const coordinate = firstCoordinate(assetPopup.geometry);
              const popupLength =
                assetPopup.id === selectedSegment?.id
                  ? cableLengthMeters(selectedCableGeometry)
                  : cableLengthMeters(assetPopup.geometry);
              const attributes = assetPopup.attributes ?? {};
              const savedFields = attributes.__kmlDetailFields;
              const sourceFields: Array<[string, unknown]> = Array.isArray(
                savedFields
              )
                ? savedFields.filter(
                    (field): field is [string, unknown] =>
                      Array.isArray(field) &&
                      field.length === 2 &&
                      typeof field[0] === "string"
                  )
                : Object.entries(attributes).filter(
                    ([key]) =>
                      !(
                        key.startsWith("__") ||
                        [
                          "name",
                          "description",
                          "folderPath",
                          "styleUrl",
                        ].includes(key)
                      )
                  );
              const originalKmzFields: Array<[string, unknown]> = [
                ...sourceFields.filter(
                  ([key]) => key.trim().toLowerCase() !== "nama objek"
                ),
                ...["description", "folderPath", "styleUrl"]
                  .filter(
                    (key) =>
                      attributes[key] !== undefined &&
                      !sourceFields.some(([label]) => label === key)
                  )
                  .map((key): [string, unknown] => [
                    key === "folderPath"
                      ? "Folder KMZ"
                      : key === "description"
                        ? "Deskripsi"
                        : key,
                    attributes[key],
                  ]),
              ];
              const fields: Array<[string, unknown]> = (
                assetPopup.source === "kml"
                  ? originalKmzFields
                  : ([
                      ["Nama objek", assetPopup.name],
                      [
                        "Tipe perangkat",
                        assetPopup.attributes?.assetKind ??
                          assetPopup.assetType,
                      ],
                      ["Tipe geometri", assetPopup.geometry?.type],
                      [
                        "Tipe jaringan",
                        assetPopup.attributes?.networkType ??
                          assetPopup.attributes?.routeType,
                      ],
                      ["Area", assetPopup.area],
                      ["Tipe kabel", assetPopup.cableType],
                      ...(assetPopup.assetType === "segment"
                        ? ([
                            [
                              "Jumlah core",
                              assetPopup.totalCores > 0
                                ? `${assetPopup.totalCores.toLocaleString("id-ID")} core`
                                : "Belum tercantum di data kabel",
                            ],
                            [
                              "Panjang kabel",
                              selectedSegmentGeometry.isPending &&
                              assetPopup.id === selectedSegment?.id
                                ? "Menghitung…"
                                : popupLength === null
                                  ? "Geometri garis tidak tersedia"
                                  : popupLength >= 1000
                                    ? `${(popupLength / 1000).toFixed(2)} km`
                                    : `${Math.round(popupLength)} m`,
                            ],
                          ] as Array<[string, unknown]>)
                        : []),
                      ["Metode instalasi", assetPopup.installation],
                      ["Sisi jalan", assetPopup.side],
                      ["Nomor tiang", assetPopup.pole],
                      ["ODC", assetPopup.odc],
                      ["ODP", assetPopup.odp],
                      ...Object.entries(assetPopup.attributes ?? {})
                        .filter(([key]) => !key.startsWith("__"))
                        .map(
                          ([key, value]) => [key, value] as [string, unknown]
                        ),
                      ["Longitude", coordinate[0]],
                      ["Latitude", coordinate[1]],
                    ] as Array<[string, unknown]>)
              ).filter(
                (entry): entry is [string, unknown] =>
                  entry[1] !== undefined &&
                  entry[1] !== null &&
                  (assetPopup.source === "kml" || entry[1] !== "")
              );
              return (
                <div
                  aria-label="Detail aset"
                  className="map-asset-popup"
                  ref={popupElement}
                  role="dialog"
                  style={popupPosition}
                >
                  <header className="map-asset-popup-header">
                    <div>
                      <h3>
                        {String(assetPopup.attributes?.name ?? assetPopup.name)}
                      </h3>
                      {assetPopup.source === "kml" && (
                        <small>Atribut asli dari KMZ</small>
                      )}
                    </div>
                    <button
                      aria-label="Tutup"
                      className="btn-close"
                      onClick={() => setAssetPopup(null)}
                      type="button"
                    />
                  </header>
                  <table
                    aria-label="Atribut detail aset"
                    className="map-asset-popup-table"
                  >
                    <tbody>
                      {fields.map(([label, value], index) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: labels can repeat (fixed fields plus raw attributes) and the rows are stateless
                        <tr key={index}>
                          <th scope="row">{label}</th>
                          <td>{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {assetPopup.source === "kml" &&
                    assetPopup.assetType === "segment" && (
                      <div className="border-top small mt-3 pt-2">
                        <strong>
                          Panjang kabel (dihitung dari geometri KMZ)
                        </strong>
                        <div>
                          {selectedSegmentGeometry.isPending &&
                          assetPopup.id === selectedSegment?.id
                            ? "Menghitung…"
                            : popupLength === null
                              ? "Geometri garis tidak tersedia"
                              : popupLength >= 1000
                                ? `${(popupLength / 1000).toFixed(2)} km`
                                : `${Math.round(popupLength)} m`}
                        </div>
                      </div>
                    )}
                </div>
              );
            })()}
        </section>
        <aside className="map-sidebar">
          <div className="map-tools">
            <div className="map-search">
              <label
                className="form-label fw-semibold"
                htmlFor="map-asset-search"
              >
                {provinceCode || selectedImportIds.length ? (
                  <>
                    Daftar aset jaringan{" "}
                    <span className="text-muted fw-normal">
                      ({(catalogQuery.data?.total ?? 0).toLocaleString("id-ID")}
                      )
                    </span>
                  </>
                ) : (
                  "Daftar aset jaringan · pilih provinsi"
                )}
              </label>
              <div className="input-group">
                <span className="input-group-text bg-white">
                  <i className="bi bi-search" />
                </span>
                <input
                  className="form-control"
                  disabled={!(provinceCode || selectedImportIds.length)}
                  id="map-asset-search"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Cari kabel, area, tiang, ODC/ODP, atau lokasi"
                  value={search}
                />
              </div>
              <label
                className="form-label small mt-2 mb-1"
                htmlFor="map-core-filter"
              >
                Filter segmen / core
              </label>
              <select
                className="form-select form-select-sm"
                disabled={!(provinceCode || selectedImportIds.length)}
                id="map-core-filter"
                onChange={(event) => {
                  setCoreFilter(event.target.value);
                  setAssetPage(1);
                }}
                value={coreFilter}
              >
                <option value="all">Semua aset</option>
                <option value="segments">Semua segmen</option>
                <option value="filled">Core sudah diisi</option>
                <option value="empty">Core belum diisi</option>
              </select>
            </div>
            <div className="map-tool-actions">
              {user?.role === "ADMIN" && (
                <>
                  <input
                    accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz"
                    className="d-none"
                    onChange={(event) => {
                      void importFile(event.target.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                    ref={importInput}
                    type="file"
                  />
                </>
              )}
            </div>
            {fileName && (
              <div aria-live="polite" className="map-file-status" role="status">
                <i className="bi bi-check-circle-fill" />
                <span>
                  <b>Map Package</b>
                  <small>{fileName}</small>
                  <strong>
                    {(fileImportCount ?? 0).toLocaleString("id-ID")} objek ·{" "}
                    {(fileImportSegmentCount ?? 0).toLocaleString("id-ID")}{" "}
                    kabel ·{" "}
                    {(fileImportFolderCount ?? 0).toLocaleString("id-ID")}{" "}
                    folder ·{" "}
                    {(
                      (fileImportCount ?? 0) - (fileImportSegmentCount ?? 0)
                    ).toLocaleString("id-ID")}{" "}
                    aset lain
                  </strong>
                </span>
              </div>
            )}
            {fileError && (
              <div className="alert alert-danger map-alert mb-0 px-3 py-2">
                {fileError}
              </div>
            )}
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
                    type="button"
                  >
                    Batal
                  </button>
                </div>
                <div className="route-point-count">
                  {routePoints.length} titik dipilih ·{" "}
                  {routeDistance === null
                    ? "Jalur akan dihitung dari jalan OSM"
                    : `Jarak jalan ${(routeDistance / 1000).toFixed(2)} km`}
                </div>
                <div className="route-actions">
                  {routePoints.length > 0 && routePoints.length < 9 && (
                    <button
                      className="btn btn-sm btn-light"
                      onClick={() => setSelectionMode("waypoint")}
                      type="button"
                    >
                      <i className="bi bi-plus-circle me-1" />
                      Waypoint
                    </button>
                  )}
                  {routePoints.length > 0 && routePoints.length < 10 && (
                    <button
                      className="btn btn-sm btn-light"
                      onClick={() => setSelectionMode("end")}
                      type="button"
                    >
                      <i className="bi bi-geo-alt me-1" />
                      Pilih titik akhir
                    </button>
                  )}
                  {routePoints.length >= 2 && (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={routeLoading}
                      onClick={() => void previewRoute()}
                      type="button"
                    >
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
                    <button
                      className="btn btn-sm btn-success"
                      onClick={confirmRoute}
                      type="button"
                    >
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
            {!provinceCode && !selectedImportIds.length && (
              <div className="map-empty-list">
                Pilih provinsi, lalu pilih Map Package untuk menampilkan aset.
              </div>
            )}
            {Boolean(provinceCode || selectedImportIds.length) &&
              catalogQuery.isPending && (
                <div className="map-empty-list">Memuat daftar aset…</div>
              )}
            {catalogQuery.isError && (
              <div className="map-empty-list">
                Daftar aset tidak dapat dimuat.
              </div>
            )}
            {standaloneSegments.map((segment) => (
              <button
                className={`segment-item ${selectedId === segment.id ? "selected" : ""}`}
                key={segment.id}
                onClick={() => focusAsset(segment)}
                type="button"
              >
                <span className="segment-dot" />
                <span className="segment-meta">
                  <b>
                    {segment.name}
                    <VerificationStatus asset={segment} />
                  </b>
                  <small>{segment.area || "Segmen jaringan"}</small>
                  <SegmentCoreSummary asset={segment} />
                </span>
                <i className="bi bi-chevron-right" />
              </button>
            ))}
            {[...ftthDraftGroups].map(([groupId, segments]) => (
              <details
                className="ftth-design-group"
                key={groupId}
                onToggle={(event) => {
                  if (event.currentTarget.open && segments[0]) {
                    void focusAsset(segments[0]);
                  }
                }}
              >
                <summary>
                  <span className="segment-dot" />
                  <span className="segment-meta">
                    <b>Draft FTTH · {segments[0]?.area || "Area desain"}</b>
                    <small>
                      {segments.length} jalur · {getDraftFeatureCount(groupId)}{" "}
                      aset dalam satu desain
                    </small>
                  </span>
                  <i className="bi bi-chevron-down" />
                </summary>
                <div>
                  {segments.map((segment) => (
                    <button
                      className={`segment-item ${selectedId === segment.id ? "selected" : ""}`}
                      key={segment.id}
                      onClick={() => focusAsset(segment)}
                      type="button"
                    >
                      <span
                        className="segment-dot"
                        style={{
                          background:
                            segment.attributes?.routeType === "FEEDER"
                              ? "#ff0000"
                              : "#a000ff",
                        }}
                      />
                      <span className="segment-meta">
                        <b>
                          {segment.name}
                          <VerificationStatus asset={segment} />
                        </b>
                        <small>
                          {segment.attributes?.routeType === "FEEDER"
                            ? "Kabel feeder"
                            : "Kabel distribusi"}{" "}
                          · {segment.area}
                        </small>
                        <SegmentCoreSummary asset={segment} />
                      </span>
                      <i className="bi bi-chevron-right" />
                    </button>
                  ))}
                </div>
              </details>
            ))}
            {filteredImported.map((line) => (
              <button
                className={`segment-item imported-item ${selectedId === line.id ? "selected" : ""}`}
                key={line.id}
                onClick={() => focusAsset(line)}
                type="button"
              >
                <span className="segment-dot" />
                <span className="segment-meta">
                  <b>
                    {line.name}
                    <VerificationStatus asset={line} />
                  </b>
                  <small>
                    {line.source === "kml" ? "KML/KMZ" : "Excel"} ·{" "}
                    {line.assetType === "segment"
                      ? "Segmen kabel"
                      : "Aset jaringan"}
                  </small>
                  <SegmentCoreSummary asset={line} />
                </span>
                <i className="bi bi-chevron-right" />
              </button>
            ))}
            {matchedImported.length > filteredImported.length && (
              <div className="map-empty-list">
                Menampilkan 100 dari {matchedImported.length} aset impor.
                Gunakan pencarian untuk mempersempit daftar.
              </div>
            )}
            {Boolean(provinceCode || selectedImportIds.length) &&
              !catalogQuery.isPending &&
              filteredSegments.length + matchedImported.length === 0 && (
                <div className="map-empty-list">
                  Tidak ada aset jaringan yang cocok.
                </div>
              )}
          </div>
          {catalogQuery.data &&
            catalogQuery.data.total > catalogQuery.data.pageSize && (
              <div className="asset-pagination">
                <small className="text-muted">
                  Halaman {assetPage.toLocaleString("id-ID")} dari{" "}
                  {catalogPageCount.toLocaleString("id-ID")}
                  {catalogQuery.isFetching ? " · Memuat…" : ""}
                </small>
                {/* biome-ignore lint/a11y/useSemanticElements: Bootstrap btn-group markup; a fieldset breaks its layout */}
                <div
                  aria-label="Pagination daftar aset"
                  className="btn-group btn-group-sm"
                  role="group"
                >
                  <button
                    aria-label="Sebelumnya"
                    className="btn btn-outline-secondary"
                    disabled={assetPage <= 1 || catalogQuery.isPlaceholderData}
                    onClick={() =>
                      setAssetPage((page) => Math.max(1, page - 1))
                    }
                    title="Sebelumnya"
                    type="button"
                  >
                    <i aria-hidden="true" className="bi bi-chevron-left" />
                  </button>
                  <button
                    aria-label="Berikutnya"
                    className="btn btn-outline-secondary"
                    disabled={
                      assetPage >= catalogPageCount ||
                      catalogQuery.isPlaceholderData
                    }
                    onClick={() =>
                      setAssetPage((page) =>
                        Math.min(catalogPageCount, page + 1)
                      )
                    }
                    title="Berikutnya"
                    type="button"
                  >
                    <i aria-hidden="true" className="bi bi-chevron-right" />
                  </button>
                </div>
              </div>
            )}
          <div className="segment-detail">
            <div className="detail-label">
              {selectedSegment ? "DETAIL SEGMEN" : "DETAIL DATA IMPOR"}
            </div>
            <h3>{selectedName}</h3>
            {selectedSegment ? (
              <>
                <p className="text-secondary">
                  {selectedSegment.area} · {selectedSegment.cableType}
                </p>
                {selectedDraftId && (
                  <div className="alert alert-primary py-2">
                    <i className="bi bi-bounding-box-circles me-2" />
                    Radius desain FTTH {draftRadiusMeters} m ditampilkan pada
                    peta.
                  </div>
                )}
                {selectedSegment.totalCores === 0 && (
                  <div className="alert alert-info py-2">
                    Kapasitas belum diisi. ADMIN perlu melengkapi jumlah core
                    sebelum segmen dapat dibooking.
                  </div>
                )}
                {selectedSegment.source !== "kml" &&
                  selectedSegment.nameValid === false && (
                    <div className="alert alert-warning py-2">
                      Nama kabel belum sesuai pola standar.
                    </div>
                  )}
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
                  <div
                    className="progress-bar"
                    style={{ width: `${utilization(selectedSegment)}%` }}
                  />
                </div>
                <div className="core-breakdown">
                  {[
                    ["Terpakai (Used)", selectedSegment.usedCores, "used"],
                    ["Booked", selectedSegment.bookedCores, "booked"],
                    [
                      "Waiting list",
                      bookings.filter(
                        (booking) =>
                          booking.segmentId === selectedSegment.id &&
                          booking.status === "Waiting List"
                      ).length,
                      "booked",
                    ],
                    ...(isCoreUsageVerified(selectedSegment)
                      ? [
                          [
                            "Idle / tersedia",
                            selectedSegment.idleCores,
                            "available",
                          ],
                        ]
                      : []),
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
                  {selectedSegment.source !== "managed" && (
                    <div className="small mt-2 mb-2 rounded border p-2">
                      <b>
                        {selectedSegment.attributes?.__coreUsageVerification &&
                        typeof selectedSegment.attributes
                          .__coreUsageVerification === "object" &&
                        (
                          selectedSegment.attributes
                            .__coreUsageVerification as Record<string, unknown>
                        ).verified === true
                          ? "Kapasitas terverifikasi"
                          : "Verifikasi pemakaian KMZ"}
                      </b>
                      {selectedSegment.attributes?.__coreUsageVerification &&
                      typeof selectedSegment.attributes
                        .__coreUsageVerification === "object" &&
                      (
                        selectedSegment.attributes
                          .__coreUsageVerification as Record<string, unknown>
                      ).verified === true ? (
                        <small className="d-block text-secondary">
                          Sumber:{" "}
                          {String(
                            (
                              selectedSegment.attributes
                                .__coreUsageVerification as Record<
                                string,
                                unknown
                              >
                            ).source ?? "—"
                          )}{" "}
                          ·{" "}
                          {String(
                            (
                              selectedSegment.attributes
                                .__coreUsageVerification as Record<
                                string,
                                unknown
                              >
                            ).verifiedAt ?? ""
                          )}
                        </small>
                      ) : (
                        <small className="d-block text-secondary">
                          Periksa status setiap core dari catatan lapangan atau
                          inventaris, lalu isi sumber dan catatan pemeriksaan.
                        </small>
                      )}
                      {user?.role === "ADMIN" && (
                        <div className="mt-2">
                          <div className="row g-2">
                            <div className="col-sm-5">
                              <select
                                aria-label="Sumber verifikasi"
                                className="form-select form-select-sm"
                                onChange={(event) =>
                                  setCoreVerificationSource(event.target.value)
                                }
                                value={coreVerificationSource}
                              >
                                <option>Survei lapangan</option>
                                <option>Data operasional</option>
                                <option>Dokumen inventaris</option>
                              </select>
                            </div>
                            <div className="col-sm-7">
                              <input
                                aria-label="Catatan verifikasi"
                                className="form-control form-control-sm"
                                maxLength={500}
                                onChange={(event) =>
                                  setCoreVerificationNote(event.target.value)
                                }
                                placeholder="Catatan / referensi pemeriksaan (opsional)"
                                value={coreVerificationNote}
                              />
                            </div>
                          </div>
                          <button
                            className="btn btn-sm btn-outline-primary mt-2"
                            disabled={
                              verifyCoreUsage.isPending ||
                              coresQuery.data?.length !==
                                selectedSegment.totalCores
                            }
                            onClick={() => verifyCoreUsage.mutate()}
                            type="button"
                          >
                            {verifyCoreUsage.isPending
                              ? "Menyimpan..."
                              : "Simpan dan verifikasi kapasitas"}
                          </button>
                          {coresQuery.data?.length !==
                            selectedSegment.totalCores && (
                            <small className="d-block text-warning mt-1">
                              Jumlah core tercatat (
                              {coresQuery.data?.length ?? 0}) belum sama dengan
                              total KMZ ({selectedSegment.totalCores}).
                            </small>
                          )}
                          {verifyCoreUsage.error && (
                            <small className="d-block text-danger mt-1">
                              {verifyCoreUsage.error instanceof Error
                                ? verifyCoreUsage.error.message
                                : "Verifikasi gagal disimpan."}
                            </small>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {isCoreUsageVerified(selectedSegment) ? (
                    coresQuery.isPending ? (
                      <small>Memuat status core...</small>
                    ) : coresQuery.isError ? (
                      <small className="text-danger">
                        Status core tidak dapat dimuat.
                      </small>
                    ) : coresQuery.data?.length ? (
                      <div className="core-status-list">
                        {coresQuery.data?.map((core) => (
                          <div key={core.coreNumber}>
                            <span>Core {core.coreNumber}</span>
                            {core.status === "Booked" ? (
                              <span
                                className="status-pill is-booked"
                                title={`PIC customer: ${core.picCustomer ?? "—"} · PIC presales: ${core.picPresales ?? "—"}`}
                              >
                                Booked · {core.customer}
                              </span>
                            ) : user?.role === "ADMIN" ? (
                              <select
                                className="form-select form-select-sm"
                                disabled={updateCore.isPending}
                                onChange={(event) =>
                                  updateCore.mutate({
                                    coreNumber: core.coreNumber,
                                    status: event.target.value as
                                      | "Available"
                                      | "Used",
                                  })
                                }
                                value={core.status}
                              >
                                <option value="Available">Tersedia</option>
                                <option value="Used">Terpakai</option>
                              </select>
                            ) : (
                              <span
                                className={`status-pill ${core.status === "Used" ? "is-released" : "is-waiting"}`}
                              >
                                {core.status === "Used"
                                  ? "Terpakai"
                                  : "Tersedia"}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <small className="text-secondary">
                        Belum ada core terpasang.
                      </small>
                    )
                  ) : (
                    <small className="d-block text-warning">
                      Daftar status core dikunci sampai kapasitas kabel
                      diverifikasi.
                    </small>
                  )}
                  {updateCore.error && (
                    <small className="text-danger">
                      {updateCore.error instanceof Error
                        ? updateCore.error.message
                        : "Status core tidak dapat diubah."}
                    </small>
                  )}
                </details>
                <details className="core-list-details">
                  <summary>
                    Waiting list ·{" "}
                    {
                      bookings.filter(
                        (booking) =>
                          booking.segmentId === selectedSegment.id &&
                          booking.status === "Waiting List"
                      ).length
                    }
                  </summary>
                  {bookingsPending ? (
                    <small role="status">Memuat antrean...</small>
                  ) : bookingsError ? (
                    <small className="text-danger">
                      Antrean tidak dapat dimuat.
                    </small>
                  ) : (
                    <div className="segment-waiting-list">
                      {bookings
                        .filter(
                          (booking) =>
                            booking.segmentId === selectedSegment.id &&
                            booking.status === "Waiting List"
                        )
                        .sort(
                          (a, b) =>
                            Date.parse(a.approvedAt ?? a.requestedAt) -
                              Date.parse(b.approvedAt ?? b.requestedAt) ||
                            a.id.localeCompare(b.id)
                        )
                        .map((booking, index) => (
                          <div
                            className="segment-waiting-item"
                            key={booking.id}
                          >
                            <b>
                              {index + 1}. {booking.customer} · {booking.cores}{" "}
                              core
                            </b>
                            <small>
                              PIC customer: {booking.picCustomer}
                              <br />
                              PIC presales: {booking.picPresales}
                              <br />
                              Masuk antrean:{" "}
                              {new Date(
                                booking.approvedAt ?? booking.requestedAt
                              ).toLocaleString("id-ID")}
                            </small>
                          </div>
                        ))}
                      {!bookings.some(
                        (booking) =>
                          booking.segmentId === selectedSegment.id &&
                          booking.status === "Waiting List"
                      ) && (
                        <small className="text-secondary">
                          Belum ada permintaan waiting list.
                        </small>
                      )}
                      <small className="text-secondary d-block mt-2">
                        FIFO ketat: permintaan berikutnya menunggu jika
                        kapasitas belum cukup untuk antrean pertama.
                      </small>
                    </div>
                  )}
                </details>
                <hr />
                <div className="asset-info">
                  {(() => {
                    const attributes = Object.entries(
                      selectedSegment.attributes ?? {}
                    ).filter(
                      ([key, value]) =>
                        !key.startsWith("__") &&
                        value !== undefined &&
                        value !== null &&
                        value !== ""
                    );
                    const find = (pattern: RegExp) =>
                      attributes.find(([key]) => pattern.test(key))?.[1];
                    const from =
                      find(
                        /^(from|source|origin|upstream|asal|dari|start|olt|odc|fdt)([_ -]?id|[_ -]?name)?$/iu
                      ) ??
                      selectedSegment.odc ??
                      selectedSegment.attributes?.olt ??
                      selectedSegment.attributes?.fdt;
                    const to =
                      find(
                        /^(to|target|destination|downstream|tujuan|ke|end|odp)([_ -]?id|[_ -]?name)?$/iu
                      ) ?? selectedSegment.odp;
                    return (
                      <div className="asset-info-group">
                        <b>Detail koneksi kabel</b>
                        {from || to ? (
                          <div className="route-endpoints">
                            <span>
                              <small>Dari</small>
                              <strong>
                                {String(from ?? "Tidak dicantumkan di KMZ")}
                              </strong>
                            </span>
                            <i
                              aria-hidden="true"
                              className="bi bi-arrow-right"
                            />
                            <span>
                              <small>Ke</small>
                              <strong>
                                {String(to ?? "Tidak dicantumkan di KMZ")}
                              </strong>
                            </span>
                          </div>
                        ) : (
                          <small className="text-secondary d-block mt-1">
                            KMZ ini tidak mencantumkan field asal dan tujuan
                            secara eksplisit.
                          </small>
                        )}
                        {attributes.length > 0 && (
                          <details className="admin-settings mt-2">
                            <summary>
                              Atribut kabel dari KMZ ({attributes.length})
                            </summary>
                            <div className="import-detail-list mt-2">
                              {attributes.map(([key, value]) => (
                                <div key={key}>
                                  <span>{key}</span>
                                  <b>{String(value)}</b>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })()}
                  <div className="asset-info-group">
                    <b>Detail kabel</b>
                    <div className="asset-info">
                      <div>
                        <span>Standar legenda</span>
                        <b>
                          {selectedLegend?.category} ·{" "}
                          {selectedLegend?.termination} · garis{" "}
                          {selectedLegend?.cableLineWidth ?? "—"} px
                        </b>
                      </div>
                      {[
                        ["Tipe kabel", selectedSegment.cableType],
                        ["Metode instalasi", selectedSegment.installation],
                        [
                          "Sisi jalan",
                          `Sisi ${selectedSegment.side.toLowerCase()}`,
                        ],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <span>{label}</span>
                          <b>{value}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                  {(selectedSegment.pole ||
                    selectedSegment.poleHeight ||
                    selectedSegment.odc ||
                    selectedSegment.odp) && (
                    <div className="asset-info-group">
                      <b>
                        {selectedSegment.source === "managed"
                          ? "Informasi aset"
                          : "Data aset dari sumber impor"}
                      </b>
                      <div className="asset-info">
                        {(
                          [
                            ["Tiang", selectedSegment.pole],
                            ["Tinggi tiang", selectedSegment.poleHeight],
                            ["ODC", selectedSegment.odc],
                            ["ODP", selectedSegment.odp],
                          ] as const
                        )
                          .filter(([, value]) => value)
                          .map(([label, value]) => (
                            <div key={label}>
                              <span>{label}</span>
                              <b>{value}</b>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
                <SegmentRelations
                  isAdmin={user?.role === "ADMIN"}
                  key={selectedSegment.id}
                  segmentId={selectedSegment.id}
                />
                {selectedSegment.source !== "managed" && (
                  <details className="admin-settings mt-3">
                    <summary>Atribut sumber impor</summary>
                    <div className="import-detail-list mt-2">
                      {Object.entries(selectedSegment.attributes ?? {})
                        .filter(([key]) => key !== "__kmlStyle")
                        .map(([key, value]) => (
                          <div key={key}>
                            <span>{key}</span>
                            <b>{String(value)}</b>
                          </div>
                        ))}
                    </div>
                  </details>
                )}
                {user?.role === "ADMIN" && (
                  <details className="admin-settings mt-4" ref={assetDetails}>
                    <summary>
                      <i className="bi bi-pencil-square me-2" />
                      Ubah detail aset
                    </summary>
                    <form
                      className="mt-3"
                      key={selectedSegment.id}
                      onSubmit={saveAssetDetails}
                    >
                      <label className="form-label" htmlFor="asset-area">
                        Area
                      </label>
                      <input
                        className="form-control form-control-sm mb-2"
                        defaultValue={selectedSegment.area}
                        id="asset-area"
                        name="area"
                      />
                      <label className="form-label" htmlFor="asset-cable-type">
                        Tipe kabel
                      </label>
                      <input
                        className="form-control form-control-sm mb-2"
                        defaultValue={selectedSegment.cableType}
                        id="asset-cable-type"
                        name="cableType"
                      />
                      <label className="form-label" htmlFor="asset-total-cores">
                        Jumlah core total
                      </label>
                      <input
                        className="form-control form-control-sm"
                        defaultValue={selectedSegment.totalCores}
                        id="asset-total-cores"
                        max="4096"
                        min="0"
                        name="totalCores"
                        required
                        type="number"
                      />
                      <small className="form-text d-block mb-2">
                        Core terpakai diatur per nomor di Rincian core;
                        jumlahnya dihitung otomatis.
                      </small>
                      <label
                        className="form-label"
                        htmlFor="asset-installation"
                      >
                        Metode instalasi
                      </label>
                      <select
                        className="form-select form-select-sm mb-2"
                        defaultValue={selectedSegment.installation}
                        id="asset-installation"
                        name="installation"
                      >
                        <option value="Aerial">Aerial</option>
                        <option value="Burial">Burial</option>
                      </select>
                      <label className="form-label" htmlFor="asset-side">
                        Sisi jalan
                      </label>
                      <select
                        className="form-select form-select-sm mb-2"
                        defaultValue={selectedSegment.side}
                        id="asset-side"
                        name="side"
                      >
                        <option value="Kiri">Kiri</option>
                        <option value="Kanan">Kanan</option>
                      </select>
                      <button
                        className="btn btn-sm btn-outline-primary"
                        disabled={updateAsset.isPending}
                        type="submit"
                      >
                        {updateAsset.isPending
                          ? "Menyimpan..."
                          : "Simpan detail"}
                      </button>
                      {updateAsset.isSuccess && (
                        <small
                          className="d-block text-success mt-2"
                          role="status"
                        >
                          Detail aset tersimpan.
                        </small>
                      )}
                      {updateAsset.error && (
                        <small className="d-block text-danger mt-2">
                          {updateAsset.error instanceof Error
                            ? updateAsset.error.message
                            : "Detail aset tidak dapat disimpan."}
                        </small>
                      )}
                    </form>
                  </details>
                )}
                <Link className="btn btn-primary mt-4 w-100" to="/booking-core">
                  <i className="bi bi-diagram-3 me-2" />
                  Kelola booking core
                </Link>
              </>
            ) : selectedImported ? (
              <>
                <p className="text-secondary">
                  Geometri sumber dipertahankan tanpa perubahan.
                </p>
                <div className="asset-info mb-3">
                  <div>
                    <span>Standar legenda</span>
                    <b>
                      {selectedLegend?.category} · {selectedLegend?.termination}{" "}
                      · ikon {selectedLegend?.size}× · label{" "}
                      {selectedLegend?.labelSize}×
                    </b>
                  </div>
                </div>
                <div className="import-detail-list">
                  {Object.entries(selectedImported.attributes ?? {})
                    .filter(([key]) => key !== "__kmlStyle")
                    .map(([key, value]) => (
                      <div key={key}>
                        <span>{key}</span>
                        <b>{String(value)}</b>
                      </div>
                    ))}
                  {(selectedImported.geometryType ||
                    selectedImported.geometry?.type) && (
                    <div>
                      <span>Tipe geometri</span>
                      <b>
                        {selectedImported.geometryType ??
                          selectedImported.geometry?.type}
                      </b>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p className="text-secondary">
                Pilih segmen untuk melihat detail aset.
              </p>
            )}
          </div>
        </aside>
      </div>
      {fileModal && (
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only backdrop close; Escape and focus trapping are missing until these modals move to <dialog>
        <div
          className="file-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setFileModal(null);
            }
          }}
          role="presentation"
        >
          <section
            aria-labelledby="file-modal-title"
            aria-modal="true"
            className="file-modal"
            role="dialog"
          >
            <header>
              <div>
                <h2 id="file-modal-title">
                  {fileModal === "import"
                    ? "Impor data jaringan"
                    : "Unduh file peta"}
                </h2>
                <p>
                  {fileModal === "import"
                    ? "Pilih file KML atau KMZ untuk diunggah."
                    : exporting
                      ? "Sedang menyiapkan file…"
                      : "Unduh seluruh aset jaringan."}
                </p>
              </div>
              <button
                aria-label="Tutup"
                className="btn-close"
                onClick={() => setFileModal(null)}
                type="button"
              />
            </header>
            <div className="file-modal-options">
              {fileModal === "import" ? (
                <>
                  <button
                    className="file-modal-option"
                    onClick={() => {
                      setFileModal(null);
                      importInput.current?.click();
                    }}
                    type="button"
                  >
                    <span>
                      <i className="bi bi-globe2" />
                    </span>
                    <div>
                      <b>KML / KMZ</b>
                      <small>
                        Impor geometri, ikon, warna, dan atribut dari Google
                        Earth.
                      </small>
                    </div>
                    <i className="bi bi-chevron-right" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="file-modal-option"
                    disabled={exporting}
                    onClick={() => void downloadNetworkFile("kml")}
                    type="button"
                  >
                    <span>
                      <i className="bi bi-globe2" />
                    </span>
                    <div>
                      <b>Ekspor KML</b>
                      <small>
                        Unduh seluruh aset jaringan dalam format KML.
                      </small>
                    </div>
                    <i className="bi bi-download" />
                  </button>
                  <button
                    className="file-modal-option"
                    disabled={exporting}
                    onClick={() => void downloadNetworkFile("kmz")}
                    type="button"
                  >
                    <span>
                      <i className="bi bi-globe2" />
                    </span>
                    <div>
                      <b>Ekspor KMZ</b>
                      <small>
                        Unduh seluruh aset jaringan dalam arsip KMZ.
                      </small>
                    </div>
                    <i className="bi bi-download" />
                  </button>
                  <button
                    className="file-modal-option"
                    disabled={exporting}
                    onClick={() => void downloadNetworkFile("xlsx")}
                    type="button"
                  >
                    <span>
                      <i className="bi bi-file-earmark-spreadsheet" />
                    </span>
                    <div>
                      <b>Ekspor Excel (.xlsx)</b>
                      <small>
                        Unduh seluruh aset jaringan dalam format Excel.
                      </small>
                    </div>
                    <i className="bi bi-download" />
                  </button>
                </>
              )}
            </div>
            <footer>
              <button
                className="btn btn-light"
                onClick={() => setFileModal(null)}
                type="button"
              >
                Tutup
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
