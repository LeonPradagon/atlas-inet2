import { BadRequestException, Inject, Injectable } from '@nestjs/common'
import { createHash, randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import JSZip from 'jszip'
import { Database } from '../database/database'

type KmlGeometry =
  | { type: 'Point'; coordinates: number[] }
  | { type: 'LineString'; coordinates: number[][] }
  | { type: 'Polygon'; coordinates: number[][][] }
  | { type: 'GeometryCollection'; geometries: KmlGeometry[] }
type KmlStyle = {
  lineColor?: string; lineOpacity?: number; lineWidth?: number
  fillColor?: string; fillOpacity?: number; fillEnabled?: boolean; outlineEnabled?: boolean
  labelColor?: string; labelOpacity?: number; labelScale?: number; iconColor?: string; iconOpacity?: number; iconScale?: number; iconHref?: string
  iconAnchor?: 'center' | 'bottom' | 'bottom-right'; iconOffset?: [number, number]
}
type KmzIcon = { id: string; mimeType: string; content: Buffer }
type NetworkFeature = { id: string; name: string; assetType: 'segment' | 'asset'; geometry: KmlGeometry; properties: Record<string, unknown>; style: KmlStyle; totalCores: number; fields?: Record<string, string | null> }

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true, processEntities: false })
const local = (key: string) => key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
const spreadsheetNamespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'

