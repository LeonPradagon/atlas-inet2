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
  bookingSegments,
  bookings,
  networkAssets,
  networkCores,
} from "../database/schema";

export type CreateBookingInput = {
  customer?: string;
  picCustomer?: string;
  picCustomerEmail?: string;
  picCustomerPhone?: string;
  picPresales?: string;
  segmentId?: string;
  cores?: number;
  segments?: { segmentId: string; cores: number; segmentFrom?: string; segmentTo?: string }[];
};

const usageVerified = sql<boolean>`(${or(
  eq(networkAssets.source, "managed"),
  sql`${networkAssets.attributes}->'__coreUsageVerification'->'verified' = 'true'::jsonb`,
  sql`${networkAssets.attributes}->'__coreUsageVerified' = 'true'::jsonb`
)})`;

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
          usageVerified
        )
      )
      .groupBy(networkAssets.id)
      .orderBy(networkAssets.name, networkAssets.id);
  }

  async listBookings() {
    const rows = await this.db.orm
      .select({
        approvedAt: bookings.approvedAt,
        area: networkAssets.area,
        cores: bookings.cores,
        customer: bookings.customer,
        expiresAt: bookings.expiresAt,
        id: bookings.id,
        picCustomer: bookings.picCustomer,
        picCustomerEmail: bookings.picCustomerEmail,
        picCustomerPhone: bookings.picCustomerPhone,
        picPresales: bookings.picPresales,
        requestedBy: bookings.requestedBy,
        rejectedAt: bookings.rejectedAt,
        requestedAt: bookings.requestedAt,
        segmentId: bookings.segmentId,
        segmentName: networkAssets.name,
        status: bookings.status,
      })
      .from(bookings)
      .innerJoin(networkAssets, eq(networkAssets.id, bookings.segmentId))
      .orderBy(desc(bookings.requestedAt), desc(bookings.id));
    const segments = await this.db.orm.select({ bookingId: bookingSegments.bookingId, segmentId: bookingSegments.segmentId, cores: bookingSegments.cores, segmentFrom: bookingSegments.segmentFrom, segmentTo: bookingSegments.segmentTo, name: networkAssets.name, area: networkAssets.area })
      .from(bookingSegments).innerJoin(networkAssets, eq(networkAssets.id, bookingSegments.segmentId));
    return rows.map((row) => ({ ...row, segments: segments.filter((item) => item.bookingId === row.id).map(({ bookingId: _id, ...item }) => item).concat(segments.some((item) => item.bookingId === row.id) ? [] : [{ segmentId: row.segmentId, cores: row.cores, segmentFrom: "", segmentTo: "", name: row.segmentName, area: row.area }]) }));
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
    const segments = input.segments ?? [{ segmentId: input.segmentId ?? "", cores: Number(input.cores) }];
    if (!Array.isArray(segments) || !segments.length || segments.some((item) => !item || typeof item.segmentId !== "string" || !item.segmentId || !Number.isInteger(item.cores) || item.cores < 1 || (item.segmentFrom !== undefined && (typeof item.segmentFrom !== "string" || !item.segmentFrom.trim() || item.segmentFrom.length > 200)) || (item.segmentTo !== undefined && (typeof item.segmentTo !== "string" || !item.segmentTo.trim() || item.segmentTo.length > 200)) || (item.segmentFrom === undefined) !== (item.segmentTo === undefined)) || new Set(segments.map((item) => item.segmentId)).size !== segments.length) {
      throw new BadRequestException({ message: "Pilih segmen unik dengan jumlah core yang valid." });
    }
    const sorted = [...segments].sort((a, b) => a.segmentId.localeCompare(b.segmentId));
    const segmentId = sorted[0].segmentId;
    const cores = sorted.reduce((sum, item) => sum + item.cores, 0);
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
      await client.query('SELECT id FROM network_assets WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [sorted.map((item) => item.segmentId)]);
      let insufficient = false;
      for (const segment of sorted) {
      const assets = await tx
        .select({ totalCores: networkAssets.totalCores, usageVerified })
        .from(networkAssets)
        .where(
          and(
            eq(networkAssets.id, segment.segmentId),
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
      if (!assets[0].usageVerified) {
        throw new BadRequestException({
          message:
            "Pemakaian core segmen belum terverifikasi. Minta ADMIN memverifikasi segmen pada halaman peta jaringan.",
        });
      }
      if (segment.cores > assets[0].totalCores) {
        throw new BadRequestException({
          message: "Jumlah booking melebihi kapasitas total segmen.",
        });
      }
      const available = await tx.select({ id: networkCores.id }).from(networkCores)
        .where(and(eq(networkCores.assetId, segment.segmentId), eq(networkCores.status, "Available")))
        .limit(segment.cores);
      if (available.length < segment.cores) insufficient = true;
      }
      const status = insufficient ? "Waiting List" : "Pending Approval";
      const id = `BKG-${randomUUID().toUpperCase()}`;
      await tx.insert(bookings).values({
        cores,
        customer,
        id,
        picCustomer,
        picCustomerEmail: input.picCustomerEmail?.trim() ?? "",
        picCustomerPhone: input.picCustomerPhone?.trim() ?? "",
        picPresales,
        requestedAt: sql`clock_timestamp()`,
        requestedBy: userId,
        segmentId,
        status,
      });
      await tx.insert(bookingSegments).values(sorted.map((item) => ({ bookingId: id, ...item, segmentFrom: item.segmentFrom?.trim() ?? "", segmentTo: item.segmentTo?.trim() ?? "" })));
      if (status === "Pending Approval") await notifyAdmins(
        client,
        "Persetujuan booking core diperlukan",
        `${customer} meminta ${cores} core pada ${sorted.length} segmen.`,
        id
      );
      await audit(client, userId, "BOOKING_CREATED", "BOOKING", id, {
        cores,
        segmentId,
        segments: sorted,
        status,
      });
      return {
        cores,
        customer,
        id,
        picCustomer,
        picPresales,
        segmentId,
        status,
      };
    });
  }

  async approveBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const segments = await lockBookingSegments(client, id);
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
      const available: number[] = [];
      let enough = true;
      for (const segment of segments) {
        const rows = await tx.select({ id: networkCores.id }).from(networkCores)
          .where(and(eq(networkCores.assetId, segment.segmentId), eq(networkCores.status, "Available")))
          .orderBy(networkCores.coreNumber).limit(segment.cores).for("update");
        if (rows.length < segment.cores) enough = false;
        available.push(...rows.map((row) => row.id));
      }
      const status = enough ? "Booked" : "Waiting List";
      if (status === "Booked") await assignCores(client, id, available);
      const [setting] = await tx.select({ value: appSettings.value }).from(appSettings)
        .where(eq(appSettings.key, "booking_duration_days"));
      await tx
        .update(bookings)
        .set({
          approvedAt: sql`clock_timestamp()`,
          approvedBy: userId,
          status,
          expiresAt: status === "Booked" ? sql`now()+(${Number(setting?.value ?? 30)}||' days')::interval` : null,
        })
        .where(eq(bookings.id, id));
      const allocatedBookingIds = status === "Booked" ? [id] : [];
      await audit(client, userId, "BOOKING_APPROVED", "BOOKING", id, {
        allocatedBookingIds,
        cores: booking.cores,
        segmentId: booking.segmentId,
        status,
      });
      const message =
        status === "Booked"
          ? `Booking ${id} disetujui dan ${booking.cores} core telah dialokasikan.`
          : `Kapasitas booking ${id} tidak lagi mencukupi. Ajukan ulang setelah tersedia.`;
      await notifyPresales(
        client,
        status === "Booked" ? "Booking core disetujui" : "Booking masuk waiting list",
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
      const segments = await lockBookingSegments(client, id);
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

  async resubmitBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const [target] = await tx.select().from(bookings).where(eq(bookings.id, id));
      if (!target || target.requestedBy !== userId) throw new NotFoundException({ message: "Booking tidak ditemukan." });
      const segments = await lockBookingSegments(client, id);
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (booking.status !== "Waiting List") throw new ConflictException({ message: "Hanya waiting list yang dapat diajukan ulang." });
      for (const segment of segments) {
        const available = await tx.select({ id: networkCores.id }).from(networkCores)
          .where(and(eq(networkCores.assetId, segment.segmentId), eq(networkCores.status, "Available"))).limit(segment.cores);
        if (available.length < segment.cores) throw new ConflictException({ message: "Core tersedia belum mencukupi di semua segmen." });
      }
      await tx.update(bookings).set({ status: "Pending Approval", requestedAt: sql`clock_timestamp()`, approvedAt: null, approvedBy: null }).where(eq(bookings.id, id));
      await notifyAdmins(client, "Persetujuan booking core diperlukan", `${booking.customer} mengajukan ulang booking ${id}.`, id);
      await audit(client, userId, "BOOKING_RESUBMITTED", "BOOKING", id, { segmentId: booking.segmentId });
      return { id, status: "Pending Approval" };
    });
  }

  async markPurchaseOrderIssued(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const [target] = await tx.select({ segmentId: bookings.segmentId }).from(bookings).where(eq(bookings.id, id));
      if (!target) throw new NotFoundException({ message: "Booking tidak ditemukan." });
      const segments = await lockBookingSegments(client, id);
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, id)).for("update");
      if (booking.status !== "Booked") throw new ConflictException({ message: "Hanya booking aktif yang dapat ditandai PO terbit." });
      const cores = await tx.select({ id: networkCores.id, status: networkCores.status, segmentId: networkCores.assetId }).from(networkCores)
        .innerJoin(bookingCores, eq(bookingCores.coreId, networkCores.id)).where(eq(bookingCores.bookingId, id)).for("update");
      if (cores.length !== booking.cores || cores.some((core) => core.status !== "Booked") || segments.some((segment) => cores.filter((core) => core.segmentId === segment.segmentId).length !== segment.cores)) throw new ConflictException({ message: "Alokasi core tidak sesuai; periksa data booking." });
      await tx.update(networkCores).set({ status: "Used" }).where(inArray(networkCores.id, cores.map((core) => core.id)));
      await tx.update(bookings).set({ status: "Used", expiresAt: null }).where(eq(bookings.id, id));
      await audit(client, userId, "BOOKING_PO_ISSUED", "BOOKING", id, { cores: booking.cores, segmentId: booking.segmentId });
      await notifyPresales(client, "PO terbit", `PO booking ${id} terbit dan core ditandai terpakai.`, booking.requestedBy, id);
      return { id, status: "Used" };
    });
  }

  async releaseBooking(id: string, userId: string) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const segments = await lockBookingSegments(client, id);
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
      const allocatedBookingIds: string[] = [];
      const notified = new Set<string>();
      for (const segment of segments) await allocateWaiting(client, segment.segmentId, userId, notified);
      await audit(client, userId, "BOOKING_RELEASED", "BOOKING", id, {
        allocatedBookingIds,
        cores: booking.cores,
        segmentId: booking.segmentId,
      });
      await notifyPresales(
        client,
        "Booking core dilepas",
        `${booking.customer}: ${booking.cores} core dilepas. Pemilik waiting list yang memenuhi kapasitas akan diberi notifikasi.`,
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
    for (const { id } of rows) {
      await this.db.transaction(async (client) => {
        const tx = drizzle({ client });
        const segments = await lockBookingSegments(client, id);
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
        const allocatedBookingIds: string[] = [];
        const notified = new Set<string>();
        for (const segment of segments) await allocateWaiting(client, segment.segmentId, null, notified);
        await audit(client, null, "BOOKING_EXPIRED", "BOOKING", id, {
          allocatedBookingIds,
          cores: booking.cores,
          segmentId: booking.segmentId,
        });
      });
    }
  }
}

