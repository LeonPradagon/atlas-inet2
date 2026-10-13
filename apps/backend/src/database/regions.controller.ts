import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common'
import { Database } from './database'

@Controller('regions')
export class RegionsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('provinces')
  async provinces() {
    const { rows } = await this.db.query<{ code: string; name: string }>('SELECT code,name FROM indonesia_provinces ORDER BY name')
    return rows
  }

  @Get('cities')
  async cities(@Query('provinceCode') provinceCode?: string) {
    if (!provinceCode) throw new BadRequestException('Kode provinsi wajib diisi.')
    const { rows } = await this.db.query<{ code: string; name: string }>('SELECT code,name FROM indonesia_cities WHERE province_code=$1 ORDER BY name', [provinceCode])
    return rows
  }

  @Get('districts')
  async districts(@Query('cityCode') cityCode?: string) {
    if (!cityCode) throw new BadRequestException('Kode kabupaten/kota wajib diisi.')
    const { rows } = await this.db.query<{ code: string; name: string }>('SELECT code,name FROM indonesia_districts WHERE city_code=$1 ORDER BY name', [cityCode])
    return rows
  }

  @Get('subdistricts')
  async subdistricts(@Query('districtCode') districtCode?: string) {
    if (!districtCode) throw new BadRequestException('Kode kecamatan wajib diisi.')
    const { rows } = await this.db.query<{ code: string; name: string; postalCode: string }>(
      'SELECT code,name,postal_code AS "postalCode" FROM indonesia_subdistricts WHERE district_code=$1 ORDER BY name', [districtCode],
    )
    return rows
  }
}
