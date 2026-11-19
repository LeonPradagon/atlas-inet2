import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class StructuredAddressDto {
  @ApiPropertyOptional({ type: String }) street?: string;
  @ApiPropertyOptional({ type: String }) number?: string;
  @ApiPropertyOptional({ type: String }) subdistrict?: string;
  @ApiPropertyOptional({ type: [String] }) subdistrictCandidates?: string[];
  @ApiPropertyOptional({ type: String }) district?: string;
  @ApiPropertyOptional({ type: [String] }) districtCandidates?: string[];
  @ApiPropertyOptional({ type: String }) city?: string;
  @ApiPropertyOptional({ type: [String] }) cityCandidates?: string[];
  @ApiPropertyOptional({ type: String }) province?: string;
  @ApiPropertyOptional({ type: String }) postalCode?: string;
}

export class AddressCoordinatesDto {
  @ApiProperty({ type: Number, example: 106.8456 }) longitude?: number;
  @ApiProperty({ type: Number, example: -6.2088 }) latitude?: number;
  @ApiPropertyOptional({ enum: ["photon", "manual"] }) provider?:
    | "photon"
    | "manual";
  @ApiPropertyOptional({ enum: ["approximate"] }) matchQuality?: "approximate";
  @ApiPropertyOptional({ type: String }) matchedStreet?: string;
}

export class CoreRequirementDto {
  @ApiProperty({ type: "integer", minimum: 1 }) services!: number;
  @ApiProperty({ type: "integer", minimum: 0 }) reserve!: number;
}

export class AnalyzeAddressDto {
  @ApiProperty({ type: String, description: "Alamat yang akan dianalisis" })
  address?: string;
  @ApiPropertyOptional({
    type: StructuredAddressDto,
    description:
      "Wajib mengisi province, city, district, dan subdistrict jika coordinates tidak dikirim",
  })
  structured?: StructuredAddressDto;
  @ApiPropertyOptional({
    type: AddressCoordinatesDto,
    description: "Alternatif alamat terstruktur",
  })
  coordinates?: AddressCoordinatesDto;
  @ApiPropertyOptional({
    type: Boolean,
    description: "Harus true jika coordinates dikirim",
  })
  coordinateConfirmed?: boolean;
  @ApiPropertyOptional({ type: Boolean }) allowExpand2km?: boolean;
  @ApiPropertyOptional({
    type: CoreRequirementDto,
    description: "Jumlah services dan reserve maksimal 4096",
  })
  coreRequirement?: CoreRequirementDto;
}

export class AssetImportDto {
  @ApiProperty({
    type: "string",
    format: "binary",
    description: "File yang akan diimpor",
  })
  file!: unknown;
}

export class CreateUserDto {
  @ApiProperty({ type: String }) name?: string;
  @ApiProperty({ type: String, format: "email" }) email?: string;
  @ApiProperty({ type: String, format: "password", minLength: 12 })
  password?: string;
  @ApiPropertyOptional({ enum: ["ADMIN", "PRESALES"], default: "PRESALES" })
  role?: string;
}

export class PointAssetDto {
  @ApiProperty({ type: String, maxLength: 150 }) name?: unknown;
  @ApiProperty({
    enum: ["OLT", "JOINT_CLOSURE", "HANDHOLE", "ODC", "ODP", "POLE"],
  })
  kind?: unknown;
  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  longitude?: unknown;
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 }) latitude?: unknown;
  @ApiPropertyOptional({ type: String, maxLength: 300 }) area?: unknown;
  @ApiPropertyOptional({
    enum: ["7 m", "9 m"],
    description: "Wajib untuk POLE",
  })
  poleHeight?: unknown;
}

