import { Injectable, ServiceUnavailableException, BadGatewayException } from '@nestjs/common'

@Injectable()
export class GeocodingService {
  async geocode(address: string): Promise<[number, number]> {
    const baseUrl = process.env.GEOCODER_URL
    if (!baseUrl) throw new ServiceUnavailableException({ code: 'GEOCODING_UNAVAILABLE', message: 'Provider geocoding belum dikonfigurasi. Data alamat belum dianalisis.' })
    const url = new URL('/search', baseUrl)
    url.search = new URLSearchParams({ q: address, format: 'jsonv2', limit: '1' }).toString()
    let response: Response
    try { response = await fetch(url, { headers: { 'User-Agent': 'ATLAS-INET/1.0' }, signal: AbortSignal.timeout(15_000) }) }
    catch { throw new ServiceUnavailableException({ code: 'GEOCODING_UNAVAILABLE', message: 'Layanan geocoding tidak dapat dihubungi.' }) }
    if (!response.ok) throw new BadGatewayException({ message: 'Layanan geocoding gagal memproses alamat.' })
    const rows = await response.json() as { lon?: string; lat?: string }[]
    const longitude = Number(rows[0]?.lon), latitude = Number(rows[0]?.lat)
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new BadGatewayException({ message: 'Alamat tidak ditemukan oleh provider geocoding.' })
    return [longitude, latitude]
  }
}
