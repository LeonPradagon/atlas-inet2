import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { api, postJson, networkQueryKeys, type Booking, type NetworkAsset } from '../../lib/api'

export function CoreBookingPage() {
  const { bookingId } = useSearch({ from: '/booking-core' })
  const queryClient = useQueryClient()
  const invalidateNetwork = () => Promise.all(networkQueryKeys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
  const [toast, setToast] = useState('')
  const [showForm, setShowForm] = useState(false)
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => api<{ role: string }>('/me') })
  const { data: duration } = useQuery({ queryKey: ['booking-duration'], queryFn: () => api<{ days: number }>('/settings/booking-duration') })
  const bookingDays = duration?.days ?? 30
  const [newDuration, setNewDuration] = useState(30)
  const [editDuration, setEditDuration] = useState(false)
  const [filter, setFilter] = useState<'Semua' | Booking['status']>('Semua')
  const { data: bookings = [], isPending, isError } = useQuery({ queryKey: ['bookings'], queryFn: () => api<Booking[]>('/bookings'), refetchInterval: 30_000 })
  const { data: networkSegments = [] } = useQuery({ queryKey: ['segments'], queryFn: () => api<NetworkAsset[]>('/assets'), refetchInterval: 30_000 })
  const release = useMutation({ mutationFn: (booking: Booking) => api<{ released: string; allocated: string | null; allocatedBookingIds: string[] }>(`/bookings/${booking.id}/release`, { method: 'POST' }), onSuccess: async (result, booking) => {
    await invalidateNetwork()
    setToast(result.allocated ? `Booking dilepas dan ${result.allocatedBookingIds.length} permintaan waiting list dialokasikan.` : `Booking ${booking.id} dilepas.`)
    window.setTimeout(() => setToast(''), 4500)
  }, onError: (error) => setToast(error instanceof Error ? error.message : 'Booking tidak dapat dilepas.') })
  const approve = useMutation({ mutationFn: (booking: Booking) => api<{ id: string; status: Booking['status'] }>(`/bookings/${booking.id}/approve`, { method: 'POST' }), onSuccess: async (result, booking) => {
    await invalidateNetwork()
    setToast(result.status === 'Booked' ? `Booking ${booking.id} disetujui dan core dialokasikan.` : `Booking ${booking.id} disetujui dan masuk waiting list.`); window.setTimeout(() => setToast(''), 4500)
  }, onError: (error) => setToast(error instanceof Error ? error.message : 'Booking tidak dapat disetujui.') })
  const reject = useMutation({ mutationFn: (booking: Booking) => api<{ id: string; status: Booking['status'] }>(`/bookings/${booking.id}/reject`, { method: 'POST' }), onSuccess: async (_result, booking) => {
    await queryClient.invalidateQueries({ queryKey: ['bookings'] })
    setToast(`Permintaan booking ${booking.id} ditolak.`); window.setTimeout(() => setToast(''), 4500)
  }, onError: (error) => setToast(error instanceof Error ? error.message : 'Booking tidak dapat ditolak.') })
  const create = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Booking>('/bookings', { ...postJson(body) }), onSuccess: async (booking) => {
    await invalidateNetwork()
    setShowForm(false); setToast(`Booking ${booking.id} diajukan dan menunggu persetujuan ADMIN.`); window.setTimeout(() => setToast(''), 4500)
  }, onError: (error) => setToast(error instanceof Error ? error.message : 'Booking tidak dapat dibuat.') })
  const updateDuration = useMutation({ mutationFn: (days: number) => api<{ days: number }>('/settings/booking-duration', { method: 'PATCH', data: { days } }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['booking-duration'] }); setEditDuration(false) }, onError: (error) => setToast(error instanceof Error ? error.message : 'Durasi tidak dapat disimpan.') })
  const waiting = bookings.filter((item) => item.status === 'Waiting List').sort((a, b) => Date.parse(a.approvedAt ?? a.requestedAt) - Date.parse(b.approvedAt ?? b.requestedAt) || a.id.localeCompare(b.id))
  const filtered = bookings.filter((item) => filter === 'Semua' || item.status === filter)
  const bookableSegments = networkSegments.filter((segment) => segment.assetType === 'segment' && segment.totalCores > 0)
  const bookedCount = bookings.filter((item) => item.status === 'Booked').length
  const waitingCount = bookings.filter((item) => item.status === 'Waiting List').length
  const pendingApprovalCount = bookings.filter((item) => item.status === 'Pending Approval').length
  useEffect(() => { if (bookingId) setFilter('Semua') }, [bookingId])
  useEffect(() => {
    if (bookingId && filter === 'Semua' && !isPending) document.getElementById(`booking-${bookingId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [bookingId, filter, bookings, isPending])
  const addBooking = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const segmentId = String(form.get('segmentId'))
    const cores = Number(form.get('cores'))
    create.mutate({ customer: String(form.get('customer')), picCustomer: String(form.get('picCustomer')), picPresales: String(form.get('picPresales')), segmentId, cores })
  }
  return <>
    <PageHeader title="Booking core" subtitle="Ajukan booking untuk persetujuan ADMIN; kapasitas dialokasikan setelah disetujui." action={<button className="btn btn-primary" onClick={() => setShowForm(true)}><i className="bi bi-plus-lg me-2" />Buat booking</button>} />
    {toast && <div className="toast-banner" role="status"><i className="bi bi-check-circle-fill" />{toast}<button onClick={() => setToast('')} aria-label="Tutup"><i className="bi bi-x-lg" /></button></div>}
    <div className="row g-3 mb-4"><div className="col-sm-6 col-xl-3"><BookingMetric label="Booking aktif" value={String(bookedCount)} icon="bi-bookmark-check" tone="blue" /></div><div className="col-sm-6 col-xl-3"><BookingMetric label="Waiting list" value={String(waitingCount)} icon="bi-hourglass" tone="orange" /></div><div className="col-sm-6 col-xl-3"><div className="metric-card compact"><span className="metric-icon purple"><i className="bi bi-calendar2-check" /></span><div className="flex-grow-1"><span className="metric-label">Masa booking sementara</span>{editDuration ? <div className="d-flex align-items-center gap-2"><input aria-label="Durasi booking (hari)" className="form-control form-control-sm duration-input" type="number" min="1" max="365" value={newDuration} onChange={(event) => setNewDuration(Math.max(1, Math.min(365, Number(event.target.value) || 1)))} /><button className="btn btn-sm btn-primary py-1" onClick={() => updateDuration.mutate(newDuration)} disabled={updateDuration.isPending}>Simpan</button></div> : <div className="d-flex align-items-center gap-2"><strong>{bookingDays} hari</strong>{user?.role === 'ADMIN' && <button className="btn btn-sm btn-link p-0 duration-edit" aria-label="Ubah durasi booking" title="Ubah durasi booking" onClick={() => { setNewDuration(bookingDays); setEditDuration(true) }}><i className="bi bi-pencil-square" /></button>}</div>}</div></div></div><div className="col-sm-6 col-xl-3"><BookingMetric label="Segmen tersedia" value={String(bookableSegments.length)} icon="bi-bezier2" tone="green" /></div></div>
    {isError && <div className="alert alert-danger">Data booking tidak dapat dimuat.</div>}{isPending ? <div className="bulk-empty">Memuat booking...</div>  : <section className="card panel-card"><div className="card-header booking-request-header"><div><h3>Permintaan core</h3><p>Booking baru menunggu persetujuan ADMIN. Booking yang disetujui langsung dialokasikan atau masuk antrean kapasitas.</p></div><div className="filter-tabs">{(['Semua', 'Pending Approval', 'Booked', 'Waiting List', 'Rejected'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'Semua' ? 'Semua' : bookingStatusLabel(value)}{value === 'Pending Approval' && <span>{pendingApprovalCount}</span>}{value === 'Waiting List' && <span>{waitingCount}</span>}</button>)}</div></div><div className="table-responsive"><table className="table atlas-table booking-table mb-0"><thead><tr><th>ID / Pelanggan</th><th>Segmen</th><th>Jumlah core</th><th>PIC customer</th><th>PIC presales</th><th>Status</th><th>Permintaan</th><th>Aksi</th></tr></thead><tbody>{filtered.map((booking) => <tr id={`booking-${booking.id}`} key={booking.id} className={bookingId === booking.id ? 'table-primary' : undefined}><td><b className="booking-id">{booking.id}</b><small className="d-block text-muted">{booking.customer}</small></td><td><span className="cable-name">{booking.segmentName}</span><small className="d-block text-muted">{booking.area}</small>{booking.status === 'Waiting List' && <small className="d-block text-warning">Antrean #{waiting.filter((item) => item.segmentId === booking.segmentId).findIndex((item) => item.id === booking.id) + 1} pada segmen</small>}</td><td><b>{booking.cores} core</b></td><td>{booking.picCustomer}</td><td>{booking.picPresales}</td><td><span className={`status-pill ${bookingStatusClass(booking.status)}`}><i className={`bi ${bookingStatusIcon(booking.status)}`} />{bookingStatusLabel(booking.status)}</span></td><td className="text-muted">{new Date(booking.requestedAt).toLocaleDateString('id-ID')}</td><td className="text-nowrap">{user?.role === 'ADMIN' && booking.status === 'Pending Approval' && <><button className="btn btn-sm btn-success me-1" onClick={() => approve.mutate(booking)} disabled={approve.isPending || reject.isPending}>Setujui</button><button className="btn btn-sm btn-outline-danger" onClick={() => { if (window.confirm(`Tolak permintaan booking ${booking.id}?`)) reject.mutate(booking) }} disabled={approve.isPending || reject.isPending}>Tolak</button></>}{booking.status === 'Booked' && <button className="btn btn-sm btn-outline-secondary" onClick={() => release.mutate(booking)} disabled={release.isPending}>Release</button>}</td></tr>)}</tbody></table></div>{filtered.length === 0 && <div className="bulk-empty"><b>Tidak ada permintaan</b><span>Coba pilih filter lain.</span></div>}</section>}
    {showForm && <div className="modal-backdrop-custom" role="presentation" onClick={() => setShowForm(false)}><section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><h3 id="booking-title">Buat booking core</h3><p>Permintaan akan menunggu persetujuan ADMIN.</p></div><button className="btn-close" onClick={() => setShowForm(false)} aria-label="Tutup" /></div><form onSubmit={addBooking}>{!bookableSegments.length && <div className="alert alert-info">Belum ada segmen dengan kapasitas core. ADMIN perlu mengisi kapasitas pada halaman peta jaringan.</div>}<label className="form-label">Nama pelanggan</label><input className="form-control mb-3" name="customer" required placeholder="Nama perusahaan" /><label className="form-label">Segmen jaringan</label><select className="form-select mb-3" name="segmentId" required>{bookableSegments.map((segment) => <option value={segment.id} key={segment.id}>{segment.name} · {segment.idleCores} core tersedia</option>)}</select><div className="row g-3"><div className="col-6"><label className="form-label">Jumlah core</label><input className="form-control" name="cores" type="number" min="1" defaultValue="2" required /></div><div className="col-6"><label className="form-label">PIC customer</label><input className="form-control" name="picCustomer" required placeholder="Nama PIC" /></div></div><label className="form-label mt-3">PIC presales</label><input className="form-control" name="picPresales" required placeholder="Nama PIC presales" /><div className="modal-actions"><button type="button" className="btn btn-light" onClick={() => setShowForm(false)}>Batal</button><button className="btn btn-primary" disabled={create.isPending || !bookableSegments.length}><i className="bi bi-check2 me-2" />Simpan booking</button></div></form></section></div>}
  </>
}

function bookingStatusLabel(status: Booking['status']) {
  return ({ 'Pending Approval': 'Menunggu Persetujuan', Booked: 'Aktif', 'Waiting List': 'Waiting List', Rejected: 'Ditolak', Released: 'Dilepas', Expired: 'Kedaluwarsa' })[status]
}

function bookingStatusClass(status: Booking['status']) {
  return ({ 'Pending Approval': 'is-pending', Booked: 'is-booked', 'Waiting List': 'is-waiting', Rejected: 'is-rejected', Released: 'is-released', Expired: 'is-released' })[status]
}

function bookingStatusIcon(status: Booking['status']) {
  return ({ 'Pending Approval': 'bi-hourglass-split', Booked: 'bi-check-circle-fill', 'Waiting List': 'bi-clock-fill', Rejected: 'bi-x-circle-fill', Released: 'bi-arrow-counterclockwise', Expired: 'bi-calendar-x' })[status]
}

function BookingMetric({ label, value, icon, tone }: { label: string; value: string; icon: string; tone: string }) {
  return <div className="metric-card compact"><span className={`metric-icon ${tone}`}><i className={`bi ${icon}`} /></span><div><span className="metric-label">{label}</span><strong>{value}</strong></div></div>
}
