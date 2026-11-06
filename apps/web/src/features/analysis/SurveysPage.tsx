import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gps } from "exifr";
import { useRef, useState } from "react";
import { AtlasTag } from "../../components/AtlasTag";
import { DataTable } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { TablePagination } from "../../components/TablePagination";
import { api } from "../../lib/api";
import {
  NearestNetworkMap,
  type NetworkSearchResult,
} from "./NearestNetworkMap";

type Survey = {
  id: string;
  address: string;
  status: string;
  requester: string;
  row_number: number;
  verified_at: string | null;
  findings: Record<string, string>;
  analysis: NetworkSearchResult;
};
type SurveyChange = {
  survey: Survey;
  status: string;
  findings: Record<string, string>;
};
const labels: Record<string, string> = {
  WAITING: "Menunggu survei",
  IN_PROGRESS: "Dalam survei",
  REVIEW: "Menunggu verifikasi",
  VERIFIED: "Terverifikasi",
  REVISION: "Perlu revisi",
};
function SurveyStatusTag({ status }: { status: string }) {
  return (
    <AtlasTag className={status === "VERIFIED" ? "is-verified" : ""}>
      {labels[status] ?? status}
    </AtlasTag>
  );
}
const fields = [
  ["connection", "Titik sambungan aktual"],
  ["route", "Jalur kabel aktual"],
  ["length", "Panjang aktual (meter)"],
  ["capacity", "Hasil pemeriksaan kapasitas / core"],
  ["evidence", "Referensi bukti survei (tautan / nomor dokumen)"],
  ["notes", "Catatan / alasan revisi"],
];
function restoreTextFindings(findings: Record<string, string>) {
  const restored = { ...findings };
  try {
    const route = JSON.parse(findings.route ?? "") as Record<string, unknown>;
    if (route.version === "1" || route.version === 1) {
      restored.route = [route.type, route.description]
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    // Keep findings saved before the structured form as they are.
  }
  try {
    const capacity = JSON.parse(findings.capacity ?? "") as Record<
      string,
      unknown
    >;
    if (capacity.version === "1" || capacity.version === 1) {
      const total = Number(capacity.total);
      const used = Number(capacity.used);
      const booked = Number(capacity.booked);
      const available =
        [total, used, booked].every(Number.isFinite) &&
        [capacity.total, capacity.used, capacity.booked].every(Boolean)
          ? `Tersedia: ${total - used - booked} core`
          : "";
      restored.capacity = [
        capacity.total && `Total: ${capacity.total} core`,
        capacity.used && `Terpakai: ${capacity.used} core`,
        capacity.booked && `Dipesan: ${capacity.booked} core`,
        available,
        capacity.core && `Core sambungan: ${capacity.core}`,
        capacity.notes,
      ]
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    // Keep findings saved before the structured form as they are.
  }
  return restored;
}

export function SurveysPage() {
  const client = useQueryClient();
  const [filter, setFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [selected, setSelected] = useState<Survey | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [imageError, setImageError] = useState("");
  const [readingImage, setReadingImage] = useState(false);
  const imageReadId = useRef(0);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ role: string }>("/me"),
  });
  const surveys = useQuery({
    queryKey: ["surveys"],
    queryFn: () => api<Survey[]>("/surveys"),
  });
  const filtered = (surveys.data ?? []).filter(
    (s) => filter === "ALL" || s.status === filter
  );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize))
  );
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );
  const refresh = () => client.invalidateQueries({ queryKey: ["surveys"] });
  const openSurvey = (survey: Survey) => {
    imageReadId.current++;
    setImageError("");
    setReadingImage(false);
    setSelected(survey);
    setForm(restoreTextFindings(survey.findings ?? {}));
    update.reset();
  };
  const update = useMutation({
    mutationFn: ({ survey, status, findings }: SurveyChange) =>
      api("/surveys/" + survey.id, {
        method: "PATCH",
        data: { ...findings, status },
      }),
    onSuccess: async (_result, change) => {
      if (change.status === "IN_PROGRESS") {
        setSelected({ ...change.survey, status: change.status });
        setForm(restoreTextFindings(change.findings));
      } else {
        setSelected(null);
      }
      await refresh();
    },
  });
  return (
    <>
      <PageHeader
        subtitle="Tindak lanjuti hasil analisis tunggal dan massal per alamat."
        title="Survei & Verifikasi"
      />
      <section className="card panel-card">
        <div className="card-header d-flex w-100 gap-3">
          <h3>Daftar survei</h3>
          <select
            aria-label="Filter status survei"
            className="form-select ms-auto w-auto"
            onChange={(e) => {
              setFilter(e.target.value);
              setPage(1);
            }}
            value={filter}
          >
            <option value="ALL">Semua status</option>
            {Object.entries(labels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {surveys.isPending ? (
          <p className="p-3">Memuat survei...</p>
        ) : surveys.isError ? (
          <p className="text-danger p-3">Survei gagal dimuat.</p>
        ) : (
          <DataTable
            columns={[
              {
                key: "address",
                header: "Alamat / sumber",
                rowHeader: true,
                render: (survey: Survey) => (
                  <>
                    {survey.address}
                    <small className="d-block text-secondary fw-normal">
                      {survey.row_number
                        ? `Massal · Baris ${survey.row_number}`
                        : "Tunggal"}{" "}
                      · {survey.requester}
                    </small>
                  </>
                ),
              },
              {
                key: "network",
                header: "Jaringan",
                render: (survey: Survey) =>
                  survey.analysis.network?.name ?? "—",
              },
              {
                key: "status",
                header: "Status",
                render: (survey: Survey) => (
                  <SurveyStatusTag status={survey.status} />
                ),
              },
              {
                key: "action",
                header: "Aksi",
                className: "text-nowrap",
                render: (survey: Survey) =>
                  survey.status === "WAITING" ||
                  survey.status === "REVISION" ? (
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={update.isPending}
                      onClick={() =>
                        update.mutate({
                          survey,
                          status: "IN_PROGRESS",
                          findings: survey.findings ?? {},
                        })
                      }
                      type="button"
                    >
                      {survey.status === "WAITING"
                        ? "Mulai survei"
                        : "Perbaiki survei"}
                    </button>
                  ) : (
                    <button
                      className="btn btn-sm btn-outline-primary"
                      onClick={() => openSurvey(survey)}
                      type="button"
                    >
                      {survey.status === "IN_PROGRESS"
                        ? "Isi survei"
                        : survey.status === "REVIEW" &&
                            me.data?.role === "ADMIN"
                          ? "Verifikasi hasil"
                          : "Lihat hasil"}
                    </button>
                  ),
              },
            ]}
            emptyState={
              filter === "ALL" ? (
                "Belum ada survei."
              ) : (
                <div className="d-flex flex-wrap align-items-center justify-content-center gap-2">
                  <span>Tidak ada survei dengan status: {labels[filter]}.</span>
                  <button
                    className="btn btn-sm btn-link"
                    onClick={() => setFilter("ALL")}
                    type="button"
                  >
                    Tampilkan semua
                  </button>
                </div>
              )
            }
            label="Daftar survei"
            rowKey={(survey: Survey) => survey.id}
            rows={visible}
          />
        )}
        {!(surveys.isPending || surveys.isError) && (
          <TablePagination
            label="survei"
            onPageChange={setPage}
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
          />
        )}
        {update.error && !selected && (
          <p className="alert alert-danger m-3" role="alert">
            {update.error.message}
          </p>
        )}
      </section>
      {selected && (
        <section className="card panel-card mt-3">
          <div className="card-header d-flex w-100 gap-3">
            <div>
              <h3>{selected.address}</h3>
              <p>
                <SurveyStatusTag status={selected.status} />
                {selected.verified_at
                  ? ` · ${new Date(selected.verified_at).toLocaleString("id-ID")}`
                  : ""}
              </p>
            </div>
            <button
              className="btn btn-sm btn-outline-secondary ms-auto"
              onClick={() => setSelected(null)}
              type="button"
            >
              Tutup
            </button>
          </div>
          <div className="card-body">
            <p>
              Jaringan hasil analisis: <b>{selected.analysis.network?.name}</b>
              {selected.analysis.distanceMeters == null
                ? ""
                : ` · Estimasi kabel ${Math.round(selected.analysis.distanceMeters)} m`}
            </p>
            {Number.isFinite(selected.analysis.latitude) &&
              Number.isFinite(selected.analysis.longitude) && (
                <div className="mb-4">
                  <NearestNetworkMap
                    key={selected.id}
                    result={selected.analysis}
                    streetViewUrl={`https://www.google.com/maps/@?${new URLSearchParams(
                      {
                        api: "1",
                        map_action: "pano",
                        viewpoint: `${selected.analysis.latitude},${selected.analysis.longitude}`,
                      }
                    )}`}
                  />
                </div>
              )}
            <h4 className="h6 mb-3">Hasil pemeriksaan lapangan</h4>
            <div className="row g-3">
              {fields.map(([key, label]) => (
                <label className="col-md-6 form-label" key={key}>
                  {label}
                  <textarea
                    className="form-control mt-1"
                    maxLength={2000}
                    onChange={(event) =>
                      setForm({ ...form, [key]: event.target.value })
                    }
                    readOnly={
                      selected.status === "VERIFIED" ||
                      (selected.status === "REVIEW" &&
                        me.data?.role !== "ADMIN")
                    }
                    rows={3}
                    value={form[key] ?? ""}
                  />
                </label>
              ))}
            </div>{" "}
            <div className="mt-3">
              <label className="form-label" htmlFor="survey-image">
                Foto bukti survei
              </label>
              {selected.status === "IN_PROGRESS" && (
                <>
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    className="form-control"
                    id="survey-image"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      const readId = ++imageReadId.current;
                      setImageError("");
                      setReadingImage(false);
                      if (!file) return;
                      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
                        setImageError("Pilih gambar JPG, PNG, atau WebP dengan ukuran maksimal 2 MB.");
                        return;
                      }
                      const reader = new FileReader();
                      setReadingImage(true);
                      reader.onload = async () => {
                        const location = await gps(file).catch(() => undefined);
                        if (readId !== imageReadId.current) return;
                        if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude) || Math.abs(location.latitude) > 90 || Math.abs(location.longitude) > 180 || typeof reader.result !== "string") {
                          setImageError("Foto tidak memiliki koordinat GPS. Aktifkan lokasi pada kamera dan pilih foto asli.");
                        } else {
                          setForm((current) => ({ ...current, image: reader.result as string, imageLatitude: String(location.latitude), imageLongitude: String(location.longitude) }));
                        }
                        setReadingImage(false);
                      };
                      reader.onerror = () => {
                        if (readId === imageReadId.current) {
                          setImageError("Gambar tidak dapat dibaca.");
                          setReadingImage(false);
                        }
                      };
                      reader.readAsDataURL(file);
                    }}
                    type="file"
                  />
                  <small className="text-secondary">JPG, PNG, atau WebP, maksimal 2 MB. Foto harus memiliki koordinat GPS.</small>
                </>
              )}
              {imageError && <p className="text-danger" role="alert">{imageError}</p>}
              {form.image && (
                <div className="mt-2">
                  <a href={form.image} target="_blank" rel="noreferrer">
                    <img alt="Bukti survei" src={form.image} style={{ maxWidth: "100%", maxHeight: 240, objectFit: "contain" }} />
                  </a>
                  {form.imageLatitude && form.imageLongitude ? (
                    <p className="mt-2 mb-1">Koordinat foto: {form.imageLatitude}, {form.imageLongitude}</p>
                  ) : (
                    <p className="text-secondary mt-2 mb-1">Koordinat foto tidak tersedia.</p>
                  )}
                  {selected.status === "IN_PROGRESS" && (
                    <button className="btn btn-sm btn-outline-danger d-block mt-2" onClick={() => { imageReadId.current++; setReadingImage(false); setForm((current) => ({ ...current, image: "", imageLatitude: "", imageLongitude: "" })); }} type="button">Hapus gambar</button>
                  )}
                </div>
              )}
              {!form.image && selected.status !== "IN_PROGRESS" && <p className="text-secondary">Tidak ada gambar.</p>}
            </div>
            <div className="d-flex mt-3 gap-2">
              {selected.status === "IN_PROGRESS" && (
                <button
                  className="btn btn-primary"
                  disabled={update.isPending || readingImage}
                  onClick={() =>
                    update.mutate({
                      survey: selected,
                      status: "REVIEW",
                      findings: form,
                    })
                  }
                  type="button"
                >
                  Kirim hasil untuk verifikasi
                </button>
              )}
              {selected.status === "REVIEW" && me.data?.role === "ADMIN" && (
                <>
                  <button
                    className="btn btn-success"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate({
                        survey: selected,
                        status: "VERIFIED",
                        findings: form,
                      })
                    }
                    type="button"
                  >
                    Verifikasi hasil survei
                  </button>
                  <button
                    className="btn btn-outline-warning"
                    disabled={update.isPending}
                    onClick={() =>
                      update.mutate({
                        survey: selected,
                        status: "REVISION",
                        findings: form,
                      })
                    }
                    type="button"
                  >
                    Minta revisi
                  </button>
                </>
              )}
            </div>
            {update.error && (
              <p className="text-danger mt-2">{update.error.message}</p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
