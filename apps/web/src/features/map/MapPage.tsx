import { notify } from "../../components/Snackbar";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
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
  FullscreenControl,
  type MapLayerMouseEvent,
  LngLatBounds,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useMemo, useRef, useState } from "react";
import { DetailTable } from "../../components/DetailTable";
import { PageHeader } from "../../components/PageHeader";
import {
  api,
  type Booking,
  type NetworkAsset,
  type NetworkAssetPage,
  networkQueryKeys,
} from "../../lib/api";
import {
  describeCableEndpoints,
  type TerminationPlan,
} from "../analysis/terminationPlan";
import {
  addAtlasMapIcons,
  assetFeatures,
  assetIconCategory,
  cableLengthMeters,
  legendStyle,
  loadNetworkMapIcons,
} from "./networkMap";
import { registerSatelliteTiles } from "./satelliteTiles";
import { assetDetailTitle } from "./assetDetailTitle";

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
type CoreSide = "A" | "B";
type CorePosition = CoreSide | "R";
type CoreDestination = {
  id: string;
  name: string;
  type: string | null;
  side: CoreSide;
  distanceFromEndpoint: number | string | null;
  distanceToRoute: number | string;
  distanceFromStart: number | string;
  longitude: number | string;
  latitude: number | string;
};
type CoreEndRecord = {
  nodeAssetId: string | null;
  nodeAssetName: string | null;
  nodeAssetType: string | null;
  longitude: number | string | null;
  latitude: number | string | null;
  verificationStatus: "confirmed" | "needs_review" | null;
  endpointSource: string | null;
  endpointNote: string | null;
  connectionType: "splice" | "termination" | "device_port" | null;
  peerSegmentId: string | null;
  peerSegmentName: string | null;
  peerCoreNumber: number | null;
  peerSide: CorePosition | null;
  peerRouteMeasureM: number | string | null;
  connectionGroupId: string | null;
  portReference: string | null;
  connectionVerificationStatus: "confirmed" | "needs_review" | null;
  connectionSource: string | null;
  connectionNote: string | null;
};
type CoreEndpoint = {
  side: CoreSide;
  endpoint: {
    nodeAssetId: string;
    nodeAssetName: string;
    nodeAssetType: string | null;
    longitude: number;
    latitude: number;
    verificationStatus: "confirmed" | "needs_review";
    source: string;
    note: string;
    updatedAt: string;
  } | null;
  candidates: CoreDestination[];
};
type CorePeer = {
  peerSegmentId: string;
  peerSegmentName: string;
  peerSide: CorePosition;
  peerRouteMeasureM: number | string | null;
  peerCoreNumber: number;
  peerStatus: "Available" | "Booked" | "Used";
  existingConnectionType: "splice" | "termination" | "device_port" | null;
  existingPeerCoreId: number | null;
  existingPeerSide: CorePosition | null;
  connectionGroupId: string | null;
  recordedNodeAssetId: string | null;
  connectedSegmentId: string | null;
  connectedCoreNumber: number | null;
  connectedSide: CorePosition | null;
  connectedRouteMeasureM: number | string | null;
  isOccupied: boolean;
  matchesDistribution: boolean;
  matchesCompany: boolean;
};
type CoreEndDraft =
  | {
      connectionType: "splice";
      peerSegmentId?: string;
      peerCoreNumber?: number;
      peerSide?: CorePosition;
      peerRouteMeasureM?: number;
    }
  | { connectionType: "termination" }
  | { connectionType: "device_port"; portReference: string }
  | null;
type CoreSpliceDraft = Extract<CoreEndDraft, { connectionType: "splice" }>;
type CorePeerPositionOption = {
  key: string;
  peerSegmentId: string;
  peerSegmentName: string;
  peerSide: CorePosition;
  peerRouteMeasureM: number | null;
  cores: CorePeer[];
};

function corePeerPositionKey(peer: Pick<CorePeer, "peerSegmentId" | "peerSide" | "peerRouteMeasureM">) {
  const routeMeasureM = peer.peerSide === "R" && peer.peerRouteMeasureM != null
    ? Number(peer.peerRouteMeasureM).toFixed(2)
    : null;
  return JSON.stringify([peer.peerSegmentId, peer.peerSide, routeMeasureM]);
}

