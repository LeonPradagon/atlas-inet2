import { Controller, Get, Inject } from '@nestjs/common'
import { Database } from '../database/database'
import { GeocodingService } from '../geospatial/geocoding.service'

@Controller()
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(GeocodingService) private readonly geocoding: GeocodingService) {}

  @Get('health')
  async health() {
    let database: 'ok' | 'unavailable' = 'ok'
    try { await this.db.query('SELECT 1') } catch { database = 'unavailable' }
    const photon = await this.geocoding.photonStatus()
    return { status: database === 'ok' && photon.status === 'ok' ? 'ok' : 'degraded', database, photon }
  }
}
