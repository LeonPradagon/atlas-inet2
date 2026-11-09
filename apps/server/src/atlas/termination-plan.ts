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
  availableCount: number | null;
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
  sourceCable?: SourceCable | null,
  targetType?: string
) {
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    throw new Error("Invalid route geometry");
  }
  const requiredCores = requirement
    ? requirement.services + requirement.reserve
    : null;
  const useSourceCapacity = !requirement || requirement.assumed === true;
  const capacity = useSourceCapacity
    ? sourceCable?.totalCores &&
      CABLE_CAPACITIES.includes(sourceCable.totalCores)
      ? sourceCable.totalCores
      : null
    : (CABLE_CAPACITIES.find((value) => value >= requiredCores!) ?? null);
  const capacityBasis = useSourceCapacity
    ? capacity === null
      ? "SOURCE_UNKNOWN"
      : sourceCable?.verified && sourceCable.recorded
        ? "VERIFIED_SOURCE"
        : "UNVERIFIED_SOURCE"
    : "EXPLICIT_DEMAND";
  return {
    cables: [
      {
        cores: capacity,
        distanceMeters,
        geometry,
        type: targetType === "ODP" || !targetType ? "Drop" : "Distribusi",
      },
    ],
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
  requiredCores?: number
) {
  const minimumCores = requiredCores ?? 1;
  const eligible = cables
    .filter(
      (cable) =>
        (cable.recorded ||
          (Number.isFinite(cable.distanceMeters) &&
            cable.distanceMeters! <= 20)) &&
        (cable.totalCores ?? 0) >= minimumCores &&
        (!cable.verified || (cable.available?.length ?? 0) >= minimumCores)
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
  const coreNumbers =
    selected.verified && requiredCores !== undefined
      ? selected.available!.slice(0, requiredCores)
      : [];
  return {
    availableCount: selected.verified
      ? (selected.available?.length ?? 0)
      : null,
    coreNumber: coreNumbers[0] ?? null,
    coreNumbers,
    id: selected.id,
    name: selected.name,
    recorded: selected.recorded === true,
    totalCores: selected.totalCores ?? null,
    verified: selected.verified === true,
  };
}

// Candidates describe possible functions at recorded assets, not a confirmed need to install equipment.
export function recommendDeviceCandidates(
  evidence: {
    type: string;
    name: string;
    latitude: number;
    longitude: number;
  }[],
  ends: {
    cableId: string;
    cableName: string;
    latitude: number;
    longitude: number;
  }[],
  incomplete: boolean
) {
  if (incomplete) {
    return [];
  }
  const near = (
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number }
  ) =>
    Math.hypot(
      (a.latitude - b.latitude) * 111_320,
      (a.longitude - b.longitude) *
        111_320 *
        Math.cos((a.latitude * Math.PI) / 180)
    ) <= 20;
  const result: {
    kind: string;
    latitude: number;
    longitude: number;
    reason: string;
  }[] = [];
  const add = (
    kind: string,
    at: { latitude: number; longitude: number },
    reason: string
  ) => {
    if (
      !evidence.some((point) => point.type === kind && near(point, at)) &&
      !result.some((point) => point.kind === kind && near(point, at))
    ) {
      result.push({
        kind,
        latitude: at.latitude,
        longitude: at.longitude,
        reason,
      });
    }
  };
  for (const point of evidence) {
    if (point.type === "POP") {
      add(
        "OLT",
        point,
        `POP ${point.name} berada dekat jalur dan OLT tidak ditemukan pada data jalur yang dibaca. Opsi hanya jika POP memerlukan perangkat akses baru.`
      );
    }
    if (point.type === "OLT") {
      add(
        "OTB",
        point,
        `OLT ${point.name} berada dekat jalur dan OTB tidak ditemukan pada data jalur yang dibaca. Opsi hanya jika diperlukan terminasi kabel optik.`
      );
    }
    if (point.type === "Closure") {
      add(
        "Slack / Coil",
        point,
        `Closure ${point.name} berada dekat jalur dan slack/coil tidak ditemukan pada data jalur yang dibaca. Opsi hanya jika diperlukan cadangan kabel.`
      );
    }
  }
  for (const point of ends) {
    if (
      new Set(
        ends.filter((other) => near(point, other)).map((other) => other.cableId)
      ).size >= 2
    ) {
      add(
        "ODC",
        point,
        "Ujung beberapa kabel terdata berdekatan di jalur. ODC adalah opsi jika titik ini memang direncanakan sebagai pusat distribusi, bukan otomatis diperlukan."
      );
    }
  }
  return result;
}

