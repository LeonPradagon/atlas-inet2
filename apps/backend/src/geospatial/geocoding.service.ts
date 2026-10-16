import { Injectable, ServiceUnavailableException, BadGatewayException } from '@nestjs/common'

export type StructuredAddress = {
  street?: string
  number?: string
  subdistrict?: string
  subdistrictCandidates?: string[]
  district?: string
  districtCandidates?: string[]
  city?: string
  cityCandidates?: string[]
  province?: string
  postalCode?: string
}

type PhotonFeature = {
  properties?: { name?: string; street?: string; housenumber?: string; locality?: string; district?: string; city?: string; county?: string; state?: string; postcode?: string; countrycode?: string; type?: string; osm_type?: string; osm_id?: number }
  geometry?: { coordinates?: unknown }
}
export type AddressSuggestion = { id: string; label: string; longitude: number; latitude: number; street?: string; number?: string; subdistrict?: string; district?: string; city?: string; province?: string; postalCode?: string; matchQuality: 'approximate' }
type NominatimAddress = Record<string, string | undefined> & {
  suburb?: string
  village?: string
  neighbourhood?: string
  hamlet?: string
  district?: string
  city_district?: string
  city?: string
  town?: string
  municipality?: string
  county?: string
  state?: string
  postcode?: string
  country_code?: string
}
type NominatimFeature = { lat: string; lon: string; name?: string; display_name?: string; address?: NominatimAddress; country_code?: string }
type BigBoundaryResponse = { features?: Array<{ attributes?: Record<string, string | number | null> }> }
const BIG_BOUNDARY_QUERY_URL = 'https://geoservices.big.go.id/rbi/rest/services/BATASWILAYAH/BATAS_DESAKEL_AR/MapServer/0/query'

function tokens(value: string) {
  return canonicalStreet(value).toLocaleLowerCase('id')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\brachmat\b/g, 'rahmat')
    .replace(/\b(?:k\s+h|kh)\b/g, 'kyai haji')
    .replace(/\bpal merah\b/g, 'palmerah')
    .split(/\s+/).filter((token) => token && token !== 'jalan' && token !== 'no')
}

function canonicalStreet(value: string) {
  return value
    .replace(/\b(?:[A-Z]\.?\s*){2,}(?=[A-Z][a-z])/g, (initials) => `${initials.replace(/[.\s]/g, '')} `)
    .replace(/^\s*(?:jln|jl)\.?\s*/i, 'Jalan ')
    .replace(/\bk\s*\.?\s*h\.?\s*/gi, 'Kyai Haji ')
    .replace(/\bkh\.?\s*/gi, 'Kyai Haji ')
    .replace(/\bhj\.?\s*/gi, 'Hajjah ')
    .replace(/\bh\.?\s+(?=[\p{L}])/giu, 'Haji ')
    .replace(/\br\.?\s*a\.?\s+(?=[\p{L}])/giu, 'Raden Ajeng ')
    .replace(/\br\.?\s+(?=[\p{L}])/giu, 'Raden ')
    .replace(/\bprof\.?\s*/gi, 'Profesor ')
    .replace(/\bdr\.?\s+(?=[\p{L}])/giu, 'Doktor ')
    .replace(/\bir\.?\s+(?=[\p{L}])/giu, 'Insinyur ')
    .replace(/\b(jln|jl)\.?\s*/gi, 'Jalan ')
    .replace(/\bgg\.?\s*/gi, 'Gang ')
    .replace(/\bkp\.?\s*/gi, 'Kampung ')
    .replace(/\bdsn\.?\s*/gi, 'Dusun ')
    .replace(/\bds\.?\s*/gi, 'Desa ')
    .replace(/\bdk\.?\s*/gi, 'Dukuh ')
    .replace(/\btj\.?\s*/gi, 'Tanjung ')
    .replace(/\bpsr\.?\s*/gi, 'Pasar ')
    .replace(/\bklp\.?\b/gi, 'Kelapa')
    .replace(/\bkb\.?\b/gi, 'Kebon')
    .replace(/\bky\b/gi, 'Kyai')
}

function geocoderCity(value?: string) {
  const name = value?.replace(/^(?:Kabupaten Administrasi|Kabupaten|Kota Administrasi|Kota|Kab)\s+/i, '').trim()
  if (!name) return {}
  if (/^Jakarta (?:Barat|Pusat|Selatan|Timur|Utara)$/i.test(name)) return { city: 'Jakarta' }
  return value?.startsWith('Kabupaten') ? { county: name } : { city: name }
}

