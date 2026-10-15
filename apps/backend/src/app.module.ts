import { Module } from '@nestjs/common'
import { HealthController } from './health/health.controller'
import { RoutingService } from './geospatial/routing.service'
import { Database } from './database/database'
import { AtlasController } from './atlas/atlas.controller'
import { AtlasService } from './atlas/atlas.service'
import { NetworkImportService } from './network/network-import.service'
import { AuthService } from './auth/auth.service'
import { AuthController } from './auth/auth.controller'
import { GeocodingService } from './geospatial/geocoding.service'
import { RegionsController } from './database/regions.controller'
import { BulkAnalysisService } from './atlas/bulk-analysis.service'

@Module({ controllers: [HealthController, AtlasController, AuthController, RegionsController], providers: [Database, AtlasService, BulkAnalysisService, NetworkImportService, AuthService, RoutingService, GeocodingService] })
export class AppModule {}
