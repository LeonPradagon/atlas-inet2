import { Pool } from 'pg'

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
  if (!email || !password || password.length < 12) throw new Error('Isi BOOTSTRAP_ADMIN_EMAIL dan BOOTSTRAP_ADMIN_PASSWORD (minimal 12 karakter) di file .env root, lalu jalankan ulang.')
  const { adminAuth } = await import('./auth')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    if ((await pool.query('SELECT id FROM "user" WHERE email=$1', [email])).rowCount) throw new Error(`User ${email} already exists.`)
    await adminAuth.api.signUpEmail({ body: { name: process.env.BOOTSTRAP_ADMIN_NAME ?? 'ATLAS Admin', email, password } })
    await pool.query('UPDATE "user" SET role=$1 WHERE email=$2', ['ADMIN', email])
    console.log(`Admin account created: ${email}`)
  } finally { await pool.end() }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Admin bootstrap gagal.')
  process.exitCode = 1
})