function matchesStreetToken(expected: string, actualTokens: string[]) {
  const numberNames: Record<string, string[]> = { '1': ['i', 'satu'], '2': ['ii', 'dua'], '3': ['iii', 'tiga'], '4': ['iv', 'empat'], '5': ['v', 'lima'], '6': ['vi', 'enam'], '7': ['vii', 'tujuh'], '8': ['viii', 'delapan'], '9': ['ix', 'sembilan'], '10': ['x', 'sepuluh'], '11': ['xi'], '12': ['xii'], '13': ['xiii'], '14': ['xiv'], '15': ['xv'], '16': ['xvi'], '17': ['xvii'], '18': ['xviii'], '19': ['xix'], '20': ['xx'] }
  const alternatives = numberNames[expected] ?? Object.entries(numberNames).flatMap(([number, names]) => names.includes(expected) ? [number, ...names.filter((name) => name !== expected)] : [])
  return actualTokens.includes(expected) || alternatives.some((alternative) => actualTokens.includes(alternative))
}

@Injectable()
export class GeocodingService {
  private nominatimLastRequest = 0
  private nominatimQueue: Promise<void> = Promise.resolve()
  private readonly nominatimCache = new Map<string, [number, number]>()
  private readonly nominatimReverseCache = new Map<string, StructuredAddress>()
  private readonly boundaryCache = new Map<string, StructuredAddress>()

