import type { NetworkCapacity } from './NetworkCapacityDetail'
import { useEffect, useRef } from 'react'
import { LngLatBounds, Map, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import type { Feature, Geometry } from 'geojson'
import { offsetCoordinate } from './ftthDraft'

export type NetworkSearchResult = {
  latitude: number; longitude: number; searchRadiusMeters?: number; expansionAvailable?: boolean;
  network: { capacity?: NetworkCapacity; id?: string; name: string; area?: string; cableType?: string; searchRadiusMeters?: number; straightDistanceMeters?: number; nearestPoint?: { coordinates: [number, number] }; geometry?: Geometry } | null;
  routeGeometry?: Geometry; distanceMeters: number | null;
}

export function NetworkLocationsMap({ points, onSelect }: { points: { row: number; latitude: number; longitude: number }[]; onSelect: (row: number) => void }) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!element.current || !points.length) return
    setWorkerUrl(workerUrl)
    const map = new Map({ container: element.current, style: 'https://tiles.openfreemap.org/styles/liberty', center: [118,-2.5], zoom: 4 })
    map.addControl(new NavigationControl())
    map.on('load', () => {
      map.addSource('locations', { type: 'geojson', data: { type: 'FeatureCollection', features: points.map(point => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [point.longitude,point.latitude] }, properties: { row: point.row } })) } })
      map.addLayer({ id: 'locations', type: 'circle', source: 'locations', paint: { 'circle-radius': 7, 'circle-color': '#3454d1', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.on('mouseenter','locations', () => { map.getCanvas().style.cursor = 'pointer' })
      map.on('mouseleave','locations', () => { map.getCanvas().style.cursor = '' })
      map.on('click','locations', event => { const row = Number(event.features?.[0]?.properties?.row); if (Number.isInteger(row)) onSelect(row) })
      const bounds = points.reduce((bounds, point) => bounds.extend([point.longitude,point.latitude]), new LngLatBounds())
      map.fitBounds(bounds, { padding: 48, maxZoom: 15, duration: 0 })
    })
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(element.current)
    return () => { observer.disconnect(); map.remove() }
  }, [points,onSelect])
  return <div ref={element} aria-label="Peta seluruh lokasi analisis massal" style={{ height: 360, borderRadius: 8 }} />
}

export function NearestNetworkMap({ result }: { result: NetworkSearchResult }) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!element.current) return
    setWorkerUrl(workerUrl)
    const center: [number, number] = [result.longitude, result.latitude]
    const radius = result.network?.searchRadiusMeters ?? result.searchRadiusMeters ?? 1000
    const ring = Array.from({ length: 65 }, (_, i) => offsetCoordinate(center, radius, i / 64 * Math.PI * 2))
    const features: Feature[] = [
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'radius' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: center }, properties: { kind: 'location', label: 'Lokasi pelanggan' } },
    ]
    if (result.network?.geometry) features.push({ type: 'Feature', geometry: result.network.geometry, properties: { kind: 'network', label: result.network.name } })
    if (result.network?.nearestPoint) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: result.network.nearestPoint.coordinates }, properties: { kind: 'target', label: result.network.name } })
    if (result.routeGeometry) features.push({ type: 'Feature', geometry: result.routeGeometry, properties: { kind: 'route' } })
    const map = new Map({ container: element.current, style: 'https://tiles.openfreemap.org/styles/liberty', center, zoom: 14 })
    map.addControl(new NavigationControl())
    map.on('load', () => {
      map.addSource('search', { type: 'geojson', data: { type: 'FeatureCollection', features } })
      map.addLayer({ id: 'radius-fill', type: 'fill', source: 'search', filter: ['==', 'kind', 'radius'], paint: { 'fill-color': '#3454d1', 'fill-opacity': 0.08 } })
      map.addLayer({ id: 'radius-line', type: 'line', source: 'search', filter: ['==', 'kind', 'radius'], paint: { 'line-color': '#3454d1', 'line-width': 2, 'line-dasharray': [3, 2] } })
      map.addLayer({ id: 'network', type: 'line', source: 'search', filter: ['==', 'kind', 'network'], paint: { 'line-color': '#3454d1', 'line-width': 4 } })
      map.addLayer({ id: 'cable-route', type: 'line', source: 'search', filter: ['==', 'kind', 'route'], paint: { 'line-color': '#e67e22', 'line-width': 5 } })
      map.addLayer({ id: 'locations', type: 'circle', source: 'search', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'location', '#e53935', '#3454d1'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.addLayer({ id: 'labels', type: 'symbol', source: 'search', filter: ['==', '$type', 'Point'], layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.5] }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2 } })
      const bounds = ring.reduce((b, point) => b.extend(point), new LngLatBounds())
      if (result.routeGeometry?.type === 'LineString') result.routeGeometry.coordinates.forEach((p) => bounds.extend([p[0], p[1]]))
      map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 })
    })
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(element.current)
    return () => { observer.disconnect(); map.remove() }
  }, [result])
  return <div ref={element} aria-label="Peta jaringan terdekat dan estimasi jalur kabel mengikuti jalan mobil" style={{ height: 500, borderRadius: 8 }} />
}
