import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common'

export type Coordinate = [longitude: number, latitude: number]

type GraphHopperResponse = { paths?: { distance: number; time: number; points: { type: 'LineString'; coordinates: Coordinate[] }; details?: { road_class?: [number, number, string][] } }[] }

@Injectable()
export class RoutingService {
  async status(): Promise<'ok' | 'unavailable'> {
    const baseUrl = process.env.ROUTING_URL
    if (!baseUrl) return 'unavailable'
    try {
      const response = await fetch(new URL('info', `${baseUrl.replace(/\/$/, '')}/`), { signal: AbortSignal.timeout(3_000) })
      return response.ok ? 'ok' : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async preview(coordinates: Coordinate[]) {
    return this.route(coordinates, process.env.ROUTING_PROFILE ?? 'car')
  }

  async previewNetwork(coordinates: Coordinate[]) {
    return this.route(coordinates, 'car')
  }

  async previewFtth(coordinates: Coordinate[]) {
    const profiles = [...new Set([process.env.ROUTING_PROFILE ?? 'car', process.env.FTTH_ROUTING_PROFILE ?? 'bike', 'foot'])]
    const routes = await Promise.allSettled(profiles.map((profile) => this.route(coordinates, profile)))
    const available = routes.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    if (!available.length) throw routes.find((result) => result.status === 'rejected')?.reason
    return available.reduce((shortest, route) => route.distanceMeters < shortest.distanceMeters ? route : shortest)
  }

  private async route(coordinates: Coordinate[], profile: string) {
    const baseUrl = process.env.ROUTING_URL
    if (!baseUrl) throw new ServiceUnavailableException({ code: 'ROUTING_UNAVAILABLE', message: 'Provider routing belum dikonfigurasi. Ekstrak data jalan belum diaktifkan.' })
    const query = new URLSearchParams()
    for (const [longitude, latitude] of coordinates) query.append('point', `${latitude},${longitude}`)
    query.set('profile', profile)
    query.set('points_encoded', 'false')
    query.append('details', 'road_class')
    if (profile === 'bike' || profile === 'foot') query.set('ch.disable', 'true')
    let response: Response
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/route?${query}`, { signal: AbortSignal.timeout(20_000) })
    } catch {
      throw new ServiceUnavailableException({ code: 'ROUTING_UNAVAILABLE', message: 'Layanan GraphHopper tidak dapat dihubungi.' })
    }
    if (!response.ok) throw new BadGatewayException({ message: 'GraphHopper tidak menemukan rute pada cakupan data jalan yang tersedia.' })
    let result: GraphHopperResponse
    try {
      result = await response.json() as GraphHopperResponse
    } catch {
      throw new BadGatewayException({ message: 'Respons GraphHopper tidak valid.' })
    }
    const route = result.paths?.[0]
    if (!route?.points?.coordinates?.length) {
      throw new BadGatewayException({ message: 'Tidak ditemukan jalur jalan yang menghubungkan titik-titik tersebut. Pastikan semua titik berada di Pulau Jawa dan terhubung ke jalan pada data OSM.' })
    }
    const roadClasses: (string | null)[] = Array(Math.max(0, route.points.coordinates.length - 1)).fill(null)
    for (const [from, to, roadClass] of route.details?.road_class ?? []) {
      for (let index = from; index < to && index < roadClasses.length; index++) roadClasses[index] = roadClass
    }
    return { geometry: route.points, roadClasses, distanceMeters: route.distance, durationSeconds: route.time / 1000 }
  }
}
