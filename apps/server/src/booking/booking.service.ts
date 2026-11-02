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
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { audit } from "../database/audit";
import { Database } from "../database/database";
import {
  appSettings,
  auditLogs,
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
          gt(networkAssets.totalCores, 0)
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
      const { rows: assets } = await client.query(
        "SELECT total_cores FROM network_assets WHERE id=$1 AND asset_type='segment' FOR UPDATE",
        [segmentId]
      );
      if (!assets.length) {
        throw new NotFoundException({ message: "Segmen tidak ditemukan." });
      }
      if (!assets[0].total_cores) {
        throw new BadRequestException({
          message:
            "Kapasitas belum diisi. Minta ADMIN melengkapi jumlah core segmen.",
        });
      }
      if (cores > assets[0].total_cores) {
        throw new BadRequestException({
          message: "Jumlah booking melebihi kapasitas total segmen.",
        });
      }
      const id = `BKG-${randomUUID().toUpperCase()}`;
      await client.query(
        `INSERT INTO bookings(id,customer,pic_customer,pic_presales,segment_id,cores,status,requested_by,requested_at)
        VALUES($1,$2,$3,$4,$5,$6,'Pending Approval',$7,clock_timestamp())`,
        [id, customer, picCustomer, picPresales, segmentId, cores, userId]
      );
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
      const { rows: targets } = await client.query(
        "SELECT segment_id FROM bookings WHERE id=$1",
        [id]
      );
      if (!targets.length) {
        throw new NotFoundException({ message: "Booking tidak ditemukan." });
      }
      await client.query(
        "SELECT id FROM network_assets WHERE id=$1 FOR UPDATE",
        [targets[0].segment_id]
      );
      const { rows } = await client.query(
        "SELECT * FROM bookings WHERE id=$1 FOR UPDATE",
        [id]
      );
      const booking = rows[0];
      if (booking.status !== "Pending Approval") {
        throw new ConflictException({
          message:
            "Hanya booking yang menunggu persetujuan yang dapat disetujui.",
        });
      }
      await client.query(
        "UPDATE bookings SET status='Waiting List',approved_by=$2,approved_at=clock_timestamp() WHERE id=$1",
        [id, userId]
      );
      const allocatedBookingIds = await allocateWaiting(
        client,
        booking.segment_id,
        userId
      );
      const { rows: result } = await client.query(
        "SELECT status FROM bookings WHERE id=$1",
        [id]
      );
      const status = result[0].status as string;
      await audit(client, userId, "BOOKING_APPROVED", "BOOKING", id, {
        allocatedBookingIds,
        cores: booking.cores,
        segmentId: booking.segment_id,
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
        booking.requested_by,
        id
      );
      return { allocatedBookingIds, id, status };
    });
  }

  async rejectBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const { rows: targets } = await client.query(
        "SELECT segment_id FROM bookings WHERE id=$1",
        [id]
      );
      if (!targets.length) {
        throw new NotFoundException({ message: "Booking tidak ditemukan." });
      }
      await client.query(
        "SELECT id FROM network_assets WHERE id=$1 FOR UPDATE",
        [targets[0].segment_id]
      );
      const { rows } = await client.query(
        "SELECT * FROM bookings WHERE id=$1 FOR UPDATE",
        [id]
      );
      const booking = rows[0];
      if (booking.status !== "Pending Approval") {
        throw new ConflictException({
          message:
            "Hanya booking yang menunggu persetujuan yang dapat ditolak.",
        });
      }
      await client.query(
        "UPDATE bookings SET status='Rejected',rejected_by=$2,rejected_at=clock_timestamp() WHERE id=$1",
        [id, userId]
      );
      await audit(client, userId, "BOOKING_REJECTED", "BOOKING", id, {
        cores: booking.cores,
        segmentId: booking.segment_id,
      });
      await notifyPresales(
        client,
        "Booking core ditolak",
        `Permintaan booking ${id} untuk ${booking.customer} ditolak oleh ADMIN.`,
        booking.requested_by,
        id
      );
      return { id, status: "Rejected" };
    });
  }

  async releaseBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const { rows: targets } = await client.query(
        "SELECT segment_id FROM bookings WHERE id=$1",
        [id]
      );
      if (!targets.length) {
        throw new NotFoundException({ message: "Booking tidak ditemukan." });
      }
      await client.query(
        "SELECT id FROM network_assets WHERE id=$1 FOR UPDATE",
        [targets[0].segment_id]
      );
      const { rows } = await client.query(
        "SELECT * FROM bookings WHERE id=$1 FOR UPDATE",
        [id]
      );
      const booking = rows[0];
      if (booking.status !== "Booked") {
        throw new ConflictException({
          message: "Hanya booking aktif yang dapat dilepas.",
        });
      }
      await client.query(
        "UPDATE network_cores SET status='Available' WHERE id IN (SELECT core_id FROM booking_cores WHERE booking_id=$1)",
        [id]
      );
      await client.query("DELETE FROM booking_cores WHERE booking_id=$1", [id]);
      await client.query(
        "UPDATE bookings SET status='Released',released_at=now() WHERE id=$1",
        [id]
      );
      const allocatedBookingIds = await allocateWaiting(
        client,
        booking.segment_id,
        userId
      );
      await audit(client, userId, "BOOKING_RELEASED", "BOOKING", id, {
        allocatedBookingIds,
        cores: booking.cores,
        segmentId: booking.segment_id,
      });
      await notifyPresales(
        client,
        "Booking core dilepas",
        `${booking.customer}: ${booking.cores} core dilepas. ${allocatedBookingIds.length} permintaan waiting list dialokasikan.`,
        booking.requested_by ?? userId,
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
    const { rows } = await this.db.query(
      "SELECT id,segment_id FROM bookings WHERE status='Booked' AND expires_at <= now() ORDER BY expires_at LIMIT 50"
    );
    for (const { id, segment_id } of rows) {
      await this.db.transaction(async (client) => {
        await client.query(
          "SELECT id FROM network_assets WHERE id=$1 FOR UPDATE",
          [segment_id]
        );
        const { rows: locked } = await client.query(
          "SELECT * FROM bookings WHERE id=$1 AND status='Booked' AND expires_at <= now() FOR UPDATE",
          [id]
        );
        if (!locked.length) {
          return;
        }
        const booking = locked[0];
        await client.query(
          "UPDATE network_cores SET status='Available' WHERE id IN (SELECT core_id FROM booking_cores WHERE booking_id=$1)",
          [id]
        );
        await client.query("DELETE FROM booking_cores WHERE booking_id=$1", [
          id,
        ]);
        await client.query(
          "UPDATE bookings SET status='Expired',released_at=now() WHERE id=$1",
          [id]
        );
        await notifyPresales(
          client,
          "Booking core kedaluwarsa",
          `${booking.customer}: masa booking ${booking.id} berakhir dan ${booking.cores} core dilepas.`,
          booking.requested_by,
          id
        );
        const allocatedBookingIds = await allocateWaiting(
          client,
          booking.segment_id
        );
        await audit(client, null, "BOOKING_EXPIRED", "BOOKING", id, {
          allocatedBookingIds,
          cores: booking.cores,
          segmentId: booking.segment_id,
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
  const { rows: queue } = await client.query(
    "SELECT * FROM bookings WHERE segment_id=$1 AND status='Waiting List' ORDER BY COALESCE(approved_at,requested_at),requested_at,id FOR UPDATE",
    [segmentId]
  );
  const { rows: settings } = await client.query(
    "SELECT value FROM app_settings WHERE key='booking_duration_days'"
  );
  const days = Number(settings[0]?.value ?? 30);
  const allocated: string[] = [];
  for (const booking of queue) {
    const { rows: available } = await client.query(
      "SELECT id FROM network_cores WHERE asset_id=$1 AND status='Available' ORDER BY core_number LIMIT $2 FOR UPDATE",
      [segmentId, booking.cores]
    );
    if (available.length !== booking.cores) {
      break;
    }
    await assignCores(
      client,
      booking.id,
      available.map((row) => row.id)
    );
    await client.query(
      "UPDATE bookings SET status='Booked',expires_at=now()+($2||' days')::interval WHERE id=$1",
      [booking.id, days]
    );
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
      booking.requested_by,
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
  for (const coreId of coreIds) {
    await client.query("UPDATE network_cores SET status='Booked' WHERE id=$1", [
      coreId,
    ]);
    await client.query(
      "INSERT INTO booking_cores(booking_id,core_id) VALUES($1,$2)",
      [bookingId, coreId]
    );
  }
}

async function notifyPresales(
  client: PoolClient,
  title: string,
  message: string,
  requestorId?: string,
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
