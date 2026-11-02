import { Link } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '../lib/api'

export function AccountMenu({ user }: { user?: { name: string; email: string; role: string } }) {
  const menu = useRef<HTMLDetailsElement>(null)
  const logout = useMutation({ mutationFn: () => api('/auth/sign-out', { method: 'POST' }), onSuccess: () => window.location.reload() })
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) menu.current?.removeAttribute('open') }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') menu.current?.removeAttribute('open') }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [])
  return <details ref={menu} className="account-menu">
    <summary className="user-chip" aria-label="Menu akun">
      <span className="avatar">{(user?.name ?? 'A').slice(0, 2).toUpperCase()}</span>
      <span className="d-none d-sm-block"><b>{user?.name}</b><small>{user?.role}</small></span>
      <i className="bi bi-chevron-down account-chevron" />
    </summary>
    <div className="account-popover">
      <div className="account-popover-identity"><b>{user?.name}</b><small>{user?.email}</small></div>
      <Link to="/profil" className="account-menu-item" onClick={() => menu.current?.removeAttribute('open')}><i className="bi bi-person-circle" /><span>Lihat profil<small>Informasi akun dan ubah password</small></span></Link>
      <button className="account-menu-item account-logout" onClick={() => logout.mutate()} disabled={logout.isPending}><i className="bi bi-box-arrow-right" /><span>{logout.isPending ? 'Keluar...' : 'Logout'}</span></button>
      {logout.isError && <small className="d-block text-danger px-2 pb-2" role="alert">Logout gagal. Silakan coba lagi.</small>}
    </div>
  </details>
}
