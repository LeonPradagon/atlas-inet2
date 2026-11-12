import { DetailTable } from "../../components/DetailTable";

export type TerminationResults = {
  searchRadiusMeters: number;
  points: {
    id: string;
    name: string;
    type: string;
    latitude: number;
    longitude: number;
    distance: number;
    relatedDevices?: {
      id: string;
      name: string;
      kind: string;
      cableId: string;
    }[];
    cables: {
      id: string;
      name: string;
      recorded: boolean;
      distanceMeters: number;
      totalCores: number;
      used: number;
      booked: number;
      usedNumbers?: number[];
      bookedNumbers?: number[];
      verified: boolean;
      available: number[] | null;
      start: { name: string; distanceMeters: number } | null;
      end: { name: string; distanceMeters: number } | null;
    }[];
  }[];
};

export function uniqueTerminationCables(
  cables: TerminationResults["points"][number]["cables"]
) {
  const seen = new Set<string>();
  return cables.filter(({ id: _id, start, end, ...cable }) => {
    const endpoint = (value: typeof start) =>
      value && [value.name, value.distanceMeters];
    const key = JSON.stringify({
      ...cable,
      start: endpoint(start),
      end: endpoint(end),
    });
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function TerminationDetail({ data }: { data?: TerminationResults }) {
  if (!data) {
    return (
      <p className="text-secondary small mt-3">
        Data terminasi belum tersedia pada hasil ini. Jalankan analisis kembali.
      </p>
    );
  }
  return (
    <section
      aria-label="Terminasi di sekitar lokasi"
      className="mt-3 rounded border p-3"
    >
      <h4 className="h6">
        Terminasi sekitar · radius {data.searchRadiusMeters} m
      </h4>
      <p className="small text-secondary">
        Perkiraan ujung kabel berdasarkan posisi pada peta, bukan arah layanan.
        Sambungan fisik perlu diverifikasi.
      </p>
      {data.points.length === 0 && (
        <p className="small mb-0">
          Tidak ada terminasi yang dikenali dalam radius pencarian.
        </p>
      )}
      {data.points.length > 0 && (
        <details>
          <summary className="fw-semibold py-2">
            Lihat {data.points.length} terminasi ditemukan
          </summary>
          {data.points.map((point) => (
            <details className="border-top py-2" key={point.id}>
              <summary>
                <b>{point.name}</b> · {point.type} ·{" "}
                {Math.round(point.distance)} m
              </summary>
              <DetailTable
                className="mt-2"
                label={`Detail ${point.name}`}
                rows={[
                  {
                    label: "Koordinat",
                    value: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
                    valueClassName: "font-monospace",
                  },
                  ...(point.relatedDevices && point.relatedDevices.length > 0
                    ? [
                        {
                          label: "Perangkat melalui kabel tercatat",
                          value: point.relatedDevices
                            .map((device) => `${device.name} (${device.kind})`)
                            .join(", "),
                        },
                      ]
                    : []),
                ]}
              />
              {point.cables.length === 0 && (
                <small>
                  Belum ada kabel tercatat atau kandidat dalam 20 m.
                </small>
              )}
              {uniqueTerminationCables(point.cables).map((cable) => (
                <div className="border rounded p-2 mt-2 small" key={cable.id}>
                  <b className="d-block mb-1">{cable.name}</b>
                  <DetailTable
                    label={`Detail ${cable.name}`}
                    rows={[
                      {
                        label: "Relasi",
                        value: cable.recorded
                          ? "Relasi tercatat"
                          : `Kabel dekat pada peta · perlu verifikasi · ${Math.round(cable.distanceMeters)} m dari titik`,
                      },
                      {
                        label: "Total core",
                        value: cable.totalCores || "Belum diketahui",
                      },
                      {
                        label: "Terpakai",
                        value: `${cable.used} (nomor: ${cable.usedNumbers?.join(", ") || (cable.usedNumbers ? "—" : "jalankan analisis ulang")})`,
                      },
                      {
                        label: "Booked",
                        value: `${cable.booked} (nomor: ${cable.bookedNumbers?.join(", ") || (cable.bookedNumbers ? "—" : "jalankan analisis ulang")})`,
                      },
                      {
                        label: "Tersedia",
                        value:
                          cable.verified &&
                          cable.totalCores > 0 &&
                          cable.available
                            ? `${cable.available.length} (nomor: ${cable.available.join(", ") || "—"})`
                            : "Belum terverifikasi atau kapasitas belum diketahui",
                      },
                      {
                        label: "Titik terdekat dari awal kabel",
                        value: cable.start
                          ? `${cable.start.name} (${Math.round(cable.start.distanceMeters)} m)`
                          : "Belum diketahui",
                      },
                      {
                        label: "Titik terdekat dari ujung kabel",
                        value: cable.end
                          ? `${cable.end.name} (${Math.round(cable.end.distanceMeters)} m)`
                          : "Belum diketahui",
                      },
                    ]}
                  />
                </div>
              ))}
            </details>
          ))}
        </details>
      )}
    </section>
  );
}
