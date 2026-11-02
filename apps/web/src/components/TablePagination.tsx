export function TablePagination({
  page,
  pageSize,
  total,
  label,
  busy = false,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  label: string;
  busy?: boolean;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) {
    return null;
  }

  return (
    <div className="card-footer d-flex align-items-center justify-content-between small text-secondary flex-wrap gap-2">
      <span>
        Menampilkan {((page - 1) * pageSize + 1).toLocaleString("id-ID")}–
        {Math.min(page * pageSize, total).toLocaleString("id-ID")} dari{" "}
        {total.toLocaleString("id-ID")} {label}
      </span>
      <div className="d-flex align-items-center ms-auto gap-2">
        <span>
          Halaman {page.toLocaleString("id-ID")} /{" "}
          {pageCount.toLocaleString("id-ID")}
        </span>
        <div
          aria-label={`Pagination ${label}`}
          className="btn-group btn-group-sm"
          role="group"
        >
          <button
            aria-label="Sebelumnya"
            className="btn btn-outline-secondary"
            disabled={page <= 1 || busy}
            onClick={() => onPageChange(Math.max(1, page - 1))}
            title="Sebelumnya"
            type="button"
          >
            <i aria-hidden="true" className="bi bi-chevron-left" />
          </button>
          <button
            aria-label="Berikutnya"
            className="btn btn-outline-secondary"
            disabled={page >= pageCount || busy}
            onClick={() => onPageChange(Math.min(pageCount, page + 1))}
            title="Berikutnya"
            type="button"
          >
            <i aria-hidden="true" className="bi bi-chevron-right" />
          </button>
        </div>
      </div>
    </div>
  );
}
