import { Pool } from 'pg'
import { migrateDatabase } from './migration-runner'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await migrateDatabase(pool)
    console.log('ATLAS database migrations are ready.')
  } finally {
    await pool.end()
  }
}

void main()
