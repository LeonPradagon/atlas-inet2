import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { and, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { audit } from "../database/audit";
import { Database } from "../database/database";
import {
  appSettings,
  auditLogs,
  bookingCores,
  bookings,
  networkAssets,
  networkCores,
} from "../database/schema";

export type CreateBookingInput = {
  customer?: string;
  picCustomer?: string;
  picPresales?: string;
  segmentId?: string;
  cores?: number;
};

@Injectable()
export class BookingService implements OnModuleInit, OnModuleDestroy {
  private expiryTimer?: NodeJS.Timeout;
  constructor(@Inject(Database) private readonly db: Database) {}

  onModuleInit() {
    this.expiryTimer = setInterval(
      () =>
        void this.expireBookings().catch((error) =>
          console.error("Booking expiry failed", error)
        ),
      60_000
    );
    this.expiryTimer.unref();
  }

  onModuleDestroy() {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
    }
  }

  async listBookableSegments() {
    return this.db.orm
      .select({
        area: networkAssets.area,
        assetType: networkAssets.assetType,
        id: networkAssets.id,
        idleCores: sql<number>`count(${networkCores.id}) FILTER (WHERE ${networkCores.status}='Available')::int`,
        name: networkAssets.name,
        totalCores: networkAssets.totalCores,
      })
      .from(networkAssets)
      .leftJoin(networkCores, eq(networkCores.assetId, networkAssets.id))
      .where(
        and(
          eq(networkAssets.assetType, "segment"),
          gt(networkAssets.totalCores, 0),
          or(
            eq(networkAssets.source, "managed"),
            sql`${networkAssets.attributes}->'__coreUsageVerification'->'verified' = 'true'::jsonb`,
            sql`${networkAssets.attributes}->'__coreUsageVerified' = 'true'::jsonb`
          )
        )
      )
      .groupBy(networkAssets.id)
      .orderBy(networkAssets.name, networkAssets.id);
  }

  async listBookings() {
    return this.db.orm
      .select({
        approvedAt: bookings.approvedAt,
        area: networkAssets.area,
        cores: bookings.cores,
        customer: bookings.customer,
        expiresAt: bookings.expiresAt,
        id: bookings.id,
        picCustomer: bookings.picCustomer,
        picPresales: bookings.picPresales,
        rejectedAt: bookings.rejectedAt,
        requestedAt: bookings.requestedAt,
        segmentId: bookings.segmentId,
        segmentName: networkAssets.name,
        status: bookings.status,
      })
      .from(bookings)
      .innerJoin(networkAssets, eq(networkAssets.id, bookings.segmentId))
      .orderBy(desc(bookings.requestedAt), desc(bookings.id));
  }

  async getBookingDuration() {
    const rows = await this.db.orm
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, "booking_duration_days"));
    return { days: Number(rows[0]?.value ?? 30) };
  }

  async setBookingDuration(days: number, userId: string) {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new BadRequestException({
        message: "Durasi booking harus 1–365 hari.",
      });
    }
    await this.db.orm
      .insert(appSettings)
      .values({ key: "booking_duration_days", value: days })
      .onConflictDoUpdate({
        set: { value: sql`EXCLUDED.value` },
        target: appSettings.key,
      });
    await this.db.orm.insert(auditLogs).values({
      action: "BOOKING_DURATION_UPDATED",
      actorId: userId,
      details: { days },
      entityId: "booking_duration_days",
      entityType: "SETTING",
    });
    return { days };
  }

  async createBooking(input: CreateBookingInput, userId: string) {
    const customer = input.customer?.trim(),
      picCustomer = input.picCustomer?.trim(),
      picPresales = input.picPresales?.trim();
    const cores = Number(input.cores),
      segmentId = input.segmentId;
    if (
      !(
        customer &&
        picCustomer &&
        picPresales &&
        segmentId &&
        Number.isInteger(cores)
      ) ||
      cores < 1
    ) {
      throw new BadRequestException({
        message: "Pelanggan, PIC, segmen, dan jumlah core wajib diisi.",
      });
    }
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const assets = await tx
        .select({ totalCores: networkAssets.totalCores })
        .from(networkAssets)
        .where(
          and(
            eq(networkAssets.id, segmentId),
            eq(networkAssets.assetType, "segment")
          )
        )
        .for("update");
      if (!assets.length) {
        throw new NotFoundException({ message: "Segmen tidak ditemukan." });
      }
      if (!assets[0].totalCores) {
        throw new BadRequestException({
          message:
            "Kapasitas belum diisi. Minta ADMIN melengkapi jumlah core segmen.",
        });
      }
      if (cores > assets[0].totalCores) {
        throw new BadRequestException({
          message: "Jumlah booking melebihi kapasitas total segmen.",
        });
      }
      const id = `BKG-${randomUUID().toUpperCase()}`;
      await tx.insert(bookings).values({
        cores,
        customer,
        id,
        picCustomer,
        picPresales,
        requestedAt: sql`clock_timestamp()`,
        requestedBy: userId,
        segmentId,
        status: "Pending Approval",
      });
      await notifyAdmins(
        client,
        "Persetujuan booking core diperlukan",
        `${customer} meminta ${cores} core pada segmen ${segmentId}.`,
        id
      );
      await audit(client, userId, "BOOKING_CREATED", "BOOKING", id, {
        cores,
        segmentId,
        status: "Pending Approval",
      });
      return {
        cores,
        customer,
        id,
        picCustomer,
        picPresales,
        segmentId,
        status: "Pending Approval",
      };
    });
  }

  async approveBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const targets = await tx
        .select({ segmentId: bookings.segmentId })
        .from(bookings)
        .where(eq(bookings.id, id));
      if (!targets.length) {
        throw new NotFoundException({ message: "Booking tidak ditemukan." });
      }
      await tx
        .select({ id: networkAssets.id })
        .from(networkAssets)
        .where(eq(networkAssets.id, targets[0].segmentId))
        .for("update");
      const [booking] = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, id))
        .for("update");
      if (booking.status !== "Pending Approval") {
        throw new ConflictException({
          message:
            "Hanya booking yang menunggu persetujuan yang dapat disetujui.",
        });
      }
      await tx
        .update(bookings)
        .set({
          approvedAt: sql`clock_timestamp()`,
          approvedBy: userId,
          status: "Waiting List",
        })
        .where(eq(bookings.id, id));
      const allocatedBookingIds = await allocateWaiting(
        client,
        booking.segmentId,
        userId
      );
      const [{ status }] = await tx
        .select({ status: bookings.status })
        .from(bookings)
        .where(eq(bookings.id, id));
      await audit(client, userId, "BOOKING_APPROVED", "BOOKING", id, {
        allocatedBookingIds,
        cores: booking.cores,
        segmentId: booking.segmentId,
        status,
      });
      const message =
        status === "Booked"
          ? `Booking ${id} disetujui dan ${booking.cores} core telah dialokasikan.`
          : `Booking ${id} disetujui dan masuk waiting list karena kapasitas belum mencukupi.`;
      await notifyPresales(
        client,
        "Booking core disetujui",
        message,
        booking.requestedBy,
        id
      );
      return { allocatedBookingIds, id, status };
    });
  }

  async rejectBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const targets = await tx
        .select({ segmentId: bookings.segmentId })
        .from(bookings)
        .where(eq(bookings.id, id));
      if (!targets.length) {
        throw new NotFoundException({ message: "Booking tidak ditemukan." });
      }
      await tx
        .select({ id: networkAssets.id })
        .from(networkAssets)
        .where(eq(networkAssets.id, targets[0].segmentId))
        .for("update");
      const [booking] = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, id))
        .for("update");
      if (booking.status !== "Pending Approval") {
        throw new ConflictException({
          message:
            "Hanya booking yang menunggu persetujuan yang dapat ditolak.",
        });
      }
      await tx
        .update(bookings)
        .set({
          rejectedAt: sql`clock_timestamp()`,
          rejectedBy: userId,
          status: "Rejected",
        })
        .where(eq(bookings.id, id));
      await audit(client, userId, "BOOKING_REJECTED", "BOOKING", id, {
        cores: booking.cores,
        segmentId: booking.segmentId,
      });
      await notifyPresales(
        client,
        "Booking core ditolak",
        `Permintaan booking ${id} untuk ${booking.customer} ditolak oleh ADMIN.`,
        booking.requestedBy,
        id
      );
      return { id, status: "Rejected" };
    });
  }

  async releaseBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const targets = await tx
        .select({ segmentId: bookings.segmentId })
        .from(bookings)
        .where(eq(bookings.id, id));
      if (!targets.length) {
        throw new NotFoundException({ message: "Booking tidak ditemukan." });
      }
      await tx
        .select({ id: networkAssets.id })
        .from(networkAssets)
        .where(eq(networkAssets.id, targets[0].segmentId))
        .for("update");
      const [booking] = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, id))
        .for("update");
      if (booking.status !== "Booked") {
        throw new ConflictException({
          message: "Hanya booking aktif yang dapat dilepas.",
        });
      }
      await tx
        .update(networkCores)
        .set({ status: "Available" })
        .where(
          inArray(
            networkCores.id,
            tx
              .select({ id: bookingCores.coreId })
              .from(bookingCores)
              .where(eq(bookingCores.bookingId, id))
          )
        );
      await tx.delete(bookingCores).where(eq(bookingCores.bookingId, id));
      await tx
        .update(bookings)
        .set({ releasedAt: sql`now()`, status: "Released" })
        .where(eq(bookings.id, id));
      const allocatedBookingIds = await allocateWaiting(
        client,
        booking.segmentId,
        userId
      );
      await audit(client, userId, "BOOKING_RELEASED", "BOOKING", id, {
        allocatedBookingIds,
        cores: booking.cores,
        segmentId: booking.segmentId,
      });
      await notifyPresales(
        client,
        "Booking core dilepas",
        `${booking.customer}: ${booking.cores} core dilepas. ${allocatedBookingIds.length} permintaan waiting list dialokasikan.`,
        booking.requestedBy ?? userId,
        id
      );
      return {
        allocated: allocatedBookingIds[0] ?? null,
        allocatedBookingIds,
        released: id,
      };
    });
  }

  async expireBookings() {
    const rows = await this.db.orm
      .select({ id: bookings.id, segmentId: bookings.segmentId })
      .from(bookings)
      .where(
        and(eq(bookings.status, "Booked"), lte(bookings.expiresAt, sql`now()`))
      )
      .orderBy(bookings.expiresAt)
      .limit(50);
    for (const { id, segmentId } of rows) {
      await this.db.transaction(async (client) => {
        const tx = drizzle({ client });
        await tx
          .select({ id: networkAssets.id })
          .from(networkAssets)
          .where(eq(networkAssets.id, segmentId))
          .for("update");
        const locked = await tx
          .select()
          .from(bookings)
          .where(
            and(
              eq(bookings.id, id),
              eq(bookings.status, "Booked"),
              lte(bookings.expiresAt, sql`now()`)
            )
          )
          .for("update");
        if (!locked.length) {
          return;
        }
        const booking = locked[0];
        await tx
          .update(networkCores)
          .set({ status: "Available" })
          .where(
            inArray(
              networkCores.id,
              tx
                .select({ id: bookingCores.coreId })
                .from(bookingCores)
                .where(eq(bookingCores.bookingId, id))
            )
          );
        await tx.delete(bookingCores).where(eq(bookingCores.bookingId, id));
        await tx
          .update(bookings)
          .set({ releasedAt: sql`now()`, status: "Expired" })
          .where(eq(bookings.id, id));
        await notifyPresales(
          client,
          "Booking core kedaluwarsa",
          `${booking.customer}: masa booking ${booking.id} berakhir dan ${booking.cores} core dilepas.`,
          booking.requestedBy,
          id
        );
        const allocatedBookingIds = await allocateWaiting(
          client,
          booking.segmentId
        );
        await audit(client, null, "BOOKING_EXPIRED", "BOOKING", id, {
          allocatedBookingIds,
          cores: booking.cores,
          segmentId: booking.segmentId,
        });
      });
    }
  }
}

