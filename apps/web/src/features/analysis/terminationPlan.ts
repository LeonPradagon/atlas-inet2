import type { LineString } from "geojson";

export type TerminationPlan = {
  targetId: string;
  capacityBasis?:
    | "VERIFIED_SOURCE"
    | "UNVERIFIED_SOURCE"
    | "SOURCE_UNKNOWN"
    | "DEMAND_UNKNOWN"
    | "EXPLICIT_DEMAND";
  requirement?: {
    services: number;
    reserve: number;
    requiredCores: number;
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
  const numbers = (
    source.coreNumbers ??
    (source.coreNumber === null ? [] : [source.coreNumber])
  ).filter((number): number is number => typeof number === "number");
  if (plan.requirement && !plan.requirement.assumed && numbers.length) {
    return `${source.name} · ${relation}core ${numbers.join(", ")} (belum dibooking)`;
  }
  return `${source.name} · ${relation}${source.availableCount == null ? "" : `${source.availableCount} core tersedia tercatat saat analisis · `}nomor core belum dipilih`;
}
