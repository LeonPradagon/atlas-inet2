import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { toNodeHandler } from 'better-auth/node'
import { fromNodeHeaders } from 'better-auth/node'
import { Pool } from 'pg'
import { migrateDatabase } from './database/migration-runner'
import { AtlasService } from './atlas/atlas.service'

async function bootstrap() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try { await migrateDatabase(pool) }
  finally { await pool.end() }
  const [{ AppModule }, { auth, recordFailedLogin }] = await Promise.all([import('./app.module'), import('./auth/auth')])
  // FTTH draft payloads contain many routed coordinates; Nest's default JSON
  // parser limit (100 KB) rejects them before the controller can handle them.
  const app = await NestFactory.create(AppModule, { bodyParser: false })
  const expressAdapter = app.getHttpAdapter() as unknown as { useBodyParser: (type: 'json' | 'urlencoded', rawBody: boolean, options: Record<string, unknown>) => void }
  expressAdapter.useBodyParser('json', false, { limit: '20mb' })
  expressAdapter.useBodyParser('urlencoded', false, { extended: true, limit: '20mb' })
  const express = app.getHttpAdapter().getInstance()
  const atlas = app.get(AtlasService)
  express.disable('x-powered-by')
  app.use((_request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: (error?: unknown) => void) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    next()
  })
  express.use('/api', (request: import('node:http').IncomingMessage & { originalUrl?: string }, response: import('node:http').ServerResponse, next: (error?: unknown) => void) => {
    const path = (request.originalUrl ?? request.url ?? '/').replace(/^\/api(?=\/|$)/, '').split('?')[0]
    if (path === '/health' || path === '/audit-trails' || path === '/auth/sign-in/email' || path === '/auth/sign-out') return next()
    const method = request.method ?? 'GET'
    const startedAt = Date.now()
    const session = auth.api.getSession({ headers: fromNodeHeaders(request.headers) }).catch(() => null)
    response.on('finish', () => {
      void session.then((current) => atlas.recordApiRequest(current?.user.id ?? null,method,path,response.statusCode,Date.now() - startedAt))
        .catch((error) => console.error('API activity audit failed', error))
    })
    next()
  })
  app.setGlobalPrefix('api')
  const authHandler = toNodeHandler(auth)
  app.getHttpAdapter().getInstance().use('/api/auth', (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, next: (error?: unknown) => void) => {
    if (request.method === 'POST' && request.url?.split('?')[0] === '/sign-in/email') {
      response.on('finish', () => {
        if (response.statusCode >= 400) void recordFailedLogin(response.statusCode).catch((error) => console.error('Failed login audit failed', error))
      })
    }
    void authHandler(request, response).catch(next)
  })
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0')
}

void bootstrap()
