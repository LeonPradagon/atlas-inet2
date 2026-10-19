import { BadRequestException, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors, Body } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import type { IncomingMessage } from 'node:http'
import { AuthService } from '../auth/auth.service'
import { AtlasService } from './atlas.service'
import { NetworkImportService } from '../network/network-import.service'
import { RoutingService } from '../geospatial/routing.service'
import { GeocodingService, type PhotonSearchOptions, type StructuredAddress } from '../geospatial/geocoding.service'
import { BulkAnalysisService } from './bulk-analysis.service'

function queryValues(query: Record<string, unknown>, key: string) {
  const value = query[key]
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => typeof item === 'string' ? [item] : [])
    .map((item) => item.trim())
    .filter(Boolean)
}

function photonSearchOptions(query: Record<string, unknown>): PhotonSearchOptions {
  const first = (key: string) => queryValues(query, key)[0]
  const number = (key: string, min: number, max: number) => {
    const value = first(key)
    if (value === undefined) return undefined
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new BadRequestException({ message: `Parameter ${key} tidak valid.` })
    return parsed
  }
  const latitude = number('lat', -90, 90)
  const longitude = number('lon', -180, 180)
  if ((latitude === undefined) !== (longitude === undefined)) throw new BadRequestException({ message: 'Parameter lat dan lon harus dikirim bersama.' })
  const lang = first('lang') ?? 'id'
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(lang)) throw new BadRequestException({ message: 'Parameter lang tidak valid.' })
  const layers = queryValues(query, 'layer').flatMap((value) => value.split(',').map((layer) => layer.trim()).filter(Boolean))
  const supportedLayers = new Set(['house', 'street', 'locality', 'district', 'city', 'county', 'state', 'country', 'other'])
  if (layers.some((layer) => !supportedLayers.has(layer))) throw new BadRequestException({ message: 'Layer Photon tidak dikenal.' })
  const categories = (key: string) => {
    const values = queryValues(query, key)
    if (values.length > 10 || values.some((value) => value.length > 100 || value.split(',').some((category) => !/^[\w-]+(?:\.[\w-]+){1,3}$/.test(category)))) {
      throw new BadRequestException({ message: `Filter ${key} tidak valid.` })
    }
    return values
  }
  const osmTags = queryValues(query, 'osm_tag')
  if (osmTags.length > 10 || osmTags.some((value) => value.length > 100 || !/^(?:!?[\w.-]+(?::!?[\w.-]+)?|:!?[\w.-]+)$/.test(value))) throw new BadRequestException({ message: 'Filter osm_tag tidak valid.' })
  const bboxValues = first('bbox')?.split(',').map(Number)
  let bbox: PhotonSearchOptions['bbox']
  if (bboxValues) {
    if (bboxValues.length !== 4 || bboxValues.some((value) => !Number.isFinite(value)) || bboxValues[0] < -180 || bboxValues[2] > 180 || bboxValues[1] < -90 || bboxValues[3] > 90 || bboxValues[0] >= bboxValues[2] || bboxValues[1] >= bboxValues[3]) {
      throw new BadRequestException({ message: 'Parameter bbox tidak valid.' })
    }
    bbox = bboxValues as [number, number, number, number]
  }
  const dedupeText = first('dedupe')
  if (dedupeText !== undefined && !['0', '1', 'true', 'false'].includes(dedupeText.toLowerCase())) throw new BadRequestException({ message: 'Parameter dedupe tidak valid.' })
  return {
    lang,
    latitude,
    longitude,
    zoom: number('zoom', 0, 22),
    locationBiasScale: number('location_bias_scale', 0, 1),
    bbox,
    layers,
    include: categories('include'),
    exclude: categories('exclude'),
    osmTags,
    dedupe: dedupeText === undefined ? undefined : ['1', 'true'].includes(dedupeText.toLowerCase()),
    limit: number('limit', 1, 5),
  }
}

