import { ApiUnauthorizedResponse, ApiForbiddenResponse } from "@nestjs/swagger";
import type { IncomingMessage } from "node:http";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBody, ApiOperation } from "@nestjs/swagger";
import { CreateUserDto } from "../atlas/api.dto";
import { AuthService } from "./auth.service";

@Controller()
export class AuthController {
  constructor(@Inject(AuthService) private readonly authService: AuthService) {}

  @Get("me")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async me(@Req() request: IncomingMessage) {
    const user = await this.authService.requireUser(request);
    return {
      email: user.email,
      id: user.id,
      name: user.name,
      role: user.role ?? "PRESALES",
    };
  }

  @Post("users")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiOperation({ summary: "Buat akun pengguna (admin)" })
  @ApiBody({ type: CreateUserDto })
  async createUser(
    @Req() request: IncomingMessage,
    @Body() body: CreateUserDto
  ) {
    const actor = await this.authService.requireAdmin(request);
    try {
      return await this.authService.createAccount(body, actor.id);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException({
        message: "Akun tidak dapat dibuat. Periksa email dan kata sandi.",
      });
    }
  }
}
