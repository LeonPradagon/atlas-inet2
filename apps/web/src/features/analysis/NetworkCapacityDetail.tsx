export type NetworkCapacity = {
  recommendation?: string;
  recommendationReason?: string;
  deviceType: string;
  totalCores: number | null;
  usedCores: number;
  bookedCores: number;
  availableCores: number;
  usageVerified: boolean;
  verification?: { source?: string; note?: string; verifiedAt?: string } | null;
  fields: { label: string; value: unknown }[];
  connectedCables: { id: string; name: string; totalCores: number; verified?: boolean; used?: number | null; booked?: number | null; available?: number | null; mappedCores?: number }[];
};

export function NetworkCapacityDetail({
  capacity,
}: {
  capacity?: NetworkCapacity;
}) {
  if (!capacity) {
    return (
      <small className="d-block text-secondary mt-2">
        Informasi kapasitas belum tersedia untuk hasil ini. Jalankan analisis
        kembali untuk memperbaruinya.
      </small>
    );
  }
  return (
    <section
      aria-label="Kapasitas jaringan terdekat"
      className="mt-3 rounded border p-3"
    >
      {capacity.recommendationReason && (
        <div
          className={
            capacity.recommendation === "CAPACITY_AVAILABLE"
              ? "alert alert-success small py-2"
              : "alert alert-warning small py-2"
          }
        >
          {capacity.recommendationReason}
        </div>
      )}
      <b className="d-block mb-2">Kapasitas · {capacity.deviceType}</b>
      {capacity.totalCores === null ? (
        <small className="d-block text-secondary">
          Jumlah core tidak dicantumkan untuk aset ini. Kapasitas kabel tidak
          dapat ditentukan dari jenis perangkat atau kedekatan lokasi saja.
        </small>
      ) : (
        <>
          <dl className="row small mb-0">
            <dt className="col-7">Total core</dt>
            <dd className="col-5">{capacity.totalCores}</dd>
            <dt className="col-7">Terpakai tercatat</dt>
            <dd className="col-5">{capacity.usedCores}</dd>
            <dt className="col-7">Booked tercatat</dt>
            <dd className="col-5">{capacity.bookedCores}</dd>
            <dt className="col-7">Tersedia</dt>
            <dd className="col-5">
              {capacity.usageVerified
                ? capacity.availableCores
                : "Belum terverifikasi"}
            </dd>
          </dl>
          {!capacity.usageVerified && (
            <small className="d-block text-warning">
              Jumlah core tersedia belum terverifikasi. Kapasitas total dari KMZ
              tidak memastikan core masih kosong.
            </small>
          )}
          {capacity.usageVerified && capacity.verification && (
            <small className="d-block text-success">
              Diverifikasi via {capacity.verification.source ?? "—"}
              {capacity.verification.verifiedAt
                ? ` · ${new Date(capacity.verification.verifiedAt).toLocaleString("id-ID")}`
                : ""}
              {capacity.verification.note
                ? ` · ${capacity.verification.note}`
                : ""}
            </small>
          )}
          {!capacity.usageVerified && (
            <small className="d-block text-secondary mt-1">
              Admin dapat memeriksa status tiap core di Peta Jaringan, lalu
              menyimpan sumber dan catatan verifikasi.
            </small>
          )}
        </>
      )}
      {capacity.fields.length > 0 && (
        <table className="table atlas-data-table atlas-data-table-compact table-sm small mt-2 mb-0">
          <tbody>
            {capacity.fields.map(({ label, value }) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="text-break">{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <small className="d-block text-secondary mt-2">
        Port/splitter adalah kapasitas perangkat, berbeda dari jumlah core
        kabel. Handhole/manhole adalah tempat akses kabel.
      </small>
      {capacity.connectedCables.length > 0 ? (
        <div className="mt-3">
          <b className="small">Kabel yang tercatat terhubung</b>
          <ul className="small mb-0">
            {capacity.connectedCables.map((cable) => (
              <li key={cable.id}>
                {cable.name} ·{" "}
                {cable.totalCores > 0
                  ? cable.totalCores + " core"
                  : "Jumlah core belum diketahui"}
                {cable.verified
                  ? ` · terpakai ${cable.used ?? 0} · dibooking ${cable.booked ?? 0} · tersedia ${cable.available ?? 0}`
                  : " · pemakaian core belum terverifikasi"}
                {cable.mappedCores ? ` · ${cable.mappedCores} core dipetakan pada titik ini` : ""}
              </li>
            ))}
          </ul>
          <small className="d-block text-secondary">Jalankan ulang analisis setelah mengubah sambungan atau verifikasi core untuk memperbarui angka.</small>
        </div>
      ) : (
        <small className="d-block text-secondary mt-2">
          Belum ada relasi kabel yang tercatat untuk aset ini.
        </small>
      )}
    </section>
  );
}
