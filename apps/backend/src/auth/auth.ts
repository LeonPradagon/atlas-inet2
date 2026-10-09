import { betterAuth } from 'better-auth'
import { kyselyAdapter } from '@better-auth/kysely-adapter'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const database = new Kysely({ dialect: new PostgresDialect({ pool }) })
const production = process.env.NODE_ENV === 'production'
const secret = process.env.BETTER_AUTH_SECRET
if (production && (!secret || secret.length < 32)) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters in production.')

export const createAuth = (disableSignUp: boolean) => betterAuth({
  database: kyselyAdapter(database, { type: 'postgres' }),
  secret: secret || 'development-only-change-me-at-least-32-characters',
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? 'http://localhost:5176,http://localhost:3000').split(',').map((origin) => origin.trim()).filter(Boolean),
  useSecureCookies: production,
  rateLimit: { enabled: true, window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 5 } } },
  emailAndPassword: { enabled: true, disableSignUp },
  user: { additionalFields: { role: { type: 'string', required: false, defaultValue: 'PRESALES', input: false } } },
})

export const auth = createAuth(true)
export const adminAuth = createAuth(false)
