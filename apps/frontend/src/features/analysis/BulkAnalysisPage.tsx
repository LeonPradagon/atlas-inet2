import { useRef, useState } from 'react'
import ExcelJS from 'exceljs'
import { PageHeader } from '../../components/PageHeader'
import { api } from '../../lib/api'

type AnalysisRow = { row: number; address: string; latitude?: number | null; longitude?: number | null; network?: { name: string } | null; distanceMeters?: number | null; status: string; message?: string }

function downloadWorkbook(workbook: ExcelJS.Workbook, name: string) {
  void workbook.xlsx.writeBuffer().then((buffer) => {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
  })
}

export function BulkAnalysisPage() {
  const input = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<AnalysisRow[]>([])
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const processFile = async (file?: File) => {
    if (!file) return
    setError(''); setLoading(true)
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Ukuran file melebihi batas 10 MB.')
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Pilih file Excel dengan format .xlsx.')
      const form = new FormData(); form.append('file', file)
      const result = await api<{ rows: AnalysisRow[] }>('/analysis/bulk', { method: 'POST', data: form })
      setRows(result.rows); setFileName(file.name)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'File tidak dapat dibaca.'); setRows([]); setFileName('') }
    finally { setLoading(false) }
  }
  const download = () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Hasil Analisis')
    sheet.addRow(['Alamat', 'Latitude', 'Longitude', 'Nearest Network', 'Estimasi Jarak Jalan (m)', 'Status', 'Pesan'])
    rows.forEach((row) => sheet.addRow([row.address,row.latitude ?? '',row.longitude ?? '',row.network?.name ?? '',row.distanceMeters ?? '',row.status,row.message ?? '']))
    downloadWorkbook(workbook,'ATLAS-hasil-analisis.xlsx')
  }
  const downloadTemplate = () => {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Lokasi')
    sheet.addRow(['Alamat']); sheet.addRow([''])
    downloadWorkbook(workbook,'template-analisis-atlas.xlsx')
  }
  return <>
    <PageHeader title="Analisis massal" subtitle="Proses banyak alamat sekaligus dengan file Excel." action={<button className="btn btn-outline-primary" onClick={downloadTemplate}><i className="bi bi-download me-2" />Unduh template</button>} />
    <div className="row g-4"><div className="col-xl-4"><section className="card panel-card"><div className="card-header"><div><h3>Unggah file lokasi</h3><p>Format .xlsx</p></div></div><div className="card-body"><div className="upload-zone" role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') input.current?.click() }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void processFile(event.dataTransfer.files[0]) }}><span className="upload-icon"><i className="bi bi-cloud-arrow-up" /></span><b>Tarik file ke sini</b><span>atau <u>pilih dari perangkat</u></span><small>Maksimal 10 MB · .xlsx</small></div><input ref={input} className="d-none" type="file" accept=".xlsx" onChange={(event) => { void processFile(event.target.files?.[0]); event.currentTarget.value = '' }} />{loading && <div className="mt-3"><span className="spinner-border spinner-border-sm me-2" />Memproses file...</div>}{fileName && <div className="selected-file"><i className="bi bi-file-earmark-excel text-success" /><span>{fileName}<small>{rows.length} baris diperiksa</small></span><button className="btn btn-sm btn-link text-secondary" onClick={() => { setRows([]); setFileName('') }} aria-label="Hapus file"><i className="bi bi-x-lg" /></button></div>}{error && <div className="alert alert-danger mt-3 mb-0"><i className="bi bi-exclamation-circle me-2" />{error}</div>}<div className="upload-requirements mt-4"><b><i className="bi bi-info-circle me-2" />Format file</b><p>Isi kolom <code>Alamat</code> atau pasangan <code>Latitude</code> dan <code>Longitude</code>. Baris pertama berisi nama kolom.</p></div></div></section></div>
      <div className="col-xl-8"><section className="card panel-card result-table-card"><div className="card-header"><div><h3>Hasil analisis</h3><p>{rows.length ? `${rows.length} lokasi diperiksa` : 'Unggah file untuk mulai memproses lokasi.'}</p></div>{rows.length > 0 && <button className="btn btn-success btn-sm" onClick={download}><i className="bi bi-file-earmark-arrow-down me-2" />Unduh Excel</button>}</div>{rows.length ? <><div className="alert alert-info m-3 mb-0">Jika provider belum tersedia, status baris menjelaskan layanan yang belum aktif. Tidak ada hasil contoh yang ditampilkan.</div><div className="table-responsive"><table className="table atlas-table mb-0"><thead><tr><th>Lokasi</th><th>Koordinat</th><th>Nearest network</th><th>Jarak jalan</th><th>Status</th></tr></thead><tbody>{rows.map((row) => <tr key={row.row}><td className="address-cell">{row.address}</td><td className="text-muted small">{row.latitude !== null && row.latitude !== undefined ? `${row.latitude}, ${row.longitude}` : '—'}</td><td><span className="cable-name">{row.network?.name ?? '—'}</span></td><td>{row.distanceMeters === null || row.distanceMeters === undefined ? '—' : `${row.distanceMeters} m`}</td><td><span className={row.status === 'OK' ? 'status-success' : 'text-warning'}>{row.status}</span><small className="d-block text-muted">{row.message ?? ''}</small></td></tr>)}</tbody></table></div></> : <div className="bulk-empty"><div className="empty-illustration small"><i className="bi bi-file-earmark-spreadsheet" /></div><b>Belum ada hasil</b><span>Hasil pemrosesan file akan ditampilkan di sini.</span></div>}</section></div></div>
  </>
}
