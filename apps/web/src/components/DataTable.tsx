import type { CSSProperties, ReactNode } from "react";

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  rowHeader?: boolean;
  className?: string;
  headerClassName?: string;
  width?: CSSProperties["width"];
};

export function DataTableShell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-label={`${label}; gulir horizontal untuk melihat semua kolom`}
      className="table-responsive atlas-data-table-scroll"
      role="region"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  emptyState = "Tidak ada data untuk ditampilkan.",
  rowClassName,
  tableClassName = "",
}: {
  label: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  emptyState?: ReactNode;
  rowClassName?: (row: Row) => string | undefined;
  tableClassName?: string;
}) {
  return (
    <DataTableShell label={label}>
      <table
        aria-label={label}
        className={`table table-hover atlas-data-table ${tableClassName}`.trim()}
      >
        <caption className="visually-hidden">{label}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                className={column.headerClassName}
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr className={rowClassName?.(row)} key={rowKey(row)}>
                {columns.map((column) => {
                  const content = column.render(row);
                  const className = column.className;
                  return column.rowHeader ? (
                    <th
                      className={className}
                      key={column.key}
                      scope="row"
                    >
                      {content}
                    </th>
                  ) : (
                    <td className={className} key={column.key}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            ))
          ) : (
            <tr>
              <td className="atlas-data-table-empty" colSpan={columns.length}>
                {emptyState}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </DataTableShell>
  );
}
