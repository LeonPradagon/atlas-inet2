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
  properties?: { name?: string; street?: string; housenumber?: string; district?: string; city?: string; county?: string; postcode?: string; countrycode?: string }
  geometry?: { coordinates?: unknown }
}
type NominatimFeature = { lat: string; lon: string; name?: string; display_name?: string; address?: Record<string, string>; country_code?: string }

function tokens(value: string) {
  return value.toLocaleLowerCase('id')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(?:jln|jl)\b/g, 'jalan')
    .replace(/\b(?:k\s+h|kh)\b/g, 'kyai haji')
    .replace(/\bky\b/g, 'kyai')
    .replace(/\bpal merah\b/g, 'palmerah')
    .split(/\s+/).filter((token) => token && token !== 'jalan' && token !== 'no')
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

  private async search(path: 'api' | 'structured', params: URLSearchParams): Promise<PhotonFeature[]> {
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

  async geocodeStructured(address: StructuredAddress): Promise<{ coordinates: [number, number]; provider: 'photon' | 'nominatim' }> {
    const params = new URLSearchParams({ countrycode: 'id', limit: '5' })
    const street = address.street?.trim()
    const district = address.district?.trim()
    const location = geocoderCity(address.city)
    if (street) params.set('street', street)
    if (address.number?.trim()) params.set('housenumber', address.number.trim())
    if (district) params.set('district', district)
    if (location.city) params.set('city', location.city)
    if (location.county) params.set('county', location.county)
    if (address.postalCode?.trim()) params.set('postcode', address.postalCode.trim())

    const expectedStreet = tokens(street ?? '')
    const matches = (features: PhotonFeature[]) => features.find((feature) => {
      const properties = feature.properties ?? {}
      if (properties.countrycode && properties.countrycode.toLowerCase() !== 'id') return false
      if (district && properties.district && !this.samePlace(properties.district, district)) return false
      if (location.city && properties.city && !this.samePlace(properties.city, location.city)) return false
      if (location.county && properties.county && !this.samePlace(properties.county.replace(/^(?:kabupaten administrasi|kabupaten|kab)\s+/i, ''), location.county)) return false
      if (address.postalCode && properties.postcode && properties.postcode !== address.postalCode) return false
      if (address.number && properties.housenumber) {
        const expectedNumber = tokens(address.number).join('')
        const actualNumber = tokens(properties.housenumber).join('')
        if (expectedNumber !== actualNumber && !matchesStreetToken(expectedNumber, [actualNumber])) return false
      }
      const actualStreet = tokens(properties.street ?? properties.name ?? '')
      return expectedStreet.every((token) => matchesStreetToken(token, actualStreet))
    })
    let match = matches(await this.search('structured', params))
    if (!match) {
      const query = [street, address.number && `No. ${address.number}`, address.subdistrict, district, address.city, address.province, address.postalCode, 'Indonesia'].filter(Boolean).join(', ')
      match = matches(await this.search('api', new URLSearchParams({ q: query, countrycode: 'id', limit: '5' })))
    }
    if (match) return { coordinates: this.coordinates(match), provider: 'photon' }
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
    const street = address.street?.trim()
    const expectedStreetTokens = tokens(street ?? '')
    const importantStreetTokens = expectedStreetTokens.filter((token) => token.length > 3 && token !== 'kyai' && token !== 'haji')
    if (!street || !importantStreetTokens.length) return null

    const canonicalStreet = street
      .replace(/^(?:jln|jl)\.?\s*/i, 'Jalan ')
      .replace(/\bky\b/gi, 'Kyai')
    const query = [
      canonicalStreet,
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
        if (address.postalCode && details.postcode && details.postcode.replace(/\s/g, '') !== address.postalCode.replace(/\s/g, '')) return false
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