function CorePeerSelector({
  idPrefix,
  peers,
  connection,
  onChange,
  disabled,
  loading,
  error,
}: {
  idPrefix: string;
  peers: CorePeer[];
  connection: CoreSpliceDraft | null;
  onChange: (connection: CoreSpliceDraft) => void;
  disabled: boolean;
  loading: boolean;
  error: boolean;
}) {
  const positions = useMemo(() => {
    const grouped = new Map<string, CorePeerPositionOption>();
    for (const peer of peers) {
      const key = corePeerPositionKey(peer);
      const existing = grouped.get(key);
      if (existing) {
        existing.cores.push(peer);
      } else {
        grouped.set(key, {
          key,
          peerSegmentId: peer.peerSegmentId,
          peerSegmentName: peer.peerSegmentName,
          peerSide: peer.peerSide,
          peerRouteMeasureM: peer.peerSide === "R" && peer.peerRouteMeasureM != null
            ? Number(peer.peerRouteMeasureM)
            : null,
          cores: [peer],
        });
      }
    }
    return [...grouped.values()].map((position) => ({
      ...position,
      cores: position.cores.sort((a, b) => a.peerCoreNumber - b.peerCoreNumber),
    }));
  }, [peers]);

  const savedPositionKey = connection?.peerSegmentId && connection.peerSide
    ? corePeerPositionKey({
        peerSegmentId: connection.peerSegmentId,
        peerSide: connection.peerSide,
        peerRouteMeasureM: connection.peerRouteMeasureM ?? null,
      })
    : "";
  const selectedPosition = positions.find((position) => position.key === savedPositionKey) ??
    (!connection?.peerSegmentId && positions.length === 1 ? positions[0] : undefined);
  const isSinglePosition = positions.length === 1 && Boolean(selectedPosition);
  const positionDescription = selectedPosition?.peerSide === "R"
    ? `Bertemu di jalur kabel tujuan · ${Number(selectedPosition.peerRouteMeasureM).toFixed(0)} m dari Ujung A`
    : selectedPosition
      ? `Bertemu di Ujung ${selectedPosition.peerSide} kabel tujuan`
      : "";
  const selectedCoreNumber = selectedPosition?.cores.some(
    (peer) => peer.peerCoreNumber === connection?.peerCoreNumber
  )
    ? String(connection?.peerCoreNumber)
    : "";

  if (loading && positions.length === 0) {
    return <small className="text-secondary">Mencari kabel di titik sambungan…</small>;
  }
  if (error) {
    return <small className="text-danger">Daftar kabel tujuan tidak dapat dimuat.</small>;
  }
  if (positions.length === 0) {
    return <small className="text-secondary">Tidak ada core tujuan yang belum tersambung di titik ini.</small>;
  }

  const updatePosition = (position: CorePeerPositionOption | undefined) => {
    if (!position) {
      onChange({ connectionType: "splice" });
      return;
    }
    onChange({
      connectionType: "splice",
      peerSegmentId: position.peerSegmentId,
      peerSide: position.peerSide,
      ...(position.peerSide === "R" && position.peerRouteMeasureM !== null
        ? { peerRouteMeasureM: position.peerRouteMeasureM }
        : {}),
    });
  };

  return (
    <div className="core-peer-selector">
      <div className="core-peer-selector-field">
        <label htmlFor={`${idPrefix}-cable`}>Kabel yang tersambung</label>
        {isSinglePosition ? (
          <span
            className="core-peer-cable-summary"
            title={selectedPosition?.peerSegmentName}
          >
            {selectedPosition?.peerSegmentName}
          </span>
        ) : (
          <select
            className="form-select form-select-sm"
            disabled={disabled}
            id={`${idPrefix}-cable`}
            onChange={(event) => updatePosition(positions.find((position) => position.key === event.target.value))}
            value={selectedPosition?.key ?? ""}
          >
            <option value="">Pilih kabel yang tersambung</option>
            {positions.map((position) => {
              const sameCablePositions = positions.filter(
                (item) => item.peerSegmentId === position.peerSegmentId
              ).length;
              const location = position.peerSide === "R"
                ? `Jalur kabel tujuan · ${Number(position.peerRouteMeasureM).toFixed(0)} m dari Ujung A`
                : `Ujung ${position.peerSide} kabel tujuan`;
              return (
                <option key={position.key} value={position.key}>
                  {position.peerSegmentName}{sameCablePositions > 1 ? ` · ${location}` : ""}
                </option>
              );
            })}
          </select>
        )}
        {selectedPosition && (
          <small>{positionDescription}</small>
        )}
      </div>
      <div className="core-peer-selector-field">
        <label htmlFor={`${idPrefix}-core`}>Core pada kabel tujuan</label>
        <select
          className="form-select form-select-sm"
          disabled={disabled || !selectedPosition}
          id={`${idPrefix}-core`}
          onChange={(event) => {
            const peerCoreNumber = Number(event.target.value);
            onChange({
              connectionType: "splice",
              peerSegmentId: selectedPosition?.peerSegmentId,
              peerSide: selectedPosition?.peerSide,
              ...(selectedPosition?.peerSide === "R" && selectedPosition.peerRouteMeasureM !== null
                ? { peerRouteMeasureM: selectedPosition.peerRouteMeasureM }
                : {}),
              ...(peerCoreNumber > 0 ? { peerCoreNumber } : {}),
            });
          }}
          value={selectedCoreNumber}
        >
          <option value="">Pilih core pada kabel tujuan</option>
          {selectedPosition?.cores.map((peer) => (
            <option key={peer.peerCoreNumber} value={peer.peerCoreNumber}>
              Core {peer.peerCoreNumber}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
type CoreRouteNode = {
  id: string;
  name: string;
  type: string | null;
  routeMeasureM: number | string;
  routeLengthM: number | string;
  distanceToRoute: number | string;
  matchesDistribution: boolean;
  matchesCompany: boolean;
};
type MidspanConnectionRecord = {
  id: string;
  nodeAssetId: string;
  nodeAssetName: string;
  nodeAssetType: string | null;
  routeMeasureM: number | string;
  connectionType: "splice" | "termination" | "device_port";
  peerSegmentId: string | null;
  peerSegmentName: string | null;
  peerCoreNumber: number | null;
  peerSide: CorePosition | null;
  peerRouteMeasureM: number | string | null;
  connectionGroupId: string;
  portReference: string | null;
  verificationStatus: "confirmed" | "needs_review";
  source: string;
  note: string;
};
type MidspanConnectionDraft = {
  draftId: string;
  nodeAssetId: string;
  routeMeasureM: number | null;
  connection: CoreEndDraft;
};
type CoreItem = {
  coreNumber: number;
  status: "Available" | "Booked" | "Used";
  endA: CoreEndRecord | null;
  endB: CoreEndRecord | null;
  midspanConnections: MidspanConnectionRecord[];
  legacyConnectedAssetId: string | null;
  legacyConnectedAssetName: string | null;
  legacyConnectedSide: CoreSide | "R" | null;
  customer?: string;
  picCustomer?: string;
  picPresales?: string;
  expiresAt?: string;
};
type PendingCoreChange = {
  status: "Available" | "Used";
  endConnections?: Partial<Record<CoreSide, CoreEndDraft>>;
  midspanConnections?: MidspanConnectionDraft[];
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
  companies: string[];
  createdAt: string;
  actorName: string | null;
  actorEmail: string | null;
};
type SavedMapSelection = {
  provinceCode: string;
  importIds: string[];
  companyValue: string;
  activeImportId: string;
};
const mapSelectionStorageKey = "atlas-map-selection-v1";
function readSavedMapSelection(): SavedMapSelection {
  const empty: SavedMapSelection = {
    provinceCode: "",
    importIds: [],
    companyValue: "",
    activeImportId: "",
  };
  try {
    const value = sessionStorage.getItem(mapSelectionStorageKey);
    if (!value) {
      return empty;
    }
    const parsed = JSON.parse(value) as Partial<SavedMapSelection>;
    return {
      provinceCode:
        typeof parsed.provinceCode === "string" ? parsed.provinceCode : "",
      importIds: Array.isArray(parsed.importIds)
        ? parsed.importIds.filter((id): id is string => typeof id === "string")
        : [],
      companyValue:
        typeof parsed.companyValue === "string" ? parsed.companyValue : "",
      activeImportId:
        typeof parsed.activeImportId === "string" ? parsed.activeImportId : "",
    };
  } catch {
    return empty;
  }
}
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
function pointCandidatesAtCursor(
  map: MapLibreMap,
  point: { x: number; y: number }
) {
  const features = map.queryRenderedFeatures([point.x, point.y], {
    layers: ["network-icons"],
  });
  const points = features.filter(
    (
      feature
    ): feature is (typeof features)[number] & {
      geometry: Point;
    } => feature.geometry.type === "Point"
  );
  const uniquePoints = new Map<string, (typeof points)[number]>();
  for (const feature of points) {
    const id = String(feature.properties?.id ?? feature.id ?? "");
    if (id && !uniquePoints.has(id)) {
      uniquePoints.set(id, feature);
    }
  }
  const sorted = [...uniquePoints.values()].sort((a, b) => {
    const distance = (feature: (typeof points)[number]) => {
      const projected = map.project(feature.geometry.coordinates as Coordinate);
      return (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
    };
    return distance(a) - distance(b);
  });
  const closest = sorted[0];
  if (!closest) {
    return [];
  }
  const closestPoint = map.project(closest.geometry.coordinates as Coordinate);
  const closestDistance = Math.hypot(
    closestPoint.x - point.x,
    closestPoint.y - point.y
  );
  // Keep the chooser focused on icons that actually overlap the click. The
  // invisible 18px hit circles included many nearby assets at this map scale.
  const overlapDistance = closestDistance + 6;
  return sorted.filter((feature) => {
    const projected = map.project(feature.geometry.coordinates as Coordinate);
    return (
      Math.hypot(projected.x - point.x, projected.y - point.y) <=
      overlapDistance
    );
  });
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
function cableCoordinates(
  geometry: LineString | { type: "MultiLineString"; coordinates: Position[][] }
) {
  return geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.coordinates;
}
function coordinateDistanceMeters(a: Position, b: Position) {
  const radians = Math.PI / 180;
  const latitudeA = a[1] * radians;
  const latitudeB = b[1] * radians;
  const latitudeDelta = (b[1] - a[1]) * radians;
  const longitudeDelta = (b[0] - a[0]) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDelta / 2) ** 2;
  return (
    6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}
function coordinateAlongCable(
  lines: Position[][],
  fraction: number
): Coordinate | null {
  const segments = lines.flatMap((line) =>
    line.slice(1).map((end, index) => ({ start: line[index], end }))
  );
  const lengths = segments.map(({ start, end }) =>
    coordinateDistanceMeters(start, end)
  );
  const totalLength = lengths.reduce((total, length) => total + length, 0);
  if (!totalLength) {
    return null;
  }
  let remaining = totalLength * fraction;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const length = lengths[index];
    if (!(segment && length)) {
      continue;
    }
    if (remaining <= length) {
      const ratio = remaining / length;
      return [
        segment.start[0] + (segment.end[0] - segment.start[0]) * ratio,
        segment.start[1] + (segment.end[1] - segment.start[1]) * ratio,
      ];
    }
    remaining -= length;
  }
  const last = segments.at(-1)?.end;
  return last ? [last[0], last[1]] : null;
}
function bearingDegrees(from: Coordinate, to: Coordinate) {
  const radians = Math.PI / 180;
  const latitudeFrom = from[1] * radians;
  const latitudeTo = to[1] * radians;
  const longitudeDelta = (to[0] - from[0]) * radians;
  const y = Math.sin(longitudeDelta) * Math.cos(latitudeTo);
  const x =
    Math.cos(latitudeFrom) * Math.sin(latitudeTo) -
    Math.sin(latitudeFrom) * Math.cos(latitudeTo) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) / radians + 360) % 360;
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
type AssetListTab = "cables" | "network";
function cableFamily(asset: NetworkAsset) {
  const value =
    `${asset.cableType ?? ""} ${asset.name} ${asset.attributes?.routeType ?? ""}`.toLocaleUpperCase(
      "id-ID"
    );
  if (value.includes("FEEDER") || value.includes("FDR")) {
    return "feeder";
  }
  if (value.includes("BACKBONE") || value.includes("BB_")) {
    return "backbone";
  }
  if (
    value.includes("SUB-DISTRIBUSI") ||
    value.includes("SUB DISTRIBUSI") ||
    value.includes("BRENCH")
  ) {
    return "sub-distribusi";
  }
  if (
    value.includes("DISTRIBUSI") ||
    value.includes("DST_") ||
    value.includes("DTB_")
  ) {
    return "distribusi";
  }
  return "lainnya";
}
function networkAssetKind(asset: NetworkAsset) {
  const value =
    `${asset.attributes?.assetKind ?? ""} ${asset.name}`.toLocaleUpperCase(
      "id-ID"
    );
  if (value.includes("ODC")) {
    return "odc";
  }
  if (value.includes("ODP")) {
    return "odp";
  }
  if (value.includes("CLOSURE") || value.includes("JC")) {
    return "closure";
  }
  if (value.includes("TIANG") || value.includes("POLE")) {
    return "tiang";
  }
  return "lainnya";
}
function sortCables(a: NetworkAsset, b: NetworkAsset) {
  const priority = (asset: NetworkAsset) =>
    isCoreUsageVerified(asset) ? (asset.idleCores > 0 ? 0 : 1) : 2;
  return priority(a) - priority(b) || a.name.localeCompare(b.name, "id-ID");
}
function SegmentCoreSummary({
  asset,
  inline = false,
}: {
  asset: NetworkAsset;
  inline?: boolean;
}) {
  if (asset.assetType !== "segment") {
    return null;
  }
  if (!asset.totalCores) {
    return <small className="segment-core-empty">Core belum diisi</small>;
  }
  const verified = isCoreUsageVerified(asset);
  return (
    <span
      className={`segment-core-summary${inline ? " segment-core-summary-inline" : ""}`}
    >
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
    <small
      className={`segment-verification-status ms-2 ${verified ? "text-success" : "text-warning"}`}
    >
      {verified ? "Terverifikasi" : "Belum terverifikasi"}
    </small>
  );
}
type SurveyMapRecord = {
  id: string;
  address: string;
  status: string;
  findings?: Record<string, string> | null;
  analysis: {
    latitude?: number;
    longitude?: number;
    distanceMeters?: number | null;
    network?: { name?: string } | null;
    proposal?: {
      kind: string;
      cores: number | null;
      latitude: number;
      longitude: number;
    };
    routeGeometry?: Geometry | null;
    terminationPlan?: TerminationPlan;
  };
};
const surveyStatusLabels: Record<string, string> = {
  WAITING: "Menunggu survei",
  IN_PROGRESS: "Dalam survei",
  REVIEW: "Menunggu verifikasi",
  VERIFIED: "Terverifikasi",
  REVISION: "Perlu revisi",
};
function formatMapCoordinate(latitude: number, longitude: number) {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}
function getSurveyPhotoLocation(survey: SurveyMapRecord) {
  const latitude = Number(survey.findings?.imageLatitude);
  const longitude = Number(survey.findings?.imageLongitude);
  return survey.findings?.imageLatitude &&
    survey.findings.imageLongitude &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
    ? { latitude, longitude }
    : null;
}
function createSurveyMapPopup(
  title: string,
  facts: Array<[string, string | number | null | undefined]>
) {
  const content = document.createElement("div");
  content.className = "survey-map-popup";
  const heading = document.createElement("header");
  heading.className = "map-asset-popup-header";
  const titleElement = document.createElement("h3");
  titleElement.textContent = title;
  heading.append(titleElement);
  content.append(heading);

  const table = document.createElement("table");
  table.className = "table atlas-detail-table map-asset-popup-table";
  table.setAttribute("aria-label", `Detail ${title}`);
  const body = document.createElement("tbody");
  for (const [label, value] of facts) {
    if (value == null || String(value).trim() === "") {
      continue;
    }
    const row = document.createElement("tr");
    const term = document.createElement("th");
    term.scope = "row";
    term.textContent = label;
    const description = document.createElement("td");
    description.textContent = String(value);
    row.append(term, description);
    body.append(row);
  }
  table.append(body);
  content.append(table);
  return content;
}
function isMapMarkerClickTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(".maplibregl-marker") !== null;
}
export function MapPage() {
  const [savedMapSelection] = useState(readSavedMapSelection);
  const proposalSurveys = useQuery({
    queryKey: ["surveys"],
    queryFn: () =>
      api<SurveyMapRecord[]>("/surveys"),
  });
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
  const [provinceCode, setProvinceCode] = useState(
    savedMapSelection.provinceCode
  );
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>(
    savedMapSelection.importIds
  );
  const [selectedCompanyValue, setSelectedCompanyValue] = useState(
    savedMapSelection.companyValue
  );
  const [activeImportId, setActiveImportId] = useState(
    savedMapSelection.activeImportId
  );
  const restorePackageBounds = useRef(savedMapSelection.importIds.length > 0);
  const [globeEnabled, setGlobeEnabled] = useState(true);
  const [satelliteEnabled, setSatelliteEnabled] = useState(false);
  const previousMapView = useRef<{
    center: [number, number];
    zoom: number;
    bearing: number;
    pitch: number;
  } | null>({ center: [118, -2.5], zoom: 5.3, bearing: 0, pitch: 0 });
  const provinceSelectRef = useRef<HTMLSelectElement>(null);
  const packageMenuRef = useRef<HTMLDetailsElement>(null);
  const packageBoundsRequest = useRef(0);
  const importPackages = mapImportsQuery.data ?? [];
  const companyOptions = [
    ...new Set(importPackages.flatMap((item) => item.companies ?? [])),
  ].sort((a, b) => a.localeCompare(b, "id-ID"));
  const selectedImportPackages = importPackages.filter((item) =>
    selectedImportIds.includes(item.id)
  );
  const companyPackages = importPackages.filter((item) =>
    selectedCompanyValue === "__unassigned__"
      ? !item.companies?.length
      : selectedCompanyValue === "__multiple__"
        ? selectedImportIds.includes(item.id)
        : Boolean(
            selectedCompanyValue &&
              item.companies?.includes(selectedCompanyValue)
          )
  );
  const hasUnassignedCompanyPackages = importPackages.some(
    (item) => !item.companies?.length
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
  useEffect(() => {
    try {
      sessionStorage.setItem(
        mapSelectionStorageKey,
        JSON.stringify({
          provinceCode,
          importIds: selectedImportIds,
          companyValue: selectedCompanyValue,
          activeImportId,
        } satisfies SavedMapSelection)
      );
    } catch {
      // Ignore storage restrictions; the map still works for this visit.
    }
  }, [provinceCode, selectedImportIds, selectedCompanyValue, activeImportId]);
  useEffect(() => {
    if (!mapProvincesQuery.isSuccess || !provinceCode) {
      return;
    }
    if (!provinces.some((item) => item.code === provinceCode)) {
      setProvinceCode("");
      setSelectedImportIds([]);
      setSelectedCompanyValue("");
      setActiveImportId("");
    }
  }, [mapProvincesQuery.isSuccess, provinceCode, provinces]);
  useEffect(() => {
    if (!mapImportsQuery.isSuccess) {
      return;
    }
    const availableIds = new Set(importPackages.map((item) => item.id));
    const validImportIds = selectedImportIds.filter((id) =>
      availableIds.has(id)
    );
    setSelectedImportIds((current) =>
      current.length === validImportIds.length ? current : validImportIds
    );
    const nextActiveId =
      activeImportId && validImportIds.includes(activeImportId)
        ? activeImportId
        : ([...validImportIds].reverse()[0] ?? "");
    if (nextActiveId !== activeImportId) {
      setActiveImportId(nextActiveId);
    }
    if (
      selectedCompanyValue &&
      !["__multiple__", "__unassigned__"].includes(selectedCompanyValue) &&
      !importPackages.some((item) =>
        item.companies?.includes(selectedCompanyValue)
      )
    ) {
      setSelectedCompanyValue("");
    }
  }, [
    mapImportsQuery.isSuccess,
    importPackages,
    selectedCompanyValue,
    selectedImportIds,
    activeImportId,
  ]);
  const [assetPage, setAssetPage] = useState(1);
  const [search, setSearch] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [coreFilter, setCoreFilter] = useState("all");
  const [assetListTab, setAssetListTab] = useState<AssetListTab>("cables");
  const [isSegmentPickerOpen, setIsSegmentPickerOpen] = useState(false);
  const [cableFamilyFilter, setCableFamilyFilter] = useState("all");
  const [cableStatusFilter, setCableStatusFilter] = useState("all");
  const [networkKindFilter, setNetworkKindFilter] = useState("all");
  const [coreVerificationSource, setCoreVerificationSource] =
    useState("Survei lapangan");
  const [coreVerificationNote, setCoreVerificationNote] = useState("");
  const [isCoreVerificationExpanded, setIsCoreVerificationExpanded] =
    useState(false);
  const [pendingCoreStatuses, setPendingCoreStatuses] = useState<
    Record<number, PendingCoreChange>
  >({});
  const [expandedCoreConnections, setExpandedCoreConnections] = useState<
    Record<number, boolean>
  >({});

  const [corePageSize, setCorePageSize] = useState(10);
  const [corePage, setCorePage] = useState(1);
  const catalogCoreFilter =
    assetListTab === "network"
      ? "all"
      : coreFilter === "all"
        ? "segments"
        : coreFilter;
  const catalogQuery = useQuery({
    queryKey: [
      "segment-catalog",
      assetPage,
      catalogSearch,
      catalogCoreFilter,
      assetListTab,
      assetListTab === "cables" ? cableFamilyFilter : "all",
      assetListTab === "cables" ? cableStatusFilter : "all",
      assetListTab === "network" ? networkKindFilter : "all",
      provinceCode,
      selectedImportIds,
    ],
    queryFn: () =>
      api<NetworkAssetPage>(
        `/assets/catalog?page=${assetPage}&pageSize=50&search=${encodeURIComponent(catalogSearch)}&coreFilter=${catalogCoreFilter}&assetType=${assetListTab}&cableFamily=${assetListTab === "cables" ? cableFamilyFilter : "all"}&cableStatus=${assetListTab === "cables" ? cableStatusFilter : "all"}&networkKind=${assetListTab === "network" ? networkKindFilter : "all"}${selectedImportIds.length ? `&importIds=${selectedImportIds.join(",")}` : ""}${provinceCode ? `&provinceCode=${provinceCode}` : ""}`
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
  const [assetChoices, setAssetChoices] = useState<NetworkAsset[] | null>(null);
  const [assetChoiceSearch, setAssetChoiceSearch] = useState("");
  const visibleAssetChoices = assetChoices?.filter((asset) => {
    const query = assetChoiceSearch.trim().toLocaleLowerCase("id-ID");
    return (
      !query ||
      [asset.name, asset.area, assetIconCategory(asset)]
        .join(" ")
        .toLocaleLowerCase("id-ID")
        .includes(query)
    );
  });
  const [popupAnchor, setPopupAnchor] = useState<Coordinate | null>(null);
  const [popupPosition, setPopupPosition] = useState({ left: 12, top: 54, maxWidth: 440, maxHeight: 300 });
  const popupElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!assetPopup && !assetChoices?.length) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        popupElement.current?.contains(event.target)
      ) {
        return;
      }
      setAssetPopup(null);
      setAssetChoices(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [assetChoices, assetPopup]);
  useEffect(() => {
    const instance = map.current;
    const element = popupElement.current;
    if (
      !(instance && element && (assetPopup || assetChoices?.length) && popupAnchor)
    ) {
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
        left: container.offsetLeft + Math.max(12, Math.min(left, container.clientWidth - width - 12)),
        top: container.offsetTop + Math.max(
          12,
          Math.min(point.y - height / 2, container.clientHeight - height - 12)
        ),
        maxWidth: Math.max(0, container.clientWidth - 24),
        maxHeight: Math.max(0, container.clientHeight - 24),
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
  }, [assetChoices, assetPopup, popupAnchor]);
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
    () => selectedIconCategories ?? [],
    [selectedIconCategories]
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
  const cableLabelFeatures = useMemo(
    () => lineCollection(allNetworkFeatures.flatMap((feature) => {
      if (feature.properties.assetType !== "segment") return [];
      const lines = feature.geometry.type === "LineString"
        ? [feature.geometry.coordinates]
        : feature.geometry.type === "MultiLineString" ? feature.geometry.coordinates : [];
      const line = lines.reduce<Position[]>((longest, current) => current.length > longest.length ? current : longest, []);
      if (line.length < 2) return [];
      const index = Math.floor((line.length - 1) / 2);
      const a = line[index];
      const b = line[index + 1];
      const coordinates = line.length % 2 ? a : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      return [{ ...feature, geometry: { type: "Point" as const, coordinates } }];
    })),
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
  const selectedAsset = knownAssets.find((item) => item.id === selectedId);
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
  const selectedCableLineColor =
    (allNetworkFeatures.find(
      (feature) => feature.properties.id === selectedSegment?.id
    )?.properties.lineColor as string | undefined) ??
    selectedLegend?.color ??
    "#3454d1";
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
  const occupiedCores = selectedSegment
    ? selectedSegment.usedCores + selectedSegment.bookedCores
    : 0;
  const selectedUtilization = selectedSegment
    ? utilization(selectedSegment)
    : 0;
  const utilizationVerified = selectedSegment
    ? isCoreUsageVerified(selectedSegment)
    : false;
  const usedMeterWidth = selectedSegment?.totalCores
    ? (Math.min(
        Math.max(selectedSegment.usedCores, 0),
        selectedSegment.totalCores
      ) /
        selectedSegment.totalCores) *
      100
    : 0;
  const bookedMeterWidth = selectedSegment?.totalCores
    ? (Math.min(
        Math.max(selectedSegment.bookedCores, 0),
        Math.max(
          selectedSegment.totalCores - Math.max(selectedSegment.usedCores, 0),
          0
        )
      ) /
        selectedSegment.totalCores) *
      100
    : 0;
  const availableMeterWidth = selectedSegment?.totalCores
    ? (Math.min(
        Math.max(selectedSegment.idleCores, 0),
        Math.max(
          selectedSegment.totalCores -
            Math.max(selectedSegment.usedCores, 0) -
            Math.max(selectedSegment.bookedCores, 0),
          0
        )
      ) /
        selectedSegment.totalCores) *
      100
    : 0;
  const coresQuery = useQuery({
    queryKey: ["cores", selectedSegment?.id],
    queryFn: () =>
      api<CoreItem[]>(`/assets/${selectedSegment?.id}/cores`),
    enabled: Boolean(selectedSegment),
    refetchInterval: 30_000,
  });
  const coreEndpointsQuery = useQuery({
    queryKey: ["core-endpoints", selectedSegment?.id],
    queryFn: () =>
      api<CoreEndpoint[]>(`/assets/${selectedSegment?.id}/cores/endpoints`),
    enabled: Boolean(selectedSegment),
    staleTime: 30_000,
  });
  const coreRouteNodesQuery = useQuery({
    queryKey: ["core-route-nodes", selectedSegment?.id],
    queryFn: () =>
      api<CoreRouteNode[]>(
        `/assets/${selectedSegment?.id}/cores/route-nodes`
      ),
    enabled: Boolean(
      selectedSegment &&
      (isCoreVerificationExpanded || isCoreUsageVerified(selectedSegment))
    ),
    staleTime: 30_000,
  });
  const effectiveEndpointNodeId = (side: CoreSide) => {
    const endpointState = coreEndpointsQuery.data?.find(
      (endpoint) => endpoint.side === side
    );
    return endpointState?.endpoint?.nodeAssetId ?? endpointState?.candidates[0]?.id ?? "";
  };
  const corePeerAQuery = useQuery({
    queryKey: [
      "core-connection-peers",
      selectedSegment?.id,
      "A",
      effectiveEndpointNodeId("A"),
    ],
    queryFn: () => {
      const query = new URLSearchParams({
        nodeAssetId: effectiveEndpointNodeId("A"),
        side: "A",
      });
      return api<CorePeer[]>(
        `/assets/${selectedSegment?.id}/cores/connection-peers?${query}`
      );
    },
    enabled: Boolean(selectedSegment && effectiveEndpointNodeId("A")),
    staleTime: 30_000,
  });
  const corePeerBQuery = useQuery({
    queryKey: [
      "core-connection-peers",
      selectedSegment?.id,
      "B",
      effectiveEndpointNodeId("B"),
    ],
    queryFn: () => {
      const query = new URLSearchParams({
        nodeAssetId: effectiveEndpointNodeId("B"),
        side: "B",
      });
      return api<CorePeer[]>(
        `/assets/${selectedSegment?.id}/cores/connection-peers?${query}`
      );
    },
    enabled: Boolean(selectedSegment && effectiveEndpointNodeId("B")),
    staleTime: 30_000,
  });
  const corePageCount = Math.max(
    1,
    Math.ceil((coresQuery.data?.length ?? 0) / corePageSize)
  );
  const visibleCores = [...(coresQuery.data ?? [])]
    .sort((a, b) => a.coreNumber - b.coreNumber)
    .slice((corePage - 1) * corePageSize, corePage * corePageSize);
  const midspanPeerQueryEntries = visibleCores.flatMap((core) => {
    const pending = pendingCoreStatuses[core.coreNumber]?.midspanConnections;
    const drafts = pending ?? (core.midspanConnections ?? []).map((record) => ({
      draftId: record.id,
      nodeAssetId: record.nodeAssetId,
      routeMeasureM: Number(record.routeMeasureM),
      connection:
        record.connectionType === "splice"
          ? {
              connectionType: "splice" as const,
              peerSegmentId: record.peerSegmentId ?? undefined,
              peerCoreNumber: record.peerCoreNumber ?? undefined,
              peerSide: record.peerSide ?? undefined,
              peerRouteMeasureM: record.peerRouteMeasureM == null
                ? undefined
                : Number(record.peerRouteMeasureM),
            }
          : record.connectionType === "device_port"
            ? { connectionType: "device_port" as const, portReference: record.portReference ?? "" }
            : { connectionType: "termination" as const },
    }));
    return drafts
      .filter(
        (draft) =>
          draft.connection?.connectionType === "splice" &&
          Boolean(draft.nodeAssetId) &&
          draft.routeMeasureM !== null
      )
      .map((draft) => ({
        key: `${core.coreNumber}:${draft.draftId}`,
        segmentId: selectedSegment?.id,
        nodeAssetId: draft.nodeAssetId,
        routeMeasureM: Number(draft.routeMeasureM),
      }));
  });
  const midspanPeerResults = useQueries({
    queries: midspanPeerQueryEntries.map((entry) => ({
      queryKey: [
        "core-connection-peers",
        entry.segmentId,
        "R",
        entry.nodeAssetId,
        entry.routeMeasureM,
      ],
      queryFn: () => {
        const query = new URLSearchParams({
          nodeAssetId: entry.nodeAssetId,
          side: "R",
          routeMeasureM: String(entry.routeMeasureM),
        });
        return api<CorePeer[]>(
          `/assets/${entry.segmentId}/cores/connection-peers?${query}`
        );
      },
      enabled: Boolean(entry.segmentId && entry.nodeAssetId),
      staleTime: 30_000,
    })),
  });
  const midspanPeerQueriesByKey = new Map(
    midspanPeerQueryEntries.map((entry, index) => [
      entry.key,
      midspanPeerResults[index],
    ])
  );
  const coreConnectionSummary = useMemo(() => {
    const counts = new Map<string, {
      side: CorePosition;
      nodeAssetName: string;
      count: number;
      routeMeasureM: number | null;
    }>();
    for (const core of coresQuery.data ?? []) {
      for (const side of ["A", "B"] as const) {
        const end = side === "A" ? core.endA : core.endB;
        if (
          !end?.nodeAssetName ||
          !end.connectionType ||
          end.connectionVerificationStatus !== "confirmed"
        ) continue;
        const key = `${side}:${end.nodeAssetName}`;
        const previous = counts.get(key);
        counts.set(key, {
          side,
          nodeAssetName: end.nodeAssetName,
          count: (previous?.count ?? 0) + 1,
          routeMeasureM: null,
        });
      }
      for (const connection of core.midspanConnections ?? []) {
        if (
          connection.verificationStatus !== "confirmed" ||
          !connection.connectionType
        ) continue;
        const routeMeasureM = Number(connection.routeMeasureM);
        const key = `R:${connection.nodeAssetId}:${routeMeasureM.toFixed(2)}`;
        const previous = counts.get(key);
        counts.set(key, {
          side: "R",
          nodeAssetName: connection.nodeAssetName,
          count: (previous?.count ?? 0) + 1,
          routeMeasureM,
        });
      }
    }
    return [...counts.entries()].map(([key, value]) => ({ key, ...value }));
  }, [coresQuery.data]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mapReady is required to populate the source created during map initialization
  useEffect(() => {
    const source = map.current?.getSource("selected-cable-highlight") as
      | GeoJSONSource
      | undefined;
    if (!source) {
      return;
    }

    const features: Feature<Geometry, Record<string, unknown>>[] = [];
    const geometry = selectedCableGeometry;
    if (
      geometry?.type === "LineString" ||
      geometry?.type === "MultiLineString"
    ) {
      const lines = cableCoordinates(geometry);
      const first = lines[0]?.[0];
      const last = lines.at(-1)?.at(-1);
      features.push({
        type: "Feature",
        properties: {
          featureType: "route",
          lineColor: selectedCableLineColor,
        },
        geometry,
      });

      const destinationsBySide = (["A", "B"] as const).map((side) => ({
        side,
        count: coreConnectionSummary
          .filter((item) => item.side === side)
          .reduce((sum, item) => sum + item.count, 0),
      }));

      for (const destination of destinationsBySide) {
        if (!destination.count) {
          continue;
        }
        const endpoint = destination.side === "A" ? first : last;
        // Anchor the marker to the route part that actually reaches this end.
        // For split KMZ lines, a percentage across every component can land on
        // an unrelated part of the imported geometry.
        const endpointLine = destination.side === "A" ? lines[0] : lines.at(-1);
        const arrowCoordinate = endpointLine
          ? coordinateAlongCable(
              [endpointLine],
              destination.side === "A" ? 0.18 : 0.82
            )
          : null;
        if (!endpoint) {
          continue;
        }

        if (arrowCoordinate) {
          const bearing = bearingDegrees(arrowCoordinate, [
            endpoint[0],
            endpoint[1],
          ]);
          features.push({
            type: "Feature",
            properties: {
              featureType: "core-direction-count",
              label: `${destination.count} core · ${destination.side}`,
              lineColor: selectedCableLineColor,
            },
            geometry: { type: "Point", coordinates: arrowCoordinate },
          });
          features.push({
            type: "Feature",
            properties: {
              featureType: "core-direction-arrow",
              lineColor: selectedCableLineColor,
              rotation: (bearing - 90 + 360) % 360,
            },
            geometry: { type: "Point", coordinates: arrowCoordinate },
          });
        }
      }

      const routeLengthM = cableLengthMeters(geometry);
      if (routeLengthM) {
        for (const destination of coreConnectionSummary.filter(
          (item) => item.side === "R" && item.routeMeasureM !== null
        )) {
          const fraction = Math.max(
            0,
            Math.min(1, Number(destination.routeMeasureM) / routeLengthM)
          );
          const arrowCoordinate = coordinateAlongCable(lines, fraction);
          const nextCoordinate = coordinateAlongCable(
            lines,
            Math.min(1, fraction + Math.min(0.02, 20 / routeLengthM))
          );
          if (!arrowCoordinate || !nextCoordinate) continue;
          features.push({
            type: "Feature",
            properties: {
              featureType: "core-direction-count",
              label: `${destination.count} core · jalur`,
              lineColor: selectedCableLineColor,
            },
            geometry: { type: "Point", coordinates: arrowCoordinate },
          });
          features.push({
            type: "Feature",
            properties: {
              featureType: "core-direction-arrow",
              lineColor: selectedCableLineColor,
              rotation: (bearingDegrees(arrowCoordinate, nextCoordinate) - 90 + 360) % 360,
            },
            geometry: { type: "Point", coordinates: arrowCoordinate },
          });
        }
      }

    }

    source.setData({ type: "FeatureCollection", features });
  }, [
    mapReady,
    selectedCableGeometry,
    selectedCableLineColor,
    selectedSegment?.id,
    coreConnectionSummary,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selected segment and page size are triggers that reset paging
  useEffect(() => {
    setCorePage(1);
  }, [selectedSegment?.id, corePageSize]);
  useEffect(() => {
    setCorePage((page) => Math.min(page, corePageCount));
  }, [corePageCount]);
  const verifyCoreUsage = useMutation({
    meta: { successNotice: "Data core berhasil disimpan.", errorNotice: "Tindakan gagal diproses." },

    mutationFn: (changes: {
      coreStatuses: {
        coreNumber: number;
        status: "Available" | "Used";
        endConnections?: Partial<Record<CoreSide, CoreEndDraft>>;
        midspanConnections?: {
          nodeAssetId: string;
          routeMeasureM: number | null;
          connection: CoreEndDraft;
        }[];
      }[];
      segmentEndpoints: Partial<Record<CoreSide, string | null>>;
    }) =>
      api<{
        verifiedAt: string;
      }>(`/assets/${selectedSegment?.id}/cores/verify`, {
        method: "POST",
        data: {
          source: coreVerificationSource,
          note: coreVerificationNote,
          coreStatuses: changes.coreStatuses,
          segmentEndpoints: changes.segmentEndpoints,
        },
      }),
    onSuccess: async () => {
      setCoreVerificationNote("");
      setPendingCoreStatuses({});
      setIsCoreVerificationExpanded(false);
      await Promise.all([
        invalidateNetwork(),
        queryClient.invalidateQueries({
          queryKey: ["cores", selectedSegment?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["core-endpoints", selectedSegment?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["core-connection-peers", selectedSegment?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["core-route-nodes", selectedSegment?.id],
        }),
      ]);
    },
  });
  const updateAsset = useMutation({
    meta: { successNotice: "Detail aset berhasil diperbarui.", errorNotice: "Tindakan gagal diproses." },

    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      api(`/assets/${id}`, { method: "PATCH", data }),
    onSuccess: () => invalidateNetwork(),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedSegment?.id is the trigger: clear mutation state when the selection changes
  useEffect(() => {
    updateAsset.reset();
    setIsCoreVerificationExpanded(false);
    setPendingCoreStatuses({});
    setExpandedCoreConnections({});
  }, [selectedSegment?.id, updateAsset.reset]);
  const normalizedSearch = search.trim().toLocaleLowerCase("id-ID");
  const matchesCableFilters = (item: NetworkAsset) =>
    item.assetType === "segment" &&
    (cableFamilyFilter === "all" || cableFamily(item) === cableFamilyFilter) &&
    (cableStatusFilter === "all" ||
      (cableStatusFilter === "verified" && isCoreUsageVerified(item)) ||
      (cableStatusFilter === "unverified" && !isCoreUsageVerified(item)) ||
      (cableStatusFilter === "available" &&
        isCoreUsageVerified(item) &&
        item.idleCores > 0) ||
      (cableStatusFilter === "unavailable" &&
        isCoreUsageVerified(item) &&
        item.idleCores <= 0));
  const filteredSegments = networkSegments
    .filter(
      (item) =>
        item.source !== "kml" &&
        matchesCableFilters(item) &&
        matchesAssetSearch(item, normalizedSearch)
    )
    .sort(sortCables);
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
  const filteredImported = matchedImported
    .filter((item) =>
      assetListTab === "cables"
        ? matchesCableFilters(item)
        : item.assetType !== "segment" &&
          (networkKindFilter === "all" ||
            networkAssetKind(item) === networkKindFilter)
    )
    .sort(
      assetListTab === "cables"
        ? sortCables
        : (a, b) => a.name.localeCompare(b.name, "id-ID")
    )
    .slice(0, 100);
  const visibleAssets =
    assetListTab === "cables"
      ? [...filteredSegments, ...filteredImported]
      : filteredImported;
  useEffect(() => {
    if (!catalogQuery.isPending && visibleAssets.length === 0 && selectedId) {
      setSelectedId("");
    }
  }, [catalogQuery.isPending, visibleAssets.length, selectedId]);
  const catalogPageCount = Math.max(
    1,
    Math.ceil(
      (catalogQuery.data?.total ?? 0) / (catalogQuery.data?.pageSize ?? 50)
    )
  );
  useEffect(() => {
    if (
      !catalogQuery.isPending &&
      !catalogQuery.isPlaceholderData &&
      assetPage > catalogPageCount
    ) {
      setAssetPage(catalogPageCount);
    }
  }, [
    assetPage,
    catalogPageCount,
    catalogQuery.isPending,
    catalogQuery.isPlaceholderData,
  ]);
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
    const navigation = new NavigationControl();
    const fullscreen = new FullscreenControl({
      container: mapElement.current.parentElement ?? undefined,
    });
    instance.addControl({
      onAdd(mapInstance) {
        const group = navigation.onAdd(mapInstance);
        group.append(...fullscreen.onAdd(mapInstance).children);
        return group;
      },
      onRemove() {
        fullscreen.onRemove();
        navigation.onRemove();
      },
    }, "top-right");
    instance.on("error", (event) => {
      if (!("sourceId" in event && event.sourceId === "satellite-imagery")) {
        setMapError(true);
      }
    });
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
      instance.addSource("network-cable-labels", { type: "geojson", data: cableLabelFeatures });
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
        attribution:
          "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
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
        id: "network-cable-labels",
        type: "symbol",
        source: "network-cable-labels",
        layout: {
          "text-field": ["to-string", ["coalesce", ["get", "sourceLabel"], ["get", "name"], ""]],
          "text-font": ["Open Sans Semibold"],
          "text-size": 12,
          "text-allow-overlap": false,
          "text-ignore-placement": false,
          "text-padding": 3,
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#17233b",
          "text-halo-width": 2,
        },
      });
      instance.addSource("selected-cable-highlight", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      instance.addLayer({
        id: "selected-cable-casing",
        type: "line",
        source: "selected-cable-highlight",
        filter: ["==", ["get", "featureType"], "route"],
        paint: {
          "line-color": "#ffffff",
          "line-width": 9,
          "line-opacity": 0.96,
        },
      });
      instance.addLayer({
        id: "selected-cable-route",
        type: "line",
        source: "selected-cable-highlight",
        filter: ["==", ["get", "featureType"], "route"],
        paint: {
          "line-color": ["get", "lineColor"],
          "line-width": 5,
          "line-opacity": 1,
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
      instance.moveLayer("network-cable-labels");
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
      instance.addLayer({
        id: "selected-cable-core-direction-count",
        type: "symbol",
        source: "selected-cable-highlight",
        filter: ["==", ["get", "featureType"], "core-direction-count"],
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Open Sans Semibold"],
          "text-size": 12,
          "text-offset": [0, -1.5],
          "text-anchor": "bottom",
          "text-padding": 4,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": ["get", "lineColor"],
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
        },
      });
      instance.addLayer({
        id: "selected-cable-core-direction-arrows",
        type: "symbol",
        source: "selected-cable-highlight",
        filter: ["==", ["get", "featureType"], "core-direction-arrow"],
        layout: {
          "text-field": "➤",
          "text-font": ["Open Sans Semibold"],
          "text-size": 18,
          "text-rotate": ["get", "rotation"],
          "text-rotation-alignment": "map",
          "text-keep-upright": false,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
        },
        paint: {
          "text-color": ["get", "lineColor"],
          "text-halo-color": "#ffffff",
          "text-halo-width": 2,
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
            setSelectedCompanyValue("");
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
        if (isMapMarkerClickTarget(event.originalEvent.target)) {
          return;
        }
        if (modeRef.current !== "idle") {
          return;
        }
        const pointAssets = pointCandidatesAtCursor(instance, event.point)
          .map((feature) =>
            knownAssetsRef.current.find(
              (asset) => asset.id === String(feature.properties?.id ?? feature.id)
            )
          )
          .filter(
            (asset): asset is NetworkAsset => asset !== undefined
          );
        const uniquePointAssets = [
          ...new Map(pointAssets.map((asset) => [asset.id, asset])).values(),
        ];
        if (uniquePointAssets.length) {
          const anchor: Coordinate = [event.lngLat.lng, event.lngLat.lat];
          // A rendered point is the intended target even when its KMZ record
          // is classified as a cable. Keep the coincident line from taking
          // over the cable-detail panel for this click.
          setSelectedId("");
          setAssetPage(1);
          setSearch("");
          setIsSegmentPickerOpen(false);
          setAssetListTab("network");
          setPopupAnchor(anchor);
          if (uniquePointAssets.length > 1) {
            setAssetPopup(null);
            setAssetChoices(uniquePointAssets);
            setAssetChoiceSearch("");
          } else {
            setAssetChoices(null);
            setAssetPopup(uniquePointAssets[0]);
          }
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
        const pointFeature = pointFeatureAtCursor(instance, event.point);
        const feature =
          pointFeature ??
          cable ??
          boundary ??
          features[0];
        const id = String(feature?.properties?.id ?? "");
        if (id) {
          const clickedAsset = knownAssetsRef.current.find(
            (asset) => asset.id === id
          );
          const isPointHit = feature?.geometry.type === "Point";
          setSelectedId(isPointHit ? "" : id);
          const isCable =
            !isPointHit &&
            (clickedAsset?.assetType === "segment" ||
              ["LineString", "MultiLineString"].includes(
                String(feature?.properties?.geometryType)
              ));
          if (isPointHit) {
            setAssetListTab("network");
          } else if (isCable) {
            setAssetListTab("cables");
            setCableFamilyFilter("all");
            setCableStatusFilter("all");
            setCoreFilter("all");
            setAssetPage(1);
            setSearch("");
            setIsSegmentPickerOpen(false);
          } else {
            setSearch("");
            setIsSegmentPickerOpen(false);
          }
          if (clickedAsset && !isCable && !isPointHit) {
            setAssetListTab("network");
          }
          setPopupAnchor([event.lngLat.lng, event.lngLat.lat]);
          setAssetChoices(null);
          setAssetPopup(clickedAsset ?? null);
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
    const instance = map.current;
    if (!instance || !mapReady) {
      return;
    }
    const completedSurveys = (proposalSurveys.data ?? []).filter(
      (survey) => survey.status === "VERIFIED"
    );
    const markers: Marker[] = [];
    const addMarker = (
      coordinates: Coordinate,
      ariaLabel: string,
      content: HTMLElement,
      style = "width:22px;height:22px;border:3px dashed #e77a12;border-radius:50%;background:white;cursor:pointer"
    ) => {
      const element = document.createElement("div");
      element.style.cssText = style;
      element.setAttribute("aria-label", ariaLabel);
      element.setAttribute("role", "button");
      element.setAttribute("tabindex", "0");
      const marker = new Marker({ element })
        .setLngLat(coordinates)
        .setPopup(
          new Popup({ closeButton: true, maxWidth: "460px" }).setDOMContent(
            content
          )
        )
        .addTo(instance);
      markers.push(marker);
    };
    for (const survey of completedSurveys) {
      const proposal = survey.analysis.proposal;
      const photoLocation = getSurveyPhotoLocation(survey);
      const analysisLocation = proposal
        ? { latitude: proposal.latitude, longitude: proposal.longitude }
        : Number.isFinite(survey.analysis.latitude) &&
            Number.isFinite(survey.analysis.longitude)
          ? {
              latitude: survey.analysis.latitude!,
              longitude: survey.analysis.longitude!,
            }
          : null;
      const markerLocation = photoLocation ?? analysisLocation;
      const findings = survey.findings ?? {};
      const sharedFacts: Array<[
        string,
        string | number | null | undefined
      ]> = [
        ["Status survei", surveyStatusLabels[survey.status] ?? survey.status],
        ["Alamat survei", survey.address],
        ["Jaringan sumber", survey.analysis.network?.name],
        ["Titik sambungan aktual", findings.connection],
        ["Jalur kabel aktual", findings.route],
        [
          "Panjang aktual",
          findings.length ? `${findings.length} m` : undefined,
        ],
        ["Kapasitas / core", findings.capacity],
        ["Bukti survei", findings.evidence],
      ];

      if (markerLocation) {
        const coordinate = formatMapCoordinate(
          markerLocation.latitude,
          markerLocation.longitude
        );
        const proposalCoordinate = proposal
          ? formatMapCoordinate(proposal.latitude, proposal.longitude)
          : undefined;
        const isPhotoLocation = photoLocation !== null;
        const coreCount = proposal?.cores;
        addMarker(
          [markerLocation.longitude, markerLocation.latitude],
          `Survei terverifikasi · ${proposal?.kind ?? "titik lokasi"} · ${survey.address}`,
          createSurveyMapPopup("Lokasi survei terverifikasi", [
            ...sharedFacts,
            [
              isPhotoLocation ? "Koordinat foto GPS" : "Koordinat titik survei",
              coordinate,
            ],
            proposalCoordinate && isPhotoLocation
              ? ["Koordinat awal analisis", proposalCoordinate]
              : ["Jenis usulan", proposal?.kind],
            [
              "Kapasitas usulan",
              coreCount == null ? undefined : `${coreCount} core`,
            ],
            [
              "Catatan lokasi",
              isPhotoLocation
                ? "Posisi diambil dari metadata GPS foto survei."
                : "Posisi mengikuti titik analisis awal; koordinat foto GPS tidak tersedia.",
            ],
          ])
        );
      }

      const plan = survey.analysis.terminationPlan;
      if (!plan) {
        continue;
      }
      for (const point of plan.routeEvidence ?? []) {
        if (point.id === survey.analysis.terminationPlan!.targetId) {
          continue;
        }
        addMarker(
          [point.longitude, point.latitude],
          `Aset terdata ${point.type} · ${point.name}`,
          createSurveyMapPopup("Aset terdata di dekat jalur", [
            ["Nama aset", point.name],
            ["Jenis aset", point.type],
            [
              "Koordinat aset",
              formatMapCoordinate(point.latitude, point.longitude),
            ],
            ["Jarak dari jalur usulan", `${Math.round(point.distanceToRouteMeters)} m`],
            ["Kabel tercatat", `${point.recordedCables} relasi`],
            ...sharedFacts.slice(0, 2),
            ["Catatan", "Kedekatan tidak memastikan sambungan fisik."],
          ]),
          "width:32px;height:32px;border:3px solid #00a6b2;border-radius:50%;background:transparent;cursor:pointer"
        );
      }
      for (const [index, point] of (plan.deviceCandidates ?? []).entries()) {
        addMarker(
          [point.longitude, point.latitude],
          `${point.basis === "PLANNING" ? "Simulasi" : "Kandidat"} ${point.kind}`,
          createSurveyMapPopup(
            `${point.basis === "PLANNING" ? "Titik simulasi" : "Kandidat aset"} · ${point.kind}`,
            [
              ["Nomor titik", `${point.kind} ${String(index + 1).padStart(2, "0")}`],
              ["Koordinat titik", formatMapCoordinate(point.latitude, point.longitude)],
              ["Jarak dari jalur", point.distanceToEvidenceMeters == null ? undefined : `${Math.round(point.distanceToEvidenceMeters)} m`],
              ["Dasar penempatan", point.reason],
              ...sharedFacts.slice(0, 2),
              ["Status", "Titik rencana, bukan aset aktif."],
            ]
          )
        );
      }
      for (const point of plan.connectionCandidates ?? []) {
        addMarker(
          [point.longitude, point.latitude],
          `Potensi sambungan · ${point.cableName}`,
          createSurveyMapPopup("Potensi sambungan kabel", [
            ["Kabel", point.cableName],
            ["Jenis terminasi", point.recommendedKind ?? "Belum ditentukan"],
            ["Koordinat titik", formatMapCoordinate(point.latitude, point.longitude)],
            ["Jarak dari jalur", `${Math.round(point.distanceMeters)} m`],
            ...sharedFacts.slice(0, 2),
            ["Catatan", "Kedekatan belum memastikan sambungan diperlukan."],
          ])
        );
      }
      for (const point of plan.points) {
        addMarker(
          [point.longitude, point.latitude],
          `Titik rencana ${point.kind}`,
          createSurveyMapPopup("Titik rencana terminasi", [
            ["Jenis titik", point.kind === "JOINT_CLOSURE" ? "Closure" : point.kind],
            ["Koordinat titik", formatMapCoordinate(point.latitude, point.longitude)],
            ["Kabel sumber", plan.sourceCable?.name],
            ...sharedFacts.slice(0, 2),
            ["Status titik", "Usulan survei terverifikasi; belum menjadi aset aktif."],
          ])
        );
      }
    }
    const features: Feature[] = completedSurveys.flatMap((survey) => {
      const plan = survey.analysis.terminationPlan;
      const findings = survey.findings ?? {};
      const photoLocation = getSurveyPhotoLocation(survey);
      if (plan) {
        const endpoints = describeCableEndpoints(
          plan,
          survey.analysis.network?.name
        );
        return plan.cables.map((cable, index) => ({
          type: "Feature" as const,
          geometry: cable.geometry,
          properties: {
            surveyAddress: survey.address,
            surveyStatus: surveyStatusLabels[survey.status] ?? survey.status,
            networkName: survey.analysis.network?.name ?? "",
            cableName: `Kabel ${String(index + 1).padStart(2, "0")}`,
            cableType: cable.type,
            capacity: cable.cores == null ? "Belum ditentukan" : `${cable.cores} core`,
            requiredCores: plan.requirement?.requiredCores == null
              ? "Belum ditentukan"
              : `${plan.requirement.requiredCores} core`,
            estimatedLength: `${Math.round(cable.distanceMeters)} m`,
            sourceCable: plan.sourceCable?.name ?? "Belum ditentukan",
            endpointFrom: endpoints.from,
            endpointTo: endpoints.to,
            photoLocation: photoLocation
              ? formatMapCoordinate(photoLocation.latitude, photoLocation.longitude)
              : "",
            actualRoute: findings.route ?? "",
            actualLength: findings.length ? `${findings.length} m` : "",
            actualCapacity: findings.capacity ?? "",
            evidence: findings.evidence ?? "",
          },
        }));
      }
      if (survey.analysis.routeGeometry) {
        return [
          {
            type: "Feature" as const,
            geometry: survey.analysis.routeGeometry,
            properties: {
              surveyAddress: survey.address,
              surveyStatus: surveyStatusLabels[survey.status] ?? survey.status,
              networkName: survey.analysis.network?.name ?? "",
              cableName: "Rute hasil analisis",
              cableType: survey.analysis.proposal?.kind ?? "Belum ditentukan",
              capacity:
                survey.analysis.proposal?.cores == null
                  ? "Belum ditentukan"
                  : `${survey.analysis.proposal.cores} core`,
              requiredCores: "Belum ditentukan",
              estimatedLength:
                survey.analysis.distanceMeters == null
                  ? "Belum ditentukan"
                  : `${Math.round(survey.analysis.distanceMeters)} m`,
              sourceCable: survey.analysis.network?.name ?? "Belum ditentukan",
              endpointFrom: survey.analysis.network?.name ?? "Belum ditentukan",
              endpointTo: "Lokasi survei",
              photoLocation: photoLocation
                ? formatMapCoordinate(photoLocation.latitude, photoLocation.longitude)
                : "",
              actualRoute: findings.route ?? "",
              actualLength: findings.length ? `${findings.length} m` : "",
              actualCapacity: findings.capacity ?? "",
              evidence: findings.evidence ?? "",
            },
          },
        ];
      }
      return [];
    });
    if (instance.getSource("survey-proposal-routes")) {
      (instance.getSource("survey-proposal-routes") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features,
      });
    } else {
      instance.addSource("survey-proposal-routes", {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });
      instance.addLayer(
        {
          id: "survey-proposal-routes",
          type: "line",
          source: "survey-proposal-routes",
          paint: {
            "line-color": "#e77a12",
            "line-width": 3,
            "line-dasharray": [2, 2],
          },
        },
        "network-cable-labels"
      );
    }
    const onPlannedRouteClick = (event: MapLayerMouseEvent) => {
      if (isMapMarkerClickTarget(event.originalEvent.target)) {
        return;
      }
      const properties = event.features?.[0]?.properties;
      if (!properties) {
        return;
      }
      new Popup({ closeButton: true, maxWidth: "460px" })
        .setLngLat(event.lngLat)
        .setDOMContent(
          createSurveyMapPopup("Jalur usulan survei", [
            ["Status survei", properties.surveyStatus],
            ["Alamat survei", properties.surveyAddress],
            ["Jaringan sumber", properties.networkName],
            ["Nama ruas", properties.cableName],
            ["Jenis kabel", properties.cableType],
            ["Kapasitas", properties.capacity],
            ["Core dibutuhkan", properties.requiredCores],
            ["Perkiraan panjang", properties.estimatedLength],
            ["Kabel sumber", properties.sourceCable],
            ["Dari", properties.endpointFrom],
            ["Ke", properties.endpointTo],
            ["Koordinat foto GPS", properties.photoLocation],
            ["Jalur aktual hasil survei", properties.actualRoute],
            ["Panjang aktual", properties.actualLength],
            ["Kapasitas / core aktual", properties.actualCapacity],
            ["Bukti survei", properties.evidence],
            [
              "Lokasi pada jalur",
              formatMapCoordinate(event.lngLat.lat, event.lngLat.lng),
            ],
            ["Status aset", "Masih berupa rencana, belum menjadi aset aktif."],
          ])
        )
        .addTo(instance);
    };
    const onPlannedRouteEnter = () => {
      instance.getCanvas().style.cursor = "pointer";
    };
    const onPlannedRouteLeave = () => {
      instance.getCanvas().style.cursor = "";
    };
    instance.on("click", "survey-proposal-routes", onPlannedRouteClick);
    instance.on("mouseenter", "survey-proposal-routes", onPlannedRouteEnter);
    instance.on("mouseleave", "survey-proposal-routes", onPlannedRouteLeave);
    return () => {
      instance.off("click", "survey-proposal-routes", onPlannedRouteClick);
      instance.off("mouseenter", "survey-proposal-routes", onPlannedRouteEnter);
      instance.off("mouseleave", "survey-proposal-routes", onPlannedRouteLeave);
      instance.getCanvas().style.cursor = "";
      for (const marker of markers) {
        marker.remove();
      }
    };
  }, [mapReady, proposalSurveys.data]);
  useEffect(() => {
    const province = provinces.find((item) => item.code === provinceCode);
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
    setAssetChoices(null);
  }, [mapReady, provinceCode, provinces]);
  useEffect(() => {
    if (
      !restorePackageBounds.current ||
      !mapReady ||
      !mapImportsQuery.isSuccess ||
      !mapProvincesQuery.isSuccess ||
      !provinces.some((item) => item.code === provinceCode)
    ) {
      return;
    }
    restorePackageBounds.current = false;
    const availableIds = new Set(importPackages.map((item) => item.id));
    const ids = selectedImportIds.filter((id) => availableIds.has(id));
    if (!ids.length) {
      return;
    }
    const request = ++packageBoundsRequest.current;
    void api<{ bounds: [number, number, number, number] | null }>(
      `/assets/bounds?importIds=${ids.join(",")}&provinceCode=${encodeURIComponent(provinceCode)}`
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
          setFileError("Batas paket peta gagal dipulihkan.");
        }
      });
  }, [
    importPackages,
    mapImportsQuery.isSuccess,
    mapProvincesQuery.isSuccess,
    mapReady,
    provinceCode,
    provinces,
    selectedImportIds,
  ]);
  useEffect(() => {
    (
      map.current?.getSource("network-shapes") as GeoJSONSource | undefined
    )?.setData(shapeFeatures);
    (
      map.current?.getSource("network-points-data") as GeoJSONSource | undefined
    )?.setData(pointFeatures);
    (
      map.current?.getSource("network-cable-labels") as GeoJSONSource | undefined
    )?.setData(cableLabelFeatures);
  }, [shapeFeatures, pointFeatures, cableLabelFeatures]);
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
      const updatedPackages =
        queryClient.getQueryData<MapImportPackage[]>(["network-map-imports"]) ??
        [];
      const selectedPackages = updatedPackages.filter((item) =>
        packageIds.includes(item.id)
      );
      const importedCompanies = [
        ...new Set(selectedPackages.flatMap((item) => item.companies ?? [])),
      ];
      setSelectedCompanyValue(
        importedCompanies.length === 0
          ? "__unassigned__"
          : importedCompanies.length === 1 &&
              selectedPackages.every((item) => item.companies?.length)
            ? importedCompanies[0]
            : "__multiple__"
      );
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
      notify("File jaringan berhasil diimpor.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "File tidak dapat dibaca.";
      setFileError(message);
      notify(message, "error");
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
    setAssetChoices(null);
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
  function selectCompanyPackages(company: string) {
    setSelectedCompanyValue(company);
    const matchingPackages = company
      ? company === "__unassigned__"
        ? importPackages.filter((item) => !item.companies?.length)
        : importPackages.filter((item) => item.companies?.includes(company))
      : [];
    const packageIds = matchingPackages.map((item) => item.id);
    const nextActiveId = packageIds.includes(activeImportId)
      ? activeImportId
      : (packageIds[packageIds.length - 1] ?? "");
    const request = ++packageBoundsRequest.current;
    setSelectedImportIds(packageIds);
    setActiveImportId(nextActiveId);
    setSelectedId("");
    setAssetPopup(null);
    setAssetChoices(null);
    setSelectedIconCategories(null);
    setAssetPage(1);
    setFileError("");
    if (!packageIds.length) {
      setMapBounds(selectedProvince?.bounds ?? null);
      return;
    }
    void api<{
      bounds: [number, number, number, number] | null;
    }>(
      `/assets/bounds?importIds=${packageIds.join(",")}${provinceCode ? `&provinceCode=${provinceCode}` : ""}`
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
          setFileError("Batas paket perusahaan gagal dimuat.");
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
    setSearch("");
    setIsSegmentPickerOpen(false);
    setAssetPopup(null);
    setAssetChoices(null);
    await focusGeometry(asset.id, asset.geometry);
  };
  return (
    <>
      <PageHeader
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
          <div className="map-province-filter">
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
                setSelectedCompanyValue("");
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
              ref={provinceSelectRef}
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
          <section
            aria-label="Pilih perusahaan dan paket KMZ"
            className="map-package-picker"
          >
            <header>
              <label
                className="form-label fw-semibold text-uppercase mb-1"
                htmlFor="map-company-select"
              >
                Pilih perusahaan
              </label>
              <button
                aria-label="Riwayat proses impor"
                className="map-package-history"
                disabled={!provinceCode}
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
            <select
              className="form-select form-select-sm mb-2"
              disabled={
                !provinceCode ||
                mapImportsQuery.isPending ||
                mapImportsQuery.isError ||
                !importPackages.length
              }
              id="map-company-select"
              onChange={(event) => selectCompanyPackages(event.target.value)}
              value={selectedCompanyValue}
            >
              <option value="">Pilih perusahaan</option>
              {companyOptions.map((company) => (
                <option key={company} value={company}>
                  {company} ·{" "}
                  {
                    importPackages.filter((item) =>
                      item.companies?.includes(company)
                    ).length
                  }{" "}
                  paket
                </option>
              ))}
              {hasUnassignedCompanyPackages && (
                <option value="__unassigned__">
                  Tanpa perusahaan ·{" "}
                  {
                    importPackages.filter((item) => !item.companies?.length)
                      .length
                  }{" "}
                  paket
                </option>
              )}
              {selectedCompanyValue === "__multiple__" && (
                <option disabled value="__multiple__">
                  Beberapa perusahaan
                </option>
              )}
            </select>
            {!provinceCode && (
              <button
                className="map-province-guidance"
                onClick={() => {
                  provinceSelectRef.current?.focus();
                  try {
                    provinceSelectRef.current?.showPicker();
                  } catch {
                    // Focus still moves to the province selector if showPicker is unavailable.
                  }
                }}
                type="button"
              >
                Pilih provinsi dulu
              </button>
            )}
            <div className="form-label fw-semibold text-uppercase mb-1">
              Pilih paket KMZ
            </div>
            {provinceCode ? (
              <details ref={packageMenuRef}>
                <summary className="form-select form-select-sm">
                  <span title={activeImportPackage?.name}>
                    {activeImportPackage?.name ?? "Pilih paket KMZ"}
                  </span>
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
                  {!selectedCompanyValue &&
                    !mapImportsQuery.isPending &&
                    !mapImportsQuery.isError &&
                    importPackages.length > 0 && (
                      <small>Pilih perusahaan terlebih dahulu.</small>
                    )}
                  {companyPackages.map((item) => {
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
                          onChange={() => toggleMapPackage(item.id)}
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
            ) : (
              <div
                aria-disabled="true"
                className="map-package-disabled form-select form-select-sm"
              >
                Pilih provinsi terlebih dahulu
              </div>
            )}
            {selectedImportPackages.length > 0 && (
              <small className="map-package-summary">
                {selectedImportPackages.length} paket ditampilkan · paket aktif
                digunakan untuk edit dan ekspor
              </small>
            )}
          </section>
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
          {Boolean(
            proposalSurveys.data?.some(
              (survey) =>
                survey.status === "VERIFIED" &&
                (survey.analysis.proposal || survey.analysis.terminationPlan)
            )
          ) && (
            <div className="alert alert-warning small">
              Penanda oranye dan garis putus-putus menunjukkan usulan survei
              terverifikasi yang belum menjadi aset aktif. Klik titik atau
              jalur untuk melihat alamat, koordinat, dan hasil pemeriksaan.
              Lingkaran biru kehijauan menandai aset terdata dekat jalur, bukan
              bukti sambungan.
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
              className="btn btn-light atlas-choice"
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
                if (globeEnabled) {
                  instance.setProjection({ type: "mercator" });
                  instance.setMaxBounds(indonesiaBounds);
                  if (previousMapView.current && instance.getZoom() < 4) {
                    instance.flyTo(previousMapView.current);
                  }
                } else {
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
          {(assetPopup || assetChoices?.length) &&
            (() => {
              if (assetChoices?.length) {
                return (
                  <div
                    aria-label="Pilih aset pada titik ini"
                    className="map-asset-popup map-asset-chooser"
                    ref={popupElement}
                    role="dialog"
                    style={popupPosition}
                  >
                    <header className="map-asset-popup-header">
                      <div>
                        <h3>Pilih aset pada titik ini</h3>
                        <small>
                          {assetChoices.length} aset bertumpuk di area klik.
                        </small>
                      </div>
                      <button
                        aria-label="Tutup pilihan aset"
                        className="btn-close"
                        onClick={() => setAssetChoices(null)}
                        type="button"
                      />
                    </header>
                    <input
                      aria-label="Cari aset di titik ini"
                      className="form-control form-control-sm map-asset-choice-search"
                      onChange={(event) => setAssetChoiceSearch(event.target.value)}
                      placeholder="Cari nama atau jenis aset"
                      type="search"
                      value={assetChoiceSearch}
                    />
                    <div className="map-asset-choice-list">
                      {visibleAssetChoices?.map((asset) => (
                        <button
                          aria-label={`Pilih ${assetIconCategory(asset)} · ${asset.name}`}
                          className="map-asset-choice-option"
                          key={asset.id}
                          onClick={() => {
                            setAssetChoices(null);
                            setSelectedId("");
                            setAssetPage(1);
                            setSearch("");
                            setIsSegmentPickerOpen(false);
                            setAssetListTab("network");
                            setAssetPopup(asset);
                          }}
                          type="button"
                        >
                          <span className="map-asset-choice-name">
                            {asset.name}
                          </span>
                          <small>
                            {assetIconCategory(asset)}
                            {asset.area ? ` · ${asset.area}` : ""}
                          </small>
                        </button>
                      ))}
                      {!visibleAssetChoices?.length && (
                        <p className="map-asset-choice-empty">
                          Tidak ada aset yang cocok dengan pencarian.
                        </p>
                      )}
                    </div>
                  </div>
                );
              }
              if (!assetPopup) {
                return null;
              }
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
                        {assetDetailTitle(assetPopup)}
                      </h3>
                      {assetPopup.source === "kml" && (
                        <small>Atribut asli dari KMZ</small>
                      )}
                    </div>
                    <button
                      aria-label="Tutup"
                      className="btn-close"
                      onClick={() => {
                        setAssetPopup(null);
                        setAssetChoices(null);
                      }}
                      type="button"
                    />
                  </header>
                  <DetailTable
                    className="map-asset-popup-table"
                    label="Atribut detail aset"
                    rows={fields.map(([label, value], index) => ({
                      key: String(index),
                      label,
                      value: String(value),
                    }))}
                  />
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
              <div
                aria-label="Kategori aset jaringan"
                className="asset-list-tabs"
                role="tablist"
              >
                <button
                  aria-selected={assetListTab === "cables"}
                  className={assetListTab === "cables" ? "active" : ""}
                  onClick={() => {
                    setAssetListTab("cables");
                    setSelectedId("");
                    setAssetPage(1);
                    setSearch("");
                    setIsSegmentPickerOpen(false);
                  }}
                  role="tab"
                  type="button"
                >
                  Kabel
                </button>
                <button
                  aria-selected={assetListTab === "network"}
                  className={assetListTab === "network" ? "active" : ""}
                  onClick={() => {
                    setAssetListTab("network");
                    setSelectedId("");
                    setAssetPage(1);
                    setSearch("");
                    setIsSegmentPickerOpen(false);
                  }}
                  role="tab"
                  type="button"
                >
                  Aset jaringan
                </button>
              </div>
              {assetListTab === "cables" ? (
                <div className="asset-list-filters mt-2">
                  <div>
                    <label
                      className="form-label small mb-1"
                      htmlFor="map-cable-family"
                    >
                      Jenis kabel
                    </label>
                    <select
                      className="form-select form-select-sm"
                      disabled={!(provinceCode || selectedImportIds.length)}
                      id="map-cable-family"
                      onChange={(event) => {
                        setCableFamilyFilter(event.target.value);
                        setAssetPage(1);
                      }}
                      value={cableFamilyFilter}
                    >
                      <option value="all">Semua kabel</option>
                      <option value="feeder">Feeder</option>
                      <option value="backbone">Backbone</option>
                      <option value="distribusi">Distribusi</option>
                      <option value="sub-distribusi">Sub-distribusi</option>
                    </select>
                  </div>
                  <div>
                    <label
                      className="form-label small mb-1"
                      htmlFor="map-cable-status"
                    >
                      Status kabel
                    </label>
                    <select
                      className="form-select form-select-sm"
                      disabled={!(provinceCode || selectedImportIds.length)}
                      id="map-cable-status"
                      onChange={(event) => {
                        setCableStatusFilter(event.target.value);
                        setAssetPage(1);
                      }}
                      value={cableStatusFilter}
                    >
                      <option value="all">Semua status</option>
                      <option value="verified">Terverifikasi</option>
                      <option value="unverified">Belum terverifikasi</option>
                      <option value="available">Tersedia</option>
                      <option value="unavailable">Tidak tersedia</option>
                    </select>
                  </div>
                  <div>
                    <label
                      className="form-label small mt-2 mb-1"
                      htmlFor="map-core-filter"
                    >
                      Kapasitas
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
                      <option value="all">Semua kapasitas</option>
                      <option value="segments">Semua segmen</option>
                      <option value="filled">Core sudah diisi</option>
                      <option value="empty">Core belum diisi</option>
                    </select>
                  </div>
                </div>
              ) : (
                <div className="mt-2">
                  <label
                    className="form-label small mb-1"
                    htmlFor="map-network-kind"
                  >
                    Jenis aset
                  </label>
                  <select
                    className="form-select form-select-sm"
                    disabled={!(provinceCode || selectedImportIds.length)}
                    id="map-network-kind"
                    onChange={(event) => {
                      setNetworkKindFilter(event.target.value);
                      setAssetPage(1);
                    }}
                    value={networkKindFilter}
                  >
                    <option value="all">Semua aset jaringan</option>
                    <option value="odc">ODC</option>
                    <option value="odp">ODP</option>
                    <option value="closure">Closure</option>
                    <option value="tiang">Tiang</option>
                  </select>
                </div>
              )}
            </div>
            {user?.role === "ADMIN" && (
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
            )}
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
                      className="btn btn-sm btn-outline-primary atlas-secondary-action"
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
          <div
            className={`segment-list ${isSegmentPickerOpen ? "is-open" : ""}`}
          >
            <div className="asset-list-header">
              <label className="asset-list-title" htmlFor="map-asset-search">
                {assetListTab === "cables"
                  ? "Pilih kabel"
                  : "Pilih aset jaringan"}{" "}
                <span className="text-muted">
                  ({(catalogQuery.data?.total ?? 0).toLocaleString("id-ID")})
                </span>
              </label>
              <input
                aria-controls="map-segment-options"
                aria-expanded={isSegmentPickerOpen}
                aria-label={`Cari ${assetListTab === "cables" ? "kabel" : "aset jaringan"}`}
                autoComplete="off"
                className="asset-list-picker form-select form-select-sm"
                id="map-asset-search"
                onBlur={(event) => {
                  const list = event.currentTarget.closest(".segment-list");
                  const nextTarget = event.relatedTarget;
                  const isPaginationTarget =
                    nextTarget instanceof Element &&
                    nextTarget.closest(".asset-pagination");
                  if (
                    !isPaginationTarget &&
                    !list?.contains(nextTarget as Node | null)
                  ) {
                    setIsSegmentPickerOpen(false);
                  }
                }}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setIsSegmentPickerOpen(true);
                }}
                onFocus={() => setIsSegmentPickerOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setSearch("");
                    setIsSegmentPickerOpen(false);
                    event.currentTarget.blur();
                  }
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setIsSegmentPickerOpen(true);
                    window.requestAnimationFrame(() => {
                      document
                        .querySelector<HTMLButtonElement>(
                          "#map-segment-options .segment-item"
                        )
                        ?.focus();
                    });
                  }
                  if (event.key === "Enter" && isSegmentPickerOpen) {
                    document
                      .querySelector<HTMLButtonElement>(
                        "#map-segment-options .segment-item"
                      )
                      ?.click();
                  }
                }}
                placeholder={
                  assetListTab === "cables"
                    ? "Cari kabel…"
                    : "Cari aset jaringan…"
                }
                role="combobox"
                value={
                  isSegmentPickerOpen ? search : selectedAsset?.name || search
                }
              />
            </div>
            {/* biome-ignore lint/a11y/useSemanticElements: labelled popup of option buttons that the combobox controls; it is not a form fieldset */}
            <div
              aria-label={
                assetListTab === "cables"
                  ? "Daftar kabel"
                  : "Daftar aset jaringan"
              }
              id="map-segment-options"
              role="group"
            >
              {!selectedImportIds.length && (
                <div className="map-empty-list">
                  {provinceCode
                    ? "Pilih perusahaan untuk menampilkan aset."
                    : "Pilih provinsi, lalu perusahaan untuk menampilkan aset."}
                </div>
              )}
              {Boolean(selectedImportIds.length) && catalogQuery.isPending && (
                <div className="map-empty-list">Memuat daftar aset…</div>
              )}
              {catalogQuery.isError && (
                <div className="map-empty-list">
                  Daftar aset tidak dapat dimuat.
                </div>
              )}
              {assetListTab === "cables" &&
                standaloneSegments.map((segment) => (
                  <button
                    className={`segment-item ${selectedId === segment.id ? "selected" : ""}`}
                    key={segment.id}
                    onClick={() => focusAsset(segment)}
                    type="button"
                  >
                    <span className="segment-meta">
                      <b>
                        <span className="segment-name" title={segment.name}>
                          {segment.name}
                        </span>
                        <VerificationStatus asset={segment} />
                      </b>
                      <small>{segment.area || "Segmen jaringan"}</small>
                      <SegmentCoreSummary asset={segment} />
                    </span>
                    <i className="bi bi-chevron-right" />
                  </button>
                ))}
              {assetListTab === "cables" &&
                [...ftthDraftGroups].map(([groupId, segments]) => (
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
                      <span className="segment-meta">
                        <b>
                          <span className="segment-name">
                            Draft FTTH · {segments[0]?.area || "Area desain"}
                          </span>
                        </b>
                        <small>
                          {segments.length} jalur ·{" "}
                          {getDraftFeatureCount(groupId)} aset dalam satu desain
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
                          <span className="segment-meta">
                            <b>
                              <span
                                className="segment-name"
                                title={segment.name}
                              >
                                {segment.name}
                              </span>
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
                  <span className="segment-meta imported-segment-meta">
                    <span className="imported-segment-identity">
                      <span className="imported-segment-title">
                        <span className="segment-name" title={line.name}>
                          {line.name}
                        </span>
                        <VerificationStatus asset={line} />
                      </span>
                      <small>
                        {line.assetType === "segment"
                          ? "Segmen kabel"
                          : "Aset jaringan"}
                      </small>
                    </span>
                    <SegmentCoreSummary asset={line} inline />
                  </span>
                  <i className="bi bi-chevron-right" />
                </button>
              ))}
              {matchedImported.length > filteredImported.length && (
                <div className="map-empty-list">
                  Menampilkan {filteredImported.length} dari{" "}
                  {matchedImported.length} aset impor. Gunakan pencarian untuk
                  mempersempit daftar.
                </div>
              )}
              {Boolean(provinceCode || selectedImportIds.length) &&
                !catalogQuery.isPending &&
                (assetListTab === "cables" ? filteredSegments.length : 0) +
                  filteredImported.length ===
                  0 && (
                  <div className="map-empty-list">
                    {assetListTab === "cables"
                      ? "Tidak ada kabel yang sesuai dengan filter."
                      : "Tidak ada aset jaringan yang sesuai dengan filter."}
                  </div>
                )}
            </div>
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
            <div className="segment-detail-toolbar">
              <div className="detail-label">
                {selectedSegment
                  ? "DETAIL KABEL"
                  : selectedAsset
                    ? "DETAIL ASET"
                    : "DETAIL"}
              </div>
            </div>
            {selectedAsset && (
              <div className="segment-detail-heading">
                <h3>{selectedName}</h3>
                {selectedSegment && (
                  <VerificationStatus asset={selectedSegment} />
                )}
              </div>
            )}
            {selectedSegment ? (
              <>
                <p className="text-secondary">
                  {selectedSegment.area || "Area belum dicantumkan"} ·{" "}
                  {selectedSegment.cableType || "Jenis kabel belum dicantumkan"}
                </p>
                <section
                  aria-label="Titik ujung kabel"
                  className="segment-endpoints-summary"
                >
                  {(["A", "B"] as const).map((side) => {
                    const geometry = selectedSegment.geometry;
                    const point = geometry?.type === "LineString"
                      ? geometry.coordinates.at(side === "A" ? 0 : -1)
                      : undefined;
                    const endpointState = coreEndpointsQuery.data?.find((item) => item.side === side);
                    const linked = endpointState?.endpoint;
                    const nearby = endpointState?.candidates[0];

                    return (
                      <div className="segment-endpoint-field" key={side}>
                        <strong>Ujung {side}</strong>
                        <div>{point ? `${point[1]}, ${point[0]}` : "Koordinat belum tersedia"}</div>
                        {linked?.verificationStatus === "confirmed" ? (
                          <small className="segment-endpoint-meta">Aset tercatat: {linked.nodeAssetName}</small>
                        ) : nearby && (
                          <small className="segment-endpoint-meta">Aset terdekat: {nearby.name}</small>
                        )}
                      </div>
                    );
                  })}
                </section>
                <section
                  aria-label="Ringkasan kapasitas kabel"
                  className="segment-capacity-summary"
                >
                  <div className="capacity-stat">
                    <span>Total</span>
                    <b>
                      {selectedSegment.totalCores}
                      <small>core</small>
                    </b>
                  </div>
                  <div className="capacity-stat is-used">
                    <span>Terpakai</span>
                    <b>
                      {selectedSegment.usedCores}
                      <small>core</small>
                    </b>
                  </div>
                  <div className="capacity-stat has-bookings">
                    <span>Dibooking</span>
                    <b>
                      {selectedSegment.bookedCores}
                      <small>core</small>
                    </b>
                  </div>
                  <div
                    className={`capacity-stat ${isCoreUsageVerified(selectedSegment) ? "is-available" : "is-unverified"}`}
                  >
                    <span>Tersedia</span>
                    {isCoreUsageVerified(selectedSegment) ? (
                      <b>
                        {selectedSegment.idleCores}
                        <small>core</small>
                      </b>
                    ) : (
                      <b className="capacity-unverified">Belum diverifikasi</b>
                    )}
                  </div>
                </section>
                <div className="detail-section-heading">
                  Kapasitas dan penggunaan
                </div>
                <div className="core-utilization">
                  <div className="core-utilization-heading">
                    <span>Utilisasi</span>
                    <b
                      className={
                        selectedSegment.totalCores
                          ? utilizationVerified
                            ? ""
                            : "is-unverified"
                          : "is-empty"
                      }
                    >
                      {selectedSegment.totalCores
                        ? utilizationVerified
                          ? `${selectedUtilization}%`
                          : "Belum diverifikasi"
                        : "—"}
                    </b>
                  </div>
                  {selectedSegment.totalCores > 0 && utilizationVerified && (
                    <>
                      <div className="core-utilization-caption">
                        {occupiedCores} dari {selectedSegment.totalCores} core
                        terpakai atau dibooking
                      </div>
                      {/* biome-ignore lint/a11y/useSemanticElements: a stacked used/booked/idle bar, which a native <meter> cannot draw */}
                      <div
                        aria-label="Komposisi kapasitas kabel"
                        aria-valuemax={100}
                        aria-valuemin={0}
                        aria-valuenow={Math.min(selectedUtilization, 100)}
                        aria-valuetext={`${selectedUtilization}% utilisasi: ${selectedSegment.usedCores} core terpakai, ${selectedSegment.bookedCores} dibooking, ${selectedSegment.idleCores} tersedia dari ${selectedSegment.totalCores} core`}
                        className="core-utilization-meter"
                        role="meter"
                      >
                        <span
                          className="core-utilization-used"
                          style={{ width: `${usedMeterWidth}%` }}
                        />
                        <span
                          className="core-utilization-booked"
                          style={{ width: `${bookedMeterWidth}%` }}
                        />
                        <span
                          className="core-utilization-available"
                          style={{ width: `${availableMeterWidth}%` }}
                        />
                      </div>
                      {occupiedCores > selectedSegment.totalCores && (
                        <small
                          className="core-utilization-warning"
                          role="status"
                        >
                          Melebihi kapasitas sebesar{" "}
                          {occupiedCores - selectedSegment.totalCores} core.
                        </small>
                      )}
                    </>
                  )}
                </div>
                {selectedDraftId && (
                  <div className="alert alert-primary py-2">
                    <i className="bi bi-bounding-box-circles me-2" />
                    Radius desain FTTH {draftRadiusMeters} m ditampilkan pada
                    peta.
                  </div>
                )}
                {selectedSegment.totalCores === 0 && (
                  <div className="alert alert-info py-2">
                    Kapasitas belum diisi. Lengkapi jumlah core sebelum segmen
                    dapat dibooking.
                  </div>
                )}
                {selectedSegment.source !== "kml" &&
                  selectedSegment.nameValid === false && (
                    <div className="alert alert-warning py-2">
                      Nama kabel belum sesuai pola standar.
                    </div>
                  )}
                <details className="core-list-details" open>
                  <summary>
                    Status dan rincian {selectedSegment.totalCores} core
                  </summary>
                  {selectedSegment.source !== "managed" && (
                    <div className="core-verification-panel small mt-2 mb-2 rounded border p-2">
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
                        <div className="d-flex align-items-center flex-wrap gap-2 mt-2">
                          <button
                            className="btn btn-sm btn-outline-primary"
                            disabled={
                              verifyCoreUsage.isPending ||
                              Object.values(pendingCoreStatuses).some((change) =>
                                Object.values(change.endConnections ?? {}).some(
                                  (connection) =>
                                    connection?.connectionType === "splice" &&
                                    (!connection.peerSegmentId ||
                                      !connection.peerCoreNumber ||
                                      !connection.peerSide ||
                                      (connection.peerSide === "R" &&
                                        !Number.isFinite(connection.peerRouteMeasureM)))
                                ) ||
                                Object.values(change.endConnections ?? {}).some(
                                  (connection) =>
                                    connection?.connectionType === "device_port" &&
                                    !connection.portReference.trim()
                                ) ||
                                change.midspanConnections?.some((draft) => {
                                  if (
                                    !draft.nodeAssetId ||
                                    draft.routeMeasureM === null ||
                                    !draft.connection
                                  ) return true;
                                  if (draft.connection.connectionType === "splice") {
                                    return !draft.connection.peerSegmentId ||
                                      !draft.connection.peerCoreNumber ||
                                      !draft.connection.peerSide ||
                                      (draft.connection.peerSide === "R" &&
                                        !Number.isFinite(draft.connection.peerRouteMeasureM));
                                  }
                                  return draft.connection.connectionType === "device_port" &&
                                    !draft.connection.portReference.trim();
                                })
                              ) ||
                              (isCoreVerificationExpanded &&
                                coresQuery.data?.length !==
                                  selectedSegment.totalCores)
                            }
                            onClick={() => {
                              if (
                                !isCoreUsageVerified(selectedSegment) &&
                                !isCoreVerificationExpanded
                              ) {
                                setIsCoreVerificationExpanded(true);
                                return;
                              }
                              const endpointsToSave: Partial<Record<CoreSide, string>> = {};
                              for (const change of Object.values(
                                pendingCoreStatuses
                              )) {
                                for (const side of ["A", "B"] as const) {
                                  const connection = change.endConnections?.[side];
                                  const savedEndpoint = coreEndpointsQuery.data?.find(
                                    (item) => item.side === side
                                  )?.endpoint;
                                  if (
                                    connection &&
                                    !Object.hasOwn(endpointsToSave, side) &&
                                    !savedEndpoint
                                  ) {
                                    const suggestedNode = effectiveEndpointNodeId(side);
                                    if (suggestedNode) endpointsToSave[side] = suggestedNode;
                                  }
                                }
                              }
                              verifyCoreUsage.mutate({
                                coreStatuses: Object.entries(pendingCoreStatuses).map(
                                  ([coreNumber, change]) => ({
                                    coreNumber: Number(coreNumber),
                                    status: change.status,
                                    endConnections: change.endConnections,
                                    midspanConnections: change.midspanConnections?.map(
                                      ({ nodeAssetId, routeMeasureM, connection }) => ({
                                        nodeAssetId,
                                        routeMeasureM,
                                        connection,
                                      })
                                    ),
                                  })
                                ),
                                segmentEndpoints: endpointsToSave,
                              });
                            }}
                            type="button"
                          >
                            {verifyCoreUsage.isPending
                              ? "Menyimpan..."
                              : isCoreUsageVerified(selectedSegment)
                                ? "Simpan perubahan"
                                : isCoreVerificationExpanded
                                  ? "Simpan dan verifikasi kabel"
                                  : "Verifikasi kabel"}
                          </button>
                          {Object.keys(pendingCoreStatuses).length > 0 && (
                            <small className="text-warning" role="status">
                              Perubahan titik ujung atau sambungan core belum disimpan.
                            </small>
                          )}
                        </div>
                        {!coresQuery.isPending &&
                          !coresQuery.isError &&
                          coresQuery.data?.length !==
                            selectedSegment.totalCores && (
                          <small className="d-block text-warning mt-1">
                            Jumlah core tercatat ({coresQuery.data?.length ?? 0}
                            ) belum sama dengan total KMZ (
                            {selectedSegment.totalCores}).
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
                    </div>
                  )}
                  {isCoreUsageVerified(selectedSegment) ||
                  isCoreVerificationExpanded ? (
                    coresQuery.isPending ? (
                      <small>Memuat status core...</small>
                    ) : coresQuery.isError ? (
                      <small className="text-danger">
                        Status core tidak dapat dimuat.
                      </small>
                    ) : coresQuery.data?.length ? (
                      <>
                        <div className="core-status-list">
                          {visibleCores.map((core) => {
                            const change = pendingCoreStatuses[core.coreNumber];
                            const status = change?.status ?? core.status;
                            const getEndDraft = (side: CoreSide): CoreEndDraft => {
                              if (
                                change?.endConnections &&
                                Object.hasOwn(change.endConnections, side)
                              ) {
                                return change.endConnections[side] ?? null;
                              }
                              const saved = side === "A" ? core.endA : core.endB;
                              if (saved?.connectionType === "splice") {
                                return {
                                  connectionType: "splice",
                                  peerSegmentId: saved.peerSegmentId ?? undefined,
                                  peerCoreNumber: saved.peerCoreNumber ?? undefined,
                                  peerSide: saved.peerSide ?? undefined,
                                  peerRouteMeasureM: saved.peerRouteMeasureM == null
                                    ? undefined
                                    : Number(saved.peerRouteMeasureM),
                                };
                              }
                              if (saved?.connectionType === "device_port") {
                                return {
                                  connectionType: "device_port",
                                  portReference: saved.portReference ?? "",
                                };
                              }
                              return saved?.connectionType === "termination"
                                ? { connectionType: "termination" }
                                : null;
                            };
                            const setEndDraft = (
                              side: CoreSide,
                              connection: CoreEndDraft
                            ) =>
                              setPendingCoreStatuses((current) => {
                                const previous = current[core.coreNumber];
                                return {
                                  ...current,
                                  [core.coreNumber]: {
                                    status:
                                      previous?.status ??
                                      (core.status as "Available" | "Used"),
                                    endConnections: {
                                      ...previous?.endConnections,
                                      [side]: connection,
                                    },
                                  },
                                };
                              });
                            const getMidspanDrafts = (): MidspanConnectionDraft[] => {
                              if (change?.midspanConnections) {
                                return change.midspanConnections;
                              }
                              return (core.midspanConnections ?? []).map((record) => ({
                                draftId: record.id,
                                nodeAssetId: record.nodeAssetId,
                                routeMeasureM: Number(record.routeMeasureM),
                                connection:
                                  record.connectionType === "splice"
                                    ? {
                                        connectionType: "splice" as const,
                                        peerSegmentId: record.peerSegmentId ?? undefined,
                                        peerCoreNumber: record.peerCoreNumber ?? undefined,
                                        peerSide: record.peerSide ?? undefined,
                                        peerRouteMeasureM: record.peerRouteMeasureM == null
                                          ? undefined
                                          : Number(record.peerRouteMeasureM),
                                      }
                                    : record.connectionType === "device_port"
                                      ? { connectionType: "device_port" as const, portReference: record.portReference ?? "" }
                                      : { connectionType: "termination" as const },
                              }));
                            };
                            const setMidspanDrafts = (
                              drafts: MidspanConnectionDraft[]
                            ) =>
                              setPendingCoreStatuses((current) => {
                                const previous = current[core.coreNumber];
                                return {
                                  ...current,
                                  [core.coreNumber]: {
                                    status:
                                      previous?.status ??
                                      (core.status as "Available" | "Used"),
                                    endConnections: previous?.endConnections,
                                    midspanConnections: drafts,
                                  },
                                };
                              });
                            return (
                              <div
                                className={`core-status-row${status === "Used" ? " is-used" : ""}${expandedCoreConnections[core.coreNumber] ? " is-expanded" : ""}`}
                                key={core.coreNumber}
                              >
                                <div className="core-status-primary">
                                  <span>Core {core.coreNumber}</span>
                                  {core.status === "Booked" ? (
                                    <span
                                      className="status-pill is-booked"
                                      title={`PIC customer: ${core.picCustomer ?? "—"} · PIC presales: ${core.picPresales ?? "—"}`}
                                    >
                                      Booked · {core.customer}
                                    </span>
                                  ) : (
                                    <select
                                      aria-label={`Status Core ${core.coreNumber}`}
                                      className="form-select form-select-sm"
                                      onChange={(event) => {
                                        const nextStatus = event.target.value as
                                          | "Available"
                                          | "Used";
                                        setPendingCoreStatuses((current) => ({
                                          ...current,
                                          [core.coreNumber]: {
                                            status: nextStatus,
                                            endConnections:
                                              current[core.coreNumber]
                                                ?.endConnections,
                                            midspanConnections:
                                              current[core.coreNumber]
                                                ?.midspanConnections,
                                          },
                                        }));
                                      }}
                                      value={status}
                                    >
                                      <option value="Available">Tersedia</option>
                                      <option value="Used">Terpakai</option>
                                    </select>
                                  )}
                                </div>
                                <details
                                  className="core-end-connections-details"
                                  hidden
                                  onToggle={(event) => {
                                    const isOpen = event.currentTarget.open;
                                    setExpandedCoreConnections((current) => ({
                                      ...current,
                                      [core.coreNumber]: isOpen,
                                    }));
                                  }}
                                  open={expandedCoreConnections[core.coreNumber] ?? false}
                                >
                                  <summary>
                                    Sambungan core
                                    <span>
                                      {(["A", "B"] as const)
                                        .map((side) => {
                                          const end = side === "A" ? core.endA : core.endB;
                                          const connection = getEndDraft(side);
                                          const peerQuery = side === "A" ? corePeerAQuery : corePeerBQuery;
                                          const selectedPeer = connection?.connectionType === "splice"
                                            ? peerQuery.data?.find((peer) =>
                                                peer.peerSegmentId === connection.peerSegmentId &&
                                                peer.peerCoreNumber === connection.peerCoreNumber &&
                                                peer.peerSide === connection.peerSide &&
                                                (peer.peerSide !== "R" ||
                                                  Math.abs(Number(peer.peerRouteMeasureM) - Number(connection.peerRouteMeasureM)) < 0.02)
                                              )
                                            : undefined;
                                          const targetSegmentName = selectedPeer?.peerSegmentName ??
                                            (connection?.connectionType === "splice" &&
                                              end != null &&
                                              connection.peerSegmentId === end.peerSegmentId
                                              ? end.peerSegmentName
                                              : null);
                                          const target =
                                            connection?.connectionType === "splice"
                                              ? connection.peerSegmentId
                                                ? connection.peerCoreNumber
                                                  ? `Core ${connection.peerCoreNumber} pada ${targetSegmentName ?? "kabel tujuan"}`
                                                  : `Pilih core pada ${targetSegmentName ?? "kabel tujuan"}`
                                                : "Tujuan belum dipilih"
                                              : connection?.connectionType === "device_port"
                                                ? `Port ${connection.portReference || "belum diisi"}`
                                                : connection?.connectionType === "termination"
                                                  ? "Berakhir di aset"
                                                  : end?.nodeAssetName
                                                    ? "Belum dicatat"
                                                    : "Titik ujung belum dipilih";
                                          return `Ujung ${side} kabel ini: ${target}`;
                                        })
                                        .join(" · ")}
                                      {` · ${getMidspanDrafts().length} titik di jalur`}
                                    </span>
                                  </summary>
                                  <div className="core-end-editors">
                                    {(["A", "B"] as const).map((side) => {
                                      const savedEnd = side === "A" ? core.endA : core.endB;
                                      const connection = getEndDraft(side);
                                      const nodeAssetId = effectiveEndpointNodeId(side);
                                      const peerQuery = side === "A" ? corePeerAQuery : corePeerBQuery;
                                      const peerOptions = (peerQuery.data ?? []).filter((peer) => {
                                        const isCurrentReciprocal =
                                          peer.connectedSegmentId === selectedSegment.id &&
                                          peer.connectedCoreNumber === core.coreNumber &&
                                          peer.connectedSide === side;
                                        return !peer.isOccupied || isCurrentReciprocal;
                                      });
                                      return (
                                        <section className="core-end-editor" key={side}>
                                          <div className="core-end-editor-heading">
                                            <strong>Ujung {side} kabel ini</strong>
                                            <span>
                                              {savedEnd?.nodeAssetName ??
                                                coreEndpointsQuery.data?.find((item) => item.side === side)?.candidates.find((item) => item.id === nodeAssetId)?.name ??
                                                "Titik belum ditentukan"}
                                            </span>
                                          </div>
                                          <label htmlFor={`core-${core.coreNumber}-${side}-connection`}>
                                            Sambungan pada ujung kabel ini
                                          </label>
                                          <select
                                            className="form-select form-select-sm"
                                            disabled={!nodeAssetId || core.status === "Booked"}
                                            id={`core-${core.coreNumber}-${side}-connection`}
                                            onChange={(event) => {
                                              const value = event.target.value;
                                              if (!value) {
                                                setEndDraft(side, null);
                                              } else if (value === "splice") {
                                                setEndDraft(
                                                  side,
                                                  connection?.connectionType === "splice"
                                                    ? connection
                                                    : { connectionType: "splice" }
                                                );
                                              } else {
                                                setEndDraft(side, { connectionType: "termination" });
                                              }
                                            }}
                                            value={connection?.connectionType ?? ""}
                                          >
                                            <option value="">Belum dicatat</option>
                                            {connection?.connectionType === "device_port" && (
                                              <option disabled value="device_port">Port perangkat · data lama</option>
                                            )}
                                            <option value="splice">Disambung ke core kabel lain</option>
                                            <option value="termination">Berakhir di aset ini</option>
                                          </select>
                                          {connection?.connectionType === "splice" && (
                                            <CorePeerSelector
                                              connection={connection}
                                              disabled={core.status === "Booked" || !nodeAssetId}
                                              error={peerQuery.isError}
                                              idPrefix={`core-${core.coreNumber}-${side}-peer`}
                                              loading={peerQuery.isPending}
                                              onChange={(nextConnection) => setEndDraft(side, nextConnection)}
                                              peers={peerOptions}
                                            />
                                          )}
                                          {connection?.connectionType === "device_port" && (
                                            <small className="text-secondary">
                                              Catatan port lama: {connection.portReference || "tanpa nomor"}. Pilihan ini tidak tersedia untuk sambungan baru.
                                            </small>
                                          )}
                                          {connection?.connectionType === "termination" && (
                                            <small className="text-secondary">
                                              Core berakhir di {savedEnd?.nodeAssetName ?? "titik ujung yang dipilih"}.
                                            </small>
                                          )}
                                        </section>
                                      );
                                    })}
                                  </div>
                                  <section className="core-midspan-editor">
                                    <div className="core-midspan-heading">
                                      <div>
                                        <strong>Sambungan di sepanjang jalur</strong>
                                        <small>
                                          Catat tiap titik akses tengah kabel. Titik dipilih dari aset yang dekat dengan jalur.
                                        </small>
                                      </div>
                                      <button
                                        className="btn btn-sm btn-outline-primary"
                                        disabled={core.status === "Booked"}
                                        onClick={() =>
                                          setMidspanDrafts([
                                            ...getMidspanDrafts(),
                                            {
                                              draftId: crypto.randomUUID(),
                                              nodeAssetId: "",
                                              routeMeasureM: null,
                                              connection: null,
                                            },
                                          ])
                                        }
                                        type="button"
                                      >
                                        Tambah titik sambungan
                                      </button>
                                    </div>
                                    {coreRouteNodesQuery.isPending ? (
                                      <small className="text-secondary">Memuat aset di sepanjang jalur…</small>
                                    ) : coreRouteNodesQuery.isError ? (
                                      <small className="text-danger">Daftar aset di sepanjang jalur tidak dapat dimuat.</small>
                                    ) : coreRouteNodesQuery.data?.length ? (
                                      getMidspanDrafts().length ? (
                                        <div className="core-midspan-list">
                                          {getMidspanDrafts().map((draft) => {
                                            const peerQuery = midspanPeerQueriesByKey.get(
                                              `${core.coreNumber}:${draft.draftId}`
                                            );
                                            const peerOptions = (peerQuery?.data ?? []).filter((peer) => {
                                              const isCurrentReciprocal =
                                                peer.connectedSegmentId === selectedSegment?.id &&
                                                peer.connectedCoreNumber === core.coreNumber &&
                                                peer.connectedSide === "R" &&
                                                Math.abs(Number(peer.connectedRouteMeasureM) - Number(draft.routeMeasureM)) < 0.02;
                                              return !peer.isOccupied || isCurrentReciprocal;
                                            });
                                            const updateDraft = (
                                              update: Partial<MidspanConnectionDraft>
                                            ) =>
                                              setMidspanDrafts(
                                                getMidspanDrafts().map((item) =>
                                                  item.draftId === draft.draftId
                                                    ? { ...item, ...update }
                                                    : item
                                                )
                                              );
                                            return (
                                              <div className="core-midspan-row" key={draft.draftId}>
                                                <div className="core-midspan-location">
                                                  <label htmlFor={`core-${core.coreNumber}-midspan-${draft.draftId}-node`}>
                                                    Titik sambungan
                                                  </label>
                                                  <select
                                                    className="form-select form-select-sm"
                                                    disabled={core.status === "Booked"}
                                                    id={`core-${core.coreNumber}-midspan-${draft.draftId}-node`}
                                                    onChange={(event) => {
                                                      const node = coreRouteNodesQuery.data?.find(
                                                        (candidate) => candidate.id === event.target.value
                                                      );
                                                      updateDraft({
                                                        nodeAssetId: node?.id ?? "",
                                                        routeMeasureM: node ? Number(node.routeMeasureM) : null,
                                                        connection: null,
                                                      });
                                                    }}
                                                    value={draft.nodeAssetId}
                                                  >
                                                    <option value="">Pilih aset di sepanjang jalur</option>
                                                    {coreRouteNodesQuery.data.map((node) => (
                                                      <option key={node.id} value={node.id}>
                                                        {node.name} · {node.type ?? "Aset"} · {Number(node.routeMeasureM).toFixed(0)} m dari Ujung A · {Number(node.distanceToRoute).toFixed(0)} m dari jalur
                                                      </option>
                                                    ))}
                                                  </select>
                                                  {draft.routeMeasureM !== null && (
                                                    <small>
                                                      Posisi jalur: {draft.routeMeasureM.toFixed(1)} m dari Ujung A
                                                    </small>
                                                  )}
                                                </div>
                                                <div className="core-midspan-connection">
                                                  <label htmlFor={`core-${core.coreNumber}-midspan-${draft.draftId}-type`}>
                                                    Sambungan di titik ini
                                                  </label>
                                                  <select
                                                    className="form-select form-select-sm"
                                                    disabled={!draft.nodeAssetId || core.status === "Booked"}
                                                    id={`core-${core.coreNumber}-midspan-${draft.draftId}-type`}
                                                    onChange={(event) => {
                                                      const value = event.target.value;
                                                      const connection: CoreEndDraft =
                                                        value === "splice"
                                                          ? draft.connection?.connectionType === "splice"
                                                            ? draft.connection
                                                            : { connectionType: "splice" }
                                                          : value === "termination"
                                                            ? { connectionType: "termination" }
                                                            : null;
                                                      updateDraft({ connection });
                                                    }}
                                                    value={draft.connection?.connectionType ?? ""}
                                                  >
                                                    <option value="">Pilih jenis sambungan</option>
                                                    {draft.connection?.connectionType === "device_port" && (
                                                      <option disabled value="device_port">Port perangkat · data lama</option>
                                                    )}
                                                    <option value="splice">Disambung ke core kabel lain</option>
                                                    <option value="termination">Berakhir di aset ini</option>
                                                  </select>
                                                  {draft.connection?.connectionType === "splice" && (
                                                    <CorePeerSelector
                                                      connection={draft.connection}
                                                      disabled={core.status === "Booked"}
                                                      error={peerQuery?.isError ?? false}
                                                      idPrefix={`core-${core.coreNumber}-midspan-${draft.draftId}-peer`}
                                                      loading={peerQuery?.isPending ?? false}
                                                      onChange={(connection) => updateDraft({ connection })}
                                                      peers={peerOptions}
                                                    />
                                                  )}
                                                  {draft.connection?.connectionType === "device_port" && (
                                                    <small className="text-secondary">
                                                      Catatan port lama: {draft.connection.portReference || "tanpa nomor"}. Pilihan ini tidak tersedia untuk sambungan baru.
                                                    </small>
                                                  )}
                                                </div>
                                                <button
                                                  aria-label="Hapus titik sambungan"
                                                  className="btn btn-sm btn-outline-secondary core-midspan-remove"
                                                  disabled={core.status === "Booked"}
                                                  onClick={() =>
                                                    setMidspanDrafts(
                                                      getMidspanDrafts().filter(
                                                        (item) => item.draftId !== draft.draftId
                                                      )
                                                    )
                                                  }
                                                  type="button"
                                                >
                                                  Hapus
                                                </button>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      ) : (
                                        <small className="text-secondary">Belum ada sambungan yang dicatat di sepanjang kabel.</small>
                                      )
                                    ) : (
                                      <small className="text-secondary">
                                        Tidak ada aset KMZ di dekat bagian tengah jalur kabel. Pastikan titik akses sudah tercatat sebagai aset jaringan.
                                      </small>
                                    )}
                                  </section>
                                </details>
                                {core.legacyConnectedAssetId &&
                                  !core.endA?.connectionType &&
                                  !core.endB?.connectionType &&
                                  !(core.midspanConnections?.length) && (
                                    <small className="core-legacy-connection-note">
                                      Catatan sambungan lama perlu diperiksa: {core.legacyConnectedAssetName ?? core.legacyConnectedAssetId}
                                      {core.legacyConnectedSide
                                        ? ` · ${core.legacyConnectedSide === "R" ? "posisi lama di sepanjang jalur" : `Ujung ${core.legacyConnectedSide}`}`
                                        : ""}.
                                    </small>
                                  )}
                              </div>
                            );
                          })}
                        </div>
                        {(corePeerAQuery.isError || corePeerBQuery.isError) && (
                          <small className="d-block text-danger mt-2">
                            Daftar kabel di titik sambungan tidak dapat dimuat.
                          </small>
                        )}
                        {coreConnectionSummary.length > 0 && (
                          <div className="core-destination-summary">
                            <div className="core-destination-summary-header">
                              <strong>
                                Core dengan sambungan tercatat
                              </strong>
                              <span>
                                {coreConnectionSummary.reduce((sum, item) => sum + item.count, 0)} sambungan
                              </span>
                            </div>
                            <ul
                              aria-label="Daftar tujuan core"
                              className="core-destination-list"
                            >
                              {coreConnectionSummary.map((destination) => (
                                <li
                                  key={destination.key}
                                >
                                  <span className="core-destination-count">
                                    {destination.count} core
                                  </span>
                                  <strong>{destination.nodeAssetName}</strong>
                                  <span className="core-destination-side">
                                    {destination.side === "R"
                                      ? `Jalur kabel ini · ${Number(destination.routeMeasureM).toFixed(0)} m dari Ujung A`
                                      : `Ujung ${destination.side} kabel ini`}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    ) : (
                      <small className="text-secondary">
                        Belum ada core terpasang.
                      </small>
                    )
                  ) : (
                    <small className="core-lock-note" role="status">
                      <i
                        aria-hidden="true"
                        className="bi bi-info-circle me-1"
                      />
                      Status core tersedia setelah kapasitas kabel diverifikasi.
                    </small>
                  )}
                  {(isCoreUsageVerified(selectedSegment) ||
                    isCoreVerificationExpanded) &&
                    Boolean(coresQuery.data?.length) && (
                      <nav
                        aria-label="Pagination status core"
                        className="core-pagination"
                      >
                        <label htmlFor="core-page-size">Per halaman</label>
                        <select
                          className="form-select form-select-sm"
                          id="core-page-size"
                          onChange={(event) =>
                            setCorePageSize(Number(event.target.value))
                          }
                          value={corePageSize}
                        >
                          {[10, 20, 30, 40].map((size) => (
                            <option key={size} value={size}>
                              {size}
                            </option>
                          ))}
                        </select>
                        <div className="core-pagination-controls">
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            disabled={corePage <= 1}
                            onClick={() =>
                              setCorePage((page) => Math.max(1, page - 1))
                            }
                            type="button"
                          >
                            Sebelumnya
                          </button>
                          <small>
                            Halaman {corePage} dari {corePageCount}
                          </small>
                          <button
                            className="btn btn-sm btn-outline-secondary"
                            disabled={corePage >= corePageCount}
                            onClick={() =>
                              setCorePage((page) =>
                                Math.min(corePageCount, page + 1)
                              )
                            }
                            type="button"
                          >
                            Berikutnya
                          </button>
                        </div>
                      </nav>
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
                <div className="detail-meta-grid">
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
                      <div className="asset-info-group detail-meta-group">
                        <b>Jalur kabel</b>
                        {from || to ? (
                          <DetailTable
                            label="Ujung jalur kabel"
                            rows={[
                              {
                                label: "Dari",
                                value: String(
                                  from ?? "Tidak dicantumkan di KMZ"
                                ),
                              },
                              {
                                label: "Ke",
                                value: String(to ?? "Tidak dicantumkan di KMZ"),
                              },
                            ]}
                          />
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
                            <DetailTable
                              className="mt-2"
                              label="Atribut kabel dari KMZ"
                              rows={attributes.map(([key, value]) => ({
                                label: key,
                                value: String(value),
                              }))}
                            />
                          </details>
                        )}
                      </div>
                    );
                  })()}
                  <div className="asset-info-group detail-meta-group">
                    <b>Spesifikasi kabel</b>
                    <DetailTable
                      label="Spesifikasi kabel"
                      rows={[
                        {
                          label: "Standar legenda",
                          value: `${selectedLegend?.category} · ${selectedLegend?.termination} · garis ${selectedLegend?.cableLineWidth ?? "—"} px`,
                        },
                        {
                          label: "Tipe kabel",
                          value: selectedSegment.cableType,
                        },
                        {
                          label: "Metode instalasi",
                          value: selectedSegment.installation,
                        },
                        {
                          label: "Sisi jalan",
                          value: `Sisi ${selectedSegment.side.toLowerCase()}`,
                        },
                      ]}
                    />
                  </div>
                  {(selectedSegment.pole ||
                    selectedSegment.poleHeight ||
                    selectedSegment.odc ||
                    selectedSegment.odp) && (
                    <div className="asset-info-group detail-meta-group detail-meta-full">
                      <b>
                        {selectedSegment.source === "managed"
                          ? "Informasi aset"
                          : "Data aset dari sumber impor"}
                      </b>
                      <DetailTable
                        label="Informasi aset kabel"
                        rows={[
                          ["Tiang", selectedSegment.pole],
                          ["Tinggi tiang", selectedSegment.poleHeight],
                          ["ODC", selectedSegment.odc],
                          ["ODP", selectedSegment.odp],
                        ]
                          .filter(([, value]) => value)
                          .map(([label, value]) => ({
                            label: String(label),
                            value: String(value),
                          }))}
                      />
                    </div>
                  )}
                </div>
                <details className="admin-settings mt-4">
                  <summary>
                    <i className="bi bi-pencil-square me-2" />
                    Edit detail kabel
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
                      Core terpakai diatur per nomor di Rincian core; jumlahnya
                      dihitung otomatis.
                    </small>
                    <label className="form-label" htmlFor="asset-installation">
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
                      {updateAsset.isPending ? "Menyimpan..." : "Simpan detail"}
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
                <Link className="btn btn-outline-primary atlas-secondary-action justify-content-center mt-4 w-100" to="/booking-core">
                  <i aria-hidden="true" className="bi bi-diagram-3 atlas-secondary-action-icon" />
                  Kelola booking core
                </Link>
              </>
            ) : selectedImported ? (
              <>
                <p className="text-secondary">
                  Informasi aset titik dari sumber impor. Geometri dipertahankan
                  tanpa perubahan.
                </p>
                <div className="detail-section-heading">Ringkasan aset</div>
                <DetailTable
                  className="mb-3"
                  label="Ringkasan aset impor"
                  rows={[
                    {
                      label: "Jenis aset",
                      value: (
                        {
                          odc: "ODC",
                          odp: "ODP",
                          closure: "Closure",
                          tiang: "Tiang",
                        } as Record<string, string>
                      )[networkAssetKind(selectedImported)] ?? "Aset jaringan",
                    },
                    {
                      label: "Area",
                      value: selectedImported.area || "Belum dicantumkan",
                    },
                    {
                      label: "Sumber",
                      value: selectedImported.source === "kml"
                        ? "KML/KMZ"
                        : selectedImported.source,
                    },
                    {
                      label: "Standar legenda",
                      value: `${selectedLegend?.category} · ${selectedLegend?.termination} · ikon ${selectedLegend?.size}× · label ${selectedLegend?.labelSize}×`,
                    },
                  ]}
                />
                <DetailTable
                  label="Atribut aset impor"
                  rows={[
                    ...Object.entries(selectedImported.attributes ?? {})
                      .filter(([key]) => key !== "__kmlStyle")
                      .map(([key, value]) => ({
                        label: key,
                        value: String(value),
                      })),
                    ...((selectedImported.geometryType ||
                    selectedImported.geometry?.type)
                      ? [
                          {
                            label: "Tipe geometri",
                            value: String(
                              selectedImported.geometryType ??
                                selectedImported.geometry?.type
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              </>
            ) : (
              <div className="asset-detail-empty">
                <i aria-hidden="true" className="bi bi-cursor" />
                <p>
                  Pilih {assetListTab === "cables" ? "kabel" : "aset jaringan"}{" "}
                  dari daftar atau langsung dari peta untuk melihat detail.
                </p>
              </div>
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
