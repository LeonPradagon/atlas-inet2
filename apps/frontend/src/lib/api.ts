import axios, { type AxiosError, type AxiosRequestConfig } from 'axios'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

type ErrorPayload = { message?: string | string[]; code?: string }

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  withCredentials: true,
})

apiClient.interceptors.request.use((config) => {
  config.headers.set('Accept', 'application/json')
  return config
})

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ErrorPayload>) => {
    const payload = error.response?.data
    const message = Array.isArray(payload?.message)
      ? payload.message.join(', ')
      : payload?.message ?? error.message ?? 'Tidak dapat terhubung ke server.'
    return Promise.reject(new ApiError(message, error.response?.status ?? 0, payload?.code))
  },
)

export async function api<T>(path: string, options: AxiosRequestConfig = {}): Promise<T> {
  const response = await apiClient.request<T>({ ...options, url: path })
  return response.data
}

export const postJson = (data: unknown): AxiosRequestConfig => ({ method: 'POST', data })

export async function postCompressedJson<T>(path: string, data: unknown): Promise<T> {
  if (typeof CompressionStream === 'undefined') return api<T>(path, postJson(data))
  const stream = new Blob([JSON.stringify(data)]).stream().pipeThrough(new CompressionStream('gzip'))
  const compressed = await new Response(stream).blob()
  return api<T>(path, { method: 'POST', data: compressed, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })
}

export type NetworkAsset = {
  id: string; name: string; area: string; assetType: string; source: 'managed' | 'kml' | 'xlsx'; cableType: string; installation: 'Aerial' | 'Burial'; side: 'Kiri' | 'Kanan';
  pole: string; poleHeight: '7 m' | '9 m' | null; odc: string; odp: string; totalCores: number; usedCores: number; bookedCores: number; idleCores: number; nameValid?: boolean;
  geometry: Geometry | null; geometryType?: string; createdAt?: string; attributes: Record<string, unknown>
}
export type NetworkAssetPage = { items: NetworkAsset[]; total: number; page: number; pageSize: number }
export type Booking = { id: string; customer: string; picCustomer: string; picPresales: string; segmentId: string; cores: number; status: 'Pending Approval' | 'Booked' | 'Waiting List' | 'Rejected' | 'Released' | 'Expired'; requestedAt: string; approvedAt: string | null; rejectedAt: string | null; expiresAt: string | null; segmentName: string; area: string }
export type AssetRelation = { assetId: string; kind: 'POLE' | 'ODC' | 'ODP'; name: string; area?: string; poleHeight: '7 m' | '9 m' | null }

export const networkQueryKeys = ['segments', 'segment-catalog', 'bookable-segments', 'map-assets', 'cores', 'bookings', 'dashboard', 'relations', 'notifications', 'audit-trails', 'network-usage'] as const
import type { Geometry } from 'geojson'
