import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Pool, PoolClient } from 'pg'

type RegionProvince = { code: string; name: string; cities: { code: string; name: string; districts: { code: string; name: string }[] }[] }
type RegionSubdistricts = Record<string, [string, string, string][]>

async function seedIndonesiaRegions(client: PoolClient) {
  const dataDir = resolve(process.cwd(), 'src/database/regions')
  const provinces = JSON.parse(await readFile(resolve(dataDir, 'provinces.json'), 'utf8')) as RegionProvince[]
  const cities = provinces.flatMap((province) => province.cities.map((city) => ({ ...city, provinceCode: province.code })))
  const districts = cities.flatMap((city) => city.districts.map((district) => ({ ...district, cityCode: city.code })))
  const districtByCode = new Map(districts.map((district) => [district.code, district]))
  const subdistricts: { code: string; districtCode: string; name: string; postalCode: string }[] = []

  for (const city of cities) {
    const entries = JSON.parse(await readFile(resolve(dataDir, 'subdistricts', `${city.code}.json`), 'utf8')) as RegionSubdistricts
    for (const [districtCode, rows] of Object.entries(entries)) {
      if (!districtByCode.has(districtCode)) throw new Error(`Unknown district in region data: ${districtCode}`)
      for (const [code, name, postalCode] of rows) subdistricts.push({ code, districtCode, name, postalCode })
    }
  }
  if (provinces.length !== 38 || cities.length !== 514 || districts.length !== 7285 || subdistricts.length !== 83762) {
    throw new Error('Indonesia region data failed integrity checks.')
  }

  await client.query(
    `INSERT INTO indonesia_provinces(code,name)
     SELECT code,name FROM jsonb_to_recordset($1::jsonb) AS x(code text,name text)
     ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name`,
    [JSON.stringify(provinces.map(({ code, name }) => ({ code, name })))],
  )
  await client.query(
    `INSERT INTO indonesia_cities(code,province_code,name)
     SELECT code,"provinceCode",name FROM jsonb_to_recordset($1::jsonb) AS x(code text,"provinceCode" text,name text)
     ON CONFLICT(code) DO UPDATE SET province_code=EXCLUDED.province_code,name=EXCLUDED.name`,
    [JSON.stringify(cities.map(({ code, name, provinceCode }) => ({ code, name, provinceCode })))],
  )
  await client.query(
    `INSERT INTO indonesia_districts(code,city_code,name)
     SELECT code,"cityCode",name FROM jsonb_to_recordset($1::jsonb) AS x(code text,"cityCode" text,name text)
     ON CONFLICT(code) DO UPDATE SET city_code=EXCLUDED.city_code,name=EXCLUDED.name`,
    [JSON.stringify(districts.map(({ code, name, cityCode }) => ({ code, name, cityCode })))],
  )
  await client.query(
    `INSERT INTO indonesia_subdistricts(code,district_code,name,postal_code)
     SELECT code,"districtCode",name,"postalCode" FROM jsonb_to_recordset($1::jsonb) AS x(code text,"districtCode" text,name text,"postalCode" text)
     ON CONFLICT(code) DO UPDATE SET district_code=EXCLUDED.district_code,name=EXCLUDED.name,postal_code=EXCLUDED.postal_code`,
    [JSON.stringify(subdistricts)],
  )
}

export async function migrateDatabase(pool: Pool) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const directory = resolve(process.cwd(), 'src/database/migrations')
  const migrations = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  for (const name of migrations) {
    const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])
    if (rowCount) continue
    const sql = await readFile(resolve(directory, name), 'utf8')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(sql)
      if (name === '002-indonesia-regions.sql') await seedIndonesiaRegions(client)
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
