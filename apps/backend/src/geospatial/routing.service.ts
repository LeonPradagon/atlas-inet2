import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common'

export type Coordinate = [longitude: number, latitude: number]

type GraphHopperResponse = { paths?: { distance: number; time: number; points: { type: 'LineString'; coordinates: Coordinate[] } }[] }

@Injectable()
export class RoutingService {
  async preview(coordinates: Coordinate[]) {
    const baseUrl = process.env.ROUTING_URL
    if (!baseUrl) throw new ServiceUnavailableException({ code: 'ROUTING_UNAVAILABLE', message: 'Provider routing belum dikonfigurasi. Ekstrak data jalan belum diaktifkan.' })
    const query = new URLSearchParams()
    for (const [longitude, latitude] of coordinates) query.append('point', `${latitude},${longitude}`)
    query.set('profile', process.env.ROUTING_PROFILE ?? 'car')
    query.set('points_encoded', 'false')
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/route?${query}`, { signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new ServiceUnavailableException({ code: 'ROUTING_UNAVAILABLE', message: 'Layanan GraphHopper tidak dapat dihubungi.' })
    }
    if (!response.ok) throw new BadGatewayException({ message: 'Layanan GraphHopper gagal menghitung rute.' })
    let result: GraphHopperResponse
    try {
      result = await response.json() as GraphHopperResponse
    } catch {
      throw new BadGatewayException({ message: 'Respons GraphHopper tidak valid.' })
    }
    const route = result.paths?.[0]
    if (!route?.points?.coordinates?.length) {
      throw new BadGatewayException({ message: 'Tidak ditemukan jalur jalan yang menghubungkan titik-titik tersebut.' })
    }
    return { geometry: route.points, distanceMeters: route.distance, durationSeconds: route.time / 1000 }
  }
}
