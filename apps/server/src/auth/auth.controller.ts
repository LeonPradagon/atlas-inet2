import { BadRequestException, Body, Controller, Get, Inject, Post, Req } from '@nestjs/common'
import type { IncomingMessage } from 'node:http'
import { AuthService } from './auth.service'

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Get('me')
  async me(@Req() request: IncomingMessage) {
    const user = await this.authService.requireUser(request)
    return { id: user.id, name: user.name, email: user.email, role: user.role ?? 'PRESALES' }
  }

  @Post('users')
  async createUser(@Req() request: IncomingMessage, @Body() body: { name?: string; email?: string; password?: string; role?: string }) {
    const actor = await this.authService.requireAdmin(request)
    try { return await this.authService.createAccount(body, actor.id) }
    catch (error) {
      if (error instanceof BadRequestException) throw error
      throw new BadRequestException({ message: 'Akun tidak dapat dibuat. Periksa email dan kata sandi.' })
    }
  }
}
