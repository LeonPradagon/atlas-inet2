import { DataTable, type DataTableColumn } from "../../components/DataTable";
import { DetailTable } from "../../components/DetailTable";
import {
  cableName,
  describeCableEndpoints,
  describeCableSpans,
  describeSourceCable,
  type TerminationPlan,
} from "./terminationPlan";

type CablePlanFact = { label: string; value: string };
type CablePlanSpan = {
  name: string;
  from: string;
  to: string;
  distanceMeters: number;
  requiredCores: number;
};

const spanColumns: readonly DataTableColumn<CablePlanSpan>[] = [
  {
    key: "name",
    header: "Ruas",
    rowHeader: true,
    render: (row) => row.name,
  },
  { key: "from", header: "Dari", render: (row) => row.from },
  { key: "to", header: "Ke", render: (row) => row.to },
  {
    key: "distance",
    header: "Panjang",
    className: "text-nowrap",
    render: (row) => `${Math.round(row.distanceMeters)} m`,
  },
  {
    key: "cores",
    header: "Core dibutuhkan",
    className: "text-nowrap",
    render: (row) => `${row.requiredCores} core`,
  },
];

export function CablePlanDetails({
  plan,
  networkName,
}: {
  plan: TerminationPlan;
  networkName?: string;
}) {
  const endpoints = describeCableEndpoints(plan, networkName);
  const spans = describeCableSpans(plan, networkName);

  return (
    <div className="cable-plan-details">
      {plan.cables.map((cable, index) => {
        const label = cableName(index);
        const facts: CablePlanFact[] = [
          { label: "Dari", value: endpoints.from },
          { label: "Ke", value: endpoints.to },
          {
            label: "Panjang estimasi",
            value: `${Math.round(cable.distanceMeters)} m`,
          },
          {
            label: "Kapasitas kabel kandidat",
            value:
              cable.cores == null ? "Belum diketahui" : `${cable.cores} core`,
          },
          {
            label: "Core yang dibutuhkan",
            value: spans.length
              ? `${spans[0].requiredCores} core`
              : "Belum dapat ditentukan",
          },
        ];

        return (
          <section
            aria-label={`${label} · ${cable.type}`}
            className="cable-plan-item"
            key={`${index}-${cable.type}`}
          >
            <h4 className="cable-plan-item-title">
              {label} <span>· {cable.type}</span>
            </h4>
            <DetailTable
              className="cable-plan-facts-table"
              label={`Ringkasan ${label}`}
              rows={facts}
            />
          </section>
        );
      })}

      {spans.length > 1 && (
        <details className="cable-plan-spans">
          <summary>Rincian {spans.length} ruas kabel</summary>
          <DataTable
            columns={spanColumns}
            density="compact"
            label="Rincian ruas kabel"
            rows={spans}
            rowKey={(span) => span.name}
            tableClassName="cable-plan-spans-table"
          />
        </details>
      )}

      <small className="cable-plan-note">
        Kabel sumber: {describeSourceCable(plan)}. Rencana menggunakan satu core
        masukan per ODP simulasi.{" "}
        {plan.sourceCable?.verified &&
        plan.sourceCable.availableCount != null &&
        spans.length
          ? `Perkiraan sisa: ${Math.max(0, plan.sourceCable.availableCount - spans[0].requiredCores)} core${spans[0].requiredCores > plan.sourceCable.availableCount ? " (kapasitas tidak mencukupi)" : ""}. `
          : ""}
        Angka rencana belum mengubah status atau booking core. Titik dan
        sambungan perlu diperiksa saat survei.
      </small>
    </div>
  );
}
