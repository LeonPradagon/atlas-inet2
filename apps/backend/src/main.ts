import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { toNodeHandler } from 'better-auth/node'
import { Pool } from 'pg'
import { migrateDatabase } from './database/migration-runner'

async function bootstrap() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try { await migrateDatabase(pool) }
  finally { await pool.end() }
  const [{ AppModule }, { auth }] = await Promise.all([import('./app.module'), import('./auth/auth')])
  // FTTH draft payloads contain many routed coordinates; Nest's default JSON
  // parser limit (100 KB) rejects them before the controller can handle them.
  const app = await NestFactory.create(AppModule, { bodyParser: false })
  const expressAdapter = app.getHttpAdapter() as unknown as { useBodyParser: (type: 'json' | 'urlencoded', rawBody: boolean, options: Record<string, unknown>) => void }
  expressAdapter.useBodyParser('json', false, { limit: '20mb' })
  expressAdapter.useBodyParser('urlencoded', false, { extended: true, limit: '20mb' })
  const express = app.getHttpAdapter().getInstance()
  express.disable('x-powered-by')
  app.use((_request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: (error?: unknown) => void) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    next()
  })
  app.setGlobalPrefix('api')
  const authHandler = toNodeHandler(auth)
  app.getHttpAdapter().getInstance().use('/api/auth', (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: (error?: unknown) => void) => {
    void authHandler(request, response).catch(next)
  })
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0')
}

void bootstrap()
