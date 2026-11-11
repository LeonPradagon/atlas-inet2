import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { gps } from "exifr";
import type { PoolClient } from "pg";
import { allocateWaiting, BookingService } from "../booking/booking.service";
import { audit } from "../database/audit";
import { Database } from "../database/database";
import provinceBoundaries from "../database/regions/province-boundaries.json";

type AssetRecord = {
  id: string;
  name: string;
  area: string;
  assetType: string;
  source: string;
  cableType: string;
  installation: string;
  side: string;
  pole: string;
  poleHeight: string | null;
  odc: string;
  odp: string;
  totalCores: number;
  usedCores: number;
  bookedCores: number;
  idleCores: number;
  geometry: unknown;
  attributes: Record<string, unknown>;
  createdAt: string;
};
type CorePosition = "A" | "B" | "R";
type CoreEndConnectionInput =
  | {
      connectionType: "splice";
      peerSegmentId: string;
      peerCoreNumber: number;
      peerSide: CorePosition;
      peerRouteMeasureM?: number;
    }
  | { connectionType: "termination" }
  | { connectionType: "device_port"; portReference: string }
  | null;
type MidspanConnectionInput = {
  nodeAssetId: string;
  routeMeasureM: number;
  connection: Exclude<CoreEndConnectionInput, null>;
};
type CoreStatusUpdate = {
  coreNumber: number;
  status: string;
  endConnections?: Partial<Record<"A" | "B", CoreEndConnectionInput>>;
  midspanConnections?: MidspanConnectionInput[];
};
type SegmentEndpointUpdate = Partial<Record<"A" | "B", string | null>>;
// Imports created before package IDs were stored share their transaction timestamp with the audit entry.
const assetImportId = `COALESCE(a.attributes->>'__atlasImportId', (SELECT legacy.entity_id FROM audit_logs legacy
  WHERE legacy.action='NETWORK_IMPORTED' AND legacy.entity_type='NETWORK_IMPORT'
    AND legacy.details->>'source'='kml/kmz' AND legacy.created_at=a.created_at AND a.source='kml'
  ORDER BY legacy.id LIMIT 1))`;
const provinceMatch = (provinceParam: number) =>
  `a.attributes->>'__atlasProvinceCode'=$${provinceParam}`;
