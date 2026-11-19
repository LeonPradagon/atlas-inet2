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
import { ApiBody } from "@nestjs/swagger";
import { AuthService } from "../auth/auth.service";
import { BookingDurationDto, CreateBookingDto } from "./booking.dto";
import { BookingService } from "./booking.service";

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
  @ApiBody({ type: CreateBookingDto })
  async createBooking(
    @Req() req: IncomingMessage,
    @Body() body: CreateBookingDto
  ) {
    const user = await this.auth.requireUser(req);
    return this.booking.createBooking({ ...body, picPresales: user.name }, user.id);
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

  @Post("bookings/:id/resubmit")
  async resubmitBooking(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireUser(req);
    return this.booking.resubmitBooking(id, user.id);
  }

  @Post("bookings/:id/po-issued")
  async purchaseOrderIssued(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.markPurchaseOrderIssued(id, user.id);
  }

  @Get("settings/booking-duration")
  async duration(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.booking.getBookingDuration();
  }

  @Patch("settings/booking-duration")
  @ApiBody({ type: BookingDurationDto })
  async setDuration(
    @Req() req: IncomingMessage,
    @Body() body: BookingDurationDto
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.booking.setBookingDuration(Number(body.days), user.id);
  }
}
