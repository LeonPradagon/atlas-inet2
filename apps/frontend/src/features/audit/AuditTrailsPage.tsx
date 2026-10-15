import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { api, ApiError } from '../../lib/api'

type User = { role: string }
type AuditEntry = {
  id: number
  action: string
  entityType: string
  entityId: string | null
  details: Record<string, unknown>
  createdAt: string
  actorName: string | null
  actorEmail: string | null
}

const actionLabels: Record<string, string> = {
  WAITING_LIST_ALLOCATED: 'Waiting list dialokasikan',
  ASSET_RELATIONS_UPDATED: 'Relasi aset diperbarui',
  ASSET_UPDATED: 'Aset diperbarui',
  BOOKING_CREATED: 'Booking dibuat',
  BOOKING_RELEASED: 'Booking dilepas',
  BOOKING_EXPIRED: 'Booking kedaluwarsa',
  BOOKING_DURATION_UPDATED: 'Durasi booking diubah',
  CABLE_NAME_PATTERN_UPDATED: 'Aturan nama kabel diubah',
  CORE_STATUS_CHANGED: 'Status core diubah',
  NETWORK_IMPORTED: 'Jaringan diimpor',
  USER_CREATED: 'Akun dibuat',
  FTTH_ASSET_CREATED: 'Aset FTTH dibuat',
  FTTH_DESIGN_CREATED: 'Draft FTTH disimpan',
  NOTIFICATION_READ: 'Notifikasi dibaca',
  ADDRESS_ANALYSIS_COMPLETED: 'Analisis alamat dijalankan',
  BULK_ANALYSIS_COMPLETED: 'Analisis massal dijalankan',
  ANALYSIS_HISTORY_DELETED: 'Riwayat analisis dihapus',
  ROUTE_PREVIEW_COMPLETED: 'Pratinjau rute dijalankan',
  FTTH_ROUTE_PREVIEW_COMPLETED: 'Pratinjau rute FTTH dijalankan',
  LOGIN_SUCCEEDED: 'Login berhasil',
  LOGIN_FAILED: 'Login gagal',
  LOGOUT_SUCCEEDED: 'Logout',
  API_REQUEST: 'Aktivitas aplikasi',
  API_REQUEST_FAILED: 'Permintaan gagal',
}

function formatDetails(details: AuditEntry['details']) {
  return Object.entries(details ?? {}).filter(([key]) => key !== 'statusCode').map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ') || '—'
}

function httpStatus(details: AuditEntry['details']) {
  const value = Number(details?.statusCode)
  if (!Number.isInteger(value) || value < 100 || value > 599) return null
  return { code: value, label: value >= 500 ? 'Kesalahan server' : value >= 400 ? 'Gagal' : 'Berhasil', tone: value >= 500 ? 'text-bg-danger' : value >= 400 ? 'text-bg-warning' : 'text-bg-success' }
}

export function AuditTrailsPage() {
  const [search, setSearch] = useState('')
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<User>('/me') })
  const audit = useQuery({
    queryKey: ['audit-trails', search],
    queryFn: () => api<AuditEntry[]>(`/audit-trails?limit=250${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`),
    enabled: me.data?.role === 'ADMIN',
    refetchInterval: 30_000,
  })
  const error = audit.error instanceof ApiError ? audit.error.message : 'Audit trail tidak dapat dimuat.'

  return <>
    <PageHeader title="Audit Trails" subtitle="Riwayat aktivitas penggunaan, analisis, jaringan, booking, dan akun." />
    {me.isLoading ? <div className="card panel-card"><div className="card-body py-5 text-center"><span className="spinner-border spinner-border-sm me-2" />Memeriksa akses...</div></div>
      : me.data?.role !== 'ADMIN' ? <div className="alert alert-warning"><i className="bi bi-lock me-2" />Halaman ini hanya tersedia untuk ADMIN.</div>
        : <section className="card panel-card">
          <div className="card-header audit-header d-flex justify-content-between align-items-start"><div><h3>Riwayat aktivitas</h3><p>Aktivitas penting dicatat server beserta waktu dan pengguna yang menjalankannya.</p></div><button className="btn btn-sm btn-outline-primary ms-auto flex-shrink-0" onClick={() => void audit.refetch()} disabled={audit.isFetching}><i className={`bi bi-arrow-clockwise me-1${audit.isFetching ? ' spin' : ''}`} />{audit.isFetching ? 'Memuat...' : 'Muat ulang'}</button></div>
          <div className="card-body border-bottom">
            <label htmlFor="audit-search" className="visually-hidden">Cari aktivitas</label>
            <div className="input-group"><span className="input-group-text bg-white"><i className="bi bi-search" /></span><input id="audit-search" className="form-control" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari aksi, objek, atau pengguna" /></div>
          </div>
          {audit.isPending ? <div className="py-5 text-center"><span className="spinner-border spinner-border-sm me-2" />Memuat riwayat...</div>
            : audit.isError ? <div className="alert alert-danger m-3"><i className="bi bi-exclamation-circle me-2" />{error}</div>
              : !audit.data?.length ? <div className="empty-result py-5"><div className="empty-illustration"><i className="bi bi-journal-text" /></div><h3>Belum ada aktivitas tercatat</h3><p>Audit Trails mencatat aktivitas penggunaan aplikasi, analisis, perubahan jaringan, booking, dan akun. Aktivitas sebelum pencatatan diaktifkan tidak tersedia di sini.</p></div>
                : <div className="table-responsive"><table className="table align-middle mb-0 audit-table"><thead><tr><th>WAKTU</th><th>PENGGUNA</th><th>AKTIVITAS</th><th>OBJEK</th><th>RINCIAN</th></tr></thead><tbody>
                  {audit.data.map((entry) => <tr key={entry.id}>
                    {(() => { const status = httpStatus(entry.details); return <>
                    <td className="text-nowrap">{new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(entry.createdAt))}</td>
                    <td><b>{entry.actorName ?? 'Sistem'}</b><small className="d-block text-secondary">{entry.actorEmail ?? 'Proses otomatis'}</small></td>
                    <td><span className="badge text-bg-light border">{actionLabels[entry.action] ?? entry.action}</span>{status && <small className="d-block mt-1"><span className={`badge ${status.tone}`}>HTTP {status.code} · {status.label}</span></small>}</td>
                    <td><b>{entry.entityType}</b><small className="d-block text-secondary text-break">{entry.entityId ?? '—'}</small></td>
                    <td className="audit-details">{formatDetails(entry.details)}</td>
                    </> })()}
                  </tr>)}
                </tbody></table></div>}
          <div className="card-footer text-secondary small">Menampilkan maksimum 250 aktivitas terbaru.</div>
        </section>}
  </>
}
