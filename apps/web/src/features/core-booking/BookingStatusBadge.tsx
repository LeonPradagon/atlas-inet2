import type { Booking } from "../../lib/api";

export type BookingDisplayStatus = Booking["status"] | "Needs Verification";

export function bookingDisplayStatus(booking: Pick<Booking, "status" | "pathRequest">): BookingDisplayStatus {
  return booking.status === "Waiting List" && booking.pathRequest?.needsVerification
    ? "Needs Verification" : booking.status;
}

export function BookingStatusBadge({ status }: { status: BookingDisplayStatus }) {
  return (
    <span className={`status-pill ${bookingStatusClass(status)}`}>
      <i aria-hidden="true" className={`bi ${bookingStatusIcon(status)}`} />
      {bookingStatusLabel(status)}
    </span>
  );
}

export function bookingStatusLabel(status: BookingDisplayStatus) {
  return {
    "Pending Approval": "Menunggu Persetujuan",
    Booked: "Aktif",
    Used: "Terpakai",
    "Waiting List": "Waiting List",
    "Needs Verification": "Perlu Verifikasi Sambungan Core",
    Rejected: "Ditolak",
    Released: "Dilepas",
    Expired: "Kedaluwarsa",
  }[status];
}

function bookingStatusClass(status: BookingDisplayStatus) {
  return {
    "Pending Approval": "is-pending",
    Booked: "is-booked",
    Used: "is-booked",
    "Waiting List": "is-waiting",
    "Needs Verification": "is-pending",
    Rejected: "is-rejected",
    Released: "is-released",
    Expired: "is-released",
  }[status];
}

function bookingStatusIcon(status: BookingDisplayStatus) {
  return {
    "Pending Approval": "bi-hourglass-split",
    Booked: "bi-check-circle-fill",
    Used: "bi-check-circle-fill",
    "Waiting List": "bi-clock-fill",
    "Needs Verification": "bi-search",
    Rejected: "bi-x-circle-fill",
    Released: "bi-arrow-counterclockwise",
    Expired: "bi-calendar-x",
  }[status];
}
