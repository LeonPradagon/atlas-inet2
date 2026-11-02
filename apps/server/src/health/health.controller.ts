import { Controller, Get, Inject } from '@nestjs/common'
import { Database } from '../database/database'
import { GeocodingService } from '../geospatial/geocoding.service'
import { RoutingService } from '../geospatial/routing.service'

@Controller()
export class HealthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(GeocodingService) private readonly geocoding: GeocodingService,
    @Inject(RoutingService) private readonly routing: RoutingService,
  ) {}

  @Get('health')
  async health() {
    let database: 'ok' | 'unavailable' = 'ok'
    try { await this.db.query('SELECT 1') } catch { database = 'unavailable' }
    const photon = await this.geocoding.photonStatus()
    const routing = await this.routing.status()
    return { status: database === 'ok' && photon.status === 'ok' && routing === 'ok' ? 'ok' : 'degraded', database, photon, routing }
  }
}
