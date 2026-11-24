export type AnalysisBookingDraft = {
  label: string;
  startId?: string;
  endId?: string;
  targetId?: string;
  cableIds: string[];
  cores: number;
};

export function segmentBookingDraft(
  label: string,
  network?: { id?: string; capacity?: { connectedCables?: { id: string }[] } } | null,
  cores?: number | null
): AnalysisBookingDraft | null {
  if (!network?.id) return null;
  return {
    label,
    targetId: network.id,
    cableIds: network.capacity?.connectedCables?.map((cable) => cable.id) ?? [],
    cores: Number.isInteger(cores) && cores && cores > 0 && cores <= 4096 ? cores : 1,
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
