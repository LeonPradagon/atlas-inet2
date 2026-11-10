import type { LineString } from "geojson";

export type TerminationPlan = {
  targetId: string;
  odpDemands?: Record<string, number>;
  terminationPatterns?: { type: string; sampleSize: number; medianMeters: number }[] | null;
  capacityBasis?:
    | "VERIFIED_SOURCE"
    | "UNVERIFIED_SOURCE"
    | "SOURCE_UNKNOWN"
    | "DEMAND_UNKNOWN"
    | "EXPLICIT_DEMAND";
  requirement?: {
    services: number;
    reserve: number;
    requiredCores: number | null;
    assumed?: boolean;
  } | null;
  upstreamRecommendation?: {
    id: string;
    name: string;
    type: string;
    recordedCables: number;
  } | null;
  deviceCandidates?: {
    kind: string;
    latitude: number;
    longitude: number;
    reason: string;
    distanceToEvidenceMeters?: number;
    basis?: "PLANNING";
  }[];
  deviceRecommendation?: {
    kind: "REUSE_ODP" | "ODP_PORT_UNKNOWN" | "NEW_ODP";
    name: string;
    relatedDevices: {
      id: string;
      name: string;
      kind: string;
      cableId: string;
    }[];
  };
  connectionCandidatesIncomplete?: boolean;
  connectionCandidates?: {
    cableId: string;
    cableName: string;
    recommendedKind?: "Closure";
    longitude: number;
    latitude: number;
    distanceMeters: number;
  }[];
  routeEvidenceIncomplete?: boolean;
  routeEvidence?: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    distanceToRouteMeters: number;
    recordedCables: number;
  }[];
  sourceCable?: {
    id: string;
    name: string;
    availableCount?: number | null;
    coreNumber: number | null;
    coreNumbers?: number[];
    totalCores?: number | null;
    verified?: boolean;
    recorded?: boolean;
  } | null;
  points: { kind: string; longitude: number; latitude: number }[];
  cables: {
    type: string;
    cores: number | null;
    geometry: LineString;
    distanceMeters: number;
  }[];
};

export function candidateName(point: { kind: string; basis?: "PLANNING" }, index: number): string {
  return `${point.basis === "PLANNING" ? "Simulasi" : "Opsi"} ${point.kind} ${String(index + 1).padStart(2, "0")}`;
}

export function cableName(index: number): string {
  return `Kabel ${String(index + 1).padStart(2, "0")}`;
}

export function connectionName(index: number): string {
  return `Potensi sambungan ${String(index + 1).padStart(2, "0")}`;
}

export function describeSourceCable(plan: TerminationPlan): string {
  const source = plan.sourceCable;
  if (!source) {
    return "Belum dapat ditentukan; kabel tercatat atau kandidat dekat dengan kapasitas sesuai belum ditemukan";
  }
  const relation =
    source.recorded === false
      ? "kandidat dekat tujuan, relasi belum tercatat · "
      : "";
  if (source.verified === false) {
    return `${source.name} · ${relation}pemakaian core belum terverifikasi`;
  }
  return `${source.name} · ${relation}${source.availableCount == null ? "" : `${source.availableCount} core tersedia tercatat saat analisis · `}nomor core belum dipilih`;
}

export function describeCableEndpoints(plan: TerminationPlan, networkName?: string): { from: string; to: string } {
  if (plan.cables.length !== 1) return { from: "Belum ditentukan", to: "Belum ditentukan" };
  const from = plan.upstreamRecommendation?.name ?? networkName ?? "Terminasi sumber belum ditentukan";
  const to = plan.deviceRecommendation?.kind === "NEW_ODP"
    ? "Usulan ODP pelanggan"
    : plan.deviceRecommendation?.kind === "REUSE_ODP" || plan.deviceRecommendation?.kind === "ODP_PORT_UNKNOWN"
      ? "Lokasi pelanggan"
      : "Tujuan belum ditentukan";
  return { from, to };
}

