import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common'
import { Database } from './database'

@Controller('regions')
export class RegionsController {
  constructor(@Inject(Database) private readonly db: Database) {}

  @Get('provinces')
  async provinces() {
    const { rows } = await this.db.query<{ code: string; name: string }>('SELECT code,btrim(name) AS name FROM indonesia_provinces ORDER BY name')
    return rows
  }

  @Get('cities')
  async cities(@Query('provinceCode') provinceCode?: string) {
    if (!provinceCode) throw new BadRequestException('Kode provinsi wajib diisi.')
    const { rows } = await this.db.query<{ code: string; name: string }>('SELECT code,btrim(name) AS name FROM indonesia_cities WHERE province_code=$1 ORDER BY name', [provinceCode])
    return rows
  }

  @Get('districts')
  async districts(@Query('cityCode') cityCode?: string) {
    if (!cityCode) throw new BadRequestException('Kode kabupaten/kota wajib diisi.')
    const { rows } = await this.db.query<{ code: string; name: string }>('SELECT code,btrim(name) AS name FROM indonesia_districts WHERE city_code=$1 ORDER BY name', [cityCode])
    return rows
  }

  @Get('subdistricts')
  async subdistricts(@Query('districtCode') districtCode?: string) {
    if (!districtCode) throw new BadRequestException('Kode kecamatan wajib diisi.')
    const { rows } = await this.db.query<{ code: string; name: string; postalCode: string }>(
      'SELECT code,btrim(name) AS name,postal_code AS "postalCode" FROM indonesia_subdistricts WHERE district_code=$1 ORDER BY name', [districtCode],
    )
    return rows
  }

  @Get('resolve')
  async resolve(
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('subdistrict') subdistrict?: string,
    @Query('postalCode') postalCode?: string,
    @Query('province') province?: string,
    @Query('cityCandidate') cityCandidate?: string | string[],
    @Query('districtCandidate') districtCandidate?: string | string[],
    @Query('subdistrictCandidate') subdistrictCandidate?: string | string[],
  ) {
    const normalize = (value: string) => value.trim().replace(/^(?:kota administrasi|kota|kabupaten administrasi|kabupaten|kab|kecamatan|kec\.?|kelurahan|kel\.?)\s+/i, '').toLocaleLowerCase('id')
    const names = (...values: Array<string | string[] | undefined>) => [...new Set(values.flatMap((value) => Array.isArray(value) ? value : value ? [value] : []).map(normalize).filter(Boolean))]
    const cityNames = names(city, cityCandidate)
    const districtNames = names(district, districtCandidate)
    const subdistrictNames = names(subdistrict, subdistrictCandidate).filter((value) => !/^(?:rt|rw)\s*\d/i.test(value))
    const provinceName = province?.trim().replace(/^(?:provinsi)\s+/i, '') ?? ''
    if (!cityNames.length) return null
    const postal = postalCode?.trim() ?? ''
    const attempts = [
      [districtNames, subdistrictNames, postal],
      [districtNames, subdistrictNames, ''],
      [districtNames, [], postal],
      [districtNames, [], ''],
      [[], subdistrictNames, postal],
      [[], subdistrictNames, ''],
      [[], [], postal],
      [[], [], ''],
    ] as const
    const seen = new Set<string>()
    for (const [districtFilter, subdistrictFilter, postalFilter] of attempts) {
      const key = [districtFilter.join(','), subdistrictFilter.join(','), postalFilter].join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const { rows } = await this.db.query<{ provinceCode: string; cityCode: string; districtCode: string; subdistrictCode: string; postalCode: string }>(
        `SELECT p.code AS "provinceCode", c.code AS "cityCode", d.code AS "districtCode", s.code AS "subdistrictCode", s.postal_code AS "postalCode"
         FROM indonesia_provinces p
         JOIN indonesia_cities c ON c.province_code=p.code
         JOIN indonesia_districts d ON d.city_code=c.code
         JOIN indonesia_subdistricts s ON s.district_code=d.code
         WHERE btrim(regexp_replace(lower(c.name), '^(kota administrasi|kota|kabupaten administrasi|kabupaten|kab)\\s+', '')) = ANY($1::text[])
           AND (cardinality($2::text[]) = 0 OR btrim(lower(d.name)) = ANY($2::text[]))
           AND (cardinality($3::text[]) = 0 OR btrim(lower(s.name)) = ANY($3::text[]))
           AND ($4 = '' OR s.postal_code = $4)
           AND ($5 = '' OR btrim(lower(p.name)) = lower($5))
         LIMIT 1000`, [cityNames, districtFilter, subdistrictFilter, postalFilter, provinceName],
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
