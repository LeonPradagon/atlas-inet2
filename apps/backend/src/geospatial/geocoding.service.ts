import { Injectable, ServiceUnavailableException, BadGatewayException } from '@nestjs/common'

@Injectable()
export class GeocodingService {
  async geocode(address: string): Promise<[number, number]> {
    const baseUrl = process.env.GEOCODER_URL
    if (!baseUrl) throw new ServiceUnavailableException({ code: 'GEOCODING_UNAVAILABLE', message: 'Provider geocoding belum dikonfigurasi. Data alamat belum dianalisis.' })
    const url = new URL('api', `${baseUrl.replace(/\/$/, '')}/`)
    url.search = new URLSearchParams({ q: address, limit: '1' }).toString()
    let response: Response
    try { response = await fetch(url, { headers: { 'User-Agent': 'ATLAS-INET/1.0' }, signal: AbortSignal.timeout(15_000) }) }
    catch { throw new ServiceUnavailableException({ code: 'GEOCODING_UNAVAILABLE', message: 'Layanan geocoding tidak dapat dihubungi.' }) }
    if (!response.ok) throw new BadGatewayException({ message: 'Layanan geocoding gagal memproses alamat.' })
    let result: { features?: { geometry?: { coordinates?: unknown } }[] }
    try { result = await response.json() as typeof result }
    catch { throw new BadGatewayException({ message: 'Respons Photon tidak valid.' }) }
    const coordinates = result.features?.[0]?.geometry?.coordinates
    const [longitude, latitude] = Array.isArray(coordinates) ? coordinates.map(Number) : []
    if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude) || Math.abs(latitude) > 90) throw new BadGatewayException({ message: 'Alamat tidak ditemukan oleh provider geocoding.' })
    return [longitude, latitude]
  }
}
