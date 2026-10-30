import { NetworkCapacityDetail } from './NetworkCapacityDetail'
import { NearestNetworkMap, type NetworkSearchResult } from './NearestNetworkMap'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import ExcelJS from 'exceljs'
import { LngLatBounds, Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { FeatureCollection, LineString, Point, Polygon } from 'geojson'
import { PageHeader } from '../../components/PageHeader'
import { TablePagination } from '../../components/TablePagination'
import { api } from '../../lib/api'

import { bulkJobStatusLabel } from './bulkJobStatus'

type HistoryItem = { id: string; analysisType: 'ADDRESS' | 'BULK' | 'FTTH_DESIGN'; title: string; status: string | null; itemCount: number; createdAt: string; bulkJobId?: string | null; jobStatus?: string | null; processedRows?: number | null; succeededRows?: number | null; failedRows?: number | null }
type HistoryPage = { items: HistoryItem[]; total: number; page: number; pageSize: number }
type RelatedDraft = { id: string; title: string; input: Record<string, unknown>; result: Record<string, unknown>; createdAt: string }
type HistoryDetail = { id: string; analysisType: 'ADDRESS' | 'BULK' | 'FTTH_DESIGN'; title: string; input: Record<string, unknown>; result: Record<string, unknown>; createdAt: string; relatedDrafts?: RelatedDraft[]; bulkJobId?: string | null; jobStatus?: string | null; totalRows?: number | null; processedRows?: number | null; succeededRows?: number | null; failedRows?: number | null }
type BulkRow = { row: number; address: string; latitude?: number | null; longitude?: number | null; network?: { name?: string } | null; distanceMeters?: number | null; status: string; message?: string }
type SavedMapPoint = { latitude: number; longitude: number; label: string; kind?: string }
type SavedMapRoute = { routeType: string; coordinates: [number, number][] }
type SavedMapRadius = { latitude: number; longitude: number; radiusMeters: number }
type DraftFeature = { kind: string; name: string; routeType?: string; designAnchor?: boolean; geometry: { type: 'Point'; coordinates: [number, number] } | { type: 'LineString'; coordinates: [number, number][] } }

function downloadWorkbook(workbook: ExcelJS.Workbook, name: string) {
  void workbook.xlsx.writeBuffer().then((buffer) => {
    const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const link = document.createElement('a'); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
}

function savedMapPoint(latitude: unknown, longitude: unknown, label: string, kind?: string): SavedMapPoint | null {
  if (latitude == null || longitude == null || String(latitude).trim() === '' || String(longitude).trim() === '') return null
  const lat = Number(latitude)
  const lon = Number(longitude)
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { latitude: lat, longitude: lon, label, kind } : null
}

function addFtthMapIcons(map: MapLibreMap) {
  for (const [kind, color] of [['OLT', '#e8b500'], ['ODC', '#ff0000'], ['ODP', '#0000ff'], ['POLE', '#536177']] as const) {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext('2d')!
    context.scale(2, 2)
    if (kind === 'ODC' || kind === 'ODP') {
      context.fillStyle = color
      context.beginPath()
      context.moveTo(16, 4)
      context.lineTo(28, 27)
      context.lineTo(4, 27)
      context.closePath()
      context.fill()
      context.globalCompositeOperation = 'destination-out'
      context.beginPath()
      context.arc(16, 19, 3.5, 0, 2 * Math.PI)
      context.fill()
      context.globalCompositeOperation = 'source-over'
    } else if (kind === 'OLT') {
      context.fillStyle = '#fff'
      context.strokeStyle = '#d9a400'
      context.lineWidth = 1.5
      context.beginPath()
      context.roundRect(5, 7, 22, 20, 2)
      context.fill()
      context.stroke()
      for (const y of [12, 18, 24]) {
        context.fillStyle = '#e8b500'
        context.fillRect(8, y - 1, 16, 3)
        context.fillStyle = '#fff'
        context.fillRect(10, y, 2, 1)
      }
    } else {
      context.strokeStyle = color
      context.lineWidth = 2.5
      context.beginPath()
      context.moveTo(16, 4); context.lineTo(16, 29)
      context.moveTo(8, 10); context.lineTo(24, 10)
      context.moveTo(10, 15); context.lineTo(22, 15)
      context.moveTo(13, 7); context.lineTo(13, 11)
      context.moveTo(19, 7); context.lineTo(19, 11)
      context.moveTo(11, 29); context.lineTo(21, 29)
      context.stroke()
    }
    map.addImage(`history-ftth-${kind.toLowerCase()}`, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 })
  }
}

function draftRadius(features: { designAnchor?: boolean; geometry: { type: 'Point'; coordinates: number[] } | { type: 'LineString'; coordinates: number[][] } }[]): SavedMapRadius[] {
  const anchor = features.find((feature) => feature.geometry.type === 'Point' && feature.designAnchor)
    ?? features.find((feature) => feature.geometry.type === 'Point')
  if (!anchor || anchor.geometry.type !== 'Point') return []
  const [longitude, latitude] = anchor.geometry.coordinates
  return [{ latitude, longitude, radiusMeters: 500 }]
}

function radiusRing({ latitude, longitude, radiusMeters }: SavedMapRadius): [number, number][] {
  const angularDistance = radiusMeters / 6_371_008.8
  const latitudeRadians = latitude * Math.PI / 180
  const longitudeRadians = longitude * Math.PI / 180
  const coordinates = Array.from({ length: 65 }, (_, index) => {
    const bearing = index / 64 * 2 * Math.PI
    const nextLatitude = Math.asin(Math.sin(latitudeRadians) * Math.cos(angularDistance)
      + Math.cos(latitudeRadians) * Math.sin(angularDistance) * Math.cos(bearing))
    const nextLongitude = longitudeRadians + Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitudeRadians),
      Math.cos(angularDistance) - Math.sin(latitudeRadians) * Math.sin(nextLatitude),
    )
    return [nextLongitude * 180 / Math.PI, nextLatitude * 180 / Math.PI] as [number, number]
  })
  coordinates[64] = coordinates[0]
  return coordinates
}

