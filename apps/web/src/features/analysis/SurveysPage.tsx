import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
      restored.route = [route.type, route.description].filter(Boolean).join("\n");
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
                        : survey.status === "REVIEW" && me.data?.role === "ADMIN"
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
                  <span>
                    Tidak ada survei dengan status: {labels[filter]}.
                  </span>
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
            </div>            <div className="d-flex mt-3 gap-2">
              {selected.status === "IN_PROGRESS" && (
                <button
                  className="btn btn-primary"
                  disabled={update.isPending}
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
