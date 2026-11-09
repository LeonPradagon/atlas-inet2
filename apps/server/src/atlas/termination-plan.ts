type Coordinate = [number, number];
type Line = { type: "LineString"; coordinates: Coordinate[] };

export type CoreRequirement = {
  services: number;
  reserve: number;
  assumed?: boolean;
};
const CABLE_CAPACITIES = [12, 24, 48, 96, 144, 288];
export type SourceCable = {
  id: string;
  name: string;
  coreNumber: number | null;
  coreNumbers: number[];
  totalCores: number | null;
  verified: boolean;
  recorded: boolean;
};
export function buildTerminationPlan(
  targetId: string,
  geometry: Line,
  distanceMeters: number,
  requirement?: CoreRequirement,
  sourceCable?: SourceCable | null
) {
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    throw new Error("Invalid route geometry");
  }
  const requiredCores = requirement
    ? requirement.services + requirement.reserve
    : null;
  const capacity =
    requiredCores === null
      ? null
      : requirement?.assumed
        ? sourceCable?.totalCores &&
          CABLE_CAPACITIES.includes(sourceCable.totalCores)
          ? sourceCable.totalCores
          : null
        : (CABLE_CAPACITIES.find((value) => value >= requiredCores) ?? null);
  const capacityBasis = requirement?.assumed
    ? capacity === null
      ? "SOURCE_UNKNOWN"
      : sourceCable?.verified && sourceCable.recorded
        ? "VERIFIED_SOURCE"
        : "UNVERIFIED_SOURCE"
    : requiredCores === null
      ? "DEMAND_UNKNOWN"
      : "EXPLICIT_DEMAND";
  return {
    cables: [{ cores: capacity, distanceMeters, geometry, type: "Drop" }],
    capacityBasis,
    points: [],
    requirement: requirement
      ? {
          assumed: requirement.assumed === true,
          requiredCores,
          reserve: requirement.reserve,
          services: requirement.services,
        }
      : null,
    targetId,
  };
}

export function recommendSourceCable(
  cables: {
    id: string;
    name: string;
    recorded: boolean;
    verified: boolean;
    available: number[] | null;
    totalCores?: number | null;
    distanceMeters?: number;
  }[],
  requiredCores = 1
) {
  const eligible = cables
    .filter(
      (cable) =>
        (cable.recorded ||
          (Number.isFinite(cable.distanceMeters) &&
            cable.distanceMeters! <= 20)) &&
        (cable.totalCores ?? 0) >= requiredCores &&
        (!cable.verified || (cable.available?.length ?? 0) >= requiredCores)
    )
    .sort(
      (a, b) =>
        Number(!CABLE_CAPACITIES.includes(a.totalCores ?? 0)) -
          Number(!CABLE_CAPACITIES.includes(b.totalCores ?? 0)) ||
        Number(!a.recorded) - Number(!b.recorded) ||
        Number(!a.verified) - Number(!b.verified) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id)
    );
  const selected = eligible[0];
  if (!selected) {
    return null;
  }
  const coreNumbers = selected.verified
    ? selected.available!.slice(0, requiredCores)
    : [];
  return {
    coreNumber: coreNumbers[0] ?? null,
    coreNumbers,
    id: selected.id,
    name: selected.name,
    recorded: selected.recorded === true,
    totalCores: selected.totalCores ?? null,
    verified: selected.verified === true,
  };
}
