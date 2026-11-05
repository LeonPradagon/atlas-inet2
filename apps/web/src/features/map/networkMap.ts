import type { Feature, Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { api, type NetworkAsset } from "../../lib/api";
import { kmzLegend } from "./kmzLegend";

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

function getIconCategory(folderPath: unknown, assetName: unknown) {
  const folders = String(folderPath ?? "")
    .split("/")
    .filter(Boolean)
    .reverse();
  const name = String(assetName ?? "");
  const categories: [string, RegExp][] = [
    ["OTB", /(^|[^A-Z0-9])OTB(?=$|[^A-Z0-9]|\d)/iu],
    ["OLT", /(^|[^A-Z0-9])OLT(?=$|[^A-Z0-9]|\d)/iu],
    ["ODP", /(^|[^A-Z0-9])ODP(?=$|[^A-Z0-9]|\d)/iu],
    ["ODC", /(^|[^A-Z0-9])ODC(?=$|[^A-Z0-9]|\d)/iu],
    ["FDT", /(^|[^A-Z0-9])FDT(?=$|[^A-Z0-9]|\d)/iu],
    ["POLE", /(^|[^A-Z0-9])(?:POLE|PL|T6|T7|T9|TL)(?=$|[^A-Z0-9]|\d)/iu],
    ["JC", /(^|[^A-Z0-9])(?:JC|CLOSURE|JOINT\s*CLOSURE)(?=$|[^A-Z0-9]|\d)/iu],
    ["OFP", /(^|[^A-Z0-9])OFP(?=$|[^A-Z0-9]|\d)/iu],
    ["POP", /(^|[^A-Z0-9])POP(?=$|[^A-Z0-9]|\d)/iu],
    ["ODF", /(^|[^A-Z0-9])ODF(?=$|[^A-Z0-9]|\d)/iu],
    ["SLACK", /(^|[^A-Z0-9])SLACK(?=$|[^A-Z0-9]|\d)/iu],
    ["HANDHOLE", /(^|[^A-Z0-9])(?:HH|HANDHOLE)(?=$|[^A-Z0-9]|\d)/iu],
    ["MANHOLE", /(^|[^A-Z0-9])(?:MH|MANHOLE)(?=$|[^A-Z0-9]|\d)/iu],
    ["TERMINAL BOX", /(^|[^A-Z0-9])(?:TB|TERMINAL\s*BOX)(?=$|[^A-Z0-9]|\d)/iu],
  ];
  for (const folder of folders) {
    const category = categories.find(([, pattern]) => pattern.test(folder));
    if (category) {
      return category[0];
    }
  }
  for (const [category, pattern] of categories) {
    if (pattern.test(name)) {
      return category;
    }
  }
  return "LAINNYA";
}

export function assetIconCategory(asset: NetworkAsset) {
  const assetKind = String(asset.attributes?.assetKind ?? "").toUpperCase();
  const categories: Record<string, string> = {
    JOINT_CLOSURE: "JC",
    HANDHOLE: "HANDHOLE",
    MANHOLE: "MANHOLE",
    OTB: "OTB",
  };
  if (
    [
      "OLT",
      "ODC",
      "ODP",
      "POLE",
      "FDT",
      "OFP",
      "POP",
      "ODF",
      "SLACK",
      "OTB",
      "MANHOLE",
    ].includes(assetKind)
  ) {
    return assetKind;
  }
  return (
    categories[assetKind] ??
    getIconCategory(
      asset.attributes?.folderPath,
      asset.attributes?.name ?? asset.name
    )
  );
}

export function legendStyle(asset: NetworkAsset) {
  const normalize = (value: unknown) =>
    String(value ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/gu, "");
  const folders = String(asset.attributes?.folderPath ?? "")
    .split("/")
    .map((folder) => folder.trim())
    .reverse();
  const metadata = [
    asset.attributes?.Spesifikasi,
    asset.attributes?.Splitter,
    asset.attributes?.["Tipe Perangkat"],
    asset.attributes?.assetKind,
  ];
  let rule: (typeof kmzLegend)[number] | undefined;
  for (const value of [
    ...folders,
    ...metadata,
    asset.attributes?.name,
    asset.name,
  ]) {
    rule = kmzLegend.find(
      (entry) =>
        Boolean(entry.iconUrl) === (asset.assetType !== "segment") &&
        entry.folder !== "-" &&
        entry.folder
          .split("/")
          .some((folder) => normalize(folder) === normalize(value))
    );
    if (rule) {
      break;
    }
  }
  const text = [asset.name, ...folders, ...metadata].join(" ").toUpperCase();
  let category = assetIconCategory(asset);
  if (!rule) {
    if (
      asset.assetType === "segment" &&
      /BRENCH|BRANCH|PATCH.?CORD/u.test(text)
    ) {
      category = "BRANCH";
    } else if (asset.assetType === "segment" && /DROP/u.test(text)) {
      category = "DROP";
    } else if (
      asset.assetType === "segment" &&
      /HDPE|DUCT|TRENCHLESS/u.test(text)
    ) {
      category = "HDPE";
    } else if (
      asset.assetType === "segment" &&
      /BACKBONE|CABLE_BB/u.test(text)
    ) {
      category = "BACKBONE";
    } else if (
      asset.assetType === "segment" &&
      /FEEDER|CABLE_FDR/u.test(text)
    ) {
      category = "FEEDER";
    } else if (
      asset.assetType === "segment" &&
      /DISTRIB|CABLE_DST/u.test(text)
    ) {
      category = "DISTRIBUTION";
    }
    const capacity =
      asset.totalCores ||
      Number(
        text.match(
          /(?:^|[^0-9])(288|144|96|48|32|24|16|12|8)\s*(?:C(?:ORE)?S?|PORT)(?:$|[^A-Z])/iu
        )?.[1] ?? 0
      );
    const candidates = kmzLegend.filter((entry) => entry.category === category);
    rule =
      candidates.find(
        (entry) =>
          capacity > 0 && entry.name.match(/\d+/u)?.[0] === String(capacity)
      ) ?? (candidates.length === 1 ? candidates[0] : undefined);
  }
  const isLine = asset.assetType === "segment";
  return {
    category: rule?.category ?? category,
    color: rule?.color,
    size: rule?.size ?? 1,
    labelSize: rule?.labelSize ?? 0,
    cableLineWidth: isLine ? rule?.size : undefined,
    iconUrl: rule?.iconUrl,
    termination: rule?.termination ?? "Bukan Terminasi",
  };
}

const localKmzIcons = new Set([
  "paddle/P.png",
  "pushpin/ylw-pushpin.png",
  "shapes/arrow.png",
  "shapes/cross-hairs.png",
  "shapes/donut.png",
  "shapes/forbidden.png",
  "shapes/homegardenbusiness.png",
  "shapes/info-i.png",
  "shapes/placemark_circle.png",
  "shapes/placemark_square.png",
  "shapes/shaded_dot.png",
  "shapes/square.png",
  "shapes/target.png",
  "shapes/triangle.png",
]);

function mapGeometryParts(geometry: Geometry): Geometry[] {
  return geometry.type === "GeometryCollection"
    ? geometry.geometries.flatMap(mapGeometryParts)
    : [geometry];
}

export const assetFeatures = (
  items: NetworkAsset[]
): Feature<Geometry, Record<string, unknown>>[] =>
  items
    .reduce<Feature<Geometry, Record<string, unknown>>[]>((features, item) => {
      if (item.geometry) {
        const style = item.attributes?.__kmlStyle as ImportedStyle | undefined;
        const legend = legendStyle(item);
        const iconCategory = legend.category;
        const iconHref = style?.iconHref ?? legend.iconUrl;
        const kmzIcon = iconHref?.match(
          /^atlas-kmz-icon:([a-f0-9]{64})$/iu
        )?.[1];
        const localIcon = iconHref?.match(
          /^https?:\/\/maps\.google\.com\/mapfiles\/kml\/(.+)$/iu
        )?.[1];
        const iconUrl = kmzIcon
          ? iconHref
          : localIcon && localKmzIcons.has(localIcon)
            ? `/kml-icons/${localIcon}`
            : iconHref?.replace(/^http:\/\//iu, "https://");
        const iconLegendColor: Record<string, string> = {
          POLE: "#e8c300",
          POP: "#e8b500",
          OLT: "#2864d7",
          OTB: "#00bcd4",
          ODC: "#f28c28",
          ODP: "#8b4513",
          JC: "#f28c28",
          SLACK: "#e53935",
          HANDHOLE: "#ffffff",
          MANHOLE: "#202124",
        };
        const googlePushpin = /\/pushpin\/ylw-pushpin\.png(?:$|[?#])/iu.test(
          style?.iconHref ?? ""
        );
        const lineDescription = `${item.name} ${item.cableType} ${String(item.attributes?.routeType ?? "")}`;
        const routeType =
          item.attributes?.routeType ??
          (/backbone/iu.test(lineDescription)
            ? "BACKBONE"
            : /feeder/iu.test(lineDescription)
              ? "FEEDER"
              : /distrib/iu.test(lineDescription)
                ? "DISTRIBUTION"
                : /drop/iu.test(lineDescription)
                  ? "DROP"
                  : undefined);
        const coreMatch = lineDescription.match(
          /(?:^|\D)(12|24|48|96|144|288)\s*(?:core|c)?\b/iu
        );
        const legendColor: Record<string, string> = {
          "12": "#8b4513",
          "24": "#f28c28",
          "48": "#2864d7",
          "96": "#e53935",
          "144": "#22a447",
          "288": "#202124",
        };
        const inferredLineColor = coreMatch
          ? legendColor[coreMatch[1]]
          : routeType === "DROP"
            ? "#8e44ad"
            : undefined;
        features.push({
          type: "Feature",
          id: item.id,
          properties: {
            id: item.id,
            name: item.name,
            area: item.area,
            ...Object.fromEntries(
              Object.entries(item.attributes ?? {}).filter(
                ([, value]) =>
                  value == null ||
                  ["string", "number", "boolean"].includes(typeof value)
              )
            ),
            source: item.source,
            assetType: item.assetType,
            totalCores: item.totalCores,
            usedCores: item.usedCores,
            bookedCores: item.bookedCores,
            idleCores: item.idleCores,
            imported: item.source !== "managed",
            geometryType: item.geometry.type,
            iconCategory,
            legendLabelSize:
              style?.labelScale ?? (style?.iconHref ? 1 : legend.labelSize),
            sourceLabel: item.attributes?.name ?? item.name,
            labelColor:
              style?.labelColor ??
              (item.source === "kml" ? "#ffffff" : "#17356f"),
            labelOpacity: style?.labelOpacity ?? 1,
            legendTermination: legend.termination,
            legendIconScale: style?.iconScale ?? legend.size,
            atlasIconId: [
              "OLT",
              "OTB",
              "ODC",
              "ODP",
              "POLE",
              "JC",
              "HANDHOLE",
              "MANHOLE",
              "FDT",
              "OFP",
              "POP",
              "ODF",
              "SLACK",
              "TERMINAL BOX",
            ].includes(iconCategory)
              ? `atlas-icon-${iconCategory.toLowerCase().replace(/\s+/gu, "-")}`
              : "",
            routeType,
            lineColor:
              style?.lineColor ??
              (legend.cableLineWidth ? legend.color : undefined) ??
              inferredLineColor ??
              String(
                item.attributes?.lineColor ??
                  (routeType === "FEEDER"
                    ? "#ff0000"
                    : routeType === "DISTRIBUTION"
                      ? "#a000ff"
                      : item.source === "kml"
                        ? "#ffffff"
                        : "#3454d1")
              ),
            lineOpacity: style?.lineOpacity ?? 1,
            lineWidth:
              style?.lineWidth ??
              legend.cableLineWidth ??
              (routeType === "BACKBONE"
                ? 5
                : routeType === "FEEDER"
                  ? 4
                  : routeType === "DISTRIBUTION"
                    ? 3
                    : routeType === "DROP"
                      ? 2
                      : item.source === "kml"
                        ? 1
                        : 3),
            fillColor:
              style?.fillColor ??
              (item.source === "kml" ? "#ffffff" : "#3454d1"),
            fillOpacity:
              style?.fillOpacity ?? (item.source === "kml" ? 1 : 0.25),
            fillEnabled: style?.fillEnabled ?? item.source === "kml",
            outlineEnabled:
              style?.outlineEnabled ??
              ((item.geometry.type !== "Polygon" &&
                item.geometry.type !== "MultiPolygon") ||
                item.source === "kml"),
            iconColor: style?.iconColor ?? "#ffffff",
            markerColor:
              style?.iconColor ??
              (
                {
                  OLT: "#2864d7",
                  OTB: "#00bcd4",
                  ODC: "#f28c28",
                  ODP: "#8b4513",
                  POLE: "#e8c300",
                  JC: "#f28c28",
                  HANDHOLE: "#fff",
                  MANHOLE: "#202124",
                } as Record<string, string>
              )[iconCategory] ??
              "#3454d1",
            isManagedFtth: item.attributes?.source === "ftth-design",
            iconOpacity: style?.iconOpacity ?? 1,
            iconScale: style?.iconScale ?? 1,
            iconAnchor:
              style?.iconAnchor ?? (googlePushpin ? "bottom-right" : "center"),
            iconOffset:
              style?.iconOffset ?? (googlePushpin ? [12 / 32, 2 / 32] : [0, 0]),
            iconImageId: kmzIcon
              ? `kmz-${kmzIcon}-${(style?.iconColor ?? "#ffffff").slice(1)}`
              : iconUrl
                ? `kml-${hashIconReference(iconUrl)}-${(style?.iconColor ?? "#ffffff").slice(1)}`
                : "",
            iconHref: iconUrl ?? "",
            fallbackIconImageId: legend.iconUrl
              ? `legend-${hashIconReference(legend.iconUrl)}-${(legend.color ?? "#ffffff").slice(1)}`
              : "",
            fallbackIconHref:
              legend.iconUrl?.replace(
                "https://maps.google.com/mapfiles/kml/",
                "/kml-icons/"
              ) ?? "",
            fallbackIconTint: legend.color ?? "#ffffff",
            iconTint:
              style?.iconColor ??
              (style?.iconHref
                ? "#ffffff"
                : (legend.color ?? iconLegendColor[iconCategory] ?? "#ffffff")),
          },
          geometry: item.geometry,
        });
      }
      return features;
    }, [])
    .flatMap((feature) =>
      mapGeometryParts(feature.geometry).map((geometry) => ({
        ...feature,
        geometry,
        properties: { ...feature.properties, geometryType: geometry.type },
      }))
    );

export function addAtlasMapIcons(map: MapLibreMap) {
  const icons: Record<string, string> = {
    OLT: "#2864d7",
    OTB: "#00bcd4",
    ODC: "#f28c28",
    ODP: "#8b4513",
    POLE: "#e8c300",
    JC: "#f28c28",
    HANDHOLE: "#fff",
    MANHOLE: "#202124",
    FDT: "#e75b3c",
    OFP: "#178c80",
    POP: "#e8b500",
    ODF: "#684fc7",
    SLACK: "#e53935",
    "TERMINAL BOX": "#3280c8",
  };
  for (const [category, color] of Object.entries(icons)) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) {
      continue;
    }
    context.scale(2, 2);
    if (category === "ODC") {
      context.fillStyle = color;
      context.strokeStyle = "#fff";
      context.lineWidth = 2;
      context.fillRect(6, 6, 20, 20);
      context.strokeRect(6, 6, 20, 20);
    } else if (category === "ODP") {
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(16, 4);
      context.lineTo(28, 27);
      context.lineTo(4, 27);
      context.closePath();
      context.fill();
      context.globalCompositeOperation = "destination-out";
      context.beginPath();
      context.arc(16, 19, 3.5, 0, 2 * Math.PI);
      context.fill();
      context.globalCompositeOperation = "source-over";
    } else if (category === "OLT") {
      context.fillStyle = "#fff";
      context.strokeStyle = "#d9a400";
      context.lineWidth = 1.5;
      context.beginPath();
      context.roundRect(5, 7, 22, 20, 2);
      context.fill();
      context.stroke();
      for (const y of [12, 18, 24]) {
        context.fillStyle = "#e8b500";
        context.fillRect(8, y - 1, 16, 3);
        context.fillStyle = "#fff";
        context.fillRect(10, y, 2, 1);
      }
    } else if (category === "POLE") {
      context.strokeStyle = color;
      context.fillStyle = color;
      context.lineWidth = 2.5;
      context.beginPath();
      context.moveTo(16, 4);
      context.lineTo(16, 29);
      context.moveTo(8, 10);
      context.lineTo(24, 10);
      context.moveTo(10, 15);
      context.lineTo(22, 15);
      context.moveTo(13, 7);
      context.lineTo(13, 11);
      context.moveTo(19, 7);
      context.lineTo(19, 11);
      context.stroke();
      context.beginPath();
      context.moveTo(11, 29);
      context.lineTo(21, 29);
      context.stroke();
    } else if (category === "JC" || category === "HANDHOLE") {
      context.beginPath();
      context.roundRect(3, 5, 26, 22, 5);
      context.fill();
      context.stroke();
      context.fillStyle = "#fff";
      context.font = "bold 8px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(category === "JC" ? "JC" : "HH", 16, 16);
    } else {
      context.beginPath();
      context.arc(16, 16, 14, 0, 2 * Math.PI);
      context.fill();
      context.stroke();
      context.fillStyle = "#fff";
      context.font = "bold 8px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(
        category === "TERMINAL BOX" ? "TB" : category,
        16,
        17,
        26
      );
    }
    map.addImage(
      `atlas-icon-${category.toLowerCase().replace(/\s+/gu, "-")}`,
      context.getImageData(0, 0, 64, 64),
      { pixelRatio: 2 }
    );
  }
}

