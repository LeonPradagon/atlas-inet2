import { Injectable, ServiceUnavailableException, BadGatewayException } from '@nestjs/common'

export type StructuredAddress = {
  street?: string
  number?: string
  subdistrict?: string
  district?: string
  city?: string
  province?: string
  postalCode?: string
}

type PhotonFeature = {
  properties?: { name?: string; street?: string; housenumber?: string; locality?: string; district?: string; city?: string; county?: string; state?: string; postcode?: string; countrycode?: string; type?: string; osm_type?: string; osm_id?: number }
  geometry?: { coordinates?: unknown }
}
export type AddressSuggestion = { id: string; label: string; longitude: number; latitude: number; street?: string; number?: string; subdistrict?: string; district?: string; city?: string; province?: string; postalCode?: string; matchQuality: 'approximate' }
type NominatimFeature = { lat: string; lon: string; name?: string; display_name?: string; address?: Record<string, string>; country_code?: string }

function tokens(value: string) {
  return canonicalStreet(value).toLocaleLowerCase('id')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(?:k\s+h|kh)\b/g, 'kyai haji')
    .replace(/\bpal merah\b/g, 'palmerah')
    .split(/\s+/).filter((token) => token && token !== 'jalan' && token !== 'no')
}

function canonicalStreet(value: string) {
  return value
    .replace(/^\s*(?:jln|jl)\.?\s*/i, 'Jalan ')
    .replace(/\bk\s*\.?\s*h\.?\s*/gi, 'Kyai Haji ')
    .replace(/\bkh\.?\s*/gi, 'Kyai Haji ')
    .replace(/\bhj\.?\s*/gi, 'Hajjah ')
    .replace(/\bh\.?\s+(?=[\p{L}])/giu, 'Haji ')
    .replace(/\br\s*\.?\s*a\.?\s*/gi, 'Raden Ajeng ')
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
    const streetNeedles = tokens(normalizedQuery.replace(/\s+(?:no(?:mor)?\.?\s*)?\d+[a-z]?$/i, ''))
      .filter((token) => !['kyai', 'haji', 'jalan', 'gang', 'kampung', 'raya', 'arteri', 'utama'].includes(token))
    const matchesRequestedStreet = (feature: PhotonFeature) => {
      const properties = feature.properties ?? {}
      const actualStreet = tokens(properties.street ?? '')
      const actualName = tokens(properties.name ?? '')
      const matches = (actual: string[]) => streetNeedles.every((token) => matchesStreetToken(token, actual))
      return !streetNeedles.length || matches(actualStreet) || matches(actualName)
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
    const features = await this.search('reverse', new URLSearchParams({ lon: String(longitude), lat: String(latitude), limit: '1' }))
    const properties = features[0]?.properties
    if (!properties) return null
    return {
      subdistrict: properties.locality,
      district: properties.district,
      city: properties.city ?? properties.county,
      province: properties.state,
      postalCode: properties.postcode,
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

    const query = [
      street,
      address.subdistrict, address.district,
      address.city?.replace(/^(?:Kota Administrasi|Kota|Kabupaten Administrasi|Kabupaten|Kab)\s+/i, ''),
      address.province, address.postalCode, 'Indonesia',
    ].filter(Boolean).join(', ')
    const cacheKey = query.toLocaleLowerCase('id')
    const cached = this.nominatimCache.get(cacheKey)
    if (cached) return cached

    const serviceUrl = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org/search'
    const url = new URL(serviceUrl)
    url.search = new URLSearchParams({ q: query, format: 'jsonv2', addressdetails: '1', countrycodes: 'id', limit: '5' }).toString()
    let release!: () => void
    const previous = this.nominatimQueue
    this.nominatimQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      const delay = Math.max(0, 1000 - (Date.now() - this.nominatimLastRequest))
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
      this.nominatimLastRequest = Date.now()
      const response = await fetch(url, { headers: { 'User-Agent': 'ATLAS-INET/1.0 (address network analysis)' }, signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new ServiceUnavailableException({ code: 'OSM_GEOCODING_UNAVAILABLE', message: 'Provider OpenStreetMap sedang tidak dapat memproses alamat.' })
      const features = await response.json() as NominatimFeature[]
      const match = features.find((feature) => {
        if (feature.country_code && feature.country_code.toLowerCase() !== 'id') return false
        const details = feature.address ?? {}
        const streetText = tokens([feature.name, feature.display_name, details.road].filter(Boolean).join(' '))
        return expectedStreetTokens.every((token) => matchesStreetToken(token, streetText))
      })
      if (!match) return null
      const coordinates: [number, number] = [Number(match.lon), Number(match.lat)]
      if (!coordinates.every(Number.isFinite) || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90) return null
      this.nominatimCache.set(cacheKey, coordinates)
      if (this.nominatimCache.size > 500) this.nominatimCache.delete(this.nominatimCache.keys().next().value!)
      return coordinates
    } catch {
      throw new ServiceUnavailableException({ code: 'OSM_GEOCODING_UNAVAILABLE', message: 'Provider OpenStreetMap tidak dapat dihubungi.' })
    } finally {
      release()
    }
  }

  private coordinates(feature?: PhotonFeature): [number, number] {
    const coordinates = feature?.geometry?.coordinates
    const [longitude, latitude] = Array.isArray(coordinates) ? coordinates.map(Number) : []
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new BadGatewayException({ message: 'Alamat tidak ditemukan oleh provider geocoding.' })
    return [longitude, latitude]
  }
}
