import type { Booking } from "../../lib/api";

export function BookingStatusBadge({ status }: { status: Booking["status"] }) {
  return (
    <span className={`status-pill ${bookingStatusClass(status)}`}>
      <i aria-hidden="true" className={`bi ${bookingStatusIcon(status)}`} />
      {bookingStatusLabel(status)}
    </span>
  );
}

export function bookingStatusLabel(status: Booking["status"]) {
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
