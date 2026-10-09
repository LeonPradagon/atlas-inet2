import { Controller, Get, Inject } from '@nestjs/common'
import { Database } from '../database/database'

@Controller()
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('health')
  async health() {
    try { await this.db.query('SELECT 1'); return { status: 'ok', database: 'ok' } }
    catch { return { status: 'degraded', database: 'unavailable' } }
  }
}
