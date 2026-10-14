import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import ExcelJS from 'exceljs'
import { LngLatBounds, Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { FeatureCollection, LineString, Point, Polygon } from 'geojson'
import { PageHeader } from '../../components/PageHeader'
import { api, postCompressedJson } from '../../lib/api'
import { generateFtthDraft, offsetCoordinate, type DesignFeature } from './ftthDraft'
import { Link } from '@tanstack/react-router'

type AnalysisRow = { row: number; address: string; latitude?: number | null; longitude?: number | null; network?: { name: string; area?: string } | null; distanceMeters?: number | null; status: string; message?: string }

type DraftOverlay = { row: number; anchor: [number, number]; features: DesignFeature[] }

function BulkResultsMap({ rows, draftOverlays }: { rows: AnalysisRow[]; draftOverlays: DraftOverlay[] }) {
  const container = useRef<HTMLDivElement>(null)
  const points = rows.filter((row): row is AnalysisRow & { latitude: number; longitude: number } => Number.isFinite(row.latitude) && Number.isFinite(row.longitude) && Math.abs(row.latitude!) <= 90 && Math.abs(row.longitude!) <= 180)

  useEffect(() => {
    if (!container.current || !points.length) return
    setWorkerUrl(workerUrl)
    const map = new MapLibreMap({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: [points[0].longitude, points[0].latitude], zoom: 13 })
    map.addControl(new NavigationControl(), 'top-right')
    map.on('load', () => {
      const data: FeatureCollection<Point, { address: string; network: string; distance: number | null; status: string; message: string }> = {
        type: 'FeatureCollection',
        features: points.map((row) => ({ type: 'Feature', properties: { address: row.address, network: row.network?.name ?? '—', distance: row.distanceMeters ?? null, status: row.status, message: row.message ?? '' }, geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] } })),
      }
      const ring = (center: [number, number], radius: number) => {
        const coordinates = Array.from({ length: 65 }, (_, index) => offsetCoordinate(center, radius, index / 64 * 2 * Math.PI))
        coordinates[coordinates.length - 1] = coordinates[0]
        return coordinates
      }
      const boundaryRings = points.map((row) => ring([row.longitude, row.latitude], 500))
      const odpRings = draftOverlays.flatMap((overlay) => overlay.features.flatMap((feature) => feature.properties.kind === 'ODP' && feature.geometry.type === 'Point' ? [ring(feature.geometry.coordinates as [number, number], 150)] : []))
      const allRings = [...boundaryRings, ...odpRings]
      const radiusBounds = allRings.flat().reduce((bounds, coordinate) => bounds.extend(coordinate), new LngLatBounds())
      const radii: FeatureCollection<Polygon, { kind: string }> = {
        type: 'FeatureCollection',
        features: [
          ...boundaryRings.map((coordinates) => ({ type: 'Feature' as const, properties: { kind: 'boundary' }, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } })),
          ...odpRings.map((coordinates) => ({ type: 'Feature' as const, properties: { kind: 'odp' }, geometry: { type: 'Polygon' as const, coordinates: [coordinates] } })),
        ],
      }
      map.addSource('bulk-analysis-radii', { type: 'geojson', data: radii })
      map.addLayer({ id: 'bulk-analysis-radius-fill', type: 'fill', source: 'bulk-analysis-radii', filter: ['==', ['get', 'kind'], 'boundary'], paint: { 'fill-color': '#3454d1', 'fill-opacity': 0.2 } })
      map.addLayer({ id: 'bulk-analysis-radius-line', type: 'line', source: 'bulk-analysis-radii', filter: ['==', ['get', 'kind'], 'boundary'], paint: { 'line-color': '#3454d1', 'line-width': 3 } })
      if (odpRings.length) {
        map.addLayer({ id: 'bulk-analysis-odp-fill', type: 'fill', source: 'bulk-analysis-radii', filter: ['==', ['get', 'kind'], 'odp'], paint: { 'fill-color': '#f29b38', 'fill-opacity': 0.12 } })
        map.addLayer({ id: 'bulk-analysis-odp-line', type: 'line', source: 'bulk-analysis-radii', filter: ['==', ['get', 'kind'], 'odp'], paint: { 'line-color': '#f29b38', 'line-width': 1, 'line-dasharray': [2, 2] } })
      }
      const draftPoints = draftOverlays.flatMap((overlay) => [
        { type: 'Feature' as const, properties: { kind: 'OLT', name: `OLT · ${rows.find((row) => row.row === overlay.row)?.address ?? 'Titik analisis'}` }, geometry: { type: 'Point' as const, coordinates: overlay.anchor } },
        ...overlay.features.filter((feature) => feature.geometry.type === 'Point'),
      ])
      const draftLines = draftOverlays.flatMap((overlay) => overlay.features.filter((feature) => feature.geometry.type === 'LineString'))
      if (draftPoints.length) {
        const drawIcon = (kind: 'OLT' | 'ODC' | 'ODP' | 'POLE', color: string) => {
          const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64
          const context = canvas.getContext('2d')!; context.scale(2, 2)
          if (kind === 'ODC' || kind === 'ODP') {
            context.fillStyle = color; context.beginPath(); context.moveTo(16, 4); context.lineTo(28, 27); context.lineTo(4, 27); context.closePath(); context.fill()
            context.globalCompositeOperation = 'destination-out'; context.beginPath(); context.arc(16, 19, 3.5, 0, 2 * Math.PI); context.fill(); context.globalCompositeOperation = 'source-over'
          } else if (kind === 'OLT') {
            context.fillStyle = '#fff'; context.strokeStyle = '#d9a400'; context.lineWidth = 1.5; context.beginPath(); context.roundRect(5, 7, 22, 20, 2); context.fill(); context.stroke()
            for (const y of [12, 18, 24]) { context.fillStyle = '#e8b500'; context.fillRect(8, y - 1, 16, 3); context.fillStyle = '#fff'; context.fillRect(10, y, 2, 1) }
          } else {
            context.strokeStyle = color; context.lineWidth = 2.5; context.beginPath(); context.moveTo(16, 4); context.lineTo(16, 29); context.moveTo(8, 10); context.lineTo(24, 10); context.moveTo(10, 15); context.lineTo(22, 15); context.moveTo(13, 7); context.lineTo(13, 11); context.moveTo(19, 7); context.lineTo(19, 11); context.moveTo(11, 29); context.lineTo(21, 29); context.stroke()
          }
          map.addImage(`bulk-ftth-${kind.toLowerCase()}`, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 })
        }
        drawIcon('OLT', '#e8b500'); drawIcon('ODC', '#ff0000'); drawIcon('ODP', '#0000ff'); drawIcon('POLE', '#536177')
        const pointData: FeatureCollection<Point, { kind: string; name: string; poleHeight?: string }> = { type: 'FeatureCollection', features: draftPoints as FeatureCollection<Point, { kind: string; name: string; poleHeight?: string }>['features'] }
        map.addSource('bulk-ftth-points', { type: 'geojson', data: pointData })
        map.addLayer({ id: 'bulk-ftth-major-icons', type: 'symbol', source: 'bulk-ftth-points', filter: ['in', ['get', 'kind'], ['literal', ['OLT', 'ODC', 'ODP']]], layout: { 'icon-image': ['concat', 'bulk-ftth-', ['downcase', ['get', 'kind']]], 'icon-size': 0.8, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
        map.addLayer({ id: 'bulk-ftth-pole-icons', type: 'symbol', source: 'bulk-ftth-points', filter: ['==', ['get', 'kind'], 'POLE'], layout: { 'icon-image': 'bulk-ftth-pole', 'icon-size': 0.62, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
      }
      if (draftLines.length) {
        const lineData: FeatureCollection<LineString, { kind: string; name: string; routeType?: string }> = { type: 'FeatureCollection', features: draftLines as FeatureCollection<LineString, { kind: string; name: string; routeType?: string }>['features'] }
        map.addSource('bulk-ftth-lines', { type: 'geojson', data: lineData })
        map.addLayer({ id: 'bulk-ftth-routes', type: 'line', source: 'bulk-ftth-lines', paint: { 'line-color': ['match', ['get', 'routeType'], 'FEEDER', '#ff0000', 'DISTRIBUTION', '#a000ff', '#64748b'], 'line-width': ['match', ['get', 'routeType'], 'FEEDER', 4.5, 3.5] } })
      }
      map.addSource('bulk-analysis-points', { type: 'geojson', data })
      map.addLayer({ id: 'bulk-analysis-points', type: 'circle', source: 'bulk-analysis-points', paint: { 'circle-radius': 8, 'circle-color': ['case', ['==', ['get', 'status'], 'OK'], '#405bd8', '#f0a22e'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.on('mouseenter', 'bulk-analysis-points', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'bulk-analysis-points', () => { map.getCanvas().style.cursor = '' })
      map.on('click', 'bulk-analysis-points', (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['bulk-analysis-points'] })[0]
        if (!feature) return
        map.flyTo({ center: event.lngLat, zoom: 15 })
        const content = document.createElement('div')
        const title = document.createElement('strong'); title.textContent = String(feature.properties?.address ?? 'Lokasi'); content.append(title)
        const detail = document.createElement('div'); detail.textContent = `Jaringan: ${feature.properties?.network ?? '—'} · ${feature.properties?.distance == null ? 'Jarak belum tersedia' : `${feature.properties.distance} m`} · ${feature.properties?.status ?? ''}`; content.append(detail)
        if (feature.properties?.message) { const message = document.createElement('small'); message.textContent = String(feature.properties.message); content.append(message) }
        new Popup({ closeButton: true, maxWidth: '320px' }).setLngLat(event.lngLat).setDOMContent(content).addTo(map)
      })
      if (draftOverlays.length) {
        map.fitBounds(radiusBounds!, { padding: 48, maxZoom: 15 })
      } else if (points.length > 1) {
        map.fitBounds(radiusBounds, { padding: 48, maxZoom: 14 })
      } else if (points.length === 1) {
        map.setZoom(15)
      }
    })
    return () => map.remove()
  }, [rows, draftOverlays])

  return <div ref={container} role="img" aria-label="Peta lokasi hasil analisis massal" className="border rounded overflow-hidden" style={{ height: 360, width: '100%' }} />
}

function downloadWorkbook(workbook: ExcelJS.Workbook, name: string) {
  void workbook.xlsx.writeBuffer().then((buffer) => {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url)
  })
}

export function BulkAnalysisPage() {
  const input = useRef<HTMLInputElement>(null)
  const [rows, setRows] = useState<AnalysisRow[]>([])
  const [analysisHistoryId, setAnalysisHistoryId] = useState('')
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [draftingRow, setDraftingRow] = useState<number | null>(null)
  const [savedDraftRows, setSavedDraftRows] = useState<Set<number>>(() => new Set())
  const [draftMessage, setDraftMessage] = useState<{ row: number; text: string; error: boolean } | null>(null)
  const [draftOverlays, setDraftOverlays] = useState<DraftOverlay[]>([])
  const queryClient = useQueryClient()
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => api<{ role: string }>('/me') })
  const processFile = async (file?: File) => {
    if (!file) return
    setError(''); setLoading(true)
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Ukuran file melebihi batas 10 MB.')
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Pilih file Excel dengan format .xlsx.')
      const form = new FormData(); form.append('file', file)
      const result = await api<{ rows: AnalysisRow[]; historyId: string }>('/analysis/bulk', { method: 'POST', data: form })
      setRows(result.rows); setAnalysisHistoryId(result.historyId); setFileName(file.name); setDraftOverlays([]); setSavedDraftRows(new Set())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'File tidak dapat dibaca.'); setRows([]); setAnalysisHistoryId(''); setFileName(''); setDraftOverlays([]); setSavedDraftRows(new Set()) }
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
  const generateDraft = async (row: AnalysisRow) => {
    if (row.status !== 'OK' || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) || user?.role !== 'ADMIN') return
    setDraftingRow(row.row); setDraftMessage(null)
    try {
      const anchor: [number, number] = [row.longitude!, row.latitude!]
      const { features, uncoveredTargets } = await generateFtthDraft(anchor, 'OLT')
      setDraftOverlays((current) => [...current.filter((overlay) => overlay.row !== row.row), { row: row.row, anchor, features }])
      setDraftMessage({ row: row.row, text: `Draft FTTH siap ditinjau${uncoveredTargets ? `; ${uncoveredTargets} titik belum terlayani.` : '.'} Klik Simpan ke peta untuk menyimpan desain.`, error: false })
    } catch (cause) {
      setDraftMessage({ row: row.row, text: cause instanceof Error ? cause.message : 'Draft FTTH tidak dapat dibuat.', error: true })
    } finally { setDraftingRow(null) }
  }
  const saveDraft = async (row: AnalysisRow) => {
    const draftOverlay = draftOverlays.find((overlay) => overlay.row === row.row)
    if (!draftOverlay || savedDraftRows.has(row.row) || user?.role !== 'ADMIN') return
    setDraftingRow(row.row); setDraftMessage(null)
    try {
      const result = await postCompressedJson<{ savedCount: number }>('/assets/ftth-design', {
        area: row.network?.area ?? 'Analisis massal',
        sourceAnalysisId: analysisHistoryId,
        sourceRow: row.row,
        features: [
          { kind: 'OLT', name: `OLT · ${row.address}`.slice(0, 150), geometry: { type: 'Point', coordinates: draftOverlay.anchor } },
          ...draftOverlay.features.map(({ properties, geometry }) => ({ ...properties, geometry })),
        ],
      })
      await Promise.all(['segments', 'map-assets', 'analysis-history'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
      setSavedDraftRows((current) => new Set(current).add(row.row))
      localStorage.setItem('atlas-map-focus', JSON.stringify(draftOverlay.anchor))
      setDraftMessage({ row: row.row, text: `Draft FTTH tersimpan (${result.savedCount} aset/jalur).`, error: false })
    } catch (cause) {
      setDraftMessage({ row: row.row, text: cause instanceof Error ? cause.message : 'Draft FTTH tidak dapat disimpan.', error: true })
    } finally { setDraftingRow(null) }
  }
  return <>
    <PageHeader title="Analisis massal" subtitle="Proses banyak alamat sekaligus dengan file Excel." action={<button className="btn btn-outline-primary" onClick={downloadTemplate}><i className="bi bi-download me-2" />Unduh template</button>} />
    <div className="row g-4"><div className="col-xl-4"><section className="card panel-card"><div className="card-header"><div><h3>Unggah file lokasi</h3><p>Format .xlsx</p></div></div><div className="card-body"><div className="upload-zone" role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(event) => { if (event.key === 'Enter') input.current?.click() }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void processFile(event.dataTransfer.files[0]) }}><span className="upload-icon"><i className="bi bi-cloud-arrow-up" /></span><b>Tarik file ke sini</b><span>atau <u>pilih dari perangkat</u></span><small>Maksimal 10 MB · .xlsx</small></div><input ref={input} className="d-none" type="file" accept=".xlsx" onChange={(event) => { void processFile(event.target.files?.[0]); event.currentTarget.value = '' }} />{loading && <div className="mt-3"><span className="spinner-border spinner-border-sm me-2" />Memproses file...</div>}{fileName && <div className="selected-file"><i className="bi bi-file-earmark-excel text-success" /><span>{fileName}<small>{rows.length} baris diperiksa</small></span><button className="btn btn-sm btn-link text-secondary" onClick={() => { setRows([]); setFileName(''); setDraftOverlays([]); setSavedDraftRows(new Set()) }} aria-label="Hapus file"><i className="bi bi-x-lg" /></button></div>}{error && <div className="alert alert-danger mt-3 mb-0"><i className="bi bi-exclamation-circle me-2" />{error}</div>}<div className="upload-requirements mt-4"><b><i className="bi bi-info-circle me-2" />Format file</b><p>Isi kolom <code>Alamat</code> atau pasangan <code>Latitude</code> dan <code>Longitude</code>. Baris pertama berisi nama kolom.</p></div></div></section></div>
      <div className="col-xl-8"><section className="card panel-card result-table-card"><div className="card-header"><div><h3>Hasil analisis</h3><p>{rows.length ? `${rows.length} lokasi diperiksa` : 'Unggah file untuk mulai memproses lokasi.'}</p></div>{rows.length > 0 && <button className="btn btn-success btn-sm ms-auto flex-shrink-0" onClick={download}><i className="bi bi-file-earmark-arrow-down me-2" />Unduh Excel</button>}</div>{rows.length ? <><div className="alert alert-info m-3 mb-0">Jika provider belum tersedia, status baris menjelaskan layanan yang belum aktif. Tidak ada hasil contoh yang ditampilkan.</div>{rows.some((row) => Number.isFinite(row.latitude) && Number.isFinite(row.longitude)) && <section className="p-3 pb-0"><h4 className="h6 mb-2">Peta lokasi</h4><BulkResultsMap rows={rows} draftOverlays={draftOverlays} /><div className="d-flex flex-wrap gap-3 mt-2 small text-secondary"><span><i className="bi bi-circle-fill text-primary me-1" />Titik alamat</span><span><i className="bi bi-circle-fill me-1" style={{ color: '#3454d1' }} />Boundary 500 m</span>{draftOverlays.length > 0 && <><span><i className="bi bi-triangle-fill me-1" style={{ color: '#ff0000' }} />ODC</span><span><i className="bi bi-triangle-fill me-1" style={{ color: '#0000ff' }} />ODP</span><span><i className="bi bi-circle-fill me-1" style={{ color: '#536177' }} />Tiang</span><span><i className="bi bi-dash-lg me-1" style={{ color: '#ff0000' }} />Feeder / distribusi</span><span><i className="bi bi-circle-fill me-1" style={{ color: '#f29b38' }} />Radius layanan ODP 150 m</span></>}</div></section>}{draftMessage && <div className={`alert ${draftMessage.error ? 'alert-danger' : 'alert-success'} mx-3 mt-3 mb-0`}><div>{draftMessage.text}</div>{!draftMessage.error && savedDraftRows.has(draftMessage.row) && <div className="d-flex gap-2 mt-2"><Link to="/peta-jaringan" className="btn btn-sm btn-outline-success">Lihat di Peta Jaringan</Link><Link to="/riwayat-analisis" className="btn btn-sm btn-outline-success">Buka Riwayat Analisis</Link></div>}</div>}<div className="table-responsive"><table className="table atlas-table mb-0"><thead><tr><th>Lokasi</th><th>Koordinat</th><th>Nearest network</th><th>Jarak jalan</th><th>Status</th>{user?.role === 'ADMIN' && <th>Aksi</th>}</tr></thead><tbody>{rows.map((row) => <tr key={row.row}><td className="address-cell">{row.address}</td><td className="text-muted small">{row.latitude !== null && row.latitude !== undefined ? `${row.latitude}, ${row.longitude}` : '—'}</td><td><span className="cable-name">{row.network?.name ?? '—'}</span></td><td>{row.distanceMeters === null || row.distanceMeters === undefined ? '—' : `${row.distanceMeters} m`}</td><td><span className={row.status === 'OK' ? 'status-success' : 'text-warning'}>{row.status}</span><small className="d-block text-muted">{row.message ?? ''}</small></td>{user?.role === 'ADMIN' && <td className="text-nowrap"><div className="d-flex gap-2 flex-wrap"><button className="btn btn-sm btn-outline-primary" onClick={() => void generateDraft(row)} disabled={draftingRow !== null || savedDraftRows.has(row.row) || draftOverlays.some((overlay) => overlay.row === row.row) || row.status !== 'OK' || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)}>{draftingRow === row.row ? <><span className="spinner-border spinner-border-sm me-1" />Memproses...</> : draftOverlays.some((overlay) => overlay.row === row.row) ? <><i className="bi bi-check2 me-1" />Draft siap</> : <><i className="bi bi-magic me-1" />Generate draft FTTH</>}</button>{savedDraftRows.has(row.row) ? <button className="btn btn-sm btn-success" disabled><i className="bi bi-check-circle me-1" />Tersimpan</button> : draftOverlays.some((overlay) => overlay.row === row.row) && <button className="btn btn-sm btn-outline-success" onClick={() => void saveDraft(row)} disabled={draftingRow !== null}>{draftingRow === row.row ? <><span className="spinner-border spinner-border-sm me-1" />Menyimpan...</> : <><i className="bi bi-save me-1" />Simpan ke peta</>}</button>}</div></td>}</tr>)}</tbody></table></div></> : <div className="bulk-empty"><div className="empty-illustration small"><i className="bi bi-file-earmark-spreadsheet" /></div><b>Belum ada hasil</b><span>Hasil pemrosesan file akan ditampilkan di sini.</span></div>}</section></div></div>
  </>
}
