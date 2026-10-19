export function TablePagination({ page, pageSize, total, label, busy = false, onPageChange }: {
  page: number
  pageSize: number
  total: number
  label: string
  busy?: boolean
  onPageChange: (page: number) => void
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (total <= pageSize) return null

  return <div className="card-footer d-flex align-items-center justify-content-between gap-2 flex-wrap small text-secondary">
    <span>Menampilkan {((page - 1) * pageSize + 1).toLocaleString('id-ID')}–{Math.min(page * pageSize, total).toLocaleString('id-ID')} dari {total.toLocaleString('id-ID')} {label}</span>
    <div className="d-flex align-items-center gap-2 ms-auto">
      <span>Halaman {page.toLocaleString('id-ID')} / {pageCount.toLocaleString('id-ID')}</span>
      <div className="btn-group btn-group-sm" role="group" aria-label={`Pagination ${label}`}>
        <button className="btn btn-outline-secondary" aria-label="Sebelumnya" title="Sebelumnya" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1 || busy}><i className="bi bi-chevron-left" aria-hidden="true" /></button>
        <button className="btn btn-outline-secondary" aria-label="Berikutnya" title="Berikutnya" onClick={() => onPageChange(Math.min(pageCount, page + 1))} disabled={page >= pageCount || busy}><i className="bi bi-chevron-right" aria-hidden="true" /></button>
      </div>
    </div>
  </div>
}
