import { cableName, describeCableEndpoints, describeCableSpans, describeSourceCable, type TerminationPlan } from "./terminationPlan";

export function CablePlanDetails({ plan, networkName }: { plan: TerminationPlan; networkName?: string }) {
  const endpoints = describeCableEndpoints(plan, networkName);
  const spans = describeCableSpans(plan, networkName);
  return <div>
    {plan.cables.map((cable, index) => <div className="border rounded p-3 mb-2" key={`${index}-${cable.type}`}>
      <strong>{cableName(index)} · {cable.type}</strong>
      <div className="table-responsive"><table className="table table-sm mb-0"><tbody>
        <tr><th scope="row">Dari</th><td>{endpoints.from}</td></tr>
        <tr><th scope="row">Ke</th><td>{endpoints.to}</td></tr>
        <tr><th scope="row">Panjang estimasi</th><td>{Math.round(cable.distanceMeters)} m</td></tr>
        <tr><th scope="row">Kapasitas kabel kandidat</th><td>{cable.cores == null ? "Belum diketahui" : `${cable.cores} core`}</td></tr>
        <tr><th scope="row">Core yang dibutuhkan (rencana)</th><td>{spans.length ? `${spans[0].requiredCores} core` : "Belum dapat ditentukan"}</td></tr>
      </tbody></table></div>
    </div>)}
    {spans.length > 1 && <details className="mb-2">
      <summary className="fw-semibold py-2">Lihat rincian {spans.length} ruas kabel</summary>
      <div className="table-responsive">
      <table className="table table-sm"><thead><tr><th>Ruas</th><th>Dari</th><th>Ke</th><th>Panjang</th><th>Core dibutuhkan</th></tr></thead>
        <tbody>{spans.map((span) => <tr key={span.name}><td>{span.name}</td><td>{span.from}</td><td>{span.to}</td><td>{Math.round(span.distanceMeters)} m</td><td>{span.requiredCores} core</td></tr>)}</tbody>
      </table>
      </div>
    </details>}
    <small className="d-block">Kabel sumber: {describeSourceCable(plan)}. Rencana menggunakan satu core masukan per ODP simulasi. {plan.sourceCable?.verified && plan.sourceCable.availableCount != null && spans.length ? `Perkiraan sisa: ${Math.max(0, plan.sourceCable.availableCount - spans[0].requiredCores)} core${spans[0].requiredCores > plan.sourceCable.availableCount ? " (kapasitas tidak mencukupi)" : ""}. ` : ""}Angka rencana belum mengubah status atau booking core. Titik dan sambungan perlu diperiksa saat survei.</small>
  </div>;
}
