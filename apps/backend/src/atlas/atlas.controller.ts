import { BadRequestException, Controller, Get, Inject, Param, Patch, Post, Query, Req, UploadedFile, UseInterceptors, Body } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { IncomingMessage } from 'node:http'
import { AuthService } from '../auth/auth.service'
import { AtlasService } from './atlas.service'
import { NetworkImportService } from '../network/network-import.service'
import { RoutingService } from '../geospatial/routing.service'
import { GeocodingService } from '../geospatial/geocoding.service'

@Controller()
export class AtlasController {
  constructor(
    @Inject(AtlasService) private readonly atlas: AtlasService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NetworkImportService) private readonly imports: NetworkImportService,
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(GeocodingService) private readonly geocoding: GeocodingService,
  ) {}

  @Get('dashboard')
  async dashboard(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.dashboard() }

  @Get('audit-trails')
  async auditTrails(@Req() req: IncomingMessage, @Query('search') search?: string, @Query('limit') limit?: string) {
    await this.auth.requireAdmin(req)
    return this.atlas.listAuditTrails(search ?? '', Number(limit) || 100)
  }

  @Get('reports/network-usage')
  async networkUsageReport(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.networkUsageReport() }

  @Get('assets')
  async assets(@Req() req: IncomingMessage, @Query('search') search?: string) { await this.auth.requireUser(req); return this.atlas.listAssets(search ?? '') }

  @Patch('assets/:id')
  async updateAsset(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.updateAsset(id, body, user.id)
  }

  @Get('assets/:id/cores')
  async cores(@Req() req: IncomingMessage, @Param('id') id: string) { await this.auth.requireUser(req); return this.atlas.listCores(id) }

  @Patch('assets/:id/cores/:coreNumber')
  async setCoreStatus(@Req() req: IncomingMessage, @Param('id') id: string, @Param('coreNumber') coreNumber: string, @Body() body: { status?: string }) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.setCoreStatus(id, Number(coreNumber), body.status, user.id)
  }

  @Post('assets/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  async importNetwork(@Req() req: IncomingMessage, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    const user = await this.auth.requireAdmin(req)
    if (!file) throw new BadRequestException({ message: 'Pilih file KML atau KMZ.' })
    return this.imports.importNetwork(file, false, user.id)
  }

  @Post('assets/import/xlsx')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importNetworkWorkbook(@Req() req: IncomingMessage, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    const user = await this.auth.requireAdmin(req)
    if (!file) throw new BadRequestException({ message: 'Pilih file Excel .xlsx.' })
    return this.imports.importNetworkWorkbook(file.buffer, user.id, file.originalname)
  }

  @Get('bookings')
  async bookings(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.listBookings() }

  @Post('bookings')
  async createBooking(@Req() req: IncomingMessage, @Body() body: { customer?: string; picCustomer?: string; picPresales?: string; segmentId?: string; cores?: number }) {
    const user = await this.auth.requireUser(req)
    return this.atlas.createBooking(body, user.id)
  }

  @Post('bookings/:id/release')
  async releaseBooking(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    return this.atlas.releaseBooking(id, user.id)
  }

  @Get('settings/booking-duration')
  async duration(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.getBookingDuration() }

  @Patch('settings/booking-duration')
  async setDuration(@Req() req: IncomingMessage, @Body() body: { days?: number }) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.setBookingDuration(Number(body.days), user.id)
  }

  @Get('settings/cable-name-pattern')
  async cableNamePattern(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.getCableNamePattern() }

  @Patch('settings/cable-name-pattern')
  async setCableNamePattern(@Req() req: IncomingMessage, @Body() body: { pattern?: string }) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.setCableNamePattern(String(body.pattern ?? ''), user.id)
  }

  @Get('notifications')
  async notifications(@Req() req: IncomingMessage) {
    const user = await this.auth.requireUser(req)
    return this.atlas.notifications(user.id)
  }

  @Patch('notifications/:id/read')
  async markRead(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    return this.atlas.markNotificationRead(id, user.id)
  }

  @Post('analysis/address')
  async analyzeAddress(@Req() req: IncomingMessage, @Body() body: { address?: string }) {
    await this.auth.requireUser(req)
    if (!body.address?.trim()) throw new BadRequestException({ message: 'Alamat wajib diisi.' })
    return this.analyzeLocation(body.address)
  }

  @Post('analysis/bulk')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async bulkAnalysis(@Req() req: IncomingMessage, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    await this.auth.requireUser(req)
    if (!file || !/\.xlsx$/i.test(file.originalname)) throw new BadRequestException({ message: 'Pilih file Excel .xlsx.' })
    const source = await this.imports.analyzeWorkbook(file.buffer)
    const rows = []
    for (const item of source) {
      try {
        const result = item.latitude !== null && item.longitude !== null
          ? await this.analyzeCoordinates(item.longitude, item.latitude)
          : await this.analyzeLocation(item.address)
        rows.push({ ...item, ...result })
      } catch (error) {
        const payload = error && typeof error === 'object' && 'getResponse' in error ? (error as { getResponse(): unknown }).getResponse() : null
        rows.push({ ...item, status: payload && typeof payload === 'object' && 'code' in payload ? String((payload as { code: unknown }).code) : 'ANALYSIS_FAILED', message: payload && typeof payload === 'object' && 'message' in payload ? String((payload as { message: unknown }).message) : 'Lokasi tidak dapat dianalisis.' })
      }
    }
    return { providerAvailable: Boolean(process.env.GEOCODER_URL), rows }
  }

  private async analyzeLocation(address: string) {
    const [longitude, latitude] = await this.geocoding.geocode(address)
    return this.analyzeCoordinates(longitude, latitude, address)
  }

  private async analyzeCoordinates(longitude: number, latitude: number, address?: string) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new BadRequestException({ message: 'Koordinat tidak valid.' })
    const nearest = await this.atlas.nearestNetwork(longitude, latitude)
    if (!nearest) return { address, longitude, latitude, network: null, distanceMeters: null, status: 'NETWORK_NOT_FOUND' }
    const target = nearest.nearestPoint?.coordinates as [number, number] | undefined
    if (!target) return { address, longitude, latitude, network: nearest, distanceMeters: null, status: 'NETWORK_NOT_FOUND' }
    try {
      const route = await this.routing.preview([[longitude,latitude],target])
      return { address, longitude, latitude, network: nearest, distanceMeters: route.distanceMeters, routeGeometry: route.geometry, status: 'OK' }
    } catch {
      return { address, longitude, latitude, network: nearest, distanceMeters: null, status: 'ROUTING_UNAVAILABLE', message: 'Rute jalan belum tersedia; jarak penarikan tidak ditampilkan.' }
    }
  }

  @Post('routes/preview')
  async routePreview(@Req() req: IncomingMessage, @Body() body: { coordinates?: unknown }) {
    await this.auth.requireUser(req)
    const coordinates = body?.coordinates
    if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 10) throw new BadRequestException({ message: 'Rute membutuhkan 2 sampai 10 titik.' })
    const points = coordinates.map((point): [number, number] => {
      if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number') throw new BadRequestException({ message: 'Koordinat harus berupa pasangan longitude, latitude.' })
      const [lon, lat] = point
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < 105.8 || lon > 107.6 || lat < -7.1 || lat > -5.5) throw new BadRequestException({ message: 'Titik rute harus berada di cakupan Jabodetabek.' })
      return [lon, lat]
    })
    return this.routing.preview(points)
  }
}