export async function allocateWaiting(
  client: PoolClient,
  segmentId: string,
  actorId: string | null = null
) {
  const tx = drizzle({ client });
  const queue = await tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.segmentId, segmentId),
        eq(bookings.status, "Waiting List")
      )
    )
    .orderBy(
      sql`COALESCE(${bookings.approvedAt},${bookings.requestedAt})`,
      bookings.requestedAt,
      bookings.id
    )
    .for("update");
  const settings = await tx
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "booking_duration_days"));
  const days = Number(settings[0]?.value ?? 30);
  const allocated: string[] = [];
  for (const booking of queue) {
    const available = await tx
      .select({ id: networkCores.id })
      .from(networkCores)
      .where(
        and(
          eq(networkCores.assetId, segmentId),
          eq(networkCores.status, "Available")
        )
      )
      .orderBy(networkCores.coreNumber)
      .limit(booking.cores)
      .for("update");
    if (available.length !== booking.cores) {
      break;
    }
    await assignCores(
      client,
      booking.id,
      available.map((row) => row.id)
    );
    await tx
      .update(bookings)
      .set({
        expiresAt: sql`now()+(${days}||' days')::interval`,
        status: "Booked",
      })
      .where(eq(bookings.id, booking.id));
    await audit(
      client,
      actorId,
      "WAITING_LIST_ALLOCATED",
      "BOOKING",
      booking.id,
      { cores: booking.cores, segmentId }
    );
    await notifyPresales(
      client,
      "Waiting list dialokasikan",
      `${booking.customer}: ${booking.cores} core tersedia dan booking ${booking.id} aktif.`,
      booking.requestedBy,
      booking.id
    );
    allocated.push(booking.id);
  }
  return allocated;
}

async function assignCores(
  client: PoolClient,
  bookingId: string,
  coreIds: number[]
) {
  const tx = drizzle({ client });
  for (const coreId of coreIds) {
    await tx
      .update(networkCores)
      .set({ status: "Booked" })
      .where(eq(networkCores.id, coreId));
    await tx.insert(bookingCores).values({ bookingId, coreId });
  }
}

async function notifyPresales(
  client: PoolClient,
  title: string,
  message: string,
  requestorId: string | null,
  bookingId?: string
) {
  await client.query(
    `INSERT INTO notifications(user_id,title,message,booking_id)
      SELECT id,$1,$2,$4 FROM "user" WHERE role='PRESALES' OR id=$3`,
    [title, message, requestorId ?? "", bookingId ?? null]
  );
}

async function notifyAdmins(
  client: PoolClient,
  title: string,
  message: string,
  bookingId?: string
) {
  await client.query(
    `INSERT INTO notifications(user_id,title,message,booking_id)
      SELECT id,$1,$2,$3 FROM "user" WHERE role='ADMIN'`,
    [title, message, bookingId ?? null]
  );
}
