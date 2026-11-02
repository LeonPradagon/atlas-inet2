import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { BookingService, type CreateBookingInput } from "./booking.service";

@Controller()
export class BookingController {
  constructor(
    @Inject(BookingService) private readonly booking: BookingService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  @Get("assets/bookable-segments")
  async bookableSegments(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.listBookableSegments();
  }

  @Get("bookings")
  async bookings(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.listBookings();
  }

  @Post("bookings")
  async createBooking(
    @Req() req: IncomingMessage,
    @Body() body: CreateBookingInput
  ) {
    const user = await this.auth.requireUser(req);
    return this.booking.createBooking(body, user.id);
  }

  @Post("bookings/:id/approve")
  async approveBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.approveBooking(id, user.id);
  }

  @Post("bookings/:id/reject")
  async rejectBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.rejectBooking(id, user.id);
  }

  @Post("bookings/:id/release")
  async releaseBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireUser(req);
    return this.booking.releaseBooking(id, user.id);
  }

  @Get("settings/booking-duration")
  async duration(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.getBookingDuration();
  }

  @Patch("settings/booking-duration")
  async setDuration(
    @Req() req: IncomingMessage,
    @Body() body: { days?: number }
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.setBookingDuration(Number(body.days), user.id);
  }
}
