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

  @Get('resolve')
  async resolve(@Query('city') city?: string, @Query('district') district?: string, @Query('subdistrict') subdistrict?: string, @Query('postalCode') postalCode?: string, @Query('province') province?: string, @Query('street') street?: string) {
    const normalize = (value?: string) => value?.trim().replace(/^(?:kota administrasi|kota|kabupaten administrasi|kabupaten|kab|kecamatan|kec\.?|kelurahan|kel\.?)\s+/i, '').replace(/^west jakarta$/i, 'Jakarta Barat').replace(/^central jakarta$/i, 'Jakarta Pusat').replace(/^south jakarta$/i, 'Jakarta Selatan').replace(/^east jakarta$/i, 'Jakarta Timur').replace(/^north jakarta$/i, 'Jakarta Utara') ?? ''
    const cityName = normalize(city)
    const districtName = normalize(district)
    const subdistrictName = normalize(subdistrict)
    const provinceName = province?.trim().replace(/^(?:provinsi)\s+/i, '') ?? ''
    const streetKey = normalize(street).toLocaleLowerCase('id').replace(/\b(?:jalan|jln|jl)\.?\s*/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    // Photon places Jalan Tiang Bendera V in RW 03 and reports the wrong postal code (11240).
    // The street is in Roa Malaka; prefer this verified street mapping over the postal-code guess.
    const knownSubdistrict = streetKey === 'tiang bendera v' ? 'Roa Malaka' : ''
    if (!cityName) return null
    const postal = postalCode?.trim() ?? ''
    const attempts = [
      ...(knownSubdistrict ? [[districtName, knownSubdistrict, ''] as const] : []),
      [districtName, subdistrictName, postal],
      [districtName, subdistrictName, ''],
      [districtName, '', postal],
      [districtName, '', ''],
      ['', subdistrictName, postal],
      ['', subdistrictName, ''],
      ['', '', postal],
      ['', '', ''],
    ] as const
    const seen = new Set<string>()
    for (const [districtFilter, subdistrictFilter, postalFilter] of attempts) {
      const key = [districtFilter, subdistrictFilter, postalFilter].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const { rows } = await this.db.query<{ provinceCode: string; cityCode: string; districtCode: string; subdistrictCode: string; postalCode: string }>(
        `SELECT p.code AS "provinceCode", c.code AS "cityCode", d.code AS "districtCode", s.code AS "subdistrictCode", s.postal_code AS "postalCode"
         FROM indonesia_provinces p
         JOIN indonesia_cities c ON c.province_code=p.code
         JOIN indonesia_districts d ON d.city_code=c.code
         JOIN indonesia_subdistricts s ON s.district_code=d.code
         WHERE (regexp_replace(lower(c.name), '^(kota administrasi|kota|kabupaten administrasi|kabupaten|kab)\\s+', '') = lower($1)
                OR (lower($1) = 'jakarta' AND regexp_replace(lower(c.name), '^(kota administrasi|kota|kabupaten administrasi|kabupaten|kab)\\s+', '') LIKE 'jakarta %'))
           AND ($2 = '' OR lower(d.name) = lower($2))
           AND ($3 = '' OR lower(s.name) = lower($3))
           AND ($4 = '' OR s.postal_code = $4)
           AND ($5 = '' OR lower(p.name) = lower($5) OR (lower(p.name) = 'daerah khusus ibukota jakarta' AND (lower($5) IN ('jakarta', 'dki jakarta') OR lower($1) = 'jakarta')))
         LIMIT 1000`, [cityName, districtFilter, subdistrictFilter, postalFilter, provinceName],
      )
      if (!rows.length) continue
      const common = (field: keyof typeof rows[number]) => new Set(rows.map((row) => row[field])).size === 1 ? rows[0][field] : null
      const provinceCode = common('provinceCode')
      const cityCode = common('cityCode')
      if (provinceCode && cityCode) return { provinceCode, cityCode, districtCode: common('districtCode'), subdistrictCode: common('subdistrictCode'), postalCode: common('postalCode') }
    }
    return null
  }
}
