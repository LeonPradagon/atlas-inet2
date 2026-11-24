import { createHash, randomUUID } from "node:crypto";
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
import { buildRecordedTopology, findCorePaths, groupCorePaths, selectDisjointCorePaths, type RecordedCoreConnection } from "./core-paths";
import {
  appSettings,
  auditLogs,
  bookingCores,
  bookingCoreSections,
  bookingCorePathRequests,
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

type BookingPrice = { name: string; unit: string; price: number };
const defaultBookingPrices: BookingPrice[] = [
  { name: "Kabel fiber optik", unit: "meter", price: 0 },
  { name: "Core kabel", unit: "core", price: 0 },
  { name: "Tiang", unit: "unit", price: 0 },
];

export type CreatePathBookingInput = {
  customer?: string;
  picCustomer?: string;
  picCustomerEmail?: string;
  picCustomerPhone?: string;
  picPresales?: string;
  startNodeId?: string;
  endNodeId?: string;
  requestedCores?: number;
  spanCoreCounts?: number[];
  routeKey?: string;
};

type CableEnds = { A: [number, number]; B: [number, number] };
const cableEnds = sql<CableEnds | null>`CASE
  WHEN GeometryType(${networkAssets.geometry}) = 'LINESTRING'
    AND NOT ST_Equals(ST_StartPoint(${networkAssets.geometry}), ST_EndPoint(${networkAssets.geometry}))
  THEN jsonb_build_object(
    'A', (ST_AsGeoJSON(ST_StartPoint(${networkAssets.geometry}), 15)::jsonb)->'coordinates',
    'B', (ST_AsGeoJSON(ST_EndPoint(${networkAssets.geometry}), 15)::jsonb)->'coordinates'
  ) END`;

const usageVerified = sql<boolean>`(${or(
  eq(networkAssets.source, "managed"),
  sql`${networkAssets.attributes}->'__coreUsageVerification'->'verified' = 'true'::jsonb`,
  sql`${networkAssets.attributes}->'__coreUsageVerified' = 'true'::jsonb`
)})`;

// A whole-cable booking must not consume a core that is already assigned on
// any part of the cable. Section bookings can later apply a narrower check.
const coreAvailableForWholeCable = and(
  eq(networkCores.status, "Available"),
  sql`NOT EXISTS (
    SELECT 1 FROM booking_core_sections section
    WHERE section.core_id = ${networkCores.id}
      AND section.status IN ('Booked', 'Used')
  )`
);

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

  /**
   * Read-only preview based on confirmed physical core records.
   * Legacy whole-cable allocations remain unavailable. New section
   * allocations are checked against each physical section.
   */
  async previewConfirmedCorePaths(startId: string, endId: string, requested: number, preferredRoute?: string) {
    if (!startId || !endId || startId === endId || !Number.isInteger(requested) || requested < 1 || requested > 4096) {
      throw new BadRequestException({ message: "Pilih dua perangkat berbeda dan jumlah core yang valid." });
    }
    const result = await getConfirmedRouteOptions(this.db, startId, endId, requested);
    const options = await getCapacityRouteOptions(this.db, startId, endId, requested, result.options, preferredRoute);
    const cableIds = [...new Set(options.flatMap((option) => option.cableIds))];
    const { rows: cableDetails } = await this.db.query<{
      id: string; available: number; endpoints: { id: string; name: string }[];
    }>(`
      SELECT asset.id,
        (SELECT count(*)::int FROM network_cores core
         WHERE core.asset_id=asset.id AND core.status='Available'
           AND NOT EXISTS (SELECT 1 FROM booking_core_sections section
             WHERE section.core_id=core.id AND section.status IN ('Booked','Used'))) AS available,
        COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', node.id, 'name', node.name))
          FROM network_segment_endpoints endpoint
          JOIN network_assets node ON node.id=endpoint.node_asset_id
          WHERE endpoint.segment_id=asset.id AND endpoint.verification_status='confirmed'), '[]'::jsonb) AS endpoints
      FROM network_assets asset WHERE asset.id=ANY($1::text[])
    `, [cableIds]);
    const detailsById = new Map(cableDetails.map((cable) => [cable.id, cable]));
    const junctionIds = [...new Set(options.flatMap((option) => option.junctionIds))];
    const { rows: routeJunctions } = await this.db.query<{ id: string; name: string }>(
      "SELECT id,name FROM network_assets WHERE id=ANY($1::text[])", [junctionIds]
    );
    const junctionById = new Map(routeJunctions.map((point) => [point.id, point]));
    return {
      truncated: result.truncated,
      options: await Promise.all(options.map(async ({ allocations: _allocations, ...option }) => {
        const confirmedJunctions = option.cableIds.slice(1).map((id, index) => {
          const incoming = detailsById.get(option.cableIds[index])?.endpoints ?? [];
          const outgoing = detailsById.get(id)?.endpoints ?? [];
          const shared = incoming.filter((point) =>
            point.id !== startId && point.id !== endId && outgoing.some((end) => end.id === point.id)
          );
          return shared.length === 1 ? shared[0] : null;
        });
        const junctions = confirmedJunctions.map((confirmedPoint, index) => {
          const routeId = option.junctionIds[index];
          return routeId ? junctionById.get(routeId) : confirmedPoint;
        });
        const boundaries = [startId, ...junctions.map((point) => point?.id ?? null), endId];
        const routePoints = await findBookingMidspanPoints(this.db, option.cableIds, boundaries);
        const segments = option.cableIds.map((id, index) => ({
          name: option.cableNames[index] ?? id,
          availableCores: option.segmentAvailability[index] ?? detailsById.get(id)?.available ?? 0,
          midspanPoints: routePoints.filter((point) => point.segmentIndex === index),
        }));
        const intermediatePoints = junctions.map((point) => point?.name ?? null);
        const plannedJunctions = junctions.map((point, index) =>
          Boolean(point && point.id !== confirmedJunctions[index]?.id)
        );
        const availableCores = Math.min(...segments.map((segment) => segment.availableCores));
        return { ...option, segments, intermediatePoints, plannedJunctions, availableCores, meetsRequest: availableCores >= requested };
      })),
    };
  }

  async listBookableDevices(startId?: string) {
    const { rows } = await this.db.query<{
      id: string; name: string; type: string | null; area: string | null; latitude: number; longitude: number;
    }>(`
      SELECT node.id,node.name,COALESCE(NULLIF(node.area,''),node.attributes->>'Wilayah',node.attributes->>'Region') AS area,
        node.attributes->>'Tipe Perangkat' AS type,ST_Y(node.geometry) AS latitude,ST_X(node.geometry) AS longitude
      FROM network_assets node
      WHERE node.asset_type='asset' AND GeometryType(node.geometry)='POINT'
        AND (EXISTS (SELECT 1 FROM network_segment_endpoints endpoint WHERE endpoint.node_asset_id=node.id)
          OR EXISTS (SELECT 1 FROM network_core_end_connections endpoint
            WHERE endpoint.node_asset_id=node.id AND endpoint.connection_type='termination')
          OR (upper(node.attributes->>'Tipe Perangkat') IN ('OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE')
            AND EXISTS (SELECT 1 FROM network_assets cable
              WHERE cable.asset_type='segment' AND cable.total_cores>0
                AND GeometryType(cable.geometry)='LINESTRING'
                AND cable.geometry && ST_Expand(node.geometry,0.001)
                AND ST_DistanceSphere(node.geometry,cable.geometry)<=25)))
      ORDER BY node.name,node.id
    `);
    const cables = await loadCandidateCables(this.db, startId ?? "", null);
    const cablesByNode = new Map<string, { id: string; name: string }[]>();
    const endpoints = new Map<string, typeof cables>();
    const reachable = new Set<string>();
    const queue: string[] = [];
    const queuedEndpoints = new Set<string>();
    const visitedCables = new Set<string>();
    const visitCable = (cable: (typeof cables)[number]) => {
      if (visitedCables.has(cable.id)) return;
      visitedCables.add(cable.id);
      for (const endpoint of [cable.a, cable.b]) {
        if (endpoint && !queuedEndpoints.has(endpoint)) {
          queuedEndpoints.add(endpoint);
          reachable.add(endpoint);
          queue.push(endpoint);
        }
      }
      for (const point of cable.access) {
        if (point.fraction * cable.length > 25 && (1 - point.fraction) * cable.length > 25) {
          reachable.add(point.node);
        }
      }
    };
    for (const cable of cables) {
      for (const id of new Set([cable.a, cable.b, ...cable.access.map((point) => point.node)])) {
        if (!id) continue;
        const list = cablesByNode.get(id) ?? [];
        list.push({ id: cable.id, name: cable.name });
        cablesByNode.set(id, list);
      }
      for (const id of new Set([cable.a, cable.b])) {
        if (!id) continue;
        const list = endpoints.get(id) ?? [];
        list.push(cable);
        endpoints.set(id, list);
      }
      if (startId && (cable.a === startId || cable.b === startId || cable.access.some((point) =>
        point.node === startId && point.fraction * cable.length > 25 && (1 - point.fraction) * cable.length > 25
      ))) visitCable(cable);
    }
    for (const id of queue) for (const cable of endpoints.get(id) ?? []) visitCable(cable);
    return rows.map((node) => ({
      ...node,
      cables: cablesByNode.get(node.id) ?? [],
      hasCandidateRoute: node.id !== startId && reachable.has(node.id),
    }));
  }

  async createPathBooking(input: CreatePathBookingInput, userId: string) {
    const customer = input.customer?.trim();
    const picCustomer = input.picCustomer?.trim();
    const picPresales = input.picPresales?.trim();
    const startNodeId = input.startNodeId?.trim();
    const endNodeId = input.endNodeId?.trim();
    const requestedCores = Number(input.requestedCores);
    const routeKey = input.routeKey;
    const spanCoreCounts = input.spanCoreCounts;
    if (!customer || !picCustomer || !picPresales || !startNodeId || !endNodeId || startNodeId === endNodeId ||
        !Number.isInteger(requestedCores) || requestedCores < 1 || requestedCores > 4096 || !routeKey) {
      throw new BadRequestException({ message: "Lengkapi pelanggan, dua perangkat berbeda, jumlah core, dan jalur." });
    }
    if (spanCoreCounts !== undefined && (
      !usesSegmentCapacity(routeKey) || !Array.isArray(spanCoreCounts) ||
      spanCoreCounts.length < 1 || spanCoreCounts.length > 100 ||
      [...spanCoreCounts].some((count) => !Number.isInteger(count) || count < 1 || count > 4096)
    )) {
      throw new BadRequestException({ message: "Jumlah core pada setiap ruas harus berupa bilangan bulat antara 1 dan 4096." });
    }
    return this.db.transaction(async (client) => {
      const snapshot = await getConfirmedRouteOptions(client, startNodeId, endNodeId, requestedCores);
      const selected = (await getCapacityRouteOptions(client, startNodeId, endNodeId, requestedCores, snapshot.options, routeKey))
        .find((option) => option.routeKey === routeKey);
      if (!selected) throw new ConflictException({ message: "Jalur berubah atau tidak lagi tersedia. Cari jalur terbaru lalu pilih kembali." });
      await lockRouteAssets(client, [startNodeId, endNodeId, ...selected.cableIds]);
      const current = await getConfirmedRouteOptions(client, startNodeId, endNodeId, requestedCores);
      const route = (await getCapacityRouteOptions(client, startNodeId, endNodeId, requestedCores, current.options, routeKey, spanCoreCounts))
        .find((option) => option.routeKey === routeKey);
      if (!route) throw new ConflictException({ message: "Jalur berubah saat diajukan. Cari jalur terbaru lalu pilih kembali." });
      if (spanCoreCounts && spanCoreCounts.length !== route.cableIds.length) {
        throw new ConflictException({ message: "Susunan ruas berubah. Tinjau jalur dan jumlah core lagi." });
      }
      const counts = spanCoreCounts ?? route.cableIds.map(() => requestedCores);
      const allocations = route.allocations;
      const status = route.meetsRequest ? "Pending Approval" : "Waiting List";
      const id = `BKG-${randomUUID().toUpperCase()}`;
      const firstCableId = route.cableIds[0];
      const totalLength = route.lengthMeters;
      await client.query(`
        INSERT INTO bookings(id,customer,pic_customer,pic_customer_email,pic_customer_phone,
          pic_presales,requested_by,segment_id,cores,status,requested_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())
      `, [id, customer, picCustomer, input.picCustomerEmail?.trim() ?? "", input.picCustomerPhone?.trim() ?? "", picPresales, userId, firstCableId, requestedCores, status]);
      await client.query(`
        INSERT INTO booking_segments(booking_id,segment_id,cores,segment_from,segment_to)
        SELECT $1,cable_id,sum(cores)::int,'Perangkat awal','Perangkat tujuan'
        FROM unnest($2::text[], $3::int[]) AS segment(cable_id, cores)
        GROUP BY cable_id
        ON CONFLICT (booking_id,segment_id) DO NOTHING
      `, [id, route.cableIds, counts]);
      const fingerprint = allocationFingerprint(routeKey, allocations);
      await client.query(`
        INSERT INTO booking_core_path_requests(booking_id,start_node_id,end_node_id,route_key,
          route_cable_ids,requested_cores,route_length_m,proposed_allocations,review_fingerprint,span_core_counts)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
      `, [id, startNodeId, endNodeId, routeKey, JSON.stringify(route.cableIds), requestedCores, totalLength, JSON.stringify(allocations), fingerprint, JSON.stringify(spanCoreCounts ?? [])]);
      if (status === "Pending Approval") {
        await notifyAdmins(client, "Persetujuan booking core diperlukan", `${customer} meminta ${counts.reduce((total, count) => total + count, 0)} alokasi core pada jalur ${route.cableNames.join(" → ")}.`, id);
      }
      await audit(client, userId, "BOOKING_PATH_CREATED", "BOOKING", id, {
        requestedCores, spanCoreCounts: counts, startNodeId, endNodeId, cableIds: route.cableIds,
        lengthMeters: totalLength, status, proposedAllocations: allocations,
      });
      return { id, status, needsVerification: false, cores: requestedCores, route: { cableIds: route.cableIds, cableNames: route.cableNames, lengthMeters: totalLength, allocations } };
    });
  }

  async listBookableSegments() {
    return this.db.orm
      .select({
        area: networkAssets.area,
        attributes: networkAssets.attributes,
        ends: cableEnds,
        endpointIds: sql<Partial<Record<"A" | "B", string>> | null>`(
          SELECT jsonb_object_agg(endpoint.side, endpoint.node_asset_id)
          FROM network_segment_endpoints endpoint
          JOIN network_assets node ON node.id=endpoint.node_asset_id
          WHERE endpoint.segment_id=${networkAssets.id}
            AND endpoint.verification_status='confirmed' AND node.asset_type='asset'
        )`,
        endpointNames: sql<Partial<Record<"A" | "B", string>> | null>`(
          SELECT jsonb_object_agg(endpoint.side, node.name)
          FROM network_segment_endpoints endpoint
          JOIN network_assets node ON node.id = endpoint.node_asset_id
          WHERE endpoint.segment_id = ${networkAssets.id}
            AND endpoint.verification_status = 'confirmed'
            AND node.asset_type = 'asset'
        )`,
        nearbyEndpointNames: sql<Partial<Record<"A" | "B", string>> | null>`(
          SELECT jsonb_object_agg(ending.side, nearby.name)
          FROM (VALUES
            ('A', ST_StartPoint(${networkAssets.geometry})),
            ('B', ST_EndPoint(${networkAssets.geometry}))
          ) AS ending(side, point)
          CROSS JOIN LATERAL (
            SELECT candidate.name
            FROM network_assets candidate
            WHERE candidate.id <> ${networkAssets.id}
              AND candidate.geometry && ST_Expand(ending.point, 0.001)
              AND candidate.asset_type = 'asset'
              AND GeometryType(candidate.geometry) = 'POINT'
              AND upper(candidate.attributes->>'Tipe Perangkat') IN
                ('OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE')
              AND ST_DistanceSphere(ending.point, candidate.geometry) <= 25
            ORDER BY ST_DistanceSphere(ending.point, candidate.geometry),
              candidate.id
            LIMIT 1
          ) nearby
        )`,
        assetType: networkAssets.assetType,
        id: networkAssets.id,
        idleCores: sql<number>`count(${networkCores.id}) FILTER (WHERE ${coreAvailableForWholeCable})::int`,
        bookedCores: sql<number>`count(${networkCores.id}) FILTER (WHERE ${networkCores.status}='Booked' OR (${networkCores.status}='Available' AND EXISTS (SELECT 1 FROM booking_core_sections section WHERE section.core_id=${networkCores.id} AND section.status='Booked') AND NOT EXISTS (SELECT 1 FROM booking_core_sections section WHERE section.core_id=${networkCores.id} AND section.status='Used')))::int`,
        usedCores: sql<number>`count(${networkCores.id}) FILTER (WHERE ${networkCores.status}='Used' OR (${networkCores.status}='Available' AND EXISTS (SELECT 1 FROM booking_core_sections section WHERE section.core_id=${networkCores.id} AND section.status='Used')))::int`,
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

  async listBookings(isAdmin = false) {
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
    const { rows: pathRequests } = await this.db.query<{
      bookingId: string; startNodeId: string; endNodeId: string; routeCableIds: string[];
      requestedCores: number; routeLengthMeters: number; proposedAllocations: unknown;
      startName: string; endName: string; routeKey: string;
      plannedSplices: PlannedSplice[];
      spanCoreCounts: number[];
      intermediateNames: (string | null)[];
    }>(`
      SELECT request.booking_id AS "bookingId",request.start_node_id AS "startNodeId",
        request.end_node_id AS "endNodeId",request.route_cable_ids AS "routeCableIds",
        request.requested_cores AS "requestedCores",request.route_length_m::float8 AS "routeLengthMeters",
        request.proposed_allocations AS "proposedAllocations",request.route_key AS "routeKey",start_node.name AS "startName",
        end_node.name AS "endName",request.planned_splices AS "plannedSplices",request.span_core_counts AS "spanCoreCounts",
        ARRAY(
          SELECT (
            SELECT max(node.name)
            FROM network_segment_endpoints incoming
            JOIN network_segment_endpoints outgoing ON outgoing.node_asset_id=incoming.node_asset_id
            JOIN network_assets node ON node.id=incoming.node_asset_id
            WHERE incoming.segment_id=pair.cable_id
              AND outgoing.segment_id=request.route_cable_ids->>(pair.position::integer)
              AND incoming.verification_status='confirmed'
              AND outgoing.verification_status='confirmed'
            HAVING count(DISTINCT node.id)=1
          )
          FROM jsonb_array_elements_text(request.route_cable_ids) WITH ORDINALITY pair(cable_id, position)
          WHERE pair.position < jsonb_array_length(request.route_cable_ids)
          ORDER BY pair.position
        ) AS "intermediateNames"
      FROM booking_core_path_requests request
      JOIN network_assets start_node ON start_node.id=request.start_node_id
      JOIN network_assets end_node ON end_node.id=request.end_node_id
    `);
    const pathByBooking = new Map(pathRequests.map((request) => [request.bookingId, request]));
    const { rows: wholeCableAllocations } = isAdmin
      ? await this.db.query<{ bookingId: string; cableId: string; coreNumber: number }>(`
          SELECT allocation.booking_id AS "bookingId", core.asset_id AS "cableId",
            core.core_number AS "coreNumber"
          FROM booking_cores allocation
          JOIN network_cores core ON core.id=allocation.core_id
        `)
      : { rows: [] };
    const { rows: sectionsByBooking } = await this.db.query<{
      bookingId: string; coreId: number; startMeters: number; endMeters: number;
      status: string; cableId: string; cableName: string; coreNumber: number;
    }>(`
      SELECT section.booking_id AS "bookingId",section.core_id::int AS "coreId",
        section.start_m::float8 AS "startMeters",section.end_m::float8 AS "endMeters",
        section.status,core.asset_id AS "cableId",asset.name AS "cableName",core.core_number AS "coreNumber"
      FROM booking_core_sections section
      JOIN network_cores core ON core.id=section.core_id
      JOIN network_assets asset ON asset.id=core.asset_id
    `);
    return Promise.all(rows.map(async (row) => {
      const pathRequest = pathByBooking.get(row.id);
      const waitingRoute = pathRequest && row.status === "Waiting List"
        ? await getRequestedCapacityRoute(this.db, pathRequest)
        : undefined;
      const rowSegments = segments.filter((item) => item.bookingId === row.id).map(({ bookingId: _id, ...item }) => item);
      return {
        ...row,
        segments: rowSegments.length ? rowSegments : [{ segmentId: row.segmentId, cores: row.cores, segmentFrom: "", segmentTo: "", name: row.segmentName, area: row.area }],
        ...(pathRequest ? { pathRequest: {
          startNodeId: pathRequest.startNodeId,
          endNodeId: pathRequest.endNodeId,
          startName: pathRequest.startName,
          needsVerification: false,
          canResubmit: Boolean(waitingRoute?.meetsRequest),
          endName: pathRequest.endName,
          intermediateNames: pathRequest.intermediateNames,
          plannedSplices: isAdmin ? pathRequest.plannedSplices : pathRequest.plannedSplices.map((splice) => ({
            ...splice,
            from: { ...splice.from, coreNumbers: [] },
            to: { ...splice.to, coreNumbers: [] },
          })),
          terminationRecorded: !usesSegmentCapacity(pathRequest.routeKey)
            && sectionsByBooking.some((section) => section.bookingId === row.id),
          cableIds: pathRequest.routeCableIds,
          cableNames: pathRequest.routeCableIds.map((cableId) => rowSegments.find((segment) => segment.segmentId === cableId)?.name ?? cableId),
          requestedCores: pathRequest.requestedCores,
          spanCoreCounts: pathRequest.spanCoreCounts,
          lengthMeters: Number(pathRequest.routeLengthMeters),
          proposedAllocations: isAdmin ? pathRequest.proposedAllocations : [],
          allocatedSections: isAdmin ? sectionsByBooking.filter((section) => section.bookingId === row.id) : [],
          wholeCableAllocations: wholeCableAllocations.filter((allocation) => allocation.bookingId === row.id),
        } } : {}),
      };
    }));
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

  async getBookingPrices() {
    const rows = await this.db.orm.select({ value: appSettings.value }).from(appSettings)
      .where(eq(appSettings.key, "booking_prices"));
    const value = rows[0]?.value as { items?: BookingPrice[] } | undefined;
    return { items: value?.items ?? defaultBookingPrices };
  }

  async setBookingPrices(items: BookingPrice[], userId: string) {
    if (!Array.isArray(items) || items.length > 50 || items.some((item) =>
      !item || typeof item.name !== "string" || !item.name.trim() || item.name.trim().length > 80 ||
      typeof item.unit !== "string" || !item.unit.trim() || item.unit.trim().length > 24 ||
      !Number.isFinite(item.price) || item.price < 0 || item.price > Number.MAX_SAFE_INTEGER || Math.round(item.price * 100) / 100 !== item.price
    )) {
      throw new BadRequestException({ message: "Daftar harga tidak valid; harga harus berupa rupiah bilangan bulat dan tidak negatif." });
    }
    const normalized = items.map((item) => ({ name: item.name.trim(), unit: item.unit.trim(), price: item.price }));
    await this.db.orm.insert(appSettings).values({ key: "booking_prices", value: { items: normalized } })
      .onConflictDoUpdate({ set: { value: sql`EXCLUDED.value` }, target: appSettings.key });
    await this.db.orm.insert(auditLogs).values({ action: "BOOKING_PRICES_UPDATED", actorId: userId, details: { items: normalized }, entityId: "booking_prices", entityType: "SETTING" });
    return { items: normalized };
  }

  async createBooking(input: CreateBookingInput, userId: string) {
    const customer = input.customer?.trim(),
      picCustomer = input.picCustomer?.trim(),
      picPresales = input.picPresales?.trim();
    const segments = input.segments ?? [{ segmentId: input.segmentId ?? "", cores: Number(input.cores) }];
    if (!Array.isArray(segments) || !segments.length || segments.some((item) => !item || typeof item.segmentId !== "string" || !item.segmentId || (item.segmentFrom !== undefined && (typeof item.segmentFrom !== "string" || !item.segmentFrom.trim() || item.segmentFrom.length > 200)) || (item.segmentTo !== undefined && (typeof item.segmentTo !== "string" || !item.segmentTo.trim() || item.segmentTo.length > 200)) || (item.segmentFrom === undefined) !== (item.segmentTo === undefined) || (item.segmentFrom !== undefined && item.segmentFrom === item.segmentTo)) || new Set(segments.map((item) => item.segmentId)).size !== segments.length) {
      throw new BadRequestException({ message: "Pilih segmen unik dengan jumlah core yang valid." });
    }
    const sorted = segments.map((segment) => ({ ...segment })).sort((a, b) => a.segmentId.localeCompare(b.segmentId));
    const segmentId = sorted[0].segmentId;
    const cores = sorted.reduce((sum, item) => sum + item.cores, 0);
    if (
      !(
        customer &&
        picCustomer &&
        picPresales &&
        segments.every((item) => Number.isInteger(item.cores) && item.cores > 0) &&
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
      for (const segment of sorted) {
      const assets = await tx
        .select({ totalCores: networkAssets.totalCores, usageVerified, ends: cableEnds, source: networkAssets.source })
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
      const { ends, source } = assets[0];
      const from = segment.segmentFrom;
      const to = segment.segmentTo;
      const isDirection = (from === "A" && to === "B") || (from === "B" && to === "A");
      if (isDirection && ends) {
        const describe = (side: "A" | "B") => {
          const [longitude, latitude] = ends[side];
          return `Ujung ${side} (${latitude.toFixed(6)}, ${longitude.toFixed(6)})`;
        };
        segment.segmentFrom = describe(from);
        segment.segmentTo = describe(to);
      } else if (isDirection) {
        throw new BadRequestException({
          message: "Pilih dua ujung berbeda dari koordinat kabel yang dipilih.",
        });
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
      }
      // Preserve the established legacy flow: every valid request is reviewed
      // by an admin first; capacity is decided atomically at approval time.
      const status = "Pending Approval";
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
      const pathRows = await client.query<PathRequestRow>(
        `SELECT booking_id AS "bookingId",start_node_id AS "startNodeId",end_node_id AS "endNodeId",
          route_key AS "routeKey",route_cable_ids AS "routeCableIds",requested_cores AS "requestedCores",
          proposed_allocations AS "proposedAllocations",review_fingerprint AS "reviewFingerprint",span_core_counts AS "spanCoreCounts"
         FROM booking_core_path_requests WHERE booking_id=$1 FOR UPDATE`, [id]);
      if (pathRows.rows.length) {
        return approvePathBooking(client, id, userId, booking, pathRows.rows[0]);
      }
      const available: number[] = [];
      let enough = true;
      for (const segment of segments) {
        const { rows: earlierWaiters } = await client.query(
          `SELECT 1
           FROM bookings waiting
           WHERE waiting.status='Waiting List' AND waiting.approved_at IS NOT NULL
             AND waiting.id<>$2
             AND NOT EXISTS (SELECT 1 FROM booking_core_path_requests path WHERE path.booking_id=waiting.id AND path.route_key NOT LIKE 'verify:%')
             AND (
               EXISTS (SELECT 1 FROM booking_segments requested
                 WHERE requested.booking_id=waiting.id AND requested.segment_id=$1
                   AND requested.cores > (
                     SELECT count(*) FROM network_cores core
                     WHERE core.asset_id=$1 AND core.status='Available'
                       AND NOT EXISTS (SELECT 1 FROM booking_core_sections section
                         WHERE section.core_id=core.id AND section.status IN ('Booked','Used'))
                   ))
               OR (waiting.segment_id=$1
                 AND NOT EXISTS (SELECT 1 FROM booking_segments requested WHERE requested.booking_id=waiting.id)
                 AND waiting.cores > (
                   SELECT count(*) FROM network_cores core
                   WHERE core.asset_id=$1 AND core.status='Available'
                     AND NOT EXISTS (SELECT 1 FROM booking_core_sections section
                       WHERE section.core_id=core.id AND section.status IN ('Booked','Used'))
                 ))
             )
           ORDER BY waiting.approved_at,waiting.requested_at,waiting.id
           LIMIT 1`, [segment.segmentId, id]
        );
        if (earlierWaiters.length) {
          enough = false;
          continue;
        }
        const rows = await tx.select({ id: networkCores.id }).from(networkCores)
          .where(and(eq(networkCores.assetId, segment.segmentId), coreAvailableForWholeCable))
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
      const pathRows = await client.query<PathRequestRow>(
        `SELECT booking_id AS "bookingId",start_node_id AS "startNodeId",end_node_id AS "endNodeId",
          route_key AS "routeKey",route_cable_ids AS "routeCableIds",requested_cores AS "requestedCores",
          proposed_allocations AS "proposedAllocations",review_fingerprint AS "reviewFingerprint",span_core_counts AS "spanCoreCounts"
         FROM booking_core_path_requests WHERE booking_id=$1 FOR UPDATE`, [id]);
      if (pathRows.rows.length) {
        const pathRequest = pathRows.rows[0];
        await lockRouteAssets(client, [pathRequest.startNodeId, pathRequest.endNodeId, ...pathRequest.routeCableIds]);
        const route = await getRequestedCapacityRoute(client, pathRequest);
        if (route && !route.meetsRequest) throw new ConflictException({ message: "Kapasitas ruas pada jalur pilihan belum mencukupi." });
        if (!route) {
          throw new ConflictException({ message: "Core yang tersambung pada jalur pilihan belum mencukupi." });
        }
        await client.query(`UPDATE booking_core_path_requests SET proposed_allocations=$2::jsonb,review_fingerprint=$3,route_key=$4,route_length_m=$5 WHERE booking_id=$1`,
          [id, JSON.stringify(route.allocations), allocationFingerprint(route.routeKey, route.allocations), route.routeKey, route.lengthMeters]);
        await tx.update(bookings).set({ status: "Pending Approval", requestedAt: sql`clock_timestamp()`, approvedAt: null, approvedBy: null }).where(eq(bookings.id, id));
        await notifyAdmins(client, "Persetujuan booking core diperlukan", `${booking.customer} mengajukan ulang booking ${id}.`, id);
        await audit(client, userId, "BOOKING_PATH_RESUBMITTED", "BOOKING", id, { routeKey: route.routeKey, allocations: route.allocations });
        return { id, status: "Pending Approval" };
      }
      for (const segment of segments) {
        const available = await tx.select({ id: networkCores.id }).from(networkCores)
          .where(and(eq(networkCores.assetId, segment.segmentId), coreAvailableForWholeCable)).limit(segment.cores);
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
      const pathRequest = await client.query(`SELECT 1 FROM booking_core_sections WHERE booking_id=$1 AND status='Booked'
        AND NOT EXISTS (SELECT 1 FROM booking_cores WHERE booking_id=$1)`, [id]);
      if (pathRequest.rowCount) {
        const allocated = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM booking_core_sections WHERE booking_id=$1 AND status='Booked'`, [id]);
        if (!allocated.rows[0]?.count) throw new ConflictException({ message: "Booking tidak memiliki alokasi bagian core." });
        await tx.update(bookingCoreSections).set({ status: "Used" })
          .where(and(eq(bookingCoreSections.bookingId, id), eq(bookingCoreSections.status, "Booked")));
        await tx.update(bookings).set({ status: "Used", expiresAt: null }).where(eq(bookings.id, id));
        await audit(client, userId, "BOOKING_PO_ISSUED", "BOOKING", id, { cores: booking.cores, sectionAllocations: allocated.rows[0].count });
        await notifyPresales(client, "PO terbit", `PO booking ${id} terbit dan alokasi core pada seluruh jalur ditandai terpakai.`, booking.requestedBy, id);
        return { id, status: "Used" };
      }
      const cores = await tx.select({ id: networkCores.id, status: networkCores.status, segmentId: networkCores.assetId }).from(networkCores)
        .innerJoin(bookingCores, eq(bookingCores.coreId, networkCores.id)).where(eq(bookingCores.bookingId, id)).for("update");
      if (cores.length !== segments.reduce((total, segment) => total + segment.cores, 0) || cores.some((core) => core.status !== "Booked") || segments.some((segment) => cores.filter((core) => core.segmentId === segment.segmentId).length !== segment.cores)) throw new ConflictException({ message: "Alokasi core tidak sesuai; periksa data booking." });
      await tx.update(networkCores).set({ status: "Used" }).where(inArray(networkCores.id, cores.map((core) => core.id)));
      await tx.update(bookingCoreSections)
        .set({ status: "Used" })
        .where(and(eq(bookingCoreSections.bookingId, id), eq(bookingCoreSections.status, "Booked")));
      await tx.update(bookings).set({ status: "Used", expiresAt: null }).where(eq(bookings.id, id));
      await audit(client, userId, "BOOKING_PO_ISSUED", "BOOKING", id, { cores: booking.cores, segmentId: booking.segmentId });
      await notifyPresales(client, "PO terbit", `PO booking ${id} terbit dan core ditandai terpakai.`, booking.requestedBy, id);
      return { id, status: "Used" };
    });
  }

  async releaseBooking(id: string, userId: string, isAdmin = false) {
    return this.db.transaction(async (client) => {
      const tx = drizzle({ client });
      const segments = await lockBookingSegments(client, id);
      const [booking] = await tx
        .select()
        .from(bookings)
        .where(eq(bookings.id, id))
        .for("update");
      if (booking.status !== "Booked" && !(booking.status === "Used" && isAdmin)) {
        throw new ConflictException({
          message: "Booking aktif dapat dilepas; layanan terpakai hanya dapat dilepas oleh admin.",
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
      await tx.update(bookingCoreSections)
        .set({ status: "Released" })
        .where(and(eq(bookingCoreSections.bookingId, id), inArray(bookingCoreSections.status, ["Booked", "Used"])));
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
        await tx.update(bookingCoreSections)
          .set({ status: "Released" })
          .where(and(eq(bookingCoreSections.bookingId, id), eq(bookingCoreSections.status, "Booked")));
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

type PathAllocation = {
  coreId: number;
  cableId: string;
  cableName: string;
  coreNumber: number;
  startMeters: number;
  endMeters: number;
  pathIndex: number;
  spanIndex?: number;
};

type PlannedSplice = {
  nodeId: string;
  nodeName: string;
  from: { cableId: string; cableName: string; coreNumbers: number[] };
  to: { cableId: string; cableName: string; coreNumbers: number[] };
};

type PathRequestRow = {
  bookingId: string;
  startNodeId: string;
  endNodeId: string;
  routeKey: string;
  routeCableIds: string[];
  requestedCores: number;
  spanCoreCounts: number[];
  proposedAllocations: PathAllocation[];
  reviewFingerprint: string;
};

async function approvePathBooking(
  client: PoolClient,
  id: string,
  userId: string,
  booking: typeof bookings.$inferSelect,
  request: PathRequestRow,
) {
  await lockRouteAssets(client, [request.startNodeId, request.endNodeId, ...request.routeCableIds]);
  const route = await getRequestedCapacityRoute(client, request);
  if (!route?.meetsRequest) {
    await client.query("UPDATE bookings SET status='Waiting List',approved_at=NULL,approved_by=NULL,expires_at=NULL WHERE id=$1", [id]);
    await client.query("UPDATE booking_core_path_requests SET proposed_allocations='[]'::jsonb,review_fingerprint=$2 WHERE booking_id=$1",
      [id, allocationFingerprint(request.routeKey, [])]);
    await audit(client, userId, "BOOKING_PATH_CAPACITY_LOST", "BOOKING", id, { routeKey: request.routeKey });
    await notifyPresales(client, "Kapasitas jalur berubah", `Kapasitas ruas pada jalur booking ${id} tidak lagi mencukupi. Booking masuk waiting list.`, booking.requestedBy, id);
    return { id, status: "Waiting List" };
  }

  const fingerprint = allocationFingerprint(route.routeKey, route.allocations);
  if (!usesSegmentCapacity(request.routeKey) && fingerprint !== request.reviewFingerprint) {
    await client.query(`UPDATE booking_core_path_requests SET proposed_allocations=$2::jsonb,review_fingerprint=$3 WHERE booking_id=$1`,
      [id, JSON.stringify(route.allocations), fingerprint]);
    await audit(client, userId, "BOOKING_PATH_REVIEW_REFRESHED", "BOOKING", id, { routeKey: route.routeKey, allocations: route.allocations });
    await notifyPresales(client, "Rincian booking diperbarui", `Rincian core booking ${id} berubah. Admin perlu meninjau nomor core terbaru sebelum menyetujui.`, booking.requestedBy, id);
    return { id, status: "Pending Approval", reviewUpdated: true };
  }

  try {
    for (const allocation of route.allocations) {
      await client.query(`
        INSERT INTO booking_core_sections(booking_id,core_id,start_m,end_m,status)
        VALUES($1,$2,$3,$4,'Booked')
      `, [id, allocation.coreId, allocation.startMeters, allocation.endMeters]);
    }
  } catch (error) {
    if ((error as { code?: string }).code === "23P01" || (error as { code?: string }).code === "23505") {
      throw new ConflictException({ message: "Core jalur baru saja dialokasikan booking lain. Muat ulang rincian dan tinjau kembali." });
    }
    throw error;
  }
  const plannedSplices = route.junctionIds.length
    ? await planBookingSplices(client, route.junctionIds, route.allocations)
    : [];
  await client.query("UPDATE booking_core_path_requests SET planned_splices=$2::jsonb WHERE booking_id=$1",
    [id, JSON.stringify(plannedSplices)]);
  const { rows: settingRows } = await client.query<{ value: string }>("SELECT value FROM app_settings WHERE key='booking_duration_days'");
  const days = Number(settingRows[0]?.value ?? 30);
  await client.query(`
    UPDATE bookings SET status='Booked',approved_at=clock_timestamp(),approved_by=$2,
      expires_at=now()+($3||' days')::interval WHERE id=$1
  `, [id, userId, days]);
  await audit(client, userId, "BOOKING_PATH_APPROVED", "BOOKING", id, {
    cores: request.requestedCores,
    routeKey: route.routeKey,
    allocations: route.allocations,
    plannedSplices,
  });
  await notifyPresales(client, "Booking core disetujui", `Booking ${id} disetujui; ${route.allocations.length} alokasi core dicadangkan pada ${route.cableNames.join(" → ")}.`, booking.requestedBy, id);
  return { id, status: "Booked", allocatedSections: route.allocations.length };
}

async function planBookingSplices(
  db: RouteQueryExecutor, junctionIds: string[], allocations: PathAllocation[]
): Promise<PlannedSplice[]> {
  const { rows } = await db.query<{ id: string; name: string }>(
    "SELECT id,name FROM network_assets WHERE id=ANY($1::text[])", [junctionIds]
  );
  const names = new Map(rows.map((node) => [node.id, node.name]));
  const spans = new Map<number, PathAllocation[]>();
  for (const allocation of allocations) {
    if (allocation.spanIndex === undefined) continue;
    const cores = spans.get(allocation.spanIndex) ?? [];
    cores.push(allocation);
    spans.set(allocation.spanIndex, cores);
  }
  return junctionIds.map((nodeId, index) => {
    const side = (spanIndex: number) => {
      const cores = spans.get(spanIndex);
      if (!cores?.length) throw new Error("Alokasi ruas untuk rencana sambungan belum lengkap.");
      return {
        cableId: cores[0].cableId,
        cableName: cores[0].cableName,
        coreNumbers: [...cores].sort((a, b) => a.pathIndex - b.pathIndex).map((core) => core.coreNumber),
      };
    };
    return { nodeId, nodeName: names.get(nodeId) ?? nodeId, from: side(index), to: side(index + 1) };
  });
}

function allocationFingerprint(routeKey: string, allocations: PathAllocation[]) {
  const canonical = allocations.map((allocation) => ({
    coreId: allocation.coreId,
    cableId: allocation.cableId,
    startMeters: Number(allocation.startMeters.toFixed(3)),
    endMeters: Number(allocation.endMeters.toFixed(3)),
    pathIndex: allocation.pathIndex,
  })).sort((a, b) => a.pathIndex - b.pathIndex || a.cableId.localeCompare(b.cableId) || a.startMeters - b.startMeters);
  return createHash("sha256").update(JSON.stringify({ routeKey, allocations: canonical })).digest("hex");
}

async function lockRouteAssets(client: PoolClient, assetIds: string[]) {
  await client.query("SELECT id FROM network_assets WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE", [[...new Set(assetIds)]]);
}

type RouteQueryExecutor = {
  query: <T extends import("pg").QueryResultRow = import("pg").QueryResultRow>(sqlText: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

async function findBookingMidspanPoints(
  db: RouteQueryExecutor, cableIds: string[], boundaries: (string | null)[]
) {
  const spans = cableIds.map((cableId, index) => ({
    cable_id: cableId, segment_index: index, start_id: boundaries[index], end_id: boundaries[index + 1],
  }));
  const { rows } = await db.query<{
    segmentIndex: number; id: string; name: string;
  }>(`
    WITH spans AS (
      SELECT entry.*, ST_Length(cable.geometry::geography) AS length_m,
        ST_LineLocatePoint(cable.geometry, start_node.geometry) AS start_fraction,
        ST_LineLocatePoint(cable.geometry, end_node.geometry) AS end_fraction
      FROM jsonb_to_recordset($1::jsonb)
        AS entry(cable_id text, segment_index int, start_id text, end_id text)
      JOIN network_assets cable ON cable.id=entry.cable_id
      JOIN network_assets start_node ON start_node.id=entry.start_id
      JOIN network_assets end_node ON end_node.id=entry.end_id
      WHERE GeometryType(cable.geometry)='LINESTRING'
        AND ST_DistanceSphere(cable.geometry, start_node.geometry)<=25
        AND ST_DistanceSphere(cable.geometry, end_node.geometry)<=25
    )
    SELECT span.segment_index AS "segmentIndex", point.id, point.name
    FROM spans span
    JOIN network_cores core ON core.asset_id=span.cable_id
    JOIN network_core_end_connections connection ON connection.core_id=core.id
      AND connection.side='R' AND connection.verification_status='confirmed'
    JOIN network_assets point ON point.id=connection.node_asset_id AND point.asset_type='asset'
      AND upper(point.attributes->>'Tipe Perangkat') IN ('OLT','POP','OTB','ODC','ODP','CLOSURE')
      AND point.id NOT IN (span.start_id,span.end_id)
    WHERE connection.route_measure_m > least(span.start_fraction,span.end_fraction)*span.length_m
      AND connection.route_measure_m < greatest(span.start_fraction,span.end_fraction)*span.length_m
    GROUP BY span.segment_index, point.id, point.name
    ORDER BY span.segment_index,
      min(CASE WHEN span.start_fraction < span.end_fraction
        THEN connection.route_measure_m ELSE -connection.route_measure_m END),
      point.name,point.id
  `, [JSON.stringify(spans)]);
  return rows;
}

// Keep the existing candidate key so waiting bookings can use capacity on their saved route.
function usesSegmentCapacity(routeKey: string) {
  return routeKey.startsWith("verify:");
}

async function allocateCapacitySpans(
  db: RouteQueryExecutor,
  spans: { cableId: string; startMeters: number; endMeters: number }[],
  requested: number,
  spanCoreCounts?: number[]
) {
  const normalized = spans.map((span) => ({
    cable_id: span.cableId,
    start_m: Math.round(span.startMeters * 100) / 100,
    end_m: Math.round(span.endMeters * 100) / 100,
  }));
  const { rows } = await db.query<PathAllocation & { spanIndex: number }>(`
    SELECT (span.ordinality-1)::int AS "spanIndex", core.id::int AS "coreId",
      core.asset_id AS "cableId", asset.name AS "cableName", core.core_number AS "coreNumber",
      span.start_m::float8 AS "startMeters", span.end_m::float8 AS "endMeters"
    FROM ROWS FROM (jsonb_to_recordset($1::jsonb) AS (cable_id text, start_m numeric, end_m numeric))
      WITH ORDINALITY AS span
    JOIN network_cores core ON core.asset_id=span.cable_id AND core.status='Available'
    JOIN network_assets asset ON asset.id=core.asset_id
    WHERE span.end_m > span.start_m AND NOT EXISTS (
      SELECT 1 FROM booking_core_sections section WHERE section.core_id=core.id
        AND section.status IN ('Booked','Used')
        AND section.start_m < span.end_m AND section.end_m > span.start_m
    )
    ORDER BY span.ordinality, core.core_number, core.id
  `, [JSON.stringify(normalized)]);
  const coresBySpan = spans.map((_, index) => rows.filter((row) => row.spanIndex === index));
  const segmentAvailability = coresBySpan.map((cores) => cores.length);
  const availableCores = segmentAvailability.length ? Math.min(...segmentAvailability) : 0;
  const counts = spanCoreCounts ?? spans.map(() => requested);
  const meetsRequest = counts.length === spans.length && segmentAvailability.every((capacity, index) => capacity >= counts[index]);
  const allocations: PathAllocation[] = meetsRequest
    ? coresBySpan.flatMap((cores, index) => cores.slice(0, counts[index]).map((core, pathIndex) => ({ ...core, pathIndex })))
    : [];
  return {
    segmentAvailability,
    availableCores,
    meetsRequest,
    allocations,
  };
}

async function getCapacityRouteOptions(
  db: RouteQueryExecutor, startId: string, endId: string, requested: number,
  confirmed: Awaited<ReturnType<typeof getConfirmedRouteOptions>>["options"],
  preferredRoute?: string,
  spanCoreCounts?: number[],
) {
  const candidates = await getCandidateRoutes(db, startId, endId, requested, candidateCableIds(preferredRoute));
  const options = await Promise.all(candidates.map(async ({ spans, ...route }) => ({
    ...route,
    ...await allocateCapacitySpans(db, spans, requested, route.routeKey === preferredRoute ? spanCoreCounts : undefined),
    needsVerification: false,
  })));
  const byKey = new Map(options.map((route) => [route.routeKey, route]));
  for (const route of confirmed) {
    if (preferredRoute === route.routeKey || !byKey.has(candidateKey(route.cableIds))) {
      byKey.set(route.routeKey, { ...route, junctionIds: [], needsVerification: false,
        segmentAvailability: route.cableIds.map(() => route.availableCores) });
    }
  }
  return [...byKey.values()];
}

async function getRequestedCapacityRoute(
  db: RouteQueryExecutor,
  request: Pick<PathRequestRow, "startNodeId" | "endNodeId" | "requestedCores" | "routeKey" | "spanCoreCounts">
) {
  const { startNodeId, endNodeId, requestedCores, routeKey } = request;
  if (usesSegmentCapacity(routeKey)) {
    const options = await getCapacityRouteOptions(db, startNodeId, endNodeId, requestedCores, [], routeKey, request.spanCoreCounts?.length ? request.spanCoreCounts : undefined);
    return options.find((option) => option.routeKey === routeKey);
  }
  const { options } = await getConfirmedRouteOptions(db, startNodeId, endNodeId, requestedCores);
  const route = options.find((option) => option.routeKey === routeKey);
  return route && { ...route, junctionIds: [] };
}

function candidateKey(cableIds: string[]) {
  return "verify:" + JSON.stringify(cableIds);
}

function candidateCableIds(routeKey?: string): string[] {
  if (typeof routeKey !== "string" || !routeKey.startsWith("verify:") || routeKey.length > 8192) return [];
  try {
    const ids: unknown = JSON.parse(routeKey.slice("verify:".length));
    return Array.isArray(ids) && ids.length <= 100 && ids.every((id) => typeof id === "string") ? ids : [];
  } catch {
    return [];
  }
}

async function loadCandidateCables(db: RouteQueryExecutor, startId: string, endId: string | null) {
  const { rows } = await db.query<{
    id: string; name: string; a: string | null; b: string | null; length: number; available: number;
    access: { node: string; fraction: number }[];
  }>(`
    SELECT cable.id, cable.name, COALESCE(a.node_asset_id, near_a.id) AS a,
      COALESCE(b.node_asset_id, near_b.id) AS b,
      ST_Length(cable.geometry::geography)::float8 AS length,
      (SELECT count(*)::int FROM network_cores core WHERE core.asset_id=cable.id
        AND core.status='Available' AND NOT EXISTS (
          SELECT 1 FROM booking_core_sections section WHERE section.core_id=core.id
            AND section.status IN ('Booked','Used')
        )) AS available,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'node', node.id, 'fraction', ST_LineLocatePoint(cable.geometry,node.geometry)
      )), '[]'::jsonb)
       FROM network_assets node
       WHERE ($2::text IS NULL OR node.id IN ($1,$2)) AND node.asset_type='asset' AND GeometryType(node.geometry)='POINT'
         AND upper(node.attributes->>'Tipe Perangkat') IN ('OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE')
         AND node.geometry && ST_Expand(cable.geometry,0.001)
         AND ST_DistanceSphere(node.geometry,cable.geometry)<=25) AS access
    FROM network_assets cable
    LEFT JOIN network_segment_endpoints a ON a.segment_id=cable.id AND a.side='A'
    LEFT JOIN network_segment_endpoints b ON b.segment_id=cable.id AND b.side='B'
    ${(["A", "B"] as const).map((side) => {
      const alias = side.toLowerCase();
      const point = side === "A" ? "ST_StartPoint" : "ST_EndPoint";
      return `LEFT JOIN LATERAL (
        SELECT node.id FROM network_assets node
        WHERE node.asset_type='asset' AND GeometryType(node.geometry)='POINT'
          AND upper(node.attributes->>'Tipe Perangkat') IN ('OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE')
          AND node.geometry && ST_Expand(${point}(cable.geometry),0.001)
          AND ST_DistanceSphere(node.geometry,${point}(cable.geometry))<=25
        ORDER BY ST_DistanceSphere(node.geometry,${point}(cable.geometry)),node.id LIMIT 1
      ) near_${alias} ON ${alias}.node_asset_id IS NULL`;
    }).join("\n")}
    WHERE cable.asset_type='segment' AND GeometryType(cable.geometry)='LINESTRING'
      AND cable.total_cores>0 AND ST_Length(cable.geometry::geography)>0
    ORDER BY cable.id
  `, [startId, endId]);
  return rows;
}

async function getCandidateRoutes(
  db: RouteQueryExecutor, startId: string, endId: string, requested: number,
  preferredIds: string[],
) {
  const rows = await loadCandidateCables(db, startId, endId);
  type Edge = { id: string; name: string; a: string; b: string; length: number; startMeters: number; endMeters: number };
  const edges: Edge[] = [];
  for (const { id, name, a, b, length, access } of rows) {
    const points = [...(a ? [{ node: a, fraction: 0 }] : []), ...(b ? [{ node: b, fraction: 1 }] : [])];
    for (const point of access ?? []) {
      if (points.some(({ node }) => node === point.node)) continue;
      const measure = point.fraction * length;
      if (measure > 25 && measure < length - 25) points.push(point);
    }
    for (const [index, from] of points.entries()) {
      for (const to of points.slice(index + 1)) {
        const distance = Math.abs(to.fraction - from.fraction) * length;
        if (from.node !== to.node && distance > 0) edges.push({ id, name, a: from.node, b: to.node, length: distance,
          startMeters: Math.min(from.fraction, to.fraction) * length,
          endMeters: Math.max(from.fraction, to.fraction) * length });
      }
    }
  }
  const adjacent = new Map<string, Edge[]>();
  for (const cable of edges) {
    for (const node of [cable.a, cable.b]) {
      const edges = adjacent.get(node) ?? [];
      edges.push(cable);
      adjacent.set(node, edges);
    }
  }
  const capacity = new Map(rows.map((cable) => [cable.id, cable.available]));
  const findRoute = (eligibleEdges: Set<Edge> | null, orderedIds: string[] = []) => {
    const queue = [{ node: startId, cables: [] as Edge[], junctionIds: [] as string[], length: 0, cableCount: 0 }];
    const visited = new Set<string>();
    while (queue.length) {
      queue.sort((a, b) => a.length - b.length);
      const current = queue.shift()!;
      const state = orderedIds.length ? JSON.stringify([current.node, current.cableCount]) : current.node;
      if (visited.has(state)) continue;
      visited.add(state);
      if (current.node === endId) {
        if (orderedIds.length && current.cableCount !== orderedIds.length) continue;
        const cables = current.cables.filter((cable, index, all) => index === 0 || cable.id !== all[index - 1].id);
        const cableIds = cables.map((cable) => cable.id);
        const spans = current.cables.reduce<{ cableId: string; startMeters: number; endMeters: number }[]>((parts, edge) => {
          const last = parts.at(-1);
          if (last?.cableId === edge.id) {
            last.startMeters = Math.min(last.startMeters, edge.startMeters);
            last.endMeters = Math.max(last.endMeters, edge.endMeters);
          } else parts.push({ cableId: edge.id, startMeters: edge.startMeters, endMeters: edge.endMeters });
          return parts;
        }, []);
        return {
          spans,
          junctionIds: current.junctionIds,
          routeKey: candidateKey(cableIds), cableIds,
          cableNames: cables.map((cable) => cable.name),
          lengthMeters: current.length, availableCores: 0, meetsRequest: false,
          needsVerification: true, allocations: [] as PathAllocation[],
        };
      }
      for (const cable of adjacent.get(current.node) ?? []) {
        if (eligibleEdges && !eligibleEdges.has(cable)) continue;
        const node = cable.a === current.node ? cable.b : cable.a;
        const sameCable = cable.id === current.cables.at(-1)?.id;
        const cableCount = current.cableCount + (sameCable ? 0 : 1);
        if (orderedIds.length && orderedIds[cableCount - 1] !== cable.id) continue;
        const junctionIds = !sameCable && current.cableCount > 0
          ? [...current.junctionIds, current.node]
          : current.junctionIds;
        queue.push({ node, cables: [...current.cables, cable], junctionIds, length: current.length + cable.length, cableCount });
      }
    }
    return null;
  };
  const primary = findRoute(null);
  if (!primary) return [];
  let alternative: ReturnType<typeof findRoute> = null;
  if (primary.cableIds.some((id) => (capacity.get(id) ?? 0) < requested)) {
    const edgeCapacity = await allocateCapacitySpans(db, edges.map((edge) => ({
      cableId: edge.id, startMeters: edge.startMeters, endMeters: edge.endMeters,
    })), requested);
    alternative = findRoute(new Set(edges.filter((_, index) => edgeCapacity.segmentAvailability[index] >= requested)));
  }
  const preferred = preferredIds.length ? findRoute(null, preferredIds) : null;
  return [primary, alternative, preferred].filter((route) => route !== null);
}

async function getConfirmedRouteOptions(queryable: RouteQueryExecutor, startId: string, endId: string, requested: number) {
  const { rows: topologyCores } = await queryable.query<{
    coreId: number; cableId: string; cableName: string; coreNumber: number; lengthMeters: number; available: boolean;
  }>(`
    SELECT core.id::int AS "coreId",core.asset_id AS "cableId",asset.name AS "cableName",
      core.core_number AS "coreNumber",ST_Length(asset.geometry::geography)::float8 AS "lengthMeters",
      (core.status='Available') AS available
    FROM network_cores core JOIN network_assets asset ON asset.id=core.asset_id
    WHERE asset.asset_type='segment' AND GeometryType(asset.geometry)='LINESTRING'
      AND ST_Length(asset.geometry::geography)>0
      AND (asset.source='managed' OR asset.attributes->'__coreUsageVerification'->'verified'='true'::jsonb
        OR asset.attributes->'__coreUsageVerified'='true'::jsonb)
    ORDER BY core.asset_id,core.core_number
  `);
  const { rows: connections } = await queryable.query<RecordedCoreConnection>(`
    SELECT e.core_id::int AS "coreId",e.side,e.route_measure_m::float8 AS "positionMeters",
      e.route_physical_side AS "physicalSide",e.node_asset_id AS "nodeId",e.connection_type AS type,
      e.connection_group_id AS "groupId",(e.verification_status='confirmed') AS confirmed,
      e.peer_core_id::int AS "peerCoreId",e.peer_side AS "peerSide",
      e.peer_route_measure_m::float8 AS "peerPositionMeters",e.peer_route_physical_side AS "peerPhysicalSide"
    FROM network_core_end_connections e JOIN network_cores c ON c.id=e.core_id
  `);
  const { rows: allocations } = await queryable.query<{ coreId: number; startMeters: number; endMeters: number }>(`
    SELECT core_id::int AS "coreId",start_m::float8 AS "startMeters",end_m::float8 AS "endMeters"
    FROM booking_core_sections WHERE status IN ('Booked','Used')
  `);
  const topology = buildRecordedTopology(topologyCores, connections, allocations);
  const paths = findCorePaths(
    topology.sections.map((section) => ({ ...section, available: true })),
    topology.links, topology.endpointsByNode.get(startId) ?? [],
    topology.endpointsByNode.get(endId) ?? [], 1000,
  );
  const options = groupCorePaths(paths);
  const availableSections = new Set(topology.sections.filter((section) => section.available).map((section) => section.id));
  const coreById = new Map<number, (typeof topologyCores)[number]>(topologyCores.map((core) => [core.coreId, core]));
  return {
    truncated: paths.length === 1000,
    options: options.map((option) => {
      const availablePaths = option.paths.filter((path) => path.sections.every((section) => availableSections.has(section.id)));
      const selectedPaths = selectDisjointCorePaths(availablePaths, requested);
      const selected = selectedPaths ?? [];
      let pathCount = selectedPaths ? requested : 0;
      let upper = Math.min(requested - 1, availablePaths.length);
      while (pathCount < upper) {
        const candidate = Math.ceil((pathCount + upper) / 2);
        if (selectDisjointCorePaths(availablePaths, candidate)) pathCount = candidate;
        else upper = candidate - 1;
      }
      const detailedAllocations: PathAllocation[] = selected.flatMap((path, pathIndex) => path.sections.map((section) => {
        const core = coreById.get(section.coreId);
        if (!core || section.startMeters === undefined || section.endMeters === undefined) throw new Error("Rincian bagian core tidak lengkap.");
        return { coreId: section.coreId, cableId: section.cableId, cableName: core.cableName, coreNumber: core.coreNumber,
          startMeters: section.startMeters, endMeters: section.endMeters, pathIndex };
      }));
      const cableNames = option.cableIds.map((cableId) => topologyCores.find((core) => core.cableId === cableId)?.cableName ?? cableId);
      return {
        routeKey: option.routeKey,
        cableIds: option.cableIds,
        cableNames,
        lengthMeters: option.lengthMeters,
        availableCores: pathCount,
        meetsRequest: Boolean(selectedPaths),
        allocations: selectedPaths ? detailedAllocations : [],
      };
    }),
  };
}

async function lockBookingSegments(client: PoolClient, id: string) {
  const { rows } = await client.query<{ segmentId: string; cores: number }>(
    `SELECT segment_id AS "segmentId", cores FROM booking_segments WHERE booking_id=$1
     UNION ALL SELECT segment_id, cores FROM bookings WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM booking_segments WHERE booking_id=$1)
     ORDER BY "segmentId"`, [id]);
  if (!rows.length) throw new NotFoundException({ message: "Booking tidak ditemukan." });
  const path = await client.query<{ startNodeId: string; endNodeId: string }>(
    "SELECT start_node_id AS \"startNodeId\",end_node_id AS \"endNodeId\" FROM booking_core_path_requests WHERE booking_id=$1", [id]);
  const assetIds = [...rows.map((row) => row.segmentId), ...(path.rows[0] ? [path.rows[0].startNodeId, path.rows[0].endNodeId] : [])];
  await client.query('SELECT id FROM network_assets WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [[...new Set(assetIds)]]);
  return rows;
}

export async function allocateWaiting(client: PoolClient, segmentId: string, _actorId: string | null = null, notified = new Set<string>()) {
  // Callers may already hold a single segment lock; do not lock waiting bookings here.
  const { rows } = await client.query<{ id: string; customer: string; requestedBy: string }>(`
    SELECT b.id,b.customer,b.requested_by AS "requestedBy"
    FROM bookings b
    WHERE b.status='Waiting List' AND b.requested_by IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM booking_core_path_requests path_request WHERE path_request.booking_id=b.id)
      AND (EXISTS (SELECT 1 FROM booking_segments s WHERE s.booking_id=b.id AND s.segment_id=$1)
           OR (b.segment_id=$1 AND NOT EXISTS (SELECT 1 FROM booking_segments s WHERE s.booking_id=b.id)))
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT s.segment_id,s.cores FROM booking_segments s WHERE s.booking_id=b.id
          UNION ALL SELECT b.segment_id,b.cores WHERE NOT EXISTS (SELECT 1 FROM booking_segments s WHERE s.booking_id=b.id)
        ) requested WHERE (SELECT count(*) FROM network_cores c
          WHERE c.asset_id=requested.segment_id AND c.status='Available'
            AND NOT EXISTS (SELECT 1 FROM booking_core_sections section
              WHERE section.core_id=c.id AND section.status IN ('Booked', 'Used'))) < requested.cores
      )`, [segmentId]);
  for (const booking of rows) {
    if (notified.has(booking.id)) continue;
    notified.add(booking.id);
    await client.query(
    `INSERT INTO notifications(user_id,title,message,booking_id) VALUES($1,$2,$3,$4)`,
    [booking.requestedBy, "Core tersedia untuk waiting list", `${booking.customer}: core tersedia di semua segmen. Ajukan ulang booking ${booking.id} untuk persetujuan ADMIN.`, booking.id]
    );
  }
  const { rows: routeWaiters } = await client.query<{
    id: string; customer: string; requestedBy: string; startNodeId: string;
    endNodeId: string; requestedCores: number; routeKey: string; spanCoreCounts: number[];
  }>(`
    SELECT booking.id,booking.customer,booking.requested_by AS "requestedBy",
      request.start_node_id AS "startNodeId",request.end_node_id AS "endNodeId",
      request.requested_cores AS "requestedCores",request.route_key AS "routeKey",request.span_core_counts AS "spanCoreCounts"
    FROM bookings booking JOIN booking_core_path_requests request ON request.booking_id=booking.id
    WHERE booking.status='Waiting List' AND booking.requested_by IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(request.route_cable_ids) cable(id) WHERE cable.id=ANY($1::text[]))
    ORDER BY booking.requested_at,booking.id
  `, [[segmentId]]);
  for (const waiter of routeWaiters) {
    if (notified.has(waiter.id)) continue;
    const route = await getRequestedCapacityRoute(client, waiter);
    if (!route?.meetsRequest) continue;
    notified.add(waiter.id);
    await client.query(
      `INSERT INTO notifications(user_id,title,message,booking_id) VALUES($1,$2,$3,$4)`,
      [waiter.requestedBy, "Kapasitas jalur tersedia", `${waiter.customer}: kapasitas cukup pada semua ruas jalur pilihan. Ajukan ulang booking ${waiter.id} untuk persetujuan ADMIN.`, waiter.id]
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
