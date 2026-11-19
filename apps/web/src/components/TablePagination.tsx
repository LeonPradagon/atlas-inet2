export function TablePagination({
  page,
  pageSize,
  total,
  label,
  busy = false,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  label: string;
  busy?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <nav
      aria-label={`Navigasi halaman ${label}`}
      className="card-footer d-flex align-items-center justify-content-between small text-secondary flex-wrap gap-2"
    >
      <label className="d-flex align-items-center gap-2">
        <span>Per halaman</span>
        <select
          aria-label={`Jumlah ${label} per halaman`}
          className="form-select form-select-sm w-auto"
          disabled={busy}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
          value={pageSize}
        >
          {[5, 10, 20, 50].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <span className="flex-grow-1 text-center">
        Menampilkan {((page - 1) * pageSize + 1).toLocaleString("id-ID")}–
        {Math.min(page * pageSize, total).toLocaleString("id-ID")} dari{" "}
        {total.toLocaleString("id-ID")} {label}
      </span>
      <div className="d-flex align-items-center gap-2">
        <span>
          Halaman {page.toLocaleString("id-ID")} /{" "}
          {pageCount.toLocaleString("id-ID")}
        </span>
        {/* biome-ignore lint/a11y/useSemanticElements: Bootstrap btn-group markup; a fieldset breaks its layout */}
        <div
          aria-label={`Kontrol halaman ${label}`}
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
    </nav>
  );
}
