import { BookingStatusBadge, bookingStatusLabel } from "./BookingStatusBadge";
import { assetDetailTitle } from "../map/assetDetailTitle";
import { DataTableShell } from "../../components/DataTable";
import { ModalDialog } from "../../components/ModalDialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { TablePagination } from "../../components/TablePagination";
import {
  api,
  type Booking,
  type NetworkAsset,
  networkQueryKeys,
  postJson,
} from "../../lib/api";
import { confirmAction } from "../../lib/dialogs";

const bookingPageSize = 20;

export function CoreBookingPage() {
  const { bookingId } = useSearch({ from: "/booking-core" });
  const queryClient = useQueryClient();
  const invalidateNetwork = () =>
    Promise.all(
      networkQueryKeys.map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] })
      )
    );
  const [toast, setToast] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>([]);
  const [segmentCores, setSegmentCores] = useState<Record<string, number>>({});
  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ id: string; name: string; role: string }>("/me"),
  });
  const { data: duration } = useQuery({
    queryKey: ["booking-duration"],
    queryFn: () => api<{ days: number }>("/settings/booking-duration"),
  });
  const bookingDays = duration?.days ?? 30;
  const [newDuration, setNewDuration] = useState(30);
  const [editDuration, setEditDuration] = useState(false);
  const [filter, setFilter] = useState<"Semua" | Booking["status"]>("Semua");
  const [page, setPage] = useState(1);
  const {
    data: bookings = [],
    isPending,
    isError,
  } = useQuery({
    queryKey: ["bookings"],
    queryFn: () => api<Booking[]>("/bookings"),
    refetchInterval: 30_000,
  });
  const segmentsQuery = useQuery({
    queryKey: ["bookable-segments"],
    queryFn: () =>
      api<
        (Pick<
          NetworkAsset,
          "id" | "name" | "area" | "assetType" | "totalCores" | "idleCores" | "usedCores" | "bookedCores" | "attributes"
        > & { ends: Record<"A" | "B", [number, number]> | null; endpointNames: Partial<Record<"A" | "B", string>> | null; nearbyEndpointNames?: Partial<Record<"A" | "B", string>> | null })[]
      >("/assets/bookable-segments"),
    refetchInterval: 30_000,
  });
  const release = useMutation({
    mutationFn: (booking: Booking) =>
      api<{
        released: string;
        allocated: string | null;
        allocatedBookingIds: string[];
      }>(`/bookings/${booking.id}/release`, { method: "POST" }),
    onSuccess: async (_result, booking) => {
      await invalidateNetwork();
      setToast(`Booking ${booking.id} dilepas. Pemilik waiting list yang memenuhi kapasitas akan diberi notifikasi.`);
      window.setTimeout(() => setToast(""), 4500);
    },
    onError: (error) =>
      setToast(
        error instanceof Error ? error.message : "Booking tidak dapat dilepas."
      ),
  });
  const approve = useMutation({
    mutationFn: (booking: Booking) =>
      api<{ id: string; status: Booking["status"] }>(
        `/bookings/${booking.id}/approve`,
        { method: "POST" }
      ),
    onSuccess: async (result, booking) => {
      await invalidateNetwork();
      setToast(
        result.status === "Booked"
          ? `Booking ${booking.id} disetujui dan core dialokasikan.`
          : `Kapasitas tidak lagi mencukupi; booking ${booking.id} masuk waiting list.`
      );
      window.setTimeout(() => setToast(""), 4500);
    },
    onError: (error) =>
      setToast(
        error instanceof Error
          ? error.message
          : "Booking tidak dapat disetujui."
      ),
  });
  const reject = useMutation({
    mutationFn: (booking: Booking) =>
      api<{ id: string; status: Booking["status"] }>(
        `/bookings/${booking.id}/reject`,
        { method: "POST" }
      ),
    onSuccess: async (_result, booking) => {
      await queryClient.invalidateQueries({ queryKey: ["bookings"] });
      setToast(`Permintaan booking ${booking.id} ditolak.`);
      window.setTimeout(() => setToast(""), 4500);
    },
    onError: (error) =>
      setToast(
        error instanceof Error ? error.message : "Booking tidak dapat ditolak."
      ),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Booking>("/bookings", { ...postJson(body) }),
    onSuccess: async (booking) => {
      await invalidateNetwork();
      setShowForm(false);
      setToast(
        booking.status === "Waiting List" ? `Booking ${booking.id} masuk waiting list.` : `Booking ${booking.id} diajukan dan menunggu persetujuan ADMIN.`
      );
      window.setTimeout(() => setToast(""), 4500);
    },
    onError: (error) =>
      setToast(
        error instanceof Error ? error.message : "Booking tidak dapat dibuat."
      ),
  });
  const resubmit = useMutation({
    mutationFn: (booking: Booking) => api(`/bookings/${booking.id}/resubmit`, { method: "POST" }),
    onSuccess: async () => { await invalidateNetwork(); setToast("Booking diajukan ulang untuk persetujuan ADMIN."); },
    onError: (error) => setToast(error instanceof Error ? error.message : "Booking tidak dapat diajukan ulang."),
  });
  const issuePo = useMutation({
    mutationFn: (booking: Booking) => api(`/bookings/${booking.id}/po-issued`, { method: "POST" }),
    onSuccess: async () => { await invalidateNetwork(); setToast("PO ditandai terbit dan core menjadi terpakai."); },
    onError: (error) => setToast(error instanceof Error ? error.message : "PO tidak dapat ditandai terbit."),
  });
  const updateDuration = useMutation({
    mutationFn: (days: number) =>
      api<{ days: number }>("/settings/booking-duration", {
        method: "PATCH",
        data: { days },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["booking-duration"] });
      setEditDuration(false);
    },
    onError: (error) =>
      setToast(
        error instanceof Error ? error.message : "Durasi tidak dapat disimpan."
      ),
  });
  const filtered = bookings.filter(
    (item) => filter === "Semua" || item.status === filter
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / bookingPageSize));
  const visibleBookings = filtered.slice(
    (page - 1) * bookingPageSize,
    page * bookingPageSize
  );
  const bookableSegments = segmentsQuery.data ?? [];
  const selectedSegments = bookableSegments.filter((segment) => selectedSegmentIds.includes(segment.id));
  const needsWaitingList = selectedSegments.some((segment) => (segmentCores[segment.id] ?? 1) > segment.idleCores);
  const bookedCount = bookings.filter(
    (item) => item.status === "Booked"
  ).length;
  const waitingCount = bookings.filter(
    (item) => item.status === "Waiting List"
  ).length;
  const pendingApprovalCount = bookings.filter(
    (item) => item.status === "Pending Approval"
  ).length;
  useEffect(() => {
    if (!bookingId) {
      return;
    }
    if (filter !== "Semua") {
      setFilter("Semua");
      return;
    }
    const index = bookings.findIndex((item) => item.id === bookingId);
    if (index >= 0) {
      setPage(Math.floor(index / bookingPageSize) + 1);
    }
  }, [bookingId, bookings, filter]);
  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bookings/page are triggers: re-scroll once the target row has rendered
  useEffect(() => {
    if (bookingId && filter === "Semua" && !isPending) {
      document
        .getElementById(`booking-${bookingId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [bookingId, filter, bookings, isPending, page]);
  const addBooking = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      customer: String(form.get("customer")),
      picCustomer: String(form.get("picCustomer")),
      picCustomerEmail: String(form.get("picCustomerEmail")),
      picCustomerPhone: String(form.get("picCustomerPhone")),
      segments: selectedSegments.map((segment) => ({ segmentId: segment.id, cores: segmentCores[segment.id] ?? 1, segmentFrom: String(form.get(`segmentFrom-${segment.id}`) ?? "").trim(), segmentTo: String(form.get(`segmentTo-${segment.id}`) ?? "").trim() })),
    });
  };
  return (
    <>
      <PageHeader
        action={
          <button
            className="btn btn-outline-primary atlas-secondary-action"
            onClick={() => {
              setSelectedSegmentIds([]);
              setSegmentCores({});
              create.reset();
              setShowForm(true);
            }}
            type="button"
          >
            <span aria-hidden="true" className="atlas-secondary-action-icon">+</span>
            Buat booking
          </button>
        }
        subtitle="Ajukan booking untuk persetujuan ADMIN; kapasitas dialokasikan setelah disetujui."
        title="Booking core"
      />
      {toast && (
        <div className="toast-banner" role="status">
          <i className="bi bi-check-circle-fill" />
          {toast}
          <button aria-label="Tutup" onClick={() => setToast("")} type="button">
            <i className="bi bi-x-lg" />
          </button>
        </div>
      )}
      <div className="row g-3 mb-4">
        <div className="col-sm-6 col-xl-3">
          <BookingMetric
            icon="bi-bookmark-check"
            label="Booking aktif"
            tone="blue"
            value={String(bookedCount)}
          />
        </div>
        <div className="col-sm-6 col-xl-3">
          <BookingMetric
            icon="bi-hourglass"
            label="Waiting list"
            tone="orange"
            value={String(waitingCount)}
          />
        </div>
        <div className="col-sm-6 col-xl-3">
          <div className="metric-card compact">
            <span className="metric-icon purple">
              <i className="bi bi-calendar2-check" />
            </span>
            <div className="flex-grow-1">
              <span className="metric-label">Masa booking sementara</span>
              {editDuration ? (
                <div className="d-flex align-items-center gap-2">
                  <input
                    aria-label="Durasi booking (hari)"
                    className="form-control form-control-sm duration-input"
                    max="365"
                    min="1"
                    onChange={(event) =>
                      setNewDuration(
                        Math.max(
                          1,
                          Math.min(365, Number(event.target.value) || 1)
                        )
                      )
                    }
                    type="number"
                    value={newDuration}
                  />
                  <button
                    className="btn btn-sm btn-outline-primary atlas-secondary-action py-1"
                    disabled={updateDuration.isPending}
                    onClick={() => updateDuration.mutate(newDuration)}
                    type="button"
                  >
                    Simpan
                  </button>
                </div>
              ) : (
                <div className="d-flex align-items-center gap-2">
                  <strong>{bookingDays} hari</strong>
                  {user?.role === "ADMIN" && (
                    <button
                      aria-label="Ubah durasi booking"
                      className="btn btn-sm btn-link duration-edit p-0"
                      onClick={() => {
                        setNewDuration(bookingDays);
                        setEditDuration(true);
                      }}
                      title="Ubah durasi booking"
                      type="button"
                    >
                      <i className="bi bi-pencil-square" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="col-sm-6 col-xl-3">
          <BookingMetric
            icon="bi-bezier2"
            label="Segmen tersedia"
            tone="green"
            value={String(bookableSegments.length)}
          />
        </div>
      </div>
      {isError && (
        <div className="alert alert-danger">
          Data booking tidak dapat dimuat.
        </div>
      )}
      {isPending ? (
        <div className="bulk-empty">Memuat booking...</div>
      ) : (
        <section className="card panel-card">
          <div className="card-header booking-request-header">
            <div>
              <h3>Permintaan core</h3>
              <p>
                Admin menyetujui permintaan saat kapasitas cukup. Pemohon di daftar tunggu mendapat notifikasi saat core tersedia.
              </p>
            </div>
            <div aria-label="Filter status booking" className="booking-status-filters" role="group">
              {(
                [
                  "Semua",
                  "Pending Approval",
                  "Booked",
                  "Used",
                  "Waiting List",
                  "Rejected",
                ] as const
              ).map((value) => (
                <button
                  aria-pressed={filter === value}
                  className="btn btn-sm btn-outline-primary atlas-choice"
                  key={value}
                  onClick={() => {
                    setFilter(value);
                    setPage(1);
                  }}
                  type="button"
                >
                  {value === "Semua" ? "Semua" : bookingStatusLabel(value)}
                  {value === "Pending Approval" && pendingApprovalCount > 0 && (
                    <span className="booking-filter-count">{pendingApprovalCount}</span>
                  )}
                  {value === "Waiting List" && waitingCount > 0 && <span className="booking-filter-count">{waitingCount}</span>}
                </button>
              ))}
            </div>
          </div>
          <DataTableShell label="Permintaan core">
            <table className="table table-hover atlas-data-table booking-table mb-0">
              <thead>
                <tr>
                  <th>ID / Pelanggan</th>
                  <th>Segmen</th>
                  <th>Total alokasi</th>
                  <th>PIC customer</th>
                  <th>PIC presales</th>
                  <th>Status</th>
                  <th>Permintaan</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {visibleBookings.map((booking) => (
                  <tr
                    className={
                      bookingId === booking.id ? "table-primary" : undefined
                    }
                    id={`booking-${booking.id}`}
                    key={booking.id}
                  >
                    <td>
                      <b className="booking-id">{booking.id}</b>
                      <small className="d-block text-muted">
                        {booking.customer}
                      </small>
                    </td>
                    <td>
                      {booking.segments.map((segment) => <div key={segment.segmentId}><span className="cable-name">{segment.name}</span><small className="d-block text-muted">{segment.cores} core{segment.area && ` (${segment.area})`}</small>{segment.segmentFrom && segment.segmentTo && <small className="d-block text-muted">{segment.segmentFrom} → {segment.segmentTo}</small>}</div>)}
                      {booking.status === "Waiting List" && (
                        <small className="d-block text-warning">
                          Menunggu kapasitas tersedia
                        </small>
                      )}
                    </td>
                    <td>
                      <b>{booking.cores} core</b>
                    </td>
                    <td>{booking.picCustomer}<small className="d-block text-muted">{booking.picCustomerEmail}</small><small className="d-block text-muted">{booking.picCustomerPhone}</small></td>
                    <td>{booking.picPresales}</td>
                    <td>
                      <BookingStatusBadge status={booking.status} />
                    </td>
                    <td className="text-muted">
                      {new Date(booking.requestedAt).toLocaleDateString(
                        "id-ID"
                      )}
                    </td>
                    <td className="text-nowrap">
                      {user?.role === "ADMIN" &&
                        booking.status === "Pending Approval" && (
                          <>
                            <button
                              className="btn btn-sm btn-success me-1"
                              disabled={approve.isPending || reject.isPending}
                              onClick={() => approve.mutate(booking)}
                              type="button"
                            >
                              Setujui
                            </button>
                            <button
                              className="btn btn-sm btn-outline-danger"
                              disabled={approve.isPending || reject.isPending}
                              onClick={async () => {
                                if (
                                  await confirmAction(
                                    `Tolak permintaan booking ${booking.id}?`
                                  )
                                ) {
                                  reject.mutate(booking);
                                }
                              }}
                              type="button"
                            >
                              Tolak
                            </button>
                          </>
                        )}
                      {booking.status === "Booked" && (
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          disabled={release.isPending}
                          onClick={() => release.mutate(booking)}
                          type="button"
                        >
                          Release
                        </button>
                      )}
                      {booking.status === "Booked" && user?.role === "ADMIN" && (
                        <button className="btn btn-sm btn-outline-primary atlas-secondary-action ms-1" disabled={issuePo.isPending} type="button" onClick={async () => { if (await confirmAction(`Tandai PO booking ${booking.id} sudah terbit? Core akan menjadi terpakai.`)) issuePo.mutate(booking); }}>PO terbit</button>
                      )}
                      {booking.status === "Waiting List" && booking.requestedBy === user?.id && (
                        <button className="btn btn-sm btn-outline-primary atlas-secondary-action" disabled={resubmit.isPending} onClick={() => resubmit.mutate(booking)} type="button">Ajukan ulang</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTableShell>
          <TablePagination
            label="booking"
            onPageChange={setPage}
            page={page}
            pageSize={bookingPageSize}
            total={filtered.length}
          />
          {filtered.length === 0 && (
            <div className="bulk-empty">
              <b>Tidak ada permintaan</b>
              <span>Coba pilih filter lain.</span>
            </div>
          )}
        </section>
      )}
      {showForm && (
        <ModalDialog labelledBy="booking-title" className="booking-modal" onClose={() => setShowForm(false)}>
            <div className="modal-heading">
              <div>
                <h3 id="booking-title">Buat booking core</h3>
                <p>Periksa ketersediaan core sebelum mengajukan permintaan.</p>
              </div>
              <button
                aria-label="Tutup"
                className="btn-close"
                onClick={() => setShowForm(false)}
                type="button"
              />
            </div>
            <form onSubmit={addBooking}>
              {segmentsQuery.isPending && <p role="status">Memuat segmen kabel...</p>}
              {segmentsQuery.isError && (
                <div className="alert alert-danger" role="alert">
                  Daftar kabel dan titik ujung gagal dimuat.{" "}
                  <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void segmentsQuery.refetch()}>Coba lagi</button>
                </div>
              )}
              {segmentsQuery.isSuccess && !bookableSegments.length && (
                <div className="alert alert-info">
                  Belum ada segmen dengan kapasitas core yang terverifikasi.
                  ADMIN perlu memverifikasi segmen pada halaman peta jaringan.
                </div>
              )}
              <label className="form-label" htmlFor="booking-customer">
                Nama pelanggan
              </label>
              <input
                className="form-control mb-3"
                id="booking-customer"
                name="customer"
                placeholder="Nama perusahaan"
                required
              />
              <fieldset className="mb-3">
                <legend className="form-label fs-6 fw-semibold">Segmen kabel</legend>
                <p className="small text-muted mb-2">
                  Pilih kabel, lalu tentukan jumlah core dan arah pada setiap kabel.
                </p>
                <div className="border rounded">
                  {bookableSegments.map((segment, index) => {
                    const selected = selectedSegmentIds.includes(segment.id);
                    const title = assetDetailTitle(segment);
                    const cores = segmentCores[segment.id] ?? 1;
                    const inputId = `booking-cores-${segment.id}`;
                    return (
                      <div className={index > 0 ? "border-top" : undefined} key={segment.id}>
                        <label className="d-flex align-items-start gap-2 p-3 mb-0">
                          <input
                            checked={selected}
                            className="form-check-input flex-shrink-0"
                            onChange={(event) => {
                              const checked = event.target.checked;
                              setSelectedSegmentIds((current) => checked
                                ? [...current, segment.id]
                                : current.filter((id) => id !== segment.id));
                            }}
                            type="checkbox"
                          />
                          <span className="d-flex flex-wrap align-items-baseline justify-content-between gap-1 flex-grow-1 text-break">
                            <strong>{title}</strong>
                            <span className={segment.idleCores ? "small text-success fw-semibold" : "small text-muted"}>
                              {segment.idleCores} core tersedia
                            </span>
                            <small className="d-flex flex-wrap gap-2 text-muted w-100">
                              <span className="fw-semibold">Total {segment.totalCores}</span>
                              <span className="fw-semibold booking-core-booked">Dibooking {segment.bookedCores}</span>
                              <span className="fw-semibold booking-core-used">Terpakai {segment.usedCores}</span>
                            </small>
                          </span>
                        </label>
                        {selected && (
                          <fieldset aria-label={`Pengaturan ${title}`} className="border-top px-3 pb-3 pt-2">
                            <label className="form-label" htmlFor={inputId}>Jumlah core</label>
                            <input
                              className="form-control"
                              id={inputId}
                              max={segment.totalCores}
                              min={1}
                              onChange={(event) => {
                                const value = Number(event.target.value);
                                setSegmentCores((current) => ({ ...current, [segment.id]: value }));
                              }}
                              required
                              type="number"
                              value={cores || ""}
                            />
                            {cores > segment.idleCores && cores <= segment.totalCores && (
                              <small className="d-block text-warning mt-1">Kapasitas saat ini kurang. Pengajuan akan masuk daftar tunggu.</small>
                            )}
                            <div className="row g-2 mt-1">
                              <BookingEndpoints segment={segment} />
                            </div>
                          </fieldset>
                        )}
                      </div>
                    );
                  })}
                </div>
              </fieldset>
              <div className="row g-3">
                <div className="col-12">
                  <label className="form-label" htmlFor="booking-pic-customer">
                    PIC customer
                  </label>
                  <input
                    className="form-control"
                    id="booking-pic-customer"
                    name="picCustomer"
                    placeholder="Nama PIC"
                    required
                  />
                </div>
              </div>
              <label className="form-label mt-3" htmlFor="booking-customer-email">Email PIC customer</label>
              <input className="form-control" id="booking-customer-email" name="picCustomerEmail" required type="email" />
              <label className="form-label mt-3" htmlFor="booking-customer-phone">Telepon PIC customer</label>
              <input className="form-control" id="booking-customer-phone" name="picCustomerPhone" required type="tel" />
              <label className="form-label mt-3" htmlFor="booking-pic-presales">
                PIC presales
              </label>
              <input
                className="form-control"
                id="booking-pic-presales"
                name="picPresales"
                value={user?.name ?? ""}
                readOnly
              />
              {selectedSegments.length > 0 && <p className="mt-3 mb-0">Total alokasi seluruh segmen: {selectedSegments.reduce((sum, segment) => sum + (segmentCores[segment.id] ?? 1), 0)} core. {needsWaitingList ? "Ada segmen yang core-nya belum cukup; seluruh permintaan akan masuk waiting list." : "Core tersedia di semua segmen; permintaan akan dikirim untuk persetujuan ADMIN."}</p>}
              {selectedSegments.length > 1 && <p className="small text-muted mt-2">Kapasitas dialokasikan per segmen. Sambungan fisik dicatat di Peta Jaringan.</p>}
              {create.isError && <div className="alert alert-danger mt-3" role="alert">{create.error.message}</div>}
              <div className="modal-actions">
                <button
                  className="btn btn-light"
                  onClick={() => setShowForm(false)}
                  type="button"
                >
                  Batal
                </button>
                <button
                  className="btn btn-outline-primary atlas-secondary-action"
                  disabled={create.isPending || segmentsQuery.isError || !selectedSegments.length || selectedSegments.some((segment) => !segment.ends)}
                  type="submit"
                >
                  <i className="bi bi-check2 atlas-secondary-action-icon" />
                  {needsWaitingList ? "Masuk waiting list" : "Ajukan persetujuan"}
                </button>
              </div>
            </form>
        </ModalDialog>
      )}
    </>
  );
}

function BookingMetric({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: string;
  tone: string;
}) {
  return (
    <div className="metric-card compact">
      <span className={`metric-icon ${tone}`}>
        <i className={`bi ${icon}`} />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function BookingEndpoints({ segment }: {
  segment: { id: string; ends: Record<"A" | "B", [number, number]> | null; endpointNames: Partial<Record<"A" | "B", string>> | null; nearbyEndpointNames?: Partial<Record<"A" | "B", string>> | null };
}) {
  const [direction, setDirection] = useState({ From: "", To: "" });
  return (
    <>
      {(["From", "To"] as const).map((end) => {
        const label = end === "From" ? "Titik awal" : "Titik akhir";
        const opposite = end === "From" ? "To" : "From";
        const id = `segment${end}-${segment.id}`;
        return (
          <div className="col-sm-6" key={end}>
            <label className="form-label" htmlFor={id}>{label}</label>
            <select
              className="form-select"
              id={id}
              name={id}
              disabled={!segment.ends}
              required
              value={direction[end]}
              onChange={(event) => setDirection({ ...direction, [end]: event.target.value })}
            >
              <option value="">Pilih {label.toLowerCase()}</option>
              {segment.ends && (["A", "B"] as const).map((side) => {
                const linked = segment.endpointNames?.[side];
                const nearby = segment.nearbyEndpointNames?.[side];
                const name = linked ?? (nearby ? `${nearby} (terdekat)` : `Perangkat belum ditemukan di ujung ${side}`);
                return <option key={side} value={side} disabled={direction[opposite] === side}>{name}</option>;
              })}
            </select>
          </div>
        );
      })}
      {!segment.ends && <small className="text-warning">Dua koordinat ujung yang berbeda belum tersedia untuk kabel ini.</small>}
    </>
  );
}
