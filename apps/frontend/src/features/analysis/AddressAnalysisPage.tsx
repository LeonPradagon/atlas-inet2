import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl'
import type { MapMouseEvent } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Feature, LineString, Point } from 'geojson'
import { Link } from '@tanstack/react-router'
import { PageHeader } from '../../components/PageHeader'
import { api, postJson, type ApiError } from '../../lib/api'

type Result = { address: string; latitude: number; longitude: number; network: { name: string; area: string; cableType: string } | null; distanceMeters: number | null; status: string; message?: string; geocodingProvider?: 'photon' | 'nominatim' }
type RegionOption = { code: string; name: string }
type Subdistrict = RegionOption & { postalCode: string }
type AddressFields = { street: string; number: string; postalCode: string; provinceCode: string; cityCode: string; districtCode: string; subdistrictCode: string }
type DesignFeature = Feature<Point | LineString, { kind: string; name: string; routeType?: 'FEEDER' | 'DISTRIBUTION'; spacingMeters?: number; poleHeight?: string; roadClass?: string }>

function offsetCoordinate([longitude, latitude]: [number, number], meters: number, bearing: number): [number, number] {
  const distance = meters / 6371008.8
  const lat1 = latitude * Math.PI / 180
  const lon1 = longitude * Math.PI / 180
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing))
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}

function insideBoundary([longitude, latitude]: [number, number], center: [number, number], radius: number): boolean {
  const north = (latitude - center[1]) * 110540
  const east = (longitude - center[0]) * 111320 * Math.cos(center[1] * Math.PI / 180)
  return Math.hypot(east, north) <= radius
}

function distanceMeters(a: [number, number], b: [number, number]): number {
  const latitude = (a[1] + b[1]) / 2 * Math.PI / 180
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(latitude), (a[1] - b[1]) * 110540)
}

function coverageTargets(center: [number, number]): [number, number][] {
  const targets: [number, number][] = []
  // 200 m grid keeps every point within ~142 m of a candidate service point.
  for (let north = -400; north <= 400; north += 200) {
    for (let east = -400; east <= 400; east += 200) {
      if (Math.hypot(east, north) > 500) continue
      targets.push(offsetCoordinate(center, Math.hypot(east, north), Math.atan2(east, north)))
    }
  }
  return targets
}

function routePoles(coordinates: [number, number][], routeName: string, spacing: number, roadClasses: (string | null)[]): DesignFeature[] {
  const features: DesignFeature[] = []
  let remaining = spacing
  for (let index = 1; index < coordinates.length; index++) {
    const start = coordinates[index - 1]
    const end = coordinates[index]
    const middleLat = (start[1] + end[1]) * Math.PI / 360
    const dx = (end[0] - start[0]) * 111320 * Math.cos(middleLat)
    const dy = (end[1] - start[1]) * 110540
    const length = Math.hypot(dx, dy)
    const roadClass = roadClasses[index - 1]
    const poleHeight = roadClass && ['primary', 'secondary', 'tertiary', 'trunk', 'motorway'].includes(roadClass) ? '9 m' : '7 m'
    for (; length > 0 && remaining <= length; remaining += spacing) {
      const fraction = remaining / length
      features.push({ type: 'Feature', properties: { kind: 'POLE', name: `Tiang ${routeName} ${features.length + 1}`, spacingMeters: spacing, poleHeight, roadClass: roadClass ?? undefined }, geometry: { type: 'Point', coordinates: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction] } })
    }
    remaining -= length
  }
  return features
}

