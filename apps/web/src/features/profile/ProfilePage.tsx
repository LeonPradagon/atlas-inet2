import { useMutation, useQuery } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { api } from '../../lib/api'

export function ProfilePage() {
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => api<{ name: string; email: string; role: string }>('/me') })
  const form = useRef<HTMLFormElement>(null)
  const [validation, setValidation] = useState('')
  const change = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) => api('/auth/change-password', { method: 'POST', data: { ...data, revokeOtherSessions: true } }),
    onSuccess: () => form.current?.reset(),
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setValidation('')
    change.reset()
    const data = new FormData(event.currentTarget)
    const currentPassword = String(data.get('currentPassword')), newPassword = String(data.get('newPassword'))
    if (newPassword !== String(data.get('confirmPassword'))) { setValidation('Konfirmasi password harus sama dengan password baru.'); return }
    if (currentPassword === newPassword) { setValidation('Password baru harus berbeda dari password lama.'); return }
    change.mutate({ currentPassword, newPassword })
  }
  return <>
    <PageHeader title="Profil saya" subtitle="Lihat informasi akun dan kelola password Anda." />
    <div className="row g-4">
      <div className="col-lg-4"><section className="card panel-card"><div className="card-header"><h3>Informasi akun</h3></div><div className="card-body profile-information"><div><small>Nama</small><b>{user?.name ?? 'Memuat...'}</b></div><div><small>Email</small><b>{user?.email ?? '—'}</b></div><div><small>Peran</small><b>{user?.role ?? '—'}</b></div></div></section></div>
      <div className="col-lg-8"><section className="card panel-card"><div className="card-header"><div><h3>Ubah password</h3><p>Gunakan password baru minimal 12 karakter.</p></div></div><div className="card-body">
        <form ref={form} onSubmit={submit}>
          <label className="form-label" htmlFor="current-password">Password lama</label><input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required className="form-control mb-3" disabled={change.isPending} />
          <label className="form-label" htmlFor="new-password">Password baru</label><input id="new-password" name="newPassword" type="password" autoComplete="new-password" required minLength={12} className="form-control mb-3" disabled={change.isPending} />
          <label className="form-label" htmlFor="confirm-password">Konfirmasi password baru</label><input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} className="form-control mb-3" disabled={change.isPending} />
          <p className="form-text">Setelah password diubah, sesi pada perangkat lain akan ditutup.</p>
          {(validation || change.isError) && <div className="alert alert-danger" role="alert">{validation || (change.error instanceof Error ? change.error.message : 'Password tidak dapat diubah.')}</div>}
          {change.isSuccess && <div className="alert alert-success" role="status">Password berhasil diubah.</div>}
          <div className="d-flex justify-content-end"><button className="btn btn-primary" disabled={change.isPending}>{change.isPending ? 'Menyimpan...' : 'Simpan password'}</button></div>
        </form>
      </div></section></div>
    </div>
  </>
}