function normalizeSpreadsheetXml(xml: string) {
  const root = xml.match(/<([A-Za-z_][\w.-]*):[A-Za-z_][\w.-]*\b[^>]*>/)
  if (!root) return xml
  const prefix = root[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const namespaceDeclaration = new RegExp(`\\sxmlns:${prefix}=(['"])(.*?)\\1`).exec(root[0])
  if (namespaceDeclaration?.[2] !== spreadsheetNamespace) return xml
  const normalized = xml.replace(new RegExp(`(<\\/?)(?:${prefix}):`, 'g'), '$1')
  return normalized.replace(new RegExp(`\\sxmlns:${prefix}=(['"])${spreadsheetNamespace}\\1`), ` xmlns="${spreadsheetNamespace}"`)
}

async function prepareSpreadsheetForExcelJs(buffer: Buffer) {
  const archive = await JSZip.loadAsync(buffer)
  let changed = false
  for (const [path, entry] of Object.entries(archive.files)) {
    const worksheetRels = path.startsWith('xl/worksheets/_rels/') && path.endsWith('.xml.rels')
    if (entry.dir || !path.startsWith('xl/') || (!path.endsWith('.xml') && !worksheetRels)) continue
    const xml = await entry.async('string')
    const normalized = path.endsWith('.xml') ? normalizeSpreadsheetXml(xml) : xml
    // ponytail: ignore cell notes because import and analysis consume values only.
    const prepared = worksheetRels
      ? normalized.replace(/<(?:[\w.-]+:)?Relationship\b[^>]*\/>/g, (relationship) => /\bType\s*=\s*(["'])[^"']*\/comments\1/.test(relationship) ? '' : relationship)
      : normalized
    if (prepared !== xml) {
      archive.file(path, prepared)
      changed = true
    }
  }
  return changed ? archive.generateAsync({ type: 'nodebuffer' }) : buffer
}

function descendants(value: unknown, tag: string): unknown[] {
  if (!value || typeof value !== 'object') return []
  const found: unknown[] = []
  for (const [key, child] of Object.entries(value)) {
    if (local(key) === tag) found.push(...list(child))
    else if (child && typeof child === 'object') found.push(...descendants(child, tag))
  }
  return found
}

function text(value: unknown, tag: string): string | undefined {
  const entry = descendants(value, tag)[0]
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>)['#text'] === 'string') return String((entry as Record<string, unknown>)['#text'])
  return undefined
}

function coordinates(value: unknown): number[][] {
  const points = String(value ?? '').trim().split(/\s+/).map((tuple) => tuple.split(',').map(Number))
  if (points.length < 1 || points.some(([lon, lat, ...altitude]) => !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90 || altitude.some((height) => !Number.isFinite(height)))) {
    throw new BadRequestException({ message: 'KML berisi koordinat yang tidak valid.' })
  }
  return points
}

function parseGeometry(node: unknown, tag: string): KmlGeometry {
  if (tag === 'Point') return { type: 'Point', coordinates: coordinates(text(node, 'coordinates'))[0] }
  if (tag === 'LineString') {
    const points = coordinates(text(node, 'coordinates'))
    if (points.length < 2) throw new BadRequestException({ message: 'Garis pada KML harus memiliki minimal dua titik.' })
    return { type: 'LineString', coordinates: points }
  }
  const rings = descendants(node, 'coordinates').map((value) => coordinates(value))
  if (!rings.length || rings.some((ring) => ring.length < 4)) throw new BadRequestException({ message: 'Poligon pada KML memiliki ring yang tidak valid.' })
  return { type: 'Polygon', coordinates: rings }
}

function geometries(node: unknown): KmlGeometry[] {
  if (!node || typeof node !== 'object') return []
  const output: KmlGeometry[] = []
  for (const [key, child] of Object.entries(node)) {
    const tag = local(key)
    if (tag === 'Point' || tag === 'LineString' || tag === 'Polygon') {
      for (const item of list(child)) output.push(parseGeometry(item, tag))
    } else if (child && typeof child === 'object') output.push(...geometries(child))
  }
  return output
}

function placemarks(node: unknown, folders: string[] = []): { node: unknown; folders: string[] }[] {
  if (!node || typeof node !== 'object') return []
  const found: { node: unknown; folders: string[] }[] = []
  for (const [key, child] of Object.entries(node)) {
    const tag = local(key)
    if (tag === 'Placemark') found.push(...list(child).map((item) => ({ node: item, folders })))
    else if (child && typeof child === 'object') {
      if (tag === 'Folder') {
        for (const folder of list(child)) {
          const name = text(folder, 'name')?.replace(/\s+/g, ' ').trim()
          found.push(...placemarks(folder, name ? [...folders, name] : folders))
        }
      } else found.push(...placemarks(child, folders))
    }
  }
  return found
}

function kmlColor(value: string | undefined): { color: string; opacity: number } | undefined {
  const match = value?.trim().match(/^[\da-f]{8}$/i)
  if (!match) return undefined
  const [alpha, blue, green, red] = [0, 2, 4, 6].map((index) => Number.parseInt(match[0].slice(index, index + 2), 16))
  return { color: `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`, opacity: alpha / 255 }
}

function featureFields(properties: Record<string, unknown>) {
  const value = (pattern: RegExp) => {
    const entry = Object.entries(properties).find(([key]) => pattern.test(key))?.[1]
    return entry === undefined ? '' : String(entry).trim()
  }
  const installationText = value(/installation|metode.?instalasi|metode.?pasang/i).toLowerCase()
  const sideText = value(/road.?side|sisi.?jalan|posisi.?kabel/i).toLowerCase()
  const heightText = value(/pole.?height|tinggi.?tiang/i)
  const height = heightText.match(/(?:^|\D)(7|9)(?:\s?m(?:eter)?\b|$)/i)?.[1]
  return {
    area: value(/^area$|wilayah|kota/i),
    cableType: value(/cable.?type|tipe.?kabel|jenis.?kabel/i),
    installation: /burial|underground|tanam|bawah.?tanah/.test(installationText) ? 'Burial' : /aerial|overhead|udara|tiang/.test(installationText) ? 'Aerial' : null,
    side: /kanan|right/.test(sideText) ? 'Kanan' : /kiri|left/.test(sideText) ? 'Kiri' : null,
    pole: value(/^pole$|nomor.?tiang|id.?tiang/i),
    poleHeight: height ? `${height} m` : null,
    odc: value(/^odc$|odc.?name/i),
    odp: value(/^odp$|odp.?name/i),
  }
}

function validateGeoJsonGeometry(value: unknown): value is { type: string; coordinates?: unknown; geometries?: unknown } {
  if (!value || typeof value !== 'object') return false
  const geometry = value as { type?: unknown; coordinates?: unknown; geometries?: unknown }
  const position = (entry: unknown): entry is number[] => Array.isArray(entry) && entry.length >= 2 && entry.every((part) => typeof part === 'number' && Number.isFinite(part)) && Math.abs(entry[0]) <= 180 && Math.abs(entry[1]) <= 90
  const line = (entry: unknown): entry is number[][] => Array.isArray(entry) && entry.length >= 2 && entry.every(position)
  const ring = (entry: unknown): entry is number[][] => Array.isArray(entry) && entry.length >= 4 && entry.every(position) && JSON.stringify(entry[0]) === JSON.stringify(entry.at(-1))
  if (geometry.type === 'GeometryCollection') return Array.isArray(geometry.geometries) && geometry.geometries.length > 0 && geometry.geometries.every(validateGeoJsonGeometry)
  if (geometry.type === 'Point') return position(geometry.coordinates)
  if (geometry.type === 'MultiPoint') return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.every(position)
  if (geometry.type === 'LineString') return line(geometry.coordinates)
  if (geometry.type === 'MultiLineString') return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.every(line)
  if (geometry.type === 'Polygon') return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.every(ring)
  if (geometry.type === 'MultiPolygon') return Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 && geometry.coordinates.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring))
  return false
}

