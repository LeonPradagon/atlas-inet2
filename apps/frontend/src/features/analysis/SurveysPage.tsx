import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { PageHeader } from '../../components/PageHeader'
import { TablePagination } from '../../components/TablePagination'
import { NearestNetworkMap, type NetworkSearchResult } from './NearestNetworkMap'

type Survey = { id:string; address:string; status:string; requester:string; row_number:number; verified_at:string|null; findings:Record<string,string>; analysis:NetworkSearchResult }
const labels:Record<string,string> = {WAITING:'Menunggu survei',IN_PROGRESS:'Dalam survei',REVIEW:'Menunggu verifikasi',VERIFIED:'Terverifikasi',REVISION:'Perlu revisi'}
const fields = [['connection','Titik sambungan aktual'],['route','Jalur kabel aktual'],['length','Panjang aktual (meter)'],['capacity','Hasil pemeriksaan kapasitas / core'],['evidence','Referensi bukti survei (tautan / nomor dokumen)'],['notes','Catatan / alasan revisi']]

export function SurveysPage() {
  const client = useQueryClient()
  const [filter,setFilter] = useState('ALL')
  const [page,setPage] = useState(1)
  const pageSize = 10
  const [selected,setSelected] = useState<Survey|null>(null)
  const [form,setForm] = useState<Record<string,string>>({})
  const me = useQuery({queryKey:['me'],queryFn:()=>api<{role:string}>('/me')})
  const surveys = useQuery({queryKey:['surveys'],queryFn:()=>api<Survey[]>('/surveys')})
  const filtered = (surveys.data ?? []).filter(s=>filter==='ALL'||s.status===filter)
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length/pageSize)))
  const visible = filtered.slice((currentPage-1)*pageSize,currentPage*pageSize)
  const refresh = () => client.invalidateQueries({queryKey:['surveys']})
  const update = useMutation({mutationFn:(status:string)=>api('/surveys/'+selected!.id,{method:'PATCH',data:{...form,status}}),onSuccess:async()=>{setSelected(null);await refresh()}})
  return <><PageHeader title="Survei & Verifikasi" subtitle="Tindak lanjuti hasil analisis tunggal dan massal per alamat." />
    <section className="card panel-card"><div className="card-header d-flex w-100 gap-3"><h3>Daftar survei</h3><select aria-label="Filter status survei" className="form-select w-auto ms-auto" value={filter} onChange={e=>{setFilter(e.target.value);setPage(1)}}><option value="ALL">Semua status</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div>
      {surveys.isPending ? <p className="p-3">Memuat survei...</p> : surveys.isError ? <p className="p-3 text-danger">Survei gagal dimuat.</p> : <div className="table-responsive"><table className="table atlas-table"><thead><tr><th>Alamat / sumber</th><th>Jaringan</th><th>Status</th><th>Aksi</th></tr></thead><tbody>{visible.map(s=><tr key={s.id}><td>{s.address}<small className="d-block">{s.row_number ? `Massal · Baris ${s.row_number}`:'Tunggal'} · {s.requester}</small></td><td>{s.analysis.network?.name ?? '—'}</td><td>{labels[s.status]}</td><td><button className="btn btn-sm btn-outline-primary" onClick={()=>{setSelected(s);setForm(s.findings);update.reset()}}>Buka pemeriksaan</button></td></tr>)}</tbody></table>{!filtered.length && <p className="p-3">Tidak ada survei untuk status yang dipilih.</p>}</div>}
      {!surveys.isPending && !surveys.isError && <TablePagination page={currentPage} pageSize={pageSize} total={filtered.length} label="survei" onPageChange={setPage} />}
    </section>
    {selected && <section className="card panel-card mt-3"><div className="card-header d-flex w-100 gap-3"><div><h3>{selected.address}</h3><p>{labels[selected.status]}{selected.verified_at ? ` · ${new Date(selected.verified_at).toLocaleString('id-ID')}`:''}</p></div><button className="btn btn-sm btn-outline-secondary ms-auto" onClick={()=>setSelected(null)}>Tutup</button></div><div className="card-body">
      <p>Jaringan hasil analisis: <b>{selected.analysis.network?.name}</b>{selected.analysis.distanceMeters != null ? ` · Estimasi kabel ${Math.round(selected.analysis.distanceMeters)} m`:''}</p>
      {Number.isFinite(selected.analysis.latitude)&&Number.isFinite(selected.analysis.longitude)&&<div className="mb-4"><NearestNetworkMap key={selected.id} result={selected.analysis}/></div>}
      <h4 className="h6 mb-3">Hasil pemeriksaan lapangan</h4>
      <div className="row g-3">{fields.map(([key,label])=><label key={key} className="col-md-6 form-label">{label}<textarea rows={3} className="form-control mt-1" value={form[key]??''} maxLength={2000} readOnly={selected.status==='VERIFIED'||(selected.status==='REVIEW'&&me.data?.role!=='ADMIN')} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}</div>
      <div className="d-flex gap-2 mt-3">{['WAITING','REVISION'].includes(selected.status)&&<button className="btn btn-primary" disabled={update.isPending} onClick={()=>update.mutate('IN_PROGRESS')}>Mulai survei</button>}{selected.status==='IN_PROGRESS'&&<button className="btn btn-primary" disabled={update.isPending} onClick={()=>update.mutate('REVIEW')}>Kirim hasil untuk verifikasi</button>}{selected.status==='REVIEW'&&me.data?.role==='ADMIN'&&<><button className="btn btn-success" disabled={update.isPending} onClick={()=>update.mutate('VERIFIED')}>Verifikasi hasil survei</button><button className="btn btn-outline-warning" disabled={update.isPending} onClick={()=>update.mutate('REVISION')}>Minta revisi</button></>}</div>
      {update.error&&<p className="text-danger mt-2">{update.error.message}</p>}
    </div></section>}
  </>
}
