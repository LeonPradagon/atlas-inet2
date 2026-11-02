import { Link } from '@tanstack/react-router'
import ExcelJS from 'exceljs'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { TablePagination } from '../../components/TablePagination'
import { api, type AssetRelation, type Booking, type NetworkAsset } from '../../lib/api'

const dashboardPageSize = 5

type Summary = { segments: number; totalCores: number; usedCores: number; bookedCores: number; waitingCount: number; recentBookings: Booking[]; topSegments: NetworkAsset[] }
type UsageRow = { relatedAssets: AssetRelation[]; id: string; name: string; area: string; cableType: string; totalCores: number; usedCores: number; availableCores: number; bookedCores: number; waitingList: number; installation: string; side: string; pole: string; poleHeight: string | null; odc: string; odp: string }

function downloadUsageReport(rows: UsageRow[]) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Utilisasi Jaringan')
  sheet.addRows([
    ['ID', 'Nama Segmen', 'Area', 'Tipe Kabel', 'Total Core', 'Used', 'Available', 'Booked', 'Waiting List', 'Metode Instalasi', 'Sisi Jalan', 'Nomor Tiang', 'Tinggi Tiang', 'ODC', 'ODP', 'Tiang Terkait (Tinggi)', 'ODC Terkait', 'ODP Terkait'],
    ...rows.map((row) => [row.id,row.name,row.area,row.cableType,row.totalCores,row.usedCores,row.availableCores,row.bookedCores,row.waitingList,row.installation,row.side,row.pole,row.poleHeight ?? '',row.odc,row.odp, ...(['POLE','ODC','ODP'] as const).map((kind) => (row.relatedAssets ?? []).filter((asset) => asset.kind === kind).map((asset) => kind === 'POLE' ? `${asset.name} (${asset.poleHeight ?? 'Belum diketahui'})` : asset.name).join('; '))]),
  ])
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3454D1' } }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  sheet.autoFilter = { from: 'A1', to: 'R1' }
  sheet.columns.forEach((column) => { column.width = 18 })
  sheet.getColumn(2).width = 38
  sheet.getColumn(3).width = 24
  sheet.getColumn(4).width = 22
  void workbook.xlsx.writeBuffer().then((buffer) => {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = 'ATLAS-laporan-utilisasi-jaringan.xlsx'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
}

export function DashboardPage() {
  const summary = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Summary>('/dashboard'), refetchInterval: 30_000 })
  const exportReport = useMutation({ mutationFn: () => api<UsageRow[]>('/reports/network-usage'), onSuccess: downloadUsageReport })
  const [segmentPage, setSegmentPage] = useState(1)
  const value = summary.data
  const visibleSegments = value?.topSegments.slice((segmentPage - 1) * dashboardPageSize, segmentPage * dashboardPageSize) ?? []
  const format = (date: Date) => new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date)
  return <>
    <PageHeader title="Ringkasan jaringan" subtitle="Pantau kondisi aset dan utilisasi core jaringan Anda." action={<div className="d-flex gap-2"><button className="btn btn-outline-primary" onClick={() => exportReport.mutate()} disabled={exportReport.isPending}><i className="bi bi-file-earmark-excel me-2" />{exportReport.isPending ? 'Menyiapkan...' : 'Ekspor laporan'}</button><Link to="/peta-jaringan" className="btn btn-primary"><i className="bi bi-map me-2" />Buka peta jaringan</Link></div>} />
    {exportReport.error && <div className="alert alert-danger">{exportReport.error instanceof Error ? exportReport.error.message : 'Laporan tidak dapat diekspor.'}</div>}
    <div className="welcome-banner mb-4"><div><span className="eyebrow">{format(new Date()).toLocaleUpperCase('id-ID')}</span><h2>Ringkasan ATLAS</h2><p>Informasi aset dan booking yang tersimpan.</p></div><div className="welcome-art"><i className="bi bi-broadcast-pin" /><span /><span /></div></div>
    {summary.isError ? <div className="alert alert-danger">Data ATLAS tidak dapat dimuat. Periksa koneksi backend atau sesi Anda.</div> : null}
    {summary.isPending ? <div className="bulk-empty"><span className="spinner-border spinner-border-sm" /> Memuat data...</div> : <>
      <div className="row g-3 mb-4">
        <Metric icon="bi-bezier2" label="Segmen jaringan" value={String(value?.segments ?? 0)} color="blue" detail="aset tersimpan" />
        <Metric icon="bi-cpu" label="Total core terpasang" value={Number(value?.totalCores ?? 0).toLocaleString('id-ID')} color="purple" detail="dari seluruh segmen" />
        <Metric icon="bi-activity" label="Core digunakan" value={String(value?.usedCores ?? 0)} color="green" detail="status Used" />
        <Metric icon="bi-hourglass-split" label="Menunggu alokasi" value={String(value?.waitingCount ?? 0)} color="orange" detail="permintaan waiting list" />
      </div>
      <div className="row g-4">
        <div className="col-xl-8"><section className="card panel-card h-100"><div className="card-header dashboard-card-header"><div><h3>Utilisasi core per segmen</h3><p>Core terpakai dan booking aktif</p></div><Link to="/peta-jaringan" className="text-link">Lihat semua <i className="bi bi-arrow-right" /></Link></div><div className="card-body p-0"><div className="table-responsive"><table className="table atlas-table mb-0"><thead><tr><th>Nama kabel</th><th>Area</th><th>Terpakai</th><th>Booked</th><th>Tersedia</th><th>Utilisasi</th></tr></thead><tbody>{visibleSegments.map((asset) => { const percent = asset.totalCores ? Math.round((asset.usedCores + asset.bookedCores) / asset.totalCores * 100) : 0; return <tr key={asset.id}><td><Link to="/peta-jaringan" className="cable-name">{asset.name}</Link><small className="d-block text-muted">{asset.cableType}</small></td><td>{asset.area || '—'}</td><td>{asset.usedCores}</td><td>{asset.bookedCores}</td><td>{asset.idleCores}</td><td><div className="util-cell"><div className="progress"><div className="progress-bar" style={{ width: `${percent}%` }} /></div><span>{percent}%</span></div></td></tr> })}</tbody></table></div>{!value?.topSegments.length && <div className="bulk-empty"><b>Belum ada aset jaringan</b><span>Impor KML/KMZ dari halaman peta jaringan untuk memulai.</span></div>}<TablePagination page={segmentPage} pageSize={dashboardPageSize} total={value?.topSegments.length ?? 0} label="segmen" onPageChange={setSegmentPage} /></div></section></div>
        <div className="col-xl-4"><section className="card panel-card h-100"><div className="card-header dashboard-card-header"><div><h3>Aktivitas booking</h3><p>Permintaan terbaru</p></div><Link to="/booking-core" className="text-link">Kelola <i className="bi bi-arrow-right" /></Link></div><div className="card-body p-0">{value?.recentBookings.map((booking) => <div className="activity-row" key={booking.id}><span className={`activity-icon ${booking.status === 'Booked' ? 'booked' : 'waiting'}`}><i className={`bi ${booking.status === 'Booked' ? 'bi-check2' : 'bi-clock'}`} /></span><div className="flex-grow-1"><b>{booking.customer}</b><small>{booking.cores} core · {new Date(booking.requestedAt).toLocaleDateString('id-ID')}</small></div><span className="badge rounded-pill text-bg-light">{booking.status}</span></div>)}{!value?.recentBookings.length && <div className="bulk-empty"><b>Belum ada permintaan</b><span>Booking baru akan muncul di sini.</span></div>}</div></section></div>
      </div>
      <div className="quick-actions mt-4"><div><h3>Akses cepat</h3><p>Mulai pekerjaan Anda dengan cepat.</p></div><Link to="/analisis-alamat" className="quick-action"><span className="quick-icon blue"><i className="bi bi-geo-alt" /></span><span><b>Analisis alamat</b><small>Temukan jaringan terdekat</small></span><i className="bi bi-arrow-up-right ms-auto" /></Link><Link to="/analisis-massal" className="quick-action"><span className="quick-icon green"><i className="bi bi-file-earmark-spreadsheet" /></span><span><b>Analisis massal</b><small>Proses banyak lokasi</small></span><i className="bi bi-arrow-up-right ms-auto" /></Link><Link to="/booking-core" className="quick-action"><span className="quick-icon purple"><i className="bi bi-diagram-3" /></span><span><b>Booking core</b><small>Kelola permintaan core</small></span><i className="bi bi-arrow-up-right ms-auto" /></Link></div>
    </>}
  </>
}

function Metric({ icon, label, value, color, detail }: { icon: string; label: string; value: string; color: string; detail: string }) {
  return <div className="col-sm-6 col-xl-3"><div className="metric-card"><span className={`metric-icon ${color}`}><i className={`bi ${icon}`} /></span><div><span className="metric-label">{label}</span><strong>{value}</strong><small>{detail}</small></div></div></div>
}