export class FtthFeatureDto {
  @ApiProperty({
    enum: ["OLT", "JOINT_CLOSURE", "HANDHOLE", "ODC", "ODP", "POLE", "ROUTE"],
  })
  kind?: unknown;
  @ApiProperty({ type: String, maxLength: 150 }) name?: unknown;
  @ApiProperty({
    type: "object",
    description: "Geometri GeoJSON Point atau LineString",
    example: { type: "Point", coordinates: [106.8456, -6.2088] },
    additionalProperties: true,
  })
  geometry?: unknown;
  @ApiPropertyOptional({ enum: ["7 m", "9 m"] }) poleHeight?: unknown;
  @ApiPropertyOptional({ type: String }) routeType?: unknown;
  @ApiPropertyOptional({ type: Boolean }) designAnchor?: unknown;
}
export class FtthDesignDto {
  @ApiProperty({ type: [FtthFeatureDto], minItems: 1, maxItems: 500 })
  features?: unknown;
  @ApiPropertyOptional({ type: String, maxLength: 300 }) area?: unknown;
  @ApiPropertyOptional({ type: String }) sourceAnalysisId?: unknown;
  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    description: "Hanya bersama sourceAnalysisId",
  })
  sourceRow?: unknown;
}
export class UpdateAssetDto {
  @ApiPropertyOptional({ type: String }) name?: string;
  @ApiPropertyOptional({ type: String }) area?: string;
  @ApiPropertyOptional({ type: String }) cableType?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 0, maximum: 4096 })
  totalCores?: number;
  @ApiPropertyOptional({ enum: ["Aerial", "Burial"] }) installation?: string;
  @ApiPropertyOptional({ enum: ["Kiri", "Kanan"] }) side?: string;
  @ApiPropertyOptional({ type: String }) pole?: string;
  @ApiPropertyOptional({ enum: ["7 m", "9 m"], nullable: true }) poleHeight?:
    | string
    | null;
  @ApiPropertyOptional({ type: String }) odc?: string;
  @ApiPropertyOptional({ type: String }) odp?: string;
}
export class CoreMappingDto {
  @ApiProperty({ type: String }) nodeAssetId?: string;
  @ApiProperty({ type: "integer", minimum: 1 }) coreNumber?: number;
  @ApiProperty({
    enum: ["Survei lapangan", "Data operasional", "Dokumen inventaris"],
  })
  source?: string;
  @ApiPropertyOptional({
    type: String,
    description: "Kabel pasangan untuk splice",
  })
  peerSegmentId?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 1 }) peerCoreNumber?: number;
  @ApiPropertyOptional({
    type: String,
    description: "Masukan splitter jika bukan splice",
  })
  splitterInput?: string;
  @ApiPropertyOptional({ type: String, maxLength: 500 }) note?: string;
}
export class CoreConnectionDto {
  @ApiProperty({ enum: ["splice", "termination", "device_port"] })
  connectionType?: string;
  @ApiPropertyOptional({ type: String }) peerSegmentId?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 1 }) peerCoreNumber?: number;
  @ApiPropertyOptional({ enum: ["A", "B", "R"] }) peerSide?: string;
  @ApiPropertyOptional({ type: Number }) peerRouteMeasureM?: number;
  @ApiPropertyOptional({ type: String }) portReference?: string;
}
export class CoreMidspanDto {
  @ApiProperty({ type: String }) nodeAssetId?: string;
  @ApiProperty({ type: Number }) routeMeasureM?: number;
  @ApiProperty({ type: CoreConnectionDto }) connection?: CoreConnectionDto;
}
export class CoreStatusDto {
  @ApiProperty({ type: "integer", minimum: 1 }) coreNumber?: number;
  @ApiProperty({ enum: ["Available", "Used"] }) status?: string;
  @ApiPropertyOptional({
    type: "object",
    description: "Sambungan ujung A/B; nilai dapat null",
    additionalProperties: {
      oneOf: [
        { $ref: "#/components/schemas/CoreConnectionDto" },
        { type: "object", nullable: true },
      ],
    },
  })
  endConnections?: unknown;
  @ApiPropertyOptional({ type: [CoreMidspanDto] })
  midspanConnections?: CoreMidspanDto[];
}
export class VerifyCoresDto {
  @ApiProperty({
    enum: ["Survei lapangan", "Data operasional", "Dokumen inventaris"],
  })
  source?: string;
  @ApiPropertyOptional({ type: String, maxLength: 500 }) note?: string;
  @ApiPropertyOptional({
    type: "object",
    description: "Pemetaan ujung A/B ke ID aset atau null",
    additionalProperties: { type: "string", nullable: true },
  })
  segmentEndpoints?: unknown;
  @ApiPropertyOptional({ type: [CoreStatusDto] })
  coreStatuses?: CoreStatusDto[];
}
export class AssetRelationDto {
  @ApiProperty({ type: String }) assetId?: string;
  @ApiProperty({ enum: ["POLE", "ODC", "ODP"] }) kind?: string;
}
export class SaveRelationsDto {
  @ApiProperty({ type: [AssetRelationDto], maxItems: 1000 })
  relations?: unknown;
}
export class SetCoreStatusDto {
  @ApiProperty({ enum: ["Available", "Used"] }) status?: string;
}
export class CableNamePatternDto {
  @ApiProperty({ type: String }) pattern?: string;
}
export class ConnectionPointDto {
  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  longitude!: number;
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 }) latitude!: number;
  @ApiPropertyOptional({ type: String, maxLength: 500 }) label?: string;
}
export class AnalyzeConnectionDto {
  @ApiProperty({ type: ConnectionPointDto }) start!: ConnectionPointDto;
  @ApiProperty({ type: ConnectionPointDto }) end!: ConnectionPointDto;
  @ApiPropertyOptional({ type: Boolean }) allowExpand2km?: boolean;
  @ApiPropertyOptional({ type: CoreRequirementDto })
  coreRequirement?: CoreRequirementDto;
}
export class ExpandBulkRowDto {
  @ApiProperty({
    type: Boolean,
    description: "Harus true untuk menyetujui pencarian hingga 2 km",
  })
  confirmed?: boolean;
}
export class CreateSurveyDto {
  @ApiProperty({ type: String }) historyId?: string;
  @ApiPropertyOptional({ type: "integer", minimum: 0 }) rowNumber?: number;
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "Proposal analisis; tidak dikirim untuk analisis sambungan",
  })
  proposal?: unknown;
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    description: "Rencana analisis; tidak dikirim untuk analisis sambungan",
  })
  plan?: unknown;
  @ApiPropertyOptional({
    type: String,
    description: "ID rute hasil analisis, misalnya A atau B",
  })
  routeId?: unknown;
}
export class UpdateSurveyDto {
  @ApiProperty({ enum: ["IN_PROGRESS", "REVIEW", "VERIFIED", "REVISION"] })
  status?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) connection?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) route?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) length?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) capacity?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) evidence?: string;
  @ApiPropertyOptional({ type: String, maxLength: 2000 }) notes?: string;
  @ApiPropertyOptional({
    type: String,
    description:
      "Data URL gambar JPEG/PNG/WebP maksimal 2 MB; gambar baru harus memuat GPS",
  })
  image?: string;
}
export class RoutePreviewDto {
  @ApiProperty({
    type: "array",
    minItems: 2,
    maxItems: 10,
    items: { type: "array", items: { type: "number" }, minItems: 2 },
    example: [
      [106.8456, -6.2088],
      [106.85, -6.21],
    ],
    description: "Daftar pasangan [longitude, latitude]",
  })
  coordinates?: unknown;
}