async function lockBookingSegments(client: PoolClient, id: string) {
  const { rows } = await client.query<{ segmentId: string; cores: number }>(
    `SELECT segment_id AS "segmentId", cores FROM booking_segments WHERE booking_id=$1
     UNION ALL SELECT segment_id, cores FROM bookings WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM booking_segments WHERE booking_id=$1)
     ORDER BY "segmentId"`, [id]);
  if (!rows.length) throw new NotFoundException({ message: "Booking tidak ditemukan." });
  await client.query('SELECT id FROM network_assets WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [rows.map((row) => row.segmentId)]);
  return rows;
}

export async function allocateWaiting(client: PoolClient, segmentId: string, _actorId: string | null = null, notified = new Set<string>()) {
  // Callers may already hold a single segment lock; do not lock waiting bookings here.
  const { rows } = await client.query<{ id: string; customer: string; requestedBy: string }>(`
    SELECT b.id,b.customer,b.requested_by AS "requestedBy"
    FROM bookings b
    WHERE b.status='Waiting List' AND b.requested_by IS NOT NULL
      AND (EXISTS (SELECT 1 FROM booking_segments s WHERE s.booking_id=b.id AND s.segment_id=$1)
           OR (b.segment_id=$1 AND NOT EXISTS (SELECT 1 FROM booking_segments s WHERE s.booking_id=b.id)))
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT s.segment_id,s.cores FROM booking_segments s WHERE s.booking_id=b.id
          UNION ALL SELECT b.segment_id,b.cores WHERE NOT EXISTS (SELECT 1 FROM booking_segments s WHERE s.booking_id=b.id)
        ) requested WHERE (SELECT count(*) FROM network_cores c WHERE c.asset_id=requested.segment_id AND c.status='Available') < requested.cores
      )`, [segmentId]);
  for (const booking of rows) {
    if (notified.has(booking.id)) continue;
    notified.add(booking.id);
    await client.query(
    `INSERT INTO notifications(user_id,title,message,booking_id) VALUES($1,$2,$3,$4)`,
    [booking.requestedBy, "Core tersedia untuk waiting list", `${booking.customer}: core tersedia di semua segmen. Ajukan ulang booking ${booking.id} untuk persetujuan ADMIN.`, booking.id]
    );
  }
  return [] as string[];
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