// Project onto the proposed line; proximity is retained as evidence, not a physical connection.
export function placeAlongRoute<
  T extends { latitude: number; longitude: number },
>(points: T[], geometry: Line) {
  const coords = geometry.coordinates;
  if (coords.length < 2) {
    return [];
  }
  const scaleY = 111_320;
  const scaleX = scaleY * Math.cos((coords[0][1] * Math.PI) / 180);
  const lengths = coords
    .slice(1)
    .map((p, i) =>
      Math.hypot((p[0] - coords[i][0]) * scaleX, (p[1] - coords[i][1]) * scaleY)
    );
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return points.flatMap((point) => {
    let before = 0;
    let best:
      | {
          longitude: number;
          latitude: number;
          distanceToEvidenceMeters: number;
          along: number;
        }
      | undefined;
    for (let i = 0; i < lengths.length; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const dx = (b[0] - a[0]) * scaleX;
      const dy = (b[1] - a[1]) * scaleY;
      const px = (point.longitude - a[0]) * scaleX;
      const py = (point.latitude - a[1]) * scaleY;
      const t = lengths[i]
        ? Math.max(0, Math.min(1, (px * dx + py * dy) / lengths[i] ** 2))
        : 0;
      const distance = Math.hypot(px - t * dx, py - t * dy);
      if (!best || distance < best.distanceToEvidenceMeters) {
        best = {
          along: before + t * lengths[i],
          distanceToEvidenceMeters: distance,
          latitude: a[1] + t * (b[1] - a[1]),
          longitude: a[0] + t * (b[0] - a[0]),
        };
      }
      before += lengths[i];
    }
    if (!best || best.along <= 20 || total - best.along <= 20) {
      return [];
    }
    return [
      {
        ...point,
        distanceToEvidenceMeters: best.distanceToEvidenceMeters,
        latitude: best.latitude,
        longitude: best.longitude,
      },
    ];
  });
}

// A midpoint is an editable planning placeholder, not a prescribed installation spacing.
export function initialSlackCandidate(
  geometry: Line,
  evidence: { type: string; longitude: number; latitude: number }[]
) {
  const coords = geometry.coordinates;
  if (coords.length < 2) {
    return null;
  }
  const scaleY = 111_320;
  const scaleX = scaleY * Math.cos((coords[0][1] * Math.PI) / 180);
  const lengths = coords
    .slice(1)
    .map((p, i) =>
      Math.hypot((p[0] - coords[i][0]) * scaleX, (p[1] - coords[i][1]) * scaleY)
    );
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= 40) {
    return null;
  }
  let left = total / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] && lengths[i] > 0) {
      const t = left / lengths[i];
      const longitude = coords[i][0] + t * (coords[i + 1][0] - coords[i][0]);
      const latitude = coords[i][1] + t * (coords[i + 1][1] - coords[i][1]);
      if (
        evidence.some(
          (point) =>
            point.type === "Slack / Coil" &&
            Math.hypot(
              (point.longitude - longitude) * scaleX,
              (point.latitude - latitude) * scaleY
            ) <= 20
        )
      ) {
        return null;
      }
      return {
        basis: "PLANNING" as const,
        kind: "Slack / Coil",
        latitude,
        longitude,
        reason:
          "Opsi cadangan kabel untuk pemeliharaan. Titik tengah jalur dipakai sebagai posisi awal perencanaan, bukan ketentuan jarak pemasangan. Kebutuhan, lokasi, dan panjang cadangan belum ditentukan.",
      };
    }
    left -= lengths[i];
  }
  return null;
}
