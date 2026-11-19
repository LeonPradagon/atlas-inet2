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
