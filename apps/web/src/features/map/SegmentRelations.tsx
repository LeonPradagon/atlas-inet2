import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, networkQueryKeys, type AssetRelation } from '../../lib/api'

const kinds = [{ kind: 'POLE', label: 'Tiang' }, { kind: 'ODC', label: 'ODC' }, { kind: 'ODP', label: 'ODP' }] as const

export function SegmentRelations({ segmentId, isAdmin }: { segmentId: string; isAdmin: boolean }) {
  const queryClient = useQueryClient()
  const relations = useQuery({ queryKey: ['relations', segmentId], queryFn: () => api<AssetRelation[]>(`/assets/${segmentId}/relations`), refetchInterval: 30_000 })
  const height = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => api(`/assets/${id}`, { method: 'PATCH', data: { poleHeight: value || null } }),
    onSuccess: () => Promise.all(networkQueryKeys.map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  })

  if (relations.isPending) return <small className="text-secondary d-block mt-3" role="status">Memuat aset yang sudah terhubung...</small>
  if (relations.isError) return <small className="text-danger d-block mt-3" role="alert">Relasi aset tidak dapat dimuat.</small>
  return <section className="segment-relations mt-3">
    <b>Relasi aset titik</b>
    {!relations.data?.length && <small className="text-secondary d-block mt-2">Belum ada aset titik yang dihubungkan. Data Tiang, ODC, dan ODP di atas adalah teks dari sumber impor.</small>}
    {kinds.map(({ kind, label }) => {
      const assets = relations.data.filter((entry) => entry.kind === kind)
      return <div className="relation-group" key={kind}>
        <b>{label} · {assets.length}</b>
        {!assets.length && <small className="text-secondary">Belum ada relasi.</small>}
        {assets.map((entry) => <div className="relation-row" key={entry.assetId}>
          <span>{entry.name}</span>
          {kind === 'POLE' && (isAdmin
            ? <select aria-label={`Tinggi tiang ${entry.name}`} className="form-select form-select-sm" value={entry.poleHeight ?? ''} disabled={height.isPending} onChange={(event) => height.mutate({ id: entry.assetId, value: event.target.value })}>
                <option value="">Belum diketahui</option><option value="7 m">7 meter</option><option value="9 m">9 meter</option>
              </select>
            : <small>{entry.poleHeight ?? 'Belum diketahui'}</small>)}
        </div>)}
      </div>
    })}
    {height.isSuccess && <small className="text-success d-block mt-2" role="status">Tinggi tiang tersimpan.</small>}
    {height.isError && <small className="text-danger d-block mt-2" role="alert">Tinggi tiang tidak dapat disimpan.</small>}
  </section>
}