function styleFrom(node: unknown, resolveIcon?: (href: string) => string | undefined): KmlStyle {
  const style: KmlStyle = {}
  const line = descendants(node, 'LineStyle')[0]
  const lineColor = kmlColor(text(line, 'color'))
  if (lineColor) { style.lineColor = lineColor.color; style.lineOpacity = lineColor.opacity }
  const lineWidth = Number(text(line, 'width'))
  if (Number.isFinite(lineWidth) && lineWidth > 0) style.lineWidth = lineWidth

  const fill = descendants(node, 'PolyStyle')[0]
  const fillColor = kmlColor(text(fill, 'color'))
  if (fillColor) { style.fillColor = fillColor.color; style.fillOpacity = fillColor.opacity }
  const fillEnabled = text(fill, 'fill')
  const outlineEnabled = text(fill, 'outline')
  if (fillEnabled !== undefined) style.fillEnabled = fillEnabled !== '0'
  if (outlineEnabled !== undefined) style.outlineEnabled = outlineEnabled !== '0'

  const label = descendants(node, 'LabelStyle')[0]
  const labelColor = kmlColor(text(label, 'color'))
  if (labelColor) { style.labelColor = labelColor.color; style.labelOpacity = labelColor.opacity }
  const labelScale = text(label, 'scale')
  if (labelScale !== undefined && Number.isFinite(Number(labelScale)) && Number(labelScale) >= 0) style.labelScale = Number(labelScale)
  const icon = descendants(node, 'IconStyle')[0]
  const iconColor = kmlColor(text(icon, 'color'))
  if (iconColor) { style.iconColor = iconColor.color; style.iconOpacity = iconColor.opacity }
  const iconScale = Number(text(icon, 'scale'))
  if (Number.isFinite(iconScale) && iconScale >= 0) style.iconScale = iconScale
  const iconHref = text(icon, 'href')
  if (iconHref) style.iconHref = resolveIcon?.(iconHref) ?? iconHref
  const hotspot = descendants(icon, 'hotSpot')[0]
  if (hotspot && typeof hotspot === 'object') {
    const attrs = hotspot as Record<string, unknown>
    const x = Number(attrs['@_x'])
    const y = Number(attrs['@_y'])
    const xUnits = String(attrs['@_xunits'] ?? '')
    const yUnits = String(attrs['@_yunits'] ?? '')
    if (Number.isFinite(x) && Number.isFinite(y) && xUnits === 'fraction' && yUnits === 'fraction') {
      if (x === 0.5 && y === 0) style.iconAnchor = 'bottom'
    } else if (Number.isFinite(x) && Number.isFinite(y) && xUnits === 'pixels' && yUnits === 'pixels') {
      // ponytail: Standard Google Earth pushpins are 32px; use actual image dimensions for arbitrary pixel hotspots.
      style.iconAnchor = 'bottom-right'
      style.iconOffset = [(32 - x) / 32, y / 32]
    }
  }
  return style
}

function normalizeArchivePath(value: string) {
  const parts: string[] = []
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/').toLocaleLowerCase('en-US')
}

function archiveIconMimeType(path: string) {
  const extension = path.toLowerCase().split('.').at(-1)
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[extension ?? '']
}

