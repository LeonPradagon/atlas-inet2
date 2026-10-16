import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import ExcelJS from 'exceljs'
import { LngLatBounds, Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { FeatureCollection, LineString, Point, Polygon } from 'geojson'
import { PageHeader } from '../../components/PageHeader'
import { api, postCompressedJson } from '../../lib/api'
import { generateFtthDraft, offsetCoordinate, type DesignFeature } from './ftthDraft'
import { bulkJobStatusLabel } from './bulkJobStatus'
import { Link } from '@tanstack/react-router'

type AnalysisRow = { row: number; address: string; latitude?: number | null; longitude?: number | null; network?: { name: string; area?: string } | null; distanceMeters?: number | null; status: string; message?: string; result?: Record<string, unknown> | null }
type BulkJob = { jobId: string; historyId: string; fileName: string; status: string; total: number; processed: number; succeeded: number; failed: number; cancelRequested: boolean; savedDraftRows?: number[] }
type BulkMapPoint = { row: number; address: string; latitude: number; longitude: number; status: string }
type FtthAssetKind = 'OLT' | 'JOINT_CLOSURE' | 'HANDHOLE' | 'ODC' | 'ODP' | 'POLE'
const ftthAssetLabels: Record<FtthAssetKind, string> = { OLT: 'OLT', JOINT_CLOSURE: 'Joint Closure', HANDHOLE: 'Handhole', ODC: 'ODC', ODP: 'ODP', POLE: 'Tiang' }

const rowStatusLabel = (status: string) => status === 'ERROR' ? 'FAILED' : status

type DraftOverlay = { row: number; address: string; area: string; anchor: [number, number]; anchorKind: FtthAssetKind; poleHeight: string; features: DesignFeature[] }

function BulkResultsMap({ draftOverlays, mapPoints, selectedRow, onSelectRow }: { draftOverlays: DraftOverlay[]; mapPoints: BulkMapPoint[]; selectedRow: AnalysisRow | null; onSelectRow: (row: number) => void }) {
  const container = useRef<HTMLDivElement>(null)
  const points = mapPoints.filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
  const selected = selectedRow && Number.isFinite(selectedRow.latitude) && Number.isFinite(selectedRow.longitude) ? selectedRow : null
  const pointsKey = points.map(({ row,latitude,longitude,status }) => `${row}:${latitude},${longitude}:${status}`).join('|')
  const selectedKey = selected ? `${selected.row}:${selected.longitude},${selected.latitude}` : ''
  const selectedDraftOverlays = draftOverlays.filter((overlay) => overlay.row === selected?.row)

  useEffect(() => {
    if (!container.current || !points.length) return
    setWorkerUrl(workerUrl)
    const map = new MapLibreMap({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: [points[0].longitude, points[0].latitude], zoom: 5 })
    map.addControl(new NavigationControl(), 'top-right')
    map.on('load', () => {
      const data: FeatureCollection<Point, { address: string; network: string; distance: number | null; status: string; message: string }> = {
        type: 'FeatureCollection',
        features: points.map((row) => ({ type: 'Feature', properties: { row: row.row, address: row.address, network: '—', distance: null, status: row.status, message: '' }, geometry: { type: 'Point', coordinates: [row.longitude, row.latitude] } })),
      }
      const ring = (center: [number, number], radius: number) => {
        const coordinates = Array.from({ length: 65 }, (_, index) => offsetCoordinate(center, radius, index / 64 * 2 * Math.PI))
        coordinates[coordinates.length - 1] = coordinates[0]
        return coordinates
      }
      const boundaryRings = selected ? [ring([selected.longitude!, selected.latitude!], 500)] : []
      const odpRings = selectedDraftOverlays.flatMap((overlay) => overlay.features.flatMap((feature) => feature.properties.kind === 'ODP' && feature.geometry.type === 'Point' ? [ring(feature.geometry.coordinates as [number, number], 150)] : []))
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
      const routeGeometry = selectedRow?.result?.routeGeometry as { type?: string; coordinates?: [number,number][] } | undefined
      if (routeGeometry?.type === 'LineString' && Array.isArray(routeGeometry.coordinates)) {
        const routeData: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeGeometry.coordinates } }] }
        map.addSource('bulk-selected-route', { type: 'geojson', data: routeData })
        map.addLayer({ id: 'bulk-selected-route', type: 'line', source: 'bulk-selected-route', paint: { 'line-color': '#f29b38', 'line-width': 4 } })
      }
      const draftPoints = selectedDraftOverlays.flatMap((overlay) => [
        { type: 'Feature' as const, properties: { kind: overlay.anchorKind, name: `${ftthAssetLabels[overlay.anchorKind]} · ${selectedRow?.address ?? 'Titik analisis'}` }, geometry: { type: 'Point' as const, coordinates: overlay.anchor } },
        ...overlay.features.filter((feature) => feature.geometry.type === 'Point'),
      ])
      const draftLines = selectedDraftOverlays.flatMap((overlay) => overlay.features.filter((feature) => feature.geometry.type === 'LineString'))
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
        map.addLayer({ id: 'bulk-ftth-other-anchor', type: 'circle', source: 'bulk-ftth-points', filter: ['in', ['get', 'kind'], ['literal', ['JOINT_CLOSURE', 'HANDHOLE']]], paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'HANDHOLE', '#795548', 'JOINT_CLOSURE', '#8e24aa', '#64748b'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      }
      if (draftLines.length) {
        const lineData: FeatureCollection<LineString, { kind: string; name: string; routeType?: string }> = { type: 'FeatureCollection', features: draftLines as FeatureCollection<LineString, { kind: string; name: string; routeType?: string }>['features'] }
        map.addSource('bulk-ftth-lines', { type: 'geojson', data: lineData })
        map.addLayer({ id: 'bulk-ftth-routes', type: 'line', source: 'bulk-ftth-lines', paint: { 'line-color': ['match', ['get', 'routeType'], 'FEEDER', '#ff0000', 'DISTRIBUTION', '#a000ff', '#64748b'], 'line-width': ['match', ['get', 'routeType'], 'FEEDER', 4.5, 3.5] } })
      }
      map.addSource('bulk-analysis-points', { type: 'geojson', data, cluster: true, clusterRadius: 48, clusterMaxZoom: 13 })
      map.addLayer({ id: 'bulk-analysis-clusters', type: 'circle', source: 'bulk-analysis-points', filter: ['has', 'point_count'], paint: { 'circle-color': '#405bd8', 'circle-radius': ['step', ['get', 'point_count'], 18, 50, 24, 200, 32], 'circle-opacity': 0.88, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.addLayer({ id: 'bulk-analysis-cluster-count', type: 'symbol', source: 'bulk-analysis-points', filter: ['has', 'point_count'], layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-size': 12 }, paint: { 'text-color': '#fff' } })
      map.addLayer({ id: 'bulk-analysis-points', type: 'circle', source: 'bulk-analysis-points', filter: ['!', ['has', 'point_count']], paint: { 'circle-radius': 7, 'circle-color': ['case', ['==', ['get', 'status'], 'OK'], '#405bd8', '#f0a22e'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.on('mouseenter', 'bulk-analysis-points', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave', 'bulk-analysis-points', () => { map.getCanvas().style.cursor = '' })
      map.on('click', 'bulk-analysis-clusters', async (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['bulk-analysis-clusters'] })[0]
        const source = map.getSource('bulk-analysis-points') as import('maplibre-gl').GeoJSONSource
        const zoom = await source.getClusterExpansionZoom(Number(feature.properties?.cluster_id))
        map.easeTo({ center: (feature.geometry as Point).coordinates as [number,number], zoom })
      })
      map.on('click', 'bulk-analysis-points', (event) => {
        const feature = map.queryRenderedFeatures(event.point, { layers: ['bulk-analysis-points'] })[0]
        if (!feature) return
        onSelectRow(Number(feature.properties?.row))
        map.flyTo({ center: event.lngLat, zoom: 15 })
      })
      if (selected) {
        map.flyTo({ center: [selected.longitude!, selected.latitude!], zoom: 15 })
      } else if (points.length > 1) {
        const allBounds = points.reduce((bounds, point) => bounds.extend([point.longitude,point.latitude]), new LngLatBounds())
        map.fitBounds(allBounds, { padding: 36, maxZoom: 8 })
      } else if (points.length === 1) {
        map.setZoom(14)
      }
      if (selected && selectedDraftOverlays.length) {
        map.fitBounds(radiusBounds!, { padding: 48, maxZoom: 15 })
      }
    })
    return () => map.remove()
  }, [pointsKey, draftOverlays, selectedKey, onSelectRow])

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
  const [jobId, setJobId] = useState(() => new URLSearchParams(window.location.search).get('jobId') ?? '')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedRowNumber, setSelectedRowNumber] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [draftingRow, setDraftingRow] = useState<number | null>(null)
  const [savedDraftRows, setSavedDraftRows] = useState<Set<number>>(() => new Set())
  const [draftMessage, setDraftMessage] = useState<{ row: number; text: string; error: boolean } | null>(null)
  const [draftOverlays, setDraftOverlays] = useState<DraftOverlay[]>([])
  const [draftAssetKind, setDraftAssetKind] = useState<FtthAssetKind>('OLT')
  const [draftPoleHeight, setDraftPoleHeight] = useState('7 m')
  const [draftBatchProgress, setDraftBatchProgress] = useState<{ completed: number; total: number } | null>(null)
  const [draftBatchSummary, setDraftBatchSummary] = useState<{ generated: number; failed: number; stopped: boolean } | null>(null)
  const [saveBatchProgress, setSaveBatchProgress] = useState<{ completed: number; total: number } | null>(null)
  const [saveBatchSummary, setSaveBatchSummary] = useState<{ saved: number; failed: number } | null>(null)
  const stopDraftBatch = useRef(false)
  const saveBatchRunning = useRef(false)
  const queryClient = useQueryClient()
  const { data: user } = useQuery({ queryKey: ['me'], queryFn: () => api<{ role: string }>('/me') })
  const jobQuery = useQuery({ queryKey: ['bulk-job',jobId], queryFn: () => api<BulkJob>(`/analysis/bulk/jobs/${jobId}`), enabled: Boolean(jobId), refetchInterval: (query) => ['COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED','FAILED'].includes(query.state.data?.status ?? '') ? false : 1500 })
  const activeJob = !['COMPLETED','COMPLETED_WITH_ERRORS','CANCELLED','FAILED'].includes(jobQuery.data?.status ?? '')
  const pageQuery = useQuery({ queryKey: ['bulk-job-rows',jobId,page,search,statusFilter], queryFn: () => api<{ rows: AnalysisRow[]; total: number; page: number; pageSize: number }>(`/analysis/bulk/jobs/${jobId}/rows?page=${page}&pageSize=50&search=${encodeURIComponent(search)}&status=${encodeURIComponent(statusFilter)}`), enabled: Boolean(jobId), refetchInterval: activeJob ? 2000 : false })
  const mapQuery = useQuery({ queryKey: ['bulk-job-map-points',jobId], queryFn: () => api<BulkMapPoint[]>(`/analysis/bulk/jobs/${jobId}/map-points`), enabled: Boolean(jobId), refetchInterval: activeJob ? 5000 : false })
  useEffect(() => {
    if (!jobId || activeJob) return
    void queryClient.invalidateQueries({ queryKey: ['bulk-job-rows',jobId] })
    void queryClient.invalidateQueries({ queryKey: ['bulk-job-map-points',jobId] })
  }, [activeJob,jobId,queryClient])
  const rows = pageQuery.data?.rows ?? []
  const mapPoints = mapQuery.data ?? []
  const job = jobQuery.data
  const savedDraftRowSet = new Set([...(job?.savedDraftRows ?? []), ...savedDraftRows])
  const selectedRow = rows.find((row) => row.row === selectedRowNumber) ?? null
  const draftCandidates = rows.filter((row) => row.status === 'OK' && Number.isFinite(row.latitude) && Number.isFinite(row.longitude) && !savedDraftRowSet.has(row.row) && !draftOverlays.some((overlay) => overlay.row === row.row))
  const unsavedDrafts = draftOverlays.filter((overlay) => !savedDraftRowSet.has(overlay.row))
  const onSelectMapRow = useCallback((row: number) => { setSelectedRowNumber(row); setPage(Math.floor((row - 1) / 50) + 1); setSearch(''); setStatusFilter('') }, [])
  const clearCurrentJob = () => {
    if (draftBatchProgress || saveBatchProgress) return
    const url = new URL(window.location.href); url.searchParams.delete('jobId'); window.history.replaceState(window.history.state, '', url)
    localStorage.removeItem('atlas-bulk-job')
    if (input.current) input.current.value = ''
    setJobId(''); setPage(1); setSearch(''); setStatusFilter(''); setSelectedRowNumber(null); setDraftOverlays([]); setSavedDraftRows(new Set()); setDraftMessage(null); setSaveBatchSummary(null); setError('')
  }
  const processFile = async (file?: File) => {
    if (!file || draftBatchProgress || saveBatchProgress) return
    setError(''); setLoading(true)
    try {
      if (file.size > 15 * 1024 * 1024) throw new Error('Ukuran file melebihi batas 15 MB.')
      if (!/\.xlsx$/i.test(file.name)) throw new Error('Pilih file Excel dengan format .xlsx.')
      const form = new FormData(); form.append('file', file)
      const result = await api<BulkJob>('/analysis/bulk/jobs', { method: 'POST', data: form })
      const url = new URL(window.location.href); url.searchParams.set('jobId', result.jobId); window.history.replaceState(window.history.state, '', url)
      setJobId(result.jobId); setPage(1); setSelectedRowNumber(null); setDraftOverlays([]); setSavedDraftRows(new Set()); setDraftBatchSummary(null); setSaveBatchSummary(null)
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['bulk-job',result.jobId] }),queryClient.invalidateQueries({ queryKey: ['analysis-history'] })])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'File tidak dapat dibaca.') }
    finally { setLoading(false) }
  }
  const download = async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Hasil Analisis')
    sheet.addRow(['Alamat', 'Latitude', 'Longitude', 'Nearest Network', 'Estimasi Jarak Jalan (m)', 'Status', 'Pesan'])
    if (jobId) {
      for (let current = 1; current <= Math.ceil((job?.total ?? 0) / 100); current++) {
        const result = await api<{ rows: AnalysisRow[] }>(`/analysis/bulk/jobs/${jobId}/rows?page=${current}&pageSize=100`)
        result.rows.forEach((row) => sheet.addRow([row.address,row.latitude ?? '',row.longitude ?? '',row.network?.name ?? '',row.distanceMeters ?? '',row.status,row.message ?? '']))
      }
    }
    downloadWorkbook(workbook,'ATLAS-hasil-analisis.xlsx')
  }
  const downloadTemplate = () => {
    const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Lokasi')
    sheet.columns = [
      { header: 'Alamat', key: 'address', width: 34 }, { header: 'Provinsi', key: 'province', width: 28 },
      { header: 'Kabupaten/Kota', key: 'city', width: 34 }, { header: 'Kecamatan', key: 'district', width: 22 },
      { header: 'Kelurahan/Desa', key: 'village', width: 22 }, { header: 'Nomor Rumah', key: 'number', width: 16 },
      { header: 'Kode Pos', key: 'postalCode', width: 14 }, { header: 'Latitude', key: 'latitude', width: 14 },
      { header: 'Longitude', key: 'longitude', width: 14 },
    ]
    sheet.addRow(['Jl. Panjang Arteri Klp. Dua Raya','Daerah Khusus Ibukota Jakarta','Kota Administrasi Jakarta Barat','Kebon Jeruk','Kebon Jeruk','5','11530','',''])
    sheet.addRow(['Titik contoh Jakarta','','','','','','',-6.1754,106.8272])
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.autoFilter = 'A1:I1'
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3454D1' } }
    const instructions = workbook.addWorksheet('Petunjuk')
    instructions.columns = [{ width: 30 }, { width: 100 }]
    instructions.addRows([
      ['PANDUAN TEMPLATE ANALISIS MASSAL'],
      ['Pilih salah satu metode', 'Untuk setiap baris, isi alamat atau koordinat. Kolom Alamat boleh kosong jika memakai koordinat.'],
      ['Metode alamat', 'Isi Alamat, Provinsi, Kabupaten/Kota, dan Kecamatan. Kosongkan Latitude dan Longitude. Kelurahan/Desa, Nomor Rumah, dan Kode Pos opsional.'],
      ['Metode koordinat', 'Kosongkan Alamat dan kolom wilayah, lalu isi Latitude dan Longitude sekaligus. Jangan isi hanya salah satunya.'],
      ['Jika keduanya diisi', 'Jika alamat dan pasangan koordinat sama-sama diisi, sistem akan memakai koordinat.'],
      ['Format koordinat', 'Latitude antara -90 sampai 90; Longitude antara -180 sampai 180. Gunakan angka desimal.'],
      ['Sebelum upload', 'Ganti atau hapus dua baris contoh pada sheet Lokasi. Jangan ubah nama kolom di baris pertama.'],
      ['Batas upload', 'Maksimal 5.000 lokasi dan ukuran file 15 MB.'],
    ])
    instructions.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF3454D1' } }
    downloadWorkbook(workbook,'template-analisis-atlas.xlsx')
  }
  const generateDraft = async (row: AnalysisRow) => {
    if (row.status !== 'OK' || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) || user?.role !== 'ADMIN') return false
    setDraftingRow(row.row); setDraftMessage(null)
    try {
      const anchor: [number, number] = [row.longitude!, row.latitude!]
      const anchorKind = draftAssetKind, poleHeight = draftPoleHeight
      const { features, uncoveredTargets, generatedOlt } = await generateFtthDraft(anchor, anchorKind)
      setDraftOverlays((current) => [...current.filter((overlay) => overlay.row !== row.row), { row: row.row, address: row.address, area: row.network?.area ?? 'Analisis massal', anchor, anchorKind, poleHeight, features }])
      setDraftMessage({ row: row.row, text: `Draft FTTH siap ditinjau dengan titik awal ${ftthAssetLabels[anchorKind]}${generatedOlt ? '; OLT otomatis ditempatkan pada jalan terhubung yang strategis dan dilengkapi feeder.' : ''}${uncoveredTargets ? ` ${uncoveredTargets} titik belum terlayani.` : ''}${generatedOlt ? ' Verifikasi usulan lokasi OLT saat survei lapangan.' : ''}`, error: false })
      return true
    } catch (cause) {
      setDraftMessage({ row: row.row, text: cause instanceof Error ? cause.message : 'Draft FTTH tidak dapat dibuat.', error: true })
      return false
    } finally { setDraftingRow(null) }
  }
  const generateDraftsForPage = async () => {
    const candidates = rows.filter((row) => row.status === 'OK' && Number.isFinite(row.latitude) && Number.isFinite(row.longitude) && !savedDraftRowSet.has(row.row) && !draftOverlays.some((overlay) => overlay.row === row.row))
    if (!candidates.length || user?.role !== 'ADMIN') return
    stopDraftBatch.current = false
    setDraftBatchSummary(null); setDraftMessage(null); setDraftBatchProgress({ completed: 0, total: candidates.length })
    let generated = 0, failed = 0, completed = 0
    for (const row of candidates) {
      if (stopDraftBatch.current) break
      if (await generateDraft(row)) generated++; else failed++
      completed++
      setDraftBatchProgress({ completed, total: candidates.length })
    }
    setDraftBatchProgress(null)
    setDraftBatchSummary({ generated, failed, stopped: stopDraftBatch.current })
  }
  const persistDraft = async (draftOverlay: DraftOverlay) => {
    try {
      const result = await postCompressedJson<{ savedCount: number; designId: string }>('/assets/ftth-design', {
        area: draftOverlay.area,
        sourceAnalysisId: job?.historyId,
        sourceRow: draftOverlay.row,
        features: [
          { kind: draftOverlay.anchorKind, name: `${ftthAssetLabels[draftOverlay.anchorKind]} · ${draftOverlay.address}`.slice(0, 150), poleHeight: draftOverlay.anchorKind === 'POLE' ? draftOverlay.poleHeight : undefined, designAnchor: true, geometry: { type: 'Point', coordinates: draftOverlay.anchor } },
          ...draftOverlay.features.map(({ properties, geometry }) => ({ ...properties, geometry })),
        ],
      })
      setSavedDraftRows((current) => new Set(current).add(draftOverlay.row))
      try {
        localStorage.setItem('atlas-map-focus', JSON.stringify(draftOverlay.anchor))
        localStorage.setItem('atlas-map-focus-design', result.designId)
      } catch { /* Saving the design must not depend on browser storage. */ }
      return { savedCount: result.savedCount, error: '' }
    } catch (cause) { return { savedCount: 0, error: cause instanceof Error ? cause.message : 'Draft FTTH tidak dapat disimpan.' } }
  }
  const saveDraft = async (row: AnalysisRow) => {
    const draftOverlay = draftOverlays.find((overlay) => overlay.row === row.row)
    if (!draftOverlay || savedDraftRows.has(row.row) || user?.role !== 'ADMIN') return
    setDraftingRow(row.row); setDraftMessage(null); setSaveBatchSummary(null)
    try {
      const result = await persistDraft(draftOverlay)
      if (result.error) throw new Error(result.error)
      await Promise.all([['segments'], ['map-assets'], ['analysis-history'], ['bulk-job', jobId]].map((queryKey) => queryClient.invalidateQueries({ queryKey })))
      setDraftMessage({ row: row.row, text: `Draft FTTH tersimpan (${result.savedCount} aset/jalur). Radius 500 m tersimpan pada titik awal desain.`, error: false })
    } catch (cause) {
      setDraftMessage({ row: row.row, text: cause instanceof Error ? cause.message : 'Draft FTTH tidak dapat disimpan.', error: true })
    } finally { setDraftingRow(null) }
  }
  const saveAllDrafts = async () => {
    if (!unsavedDrafts.length || user?.role !== 'ADMIN' || saveBatchRunning.current || draftingRow !== null) return
    saveBatchRunning.current = true
    setSaveBatchSummary(null); setDraftMessage(null); setSaveBatchProgress({ completed: 0, total: unsavedDrafts.length })
    let saved = 0, failed = 0
    try {
      for (let index = 0; index < unsavedDrafts.length; index++) {
        const result = await persistDraft(unsavedDrafts[index])
        if (result.error) failed++; else saved++
        setSaveBatchProgress({ completed: index + 1, total: unsavedDrafts.length })
      }
      setSaveBatchSummary({ saved, failed })
      await Promise.all([['segments'], ['map-assets'], ['analysis-history'], ['bulk-job', jobId]].map((queryKey) => queryClient.invalidateQueries({ queryKey })))
      const last = unsavedDrafts.at(-1)!
      setDraftMessage({ row: last.row, text: failed ? `${saved} draft tersimpan; ${failed} gagal dan bisa dicoba ulang. Radius 500 m disimpan pada titik awal tiap desain.` : `${saved} draft tersimpan ke Peta Jaringan. Radius 500 m disimpan pada titik awal tiap desain.`, error: failed > 0 })
    } finally {
      saveBatchRunning.current = false
      setSaveBatchProgress(null)
    }
  }
  return <>
    <PageHeader title="Analisis massal" subtitle="Analisis hingga 5.000 lokasi di latar belakang." action={<button className="btn btn-outline-primary" onClick={downloadTemplate}><i className="bi bi-download me-2" />Unduh template</button>} />
    <div className="row g-4">
      <div className="col-xl-4"><section className="card panel-card"><div className="card-header"><div><h3>Unggah file lokasi</h3><p>Format .xlsx · maksimal 15 MB</p></div>{(jobId || error || search || statusFilter) && <button type="button" className="btn btn-sm btn-outline-secondary ms-auto" onClick={clearCurrentJob} disabled={loading || Boolean(draftBatchProgress || saveBatchProgress)} title="Kosongkan file dan hasil yang sedang dibuka"><i className="bi bi-eraser me-1" />Bersihkan</button>}</div><div className="card-body">
        <div className="upload-zone" role="button" tabIndex={0} aria-disabled={Boolean(draftBatchProgress || saveBatchProgress)} onClick={() => { if (!draftBatchProgress && !saveBatchProgress) input.current?.click() }} onKeyDown={(event) => { if (!draftBatchProgress && !saveBatchProgress && event.key === 'Enter') input.current?.click() }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!draftBatchProgress && !saveBatchProgress) void processFile(event.dataTransfer.files[0]) }}><span className="upload-icon"><i className="bi bi-cloud-arrow-up" /></span><b>Tarik file ke sini</b><span>atau <u>pilih dari perangkat</u></span><small>Maksimal 15 MB · 5.000 lokasi · .xlsx</small></div>
        <input ref={input} className="d-none" type="file" accept=".xlsx" disabled={Boolean(draftBatchProgress || saveBatchProgress)} onChange={(event) => { void processFile(event.target.files?.[0]); event.currentTarget.value = '' }} />
        {loading && <div className="mt-3"><span className="spinner-border spinner-border-sm me-2" />Mengunggah dan menyiapkan antrean...</div>}
        {job && <div className="selected-file"><i className="bi bi-file-earmark-excel text-success" /><span>{job.fileName}<small>{job.processed.toLocaleString('id-ID')} dari {job.total.toLocaleString('id-ID')} · {bulkJobStatusLabel(job.status)}</small></span>{['QUEUED','RUNNING'].includes(job.status) && <button className="btn btn-sm btn-outline-danger ms-auto" onClick={() => void api(`/analysis/bulk/jobs/${jobId}/cancel`,{method:'POST'}).then(() => queryClient.invalidateQueries({queryKey:['bulk-job',jobId]}))}>Batalkan</button>}</div>}
        {job && <div className="mt-3"><div className="progress" role="progressbar" aria-valuenow={job.processed} aria-valuemin={0} aria-valuemax={job.total}><div className="progress-bar" style={{width:`${job.total ? Math.round(job.processed / job.total * 100) : 0}%`}} /></div><small className="text-secondary">{job.succeeded} berhasil · {job.failed} perlu diperiksa</small></div>}
        {error && <div className="alert alert-danger mt-3 mb-0"><i className="bi bi-exclamation-circle me-2" />{error}</div>}
        <div className="upload-requirements mt-4"><b><i className="bi bi-info-circle me-2" />Format file</b><p>Alamat memerlukan Provinsi, Kabupaten/Kota, dan Kecamatan. Atau isi pasangan Latitude dan Longitude. Kelurahan, nomor rumah, serta kode pos opsional.</p></div>
      </div></section></div>
      <div className="col-xl-8"><section className="card panel-card result-table-card">
        <div className="card-header d-flex align-items-start gap-2 flex-wrap"><div><h3>Hasil analisis</h3><p>{job ? `${job.total.toLocaleString('id-ID')} lokasi · ${job.processed.toLocaleString('id-ID')} diproses` : 'Unggah file untuk memulai pekerjaan.'}</p></div>{job && job.processed === job.total && <div className="ms-auto d-flex align-items-end gap-2 flex-wrap">{user?.role === 'ADMIN' && <div><label className="form-label small mb-1" htmlFor="bulk-ftth-anchor-kind">Titik awal sebagai</label><select id="bulk-ftth-anchor-kind" className="form-select form-select-sm" value={draftAssetKind} onChange={(event) => setDraftAssetKind(event.target.value as FtthAssetKind)} disabled={Boolean(draftBatchProgress || saveBatchProgress) || draftingRow !== null}><option value="OLT">OLT</option><option value="JOINT_CLOSURE">Joint Closure</option><option value="HANDHOLE">Handhole</option><option value="ODC">ODC</option><option value="ODP">ODP</option><option value="POLE">Tiang</option></select></div>}{user?.role === 'ADMIN' && draftAssetKind === 'POLE' && <div><label className="form-label small mb-1" htmlFor="bulk-ftth-pole-height">Tinggi tiang</label><select id="bulk-ftth-pole-height" className="form-select form-select-sm" value={draftPoleHeight} onChange={(event) => setDraftPoleHeight(event.target.value)} disabled={Boolean(draftBatchProgress || saveBatchProgress) || draftingRow !== null}><option value="7 m">7 meter</option><option value="9 m">9 meter</option></select></div>}{user?.role === 'ADMIN' && (draftBatchProgress ? <button type="button" className="btn btn-outline-danger btn-sm" onClick={() => { stopDraftBatch.current = true }}>Hentikan draft ({draftBatchProgress.completed}/{draftBatchProgress.total})</button> : draftCandidates.length > 0 && <button type="button" className="btn btn-outline-primary btn-sm" onClick={() => void generateDraftsForPage()} disabled={Boolean(saveBatchProgress) || draftingRow !== null} title={`Buat draft untuk semua lokasi valid di halaman ini dengan titik awal ${ftthAssetLabels[draftAssetKind]}`}><i className="bi bi-diagram-3 me-2" />Generate draft FTTH ({draftCandidates.length})</button>)}{user?.role === 'ADMIN' && unsavedDrafts.length > 0 && <button type="button" className="btn btn-outline-success btn-sm" onClick={() => void saveAllDrafts()} disabled={Boolean(saveBatchProgress) || draftBatchProgress !== null || draftingRow !== null} title="Simpan semua draft FTTH yang sudah dibuat, termasuk dari halaman lain"><i className="bi bi-geo-alt me-2" />{saveBatchProgress ? `Menyimpan ${saveBatchProgress.completed}/${saveBatchProgress.total}` : `Simpan semua draft (${unsavedDrafts.length})`}</button>}<button className="btn btn-success btn-sm flex-shrink-0" onClick={() => void download()}><i className="bi bi-file-earmark-arrow-down me-2" />Unduh Excel</button></div>}</div>
        {draftBatchProgress && <div className="px-3 pt-3"><div className="progress" role="progressbar" aria-valuenow={draftBatchProgress.completed} aria-valuemin={0} aria-valuemax={draftBatchProgress.total}><div className="progress-bar" style={{ width: `${Math.round(draftBatchProgress.completed / draftBatchProgress.total * 100)}%` }} /></div><small className="text-secondary">Membuat draft FTTH berurutan: {draftBatchProgress.completed} dari {draftBatchProgress.total}. Draft yang selesai tetap tersimpan di sesi ini.</small></div>}
        {draftBatchSummary && <div className={`alert ${draftBatchSummary.failed ? 'alert-warning' : 'alert-success'} mx-3 mt-3 mb-0`}>{draftBatchSummary.generated} draft siap ditinjau{draftBatchSummary.failed ? ` · ${draftBatchSummary.failed} gagal dibuat` : ''}{draftBatchSummary.stopped ? ' · proses dihentikan' : ''}. Gunakan Simpan semua draft untuk menyimpan semua draft yang sudah dibuat, termasuk dari halaman lain.</div>}
        {saveBatchProgress && <div className="px-3 pt-3"><div className="progress" role="progressbar" aria-valuenow={saveBatchProgress.completed} aria-valuemin={0} aria-valuemax={saveBatchProgress.total}><div className="progress-bar bg-success" style={{ width: `${Math.round(saveBatchProgress.completed / saveBatchProgress.total * 100)}%` }} /></div><small className="text-secondary">Menyimpan draft ke Peta Jaringan berurutan: {saveBatchProgress.completed} dari {saveBatchProgress.total}.</small></div>}
        {saveBatchSummary && <div className={`alert ${saveBatchSummary.failed ? 'alert-warning' : 'alert-success'} mx-3 mt-3 mb-0`}>{saveBatchSummary.saved} draft tersimpan{saveBatchSummary.failed ? ` · ${saveBatchSummary.failed} gagal dan tetap tersedia untuk dicoba ulang` : ''}.</div>}
        {job && <><div className="alert alert-info m-3 mb-0">Ringkasan peta mengelompokkan seluruh titik. Pilih titik pada peta atau baris tabel untuk melihat radius 500 m dan detail lokasi.</div>
          {mapPoints.length > 0 && <section className="p-3 pb-0"><h4 className="h6 mb-2">Peta lokasi · {mapPoints.length.toLocaleString('id-ID')} titik</h4><BulkResultsMap draftOverlays={draftOverlays} mapPoints={mapPoints} selectedRow={selectedRow} onSelectRow={onSelectMapRow} /><div className="small text-secondary mt-2">Lingkaran 500 m hanya terlihat saat lokasi dipilih.</div></section>}
          {selectedRow && <section className="mx-3 mt-3 p-3 border rounded"><div className="d-flex justify-content-between gap-2"><div><b>{selectedRow.address}</b><div className="small text-secondary">{selectedRow.latitude}, {selectedRow.longitude} · {selectedRow.status}</div><div className="small">Jaringan: {selectedRow.network?.name ?? '—'} · Jarak jalan: {selectedRow.distanceMeters ?? '—'}{selectedRow.distanceMeters != null ? ' m' : ''}</div>{selectedRow.message && <small className="text-secondary">{selectedRow.message}</small>}</div><button className="btn btn-sm btn-light" onClick={() => setSelectedRowNumber(null)}>Tutup</button></div></section>}
          {draftMessage && <div className={`alert ${draftMessage.error ? 'alert-danger' : 'alert-success'} mx-3 mt-3 mb-0`}><div>{draftMessage.text}</div>{!draftMessage.error && savedDraftRows.has(draftMessage.row) && <div className="d-flex gap-2 mt-2"><Link to="/peta-jaringan" className="btn btn-sm btn-outline-success">Lihat di Peta Jaringan</Link><Link to="/riwayat-analisis" className="btn btn-sm btn-outline-success">Buka Riwayat Analisis</Link></div>}</div>}
          <div className="row g-2 px-3 mt-3"><div className="col-md"><input className="form-control form-control-sm" value={search} placeholder="Cari alamat..." onChange={(event) => { setSearch(event.target.value); setPage(1) }} /></div><div className="col-md-4"><select className="form-select form-select-sm" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1) }}><option value="">Semua status</option><option value="OK">Berhasil</option><option value="ERROR">Gagal</option><option value="QUEUED">Menunggu</option><option value="PROCESSING">Diproses</option><option value="CANCELLED">Dibatalkan</option></select></div></div>
          <div className="table-responsive mt-3"><table className="table atlas-table mb-0"><thead><tr><th>Baris</th><th>Lokasi</th><th>Koordinat</th><th>Jaringan</th><th>Jarak</th><th>Status</th>{user?.role === 'ADMIN' && <th>Aksi</th>}</tr></thead><tbody>{rows.map((row) => { const draftSaved = savedDraftRowSet.has(row.row); const draftReady = draftOverlays.some((overlay) => overlay.row === row.row); return <tr key={row.row} className={selectedRowNumber === row.row ? 'table-primary' : ''} onClick={() => setSelectedRowNumber(row.row)} style={{cursor:'pointer'}}><td>{row.row}</td><td className="address-cell">{row.address}</td><td className="text-muted small">{row.latitude != null && row.longitude != null ? `${row.latitude}, ${row.longitude}` : '—'}</td><td><span className="cable-name">{row.network?.name ?? '—'}</span></td><td>{row.distanceMeters == null ? '—' : `${row.distanceMeters} m`}</td><td><span className={row.status === 'OK' ? 'status-success' : 'text-warning'}>{rowStatusLabel(row.status)}</span><small className="d-block text-muted">{row.message ?? ''}</small></td>{user?.role === 'ADMIN' && <td className="text-nowrap" onClick={(event) => event.stopPropagation()}><div className="d-flex gap-2 flex-wrap"><button className={`btn btn-sm ${draftSaved ? 'btn-success' : 'btn-outline-primary'}`} onClick={() => { setSelectedRowNumber(row.row); void generateDraft(row) }} disabled={Boolean(draftBatchProgress || saveBatchProgress) || draftingRow !== null || draftSaved || draftReady || row.status !== 'OK' || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)}>{draftingRow === row.row ? <><span className="spinner-border spinner-border-sm me-1" />Memproses...</> : draftSaved ? 'Draft tersimpan' : draftReady ? 'Draft siap' : 'Generate draft FTTH'}</button>{!draftSaved && draftReady && <button className="btn btn-sm btn-outline-success" onClick={() => void saveDraft(row)} disabled={Boolean(draftBatchProgress || saveBatchProgress) || draftingRow !== null}>Simpan ke peta</button>}</div></td>}</tr> })}</tbody></table></div>
          <div className="d-flex align-items-center justify-content-between p-3"><small>Halaman {page} · {pageQuery.data?.total ?? 0} baris</small><div className="btn-group"><button className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Sebelumnya</button><button className="btn btn-sm btn-outline-secondary" disabled={page * 50 >= (pageQuery.data?.total ?? 0)} onClick={() => setPage((value) => value + 1)}>Berikutnya</button></div></div>
        </>}
        {!job && <div className="bulk-empty"><div className="empty-illustration small"><i className="bi bi-file-earmark-spreadsheet" /></div><b>Belum ada hasil</b><span>Hasil pekerjaan akan tersimpan dan dapat dibuka lagi dari riwayat analisis.</span></div>}
      </section></div>
    </div>
  </>
}