function SavedAnalysisMap({ points, routes = [], radii = [] }: { points: SavedMapPoint[]; routes?: SavedMapRoute[]; radii?: SavedMapRadius[] }) {
  const container = useRef<HTMLDivElement>(null)
  const pointsKey = points.map(({ longitude, latitude, label }) => `${longitude},${latitude},${label}`).join('|')
  const routesKey = routes.map(({ routeType, coordinates }) => `${routeType}:${coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`).join(';')}`).join('|')
  const radiiKey = radii.map(({ longitude, latitude, radiusMeters }) => `${longitude},${latitude},${radiusMeters}`).join('|')

  useEffect(() => {
    if (!container.current || (!points.length && !routes.length && !radii.length)) return
    setWorkerUrl(workerUrl)
    const coordinates = [
      ...points.map(({ longitude, latitude }) => [longitude, latitude] as [number, number]),
      ...routes.flatMap(({ coordinates: routeCoordinates }) => routeCoordinates),
      ...radii.flatMap(radiusRing),
    ]
    const map = new MapLibreMap({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: coordinates[0], zoom: 15 })
    map.addControl(new NavigationControl(), 'top-right')
    map.on('load', () => {
      addFtthMapIcons(map)
      if (radii.length) {
        const data: FeatureCollection<Polygon, { radiusMeters: number }> = {
          type: 'FeatureCollection',
          features: radii.map((radius) => ({ type: 'Feature', properties: { radiusMeters: radius.radiusMeters }, geometry: { type: 'Polygon', coordinates: [radiusRing(radius)] } })),
        }
        map.addSource('saved-analysis-radii', { type: 'geojson', data })
        map.addLayer({ id: 'saved-analysis-radius-fill', type: 'fill', source: 'saved-analysis-radii', paint: { 'fill-color': '#3454d1', 'fill-opacity': 0.12 } })
        map.addLayer({ id: 'saved-analysis-radius-line', type: 'line', source: 'saved-analysis-radii', paint: { 'line-color': '#3454d1', 'line-width': 2, 'line-dasharray': [2, 2] } })
      }
      if (points.length) {
        const data: FeatureCollection<Point, { label: string; kind?: string }> = {
          type: 'FeatureCollection',
          features: points.map((point) => ({ type: 'Feature', properties: { label: point.label, kind: point.kind ?? '' }, geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] } })),
        }
        map.addSource('saved-analysis-points', { type: 'geojson', data })
        map.addLayer({ id: 'saved-analysis-points', type: 'circle', source: 'saved-analysis-points', filter: ['!', ['in', ['get', 'kind'], ['literal', ['OLT', 'ODC', 'ODP', 'POLE']]]], paint: {
          'circle-radius': 8,
          'circle-color': '#405bd8',
          'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
        } })
      }
      if (routes.length) {
        const data: FeatureCollection<LineString, { routeType: string }> = {
          type: 'FeatureCollection',
          features: routes.map((route) => ({ type: 'Feature', properties: { routeType: route.routeType }, geometry: { type: 'LineString', coordinates: route.coordinates } })),
        }
        map.addSource('saved-analysis-routes', { type: 'geojson', data })
        map.addLayer({ id: 'saved-analysis-routes', type: 'line', source: 'saved-analysis-routes', paint: { 'line-color': ['match', ['get', 'routeType'], 'FEEDER', '#ff0000', '#a000ff'], 'line-width': 4 } })
      }
      if (points.some((point) => ['OLT', 'ODC', 'ODP'].includes(point.kind ?? ''))) {
        map.addLayer({ id: 'saved-analysis-ftth-assets', type: 'symbol', source: 'saved-analysis-points', filter: ['in', ['get', 'kind'], ['literal', ['OLT', 'ODC', 'ODP']]], layout: { 'icon-image': ['concat', 'history-ftth-', ['downcase', ['get', 'kind']]], 'icon-size': 0.8, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
      }
      if (points.some((point) => point.kind === 'POLE')) {
        map.addLayer({ id: 'saved-analysis-ftth-poles', type: 'symbol', source: 'saved-analysis-points', filter: ['==', ['get', 'kind'], 'POLE'], layout: { 'icon-image': 'history-ftth-pole', 'icon-size': 0.62, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
      }
      if (new Set(coordinates.map(([longitude, latitude]) => `${longitude},${latitude}`)).size > 1) {
        const bounds = coordinates.reduce((value, coordinate) => value.extend(coordinate), new LngLatBounds())
        map.fitBounds(bounds, { padding: 48, maxZoom: 14 })
      }
    })
    return () => map.remove()
    // Geometry keys keep the map stable across parent renders while rebuilding it when saved coordinates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey, routesKey, radiiKey])

  return <div ref={container} role="img" aria-label="Peta lokasi dari hasil analisis tersimpan" className="border rounded overflow-hidden" style={{ height: 360, width: '100%' }} />
}

const dateTime = (value: string) => new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))

function HoverActionButton({ label, className, disabled, onClick, children }: { label: string; className: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const show = (element: HTMLButtonElement) => {
    const rect = element.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 8, rect.left + rect.width / 2)), top: rect.top > 48 ? rect.top - 8 : rect.bottom + 8 })
  }
  const hide = () => setPosition(null)
  return <><button type="button" className={className} aria-label={label} aria-describedby={position ? 'history-action-tooltip' : undefined} disabled={disabled} onClick={onClick} onMouseEnter={(event) => show(event.currentTarget)} onMouseLeave={hide} onFocus={(event) => show(event.currentTarget)} onBlur={hide}>{children}</button>{position && createPortal(<div id="history-action-tooltip" role="tooltip" style={{ position: 'fixed', zIndex: 3000, left: position.left, top: position.top, transform: `translate(-50%, ${position.top < 60 ? '0' : '-100%'})`, pointerEvents: 'none', padding: '5px 9px', borderRadius: 5, background: '#172033', color: '#fff', fontSize: 12, lineHeight: 1.3, whiteSpace: 'nowrap', boxShadow: '0 2px 8px #0003' }}>{label}</div>, document.body)}</>
}

function BulkHistoryDetail({ detail, rows, mapPoints, mapRoutes, mapRadii, onOpenDraft }: { detail: HistoryDetail; rows: BulkRow[]; mapPoints: SavedMapPoint[]; mapRoutes: SavedMapRoute[]; mapRadii: SavedMapRadius[]; onOpenDraft: (id: string) => void }) {
  const [page, setPage] = useState(1)
  const pageSize = 25
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize))
  const visibleRows = rows.slice((page - 1) * pageSize, page * pageSize)
  const drafts = detail.relatedDrafts ?? []
  const rowCount = detail.totalRows ?? rows.length
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  return <>
    <div className="alert alert-light border">File: <b>{String(detail.input.fileName ?? detail.title)}</b> · {rowCount.toLocaleString('id-ID')} baris tersimpan.</div>
    {drafts.length > 0 && <section className="mb-3"><h4 className="h6 mb-2">Draft FTTH dari analisis ini</h4><div className="d-flex flex-column gap-2">{drafts.map((draft) => {
      const sourceRow = Number(draft.input.sourceRow)
      const sourceAddress = rows.find((row) => row.row === sourceRow)?.address
      const features = Array.isArray(draft.result.features) ? draft.result.features as DraftFeature[] : []
      return <div className="border rounded p-3 d-flex align-items-center gap-3 flex-wrap" key={draft.id}><div className="flex-grow-1"><b>{sourceAddress ? `Baris ${sourceRow} · ${sourceAddress}` : draft.title}</b><small className="d-block text-secondary">{features.filter((feature) => feature.geometry.type === 'Point').length} aset · {features.filter((feature) => feature.geometry.type === 'LineString').length} jalur kabel · {dateTime(draft.createdAt)}</small></div><button className="btn btn-sm btn-outline-primary" onClick={() => onOpenDraft(draft.id)}>Buka detail draft</button></div>
    })}</div></section>}
    {mapPoints.length > 0 && <section className="mb-3"><h4 className="h6 mb-2">{drafts.length ? 'Peta analisis dan draft FTTH tersimpan' : 'Peta titik analisis tersimpan'}</h4><SavedAnalysisMap points={mapPoints} routes={mapRoutes} radii={mapRadii} />{mapRadii.length > 0 && <small className="text-secondary">Lingkaran biru menunjukkan radius desain 500 m dari titik awal setiap draft.</small>}</section>}
    <div className="table-responsive"><table className="table table-sm align-middle"><thead><tr><th>BARIS</th><th>ALAMAT</th><th>KOORDINAT</th><th>JARINGAN</th><th>JARAK</th><th>STATUS</th></tr></thead><tbody>{visibleRows.map((row) => <tr key={row.row}><td>{row.row}</td><td>{row.address}</td><td className="font-monospace small">{row.latitude != null && row.longitude != null ? `${row.latitude}, ${row.longitude}` : '—'}</td><td>{row.network?.name ?? '—'}</td><td>{row.distanceMeters == null ? '—' : `${row.distanceMeters} m`}</td><td>{row.status}<small className="d-block text-secondary">{row.message}</small></td></tr>)}</tbody></table></div>
    <TablePagination page={page} pageSize={pageSize} total={rows.length} label="baris" onPageChange={setPage} />
    <details><summary>Lihat seluruh data file dan hasil</summary><pre className="bg-body-tertiary rounded p-3 mt-2 text-wrap">{JSON.stringify({ input: detail.input, result: detail.result }, null, 2)}</pre></details>
  </>
}

export function AnalysisHistoryPage() {
  const [type, setType] = useState('')
  const [page, setPage] = useState(1)
  const [selectedId, setSelectedId] = useState('')
  const [busyId, setBusyId] = useState('')
  const detailPanelRef = useRef<HTMLElement>(null)

  const history = useQuery({ queryKey: ['analysis-history', type, page], queryFn: () => api<HistoryPage>(`/analysis/history?page=${page}&pageSize=25${type ? `&type=${type}` : ''}`), placeholderData: (previous) => previous })
  const detail = useQuery({ queryKey: ['analysis-history', selectedId], queryFn: () => api<HistoryDetail>(`/analysis/history/${selectedId}`), enabled: Boolean(selectedId) })
  useEffect(() => { if (history.data && page > Math.max(1, Math.ceil(history.data.total / history.data.pageSize))) setPage(Math.max(1, Math.ceil(history.data.total / history.data.pageSize))) }, [history.data, page])
  useEffect(() => {
    if (selectedId && !detail.isPending) detailPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedId, detail.isPending])
  const result = detail.data?.result ?? {}
  const rows = Array.isArray(result.rows) ? result.rows as BulkRow[] : []
  const savedDraftFeatures = Array.isArray(result.features) ? result.features as DraftFeature[] : []
  const relatedDrafts = detail.data?.relatedDrafts ?? []
  const relatedDraftFeatures = relatedDrafts.flatMap((draft) => Array.isArray(draft.result.features) ? draft.result.features as DraftFeature[] : [])
  const mapRadii = detail.data?.analysisType === 'FTTH_DESIGN'
    ? draftRadius(savedDraftFeatures)
    : relatedDrafts.flatMap((draft) => draftRadius(Array.isArray(draft.result.features) ? draft.result.features as DraftFeature[] : []))
  const mapPoints = detail.data?.analysisType === 'ADDRESS'
    ? [...[savedMapPoint(result.latitude, result.longitude, String(result.address ?? detail.data.title))].filter((point): point is SavedMapPoint => point !== null), ...relatedDraftFeatures.flatMap((feature) => feature.geometry.type === 'Point' ? [savedMapPoint(feature.geometry.coordinates[1], feature.geometry.coordinates[0], `${feature.kind} · ${feature.name}`, feature.kind)].filter((point): point is SavedMapPoint => point !== null) : [])]
    : detail.data?.analysisType === 'FTTH_DESIGN'
      ? savedDraftFeatures.flatMap((feature) => feature.geometry.type === 'Point' ? [savedMapPoint(feature.geometry.coordinates[1], feature.geometry.coordinates[0], `${feature.kind} · ${feature.name}`, feature.kind)].filter((point): point is SavedMapPoint => point !== null) : [])
      : [...rows.flatMap((row) => { const point = savedMapPoint(row.latitude, row.longitude, row.address); return point ? [point] : [] }), ...relatedDraftFeatures.flatMap((feature) => feature.geometry.type === 'Point' ? [savedMapPoint(feature.geometry.coordinates[1], feature.geometry.coordinates[0], `${feature.kind} · ${feature.name}`, feature.kind)].filter((point): point is SavedMapPoint => point !== null) : [])]
  const mapRoutes = detail.data?.analysisType === 'FTTH_DESIGN'
    ? savedDraftFeatures.flatMap((feature) => feature.geometry.type === 'LineString' ? [{ routeType: feature.routeType ?? 'DISTRIBUTION', coordinates: feature.geometry.coordinates }] : [])
    : relatedDraftFeatures.flatMap((feature) => feature.geometry.type === 'LineString' ? [{ routeType: feature.routeType ?? 'DISTRIBUTION', coordinates: feature.geometry.coordinates }] : [])
  const exportHistory = async (item: HistoryItem) => {
    setBusyId(item.id)
    try {
      const saved = await api<HistoryDetail>(`/analysis/history/${item.id}`)
      const outerResult = saved.result && typeof saved.result === 'object' ? saved.result : {}
      const result = outerResult.result && typeof outerResult.result === 'object' ? outerResult.result as Record<string, unknown> : outerResult
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('Hasil Analisis')
      sheet.addRow(['Alamat / Aset', 'Latitude', 'Longitude', 'Nearest Network', 'Estimasi Jarak (m)', 'Status'])
      const resultData = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {}
      const bulkRows = Array.isArray(result.rows) ? result.rows : Array.isArray(resultData.rows) ? resultData.rows : Array.isArray(result.results) ? result.results : []
      if (saved.analysisType === 'BULK') {
        if (saved.bulkJobId) {
          for (let page = 1; page <= Math.ceil((saved.totalRows ?? item.itemCount) / 100); page++) {
            const resultPage = await api<{ rows: BulkRow[] }>(`/analysis/bulk/jobs/${saved.bulkJobId}/rows?page=${page}&pageSize=100`)
            for (const row of resultPage.rows) sheet.addRow([row.address ?? '',row.latitude ?? '',row.longitude ?? '',row.network?.name ?? '',row.distanceMeters ?? '',row.status ?? ''])
          }
        } else for (const value of bulkRows) {
          const row = value as BulkRow
          sheet.addRow([row.address ?? '', row.latitude ?? '', row.longitude ?? '', row.network?.name ?? '', row.distanceMeters ?? '', row.status ?? ''])
        }
      } else if (saved.analysisType === 'ADDRESS') {
        const inputAddress = (saved.input as { address?: string } | undefined)?.address
        const coordinates = Array.isArray(result.coordinates) ? result.coordinates as unknown[] : []
        sheet.addRow([String(result.address ?? inputAddress ?? saved.title), result.latitude ?? coordinates[1] ?? '', result.longitude ?? coordinates[0] ?? '', (result.network as { name?: string } | null)?.name ?? '', result.distanceMeters ?? '', String(result.status ?? '')])
      } else {
        const featureCollection = result.features && typeof result.features === 'object' && !Array.isArray(result.features) ? result.features as { features?: unknown[] } : null
        const features = Array.isArray(result.features) ? result.features : featureCollection?.features ?? []
        for (const value of features) {
          const feature = value as DraftFeature & { properties?: { kind?: string; name?: string }; geometry?: { type?: string; coordinates?: number[] } }
          const geometry = feature.geometry
          if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
            const kind = feature.kind ?? feature.properties?.kind ?? 'Aset'
            const name = feature.name ?? feature.properties?.name ?? ''
            sheet.addRow([`${kind}${name ? ` · ${name}` : ''}`, geometry.coordinates[1], geometry.coordinates[0], 'Tidak dihitung untuk draft FTTH', 'Tidak dihitung untuk draft FTTH', 'Draft FTTH'])
          }
        }
      }
      if (sheet.rowCount <= 1) {
        const keys = Object.keys(outerResult).join(', ') || 'tidak ada'
        throw new Error(`Data lokasi tidak ditemukan di riwayat ini (jenis ${saved.analysisType}; field hasil: ${keys}). Buka detail untuk memastikan datanya tersimpan.`)
      }
      sheet.getRow(1).font = { bold: true }
      sheet.columns.forEach((column) => { column.width = Math.min(48, Math.max(16, ...column.values!.map((value) => String(value ?? '').length + 2))) })
      sheet.views = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activeCell: 'A2' }]
      downloadWorkbook(workbook, `ATLAS-${item.analysisType.toLowerCase()}-${item.id.slice(0, 8)}.xlsx`)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Data riwayat gagal diekspor.')
    } finally { setBusyId('') }
  }
  const deleteHistory = async (item: HistoryItem) => {
    if (!window.confirm(`Hapus riwayat “${item.title}”?`)) return
    setBusyId(item.id)
    try {
      await api(`/analysis/history/${item.id}`, { method: 'DELETE' })
      if (selectedId === item.id) setSelectedId('')
      await history.refetch()
    } finally { setBusyId('') }
  }

  return <>
    <PageHeader title="Riwayat Analisis" subtitle="Hasil analisis alamat, massal, dan draft FTTH tersimpan di database dan dapat dibuka kembali." />
    <section className="card panel-card">
      <div className="card-header d-flex align-items-center gap-3 flex-wrap"><div><h3>Semua analisis</h3><p>Riwayat milik akun Anda, terbaru ditampilkan lebih dulu.</p></div><div className="d-flex align-items-center gap-2 ms-auto flex-nowrap"><select className="form-select form-select-sm" style={{ width: 165 }} aria-label="Filter jenis analisis" value={type} onChange={(event) => { setType(event.target.value); setPage(1); setSelectedId('') }}><option value="">Semua jenis</option><option value="ADDRESS">Analisis alamat</option><option value="BULK">Analisis massal</option><option value="FTTH_DESIGN">Draft FTTH</option></select><button type="button" className="btn btn-sm btn-outline-primary text-nowrap" style={{ padding: '6px 10px' }} onClick={() => void history.refetch()} disabled={history.isFetching}><i className={`bi bi-arrow-clockwise me-1${history.isFetching ? ' spin' : ''}`} />Muat ulang</button></div></div>
      {history.isPending ? <div className="py-5 text-center"><span className="spinner-border spinner-border-sm me-2" />Memuat riwayat...</div>
        : history.isError ? <div className="alert alert-danger m-3">Riwayat analisis tidak dapat dimuat.</div>
          : !history.data?.items.length && history.data.total === 0 ? <div className="empty-result py-5"><div className="empty-illustration"><i className="bi bi-clock-history" /></div><h3>Belum ada riwayat analisis</h3><p>Setelah analisis alamat, massal, atau draft FTTH disimpan, hasilnya akan muncul di sini.</p></div>
            : !history.data?.items.length ? <div className="py-5 text-center text-secondary">Menyesuaikan halaman riwayat...</div>
              : <div className="table-responsive"><table className="table align-middle mb-0"><thead><tr><th>WAKTU</th><th>JENIS</th><th>ALAMAT / FILE</th><th>JUMLAH / PROGRES</th><th></th></tr></thead><tbody>{history.data.items.map((item) => <tr key={item.id} className={selectedId === item.id ? 'table-primary' : ''}><td className="text-nowrap">{dateTime(item.createdAt)}</td><td><span className="badge text-bg-light border">{item.analysisType === 'ADDRESS' ? 'Analisis alamat' : item.analysisType === 'BULK' ? 'Analisis massal' : 'Draft FTTH'}</span></td><td className="text-break">{item.title}</td><td>{item.bulkJobId ? <>{item.processedRows ?? 0}/{item.itemCount} · {bulkJobStatusLabel(item.jobStatus)}</> : <>{item.itemCount} {item.analysisType === 'ADDRESS' ? 'lokasi' : item.analysisType === 'BULK' ? 'baris' : 'aset'}</>}</td><td className="text-end text-nowrap">{item.bulkJobId && <HoverActionButton label="Buka hasil dan progres pekerjaan analisis massal" className="btn btn-sm btn-outline-success me-1" onClick={() => { window.location.href = `/analisis-massal?jobId=${item.bulkJobId}` }}><i className="bi bi-box-arrow-up-right" aria-hidden="true" /></HoverActionButton>}{item.analysisType === 'ADDRESS' && <HoverActionButton label="Buka hasil analisis alamat" className="btn btn-sm btn-outline-success me-1" onClick={() => setSelectedId(item.id)}><i className="bi bi-box-arrow-up-right" aria-hidden="true" /></HoverActionButton>}<HoverActionButton label="Unduh hasil sebagai file Excel" className="btn btn-sm btn-outline-success me-1" disabled={busyId === item.id} onClick={() => void exportHistory(item)}><i className="bi bi-file-earmark-excel" aria-hidden="true" /></HoverActionButton><HoverActionButton label="Hapus catatan riwayat ini" className="btn btn-sm btn-outline-danger me-1" disabled={busyId === item.id} onClick={() => void deleteHistory(item)}><i className="bi bi-trash" aria-hidden="true" /></HoverActionButton><HoverActionButton label={selectedId === item.id ? 'Tutup panel detail' : 'Lihat detail analisis'} className="btn btn-sm btn-outline-primary" onClick={() => setSelectedId(selectedId === item.id ? '' : item.id)}><i className={`bi ${selectedId === item.id ? 'bi-eye-slash' : 'bi-eye'}`} aria-hidden="true" /></HoverActionButton></td></tr>)}</tbody></table></div>}
      <div className="card-footer d-flex align-items-center justify-content-between gap-2 flex-wrap small text-secondary">
        <span>{history.data ? `${history.data.total === 0 ? 0 : ((page - 1) * history.data.pageSize + 1).toLocaleString('id-ID')}–${Math.min(page * history.data.pageSize, history.data.total).toLocaleString('id-ID')} dari ${history.data.total.toLocaleString('id-ID')} riwayat` : 'Memuat jumlah riwayat…'}</span>
        <div className="d-flex align-items-center gap-2 ms-auto">
          <span>Halaman {page.toLocaleString('id-ID')} / {Math.max(1, Math.ceil((history.data?.total ?? 0) / (history.data?.pageSize ?? 25))).toLocaleString('id-ID')}</span>
          <div className="btn-group btn-group-sm" role="group" aria-label="Pagination riwayat analisis">
            <button className="btn btn-outline-secondary" aria-label="Sebelumnya" title="Sebelumnya" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || history.isFetching}><i className="bi bi-chevron-left" aria-hidden="true" /></button>
            <button className="btn btn-outline-secondary" aria-label="Berikutnya" title="Berikutnya" onClick={() => setPage((current) => current + 1)} disabled={!history.data || page >= Math.ceil(history.data.total / history.data.pageSize) || history.isFetching}><i className="bi bi-chevron-right" aria-hidden="true" /></button>
          </div>
        </div>
      </div>
    </section>
    {selectedId && <section ref={detailPanelRef} className="card panel-card mt-4">
      {detail.isPending ? <div className="card-body py-5 text-center"><span className="spinner-border spinner-border-sm me-2" />Memuat detail...</div>
        : detail.isError || !detail.data ? <div className="alert alert-danger m-3">Detail riwayat tidak dapat dibuka.</div>
          : <><div className="card-header d-flex align-items-start gap-3"><div className="flex-grow-1" style={{ minWidth: 0 }}><span className="detail-label">{detail.data.analysisType === 'ADDRESS' ? 'ANALISIS ALAMAT' : detail.data.analysisType === 'BULK' ? 'ANALISIS MASSAL' : 'DRAFT FTTH'}</span><h3 className="mt-1">{detail.data.title}</h3><p>{dateTime(detail.data.createdAt)}</p></div><button className="btn btn-sm btn-outline-secondary ms-auto flex-shrink-0" onClick={() => setSelectedId('')}>Tutup</button></div>
            <div className="card-body">
              {detail.data.analysisType === 'ADDRESS' ? <><div className="row g-3 mb-3"><div className="col-md-4"><small className="text-secondary d-block">Status</small><b>{String(result.status ?? '—')}</b></div><div className="col-md-4"><small className="text-secondary d-block">Koordinat</small><b className="font-monospace">{result.latitude != null && result.longitude != null ? `${result.latitude}, ${result.longitude}` : '—'}</b></div><div className="col-md-4"><small className="text-secondary d-block">Estimasi panjang kabel via jalan mobil</small><b>{result.distanceMeters == null ? '—' : `${result.distanceMeters} m`}</b></div><div className="col-12"><small className="text-secondary d-block">Jaringan terdekat</small><b>{(result.network as { name?: string } | null)?.name ?? '—'}</b></div></div>{relatedDrafts.length > 0 && <section className="mb-3"><h4 className="h6">Draft FTTH tersimpan</h4>{relatedDrafts.map((draft) => <div className="border rounded p-3 mb-2 d-flex align-items-center gap-3 flex-wrap" key={draft.id}><div className="flex-grow-1"><b>{draft.title}</b><small className="d-block text-secondary">{Number(draft.result.assetCount ?? 0)} aset · {Number(draft.result.routeCount ?? 0)} jalur kabel · {dateTime(draft.createdAt)}</small></div><button type="button" className="btn btn-sm btn-outline-primary" onClick={() => setSelectedId(draft.id)}>Buka draft</button></div>)}</section>}{Boolean(result.routeGeometry) && typeof result.latitude === "number" && typeof result.longitude === "number" && <div><NetworkCapacityDetail capacity={(result as unknown as NetworkSearchResult).network?.capacity}/><NearestNetworkMap result={result as unknown as NetworkSearchResult}/></div>} {mapPoints.length > 0 && !result.routeGeometry && <section className="mb-3"><h4 className="h6 mb-2">Peta lokasi{relatedDrafts.length ? ' dan draft FTTH tersimpan' : ' tersimpan'}</h4><SavedAnalysisMap points={mapPoints} routes={mapRoutes} radii={mapRadii} />{mapRadii.length > 0 && <small className="text-secondary">Lingkaran biru menunjukkan radius desain 500 m dari titik awal draft.</small>}</section>}<details><summary>Lihat semua data tersimpan</summary><pre className="bg-body-tertiary rounded p-3 mt-2 text-wrap">{JSON.stringify({ input: detail.data.input, result }, null, 2)}</pre></details></>
                : detail.data.analysisType === 'BULK' ? <>{detail.data.bulkJobId && <div className="alert alert-primary d-flex align-items-center justify-content-between gap-2 flex-wrap"><span>Status: <b>{bulkJobStatusLabel(detail.data.jobStatus)}</b> · {detail.data.processedRows ?? 0}/{detail.data.totalRows ?? 0} diproses · {detail.data.succeededRows ?? 0} berhasil · {detail.data.failedRows ?? 0} perlu diperiksa.</span><button className="btn btn-sm btn-primary" onClick={() => { window.location.href = `/analisis-massal?jobId=${detail.data.bulkJobId}` }}>Buka pekerjaan dan hasil</button></div>}<BulkHistoryDetail detail={detail.data} rows={rows} mapPoints={mapPoints} mapRoutes={mapRoutes} mapRadii={mapRadii} onOpenDraft={setSelectedId} /></>
                  : <><div className="alert alert-light border">Draft FTTH tersimpan: <b>{Number(result.assetCount ?? mapPoints.length)} aset</b> · <b>{Number(result.routeCount ?? mapRoutes.length)} jalur kabel</b>.</div>{(mapPoints.length > 0 || mapRoutes.length > 0) && <section className="mb-3"><h4 className="h6 mb-2">Peta draft FTTH tersimpan</h4><SavedAnalysisMap points={mapPoints} routes={mapRoutes} radii={mapRadii} /><small className="text-secondary">Lingkaran biru menunjukkan radius desain 500 m dari titik awal draft.</small></section>}<details><summary>Lihat semua data draft tersimpan</summary><pre className="bg-body-tertiary rounded p-3 mt-2 text-wrap">{JSON.stringify({ input: detail.data.input, result }, null, 2)}</pre></details></>}
            </div></>}
    </section>}
  </>
}