function relativeArchiveIconPath(kmlDirectory: string, href: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return ''
  let decoded = href.split(/[?#]/, 1)[0]
  try { decoded = decodeURIComponent(decoded) } catch { /* keep literal archive path */ }
  return normalizeArchivePath(`${kmlDirectory}/${decoded}`)
}

export function parseKml(xml: string, file: string, resolveIcon?: (href: string) => string | undefined): NetworkFeature[] {
  if (XMLValidator.validate(xml) !== true) throw new BadRequestException({ message: 'Isi KML tidak valid.' })
  const document = parser.parse(xml)
  const styles = new Map<string, KmlStyle>()
  for (const style of descendants(document, 'Style')) {
    if (style && typeof style === 'object') {
      const id = String((style as Record<string, unknown>)['@_id'] ?? '')
      if (id) styles.set(`#${id}`, styleFrom(style, resolveIcon))
    }
  }
  const styleMaps = new Map<string, string>()
  for (const styleMap of descendants(document, 'StyleMap')) {
    if (!styleMap || typeof styleMap !== 'object') continue
    const id = String((styleMap as Record<string, unknown>)['@_id'] ?? '')
    const normal = descendants(styleMap, 'Pair').find((pair) => text(pair, 'key') === 'normal')
    const reference = text(normal, 'styleUrl')
    if (id && reference) styleMaps.set(`#${id}`, reference)
  }

  const features: NetworkFeature[] = []
  for (const [index, entry] of placemarks(document).entries()) {
    const placemark = entry.node
    const parts = geometries(placemark)
    if (!parts.length) continue
    const geometry = parts.length === 1 ? parts[0] : { type: 'GeometryCollection' as const, geometries: parts }
    const properties: Record<string, unknown> = {}
    const detailFields: Array<[string, string]> = []
    for (const key of ['name', 'description', 'styleUrl']) {
      const value = text(placemark, key)
      if (value) properties[key] = value
    }
    for (const data of descendants(placemark, 'Data')) {
      if (!data || typeof data !== 'object') continue
      const key = String((data as Record<string, unknown>)['@_name'] ?? '')
      const value = text(data, 'value')
      if (key && value !== undefined) { properties[key] = value; detailFields.push([text(data, 'displayName') ?? key, value]) }
    }
    for (const data of descendants(placemark, 'SimpleData')) {
      if (!data || typeof data !== 'object') continue
      const key = String((data as Record<string, unknown>)['@_name'] ?? '')
      const value = (data as Record<string, unknown>)['#text'] ?? Object.values(data as Record<string, unknown>).find((entry) => typeof entry === 'string')
      if (key && value !== undefined) { properties[key] = String(value); detailFields.push([key, String(value)]) }
    }

    if (detailFields.length) properties.__kmlDetailFields = detailFields
    let styleUrl = String(properties.styleUrl ?? '')
    if (styleMaps.has(styleUrl)) styleUrl = styleMaps.get(styleUrl)!
    const inlineStyle = descendants(placemark, 'Style')[0]
    const style = { ...(styles.get(styleUrl) ?? {}), ...(inlineStyle ? styleFrom(inlineStyle, resolveIcon) : {}) }
    const rawName = String(properties.name ?? '').replace(/\s+/g, ' ').trim()
    const folderPath = entry.folders.slice(-2)
    const typeName = parts.some((part) => part.type === 'LineString') ? 'Segmen' : parts.some((part) => part.type === 'Polygon') ? 'Area' : 'Aset'
    const label = rawName && !/^\d+$/.test(rawName) ? rawName : `${typeName} ${rawName || index + 1}`
    const name = [...folderPath, label].filter(Boolean).join(' · ') || `${file} · Aset ${index + 1}`
    const totalCores = Number(Object.entries(properties).find(([key]) => /total.?cores|jumlah.?core/i.test(key))?.[1] ?? 0)
    const hasLine = parts.some((part) => part.type === 'LineString' || (part.type === 'GeometryCollection' && part.geometries.some((item) => item.type === 'LineString')))
    features.push({
      id: randomUUID(), name, assetType: hasLine ? 'segment' : 'asset', geometry,
      properties: { ...properties, folderPath: entry.folders.join(' / '), __kmlStyle: style }, style, fields: featureFields(properties),
      totalCores: Number.isInteger(totalCores) && totalCores > 0 && totalCores <= 4096 ? totalCores : 0,
    })
  }
  if (!features.length) throw new BadRequestException({ message: 'Tidak ditemukan geometri yang didukung pada KML/KMZ.' })
  return features
}

@Injectable()
export class NetworkImportService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async importNetwork(file: { originalname: string; buffer: Buffer }, replaceExistingKml = false, actorId?: string) {
    if (!file || !/\.(kml|kmz)$/i.test(file.originalname)) throw new BadRequestException({ message: 'Pilih file KML atau KMZ.' })
    if (file.buffer.length > 50 * 1024 * 1024) throw new BadRequestException({ message: 'Ukuran file maksimal 50 MB.' })
    let xml: string
    const kmzIcons = new Map<string, KmzIcon>()
    let resolveKmzIcon: ((href: string) => string | undefined) | undefined
    if (/\.kmz$/i.test(file.originalname)) {
      try {
        const archive = await JSZip.loadAsync(file.buffer)
        if (Object.values(archive.files).some((item) => (item as typeof item & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize && (item as typeof item & { _data: { uncompressedSize: number } })._data.uncompressedSize > 100 * 1024 * 1024)) throw new BadRequestException({ message: 'Isi arsip KMZ melebihi batas ekstraksi 100 MB.' })
        const entry = Object.values(archive.files).find((item) => !item.dir && item.name.toLowerCase().endsWith('.kml'))
        if (!entry) throw new BadRequestException({ message: 'Arsip KMZ tidak berisi file KML.' })
        xml = await entry.async('text')
        const kmlDirectory = entry.name.split('/').slice(0, -1).join('/')
        const iconPaths = new Map<string, string>()
        let totalIconBytes = 0
        for (const image of Object.values(archive.files)) {
          if (image.dir) continue
          const mimeType = archiveIconMimeType(image.name)
          if (!mimeType) continue
          const uncompressedSize = (image as typeof image & { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
          if (uncompressedSize > 1_000_000 || totalIconBytes + uncompressedSize > 15_000_000) continue
          const content = await image.async('nodebuffer')
          totalIconBytes += content.length
          const id = createHash('sha256').update(content).digest('hex')
          kmzIcons.set(id, { id, mimeType, content })
          iconPaths.set(normalizeArchivePath(image.name), id)
        }
        resolveKmzIcon = (href) => {
          const iconId = iconPaths.get(relativeArchiveIconPath(kmlDirectory, href))
          return iconId ? `atlas-kmz-icon:${iconId}` : undefined
        }
      } catch (error) {
        if (error instanceof BadRequestException) throw error
        throw new BadRequestException({ message: 'Arsip KMZ rusak atau tidak dapat dibaca.' })
      }
    } else xml = file.buffer.toString('utf8')

    const features = parseKml(xml, file.originalname.replace(/\.(kml|kmz)$/i, ''), resolveKmzIcon)
    const batchSize = 250
    await this.db.transaction(async (client) => {
      if (replaceExistingKml) {
        await client.query("DELETE FROM network_assets WHERE source='kml'")
        await client.query('DELETE FROM network_kml_icons')
      }
      for (const icon of kmzIcons.values()) {
        await client.query('INSERT INTO network_kml_icons(id,mime_type,content) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [icon.id, icon.mimeType, icon.content])
      }
      for (let offset = 0; offset < features.length; offset += batchSize) {
        const batch = features.slice(offset, offset + batchSize)
        const payload = JSON.stringify(batch.map((feature) => ({
          id: feature.id, name: feature.name, asset_type: feature.assetType, total_cores: feature.totalCores,
          attributes: feature.properties, geometry: feature.geometry, area: feature.fields?.area, cable_type: feature.fields?.cableType,
          installation: feature.fields?.installation, road_side: feature.fields?.side, pole: feature.fields?.pole,
          pole_height: feature.fields?.poleHeight, odc: feature.fields?.odc, odp: feature.fields?.odp,
        })))
        // Preserve the original 3D GeoJSON; spatial queries use its 2D projection.
        await client.query(`WITH imported AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
            id text, name text, asset_type text, total_cores integer, attributes jsonb, geometry jsonb, area text,
            cable_type text, installation text, road_side text, pole text, pole_height text, odc text, odp text
          )
        )
        INSERT INTO network_assets(id,name,asset_type,source,total_cores,attributes,geometry,source_geometry,area,cable_type,installation,road_side,pole,pole_height,odc,odp)
        SELECT id,name,asset_type,'kml',total_cores,attributes,
          ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text),4326)),geometry,COALESCE(area,''),COALESCE(cable_type,'Fiber Optic'),
          COALESCE(installation,'Aerial'),COALESCE(road_side,'Kiri'),COALESCE(pole,''),pole_height,COALESCE(odc,''),COALESCE(odp,'')
        FROM imported`, [payload])
        await client.query(`INSERT INTO network_cores(asset_id,core_number)
          SELECT id, n FROM jsonb_to_recordset($1::jsonb) AS row(id text, total_cores integer)
          CROSS JOIN LATERAL generate_series(1,total_cores) n WHERE total_cores > 0`, [payload])
      }
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details)
        VALUES($1,'NETWORK_IMPORTED','NETWORK_IMPORT',$2,$3::jsonb)`, [actorId ?? null,randomUUID(),JSON.stringify({ source: 'kml/kmz', fileName: file.originalname, importedCount: features.length, segmentCount: features.filter((feature) => feature.assetType === 'segment').length, replacesExisting: replaceExistingKml })])
    })
    return {
      importedCount: features.length,
      segmentCount: features.filter((feature) => feature.assetType === 'segment').length,
      firstId: features[0]?.id,
    }
  }

  async importNetworkWorkbook(buffer: Buffer, actorId?: string, fileName = 'network.xlsx') {
    if (buffer.length > 10 * 1024 * 1024) throw new BadRequestException({ message: 'Ukuran file maksimal 10 MB.' })
    const workbook = new ExcelJS.Workbook()
    try { await workbook.xlsx.load(await prepareSpreadsheetForExcelJs(buffer) as never) } catch { throw new BadRequestException({ message: 'File XLSX jaringan tidak dapat dibaca.' }) }
    const sheet = workbook.worksheets[0]
    if (!sheet || sheet.rowCount < 2) throw new BadRequestException({ message: 'Sheet pertama harus berisi header dan minimal satu aset.' })
    if (sheet.rowCount > 10_001) throw new BadRequestException({ message: 'Maksimal 10.000 aset per file XLSX.' })
    const headers: string[] = []
    sheet.getRow(1).eachCell((cell, column) => { headers[column - 1] = cell.text.trim().toLowerCase() })
    const column = (pattern: RegExp) => headers.findIndex((header) => pattern.test(header))
    const columns = {
      name: column(/^(nama|name|nama kabel|nama aset)$/), geometry: column(/^(geometry geojson|geojson|geometri)$/),
      type: column(/^(tipe aset|asset type|type)$/), area: column(/^area$/), cableType: column(/^(tipe kabel|jenis kabel|cable type)$/),
      cores: column(/^(jumlah core|total cores|cores)$/), installation: column(/^(metode instalasi|installation)$/), side: column(/^(sisi jalan|road side|side)$/),
      pole: column(/^(nomor tiang|tiang|pole)$/), poleHeight: column(/^(tinggi tiang|pole height)$/), odc: column(/^odc$/), odp: column(/^odp$/),
    }
    if (columns.name < 0 || columns.geometry < 0) throw new BadRequestException({ message: 'Kolom wajib: Nama dan Geometry GeoJSON. Unduh template impor jaringan untuk format lengkap.' })
    const assets: { id: string; name: string; type: string; area: string; cableType: string; cores: number; installation: string | null; side: string | null; pole: string; poleHeight: string | null; odc: string; odp: string; geometry: unknown }[] = []
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      const value = (index: number) => index < 0 ? '' : String(row.getCell(index + 1).text ?? '').trim()
      const name = value(columns.name), rawGeometry = value(columns.geometry)
      if (!name && !rawGeometry) continue
      if (!name || !rawGeometry) throw new BadRequestException({ message: `Baris ${rowNumber}: Nama dan Geometry GeoJSON wajib diisi.` })
      let geometry: unknown
      try { geometry = JSON.parse(rawGeometry) } catch { throw new BadRequestException({ message: `Baris ${rowNumber}: Geometry GeoJSON tidak valid.` }) }
      if (!validateGeoJsonGeometry(geometry)) throw new BadRequestException({ message: `Baris ${rowNumber}: geometri tidak didukung atau koordinatnya tidak valid.` })
      const assetType = value(columns.type).toLowerCase()
      const inferredSegment = ['LineString', 'MultiLineString'].includes(String((geometry as { type: string }).type))
      const isSegment = ['segment', 'segmen', 'kabel', 'cable'].includes(assetType)
      const isAsset = ['asset', 'aset', 'point', 'titik'].includes(assetType)
      if (assetType && !isSegment && !isAsset) throw new BadRequestException({ message: `Baris ${rowNumber}: Tipe Aset harus Segmen atau Aset.` })
      const type = isSegment || (!assetType && inferredSegment) ? 'segment' : 'asset'
      if (type === 'segment' && !inferredSegment) throw new BadRequestException({ message: `Baris ${rowNumber}: Segmen harus memakai geometri LineString atau MultiLineString.` })
      const coreText = value(columns.cores), cores = coreText ? Number(coreText) : 0
      if (!Number.isInteger(cores) || cores < 0 || cores > 4096) throw new BadRequestException({ message: `Baris ${rowNumber}: Jumlah Core harus bilangan bulat 0–4096.` })
      const installationText = value(columns.installation).toLowerCase()
      const installation = /^(aerial|udara|overhead)$/.test(installationText) ? 'Aerial' : /^(burial|tanam|bawah tanah)$/.test(installationText) ? 'Burial' : null
      if (installationText && !installation) throw new BadRequestException({ message: `Baris ${rowNumber}: Metode Instalasi harus Aerial atau Burial.` })
      const sideText = value(columns.side).toLowerCase()
      const side = /^(kiri|left)$/.test(sideText) ? 'Kiri' : /^(kanan|right)$/.test(sideText) ? 'Kanan' : null
      if (sideText && !side) throw new BadRequestException({ message: `Baris ${rowNumber}: Sisi Jalan harus Kiri atau Kanan.` })
      const heightText = value(columns.poleHeight).toLowerCase().replace(/meter/, 'm')
      const poleHeight = heightText ? (/^(7|9)\s?m$/.test(heightText) ? `${heightText[0]} m` : null) : null
      if (heightText && !poleHeight) throw new BadRequestException({ message: `Baris ${rowNumber}: Tinggi Tiang harus 7 m atau 9 m.` })
      assets.push({ id: randomUUID(), name, type, area: value(columns.area), cableType: value(columns.cableType) || 'Fiber Optic', cores, installation, side, pole: value(columns.pole), poleHeight, odc: value(columns.odc), odp: value(columns.odp), geometry })
      if (assets.length > 10_000) throw new BadRequestException({ message: 'Maksimal 10.000 aset per file XLSX.' })
    }
    if (!assets.length) throw new BadRequestException({ message: 'Tidak ada baris aset pada file.' })
    await this.db.transaction(async (client) => {
      const payload = JSON.stringify(assets.map((asset) => ({
        id: asset.id, name: asset.name, type: asset.type, area: asset.area, cable_type: asset.cableType, total_cores: asset.cores,
        installation: asset.installation, road_side: asset.side, pole: asset.pole, pole_height: asset.poleHeight, odc: asset.odc,
        odp: asset.odp, geometry: asset.geometry, attributes: { importSource: 'xlsx' },
      })))
      await client.query(`WITH imported AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
          id text,name text,type text,area text,cable_type text,total_cores integer,installation text,road_side text,pole text,pole_height text,odc text,odp text,geometry jsonb,attributes jsonb
        )
      )
      INSERT INTO network_assets(id,name,asset_type,source,area,cable_type,total_cores,installation,road_side,pole,pole_height,odc,odp,attributes,geometry,source_geometry)
      SELECT id,name,type,'xlsx',COALESCE(area,''),COALESCE(cable_type,'Fiber Optic'),COALESCE(total_cores,0),COALESCE(installation,'Aerial'),COALESCE(road_side,'Kiri'),COALESCE(pole,''),pole_height,COALESCE(odc,''),COALESCE(odp,''),attributes,
        ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text),4326)),geometry FROM imported`, [payload])
      await client.query(`INSERT INTO network_cores(asset_id,core_number)
        SELECT id,n FROM jsonb_to_recordset($1::jsonb) AS row(id text,total_cores integer)
        CROSS JOIN LATERAL generate_series(1,total_cores) n WHERE total_cores > 0`, [payload])
      await client.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details)
        VALUES($1,'NETWORK_IMPORTED','NETWORK_IMPORT',$2,$3::jsonb)`, [actorId ?? null,randomUUID(),JSON.stringify({ source: 'xlsx', fileName, importedCount: assets.length, segmentCount: assets.filter((asset) => asset.type === 'segment').length })])
    })
    return { importedCount: assets.length, segmentCount: assets.filter((asset) => asset.type === 'segment').length }
  }

  async analyzeWorkbook(buffer: Buffer, options: { maxBytes?: number; maxRows?: number; validateRegions?: boolean } = {}) {
    const maxBytes = options.maxBytes ?? 10 * 1024 * 1024
    const maxRows = options.maxRows ?? 500
    if (buffer.length > maxBytes) throw new BadRequestException({ message: `Ukuran file maksimal ${Math.round(maxBytes / 1024 / 1024)} MB.` })
    const workbook = new ExcelJS.Workbook()
    try { await workbook.xlsx.load(await prepareSpreadsheetForExcelJs(buffer) as never) } catch { throw new BadRequestException({ message: 'File XLSX tidak dapat dibaca.' }) }
    const sheet = workbook.worksheets[0]
    if (!sheet || sheet.rowCount < 2) throw new BadRequestException({ message: 'Sheet pertama harus memiliki header dan minimal satu baris lokasi.' })
    const headers: string[] = []
    sheet.getRow(1).eachCell((cell, column) => { headers[column - 1] = cell.text.trim() })
    const addressIndex = headers.findIndex((value) => /alamat|address/i.test(value))
    const latIndex = headers.findIndex((value) => /^lat|latitude$/i.test(value))
    const lonIndex = headers.findIndex((value) => /^(lon|lng|longitude)$/i.test(value))
    if (addressIndex < 0 && (latIndex < 0 || lonIndex < 0)) throw new BadRequestException({ message: 'Kolom wajib: Alamat atau pasangan Latitude dan Longitude.' })
    const column = (pattern: RegExp) => headers.findIndex((value) => pattern.test(value))
    const indexes = {
      province: column(/^(provinsi|province)$/i), city: column(/^(kabupaten|kabupaten\/kota|kota|city)$/i),
      district: column(/^(kecamatan|district)$/i), village: column(/^(kelurahan|kelurahan\/desa|desa|village)$/i),
      number: column(/^(nomor rumah|no rumah|house number)$/i), postal: column(/^(kode pos|postal code|postcode)$/i),
    }
    const rows: { row: number; address: string; latitude: number | null; longitude: number | null; structured?: Record<string, string>; inputError?: string }[] = []
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      const value = (index: number) => index < 0 ? '' : String(row.getCell(index + 1).text ?? '').trim()
      const address = value(addressIndex)
      const latitudeText = value(latIndex), longitudeText = value(lonIndex)
      const blankCoordinates = !latitudeText && !longitudeText
      if (!address && blankCoordinates) continue
      const latitude = latitudeText ? Number(latitudeText) : null
      const longitude = longitudeText ? Number(longitudeText) : null
      const structured = Object.fromEntries(Object.entries({
        province: value(indexes.province), city: value(indexes.city), district: value(indexes.district),
        subdistrict: value(indexes.village), number: value(indexes.number), postalCode: value(indexes.postal), street: address,
      }).filter(([, field]) => field))
      let inputError: string | undefined
      if ((latitudeText && !longitudeText) || (!latitudeText && longitudeText)) inputError = 'Latitude dan Longitude harus diisi berpasangan.'
      else if (latitudeText && longitudeText && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude!) > 90 || Math.abs(longitude!) > 180)) inputError = 'Koordinat tidak valid.'
      else if (blankCoordinates && (!address || !structured.province || !structured.city || !structured.district)) inputError = 'Alamat tanpa koordinat wajib memiliki Alamat, Provinsi, Kabupaten/Kota, dan Kecamatan.'
      rows.push({ row: rowNumber, address: address || `${latitudeText}, ${longitudeText}`, latitude, longitude, ...(Object.keys(structured).length ? { structured } : {}), ...(inputError ? { inputError } : {}) })
    }
    if (!rows.length) throw new BadRequestException({ message: 'Tidak ada baris lokasi pada file.' })
    if (rows.length > maxRows) throw new BadRequestException({ message: `Maksimal ${maxRows.toLocaleString('id-ID')} lokasi per file XLSX.` })
    if (options.validateRegions && !['province', 'city', 'district'].every((field) => indexes[field as keyof typeof indexes] >= 0)) {
      throw new BadRequestException({ message: 'Template alamat harus menyediakan kolom Provinsi, Kabupaten/Kota, dan Kecamatan.' })
    }
    return rows
  }
}