function AddressResultMap({ latitude, longitude, anchorKind, design }: { latitude: number; longitude: number; anchorKind: string; design: DesignFeature[] }) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    setWorkerUrl(workerUrl)
    const map = new MapLibreMap({ container: container.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: [longitude, latitude], zoom: 15 })
    map.addControl(new NavigationControl(), 'top-right')
    const circle = Array.from({ length: 65 }, (_, index) => {
      const bearing = (index / 64) * 2 * Math.PI
      const distance = 500 / 6371008.8
      const lat1 = latitude * Math.PI / 180
      const lon1 = longitude * Math.PI / 180
      const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing))
      const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2))
      return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
    })
    map.on('load', async () => {
      const drawAssetIcon = (kind: 'OLT' | 'ODC' | 'ODP' | 'POLE', color: string) => {
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
          context.fillStyle = color
          context.lineWidth = 2.5
          context.beginPath()
          context.moveTo(16, 4)
          context.lineTo(16, 29)
          context.moveTo(8, 10)
          context.lineTo(24, 10)
          context.moveTo(10, 15)
          context.lineTo(22, 15)
          context.moveTo(13, 7)
          context.lineTo(13, 11)
          context.moveTo(19, 7)
          context.lineTo(19, 11)
          context.stroke()
          context.beginPath()
          context.moveTo(11, 29)
          context.lineTo(21, 29)
          context.stroke()
        }
        map.addImage(`ftth-${kind.toLowerCase()}`, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 })
      }
      drawAssetIcon('OLT', '#e8b500')
      drawAssetIcon('ODC', '#ff0000')
      drawAssetIcon('ODP', '#0000ff')
      drawAssetIcon('POLE', '#536177')
      const bounds = circle.reduce(([west, south, east, north], [lng, lat]) => [Math.min(west, lng), Math.min(south, lat), Math.max(east, lng), Math.max(north, lat)], [Infinity, Infinity, -Infinity, -Infinity])
      map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 36, maxZoom: 15 })
      map.addSource('analysis-location', { type: 'geojson', data: { type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { kind: 'boundary', name: 'Radius 500 m' }, geometry: { type: 'Polygon', coordinates: [circle] } },
        { type: 'Feature', properties: { kind: anchorKind, name: 'Titik awal' }, geometry: { type: 'Point', coordinates: [longitude, latitude] } },
        ...design.filter((feature) => feature.properties.kind === 'ODP').map((feature) => {
          const [odpLongitude, odpLatitude] = feature.geometry.coordinates as [number, number]
          const coverage = Array.from({ length: 65 }, (_, index) => offsetCoordinate([odpLongitude, odpLatitude], 150, index / 64 * 2 * Math.PI))
          return { type: 'Feature' as const, properties: { kind: 'coverage', name: `Radius layanan ${feature.properties.name} · 150 m` }, geometry: { type: 'Polygon' as const, coordinates: [coverage] } }
        }),
        ...design,
      ] } })
      map.addLayer({ id: 'analysis-radius-fill', type: 'fill', source: 'analysis-location', filter: ['==', '$type', 'Polygon'], paint: { 'fill-color': '#3454d1', 'fill-opacity': 0.16 } })
      map.addLayer({ id: 'analysis-radius-line', type: 'line', source: 'analysis-location', filter: ['==', '$type', 'Polygon'], paint: { 'line-color': '#3454d1', 'line-width': 2 } })
      map.addLayer({ id: 'analysis-odp-coverage', type: 'fill', source: 'analysis-location', filter: ['==', ['get', 'kind'], 'coverage'], paint: { 'fill-color': '#f29b38', 'fill-opacity': 0.12 } }, 'analysis-radius-line')
      map.addLayer({ id: 'analysis-odp-coverage-line', type: 'line', source: 'analysis-location', filter: ['==', ['get', 'kind'], 'coverage'], paint: { 'line-color': '#f29b38', 'line-width': 1, 'line-dasharray': [2, 2] } })
      map.addLayer({ id: 'analysis-design-routes', type: 'line', source: 'analysis-location', filter: ['==', ['get', 'kind'], 'ROUTE'], paint: { 'line-color': ['match', ['get', 'routeType'], 'FEEDER', '#ff0000', 'DISTRIBUTION', '#a000ff', '#64748b'], 'line-width': ['match', ['get', 'routeType'], 'FEEDER', 4.5, 3.5] } })
      const pointKinds = ['OLT', 'HANDHOLE', 'JOINT_CLOSURE', 'ODC', 'ODP', 'POLE']
      map.addLayer({ id: 'analysis-design-points', type: 'circle', source: 'analysis-location', filter: ['all', ['in', ['get', 'kind'], ['literal', pointKinds]], ['!', ['in', ['get', 'kind'], ['literal', ['OLT', 'ODC', 'ODP', 'POLE']]]]], paint: {
        'circle-radius': 12,
        'circle-color': ['match', ['get', 'kind'], 'HANDHOLE', '#536177', 'JOINT_CLOSURE', '#7256bf', '#536177'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
      } })
      map.addLayer({ id: 'analysis-design-point-labels', type: 'symbol', source: 'analysis-location', filter: ['all', ['in', ['get', 'kind'], ['literal', pointKinds]], ['!', ['in', ['get', 'kind'], ['literal', ['OLT', 'ODC', 'ODP', 'POLE']]]]], layout: {
        'text-field': ['match', ['get', 'kind'], 'HANDHOLE', 'HH', 'JOINT_CLOSURE', 'JC', ''],
        'text-size': 9, 'text-font': ['Noto Sans Bold'],
        'text-allow-overlap': true, 'text-ignore-placement': true,
      }, paint: { 'text-color': '#fff', 'text-halo-color': 'rgba(0,0,0,0.2)', 'text-halo-width': 0.5 } })
      map.addLayer({ id: 'analysis-design-major-icons', type: 'symbol', source: 'analysis-location', filter: ['in', ['get', 'kind'], ['literal', ['OLT', 'ODC', 'ODP']]], layout: { 'icon-image': ['concat', 'ftth-', ['downcase', ['get', 'kind']]], 'icon-size': 0.8, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
      map.addLayer({ id: 'analysis-design-pole-icons', type: 'symbol', source: 'analysis-location', filter: ['==', ['get', 'kind'], 'POLE'], layout: { 'icon-image': 'ftth-pole', 'icon-size': 0.62, 'icon-allow-overlap': true, 'icon-ignore-placement': true } })
      const interactiveLayers = ['analysis-design-major-icons', 'analysis-design-pole-icons', 'analysis-design-points', 'analysis-design-point-labels', 'analysis-design-routes']
      const kindLabels: Record<string, string> = { OLT: 'Server OLT (POP)', ODC: 'ODC (Cabinet)', ODP: 'ODP (Tiang)', HANDHOLE: 'Handhole', JOINT_CLOSURE: 'Joint Closure', POLE: 'Tiang', ROUTE: 'Jalur kabel' }
      let activePopup: Popup | undefined
      let pinnedPopup = false
      let activeFeatureKey = ''
      const getFeature = (point: MapMouseEvent['point']) => map.queryRenderedFeatures(point, { layers: interactiveLayers }).find((feature) => feature.geometry.type === 'Point') ?? map.queryRenderedFeatures(point, { layers: ['analysis-design-routes'] })[0]
      const popupContent = (feature: ReturnType<typeof getFeature>) => {
        const properties = feature?.properties as { kind?: string; name?: string; routeType?: string; spacingMeters?: number; poleHeight?: string; roadClass?: string } | undefined
        const kind = properties?.kind ?? 'ASSET'
        const routeType = properties?.routeType
        const title = routeType === 'FEEDER' ? 'Kabel Feeder' : routeType === 'DISTRIBUTION' ? 'Kabel Distribusi' : kindLabels[kind] ?? kind
        const content = document.createElement('div')
        content.className = 'small'
        const heading = document.createElement('strong')
        heading.className = 'd-block mb-1'
        heading.textContent = title
        content.append(heading)
        const name = document.createElement('span')
        name.className = 'd-block'
        name.textContent = properties?.name ?? 'Titik awal'
        content.append(name)
        if (kind === 'POLE' && properties?.spacingMeters) {
          const spacing = document.createElement('span')
          spacing.className = 'd-block text-secondary mt-1'
          spacing.textContent = `Tinggi ${properties.poleHeight ?? '—'}${properties.roadClass ? ` · kelas jalan ${properties.roadClass}` : ''} · jarak rencana antartiang ±${properties.spacingMeters} m di sepanjang jalur`
          content.append(spacing)
        }
        if (feature?.geometry.type === 'Point') {
          const [lng, lat] = feature.geometry.coordinates
          const coordinates = document.createElement('span')
          coordinates.className = 'd-block text-secondary mt-1'
          coordinates.textContent = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`
          content.append(coordinates)
        } else if (feature?.geometry.type === 'LineString') {
          const coords = feature.geometry.coordinates as [number, number][]
          const length = coords.slice(1).reduce((sum, coordinate, index) => sum + distanceMeters(coords[index], coordinate), 0)
          const distance = document.createElement('span')
          distance.className = 'd-block text-secondary mt-1'
          distance.textContent = `Panjang jalur ± ${(length / 1000).toFixed(2)} km`
          content.append(distance)
        }
        return content
      }
      const setPopup = (feature: ReturnType<typeof getFeature>, lngLat: { lng: number; lat: number }, pinned: boolean) => {
        if (!feature) return
        const properties = feature.properties as { kind?: string; name?: string } | undefined
        const key = `${properties?.kind}:${properties?.name}`
        if (!pinned && (pinnedPopup || key === activeFeatureKey)) return
        activeFeatureKey = key
        pinnedPopup = pinned
        activePopup?.remove()
        activePopup = new Popup({ closeButton: pinned, closeOnClick: pinned, offset: 12, maxWidth: '260px' })
          .setLngLat(lngLat)
          .setDOMContent(popupContent(feature))
          .addTo(map)
        if (pinned) activePopup.on('close', () => { pinnedPopup = false; activePopup = undefined; activeFeatureKey = '' })
      }
      map.on('mousemove', (event) => {
        const feature = getFeature(event.point)
        map.getCanvas().style.cursor = feature ? 'pointer' : ''
        if (feature) setPopup(feature, event.lngLat, false)
        else if (!pinnedPopup) { activePopup?.remove(); activePopup = undefined; activeFeatureKey = '' }
      })
      map.on('click', (event) => {
        const feature = getFeature(event.point)
        if (feature) setPopup(feature, event.lngLat, true)
        else if (pinnedPopup) { activePopup?.remove(); activePopup = undefined; pinnedPopup = false; activeFeatureKey = '' }
      })
      map.on('mouseout', () => {
        map.getCanvas().style.cursor = ''
        if (!pinnedPopup) { activePopup?.remove(); activePopup = undefined; activeFeatureKey = '' }
      })
    })
    return () => map.remove()
  }, [latitude, longitude, design])

  return <div ref={container} role="img" aria-label="Peta lokasi dengan boundary radius 500 meter" style={{ height: 620, width: '100%', borderRadius: 8, overflow: 'hidden' }} />
}

export function AddressAnalysisPage() {
  const [address, setAddress] = useState<AddressFields>({ street: '', number: '', postalCode: '', provinceCode: '', cityCode: '', districtCode: '', subdistrictCode: '' })
  const [coordinateCopyStatus, setCoordinateCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const [assetKind, setAssetKind] = useState('OLT')
  const [poleHeight, setPoleHeight] = useState('7 m')
  const [assetName, setAssetName] = useState('')
  const [designFeatures, setDesignFeatures] = useState<DesignFeature[]>([])
  const [designError, setDesignError] = useState('')
  const [designNotice, setDesignNotice] = useState('')
  const [designLoading, setDesignLoading] = useState(false)
  const queryClient = useQueryClient()
  const { data: regions = [] } = useQuery({ queryKey: ['indonesia-provinces'], staleTime: Infinity, queryFn: () => api<RegionOption[]>('/regions/provinces') })
  const { data: cities = [] } = useQuery({
    queryKey: ['indonesia-cities', address.provinceCode], enabled: Boolean(address.provinceCode), staleTime: Infinity,
    queryFn: () => api<RegionOption[]>(`/regions/cities?provinceCode=${encodeURIComponent(address.provinceCode)}`),
  })
  const { data: districts = [] } = useQuery({
    queryKey: ['indonesia-districts', address.cityCode], enabled: Boolean(address.cityCode), staleTime: Infinity,
    queryFn: () => api<RegionOption[]>(`/regions/districts?cityCode=${encodeURIComponent(address.cityCode)}`),
  })
  const { data: subdistricts = [], isLoading: loadingSubdistricts, isError: subdistrictLoadError } = useQuery({
    queryKey: ['indonesia-subdistricts', address.districtCode],
    enabled: Boolean(address.districtCode),
    staleTime: Infinity,
    retry: false,
    queryFn: () => api<Subdistrict[]>(`/regions/subdistricts?districtCode=${encodeURIComponent(address.districtCode)}`),
  })
  const province = regions.find((region) => region.code === address.provinceCode)
  const city = cities.find((item) => item.code === address.cityCode)
  const district = districts.find((item) => item.code === address.districtCode)
  const subdistrict = subdistricts.find((item) => item.code === address.subdistrictCode)
  const fullAddress = [address.street.trim(), address.number.trim() && `No. ${address.number.trim()}`, subdistrict?.name, district && `Kecamatan ${district.name}`, city?.name, province && `Provinsi ${province.name}`, address.postalCode.trim() && `Kode pos ${address.postalCode.trim()}`].filter(Boolean).join(', ')
  const analyze = useMutation({ mutationFn: (value: { address: string; structured: { street: string; number: string; subdistrict: string; district: string; city: string; province: string; postalCode: string } }) => api<Result>('/analysis/address', postJson(value)) })
  const saveAsset = useMutation({
    mutationFn: () => api<{ id: string; name: string }>('/assets/point', postJson({ kind: assetKind, poleHeight: assetKind === 'POLE' ? poleHeight : undefined, name: (assetName.trim() || `${assetKind} · ${address.street.trim() || 'Titik analisis'}`).slice(0, 150), longitude: analyze.data?.longitude, latitude: analyze.data?.latitude, area: [city?.name, province?.name].filter(Boolean).join(', ') })),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: ['segments'] }), queryClient.invalidateQueries({ queryKey: ['map-assets'] })]),
  })
  const saveDesign = useMutation({
    mutationFn: () => api<{ savedCount: number; historyId: string }>('/assets/ftth-design', postJson({ area: [city?.name, province?.name].filter(Boolean).join(', '), features: [
      ...(!saveAsset.isSuccess ? [{ kind: assetKind, name: (assetName.trim() || `${assetKind} · ${address.street.trim() || 'Titik analisis'}`).slice(0, 150), poleHeight: assetKind === 'POLE' ? poleHeight : undefined, geometry: { type: 'Point', coordinates: [analyze.data!.longitude, analyze.data!.latitude] } }] : []),
      ...designFeatures.map((feature) => ({ ...feature.properties, geometry: feature.geometry })),
    ] })),
    onSuccess: () => Promise.all([queryClient.invalidateQueries({ queryKey: ['segments'] }), queryClient.invalidateQueries({ queryKey: ['map-assets'] }), queryClient.invalidateQueries({ queryKey: ['analysis-history'] })]),
  })
  const error = analyze.error as ApiError | null
  const updateAddress = (field: keyof AddressFields, value: string) => setAddress((current) => ({ ...current, [field]: value }))
  const coordinates = analyze.data ? `${analyze.data.latitude}, ${analyze.data.longitude}` : ''
  const copyCoordinates = async () => {
    try {
      await navigator.clipboard.writeText(coordinates)
      setCoordinateCopyStatus('copied')
      window.setTimeout(() => setCoordinateCopyStatus('idle'), 2000)
    } catch {
      setCoordinateCopyStatus('error')
    }
  }
  const createFtthDraft = async () => {
    if (!analyze.data) return
    setDesignLoading(true)
    setDesignError('')
    setDesignNotice('')
    setDesignFeatures([])
    saveDesign.reset()
    try {
      const anchor: [number, number] = [analyze.data.longitude, analyze.data.latitude]
      const requestRoute = async (from: [number, number], to: [number, number], name: string, maxDistance: number) => {
        const result = await api<{ geometry?: LineString; roadClasses?: (string | null)[]; distanceMeters?: number }>('/routes/preview-ftth', postJson({ coordinates: [from, to] }))
        if (!result.geometry || result.geometry.coordinates.length < 2) throw new Error(`Jalur ${name} tidak ditemukan di jaringan jalan.`)
        const points = result.geometry.coordinates as [number, number][]
        if ((result.distanceMeters ?? Infinity) > maxDistance) throw new Error(`Jalur ${name} melebihi batas ${maxDistance} m.`)
        return { points, roadClasses: result.roadClasses ?? [] }
      }
      const draft: DesignFeature[] = []
      const poleKeys = new Set<string>()
      let uncoveredTargets = 0
      const appendRoute = (points: [number, number][], roadClasses: (string | null)[], name: string, routeType: 'FEEDER' | 'DISTRIBUTION') => {
        draft.push({ type: 'Feature', properties: { kind: 'ROUTE', name, routeType }, geometry: { type: 'LineString', coordinates: points } })
        for (const pole of routePoles(points, name, 50, roadClasses)) {
          const [longitude, latitude] = pole.geometry.coordinates as [number, number]
          const key = `${longitude.toFixed(5)},${latitude.toFixed(5)}`
          if (!poleKeys.has(key)) { poleKeys.add(key); draft.push(pole) }
        }
      }
      const sourceLabel = ({ OLT: 'OLT', JOINT_CLOSURE: 'Joint Closure', HANDHOLE: 'Handhole', ODC: 'ODC', ODP: 'ODP', POLE: 'Tiang' } as Record<string, string>)[assetKind] ?? assetKind
      const odcCandidates: { index: number; coordinate: [number, number]; feeder: [number, number][]; roadClasses: (string | null)[]; used: number }[] = []
      const odcLocations = [
        ...[180, 360].flatMap((radius) => Array.from({ length: 8 }, (_, direction) => offsetCoordinate(anchor, radius, 2 * Math.PI * direction / 8))),
        ...coverageTargets(anchor).filter((target) => distanceMeters(anchor, target) >= 120),
      ]
      for (const location of odcLocations) {
        const index = odcCandidates.length + 1
        const odcName = `ODC ${String(index).padStart(2, '0')}`
        const feederName = assetKind === 'OLT' ? `Kabel feeder OLT–${odcName}` : `Kabel lanjutan ${sourceLabel}–${odcName}`
        let feeder: { points: [number, number][]; roadClasses: (string | null)[] }
        try {
          feeder = await requestRoute(anchor, location, feederName, Number.POSITIVE_INFINITY)
        } catch {
          continue
        }
        const odc: [number, number] = feeder.points.at(-1)!
        if (insideBoundary(odc, anchor, 500) && !odcCandidates.some((candidate) => distanceMeters(candidate.coordinate, odc) < 80)) {
          odcCandidates.push({ index, coordinate: odc, feeder: feeder.points, roadClasses: feeder.roadClasses, used: 0 })
        }
      }
      let odpIndex = 0
      for (const target of coverageTargets(anchor)) {
        let placed = false
        const candidates = odcCandidates.filter((odc) => odc.used < 4).sort((a, b) => {
          return distanceMeters(a.coordinate, target) - distanceMeters(b.coordinate, target)
        })
        for (const odc of candidates) {
          const name = `ODP ${String(odpIndex + 1).padStart(2, '0')}`
          let route: { points: [number, number][]; roadClasses: (string | null)[] }
          try {
            route = await requestRoute(odc.coordinate, target, `kabel ODC ${String(odc.index).padStart(2, '0')}–${name}`, 1500)
          } catch {
            continue
          }
          const odp: [number, number] = route.points.at(-1)!
          if (!insideBoundary(odp, anchor, 500)) continue
          const feederName = assetKind === 'OLT' ? `Kabel feeder OLT–ODC ${String(odc.index).padStart(2, '0')}` : `Kabel lanjutan ${sourceLabel}–ODC ${String(odc.index).padStart(2, '0')}`
          if (odc.used === 0) {
            appendRoute(odc.feeder, odc.roadClasses, feederName, 'FEEDER')
            draft.push({ type: 'Feature', properties: { kind: 'ODC', name: `ODC ${String(odc.index).padStart(2, '0')}` }, geometry: { type: 'Point', coordinates: odc.coordinate } })
          }
          appendRoute(route.points, route.roadClasses, `Kabel ODC ${String(odc.index).padStart(2, '0')}–${name}`, 'DISTRIBUTION')
          draft.push({ type: 'Feature', properties: { kind: 'ODP', name }, geometry: { type: 'Point', coordinates: odp } })
          odc.used++
          odpIndex++
          placed = true
          break
        }
        if (!placed) uncoveredTargets++
      }
      if (!draft.some((feature) => feature.properties.kind === 'ODP')) throw new Error('Tidak ada ODP yang dapat dijangkau melalui data jalan di area ini.')
      setDesignFeatures(draft)
      if (uncoveredTargets) setDesignNotice(`${uncoveredTargets} titik pemerataan tidak dapat dipasangi ODP dengan jalur kabel maksimal 1.500 m pada jaringan GraphHopper. Cakupan mengikuti jalan yang tersedia; sebagian boundary masih belum terlayani.`)
    } catch (error) {
      setDesignError(error instanceof Error ? error.message : 'Draft FTTH tidak dapat dibuat.')
    } finally {
      setDesignLoading(false)
    }
  }

  return <>
    <PageHeader title="Analisis alamat" subtitle="Ubah alamat menjadi koordinat dan temukan jaringan terdekat." />
    <div className="row g-4"><div className="col-lg-7"><section className="card panel-card"><div className="card-header analysis-form-header"><div><h3>Lokasi pelanggan</h3><p>Lengkapi detail alamat agar lokasi mudah ditemukan.</p></div><span className="step-tag">ANALISIS TUNGGAL</span></div><div className="card-body"><form onSubmit={(event) => { event.preventDefault(); analyze.mutate({ address: fullAddress, structured: { street: address.street, number: address.number, subdistrict: subdistrict?.name ?? '', district: district?.name ?? '', city: city?.name ?? '', province: province?.name ?? '', postalCode: address.postalCode } }) }}>
      <div className="row g-3">
        <div className="col-12"><label className="form-label fw-semibold" htmlFor="street">Nama jalan <span className="text-secondary fw-normal">(opsional)</span></label><input id="street" className="form-control" value={address.street} onChange={(event) => updateAddress('street', event.target.value)} placeholder="Contoh: Jl. Sudirman" /></div>
        <div className="col-md-6"><label className="form-label fw-semibold" htmlFor="province">Provinsi <span className="text-danger">*</span></label><select id="province" className="form-select" value={address.provinceCode} onChange={(event) => setAddress((current) => ({ ...current, provinceCode: event.target.value, cityCode: '', districtCode: '', subdistrictCode: '', postalCode: '' }))} required><option value="">Pilih provinsi</option>{[...regions].sort((a, b) => a.name.localeCompare(b.name, 'id')).map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></div>
        <div className="col-md-6"><label className="form-label fw-semibold" htmlFor="city">Kabupaten / kota <span className="text-danger">*</span></label><select id="city" className="form-select" value={address.cityCode} onChange={(event) => setAddress((current) => ({ ...current, cityCode: event.target.value, districtCode: '', subdistrictCode: '', postalCode: '' }))} disabled={!province} required><option value="">Pilih kabupaten/kota</option>{cities.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></div>
        <div className="col-md-6"><label className="form-label fw-semibold" htmlFor="district">Kecamatan <span className="text-danger">*</span></label><select id="district" className="form-select" value={address.districtCode} onChange={(event) => setAddress((current) => ({ ...current, districtCode: event.target.value, subdistrictCode: '', postalCode: '' }))} disabled={!city} required><option value="">Pilih kecamatan</option>{districts.map((item) => <option value={item.code} key={item.code}>{item.name}</option>)}</select></div>
        <div className="col-md-6"><label className="form-label fw-semibold" htmlFor="subdistrict">Kelurahan / desa <span className="text-danger">*</span></label><select id="subdistrict" className="form-select" value={address.subdistrictCode} onChange={(event) => { const selected = subdistricts.find((item) => item.code === event.target.value); setAddress((current) => ({ ...current, subdistrictCode: event.target.value, postalCode: selected?.postalCode ?? '' })) }} disabled={!district || loadingSubdistricts || subdistrictLoadError} required><option value="">{loadingSubdistricts ? 'Memuat daftar...' : 'Pilih kelurahan/desa'}</option>{subdistricts.map(({ code, name }) => <option value={code} key={code}>{name}</option>)}</select>{subdistrictLoadError && <div className="form-text text-danger">Daftar kelurahan/desa gagal dimuat. Coba pilih ulang kabupaten/kota.</div>}</div>
        <div className="col-md-6"><label className="form-label fw-semibold" htmlFor="street-number">Nomor rumah <span className="text-secondary fw-normal">(opsional)</span></label><input id="street-number" className="form-control" value={address.number} onChange={(event) => updateAddress('number', event.target.value)} placeholder="Contoh: 12 atau A-12" /></div>
        <div className="col-md-6"><label className="form-label fw-semibold" htmlFor="postal-code">Kode pos <span className="text-secondary fw-normal">(otomatis; bisa diedit)</span></label><input id="postal-code" className="form-control" inputMode="numeric" autoComplete="postal-code" pattern="[0-9]{5}" maxLength={5} value={address.postalCode} onChange={(event) => updateAddress('postalCode', event.target.value)} placeholder="Terisi setelah kelurahan/desa dipilih" /></div>
      </div>
      <div className="form-text mt-3"><i className="bi bi-info-circle me-1" />Isi semua bagian alamat agar hasil analisis lebih akurat.</div>
      <div className="d-flex justify-content-between align-items-center mt-4"><button type="button" className="btn btn-link text-secondary p-0" onClick={() => { setAddress({ street: '', number: '', postalCode: '', provinceCode: '', cityCode: '', districtCode: '', subdistrictCode: '' }); analyze.reset() }}>Bersihkan</button><button className="btn btn-primary px-4" disabled={analyze.isPending || !address.provinceCode || !address.cityCode || !address.districtCode || !address.subdistrictCode}>{analyze.isPending ? <><span className="spinner-border spinner-border-sm me-2" />Menganalisis...</> : <><i className="bi bi-search me-2" />Analisis jaringan</>}</button></div>
    </form></div></section><div className="info-note mt-3"><i className="bi bi-lightbulb" /><p><b>Bagaimana hasil dihitung?</b><br />ATLAS mengubah alamat menjadi koordinat, mencari segmen terdekat, lalu menghitung jarak mengikuti jalan jika layanan routing tersedia.</p></div></div>
      <div className="col-lg-5">
        {analyze.data ? <section className="card panel-card result-card">
          <div className={`result-success ${analyze.data.distanceMeters === null ? 'result-pending' : ''}`}><span><i className={`bi ${analyze.data.distanceMeters === null ? 'bi-info-lg' : 'bi-check-lg'}`} /></span><div><b>{analyze.data.distanceMeters === null ? 'Hasil parsial' : 'Analisis berhasil'}</b><small>{analyze.data.message ?? 'Koordinat dan jaringan terdekat ditemukan.'}</small></div></div>
          <div className="card-body">
            <div className="detail-label">HASIL KONVERSI</div><div className="result-address"><i className="bi bi-geo-alt-fill" /><span>{analyze.data.address}</span></div>
            <div className="w-100 rounded border bg-body-tertiary px-3 py-2 mt-3 d-flex align-items-center justify-content-between gap-2" aria-label="Koordinat"><div className="min-w-0"><small className="d-block text-secondary">Koordinat</small><b className="font-monospace user-select-all text-break">{coordinates}</b></div><button type="button" className="btn btn-sm btn-outline-primary flex-shrink-0" onClick={copyCoordinates} aria-label="Salin koordinat" title={coordinateCopyStatus === 'copied' ? 'Tersalin' : 'Salin koordinat'}><i className={`bi ${coordinateCopyStatus === 'copied' ? 'bi-check2' : coordinateCopyStatus === 'error' ? 'bi-exclamation-triangle' : 'bi-clipboard'}`} /></button></div>
            <a className="btn btn-outline-primary w-100 mt-2" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(coordinates)}`} target="_blank" rel="noreferrer"><i className="bi bi-map me-2" />Buka Google Maps</a>
            <div className="border rounded p-3 mt-3"><label className="form-label fw-semibold" htmlFor="ftth-asset-kind">Simpan titik sebagai aset FTTH</label><div className="d-flex gap-2"><select id="ftth-asset-kind" className="form-select" value={assetKind} onChange={(event) => { setAssetKind(event.target.value); saveAsset.reset(); setDesignFeatures([]); setDesignError(''); setDesignNotice(''); saveDesign.reset() }} disabled={saveAsset.isPending}><option value="OLT">OLT</option><option value="JOINT_CLOSURE">Joint Closure</option><option value="HANDHOLE">Handhole</option><option value="ODC">ODC</option><option value="ODP">ODP</option><option value="POLE">Tiang</option></select><button type="button" className="btn btn-primary flex-shrink-0" onClick={() => saveAsset.mutate()} disabled={saveAsset.isPending || saveAsset.isSuccess}>{saveAsset.isPending ? 'Menyimpan...' : 'Simpan'}</button></div>{assetKind === 'POLE' && <div className="mt-2"><label className="form-label" htmlFor="ftth-pole-height">Tinggi tiang</label><select id="ftth-pole-height" className="form-select" value={poleHeight} onChange={(event) => { setPoleHeight(event.target.value); saveAsset.reset() }} disabled={saveAsset.isPending}><option value="7 m">7 meter</option><option value="9 m">9 meter</option></select></div>}<input className="form-control mt-2" value={assetName} onChange={(event) => { setAssetName(event.target.value); saveAsset.reset() }} placeholder={`${assetKind} · Nama aset (opsional)`} maxLength={150} aria-label="Nama aset" />{saveAsset.isSuccess && <small className="text-success d-block mt-2">Aset tersimpan{assetKind === 'POLE' ? ` dengan tinggi ${poleHeight}` : ''}. Buka Peta Jaringan untuk melihatnya.</small>}{saveAsset.error && <small className="text-danger d-block mt-2">{saveAsset.error.message}</small>}</div>
            <div className="border rounded p-3 mt-3"><b className="d-block">Draft FTTH otomatis</b><small className="d-block text-secondary mt-1">Sistem menempatkan ODC dan ODP berdasarkan boundary 500 m, perkiraan radius layanan ODP 150 m, kapasitas maksimal 4 ODP per ODC, dan jalur yang tersedia di GraphHopper. Jarak kabel distribusi maksimal 1.500 m; jarak antartiang otomatis sekitar 50 m. Tinggi tiang diperkirakan dari kelas jalan: jalan utama 9 m, jalan lokal/gang 7 m. Klik tiang di peta untuk melihat kelas jalan yang terbaca. Perkiraan ini perlu verifikasi survei lapangan. Jika titik awal bukan OLT, OLT upstream dianggap berada di luar area draft.</small>
              <button type="button" className="btn btn-primary w-100 mt-2" onClick={() => void createFtthDraft()} disabled={designLoading}>{designLoading ? <><span className="spinner-border spinner-border-sm me-2" />Menghitung rute jalan...</> : <><i className="bi bi-diagram-3 me-2" />Buat draft FTTH</>}</button>
              {designError && <div className="alert alert-danger py-2 px-3 mt-2 mb-0">{designError}</div>}{designNotice && <div className="alert alert-warning py-2 px-3 mt-2 mb-0">{designNotice}</div>}
              {designFeatures.length > 0 && <><small className="d-block text-success mt-2">Draft: {designFeatures.filter((feature) => feature.properties.kind === 'ODC').length} ODC, {designFeatures.filter((feature) => feature.properties.kind === 'ODP').length} ODP, {designFeatures.filter((feature) => feature.properties.kind === 'POLE').length} tiang, {designFeatures.filter((feature) => feature.properties.kind === 'ROUTE').length} jalur.</small><button type="button" className="btn btn-outline-primary w-100 mt-2" onClick={() => saveDesign.mutate()} disabled={saveDesign.isPending || saveDesign.isSuccess}>{saveDesign.isPending ? 'Menyimpan desain...' : saveDesign.isSuccess ? 'Desain tersimpan' : 'Simpan desain ke peta jaringan'}</button>{saveDesign.error && <small className="text-danger d-block mt-2">{saveDesign.error.message}</small>}</>}
            </div>
            {coordinateCopyStatus !== 'idle' && <small className={`d-block mt-1 ${coordinateCopyStatus === 'error' ? 'text-danger' : 'text-success'}`}>{coordinateCopyStatus === 'copied' ? 'Koordinat tersalin.' : 'Gagal menyalin koordinat.'}</small>}
            {analyze.data.geocodingProvider === 'nominatim' && <small className="text-secondary d-block mt-2">Lokasi dari <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>.</small>}
            <hr /><div className="detail-label">JARINGAN TERDEKAT</div>{analyze.data.network ? <><div className="nearest-network"><span className="network-icon"><i className="bi bi-bezier2" /></span><div><b>{analyze.data.network.name}</b><small>{analyze.data.network.area} · {analyze.data.network.cableType}</small></div></div><div className="distance-card"><div><small>Estimasi jarak jalan</small><strong>{analyze.data.distanceMeters === null ? 'Belum tersedia' : `${(analyze.data.distanceMeters / 1000).toFixed(2)} km`}</strong></div><span className="distance-icon"><i className="bi bi-rulers" /></span></div></> : <div className="alert alert-secondary">Belum ada jaringan dengan geometri di dekat titik ini.</div>}
            <Link to="/peta-jaringan" className="btn btn-outline-primary w-100 mt-3"><i className="bi bi-map me-2" />Lihat di peta jaringan</Link>
          </div></section> : <section className="empty-result"><div className="empty-illustration"><i className="bi bi-geo-alt" /><span /><span /></div><h3>{error ? 'Analisis belum tersedia' : 'Hasil analisis akan tampil di sini'}</h3><p>{error ? error.message : 'Lengkapi alamat untuk melihat koordinat, jaringan terdekat, dan jarak jalan.'}</p></section>}
      </div>
    </div>
      {analyze.data && <section className="card panel-card mt-4"><div className="card-header"><div><h3>Peta lokasi</h3><p>Boundary 500 m dan perkiraan radius layanan 150 m tiap ODP.</p></div></div><div className="card-body"><AddressResultMap latitude={analyze.data.latitude} longitude={analyze.data.longitude} anchorKind={assetKind} design={designFeatures} /><div className="d-flex flex-wrap gap-3 mt-2 small text-secondary"><span><i className="bi bi-circle-fill text-primary me-1" />Boundary 500 m</span><span><i className="bi bi-circle-fill text-warning me-1" />Radius layanan ODP 150 m</span><span><i className="bi bi-hdd-network me-1" style={{ color: "#e8b500" }} />OLT</span><span><i className="bi bi-triangle-fill me-1" style={{ color: "#ff0000" }} />ODC</span><span><i className="bi bi-triangle-fill me-1" style={{ color: "#0000ff" }} />ODP</span><span><i className="bi bi-signpost-2 me-1" style={{ color: "#536177" }} />Tiang · ±50 m</span><span><i className="bi bi-dash-lg me-1" style={{ color: "#ff0000" }} />Kabel feeder</span><span><i className="bi bi-dash-lg me-1" style={{ color: "#a000ff" }} />Kabel distribusi</span></div></div></section>}
  </>
}
