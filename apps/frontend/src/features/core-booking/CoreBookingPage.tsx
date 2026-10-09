import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { api, postJson, type Booking, type NetworkAsset } from '../../lib/api'

export function CoreBookingPage() {
  const queryClient = useQueryClient()
  const [toast, setToast] = useState('')
  const [showForm, setShowForm] = useState(false)
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => api<{ role: string }>('/me') })
  const { data: duration } = useQuery({ queryKey: ['booking-duration'], queryFn: () => api<{ days: number }>('/settings/booking-duration') })
  const bookingDays = duration?.days ?? 30
  const [newDuration, setNewDuration] = useState(30)
  const [editDuration, setEditDuration] = useState(false)
  const [filter, setFilter] = useState<'Semua' | 'Booked' | 'Waiting List'>('Semua')
  const { data: bookings = [], isPending, isError } = useQuery({ queryKey: ['bookings'], queryFn: () => api<Booking[]>('/bookings') })
  const { data: networkSegments = [] } = useQuery({ queryKey: ['segments'], queryFn: () => api<NetworkAsset[]>('/assets') })
  const release = useMutation({ mutationFn: (booking: Booking) => api<{ released: string; allocated: string | null }>(`/bookings/${booking.id}/release`, { method: 'POST' }), onSuccess: async (result, booking) => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['bookings'] }), queryClient.invalidateQueries({ queryKey: ['segments'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })])
    setToast(result.allocated ? `Booking dilepas dan waiting list ${result.allocated} dialokasikan.` : `Booking ${booking.id} dilepas.`)
    window.setTimeout(() => setToast(''), 4500)
  }, onError: (error) => setToast(error instanceof Error ? error.message : 'Booking tidak dapat dilepas.') })
  const create = useMutation({ mutationFn: (body: Record<string, unknown>) => api<Booking>('/bookings', { ...postJson(body) }), onSuccess: async (booking) => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['bookings'] }), queryClient.invalidateQueries({ queryKey: ['segments'] }), queryClient.invalidateQueries({ queryKey: ['dashboard'] })])
    setShowForm(false); setToast(booking.status === 'Booked' ? `Booking ${booking.id} berhasil dibuat.` : `${booking.id} masuk waiting list.`); window.setTimeout(() => setToast(''), 3500)
  }, onError: (error) => setToast(error instanceof Error ? error.message : 'Booking tidak dapat dibuat.') })
  const updateDuration = useMutation({ mutationFn: (days: number) => api<{ days: number }>('/settings/booking-duration', { method: 'PATCH', data: { days } }), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['booking-duration'] }); setEditDuration(false) }, onError: (error) => setToast(error instanceof Error ? error.message : 'Durasi tidak dapat disimpan.') })
  const filtered = bookings.filter((item) => filter === 'Semua' || item.status === filter)
  const bookedCount = bookings.filter((item) => item.status === 'Booked').length
  const waitingCount = bookings.filter((item) => item.status === 'Waiting List').length
  const addBooking = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const segmentId = String(form.get('segmentId'))
    const cores = Number(form.get('cores'))
    create.mutate({ customer: String(form.get('customer')), picCustomer: String(form.get('picCustomer')), picPresales: String(form.get('picPresales')), segmentId, cores })
  }
  return <>
    <PageHeader title="Booking core" subtitle="Kelola booking kapasitas, release, dan permintaan waiting list." action={<button className="btn btn-primary" onClick={() => setShowForm(true)}><i className="bi bi-plus-lg me-2" />Buat booking</button>} />
    {toast && <div className="toast-banner" role="status"><i className="bi bi-check-circle-fill" />{toast}<button onClick={() => setToast('')} aria-label="Tutup"><i className="bi bi-x-lg" /></button></div>}
    <div className="row g-3 mb-4"><div className="col-sm-6 col-xl-3"><BookingMetric label="Booking aktif" value={String(bookedCount)} icon="bi-bookmark-check" tone="blue" /></div><div className="col-sm-6 col-xl-3"><BookingMetric label="Waiting list" value={String(waitingCount)} icon="bi-hourglass" tone="orange" /></div><div className="col-sm-6 col-xl-3"><div className="metric-card compact"><span className="metric-icon purple"><i className="bi bi-calendar2-check" /></span><div className="flex-grow-1"><span className="metric-label">Masa booking sementara</span>{editDuration ? <div className="d-flex align-items-center gap-2"><input aria-label="Durasi booking (hari)" className="form-control form-control-sm duration-input" type="number" min="1" max="365" value={newDuration} onChange={(event) => setNewDuration(Math.max(1, Math.min(365, Number(event.target.value) || 1)))} /><button className="btn btn-sm btn-primary py-1" onClick={() => updateDuration.mutate(newDuration)} disabled={updateDuration.isPending}>Simpan</button></div> : <div className="d-flex align-items-center gap-2"><strong>{bookingDays} hari</strong>{user?.role === 'ADMIN' && <button className="btn btn-sm btn-link p-0 duration-edit" aria-label="Ubah durasi booking" title="Ubah durasi booking" onClick={() => { setNewDuration(bookingDays); setEditDuration(true) }}><i className="bi bi-pencil-square" /></button>}</div>}</div></div></div><div className="col-sm-6 col-xl-3"><BookingMetric label="Segmen tersedia" value={String(networkSegments.length)} icon="bi-bezier2" tone="green" /></div></div>
    {isError && <div className="alert alert-danger">Data booking tidak dapat dimuat.</div>}{isPending ? <div className="bulk-empty">Memuat booking...</div> : <section className="card panel-card"><div className="card-header booking-request-header"><div><h3>Permintaan core</h3><p>Booking, status kapasitas, dan waiting list pelanggan.</p></div><div className="filter-tabs">{(['Semua', 'Booked', 'Waiting List'] as const).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value}{value === 'Waiting List' && <span>{waitingCount}</span>}</button>)}</div></div><div className="table-responsive"><table className="table atlas-table booking-table mb-0"><thead><tr><th>ID / Pelanggan</th><th>Segmen</th><th>Jumlah core</th><th>PIC customer</th><th>PIC presales</th><th>Status</th><th>Permintaan</th><th /></tr></thead><tbody>{filtered.map((booking) => <tr key={booking.id}><td><b className="booking-id">{booking.id}</b><small className="d-block text-muted">{booking.customer}</small></td><td><span className="cable-name">{booking.segmentName}</span><small className="d-block text-muted">{booking.area}</small></td><td><b>{booking.cores} core</b></td><td>{booking.picCustomer}</td><td>{booking.picPresales}</td><td><span className={`status-pill ${booking.status === 'Booked' ? 'is-booked' : booking.status === 'Waiting List' ? 'is-waiting' : 'is-released'}`}><i className={`bi ${booking.status === 'Booked' ? 'bi-check-circle-fill' : booking.status === 'Waiting List' ? 'bi-clock-fill' : 'bi-arrow-counterclockwise'}`} />{booking.status}</span></td><td className="text-muted">{new Date(booking.requestedAt).toLocaleDateString('id-ID')}</td><td>{booking.status === 'Booked' && <button className="btn btn-sm btn-outline-secondary" onClick={() => release.mutate(booking)} disabled={release.isPending}>Release</button>}</td></tr>)}</tbody></table></div>{filtered.length === 0 && <div className="bulk-empty"><b>Tidak ada permintaan</b><span>Coba pilih filter lain.</span></div>}</section>}
    {showForm && <div className="modal-backdrop-custom" role="presentation" onClick={() => setShowForm(false)}><section className="booking-modal" role="dialog" aria-modal="true" aria-labelledby="booking-title" onClick={(event) => event.stopPropagation()}><div className="modal-heading"><div><h3 id="booking-title">Buat booking core</h3><p>Catat kebutuhan core pelanggan.</p></div><button className="btn-close" onClick={() => setShowForm(false)} aria-label="Tutup" /></div><form onSubmit={addBooking}><label className="form-label">Nama pelanggan</label><input className="form-control mb-3" name="customer" required placeholder="Nama perusahaan" /><label className="form-label">Segmen jaringan</label><select className="form-select mb-3" name="segmentId" required>{networkSegments.filter((segment) => segment.assetType === 'segment').map((segment) => <option value={segment.id} key={segment.id}>{segment.name} · {segment.idleCores} core tersedia</option>)}</select><div className="row g-3"><div className="col-6"><label className="form-label">Jumlah core</label><input className="form-control" name="cores" type="number" min="1" defaultValue="2" required /></div><div className="col-6"><label className="form-label">PIC customer</label><input className="form-control" name="picCustomer" required placeholder="Nama PIC" /></div></div><label className="form-label mt-3">PIC presales</label><input className="form-control" name="picPresales" required placeholder="Nama PIC presales" /><div className="modal-actions"><button type="button" className="btn btn-light" onClick={() => setShowForm(false)}>Batal</button><button className="btn btn-primary" disabled={create.isPending || !networkSegments.length}><i className="bi bi-check2 me-2" />Simpan booking</button></div></form></section></div>}
  </>
}

function BookingMetric({ label, value, icon, tone }: { label: string; value: string; icon: string; tone: string }) {
  return <div className="metric-card compact"><span className={`metric-icon ${tone}`}><i className={`bi ${icon}`} /></span><div><span className="metric-label">{label}</span><strong>{value}</strong></div></div>
}