@Controller()
export class AtlasController {
  constructor(
    @Inject(AtlasService) private readonly atlas: AtlasService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(NetworkImportService) private readonly imports: NetworkImportService,
    @Inject(RoutingService) private readonly routing: RoutingService,
    @Inject(GeocodingService) private readonly geocoding: GeocodingService,
    @Inject(BulkAnalysisService) private readonly bulk: BulkAnalysisService,
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

  @Get('assets/catalog')
  async assetCatalog(@Req() req: IncomingMessage, @Query('search') search?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('coreFilter') coreFilter = 'all') {
    await this.auth.requireUser(req)
    const parsedPage = page === undefined ? 1 : Number(page)
    const parsedPageSize = pageSize === undefined ? 50 : Number(pageSize)
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || !Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) throw new BadRequestException({ message: 'Parameter pagination aset tidak valid.' })
    if (!['all','segments','filled','empty'].includes(coreFilter)) throw new BadRequestException({ message: 'Filter core tidak valid.' })
    return this.atlas.listAssetPage(search ?? '', parsedPage, parsedPageSize, coreFilter)
  }

  @Get('assets/bookable-segments')
  async bookableSegments(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.listBookableSegments() }

  @Get('assets/bounds')
  async mapBounds(@Req() req: IncomingMessage) { await this.auth.requireUser(req); return this.atlas.mapBounds() }

