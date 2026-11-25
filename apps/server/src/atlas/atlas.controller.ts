import { ApiUnauthorizedResponse, ApiForbiddenResponse } from "@nestjs/swagger";
import type { IncomingMessage } from "node:http";
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
} from "@nestjs/swagger";
import { AuthService } from "../auth/auth.service";
import {
  GeocodingService,
  type PhotonSearchOptions,
} from "../geospatial/geocoding.service";
import { RoutingService } from "../geospatial/routing.service";
import { NetworkImportService } from "../network/network-import.service";
import { AtlasService } from "./atlas.service";
import { BulkAnalysisService } from "./bulk-analysis.service";
import { analyzeCoordinates } from "./address-analysis";
import type { CoreRequirement } from "./termination-plan";
import {
  ConnectionService,
  validateConnectionInput,
} from "./connection.service";
import {
  AnalyzeAddressDto,
  AssetImportDto,
  PointAssetDto,
  FtthDesignDto,
  UpdateAssetDto,
  CoreMappingDto,
  VerifyCoresDto,
  SaveRelationsDto,
  SetCoreStatusDto,
  CableNamePatternDto,
  AnalyzeConnectionDto,
  ExpandBulkRowDto,
  CreateSurveyDto,
  UpdateSurveyDto,
  RoutePreviewDto,
} from "./api.dto";

function queryValues(query: Record<string, unknown>, key: string) {
  const value = query[key];
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => (typeof item === "string" ? [item] : []))
    .map((item) => item.trim())
    .filter(Boolean);
}

function importFilter(importId?: string, importIds?: string) {
  const ids = (importIds ?? importId)?.split(",");
  if (
    ids &&
    (ids.length > 50 ||
      ids.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
            id
          )
      ))
  ) {
    throw new BadRequestException({ message: "ID paket impor tidak valid." });
  }
  return ids?.join(",");
}

function photonSearchOptions(
  query: Record<string, unknown>
): PhotonSearchOptions {
  const first = (key: string) => queryValues(query, key)[0];
  const number = (key: string, min: number, max: number) => {
    const value = first(key);
    if (value === undefined) {
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      throw new BadRequestException({
        message: `Parameter ${key} tidak valid.`,
      });
    }
    return parsed;
  };
  const latitude = number("lat", -90, 90);
  const longitude = number("lon", -180, 180);
  if ((latitude === undefined) !== (longitude === undefined)) {
    throw new BadRequestException({
      message: "Parameter lat dan lon harus dikirim bersama.",
    });
  }
  const lang = first("lang") ?? "id";
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(lang)) {
    throw new BadRequestException({ message: "Parameter lang tidak valid." });
  }
  const layers = queryValues(query, "layer").flatMap((value) =>
    value
      .split(",")
      .map((layer) => layer.trim())
      .filter(Boolean)
  );
  const supportedLayers = new Set([
    "house",
    "street",
    "locality",
    "district",
    "city",
    "county",
    "state",
    "country",
    "other",
  ]);
  if (layers.some((layer) => !supportedLayers.has(layer))) {
    throw new BadRequestException({ message: "Layer Photon tidak dikenal." });
  }
  const categories = (key: string) => {
    const values = queryValues(query, key);
    if (
      values.length > 10 ||
      values.some(
        (value) =>
          value.length > 100 ||
          value
            .split(",")
            .some((category) => !/^[\w-]+(?:\.[\w-]+){1,3}$/u.test(category))
      )
    ) {
      throw new BadRequestException({ message: `Filter ${key} tidak valid.` });
    }
    return values;
  };
  const osmTags = queryValues(query, "osm_tag");
  if (
    osmTags.length > 10 ||
    osmTags.some(
      (value) =>
        value.length > 100 ||
        !/^(?:!?[\w.-]+(?::!?[\w.-]+)?|:!?[\w.-]+)$/u.test(value)
    )
  ) {
    throw new BadRequestException({ message: "Filter osm_tag tidak valid." });
  }
  const bboxValues = first("bbox")?.split(",").map(Number);
  let bbox: PhotonSearchOptions["bbox"];
  if (bboxValues) {
    if (
      bboxValues.length !== 4 ||
      bboxValues.some((value) => !Number.isFinite(value)) ||
      bboxValues[0] < -180 ||
      bboxValues[2] > 180 ||
      bboxValues[1] < -90 ||
      bboxValues[3] > 90 ||
      bboxValues[0] >= bboxValues[2] ||
      bboxValues[1] >= bboxValues[3]
    ) {
      throw new BadRequestException({ message: "Parameter bbox tidak valid." });
    }
    bbox = bboxValues as [number, number, number, number];
  }
  const dedupeText = first("dedupe");
  if (
    dedupeText !== undefined &&
    !["0", "1", "true", "false"].includes(dedupeText.toLowerCase())
  ) {
    throw new BadRequestException({ message: "Parameter dedupe tidak valid." });
  }
  return {
    bbox,
    dedupe:
      dedupeText === undefined
        ? undefined
        : ["1", "true"].includes(dedupeText.toLowerCase()),
    exclude: categories("exclude"),
    include: categories("include"),
    lang,
    latitude,
    layers,
    limit: number("limit", 1, 5),
    locationBiasScale: number("location_bias_scale", 0, 1),
    longitude,
    osmTags,
    zoom: number("zoom", 0, 22),
  };
}

