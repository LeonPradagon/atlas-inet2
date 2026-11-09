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
