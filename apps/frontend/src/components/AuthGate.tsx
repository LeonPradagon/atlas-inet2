import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { api, apiClient } from '../lib/api'

type User = { id: string; name: string; email: string; role: 'ADMIN' | 'PRESALES' }

function Login() {
  const queryClient = useQueryClient()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setLoading(true)
    const form = new FormData(event.currentTarget)
    try {
      await apiClient.post('/auth/sign-in/email', { email: form.get('email'), password: form.get('password') })
      await queryClient.invalidateQueries({ queryKey: ['me'] })
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Tidak dapat masuk.') }
    finally { setLoading(false) }
  }
  return <main className="auth-screen"><section className="auth-card"><img className="corporate-logo auth-corporate-logo" src="/sinergy-networks-brd.png" alt="Sinergy Networks" width="230" height="60" /><h1>Masuk ke ATLAS</h1><p>Gunakan akun organisasi yang telah disiapkan administrator.</p><form onSubmit={signIn}><label className="form-label" htmlFor="email">Email</label><input id="email" name="email" type="email" className="form-control mb-3" required autoComplete="username" /><label className="form-label" htmlFor="password">Kata sandi</label><input id="password" name="password" type="password" className="form-control mb-3" required autoComplete="current-password" />{error && <div className="alert alert-danger">{error}</div>}<button className="btn btn-primary w-100" disabled={loading}>{loading ? 'Memeriksa...' : 'Masuk'}</button></form></section></main>
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isPending, isError } = useQuery({ queryKey: ['me'], queryFn: () => api<User>('/me'), retry: false })
  if (isPending) return <main className="auth-screen"><div className="spinner-border text-primary" aria-label="Memuat sesi" /></main>
  if (isError || !data) return <Login />
  return children
}