@Controller()
export class AtlasController {
  constructor(
    @Inject(AtlasService) private readonly atlas: AtlasService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NetworkImportService)
    private readonly imports: NetworkImportService,
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(GeocodingService) private readonly geocoding: GeocodingService,
    @Inject(BulkAnalysisService) private readonly bulk: BulkAnalysisService,
    @Inject(ConnectionService) private readonly connection?: ConnectionService
  ) {}

  @Get("dashboard")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "company", type: String, required: false })
  @ApiQuery({ name: "page", type: String, required: false })
  @ApiQuery({ name: "pageSize", type: String, required: false })
  async dashboard(
    @Req() req: IncomingMessage,
    @Query("company") company?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    await this.auth.requireUser(req);
    return this.atlas.dashboard(company, Number(page), Number(pageSize));
  }

  @Get("audit-trails")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiQuery({ name: "search", type: String, required: false })
  @ApiQuery({ name: "limit", type: String, required: false })
  @ApiQuery({ name: "kind", type: String, required: false })
  async auditTrails(
    @Req() req: IncomingMessage,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("kind") kind?: string
  ) {
    await this.auth.requireAdmin(req);
    return this.atlas.listAuditTrails(search ?? "", Number(limit) || 100, kind);
  }

  @Get("reports/network-usage")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async networkUsageReport(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.atlas.networkUsageReport();
  }

  @Get("assets")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "search", type: String, required: false })
  @ApiQuery({ name: "id", type: String, required: false })
  async assets(@Req() req: IncomingMessage, @Query("search") search?: string, @Query("id") id?: string) {
    await this.auth.requireUser(req);
    return this.atlas.listAssets(search ?? "", id);
  }

  @Get("assets/imports")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async assetImports(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.atlas.listAssetImports();
  }

  @Get("assets/catalog")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "search", type: String, required: false })
  @ApiQuery({ name: "page", type: String, required: false })
  @ApiQuery({ name: "pageSize", type: String, required: false })
  @ApiQuery({ name: "coreFilter", type: String, required: false })
  @ApiQuery({ name: "provinceCode", type: String, required: false })
  @ApiQuery({ name: "importId", type: String, required: false })
  @ApiQuery({ name: "importIds", type: String, required: false })
  @ApiQuery({ name: "assetType", type: String, required: false })
  @ApiQuery({ name: "cableFamily", type: String, required: false })
  @ApiQuery({ name: "cableStatus", type: String, required: false })
  @ApiQuery({ name: "networkKind", type: String, required: false })
  async assetCatalog(
    @Req() req: IncomingMessage,
    @Query("search") search?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("coreFilter") coreFilter = "all",
    @Query("provinceCode") provinceCode?: string,
    @Query("importId") importId?: string,
    @Query("importIds") importIds?: string,
    @Query("assetType") assetType = "all",
    @Query("cableFamily") cableFamily = "all",
    @Query("cableStatus") cableStatus = "all",
    @Query("networkKind") networkKind = "all"
  ) {
    await this.auth.requireUser(req);
    const parsedPage = page === undefined ? 1 : Number(page);
    const parsedPageSize = pageSize === undefined ? 50 : Number(pageSize);
    if (
      !Number.isInteger(parsedPage) ||
      parsedPage < 1 ||
      !Number.isInteger(parsedPageSize) ||
      parsedPageSize < 1 ||
      parsedPageSize > 100
    ) {
      throw new BadRequestException({
        message: "Parameter pagination aset tidak valid.",
      });
    }
    if (
      !["all", "segments", "points", "filled", "empty"].includes(coreFilter)
    ) {
      throw new BadRequestException({ message: "Filter core tidak valid." });
    }
    if (!["all", "cables", "network"].includes(assetType)) {
      throw new BadRequestException({
        message: "Filter jenis aset tidak valid.",
      });
    }
    if (
      !["all", "feeder", "backbone", "distribusi", "sub-distribusi"].includes(
        cableFamily
      )
    ) {
      throw new BadRequestException({
        message: "Filter jenis kabel tidak valid.",
      });
    }
    if (
      !["all", "verified", "unverified", "available", "unavailable"].includes(
        cableStatus
      )
    ) {
      throw new BadRequestException({
        message: "Filter status kabel tidak valid.",
      });
    }
    if (!["all", "odc", "odp", "closure", "tiang"].includes(networkKind)) {
      throw new BadRequestException({
        message: "Filter jenis aset jaringan tidak valid.",
      });
    }
    if (provinceCode !== undefined && !/^\d{2}$/u.test(provinceCode)) {
      throw new BadRequestException({ message: "Kode provinsi tidak valid." });
    }
    const packageFilter = importFilter(importId, importIds);
    return this.atlas.listAssetPage(
      search ?? "",
      parsedPage,
      parsedPageSize,
      coreFilter,
      provinceCode,
      packageFilter,
      assetType,
      cableFamily,
      cableStatus,
      networkKind
    );
  }

  @Get("assets/provinces")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async mapProvinces(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.atlas.listKmzProvinces();
  }

  @Get("assets/provinces/boundaries")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async mapProvinceBoundaries(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.atlas.listKmzProvinceBoundaries();
  }

  @Get("assets/kml-icons/:id")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async kmzIcon(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    if (!/^[a-f0-9]{64}$/u.test(id)) {
      throw new BadRequestException({ message: "ID ikon KMZ tidak valid." });
    }
    return this.atlas.getKmzIcon(id);
  }

  @Get("assets/bounds")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "provinceCode", type: String, required: false })
  @ApiQuery({ name: "importId", type: String, required: false })
  @ApiQuery({ name: "importIds", type: String, required: false })
  async mapBounds(
    @Req() req: IncomingMessage,
    @Query("provinceCode") provinceCode?: string,
    @Query("importId") importId?: string,
    @Query("importIds") importIds?: string
  ) {
    await this.auth.requireUser(req);
    if (provinceCode !== undefined && !/^\d{2}$/u.test(provinceCode)) {
      throw new BadRequestException({ message: "Kode provinsi tidak valid." });
    }
    return this.atlas.mapBounds(
      provinceCode,
      importFilter(importId, importIds)
    );
  }

  @Get("assets/map")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "bbox", type: String, required: true })
  @ApiQuery({ name: "zoom", type: String, required: false })
  @ApiQuery({ name: "provinceCode", type: String, required: false })
  @ApiQuery({ name: "importId", type: String, required: false })
  @ApiQuery({ name: "importIds", type: String, required: false })
  @ApiQuery({ name: "company", type: String, required: false })
  @ApiQuery({ name: "view", enum: ["geometry"], required: false })
  async mapAssets(
    @Req() req: IncomingMessage,
    @Query("bbox") bbox?: string,
    @Query("zoom") zoom?: string,
    @Query("provinceCode") provinceCode?: string,
    @Query("importId") importId?: string,
    @Query("importIds") importIds?: string,
    @Query("company") company?: string,
    @Query("view") view?: string
  ) {
    await this.auth.requireUser(req);
    const values = bbox?.split(",").map(Number) ?? [];
    if (
      values.length !== 4 ||
      values.some((value) => !Number.isFinite(value)) ||
      values[0] < -180 ||
      values[2] > 180 ||
      values[1] < -90 ||
      values[3] > 90 ||
      values[0] >= values[2] ||
      values[1] >= values[3]
    ) {
      throw new BadRequestException({ message: "Batas peta tidak valid." });
    }
    const level = zoom === undefined ? 16 : Number(zoom);
    if (!Number.isFinite(level) || level < 0 || level > 24) {
      throw new BadRequestException({ message: "Zoom peta tidak valid." });
    }
    if (provinceCode !== undefined && !/^\d{2}$/u.test(provinceCode)) {
      throw new BadRequestException({ message: "Kode provinsi tidak valid." });
    }
    return this.atlas.listMapAssets(
      values as [number, number, number, number],
      level,
      provinceCode,
      importFilter(importId, importIds),
      company?.trim() || undefined,
      view === "geometry"
    );
  }

  @Post("assets/point")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiBody({ type: PointAssetDto })
  async createPointAsset(
    @Req() req: IncomingMessage,
    @Body() body: PointAssetDto
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.atlas.createPointAsset(body, user.id);
  }

  @Post("assets/ftth-design")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiBody({ type: FtthDesignDto })
  async saveFtthDesign(
    @Req() req: IncomingMessage,
    @Body() body: FtthDesignDto
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.atlas.saveFtthDesign(body?.features, user.id, body?.area, {
      analysisId: body?.sourceAnalysisId,
      row: body?.sourceRow,
    });
  }

  @Get("assets/:id/geometry")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async assetGeometry(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.assetGeometry(id);
  }

  @Patch("assets/:id")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiBody({ type: UpdateAssetDto })
  async updateAsset(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>
  ) {
    const user = await this.auth.requireUser(req);
    return this.atlas.updateAsset(id, body, user.id, user.role !== "ADMIN");
  }

  @Get("assets/:id/cores")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async cores(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.listCores(id);
  }

  @Get("assets/:id/cores/destinations")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async coreDestinations(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.listCoreDestinations(id);
  }

  @Get("assets/:id/cores/endpoints")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async coreEndpoints(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.listCoreEndpoints(id);
  }

  @Get("assets/:id/cores/route-nodes")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async coreRouteNodes(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.listCoreRouteNodes(id);
  }

  @Get("assets/:id/cores/connection-peers")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiQuery({ name: "nodeAssetId", type: String, required: false })
  @ApiQuery({ name: "side", type: String, required: false })
  @ApiQuery({ name: "routeMeasureM", type: String, required: false })
  async coreConnectionPeers(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Query("nodeAssetId") nodeAssetId?: string,
    @Query("side") side?: string,
    @Query("routeMeasureM") routeMeasureM?: string
  ) {
    await this.auth.requireUser(req);
    return this.atlas.listCoreConnectionPeers(
      id,
      side ?? "",
      nodeAssetId ?? "",
      routeMeasureM === undefined ? undefined : Number(routeMeasureM)
    );
  }

  @Get("assets/:id/core-mappings")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async coreMappings(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.listCoreMappings(id);
  }

  @Post("assets/:id/core-mappings")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiParam({ name: "id", type: String })
  @ApiBody({ type: CoreMappingDto })
  async createCoreMapping(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.atlas.createCoreMapping(id, body, user.id);
  }

  @Delete("assets/:id/core-mappings/:mappingId")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiParam({ name: "id", type: String })
  @ApiParam({ name: "mappingId", type: String })
  async deleteCoreMapping(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Param("mappingId") mappingId: string
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.atlas.deleteCoreMapping(id, mappingId, user.id);
  }

  @Post("assets/:id/cores/verify")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiBody({ type: VerifyCoresDto })
  async verifyCoreUsage(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Body() body: {
      source?: string;
      note?: string;
      segmentEndpoints?: Partial<Record<"A" | "B", string | null>>;
      coreStatuses?: {
        coreNumber: number;
        status: string;
        midspanConnections?: {
          nodeAssetId: string;
          routeMeasureM: number;
          routePhysicalSide?: "toward_A" | "toward_B" | null;
          connection:
            | {
                connectionType: "splice";
                peerSegmentId: string;
                peerCoreNumber: number;
                peerSide: "A" | "B" | "R";
                peerRouteMeasureM?: number;
                peerRoutePhysicalSide?: "toward_A" | "toward_B" | null;
              }
            | { connectionType: "termination" }
            | { connectionType: "device_port"; portReference: string };
        }[];
        endConnections?: Partial<
          Record<
            "A" | "B",
            | {
                connectionType: "splice";
                peerSegmentId: string;
                peerCoreNumber: number;
                peerSide: "A" | "B" | "R";
                peerRouteMeasureM?: number;
                peerRoutePhysicalSide?: "toward_A" | "toward_B" | null;
              }
            | { connectionType: "termination" }
            | { connectionType: "device_port"; portReference: string }
            | null
          >
        >;
      }[];
    }
  ) {
    const user = await this.auth.requireUser(req);
    return this.atlas.verifyCoreUsage(
      id,
      body?.source,
      body?.note,
      user.id,
      body?.coreStatuses,
      body?.segmentEndpoints
    );
  }

  @Get("assets/:id/relations")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async relations(@Req() req: IncomingMessage, @Param("id") id: string) {
    await this.auth.requireUser(req);
    return this.atlas.listRelations(id);
  }

  @Put("assets/:id/relations")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiParam({ name: "id", type: String })
  @ApiBody({ type: SaveRelationsDto })
  async saveRelations(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Body() body: SaveRelationsDto
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.atlas.saveRelations(id, body?.relations, user.id);
  }

  @Patch("assets/:id/cores/:coreNumber")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiParam({ name: "coreNumber", type: String })
  @ApiBody({ type: SetCoreStatusDto })
  async setCoreStatus(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Param("coreNumber") coreNumber: string,
    @Body() body: SetCoreStatusDto
  ) {
    const user = await this.auth.requireUser(req);
    return this.atlas.setCoreStatus(
      id,
      Number(coreNumber),
      body.status,
      user.id
    );
  }

  @Post("assets/import")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiOperation({
    summary: "Impor aset dari KML atau KMZ (admin, maksimal 50 MB)",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: AssetImportDto })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024 } })
  )
  async importNetwork(
    @Req() req: IncomingMessage,
    @UploadedFile() file?: { originalname: string; buffer: Buffer }
  ) {
    const user = await this.auth.requireAdmin(req);
    if (!file) {
      throw new BadRequestException({ message: "Pilih file KML atau KMZ." });
    }
    return this.imports.importNetwork(file, false, user.id);
  }

  @Post("assets/import/xlsx")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiOperation({ summary: "Impor aset dari XLSX (admin, maksimal 10 MB)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: AssetImportDto })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } })
  )
  async importNetworkWorkbook(
    @Req() req: IncomingMessage,
    @UploadedFile() file?: { originalname: string; buffer: Buffer }
  ) {
    const user = await this.auth.requireAdmin(req);
    if (!file) {
      throw new BadRequestException({ message: "Pilih file Excel .xlsx." });
    }
    return this.imports.importNetworkWorkbook(
      file.buffer,
      user.id,
      file.originalname
    );
  }

  @Get("settings/cable-name-pattern")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async cableNamePattern(@Req() req: IncomingMessage) {
    await this.auth.requireUser(req);
    return this.atlas.getCableNamePattern();
  }

  @Patch("settings/cable-name-pattern")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Akses hanya untuk ADMIN." })
  @ApiBody({ type: CableNamePatternDto })
  async setCableNamePattern(
    @Req() req: IncomingMessage,
    @Body() body: CableNamePatternDto
  ) {
    const user = await this.auth.requireAdmin(req);
    return this.atlas.setCableNamePattern(String(body.pattern ?? ""), user.id);
  }

  @Get("notifications")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async notifications(@Req() req: IncomingMessage) {
    const user = await this.auth.requireUser(req);
    return this.atlas.notifications(user.id);
  }

  @Patch("notifications/:id/read")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async markRead(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireUser(req);
    return this.atlas.markNotificationRead(id, user.id);
  }

  @Post("analysis/connection")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiBody({ type: AnalyzeConnectionDto })
  async analyzeConnection(
    @Req() req: IncomingMessage,
    @Body() body: AnalyzeConnectionDto
  ) {
    const user = await this.auth.requireAnalysisUser(req);
    const input = validateConnectionInput(body);
    const result = await this.connection!.analyze(input);
    const historyId = await this.atlas.saveAnalysisHistory(
      user.id,
      "ADDRESS",
      result.address,
      { ...input, inputMode: "connection" },
      result
    );
    return { ...result, historyId };
  }

  @Post("analysis/address")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiBody({ type: AnalyzeAddressDto })
  async analyzeAddress(
    @Req() req: IncomingMessage,
    @Body() body: AnalyzeAddressDto
  ) {
    const user = await this.auth.requireAnalysisUser(req);
    const suppliedRequirement = body.coreRequirement;
    if (
      suppliedRequirement !== undefined &&
      (!suppliedRequirement ||
        !Number.isInteger(suppliedRequirement.services) ||
        suppliedRequirement.services < 1 ||
        !Number.isInteger(suppliedRequirement.reserve) ||
        suppliedRequirement.reserve < 0 ||
        suppliedRequirement.services + suppliedRequirement.reserve > 4096)
    ) {
      throw new BadRequestException({
        message:
          "Kebutuhan layanan, cadangan, atau kapasitas kabel tidak valid.",
      });
    }
    const requirement: CoreRequirement | undefined = suppliedRequirement
      ? {
          reserve: suppliedRequirement.reserve,
          services: suppliedRequirement.services,
        }
      : undefined;
    const address =
      body.address?.trim() ||
      (body.coordinates
        ? `${body.coordinates.latitude}, ${body.coordinates.longitude}`
        : "");
    if (!body.coordinates && !address) {
      throw new BadRequestException({
        message: "Alamat atau koordinat wajib diisi.",
      });
    }
    if (body.coordinates) {
      if (body.coordinateConfirmed !== true) {
        throw new BadRequestException({
          message: "Konfirmasi posisi titik pada peta sebelum analisis.",
        });
      }
      const { longitude, latitude, provider, matchQuality, matchedStreet } =
        body.coordinates;
      if (
        typeof longitude !== "number" ||
        typeof latitude !== "number" ||
        !Number.isFinite(longitude) ||
        !Number.isFinite(latitude) ||
        Math.abs(longitude) > 180 ||
        Math.abs(latitude) > 90
      ) {
        throw new BadRequestException({
          message: "Longitude dan latitude harus berupa koordinat yang valid.",
        });
      }
      const result = await this.analyzeCoordinates(
        longitude,
        latitude,
        address,
        provider,
        matchQuality,
        matchedStreet,
        body.allowExpand2km === true,
        requirement
      );
      const historyId = await this.atlas.saveAnalysisHistory(
        user.id,
        "ADDRESS",
        address,
        {
          address,
          coordinateConfirmed: true,
          coordinates: body.coordinates,
          coreRequirement: requirement,
          structured: body.structured,
        },
        result
      );
      return { ...result, historyId };
    }
    if (
      body.structured?.province?.trim() &&
      body.structured.city?.trim() &&
      body.structured.district?.trim() &&
      body.structured.subdistrict?.trim()
    ) {
      const result = await this.geocoding.geocodeStructured(body.structured);
      const [longitude, latitude] = result.coordinates;
      const analysis = await this.analyzeCoordinates(
        longitude,
        latitude,
        address,
        result.provider,
        result.matchQuality,
        result.matchedStreet,
        body.allowExpand2km === true,
        requirement
      );
      const historyId = await this.atlas.saveAnalysisHistory(
        user.id,
        "ADDRESS",
        address,
        {
          address,
          coreRequirement: requirement,
          structured: body.structured,
        },
        analysis
      );
      return { ...analysis, historyId };
    }
    const result = await this.analyzeLocation(address);
    const historyId = await this.atlas.saveAnalysisHistory(
      user.id,
      "ADDRESS",
      address,
      { address },
      result
    );
    return { ...result, historyId };
  }

  @Get("analysis/address/suggestions")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "q", type: String, required: false })
  @ApiQuery({ name: "city", type: String, required: false })
  @ApiQuery({ name: "district", type: String, required: false })
  @ApiQuery({ name: "subdistrict", type: String, required: false })
  @ApiQuery({ name: "postalCode", type: String, required: false })
  @ApiQuery({ name: "province", type: String, required: false })
  @ApiQuery({ name: "lat", type: String, required: false })
  @ApiQuery({ name: "lon", type: String, required: false })
  @ApiQuery({ name: "limit", type: String, required: false })
  @ApiQuery({ name: "zoom", type: String, required: false })
  @ApiQuery({ name: "location_bias_scale", type: String, required: false })
  @ApiQuery({ name: "bbox", type: String, required: false })
  @ApiQuery({ name: "dedupe", type: String, required: false })
  @ApiQuery({ name: "lang", type: String, required: false })
  @ApiQuery({ name: "layer", type: String, required: false })
  @ApiQuery({ name: "include", type: String, required: false })
  @ApiQuery({ name: "exclude", type: String, required: false })
  @ApiQuery({ name: "osm_tag", type: String, required: false })
  async addressSuggestions(
    @Req() req: IncomingMessage,
    @Query() query: Record<string, unknown>
  ) {
    await this.auth.requireAnalysisUser(req);
    const search = typeof query.q === "string" ? query.q.trim() : "";
    if (!search || search.length < 3) {
      return [];
    }
    const first = (key: string) => queryValues(query, key)[0];
    return this.geocoding.suggestAddress(
      search,
      {
        city: first("city"),
        district: first("district"),
        postalCode: first("postalCode"),
        province: first("province"),
        subdistrict: first("subdistrict"),
      },
      photonSearchOptions(query)
    );
  }

  @Get("analysis/terminations")
  @ApiSecurity("AnalysisApiKey")
  async nearbyAnalysisTerminations(
    @Req() req: IncomingMessage,
    @Query("longitude") longitude?: string,
    @Query("latitude") latitude?: string,
    @Query("expand") expand?: string
  ) {
    await this.auth.requireAnalysisUser(req);
    const lon = Number(longitude);
    const lat = Number(latitude);
    if (!longitude || !latitude || !Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new BadRequestException({ message: "Koordinat tidak valid." });
    }
    return this.atlas.nearbyTerminations(lon, lat, expand === "true");
  }

  @Get("analysis/address/reverse")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "longitude", type: String, required: true })
  @ApiQuery({ name: "latitude", type: String, required: true })
  async reverseAddress(
    @Req() req: IncomingMessage,
    @Query("longitude") longitude?: string,
    @Query("latitude") latitude?: string
  ) {
    await this.auth.requireAnalysisUser(req);
    const lon = Number(longitude),
      lat = Number(latitude);
    if (
      !(Number.isFinite(lon) && Number.isFinite(lat)) ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90
    ) {
      throw new BadRequestException({
        message: "Koordinat alamat tidak valid.",
      });
    }
    return this.geocoding.reverseAddress(lon, lat);
  }

  @Post("analysis/bulk")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiOperation({ summary: "Analisis file XLSX (maksimal 15 MB)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: AssetImportDto })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } })
  )
  async bulkAnalysis(
    @Req() req: IncomingMessage,
    @UploadedFile() file?: { originalname: string; buffer: Buffer }
  ) {
    const user = await this.auth.requireAnalysisUser(req);
    if (!(file && /\.xlsx$/iu.test(file.originalname))) {
      throw new BadRequestException({ message: "Pilih file Excel .xlsx." });
    }
    const source = await this.imports.analyzeWorkbook(file.buffer, {
      maxBytes: 15 * 1024 * 1024,
      maxRows: 500,
    });
    const rows: Record<string, unknown>[] = [];
    for (const item of source) {
      try {
        const result =
          item.latitude !== null && item.longitude !== null
            ? await this.analyzeCoordinates(item.longitude, item.latitude)
            : await this.analyzeLocation(item.address);
        rows.push({ ...item, ...result });
      } catch (error) {
        const payload =
          error && typeof error === "object" && "getResponse" in error
            ? (error as { getResponse(): unknown }).getResponse()
            : null;
        rows.push({
          ...item,
          message:
            payload && typeof payload === "object" && "message" in payload
              ? String((payload as { message: unknown }).message)
              : "Lokasi tidak dapat dianalisis.",
          status:
            payload && typeof payload === "object" && "code" in payload
              ? String((payload as { code: unknown }).code)
              : "ANALYSIS_FAILED",
        });
      }
    }
    const result = {
      providerAvailable: Boolean(process.env.GEOCODER_URL),
      rows,
    };
    const historyId = await this.atlas.saveAnalysisHistory(
      user.id,
      "BULK",
      file.originalname,
      { fileName: file.originalname, rowCount: rows.length },
      result
    );
    return { ...result, historyId };
  }

  @Post("analysis/bulk/jobs")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiOperation({ summary: "Analisis file XLSX (maksimal 15 MB)" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({ type: AssetImportDto })
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 15 * 1024 * 1024 } })
  )
  async createBulkJob(
    @Req() req: IncomingMessage,
    @UploadedFile() file?: { originalname: string; buffer: Buffer }
  ) {
    const user = await this.auth.requireAnalysisUser(req);
    if (!file) {
      throw new BadRequestException({ message: "Pilih file Excel .xlsx." });
    }
    return this.bulk.create(user.id, file.originalname, file.buffer);
  }

  @Get("analysis/bulk/jobs/:id")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async bulkJobProgress(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAnalysisUser(req);
    return this.bulk.progress(user.id, id, user.role === "ADMIN");
  }

  @Get("analysis/bulk/jobs/:id/rows")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiQuery({ name: "page", type: String, required: false })
  @ApiQuery({ name: "pageSize", type: String, required: false })
  @ApiQuery({ name: "search", type: String, required: false })
  @ApiQuery({ name: "status", type: String, required: false })
  async bulkJobRows(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("search") search?: string,
    @Query("status") status?: string
  ) {
    const user = await this.auth.requireAnalysisUser(req);
    return this.bulk.page(
      user.id,
      id,
      Number(page) || 1,
      Number(pageSize) || 50,
      search ?? "",
      status ?? "",
      user.role === "ADMIN"
    );
  }

  @Get("analysis/bulk/jobs/:id/map-points")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async bulkJobMapPoints(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAnalysisUser(req);
    return this.bulk.mapPoints(user.id, id, user.role === "ADMIN");
  }

  @Post("analysis/bulk/jobs/:id/rows/:row/expand")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiParam({ name: "row", type: String })
  @ApiBody({ type: ExpandBulkRowDto })
  async expandBulkRow(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Param("row") row: string,
    @Body() body: ExpandBulkRowDto
  ) {
    const user = await this.auth.requireAnalysisUser(req);
    if (body.confirmed !== true) {
      throw new BadRequestException({
        message: "Persetujuan diperlukan sebelum pencarian hingga 2 km.",
      });
    }
    if (!Number.isInteger(Number(row)) || Number(row) < 1) {
      throw new BadRequestException({ message: "Nomor baris tidak valid." });
    }
    return this.bulk.expand(user.id, id, Number(row));
  }

  @Post("analysis/bulk/jobs/:id/cancel")
  @ApiSecurity("AnalysisApiKey")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async cancelBulkJob(@Req() req: IncomingMessage, @Param("id") id: string) {
    const user = await this.auth.requireAnalysisUser(req);
    return this.bulk.cancel(user.id, id);
  }

  @Get("analysis/history")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiQuery({ name: "type", type: String, required: false })
  @ApiQuery({ name: "page", type: String, required: false })
  @ApiQuery({ name: "pageSize", type: String, required: false })
  async analysisHistory(
    @Req() req: IncomingMessage,
    @Query("type") type?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string
  ) {
    const user = await this.auth.requireUser(req);
    if (
      type &&
      type !== "ADDRESS" &&
      type !== "BULK" &&
      type !== "FTTH_DESIGN"
    ) {
      throw new BadRequestException({ message: "Jenis riwayat tidak valid." });
    }
    const parsedPage = page === undefined ? 1 : Number(page);
    const parsedPageSize = pageSize === undefined ? 25 : Number(pageSize);
    if (
      !Number.isInteger(parsedPage) ||
      parsedPage < 1 ||
      !Number.isInteger(parsedPageSize) ||
      parsedPageSize < 1 ||
      parsedPageSize > 100
    ) {
      throw new BadRequestException({
        message: "Parameter pagination riwayat tidak valid.",
      });
    }
    return this.atlas.listAnalysisHistory(
      user.id,
      type as "ADDRESS" | "BULK" | "FTTH_DESIGN" | undefined,
      parsedPage,
      parsedPageSize,
      user.role === "ADMIN"
    );
  }

  @Get("surveys/candidates")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async surveyCandidates(@Req() req: IncomingMessage) {
    const user = await this.auth.requireUser(req);
    return this.atlas.surveyCandidates(user.id);
  }

  @Get("surveys")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  async surveys(@Req() req: IncomingMessage) {
    const user = await this.auth.requireUser(req);
    return this.atlas.listSurveys(user.id, user.role === "ADMIN");
  }

  @Post("surveys")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiBody({ type: CreateSurveyDto })
  async createSurvey(
    @Req() req: IncomingMessage,
    @Body() body: CreateSurveyDto
  ) {
    const user = await this.auth.requireUser(req);
    return this.atlas.createSurvey(
      user.id,
      String(body.historyId ?? ""),
      Number(body.rowNumber ?? 0),
      body.proposal,
      body.plan,
      body.routeId
    );
  }

  @Patch("surveys/:id")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  @ApiBody({ type: UpdateSurveyDto })
  async updateSurvey(
    @Req() req: IncomingMessage,
    @Param("id") id: string,
    @Body() body: Record<string, unknown>
  ) {
    const user = await this.auth.requireUser(req);
    return this.atlas.updateSurvey(user.id, user.role === "ADMIN", id, body);
  }

  @Get("analysis/history/:id")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async analysisHistoryDetail(
    @Req() req: IncomingMessage,
    @Param("id") id: string
  ) {
    const user = await this.auth.requireUser(req);
    return this.atlas.getAnalysisHistory(user.id, id, user.role === "ADMIN");
  }

  @Delete("analysis/history/:id")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiParam({ name: "id", type: String })
  async deleteAnalysisHistory(
    @Req() req: IncomingMessage,
    @Param("id") id: string
  ) {
    const user = await this.auth.requireUser(req);
    await this.atlas.deleteAnalysisHistory(
      user.id,
      id,
      user.role === "ADMIN"
    );
    return { success: true };
  }

  private async analyzeLocation(address: string) {
    const [longitude, latitude] = await this.geocoding.geocode(address);
    return this.analyzeCoordinates(longitude, latitude, address);
  }

  private async analyzeCoordinates(
    ...args: Parameters<typeof analyzeCoordinates> extends [
      unknown,
      unknown,
      ...infer Rest,
    ]
      ? Rest
      : never
  ) {
    return analyzeCoordinates(this.atlas, this.routing, ...args);
  }

  @Post("routes/preview")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiBody({ type: RoutePreviewDto })
  async routePreview(
    @Req() req: IncomingMessage,
    @Body() body: RoutePreviewDto
  ) {
    const user = await this.auth.requireUser(req);
    const points = this.parseRouteCoordinates(body?.coordinates);
    const result = await this.routing.preview(points);
    await this.atlas.recordAudit(user.id, "ROUTE_PREVIEW_COMPLETED", {
      distanceMeters: result.distanceMeters,
      pointCount: points.length,
    });
    return result;
  }

  @Post("routes/preview-ftth")
  @ApiUnauthorizedResponse({ description: "Sesi login diperlukan." })
  @ApiForbiddenResponse({ description: "Peran akun tidak diizinkan." })
  @ApiBody({ type: RoutePreviewDto })
  async ftthRoutePreview(
    @Req() req: IncomingMessage,
    @Body() body: RoutePreviewDto
  ) {
    const user = await this.auth.requireUser(req);
    const points = this.parseRouteCoordinates(body?.coordinates);
    const result = await this.routing.previewFtth(points);
    await this.atlas.recordAudit(user.id, "FTTH_ROUTE_PREVIEW_COMPLETED", {
      distanceMeters: result.distanceMeters,
      pointCount: points.length,
    });
    return result;
  }

  private parseRouteCoordinates(coordinates: unknown) {
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      coordinates.length > 10
    ) {
      throw new BadRequestException({
        message: "Rute membutuhkan 2 sampai 10 titik.",
      });
    }
    const points = coordinates.map((point): [number, number] => {
      if (
        !Array.isArray(point) ||
        point.length < 2 ||
        typeof point[0] !== "number" ||
        typeof point[1] !== "number"
      ) {
        throw new BadRequestException({
          message: "Koordinat harus berupa pasangan longitude, latitude.",
        });
      }
      const [lon, lat] = point;
      if (
        !(Number.isFinite(lon) && Number.isFinite(lat)) ||
        Math.abs(lon) > 180 ||
        Math.abs(lat) > 90
      ) {
        throw new BadRequestException({
          message:
            "Koordinat harus berada dalam rentang longitude dan latitude yang valid.",
        });
      }
      return [lon, lat];
    });
    return points;
  }
}
