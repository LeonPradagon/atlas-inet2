import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class BookingSegmentDto {
  @ApiProperty({ type: String, description: "ID segmen jaringan" })
  segmentId!: string;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    description: "Jumlah core yang dipesan",
  })
  cores!: number;

  @ApiPropertyOptional({
    type: String,
    description: "Nama titik awal; isi bersama segmentTo",
  })
  segmentFrom?: string;

  @ApiPropertyOptional({
    type: String,
    description: "Nama titik akhir; isi bersama segmentFrom",
  })
  segmentTo?: string;
}

export class CreateBookingDto {
  @ApiProperty({ type: String, description: "Nama pelanggan" })
  customer?: string;

  @ApiProperty({ type: String, description: "Nama PIC pelanggan" })
  picCustomer?: string;

  @ApiPropertyOptional({ type: String, format: "email" })
  picCustomerEmail?: string;

  @ApiPropertyOptional({ type: String })
  picCustomerPhone?: string;

  @ApiPropertyOptional({ type: String, description: "PIC presales yang menangani permintaan" })
  picPresales?: string;

  @ApiPropertyOptional({
    type: String,
    description:
      "ID segmen untuk pemesanan satu segmen; gunakan bersama cores jika segments tidak diisi",
  })
  segmentId?: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    description: "Jumlah core untuk pemesanan satu segmen",
  })
  cores?: number;

  @ApiPropertyOptional({
    type: [BookingSegmentDto],
    description: "Daftar segmen unik; alternatif segmentId dan cores",
  })
  segments?: BookingSegmentDto[];
}

export class BookingDurationDto {
  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: 365,
    description: "Durasi booking dalam hari",
  })
  days?: number;
}

export class BookingPricesDto {
  @ApiProperty({ type: "array", items: { type: "object" } })
  items!: { name: string; unit: string; price: number }[];
}