  @Get('assets/map')
  async mapAssets(@Req() req: IncomingMessage, @Query('bbox') bbox?: string) {
    await this.auth.requireUser(req)
    const values = bbox?.split(',').map(Number) ?? []
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[0] < -180 || values[2] > 180 || values[1] < -90 || values[3] > 90 || values[0] >= values[2] || values[1] >= values[3]) {
      throw new BadRequestException({ message: 'Batas peta tidak valid.' })
    }
    return this.atlas.listMapAssets(values as [number, number, number, number])
  }

  @Post('assets/point')
  async createPointAsset(@Req() req: IncomingMessage, @Body() body: { name?: unknown; kind?: unknown; longitude?: unknown; latitude?: unknown; area?: unknown; poleHeight?: unknown }) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.createPointAsset(body, user.id)
  }

  @Post('assets/ftth-design')
  async saveFtthDesign(@Req() req: IncomingMessage, @Body() body: { features?: unknown; area?: unknown; sourceAnalysisId?: unknown; sourceRow?: unknown }) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.saveFtthDesign(body?.features, user.id, body?.area, { analysisId: body?.sourceAnalysisId, row: body?.sourceRow })
  }

  @Get('assets/:id/geometry')
  async assetGeometry(@Req() req: IncomingMessage, @Param('id') id: string) { await this.auth.requireUser(req); return this.atlas.assetGeometry(id) }

  @Patch('assets/:id')
  async updateAsset(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.updateAsset(id, body, user.id)
  }

  @Get('assets/:id/cores')
  async cores(@Req() req: IncomingMessage, @Param('id') id: string) { await this.auth.requireUser(req); return this.atlas.listCores(id) }

  @Get('assets/:id/relations')
  async relations(@Req() req: IncomingMessage, @Param('id') id: string) {
    await this.auth.requireUser(req)
    return this.atlas.listRelations(id)
  }

  @Put('assets/:id/relations')
  async saveRelations(@Req() req: IncomingMessage, @Param('id') id: string, @Body() body: { relations?: unknown }) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.saveRelations(id,body?.relations,user.id)
  }

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

  @Post('bookings/:id/approve')
  async approveBooking(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.approveBooking(id, user.id)
  }

  @Post('bookings/:id/reject')
  async rejectBooking(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireAdmin(req)
    return this.atlas.rejectBooking(id, user.id)
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
  async analyzeAddress(@Req() req: IncomingMessage, @Body() body: { address?: string; structured?: StructuredAddress; coordinates?: { longitude?: number; latitude?: number; provider?: 'photon' | 'manual'; matchQuality?: 'approximate'; matchedStreet?: string }; coordinateConfirmed?: boolean }) {
    const user = await this.auth.requireUser(req)
    if (!body.address?.trim()) throw new BadRequestException({ message: 'Alamat wajib diisi.' })
    if (!body.structured?.province?.trim() || !body.structured.city?.trim() || !body.structured.district?.trim() || !body.structured.subdistrict?.trim()) {
      throw new BadRequestException({ message: 'Provinsi, kabupaten/kota, kecamatan, dan kelurahan/desa wajib dipilih.' })
    }
    if (body.coordinates) {
      if (body.coordinateConfirmed !== true) throw new BadRequestException({ message: 'Konfirmasi posisi titik pada peta sebelum analisis.' })
      const { longitude, latitude, provider, matchQuality, matchedStreet } = body.coordinates
      if (typeof longitude !== 'number' || typeof latitude !== 'number') throw new BadRequestException({ message: 'Koordinat harus berupa longitude dan latitude.' })
      const result = await this.analyzeCoordinates(longitude, latitude, body.address, provider, matchQuality, matchedStreet)
      const historyId = await this.atlas.saveAnalysisHistory(user.id, 'ADDRESS', body.address.trim(), { address: body.address, structured: body.structured, coordinates: body.coordinates, coordinateConfirmed: true }, result)
      return { ...result, historyId }
    }
    if (body.structured) {
        const result = await this.geocoding.geocodeStructured(body.structured)
        const [longitude, latitude] = result.coordinates
        const analysis = await this.analyzeCoordinates(longitude, latitude, body.address, result.provider, result.matchQuality, result.matchedStreet)
        const historyId = await this.atlas.saveAnalysisHistory(user.id, 'ADDRESS', body.address.trim(), { address: body.address, structured: body.structured }, analysis)
        return { ...analysis, historyId }
    }
    const result = await this.analyzeLocation(body.address)
    const historyId = await this.atlas.saveAnalysisHistory(user.id, 'ADDRESS', body.address.trim(), { address: body.address }, result)
    return { ...result, historyId }
  }

  @Get('analysis/address/suggestions')
  async addressSuggestions(@Req() req: IncomingMessage, @Query() query: Record<string, unknown>) {
    await this.auth.requireUser(req)
    const search = typeof query.q === 'string' ? query.q.trim() : ''
    if (!search || search.length < 3) return []
    const first = (key: string) => queryValues(query, key)[0]
    return this.geocoding.suggestAddress(search, { subdistrict: first('subdistrict'), district: first('district'), city: first('city'), province: first('province'), postalCode: first('postalCode') }, photonSearchOptions(query))
  }

  @Get('analysis/address/reverse')
  async reverseAddress(@Req() req: IncomingMessage, @Query('longitude') longitude?: string, @Query('latitude') latitude?: string) {
    await this.auth.requireUser(req)
    const lon = Number(longitude), lat = Number(latitude)
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new BadRequestException({ message: 'Koordinat alamat tidak valid.' })
    return this.geocoding.reverseAddress(lon, lat)
  }

  @Post('analysis/bulk')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async bulkAnalysis(@Req() req: IncomingMessage, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    const user = await this.auth.requireUser(req)
    if (!file || !/\.xlsx$/i.test(file.originalname)) throw new BadRequestException({ message: 'Pilih file Excel .xlsx.' })
    const source = await this.imports.analyzeWorkbook(file.buffer, { maxBytes: 15 * 1024 * 1024, maxRows: 500 })
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
    const result = { providerAvailable: Boolean(process.env.GEOCODER_URL), rows }
    const historyId = await this.atlas.saveAnalysisHistory(user.id, 'BULK', file.originalname, { fileName: file.originalname, rowCount: rows.length }, result)
    return { ...result, historyId }
  }

  @Post('analysis/bulk/jobs')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
  async createBulkJob(@Req() req: IncomingMessage, @UploadedFile() file?: { originalname: string; buffer: Buffer }) {
    const user = await this.auth.requireUser(req)
    if (!file) throw new BadRequestException({ message: 'Pilih file Excel .xlsx.' })
    return this.bulk.create(user.id,file.originalname,file.buffer)
  }

  @Get('analysis/bulk/jobs/:id')
  async bulkJobProgress(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    return this.bulk.progress(user.id,id)
  }

  @Get('analysis/bulk/jobs/:id/rows')
  async bulkJobRows(@Req() req: IncomingMessage, @Param('id') id: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string, @Query('search') search?: string, @Query('status') status?: string) {
    const user = await this.auth.requireUser(req)
    return this.bulk.page(user.id,id,Number(page) || 1,Number(pageSize) || 50,search ?? '',status ?? '')
  }

  @Get('analysis/bulk/jobs/:id/map-points')
  async bulkJobMapPoints(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    return this.bulk.mapPoints(user.id,id)
  }

  @Post('analysis/bulk/jobs/:id/cancel')
  async cancelBulkJob(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    return this.bulk.cancel(user.id,id)
  }

  @Get('analysis/history')
  async analysisHistory(@Req() req: IncomingMessage, @Query('type') type?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const user = await this.auth.requireUser(req)
    if (type && type !== 'ADDRESS' && type !== 'BULK' && type !== 'FTTH_DESIGN') throw new BadRequestException({ message: 'Jenis riwayat tidak valid.' })
    const parsedPage = page === undefined ? 1 : Number(page)
    const parsedPageSize = pageSize === undefined ? 25 : Number(pageSize)
    if (!Number.isInteger(parsedPage) || parsedPage < 1 || !Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 100) throw new BadRequestException({ message: 'Parameter pagination riwayat tidak valid.' })
    return this.atlas.listAnalysisHistory(user.id, type as 'ADDRESS' | 'BULK' | 'FTTH_DESIGN' | undefined, parsedPage, parsedPageSize)
  }

  @Get('analysis/history/:id')
  async analysisHistoryDetail(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    return this.atlas.getAnalysisHistory(user.id, id)
  }

  @Delete('analysis/history/:id')
  async deleteAnalysisHistory(@Req() req: IncomingMessage, @Param('id') id: string) {
    const user = await this.auth.requireUser(req)
    await this.atlas.deleteAnalysisHistory(user.id, id)
    return { success: true }
  }

  private async analyzeLocation(address: string) {
    const [longitude, latitude] = await this.geocoding.geocode(address)
    return this.analyzeCoordinates(longitude, latitude, address)
  }

  private async analyzeCoordinates(longitude: number, latitude: number, address?: string, geocodingProvider?: 'photon' | 'nominatim' | 'manual', geocodingMatch?: 'approximate', matchedStreet?: string) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) throw new BadRequestException({ message: 'Koordinat tidak valid.' })
    const nearest = await this.atlas.nearestNetwork(longitude, latitude)
      if (!nearest) return { address, longitude, latitude, network: null, distanceMeters: null, status: 'NETWORK_NOT_FOUND', geocodingProvider, geocodingMatch, matchedStreet }
    const target = nearest.nearestPoint?.coordinates as [number, number] | undefined
      if (!target) return { address, longitude, latitude, network: nearest, distanceMeters: null, status: 'NETWORK_NOT_FOUND', geocodingProvider, geocodingMatch, matchedStreet }
    try {
      const route = await this.routing.preview([[longitude,latitude],target])
        return { address, longitude, latitude, network: nearest, distanceMeters: route.distanceMeters, routeGeometry: route.geometry, status: 'OK', geocodingProvider, geocodingMatch, matchedStreet }
    } catch {
        return { address, longitude, latitude, network: nearest, distanceMeters: null, status: 'ROUTING_UNAVAILABLE', message: 'Rute jalan belum tersedia; jarak penarikan tidak ditampilkan.', geocodingProvider, geocodingMatch, matchedStreet }
    }
  }

  @Post('routes/preview')
  async routePreview(@Req() req: IncomingMessage, @Body() body: { coordinates?: unknown }) {
    const user = await this.auth.requireUser(req)
    const points = this.parseRouteCoordinates(body?.coordinates)
    const result = await this.routing.preview(points)
    await this.atlas.recordAudit(user.id,'ROUTE_PREVIEW_COMPLETED',{ pointCount: points.length,distanceMeters: result.distanceMeters })
    return result
  }

  @Post('routes/preview-ftth')
  async ftthRoutePreview(@Req() req: IncomingMessage, @Body() body: { coordinates?: unknown }) {
    const user = await this.auth.requireUser(req)
    const points = this.parseRouteCoordinates(body?.coordinates)
    const result = await this.routing.previewFtth(points)
    await this.atlas.recordAudit(user.id,'FTTH_ROUTE_PREVIEW_COMPLETED',{ pointCount: points.length,distanceMeters: result.distanceMeters })
    return result
  }

  private parseRouteCoordinates(coordinates: unknown) {
    if (!Array.isArray(coordinates) || coordinates.length < 2 || coordinates.length > 10) throw new BadRequestException({ message: 'Rute membutuhkan 2 sampai 10 titik.' })
    const points = coordinates.map((point): [number, number] => {
      if (!Array.isArray(point) || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number') throw new BadRequestException({ message: 'Koordinat harus berupa pasangan longitude, latitude.' })
      const [lon, lat] = point
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new BadRequestException({ message: 'Koordinat harus berada dalam rentang longitude dan latitude yang valid.' })
      return [lon, lat]
    })
    return points
  }
}
