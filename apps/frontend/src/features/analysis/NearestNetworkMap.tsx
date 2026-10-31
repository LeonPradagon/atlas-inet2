import { api, type NetworkAsset } from '../../lib/api'
import { assetFeatures, addAtlasMapIcons, loadNetworkMapIcons, cableLengthMeters } from '../map/MapPage'
import { kmzLegend } from '../map/kmzLegend'
import type { NetworkCapacity } from './NetworkCapacityDetail'
import { useEffect, useRef, useState } from 'react'
import { LngLatBounds, Map, NavigationControl, Popup, setWorkerUrl } from 'maplibre-gl'
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
  const [assetError, setAssetError] = useState('')
  const [assetCount, setAssetCount] = useState(0)
  const [assetsLoading, setAssetsLoading] = useState(false)
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!element.current) return
    setAssetError('')
    let request: AbortController | undefined
    let requestVersion = 0
    let viewportTimer: ReturnType<typeof setTimeout> | undefined
    let stopIcons: (() => void) | undefined
    let active = true
    const assetsById = new globalThis.Map<string,NetworkAsset>()
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

      map.addLayer({ id: 'cable-route', type: 'line', source: 'search', filter: ['==', 'kind', 'route'], paint: { 'line-color': kmzLegend.find(rule => rule.category === 'DROP')!.color, 'line-width': 2, 'line-dasharray': [3,2] } })
      map.addLayer({ id: 'locations', type: 'circle', source: 'search', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 8, 'circle-color': ['match', ['get', 'kind'], 'location', '#e53935', '#3454d1'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } })
      map.addLayer({ id: 'labels', type: 'symbol', source: 'search', filter: ['==', '$type', 'Point'], layout: { 'text-field': ['get', 'label'], 'text-size': 12, 'text-offset': [0, 1.5] }, paint: { 'text-halo-color': '#fff', 'text-halo-width': 2 } })
      addAtlasMapIcons(map)
      map.addSource('nearby-assets', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: 'asset-areas', type: 'fill', source: 'nearby-assets', filter: ['all',['==',['geometry-type'],'Polygon'],['!=',['get','fillEnabled'],false]], paint: { 'fill-color': ['get','fillColor'], 'fill-opacity': ['min',['get','fillOpacity'],0.15] } },'cable-route')
      map.addLayer({ id: 'asset-lines', type: 'line', source: 'nearby-assets', filter: ['any',['==',['geometry-type'],'LineString'],['all',['==',['geometry-type'],'Polygon'],['!=',['get','outlineEnabled'],false]]], paint: { 'line-color': ['get','lineColor'], 'line-width': ['get','lineWidth'], 'line-opacity': ['get','lineOpacity'] } },'cable-route')
      map.addLayer({ id: 'asset-icons', type: 'symbol', source: 'nearby-assets', filter: ['==',['geometry-type'],'Point'], layout: { 'icon-image': ['coalesce',['image',['get','iconImageId']],['image',['get','fallbackIconImageId']],['image',['get','atlasIconId']]], 'icon-size': ['interpolate',['linear'],['zoom'],12,['*',['get','legendIconScale'],0.35],14,['*',['get','legendIconScale'],0.5],16,['*',['get','legendIconScale'],0.75],18,['get','legendIconScale']], 'icon-anchor': ['get','iconAnchor'], 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': ['get','iconOpacity'] } })
      map.addLayer({ id: 'asset-labels', minzoom: 17, type: 'symbol', source: 'nearby-assets', filter: ['all',['==',['geometry-type'],'Point'],['>',['get','legendLabelSize'],0]], layout: { 'text-field': ['get','sourceLabel'], 'text-size': ['*',['get','legendLabelSize'],10], 'text-offset': [0,1.5], 'text-padding': 8, 'text-allow-overlap': false, 'text-ignore-placement': false },paint: { 'text-color': ['get','labelColor'], 'text-opacity': ['get','labelOpacity'], 'text-halo-color': ['match',['get','labelColor'],'#ffffff','#263238','#ffffff'],'text-halo-width': 1.5 } })
      map.addLayer({ id: 'asset-line-hit', type: 'line', source: 'nearby-assets', filter: ['==',['geometry-type'],'LineString'], paint: { 'line-width': 18,'line-opacity': 0 } })
      map.addLayer({ id: 'asset-point-hit', type: 'circle', source: 'nearby-assets', filter: ['==',['geometry-type'],'Point'], paint: { 'circle-radius': 16,'circle-opacity': 0 } })
      const loadViewport = async () => {
        const version = ++requestVersion
        request?.abort()
        request = new AbortController()
        const bounds = map.getBounds()
        const bbox = [Math.max(-180,bounds.getWest()),Math.max(-90,bounds.getSouth()),Math.min(180,bounds.getEast()),Math.min(90,bounds.getNorth())]
        setAssetsLoading(true)
        try {
          const assets = await api<NetworkAsset[]>('/assets/map?bbox='+bbox.join(',')+'&zoom=24',{signal:request.signal,timeout:30000})
          if (!active || version !== requestVersion) return
          const unique = new globalThis.Map<string,NetworkAsset>()
          for (const asset of assets) unique.set(JSON.stringify([asset.source,asset.name,asset.geometry,asset.attributes]),asset)
          const visible = [...unique.values()]
          assetsById.clear()
          visible.forEach(asset=>assetsById.set(asset.id,asset))
          const features=assetFeatures(visible)
          stopIcons?.()
          stopIcons=loadNetworkMapIcons(map,features)
          ;(map.getSource('nearby-assets') as import('maplibre-gl').GeoJSONSource).setData({type:'FeatureCollection',features})
          setAssetCount(visible.length)
          setAssetError('')
        } catch {
          if(active && version === requestVersion) setAssetError('Aset pada area peta gagal dimuat. Geser atau zoom peta untuk mencoba lagi.')
        } finally {
          if(active && version === requestVersion) setAssetsLoading(false)
        }
      }
      map.on('moveend',()=>{clearTimeout(viewportTimer);viewportTimer=setTimeout(()=>void loadViewport(),250)})
      const popup = new Popup({maxWidth:'460px',closeButton:true,className:'analysis-asset-popup'})
      const hitLayers=['asset-point-hit','asset-line-hit','asset-areas','cable-route','locations']
      map.on('mousemove',event=>{map.getCanvas().style.cursor=map.queryRenderedFeatures(event.point,{layers:hitLayers}).length?'pointer':''})
      map.on('click',event=>{
        const hits=map.queryRenderedFeatures(event.point,{layers:hitLayers})
        const feature=hits.find(f=>f.layer.id==='asset-point-hit')??hits.find(f=>f.layer.id==='asset-line-hit')??hits.find(f=>f.layer.id==='cable-route')??hits[0]
        if(!feature)return
        const asset=assetsById.get(String(feature.properties?.id??'')) ?? (feature.properties?.kind==='target' && result.network?.id ? assetsById.get(result.network.id) : undefined)
        const content=document.createElement('div');content.className='analysis-asset-popup-body'
        const title=document.createElement('strong');title.textContent=asset?String(asset.attributes?.name??asset.name):feature.layer.id==='cable-route'?'Usulan jalur kabel mengikuti jalan mobil':String(feature.properties?.label??'Detail lokasi');content.append(title)
        const formatLength = (meters: number) => meters >= 1000 ? (meters / 1000).toLocaleString('id-ID',{maximumFractionDigits:2})+' km ('+meters.toLocaleString('id-ID',{maximumFractionDigits:1})+' m)' : meters.toLocaleString('id-ID',{maximumFractionDigits:1})+' m'
        const cableGeometry = asset?.geometry ?? (feature.properties?.kind === 'target' ? result.network?.geometry ?? null : null)
        const cableLength = cableLengthMeters(cableGeometry)
        const lengths: [string,string][] = []
        if(cableLength !== null) lengths.push(['Panjang total kabel eksisting', formatLength(cableLength)])
        if(feature.layer.id === 'cable-route' || feature.properties?.kind === 'target' || (asset?.id && asset.id === result.network?.id)) lengths.push(['Estimasi kabel baru melalui jalan mobil', result.distanceMeters === null ? 'Rute belum tersedia' : formatLength(result.distanceMeters)])
        if(lengths.length){
          const summary=document.createElement('section');summary.className='analysis-cable-length';summary.setAttribute('aria-label','Panjang kabel')
          for(const [label,value] of lengths){const row=document.createElement('div');const heading=document.createElement('small');const length=document.createElement('strong');heading.textContent=label;length.textContent=value;row.append(heading,length);summary.append(row)}
          const note=document.createElement('small');note.textContent='Kabel eksisting dihitung dari geometri KMZ. Estimasi kabel baru mengikuti rute jalan dan belum termasuk cadangan/slack.';summary.append(note);content.append(summary)
        }
        const table=document.createElement('table');table.className='map-asset-popup-table'
        const body=document.createElement('tbody')
        const attrs=asset?.attributes??{}
        const saved=attrs.__kmlDetailFields
        const rows: [string,unknown][]=asset?(Array.isArray(saved)?saved.filter((row):row is [string,unknown]=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'):Object.entries(attrs).filter(([key])=>!key.startsWith('__')&&key!=='name')):feature.layer.id==='cable-route'?[['Estimasi panjang kabel',result.distanceMeters==null?'Belum tersedia':Math.round(result.distanceMeters)+' m'],['Acuan jalur','Jalan yang dapat dilalui mobil'],['Tampilan','Legenda drop: garis ungu putus-putus (usulan)']]:[['Latitude',event.lngLat.lat],['Longitude',event.lngLat.lng]]

        for(const [label,value]of rows){const tr=document.createElement('tr');const th=document.createElement('th');const td=document.createElement('td');th.scope='row';th.textContent=label;td.textContent=String(value??'');tr.append(th,td);body.append(tr)}
        table.append(body);content.append(table);popup.setLngLat(event.lngLat).setDOMContent(content).addTo(map)
      })
      const bounds = ring.reduce((b, point) => b.extend(point), new LngLatBounds())
      if (result.routeGeometry?.type === 'LineString') result.routeGeometry.coordinates.forEach((p) => bounds.extend([p[0], p[1]]))
      map.fitBounds(bounds, { padding: 48, maxZoom: 16, duration: 0 })
      clearTimeout(viewportTimer)
      void loadViewport()
    })
    const observer = new ResizeObserver(() => map.resize())
    observer.observe(element.current)
    return () => { active=false;clearTimeout(viewportTimer);request?.abort();stopIcons?.();observer.disconnect();map.remove() }
  }, [result])
  return <><small className="d-block mb-2 text-secondary" role="status">{assetsLoading ? "Memuat aset pada area peta…" : assetCount.toLocaleString("id-ID")+" aset pada area peta"} · Perbesar peta untuk menampilkan label. Aset duplikat identik ditampilkan satu kali.</small>{assetError && <div className="alert alert-warning">{assetError}</div>}<div ref={element} aria-label="Peta jaringan terdekat dan estimasi jalur kabel mengikuti jalan mobil" style={{ height: 500, borderRadius: 8 }} /><small className="d-block mt-2 text-secondary">Klik ikon atau kabel untuk detail KMZ. Garis ungu putus-putus adalah usulan jalur penarikan; ikon dan kabel eksisting mengikuti style KMZ atau fallback legend.</small></>
}
