import { useQuery, useQueryClient } from "@tanstack/react-query";
import ExcelJS from "exceljs";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { api, postJson } from "../../lib/api";
import { confirmAction } from "../../lib/dialogs";
import { bulkJobStatusLabel } from "./bulkJobStatus";
import {
  NearestNetworkMap,
  NetworkLocationsMap,
  type NetworkSearchResult,
} from "./NearestNetworkMap";
import { NetworkCapacityDetail } from "./NetworkCapacityDetail";
import { SubmitSurveyButton } from "./SubmitSurveyButton";

type AnalysisRow = {
  row: number;
  address: string;
  latitude?: number | null;
  longitude?: number | null;
  network?: NetworkSearchResult["network"];
  distanceMeters?: number | null;
  status: string;
  message?: string;
  result?: NetworkSearchResult | null;
};
type BulkJob = {
  jobId: string;
  historyId: string;
  fileName: string;
  status: string;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  cancelRequested: boolean;
};
function rowReviewReason(row: AnalysisRow) {
  if (row.message) return row.message;
  if (row.status === "NETWORK_NOT_FOUND") {
    return "Jaringan tidak ditemukan dalam radius 1 km.";
  }
  if (row.status === "ROUTING_UNAVAILABLE") {
    return "Jaringan ditemukan, tetapi rute jalan belum tersedia.";
  }
  if (["OK", "QUEUED", "PROCESSING", "CANCELLED"].includes(row.status)) {
    return "";
  }
  return "Periksa kembali alamat atau koordinat pada file.";
}
function downloadWorkbook(workbook: ExcelJS.Workbook, name: string) {
  void workbook.xlsx.writeBuffer().then((buffer) => {
    const url = URL.createObjectURL(
      new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  });
}
export function BulkAnalysisPage() {
  const input = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const [jobId, setJobId] = useState(
    () => new URLSearchParams(window.location.search).get("jobId") ?? ""
  );
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedRowNumber, setSelectedRowNumber] = useState<number | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [expanding, setExpanding] = useState<number | null>(null);
  const [error, setError] = useState("");
  const queryClient = useQueryClient();
  const jobQuery = useQuery({
    queryKey: ["bulk-job", jobId],
    queryFn: () => api<BulkJob>("/analysis/bulk/jobs/" + jobId),
    enabled: Boolean(jobId),
    refetchInterval: (q) =>
      ["COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED", "FAILED"].includes(
        q.state.data?.status ?? ""
      )
        ? false
        : 1500,
  });
  const activeJob = ![
    "COMPLETED",
    "COMPLETED_WITH_ERRORS",
    "CANCELLED",
    "FAILED",
  ].includes(jobQuery.data?.status ?? "");
  const pageQuery = useQuery({
    queryKey: ["bulk-job-rows", jobId, page, search, statusFilter],
    queryFn: () =>
      api<{ rows: AnalysisRow[]; total: number }>(
        "/analysis/bulk/jobs/" +
          jobId +
          "/rows?page=" +
          page +
          "&pageSize=50&search=" +
          encodeURIComponent(search) +
          "&status=" +
          encodeURIComponent(statusFilter)
      ),
    enabled: Boolean(jobId),
    refetchInterval: activeJob ? 2000 : false,
  });
  useEffect(() => {
    if (jobId && !activeJob) {
      void queryClient.invalidateQueries({
        queryKey: ["bulk-job-rows", jobId],
      });
    }
  }, [jobId, activeJob, queryClient]);
  const mapQuery = useQuery({
    queryKey: ["bulk-job-map-points", jobId],
    queryFn: () =>
      api<{ row: number; latitude: number; longitude: number }[]>(
        "/analysis/bulk/jobs/" + jobId + "/map-points"
      ),
    enabled: Boolean(jobId),
    refetchInterval: activeJob ? 5000 : false,
  });
  const selectMapRow = useCallback((row: number) => {
    setSelectedRowNumber(row);
    setPage(Math.floor((row - 1) / 50) + 1);
    setSearch("");
    setStatusFilter("");
  }, []);
  const job = jobQuery.data;
  const rows = pageQuery.data?.rows ?? [];
  const selectedRow = rows.find((row) => row.row === selectedRowNumber);
  const clearCurrentJob = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("jobId");
    window.history.replaceState(window.history.state, "", url);
    setJobId("");
    setPage(1);
    setSearch("");
    setStatusFilter("");
    setSelectedRowNumber(null);
    setError("");
    setSelectedFile(null);
    if (input.current) {
      input.current.value = "";
    }
  };
  const processFile = async (file?: File) => {
    if (!file) {
      return;
    }
    setError("");
    setLoading(true);
    try {
      if (!/\.xlsx$/iu.test(file.name)) {
        throw new Error("Format file belum didukung. Pilih file Excel .xlsx.");
      }
      if (file.size === 0) {
        throw new Error("File kosong. Pilih file Excel yang berisi data lokasi.");
      }
      if (file.size > 15 * 1024 * 1024) {
        throw new Error("Ukuran file melebihi 15 MB. Pilih file yang lebih kecil.");
      }
      const form = new FormData();
      form.append("file", file);
      const result = await api<BulkJob>("/analysis/bulk/jobs", {
        method: "POST",
        data: form,
      });
      const url = new URL(window.location.href);
      url.searchParams.set("jobId", result.jobId);
      window.history.replaceState(window.history.state, "", url);
      setJobId(result.jobId);
      setPage(1);
      setSelectedRowNumber(null);
      await queryClient.invalidateQueries({ queryKey: ["analysis-history"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unggah gagal");
    } finally {
      setLoading(false);
    }
  };
  const chooseFile = (file?: File) => {
    if (!file) return;
    setSelectedFile(file);
    setError("");
    if (input.current) input.current.value = "";
    void processFile(file);
  };
  const fileSizeLabel = (size: number) =>
    size < 1024
      ? `${size} byte`
      : size < 1024 * 1024
      ? `${Math.max(1, Math.round(size / 1024))} KB`
      : `${(size / (1024 * 1024)).toFixed(1)} MB`;
  const showRowsNeedingReview = () => {
    setSearch("");
    setStatusFilter("ERROR");
    setPage(1);
    setSelectedRowNumber(null);
    requestAnimationFrame(() =>
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };
  const expand = async (row: AnalysisRow) => {
    if (
      !(await confirmAction(
        "Belum ada jaringan dalam radius 1 km. Setujui pencarian hingga 2 km untuk lokasi ini?"
      ))
    ) {
      return;
    }
    setExpanding(row.row);
    setError("");
    try {
      await api(
        "/analysis/bulk/jobs/" + jobId + "/rows/" + row.row + "/expand",
        postJson({ confirmed: true })
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bulk-job-rows", jobId] }),
        queryClient.invalidateQueries({ queryKey: ["bulk-job", jobId] }),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Perluasan gagal");
    } finally {
      setExpanding(null);
    }
  };
  const download = async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Hasil Analisis");
    sheet.addRow([
      "Alamat",
      "Latitude",
      "Longitude",
      "Nearest Network",
      "Estimasi Panjang Kabel via Jalan Mobil (m)",
      "Status",
      "Pesan",
    ]);
    if (jobId) {
      for (
        let current = 1;
        current <= Math.ceil((job?.total ?? 0) / 100);
        current++
      ) {
        const result = await api<{ rows: AnalysisRow[] }>(
          `/analysis/bulk/jobs/${jobId}/rows?page=${current}&pageSize=100`
        );
        for (const row of result.rows) {
          sheet.addRow([
            row.address,
            row.latitude ?? "",
            row.longitude ?? "",
            row.network?.name ?? "",
            row.distanceMeters ?? "",
            row.status,
            row.message ?? "",
          ]);
        }
      }
    }
    downloadWorkbook(workbook, "ATLAS-hasil-analisis.xlsx");
  };
  const downloadTemplate = () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Lokasi");
    sheet.columns = [
      { header: "Alamat", key: "address", width: 34 },
      { header: "Provinsi", key: "province", width: 28 },
      { header: "Kabupaten/Kota", key: "city", width: 34 },
      { header: "Kecamatan", key: "district", width: 22 },
      { header: "Kelurahan/Desa", key: "village", width: 22 },
      { header: "Nomor Rumah", key: "number", width: 16 },
      { header: "Kode Pos", key: "postalCode", width: 14 },
      { header: "Latitude", key: "latitude", width: 14 },
      { header: "Longitude", key: "longitude", width: 14 },
    ];
    sheet.addRow([
      "Jl. Panjang Arteri Klp. Dua Raya",
      "Daerah Khusus Ibukota Jakarta",
      "Kota Administrasi Jakarta Barat",
      "Kebon Jeruk",
      "Kebon Jeruk",
      "5",
      "11530",
      "",
      "",
    ]);
    sheet.addRow([
      "Titik contoh Jakarta",
      "",
      "",
      "",
      "",
      "",
      "",
      -6.1754,
      106.8272,
    ]);
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = "A1:I1";
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF3454D1" },
    };
    const instructions = workbook.addWorksheet("Petunjuk");
    instructions.columns = [{ width: 30 }, { width: 100 }];
    instructions.addRows([
      ["PANDUAN TEMPLATE ANALISIS MASSAL"],
      [
        "Pilih salah satu metode",
        "Untuk setiap baris, isi alamat atau koordinat. Kolom Alamat boleh kosong jika memakai koordinat.",
      ],
      [
        "Metode alamat",
        "Isi Alamat, Provinsi, Kabupaten/Kota, dan Kecamatan. Kosongkan Latitude dan Longitude. Kelurahan/Desa, Nomor Rumah, dan Kode Pos opsional.",
      ],
      [
        "Metode koordinat",
        "Kosongkan Alamat dan kolom wilayah, lalu isi Latitude dan Longitude sekaligus. Jangan isi hanya salah satunya.",
      ],
      [
        "Jika keduanya diisi",
        "Jika alamat dan pasangan koordinat sama-sama diisi, sistem akan memakai koordinat.",
      ],
      [
        "Format koordinat",
        "Latitude antara -90 sampai 90; Longitude antara -180 sampai 180. Gunakan angka desimal.",
      ],
      [
        "Sebelum upload",
        "Ganti atau hapus dua baris contoh pada sheet Lokasi. Jangan ubah nama kolom di baris pertama.",
      ],
      ["Batas upload", "Maksimal 5.000 lokasi dan ukuran file 15 MB."],
    ]);
    instructions.getRow(1).font = {
      bold: true,
      size: 14,
      color: { argb: "FF3454D1" },
    };
    downloadWorkbook(workbook, "template-analisis-atlas.xlsx");
  };
  return (
    <>
      <PageHeader
        action={
          <button
            className="btn btn-outline-primary"
            onClick={downloadTemplate}
            type="button"
          >
            Unduh template
          </button>
        }
        subtitle="Cari jaringan terdekat: 500 m → 1 km. Perluasan ke 2 km memerlukan persetujuan per lokasi."
        title="Analisis massal"
      />
      <section className="card panel-card mb-4">
        <div className="card-body">
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            aria-describedby="bulk-upload-help"
            aria-label="Pilih file Excel untuk analisis massal"
            className="bulk-upload-input"
            disabled={loading}
            onChange={(event) => chooseFile(event.target.files?.[0])}
            ref={input}
            type="file"
          />
          <div
            className={`bulk-upload-zone${isDraggingFile ? " is-dragging" : ""}${loading ? " is-uploading" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!loading) setIsDraggingFile(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setIsDraggingFile(false);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDraggingFile(false);
              if (loading) return;
              if (event.dataTransfer.files.length > 1) {
                setError("Pilih satu file Excel setiap kali mengunggah.");
                return;
              }
              chooseFile(event.dataTransfer.files[0]);
            }}
          >
            <div className="bulk-upload-icon" aria-hidden="true">
              <i className="bi bi-file-earmark-spreadsheet" />
            </div>
            <div className="bulk-upload-copy">
              <strong>{isDraggingFile ? "Lepaskan file untuk mulai" : "Unggah data lokasi"}</strong>
              <span id="bulk-upload-help">
                Pilih file Excel (.xlsx), maksimal 15 MB. Analisis langsung dimulai setelah file dipilih.
              </span>
              {selectedFile && (
                <span className="bulk-upload-selected" title={selectedFile.name}>
                  <i className="bi bi-file-earmark-check" aria-hidden="true" />
                  <b>{selectedFile.name}</b>
                  <span>{fileSizeLabel(selectedFile.size)}</span>
                </span>
              )}
            </div>
            <button
              className="btn btn-outline-primary bulk-upload-button"
              disabled={loading}
              onClick={() => input.current?.click()}
              type="button"
            >
              {selectedFile ? "Pilih file lain" : "Pilih file Excel"}
            </button>
            <span className="bulk-upload-drop-hint">atau seret file ke sini</span>
          </div>
          <div aria-live="polite" className="bulk-upload-feedback" role="status">
            {loading && (
              <>
                <span
                  aria-hidden="true"
                  className="spinner-border spinner-border-sm"
                />
                <span>
                  Mengunggah {selectedFile?.name ?? "file"} dan memulai analisis…
                </span>
              </>
            )}
          </div>
          {jobId && (
            <div className="bulk-job-footer">
              <div className="bulk-job-summary">
                {job ? (
                  <>
                    <div className="bulk-job-titleline">
                      <strong title={job.fileName}>{job.fileName}</strong>
                      <span
                        className={`bulk-job-state${job.status === "COMPLETED" || job.status === "COMPLETED_WITH_ERRORS" ? " is-complete" : ""}`}
                      >
                        {job.status === "COMPLETED_WITH_ERRORS"
                          ? "Selesai"
                          : bulkJobStatusLabel(job.status)}
                      </span>
                    </div>
                    {job.failed > 0 ? (
                      <button
                        className="bulk-job-review-link"
                        onClick={showRowsNeedingReview}
                        type="button"
                      >
                        {job.failed} dari {job.total} lokasi perlu diperiksa
                        <i className="bi bi-arrow-right-short" aria-hidden="true" />
                      </button>
                    ) : (
                      <span>{job.processed} dari {job.total} lokasi</span>
                    )}
                  </>
                ) : (
                  <span>Memuat hasil analisis…</span>
                )}
              </div>
              <div className="bulk-job-actions">
                <button
                  className="btn btn-outline-secondary"
                  onClick={clearCurrentJob}
                  type="button"
                >
                  Bersihkan tampilan
                </button>
                {activeJob && (
                  <button
                    className="btn btn-outline-danger"
                    onClick={() =>
                      void api(
                        "/analysis/bulk/jobs/" + jobId + "/cancel",
                        postJson({})
                      )
                        .then(() =>
                          queryClient.invalidateQueries({
                            queryKey: ["bulk-job", jobId],
                          })
                        )
                        .catch((e) => setError(e.message))
                    }
                    type="button"
                  >
                    Batalkan pekerjaan
                  </button>
                )}
                {job && !activeJob && (
                  <button
                    className="btn btn-success"
                    onClick={() =>
                      void download().catch((e) => setError(e.message))
                    }
                    type="button"
                  >
                    Unduh hasil Excel
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
      {(error || jobQuery.isError || pageQuery.isError) && (
        <div className="alert alert-danger" role="alert">
          {error || jobQuery.error?.message || pageQuery.error?.message}
        </div>
      )}
      {jobId && (
        <section
          className="card panel-card bulk-analysis-results"
          ref={resultsRef}
        >
          <div className="card-header">
            <h3>Hasil pencarian jaringan</h3>
          </div>
          <div className="card-body">
            {Boolean(mapQuery.data?.length) && (
              <div className="mb-3">
                <NetworkLocationsMap
                  onSelect={selectMapRow}
                  points={mapQuery.data!}
                />
              </div>
            )}
            <div className="row g-2 mb-3">
              <div className="col-md">
                <input
                  className="form-control"
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Cari alamat"
                  value={search}
                />
              </div>
              <div className="col-md-4">
                <select
                  aria-label="Filter status"
                  className="form-select"
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setPage(1);
                  }}
                  value={statusFilter}
                >
                  <option value="">Semua status</option>
                  <option value="OK">Jaringan dan rute ditemukan</option>
                  <option value="NETWORK_NOT_FOUND">
                    Jaringan belum ditemukan
                  </option>
                  <option value="ROUTING_UNAVAILABLE">
                    Rute belum tersedia
                  </option>
                  <option value="ERROR">Perlu diperiksa</option>
                  <option value="PROCESSING">Diproses</option>
                  <option value="QUEUED">Menunggu</option>
                </select>
              </div>
            </div>
            <div className="table-responsive">
              <table className="table table-hover atlas-data-table">
                <thead>
                  <tr>
                    <th>Baris</th>
                    <th>Lokasi</th>
                    <th>Jaringan terdekat</th>
                    <th>Radius pencarian</th>
                    <th>Estimasi panjang kabel mengikuti jalan mobil</th>
                    <th>Status</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const reason = rowReviewReason(row);
                    const needsReview = Boolean(reason);
                    return (
                      <tr
                        className={
                          selectedRowNumber === row.row
                            ? "table-primary"
                            : needsReview
                              ? "bulk-row-needs-review"
                              : ""
                        }
                        key={row.row}
                      >
                      <td>{row.row}</td>
                      <td>
                        <button
                          className="btn btn-link p-0 text-start"
                          onClick={() => setSelectedRowNumber(row.row)}
                          type="button"
                        >
                          {row.address}
                        </button>
                        <small className="d-block">
                          {row.latitude}, {row.longitude}
                        </small>
                      </td>
                      <td>{row.network?.name ?? "—"}</td>
                      <td>
                        {row.result?.network?.searchRadiusMeters ??
                          row.result?.searchRadiusMeters ??
                          "—"}{" "}
                        m
                      </td>
                      <td>
                        {row.distanceMeters == null
                          ? "Belum tersedia"
                          : row.distanceMeters >= 1000
                            ? (row.distanceMeters / 1000).toFixed(2) + " km"
                            : Math.round(row.distanceMeters) + " m"}
                      </td>
                      <td>
                        {needsReview ? (
                          <span className="bulk-row-review-state">
                            Perlu diperiksa
                          </span>
                        ) : (
                          row.status
                        )}
                        {reason && (
                          <small className="bulk-row-review-reason">
                            {reason}
                          </small>
                        )}
                      </td>
                      <td>
                        {row.network && jobQuery.data?.historyId && (
                          <SubmitSurveyButton
                            historyId={jobQuery.data.historyId}
                            rowNumber={row.row}
                          />
                        )}
                        {row.result?.expansionAvailable && (
                          <button
                            className="btn btn-outline-primary btn-sm"
                            disabled={expanding !== null}
                            onClick={() => void expand(row)}
                            type="button"
                          >
                            {expanding === row.row
                              ? "Mencari…"
                              : "Cari hingga 2 km"}
                          </button>
                        )}
                      </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="d-flex justify-content-between align-items-center">
              <small>
                Halaman {page} · {pageQuery.data?.total ?? 0} baris
              </small>
              <div className="btn-group">
                <button
                  className="btn btn-outline-secondary"
                  disabled={page === 1}
                  onClick={() => setPage((p) => p - 1)}
                  type="button"
                >
                  Sebelumnya
                </button>
                <button
                  className="btn btn-outline-secondary"
                  disabled={page * 50 >= (pageQuery.data?.total ?? 0)}
                  onClick={() => setPage((p) => p + 1)}
                  type="button"
                >
                  Berikutnya
                </button>
              </div>
            </div>
            {selectedRow?.result &&
              Number.isFinite(selectedRow.latitude) &&
              Number.isFinite(selectedRow.longitude) && (
                <section className="mt-4">
                  <h4 className="h6">{selectedRow.address}</h4>
                  <NetworkCapacityDetail
                    capacity={selectedRow.result.network?.capacity}
                  />
                  <NearestNetworkMap result={selectedRow.result} />
                  <small>
                    Klik lokasi lain di tabel untuk melihat jaringan dan
                    estimasi jalur kabelnya.
                  </small>
                </section>
              )}
          </div>
        </section>
      )}
      {!jobId && (
        <div className="alert alert-info">
          Unggah lokasi untuk mencari jaringan yang sudah ada. Hasil tersimpan
          di riwayat analisis.
        </div>
      )}
    </>
  );
}
