import { Module } from "@nestjs/common";
import { AtlasController } from "./atlas/atlas.controller";
import { AtlasService } from "./atlas/atlas.service";
import { BulkAnalysisService } from "./atlas/bulk-analysis.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { BookingController } from "./booking/booking.controller";
import { BookingService } from "./booking/booking.service";
import { Database } from "./database/database";
import { RegionsController } from "./database/regions.controller";
import { GeocodingService } from "./geospatial/geocoding.service";
import { RoutingService } from "./geospatial/routing.service";
import { HealthController } from "./health/health.controller";
import { NetworkImportService } from "./network/network-import.service";

@Module({
  controllers: [
    HealthController,
    BookingController,
    AtlasController,
    AuthController,
    RegionsController,
  ],
  providers: [
    Database,
    BookingService,
    AtlasService,
    BulkAnalysisService,
    NetworkImportService,
    AuthService,
    RoutingService,
    GeocodingService,
  ],
})
export class AppModule {}
