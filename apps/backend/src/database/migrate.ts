import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { resolve } from 'node:path'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const sql = await readFile(resolve(process.cwd(), 'src/database/migrations/001-initial.sql'), 'utf8')
    await pool.query(sql)
    console.log('ATLAS database schema is ready.')
  } finally {
    await pool.end()
  }
}

void main()
