import { formatDistance } from "../../lib/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gps } from "exifr";
import { useRef, useState } from "react";
import { AtlasTag } from "../../components/AtlasTag";
import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { PageHeader } from "../../components/PageHeader";
import { TablePagination } from "../../components/TablePagination";
import { api } from "../../lib/api";
import {
  NearestNetworkMap,
  type NetworkSearchResult,
} from "./NearestNetworkMap";
import { candidateName, type TerminationPlan } from "./terminationPlan";

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
type TerminationReference = {
  id: string;
  name: string;
  location: string;
  detail: string;
};

const terminationReferenceColumns: readonly DataTableColumn<TerminationReference>[] =
  [
    {
      key: "name",
      header: "Titik / aset",
      rowHeader: true,
      render: (row) => row.name,
    },
    {
      key: "location",
      header: "Koordinat",
      className: "text-nowrap",
      render: (row) => row.location,
    },
    {
      key: "detail",
      header: "Keterangan",
      render: (row) => row.detail || "—",
    },
  ];

function getTerminationReferences(plan: TerminationPlan) {
  const references: TerminationReference[] = [];
  const seen = new Set<string>();
  const add = (reference: TerminationReference) => {
    const key = `${reference.name}:${reference.location}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push(reference);
    }
  };

  plan.points.forEach((point, index) => {
    add({
      id: `point-${index}-${point.kind}`,
      name: `Titik rencana ${String(index + 1).padStart(2, "0")}`,
      location: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
      detail: point.kind,
    });
  });

  (plan.deviceCandidates ?? [])
    .filter((point) => point.kind !== "Tiang")
    .forEach((point, index) => {
      add({
        id: `device-${index}-${point.kind}`,
        name: candidateName(point, index),
        location: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
        detail: point.basis === "PLANNING" ? "" : point.reason,
      });
    });

  (plan.routeEvidence ?? []).forEach((point) => {
    add({
      id: `asset-${point.id}`,
      name: point.name,
      location: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
      detail: `${point.type} · ${Math.round(point.distanceToRouteMeters)} m dari jalur · ${point.recordedCables} kabel tercatat`,
    });
  });

  (plan.connectionCandidates ?? []).forEach((point, index) => {
    add({
      id: `connection-${point.cableId}-${index}`,
      name: point.cableName,
      location: `${point.latitude.toFixed(6)}, ${point.longitude.toFixed(6)}`,
      detail: `${point.recommendedKind ? `Potensi ${point.recommendedKind}` : "Jenis terminasi belum ditentukan"} · ${formatDistance(point.distanceMeters)} dari jalur`,
    });
  });

  return references;
}

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
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
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
  const terminationPlan = selected?.analysis.terminationPlan;
  const terminationReferences = terminationPlan
    ? getTerminationReferences(terminationPlan)
    : [];
  const hasSimulatedOdp = terminationPlan?.deviceCandidates?.some(
    (point) => point.kind === "ODP" && point.basis === "PLANNING"
  );
  const refresh = () => client.invalidateQueries({ queryKey: ["surveys"] });
  const openSurvey = (survey: Survey) => {
    imageReadId.current++;
    setImageError("");
    setReadingImage(false);
    setIsDraggingImage(false);
    setImageFile(null);
    setSelected(survey);
    setForm(restoreTextFindings(survey.findings ?? {}));
    update.reset();
  };
  const chooseImage = (file?: File) => {
    if (!file) {
      return;
    }
    const readId = ++imageReadId.current;
    setImageError("");
    setReadingImage(false);
    setImageFile(null);
    setForm((current) => ({
      ...current,
      image: "",
      imageLatitude: "",
      imageLongitude: "",
    }));
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setImageError(
        "Pilih gambar JPG, PNG, atau WebP dengan ukuran maksimal 2 MB."
      );
      return;
    }

    setImageFile(file);
    const reader = new FileReader();
    setReadingImage(true);
    reader.onload = async () => {
      const location = await gps(file).catch(() => undefined);
      if (readId !== imageReadId.current) {
        return;
      }
      if (
        !location ||
        !Number.isFinite(location.latitude) ||
        !Number.isFinite(location.longitude) ||
        Math.abs(location.latitude) > 90 ||
        Math.abs(location.longitude) > 180 ||
        typeof reader.result !== "string"
      ) {
        setImageError(
          "Foto tidak memiliki koordinat GPS. Aktifkan lokasi pada kamera dan pilih foto asli."
        );
      } else {
        setForm((current) => ({
          ...current,
          image: reader.result as string,
          imageLatitude: String(location.latitude),
          imageLongitude: String(location.longitude),
        }));
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
                    <small className="d-block text-secondary">
                      {survey.analysis.latitude.toFixed(6)},{" "}
                      {survey.analysis.longitude.toFixed(6)}
                    </small>
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
            {terminationPlan && (
              <section
                aria-labelledby="survey-termination-plan-title"
                className="survey-termination-plan"
              >
                <header className="survey-termination-plan-heading">
                  <h4 id="survey-termination-plan-title">
                    Rencana terminasi dan kabel
                  </h4>
                  <AtlasTag className="is-pending">Belum menjadi aset</AtlasTag>
                </header>
                {terminationReferences.length > 0 && (
                  <details className="survey-termination-references">
                    <summary>
                      Rincian titik dan aset ({terminationReferences.length})
                    </summary>
                    {hasSimulatedOdp && (
                      <p className="survey-termination-note">
                        Titik simulasi ODP mengikuti pola jarak pada data KMZ;
                        bukan jumlah pemasangan yang ditetapkan.
                      </p>
                    )}
                    <DataTable
                      columns={terminationReferenceColumns}
                      density="compact"
                      label="Rincian titik dan aset rencana"
                      rows={terminationReferences}
                      rowKey={(row) => row.id}
                    />
                  </details>
                )}
                {(terminationPlan.routeEvidenceIncomplete ||
                  terminationPlan.connectionCandidatesIncomplete) && (
                  <p className="survey-termination-note">
                    Sebagian aset atau ujung kabel belum tercakup dalam data
                    analisis.
                  </p>
                )}
              </section>
            )}
            {selected.analysis.proposal && (
              <div className="alert alert-warning">
                Usulan {selected.analysis.proposal.kind} pelanggan · kabel{" "}
                {selected.analysis.proposal.cores === null
                  ? "core belum ditentukan"
                  : `${selected.analysis.proposal.cores} core`}{" "}
                · lokasi {selected.analysis.proposal.latitude},{" "}
                {selected.analysis.proposal.longitude}. Rencana belum menjadi
                aset aktif.
              </div>
            )}
            <h4 className="h6 mb-3">Hasil pemeriksaan lapangan</h4>
            <div className="row g-3">
              {fields.map(([key, label]) => (
                <label className="col-md-6 form-label" key={key}>
                  {label}
                  {key === "length" ? (
                    <input
                      className="form-control mt-1"
                      type="number"
                      min="0"
                      step="any"
                      inputMode="decimal"
                      value={form[key] ?? ""}
                      readOnly={
                        selected.status === "VERIFIED" ||
                        (selected.status === "REVIEW" &&
                          me.data?.role !== "ADMIN")
                      }
                      onChange={(event) =>
                        setForm({ ...form, [key]: event.target.value })
                      }
                    />
                  ) : key === "evidence" ? (
                    <input
                      className="form-control mt-1"
                      value={form[key] ?? ""}
                      readOnly={
                        selected.status === "VERIFIED" ||
                        (selected.status === "REVIEW" &&
                          me.data?.role !== "ADMIN")
                      }
                      onChange={(event) =>
                        setForm({ ...form, [key]: event.target.value })
                      }
                    />
                  ) : (
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
                  )}
                </label>
              ))}
            </div>{" "}
            <div className="mt-4">
              {selected.status === "IN_PROGRESS" && (
                <>
                  <input
                    accept="image/jpeg,image/png,image/webp"
                    aria-describedby="survey-image-help"
                    aria-label="Pilih foto bukti survei"
                    className="file-upload-input"
                    id="survey-image"
                    onChange={(event) => {
                      chooseImage(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                    ref={imageInput}
                    type="file"
                  />
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop zone has a keyboard-accessible file picker button */}
                  {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the drop zone has a keyboard-accessible file picker button */}
                  <div
                    className={`file-upload-zone survey-image-upload${isDraggingImage ? " is-dragging" : ""}${readingImage ? " is-uploading" : ""}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsDraggingImage(true);
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null
                        )
                      ) {
                        setIsDraggingImage(false);
                      }
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      setIsDraggingImage(false);
                      if (event.dataTransfer.files.length > 1) {
                        setImageError(
                          "Pilih satu foto setiap kali mengunggah."
                        );
                        return;
                      }
                      chooseImage(event.dataTransfer.files[0]);
                    }}
                  >
                    <div aria-hidden="true" className="file-upload-icon">
                      <i className="bi bi-file-earmark-image" />
                    </div>
                    <div className="file-upload-copy">
                      <strong>
                        {isDraggingImage
                          ? "Lepaskan foto untuk diperiksa"
                          : readingImage
                            ? "Memeriksa foto dan koordinat GPS…"
                            : form.image
                              ? "Foto bukti survei siap"
                              : "Unggah foto bukti survei"}
                      </strong>
                      <span id="survey-image-help">
                        JPG, PNG, atau WebP, maksimal 2 MB. Foto harus memiliki
                        koordinat GPS.
                      </span>
                      {(imageFile || form.image) && (
                        <span
                          className="file-upload-selected"
                          title={
                            imageFile?.name ?? "Foto bukti survei tersimpan"
                          }
                        >
                          <i
                            aria-hidden="true"
                            className="bi bi-file-earmark-check"
                          />
                          <b>
                            {imageFile?.name ?? "Foto bukti survei tersimpan"}
                          </b>
                          {imageFile && (
                            <span>{(imageFile.size / 1024).toFixed(1)} KB</span>
                          )}
                        </span>
                      )}
                    </div>
                    <button
                      className="btn btn-outline-primary file-upload-button"
                      disabled={readingImage}
                      onClick={() => imageInput.current?.click()}
                      type="button"
                    >
                      {form.image ? "Pilih foto lain" : "Pilih foto"}
                    </button>
                    <span className="file-upload-drop-hint">
                      atau seret foto ke sini
                    </span>
                  </div>
                  <div
                    aria-live="polite"
                    className="file-upload-feedback"
                    role="status"
                  >
                    {readingImage && (
                      <>
                        <span
                          aria-hidden="true"
                          className="spinner-border spinner-border-sm"
                        />
                        <span>Memeriksa foto dan koordinat GPS…</span>
                      </>
                    )}
                  </div>
                </>
              )}
              {imageError && (
                <p
                  className="alert alert-danger py-2 px-3 mt-2 mb-0"
                  role="alert"
                >
                  {imageError}
                </p>
              )}
              {form.image && (
                <div className="survey-image-preview mt-3">
                  <a
                    aria-label="Buka foto bukti survei ukuran penuh"
                    className="survey-image-preview-link"
                    href={form.image}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {/* biome-ignore lint/correctness/useImageSize: foto survei memiliki rasio yang berbeda */}
                    <img alt="Bukti survei" src={form.image} />
                  </a>
                  <div className="survey-image-preview-details">
                    <strong>Foto bukti survei</strong>
                    {form.imageLatitude && form.imageLongitude ? (
                      <span className="survey-image-gps">
                        <i aria-hidden="true" className="bi bi-geo-alt-fill" />
                        Koordinat GPS terbaca
                      </span>
                    ) : (
                      <span className="text-secondary">
                        Koordinat foto tidak tersedia.
                      </span>
                    )}
                    {form.imageLatitude && form.imageLongitude && (
                      <span className="survey-image-coordinates">
                        {form.imageLatitude}, {form.imageLongitude}
                      </span>
                    )}
                    {selected.status === "IN_PROGRESS" && (
                      <button
                        className="btn btn-sm btn-outline-danger mt-2"
                        onClick={() => {
                          imageReadId.current++;
                          setReadingImage(false);
                          setImageFile(null);
                          setImageError("");
                          setForm((current) => ({
                            ...current,
                            image: "",
                            imageLatitude: "",
                            imageLongitude: "",
                          }));
                        }}
                        type="button"
                      >
                        Hapus gambar
                      </button>
                    )}
                  </div>
                </div>
              )}
              {!form.image && selected.status !== "IN_PROGRESS" && (
                <p className="text-secondary">Tidak ada gambar.</p>
              )}
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
