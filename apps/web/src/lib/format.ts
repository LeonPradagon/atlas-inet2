export function formatDistance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "Belum tersedia";
  return value >= 1000
    ? `${(value / 1000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} km`
    : `${Math.round(value).toLocaleString("id-ID")} m`;
}

export function formatCoordinates(latitude: number, longitude: number) {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}
