import { ApiUnauthorizedResponse, ApiForbiddenResponse } from "@nestjs/swagger";
import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { ApiBody, ApiParam } from "@nestjs/swagger";
import { AuthService } from "../auth/auth.service";
import { BookingDurationDto, BookingPricesDto, CreateBookingDto } from "./booking.dto";
import { BookingService, type CreatePathBookingInput } from "./booking.service";

@Controller()
export class BookingController {
  constructor(
    @Inject(BookingService) private readonly booking: BookingService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  @Get("assets/bookable-segments")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async bookableSegments(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.listBookableSegments();
  }

  @Get("assets/bookable-devices")
  async bookableDevices(@Req() req: IncomingMessage, @Query("startId") startId?: string) {
    await this.auth.requireUser(req);
    return this.booking.listBookableDevices(startId);
  }

  @Get("bookings/confirmed-core-paths")
  async confirmedCorePaths(
    @Req() req: IncomingMessage,
    @Query("startId") startId?: string,
    @Query("endId") endId?: string,
    @Query("cores") cores?: string,
    @Query("preferredRoute") preferredRoute?: string
  ) {
    await this.auth.requireUser(req);
    return this.booking.previewConfirmedCorePaths(startId ?? "", endId ?? "", Number(cores), preferredRoute);
  }

  @Get("bookings")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async bookings(@Req() req: IncomingMessage) {
    const user = await this.auth.requireUser(req);
    return this.booking.listBookings(user.role === "ADMIN");
  }

  @Post("bookings")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiBody({ type: CreateBookingDto })
  async createBooking(
    @Req() req: IncomingMessage,
    @Body() body: CreateBookingDto
  ) {
    const user = await this.auth.requireUser(req);
    return this.booking.createBooking(
      { ...body, picPresales: user.name },
      user.id
    );
  }

  @Post("bookings/route")
  @ApiBody({ schema: { type: "object" } })
  async createPathBooking(@Req() req: IncomingMessage, @Body() body: CreatePathBookingInput) {
    const user = await this.auth.requireUser(req);
    return this.booking.createPathBooking({
      ...body,
      picPresales: body.picPresales?.trim() || user.name || user.email,
    }, user.id);
  }

  @Post("bookings/:id/approve")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiParam({ name: "id", type: String })
  async approveBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.approveBooking(id, user.id);
  }

  @Post("bookings/:id/reject")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiParam({ name: "id", type: String })
  async rejectBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.rejectBooking(id, user.id);
  }

  @Post("bookings/:id/release")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async releaseBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireUser(req);
    return this.booking.releaseBooking(id, user.id, user.role === "ADMIN");
  }

  @Post("bookings/:id/resubmit")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async resubmitBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireUser(req);
    return this.booking.resubmitBooking(id, user.id);
  }

  @Post("bookings/:id/po-issued")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiParam({ name: "id", type: String })
  async purchaseOrderIssued(
    @Req() req: IncomingMessage,
    @Param("id") id: string
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.markPurchaseOrderIssued(id, user.id);
  }

  @Get("settings/booking-duration")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async duration(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.getBookingDuration();
  }

  @Patch("settings/booking-duration")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiBody({ type: BookingDurationDto })
  async setDuration(
    @Req() req: IncomingMessage,
    @Body() body: BookingDurationDto
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.setBookingDuration(Number(body.days), user.id);
  }

  @Get("settings/booking-prices")
  async prices(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.getBookingPrices();
  }

  @Patch("settings/booking-prices")
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiBody({ type: BookingPricesDto })
  async setPrices(@Req() req: IncomingMessage, @Body() body: BookingPricesDto) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.setBookingPrices(body.items, user.id);
  }
}
