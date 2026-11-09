import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import type { TerminationPlan } from "./terminationPlan";

export function SubmitSurveyButton({
  historyId,
  rowNumber = 0,
  latitude,
  longitude,
  requireProposal = false,
  plan,
  planRequired = false,
}: {
  historyId: string;
  rowNumber?: number;
  latitude?: number;
  longitude?: number;
  requireProposal?: boolean;
  plan?: TerminationPlan | null;
  planRequired?: boolean;
}) {
  const client = useQueryClient();
  const [showProposal, setShowProposal] = useState(requireProposal);
  const [kind, setKind] = useState("ODP");
  const [cores, setCores] = useState("");
  const count = Number(cores);
  const proposalValid =
    Number.isInteger(count) &&
    count > 0 &&
    count <= 4096 &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude);
  const submit = useMutation({
    mutationFn: () =>
      api("/surveys", {
        method: "POST",
        data: {
          historyId,
          rowNumber,
          ...(showProposal && !planRequired
            ? { proposal: { kind, cores: count, latitude, longitude } }
            : {}),
          ...(plan ? { plan } : {}),
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["surveys"] });
    },
  });
  return (
    <div className="my-3">
      {!planRequired && (
        <label className="d-block mb-2">
          <input
            checked={showProposal}
            className="form-check-input me-2"
            disabled={submit.isSuccess || requireProposal}
            onChange={(e) => setShowProposal(e.target.checked)}
            type="checkbox"
          />
          Usulkan terminasi baru pada titik lokasi analisis
        </label>
      )}
      {showProposal && !planRequired && (
        <div className="border rounded p-2 mb-2">
          <label className="form-label d-block">
            Jenis terminasi{" "}
            <select
              className="form-select"
              disabled={submit.isSuccess}
              onChange={(e) => setKind(e.target.value)}
              value={kind}
            >
              <option value="ODP">ODP</option>
              <option value="ODC">ODC</option>
              <option value="JOINT_CLOSURE">Closure</option>
              <option value="OTB">OTB</option>
            </select>
          </label>
          <label className="form-label d-block">
            Jumlah core kabel usulan{" "}
            <input
              className="form-control"
              disabled={submit.isSuccess}
              max="4096"
              min="1"
              onChange={(e) => setCores(e.target.value)}
              step="1"
              type="number"
              value={cores}
            />
          </label>
          <small>
            Lokasi mengikuti titik analisis. Usulan dan jalur harus diverifikasi
            saat survei.
          </small>
        </div>
      )}
      {plan && (
        <small className="d-block text-success mb-2">
          Usulan jalur dan {plan.cables.length} kabel akan disertakan.
        </small>
      )}
      {planRequired && !plan && (
        <small className="d-block text-warning mb-2">
          Hitung jalur rencana sebelum mengajukan survei.
        </small>
      )}
      <button
        className="btn btn-outline-primary"
        disabled={
          submit.isPending ||
          submit.isSuccess ||
          (showProposal && !planRequired && !proposalValid) ||
          (planRequired && !plan)
        }
        onClick={() => submit.mutate()}
        type="button"
      >
        {submit.isSuccess
          ? "Survei sudah diajukan"
          : submit.isPending
            ? "Mengajukan..."
            : "Ajukan survei"}
      </button>
      {submit.isSuccess && (
        <small className="d-block text-success mt-1" role="status">
          Tersimpan di menu Survei & Verifikasi.
        </small>
      )}
      {submit.error && (
        <small className="d-block text-danger mt-1" role="alert">
          {submit.error.message}
        </small>
      )}
    </div>
  );
}
