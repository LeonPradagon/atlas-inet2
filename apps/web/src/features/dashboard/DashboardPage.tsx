import { BookingStatusBadge } from "../core-booking/BookingStatusBadge";
import { DataTableShell } from "../../components/DataTable";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import ExcelJS from "exceljs";
import { useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { TablePagination } from "../../components/TablePagination";
import { DashboardNetworkMap } from "./DashboardNetworkMap";
import {
  type AssetRelation,
  api,
  type Booking,
} from "../../lib/api";

type CompanyOption = {
  value: string;
  name: string;
  segmentCount: number;
  lengthMeters: number;
};
type CompanySummary = {
  segmentCount: number;
  lengthMeters: number;
  provinceCount: number;
  areaCount: number;
  totalCores: number;
  verifiedCores: number;
  unverifiedCores: number;
  usedCores: number;
  bookedCores: number;
  idleCores: number;
};
type DashboardRegion = {
  area: string;
  province: string;
  segmentCount: number;
  lengthMeters: number;
};
type DashboardSegment = {
  id: string;
  name: string;
  area: string;
  province: string;
  cableType: string | null;
  lengthMeters: number;
  totalCores: number;
  usedCores: number;
  bookedCores: number;
  idleCores: number;
};

type Summary = {
  segments: number;
  totalCores: number;
  usedCores: number;
  bookedCores: number;
  waitingCount: number;
  recentBookings: Booking[];
  companyCount: number;
  companies: CompanyOption[];
  companySummary: CompanySummary;
  regions: DashboardRegion[];
  segmentTotal: number;
  page: number;
  pageSize: number;
  segmentItems: DashboardSegment[];
};
type UsageRow = {
  relatedAssets: AssetRelation[];
  id: string;
  name: string;
  area: string;
  cableType: string;
  totalCores: number;
  usedCores: number;
  availableCores: number;
  bookedCores: number;
  waitingList: number;
  installation: string;
  side: string;
  pole: string;
  poleHeight: string | null;
  odc: string;
  odp: string;
};

function downloadUsageReport(rows: UsageRow[]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Utilisasi Jaringan");
  sheet.addRows([
    [
      "ID",
      "Nama Segmen",
      "Area",
      "Tipe Kabel",
      "Total Core",
      "Used",
      "Available",
      "Booked",
      "Waiting List",
      "Metode Instalasi",
      "Sisi Jalan",
      "Nomor Tiang",
      "Tinggi Tiang",
      "ODC",
      "ODP",
      "Tiang Terkait (Tinggi)",
      "ODC Terkait",
      "ODP Terkait",
    ],
    ...rows.map((row) => [
      row.id,
      row.name,
      row.area,
      row.cableType,
      row.totalCores,
      row.usedCores,
      row.availableCores,
      row.bookedCores,
      row.waitingList,
      row.installation,
      row.side,
      row.pole,
      row.poleHeight ?? "",
      row.odc,
      row.odp,
      ...(["POLE", "ODC", "ODP"] as const).map((kind) =>
        (row.relatedAssets ?? [])
          .filter((asset) => asset.kind === kind)
          .map((asset) =>
            kind === "POLE"
              ? `${asset.name} (${asset.poleHeight ?? "Belum diketahui"})`
              : asset.name
          )
          .join("; ")
      ),
    ]),
  ]);
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF3454D1" },
  };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: "A1", to: "R1" };
  sheet.columns.forEach((column) => {
    column.width = 18;
  });
  sheet.getColumn(2).width = 38;
  sheet.getColumn(3).width = 24;
  sheet.getColumn(4).width = 22;
  void workbook.xlsx.writeBuffer().then((buffer) => {
    const url = URL.createObjectURL(
      new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "ATLAS-laporan-utilisasi-jaringan.xlsx";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

export function DashboardPage() {
  const [selectedCompany, setSelectedCompany] = useState("");
  const [segmentPage, setSegmentPage] = useState(1);
  const [segmentPageSize, setSegmentPageSize] = useState(5);
  const [regionPage, setRegionPage] = useState(1);
  const [regionPageSize, setRegionPageSize] = useState(5);
  const summary = useQuery({
    queryKey: ["dashboard", selectedCompany, segmentPage, segmentPageSize],
    queryFn: () =>
      api<Summary>(
        `/dashboard?company=${encodeURIComponent(selectedCompany)}&page=${segmentPage}&pageSize=${segmentPageSize}`
      ),
    refetchInterval: 30_000,
  });
  const exportReport = useMutation({
    meta: { successNotice: "Laporan berhasil diunduh.", errorNotice: "Tindakan gagal diproses." },

    mutationFn: () => api<UsageRow[]>("/reports/network-usage"),
    onSuccess: downloadUsageReport,
  });
  const value = summary.data;
  const companySummary = value?.companySummary;
  const visibleRegions = (value?.regions ?? []).slice(
    (regionPage - 1) * regionPageSize,
    regionPage * regionPageSize
  );
  return (
    <>
      <PageHeader
        action={
          <div className="d-flex gap-2">
            <button
              className="btn btn-outline-primary atlas-secondary-action"
              disabled={exportReport.isPending}
              onClick={() => exportReport.mutate()}
              type="button"
            >
              <i aria-hidden="true" className="bi bi-file-earmark-excel atlas-secondary-action-icon" />
              {exportReport.isPending ? "Menyiapkan..." : "Ekspor laporan"}
            </button>
            <Link className="btn btn-outline-primary atlas-secondary-action" to="/peta-jaringan">
              <i aria-hidden="true" className="bi bi-map atlas-secondary-action-icon" />
              Buka peta jaringan
            </Link>
          </div>
        }
        subtitle="Lihat sebaran perusahaan, segmen, panjang kabel, dan kapasitas jaringan."
        title="Dashboard jaringan"
      />
      {exportReport.error && (
        <div className="alert alert-danger">
          {exportReport.error instanceof Error
            ? exportReport.error.message
            : "Laporan tidak dapat diekspor."}
        </div>
      )}
      {summary.isError ? (
        <div className="alert alert-danger">
          Data ATLAS tidak dapat dimuat. Periksa koneksi backend atau sesi Anda.
        </div>
      ) : null}
      {summary.isPending ? (
        <div className="bulk-empty">
          <span className="spinner-border spinner-border-sm" /> Memuat data...
        </div>
      ) : (
        <>
          <section className="card panel-card dashboard-company-panel mb-4">
            <div className="dashboard-company-overview">
              <div className="dashboard-company-count">
                <span className="metric-icon blue"><i className="bi bi-buildings" /></span>
                <div>
                  <span className="metric-label">Perusahaan dengan segmen</span>
                  <strong>{Number(value?.companyCount ?? 0).toLocaleString("id-ID")}</strong>
                </div>
              </div>
              <div className="dashboard-company-picker">
                <label className="form-label" htmlFor="dashboard-company">Pilih perusahaan</label>
                <select
                  className="form-select"
                  id="dashboard-company"
                  onChange={(event) => {
                    setSelectedCompany(event.currentTarget.value);
                    setSegmentPage(1);
                    setRegionPage(1);
                  }}
                  value={selectedCompany}
                >
                  <option value="">Semua perusahaan</option>
                  {value?.companies.map((company) => (
                    <option key={company.value} value={company.value}>
                      {company.name} · {company.segmentCount} segmen
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <div className="row g-3 mb-4">
            <Metric color="blue" detail="pada pilihan ini" icon="bi-bezier2" label="Segmen kabel" value={Number(companySummary?.segmentCount ?? 0).toLocaleString("id-ID")} />
            <Metric color="purple" detail="panjang berdasarkan geometri" icon="bi-rulers" label="Total panjang kabel" value={formatCableLength(companySummary?.lengthMeters ?? 0)} />
            <Metric color="green" detail={`${companySummary?.areaCount ?? 0} wilayah`} icon="bi-geo-alt" label="Cakupan provinsi" value={Number(companySummary?.provinceCount ?? 0).toLocaleString("id-ID")} />
            <Metric color="orange" detail={`${companySummary?.verifiedCores ?? 0} terverifikasi · ${companySummary?.unverifiedCores ?? 0} belum diverifikasi · ${companySummary?.usedCores ?? 0} dipakai · ${companySummary?.bookedCores ?? 0} dibooking`} icon="bi-cpu" label="Core terpasang" value={Number(companySummary?.totalCores ?? 0).toLocaleString("id-ID")} />
          </div>

          <section className="card panel-card mb-4">
            <div className="card-header dashboard-card-header">
              <div>
                <h3>Peta jaringan fiber optik</h3>
                <p>{selectedCompany ? `Jalur milik ${value?.companies.find((company) => company.value === selectedCompany)?.name ?? "perusahaan terpilih"}` : "Jalur dari seluruh perusahaan"}</p>
              </div>
              <Link className="btn btn-sm btn-outline-primary atlas-secondary-action flex-shrink-0" to="/peta-jaringan">
                Buka peta jaringan
                <i aria-hidden="true" className="bi bi-arrow-right atlas-secondary-action-icon" />
              </Link>
            </div>
            <div className="card-body p-0">
              <DashboardNetworkMap company={selectedCompany} />
              <div className="dashboard-map-legend">
                <span><i className="dashboard-map-legend-line backbone" /> Backbone</span>
                <span><i className="dashboard-map-legend-line feeder" /> Feeder</span>
                <span><i className="dashboard-map-legend-line distribution" /> Distribusi</span>
                <span><i className="dashboard-map-legend-line drop" /> Drop</span>
                <span><i className="dashboard-map-legend-line submarine" /> Submarine</span>
                <span><i className="dashboard-map-legend-line other" /> Lainnya / belum diklasifikasi</span>
              </div>
            </div>
          </section>

          <section className="card panel-card mb-4">
            <div className="card-header dashboard-card-header">
              <div>
                <h3>Daftar segmen kabel</h3>
                <p>Wilayah, provinsi, panjang kabel, dan utilisasi core</p>
              </div>
              <Link className="btn btn-sm btn-outline-primary atlas-secondary-action flex-shrink-0" to="/peta-jaringan">
                Buka peta jaringan
                <i aria-hidden="true" className="bi bi-arrow-right atlas-secondary-action-icon" />
              </Link>
            </div>
            <div className="card-body p-0">
              <DataTableShell label="Daftar segmen perusahaan">
                <table className="table table-hover atlas-data-table mb-0">
                  <thead>
                    <tr><th>Segmen</th><th>Wilayah</th><th>Provinsi</th><th>Panjang</th><th>Core</th><th>Utilisasi</th></tr>
                  </thead>
                  <tbody>
                    {value?.segmentItems.map((segment) => {
                      const percent = segment.totalCores
                        ? Math.round(((segment.usedCores + segment.bookedCores) / segment.totalCores) * 100)
                        : 0;
                      return (
                        <tr key={segment.id}>
                          <td>
                            <Link className="cable-name" to="/peta-jaringan">{segment.name}</Link>
                            <small className="d-block text-body-secondary">{segment.cableType || "Tipe kabel belum dicatat"}</small>
                          </td>
                          <td>{segment.area}</td>
                          <td>{segment.province}</td>
                          <td className="text-nowrap">{formatCableLength(segment.lengthMeters)}</td>
                          <td className="text-nowrap">
                            <b>{segment.totalCores}</b>
                            <small className="d-block text-body-secondary">{segment.usedCores} dipakai · {segment.bookedCores} dibooking · {segment.idleCores} tersedia</small>
                          </td>
                          <td>
                            <div className="util-cell">
                              <div className="progress"><div className="progress-bar" style={{ width: `${percent}%` }} /></div>
                              <span>{percent}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </DataTableShell>
              {!value?.segmentTotal && (
                <div className="bulk-empty">
                  <b>Belum ada segmen untuk pilihan ini</b>
                  <span>Impor jaringan atau pilih perusahaan lain untuk melihat detail.</span>
                </div>
              )}
              <TablePagination label="segmen" onPageChange={setSegmentPage} onPageSizeChange={(size) => { setSegmentPageSize(size); setSegmentPage(1); }} page={segmentPage} pageSize={segmentPageSize} total={value?.segmentTotal ?? 0} />
            </div>
          </section>

          <div className="row g-4">
            <div className="col-xl-7">
              <section className="card panel-card h-100">
                <div className="card-header dashboard-card-header">
                  <div><h3>Sebaran wilayah</h3><p>Area dengan jumlah segmen terbanyak</p></div>
                </div>
                <div className="card-body p-0">
                  {value?.regions.length ? (
                    <>
                      <DataTableShell label="Sebaran segmen per wilayah">
                        <table className="table table-hover atlas-data-table mb-0">
                          <thead><tr><th>Wilayah</th><th>Provinsi</th><th>Segmen</th><th>Panjang kabel</th></tr></thead>
                          <tbody>{visibleRegions.map((region) => (
                            <tr key={`${region.province}:${region.area}`}>
                              <td>{region.area}</td><td>{region.province}</td>
                              <td>{Number(region.segmentCount).toLocaleString("id-ID")}</td>
                              <td className="text-nowrap">{formatCableLength(region.lengthMeters)}</td>
                            </tr>
                          ))}</tbody>
                        </table>
                      </DataTableShell>
                      <TablePagination label="wilayah" onPageChange={setRegionPage} onPageSizeChange={(size) => { setRegionPageSize(size); setRegionPage(1); }} page={regionPage} pageSize={regionPageSize} total={value.regions.length} />
                    </>
                  ) : <div className="bulk-empty"><b>Belum ada sebaran wilayah</b></div>}
                </div>
              </section>
            </div>
            <div className="col-xl-5">
              <section className="card panel-card h-100">
                <div className="card-header dashboard-card-header">
                  <div><h3>Aktivitas booking</h3><p>Permintaan terbaru</p></div>
                  <Link aria-label="Kelola booking core" className="btn btn-sm btn-outline-primary atlas-secondary-action flex-shrink-0" to="/booking-core">
                    Kelola<i aria-hidden="true" className="bi bi-arrow-right atlas-secondary-action-icon" />
                  </Link>
                </div>
                <div className="card-body p-0">
                  {value?.recentBookings.map((booking) => (
                    <div className="activity-row" key={booking.id}>
                      <div className="booking-activity-info">
                        <b>{booking.customer}</b>
                        <small className="d-flex flex-wrap column-gap-3">
                          <span>{booking.cores} core</span>
                          <time dateTime={booking.requestedAt}>{new Date(booking.requestedAt).toLocaleDateString("id-ID")}</time>
                        </small>
                      </div>
                      <BookingStatusBadge status={booking.status} />
                    </div>
                  ))}
                  {!value?.recentBookings.length && <div className="bulk-empty"><b>Belum ada permintaan</b><span>Booking baru akan muncul di sini.</span></div>}
                </div>
              </section>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function Metric({
  icon,
  label,
  value,
  color,
  detail,
}: {
  icon: string;
  label: string;
  value: string;
  color: string;
  detail: string;
}) {
  return (
    <div className="col-sm-6 col-xl-3">
      <div className="metric-card">
        <span className={`metric-icon ${color}`}>
          <i className={`bi ${icon}`} />
        </span>
        <div>
          <span className="metric-label">{label}</span>
          <strong>{value}</strong>
          <small>{detail}</small>
        </div>
      </div>
    </div>
  );
}

function formatCableLength(meters: number) {
  if (!Number.isFinite(meters)) return "—";
  return meters >= 1000
    ? `${(meters / 1000).toLocaleString("id-ID", { maximumFractionDigits: 2 })} km`
    : `${Math.round(meters).toLocaleString("id-ID")} m`;
}
