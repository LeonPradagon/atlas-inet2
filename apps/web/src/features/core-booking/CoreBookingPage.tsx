import { advanceAnalysisBookings, readAnalysisBookings } from "./analysisBookingDraft";
import { BookingStatusBadge, bookingDisplayStatus, bookingStatusLabel, type BookingDisplayStatus } from "./BookingStatusBadge";
import { notify } from "../../components/Snackbar";
import { assetDetailTitle } from "../map/assetDetailTitle";
import { DataTableShell } from "../../components/DataTable";
import { ModalDialog } from "../../components/ModalDialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { TablePagination } from "../../components/TablePagination";
import { BookingPriceEstimate } from "./BookingPriceEstimate";
import {
  api,
  type Booking,
  type NetworkAsset,
  networkQueryKeys,
  postJson,
} from "../../lib/api";
import { confirmAction } from "../../lib/dialogs";

type EndpointNames = {
  endpointNames: Partial<Record<"A" | "B", string>> | null;
  nearbyEndpointNames?: Partial<Record<"A" | "B", string>> | null;
};
type BookingPrice = { name: string; unit: string; price: number };

function rupiahFromCents(cents: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

type BookingDevice = {
  id: string;
  name: string;
  type: string | null;
  area?: string | null;
  latitude?: number;
  longitude?: number;
  cables?: { id: string; name: string; startId?: string | null; endId?: string | null }[];
  hasCandidateRoute?: boolean;
};
type RouteOption = {
  routeKey: string;
  cableIds: string[];
  cableNames: string[];
  lengthMeters: number;
  availableCores: number;
  meetsRequest: boolean;
  segments?: {
    name: string;
    availableCores: number;
    midspanPoints?: { id: string; name: string }[];
  }[];
  intermediatePoints?: (string | null)[];
  plannedJunctions?: boolean[];
};

function endpointLabel(segment: EndpointNames | undefined, side: "A" | "B") {
  const linked = segment?.endpointNames?.[side];
  const nearby = segment?.nearbyEndpointNames?.[side];
  return linked || (nearby ? `${nearby} (terdekat)` : "Perangkat belum ditemukan");
}

function bookingEndpointLabel(value: string, segment: EndpointNames | undefined) {
  const side = /^(?:Ujung )?([AB])(?: \(-?\d+\.\d{6}, -?\d+\.\d{6}\))?$/.exec(value)?.[1];
  return side === "A" || side === "B" ? endpointLabel(segment, side) : value;
}

export function CoreBookingPage() {
  const { bookingId } = useSearch({ from: "/booking-core" });
  const queryClient = useQueryClient();
  const invalidateNetwork = () =>
    Promise.all(
      networkQueryKeys.map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] })
      )
    );
  const [draftKey] = useState(() => new URLSearchParams(window.location.search).get("draft") ?? "");
  const [analysisDrafts, setAnalysisDrafts] = useState(() => readAnalysisBookings(draftKey));
  const analysisDraft = analysisDrafts[0];
  const newCableMeters = analysisDraft?.newCableMeters ?? 0;
  const [draftScope, setDraftScope] = useState<"core" | "cable" | "both">("both");
  const canDraftCore = Boolean(analysisDraft && !analysisDraft.cableOnly);
  const activeDraftScope = analysisDraft?.cableOnly
    ? "cable"
    : newCableMeters > 0 ? draftScope : "core";
  const includeCable = activeDraftScope !== "core";
  const includeCore = activeDraftScope !== "cable";
  const [showForm, setShowForm] = useState(Boolean(analysisDraft));
  const [formMode, setFormMode] = useState<"route" | "legacy">("route");
  const [startNodeId, setStartNodeId] = useState(analysisDraft?.startId ?? "");
  const [endNodeId, setEndNodeId] = useState(analysisDraft?.endId ?? "");
  const [requestedCores, setRequestedCores] = useState(analysisDraft?.cores ?? 1);
  const [selectedRouteKey, setSelectedRouteKey] = useState("");
  const [spanOverrides, setSpanOverrides] = useState<Record<string, Record<number, number>>>({});
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
  const pricesQuery = useQuery({
    queryKey: ["booking-prices"],
    queryFn: () => api<{ items: BookingPrice[] }>("/settings/booking-prices"),
  });
  const corePriceItems = (pricesQuery.data?.items ?? []).filter((item) => item.unit.trim().toLowerCase() === "core");
  const coreRateCents = corePriceItems.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
  const meterRateCents = (pricesQuery.data?.items ?? [])
    .filter((item) => item.unit.trim().toLowerCase() === "meter")
    .reduce((sum, item) => sum + Math.round(item.price * 100), 0);
  const bookingDays = duration?.days ?? 30;
  const [newDuration, setNewDuration] = useState(30);
  const [editDuration, setEditDuration] = useState(false);
  const [filter, setFilter] = useState<"Semua" | BookingDisplayStatus>("Semua");
  const [page, setPage] = useState(1);
  const [bookingPageSize, setBookingPageSize] = useState(5);
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
        > & { ends: Record<"A" | "B", [number, number]> | null; endpointIds?: Partial<Record<"A" | "B", string>> | null; endpointNames: Partial<Record<"A" | "B", string>> | null; nearbyEndpointNames?: Partial<Record<"A" | "B", string>> | null })[]
      >("/assets/bookable-segments"),
    refetchInterval: 30_000,
  });
  const targetId = analysisDraft?.targetId;
  const matchingSegments = targetId ? (segmentsQuery.data ?? []).filter((segment) => {
    const ends = segment.endpointIds;
    return ends?.A && ends.B && ends.A !== ends.B &&
      (segment.id === targetId || ends.A === targetId || ends.B === targetId);
  }) : [];
  const suggestedSegment = matchingSegments.find((segment) => segment.id === targetId)
    ?? matchingSegments.find((segment) => analysisDraft?.cableIds.includes(segment.id))
    ?? matchingSegments[0];
  const suggestedEndpoints = suggestedSegment ? suggestedSegment.endpointIds : undefined;
  const reverseEndpoints = targetId === suggestedEndpoints?.A;
  const devicesQuery = useQuery({
    queryKey: ["bookable-devices"],
    queryFn: () => api<BookingDevice[]>("/assets/bookable-devices"),
    enabled: includeCore && showForm && formMode === "route",
    staleTime: 30_000,
  });
  const devices = devicesQuery.data ?? [];
  const deviceIds = new Set(devices.map((device) => device.id));
  const targetCables = devices.find((device) => device.id === targetId)?.cables ?? [];
  const preferredDraftCables = analysisDraft?.cableIds ?? [];
  const cableRank = (id: string) => {
    const index = preferredDraftCables.indexOf(id);
    return index === -1 ? preferredDraftCables.length : index;
  };
  const candidateCable = [...targetCables].sort((a, b) => cableRank(a.id) - cableRank(b.id))
    .find((cable) => [cable.startId, cable.endId].some(
    (id) => id && id !== targetId && deviceIds.has(id)
  ));
  const candidateStartId = [candidateCable?.startId, candidateCable?.endId].find(
    (id) => id && id !== targetId && deviceIds.has(id)
  );
  const candidateCablePair = targetId && !candidateStartId ? devices
    .flatMap((device) => device.cables ?? [])
    .filter((cable) => cable.id === targetId)
    .sort((a, b) => cableRank(a.id) - cableRank(b.id))
    .find((cable) => cable.startId && cable.endId && cable.startId !== cable.endId &&
      deviceIds.has(cable.startId) && deviceIds.has(cable.endId)) : undefined;
  const draftStartId = analysisDraft?.startId ?? candidateStartId ??
    candidateCablePair?.startId ?? (reverseEndpoints ? suggestedEndpoints?.B : suggestedEndpoints?.A);
  const draftEndId = analysisDraft?.endId ?? (candidateStartId ? targetId :
    candidateCablePair?.endId ?? (reverseEndpoints ? suggestedEndpoints?.A : suggestedEndpoints?.B));
  const preferredCable = candidateCable || candidateCablePair || suggestedSegment;
  const preferredCableIds = preferredCable ? [preferredCable.id] : preferredDraftCables;
  useEffect(() => {
    if (draftStartId && draftEndId && draftStartId !== draftEndId) {
      setStartNodeId(draftStartId);
      setEndNodeId(draftEndId);
      setSelectedRouteKey("");
    }
  }, [analysisDraft, draftStartId, draftEndId]);
  const preferredRouteKey = preferredCableIds.length && startNodeId === draftStartId && endNodeId === draftEndId
    ? `verify:${JSON.stringify(preferredCableIds)}`
    : undefined;
  const routeQuery = useQuery({
    queryKey: ["bookable-core-routes", startNodeId, endNodeId, requestedCores, preferredRouteKey],
    queryFn: () => {
      const query = new URLSearchParams({ startId: startNodeId, endId: endNodeId, cores: String(requestedCores) });
      if (preferredRouteKey) query.set("preferredRoute", preferredRouteKey);
      return api<{ truncated: boolean; options: RouteOption[] }>(`/bookings/confirmed-core-paths?${query}`);
    },
    enabled: includeCore && showForm && formMode === "route" && Boolean(startNodeId && endNodeId && startNodeId !== endNodeId && requestedCores > 0),
  });
  const options = routeQuery.data?.options ?? [];
  const sortedOptions = [...options].sort((left, right) => left.lengthMeters - right.lengthMeters);
  const preferredRoute = analysisDraft && (
    sortedOptions.find((route) => route.routeKey === preferredRouteKey) ?? sortedOptions[0]
  );
  const recommendedRoute = preferredRoute && (preferredRoute.meetsRequest
    ? preferredRoute
    : sortedOptions.find((option) => option.meetsRequest) ?? preferredRoute);
  const selectedRoute = options.find((option) => option.routeKey === selectedRouteKey) ?? recommendedRoute;
  const routeEditKey = (option: RouteOption) => JSON.stringify([startNodeId, endNodeId, option.routeKey]);
  const countsForRoute = (option: RouteOption) =>
    option.cableIds.map((_, index) => spanOverrides[routeEditKey(option)]?.[index] ?? requestedCores);
  const selectedCounts = selectedRoute ? countsForRoute(selectedRoute) : [];
  const validSpanCounts = selectedCounts.every((count) => Number.isInteger(count) && count >= 1 && count <= 4096);
  const selectedRouteAllocationCount = selectedCounts.reduce((sum, count) => sum + count, 0);
  const selectedRouteMeetsRequest = selectedRoute
    ? routeMeetsSpanCounts(selectedRoute, selectedCounts)
    : false;
  const usesAlternative = recommendedRoute && preferredRoute?.routeKey !== recommendedRoute.routeKey &&
    selectedRoute?.routeKey === recommendedRoute.routeKey;
  const advanceDraft = () => {
    setSpanOverrides({});
    setDraftScope("both");
    const remaining = analysisDrafts.slice(1);
    advanceAnalysisBookings(draftKey, remaining);
    setAnalysisDrafts(remaining);
    setStartNodeId(remaining[0]?.startId ?? "");
    setEndNodeId(remaining[0]?.endId ?? "");
    setRequestedCores(remaining[0]?.cores ?? 1);
    setSelectedRouteKey("");
    setShowForm(remaining.length > 0);
  };
  const release = useMutation({
    mutationFn: (booking: Booking) =>
      api<{
        released: string;
        allocated: string | null;
        allocatedBookingIds: string[];
      }>(`/bookings/${booking.id}/release`, { method: "POST" }),
    onSuccess: async (_result, booking) => {
      await invalidateNetwork();
      notify(`Booking ${booking.id} dilepas. Pemilik waiting list yang memenuhi kapasitas akan diberi notifikasi.`);
    },
    onError: (error) =>
      notify(
        error instanceof Error ? error.message : "Booking tidak dapat dilepas.", "error"),
  });
  const approve = useMutation({
    mutationFn: (booking: Booking) =>
      api<{ id: string; status: Booking["status"]; reviewUpdated?: boolean }>(
        `/bookings/${booking.id}/approve`,
        { method: "POST" }
      ),
    onSuccess: async (result, booking) => {
      await invalidateNetwork();
      notify(result.reviewUpdated
          ? `Nomor core booking ${booking.id} berubah. Periksa rincian terbaru sebelum menyetujui lagi.`
          : result.status === "Booked"
          ? `Booking ${booking.id} disetujui dan core dialokasikan.`
          : `Kapasitas tidak lagi mencukupi; booking ${booking.id} masuk waiting list.`,
        result.reviewUpdated ? "warning" : result.status === "Booked" ? "success" : "warning",
      );
    },
    onError: (error) =>
      notify(
        error instanceof Error
          ? error.message
          : "Booking tidak dapat disetujui.", "error"),
  });
  const reject = useMutation({
    mutationFn: (booking: Booking) =>
      api<{ id: string; status: Booking["status"] }>(
        `/bookings/${booking.id}/reject`,
        { method: "POST" }
      ),
    onSuccess: async (_result, booking) => {
      await queryClient.invalidateQueries({ queryKey: ["bookings"] });
      notify(`Permintaan booking ${booking.id} ditolak.`);
    },
    onError: (error) =>
      notify(
        error instanceof Error ? error.message : "Booking tidak dapat ditolak.", "error"),
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Booking>("/bookings", { ...postJson(body) }),
    onSuccess: async (booking) => {
      await invalidateNetwork();
      setShowForm(false);
      notify(booking.status === "Waiting List" ? `Booking ${booking.id} masuk waiting list.` : `Booking ${booking.id} diajukan dan menunggu persetujuan ADMIN.`,
        booking.status === "Waiting List" ? "warning" : "success",
      );
    },
    onError: (error) =>
      notify(
        error instanceof Error ? error.message : "Booking tidak dapat dibuat.", "error"),
  });
  const createRoute = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Booking & { needsVerification?: boolean }>("/bookings/route", postJson(body)),
    onSuccess: async (booking) => {
      await invalidateNetwork();
      if (analysisDraft) advanceDraft();
      else setShowForm(false);
      const message = booking.status === "Waiting List" ? `Jalur booking ${booking.id} masuk waiting list.`
          : `Jalur booking ${booking.id} diajukan untuk ditinjau ADMIN.`;
      notify(message, booking.status === "Waiting List" ? "warning" : "success");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "Booking jalur tidak dapat dibuat.", "error"),
  });
  const cablePlansQuery = useQuery({
    queryKey: ["booking-cable-plans", user?.id],
    enabled: Boolean(user),
    queryFn: () => api<{ id: string; customer: string; estimate: { label: string; meters: number; rateCents: number; totalCents: number } }[]>("/bookings/cable-plan"),
  });
  const createCablePlan = useMutation({
    mutationFn: (body: { customer: string; cablePlan: { label: string; meters: number } }) =>
      api<{ id: string }>("/bookings/cable-plan", postJson(body)),
    onSuccess: (plan) => {
      void queryClient.invalidateQueries({ queryKey: ["booking-cable-plans"] });
      advanceDraft();
      notify(`Rencana tarik kabel tersimpan untuk survei. Referensi: ${plan.id}`);
    },
    onError: (error) => notify(error instanceof Error ? error.message : "Rencana kabel gagal disimpan.", "error"),
  });
  const resubmit = useMutation({
    mutationFn: (booking: Booking) => api(`/bookings/${booking.id}/resubmit`, { method: "POST" }),
    onSuccess: async () => { await invalidateNetwork(); notify("Booking diajukan ulang untuk persetujuan ADMIN."); },
    onError: (error) => notify(error instanceof Error ? error.message : "Booking tidak dapat diajukan ulang.", "error"),
  });
  const issuePo = useMutation({
    mutationFn: (booking: Booking) => api(`/bookings/${booking.id}/po-issued`, { method: "POST" }),
    onSuccess: async () => { await invalidateNetwork(); notify("PO ditandai terbit dan core menjadi terpakai."); },
    onError: (error) => notify(error instanceof Error ? error.message : "PO tidak dapat ditandai terbit.", "error"),
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
      notify("Durasi booking berhasil disimpan.");
    },
    onError: (error) =>
      notify(error instanceof Error ? error.message : "Durasi tidak dapat disimpan.", "error"),
  });
  const filtered = bookings.filter(
    (item) => filter === "Semua" || bookingDisplayStatus(item) === filter
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / bookingPageSize));
  const visibleBookings = filtered.slice(
    (page - 1) * bookingPageSize,
    page * bookingPageSize
  );
  const bookableSegments = segmentsQuery.data ?? [];
  const segmentById = new Map(bookableSegments.map((segment) => [segment.id, segment]));
  const selectedSegments = bookableSegments.filter((segment) => selectedSegmentIds.includes(segment.id));
  const validSelectedSegmentCores = selectedSegments.every((segment) => {
    const cores = segmentCores[segment.id] ?? 1;
    return Number.isInteger(cores) && cores >= 1 && cores <= segment.totalCores;
  });
  const selectedCoreCount = selectedSegments.reduce((sum, segment) => sum + (segmentCores[segment.id] ?? 1), 0);
  const needsWaitingList = selectedSegments.some((segment) => (segmentCores[segment.id] ?? 1) > segment.idleCores);
  const statusCounts = new Map<BookingDisplayStatus, number>();
  for (const booking of bookings) {
    const status = bookingDisplayStatus(booking);
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const bookedCount = statusCounts.get("Booked") ?? 0;
  const waitingCount = statusCounts.get("Waiting List") ?? 0;
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
  const addBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (create.isPending) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const request = {
      customer: String(form.get("customer")),
      picCustomer: String(form.get("picCustomer")),
      picCustomerEmail: String(form.get("picCustomerEmail")),
      picCustomerPhone: String(form.get("picCustomerPhone")),
      segments: selectedSegments.map((segment) => ({ segmentId: segment.id, cores: segmentCores[segment.id] ?? 1, segmentFrom: String(form.get(`segmentFrom-${segment.id}`) ?? "").trim(), segmentTo: String(form.get(`segmentTo-${segment.id}`) ?? "").trim() })),
    };
    const message = needsWaitingList
      ? "Masukkan permintaan booking ini ke daftar tunggu?"
      : "Ajukan permintaan booking ini untuk persetujuan admin?";
    if (await confirmAction(message, formElement.closest("dialog") ?? undefined)) {
      create.mutate(request);
    }
  };
  const addRouteBooking = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createRoute.isPending || createCablePlan.isPending) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const cablePlan = includeCable && analysisDraft ? { label: analysisDraft.label, meters: newCableMeters } : undefined;
    const customer = String(form.get("customer") ?? "").trim();
    if (!includeCore && cablePlan) {
      if (await confirmAction("Simpan rencana tarik kabel untuk survei?", formElement.closest("dialog") ?? undefined)) {
        createCablePlan.mutate({ customer, cablePlan });
      }
      return;
    }
    const route = selectedRoute;
    if (!route || !validSpanCounts) return;
    const body = {
      customer,
      cablePlan,
      picCustomer: String(form.get("picCustomer") ?? "").trim(),
      picCustomerEmail: String(form.get("picCustomerEmail") ?? "").trim(),
      picCustomerPhone: String(form.get("picCustomerPhone") ?? "").trim(),
      startNodeId,
      endNodeId,
      requestedCores,
      routeKey: route.routeKey,
      spanCoreCounts: spanOverrides[routeEditKey(route)] ? selectedCounts : undefined,
    };
    const message = selectedRouteMeetsRequest
      ? "Ajukan jalur core ini untuk ditinjau admin? Core baru dialokasikan setelah persetujuan."
      : "Kapasitas jalur belum cukup. Masukkan permintaan ini ke waiting list?";
    const confirmation = cablePlan ? `${message} Rencana tarik kabel baru juga akan disimpan untuk survei.` : message;
    if (await confirmAction(confirmation, formElement.closest("dialog") ?? undefined)) createRoute.mutate(body);
  };
  return (
    <>
      <PageHeader
        action={
          <button
            className="btn btn-outline-primary atlas-secondary-action"
            onClick={() => {
              if (analysisDraft) {
                setShowForm(true);
                return;
              }
              setSpanOverrides({});
              setFormMode("route");
              setStartNodeId("");
              setEndNodeId("");
              setRequestedCores(1);
              setSelectedRouteKey("");
              setSelectedSegmentIds([]);
              setSegmentCores({});
              create.reset();
              createRoute.reset();
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
                    onClick={async () => {
                      if (await confirmAction(`Ubah masa booking sementara menjadi ${newDuration} hari?`)) {
                        updateDuration.mutate(newDuration);
                      }
                    }}
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
                  <span className="booking-filter-count">
                    {value === "Semua" ? bookings.length : (statusCounts.get(value) ?? 0)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <DataTableShell label="Permintaan core">
            <table className="table table-hover atlas-data-table booking-table mb-0">
              <thead>
                <tr>
                  <th>Pelanggan / ID</th>
                  <th>Segmen</th>
                  <th>Total alokasi</th>
                  <th>Estimasi biaya</th>
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
                      <strong className="d-block text-break">{booking.customer}</strong>
                      <small className="booking-id d-block text-body-secondary text-break mt-1">
                        {booking.id}
                      </small>
                    </td>
                    <td>
                      {booking.pathRequest ? <BookingRouteDetail booking={booking} /> : <div className="d-grid gap-2">
                        {booking.segments.map((segment) => (
                          <div key={segment.segmentId}>
                            <span className="cable-name text-break">{segment.name}</span>
                            <small className="d-block text-body-secondary">
                              {segment.cores} core{segment.area && ` (${segment.area})`}
                            </small>
                            {segment.segmentFrom && segment.segmentTo && (
                              <small className="d-block text-body-secondary text-break mt-1">
                                <span className="d-block">Dari {bookingEndpointLabel(segment.segmentFrom, segmentById.get(segment.segmentId))}</span>
                                <span className="d-block">Ke {bookingEndpointLabel(segment.segmentTo, segmentById.get(segment.segmentId))}</span>
                              </small>
                            )}
                          </div>
                        ))}
                      </div>}
                      {booking.status === "Waiting List" && (
                        <small className="d-block text-warning">
                          {booking.pathRequest?.canResubmit ? "Core tersedia. Siap diajukan ulang."
                              : "Menunggu kapasitas tersedia"}
                        </small>
                      )}
                    </td>
                    <td className="text-nowrap fw-semibold">
                      {booking.pathRequest ? (
                        <>
                          <b className="d-block">
                            {bookingSpanCounts(booking.pathRequest).reduce((sum, count) => sum + count, 0)}{" "}
                            {booking.status === "Booked" || booking.status === "Used" ? "alokasi core" : "alokasi dibutuhkan"}
                          </b>
                          <small className="d-block text-body-secondary">
                            {describeSpanCounts(bookingSpanCounts(booking.pathRequest))}
                          </small>
                        </>
                      ) : booking.status === "Booked" || booking.status === "Used" ? <b>{booking.cores} core</b> : (
                        <>
                          <span>Belum dialokasikan</span>
                          <small className="d-block text-body-secondary">Diminta {booking.cores} core</small>
                        </>
                      )}
                    </td>
                    <td className="text-nowrap">
                      <strong>{formatBookingEstimate(bookingEstimateCents(booking))}</strong>
                    </td>
                    <td className="text-break">
                      <span className="d-block fw-semibold">{booking.picCustomer}</span>
                      <small className="d-block text-body-secondary">{booking.picCustomerEmail}</small>
                      <small className="d-block text-body-secondary">{booking.picCustomerPhone}</small>
                    </td>
                    <td>{booking.picPresales}</td>
                    <td>
                      <BookingStatusBadge status={bookingDisplayStatus(booking)} />
                    </td>
                    <td className="text-body-secondary text-nowrap">
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
                              onClick={async () => {
                                if (await confirmAction(`Setujui permintaan booking untuk ${booking.customer}?`)) {
                                  approve.mutate(booking);
                                }
                              }}
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
                      {(booking.status === "Booked" || (booking.status === "Used" && user?.role === "ADMIN")) && (
                        <button
                          className="btn btn-sm btn-outline-secondary"
                          disabled={release.isPending}
                          onClick={async () => {
                            if (await confirmAction(`Lepas booking untuk ${booking.customer} dan kembalikan alokasi core?`)) {
                              release.mutate(booking);
                            }
                          }}
                          type="button"
                        >
                          Release
                        </button>
                      )}
                      {booking.status === "Booked" && user?.role === "ADMIN" && (
                        <button className="btn btn-sm btn-outline-primary atlas-secondary-action ms-1" disabled={issuePo.isPending} type="button" onClick={async () => { if (await confirmAction(`Tandai PO booking ${booking.id} sudah terbit? Core akan menjadi terpakai.`)) issuePo.mutate(booking); }}>PO terbit</button>
                      )}
                      {booking.status === "Waiting List" && booking.requestedBy === user?.id &&
                        (!booking.pathRequest || booking.pathRequest.canResubmit) && (
                        <button
                          className="btn btn-sm btn-outline-primary atlas-secondary-action"
                          disabled={resubmit.isPending}
                          onClick={async () => {
                            if (await confirmAction(`Ajukan ulang booking untuk ${booking.customer} agar ditinjau admin?`)) {
                              resubmit.mutate(booking);
                            }
                          }}
                          type="button"
                        >
                          Ajukan ulang
                        </button>
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
            onPageSizeChange={(size) => { setBookingPageSize(size); setPage(1); }}
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
      {showForm && formMode === "route" && (
        <ModalDialog labelledBy="booking-title" className="booking-modal" onClose={() => setShowForm(false)}>
          <div className="modal-heading">
            <div>
              <h3 id="booking-title">Booking jalur antarperangkat</h3>
              <p>Pilih dua perangkat. ATLAS mencari jalur kabel dan memeriksa kapasitas setiap segmen.</p>
            </div>
            <button aria-label="Tutup" className="btn-close" onClick={() => setShowForm(false)} type="button" />
          </div>
          <form key={analysisDrafts.length} onSubmit={addRouteBooking}>
            {analysisDraft && (
              <div className="alert alert-info">
                <strong>Draf dari analisis: {analysisDraft.label}</strong>
                {analysisDrafts.length > 1 && <span className="d-block">{analysisDrafts.length} draf tersisa. Tinjau satu per satu.</span>}
                {includeCore && preferredRouteKey && preferredRoute && preferredRoute.routeKey !== preferredRouteKey && <span className="d-block">Jalur dari analisis belum tersedia untuk booking. Tinjau jalur kabel yang ditemukan.</span>}
                {includeCore && usesAlternative && <span className="d-block">Jalur utama kurang kapasitas. Alternatif dengan kapasitas cukup dipilih otomatis.</span>}
                {includeCore && !segmentsQuery.isPending && !devicesQuery.isPending && (!draftStartId || !draftEndId || draftStartId === draftEndId) &&
                  <span className="d-block">Jalur booking belum tersedia dari hasil ini. Diperlukan dua titik jaringan berbeda.</span>}
              </div>
            )}
            <label className="form-label" htmlFor="booking-customer-route">Nama pelanggan</label>
            <input className="form-control mb-3" id="booking-customer-route" name="customer" placeholder="Nama perusahaan" required />
            {analysisDraft && (
              <fieldset className="booking-request-selector">
                <legend>Pilih kebutuhan jaringan</legend>
                <div className="booking-request-options">
                  {[
                    ...(canDraftCore ? [["core", "Booking core", "Pakai kapasitas kabel yang sudah ada."]] : []),
                    ...(newCableMeters > 0 ? [["cable", "Tarik kabel baru", "Pasang kabel dari jaringan ke lokasi."]] : []),
                    ...(canDraftCore && newCableMeters > 0 ? [["both", "Core dan kabel baru", "Pakai core eksisting sekaligus rencanakan kabel baru."]] : []),
                  ].map(([value, label, description]) => (
                    <label className={`booking-request-choice ${activeDraftScope === value ? "is-selected" : ""}`} key={value}>
                      <input
                        checked={activeDraftScope === value}
                        disabled={createRoute.isPending || createCablePlan.isPending}
                        name="booking-request-scope"
                        onChange={() => setDraftScope(value as "core" | "cable" | "both")}
                        type="radio"
                        value={value}
                      />
                      <span><strong>{label}</strong><small>{description}</small></span>
                    </label>
                  ))}
                </div>
                {!canDraftCore && !newCableMeters && <p role="status">Rute core dan panjang kabel baru belum tersedia dari hasil analisis ini.</p>}
              </fieldset>
            )}
            {includeCore && <>
            <div className="row g-3">
              <div className="col-md-6">
                <BookingDevicePicker
                  id="booking-start-device"
                  label="Perangkat awal"
                  devices={devicesQuery.data ?? []}
                  value={startNodeId}
                  onSelect={(id) => {
                    setStartNodeId(id);
                    if (id === endNodeId) setEndNodeId("");
                    setSelectedRouteKey("");
                  }}
                />
              </div>
              <div className="col-md-6">
                <BookingDevicePicker
                  id="booking-end-device"
                  label="Perangkat tujuan"
                  devices={devicesQuery.data ?? []}
                  value={endNodeId}
                  excludedId={startNodeId}
                  onSelect={(id) => { setEndNodeId(id); setSelectedRouteKey(""); }}
                />
              </div>
              <div className="col-md-6">
                <label className="form-label" htmlFor="booking-route-cores">Jumlah core khusus</label>
                <input className="form-control" id="booking-route-cores" type="number" min={1} max={4096} value={requestedCores} onChange={(event) => { setRequestedCores(Number(event.target.value)); setSelectedRouteKey(""); }} required />
                <small className="form-text">Jumlah awal untuk semua ruas. Ubah jumlah pada ruas tertentu setelah memilih jalur.</small>
              </div>
            </div>
            {devicesQuery.isPending && <p className="mt-3" role="status">Memuat daftar perangkat...</p>}
            {devicesQuery.isError && <div className="alert alert-danger mt-3" role="alert">Daftar perangkat gagal dimuat. <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => void devicesQuery.refetch()}>Coba lagi</button></div>}
            {startNodeId && endNodeId && startNodeId === endNodeId && <div className="alert alert-warning mt-3">Pilih dua perangkat yang berbeda.</div>}
            {routeQuery.isFetching && <p className="mt-3" role="status">Menelusuri jalur kabel dan kapasitas...</p>}
            {routeQuery.isError && <div className="alert alert-danger mt-3" role="alert">Pencarian jalur gagal. Ubah pilihan atau coba kembali.</div>}
            {routeQuery.data && (
              <fieldset className="mt-3">
                <legend className="form-label fs-6 fw-semibold">Pilih jalur</legend>
                {routeQuery.data.truncated && <p className="small text-warning">Jalur yang ditemukan banyak; hasil dibatasi. Persempit pilihan perangkat.</p>}
                {!routeQuery.data.options.length ? <div className="alert alert-warning">Belum ada jalur kabel antara kedua perangkat ini.</div> : (
                  <div className="d-grid gap-2">
                    {routeQuery.data.options.map((option, index) => (
                      <BookingRouteOption
                        key={option.routeKey}
                        option={option}
                        index={index}
                        selected={selectedRoute?.routeKey === option.routeKey}
                        onSelect={() => setSelectedRouteKey(option.routeKey)}
                        spanCounts={countsForRoute(option)}
                        onChangeSpan={option.routeKey.startsWith("verify:") ? (index, count) => {
                          const key = routeEditKey(option);
                          setSpanOverrides((current) => ({
                            ...current,
                            [key]: { ...current[key], [index]: count },
                          }));
                        } : undefined}
                        startName={devicesQuery.data?.find((device) => device.id === startNodeId)?.name}
                        endName={devicesQuery.data?.find((device) => device.id === endNodeId)?.name}
                      />
                    ))}
                  </div>
                )}
              </fieldset>
            )}
            </>}
            {analysisDraft && (includeCore || includeCable) && (
              <BookingPriceEstimate
                cablePlan={includeCable ? { label: analysisDraft.label, meters: newCableMeters, rateCents: meterRateCents } : undefined}
                corePending={includeCore && !selectedRoute}
                includeCore={includeCore}
                lineLabel="Ruas"
                lines={includeCore && selectedRoute ? selectedRoute.cableIds.map((cableId, index) => ({
                  name: selectedRoute.cableNames[index] ?? cableId,
                  cores: selectedCounts[index] ?? requestedCores,
                })) : []}
                totalCores={includeCore ? selectedRouteAllocationCount : 0}
                coreRateCents={coreRateCents}
                ratesPending={pricesQuery.isPending}
                ratesError={pricesQuery.isError}
                valid={!includeCore || validSpanCounts}
                onRetry={() => void pricesQuery.refetch()}
              />
            )}
            {!analysisDraft && selectedRoute && (
              <BookingPriceEstimate
                lineLabel="Ruas"
                lines={selectedRoute.cableIds.map((cableId, index) => ({
                  name: selectedRoute.cableNames[index] ?? cableId,
                  cores: selectedCounts[index] ?? requestedCores,
                }))}
                totalCores={selectedRouteAllocationCount}
                coreRateCents={coreRateCents}
                ratesPending={pricesQuery.isPending}
                ratesError={pricesQuery.isError}
                valid={validSpanCounts}
                onRetry={() => void pricesQuery.refetch()}
              />
            )}
            {(includeCore || includeCable) && <div className="row g-3 mt-1">
              <div className="col-md-6"><label className="form-label" htmlFor="booking-route-pic">PIC customer</label><input className="form-control" id="booking-route-pic" name="picCustomer" placeholder="Nama PIC" required /></div>
              {includeCore && <>
                <div className="col-md-6"><label className="form-label" htmlFor="booking-route-email">Email PIC customer</label><input className="form-control" id="booking-route-email" name="picCustomerEmail" type="email" required /></div>
                <div className="col-md-6"><label className="form-label" htmlFor="booking-route-phone">Telepon PIC customer</label><input className="form-control" id="booking-route-phone" name="picCustomerPhone" type="tel" required /></div>
                <div className="col-md-6"><label className="form-label" htmlFor="booking-route-presales">PIC presales</label><input className="form-control" id="booking-route-presales" value={user?.name ?? ""} readOnly /></div>
              </>}
            </div>
            }
            {createCablePlan.isError && <div className="alert alert-danger mt-3" role="alert">{createCablePlan.error.message}</div>}
            {createRoute.isError && <div className="alert alert-danger mt-3" role="alert">{createRoute.error.message}</div>}
            <div className="modal-actions">
              <button className="btn btn-light" type="button" onClick={() => setShowForm(false)}>Batal</button>
              {analysisDrafts.length > 1 && <button className="btn btn-outline-secondary" type="button" onClick={advanceDraft} disabled={createRoute.isPending || createCablePlan.isPending}>Lewati draf</button>}
              {!analysisDraft && <button className="btn btn-outline-primary atlas-secondary-action" type="button" onClick={() => { setFormMode("legacy"); create.reset(); }}>Booking per segmen</button>}
              <button className="btn btn-primary" type="submit" disabled={createRoute.isPending || createCablePlan.isPending || (includeCore && (routeQuery.isFetching || routeQuery.isError || !selectedRoute || !startNodeId || !endNodeId || startNodeId === endNodeId || requestedCores < 1 || !validSpanCounts))}>
                {!includeCore ? "Simpan rencana tarik kabel" : !selectedRoute ? "Pilih jalur dulu" : selectedRouteMeetsRequest ? "Ajukan persetujuan" : "Masuk waiting list"}
              </button>
            </div>
          </form>
        </ModalDialog>
      )}
      {!!cablePlansQuery.data?.length && (
        <section className="card panel-card mt-3" aria-label="Rencana tarik kabel saya">
          <div className="card-header"><h2 className="h6 mb-0">Rencana tarik kabel saya</h2></div>
          <div className="list-group list-group-flush">
            {cablePlansQuery.data.map(({ id, customer, estimate }) => (
              <div className="list-group-item d-flex flex-wrap justify-content-between gap-2" key={id}>
                <div><strong>{customer}</strong><span className="d-block">{estimate.label}</span></div>
                <div>
                  <strong>{estimate.rateCents > 0 ? rupiahFromCents(estimate.totalCents) : "Tarif belum tersedia"}</strong>
                  <small className="d-block text-body-secondary">{estimate.meters.toLocaleString("id-ID")} m · Perlu survei</small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {showForm && formMode === "legacy" && (
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
              {selectedSegments.length > 0 && (
                <BookingPriceEstimate
                  lineLabel="Segmen"
                  lines={selectedSegments.map((segment) => ({
                    name: assetDetailTitle(segment),
                    cores: segmentCores[segment.id] ?? 1,
                  }))}
                  totalCores={selectedCoreCount}
                  coreRateCents={coreRateCents}
                  ratesPending={pricesQuery.isPending}
                  ratesError={pricesQuery.isError}
                  valid={validSelectedSegmentCores}
                  onRetry={() => void pricesQuery.refetch()}
                />
              )}
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
  segment: EndpointNames & { id: string; ends: Record<"A" | "B", [number, number]> | null };
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
                const name = endpointLabel(segment, side);
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

function BookingDevicePicker({
  id, label, devices, value, excludedId, onSelect,
}: {
  id: string;
  label: string;
  devices: BookingDevice[];
  value: string;
  excludedId?: string;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <label className="form-label" htmlFor={id}>{label}</label>
      <select className="form-select" id={id} value={value} onChange={(event) => onSelect(event.target.value)} required>
        <option value="">Pilih {label.toLowerCase()}</option>
        {devices.map((device) => (
          <option key={device.id} value={device.id} disabled={device.id === excludedId}>
            {device.name}{device.type ? ` · ${device.type}` : ""}
          </option>
        ))}
      </select>
    </>
  );
}

function routeMeetsSpanCounts(option: RouteOption, counts: number[]) {
  if (!option.routeKey.startsWith("verify:") || !option.segments) return option.meetsRequest;
  return option.segments.length === counts.length &&
    option.segments.every((segment, index) => counts[index] > 0 && segment.availableCores >= counts[index]);
}

function bookingSpanCounts(route: NonNullable<Booking["pathRequest"]>) {
  return route.cableIds.map((_, index) => route.spanCoreCounts?.[index] ?? route.requestedCores);
}

function describeSpanCounts(counts: number[]) {
  return counts.length && counts.every((count) => count === counts[0])
    ? `${counts[0]} core × ${counts.length} segmen`
    : `${counts.join(" + ")} core per ruas`;
}

function BookingRouteOption({
  option, index, selected, onSelect, spanCounts, onChangeSpan, startName, endName,
}: {
  option: RouteOption;
  index: number;
  selected: boolean;
  onSelect: () => void;
  spanCounts: number[];
  onChangeSpan?: (index: number, count: number) => void;
  startName?: string;
  endName?: string;
}) {
  const titleId = `booking-route-option-${index}-title`;
  const summaryId = `booking-route-option-${index}-capacity`;
  return (
    <div className={`booking-route-option${selected ? " is-selected" : ""}`}>
      <input
        id={`booking-route-option-${index}`}
        className="form-check-input mt-1"
        type="radio"
        name="bookingRoute"
        value={option.routeKey}
        checked={selected}
        onChange={onSelect}
        aria-labelledby={titleId}
        aria-describedby={summaryId}
      />
      <span className="booking-route-content">
        <span className="booking-route-heading">
          <label id={titleId} htmlFor={`booking-route-option-${index}`} className="fw-bold">Jalur {index + 1}</label>
          <span className="booking-route-distance">{(option.lengthMeters / 1000).toFixed(2)} km</span>
        </span>
        <span id={summaryId} className="booking-route-capacity">
          <strong>{option.availableCores} core tersedia</strong>
          {!routeMeetsSpanCounts(option, spanCounts) && <span>Kapasitas belum cukup · Waiting List</span>}
          {spanCounts.every((count) => count > 0) && spanCounts.length > 0 && (
            <span className="w-100">
              <strong>{spanCounts.reduce((sum, count) => sum + count, 0)} alokasi core</strong>
              {" "}({describeSpanCounts(spanCounts)})
            </span>
          )}
        </span>
        <span className="booking-route-itinerary">
          <span className="booking-route-point"><strong>Awal</strong> {startName ?? "Belum tercatat"}</span>
          {option.cableNames.map((name, segmentIndex) => {
            const segment = option.segments?.[segmentIndex];
            return (
              <span className="booking-route-leg" key={segmentIndex}>
                <span className="booking-route-cable">
                  <span>
                    <span className="booking-route-segment-label">Segmen {segmentIndex + 1}</span>
                    <strong className="d-block">{name}</strong>
                    {option.cableNames.length > 1 && (
                      <span className="booking-route-segment-capacity">
                        {segment ? `${segment.availableCores} core tersedia` : "Kapasitas belum tersedia"}
                      </span>
                    )}
                  </span>
                {selected && onChangeSpan ? (
                  <span className="booking-route-span-control">
                      <input
                        id={`booking-route-span-${index}-${segmentIndex}`}
                        className="form-control form-control-sm"
                        type="number"
                        min={1}
                        max={4096}
                        step={1}
                        required
                        value={spanCounts[segmentIndex] || ""}
                        aria-label={`Jumlah core untuk ruas ${segmentIndex + 1}`}
                        onChange={(event) => onChangeSpan(segmentIndex, Number(event.target.value))}
                      />
                    <label htmlFor={`booking-route-span-${index}-${segmentIndex}`}>core diminta</label>
                  </span>
                ) : (
                  <span>{spanCounts[segmentIndex]} core diminta</span>
                )}
                </span>
                {selected && onChangeSpan && segment && spanCounts[segmentIndex] > segment.availableCores && (
                  <small className="booking-route-span-error">Kapasitas ruas ini tidak cukup.</small>
                )}
                {segment?.midspanPoints?.map((point) => (
                  <span className="booking-route-point" key={point.id}><strong>Sambungan</strong> {point.name}</span>
                ))}
                {segmentIndex < option.cableNames.length - 1 && (
                  <span className="booking-route-point">
                    <strong>{option.plannedJunctions?.[segmentIndex] ? "Rencana terminasi" : "Terminasi"}</strong>{" "}
                    {option.intermediatePoints?.[segmentIndex] ?? "Belum tercatat"}
                  </span>
                )}
              </span>
            );
          })}
          <span className="booking-route-point"><strong>Tujuan</strong> {endName ?? "Belum tercatat"}</span>
        </span>
      </span>
    </div>
  );
}

function bookingEstimateCents(booking: Booking): number | undefined {
  const snapshot = booking.pathRequest?.priceSnapshot;
  if (!snapshot?.configured) return undefined;
  const cable = snapshot.cablePlan;
  if (cable && cable.rateCents <= 0) return undefined;
  return snapshot.totalCents + (cable?.totalCents ?? 0);
}

function formatBookingEstimate(cents: number | undefined) {
  return cents === undefined ? "Belum tersedia" : rupiahFromCents(cents);
}

function BookingRouteDetail({ booking }: { booking: Booking }) {
  const [isOpen, setIsOpen] = useState(false);
  const route = booking.pathRequest;
  if (!route) return null;

  const snapshot = route.priceSnapshot;
  const cablePlan = snapshot?.cablePlan;
  const dialogTitleId = `booking-route-title-${booking.id}`;
  const hasAllocation = booking.status === "Booked" || booking.status === "Used";
  const allocations = hasAllocation
    ? [...(route.wholeCableAllocations ?? []), ...route.allocatedSections]
    : booking.status === "Pending Approval" ? route.proposedAllocations : [];
  const spanCounts = bookingSpanCounts(route);
  const points = [
    route.startName,
    ...route.cableIds.slice(1).map((_, index) =>
      route.plannedSplices?.[index]?.nodeName ?? route.intermediateNames?.[index]
    ),
    route.endName,
  ];

  return (
    <>
      <div className="booking-path-summary">
        <strong className="d-block text-break">{route.startName} → {route.endName}</strong>
        <small className="d-block text-body-secondary mt-1">
          {(route.lengthMeters / 1000).toFixed(2)} km
        </small>
        <button
          aria-haspopup="dialog"
          className="btn btn-sm btn-outline-primary atlas-secondary-action mt-2"
          onClick={() => setIsOpen(true)}
          type="button"
        >
          Detail jalur
        </button>
      </div>
      {isOpen && (
        <ModalDialog
          labelledBy={dialogTitleId}
          className="booking-route-detail-dialog"
          onClose={() => setIsOpen(false)}
        >
          <div className="modal-heading booking-route-detail-heading">
            <div>
              <h3 id={dialogTitleId}>Detail jalur booking</h3>
              <p className="text-break">{booking.customer} · {booking.id}</p>
            </div>
            <button aria-label="Tutup detail jalur" className="btn-close" onClick={() => setIsOpen(false)} type="button" />
          </div>

          <section className="booking-route-detail-section booking-price-estimate">
            <div className="booking-price-estimate-heading">
              <div>
                <h4 className="mb-0">Estimasi saat diajukan</h4>
                <strong>{formatBookingEstimate(bookingEstimateCents(booking))}</strong>
              </div>
            </div>
            <div className="booking-price-estimate-items">
              <div className="booking-price-estimate-item">
                <div>
                  <strong>Core eksisting</strong>
                  <small className="d-block">{describeSpanCounts(spanCounts)}{snapshot?.configured && ` · ${rupiahFromCents(snapshot.coreRateCents)} per core`}</small>
                </div>
                <b>{formatBookingEstimate(snapshot?.configured ? snapshot.totalCents : undefined)}</b>
              </div>
              {cablePlan && (
                <div className="booking-price-estimate-item">
                  <div>
                    <strong>Tarik kabel baru</strong>
                    <small className="d-block">{cablePlan.label} · {cablePlan.meters.toLocaleString("id-ID", { maximumFractionDigits: 2 })} m · Perlu survei</small>
                  </div>
                  <b>{formatBookingEstimate(cablePlan.rateCents > 0 ? cablePlan.totalCents : undefined)}</b>
                </div>
              )}
            </div>
          </section>

          <section className="booking-route-detail-section" aria-labelledby={`${dialogTitleId}-segments`}>
            <div className="booking-route-detail-segment-heading">
              <h4 id={`${dialogTitleId}-segments`}>Rincian jalur</h4>
              <span>{(route.lengthMeters / 1000).toFixed(2)} km</span>
            </div>
            <ol className="booking-route-detail-segments">
              {route.cableIds.map((cableId, index) => {
                const numbers = [...new Set(allocations.filter((item) => item.cableId === cableId).map((item) => item.coreNumber))]
                  .sort((left, right) => left - right);
                const ranges = [...new Set((hasAllocation ? route.allocatedSections : route.proposedAllocations)
                  .filter((part) => part.cableId === cableId)
                  .map((part) => `${Math.round(part.startMeters)}–${Math.round(part.endMeters)} m`))];
                return (
                  <li className="booking-route-detail-segment" key={`${cableId}-${index}`}>
                    <p className="mb-1 fw-semibold text-break">{points[index] || "Belum tercatat"} → {points[index + 1] || "Belum tercatat"}</p>
                    <div className="booking-route-detail-segment-heading">
                      <strong className="text-break">Segmen {index + 1} · {route.cableNames[index] ?? cableId}</strong>
                      <span>{spanCounts[index] ?? 0} core {hasAllocation ? "dialokasikan" : "diminta"}</span>
                    </div>
                    {numbers.length > 0 && (
                      <small className="d-block text-body-secondary">
                        {hasAllocation ? "Nomor core" : "Usulan nomor core"}: {numbers.join(", ")}
                      </small>
                    )}
                    {ranges.map((range) => (
                      <small className="d-block text-body-secondary" key={range}>Posisi ruas pada kabel: {range}</small>
                    ))}
                    {!route.terminationRecorded && index < route.cableIds.length - 1 && !route.plannedSplices?.[index] && (
                      <small className="d-block text-body-secondary">Terminasi: Belum tercatat</small>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>

          {route.plannedSplices?.length ? (
            <section className="booking-route-detail-section" aria-labelledby={`${dialogTitleId}-splices`}>
              <h4 id={`${dialogTitleId}-splices`}>Rencana sambungan</h4>
              <p className="booking-route-detail-note">Belum dikonfirmasi secara fisik</p>
              <ol className="booking-route-detail-splices">
                {route.plannedSplices.map((splice, index) => (
                  <li className="text-break" key={index}>
                    <strong>{splice.nodeName}</strong>
                    <small className="d-block">{splice.from.cableName} → {splice.to.cableName}</small>
                    {Array.from({ length: Math.max(splice.from.coreNumbers.length, splice.to.coreNumbers.length) }, (_, pairIndex) => {
                      const incoming = splice.from.coreNumbers[pairIndex];
                      const outgoing = splice.to.coreNumbers[pairIndex];
                      return (
                        <small className="d-block" key={pairIndex}>
                          {incoming !== undefined && outgoing !== undefined
                            ? `Core ${incoming} → Core ${outgoing}`
                            : `Core ${incoming ?? outgoing} (${incoming === undefined ? "keluar" : "masuk"}) · Tidak dipasangkan`}
                        </small>
                      );
                    })}
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <p className="booking-route-detail-note">
              Sambungan terminasi: {route.terminationRecorded ? "Tercatat" : "Belum tercatat"}
            </p>
          )}

          <div className="modal-actions booking-route-detail-actions">
            <button className="btn btn-outline-secondary" onClick={() => setIsOpen(false)} type="button">Tutup</button>
          </div>
        </ModalDialog>
      )}
    </>
  );
}
