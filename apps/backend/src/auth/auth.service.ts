import { BadRequestException, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { fromNodeHeaders } from 'better-auth/node'
import type { IncomingMessage } from 'node:http'
import { adminAuth, auth } from './auth'
import { Database } from '../database/database'

@Injectable()
export class AuthService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async session(request: IncomingMessage) {
    return auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
  }

  async requireUser(request: IncomingMessage) {
    const session = await this.session(request)
    if (!session) throw new UnauthorizedException({ message: 'Silakan masuk untuk melanjutkan.' })
    return session.user as typeof session.user & { role?: 'ADMIN' | 'PRESALES' }
  }

  async requireAdmin(request: IncomingMessage) {
    const user = await this.requireUser(request)
    if (user.role !== 'ADMIN') throw new ForbiddenException({ message: 'Akses ini hanya tersedia untuk ADMIN.' })
    return user
  }

  async createAccount(input: { name?: string; email?: string; password?: string; role?: string }, actorId: string) {
    const name = input.name?.trim(), email = input.email?.trim().toLowerCase(), password = input.password
    const role = input.role ?? 'PRESALES'
    if (!name || !email || !password || password.length < 12 || !['ADMIN','PRESALES'].includes(role)) throw new BadRequestException({ message: 'Nama, email, role valid, dan kata sandi minimal 12 karakter wajib diisi.' })
    const result = await adminAuth.api.signUpEmail({ body: { name, email, password } })
    await this.db.query('UPDATE "user" SET role=$1 WHERE id=$2', [role,result.user.id])
    await this.db.query(`INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'USER_CREATED','USER',$2,$3::jsonb)`, [actorId,result.user.id,JSON.stringify({ email,role })])
    return { id: result.user.id, name, email, role }
  }
}
