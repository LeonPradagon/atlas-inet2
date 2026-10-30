import { kmzLegend } from "./kmzLegend";
import { useEffect, useMemo, useRef, useState } from "react";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { LngLatBounds, Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl, type FilterSpecification, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { Feature, FeatureCollection, Geometry, LineString, Point, Polygon, Position } from "geojson";
import { SegmentRelations } from "./SegmentRelations";
import { PageHeader } from "../../components/PageHeader";
import { api, networkQueryKeys, type Booking, type NetworkAsset, type NetworkAssetPage } from "../../lib/api";

type Coordinate = [number, number];
type MapProvinceOption = { code: string; name: string; assetCount: number; folderCount: number; bounds: [number, number, number, number] | null };
type MapProvinceResponse = { items: MapProvinceOption[] };
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
  labelColor?: string;
  labelOpacity?: number;
  labelScale?: number;
  iconColor?: string;
  iconOpacity?: number;
  iconScale?: number;
  iconHref?: string;
  iconAnchor?: "center" | "bottom" | "bottom-right";
  iconOffset?: [number, number];
};
const networkXlsxHeaders = ["Nama", "Tipe Aset", "Area", "Tipe Kabel", "Jumlah Core", "Metode Instalasi", "Sisi Jalan", "Tinggi Tiang", "Nomor Tiang", "ODC", "ODP", "Geometry GeoJSON"];

