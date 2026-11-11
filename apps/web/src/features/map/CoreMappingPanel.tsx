import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type NetworkAssetPage, networkQueryKeys } from "../../lib/api";

type Mapping = { id: string; nodeName: string; source: string; note: string; cableAId: string; cableAName: string; coreA: number; cableBName: string | null; coreB: number | null; splitterInput: string | null };

export function CoreMappingPanel({ segmentId, isAdmin }: { segmentId: string; isAdmin: boolean }) {
  const client = useQueryClient();
  const [kind, setKind] = useState<"splitter" | "splice">("splitter");
  const [nodeSearch, setNodeSearch] = useState("");
  const [node, setNode] = useState("");
  const [peerSearch, setPeerSearch] = useState("");
  const [peer, setPeer] = useState("");
  const [core, setCore] = useState("");
  const [peerCore, setPeerCore] = useState("");
  const [splitter, setSplitter] = useState("");
  const [source, setSource] = useState("");
  const [note, setNote] = useState("");
  const mappings = useQuery({ queryKey: ["core-mappings", segmentId], queryFn: () => api<Mapping[]>(`/assets/${segmentId}/core-mappings`) });
  const nodes = useQuery({ queryKey: ["mapping-nodes", nodeSearch, kind], enabled: isAdmin && nodeSearch.trim().length >= 2, queryFn: () => api<NetworkAssetPage>(`/assets/catalog?assetType=network&pageSize=25${kind === "splitter" ? "&networkKind=odp" : ""}&search=${encodeURIComponent(nodeSearch.trim())}`) });
  const peers = useQuery({ queryKey: ["mapping-peers", peerSearch], enabled: isAdmin && kind === "splice" && peerSearch.trim().length >= 2, queryFn: () => api<NetworkAssetPage>(`/assets/catalog?assetType=cables&pageSize=25&search=${encodeURIComponent(peerSearch.trim())}`) });
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ["core-mappings"] }), ...networkQueryKeys.map((key) => client.invalidateQueries({ queryKey: [key] }))]);
  const create = useMutation({ mutationFn: () => api(`/assets/${segmentId}/core-mappings`, { method: "POST", data: { nodeAssetId: node, coreNumber: Number(core), source, note, ...(kind === "splice" ? { peerSegmentId: peer, peerCoreNumber: Number(peerCore) } : { splitterInput: splitter.trim() }) } }), onSuccess: async () => { setCore(""); setPeerCore(""); setSplitter(""); setNote(""); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api(`/assets/${segmentId}/core-mappings/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const valid = Boolean(node && source && /^\d+$/.test(core) && Number(core) > 0 && (kind === "splitter" ? splitter.trim() : peer && /^\d+$/.test(peerCore) && Number(peerCore) > 0));
  return <section className="border rounded p-3 mt-3" aria-label="Sambungan core">
    <strong>Sambungan core</strong>
    <p className="small text-secondary mt-1">Catat sambungan dari survei atau dokumen. Sambungan fisik tidak otomatis berarti core terpakai; verifikasi status core secara terpisah.</p>
    {mappings.isPending && <small>Memuat sambungan…</small>}
    {mappings.isError && <small className="text-danger" role="alert">Sambungan tidak dapat dimuat.</small>}
    {mappings.data?.length === 0 && <small className="d-block">Belum ada sambungan core tercatat.</small>}
    {mappings.data && <small className="d-block mb-2">{new Set(mappings.data.map((item) => item.cableAId === segmentId ? item.coreA : item.coreB)).size} core kabel ini memiliki catatan sambungan. Jumlah ini bukan jumlah core terpakai.</small>}
    {mappings.data?.map((item) => <div key={item.id} className="border rounded p-2 mb-2 small">
      <div><b>{item.nodeName}</b> · {item.cableAName} core {item.coreA} → {item.splitterInput ? `masukan ${item.splitterInput}` : `${item.cableBName} core ${item.coreB}`}</div>
      <div>Sumber: {item.source}{item.note ? ` · ${item.note}` : ""}</div>
      {isAdmin && <button className="btn btn-sm btn-outline-danger mt-1" type="button" disabled={remove.isPending} onClick={() => { if (window.confirm("Hapus catatan sambungan ini? Status core tidak berubah.")) remove.mutate(item.id); }}>Hapus catatan</button>}
    </div>)}
    {isAdmin && <details className="mt-2"><summary>Tambah sambungan core</summary>
      <div className="row g-2 mt-1">
        <div className="col-md-6"><label className="form-label" htmlFor="mapping-kind">Jenis sambungan</label><select id="mapping-kind" className="form-select form-select-sm" value={kind} onChange={(e) => { setKind(e.target.value as "splitter" | "splice"); setNode(""); }}><option value="splitter">Core kabel → masukan splitter ODP</option><option value="splice">Core kabel → core kabel lain</option></select></div>
        <div className="col-md-6"><label className="form-label" htmlFor="mapping-core">Nomor core kabel ini</label><input id="mapping-core" className="form-control form-control-sm" type="number" min="1" step="1" value={core} onChange={(e) => setCore(e.target.value)} /></div>
        <div className="col-md-6"><label className="form-label" htmlFor="mapping-node-search">Cari titik terminasi</label><input id="mapping-node-search" className="form-control form-control-sm" value={nodeSearch} onChange={(e) => { setNodeSearch(e.target.value); setNode(""); }} placeholder="Ketik minimal 2 karakter" /><select aria-label="Pilih titik terminasi" className="form-select form-select-sm mt-1" value={node} onChange={(e) => setNode(e.target.value)}><option value="">Pilih titik</option>{nodes.data?.items.map((item) => <option key={item.id} value={item.id}>{item.name} {item.area ? `· ${item.area}` : ""} · ID {item.id.slice(-8)}</option>)}</select>{nodes.isError && <small className="text-danger">Pencarian titik gagal.</small>}</div>
        {kind === "splitter" ? <div className="col-md-6"><label className="form-label" htmlFor="mapping-splitter">Identitas masukan splitter</label><input id="mapping-splitter" className="form-control form-control-sm" maxLength={80} value={splitter} onChange={(e) => setSplitter(e.target.value)} placeholder="Contoh: SPL-1:8 input 1" /></div> : <><div className="col-md-6"><label className="form-label" htmlFor="mapping-peer-search">Cari kabel lain</label><input id="mapping-peer-search" className="form-control form-control-sm" value={peerSearch} onChange={(e) => { setPeerSearch(e.target.value); setPeer(""); }} placeholder="Ketik minimal 2 karakter" /><select aria-label="Pilih kabel lain" className="form-select form-select-sm mt-1" value={peer} onChange={(e) => setPeer(e.target.value)}><option value="">Pilih kabel</option>{peers.data?.items.filter((item) => item.id !== segmentId).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.totalCores} core · ID {item.id.slice(-8)}</option>)}</select>{peers.isError && <small className="text-danger">Pencarian kabel gagal.</small>}</div><div className="col-md-6"><label className="form-label" htmlFor="mapping-peer-core">Nomor core kabel lain</label><input id="mapping-peer-core" className="form-control form-control-sm" type="number" min="1" step="1" value={peerCore} onChange={(e) => setPeerCore(e.target.value)} /></div></>}
        <div className="col-md-6"><label className="form-label" htmlFor="mapping-source">Sumber data</label><select id="mapping-source" className="form-select form-select-sm" value={source} onChange={(e) => setSource(e.target.value)}><option value="">Pilih sumber</option><option>Survei lapangan</option><option>Data operasional</option><option>Dokumen inventaris</option></select></div>
        <div className="col-md-6"><label className="form-label" htmlFor="mapping-note">Catatan (opsional)</label><input id="mapping-note" className="form-control form-control-sm" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      <button type="button" className="btn btn-primary btn-sm mt-2" disabled={!valid || create.isPending} onClick={() => create.mutate()}>Simpan sambungan</button>
      {create.isSuccess && <small className="text-success d-block" role="status">Sambungan tersimpan. Status penggunaan core tidak berubah.</small>}
      {create.error && <small className="text-danger d-block" role="alert">{create.error.message}</small>}
    </details>}
    {remove.error && <small className="text-danger d-block" role="alert">{remove.error.message}</small>}
  </section>;
}
