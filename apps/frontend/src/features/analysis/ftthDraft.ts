import type { Feature, LineString, Point } from 'geojson'
import { api, postJson } from '../../lib/api'

export type DesignFeature = Feature<Point | LineString, { kind: string; name: string; routeType?: 'FEEDER' | 'DISTRIBUTION'; spacingMeters?: number; poleHeight?: string; roadClass?: string }>

export function offsetCoordinate([longitude, latitude]: [number, number], meters: number, bearing: number): [number, number] {
  const distance = meters / 6371008.8
  const lat1 = latitude * Math.PI / 180
  const lon1 = longitude * Math.PI / 180
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing))
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2))
  return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI]
}

export function distanceMeters(a: [number, number], b: [number, number]): number {
  const latitude = (a[1] + b[1]) / 2 * Math.PI / 180
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(latitude), (a[1] - b[1]) * 110540)
}

function insideBoundary([longitude, latitude]: [number, number], center: [number, number], radius: number): boolean {
  const north = (latitude - center[1]) * 110540
  const east = (longitude - center[0]) * 111320 * Math.cos(center[1] * Math.PI / 180)
  return Math.hypot(east, north) <= radius
}

function coverageTargets(center: [number, number]): [number, number][] {
  const targets: [number, number][] = []
  for (let north = -400; north <= 400; north += 200) for (let east = -400; east <= 400; east += 200) {
    if (Math.hypot(east, north) <= 500) targets.push(offsetCoordinate(center, Math.hypot(east, north), Math.atan2(east, north)))
  }
  return targets
}

function routePoles(coordinates: [number, number][], routeName: string, roadClasses: (string | null)[]): DesignFeature[] {
  const features: DesignFeature[] = []
  let remaining = 50
  for (let index = 1; index < coordinates.length; index++) {
    const start = coordinates[index - 1], end = coordinates[index]
    const middleLat = (start[1] + end[1]) * Math.PI / 360
    const dx = (end[0] - start[0]) * 111320 * Math.cos(middleLat), dy = (end[1] - start[1]) * 110540
    const length = Math.hypot(dx, dy), roadClass = roadClasses[index - 1]
    const poleHeight = roadClass && ['primary', 'secondary', 'tertiary', 'trunk', 'motorway'].includes(roadClass) ? '9 m' : '7 m'
    for (; length > 0 && remaining <= length; remaining += 50) {
      const fraction = remaining / length
      features.push({ type: 'Feature', properties: { kind: 'POLE', name: `Tiang ${routeName} ${features.length + 1}`, spacingMeters: 50, poleHeight, roadClass: roadClass ?? undefined }, geometry: { type: 'Point', coordinates: [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction] } })
    }
    remaining -= length
  }
  return features
}

export async function generateFtthDraft(anchor: [number, number], assetKind: string) {
  const requestRoute = async (from: [number, number], to: [number, number], name: string, maxDistance: number) => {
    const result = await api<{ geometry?: LineString; roadClasses?: (string | null)[]; distanceMeters?: number }>('/routes/preview-ftth', postJson({ coordinates: [from, to] }))
    if (!result.geometry || result.geometry.coordinates.length < 2) throw new Error(`Jalur ${name} tidak ditemukan di jaringan jalan.`)
    const points = result.geometry.coordinates as [number, number][]
    if ((result.distanceMeters ?? Infinity) > maxDistance) throw new Error(`Jalur ${name} melebihi batas ${maxDistance} m.`)
    return { points, roadClasses: result.roadClasses ?? [] }
  }
  const features: DesignFeature[] = [], poleKeys = new Set<string>()
  let uncoveredTargets = 0
  const appendRoute = (points: [number, number][], roadClasses: (string | null)[], name: string, routeType: 'FEEDER' | 'DISTRIBUTION') => {
    features.push({ type: 'Feature', properties: { kind: 'ROUTE', name, routeType }, geometry: { type: 'LineString', coordinates: points } })
    for (const pole of routePoles(points, name, roadClasses)) {
      const [longitude, latitude] = pole.geometry.coordinates as [number, number]
      const key = `${longitude.toFixed(5)},${latitude.toFixed(5)}`
      if (!poleKeys.has(key)) { poleKeys.add(key); features.push(pole) }
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
    try {
      const feeder = await requestRoute(anchor, location, feederName, Infinity)
      const odc = feeder.points.at(-1)!
      if (insideBoundary(odc, anchor, 500) && !odcCandidates.some((candidate) => distanceMeters(candidate.coordinate, odc) < 80)) odcCandidates.push({ index, coordinate: odc, feeder: feeder.points, roadClasses: feeder.roadClasses, used: 0 })
    } catch { /* Skip candidate routes that do not follow a usable road. */ }
  }
  let odpIndex = 0
  for (const target of coverageTargets(anchor)) {
    let placed = false
    const candidates = odcCandidates.filter((odc) => odc.used < 4).sort((a, b) => distanceMeters(a.coordinate, target) - distanceMeters(b.coordinate, target))
    for (const odc of candidates) {
      const name = `ODP ${String(odpIndex + 1).padStart(2, '0')}`
      let route: { points: [number, number][]; roadClasses: (string | null)[] }
      try { route = await requestRoute(odc.coordinate, target, `kabel ODC ${String(odc.index).padStart(2, '0')}–${name}`, 1500) } catch { continue }
      const odp = route.points.at(-1)!
      if (!insideBoundary(odp, anchor, 500)) continue
      const feederName = assetKind === 'OLT' ? `Kabel feeder OLT–ODC ${String(odc.index).padStart(2, '0')}` : `Kabel lanjutan ${sourceLabel}–ODC ${String(odc.index).padStart(2, '0')}`
      if (odc.used === 0) {
        appendRoute(odc.feeder, odc.roadClasses, feederName, 'FEEDER')
        features.push({ type: 'Feature', properties: { kind: 'ODC', name: `ODC ${String(odc.index).padStart(2, '0')}` }, geometry: { type: 'Point', coordinates: odc.coordinate } })
      }
      appendRoute(route.points, route.roadClasses, `Kabel ODC ${String(odc.index).padStart(2, '0')}–${name}`, 'DISTRIBUTION')
      features.push({ type: 'Feature', properties: { kind: 'ODP', name }, geometry: { type: 'Point', coordinates: odp } })
      odc.used++; odpIndex++; placed = true; break
    }
    if (!placed) uncoveredTargets++
  }
  if (!features.some((feature) => feature.properties.kind === 'ODP')) throw new Error('Tidak ada ODP yang dapat dijangkau melalui data jalan di area ini.')
  return { features, uncoveredTargets }
}
