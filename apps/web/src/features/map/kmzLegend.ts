const kmlShapes = "https://maps.google.com/mapfiles/kml/shapes";

type LegendRule = {
  name: string;
  category: string;
  color: string;
  size: number;
  opacity: number;
  labelSize: number;
  termination: string;
  folder: string;
  iconUrl?: string;
  aliases: string[];
  cores?: number[];
};

const point = (
  name: string,
  category: string,
  color: string,
  size: number,
  icon: string,
  aliases: string[],
  labelSize = 0,
  termination = "Bukan Terminasi"
): LegendRule => ({
  name,
  category,
  color,
  size,
  opacity: 1,
  labelSize,
  termination,
  folder: aliases[0] ?? name,
  iconUrl: `${kmlShapes}/${icon}.png`,
  aliases: [name, ...aliases],
});

const cableColors: Record<number, string> = {
  1: "#9000FF",
  2: "#9000FF",
  4: "#9000FF",
  6: "#9000FF",
  8: "#9000FF",
  12: "#964B00",
  24: "#FFA500",
  48: "#0000FF",
  96: "#FF0000",
  144: "#00FF00",
  288: "#000000",
  576: "#FFB8C4",
};
const capacities = Object.keys(cableColors).map(Number);

const cable = (
  route: "DISTRIBUTION" | "FEEDER" | "BACKBONE",
  label: string,
  width: number
): LegendRule[] => {
  const folderPrefix =
    route === "DISTRIBUTION" ? "DST" : route === "FEEDER" ? "FDR" : "BB";
  return [
    ...new Set(Object.values(cableColors)),
  ].map((color) => {
    const cores = capacities.filter((capacity) => cableColors[capacity] === color);
    const coreNames = cores.join(" / ");
    return {
      name: `Line ${label} ${coreNames} Core`,
      category: route,
      color,
      size: width,
      opacity: 1,
      labelSize: 0,
      termination: "Bukan Terminasi",
      folder: `Line ${label} ${coreNames} Core`,
      aliases: [
        `Line ${label} ${coreNames} Core`,
        ...cores.flatMap((core) => [
          `${folderPrefix}_${core}C`,
          `${folderPrefix}_${core} CORE`,
          `CABLE_${folderPrefix}_${core}C`,
        ]),
      ],
      cores,
    };
  });
};

// Fallback values mirror the supplied LEGEND KMZ ASSET workbook. A KMZ's own
// KML styles take precedence whenever they define the corresponding property.
export const kmzLegend: LegendRule[] = [
  point("Tiang 6 Meter (T6)", "POLE", "#FFF700", 0.5, "shaded_dot", ["T6"]),
  point("Tiang 7 Meter (T7)", "POLE", "#000000", 0.5, "shaded_dot", ["T7"]),
  point("Tiang 9 Meter (T9)", "POLE", "#0000FF", 0.5, "shaded_dot", ["T9"]),
  point("Tiang Listrik (TL)", "POLE", "#FFA500", 0.5, "shaded_dot", ["TL"]),
  point("Handhole (HH)", "HANDHOLE", "#08E8DE", 0.6, "square", ["HH"]),
  point("Manhole (MH)", "MANHOLE", "#00FF00", 0.6, "square", ["MH"]),
  {
    name: "HDPE",
    category: "HDPE",
    color: "#FFFFFF",
    size: 8,
    opacity: 0.5,
    labelSize: 0,
    termination: "Bukan Terminasi",
    folder: "HDPE",
    aliases: ["HDPE", "DUCT", "TRENCHLESS"],
  },
  point("ODP 4 Port", "ODP", "#964B00", 0.8, "triangle", ["SPL-1:4", "ODP_4"], 0, "Terminasi"),
  point("ODP 8 Port", "ODP", "#0000FF", 0.8, "triangle", ["SPL-1:8", "ODP_8"], 0, "Terminasi"),
  point("ODP 12 Port", "ODP", "#FF0000", 0.8, "triangle", ["SPL-1:12", "ODP_12"], 0, "Terminasi"),
  point("ODP 16 Port", "ODP", "#FFA500", 0.8, "triangle", ["SPL-1:16", "ODP_16"], 0, "Terminasi"),
  point("ODP 24 Port", "ODP", "#FF00FF", 0.8, "triangle", ["SPL-1:24", "ODP_24"], 0, "Terminasi"),
  point("ODP 32 Port", "ODP", "#00FF00", 0.8, "triangle", ["SPL-1:32", "ODP_32"], 0, "Terminasi"),
  point("ODP 48 Port", "ODP", "#08E8DE", 0.8, "polygon", ["SPL-1:48", "ODP_48"], 0, "Terminasi"),
  ...[
    [24, "#FFA500"], [48, "#FF0000"], [96, "#00FF00"],
    [144, "#08E8DE"], [288, "#000000"], [576, "#FFB8C4"],
  ].map(([capacity, color]) =>
    point(`ODC ${capacity}C`, "ODC", String(color), 1, "polygon", [`ODC_${capacity}C`, `FDT_${capacity}C`], 0.8, "Terminasi")
  ),
  ...[
    [12, "#0000FF"], [24, "#FFA500"], [48, "#9000FF"],
    [96, "#FF0000"], [144, "#00FF00"], [288, "#000000"],
  ].map(([capacity, color]) =>
    point(`Closure ${capacity}C`, "JC", String(color), 1, "forbidden", [`CS_${capacity}C`, `CLOSURE_${capacity}C`], 0.8, "Terminasi")
  ),
  point("Slack / Coil", "SLACK", "#FF0000", 1, "target", ["SLACK", "COIL"], 0, "Terminasi (Need Confirm)"),
  {
    name: "Line Drop (Distribusi 1/2 Core)",
    category: "DROP",
    color: "#9000FF",
    size: 1,
    opacity: 1,
    labelSize: 0,
    termination: "Bukan Terminasi",
    folder: "DROP",
    aliases: ["DROP", "DROP_CORE", "DROP CABLE", "LINE DROP"],
    cores: [1, 2],
  },
  ...cable("DISTRIBUTION", "Distribusi", 1),
  ...cable("FEEDER", "Feeder", 3),
  ...cable("BACKBONE", "Backbone", 4),
  ...[
    ["POP (Point of Presence)", "#FFFFFF", "arrow", "POP", "Bukan Terminasi"],
    ["Data Center", "#FF0000", "arrow", "DATA_CENTER", "Bukan Terminasi"],
    ["Rumah Kabel", "#00FF00", "arrow", "RK", "Terminasi"],
    ["OLT (Optical Line Terminal)", "#FFF700", "arrow", "OLT", "Terminasi"],
    ["OTB (Optical Termination Box)", "#9000FF", "arrow", "OTB", "Terminasi"],
    ["HUB", "#08E8DE", "arrow", "HUB", "Bukan Terminasi"],
    ["Shelter", "#0000FF", "arrow", "SHELTER", "Bukan Terminasi"],
    ["BTS / RBS", "#FFF700", "electronics", "BTS/RBS", "Bukan Terminasi"],
  ].map(([name, color, icon, alias, termination]) =>
    point(String(name), String(alias), String(color), 1, String(icon), [String(alias)], 1, String(termination))
  ),
];