type RegionName = {
  provinceCode: string;
  name: string;
  level: number;
};
type KmzProvinceAsset = {
  id: string;
  name: string;
  area: string;
  folderPath: string;
};
type KmzProvinceBoundary = {
  provinceCode: string;
  provinceName: string;
  geometry: unknown;
};
const normalizeRegionText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("id-ID")
    .replace(
      /\b(provinsi|province|kabupaten|kab\.?|kota|kotamadya|kecamatan|district|desa|kelurahan)\b/gu,
      " "
    )
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
const kmzGroup = (path: string) => {
  const folders = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const popIndex = folders.findIndex((part) => /^POP\s+/iu.test(part));
  if (popIndex >= 0) {
    return folders[popIndex].replace(/^POP\s+/iu, "").trim();
  }
  const boundaryIndex = folders.findIndex(
    (part) =>
      normalizeRegionText(part) === "full boundry" ||
      normalizeRegionText(part) === "full boundary"
  );
  if (boundaryIndex >= 0 && folders[boundaryIndex + 1]) {
    return folders[boundaryIndex + 1];
  }
  return folders[1] ?? folders[0] ?? "";
};
@Injectable()
export class AtlasService {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(BookingService) private readonly booking: BookingService
  ) {}
  async recordAudit(
    actorId: string | null,
    action: string,
    details: Record<string, unknown>
  ) {
    await this.db.transaction((client) =>
      audit(client, actorId, action, "PROCESS", null, details)
    );
  }
  async surveyCandidates(userId: string) {
    const { rows } = await this.db.query(
      `WITH candidates AS (
      SELECT h.id AS "historyId",0 AS "rowNumber",h.title AS address,h.result AS analysis,h.created_at
      FROM analysis_history h WHERE h.user_id=$1 AND h.analysis_type='ADDRESS' AND h.result->'network'->>'id' IS NOT NULL
      UNION ALL
      SELECT h.id,r.row_number,COALESCE(r.input->>'address',h.title || ' · Baris ' || r.row_number),r.result,h.created_at
      FROM analysis_history h JOIN analysis_bulk_jobs j ON j.history_id=h.id JOIN analysis_bulk_job_rows r ON r.job_id=j.id
      WHERE h.user_id=$1 AND r.result->'network'->>'id' IS NOT NULL
    ) SELECT * FROM candidates c WHERE NOT EXISTS(SELECT 1 FROM network_surveys s WHERE s.requested_by=$1 AND s.history_id=c."historyId" AND s.row_number=c."rowNumber") ORDER BY created_at DESC LIMIT 500`,
      [userId]
    );
    return rows;
  }
  async listSurveys(userId: string, admin: boolean) {
    return (
      await this.db.query(
        `SELECT s.*,u.name AS requester FROM network_surveys s LEFT JOIN "user" u ON u.id=s.requested_by WHERE ($2::boolean OR s.requested_by=$1) ORDER BY s.updated_at DESC`,
        [userId, admin]
      )
    ).rows;
  }
  async createSurvey(
    userId: string,
    historyId: string,
    rowNumber: number,
    proposal?: unknown,
    plan?: unknown
  ) {
    if (
      !(/^[0-9a-f-]{36}$/iu.test(historyId) && Number.isInteger(rowNumber)) ||
      rowNumber < 0
    ) {
      throw new BadRequestException({
        message: "Referensi analisis tidak valid.",
      });
    }
    const { rows: candidates } = await this.db.query(
      `SELECT h.title AS address,h.result AS analysis FROM analysis_history h WHERE h.id=$1 AND h.user_id=$2 AND h.analysis_type='ADDRESS' AND $3=0
      UNION ALL SELECT COALESCE(r.input->>'address',h.title),r.result FROM analysis_history h JOIN analysis_bulk_jobs j ON j.history_id=h.id JOIN analysis_bulk_job_rows r ON r.job_id=j.id WHERE h.id=$1 AND h.user_id=$2 AND r.row_number=$3`,
      [historyId, userId, rowNumber]
    );
    const candidate = candidates[0];
    if (!candidate) {
      throw new BadRequestException({
        message: "Hasil analisis tidak tersedia atau sudah diajukan.",
      });
    }
    if (
      !(
        (candidate.analysis?.network?.id || proposal) &&
        Number.isFinite(candidate.analysis.latitude) &&
        Number.isFinite(candidate.analysis.longitude)
      )
    ) {
      throw new BadRequestException({
        message:
          "Ajukan survei dari hasil yang sudah menemukan jaringan dan koordinat.",
      });
    }
    if (proposal !== undefined && proposal !== null) {
      const value = proposal as Record<string, unknown>;
      if (
        !value ||
        typeof value !== "object" ||
        !["ODP", "ODC", "JOINT_CLOSURE", "OTB"].includes(String(value.kind)) ||
        typeof value.latitude !== "number" ||
        !Number.isFinite(value.latitude) ||
        Math.abs(value.latitude) > 90 ||
        typeof value.longitude !== "number" ||
        !Number.isFinite(value.longitude) ||
        Math.abs(value.longitude) > 180 ||
        value.latitude !== candidate.analysis.latitude ||
        value.longitude !== candidate.analysis.longitude ||
        !Number.isInteger(value.cores) ||
        Number(value.cores) < 1 ||
        Number(value.cores) > 4096
      ) {
        throw new BadRequestException({
          message: "Usulan terminasi atau jumlah core tidak valid.",
        });
      }
      candidate.analysis.proposal = {
        cores: value.cores,
        kind: value.kind,
        latitude: value.latitude,
        longitude: value.longitude,
      };
    }
    if (plan !== undefined && plan !== null) {
      const value = plan as {
        targetId?: unknown;
        points?: unknown;
        cables?: unknown;
      };
      const validPoint = (point: unknown) => {
        if (!point || typeof point !== "object") {
          return false;
        }
        const item = point as Record<string, unknown>;
        return (
          ["ODP", "ODC", "JOINT_CLOSURE", "OTB"].includes(String(item.kind)) &&
          typeof item.longitude === "number" &&
          Number.isFinite(item.longitude) &&
          Math.abs(item.longitude) <= 180 &&
          typeof item.latitude === "number" &&
          Number.isFinite(item.latitude) &&
          Math.abs(item.latitude) <= 90
        );
      };
      const validCable = (cable: unknown) => {
        if (!cable || typeof cable !== "object") {
          return false;
        }
        const item = cable as Record<string, unknown>;
        const geometry = item.geometry as
          | { type?: unknown; coordinates?: unknown }
          | undefined;
        return (
          ["Distribusi", "Feeder", "Backbone", "Drop"].includes(
            String(item.type)
          ) &&
          (item.cores === null ||
            (Number.isInteger(item.cores) &&
              Number(item.cores) > 0 &&
              Number(item.cores) <= 4096)) &&
          typeof item.distanceMeters === "number" &&
          Number.isFinite(item.distanceMeters) &&
          item.distanceMeters >= 0 &&
          geometry?.type === "LineString" &&
          Array.isArray(geometry.coordinates) &&
          geometry.coordinates.length >= 2 &&
          geometry.coordinates.length <= 10_000 &&
          geometry.coordinates.every(
            (coordinate: unknown) =>
              Array.isArray(coordinate) &&
              coordinate.length >= 2 &&
              typeof coordinate[0] === "number" &&
              Number.isFinite(coordinate[0]) &&
              Math.abs(coordinate[0]) <= 180 &&
              typeof coordinate[1] === "number" &&
              Number.isFinite(coordinate[1]) &&
              Math.abs(coordinate[1]) <= 90
          )
        );
      };
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.targetId !== "string" ||
        !value.targetId ||
        value.targetId !== candidate.analysis.network?.id ||
        !Array.isArray(value.points) ||
        value.points.length > 8 ||
        !value.points.every(validPoint) ||
        !Array.isArray(value.cables) ||
        value.cables.length !== value.points.length + 1 ||
        !value.cables.every(validCable)
      ) {
        throw new BadRequestException({
          message: "Rencana terminasi atau kabel tidak valid.",
        });
      }
      const {
        deviceCandidates: _clientDeviceCandidates,
        upstreamRecommendation: _clientUpstreamRecommendation,
        deviceRecommendation: _clientDeviceRecommendation,
        sourceCable: _clientSourceCable,
        connectionCandidates: _clientConnectionCandidates,
        connectionCandidatesIncomplete: _clientConnectionCandidatesIncomplete,
        routeEvidence: _clientRouteEvidence,
        routeEvidenceIncomplete: _clientRouteEvidenceIncomplete,
        requirement: _clientRequirement,
        odpDemands: clientOdpDemands,
        ...validatedPlan
      } = value as typeof value & {
        deviceCandidates?: unknown;
        upstreamRecommendation?: unknown;
        deviceRecommendation?: unknown;
        sourceCable?: unknown;
        connectionCandidates?: unknown;
        connectionCandidatesIncomplete?: unknown;
        routeEvidence?: unknown;
        routeEvidenceIncomplete?: unknown;
        requirement?: unknown;
        odpDemands?: unknown;
      };
      const savedPlan = candidate.analysis.terminationPlan;
      if (clientOdpDemands !== undefined) {
        const points = Array.isArray(savedPlan?.deviceCandidates) ? savedPlan.deviceCandidates.filter((point: { kind?: string }) => point.kind !== "Tiang") : [];
        const allowed = new Set(points.flatMap((point: { kind?: string; basis?: string }, index: number) => point.kind === "ODP" && point.basis === "PLANNING" ? [`Simulasi ODP ${String(index + 1).padStart(2, "0")}`] : []));
        if (!clientOdpDemands || typeof clientOdpDemands !== "object" || Array.isArray(clientOdpDemands) || !savedPlan) throw new BadRequestException({ message: "Kebutuhan ODP tidak valid." });
        const entries = Object.entries(clientOdpDemands);
        const total = entries.reduce((sum, [, count]) => sum + (typeof count === "number" ? count : 0), Number(savedPlan.requirement?.requiredCores ?? 0));
        if (entries.length > allowed.size || entries.some(([name, count]) => !allowed.has(name) || !Number.isSafeInteger(count) || Number(count) < 0 || Number(count) > 4096) || total > 4096) throw new BadRequestException({ message: "Kebutuhan ODP tidak valid." });
        candidate.analysis.terminationPlan = { ...savedPlan, odpDemands: Object.fromEntries(entries) };
      } else {
        candidate.analysis.terminationPlan = savedPlan ?? validatedPlan;
      }
    }
    return this.db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `survey:${userId}`,
      ]);
      const { rows: duplicates } = await client.query(
        `SELECT id FROM network_surveys WHERE requested_by=$1 AND ((history_id=$2 AND row_number=$3) OR (analysis->'network'->>'id'=$4 AND round((analysis->>'latitude')::numeric,6)=$5::numeric AND round((analysis->>'longitude')::numeric,6)=$6::numeric)) LIMIT 1`,
        [
          userId,
          historyId,
          rowNumber,
          candidate.analysis.network?.id ?? null,
          candidate.analysis.latitude.toFixed(6),
          candidate.analysis.longitude.toFixed(6),
        ]
      );
      if (duplicates.length) {
        throw new ConflictException({
          message:
            "Lokasi dan jaringan ini sudah diajukan survei. Buka pengajuan sebelumnya di menu Survei & Verifikasi.",
        });
      }
      const { rows } = await client.query(
        "INSERT INTO network_surveys(requested_by,history_id,row_number,address,analysis) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING id",
        [
          userId,
          historyId,
          rowNumber,
          candidate.address,
          JSON.stringify(candidate.analysis),
        ]
      );
      if (!rows.length) {
        throw new ConflictException({ message: "Survei sudah diajukan." });
      }
      await audit(client, userId, "SURVEY_REQUESTED", "SURVEY", rows[0].id, {
        historyId,
        rowNumber,
      });
      return rows[0];
    });
  }
  async updateSurvey(
    userId: string,
    admin: boolean,
    id: string,
    body: Record<string, unknown>
  ) {
    const status = String(body.status ?? "");
    const allowed: Record<string, string[]> = {
      IN_PROGRESS: ["IN_PROGRESS", "REVIEW"],
      REVIEW: ["VERIFIED", "REVISION"],
      REVISION: ["IN_PROGRESS"],
      WAITING: ["IN_PROGRESS"],
    };
    return this.db.transaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM network_surveys WHERE id=$1 AND ($3::boolean OR requested_by=$2) FOR UPDATE",
        [id, userId, admin]
      );
      const survey = rows[0];
      if (!survey) {
        throw new NotFoundException({ message: "Survei tidak ditemukan." });
      }
      if (
        !allowed[survey.status]?.includes(status) ||
        (["VERIFIED", "REVISION"].includes(status) && !admin)
      ) {
        throw new BadRequestException({
          message: "Perubahan status tidak diizinkan.",
        });
      }
      const findings: Record<string, string> = {};
      for (const key of [
        "connection",
        "route",
        "length",
        "capacity",
        "evidence",
        "notes",
      ]) {
        findings[key] = String(body[key] ?? survey.findings[key] ?? "")
          .trim()
          .slice(0, 2000);
      }
      const image = body.image ?? survey.findings.image ?? "";
      let imageLatitude = String(survey.findings.imageLatitude ?? "");
      let imageLongitude = String(survey.findings.imageLongitude ?? "");
      if (typeof image !== "string") {
        throw new BadRequestException({
          message: "Gambar survei tidak valid.",
        });
      }
      if (image) {
        if (image.length > 2_796_230) {
          throw new BadRequestException({
            message: "Ukuran gambar maksimal 2 MB.",
          });
        }
        const match =
          /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
            image
          );
        const data = match ? Buffer.from(match[2], "base64") : null;
        const valid =
          data &&
          data.length <= 2 * 1024 * 1024 &&
          ((match?.[1] === "jpeg" &&
            data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) ||
            (match?.[1] === "png" &&
              data
                .subarray(0, 8)
                .equals(
                  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
                )) ||
            (match?.[1] === "webp" &&
              data.subarray(0, 4).toString() === "RIFF" &&
              data.subarray(8, 12).toString() === "WEBP"));
        if (!valid) {
          throw new BadRequestException({
            message:
              "Gambar harus JPG, PNG, atau WebP dengan ukuran maksimal 2 MB.",
          });
        }
        if (image !== survey.findings.image) {
          const location = await gps(data).catch(() => undefined);
          if (
            !location ||
            !Number.isFinite(location.latitude) ||
            !Number.isFinite(location.longitude) ||
            Math.abs(location.latitude) > 90 ||
            Math.abs(location.longitude) > 180
          ) {
            throw new BadRequestException({
              message:
                "Foto harus memiliki koordinat GPS. Aktifkan lokasi pada kamera dan unggah foto asli.",
            });
          }
          imageLatitude = String(location.latitude);
          imageLongitude = String(location.longitude);
        }
      } else {
        imageLatitude = "";
        imageLongitude = "";
      }
      findings.image = image;
      findings.imageLatitude = imageLatitude;
      findings.imageLongitude = imageLongitude;
      if (
        ["REVIEW", "VERIFIED"].includes(status) &&
        ["connection", "route", "length", "capacity", "evidence"].some(
          (key) => !findings[key]
        )
      ) {
        throw new BadRequestException({
          message:
            "Isi titik sambungan, jalur, panjang aktual, kapasitas, dan referensi bukti survei.",
        });
      }
      if (
        ["REVIEW", "VERIFIED"].includes(status) &&
        (!Number.isFinite(Number(findings.length)) ||
          Number(findings.length) <= 0)
      ) {
        throw new BadRequestException({
          message: "Panjang aktual harus berupa angka meter lebih dari nol.",
        });
      }
      if (status === "REVISION" && !findings.notes) {
        throw new BadRequestException({ message: "Isi alasan revisi." });
      }
      await client.query(
        `UPDATE network_surveys SET status=$2,findings=$3::jsonb,verified_by=CASE WHEN $2='VERIFIED' THEN $4 ELSE NULL END,verified_at=CASE WHEN $2='VERIFIED' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1`,
        [id, status, JSON.stringify(findings), userId]
      );
      await audit(client, userId, "SURVEY_STATUS_CHANGED", "SURVEY", id, {
        findings: { ...findings, image: image ? "[gambar terlampir]" : "" },
        from: survey.status,
        to: status,
      });
      return { id, status };
    });
  }
  async recordApiRequest(
    actorId: string | null,
    method: string,
    path: string,
    statusCode: number,
    durationMs: number
  ) {
    const action = statusCode >= 400 ? "API_REQUEST_FAILED" : "API_REQUEST";
    await this.db.transaction((client) =>
      audit(client, actorId, action, "API", `${method} ${path}`, {
        durationMs,
        method,
        path,
        statusCode,
      })
    );
  }
  async saveAnalysisHistory(
    userId: string,
    type: "ADDRESS" | "BULK",
    title: string,
    input: unknown,
    result: unknown
  ) {
    return this.db.transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO analysis_history(user_id,analysis_type,title,input,result)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
      RETURNING id`,
        [
          userId,
          type,
          title.slice(0, 300),
          JSON.stringify(input),
          JSON.stringify(result),
        ]
      );
      const id = rows[0].id as string;
      const payload =
        result && typeof result === "object"
          ? (result as {
              status?: string;
              rows?: {
                status?: string;
              }[];
            })
          : {};
      const statusCounts = (payload.rows ?? []).reduce<Record<string, number>>(
        (counts, row) => {
          const status = row.status ?? "UNKNOWN";
          counts[status] = (counts[status] ?? 0) + 1;
          return counts;
        },
        {}
      );
      const details =
        type === "BULK"
          ? { rowCount: payload.rows?.length ?? 0, statusCounts }
          : { status: payload.status ?? "COMPLETED" };
      await audit(
        client,
        userId,
        type === "BULK"
          ? "BULK_ANALYSIS_COMPLETED"
          : "ADDRESS_ANALYSIS_COMPLETED",
        "ANALYSIS_HISTORY",
        id,
        details
      );
      return id;
    });
  }
  async listAnalysisHistory(
    userId: string,
    type?: "ADDRESS" | "BULK" | "FTTH_DESIGN",
    page = 1,
    pageSize = 25
  ) {
    const { rows } = await this.db.query(
      `WITH filtered AS (
        SELECT h.id,h.analysis_type AS "analysisType",h.title,h.result->>'status' AS status,
          CASE WHEN h.analysis_type='BULK' THEN COALESCE(j.total_rows,jsonb_array_length(COALESCE(h.result->'rows','[]'::jsonb)))
               WHEN h.analysis_type='FTTH_DESIGN' THEN COALESCE((h.result->>'savedCount')::int,0)
               ELSE 1 END AS "itemCount",
          h.created_at AS "createdAt",j.id AS "bulkJobId",j.status AS "jobStatus",j.processed_rows AS "processedRows",
          j.succeeded_rows AS "succeededRows",j.failed_rows AS "failedRows"
        FROM analysis_history h LEFT JOIN analysis_bulk_jobs j ON j.history_id=h.id
        WHERE h.user_id=$1 AND ($2::text IS NULL OR h.analysis_type=$2)
          AND NOT (h.analysis_type='FTTH_DESIGN' AND EXISTS (
            SELECT 1 FROM analysis_history a
            WHERE a.user_id=h.user_id AND a.analysis_type IN ('ADDRESS','BULK')
              AND (h.input->>'sourceAnalysisId'=a.id::text OR (a.analysis_type='ADDRESS' AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(COALESCE(h.result->'features','[]'::jsonb)) f
                CROSS JOIN LATERAL (SELECT CASE WHEN f->>'kind'='OLT' THEN f->'geometry'->'coordinates'
                  ELSE f->'geometry'->'coordinates'->0 END AS point) p
                WHERE (f->>'kind'='OLT' OR (f->>'kind'='ROUTE' AND f->>'routeType'='FEEDER'))
                  AND jsonb_typeof(p.point)='array' AND jsonb_array_length(p.point)>=2
                  AND ST_DistanceSphere(ST_MakePoint((p.point->>0)::float8,(p.point->>1)::float8),
                    ST_MakePoint((a.result->>'longitude')::float8,(a.result->>'latitude')::float8))<=5
              )))
          ))
      ), page_rows AS (
        SELECT * FROM filtered ORDER BY "createdAt" DESC,id DESC LIMIT $3 OFFSET $4
      ), total_rows AS (
        SELECT count(*)::int AS total FROM filtered
      )
      SELECT page_rows.*,total_rows.total FROM total_rows LEFT JOIN page_rows ON TRUE
      ORDER BY page_rows."createdAt" DESC NULLS LAST,page_rows.id DESC NULLS LAST`,
      [userId, type ?? null, pageSize, (page - 1) * pageSize]
    );
    return {
      items: rows.filter((row) => row.id),
      page,
      pageSize,
      total: rows[0]?.total ?? 0,
    };
  }
  async getAnalysisHistory(userId: string, id: string) {
    const { rows } = await this.db.query(
      `SELECT h.id,h.analysis_type AS "analysisType",h.title,h.input,h.result,h.created_at AS "createdAt",
      j.id AS "bulkJobId",j.status AS "jobStatus",j.total_rows AS "totalRows",j.processed_rows AS "processedRows",
      j.succeeded_rows AS "succeededRows",j.failed_rows AS "failedRows"
      FROM analysis_history h LEFT JOIN analysis_bulk_jobs j ON j.history_id=h.id WHERE h.user_id=$1 AND h.id=$2`,
      [userId, id]
    );
    if (!rows[0]) {
      throw new NotFoundException({
        message: "Riwayat analisis tidak ditemukan.",
      });
    }
    if (!["BULK", "ADDRESS"].includes(rows[0].analysisType)) {
      return rows[0];
    }
    const { rows: drafts } = await this.db.query(
      `SELECT id,title,input,result,created_at AS "createdAt"
      FROM analysis_history WHERE user_id=$1 AND analysis_type='FTTH_DESIGN'
        AND (input->>'sourceAnalysisId'=$2 OR input->>'sourceAnalysisId' IS NULL)
      ORDER BY created_at DESC`,
      [userId, id]
    );
    const latitude = Number(rows[0].result?.latitude);
    const longitude = Number(rows[0].result?.longitude);
    const relatedDrafts = drafts.filter((draft) => {
      if (draft.input?.sourceAnalysisId === id) {
        return true;
      }
      if (!(Number.isFinite(latitude) && Number.isFinite(longitude))) {
        return false;
      }
      const features = draft.result?.features ?? [];
      return features.some(
        (feature: {
          kind?: string;
          routeType?: string;
          geometry?: {
            coordinates?: unknown;
          };
        }) => {
          if (
            feature.kind !== "OLT" &&
            !(feature.kind === "ROUTE" && feature.routeType === "FEEDER")
          ) {
            return false;
          }
          const geometryCoordinates = feature.geometry?.coordinates;
          if (
            !Array.isArray(geometryCoordinates) ||
            geometryCoordinates.length < 2
          ) {
            return false;
          }
          const coordinates = Array.isArray(geometryCoordinates[0])
            ? geometryCoordinates[0]
            : geometryCoordinates;
          const dx =
            (Number(coordinates[0]) - longitude) *
            111_320 *
            Math.cos((latitude * Math.PI) / 180);
          const dy = (Number(coordinates[1]) - latitude) * 111_320;
          return (
            Number.isFinite(dx) &&
            Number.isFinite(dy) &&
            Math.hypot(dx, dy) <= 5
          );
        }
      );
    });
    return { ...rows[0], relatedDrafts };
  }
  async deleteAnalysisHistory(userId: string, id: string) {
    await this.db.transaction(async (client) => {
      const { rows } = await client.query(
        "SELECT analysis_type AS type FROM analysis_history WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [userId, id]
      );
      if (!rows.length) {
        throw new NotFoundException({
          message: "Riwayat analisis tidak ditemukan.",
        });
      }
      await client.query(
        "DELETE FROM analysis_history WHERE user_id=$1 AND id=$2",
        [userId, id]
      );
      await audit(
        client,
        userId,
        "ANALYSIS_HISTORY_DELETED",
        "ANALYSIS_HISTORY",
        id,
        { type: rows[0].type }
      );
    });
  }
  async listAuditTrails(search = "", limit = 100) {
    const { rows } = await this.db.query(
      `SELECT l.id,l.action,l.entity_type AS "entityType",l.entity_id AS "entityId",l.details,
      l.created_at AS "createdAt",u.name AS "actorName",u.email AS "actorEmail"
      FROM audit_logs l LEFT JOIN "user" u ON u.id=l.actor_id
      WHERE $1='' OR l.action ILIKE '%'||$1||'%' OR l.entity_type ILIKE '%'||$1||'%' OR l.entity_id ILIKE '%'||$1||'%' OR u.name ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%'
      ORDER BY l.created_at DESC,l.id DESC LIMIT $2`,
      [search.trim(), Math.max(1, Math.min(250, limit))]
    );
    return rows;
  }
  async listAssets(search = "") {
    const { rows } = await this.db.query<AssetRecord>(
      `SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      GeometryType(a.geometry) AS "geometryType",NULL::jsonb AS geometry,a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE $1='' OR a.name ILIKE '%'||$1||'%' OR a.area ILIKE '%'||$1||'%'
      GROUP BY a.id ORDER BY a.name`,
      [search]
    );
    const pattern = new RegExp((await this.getCableNamePattern()).pattern);
    return rows.map((asset) => ({
      ...asset,
      nameValid: pattern.test(asset.name),
    }));
  }
  async listAssetImports() {
    const { rows } = await this.db.query(`SELECT l.entity_id AS id,
        COALESCE(l.details->>'fileName', 'Map Package') AS name,
        COALESCE((l.details->>'importedCount')::int, 0) AS "importedCount",
        COALESCE((l.details->>'segmentCount')::int, 0) AS "segmentCount",
        COALESCE((
          SELECT jsonb_agg(company.name ORDER BY company.name)
          FROM (
            SELECT DISTINCT NULLIF(btrim(a.attributes->>'Company'), '') AS name
            FROM network_assets a
            WHERE ${assetImportId}=l.entity_id
          ) company
          WHERE company.name IS NOT NULL
        ), '[]'::jsonb) AS companies,
        COALESCE((l.details->>'ftthFolderCount')::int, (
          SELECT count(DISTINCT array_to_string((string_to_array(a.attributes->>'folderPath', '/'))[1:p.ordinality], ' / '))::int
          FROM network_assets a
          CROSS JOIN LATERAL unnest(string_to_array(a.attributes->>'folderPath', '/')) WITH ORDINALITY AS p(folder, ordinality)
          WHERE ${assetImportId}=l.entity_id AND p.folder ILIKE '%ftth%'
        ), 0) AS "ftthFolderCount",
        COALESCE(l.details->'folderPaths', (
          SELECT COALESCE(jsonb_agg(folders.path ORDER BY folders.path), '[]'::jsonb)
          FROM (
            SELECT DISTINCT array_to_string((string_to_array(a.attributes->>'folderPath', '/'))[1:p.ordinality], ' / ') AS path
            FROM network_assets a
            CROSS JOIN LATERAL unnest(string_to_array(a.attributes->>'folderPath', '/')) WITH ORDINALITY AS p(folder, ordinality)
            WHERE ${assetImportId}=l.entity_id AND COALESCE(a.attributes->>'folderPath','')<>''
          ) folders
        )) AS "folderPaths",
        l.created_at AS "createdAt",u.name AS "actorName",u.email AS "actorEmail"
      FROM audit_logs l LEFT JOIN "user" u ON u.id=l.actor_id
      WHERE l.action='NETWORK_IMPORTED' AND l.entity_type='NETWORK_IMPORT' AND l.entity_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM network_assets a WHERE ${assetImportId}=l.entity_id)
      ORDER BY l.created_at DESC LIMIT 50`);
    return rows;
  }
  async listAssetPage(
    search = "",
    page = 1,
    pageSize = 50,
    coreFilter = "all",
    provinceCode?: string,
    importId?: string,
    assetType = "all",
    cableFamily = "all",
    cableStatus = "all",
    networkKind = "all"
  ) {
    const filter = search.trim();
    const match = `%${filter}%`;
    const provinceCondition = provinceMatch(4);
    const conditions = `($1='' OR a.name ILIKE $2 OR a.area ILIKE $2 OR a.cable_type ILIKE $2 OR a.asset_type ILIKE $2 OR a.attributes::text ILIKE $2)
      AND ($3 IN ('all','points') OR a.asset_type='segment')
      AND ($3<>'points' OR a.asset_type<>'segment')
      AND ($3<>'filled' OR a.total_cores>0)
      AND ($3<>'empty' OR a.total_cores=0)
      AND ($4::text IS NULL OR ${provinceCondition})
      AND ($5::text IS NULL OR ${assetImportId}=ANY(string_to_array($5, ',')))
      AND ($6='all' OR ($6='cables' AND a.asset_type='segment') OR ($6='network' AND a.asset_type<>'segment'))
      AND ($7='all' OR CASE
        WHEN upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%FEEDER%' OR upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%FDR%' THEN 'feeder'
        WHEN upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%BACKBONE%' OR position('BB_' in upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')))>0 THEN 'backbone'
        WHEN upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%SUB-DISTRIBUSI%' OR upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%SUB DISTRIBUSI%' OR upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%BRENCH%' THEN 'sub-distribusi'
        WHEN upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')) LIKE '%DISTRIBUSI%' OR position('DST_' in upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')))>0 OR position('DTB_' in upper(concat_ws(' ',a.cable_type,a.name,a.attributes->>'routeType')))>0 THEN 'distribusi'
        ELSE 'lainnya' END=$7)
      AND ($8='all' OR ($8='verified' AND (a.source='managed' OR a.attributes->'__coreUsageVerification'->>'verified'='true' OR a.attributes->>'__coreUsageVerified'='true'))
        OR ($8='unverified' AND NOT (a.source='managed' OR a.attributes->'__coreUsageVerification'->>'verified'='true' OR a.attributes->>'__coreUsageVerified'='true'))
        OR ($8='available' AND (a.source='managed' OR a.attributes->'__coreUsageVerification'->>'verified'='true' OR a.attributes->>'__coreUsageVerified'='true') AND EXISTS(SELECT 1 FROM network_cores c WHERE c.asset_id=a.id AND c.status='Available'))
        OR ($8='unavailable' AND (a.source='managed' OR a.attributes->'__coreUsageVerification'->>'verified'='true' OR a.attributes->>'__coreUsageVerified'='true') AND NOT EXISTS(SELECT 1 FROM network_cores c WHERE c.asset_id=a.id AND c.status='Available')))
      AND ($9='all' OR CASE
        WHEN upper(concat_ws(' ',a.attributes->>'assetKind',a.name)) LIKE '%ODC%' THEN 'odc'
        WHEN upper(concat_ws(' ',a.attributes->>'assetKind',a.name)) LIKE '%ODP%' THEN 'odp'
        WHEN upper(concat_ws(' ',a.attributes->>'assetKind',a.name)) LIKE '%CLOSURE%' OR upper(concat_ws(' ',a.attributes->>'assetKind',a.name)) LIKE '%JC%' THEN 'closure'
        WHEN upper(concat_ws(' ',a.attributes->>'assetKind',a.name)) LIKE '%TIANG%' OR upper(concat_ws(' ',a.attributes->>'assetKind',a.name)) LIKE '%POLE%' THEN 'tiang'
        ELSE 'lainnya' END=$9)`;
    const [{ rows: countRows }, { rows }] = await Promise.all([
      this.db.query<{
        total: number;
      }>(
        `SELECT count(*)::int AS total FROM network_assets a
        WHERE ${conditions}`,
        [
          filter,
          match,
          coreFilter,
          provinceCode ?? null,
          importId ?? null,
          assetType,
          cableFamily,
          cableStatus,
          networkKind,
        ]
      ),
      this.db.query<AssetRecord>(
        `WITH page AS (
          SELECT a.id,a.name FROM network_assets a
          WHERE ${conditions}
          ORDER BY a.name,a.id LIMIT $10 OFFSET $11
        )
        SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
          a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
          count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
          count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
          count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
          GeometryType(a.geometry) AS "geometryType",NULL::jsonb AS geometry,a.attributes,a.created_at AS "createdAt"
        FROM page p JOIN network_assets a ON a.id=p.id LEFT JOIN network_cores c ON c.asset_id=a.id
        GROUP BY a.id ORDER BY a.name,a.id`,
        [
          filter,
          match,
          coreFilter,
          provinceCode ?? null,
          importId ?? null,
          assetType,
          cableFamily,
          cableStatus,
          networkKind,
          pageSize,
          (page - 1) * pageSize,
        ]
      ),
    ]);
    const pattern = new RegExp((await this.getCableNamePattern()).pattern);
    return {
      items: rows.map((asset) => ({
        ...asset,
        nameValid: pattern.test(asset.name),
      })),
      page,
      pageSize,
      total: countRows[0].total,
    };
  }
  async listDashboardSegments() {
    const { rows } =
      await this.db.query<AssetRecord>(`SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      NULL::text AS "geometryType",NULL::jsonb AS geometry,a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.asset_type='segment' GROUP BY a.id ORDER BY a.name,a.id LIMIT 8`);
    const pattern = new RegExp((await this.getCableNamePattern()).pattern);
    return rows.map((asset) => ({
      ...asset,
      nameValid: pattern.test(asset.name),
    }));
  }
  async mapBounds(provinceCode?: string, importId?: string) {
    const provinceCondition = provinceMatch(1);
    const { rows } = await this.db.query(
      `SELECT ST_XMin(extent) AS west,ST_YMin(extent) AS south,ST_XMax(extent) AS east,ST_YMax(extent) AS north
      FROM (SELECT ST_Extent(geometry) AS extent FROM network_assets a WHERE ($1::text IS NULL OR ${provinceCondition})
        AND ($2::text IS NULL OR ${assetImportId}=ANY(string_to_array($2, ',')))) bounds`,
      [provinceCode ?? null, importId ?? null]
    );
    const { west, south, east, north } = rows[0];
    return { bounds: west === null ? null : [west, south, east, north] };
  }
  async listKmzProvinces() {
    const { rows: assets } =
      await this.db.query<KmzProvinceAsset>(`SELECT id,name,COALESCE(area,'') AS area,
        COALESCE(attributes->>'folderPath','') AS "folderPath"
      FROM network_assets WHERE source='kml' AND attributes ? 'folderPath' AND COALESCE(attributes->>'__atlasProvinceSource','') <> 'geometry-boundary'`);
    const { rows: regions } =
      await this.db.query<RegionName>(`SELECT p.code AS "provinceCode",btrim(p.name) AS name,4 AS level FROM indonesia_provinces p
      UNION ALL SELECT c.province_code,btrim(c.name),3 FROM indonesia_cities c
      UNION ALL SELECT c.province_code,btrim(d.name),2 FROM indonesia_districts d JOIN indonesia_cities c ON c.code=d.city_code
      UNION ALL SELECT c.province_code,btrim(s.name),1 FROM indonesia_subdistricts s
        JOIN indonesia_districts d ON d.code=s.district_code JOIN indonesia_cities c ON c.code=d.city_code`);
    const assetGroups = new Map<string, KmzProvinceAsset[]>();
    const folderNamesByGroup = new Map<string, Set<string>>();
    for (const asset of assets) {
      const group = kmzGroup(asset.folderPath);
      if (!group) {
        continue;
      }
      const key = normalizeRegionText(group);
      const groupAssets = assetGroups.get(key) ?? [];
      groupAssets.push(asset);
      assetGroups.set(key, groupAssets);
      const folders = folderNamesByGroup.get(key) ?? new Set<string>();
      folders.add(asset.folderPath);
      folderNamesByGroup.set(key, folders);
    }
    const { rows: boundaries } = await this.db.query<{
      folderPath: string;
      village: string;
    }>(`SELECT DISTINCT
        COALESCE(attributes->>'folderPath','') AS "folderPath",
        btrim(split_part(name,' · ',3)) AS village
      FROM network_assets WHERE source='kml' AND attributes->>'folderPath' ILIKE '%FULL BOUNDRY%' AND name LIKE '% · % · %'`);
    const villagesByGroup = new Map<string, Set<string>>();
    for (const boundary of boundaries) {
      const group = normalizeRegionText(kmzGroup(boundary.folderPath));
      const village = normalizeRegionText(boundary.village);
      if (!(group && village)) {
        continue;
      }
      const villages = villagesByGroup.get(group) ?? new Set<string>();
      villages.add(village);
      villagesByGroup.set(group, villages);
    }
    const regionsByName = new Map<string, RegionName[]>();
    for (const region of regions) {
      const normalized = normalizeRegionText(region.name);
      if (!normalized) {
        continue;
      }
      const matches = regionsByName.get(normalized) ?? [];
      matches.push(region);
      regionsByName.set(normalized, matches);
    }
    const subdistrictsByName = new Map(
      [...regionsByName.entries()].map(([name, matches]) => [
        name,
        matches.filter((region) => region.level === 1),
      ])
    );
    const provinceByGroup = new Map<
      string,
      {
        code: string;
        source: string;
      }
    >();
    for (const [group, groupAssets] of assetGroups) {
      const areaNames = [
        ...new Set(
          groupAssets
            .map((asset) => normalizeRegionText(asset.area))
            .filter(Boolean)
        ),
      ];
      const villages = [...(villagesByGroup.get(group) ?? [])];
      const votes = new Map<string, number>();
      for (const village of villages) {
        const matches = subdistrictsByName.get(village) ?? [];
        const codes = new Set(matches.map((region) => region.provinceCode));
        if (codes.size === 1) {
          const code = [...codes][0];
          votes.set(code, (votes.get(code) ?? 0) + 1);
        }
      }
      const voteRanking = [...votes.entries()].sort(
        (left, right) => right[1] - left[1]
      );
      const [winner, winnerVotes] = voteRanking[0] ?? [];
      const runnerUpVotes = voteRanking[1]?.[1] ?? 0;
      if (
        winner &&
        winnerVotes >= 3 &&
        winnerVotes >= runnerUpVotes + 2 &&
        winnerVotes / villages.length >= 0.6
      ) {
        provinceByGroup.set(group, {
          code: winner,
          source: "village-boundary-consensus",
        });
        continue;
      }
      const areaCandidates = areaNames.flatMap(
        (area) => regionsByName.get(area) ?? []
      );
      const areaCodes = new Set(
        areaCandidates.map((region) => region.provinceCode)
      );
      if (areaCodes.size === 1 && areaCandidates.length) {
        provinceByGroup.set(group, {
          code: [...areaCodes][0],
          source: "kmz-area-hierarchy",
        });
        continue;
      }
      const exactFolderNames = new Set<string>([group]);
      for (const folderPath of folderNamesByGroup.get(group) ?? []) {
        for (const folder of folderPath.split("/")) {
          const cleaned = folder.replace(/^\s*POP\s+/iu, "").trim();
          for (const part of [cleaned, ...cleaned.split(/\s*[-–—,;|]\s*/u)]) {
            const normalized = normalizeRegionText(part);
            if (normalized) {
              exactFolderNames.add(normalized);
            }
          }
        }
      }
      const candidates = [...exactFolderNames]
        .flatMap((name) => regionsByName.get(name) ?? [])
        .filter((region) => region.level >= 2);
      if (!candidates.length) {
        continue;
      }
      const bestLevel = Math.max(...candidates.map((region) => region.level));
      const bestCandidates = candidates.filter(
        (region) => region.level === bestLevel
      );
      const codes = new Set(
        bestCandidates.map((region) => region.provinceCode)
      );
      if (codes.size === 1) {
        provinceByGroup.set(group, {
          code: [...codes][0],
          source: "kmz-folder-hierarchy",
        });
      }
    }
    const updatesByValue = new Map<
      string,
      {
        code: string;
        source: string;
        ids: string[];
      }
    >();
    const unresolvedIds: string[] = [];
    for (const [group, groupAssets] of assetGroups) {
      const assignment = provinceByGroup.get(group);
      if (assignment) {
        const key = `${assignment.code}:${assignment.source}`;
        const update = updatesByValue.get(key) ?? { ...assignment, ids: [] };
        update.ids.push(...groupAssets.map((asset) => asset.id));
        updatesByValue.set(key, update);
      } else {
        unresolvedIds.push(...groupAssets.map((asset) => asset.id));
      }
    }
    for (const { code, source, ids } of updatesByValue.values()) {
      await this.db.query(
        `UPDATE network_assets SET attributes=COALESCE(attributes,'{}'::jsonb)||jsonb_build_object('__atlasProvinceCode',$2,'__atlasProvinceSource',$3)
        WHERE id=ANY($1::text[]) AND (attributes->>'__atlasProvinceCode' IS DISTINCT FROM $2 OR attributes->>'__atlasProvinceSource' IS DISTINCT FROM $3)`,
        [ids, code, source]
      );
    }
    if (unresolvedIds.length) {
      await this.db.query(
        `UPDATE network_assets SET attributes=COALESCE(attributes,'{}'::jsonb)-'__atlasProvinceCode'-'__atlasProvinceSource'
      WHERE id=ANY($1::text[]) AND attributes ? '__atlasProvinceCode'`,
        [unresolvedIds]
      );
    }
    // Coordinates are authoritative when folder names do not identify a province.
    const provinceNames = regions.filter((region) => region.level === 4);
    const spatialProvinces = provinceBoundaries.features.flatMap((feature) => {
      const name = normalizeRegionText(
        (
          {
            "DI. ACEH": "Aceh",
            "DKI JAKARTA": "Daerah Khusus Ibukota Jakarta",
            "NUSATENGGARA BARAT": "Nusa Tenggara Barat",
            PROBANTEN: "Banten",
          } as Record<string, string>
        )[feature.properties.Propinsi] ?? feature.properties.Propinsi
      );
      const province = provinceNames.find(
        (region) => normalizeRegionText(region.name) === name
      );
      return province
        ? [{ code: province.provinceCode, geometry: feature.geometry }]
        : [];
    });
    await this.db.query(
      `WITH boundaries AS MATERIALIZED (
      SELECT value->>'code' AS code, ST_SetSRID(ST_GeomFromGeoJSON(value->'geometry'),4326) AS geometry
      FROM jsonb_array_elements($1::jsonb)
    ), assigned AS (
      SELECT DISTINCT ON (a.id) a.id,b.code FROM network_assets a JOIN boundaries b
        ON a.geometry && b.geometry AND ST_Covers(b.geometry,ST_PointOnSurface(a.geometry))
      WHERE a.source='kml' ORDER BY a.id,b.code
    ) UPDATE network_assets a SET attributes=COALESCE(a.attributes,'{}'::jsonb)||jsonb_build_object('__atlasProvinceCode',assigned.code,'__atlasProvinceSource','geometry-boundary')
      FROM assigned WHERE a.id=assigned.id AND (a.attributes->>'__atlasProvinceCode' IS DISTINCT FROM assigned.code OR a.attributes->>'__atlasProvinceSource' IS DISTINCT FROM 'geometry-boundary')`,
      [JSON.stringify(spatialProvinces)]
    );
    const { rows: spatialGroups } = await this.db.query<{
      id: string;
      folderPath: string;
      code: string | null;
    }>(
      `SELECT id,attributes->>'folderPath' AS "folderPath",attributes->>'__atlasProvinceCode' AS code FROM network_assets WHERE source='kml' AND attributes ? 'folderPath'`
    );
    const groupCodes = new Map<string, Set<string>>();
    for (const asset of spatialGroups) {
      if (!asset.code) {
        continue;
      }
      const group = normalizeRegionText(kmzGroup(asset.folderPath));
      const codes = groupCodes.get(group) ?? new Set<string>();
      codes.add(asset.code);
      groupCodes.set(group, codes);
    }
    for (const asset of spatialGroups) {
      if (asset.code) {
        continue;
      }
      const codes = groupCodes.get(
        normalizeRegionText(kmzGroup(asset.folderPath))
      );
      if (codes?.size !== 1) {
        continue;
      }
      await this.db.query(
        `UPDATE network_assets SET attributes=attributes||jsonb_build_object('__atlasProvinceCode',$2::text,'__atlasProvinceSource','kmz-group-spatial-consensus') WHERE id=$1`,
        [asset.id, [...codes][0]]
      );
    }
    const { rows } =
      await this.db.query(`SELECT p.code,btrim(p.name) AS name,count(DISTINCT a.id)::int AS "assetCount",
        count(DISTINCT a.attributes->>'folderPath')::int AS "folderCount",
        ST_XMin(ST_Extent(a.geometry)) AS west,ST_YMin(ST_Extent(a.geometry)) AS south,
        ST_XMax(ST_Extent(a.geometry)) AS east,ST_YMax(ST_Extent(a.geometry)) AS north
      FROM indonesia_provinces p JOIN network_assets a ON a.attributes->>'__atlasProvinceCode'=p.code AND a.source='kml'
      GROUP BY p.code,p.name ORDER BY p.name`);
    const { rows: unresolved } =
      await this.db.query(`SELECT count(*)::int AS "assetCount",count(DISTINCT attributes->>'folderPath')::int AS "folderCount"
      FROM network_assets WHERE source='kml' AND attributes ? 'folderPath' AND NOT (attributes ? '__atlasProvinceCode')`);
    return {
      items: rows.map(({ west, south, east, north, ...province }) => ({
        ...province,
        bounds: west === null ? null : [west, south, east, north],
      })),
      unassigned: unresolved[0] ?? { assetCount: 0, folderCount: 0 },
    };
  }
  async listKmzProvinceBoundaries() {
    const { rows } =
      await this.db.query<KmzProvinceBoundary>(`SELECT a.attributes->>'__atlasProvinceCode' AS "provinceCode",btrim(p.name) AS "provinceName",
        ST_AsGeoJSON(ST_SimplifyPreserveTopology(a.geometry,0.0005),5)::json AS geometry
      FROM network_assets a JOIN indonesia_provinces p ON p.code=a.attributes->>'__atlasProvinceCode'
      WHERE a.source='kml' AND a.attributes->>'folderPath' ~* 'FULL[ _]BOUNDRY|FULL[ _]BOUNDARY'
        AND GeometryType(a.geometry) IN ('POLYGON','MULTIPOLYGON')
      ORDER BY p.name,a.name`);
    return {
      features: rows.map(({ provinceCode, provinceName, geometry }) => ({
        geometry,
        properties: { provinceCode, provinceName },
        type: "Feature",
      })),
      type: "FeatureCollection",
    };
  }
  async getKmzIcon(id: string) {
    const { rows } = await this.db.query<{
      mimeType: string;
      content: Buffer;
    }>(
      'SELECT mime_type AS "mimeType",content FROM network_kml_icons WHERE id=$1',
      [id]
    );
    const icon = rows[0];
    if (!icon) {
      throw new NotFoundException("Ikon KMZ tidak ditemukan.");
    }
    return { data: icon.content.toString("base64"), mimeType: icon.mimeType };
  }
  async listMapAssets(
    bounds: [number, number, number, number],
    zoom = 16,
    provinceCode?: string,
    importId?: string
  ) {
    // Display geometry only; original geometry stays available for editing and exports.
    const tolerance = zoom >= 16 ? 0 : 360 / (512 * 2 ** zoom);
    const { rows } = await this.db.query<AssetRecord>(
      `SELECT a.id,a.name,a.area,a.asset_type AS "assetType",a.source,a.cable_type AS "cableType",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "idleCores",
      ST_AsGeoJSON(CASE WHEN $5::float8 > 0 AND a.source<>'kml' THEN ST_SimplifyPreserveTopology(a.geometry,$5::float8) ELSE a.geometry END,6)::json AS geometry,
      GeometryType(a.geometry) AS "geometryType",a.attributes,a.created_at AS "createdAt"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.geometry && ST_MakeEnvelope($1,$2,$3,$4,4326)
        AND ST_Intersects(a.geometry,ST_MakeEnvelope($1,$2,$3,$4,4326))
        AND ($6::text IS NULL OR ${provinceMatch(6)})
        AND ($7::text IS NULL OR ${assetImportId}=ANY(string_to_array($7, ',')))
      GROUP BY a.id ORDER BY a.name`,
      [...bounds, tolerance, provinceCode ?? null, importId ?? null]
    );
    const pattern = new RegExp((await this.getCableNamePattern()).pattern);
    return rows.map((asset) => ({
      ...asset,
      nameValid: pattern.test(asset.name),
    }));
  }
  async createPointAsset(
    body: {
      name?: unknown;
      kind?: unknown;
      longitude?: unknown;
      latitude?: unknown;
      area?: unknown;
      poleHeight?: unknown;
    },
    userId: string
  ) {
    const kinds = ["OLT", "JOINT_CLOSURE", "HANDHOLE", "ODC", "ODP", "POLE"];
    const kind = typeof body.kind === "string" ? body.kind : "";
    const longitude = body.longitude;
    const latitude = body.latitude;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const area = typeof body.area === "string" ? body.area.trim() : "";
    const poleHeight =
      body.poleHeight === "7 m" || body.poleHeight === "9 m"
        ? body.poleHeight
        : null;
    if (!kinds.includes(kind)) {
      throw new BadRequestException({
        message: "Jenis aset FTTH tidak valid.",
      });
    }
    if (kind === "POLE" && !poleHeight) {
      throw new BadRequestException({
        message: "Tinggi tiang harus 7 m atau 9 m.",
      });
    }
    if (!name || name.length > 150) {
      throw new BadRequestException({
        message: "Nama aset wajib diisi, maksimal 150 karakter.",
      });
    }
    if (area.length > 300) {
      throw new BadRequestException({
        message: "Wilayah maksimal 300 karakter.",
      });
    }
    if (
      typeof longitude !== "number" ||
      typeof latitude !== "number" ||
      !Number.isFinite(longitude) ||
      !Number.isFinite(latitude) ||
      Math.abs(longitude) > 180 ||
      Math.abs(latitude) > 90
    ) {
      throw new BadRequestException({ message: "Koordinat aset tidak valid." });
    }
    const id = randomUUID();
    const category =
      kind === "JOINT_CLOSURE" ? "JC" : kind === "HANDHOLE" ? "HANDHOLE" : kind;
    const attributes = {
      assetKind: kind,
      folderPath: `FTTH / ${category}`,
      source: "address-analysis",
    };
    await this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO network_assets(id,name,asset_type,source,area,cable_type,installation,road_side,pole,pole_height,attributes,geometry,source_geometry)
        VALUES($1,$2,'asset','managed',$3,'Fiber Optic','Aerial','Kiri',$4,$5,$6::jsonb,ST_SetSRID(ST_MakePoint($7,$8),4326),$9::jsonb)`,
        [
          id,
          name,
          area,
          kind === "POLE" ? name : "",
          poleHeight,
          JSON.stringify(attributes),
          longitude,
          latitude,
          JSON.stringify({ coordinates: [longitude, latitude], type: "Point" }),
        ]
      );
      await audit(client, userId, "FTTH_ASSET_CREATED", "ASSET", id, {
        area,
        kind,
        latitude,
        longitude,
        poleHeight,
      });
    });
    return { area, id, kind, latitude, longitude, name, poleHeight };
  }
  async saveFtthDesign(
    input: unknown,
    userId: string,
    areaInput: unknown,
    sourceInput?: {
      analysisId?: unknown;
      row?: unknown;
    }
  ) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 500) {
      throw new BadRequestException({
        message: "Desain harus memiliki 1–500 fitur.",
      });
    }
    const area = typeof areaInput === "string" ? areaInput.trim() : "";
    if (area.length > 300) {
      throw new BadRequestException({
        message: "Wilayah maksimal 300 karakter.",
      });
    }
    const sourceAnalysisId =
      typeof sourceInput?.analysisId === "string" ? sourceInput.analysisId : "";
    const sourceRow = Number(sourceInput?.row);
    if (
      (!sourceAnalysisId && sourceInput?.row !== undefined) ||
      (sourceInput?.row !== undefined &&
        (!Number.isInteger(sourceRow) || sourceRow < 1))
    ) {
      throw new BadRequestException({
        message: "Asal draft analisis tidak valid.",
      });
    }
    const kinds = [
      "OLT",
      "JOINT_CLOSURE",
      "HANDHOLE",
      "ODC",
      "ODP",
      "POLE",
      "ROUTE",
    ];
    const designId = randomUUID();
    const features = input.map((value) => {
      if (!value || typeof value !== "object") {
        throw new BadRequestException({ message: "Fitur desain tidak valid." });
      }
      const feature = value as {
        kind?: unknown;
        name?: unknown;
        poleHeight?: unknown;
        routeType?: unknown;
        designAnchor?: unknown;
        geometry?: unknown;
      };
      const kind = String(feature.kind ?? "");
      const name = String(feature.name ?? "").trim();
      const poleHeight =
        feature.poleHeight === "7 m" || feature.poleHeight === "9 m"
          ? feature.poleHeight
          : null;
      const geometry = feature.geometry as
        | {
            type?: unknown;
            coordinates?: unknown;
          }
        | undefined;
      if (
        !(kinds.includes(kind) && name) ||
        name.length > 150 ||
        !geometry ||
        !["Point", "LineString"].includes(String(geometry.type)) ||
        !Array.isArray(geometry.coordinates)
      ) {
        throw new BadRequestException({
          message: "Jenis, nama, atau geometri desain tidak valid.",
        });
      }
      const coordinates = geometry.coordinates as unknown[];
      const points = geometry.type === "Point" ? [coordinates] : coordinates;
      if (
        (geometry.type === "Point" && coordinates.length < 2) ||
        (geometry.type === "LineString" &&
          (coordinates.length < 2 || coordinates.length > 2000)) ||
        points.some(
          (point) =>
            !Array.isArray(point) ||
            point.length < 2 ||
            typeof point[0] !== "number" ||
            typeof point[1] !== "number" ||
            !Number.isFinite(point[0]) ||
            !Number.isFinite(point[1]) ||
            Math.abs(point[0]) > 180 ||
            Math.abs(point[1]) > 90
        )
      ) {
        throw new BadRequestException({
          message: "Koordinat desain tidak valid.",
        });
      }
      if ((kind === "ROUTE") !== (geometry.type === "LineString")) {
        throw new BadRequestException({
          message:
            "Fitur kabel harus berupa jalur garis; aset perangkat harus berupa titik.",
        });
      }
      if (
        feature.designAnchor === true &&
        (kind === "ROUTE" || geometry.type !== "Point")
      ) {
        throw new BadRequestException({
          message: "Titik pusat radius desain harus berupa aset titik.",
        });
      }
      if (kind === "POLE" && !poleHeight) {
        throw new BadRequestException({
          message: "Setiap tiang draft harus memiliki tinggi 7 m atau 9 m.",
        });
      }
      const routeType =
        kind === "ROUTE" &&
        (feature.routeType === "FEEDER" || feature.routeType === "DISTRIBUTION")
          ? feature.routeType
          : null;
      if (kind === "ROUTE" && !routeType) {
        throw new BadRequestException({
          message: "Jenis jalur FTTH harus feeder atau distribusi.",
        });
      }
      const category =
        kind === "JOINT_CLOSURE"
          ? "JC"
          : kind === "HANDHOLE"
            ? "HANDHOLE"
            : kind;
      const attributes = {
        assetKind: kind,
        coverageRadiusMeters:
          feature.designAnchor === true || kind === "OLT" ? 500 : undefined,
        designAnchor: feature.designAnchor === true || undefined,
        folderPath: `FTTH Draft / ${designId} / ${category}`,
        ftthDesignId: designId,
        lineColor:
          routeType === "FEEDER"
            ? "#ff0000"
            : routeType === "DISTRIBUTION"
              ? "#a000ff"
              : undefined,
        poleHeight,
        routeType,
        source: "ftth-design",
      };
      return {
        attributes: JSON.stringify(attributes),
        designAnchor: feature.designAnchor === true,
        geometry,
        geometryJson: JSON.stringify({ coordinates, type: geometry.type }),
        id: randomUUID(),
        kind,
        name,
        poleHeight,
        routeType,
      };
    });
    const historyId = await this.db.transaction(async (client) => {
      if (sourceAnalysisId) {
        const { rows: parent } = await client.query(
          "SELECT h.analysis_type,h.result,j.id AS job_id FROM analysis_history h LEFT JOIN analysis_bulk_jobs j ON j.history_id=h.id WHERE h.id=$1 AND h.user_id=$2 AND h.analysis_type IN ('ADDRESS','BULK') FOR UPDATE OF h",
          [sourceAnalysisId, userId]
        );
        if (!parent.length) {
          throw new NotFoundException({
            message: "Riwayat analisis tidak ditemukan.",
          });
        }
        if (
          parent[0].analysis_type === "ADDRESS" &&
          sourceInput?.row !== undefined
        ) {
          throw new BadRequestException({
            message: "Analisis alamat tunggal tidak memakai nomor baris.",
          });
        }
        if (parent[0].analysis_type === "BULK") {
          if (!Number.isInteger(sourceRow) || sourceRow < 1) {
            throw new BadRequestException({
              message: "Nomor baris analisis massal tidak valid.",
            });
          }
          const asyncRow = parent[0].job_id
            ? await client.query(
                "SELECT 1 FROM analysis_bulk_job_rows WHERE job_id=$1 AND row_number=$2 AND status='OK'",
                [parent[0].job_id, sourceRow]
              )
            : { rows: [] };
          if (
            !asyncRow.rows.length &&
            !(
              Array.isArray(parent[0].result?.rows) &&
              parent[0].result.rows.some(
                (row: { row?: number }) => Number(row.row) === sourceRow
              )
            )
          ) {
            throw new NotFoundException({
              message:
                "Baris analisis massal tidak ditemukan atau belum berhasil.",
            });
          }
        }
      }
      for (const feature of features) {
        const isRoute = feature.kind === "ROUTE";
        await client.query(
          `INSERT INTO network_assets(id,name,asset_type,source,area,cable_type,installation,road_side,pole_height,attributes,geometry,source_geometry)
          VALUES($1,$2,$3,'managed',$4,'Fiber Optic','Aerial','Kiri',$5,$6::jsonb,ST_SetSRID(ST_GeomFromGeoJSON($7),4326),$7::jsonb)`,
          [
            feature.id,
            feature.name,
            isRoute ? "segment" : "asset",
            area,
            feature.poleHeight,
            feature.attributes,
            feature.geometryJson,
          ]
        );
      }
      await client.query(
        `INSERT INTO network_asset_relations(segment_id,asset_id,kind)
        SELECT route.id, point.id, point.attributes->>'assetKind'
        FROM network_assets route
        JOIN network_assets point ON point.attributes->>'ftthDesignId'=route.attributes->>'ftthDesignId'
          AND point.attributes->>'assetKind' IN ('POLE','ODC','ODP')
          AND ST_DWithin(route.geometry::geography,point.geometry::geography,1)
        WHERE route.attributes->>'ftthDesignId'=$1 AND route.attributes->>'assetKind'='ROUTE'
        ON CONFLICT DO NOTHING`,
        [designId]
      );
      const historyTitle = `Draft FTTH · ${area || "Lokasi analisis"}`.slice(
        0,
        300
      );
      const historyInput = {
        area,
        designId,
        ...(sourceAnalysisId ? { sourceAnalysisId, sourceRow } : {}),
      };
      const historyResult = {
        assetCount: features.filter((feature) => feature.kind !== "ROUTE")
          .length,
        designId,
        features: features.map(
          ({ kind, name, poleHeight, routeType, designAnchor, geometry }) => ({
            designAnchor,
            geometry,
            kind,
            name,
            poleHeight,
            routeType,
          })
        ),
        routeCount: features.filter((feature) => feature.kind === "ROUTE")
          .length,
        savedCount: features.length,
      };
      const { rows: historyRows } = await client.query(
        `INSERT INTO analysis_history(user_id,analysis_type,title,input,result)
        VALUES($1,'FTTH_DESIGN',$2,$3::jsonb,$4::jsonb) RETURNING id`,
        [
          userId,
          historyTitle,
          JSON.stringify(historyInput),
          JSON.stringify(historyResult),
        ]
      );
      await audit(
        client,
        userId,
        "FTTH_DESIGN_CREATED",
        "FTTH_DESIGN",
        features[0].id,
        {
          featureCount: features.length,
          kinds: [...new Set(features.map((feature) => feature.kind))],
        }
      );
      return historyRows[0].id as string;
    });
    return { designId, historyId, savedCount: features.length };
  }
  async assetGeometry(id: string) {
    const { rows } = await this.db.query(
      `SELECT COALESCE(source_geometry,ST_AsGeoJSON(geometry)::jsonb) AS geometry,
        attributes->>'__atlasProvinceCode' AS "provinceCode" FROM network_assets WHERE id=$1`,
      [id]
    );
    if (!rows.length) {
      throw new NotFoundException({ message: "Aset tidak ditemukan." });
    }
    return rows[0];
  }
  async updateAsset(
    id: string,
    body: Record<string, unknown>,
    userId: string,
    cableOnly = false
  ) {
    if (
      cableOnly &&
      Object.keys(body).some(
        (key) =>
          !["area", "cableType", "totalCores", "installation", "side"].includes(
            key
          )
      )
    ) {
      throw new ForbiddenException({
        message: "Hanya detail kabel yang dapat diubah.",
      });
    }
    const validInstallation = ["Aerial", "Burial"].includes(
      String(body.installation)
    );
    const validSide = ["Kiri", "Kanan"].includes(String(body.side));
    const total = Number(body.totalCores);
    if (body.installation !== undefined && !validInstallation) {
      throw new BadRequestException({
        message: "Metode instalasi harus Aerial atau Burial.",
      });
    }
    if (body.side !== undefined && !validSide) {
      throw new BadRequestException({
        message: "Sisi jalan harus Kiri atau Kanan.",
      });
    }
    if (
      body.poleHeight !== undefined &&
      body.poleHeight !== null &&
      !["7 m", "9 m"].includes(String(body.poleHeight))
    ) {
      throw new BadRequestException({
        message: "Tinggi tiang harus 7 m atau 9 m.",
      });
    }
    if (
      body.totalCores !== undefined &&
      (!Number.isInteger(total) || total < 0 || total > 4096)
    ) {
      throw new BadRequestException({
        message: "Jumlah core harus bilangan bulat 0–4096.",
      });
    }
    for (const key of ["name", "area", "cableType", "pole", "odc", "odp"]) {
      if (
        body[key] !== undefined &&
        (typeof body[key] !== "string" || String(body[key]).length > 500)
      ) {
        throw new BadRequestException({
          message: "Informasi aset harus berupa teks maksimal 500 karakter.",
        });
      }
    }
    await this.db.transaction(async (client) => {
      const { rows: locked } = await client.query(
        "SELECT id,asset_type FROM network_assets WHERE id=$1 FOR UPDATE",
        [id]
      );
      if (!locked.length) {
        throw new NotFoundException({ message: "Aset tidak ditemukan." });
      }
      if (cableOnly && locked[0].asset_type !== "segment") {
        throw new ForbiddenException({
          message: "Hanya detail kabel yang dapat diubah.",
        });
      }
      if (body.totalCores !== undefined && locked[0].asset_type !== "segment") {
        throw new BadRequestException({
          message: "Kapasitas core hanya dapat diatur pada segmen kabel.",
        });
      }
      await client.query(
        `UPDATE network_assets SET
        name=COALESCE($2,name), area=COALESCE($3,area), cable_type=COALESCE($4,cable_type),
        installation=CASE WHEN $5 THEN $6 ELSE installation END, road_side=CASE WHEN $7 THEN $8 ELSE road_side END,
        pole=COALESCE($9,pole), pole_height=CASE WHEN $10 THEN $11 ELSE pole_height END,
        odc=COALESCE($12,odc), odp=COALESCE($13,odp), updated_at=now()
        WHERE id=$1`,
        [
          id,
          body.name ?? null,
          body.area ?? null,
          body.cableType ?? null,
          body.installation !== undefined,
          validInstallation ? body.installation : "Aerial",
          body.side !== undefined,
          validSide ? body.side : "Kiri",
          body.pole ?? null,
          body.poleHeight !== undefined,
          body.poleHeight ?? null,
          body.odc ?? null,
          body.odp ?? null,
        ]
      );
      if (body.totalCores !== undefined) {
        await this.setCoreCount(client, id, total);
        await allocateWaiting(client, id, userId);
      }
      await audit(client, userId, "ASSET_UPDATED", "ASSET", id, {
        fields: Object.keys(body),
      });
    });
    return (await this.listAssets()).find((asset) => asset.id === id);
  }
  async listRelations(segmentId: string) {
    const { rows: segment } = await this.db.query(
      "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment'",
      [segmentId]
    );
    if (!segment.length) {
      throw new NotFoundException({ message: "Segmen tidak ditemukan." });
    }
    const { rows } = await this.db.query(
      `SELECT r.asset_id AS "assetId",r.kind,a.name,a.area,a.pole_height AS "poleHeight"
      FROM network_asset_relations r JOIN network_assets a ON a.id=r.asset_id
      WHERE r.segment_id=$1 ORDER BY r.kind,a.name,a.id`,
      [segmentId]
    );
    return rows;
  }
  async saveRelations(segmentId: string, input: unknown, userId: string) {
    if (!Array.isArray(input) || input.length > 1000) {
      throw new BadRequestException({
        message: "Relasi harus berupa daftar, maksimal 1.000 aset.",
      });
    }
    const relations = input.map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.assetId !== "string" ||
        !["POLE", "ODC", "ODP"].includes(entry.kind)
      ) {
        throw new BadRequestException({
          message:
            "Relasi harus memiliki assetId dan jenis POLE, ODC, atau ODP.",
        });
      }
      return { assetId: entry.assetId as string, kind: entry.kind as string };
    });
    if (
      new Set(relations.map((entry) => `${entry.kind}:${entry.assetId}`))
        .size !== relations.length
    ) {
      throw new BadRequestException({
        message: "Relasi aset tidak boleh duplikat.",
      });
    }
    await this.db.transaction(async (client) => {
      const { rows: segment } = await client.query(
        "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' FOR UPDATE",
        [segmentId]
      );
      if (!segment.length) {
        throw new NotFoundException({ message: "Segmen tidak ditemukan." });
      }
      const ids = [...new Set(relations.map((entry) => entry.assetId))].sort();
      if (ids.length) {
        const { rows: points } = await client.query(
          "SELECT id FROM network_assets WHERE id=ANY($1::text[]) AND asset_type='asset' AND GeometryType(geometry)='POINT' ORDER BY id FOR UPDATE",
          [ids]
        );
        if (points.length !== ids.length) {
          throw new BadRequestException({
            message:
              "Pilih aset titik yang masih tersedia; segmen dan boundary tidak dapat dijadikan relasi.",
          });
        }
      }
      await client.query(
        "DELETE FROM network_asset_relations WHERE segment_id=$1",
        [segmentId]
      );
      for (const entry of relations) {
        await client.query(
          "INSERT INTO network_asset_relations(segment_id,asset_id,kind) VALUES($1,$2,$3)",
          [segmentId, entry.assetId, entry.kind]
        );
      }
      await audit(
        client,
        userId,
        "ASSET_RELATIONS_UPDATED",
        "ASSET",
        segmentId,
        { relations }
      );
    });
    return this.listRelations(segmentId);
  }
  async listCores(assetId: string) {
    const { rows: segment } = await this.db.query(
      "SELECT id,total_cores AS \"totalCores\" FROM network_assets WHERE id=$1 AND asset_type='segment'",
      [assetId]
    );
    if (!segment.length) {
      throw new NotFoundException({ message: "Segmen tidak ditemukan." });
    }
    const totalCores = Number(segment[0].totalCores);
    if (Number.isInteger(totalCores) && totalCores > 0) {
      // Older KMZ imports stored capacity before per-core rows were materialized.
      // Fill only missing rows; existing statuses and connections remain untouched.
      await this.db.query(
        `INSERT INTO network_cores(asset_id,core_number)
         SELECT $1,n FROM generate_series(1,$2::integer) n
         ON CONFLICT (asset_id,core_number) DO NOTHING`,
        [assetId, totalCores]
      );
    }
    const { rows } = await this.db.query(
      `SELECT c.core_number AS "coreNumber",c.status,
        CASE WHEN nea.segment_id IS NULL AND ea.id IS NULL THEN NULL ELSE jsonb_build_object(
          'nodeAssetId',COALESCE(ea.node_asset_id,nea.node_asset_id),'nodeAssetName',COALESCE(na.name,ena.name),
          'nodeAssetType',na.attributes->>'Tipe Perangkat','longitude',ST_X(na.geometry)::float8,'latitude',ST_Y(na.geometry)::float8,
          'verificationStatus',nea.verification_status,'endpointSource',nea.source,'endpointNote',nea.note,
          'connectionType',ea.connection_type,'peerSegmentId',pa.asset_id,'peerSegmentName',pas.name,
          'peerCoreNumber',pa.core_number,'peerSide',ea.peer_side,'peerRouteMeasureM',ea.peer_route_measure_m,
          'connectionGroupId',ea.connection_group_id,'portReference',ea.port_reference,
          'connectionVerificationStatus',ea.verification_status,'connectionSource',ea.source,'connectionNote',ea.note
        ) END AS "endA",
        CASE WHEN neb.segment_id IS NULL AND eb.id IS NULL THEN NULL ELSE jsonb_build_object(
          'nodeAssetId',COALESCE(eb.node_asset_id,neb.node_asset_id),'nodeAssetName',COALESCE(nb.name,enb.name),
          'nodeAssetType',nb.attributes->>'Tipe Perangkat','longitude',ST_X(nb.geometry)::float8,'latitude',ST_Y(nb.geometry)::float8,
          'verificationStatus',neb.verification_status,'endpointSource',neb.source,'endpointNote',neb.note,
          'connectionType',eb.connection_type,'peerSegmentId',pb.asset_id,'peerSegmentName',pbs.name,
          'peerCoreNumber',pb.core_number,'peerSide',eb.peer_side,'peerRouteMeasureM',eb.peer_route_measure_m,
          'connectionGroupId',eb.connection_group_id,'portReference',eb.port_reference,
          'connectionVerificationStatus',eb.verification_status,'connectionSource',eb.source,'connectionNote',eb.note
        ) END AS "endB",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'id',middle.id,'nodeAssetId',middle.node_asset_id,'nodeAssetName',middleNode.name,
            'nodeAssetType',middleNode.attributes->>'Tipe Perangkat','routeMeasureM',middle.route_measure_m,
            'connectionType',middle.connection_type,'peerSegmentId',middlePeer.asset_id,
            'peerSegmentName',middlePeerAsset.name,'peerCoreNumber',middlePeer.core_number,
            'peerSide',middle.peer_side,'peerRouteMeasureM',middle.peer_route_measure_m,
            'connectionGroupId',middle.connection_group_id,'portReference',middle.port_reference,
            'verificationStatus',middle.verification_status,'source',middle.source,'note',middle.note
          ) ORDER BY middle.route_measure_m,middle.node_asset_id)
          FROM network_core_end_connections middle
          JOIN network_assets middleNode ON middleNode.id=middle.node_asset_id
          LEFT JOIN network_cores middlePeer ON middlePeer.id=middle.peer_core_id
          LEFT JOIN network_assets middlePeerAsset ON middlePeerAsset.id=middlePeer.asset_id
          WHERE middle.core_id=c.id AND middle.side='R'
        ),'[]'::jsonb) AS "midspanConnections",
        c.connected_asset_id AS "legacyConnectedAssetId",c.connected_side AS "legacyConnectedSide",legacy.name AS "legacyConnectedAssetName",
        b.id AS "bookingId",b.customer,b.pic_customer AS "picCustomer",b.pic_presales AS "picPresales",b.expires_at AS "expiresAt"
      FROM network_cores c LEFT JOIN booking_cores bc ON bc.core_id=c.id LEFT JOIN bookings b ON b.id=bc.booking_id
      LEFT JOIN network_assets legacy ON legacy.id=c.connected_asset_id
      LEFT JOIN network_segment_endpoints nea ON nea.segment_id=c.asset_id AND nea.side='A'
      LEFT JOIN network_assets na ON na.id=nea.node_asset_id
      LEFT JOIN network_core_end_connections ea ON ea.core_id=c.id AND ea.side='A'
      LEFT JOIN network_assets ena ON ena.id=ea.node_asset_id
      LEFT JOIN network_cores pa ON pa.id=ea.peer_core_id
      LEFT JOIN network_assets pas ON pas.id=pa.asset_id
      LEFT JOIN network_segment_endpoints neb ON neb.segment_id=c.asset_id AND neb.side='B'
      LEFT JOIN network_assets nb ON nb.id=neb.node_asset_id
      LEFT JOIN network_core_end_connections eb ON eb.core_id=c.id AND eb.side='B'
      LEFT JOIN network_assets enb ON enb.id=eb.node_asset_id
      LEFT JOIN network_cores pb ON pb.id=eb.peer_core_id
      LEFT JOIN network_assets pbs ON pbs.id=pb.asset_id
      WHERE c.asset_id=$1 ORDER BY c.core_number`,
      [assetId]
    );
    return rows;
  }

  async listCoreEndpoints(assetId: string) {
    const { rows: segment } = await this.db.query(
      "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' AND GeometryType(geometry)='LINESTRING'",
      [assetId]
    );
    if (!segment.length) {
      throw new NotFoundException({ message: "Segmen tidak ditemukan." });
    }
    const [{ rows }, candidates] = await Promise.all([
      this.db.query(
        `SELECT endpoint.side,endpoint.node_asset_id AS "nodeAssetId",node.name AS "nodeAssetName",
          node.attributes->>'Tipe Perangkat' AS "nodeAssetType",ST_X(node.geometry)::float8 AS longitude,
          ST_Y(node.geometry)::float8 AS latitude,endpoint.verification_status AS "verificationStatus",
          endpoint.source,endpoint.note,endpoint.updated_at AS "updatedAt"
         FROM network_segment_endpoints endpoint
         JOIN network_assets node ON node.id=endpoint.node_asset_id
         WHERE endpoint.segment_id=$1 ORDER BY endpoint.side`,
        [assetId]
      ),
      this.listCoreDestinations(assetId),
    ]);
    return (["A", "B"] as const).map((side) => ({
      side,
      endpoint: rows.find((row) => row.side === side) ?? null,
      candidates: candidates.filter((candidate) => candidate.side === side),
    }));
  }
  async listCoreRouteNodes(assetId: string) {
    const { rows: segments } = await this.db.query(
      "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' AND GeometryType(geometry)='LINESTRING'",
      [assetId]
    );
    if (!segments.length) {
      throw new NotFoundException({ message: "Segmen tidak ditemukan." });
    }
    const { rows } = await this.db.query(
      `WITH segment AS (
        SELECT id,geometry,attributes->>'Company' AS company,
          attributes->>'Distribution ID' AS distribution_id,
          ST_Length(geometry::geography) AS route_length_m
        FROM network_assets WHERE id=$1
      ), candidates AS (
        SELECT point.id,point.name,point.attributes->>'Tipe Perangkat' AS type,
          round((ST_LineLocatePoint(segment.geometry,
            ST_ClosestPoint(segment.geometry,point.geometry))*segment.route_length_m)::numeric,2) AS "routeMeasureM",
          round(ST_DistanceSphere(point.geometry,segment.geometry)::numeric,1) AS "distanceToRoute",
          segment.route_length_m AS "routeLengthM",
          (NULLIF(btrim(segment.distribution_id),'') IS NOT NULL AND
            NULLIF(btrim(point.attributes->>'Distribution ID'),'')=NULLIF(btrim(segment.distribution_id),'')) AS "matchesDistribution",
          (NULLIF(btrim(segment.company),'') IS NOT NULL AND
            lower(btrim(point.attributes->>'Company'))=lower(btrim(segment.company))) AS "matchesCompany"
        FROM segment JOIN network_assets point ON point.asset_type='asset'
          AND GeometryType(point.geometry)='POINT' AND point.geometry && ST_Expand(segment.geometry,0.001)
        WHERE upper(point.attributes->>'Tipe Perangkat')=ANY(ARRAY[
            'OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE'
          ])
          AND ST_DistanceSphere(point.geometry,segment.geometry)<=25
      )
      SELECT * FROM candidates
      WHERE "routeMeasureM">25 AND "routeMeasureM"<"routeLengthM"-25
      ORDER BY "matchesDistribution" DESC,"matchesCompany" DESC,"routeMeasureM",name`,
      [assetId]
    );
    return rows;
  }
  async listCoreDestinations(assetId: string) {
    const { rows: segments } = await this.db.query(
      "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' AND GeometryType(geometry)='LINESTRING'",
      [assetId]
    );
    if (!segments.length) {
      throw new NotFoundException({ message: "Segmen tidak ditemukan." });
    }
    const { rows } = await this.db.query(
      `WITH segment AS (
        SELECT id,geometry,attributes->>'Company' AS company,
          attributes->>'Distribution ID' AS distribution_id
        FROM network_assets
        WHERE id=$1 AND asset_type='segment' AND GeometryType(geometry)='LINESTRING'
      ), ends AS (
        SELECT s.id,s.geometry,s.company,s.distribution_id,'A'::text AS side,
          ST_StartPoint(s.geometry) AS point
        FROM segment s
        UNION ALL
        SELECT s.id,s.geometry,s.company,s.distribution_id,'B'::text,
          ST_EndPoint(s.geometry)
        FROM segment s
      )
      SELECT p.id,p.name,p.attributes->>'Tipe Perangkat' AS type,e.side,
        round(ST_DistanceSphere(p.geometry,e.point)::numeric,1) AS "distanceFromEndpoint",
        round(ST_DistanceSphere(p.geometry,e.geometry)::numeric,1) AS "distanceToRoute",
        ST_X(p.geometry)::float8 AS longitude,ST_Y(p.geometry)::float8 AS latitude,
        (NULLIF(btrim(e.distribution_id),'') IS NOT NULL AND NULLIF(btrim(p.attributes->>'Distribution ID'),'')=NULLIF(btrim(e.distribution_id),'')) AS "matchesDistribution",
        (NULLIF(btrim(e.company),'') IS NOT NULL AND lower(btrim(p.attributes->>'Company'))=lower(btrim(e.company))) AS "matchesCompany"
      FROM ends e JOIN network_assets p
        ON p.asset_type='asset' AND GeometryType(p.geometry)='POINT'
      WHERE p.geometry && ST_Expand(e.geometry,0.001)
        AND ST_DistanceSphere(p.geometry,e.point)<=25
        AND upper(p.attributes->>'Tipe Perangkat')=ANY(ARRAY['OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE'])
      ORDER BY e.side,(NULLIF(btrim(e.distribution_id),'') IS NOT NULL AND NULLIF(btrim(p.attributes->>'Distribution ID'),'')=NULLIF(btrim(e.distribution_id),'')) DESC,
        (NULLIF(btrim(e.company),'') IS NOT NULL AND lower(btrim(p.attributes->>'Company'))=lower(btrim(e.company))) DESC,
        ST_DistanceSphere(p.geometry,e.point),p.name`,
      [assetId]
    );
    return rows;
  }

  async listCoreConnectionPeers(
    assetId: string,
    side: string,
    nodeAssetId: string,
    routeMeasureM?: number
  ) {
    if (
      !["A", "B", "R"].includes(side) ||
      !nodeAssetId ||
      (side === "R" && (!Number.isFinite(routeMeasureM) || Number(routeMeasureM) <= 25))
    ) {
      throw new BadRequestException({ message: "Titik sambungan kabel tidak valid." });
    }
    const { rows } = await this.db.query(
      `WITH source AS (
        SELECT segment.id AS segment_id,segment.geometry AS segment_geometry,
          ST_Length(segment.geometry::geography) AS route_length_m,
          node.id AS node_asset_id,node.geometry AS node_geometry,
          segment.attributes->>'Company' AS company,segment.attributes->>'Distribution ID' AS distribution_id
        FROM network_assets segment
        JOIN network_assets node ON node.id=$3 AND node.asset_type='asset' AND GeometryType(node.geometry)='POINT'
          AND upper(node.attributes->>'Tipe Perangkat')=ANY(ARRAY['OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE'])
        WHERE segment.id=$1 AND segment.asset_type='segment' AND GeometryType(segment.geometry)='LINESTRING'
          AND CASE $2 WHEN 'A' THEN ST_DistanceSphere(node.geometry,ST_StartPoint(segment.geometry))<=25
            WHEN 'B' THEN ST_DistanceSphere(node.geometry,ST_EndPoint(segment.geometry))<=25
            ELSE ST_DistanceSphere(node.geometry,segment.geometry)<=25
              AND $4::numeric>25 AND $4::numeric<ST_Length(segment.geometry::geography)-25
              AND abs($4::numeric-(ST_LineLocatePoint(segment.geometry,
                ST_ClosestPoint(segment.geometry,node.geometry))*ST_Length(segment.geometry::geography)))<=1.5 END
      ), peer_positions AS (
        SELECT peer.id AS segment_id,peer.name,peer.total_cores,peer.attributes->>'Company' AS company,
          peer.attributes->>'Distribution ID' AS distribution_id,endpoint.side,
          NULL::numeric AS route_measure_m,source.node_asset_id,
          peerEndpoint.node_asset_id AS recorded_node_asset_id
        FROM source
        JOIN network_assets peer ON peer.asset_type='segment' AND peer.id<>source.segment_id
          AND GeometryType(peer.geometry)='LINESTRING' AND peer.total_cores>0
          AND peer.geometry && ST_Expand(source.node_geometry,0.001)
        CROSS JOIN LATERAL (VALUES
          ('A'::text,ST_StartPoint(peer.geometry)),('B'::text,ST_EndPoint(peer.geometry))
        ) endpoint(side,point)
        LEFT JOIN network_segment_endpoints peerEndpoint
          ON peerEndpoint.segment_id=peer.id AND peerEndpoint.side=endpoint.side
        WHERE ST_DistanceSphere(source.node_geometry,endpoint.point)<=25
          AND (peerEndpoint.segment_id IS NULL OR peerEndpoint.node_asset_id=source.node_asset_id)
        UNION ALL
        SELECT peer.id,peer.name,peer.total_cores,peer.attributes->>'Company',
          peer.attributes->>'Distribution ID','R'::text,
          round((ST_LineLocatePoint(peer.geometry,
            ST_ClosestPoint(peer.geometry,source.node_geometry))*ST_Length(peer.geometry::geography))::numeric,2),
          source.node_asset_id,NULL::text
        FROM source JOIN network_assets peer ON peer.asset_type='segment'
          AND peer.id<>source.segment_id AND GeometryType(peer.geometry)='LINESTRING'
          AND peer.total_cores>0 AND peer.geometry && ST_Expand(source.node_geometry,0.001)
        WHERE ST_DistanceSphere(source.node_geometry,peer.geometry)<=25
          AND ST_LineLocatePoint(peer.geometry,ST_ClosestPoint(peer.geometry,source.node_geometry))*
            ST_Length(peer.geometry::geography)>25
          AND ST_LineLocatePoint(peer.geometry,ST_ClosestPoint(peer.geometry,source.node_geometry))*
            ST_Length(peer.geometry::geography)<ST_Length(peer.geometry::geography)-25
      )
      SELECT peerPosition.segment_id AS "peerSegmentId",peerPosition.name AS "peerSegmentName",
        peerPosition.side AS "peerSide",peerPosition.route_measure_m AS "peerRouteMeasureM",
        peerCore.core_number AS "peerCoreNumber",peerCore.status AS "peerStatus",
        existing.connection_type AS "existingConnectionType",existing.peer_core_id AS "existingPeerCoreId",
        existing.peer_side AS "existingPeerSide",existing.connection_group_id AS "connectionGroupId",
        connectedCore.asset_id AS "connectedSegmentId",connectedCore.core_number AS "connectedCoreNumber",
        existing.peer_side AS "connectedSide",existing.peer_route_measure_m AS "connectedRouteMeasureM",
        (existing.id IS NOT NULL) AS "isOccupied",
        peerPosition.recorded_node_asset_id AS "recordedNodeAssetId",
        (NULLIF(btrim(peerPosition.distribution_id),'') IS NOT NULL AND
          NULLIF(btrim(peerPosition.distribution_id),'')=NULLIF(btrim(source.distribution_id),'')) AS "matchesDistribution",
        (NULLIF(btrim(peerPosition.company),'') IS NOT NULL AND
          lower(btrim(peerPosition.company))=lower(btrim(source.company))) AS "matchesCompany"
      FROM source
      JOIN peer_positions peerPosition ON true
      JOIN network_cores peerCore ON peerCore.asset_id=peerPosition.segment_id
      LEFT JOIN network_core_end_connections existing ON existing.core_id=peerCore.id
        AND existing.side=peerPosition.side AND existing.node_asset_id=source.node_asset_id
        AND (peerPosition.side<>'R' OR existing.route_measure_m=peerPosition.route_measure_m)
      LEFT JOIN network_cores connectedCore ON connectedCore.id=existing.peer_core_id
      ORDER BY "matchesDistribution" DESC,"matchesCompany" DESC,
        peerPosition.name,peerPosition.side,peerPosition.route_measure_m,peerCore.core_number`,
      [assetId, side, nodeAssetId, routeMeasureM ?? null]
    );
    if (!rows.length) {
      const { rows: segment } = await this.db.query(
        "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment'",
        [assetId]
      );
      if (!segment.length) throw new NotFoundException({ message: "Segmen tidak ditemukan." });
    }
    return rows;
  }

  async listCoreMappings(segmentId: string) {
    const { rows: segment } = await this.db.query("SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment'", [segmentId]);
    if (!segment.length) throw new NotFoundException({ message: "Kabel tidak ditemukan." });
    const { rows } = await this.db.query(
      `SELECT m.id,m.source,m.note,m.created_at AS "createdAt",m.node_asset_id AS "nodeAssetId",n.name AS "nodeName",
        a.asset_id AS "cableAId",ca.name AS "cableAName",a.core_number AS "coreA",
        b.asset_id AS "cableBId",cb.name AS "cableBName",b.core_number AS "coreB",m.splitter_input AS "splitterInput"
       FROM network_core_mappings m JOIN network_assets n ON n.id=m.node_asset_id
       JOIN network_cores a ON a.id=m.core_a_id JOIN network_assets ca ON ca.id=a.asset_id
       LEFT JOIN network_cores b ON b.id=m.core_b_id LEFT JOIN network_assets cb ON cb.id=b.asset_id
       WHERE a.asset_id=$1 OR b.asset_id=$1 ORDER BY n.name,a.core_number,m.id`, [segmentId]);
    return rows;
  }

  async createCoreMapping(segmentId: string, input: Record<string, unknown>, userId: string) {
    const node = input?.nodeAssetId;
    const core = input?.coreNumber;
    const peer = input?.peerSegmentId;
    const peerCore = input?.peerCoreNumber;
    const source = input?.source;
    const splitter = typeof input?.splitterInput === "string" ? input.splitterInput.trim() : "";
    const note = typeof input?.note === "string" ? input.note.trim() : "";
    const isSplice = typeof peer === "string" && peer.length > 0;
    if (typeof node !== "string" || !node || !Number.isSafeInteger(core) || Number(core) < 1 || !["Survei lapangan", "Data operasional", "Dokumen inventaris"].includes(String(source)) || note.length > 500 || (!isSplice && peer != null && peer !== "") || (isSplice ? peer === segmentId || !Number.isSafeInteger(peerCore) || Number(peerCore) < 1 || !!splitter : !splitter || splitter.length > 80 || peerCore != null)) {
      throw new BadRequestException({ message: "Data sambungan core tidak valid." });
    }
    try {
      const mappingId = await this.db.transaction(async (client) => {
        const { rows: nodes } = await client.query(`SELECT id,lower(concat_ws(' ',name,attributes->>'folderPath',attributes->>'assetKind',attributes->>'Tipe Perangkat')) AS label FROM network_assets WHERE id=$1 AND asset_type='asset' AND GeometryType(geometry)='POINT' FOR UPDATE`, [node]);
        if (!nodes.length) throw new BadRequestException({ message: "Pilih titik terminasi yang tersedia." });
        if (!isSplice && !/(^|[^a-z0-9])(odp|fat|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)/u.test(nodes[0].label)) throw new BadRequestException({ message: "Masukan splitter harus berada pada ODP." });
        const ids = isSplice ? [segmentId, peer] : [segmentId];
        const { rows: cables } = await client.query("SELECT id FROM network_assets WHERE id=ANY($1::text[]) AND asset_type='segment' ORDER BY id FOR UPDATE", [ids]);
        if (cables.length !== ids.length) throw new BadRequestException({ message: "Kabel tidak ditemukan." });
        const { rows: cores } = await client.query("SELECT id,asset_id AS \"assetId\",core_number AS \"coreNumber\" FROM network_cores WHERE (asset_id=$1 AND core_number=$2) OR (asset_id=$3 AND core_number=$4) ORDER BY id FOR UPDATE", [segmentId, core, isSplice ? peer : segmentId, isSplice ? peerCore : core]);
        const first = cores.find((row) => row.assetId === segmentId && row.coreNumber === core);
        const second = isSplice ? cores.find((row) => row.assetId === peer && row.coreNumber === peerCore) : null;
        if (!first || (isSplice && !second)) throw new BadRequestException({ message: "Nomor core tidak ditemukan pada kabel yang dipilih." });
        const ordered = second ? [Number(first.id), Number(second.id)].sort((a, b) => a - b) : [Number(first.id), null];
        const { rows: occupied } = await client.query(`SELECT id FROM network_core_mappings WHERE node_asset_id=$1 AND (core_a_id=ANY($2::bigint[]) OR core_b_id=ANY($2::bigint[])) LIMIT 1`, [node, ordered.filter((value) => value !== null)]);
        if (occupied.length) throw new ConflictException({ message: "Salah satu core sudah memiliki sambungan pada titik ini." });
        if (!isSplice) {
          const { rows: inputTaken } = await client.query("SELECT id FROM network_core_mappings WHERE node_asset_id=$1 AND lower(splitter_input)=lower($2) LIMIT 1", [node, splitter]);
          if (inputTaken.length) throw new ConflictException({ message: "Masukan splitter tersebut sudah tercatat." });
        }
        const { rows } = await client.query(`INSERT INTO network_core_mappings(node_asset_id,core_a_id,core_b_id,splitter_input,source,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [node, ordered[0], ordered[1], isSplice ? null : splitter, source, note, userId]);
        await audit(client, userId, "CORE_MAPPING_CREATED", "ASSET", segmentId, { mappingId: rows[0].id, nodeAssetId: node, coreNumber: core, peerSegmentId: isSplice ? peer : null, peerCoreNumber: isSplice ? peerCore : null, splitterInput: isSplice ? null : splitter, source });
        return rows[0].id;
      });
      return { id: mappingId };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ConflictException({ message: "Sambungan ini atau masukan splitter tersebut sudah tercatat." });
      throw error;
    }
  }

  async deleteCoreMapping(segmentId: string, mappingId: string, userId: string) {
    if (!/^[0-9a-f-]{36}$/iu.test(mappingId)) throw new BadRequestException({ message: "ID sambungan tidak valid." });
    return this.db.transaction(async (client) => {
      const { rows } = await client.query(`DELETE FROM network_core_mappings m USING network_cores a WHERE m.id=$1 AND a.id=m.core_a_id AND (a.asset_id=$2 OR EXISTS (SELECT 1 FROM network_cores b WHERE b.id=m.core_b_id AND b.asset_id=$2)) RETURNING m.id,m.node_asset_id AS "nodeAssetId"`, [mappingId, segmentId]);
      if (!rows.length) throw new NotFoundException({ message: "Sambungan tidak ditemukan pada kabel ini." });
      await audit(client, userId, "CORE_MAPPING_DELETED", "ASSET", segmentId, rows[0]);
      return { id: rows[0].id };
    });
  }

  async verifyCoreUsage(
    assetId: string,
    source: string | undefined,
    note: string | undefined,
    userId: string,
    coreStatuses: CoreStatusUpdate[] = [],
    segmentEndpoints: SegmentEndpointUpdate = {}
  ) {
    const allowedSources = [
      "Survei lapangan",
      "Data operasional",
      "Dokumen inventaris",
    ];
    const cleanNote = String(note ?? "")
      .trim()
      .slice(0, 500);
    if (!allowedSources.includes(String(source))) {
      throw new BadRequestException({ message: "Pilih sumber verifikasi." });
    }
    const connectionFieldsValid = (connection: CoreEndConnectionInput) => {
      if (connection === null) return true;
      if (!connection || typeof connection !== "object") return false;
      if (connection.connectionType === "splice") {
        return typeof connection.peerSegmentId === "string" &&
          connection.peerSegmentId.length > 0 &&
          Number.isInteger(connection.peerCoreNumber) &&
          Number(connection.peerCoreNumber) > 0 &&
          ["A", "B", "R"].includes(connection.peerSide) &&
          (connection.peerSide === "R"
            ? Number.isFinite(connection.peerRouteMeasureM) && Number(connection.peerRouteMeasureM) > 25
            : connection.peerRouteMeasureM === undefined) &&
          connection.peerSegmentId !== assetId;
      }
      if (connection.connectionType === "device_port") {
        return typeof connection.portReference === "string" &&
          connection.portReference.trim().length > 0 &&
          connection.portReference.trim().length <= 100;
      }
      return connection.connectionType === "termination";
    };
    const endConnectionFieldsValid = (entry: CoreStatusUpdate) =>
      entry.endConnections === undefined ||
      (!!entry.endConnections &&
        typeof entry.endConnections === "object" &&
        Object.entries(entry.endConnections).every(([side, connection]) =>
          (side === "A" || side === "B") && connectionFieldsValid(connection)
        ));
    const midspanConnectionsValid = (entry: CoreStatusUpdate) =>
      entry.midspanConnections === undefined ||
      (Array.isArray(entry.midspanConnections) &&
        entry.midspanConnections.every((item) =>
          !!item &&
          typeof item.nodeAssetId === "string" &&
          item.nodeAssetId.length > 0 &&
          Number.isFinite(item.routeMeasureM) &&
          item.routeMeasureM > 25 &&
          item.connection !== null &&
          connectionFieldsValid(item.connection)
        ) &&
        new Set(
          entry.midspanConnections.map(
            (item) => `${item.nodeAssetId}:${Number(item.routeMeasureM).toFixed(2)}`
          )
        ).size === entry.midspanConnections.length);
    const endpointUpdatesValid =
      segmentEndpoints &&
      typeof segmentEndpoints === "object" &&
      Object.entries(segmentEndpoints).every(
        ([side, nodeAssetId]) =>
          (side === "A" || side === "B") &&
          (nodeAssetId === null ||
            (typeof nodeAssetId === "string" && nodeAssetId.length > 0))
      );
    if (
      !Array.isArray(coreStatuses) ||
      coreStatuses.some(
        (entry) =>
          !entry ||
          typeof entry !== "object" ||
          !Number.isInteger(entry.coreNumber) ||
          entry.coreNumber < 1 ||
          !["Available", "Used"].includes(entry.status) ||
          !endConnectionFieldsValid(entry) ||
          !midspanConnectionsValid(entry)
      ) ||
      new Set(coreStatuses.map(({ coreNumber }) => coreNumber)).size !== coreStatuses.length ||
      !endpointUpdatesValid
    ) {
      throw new BadRequestException({
        message: "Perubahan status core tidak valid.",
      });
    }
    try {
      return await this.db.transaction(async (client) => {
        const referencedSegmentIds = coreStatuses.flatMap((entry) => {
          const peers = [
            ...Object.values(entry.endConnections ?? {}),
            ...(entry.midspanConnections ?? []).map((item) => item.connection),
          ];
          return peers.flatMap((connection) =>
            connection?.connectionType === "splice"
              ? [connection.peerSegmentId]
              : []
          );
        });
        const segmentIdsToLock = [...new Set([assetId, ...referencedSegmentIds])];
        const { rows: assets } = await client.query(
          `SELECT id,total_cores FROM network_assets
           WHERE id=ANY($1::text[]) AND asset_type='segment' AND GeometryType(geometry)='LINESTRING'
           ORDER BY id FOR UPDATE`,
          [segmentIdsToLock]
        );
        if (assets.length !== segmentIdsToLock.length) {
          throw new NotFoundException({ message: "Segmen tidak ditemukan." });
        }
        const sourceSegment = assets.find((asset) => asset.id === assetId);
        if (!sourceSegment) {
          throw new NotFoundException({ message: "Segmen tidak ditemukan." });
        }
        const total = Number(sourceSegment.total_cores);
        const requestedNumbers = coreStatuses.map(({ coreNumber }) => coreNumber);
        const { rows: currentCores } = await client.query(
          `SELECT id,core_number AS "coreNumber",status FROM network_cores
           WHERE asset_id=$1 AND core_number=ANY($2::int[]) ORDER BY id FOR UPDATE`,
          [assetId, requestedNumbers]
        );
        const currentByNumber = new Map(currentCores.map((core) => [core.coreNumber, core]));
        if (currentByNumber.size !== coreStatuses.length) {
          const missing = coreStatuses.find((entry) => !currentByNumber.has(entry.coreNumber));
          throw new NotFoundException({ message: `Core ${missing?.coreNumber ?? ""} tidak ditemukan.` });
        }

        const changedConnections: {
          coreId: number;
          coreNumber: number;
          side: CorePosition;
          nodeAssetId?: string;
          routeMeasureM?: number;
          connection: Exclude<CoreEndConnectionInput, null> | null;
        }[] = [];
        for (const entry of coreStatuses) {
          const current = currentByNumber.get(entry.coreNumber)!;
          if (current.status === "Booked") {
            throw new ConflictException({ message: `Core ${entry.coreNumber} sedang dibooking dan tidak dapat diubah.` });
          }
          if (entry.endConnections) {
            for (const side of ["A", "B"] as const) {
              if (Object.hasOwn(entry.endConnections, side)) {
                changedConnections.push({
                  coreId: Number(current.id),
                  coreNumber: entry.coreNumber,
                  side,
                  connection: entry.endConnections[side] ?? null,
                });
              }
            }
          }
          if (entry.midspanConnections !== undefined) {
            changedConnections.push({
              coreId: Number(current.id),
              coreNumber: entry.coreNumber,
              side: "R",
              connection: null,
            });
            for (const midspan of entry.midspanConnections) {
              changedConnections.push({
                coreId: Number(current.id),
                coreNumber: entry.coreNumber,
                side: "R",
                nodeAssetId: midspan.nodeAssetId,
                routeMeasureM: Number(midspan.routeMeasureM),
                connection: midspan.connection,
              });
            }
          }
          if (current.status !== entry.status) {
            await client.query(
              "UPDATE network_cores SET status=$3 WHERE asset_id=$1 AND core_number=$2",
              [assetId, entry.coreNumber, entry.status]
            );
            await audit(client, userId, "CORE_STATUS_CHANGED", "CORE", `${assetId}:${entry.coreNumber}`, {
              assetId,
              coreNumber: entry.coreNumber,
              status: entry.status,
            });
            if (entry.status === "Available") await allocateWaiting(client, assetId, userId);
          }
        }

        const oldGroupIds = new Set<string>();
        for (const { coreId, side } of changedConnections) {
          const { rows } = await client.query(
            "SELECT connection_group_id AS \"groupId\" FROM network_core_end_connections WHERE core_id=$1 AND side=$2 FOR UPDATE",
            [coreId, side]
          );
          for (const row of rows) {
            if (row.groupId) oldGroupIds.add(row.groupId);
          }
        }
        if (oldGroupIds.size) {
          await client.query(
            "DELETE FROM network_core_end_connections WHERE connection_group_id=ANY($1::uuid[])",
            [[...oldGroupIds]]
          );
        }

        for (const side of ["A", "B"] as const) {
          if (!Object.hasOwn(segmentEndpoints, side)) continue;
          const nodeAssetId = segmentEndpoints[side];
          if (nodeAssetId === null) {
            const { rows: attached } = await client.query(
              `SELECT 1 FROM network_core_end_connections connection
               JOIN network_cores core ON core.id=connection.core_id
               WHERE core.asset_id=$1 AND connection.side=$2 LIMIT 1`,
              [assetId, side]
            );
            if (attached.length) {
              throw new ConflictException({
                message: `Hapus sambungan core pada Ujung ${side} sebelum menghapus titik ujung kabel.`,
              });
            }
            await client.query(
              "DELETE FROM network_segment_endpoints WHERE segment_id=$1 AND side=$2",
              [assetId, side]
            );
            await audit(client, userId, "CABLE_ENDPOINT_CLEARED", "ASSET", assetId, { side });
            continue;
          }

          const { rows: node } = await client.query(
            `SELECT point.id FROM network_assets segment JOIN network_assets point
              ON point.id=$3 AND point.asset_type='asset' AND GeometryType(point.geometry)='POINT'
              WHERE segment.id=$1 AND segment.asset_type='segment'
                AND upper(point.attributes->>'Tipe Perangkat')=ANY(ARRAY['OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE'])
                AND CASE $2 WHEN 'A' THEN ST_DistanceSphere(point.geometry,ST_StartPoint(segment.geometry))<=25
                  ELSE ST_DistanceSphere(point.geometry,ST_EndPoint(segment.geometry))<=25 END`,
            [assetId, side, nodeAssetId]
          );
          if (!node.length) {
            throw new BadRequestException({
              message: `Titik Ujung ${side} harus berupa aset jaringan yang berada maksimal 25 meter dari ujung kabel.`,
            });
          }
          const { rows: existingEndpoint } = await client.query(
            "SELECT node_asset_id AS \"nodeAssetId\" FROM network_segment_endpoints WHERE segment_id=$1 AND side=$2 FOR UPDATE",
            [assetId, side]
          );
          if (existingEndpoint[0]?.nodeAssetId !== nodeAssetId) {
            const { rows: attached } = await client.query(
              `SELECT 1 FROM network_core_end_connections connection
               JOIN network_cores core ON core.id=connection.core_id
               WHERE core.asset_id=$1 AND connection.side=$2 LIMIT 1`,
              [assetId, side]
            );
            if (attached.length) {
              throw new ConflictException({
                message: `Ujung ${side} sudah memiliki sambungan core. Hapus sambungan tersebut sebelum mengganti titik ujung.`,
              });
            }
          }
          await client.query(
            `INSERT INTO network_segment_endpoints
              (segment_id,side,node_asset_id,verification_status,source,note,created_by,updated_at)
             VALUES($1,$2,$3,'confirmed',$4,$5,$6,now())
             ON CONFLICT(segment_id,side) DO UPDATE SET node_asset_id=EXCLUDED.node_asset_id,
               verification_status='confirmed',source=EXCLUDED.source,note=EXCLUDED.note,
               created_by=EXCLUDED.created_by,updated_at=now()`,
            [assetId, side, nodeAssetId, source, cleanNote, userId]
          );
          await audit(client, userId, "CABLE_ENDPOINT_CONFIRMED", "ASSET", assetId, {
            side,
            nodeAssetId,
            source,
          });
        }

        for (const change of changedConnections) {
          if (!change.connection) continue;
          let sourcePosition: {
            nodeAssetId: string;
            nodeName: string;
            routeMeasureM: number | null;
          } | undefined;
          if (change.side === "R") {
            const { rows } = await client.query(
              `SELECT point.id AS "nodeAssetId",point.name AS "nodeName"
               FROM network_assets segment JOIN network_assets point
                 ON point.id=$3 AND point.asset_type='asset' AND GeometryType(point.geometry)='POINT'
               WHERE segment.id=$1 AND segment.asset_type='segment'
                 AND upper(point.attributes->>'Tipe Perangkat')=ANY(ARRAY['OLT','POP','OTB','ODC','ODP','CLOSURE','SLACK / COIL','TIANG','POLE'])
                 AND ST_DistanceSphere(point.geometry,segment.geometry)<=25
                 AND $2::numeric>25
                 AND $2::numeric<ST_Length(segment.geometry::geography)-25
                 AND abs($2::numeric-(ST_LineLocatePoint(segment.geometry,
                   ST_ClosestPoint(segment.geometry,point.geometry))*ST_Length(segment.geometry::geography)))<=1.5
               FOR UPDATE OF segment,point`,
              [assetId, change.routeMeasureM, change.nodeAssetId]
            );
            if (!rows.length) {
              throw new BadRequestException({
                message: `Titik sambungan Core ${change.coreNumber} harus berada maksimal 25 meter dari jalur dan lebih dari 25 meter dari kedua ujung kabel.`,
              });
            }
            sourcePosition = {
              ...rows[0],
              routeMeasureM: Number(change.routeMeasureM),
            };
          } else {
            const { rows } = await client.query(
              `SELECT endpoint.node_asset_id AS "nodeAssetId",node.name AS "nodeName"
               FROM network_segment_endpoints endpoint
               JOIN network_assets node ON node.id=endpoint.node_asset_id
               WHERE endpoint.segment_id=$1 AND endpoint.side=$2
                 AND endpoint.verification_status='confirmed' FOR UPDATE OF endpoint`,
              [assetId, change.side]
            );
            sourcePosition = rows[0]
              ? { ...rows[0], routeMeasureM: null }
              : undefined;
          }
          if (!sourcePosition) {
            throw new BadRequestException({
              message: change.side === "R"
                ? `Pilih aset dan posisi di sepanjang jalur untuk Core ${change.coreNumber}.`
                : `Tentukan dan simpan titik Ujung ${change.side} kabel sebelum mencatat sambungan Core ${change.coreNumber}.`,
            });
          }
          const connection = change.connection;
          if (connection.connectionType === "splice") {
            const { rows: peer } = await client.query(
              `SELECT peer.id AS "segmentId",peer.name AS "segmentName",peerCore.id AS "coreId",
                  peerCore.core_number AS "coreNumber",peerCore.status,
                  CASE WHEN $3='R' THEN round((ST_LineLocatePoint(peer.geometry,
                    ST_ClosestPoint(peer.geometry,node.geometry))*ST_Length(peer.geometry::geography))::numeric,2)
                    ELSE NULL END AS "peerRouteMeasureM"
               FROM network_assets peer
               JOIN network_assets node ON node.id=$5 AND node.asset_type='asset' AND GeometryType(node.geometry)='POINT'
               LEFT JOIN network_segment_endpoints peerEnd ON peerEnd.segment_id=peer.id
                 AND peerEnd.side=$3 AND $3 IN ('A','B')
               JOIN network_cores peerCore ON peerCore.asset_id=peer.id AND peerCore.core_number=$2
               WHERE peer.id=$1 AND peer.id<>$4 AND peer.asset_type='segment'
                 AND (peerEnd.node_asset_id IS NULL OR peerEnd.node_asset_id=$5 OR $3='R')
                 AND CASE $3
                   WHEN 'A' THEN ST_DistanceSphere(node.geometry,ST_StartPoint(peer.geometry))<=25
                   WHEN 'B' THEN ST_DistanceSphere(node.geometry,ST_EndPoint(peer.geometry))<=25
                   ELSE ST_DistanceSphere(node.geometry,peer.geometry)<=25
                     AND $6::numeric>25
                     AND $6::numeric<ST_Length(peer.geometry::geography)-25
                     AND abs($6::numeric-(ST_LineLocatePoint(peer.geometry,
                       ST_ClosestPoint(peer.geometry,node.geometry))*ST_Length(peer.geometry::geography)))<=1.5
                 END
               FOR UPDATE OF peer,peerCore`,
              [connection.peerSegmentId, connection.peerCoreNumber, connection.peerSide, assetId,
                sourcePosition.nodeAssetId, connection.peerSide === "R" ? connection.peerRouteMeasureM : null]
            );
            if (!peer.length) {
              throw new BadRequestException({
                message: `Posisi kabel tujuan Core ${change.coreNumber} tidak berada pada titik sambungan ${sourcePosition.nodeName}.`,
              });
            }
            const peerCoreId = Number(peer[0].coreId);
            if (connection.peerSide !== "R") {
              await client.query(
                `INSERT INTO network_segment_endpoints
                  (segment_id,side,node_asset_id,verification_status,source,note,created_by,updated_at)
                 VALUES($1,$2,$3,'confirmed',$4,$5,$6,now())
                 ON CONFLICT(segment_id,side) DO UPDATE SET
                   verification_status='confirmed',source=EXCLUDED.source,note=EXCLUDED.note,
                   created_by=EXCLUDED.created_by,updated_at=now()`,
                [connection.peerSegmentId, connection.peerSide, sourcePosition.nodeAssetId, source, cleanNote, userId]
              );
            }
            const { rows: occupiedPeer } = await client.query(
              `SELECT 1 FROM network_core_end_connections
               WHERE core_id=$1 AND side=$2 AND node_asset_id=$3
                 AND ($2<>'R' OR route_measure_m=$4::numeric)
               LIMIT 1 FOR UPDATE`,
              [peerCoreId, connection.peerSide, sourcePosition.nodeAssetId,
                connection.peerSide === "R" ? connection.peerRouteMeasureM : null]
            );
            if (occupiedPeer.length) {
              throw new ConflictException({
                message: `${connection.peerSide === "R" ? "Titik jalur" : `Ujung ${connection.peerSide}`} Core ${connection.peerCoreNumber} pada kabel tujuan sudah tersambung.`,
              });
            }
            const groupId = randomUUID();
            await client.query(
              `INSERT INTO network_core_end_connections
                (connection_group_id,connection_type,core_id,side,node_asset_id,route_measure_m,
                 peer_core_id,peer_side,peer_route_measure_m,verification_status,source,note,created_by)
               VALUES($1,'splice',$2,$3,$4,$5,$6,$7,$8,'confirmed',$9,$10,$11),
                     ($1,'splice',$6,$7,$4,$8,$2,$3,$5,'confirmed',$9,$10,$11)`,
              [groupId, change.coreId, change.side, sourcePosition.nodeAssetId, sourcePosition.routeMeasureM,
                peerCoreId, connection.peerSide,
                connection.peerSide === "R" ? Number(peer[0].peerRouteMeasureM) : null,
                source, cleanNote, userId]
            );
            await audit(client, userId, "CORE_SPLICE_RECORDED", "CORE", `${assetId}:${change.coreNumber}:${change.side}`, {
              connectionGroupId: groupId,
              nodeAssetId: sourcePosition.nodeAssetId,
              sourceCoreNumber: change.coreNumber,
              sourceSide: change.side,
              sourceRouteMeasureM: sourcePosition.routeMeasureM,
              peerSegmentId: connection.peerSegmentId,
              peerCoreNumber: connection.peerCoreNumber,
              peerSide: connection.peerSide,
              peerRouteMeasureM: connection.peerSide === "R" ? Number(peer[0].peerRouteMeasureM) : null,
              source,
            });
          } else {
            const groupId = randomUUID();
            await client.query(
              `INSERT INTO network_core_end_connections
                (connection_group_id,connection_type,core_id,side,node_asset_id,route_measure_m,
                 port_reference,verification_status,source,note,created_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed',$8,$9,$10)`,
              [groupId, connection.connectionType, change.coreId, change.side,
                sourcePosition.nodeAssetId, sourcePosition.routeMeasureM,
                connection.connectionType === "device_port" ? connection.portReference.trim() : null,
                source, cleanNote, userId]
            );
            await audit(client, userId, "CORE_END_RECORDED", "CORE", `${assetId}:${change.coreNumber}:${change.side}`, {
              connectionGroupId: groupId,
              connectionType: connection.connectionType,
              nodeAssetId: sourcePosition.nodeAssetId,
              coreNumber: change.coreNumber,
              side: change.side,
              routeMeasureM: sourcePosition.routeMeasureM,
              portReference: connection.connectionType === "device_port" ? connection.portReference.trim() : null,
              source,
            });
          }
        }

      const { rows: counts } = await client.query(
        `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='Available')::int AS available,
        count(*) FILTER (WHERE status='Used')::int AS used,
        count(*) FILTER (WHERE status='Booked')::int AS booked
        FROM network_cores WHERE asset_id=$1`,
        [assetId]
      );
      if (!total || counts[0].total !== total) {
        throw new ConflictException({
          message:
            "Daftar core belum lengkap. Lengkapi jumlah core sebelum verifikasi.",
        });
      }
      const verification = {
        availableCores: counts[0].available,
        bookedCores: counts[0].booked,
        note: cleanNote,
        source,
        totalCores: total,
        usedCores: counts[0].used,
        verified: true,
        verifiedAt: new Date().toISOString(),
        verifiedBy: userId,
      };
      await client.query(
        `UPDATE network_assets SET attributes=jsonb_set(COALESCE(attributes,'{}'::jsonb),'{__coreUsageVerification}',$2::jsonb,true),updated_at=now() WHERE id=$1`,
        [assetId, JSON.stringify(verification)]
      );
      await audit(
        client,
        userId,
        "CORE_USAGE_VERIFIED",
        "ASSET",
        assetId,
        verification
      );
      return { assetId, ...verification };
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new ConflictException({ message: "Sambungan pada ujung core tersebut baru saja berubah. Muat ulang data dan coba lagi." });
      }
      throw error;
    }
  }
  private async setCoreCount(
    client: PoolClient,
    assetId: string,
    total: number
  ) {
    await client.query("SELECT id FROM network_assets WHERE id=$1 FOR UPDATE", [
      assetId,
    ]);
    const { rows: connected } = await client.query(
      `SELECT c.core_number FROM network_cores c
       WHERE c.asset_id=$1 AND c.core_number>$2
         AND EXISTS (SELECT 1 FROM network_core_end_connections e WHERE e.core_id=c.id OR e.peer_core_id=c.id)
       LIMIT 1`,
      [assetId, total]
    );
    if (connected.length) {
      throw new ConflictException({ message: "Kapasitas tidak dapat dikurangi karena core yang akan dihapus masih memiliki catatan sambungan." });
    }
    const { rows: mapped } = await client.query(
      `SELECT c.core_number FROM network_cores c JOIN network_core_mappings m ON c.id IN (m.core_a_id,m.core_b_id) WHERE c.asset_id=$1 AND c.core_number>$2 LIMIT 1`,
      [assetId, total]
    );
    if (mapped.length) throw new ConflictException({ message: "Kapasitas tidak dapat dikurangi karena core yang akan dihapus masih memiliki catatan sambungan." });
    const { rows: active } = await client.query(
      `SELECT id FROM network_cores WHERE asset_id=$1 AND core_number > $2 AND status <> 'Available' LIMIT 1`,
      [assetId, total]
    );
    if (active.length) {
      throw new ConflictException({
        message:
          "Kapasitas tidak dapat dikurangi karena nomor core yang akan dihapus masih Used atau Booked.",
      });
    }
    await client.query(
      `DELETE FROM network_cores WHERE asset_id=$1 AND core_number > $2 AND status='Available'`,
      [assetId, total]
    );
    await client.query(
      "INSERT INTO network_cores(asset_id,core_number) SELECT $1,n FROM generate_series(1,$2) n ON CONFLICT DO NOTHING",
      [assetId, total]
    );
    await client.query(
      "UPDATE network_assets SET total_cores=$2,updated_at=now() WHERE id=$1",
      [assetId, total]
    );
  }
  async setCoreStatus(
    assetId: string,
    coreNumber: number,
    status: string | undefined,
    userId: string
  ) {
    if (
      !Number.isInteger(coreNumber) ||
      coreNumber < 1 ||
      !["Available", "Used"].includes(String(status))
    ) {
      throw new BadRequestException({
        message: "Status core harus Available atau Used.",
      });
    }
    return this.db.transaction(async (client) => {
      const { rows: segment } = await client.query(
        "SELECT id FROM network_assets WHERE id=$1 AND asset_type='segment' FOR UPDATE",
        [assetId]
      );
      if (!segment.length) {
        throw new NotFoundException({ message: "Segmen tidak ditemukan." });
      }
      const { rows } = await client.query(
        "SELECT id,status FROM network_cores WHERE asset_id=$1 AND core_number=$2 FOR UPDATE",
        [assetId, coreNumber]
      );
      if (!rows.length) {
        throw new NotFoundException({ message: "Core tidak ditemukan." });
      }
      if (rows[0].status === "Booked") {
        throw new ConflictException({
          message: "Core yang sedang dibooking tidak dapat diubah.",
        });
      }
      await client.query(
        "UPDATE network_cores SET status=$3 WHERE asset_id=$1 AND core_number=$2",
        [assetId, coreNumber, status]
      );
      await client.query(
        `UPDATE network_assets SET attributes=attributes-'__coreUsageVerified' || jsonb_build_object('__coreUsageVerification',COALESCE(attributes->'__coreUsageVerification','{}'::jsonb) || '{"verified":false}'::jsonb),updated_at=now() WHERE id=$1`,
        [assetId]
      );
      await audit(
        client,
        userId,
        "CORE_STATUS_CHANGED",
        "CORE",
        `${assetId}:${coreNumber}`,
        { assetId, coreNumber, status }
      );
      if (status === "Available") {
        await allocateWaiting(client, assetId, userId);
      }
      const { rows: current } = await client.query(
        "SELECT status FROM network_cores WHERE asset_id=$1 AND core_number=$2",
        [assetId, coreNumber]
      );
      return { assetId, coreNumber, status: current[0].status };
    });
  }
  async dashboard() {
    const [assets, bookings, topSegments] = await Promise.all([
      this.db.query(`SELECT (SELECT count(*)::int FROM network_assets WHERE asset_type='segment') AS segments,
       COALESCE((SELECT sum(total_cores)::int FROM network_assets WHERE asset_type='segment'),0) AS "totalCores",
       (SELECT count(*)::int FROM network_cores c JOIN network_assets a ON a.id=c.asset_id WHERE a.asset_type='segment' AND c.status='Used') AS "usedCores",
       (SELECT count(*)::int FROM network_cores c JOIN network_assets a ON a.id=c.asset_id WHERE a.asset_type='segment' AND c.status='Booked') AS "bookedCores"`),
      this.booking.listBookings(),
      this.listDashboardSegments(),
    ]);
    return {
      ...assets.rows[0],
      recentBookings: bookings.slice(0, 4),
      topSegments,
      waitingCount: bookings.filter((item) => item.status === "Waiting List")
        .length,
    };
  }
  async networkUsageReport() {
    const { rows } =
      await this.db.query(`SELECT a.id,a.name,a.area,a.cable_type AS "cableType",a.total_cores AS "totalCores",
      count(c.id) FILTER (WHERE c.status='Used')::int AS "usedCores",
      count(c.id) FILTER (WHERE c.status='Available')::int AS "availableCores",
      count(c.id) FILTER (WHERE c.status='Booked')::int AS "bookedCores",
      (SELECT count(*)::int FROM bookings b WHERE b.segment_id=a.id AND b.status='Waiting List') AS "waitingList",
      a.installation,a.road_side AS side,a.pole,a.pole_height AS "poleHeight",a.odc,a.odp,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('assetId',linked.id,'kind',r.kind,'name',linked.name,'poleHeight',linked.pole_height) ORDER BY r.kind,linked.name)
        FROM network_asset_relations r JOIN network_assets linked ON linked.id=r.asset_id WHERE r.segment_id=a.id),'[]'::jsonb) AS "relatedAssets"
      FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
      WHERE a.asset_type='segment' GROUP BY a.id ORDER BY a.area,a.name`);
    return rows;
  }
  async getCableNamePattern() {
    const { rows } = await this.db.query(
      "SELECT value FROM app_settings WHERE key='cable_name_pattern'"
    );
    return {
      pattern: String(rows[0]?.value ?? "^AT-[A-Z]{3}-[A-Z]{3}-FO-[0-9]{3}$"),
    };
  }
  async setCableNamePattern(pattern: string, userId: string) {
    if (!pattern || pattern.length > 200) {
      throw new BadRequestException({
        message: "Pola nama kabel wajib diisi (maksimal 200 karakter).",
      });
    }
    try {
      // biome-ignore lint/correctness/noUnusedInstantiation: the constructor throws on invalid syntax, which is the check
      new RegExp(pattern);
    } catch {
      throw new BadRequestException({
        message: "Pola nama kabel bukan regular expression yang valid.",
      });
    }
    await this.db.query(
      "INSERT INTO app_settings(key,value) VALUES('cable_name_pattern',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [JSON.stringify(pattern)]
    );
    await this.db.query(
      "INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,'CABLE_NAME_PATTERN_UPDATED','SETTING','cable_name_pattern',$2::jsonb)",
      [userId, JSON.stringify({ pattern })]
    );
    return { pattern };
  }
  async nearbyTerminations(
    longitude: number,
    latitude: number,
    allowExpand2km = false
  ) {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      type: string;
      attributes: Record<string, unknown>;
      longitude: number;
      latitude: number;
      distance: number;
    }>(
      `WITH points AS (
        SELECT a.id, a.name, a.geometry, a.attributes,
          CASE
            WHEN label ~ '(^|[^a-z0-9])olt([^a-z0-9]|$)' THEN 'OLT'
            WHEN label ~ '(^|[^a-z0-9])otb([^a-z0-9]|$)' THEN 'OTB'
            WHEN label ~ '(^|[^a-z0-9])odc([^a-z0-9]|$)' THEN 'ODC'
            WHEN label ~ '(^|[^a-z0-9])(odp|fat|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)' THEN 'ODP'
            WHEN label ~ '(^|[^a-z0-9])(closure|cs[-_ ]?[0-9]+c)([^a-z0-9]|$)' THEN 'Closure'
            WHEN label ~ '(^|[^a-z0-9])(slack|coil|slk[-_ ]?[0-9]+)([^a-z0-9]|$)' THEN 'Slack / Coil'
          END AS type
        FROM network_assets a
        CROSS JOIN LATERAL (SELECT lower(concat_ws(' ',a.name,a.attributes->>'folderPath',a.attributes->>'assetKind',a.attributes->>'Tipe Perangkat',a.attributes->>'tipe_perangkat')) AS label) labels
        WHERE a.asset_type='asset' AND GeometryType(a.geometry)='POINT'
          AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
      ), selected AS (
        SELECT *, ST_Distance(geometry::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS distance
        FROM points WHERE type IS NOT NULL
          AND ST_DWithin(geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3)
      )
      SELECT id,name,type,attributes,ST_X(geometry) AS longitude,ST_Y(geometry) AS latitude,distance
      FROM selected ORDER BY distance,id`,
      [longitude, latitude, allowExpand2km ? 2000 : 1000]
    );
    const radius =
      [500, 1000, ...(allowExpand2km ? [2000] : [])].find((r) =>
        rows.some((row) => row.distance <= r)
      ) ?? (allowExpand2km ? 2000 : 1000);
    const points = rows.filter((row) => row.distance <= radius);
    if (!points.length) {
      return { points: [], searchRadiusMeters: radius };
    }
    const { rows: cables } = await this.db.query(
      `SELECT p.id AS "pointId", c.id,c.name,c.total_cores AS "totalCores",
        (EXISTS(SELECT 1 FROM network_asset_relations r WHERE r.asset_id=p.id AND r.segment_id=c.id) OR EXISTS(SELECT 1 FROM network_core_mappings m JOIN network_cores mc ON mc.id IN (m.core_a_id,m.core_b_id) WHERE m.node_asset_id=p.id AND mc.asset_id=c.id)) AS recorded,
        ST_Distance(p.geometry::geography,c.geometry::geography) AS "distanceMeters",
        COALESCE((c.source='managed' OR c.attributes->'__coreUsageVerification'->>'verified'='true' OR c.attributes->>'__coreUsageVerified'='true'), false) AS verified,
        (SELECT count(*)::int FROM network_cores x WHERE x.asset_id=c.id AND x.status='Used') AS used,
        (SELECT count(*)::int FROM network_cores x WHERE x.asset_id=c.id AND x.status='Booked') AS booked,
        (SELECT COALESCE(array_agg(x.core_number ORDER BY x.core_number),ARRAY[]::integer[]) FROM network_cores x WHERE x.asset_id=c.id AND x.status='Used') AS "usedNumbers",
        (SELECT COALESCE(array_agg(x.core_number ORDER BY x.core_number),ARRAY[]::integer[]) FROM network_cores x WHERE x.asset_id=c.id AND x.status='Booked') AS "bookedNumbers",
        (SELECT COALESCE(array_agg(x.core_number ORDER BY x.core_number),ARRAY[]::integer[]) FROM network_cores x WHERE x.asset_id=c.id AND x.status='Available') AS available,
        ST_AsGeoJSON(c.geometry)::json AS geometry
      FROM network_assets p JOIN network_assets c ON c.asset_type='segment'
        AND GeometryType(c.geometry) IN ('LINESTRING','MULTILINESTRING')
        AND (ST_DWithin(p.geometry::geography,c.geometry::geography,20) OR EXISTS(SELECT 1 FROM network_asset_relations r WHERE r.asset_id=p.id AND r.segment_id=c.id) OR EXISTS(SELECT 1 FROM network_core_mappings m JOIN network_cores mc ON mc.id IN (m.core_a_id,m.core_b_id) WHERE m.node_asset_id=p.id AND mc.asset_id=c.id))
      WHERE p.id=ANY($1::text[]) ORDER BY p.id,recorded DESC,"distanceMeters",c.id`,
      [points.map((point) => point.id)]
    );
    const { rows: related } = await this.db.query(
      `SELECT DISTINCT origin.asset_id AS "pointId", other.asset_id AS id, a.name, other.kind, origin.segment_id AS "cableId"
       FROM network_asset_relations origin
       JOIN network_asset_relations other ON other.segment_id=origin.segment_id AND other.asset_id<>origin.asset_id
       JOIN network_assets a ON a.id=other.asset_id
       WHERE origin.asset_id=ANY($1::text[]) ORDER BY origin.asset_id,a.name,other.asset_id`,
      [points.map((point) => point.id)]
    );
    // Endpoint candidates must include terminations outside the search radius.
    const { rows: endpoints } = await this.db.query(
      `WITH points AS (
        SELECT a.id,a.name,a.geometry,lower(concat_ws(' ',a.name,a.attributes->>'folderPath',a.attributes->>'assetKind',a.attributes->>'Tipe Perangkat',a.attributes->>'tipe_perangkat')) AS label
        FROM network_assets a WHERE a.asset_type='asset' AND GeometryType(a.geometry)='POINT' AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
      ), ends AS (
        SELECT c.id, side, CASE WHEN side='start' THEN ST_StartPoint(CASE WHEN GeometryType(c.geometry)='LINESTRING' THEN c.geometry ELSE ST_GeometryN(c.geometry,1) END)
          ELSE ST_EndPoint(CASE WHEN GeometryType(c.geometry)='LINESTRING' THEN c.geometry ELSE ST_GeometryN(c.geometry,ST_NumGeometries(c.geometry)) END) END AS geom
        FROM network_assets c CROSS JOIN (VALUES ('start'),('end')) v(side) WHERE c.id=ANY($1::text[])
      )
      SELECT e.id,e.side,p.id AS "pointId",p.name,ST_Distance(e.geom::geography,p.geometry::geography) AS "distanceMeters"
      FROM ends e JOIN LATERAL (SELECT * FROM points p WHERE p.label ~ '(^|[^a-z0-9])(olt|otb|odc|odp|fat|closure|slack|coil|cs[-_ ]?[0-9]+c|slk[-_ ]?[0-9]+|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)' AND ST_DWithin(e.geom::geography,p.geometry::geography,20) ORDER BY ST_Distance(e.geom::geography,p.geometry::geography),p.id LIMIT 1) p ON true`,
      [[...new Set(cables.map((cable) => cable.id))]]
    );
    return {
      points: points.map((point) => ({
        ...point,
        cables: cables
          .filter((cable) => cable.pointId === point.id)
          .map(({ geometry, pointId, ...cable }) => ({
            ...cable,
            available: cable.verified ? cable.available : null,
            end:
              endpoints.find(
                (end) => end.id === cable.id && end.side === "end"
              ) ?? null,
            start:
              endpoints.find(
                (end) => end.id === cable.id && end.side === "start"
              ) ?? null,
          })),
        relatedDevices: related
          .filter((device) => device.pointId === point.id)
          .map(({ pointId, ...device }) => device),
      })),
      searchRadiusMeters: radius,
    };
  }

  async terminationPatterns(longitude: number, latitude: number) {
    const { rows } = await this.db.query<{ type: string; sampleSize: number; medianMeters: number }>(
      `WITH location AS (SELECT ST_SetSRID(ST_MakePoint($1,$2),4326) AS geom),
       points AS (
         SELECT DISTINCT a.geometry,
           CASE
             WHEN label ~ '(^|[^a-z0-9])olt([^a-z0-9]|$)' THEN 'OLT'
             WHEN label ~ '(^|[^a-z0-9])otb([^a-z0-9]|$)' THEN 'OTB'
             WHEN label ~ '(^|[^a-z0-9])odc([^a-z0-9]|$)' THEN 'ODC'
             WHEN label ~ '(^|[^a-z0-9])(odp|fat|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)' THEN 'ODP'
             WHEN label ~ '(^|[^a-z0-9])(closure|cs[-_ ]?[0-9]+c)([^a-z0-9]|$)' THEN 'Closure'
             WHEN label ~ '(^|[^a-z0-9])(slack|coil|slk[-_ ]?[0-9]+)([^a-z0-9]|$)' THEN 'Slack / Coil'
           END AS type
         FROM network_assets a CROSS JOIN location l CROSS JOIN LATERAL
           (SELECT lower(concat_ws(' ',a.name,a.attributes->>'folderPath',a.attributes->>'assetKind',a.attributes->>'Tipe Perangkat',a.attributes->>'tipe_perangkat')) AS label) labels
         WHERE a.source='kml' AND a.asset_type='asset' AND GeometryType(a.geometry)='POINT'
           AND ST_DWithin(a.geometry::geography,l.geom::geography,2000)
       ), nearest AS (
         SELECT a.type, min(ST_Distance(a.geometry::geography,b.geometry::geography)) AS distance
         FROM points a JOIN points b ON a.type=b.type AND NOT ST_Equals(a.geometry,b.geometry)
           AND ST_DWithin(a.geometry::geography,b.geometry::geography,500)
           AND ST_Distance(a.geometry::geography,b.geometry::geography)>1
         WHERE a.type IS NOT NULL GROUP BY a.type,a.geometry
       )
       SELECT type,count(*)::int AS "sampleSize",percentile_cont(0.5) WITHIN GROUP (ORDER BY distance) AS "medianMeters"
       FROM nearest GROUP BY type`,
      [longitude, latitude]
    );
    return rows;
  }

  async terminationsAlongRoute(geometry: unknown) {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      type: string;
      longitude: number;
      latitude: number;
      distanceToRouteMeters: number;
      recordedCables: number;
    }>(
      `WITH route AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS geom), points AS (
        SELECT a.id,a.name,a.geometry,
          CASE
            WHEN label ~ '(^|[^a-z0-9])pop([^a-z0-9]|$)' THEN 'POP'
            WHEN label ~ '(^|[^a-z0-9])olt([^a-z0-9]|$)' THEN 'OLT'
            WHEN label ~ '(^|[^a-z0-9])otb([^a-z0-9]|$)' THEN 'OTB'
            WHEN label ~ '(^|[^a-z0-9])odc([^a-z0-9]|$)' THEN 'ODC'
            WHEN label ~ '(^|[^a-z0-9])(odp|fat|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)' THEN 'ODP'
            WHEN label ~ '(^|[^a-z0-9])(closure|cs[-_ ]?[0-9]+c)([^a-z0-9]|$)' THEN 'Closure'
            WHEN label ~ '(^|[^a-z0-9])(slack|coil|slk[-_ ]?[0-9]+)([^a-z0-9]|$)' THEN 'Slack / Coil'
          END AS type
        FROM network_assets a CROSS JOIN LATERAL
          (SELECT lower(concat_ws(' ',a.name,a.attributes->>'folderPath',a.attributes->>'assetKind',a.attributes->>'Tipe Perangkat',a.attributes->>'tipe_perangkat')) AS label) labels
        WHERE a.asset_type='asset' AND GeometryType(a.geometry)='POINT' AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
      )
      SELECT p.id,p.name,p.type,ST_X(p.geometry) AS longitude,ST_Y(p.geometry) AS latitude,
        ST_Distance(p.geometry::geography,r.geom::geography) AS "distanceToRouteMeters",
        (SELECT count(*)::int FROM (
          SELECT rel.segment_id FROM network_asset_relations rel WHERE rel.asset_id=p.id
          UNION SELECT mc.asset_id FROM network_core_mappings m JOIN network_cores mc ON mc.id IN (m.core_a_id,m.core_b_id) WHERE m.node_asset_id=p.id
        ) linked) AS "recordedCables"
      FROM points p CROSS JOIN route r
      WHERE p.type IS NOT NULL AND ST_DWithin(p.geometry::geography,r.geom::geography,20)
      ORDER BY ST_LineLocatePoint(r.geom,p.geometry),p.id LIMIT 100`,
      [JSON.stringify(geometry)]
    );
    return rows;
  }

  async cableEndsAlongRoute(geometry: unknown) {
    const { rows } = await this.db.query<{
      cableId: string;
      cableName: string;
      longitude: number;
      latitude: number;
      distanceMeters: number;
    }>(
      `WITH route AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1),4326) AS geom),
      ends AS (
        SELECT a.id,a.name,ST_StartPoint(part.geom) AS point
        FROM network_assets a CROSS JOIN route r CROSS JOIN LATERAL ST_Dump(ST_CollectionExtract(a.geometry,2)) part
        WHERE a.asset_type='segment' AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
          AND ST_DWithin(a.geometry::geography,r.geom::geography,10)
        UNION ALL
        SELECT a.id,a.name,ST_EndPoint(part.geom) AS point
        FROM network_assets a CROSS JOIN route r CROSS JOIN LATERAL ST_Dump(ST_CollectionExtract(a.geometry,2)) part
        WHERE a.asset_type='segment' AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
          AND ST_DWithin(a.geometry::geography,r.geom::geography,10)
      )
      SELECT e.id AS "cableId",e.name AS "cableName",
        ST_X(e.point) AS longitude,ST_Y(e.point) AS latitude,
        ST_Distance(e.point::geography,r.geom::geography) AS "distanceMeters"
      FROM ends e CROSS JOIN route r
      WHERE e.point IS NOT NULL AND ST_DWithin(e.point::geography,r.geom::geography,10)
        AND NOT ST_DWithin(e.point::geography,ST_StartPoint(r.geom)::geography,20)
        AND NOT ST_DWithin(e.point::geography,ST_EndPoint(r.geom)::geography,20)
      ORDER BY ST_LineLocatePoint(r.geom,e.point),e.id LIMIT 100`,
      [JSON.stringify(geometry)]
    );
    return rows;
  }

  async nearestNetwork(
    longitude: number,
    latitude: number,
    allowExpand2km = false
  ) {
    for (const radius of allowExpand2km ? [500, 1000, 2000] : [500, 1000]) {
      const { rows } = await this.db.query<{
        id: string;
        name: string;
        area: string;
        cableType: string;
        assetType: string;
        totalCores: number;
        attributes: Record<string, unknown>;
        source: string;
        nearestPoint: {
          coordinates: [number, number];
        };
        straightDistanceMeters: number;
        searchRadiusMeters: number;
        geometry: unknown;
      }>(
        `SELECT a.id,a.name,a.area,a.cable_type AS "cableType",a.asset_type AS "assetType",a.total_cores AS "totalCores",a.attributes,a.source,
        ST_AsGeoJSON(a.geometry)::json AS geometry,
        ST_AsGeoJSON(ST_ClosestPoint(a.geometry,ST_SetSRID(ST_MakePoint($1,$2),4326)))::json AS "nearestPoint",
        ST_Distance(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS "straightDistanceMeters",
        $3::int AS "searchRadiusMeters"
        FROM network_assets a
        WHERE a.asset_type='asset' AND GeometryType(a.geometry)='POINT'
          AND lower(concat_ws(' ',a.name,a.attributes->>'folderPath',a.attributes->>'assetKind',a.attributes->>'Tipe Perangkat',a.attributes->>'tipe_perangkat')) ~ '(^|[^a-z0-9])(olt|otb|odc|odp|fat|closure|slack|coil|cs[-_ ]?[0-9]+c|slk[-_ ]?[0-9]+|spl[-_ ]?1[:_-][0-9]+)([^a-z0-9]|$)'
          AND COALESCE(a.attributes->>'source','') <> 'ftth-design'
          AND ST_DWithin(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3)
        ORDER BY         ST_Distance(a.geometry::geography,ST_SetSRID(ST_MakePoint($1,$2),4326)::geography),a.id LIMIT 1`,
        [longitude, latitude, radius]
      );
      if (rows[0]) {
        const asset = rows[0];
        const { rows: counts } = await this.db.query(
          `SELECT count(*) FILTER(WHERE status='Used')::int AS used,count(*) FILTER(WHERE status='Booked')::int AS booked,count(*) FILTER(WHERE status='Available')::int AS available FROM network_cores WHERE asset_id=$1`,
          [asset.id]
        );
        const { rows: connectedCables } = await this.db.query(
          `SELECT a.id,a.name,a.total_cores AS "totalCores",
            COALESCE((a.source='managed' OR a.attributes->'__coreUsageVerification'->>'verified'='true' OR a.attributes->>'__coreUsageVerified'='true'), false) AS verified,
            count(c.id) FILTER (WHERE c.status='Used')::int AS used,
            count(c.id) FILTER (WHERE c.status='Booked')::int AS booked,
            count(c.id) FILTER (WHERE c.status='Available')::int AS available,
            (SELECT count(DISTINCT mc.id)::int FROM network_core_mappings m JOIN network_cores mc ON mc.id IN (m.core_a_id,m.core_b_id) WHERE m.node_asset_id=$1 AND mc.asset_id=a.id) AS "mappedCores"
           FROM network_assets a LEFT JOIN network_cores c ON c.asset_id=a.id
           WHERE a.asset_type='segment' AND (EXISTS (SELECT 1 FROM network_asset_relations r WHERE r.asset_id=$1 AND r.segment_id=a.id)
             OR EXISTS (SELECT 1 FROM network_core_mappings m JOIN network_cores mc ON mc.id IN (m.core_a_id,m.core_b_id) WHERE m.node_asset_id=$1 AND mc.asset_id=a.id))
           GROUP BY a.id ORDER BY a.name`,
          [asset.id]
        );
        const attributes = asset.attributes ?? {};
        const deviceType =
          Object.entries(attributes).find(([key]) =>
            /^(tipe[ _]?perangkat|assetKind)$/iu.test(key)
          )?.[1] ?? (asset.assetType === "segment" ? "Kabel" : "Aset jaringan");
        const capacityFields = Object.entries(attributes)
          .filter(
            ([key]) =>
              !key.startsWith("__") &&
              /core|port|splitter|spesifikasi|kapasitas/iu.test(key)
          )
          .map(([label, value]) => ({ label, value }));
        const verification =
          attributes.__coreUsageVerification &&
          typeof attributes.__coreUsageVerification === "object"
            ? (attributes.__coreUsageVerification as Record<string, unknown>)
            : null;
        const verified =
          asset.source === "managed" ||
          verification?.verified === true ||
          attributes.__coreUsageVerified === true;
        const full =
          asset.assetType === "segment" &&
          asset.totalCores > 0 &&
          (counts[0]?.used ?? 0) + (counts[0]?.booked ?? 0) >= asset.totalCores;
        const chamber = /handhole|manhole|^(HH|MH)$/iu.test(String(deviceType));
        const recommendation = full
          ? "CORE_FULL"
          : chamber && !connectedCables.length
            ? "NO_CABLE_RELATION"
            : asset.assetType === "segment" &&
                verified &&
                asset.totalCores > 0 &&
                counts[0]?.available > 0
              ? "CAPACITY_AVAILABLE"
              : "SURVEY_REQUIRED";
        const recommendationReason = full
          ? "Core tercatat penuh. Titik ini tidak direkomendasikan untuk sambungan baru."
          : chamber && !connectedCables.length
            ? "Aset akses kabel belum memiliki relasi kabel. Titik sambung perlu diperiksa."
            : recommendation === "CAPACITY_AVAILABLE"
              ? "Core tersedia tercatat dan diprioritaskan di antara kandidat dalam radius pencarian. Kelayakan fisik tetap perlu diperiksa."
              : "Kapasitas atau pemakaian belum terverifikasi. Jalur kabel merupakan estimasi untuk survei.";
        return {
          ...asset,
          capacity: {
            availableCores: counts[0]?.available ?? 0,
            bookedCores: counts[0]?.booked ?? 0,
            connectedCables: connectedCables.map((cable) => ({
              ...cable,
              used: cable.verified ? cable.used : null,
              booked: cable.verified ? cable.booked : null,
              available: cable.verified ? cable.available : null,
            })),
            deviceType: String(deviceType),
            fields: capacityFields,
            recommendation,
            recommendationReason,
            totalCores:
              asset.assetType === "segment" && asset.totalCores > 0
                ? asset.totalCores
                : null,
            usageVerified:
              asset.source === "managed" ||
              verification?.verified === true ||
              attributes.__coreUsageVerified === true,
            usedCores: counts[0]?.used ?? 0,
            verification:
              verification?.verified === true
                ? {
                    note: verification.note,
                    source: verification.source,
                    verifiedAt: verification.verifiedAt,
                  }
                : null,
          },
        };
      }
    }
    return null;
  }
  async notifications(userId: string) {
    const { rows } = await this.db.query(
      'SELECT id,title,message,booking_id AS "bookingId",read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
      [userId]
    );
    return rows;
  }
  async markNotificationRead(id: string, userId: string) {
    await this.db.transaction(async (client) => {
      const { rowCount } = await client.query(
        "UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2",
        [id, userId]
      );
      if (!rowCount) {
        throw new NotFoundException({ message: "Notifikasi tidak ditemukan." });
      }
      await audit(client, userId, "NOTIFICATION_READ", "NOTIFICATION", id, {
        read: true,
      });
    });
    return { id, read: true };
  }
}