function hashIconReference(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a XOR step
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: unsigned 32-bit result
  return (hash >>> 0).toString(16);
}

function tintKmlIcon(source: HTMLImageElement | ImageBitmap, color?: string) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return source;
  }
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

export function cableLengthMeters(geometry: Geometry | null): number | null {
  if (!geometry) {
    return null;
  }
  const lines: number[][][] = [];
  const collect = (item: Geometry) => {
    if (item.type === "LineString") {
      lines.push(item.coordinates as number[][]);
    } else if (item.type === "MultiLineString") {
      lines.push(...(item.coordinates as number[][][]));
    } else if (item.type === "GeometryCollection") {
      item.geometries.forEach(collect);
    }
  };
  collect(geometry);
  if (!lines.length) {
    return null;
  }
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  return lines.reduce(
    (total, line) =>
      total +
      line.slice(1).reduce((length, point, index) => {
        const [lon1, lat1] = line[index];
        const [lon2, lat2] = point;
        const dLat = radians(lat2 - lat1);
        const dLon = radians(lon2 - lon1);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(radians(lat1)) *
            Math.cos(radians(lat2)) *
            Math.sin(dLon / 2) ** 2;
        return (
          length + 6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
        );
      }, 0),
    0
  );
}

export function loadNetworkMapIcons(
  instance: MapLibreMap,
  features: Feature<Geometry, Record<string, unknown>>[],
  onComplete?: () => void
) {
  let active = true;
  const icons = new Map<string, { url: string; color: string }>();

  for (const feature of features) {
    const fallbackId = String(feature.properties?.fallbackIconImageId ?? "");
    const fallbackUrl = String(feature.properties?.fallbackIconHref ?? "");
    if (fallbackId && fallbackUrl) {
      icons.set(fallbackId, {
        url: fallbackUrl,
        color: String(feature.properties?.fallbackIconTint ?? "#ffffff"),
      });
    }
    const id = String(feature.properties?.iconImageId ?? "");
    const url = String(feature.properties?.iconHref ?? "");
    if (id && url) {
      icons.set(id, {
        url,
        color: String(feature.properties?.iconTint ?? "#ffffff"),
      });
    }
  }
  let remaining = [...icons.keys()].filter((id) => !instance.hasImage(id)).length;
  let completed = false;
  const complete = () => {
    if (completed) {
      return;
    }
    completed = true;
    onComplete?.();
  };
  const settle = () => {
    remaining -= 1;
    if (remaining === 0) {
      complete();
    }
  };
  if (remaining === 0) {
    complete();
  }
  const addLoadedIcon = (
    id: string,
    data: HTMLImageElement | ImageBitmap | ImageData,
    color: string
  ) => {
    if (!active || instance.hasImage(id)) {
      return;
    }
    let image: HTMLImageElement | ImageBitmap | ImageData = data;
    if (!(data instanceof ImageData)) {
      try {
        image = tintKmlIcon(data, color);
      } catch {
        /* use the original Google Earth icon if canvas tinting is blocked */
      }
    }
    instance.addImage(id, image, {
      pixelRatio: Math.max(0.5, Math.max(data.width, data.height) / 32),
    });
  };
  for (const [id, { url, color }] of icons) {
    if (instance.hasImage(id)) {
      continue;
    }
    if (url.startsWith("atlas-kmz-icon:")) {
      const iconId = url.slice("atlas-kmz-icon:".length);
      void api<{ mimeType: string; data: string }>(
        `/assets/kml-icons/${iconId}`
      )
        .then(async ({ mimeType, data }) => {
          const binary = Uint8Array.from(atob(data), (character) =>
            character.charCodeAt(0)
          );
          const image = await createImageBitmap(
            new Blob([binary], { type: mimeType })
          );
          addLoadedIcon(id, image, color);
        })
        .catch(() => undefined)
        .finally(settle);
    } else {
      void instance
        .loadImage(url)
        .then(({ data }) => addLoadedIcon(id, data, color))
        .catch(() => undefined)
        .finally(settle);
    }
  }

  return () => {
    active = false;
    complete();
  };
}
