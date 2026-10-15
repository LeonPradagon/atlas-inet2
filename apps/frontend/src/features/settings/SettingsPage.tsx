import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { PageHeader } from '../../components/PageHeader'
import { api } from '../../lib/api'

export function SettingsPage() {
  const queryClient = useQueryClient()
  const [pattern, setPattern] = useState('')
  const settings = useQuery({ queryKey: ['cable-name-pattern'], queryFn: () => api<{ pattern: string }>('/settings/cable-name-pattern') })
  useEffect(() => { if (settings.data) setPattern(settings.data.pattern) }, [settings.data])
  const save = useMutation({
    mutationFn: () => api('/settings/cable-name-pattern', { method: 'PATCH', data: { pattern } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cable-name-pattern'] })
      await queryClient.invalidateQueries({ queryKey: ['segments'] })
    },
  })

  return <>
    <PageHeader title="Pengaturan" subtitle="Atur validasi dan preferensi jaringan." />
    <section className="card panel-card">
      <div className="card-header"><h3>Pola nama kabel</h3><p>Validasi nama segmen jaringan menggunakan regular expression.</p></div>
      <div className="card-body">
        {settings.isPending ? <p role="status">Memuat pengaturan...</p> : settings.isError ? <div className="alert alert-danger">Pola nama kabel tidak dapat dimuat.</div> : <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
          <label className="form-label" htmlFor="cable-pattern">Pola nama kabel (RegExp)</label>
          <input id="cable-pattern" className="form-control" value={pattern} onChange={(event) => setPattern(event.target.value)} required />
          <div className="d-flex align-items-center gap-3 mt-3">
            <button className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Menyimpan...' : 'Simpan pola'}</button>
            {save.isSuccess && <span className="text-success" role="status">Pola tersimpan.</span>}
            {save.isError && <span className="text-danger" role="alert">{save.error instanceof Error ? save.error.message : 'Pola tidak dapat disimpan.'}</span>}
          </div>
        </form>}
      </div>
    </section>
  </>
}
