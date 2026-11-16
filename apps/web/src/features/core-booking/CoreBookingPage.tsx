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
  const { data: networkSegments = [] } = useQuery({
    queryKey: ["bookable-segments"],
    queryFn: () =>
      api<
        Pick<
          NetworkAsset,
          "id" | "name" | "area" | "assetType" | "totalCores" | "idleCores"
        >[]
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
  const bookableSegments = networkSegments;
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
            className="btn btn-primary"
            onClick={() => setShowForm(true)}
            type="button"
          >
            <i className="bi bi-plus-lg me-2" />
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
                    className="btn btn-sm btn-primary py-1"
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
                Permintaan dengan core tersedia menunggu persetujuan ADMIN. Waiting list diberi notifikasi ketika kapasitas tersedia untuk diajukan ulang.
              </p>
            </div>
            <div className="filter-tabs">
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
                  className={filter === value ? "active" : ""}
                  key={value}
                  onClick={() => {
                    setFilter(value);
                    setPage(1);
                  }}
                  type="button"
                >
                  {value === "Semua" ? "Semua" : bookingStatusLabel(value)}
                  {value === "Pending Approval" && (
                    <span>{pendingApprovalCount}</span>
                  )}
                  {value === "Waiting List" && <span>{waitingCount}</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="table-responsive">
            <table className="table table-hover atlas-data-table booking-table mb-0">
              <thead>
                <tr>
                  <th>ID / Pelanggan</th>
                  <th>Segmen</th>
                  <th>Jumlah core</th>
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
                      {booking.segments.map((segment) => <div key={segment.segmentId}><span className="cable-name">{segment.name}</span><small className="d-block text-muted">{segment.area} · {segment.cores} core</small>{segment.segmentFrom && segment.segmentTo && <small className="d-block text-muted">{segment.segmentFrom} → {segment.segmentTo}</small>}</div>)}
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
                      <span
                        className={`status-pill ${bookingStatusClass(booking.status)}`}
                      >
                        <i
                          className={`bi ${bookingStatusIcon(booking.status)}`}
                        />
                        {bookingStatusLabel(booking.status)}
                      </span>
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
                        <button className="btn btn-sm btn-primary ms-1" disabled={issuePo.isPending} type="button" onClick={async () => { if (await confirmAction(`Tandai PO booking ${booking.id} sudah terbit? Core akan menjadi terpakai.`)) issuePo.mutate(booking); }}>PO terbit</button>
                      )}
                      {booking.status === "Waiting List" && booking.requestedBy === user?.id && (
                        <button className="btn btn-sm btn-primary" disabled={resubmit.isPending} onClick={() => resubmit.mutate(booking)} type="button">Ajukan ulang</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
        // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only backdrop close; Escape and focus trapping are missing until these modals move to <dialog>
        <div
          className="modal-backdrop-custom"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setShowForm(false);
            }
          }}
          role="presentation"
        >
          <section
            aria-labelledby="booking-title"
            aria-modal="true"
            className="booking-modal"
            role="dialog"
          >
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
              {!bookableSegments.length && (
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
                <legend className="form-label fs-6">Cek ketersediaan segmen</legend>
                <small className="text-muted d-block mb-2">Pilih satu atau beberapa segmen untuk melihat kapasitasnya.</small>
                <div className="border rounded p-2" style={{ maxHeight: 180, overflowY: "auto" }}>
                  {bookableSegments.map((segment) => (
                    <label className="form-check d-block mb-1" key={segment.id}>
                      <input
                        checked={selectedSegmentIds.includes(segment.id)}
                        className="form-check-input"
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelectedSegmentIds((current) => checked ? [...current, segment.id] : current.filter((id) => id !== segment.id));
                        }}
                        type="checkbox"
                      />
                      <span className="form-check-label">{segment.name} · {segment.idleCores} dari {segment.totalCores} core tersedia</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {selectedSegments.map((segment) => (
                <div className="mb-3" key={segment.id}>
                  <label className="form-label" htmlFor={`booking-cores-${segment.id}`}>Jumlah core · {segment.name}</label>
                  <input className="form-control" id={`booking-cores-${segment.id}`} max={segment.totalCores} min="1" onChange={(event) => setSegmentCores((current) => ({ ...current, [segment.id]: Number(event.target.value) }))} required type="number" value={segmentCores[segment.id] ?? 1} />
                  <small className="text-muted">{segment.idleCores} tersedia dari {segment.totalCores} core</small>
                  <div className="row g-2 mt-1">
                    <div className="col-sm-6"><label className="form-label" htmlFor={`booking-from-${segment.id}`}>Segmen dari</label><input className="form-control" id={`booking-from-${segment.id}`} maxLength={200} name={`segmentFrom-${segment.id}`} placeholder="Titik awal" required /></div>
                    <div className="col-sm-6"><label className="form-label" htmlFor={`booking-to-${segment.id}`}>Segmen ke</label><input className="form-control" id={`booking-to-${segment.id}`} maxLength={200} name={`segmentTo-${segment.id}`} placeholder="Titik akhir" required /></div>
                  </div>
                </div>
              ))}
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
              {selectedSegments.length > 0 && <p className="mt-3 mb-0">{needsWaitingList ? "Ada segmen yang core-nya belum cukup; seluruh permintaan akan masuk waiting list." : "Core tersedia di semua segmen; permintaan akan dikirim untuk persetujuan ADMIN."}</p>}
              <div className="modal-actions">
                <button
                  className="btn btn-light"
                  onClick={() => setShowForm(false)}
                  type="button"
                >
                  Batal
                </button>
                <button
                  className="btn btn-primary"
                  disabled={create.isPending || !selectedSegments.length}
                  type="submit"
                >
                  <i className="bi bi-check2 me-2" />
                  {needsWaitingList ? "Masuk waiting list" : "Ajukan persetujuan"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

function bookingStatusLabel(status: Booking["status"]) {
  return {
    "Pending Approval": "Menunggu Persetujuan",
    Booked: "Aktif",
    Used: "Terpakai",
    "Waiting List": "Waiting List",
    Rejected: "Ditolak",
    Released: "Dilepas",
    Expired: "Kedaluwarsa",
  }[status];
}

function bookingStatusClass(status: Booking["status"]) {
  return {
    "Pending Approval": "is-pending",
    Booked: "is-booked",
    Used: "is-booked",
    "Waiting List": "is-waiting",
    Rejected: "is-rejected",
    Released: "is-released",
    Expired: "is-released",
  }[status];
}

function bookingStatusIcon(status: Booking["status"]) {
  return {
    "Pending Approval": "bi-hourglass-split",
    Booked: "bi-check-circle-fill",
    Used: "bi-check-circle-fill",
    "Waiting List": "bi-clock-fill",
    Rejected: "bi-x-circle-fill",
    Released: "bi-arrow-counterclockwise",
    Expired: "bi-calendar-x",
  }[status];
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
