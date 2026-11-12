import type { ReactNode } from "react";

export type DetailTableRow = {
  label: string;
  value: ReactNode;
  key?: string;
  valueClassName?: string;
};

export function DetailTable({
  label,
  rows,
  className = "",
}: {
  label: string;
  rows: readonly DetailTableRow[];
  className?: string;
}) {
  return (
    <table
      aria-label={label}
      className={`table atlas-detail-table ${className}`.trim()}
    >
      <caption className="visually-hidden">{label}</caption>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.key ?? `${row.label}-${index}`}>
            <th scope="row">{row.label}</th>
            <td className={row.valueClassName}>{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
