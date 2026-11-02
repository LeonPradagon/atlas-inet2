const labels: Record<string, string> = {
  QUEUED: 'Menunggu antrean',
  RUNNING: 'Sedang diproses',
  COMPLETED: 'Selesai',
  COMPLETED_WITH_ERRORS: 'Selesai, beberapa lokasi perlu diperiksa',
  CANCELLED: 'Dibatalkan',
  FAILED: 'Tidak dapat diproses',
}

export const bulkJobStatusLabel = (status?: string | null) => labels[status ?? ''] ?? 'Status belum tersedia'