function buildNetworkWorkbook(assets: NetworkAsset[] = []) {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet("Data Jaringan");
  data.addRow(networkXlsxHeaders);
  data.columns = [{ width: 32 }, { width: 16 }, { width: 22 }, { width: 20 }, { width: 14 }, { width: 20 }, { width: 14 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 68 }];
  data.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  data.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3454D1" } };
  for (const asset of assets) {
    if (!asset.geometry) continue;
    data.addRow([asset.name, asset.assetType === "segment" ? "Segmen" : "Aset", asset.area, asset.cableType, asset.totalCores,
      asset.installation, asset.side, asset.poleHeight, asset.pole, asset.odc, asset.odp, JSON.stringify(asset.geometry)]);
  }
  const guide = workbook.addWorksheet("Petunjuk");
  guide.addRows([
    ["Impor Jaringan ATLAS"],
    ["Isi satu baris untuk setiap aset. Kolom Nama dan Geometry GeoJSON wajib."],
    ["Tipe Aset: Segmen untuk kabel, Aset untuk tiang/ODC/ODP. Jika kosong, tipe geometri menentukan jenis."],
    ["Geometry GeoJSON wajib berupa geometri GeoJSON; semua koordinat memakai urutan longitude, latitude."],
    ['Contoh titik: {"type":"Point","coordinates":[106.8,-6.2]}'],
    ['Contoh kabel: {"type":"LineString","coordinates":[[106.8,-6.2],[106.81,-6.21]]}'],
    ["Jumlah Core berupa bilangan 0–4096. Metode Instalasi: Aerial atau Burial. Sisi Jalan: Kiri atau Kanan."],
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
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[char]!);
}

function kmlCoordinate(position: Position) { return position.join(","); }
function kmlCoordinates(positions: Position[]) { return positions.map(kmlCoordinate).join(" "); }

function kmlPolygon(rings: Position[][]) {
  const [outer, ...inner] = rings;
  if (!outer) return "";
  const ring = (points: Position[]) => `<LinearRing><coordinates>${kmlCoordinates(points)}</coordinates></LinearRing>`;
  return `<Polygon><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${inner.map((points) => `<innerBoundaryIs>${ring(points)}</innerBoundaryIs>`).join("")}</Polygon>`;
}

function kmlGeometry(geometry: Geometry): string {
  switch (geometry.type) {
    case "Point": return `<Point><coordinates>${kmlCoordinate(geometry.coordinates)}</coordinates></Point>`;
    case "MultiPoint": return `<MultiGeometry>${geometry.coordinates.map((coordinates) => kmlGeometry({ type: "Point", coordinates })).join("")}</MultiGeometry>`;
    case "LineString": return `<LineString><coordinates>${kmlCoordinates(geometry.coordinates)}</coordinates></LineString>`;
    case "MultiLineString": return `<MultiGeometry>${geometry.coordinates.map((coordinates) => kmlGeometry({ type: "LineString", coordinates })).join("")}</MultiGeometry>`;
    case "Polygon": return kmlPolygon(geometry.coordinates);
    case "MultiPolygon": return `<MultiGeometry>${geometry.coordinates.map(kmlPolygon).join("")}</MultiGeometry>`;
    case "GeometryCollection": return `<MultiGeometry>${geometry.geometries.map(kmlGeometry).join("")}</MultiGeometry>`;
  }
}

function networkKml(assets: NetworkAsset[]) {
  const placemarks = assets.flatMap((asset) => {
    if (!asset.geometry) return [];
    const fields: Array<[string, unknown]> = [["asset_type", asset.assetType], ["area", asset.area], ["source", asset.source], ["cable_type", asset.cableType], ["total_cores", asset.totalCores], ["installation", asset.installation], ["side", asset.side], ["pole", asset.pole], ["pole_height", asset.poleHeight], ["odc", asset.odc], ["odp", asset.odp]];
    const data = fields.filter(([, value]) => value !== null && value !== undefined && value !== "").map(([name, value]) => `<Data name="${name}"><value>${xmlEscape(value)}</value></Data>`).join("");
    return [`<Placemark><name>${xmlEscape(asset.name)}</name><ExtendedData>${data}</ExtendedData>${kmlGeometry(asset.geometry)}</Placemark>`];
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>ATLAS - Data Jaringan</name>${placemarks}</Document></kml>`;
}

function getIconCategory(folderPath: unknown, assetName: unknown) {
  const folders = String(folderPath ?? "")
    .split("/")
    .filter(Boolean)
    .reverse();
  const name = String(assetName ?? "");
  const categories: [string, RegExp][] = [
    ["OTB", /(^|[^A-Z0-9])OTB(?=$|[^A-Z0-9]|\d)/i],
    ["OLT", /(^|[^A-Z0-9])OLT(?=$|[^A-Z0-9]|\d)/i],
    ["ODP", /(^|[^A-Z0-9])ODP(?=$|[^A-Z0-9]|\d)/i],
    ["ODC", /(^|[^A-Z0-9])ODC(?=$|[^A-Z0-9]|\d)/i],
    ["FDT", /(^|[^A-Z0-9])FDT(?=$|[^A-Z0-9]|\d)/i],
    ["POLE", /(^|[^A-Z0-9])(?:POLE|PL|T6|T7|T9|TL)(?=$|[^A-Z0-9]|\d)/i],
    ["JC", /(^|[^A-Z0-9])(?:JC|CLOSURE|JOINT\s*CLOSURE)(?=$|[^A-Z0-9]|\d)/i],
    ["OFP", /(^|[^A-Z0-9])OFP(?=$|[^A-Z0-9]|\d)/i],
    ["POP", /(^|[^A-Z0-9])POP(?=$|[^A-Z0-9]|\d)/i],
    ["ODF", /(^|[^A-Z0-9])ODF(?=$|[^A-Z0-9]|\d)/i],
    ["SLACK", /(^|[^A-Z0-9])SLACK(?=$|[^A-Z0-9]|\d)/i],
    ["HANDHOLE", /(^|[^A-Z0-9])(?:HH|HANDHOLE)(?=$|[^A-Z0-9]|\d)/i],
    ["MANHOLE", /(^|[^A-Z0-9])(?:MH|MANHOLE)(?=$|[^A-Z0-9]|\d)/i],
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
    MANHOLE: "MANHOLE",
    OTB: "OTB",
  };
  if (["OLT", "ODC", "ODP", "POLE", "FDT", "OFP", "POP", "ODF", "SLACK", "OTB", "MANHOLE"].includes(assetKind)) return assetKind;
  return categories[assetKind] ?? getIconCategory(asset.attributes?.folderPath, asset.attributes?.name ?? asset.name);
}

function legendStyle(asset: NetworkAsset) {
  const normalize = (value: unknown) => String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const folders = String(asset.attributes?.folderPath ?? "").split("/").map((folder) => folder.trim()).reverse();
  const metadata = [asset.attributes?.Spesifikasi, asset.attributes?.Splitter, asset.attributes?.["Tipe Perangkat"], asset.attributes?.assetKind];
  let rule: (typeof kmzLegend)[number] | undefined;
  for (const value of [...folders, ...metadata, asset.attributes?.name, asset.name]) {
    rule = kmzLegend.find((entry) => Boolean(entry.iconUrl) === (asset.assetType !== "segment") && entry.folder !== "-" && entry.folder.split("/").some((folder) => normalize(folder) === normalize(value)));
    if (rule) break;
  }
  const text = [asset.name, ...folders, ...metadata].join(" ").toUpperCase();
  let category = assetIconCategory(asset);
  if (!rule) {
    if (asset.assetType === "segment" && /BRENCH|BRANCH|PATCH.?CORD/.test(text)) category = "BRANCH";
    else if (asset.assetType === "segment" && /DROP/.test(text)) category = "DROP";
    else if (asset.assetType === "segment" && /HDPE|DUCT|TRENCHLESS/.test(text)) category = "HDPE";
    else if (asset.assetType === "segment" && /BACKBONE|CABLE_BB/.test(text)) category = "BACKBONE";
    else if (asset.assetType === "segment" && /FEEDER|CABLE_FDR/.test(text)) category = "FEEDER";
    else if (asset.assetType === "segment" && /DISTRIB|CABLE_DST/.test(text)) category = "DISTRIBUTION";
    const capacity = asset.totalCores || Number(text.match(/(?:^|[^0-9])(288|144|96|48|32|24|16|12|8)\s*(?:C(?:ORE)?S?|PORT)(?:$|[^A-Z])/i)?.[1] ?? 0);
    const candidates = kmzLegend.filter((entry) => entry.category === category);
    rule = candidates.find((entry) => capacity > 0 && entry.name.match(/\d+/)?.[0] === String(capacity)) ?? (candidates.length === 1 ? candidates[0] : undefined);
  }
  const isLine = asset.assetType === "segment";
  return { category: rule?.category ?? category, color: rule?.color, size: rule?.size ?? 1, labelSize: rule?.labelSize ?? 0,
    cableLineWidth: isLine ? rule?.size : undefined, iconUrl: rule?.iconUrl, termination: rule?.termination ?? "Bukan Terminasi" };
}

function iconPreview(category: string) {
  const shapes: Record<string, string> = { POLE: "shaded_dot.png", POP: "arrow.png", OLT: "arrow.png", OTB: "arrow.png", ODC: "square.png", ODP: "triangle.png", JC: "forbidden.png", SLACK: "target.png", HANDHOLE: "square.png", MANHOLE: "square.png" };
  if (shapes[category]) return <img className="map-icon-preview" src={`https://maps.google.com/mapfiles/kml/shapes/${shapes[category]}`} alt="" />;
  const icons: Record<string, [string, string]> = {
    OLT: ["bi-hdd-network-fill", "#2864d7"], OTB: ["bi-box-fill", "#00aabb"], ODC: ["bi-square-fill", "#f28c28"], ODP: ["bi-triangle-fill", "#8b4513"],
    POLE: ["bi-signpost-2-fill", "#c5a900"], JC: ["bi-record-circle-fill", "#f28c28"], HANDHOLE: ["bi-square-fill", "#8993a3"], MANHOLE: ["bi-square-fill", "#202124"],
    POP: ["bi-arrow-up-right-circle-fill", "#e8b500"], ODF: ["bi-grid-3x3-gap-fill", "#684fc7"], SLACK: ["bi-bullseye", "#e53935"], FDT: ["bi-diagram-3-fill", "#e75b3c"],
    OFP: ["bi-box-fill", "#178c80"], "TERMINAL BOX": ["bi-box-fill", "#3280c8"], LAINNYA: ["bi-geo-alt-fill", "#3454d1"],
  };
  const [icon, color] = icons[category] ?? ["bi-geo-alt-fill", "#3454d1"];
  return <i className={`bi ${icon} map-icon-preview`} style={{ color }} aria-hidden="true" />;
}

const localKmzIcons = new Set(["paddle/P.png","pushpin/ylw-pushpin.png","shapes/arrow.png","shapes/cross-hairs.png","shapes/donut.png","shapes/forbidden.png","shapes/homegardenbusiness.png","shapes/info-i.png","shapes/placemark_circle.png","shapes/placemark_square.png","shapes/shaded_dot.png","shapes/square.png","shapes/target.png","shapes/triangle.png"]);

function mapGeometryParts(geometry: Geometry): Geometry[] {
  return geometry.type === "GeometryCollection" ? geometry.geometries.flatMap(mapGeometryParts) : [geometry];
}

const assetFeatures = (items: NetworkAsset[]): Feature<Geometry, Record<string, unknown>>[] =>
  items.reduce<Feature<Geometry, Record<string, unknown>>[]>((features, item) => {
    if (item.geometry) {
      const style = item.attributes?.__kmlStyle as ImportedStyle | undefined;
      const legend = legendStyle(item);
      const iconCategory = legend.category;
      const iconHref = style?.iconHref ?? legend.iconUrl;
      const kmzIcon = iconHref?.match(/^atlas-kmz-icon:([a-f0-9]{64})$/i)?.[1];
      const localIcon = iconHref?.match(/^https?:\/\/maps\.google\.com\/mapfiles\/kml\/(.+)$/i)?.[1];
      const iconUrl = kmzIcon ? iconHref : localIcon && localKmzIcons.has(localIcon) ? `/kml-icons/${localIcon}` : iconHref?.replace(/^http:\/\//i, "https://");
      const iconLegendColor: Record<string, string> = { POLE: "#e8c300", POP: "#e8b500", OLT: "#2864d7", OTB: "#00bcd4", ODC: "#f28c28", ODP: "#8b4513", JC: "#f28c28", SLACK: "#e53935", HANDHOLE: "#ffffff", MANHOLE: "#202124" };
      const googlePushpin = /\/pushpin\/ylw-pushpin\.png(?:$|[?#])/i.test(style?.iconHref ?? "");
      const lineDescription = `${item.name} ${item.cableType} ${String(item.attributes?.routeType ?? "")}`;
      const routeType = item.attributes?.routeType ?? (/backbone/i.test(lineDescription) ? "BACKBONE" : /feeder/i.test(lineDescription) ? "FEEDER" : /distrib/i.test(lineDescription) ? "DISTRIBUTION" : /drop/i.test(lineDescription) ? "DROP" : undefined);
      const coreMatch = lineDescription.match(/(?:^|\D)(12|24|48|96|144|288)\s*(?:core|c)?\b/i);
      const legendColor: Record<string, string> = { "12": "#8b4513", "24": "#f28c28", "48": "#2864d7", "96": "#e53935", "144": "#22a447", "288": "#202124" };
      const inferredLineColor = coreMatch ? legendColor[coreMatch[1]] : routeType === "DROP" ? "#8e44ad" : undefined;
      features.push({
        type: "Feature",
        id: item.id,
        properties: {
          id: item.id,
          name: item.name,
          area: item.area,
          ...Object.fromEntries(Object.entries(item.attributes ?? {}).filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))),
          source: item.source,
          assetType: item.assetType,
          totalCores: item.totalCores,
          usedCores: item.usedCores,
          bookedCores: item.bookedCores,
          idleCores: item.idleCores,
          imported: item.source !== "managed",
          geometryType: item.geometry.type,
          iconCategory,
          legendLabelSize: style?.labelScale ?? (style?.iconHref ? 1 : legend.labelSize),
          sourceLabel: item.attributes?.name ?? item.name,
          labelColor: style?.labelColor ?? (item.source === "kml" ? "#ffffff" : "#17356f"),
          labelOpacity: style?.labelOpacity ?? 1,
          legendTermination: legend.termination,
          legendIconScale: style?.iconScale ?? legend.size,
          atlasIconId: ["OLT", "OTB", "ODC", "ODP", "POLE", "JC", "HANDHOLE", "MANHOLE", "FDT", "OFP", "POP", "ODF", "SLACK", "TERMINAL BOX"].includes(iconCategory) ? `atlas-icon-${iconCategory.toLowerCase().replace(/\s+/g, "-")}` : "",
          routeType,
          lineColor: style?.lineColor ?? (legend.cableLineWidth ? legend.color : undefined) ?? inferredLineColor ?? String(item.attributes?.lineColor ?? (routeType === "FEEDER" ? "#ff0000" : routeType === "DISTRIBUTION" ? "#a000ff" : item.source === "kml" ? "#ffffff" : "#3454d1")),
          lineOpacity: style?.lineOpacity ?? 1,
          lineWidth: style?.lineWidth ?? legend.cableLineWidth ?? (routeType === "BACKBONE" ? 5 : routeType === "FEEDER" ? 4 : routeType === "DISTRIBUTION" ? 3 : routeType === "DROP" ? 2 : item.source === "kml" ? 1 : 3),
          fillColor: style?.fillColor ?? (item.source === "kml" ? "#ffffff" : "#3454d1"),
          fillOpacity: style?.fillOpacity ?? (item.source === "kml" ? 1 : 0.25),
          fillEnabled: style?.fillEnabled ?? item.source === "kml",
          outlineEnabled: style?.outlineEnabled ?? ((item.geometry.type !== "Polygon" && item.geometry.type !== "MultiPolygon") || item.source === "kml"),
          iconColor: style?.iconColor ?? "#ffffff",
          markerColor: style?.iconColor ?? ({ OLT: "#2864d7", OTB: "#00bcd4", ODC: "#f28c28", ODP: "#8b4513", POLE: "#e8c300", JC: "#f28c28", HANDHOLE: "#fff", MANHOLE: "#202124" } as Record<string, string>)[iconCategory] ?? "#3454d1",
          isManagedFtth: item.attributes?.source === "ftth-design",
          iconOpacity: style?.iconOpacity ?? 1,
          iconScale: style?.iconScale ?? 1,
          iconAnchor: style?.iconAnchor ?? (googlePushpin ? "bottom-right" : "center"),
          iconOffset: style?.iconOffset ?? (googlePushpin ? [12 / 32, 2 / 32] : [0, 0]),
          iconImageId: kmzIcon ? `kmz-${kmzIcon}-${(style?.iconColor ?? "#ffffff").slice(1)}` : iconUrl ? `kml-${hashIconReference(iconUrl)}-${(style?.iconColor ?? "#ffffff").slice(1)}` : "",
          iconHref: iconUrl ?? "",
          fallbackIconImageId: legend.iconUrl ? `legend-${hashIconReference(legend.iconUrl)}-${(legend.color ?? "#ffffff").slice(1)}` : "",
          fallbackIconHref: legend.iconUrl?.replace("https://maps.google.com/mapfiles/kml/", "/kml-icons/") ?? "",
          fallbackIconTint: legend.color ?? "#ffffff",
          iconTint: style?.iconColor ?? (style?.iconHref ? "#ffffff" : legend.color ?? iconLegendColor[iconCategory] ?? "#ffffff"),
        },
        geometry: item.geometry,
      });
    }
    return features;
  }, []).flatMap((feature) => mapGeometryParts(feature.geometry).map((geometry) => ({ ...feature, geometry, properties: { ...feature.properties, geometryType: geometry.type } })));

function addAtlasMapIcons(map: MapLibreMap) {
  const icons: Record<string, string> = { OLT: "#2864d7", OTB: "#00bcd4", ODC: "#f28c28", ODP: "#8b4513", POLE: "#e8c300", JC: "#f28c28", HANDHOLE: "#fff", MANHOLE: "#202124", FDT: "#e75b3c", OFP: "#178c80", POP: "#e8b500", ODF: "#684fc7", SLACK: "#e53935", "TERMINAL BOX": "#3280c8" };
  for (const [category, color] of Object.entries(icons)) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) continue;
    context.scale(2, 2);
    if (category === "ODC") {
      context.fillStyle = color; context.strokeStyle = "#fff"; context.lineWidth = 2;
      context.fillRect(6, 6, 20, 20); context.strokeRect(6, 6, 20, 20);
    } else if (category === "ODP") {
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

const normalizeProvinceBoundaryName = (value: unknown) => String(value ?? "")
  .trim()
  .toLocaleLowerCase("id-ID")
  .replace(/^(provinsi|province|propinsi)\s+/i, "")
  .replace(/\s+(province|provinsi|propinsi)$/i, "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "");

const provinceBoundaryAliases: Record<string, string[]> = {
  "12": ["sumatera utara", "north sumatra", "north sumatera"],
  "36": ["banten", "probanten"],
  "31": ["dki jakarta", "jakarta", "daerah khusus ibukota jakarta"],
  "32": ["jawa barat", "west java"],
};

function hashIconReference(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}
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
  const nearby = map.queryRenderedFeatures([point.x, point.y], { layers: ["network-point-hit", "network-icons"] });
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
  const features = map.queryRenderedFeatures([point.x, point.y], { layers: ["network-icons"] }).filter((feature): feature is typeof feature & { geometry: Point } => feature.geometry.type === "Point");
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

function cableLengthMeters(geometry: Geometry | null): number | null {
  if (!geometry) return null;
  const lines: number[][][] = [];
  const collect = (item: Geometry) => {
    if (item.type === "LineString") lines.push(item.coordinates as number[][]);
    else if (item.type === "MultiLineString") lines.push(...item.coordinates as number[][][]);
    else if (item.type === "GeometryCollection") item.geometries.forEach(collect);
  };
  collect(geometry);
  if (!lines.length) return null;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  return lines.reduce((total, line) => total + line.slice(1).reduce((length, point, index) => {
    const [lon1, lat1] = line[index];
    const [lon2, lat2] = point;
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
    return length + 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }, 0), 0);
}

function matchesAssetSearch(asset: NetworkAsset, query: string) {
  if (!query) return true;
  const searchable = [asset.name, asset.area, asset.cableType, asset.assetType, asset.pole, asset.odc, asset.odp,
    ...Object.entries(asset.attributes ?? {}).flatMap(([key, value]) => [key, value]).filter((value) => typeof value === "string" || typeof value === "number")]
    .map((value) => String(value ?? "").toLocaleLowerCase("id-ID"))
    .join(" ");
  return searchable.includes(query);
}

function SegmentCoreSummary({ asset }: { asset: NetworkAsset }) {
  if (asset.assetType !== "segment") return null;
  if (!asset.totalCores) return <small className="segment-core-empty">Core belum diisi</small>;
  return <span className="segment-core-summary">
    <span>{asset.totalCores.toLocaleString("id-ID")} total</span>
    <span className="core-used">{asset.usedCores.toLocaleString("id-ID")} terpakai</span>
    <span className="core-booked">{asset.bookedCores.toLocaleString("id-ID")} dibooking</span>
    <span className="core-available">{asset.idleCores.toLocaleString("id-ID")} tersedia</span>
  </span>;
}

export function MapPage() {
  const mapProvincesQuery = useQuery({
    queryKey: ["network-map-provinces"],
    queryFn: () => api<MapProvinceResponse>("/assets/provinces", { timeout: 30_000 }),
    retry: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [provinceCode, setProvinceCode] = useState("");
  const [provincePickMessage, setProvincePickMessage] = useState("");
  const provinces = mapProvincesQuery.data?.items ?? [];
  const selectedProvince = provinces.find((province) => province.code === provinceCode);
  const selectedProvinceCodeRef = useRef(provinceCode);
  selectedProvinceCodeRef.current = provinceCode;
  const [assetPage, setAssetPage] = useState(1);
  const [search, setSearch] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [coreFilter, setCoreFilter] = useState("all");
  const catalogQuery = useQuery({
    queryKey: ["segment-catalog", assetPage, catalogSearch, coreFilter, provinceCode],
    queryFn: () => api<NetworkAssetPage>(`/assets/catalog?page=${assetPage}&pageSize=50&search=${encodeURIComponent(catalogSearch)}&coreFilter=${coreFilter}&provinceCode=${provinceCode}`),
    enabled: Boolean(provinceCode),
    refetchInterval: 30_000,
  });
  const networkSegments = catalogQuery.data?.items ?? [];
  const [mapBounds, setMapBounds] = useState<[number, number, number, number] | null>(null);
  const [mapZoom, setMapZoom] = useState(4);
  const mapAssetsQuery = useQuery({
    queryKey: ["map-assets", mapBounds, mapZoom, provinceCode],
    queryFn: ({ signal }) => api<NetworkAsset[]>(`/assets/map?bbox=${mapBounds!.join(",")}&zoom=${mapZoom}&provinceCode=${provinceCode}`, { signal, timeout: 30_000 }),
    retry: 0,
    enabled: Boolean(mapBounds && provinceCode),
    staleTime: 20_000,
    placeholderData: (previousData, previousQuery) => previousQuery?.queryKey[3] === provinceCode ? previousData : undefined,
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
  const [exporting, setExporting] = useState(false);
  const [routeError, setRouteError] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileImportCount, setFileImportCount] = useState<number | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeDistance, setRouteDistance] = useState<number | null>(null);
  const [assetPopup, setAssetPopup] = useState<NetworkAsset | null>(null);
  const [popupAnchor, setPopupAnchor] = useState<Coordinate | null>(null);
  const [popupPosition, setPopupPosition] = useState({ left: 12, top: 54 });
  const popupElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const instance = map.current;
    const element = popupElement.current;
    if (!instance || !element || !assetPopup || !popupAnchor) return;
    const position = () => {
      const point = instance.project(popupAnchor);
      const container = instance.getContainer();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = point.x + width + 20 < container.clientWidth ? point.x + 18 : point.x - width - 18;
      setPopupPosition({ left: Math.max(12, Math.min(left, container.clientWidth - width - 12)), top: Math.max(54, Math.min(point.y - height / 2, container.clientHeight - height - 12)) });
    };
    position();
    instance.on("move", position);
    instance.on("resize", position);
    const observer = new ResizeObserver(position);
    observer.observe(element);
    return () => { instance.off("move", position); instance.off("resize", position); observer.disconnect(); };
  }, [assetPopup, popupAnchor]);
  const [fileModal, setFileModal] = useState<"import" | "download" | null>(null);
  const { data: user } = useQuery({ queryKey: ["me"], queryFn: () => api<{ role: string }>("/me") });

  useEffect(() => {
    const timer = window.setTimeout(() => { setAssetPage(1); setCatalogSearch(search.trim()); }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const knownAssets = useMemo(() => [...new Map([...networkSegments, ...(mapAssetsQuery.data ?? [])].map((asset) => [asset.id, asset])).values()], [networkSegments, mapAssetsQuery.data]);
  const knownAssetsRef = useRef(knownAssets);
  knownAssetsRef.current = knownAssets;

  const allNetworkFeatures = useMemo(() => assetFeatures(mapAssetsQuery.data ?? []), [mapAssetsQuery.data]);
  const iconCategoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const asset of mapAssetsQuery.data ?? [])
      if (asset.geometryType?.toUpperCase() === "POINT") {
        const category = assetIconCategory(asset);
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    return [...counts].sort(([a], [b]) => a.localeCompare(b, "id"));
  }, [mapAssetsQuery.data]);
  const activeIconCategories = useMemo(() => selectedIconCategories ?? iconCategoryCounts.map(([category]) => category), [selectedIconCategories, iconCategoryCounts]);
  useEffect(() => {
    if (selectedIconCategories === null) localStorage.removeItem("atlas-map-icon-categories-v2");
    else localStorage.setItem("atlas-map-icon-categories-v2", JSON.stringify(selectedIconCategories));
  }, [selectedIconCategories]);
  const shapeFeatures = useMemo(() => lineCollection(allNetworkFeatures.filter((feature) => feature.geometry.type !== "Point")), [allNetworkFeatures]);
  const pointFeatures = useMemo(() => lineCollection(allNetworkFeatures.filter((feature) => feature.geometry.type === "Point" && activeIconCategories.includes(String(feature.properties.iconCategory)))), [allNetworkFeatures, activeIconCategories]);
  const routeFeatures = useMemo(() => routeCollection([...confirmedRoutes, ...(routePreview ? [routePreview] : [])]), [confirmedRoutes, routePreview]);
  const routePointFeatures = useMemo(() => pointCollection(routePoints), [routePoints]);
  const selectedAsset = knownAssets.find((item) => item.id === selectedId)
    ?? knownAssets.find((item) => ftthDesignGroupId(item))
    ?? networkSegments[0];
  const selectedDraftId = selectedAsset ? ftthDesignGroupId(selectedAsset) : undefined;
  const selectedDraftDesignAnchor = selectedDraftId ? knownAssets.find((asset) =>
    ftthDesignGroupId(asset) === selectedDraftId && asset.attributes?.designAnchor === true,
  ) : undefined;
  const selectedDraftOlt = selectedDraftId ? knownAssets.find((asset) =>
    ftthDesignGroupId(asset) === selectedDraftId
    && (String(asset.attributes?.assetKind ?? "").toUpperCase() === "OLT" || /^OLT(?:\b|\s|·)/i.test(asset.name)),
  ) : undefined;
  const selectedDraftAnchor = selectedDraftDesignAnchor ?? selectedDraftOlt ?? (selectedDraftId ? selectedAsset : undefined);
  const selectedDraftOltGeometry = useQuery({
    queryKey: ["asset-geometry", selectedDraftAnchor?.id],
    queryFn: () => api<{ geometry: Geometry | null }>(`/assets/${selectedDraftAnchor!.id}/geometry`),
    enabled: Boolean(selectedDraftAnchor),
    staleTime: 60_000,
  });
  const draftRadiusMeters = Number(selectedDraftDesignAnchor?.attributes?.coverageRadiusMeters ?? selectedDraftOlt?.attributes?.coverageRadiusMeters) || 500;
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
  const selectedLegend = selectedAsset ? legendStyle(selectedAsset) : undefined;
  const selectedSegmentGeometry = useQuery({
    queryKey: ["asset-geometry", selectedSegment?.id],
    queryFn: () => api<{ geometry: Geometry | null }>(`/assets/${selectedSegment!.id}/geometry`),
    enabled: Boolean(selectedSegment),
    staleTime: 60_000,
  });
  const selectedCableGeometry = selectedSegmentGeometry.data?.geometry ?? selectedSegment?.geometry ?? null;
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
    onSuccess: (_, { id }) => {
      if (selectedSegment?.id === id && assetDetails.current) assetDetails.current.open = false;
      return invalidateNetwork();
    },
  });
  useEffect(() => {
    updateCore.reset();
    updateAsset.reset();
  }, [selectedSegment?.id, updateCore.reset, updateAsset.reset]);
  const normalizedSearch = search.trim().toLocaleLowerCase("id-ID");
  const filteredSegments = networkSegments.filter((item) => item.source !== "kml" && item.assetType === "segment" && matchesAssetSearch(item, normalizedSearch));
  const ftthDraftGroups = new Map<string, typeof filteredSegments>();
  const standaloneSegments = filteredSegments.filter((segment) => {
    const groupId = ftthDesignGroupId(segment);
    if (!groupId) return true;
    const group = ftthDraftGroups.get(groupId) ?? [];
    group.push(segment);
    ftthDraftGroups.set(groupId, group);
    return false;
  });
  const getDraftFeatureCount = (groupId: string) => knownAssets.filter((asset) => ftthDesignGroupId(asset) === groupId).length;
  const matchedImported = imported.filter((item) => (item.source === "kml" || item.assetType !== "segment") && matchesAssetSearch(item, normalizedSearch));
  const filteredImported = matchedImported.slice(0, 100);
  const catalogPageCount = Math.max(1, Math.ceil((catalogQuery.data?.total ?? 0) / (catalogQuery.data?.pageSize ?? 50)));

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
    localStorage.removeItem("atlas-map-focus");
    localStorage.removeItem("atlas-map-focus-design");
    const instance = new MapLibreMap({
      container: mapElement.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [118, -2.5],
      zoom: 5.3,
      maxBounds: [[94, -12], [142, 7]],
    });
    map.current = instance;
    let boundsTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeObserver = new ResizeObserver(() => instance.resize());
    resizeObserver.observe(mapElement.current);
    instance.addControl(new NavigationControl(), "top-right");
    instance.on("error", () => setMapError(true));
    instance.on("load", () => {
      addAtlasMapIcons(instance);
      const updateBounds = () => {
        const bounds = instance.getBounds();
        const nextBounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value) => Number(value.toFixed(4))) as [number, number, number, number];
        const nextZoom = Math.floor(instance.getZoom());
        setMapBounds((previous) => previous?.every((value, index) => value === nextBounds[index]) ? previous : nextBounds);
        setMapZoom((previous) => previous === nextZoom ? previous : nextZoom);
      };
      instance.on("moveend", () => {
        clearTimeout(boundsTimer);
        boundsTimer = setTimeout(updateBounds, 450);
      });
      updateBounds();
      instance.addSource("network-shapes", { type: "geojson", data: shapeFeatures });
      instance.addSource("network-points-data", { type: "geojson", data: pointFeatures, cluster: false });
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
        id: "network-icons",
        type: "symbol",
        source: "network-points-data",
        filter: ["all", ["!", ["has", "point_count"]], ["any", ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]], ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]]]],
        layout: {
          "icon-image": ["coalesce", ["image", ["get", "iconImageId"]], ["image", ["get", "fallbackIconImageId"]], ["image", ["get", "atlasIconId"]]],
          "icon-size": ["case", ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]], ["get", "legendIconScale"], ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]], ["match", ["get", "iconCategory"], "POLE", 0.62, "OLT", 0.8, "ODC", 0.8, "ODP", 0.8, 0.8], ["min", ["max", ["*", ["coalesce", ["get", "iconScale"], 1], 0.9], 0.9], 1]],
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
        filter: ["all", ["!", ["has", "point_count"]], [">", ["get", "legendLabelSize"], 0]],
        layout: { "text-field": ["get", "sourceLabel"], "text-size": ["*", ["get", "legendLabelSize"], 10], "text-font": ["Open Sans Semibold"], "text-offset": [0, 1.2], "text-anchor": "top", "text-allow-overlap": false, "text-ignore-placement": false },
        paint: { "text-color": ["get", "labelColor"], "text-opacity": ["get", "labelOpacity"], "text-halo-color": "#333", "text-halo-width": 1.5 },
      });
      instance.addLayer({ id: "network-point-hit", type: "circle", source: "network-points-data", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 18, "circle-color": "#000", "circle-opacity": 0 } });
      instance.addSource("route-lines", { type: "geojson", data: routeFeatures });
      instance.addLayer({ id: "saved-routes", type: "line", source: "route-lines", filter: ["==", ["get", "status"], "saved"], paint: { "line-color": "#f29b38", "line-width": 5 } });
      instance.addLayer({ id: "preview-route", type: "line", source: "route-lines", filter: ["==", ["get", "status"], "preview"], paint: { "line-color": "#f29b38", "line-width": 5, "line-dasharray": [2, 1] } });
      instance.addSource("route-points", { type: "geojson", data: routePointFeatures });
      instance.addLayer({ id: "route-markers", type: "circle", source: "route-points", paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-width": 3, "circle-stroke-color": "#f29b38" } });
      void fetch("/data/indonesia-provinces.geojson").then((response) => response.json()).then((data) => {
        if (!map.current || map.current !== instance) return;
        instance.addSource("indonesia-provinces", { type: "geojson", data });
        instance.addLayer({ id: "province-selection-fill", type: "fill", source: "indonesia-provinces", paint: { "fill-color": "#64748b", "fill-opacity": 0.22 } });
        instance.addLayer({ id: "province-selection-border", type: "line", source: "indonesia-provinces", paint: { "line-color": "#ffffff", "line-width": 2 } });
        instance.moveLayer("province-selection-fill", "network-polygons");
        instance.moveLayer("province-selection-border", "network-polygons");
        instance.on("click", "province-selection-fill", (event) => {
          if (modeRef.current !== "idle") return;
          const name = normalizeProvinceBoundaryName(String(event.features?.[0]?.properties?.Propinsi ?? ""));
          const province = provincesRef.current.find((item) => [item.name, ...(provinceBoundaryAliases[item.code] ?? [])].some((value) => normalizeProvinceBoundaryName(value) === name));
          if (!province) { setProvincePickMessage("Belum ada aset KMZ yang terpetakan ke provinsi ini. Silakan pilih provinsi lain."); return; }
          setProvincePickMessage("");
          if (province.code === selectedProvinceCodeRef.current) return;
          setSelectedIconCategories(null);
          setMapBounds(province.bounds);
          setProvinceCode(province.code);
          instance.setPaintProperty("province-selection-fill", "fill-opacity", ["case", ["==", ["get", "Propinsi"], event.features?.[0]?.properties?.Propinsi], 0, 0.3]);
        });
        instance.on("mouseenter", "province-selection-fill", () => { instance.getCanvas().style.cursor = "pointer"; });
        instance.on("mouseleave", "province-selection-fill", () => { instance.getCanvas().style.cursor = ""; });
      }).catch(() => setMapError(true));
      if (instance.isStyleLoaded()) {
        instance.moveLayer("selected-ftth-boundary-fill");
        instance.moveLayer("selected-ftth-boundary-line");
      }
      instance.on("click", (event) => {
        if (modeRef.current !== "idle") return;
        const features = instance.queryRenderedFeatures(event.point, { layers: ["network-icons", "network-polygons", "network-lines", "network-hit"] });
        const cable = features.find((item) => ["network-lines", "network-hit"].includes(item.layer.id) && ["LineString", "MultiLineString"].includes(String(item.properties?.geometryType)));
        const boundary = features.find((item) => item.layer.id === "network-polygons");
        const feature = cable ?? pointFeatureAtCursor(instance, event.point) ?? boundary ?? nearestPointFeature(instance, event.point) ?? features[0];
        const id = String(feature?.properties?.id ?? "");
        if (id) {
          setSelectedId(id);
          setPopupAnchor([event.lngLat.lng, event.lngLat.lat]);
          setAssetPopup(knownAssetsRef.current.find((asset) => asset.id === id) ?? null);
        }
      });
      hoverPopup.current = new Popup({ closeButton: false, closeOnClick: false, anchor: "bottom", offset: 12, maxWidth: "260px", className: "network-hover-popup" });
      instance.on("mousemove", (event) => {
        const pointFeature = pointFeatureAtCursor(instance, event.point);
        const lineFeature = pointFeature
          ? undefined
          : instance.queryRenderedFeatures(event.point, { layers: ["network-lines", "network-hit"] }).find((item) => ["LineString", "MultiLineString"].includes(String(item.properties?.geometryType)));
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
        const sourceLabel = feature.properties?.source === "kml" ? "KML/KMZ" : feature.properties?.source === "xlsx" ? "Excel" : String(feature.properties?.area ?? "Jaringan");
        detail.textContent = isCluster ? "Klik untuk melihat lebih dekat" : `${sourceLabel} · ${String(feature.properties?.geometryType ?? "Segmen")} · Klik untuk detail`;
        content.append(title, document.createElement("br"), detail);
        if (!isCluster && feature.properties?.assetType === "segment") {
          const cores = document.createElement("small");
          const total = Number(feature.properties.totalCores ?? 0);
          cores.textContent = total > 0
            ? `${total} core total · ${Number(feature.properties.usedCores ?? 0)} terpakai · ${Number(feature.properties.bookedCores ?? 0)} dibooking · ${Number(feature.properties.idleCores ?? 0)} tersedia`
            : "Core belum diisi";
          content.append(document.createElement("br"), cores);
        }
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
      clearTimeout(boundsTimer);
      resizeObserver.disconnect();
      hoverPopup.current?.remove();
      hoverPopup.current = null;
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !selectedProvince?.bounds) return;
    map.current?.fitBounds(selectedProvince.bounds, { padding: 48, maxZoom: 10, duration: 0 });
    setAssetPage(1);
    setSelectedId("");
    setAssetPopup(null);
  }, [mapReady, selectedProvince]);

  useEffect(() => {
    (map.current?.getSource("network-shapes") as GeoJSONSource | undefined)?.setData(shapeFeatures);
    (map.current?.getSource("network-points-data") as GeoJSONSource | undefined)?.setData(pointFeatures);
  }, [shapeFeatures, pointFeatures]);
  useEffect(() => {
    (map.current?.getSource("selected-ftth-boundary") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: draftBoundary ? [draftBoundary] : [] });
  }, [draftBoundary, mapReady]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !mapReady) return;
    const categoryFilter: FilterSpecification = activeIconCategories.length ? ["in", ["get", "iconCategory"], ["literal", activeIconCategories]] : ["==", ["get", "iconCategory"], "__NO_ICON_CATEGORY_SELECTED__"];
    const applyFilters = () => {
      if (!instance.isStyleLoaded()) return;
      if (instance.getLayer("network-icons")) instance.setFilter("network-icons", ["all", ["any", ["all", ["has", "atlasIconId"], ["!=", ["get", "atlasIconId"], ""]], ["all", ["has", "iconImageId"], ["!=", ["get", "iconImageId"], ""]]], categoryFilter]);
      if (instance.getLayer("network-point-hit")) instance.setFilter("network-point-hit", categoryFilter);
      if (instance.getLayer("network-labels")) instance.setFilter("network-labels", ["all", [">", ["get", "legendLabelSize"], 0], categoryFilter]);
    };
    if (instance.isStyleLoaded()) applyFilters();
    else instance.once("idle", applyFilters);
    return () => { instance.off("idle", applyFilters); };
  }, [mapReady, activeIconCategories]);
  useEffect(() => {
    if (!activeIconCategories.length) {
      const instance = map.current;
      if (!instance) return;
      instance.getCanvas().style.cursor = "";
      hoverPopup.current?.remove();
    }
  }, [activeIconCategories]);
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
    const assetsById = new Map(knownAssets.map((asset) => [asset.id, asset]));
    for (const feature of allNetworkFeatures) {
      const fallbackId = String(feature.properties?.fallbackIconImageId ?? "");
      const fallbackUrl = String(feature.properties?.fallbackIconHref ?? "");
      if (fallbackId && fallbackUrl) icons.set(fallbackId, { url: fallbackUrl, color: String(feature.properties?.fallbackIconTint ?? "#ffffff") });
      const id = String(feature.properties?.iconImageId ?? "");
      const url = String(feature.properties?.iconHref ?? "");
      if (id && url) {
        const style = assetsById.get(String(feature.properties?.id))?.attributes?.__kmlStyle as ImportedStyle | undefined;
        icons.set(id, { url, color: String(feature.properties?.iconTint ?? style?.iconColor ?? "#ffffff") });
      }
    }
    const addLoadedIcon = (id: string, data: HTMLImageElement | ImageBitmap | ImageData, color: string) => {
      if (instance.hasImage(id)) return;
      let image: HTMLImageElement | ImageBitmap | ImageData = data;
      if (!(data instanceof ImageData)) {
        try {
          image = tintKmlIcon(data, color);
        } catch {
          /* use the original Google Earth icon if canvas tinting is blocked */
        }
      }
      instance.addImage(id, image, { pixelRatio: Math.max(0.5, Math.max(data.width, data.height) / 32) });
    };
    for (const [id, { url, color }] of icons) {
      if (instance.hasImage(id)) continue;
      if (url.startsWith("atlas-kmz-icon:")) {
        const iconId = url.slice("atlas-kmz-icon:".length);
        void api<{ mimeType: string; data: string }>(`/assets/kml-icons/${iconId}`)
          .then(async ({ mimeType, data }) => {
            const binary = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
            const image = await createImageBitmap(new Blob([binary], { type: mimeType }));
            addLoadedIcon(id, image, color);
          })
          .catch(() => undefined);
      } else {
        void instance.loadImage(url)
          .then(({ data }) => addLoadedIcon(id, data, color))
          .catch(() => undefined);
      }
    }
  }, [allNetworkFeatures, mapReady, knownAssets]);

  async function importFile(file?: File) {
    if (!file) return;
    setImporting(true);
    try {
      setFileError("");
      const form = new FormData();
      form.append("file", file);
      const response = await api<{ importedCount: number; segmentCount: number; firstId?: string }>("/assets/import", { method: "POST", data: form });
      setFileName(file.name);
      setFileImportCount(response.importedCount);
      await queryClient.invalidateQueries({ queryKey: ["network-map-provinces"] });
      await invalidateNetwork();
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
      setFileName(file.name)
      setFileImportCount(result.importedCount)
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "File Excel jaringan tidak dapat dibaca.")
    } finally { setImporting(false) }
  }

  function downloadNetworkTemplate() {
    void buildNetworkWorkbook().xlsx.writeBuffer().then((buffer) => downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "template-impor-jaringan-atlas.xlsx"));
  }

  async function downloadNetworkFile(format: "kml" | "kmz" | "xlsx") {
    setExporting(true);
    setFileError("");
    try {
      const boundsQuery = provinceCode ? `?provinceCode=${encodeURIComponent(provinceCode)}` : "";
      const { bounds } = await api<{ bounds: [number, number, number, number] | null }>(`/assets/bounds${boundsQuery}`);
      if (!bounds) throw new Error("Belum ada aset jaringan untuk diunduh.");
      const padding = 0.000001;
      const bbox = [Math.max(-180, bounds[0] - padding), Math.max(-90, bounds[1] - padding), Math.min(180, bounds[2] + padding), Math.min(90, bounds[3] + padding)].join(",");
      const assets = await api<NetworkAsset[]>(`/assets/map?bbox=${bbox}&zoom=24${provinceCode ? `&provinceCode=${encodeURIComponent(provinceCode)}` : ""}`);
      if (!assets.some((asset) => asset.geometry)) throw new Error("Belum ada geometri aset jaringan untuk diunduh.");
      const baseName = `atlas-data-jaringan${selectedProvince ? `-${selectedProvince.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : ""}`;
      if (format === "xlsx") {
        const buffer = await buildNetworkWorkbook(assets).xlsx.writeBuffer();
        downloadBlob(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `${baseName}.xlsx`);
      } else {
        const kml = networkKml(assets);
        if (format === "kml") downloadBlob(new Blob([kml], { type: "application/vnd.google-earth.kml+xml;charset=utf-8" }), `${baseName}.kml`);
        else {
          const archive = new JSZip();
          archive.file("doc.kml", kml);
          downloadBlob(await archive.generateAsync({ type: "blob", compression: "DEFLATE" }), `${baseName}.kmz`);
        }
      }
      setFileModal(null);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "File peta tidak dapat dibuat.");
    } finally { setExporting(false); }
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
        <section className="map-canvas-wrap" aria-busy={(!mapReady && !mapError) || (Boolean(provinceCode) && mapAssetsQuery.isLoading)}>
          <div ref={mapElement} className={`map-canvas ${mode !== "idle" ? "map-picking" : ""}`} aria-label="Peta jaringan ATLAS" />
          <div className="map-province-filter" style={{ position: "absolute", zIndex: 4, top: 12, left: 12, width: "min(290px, calc(100% - 24px))", padding: 10, borderRadius: 12, background: "var(--bs-body-bg, white)", boxShadow: "0 2px 12px #17233b33" }}>
            <label className="form-label fw-semibold mb-1 text-uppercase" htmlFor="map-province-filter">Pilih provinsi</label>
            <select id="map-province-filter" className="form-select form-select-sm mb-2" value={provinceCode} disabled={mapProvincesQuery.isPending} onChange={(event) => {
              const nextProvince = provinces.find((province) => province.code === event.target.value);
              setProvincePickMessage("");
              setSelectedIconCategories(null);
              setMapBounds(nextProvince?.bounds ?? null);
              setProvinceCode(event.target.value);
              if (!nextProvince) map.current?.flyTo({ center: [118, -2.5], zoom: 5.3 });
              const instance = map.current;
              if (instance?.getLayer("province-selection-fill")) {
                instance.setPaintProperty("province-selection-fill", "fill-opacity", nextProvince ? ["case", ["in", ["upcase", ["get", "Propinsi"]], ["literal", [nextProvince.name, ...(provinceBoundaryAliases[nextProvince.code] ?? [])].map((name) => name.toUpperCase())]], 0, 0.3] : 0.22);
              }
            }}>
              <option value="">{mapProvincesQuery.isPending ? "Memuat provinsi…" : "Pilih provinsi untuk melihat aset"}</option>
              {provinces.map((province) => <option key={province.code} value={province.code}>{province.name} · {province.assetCount.toLocaleString("id-ID")} aset</option>)}
            </select>
            <small className="d-block">Klik langsung wilayah provinsi untuk menampilkan aset KMZ.</small>
            {provincePickMessage && <small className="text-warning d-block mt-1" role="status">{provincePickMessage}</small>}
            {selectedProvince && <small className="text-muted d-block mt-1">{selectedProvince.assetCount.toLocaleString("id-ID")} aset · {selectedProvince.folderCount.toLocaleString("id-ID")} folder KMZ</small>}
            {!provinceCode && provinces.length > 0 && <small className="text-muted d-block mt-1">Aset jaringan dimuat setelah wilayah provinsi diklik.</small>}
            {!mapProvincesQuery.isPending && !mapProvincesQuery.isError && !provinces.length && <small className="text-warning d-block mt-1">Belum ada provinsi yang cocok dengan data KMZ.</small>}
            {mapProvincesQuery.isError && <small className="text-danger d-block mt-1">Daftar provinsi KMZ gagal dimuat.</small>}
          </div>
          {((!mapReady && !mapError) || (Boolean(provinceCode) && mapAssetsQuery.isLoading)) && (
            <div className="position-absolute top-50 start-50 translate-middle d-flex align-items-center gap-3 bg-body border rounded-3 shadow px-4 py-3" style={{ zIndex: 5, pointerEvents: "none" }} role="status" aria-live="polite">
              <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
              <span className="text-nowrap">Memuat data peta…</span>
            </div>
          )}
          {mapAssetsQuery.isError && <div className="map-error" role="alert">Aset provinsi gagal dimuat. <button className="btn btn-sm btn-outline-danger ms-2" onClick={() => void mapAssetsQuery.refetch()}>Coba lagi</button></div>}
          <div className="map-top-actions">
            {user?.role === "ADMIN" && <div className="map-file-actions">
              <button className="btn btn-light" onClick={() => setFileModal("import")} disabled={importing} aria-busy={importing}>{importing ? <><span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true" />Mengimpor...</> : <><i className="bi bi-upload me-1" />Impor</>}</button>
              <button className="btn btn-light" onClick={() => setFileModal("download")}><i className="bi bi-download me-1" />Unduh</button>
            </div>}
            {provinceCode && <details ref={iconFilter} className="map-icon-filter">
              <summary><i className="bi bi-funnel" /><span>Filter ikon</span><b>{activeIconCategories.length}/{iconCategoryCounts.length}</b></summary>
              <div className="map-icon-filter-menu">
                <div className="map-icon-filter-actions">
                  <button type="button" onClick={() => setSelectedIconCategories(iconCategoryCounts.map(([category]) => category))}>Pilih semua</button>
                  <button type="button" onClick={() => setSelectedIconCategories([])}>Bersihkan</button>
                </div>
                <input aria-label="Cari kategori ikon" placeholder="Cari jenis ikon" value={iconCategorySearch} onChange={(event) => setIconCategorySearch(event.target.value)} />
                <div className="map-icon-filter-list">
                  {iconCategoryCounts.filter(([category]) => category.toLowerCase().includes(iconCategorySearch.toLowerCase())).map(([category, count]) => (
                    <label key={category}><input type="checkbox" checked={activeIconCategories.includes(category)} onChange={(event) => setSelectedIconCategories((current) => (event.target.checked ? [...(current ?? activeIconCategories), category] : (current ?? activeIconCategories).filter((item) => item !== category)))} />{iconPreview(category)}<span>{category}</span><small>{count.toLocaleString("id-ID")}</small></label>
                  ))}
                </div>
                {!iconCategoryCounts.length && <small className="map-icon-filter-empty">Belum ada ikon titik.</small>}
              </div>
            </details>}
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
          {assetPopup && (() => {
            const coordinate = firstCoordinate(assetPopup.geometry);
            const popupLength = assetPopup.id === selectedSegment?.id ? cableLengthMeters(selectedCableGeometry) : cableLengthMeters(assetPopup.geometry);
            const attributes = assetPopup.attributes ?? {};
            const savedFields = attributes.__kmlDetailFields;
            const sourceFields: Array<[string, unknown]> = Array.isArray(savedFields)
              ? savedFields.filter((field): field is [string, unknown] => Array.isArray(field) && field.length === 2 && typeof field[0] === "string")
              : Object.entries(attributes).filter(([key]) => !key.startsWith("__") && !["name", "description", "folderPath", "styleUrl"].includes(key));
            const originalKmzFields: Array<[string, unknown]> = [
              ...sourceFields.filter(([key]) => key.trim().toLowerCase() !== "nama objek"),
              ...["description", "folderPath", "styleUrl"].filter((key) => attributes[key] !== undefined && !sourceFields.some(([label]) => label === key)).map((key): [string, unknown] => [key === "folderPath" ? "Folder KMZ" : key === "description" ? "Deskripsi" : key, attributes[key]]),
            ];
            const fields: Array<[string, unknown]> = (assetPopup.source === "kml" ? originalKmzFields : [
              ["Nama objek", assetPopup.name], ["Tipe perangkat", assetPopup.attributes?.assetKind ?? assetPopup.assetType],
              ["Tipe geometri", assetPopup.geometry?.type], ["Tipe jaringan", assetPopup.attributes?.networkType ?? assetPopup.attributes?.routeType],
              ["Area", assetPopup.area], ["Tipe kabel", assetPopup.cableType],
              ...(assetPopup.assetType === "segment" ? [["Jumlah core", assetPopup.totalCores > 0 ? `${assetPopup.totalCores.toLocaleString("id-ID")} core` : "Belum tercantum di data kabel"], ["Panjang kabel", selectedSegmentGeometry.isPending && assetPopup.id === selectedSegment?.id ? "Menghitung…" : popupLength === null ? "Geometri garis tidak tersedia" : popupLength >= 1000 ? `${(popupLength / 1000).toFixed(2)} km` : `${Math.round(popupLength)} m`]] as Array<[string, unknown]> : []),
              ["Metode instalasi", assetPopup.installation], ["Sisi jalan", assetPopup.side], ["Nomor tiang", assetPopup.pole],
              ["ODC", assetPopup.odc], ["ODP", assetPopup.odp], ...Object.entries(assetPopup.attributes ?? {}).filter(([key]) => !key.startsWith("__")).map(([key, value]) => [key, value] as [string, unknown]),
              ["Longitude", coordinate[0]], ["Latitude", coordinate[1]],
            ] as Array<[string, unknown]>).filter((entry): entry is [string, unknown] => entry[1] !== undefined && entry[1] !== null && (assetPopup.source === "kml" || entry[1] !== ""));
            return <div ref={popupElement} className="map-asset-popup" role="dialog" aria-label="Detail aset" style={popupPosition}>
              <header className="map-asset-popup-header">
                <div><h3>{String(assetPopup.attributes?.name ?? assetPopup.name)}</h3>{assetPopup.source === "kml" && <small>Atribut asli dari KMZ</small>}</div>
                <button type="button" className="btn-close" aria-label="Tutup" onClick={() => setAssetPopup(null)} />
              </header>
              <table className="map-asset-popup-table" aria-label="Atribut detail aset"><tbody>{fields.map(([label, value], index) => <tr key={index}><th scope="row">{label}</th><td>{String(value)}</td></tr>)}</tbody></table>
              {assetPopup.source === "kml" && assetPopup.assetType === "segment" && <div className="border-top mt-3 pt-2 small"><strong>Panjang kabel (dihitung dari geometri KMZ)</strong><div>{selectedSegmentGeometry.isPending && assetPopup.id === selectedSegment?.id ? "Menghitung…" : popupLength === null ? "Geometri garis tidak tersedia" : popupLength >= 1000 ? `${(popupLength / 1000).toFixed(2)} km` : `${Math.round(popupLength)} m`}</div></div>}
            </div>;
          })()}
        </section>
        <aside className="map-sidebar">
          <div className="map-tools">
            <div className="map-search">
              <label className="form-label fw-semibold">
                {provinceCode
                  ? <>Daftar aset jaringan <span className="text-muted fw-normal">({(catalogQuery.data?.total ?? 0).toLocaleString("id-ID")})</span></>
                  : "Daftar aset jaringan · pilih provinsi"}
              </label>
              <div className="input-group">
                <span className="input-group-text bg-white">
                  <i className="bi bi-search" />
                </span>
                <input className="form-control" placeholder="Cari kabel, area, tiang, ODC/ODP, atau lokasi" value={search} onChange={(event) => setSearch(event.target.value)} disabled={!provinceCode} />
              </div>
              <label className="form-label small mt-2 mb-1" htmlFor="map-core-filter">Filter segmen / core</label>
              <select id="map-core-filter" className="form-select form-select-sm" value={coreFilter} disabled={!provinceCode} onChange={(event) => { setCoreFilter(event.target.value); setAssetPage(1); }}>
                <option value="all">Semua aset</option>
                <option value="segments">Semua segmen</option>
                <option value="filled">Core sudah diisi</option>
                <option value="empty">Core belum diisi</option>
              </select>
            </div>
            <div className="map-tool-actions">
              {user?.role === "ADMIN" && <>
                <input ref={importInput} className="d-none" type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
                <input ref={xlsxImportInput} className="d-none" type="file" accept=".xlsx" onChange={(event) => { void importNetworkXlsx(event.target.files?.[0]); event.currentTarget.value = ""; }} />
              </>}
            </div>
            {fileName && (
              <div className="map-file-status">
                <i className="bi bi-check-circle-fill" /> {fileName} · {(fileImportCount ?? 0).toLocaleString("id-ID")} aset tersimpan
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
            {!provinceCode && <div className="map-empty-list">Pilih provinsi di peta untuk menampilkan aset KMZ.</div>}
            {Boolean(provinceCode) && catalogQuery.isPending && <div className="map-empty-list">Memuat daftar aset…</div>}
            {catalogQuery.isError && <div className="map-empty-list">Daftar aset tidak dapat dimuat.</div>}
            {standaloneSegments.map((segment) => (
              <button key={segment.id} className={`segment-item ${selectedId === segment.id ? "selected" : ""}`} onClick={() => focusAsset(segment)}>
                <span className="segment-dot" />
                <span className="segment-meta">
                  <b>{segment.name}</b>
                  <small>
                    {segment.area || "Segmen jaringan"}
                  </small>
                  <SegmentCoreSummary asset={segment} />
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
                    <span className="segment-meta"><b>{segment.name}</b><small>{segment.attributes?.routeType === "FEEDER" ? "Kabel feeder" : "Kabel distribusi"} · {segment.area}</small><SegmentCoreSummary asset={segment} /></span>
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
                  <small>{line.source === "kml" ? "KML/KMZ" : "Excel"} · {line.assetType === "segment" ? "Segmen kabel" : "Aset jaringan"}</small>
                  <SegmentCoreSummary asset={line} />
                </span>
                <i className="bi bi-chevron-right" />
              </button>
            ))}
            {matchedImported.length > filteredImported.length && <div className="map-empty-list">Menampilkan 100 dari {matchedImported.length} aset impor. Gunakan pencarian untuk mempersempit daftar.</div>}
            {Boolean(provinceCode) && !catalogQuery.isPending && filteredSegments.length + matchedImported.length === 0 && <div className="map-empty-list">Tidak ada aset jaringan yang cocok.</div>}
          </div>
          {catalogQuery.data && catalogQuery.data.total > catalogQuery.data.pageSize && <div className="asset-pagination">
            <small className="text-muted">Halaman {assetPage.toLocaleString("id-ID")} dari {catalogPageCount.toLocaleString("id-ID")}{catalogQuery.isFetching ? " · Memuat…" : ""}</small>
            <div className="btn-group btn-group-sm" role="group" aria-label="Pagination daftar aset">
              <button className="btn btn-outline-secondary" aria-label="Sebelumnya" title="Sebelumnya" onClick={() => setAssetPage((page) => Math.max(1, page - 1))} disabled={assetPage <= 1 || catalogQuery.isPlaceholderData}><i className="bi bi-chevron-left" aria-hidden="true" /></button>
              <button className="btn btn-outline-secondary" aria-label="Berikutnya" title="Berikutnya" onClick={() => setAssetPage((page) => Math.min(catalogPageCount, page + 1))} disabled={assetPage >= catalogPageCount || catalogQuery.isPlaceholderData}><i className="bi bi-chevron-right" aria-hidden="true" /></button>
            </div>
          </div>}
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
                    ["Terpakai (Used)", selectedSegment.usedCores, "used"],
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
                              <option value="Available">Tersedia</option>
                              <option value="Used">Terpakai</option>
                            </select>
                          ) : (
                            <span className={`status-pill ${core.status === "Used" ? "is-released" : "is-waiting"}`}>{core.status === "Used" ? "Terpakai" : "Tersedia"}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {updateCore.error && <small className="text-danger">{updateCore.error instanceof Error ? updateCore.error.message : "Status core tidak dapat diubah."}</small>}
                </details>
                <details className="core-list-details"><summary>Waiting list · {bookings.filter((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List").length}</summary>
                  {bookingsPending ? <small role="status">Memuat antrean...</small> : bookingsError ? <small className="text-danger">Antrean tidak dapat dimuat.</small> : <div className="segment-waiting-list">
                    {bookings.filter((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List").sort((a, b) => Date.parse(a.approvedAt ?? a.requestedAt) - Date.parse(b.approvedAt ?? b.requestedAt) || a.id.localeCompare(b.id)).map((booking, index) => <div className="segment-waiting-item" key={booking.id}><b>{index + 1}. {booking.customer} · {booking.cores} core</b><small>PIC customer: {booking.picCustomer}<br />PIC presales: {booking.picPresales}<br />Masuk antrean: {new Date(booking.approvedAt ?? booking.requestedAt).toLocaleString('id-ID')}</small></div>)}
                    {!bookings.some((booking) => booking.segmentId === selectedSegment.id && booking.status === "Waiting List") && <small className="text-secondary">Belum ada permintaan waiting list.</small>}
                    <small className="text-secondary d-block mt-2">FIFO ketat: permintaan berikutnya menunggu jika kapasitas belum cukup untuk antrean pertama.</small>
                  </div>}
                </details>
                <hr />
                <div className="asset-info">
                  {(() => {
                    const attributes = Object.entries(selectedSegment.attributes ?? {}).filter(([key, value]) => !key.startsWith("__") && value !== undefined && value !== null && value !== "");
                    const find = (pattern: RegExp) => attributes.find(([key]) => pattern.test(key))?.[1];
                    const from = find(/^(from|source|origin|upstream|asal|dari|start|olt|odc|fdt)([_ -]?id|[_ -]?name)?$/i) ?? selectedSegment.odc ?? selectedSegment.attributes?.olt ?? selectedSegment.attributes?.fdt;
                    const to = find(/^(to|target|destination|downstream|tujuan|ke|end|odp)([_ -]?id|[_ -]?name)?$/i) ?? selectedSegment.odp;
                    return <div className="asset-info-group"><b>Detail koneksi kabel</b>
                      {from || to ? <div className="route-endpoints">
                        <span><small>Dari</small><strong>{String(from ?? "Tidak dicantumkan di KMZ")}</strong></span><i className="bi bi-arrow-right" aria-hidden="true" /><span><small>Ke</small><strong>{String(to ?? "Tidak dicantumkan di KMZ")}</strong></span>
                      </div> : <small className="text-secondary d-block mt-1">KMZ ini tidak mencantumkan field asal dan tujuan secara eksplisit.</small>}
                      {attributes.length > 0 && <details className="admin-settings mt-2"><summary>Atribut kabel dari KMZ ({attributes.length})</summary><div className="import-detail-list mt-2">{attributes.map(([key, value]) => <div key={key}><span>{key}</span><b>{String(value)}</b></div>)}</div></details>}
                    </div>;
                  })()}
                  <div className="asset-info-group"><b>Detail kabel</b><div className="asset-info">
                    <div><span>Standar legenda</span><b>{selectedLegend?.category} · {selectedLegend?.termination} · garis {selectedLegend?.cableLineWidth ?? "—"} px</b></div>
                    {[["Tipe kabel", selectedSegment.cableType], ["Metode instalasi", selectedSegment.installation], ["Sisi jalan", `Sisi ${selectedSegment.side.toLowerCase()}`]].map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
                  </div></div>
                  {(selectedSegment.pole || selectedSegment.poleHeight || selectedSegment.odc || selectedSegment.odp) && <div className="asset-info-group"><b>{selectedSegment.source === "managed" ? "Informasi aset" : "Data aset dari sumber impor"}</b><div className="asset-info">
                    {([["Tiang", selectedSegment.pole], ["Tinggi tiang", selectedSegment.poleHeight], ["ODC", selectedSegment.odc], ["ODP", selectedSegment.odp]] as const).filter(([, value]) => value).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}
                  </div></div>}
                </div>
                <SegmentRelations key={selectedSegment.id} segmentId={selectedSegment.id} isAdmin={user?.role === "ADMIN"} />
                {selectedSegment.source !== "managed" && <details className="admin-settings mt-3"><summary>Atribut sumber impor</summary><div className="import-detail-list mt-2">{Object.entries(selectedSegment.attributes ?? {}).filter(([key]) => key !== "__kmlStyle").map(([key, value]) => <div key={key}><span>{key}</span><b>{String(value)}</b></div>)}</div></details>}
                {user?.role === "ADMIN" && <details ref={assetDetails} className="admin-settings mt-4">
                  <summary><i className="bi bi-pencil-square me-2" />Ubah detail aset</summary>
                  <form key={selectedSegment.id} className="mt-3" onSubmit={saveAssetDetails}>
                    <label className="form-label">Area</label><input name="area" className="form-control form-control-sm mb-2" defaultValue={selectedSegment.area} />
                    <label className="form-label">Tipe kabel</label><input name="cableType" className="form-control form-control-sm mb-2" defaultValue={selectedSegment.cableType} />
                    <label className="form-label">Jumlah core total</label><input name="totalCores" type="number" min="0" max="4096" required className="form-control form-control-sm" defaultValue={selectedSegment.totalCores} />
                    <small className="form-text d-block mb-2">Core terpakai diatur per nomor di Rincian core; jumlahnya dihitung otomatis.</small>
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
                <div className="asset-info mb-3"><div><span>Standar legenda</span><b>{selectedLegend?.category} · {selectedLegend?.termination} · ikon {selectedLegend?.size}× · label {selectedLegend?.labelSize}×</b></div></div>
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
          <header><div><h2 id="file-modal-title">{fileModal === "import" ? "Impor data jaringan" : "Unduh file peta"}</h2><p>{fileModal === "import" ? "Pilih format file yang ingin diunggah." : exporting ? "Sedang menyiapkan file…" : "Unduh seluruh aset jaringan atau template Excel impor."}</p></div><button className="btn-close" aria-label="Tutup" onClick={() => setFileModal(null)} /></header>
          <div className="file-modal-options">{fileModal === "import" ? <>
            <button className="file-modal-option" onClick={() => { setFileModal(null); importInput.current?.click(); }}><span><i className="bi bi-globe2" /></span><div><b>KML / KMZ</b><small>Impor geometri, ikon, warna, dan atribut dari Google Earth.</small></div><i className="bi bi-chevron-right" /></button>
            <button className="file-modal-option" onClick={() => { setFileModal(null); xlsxImportInput.current?.click(); }}><span><i className="bi bi-file-earmark-spreadsheet" /></span><div><b>Excel (.xlsx)</b><small>Impor aset jaringan memakai template ATLAS.</small></div><i className="bi bi-chevron-right" /></button>
          </> : <>
            <button className="file-modal-option" onClick={() => { setFileModal(null); downloadNetworkTemplate(); }}><span><i className="bi bi-file-earmark-arrow-down" /></span><div><b>Template Excel jaringan</b><small>Unduh format impor beserta petunjuk pengisian.</small></div><i className="bi bi-download" /></button>
            <button className="file-modal-option" disabled={exporting} onClick={() => void downloadNetworkFile("kml")}><span><i className="bi bi-globe2" /></span><div><b>Ekspor KML</b><small>Unduh seluruh aset jaringan dalam format KML.</small></div><i className="bi bi-download" /></button>
            <button className="file-modal-option" disabled={exporting} onClick={() => void downloadNetworkFile("kmz")}><span><i className="bi bi-globe2" /></span><div><b>Ekspor KMZ</b><small>Unduh seluruh aset jaringan dalam arsip KMZ.</small></div><i className="bi bi-download" /></button>
            <button className="file-modal-option" disabled={exporting} onClick={() => void downloadNetworkFile("xlsx")}><span><i className="bi bi-file-earmark-spreadsheet" /></span><div><b>Ekspor Excel (.xlsx)</b><small>Unduh seluruh aset; geometri GeoJSON siap diimpor kembali.</small></div><i className="bi bi-download" /></button>
          </>}</div>
          <footer><button className="btn btn-light" onClick={() => setFileModal(null)}>Tutup</button></footer>
        </section>
      </div>}
    </>
  );
}
