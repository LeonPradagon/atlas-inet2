import { Link } from "@tanstack/react-router";

type BookingPriceEstimateProps = {
  lineLabel: "Segmen" | "Ruas";
  lines: { name: string; cores: number }[];
  totalCores: number;
  coreRateCents: number;
  ratesPending: boolean;
  ratesError: boolean;
  valid: boolean;
  onRetry: () => void;
  cablePlan?: { label: string; meters: number; rateCents: number };
  includeCore?: boolean;
  corePending?: boolean;
};

function formatRupiah(cents: number) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function BookingPriceEstimate({
  lineLabel,
  lines,
  totalCores,
  coreRateCents,
  ratesPending,
  ratesError,
  valid,
  onRetry,
  cablePlan,
  includeCore,
  corePending = false,
}: BookingPriceEstimateProps) {
  const includesCore = includeCore ?? lines.length > 0;
  const coreTotalCents = coreRateCents * totalCores;
  const cableTotalCents = cablePlan ? Math.round(cablePlan.meters * cablePlan.rateCents) : 0;
  const coreReady = !includesCore || (!corePending && valid && coreRateCents > 0);
  const cableReady = !cablePlan || cablePlan.rateCents > 0;
  const totalReady = !ratesPending && !ratesError && coreReady && cableReady;
  const totalCents = coreTotalCents + cableTotalCents;

  return (
    <section aria-label="Estimasi biaya" className="booking-price-estimate mt-3">
      <div className="booking-price-estimate-heading">
        <div>
          <span>Estimasi biaya</span>
          <strong>{ratesPending ? "Memuat tarif…" : ratesError ? "Tarif gagal dimuat" : totalReady ? formatRupiah(totalCents) : "Belum lengkap"}</strong>
        </div>
        <div className="booking-price-estimate-formula">
          {includesCore && !corePending && <span>{totalCores} alokasi core</span>}
          {cablePlan && <span>{new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 }).format(cablePlan.meters)} m kabel baru</span>}
        </div>
      </div>

      {(ratesPending || ratesError) && (
        <p className="booking-price-estimate-message" role="status">
          {ratesPending ? "Memuat tarif booking…" : "Tarif gagal dimuat."}
          {ratesError && <button className="btn btn-sm btn-outline-primary atlas-secondary-action" onClick={onRetry} type="button">Coba lagi</button>}
        </p>
      )}
      {!ratesPending && !ratesError && !valid && includesCore && (
        <p className="booking-price-estimate-message" role="status">Periksa jumlah core pada setiap ruas.</p>
      )}

      <div className="booking-price-estimate-items">
        {includesCore && (
          <div className="booking-price-estimate-item">
            <div>
              <strong>Booking core pada kabel eksisting</strong>
              <small>{corePending ? "Pilih jalur untuk menghitung kebutuhan core" : `${totalCores} alokasi × ${coreRateCents > 0 ? formatRupiah(coreRateCents) : "tarif belum diatur"} per core`}</small>
            </div>
            <b>{!corePending && !ratesPending && !ratesError && valid && coreRateCents > 0 ? formatRupiah(coreTotalCents) : "—"}</b>
          </div>
        )}
        {cablePlan && (
          <div className="booking-price-estimate-item">
            <div>
              <strong>Tarik kabel baru</strong>
              <small>{cablePlan.label} · {cablePlan.rateCents > 0 ? `${formatRupiah(cablePlan.rateCents)} per meter` : "tarif per meter belum diatur"}</small>
            </div>
            <b>{!ratesPending && !ratesError && cablePlan.rateCents > 0 ? formatRupiah(cableTotalCents) : "—"}</b>
          </div>
        )}
      </div>

      {includesCore && lines.length > 0 && (
        <details className="booking-price-estimate-details">
          <summary>Lihat rincian {lineLabel.toLowerCase()}</summary>
          <div className="booking-price-breakdown">
            {lines.map((line, index) => (
              <div className="booking-price-breakdown-row" key={`${line.name}-${index}`}>
                <div className="booking-price-breakdown-description">
                  <span>{lineLabel} {index + 1}</span>
                  <strong>{line.name}</strong>
                  <small>{line.cores} core</small>
                </div>
                <b>{coreRateCents > 0 ? formatRupiah(coreRateCents * line.cores) : "—"}</b>
              </div>
            ))}
          </div>
        </details>
      )}

      {!ratesPending && !ratesError && !corePending && valid && coreRateCents <= 0 && includesCore && (
        <p className="booking-price-estimate-message">Tarif per core belum diatur. <Link to="/harga-jaringan">Atur tarif</Link>.</p>
      )}
      {!ratesPending && !ratesError && !cableReady && cablePlan && (
        <p className="booking-price-estimate-message">Tarif kabel per meter belum diatur. <Link to="/harga-jaringan">Atur tarif</Link>.</p>
      )}
      {cablePlan && <p className="booking-price-estimate-note">Panjang kabel baru adalah estimasi. Pastikan kembali saat survei.</p>}
    </section>
  );
}
