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
  const app = await NestFactory.create(AppModule)
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