// The route is stored from customer to source; each simulated ODP plans one input core.
export function describeCableSpans(plan: TerminationPlan, networkName?: string) {
  if (plan.cables.length !== 1) return [];
  const cable = plan.cables[0];
  const coords = cable.geometry.coordinates;
  if (coords.length < 2) return [];
  const sy = 111_320;
  const sx = sy * Math.cos((coords[0][1] * Math.PI) / 180);
  const lengths = coords.slice(1).map((p, i) => Math.hypot((p[0] - coords[i][0]) * sx, (p[1] - coords[i][1]) * sy));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (!total) return [];
  const points = (plan.deviceCandidates ?? []).filter((p) => p.kind !== "Tiang");
  const stops: { along: number; name: string; coordinate: number[] }[] = [];
  for (const [index, point] of points.entries()) {
    if (point.kind !== "ODP" || point.basis !== "PLANNING") continue;
    let before = 0;
    let best: { along: number; distance: number; coordinate: number[] } | null = null;
    for (let i = 0; i < lengths.length; i++) {
      const [x, y] = coords[i];
      const dx = (coords[i + 1][0] - x) * sx, dy = (coords[i + 1][1] - y) * sy;
      const px = (point.longitude - x) * sx, py = (point.latitude - y) * sy;
      const t = lengths[i] ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengths[i] ** 2)) : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (!best || distance < best.distance) best = { along: before + t * lengths[i], distance, coordinate: [x + t * (coords[i + 1][0] - x), y + t * (coords[i + 1][1] - y)] };
      before += lengths[i];
    }
    if (best && best.distance <= 2 && best.along > 0.5 && total - best.along > 0.5) stops.push({ along: best.along, coordinate: best.coordinate, name: candidateName(point, index) });
  }
  stops.sort((a, b) => a.along - b.along);
  const uniqueStops = stops.filter((point, i) => i === 0 || point.along - stops[i - 1].along > 0.5);
  const endpoints = describeCableEndpoints(plan, networkName);
  const boundaries = [{ along: 0, coordinate: coords[0], name: endpoints.to }, ...uniqueStops, { along: total, coordinate: coords[coords.length - 1], name: endpoints.from }];
  const spans = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const a = boundaries[i], b = boundaries[i + 1];
    const interior: number[][] = [];
    let along = 0;
    for (let j = 0; j < lengths.length; j++) {
      along += lengths[j];
      if (along > a.along && along < b.along) interior.push(coords[j + 1]);
    }
    spans.push({ from: b.name, to: a.name, distanceMeters: cable.distanceMeters * (b.along - a.along) / total, geometry: { type: "LineString" as const, coordinates: [a.coordinate, ...interior, b.coordinate].reverse() } });
  }
  const targetOdp = plan.deviceRecommendation?.kind === "NEW_ODP" ? 1 : 0;
  return spans.reverse().map((span, index) => ({ ...span, requiredCores: Math.max(0, uniqueStops.length - index) + targetOdp, name: `Ruas ${String(index + 1).padStart(2, "0")}` }));
}

export function describeNodeCableRows(plan: TerminationPlan, name: string, networkName?: string): [string, string][] {
  const spans = describeCableSpans(plan, networkName);
  const incoming = spans.find((span) => span.to === name);
  const outgoing = spans.find((span) => span.from === name);
  if (!incoming && !outgoing) return [];
  const rows: [string, string][] = [];
  if (incoming) rows.push(["Ruas masuk", `${incoming.name}: ${incoming.from} → ${name} · ${Math.round(incoming.distanceMeters)} m`]);
  if (outgoing) rows.push(["Ruas keluar", `${outgoing.name}: ${name} → ${outgoing.to} · ${Math.round(outgoing.distanceMeters)} m`]);
  const cable = plan.cables[0];
  rows.push(["Kabel usulan", `${cableName(0)} · ${cable.type} · ${cable.cores == null ? "kapasitas belum ditentukan" : `${cable.cores} core`}`]);
  if (incoming) rows.push(["Core rencana ruas masuk", `${incoming.requiredCores} core`]);
  if (outgoing) rows.push(["Core rencana ruas keluar", `${outgoing.requiredCores} core`]);
  rows.push(["Catatan ruas", "Port ODP dan core kabel berbeda. Titik dan sambungan ini masih simulasi."]);
  return rows;
}
