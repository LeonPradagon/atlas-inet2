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

@Module({ controllers: [HealthController, AtlasController, AuthController, RegionsController], providers: [Database, AtlasService, NetworkImportService, AuthService, RoutingService, GeocodingService] })
export class AppModule {}