  private async fetchNominatim(url: URL) {
    let release!: () => void
    const previous = this.nominatimQueue
    this.nominatimQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const delay = Math.max(0, 1000 - (Date.now() - this.nominatimLastRequest))
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      this.nominatimLastRequest = Date.now()
      return await fetch(url, { headers: { 'User-Agent': 'ATLAS-INET/1.0 (address network analysis)' }, signal: AbortSignal.timeout(15_000) })
    } finally {
      release()
    }
  }

  private async search(path: 'api' | 'structured' | 'reverse', params: URLSearchParams): Promise<PhotonFeature[]> {
    const baseUrl = process.env.GEOCODER_URL
    if (!baseUrl) throw new ServiceUnavailableException({ code: 'GEOCODING_UNAVAILABLE', message: 'Provider geocoding belum dikonfigurasi. Data alamat belum dianalisis.' })
    const url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`)
    url.search = params.toString()
    let response: Response
    try { response = await fetch(url, { headers: { 'User-Agent': 'ATLAS-INET/1.0' }, signal: AbortSignal.timeout(15_000) }) }
    catch { throw new ServiceUnavailableException({ code: 'GEOCODING_UNAVAILABLE', message: 'Layanan geocoding tidak dapat dihubungi.' }) }
    if (!response.ok) throw new BadGatewayException({ message: 'Layanan geocoding gagal memproses alamat.' })
    try { return (await response.json() as { features?: PhotonFeature[] }).features ?? [] }
    catch { throw new BadGatewayException({ message: 'Respons Photon tidak valid.' }) }
  }

  async geocode(address: string): Promise<[number, number]> {
    const features = await this.search('api', new URLSearchParams({ q: address, limit: '1' }))
    return this.coordinates(features[0])
  }

  async suggestAddress(query: string, context: StructuredAddress = {}): Promise<AddressSuggestion[]> {
    const rawQuery = query.slice(0, 200).trim().toLocaleLowerCase('id')
    const normalizedQuery = canonicalStreet(rawQuery).replace(/\bkec\.?\b/gi, 'Kecamatan').replace(/\bno\.?\s*(?=\d)/gi, 'Nomor ')
    const queryVariants = [...new Set([normalizedQuery, rawQuery])]
    const searches = queryVariants.flatMap((variant) => {
      const streetWithoutNumber = variant.replace(/\s+(?:no(?:mor)?\.?\s*)?\d+[a-z]?$/i, '').trim()
      return [
        [variant, context.subdistrict, context.district, context.city, context.province, context.postalCode],
        [variant, context.city, context.province],
        [streetWithoutNumber, context.city, context.province],
        [streetWithoutNumber],
      ]
    })
    const streetNeedles = tokens(normalizedQuery
      .replace(/\b(?:no(?:mor)?\.?)\s*\d+[a-z]?\b/gi, ' ')
      .replace(/\b\d{5}\b/g, ' ')
      .replace(/\s+\d+[a-z]?$/i, ' '))
      .filter((token) => !['kyai', 'haji', 'jalan', 'gang', 'kampung', 'raya', 'arteri', 'utama'].includes(token))
    const matchesRequestedStreet = (feature: PhotonFeature) => {
      const properties = feature.properties ?? {}
      const regionTokens = new Set(tokens([properties.city, properties.county, properties.state, properties.postcode].filter(Boolean).join(' ')))
      const requestedStreet = streetNeedles.filter((token) => !regionTokens.has(token))
      if (!requestedStreet.length) return false
      const actualStreet = tokens(properties.street ?? properties.name ?? '').filter((token) => !regionTokens.has(token))
      return requestedStreet.every((token) => matchesStreetToken(token, actualStreet))
    }
    let features: PhotonFeature[] = []
    const searched = new Set<string>()
    for (const parts of searches) {
      const searchText = parts.filter(Boolean).join(', ')
      if (searched.has(searchText)) continue
      searched.add(searchText)
      const results = await this.search('api', new URLSearchParams({ q: searchText, countrycode: 'id', limit: '5' }))
      if (!results.length) continue
      if (!features.length) features = results
      if (results.some(matchesRequestedStreet)) { features = results; break }
    }
    const unique = new Set<string>()
    return features.flatMap((feature) => {
      try {
        const properties = feature.properties ?? {}
        if (!matchesRequestedStreet(feature)) return []
        const [longitude, latitude] = this.coordinates(feature)
        const id = `${properties.osm_type ?? 'feature'}:${properties.osm_id ?? `${longitude},${latitude}`}`
        if (unique.has(id)) return []
        unique.add(id)
        const street = properties.street ?? properties.name
        const fields = [properties.name, properties.street, properties.housenumber && `No. ${properties.housenumber}`, properties.locality, properties.district, properties.city, properties.postcode]
        return [{ id, label: [...new Set(fields.filter(Boolean))].join(', '), longitude, latitude, street, number: properties.housenumber, subdistrict: properties.locality, district: properties.district, city: properties.city ?? properties.county, province: properties.state, postalCode: properties.postcode, matchQuality: 'approximate' as const }]
      } catch { return [] }
    })
  }

  async reverseAddress(longitude: number, latitude: number): Promise<StructuredAddress | null> {
    let features: PhotonFeature[] = []
    try {
      features = await this.search('reverse', new URLSearchParams({ lon: String(longitude), lat: String(latitude), limit: '1' }))
    } catch {
      // The administrative boundary lookup can still resolve coordinates when Photon is unavailable.
    }
    const properties = features[0]?.properties
    const photon: StructuredAddress | null = properties ? {
      subdistrict: properties.locality,
      district: properties.district,
      city: properties.city ?? properties.county,
      province: properties.state,
      postalCode: properties.postcode,
    } : null

    const boundary = await this.reverseBigBoundary(longitude, latitude)
    if (boundary) return { ...photon, ...boundary }
    if (photon?.subdistrict && !/^(?:rt|rw)\s*\d/i.test(photon.subdistrict)) return photon

    const key = `${longitude.toFixed(6)},${latitude.toFixed(6)}`
    const cached = this.nominatimReverseCache.get(key)
    if (cached) return { ...photon, ...cached }
    try {
      const serviceUrl = new URL(process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org/search')
      serviceUrl.pathname = serviceUrl.pathname.replace(/\/search(?:\.php)?\/?$/, '/reverse')
      serviceUrl.search = new URLSearchParams({ lat: String(latitude), lon: String(longitude), format: 'jsonv2', addressdetails: '1', zoom: '18', 'accept-language': 'id' }).toString()
      const response = await this.fetchNominatim(serviceUrl)
      if (!response.ok) return photon
      const address = (await response.json() as NominatimFeature).address
      if (!address || (address.country_code && address.country_code.toLowerCase() !== 'id')) return photon
      const candidates = (...values: Array<string | undefined>) => [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))]
      const refined: StructuredAddress = {
        subdistrict: address.suburb ?? address.village ?? address.neighbourhood,
        subdistrictCandidates: candidates(address.suburb, address.village, address.neighbourhood, address.hamlet, photon?.subdistrict),
        district: address.district ?? address.city_district ?? photon?.district,
        districtCandidates: candidates(address.district, address.city_district, address.county, photon?.district),
        city: address.city ?? address.town ?? address.municipality ?? address.county ?? photon?.city,
        cityCandidates: candidates(address.city, address.town, address.municipality, address.county, address.city_district, photon?.city, photon?.district),
        province: address.state ?? photon?.province,
        postalCode: address.postcode ?? photon?.postalCode,
      }
      this.nominatimReverseCache.set(key, refined)
      if (this.nominatimReverseCache.size > 1000) this.nominatimReverseCache.delete(this.nominatimReverseCache.keys().next().value!)
      return { ...photon, ...refined }
    } catch {
      return photon
    }
  }

  private async reverseBigBoundary(longitude: number, latitude: number): Promise<StructuredAddress | null> {
    const key = `${longitude.toFixed(6)},${latitude.toFixed(6)}`
    const cached = this.boundaryCache.get(key)
    if (cached) return cached
    const url = new URL(BIG_BOUNDARY_QUERY_URL)
    url.search = new URLSearchParams({
      geometry: JSON.stringify({ x: longitude, y: latitude, spatialReference: { wkid: 4326 } }),
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'wadmkd,wadmkc,wadmkk,wadmpr',
      returnGeometry: 'false',
      f: 'json',
    }).toString()
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'ATLAS-INET/1.0 (administrative boundary lookup)' }, signal: AbortSignal.timeout(7_000) })
      if (!response.ok) return null
      const result = await response.json() as BigBoundaryResponse
      const attributes = result.features?.[0]?.attributes
      if (!attributes) return null
      const value = (name: string) => {
        const field = Object.keys(attributes).find((key) => key.toLowerCase() === name)
        const fieldValue = field ? attributes[field] : undefined
        return typeof fieldValue === 'string' ? fieldValue.trim() || undefined : undefined
      }
      const boundary: StructuredAddress = {
        subdistrict: value('wadmkd'),
        district: value('wadmkc'),
        city: value('wadmkk'),
        province: value('wadmpr'),
      }
      if (!boundary.subdistrict || !boundary.city) return null
      this.boundaryCache.set(key, boundary)
      if (this.boundaryCache.size > 1000) this.boundaryCache.delete(this.boundaryCache.keys().next().value!)
      return boundary
    } catch {
      return null
    }
  }

  async geocodeStructured(address: StructuredAddress): Promise<{ coordinates: [number, number]; provider: 'photon' | 'nominatim'; matchQuality?: 'approximate'; matchedStreet?: string }> {
    const params = new URLSearchParams({ countrycode: 'id', limit: '5' })
    const street = canonicalStreet(address.street ?? '').trim()
    const district = address.district?.trim()
    const location = geocoderCity(address.city)
    if (street) params.set('street', street)
    if (address.number?.trim()) params.set('housenumber', address.number.trim())
    if (district) params.set('district', district)
    if (location.city) params.set('city', location.city)
    if (location.county) params.set('county', location.county)
    if (address.postalCode?.trim()) params.set('postcode', address.postalCode.trim())

    const expectedStreet = tokens(street ?? '')
    const matches = (features: PhotonFeature[]) => features.filter((feature) => {
      const properties = feature.properties ?? {}
      if (properties.countrycode && properties.countrycode.toLowerCase() !== 'id') return false
      if (district && properties.district && !this.samePlace(properties.district, district)) return false
      if (location.city && properties.city && !this.samePlace(properties.city, location.city)) return false
      if (location.county && properties.county && !this.samePlace(properties.county.replace(/^(?:kabupaten administrasi|kabupaten|kab)\s+/i, ''), location.county)) return false
      if (address.number && properties.housenumber) {
        const expectedNumber = tokens(address.number).join('')
        const actualNumber = tokens(properties.housenumber).join('')
        if (expectedNumber !== actualNumber && !matchesStreetToken(expectedNumber, [actualNumber])) return false
      }
      const actualStreet = tokens([properties.street, properties.name].filter(Boolean).join(' '))
      return expectedStreet.every((token) => matchesStreetToken(token, actualStreet))
    })
    const preferPostalCode = (features: PhotonFeature[]) => matches(features)
      .sort((left, right) => Number(right.properties?.postcode === address.postalCode) - Number(left.properties?.postcode === address.postalCode))[0]
    const structuredFeatures = await this.search('structured', params)
    let match = preferPostalCode(structuredFeatures)
    let textFeatures: PhotonFeature[] = []
    if (!match) {
      const query = [street, address.number && `No. ${address.number}`, address.subdistrict, district, address.city, address.province, address.postalCode, 'Indonesia'].filter(Boolean).join(', ')
      textFeatures = await this.search('api', new URLSearchParams({ q: query, countrycode: 'id', limit: '5' }))
      match = preferPostalCode(textFeatures)
    }
    if (match) return { coordinates: this.coordinates(match), provider: 'photon' }
    const anchor = expectedStreet.find((token) => token.length >= 4 && !['arteri', 'raya', 'kyai', 'haji'].includes(token))
    const approximate = [...structuredFeatures, ...textFeatures]
      .filter((feature) => {
        const properties = feature.properties ?? {}
        if (!anchor || !address.postalCode || properties.postcode !== address.postalCode || !district || !properties.district || !this.samePlace(properties.district, district)) return false
        if (properties.countrycode && properties.countrycode.toLowerCase() !== 'id') return false
        if (location.city && properties.city && !this.samePlace(properties.city, location.city)) return false
        if (address.number && properties.housenumber && tokens(address.number).join('') !== tokens(properties.housenumber).join('')) return false
        return tokens([properties.street, properties.name].filter(Boolean).join(' ')).some((token) => matchesStreetToken(anchor, [token]))
      })
      .sort((left, right) => {
        const exactHouseNumber = (feature: PhotonFeature) => Number(Boolean(address.number && feature.properties?.housenumber && tokens(address.number).join('') === tokens(feature.properties.housenumber).join('')))
        return exactHouseNumber(right) - exactHouseNumber(left)
      })[0]
    if (approximate) return { coordinates: this.coordinates(approximate), provider: 'photon', matchQuality: 'approximate', matchedStreet: approximate.properties?.street ?? approximate.properties?.name }
    const coordinates = await this.geocodeWithNominatim(address)
    if (coordinates) return { coordinates, provider: 'nominatim' }
    throw new BadGatewayException({ code: 'GEOCODING_NO_MATCH', message: 'Jalan tidak ditemukan pada Photon maupun OpenStreetMap. Periksa nama jalan atau kode pos.' })
  }

  private samePlace(actual: string, expected: string) {
    const clean = (value: string) => tokens(value.replace(/^(?:(?:kecamatan|kec\.?|kelurahan|kel\.?|kota administrasi|kota|kabupaten administrasi|kabupaten|kab)\s+)/i, ''))
    const left = clean(actual).join(' ')
    const right = clean(expected).join(' ')
    if (left === right) return true
    return right === 'jakarta' && left.includes('jakarta')
  }

  private async geocodeWithNominatim(address: StructuredAddress): Promise<[number, number] | null> {
    const street = canonicalStreet(address.street ?? '').trim()
    const expectedStreetTokens = tokens(street ?? '')
    const importantStreetTokens = expectedStreetTokens.filter((token) => token.length > 3 && token !== 'kyai' && token !== 'haji')
    if (!street || !importantStreetTokens.length) return null

    const location = geocoderCity(address.city)
    const city = location.city ?? location.county ?? address.city?.replace(/^(?:Kota Administrasi|Kota|Kabupaten Administrasi|Kabupaten|Kab)\s+/i, '')
    const queries = [...new Set([
      [street, address.subdistrict, address.district, city, address.province, address.postalCode, 'Indonesia'].filter(Boolean).join(', '),
      ...(city ? [[street, city, address.province, 'Indonesia'].filter(Boolean).join(', ')] : []),
    ])]

    const serviceUrl = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org/search'
    try {
      for (const query of queries) {
        const cacheKey = query.toLocaleLowerCase('id')
        const cached = this.nominatimCache.get(cacheKey)
        if (cached) return cached
        const url = new URL(serviceUrl)
        url.search = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', countrycodes: 'id', limit: '5' }).toString()
        const response = await this.fetchNominatim(url)
        if (!response.ok) throw new ServiceUnavailableException({ code: 'OSM_GEOCODING_UNAVAILABLE', message: 'Provider OpenStreetMap sedang tidak dapat memproses alamat.' })
        const features = await response.json() as NominatimFeature[]
        const match = features.find((feature) => {
          if (feature.country_code && feature.country_code.toLowerCase() !== 'id') return false
          const details = feature.address ?? {}
          const actualCity = details.city ?? details.town ?? details.county ?? details.municipality
          if (city && actualCity && !this.samePlace(actualCity, city)) return false
          const streetText = tokens(details.road ?? feature.name ?? feature.display_name ?? '')
          return expectedStreetTokens.every((token) => matchesStreetToken(token, streetText))
        })
        if (!match) continue
        const coordinates: [number, number] = [Number(match.lon), Number(match.lat)]
        if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) continue
        this.nominatimCache.set(cacheKey, coordinates)
        if (this.nominatimCache.size > 500) this.nominatimCache.delete(this.nominatimCache.keys().next().value!)
        return coordinates
      }
      return null
    } catch {
      throw new ServiceUnavailableException({ code: 'OSM_GEOCODING_UNAVAILABLE', message: 'Provider OpenStreetMap tidak dapat dihubungi.' })
    }
  }

  private coordinates(feature?: PhotonFeature): [number, number] {
    const coordinates = feature?.geometry?.coordinates
    const [longitude, latitude] = Array.isArray(coordinates) ? coordinates.map(Number) : []
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new BadGatewayException({ message: 'Alamat tidak ditemukan oleh provider geocoding.' })
    return [longitude, latitude]
  }
}
