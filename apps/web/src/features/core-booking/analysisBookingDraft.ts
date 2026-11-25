export type AnalysisBookingDraft = {
  label: string;
  startId?: string;
  endId?: string;
  targetId?: string;
  cableIds: string[];
  cores: number;
  newCableMeters?: number;
  cableOnly?: boolean;
};

export function segmentBookingDraft(
  label: string,
  network?: {
    id?: string;
    geometry?: unknown;
    capacity?: { connectedCables?: { id: string }[] };
  } | null,
  sourceCableId?: string,
  nearbyTerminations?: {
    id: string;
    type: string;
    latitude: number;
    longitude: number;
  }[],
  proposedCables?: { distanceMeters: number }[]
): AnalysisBookingDraft | null {
  const newCableMeters = proposedCableMeters(proposedCables);
  if (!network?.id) {
    return newCableMeters > 0 ? { label, cableIds: [], cores: 1, newCableMeters, cableOnly: true } : null;
  }
  const coordinates =
    network.geometry &&
    typeof network.geometry === "object" &&
    "coordinates" in network.geometry &&
    Array.isArray(network.geometry.coordinates)
      ? network.geometry.coordinates
      : [];
  const [longitude, latitude] = coordinates.map(Number);
  const duplicateClosure = nearbyTerminations?.find((point) =>
    point.type === "Closure" &&
    point.id !== network.id &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(point.latitude - latitude) <= 0.000001 &&
    Math.abs(point.longitude - longitude) <= 0.000001
  );
  return {
    label,
    targetId: duplicateClosure?.id ?? network.id,
    cableIds: [...new Set([
      ...(sourceCableId ? [sourceCableId] : []),
      ...(network.capacity?.connectedCables?.map((cable) => cable.id) ?? []),
    ])],
    cores: 1,
    newCableMeters,
  };
}

export function prepareAnalysisBookings(drafts: AnalysisBookingDraft[]) {
  const key = crypto.randomUUID();
  sessionStorage.setItem(`atlas-booking-draft:${key}`, JSON.stringify(drafts));
  window.location.assign(`/booking-core?${new URLSearchParams({ draft: key })}`);
}

export function readAnalysisBookings(key: string): AnalysisBookingDraft[] {
  if (!key) return [];
  try {
    const entries = JSON.parse(sessionStorage.getItem(`atlas-booking-draft:${key}`) ?? "[]");
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

export function advanceAnalysisBookings(key: string, remaining: AnalysisBookingDraft[]) {
  if (remaining.length) sessionStorage.setItem(`atlas-booking-draft:${key}`, JSON.stringify(remaining));
  else sessionStorage.removeItem(`atlas-booking-draft:${key}`);
}

export function proposedCableMeters(cables: readonly { distanceMeters: number }[] = []) {
  return cables.reduce((sum, cable) => Number.isFinite(cable.distanceMeters) && cable.distanceMeters > 0 ? sum + cable.distanceMeters : sum, 0);
}
