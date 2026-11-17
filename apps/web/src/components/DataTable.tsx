import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  cloneElement,
  isValidElement,
  type ReactNode,
} from "react";

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
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    const table = element.current?.querySelector("table");
    if (!table) return;
    const labels = [...table.querySelectorAll("thead th")].map(
      (cell) => cell.textContent?.trim() ?? ""
    );
    table.dataset.mobileCards = "true";
    for (const row of table.querySelectorAll("tbody tr")) {
      for (const [index, cell] of [...row.children].entries()) {
        (cell as HTMLElement).dataset.columnLabel = labels[index] ?? "";
      }
    }
  }, [children]);
  const table =
    isValidElement<{ className?: string }>(children) &&
    children.type === "table"
      ? cloneElement(children, {
          className:
            `${children.props.className ?? ""} atlas-data-table`.trim(),
        })
      : children;
  return (
    <section
      ref={element}
      aria-label={label}
      className="table-responsive atlas-data-table-scroll"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be focusable so keyboard users can scroll it
      tabIndex={0}
    >
      {table}
    </section>
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
  rowId,
  onRowClick,
  rowAriaLabel,
  density = "comfortable",
  showHeader = true,
  hover = true,
}: {
  label: string;
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  emptyState?: ReactNode;
  rowClassName?: (row: Row) => string | undefined;
  tableClassName?: string;
  rowId?: (row: Row) => string | undefined;
  onRowClick?: (row: Row) => void;
  rowAriaLabel?: (row: Row) => string;
  density?: "comfortable" | "compact";
  showHeader?: boolean;
  hover?: boolean;
}) {
  return (
    <DataTableShell label={label}>
      <table
        aria-label={label}
        className={`table ${hover ? "table-hover" : ""} atlas-data-table ${density === "compact" ? "atlas-data-table-compact" : ""} ${tableClassName}`.trim()}
      >
        <caption className="visually-hidden">{label}</caption>
        {showHeader && (
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
        )}
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr
                className={rowClassName?.(row)}
                id={rowId?.(row)}
                key={rowKey(row)}
                aria-label={onRowClick ? rowAriaLabel?.(row) : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event: KeyboardEvent<HTMLTableRowElement>) => {
                        if (
                          event.target !== event.currentTarget ||
                          (event.key !== "Enter" && event.key !== " ")
                        ) {
                          return;
                        }
                        event.preventDefault();
                        onRowClick(row);
                      }
                    : undefined
                }
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((column) => {
                  const content = column.render(row);
                  const className = column.className;
                  return column.rowHeader ? (
                    <th className={className} key={column.key} scope="row">
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
