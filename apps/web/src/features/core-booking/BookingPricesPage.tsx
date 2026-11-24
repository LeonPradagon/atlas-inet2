import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import ExcelJS from "exceljs";
import { PageHeader } from "../../components/PageHeader";
import { notify } from "../../components/Snackbar";
import { api, type Booking } from "../../lib/api";

type BookingPrice = { name: string; unit: string; price: number };
const defaultPrices: BookingPrice[] = [
  { name: "Kabel fiber optik", unit: "meter", price: 0 },
  { name: "Core kabel", unit: "core", price: 0 },
  { name: "Tiang", unit: "unit", price: 0 },
];

function formatRupiah(cents: number) {
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

export function BookingPricesPage() {
  const client = useQueryClient();
  const [prices, setPrices] = useState(defaultPrices);
  const [procurementQuantities, setProcurementQuantities] = useState<Record<number, string>>({});
  const [procurementSpecifications, setProcurementSpecifications] = useState<Record<number, string>>({});
  const [procurementReference, setProcurementReference] = useState("");
  const [procurementBookingId, setProcurementBookingId] = useState("");
  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ role: string }>("/me"),
  });
  const pricesQuery = useQuery({
    queryKey: ["booking-prices"],
    queryFn: () => api<{ items: BookingPrice[] }>("/settings/booking-prices"),
  });
  const bookingsQuery = useQuery({
    queryKey: ["bookings"],
    queryFn: () => api<Booking[]>("/bookings"),
  });
  const save = useMutation({
    mutationFn: (items: BookingPrice[]) => api<{ items: BookingPrice[] }>("/settings/booking-prices", { method: "PATCH", data: { items } }),
    onSuccess: async ({ items }) => {
      setPrices(items);
      setProcurementQuantities({});
      setProcurementSpecifications({});
      await client.invalidateQueries({ queryKey: ["booking-prices"] });
      notify("Daftar harga berhasil disimpan.");
    },
    onError: (error) => notify(error instanceof Error ? error.message : "Harga tidak dapat disimpan.", "error"),
  });
  useEffect(() => {
    if (pricesQuery.data) setPrices(pricesQuery.data.items);
  }, [pricesQuery.data]);
  const savedPrices = pricesQuery.data?.items ?? defaultPrices;
  const hasChanges = JSON.stringify(prices) !== JSON.stringify(savedPrices);
  const completedPrices = prices.filter((item) => item.price > 0).length;
  const canSave = prices.length > 0 && prices.length <= 50 && prices.every((item) =>
    item.name.trim() && item.unit.trim() && Number.isFinite(item.price) && item.price >= 0 && item.price <= Number.MAX_SAFE_INTEGER && Math.round(item.price * 100) / 100 === item.price
  );
  const selectedBooking = bookingsQuery.data?.find((booking) => booking.id === procurementBookingId);
  const procurementLines = savedPrices.map((item, index) => {
    const linkedCoreQuantity = selectedBooking && item.unit.trim().toLowerCase() === "core" ? selectedBooking.cores : undefined;
    const quantity = linkedCoreQuantity ?? Number(procurementQuantities[index] ?? 0);
    return { item, index, quantity, linkedCoreQuantity, specification: procurementSpecifications[index] ?? "", subtotalCents: Math.round(quantity * item.price * 100) };
  });
  const totalProcurementCents = procurementLines.reduce((sum, line) => sum + line.subtotalCents, 0);
  const exportProcurement = async () => {
    const lines = procurementLines.filter((line) => line.quantity > 0);
    if (!lines.length) return;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "ATLAS";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet("Estimasi Procurement");
    sheet.addRow(["ESTIMASI PROCUREMENT"]);
    sheet.addRow(["Referensi", procurementReference || "—"]);
    sheet.addRow(["Booking", selectedBooking ? `${selectedBooking.id} · ${selectedBooking.customer}` : "Tidak ditautkan"]);
    sheet.addRow(["Jumlah core booking", selectedBooking?.cores ?? "—"]);
    sheet.addRow([]);
    sheet.addRow(["Item", "Spesifikasi / Beamwidth", "Kuantitas", "Satuan", "Harga satuan (Rp)", "Status harga", "Subtotal (Rp)"]);
    const firstLineRow = sheet.rowCount + 1;
    for (const line of lines) {
      const rowNumber = sheet.rowCount + 1;
      const row = sheet.addRow([line.item.name, line.specification, line.quantity, line.item.unit, line.item.price, line.item.price > 0 ? "Tersedia" : "Belum ditetapkan", { formula: `C${rowNumber}*E${rowNumber}`, result: line.subtotalCents / 100 }]);
      row.getCell(5).numFmt = "#,##0.00";
      row.getCell(7).numFmt = "#,##0.00";
    }
    const totalRow = sheet.addRow(["TOTAL", "", "", "", "", "", lines.length ? { formula: `SUM(G${firstLineRow}:G${sheet.rowCount})`, result: totalProcurementCents / 100 } : 0]);
    totalRow.font = { bold: true };
    totalRow.getCell(7).numFmt = '"Rp" #,##0.00';
    sheet.getRow(1).font = { bold: true, size: 14 };
    sheet.getRow(6).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3454D1" } };
    sheet.views = [{ state: "frozen", ySplit: 6 }];
    sheet.columns = [{ width: 30 }, { width: 34 }, { width: 14 }, { width: 14 }, { width: 22 }, { width: 20 }, { width: 22 }];
    sheet.autoFilter = { from: "A6", to: `G${sheet.rowCount - 1}` };
    try {
      const buffer = await workbook.xlsx.writeBuffer();
      const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `ATLAS-estimasi-procurement${procurementReference ? `-${procurementReference.trim().replace(/[^a-z0-9_-]+/giu, "-")}` : ""}.xlsx`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("Estimasi procurement berhasil diunduh.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "File estimasi procurement gagal dibuat.", "error");
    }
  };

  return (
    <div className="pricing-page">
      <PageHeader subtitle="Kelola referensi harga satuan untuk kabel, kapasitas core, dan material jaringan." title="Manajemen Harga" />
      <div className="row g-3 mb-4 pricing-summary">
        <div className="col-md-4"><div className="metric-card"><span className="metric-icon blue"><i className="bi bi-list-check" /></span><div><span className="metric-label">Item harga</span><strong>{prices.length}</strong><small>Jenis material terdaftar</small></div></div></div>
        <div className="col-md-4"><div className="metric-card"><span className="metric-icon green"><i className="bi bi-currency-exchange" /></span><div><span className="metric-label">Harga terisi</span><strong>{completedPrices}<span className="pricing-count-total"> / {prices.length}</span></strong><small>Item memiliki nilai di atas Rp0</small></div></div></div>
        <div className="col-md-4"><div className="metric-card"><span className={`metric-icon ${hasChanges ? "orange" : "purple"}`}><i className={`bi ${hasChanges ? "bi-pencil-square" : "bi-check2-circle"}`} /></span><div><span className="metric-label">Status perubahan</span><strong className="pricing-state-value">{hasChanges ? "Belum disimpan" : "Tersimpan"}</strong><small>{user?.role === "ADMIN" ? "Hanya ADMIN dapat mengubah harga" : "Mode lihat saja"}</small></div></div></div>
      </div>
      <section className="card panel-card pricing-card">
        <div className="card-header pricing-card-header">
          <div>
            <span className="pricing-eyebrow">REFERENSI PENGADAAN</span>
            <h3>Daftar harga satuan</h3>
            <p>Atur nama item, satuan, dan harga dalam rupiah. Tarif bersatuan core otomatis digunakan untuk menghitung estimasi booking.</p>
          </div>
          {user?.role === "ADMIN" && <button className="btn btn-outline-primary atlas-secondary-action pricing-add-top" disabled={pricesQuery.isPending || pricesQuery.isError || prices.length >= 50} onClick={() => setPrices((current) => [...current, { name: "", unit: "unit", price: 0 }])} type="button"><i aria-hidden="true" className="bi bi-plus-lg atlas-secondary-action-icon" />Tambah item</button>}
        </div>
        <div className="card-body pricing-card-body">
          {pricesQuery.isPending ? <div className="pricing-loading" role="status"><span className="spinner-border spinner-border-sm" /> Memuat daftar harga...</div> : pricesQuery.isError ? <div className="alert alert-danger mb-0">Daftar harga gagal dimuat. Muat ulang halaman untuk mencoba lagi.</div> : <>
            <div className="pricing-table-wrap">
              <div className="table-responsive">
                <table className="table align-middle pricing-table">
                  <thead><tr><th className="pricing-number">#</th><th>Nama item</th><th>Satuan</th><th>Harga satuan</th>{user?.role === "ADMIN" && <th aria-label="Aksi" />}</tr></thead>
                  <tbody>
                    {prices.map((item, index) => (
                      <tr key={`${index}-${item.name}`}>
                        <td className="pricing-number">{String(index + 1).padStart(2, "0")}</td>
                        <td>{user?.role === "ADMIN" ? <input aria-label={`Nama item harga ${index + 1}`} className="form-control pricing-item-input" maxLength={80} onChange={(event) => setPrices((current) => current.map((row, i) => i === index ? { ...row, name: event.target.value } : row))} placeholder="Contoh: Kabel fiber optik" value={item.name} /> : <span className="pricing-item-name">{item.name}</span>}</td>
                        <td>{user?.role === "ADMIN" ? <input aria-label={`Satuan item harga ${index + 1}`} className="form-control pricing-unit-input" maxLength={24} onChange={(event) => setPrices((current) => current.map((row, i) => i === index ? { ...row, unit: event.target.value } : row))} placeholder="meter" value={item.unit} /> : <span className="pricing-unit-badge">/{item.unit}</span>}</td>
                        <td>{user?.role === "ADMIN" ? <div className="input-group pricing-price-input"><span className="input-group-text">Rp</span><input aria-label={`Harga item ${index + 1}`} className="form-control" min="0" onChange={(event) => setPrices((current) => current.map((row, i) => i === index ? { ...row, price: Number(event.target.value) } : row))} type="number" step="0.01" value={item.price} /></div> : <span className="pricing-price-value">Rp{item.price.toLocaleString("id-ID", { maximumFractionDigits: 2 })}</span>}</td>
                        {user?.role === "ADMIN" && <td className="pricing-action-cell"><button aria-label={`Hapus ${item.name || "item harga"}`} className="btn btn-sm btn-outline-danger pricing-remove" onClick={() => setPrices((current) => current.filter((_, i) => i !== index))} type="button"><i aria-hidden="true" className="bi bi-trash3" /><span className="visually-hidden">Hapus</span></button></td>}
                      </tr>
                    ))}
                    {!prices.length && <tr><td className="pricing-empty" colSpan={user?.role === "ADMIN" ? 5 : 4}><i className="bi bi-inboxes" /><strong>Belum ada item harga</strong><span>Tambahkan item untuk mulai mengelola referensi harga.</span></td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="pricing-card-footer">
              <div className="pricing-footer-note"><i className="bi bi-info-circle" /><span>Harga Rp0 menandakan nilai belum ditetapkan. Satuan dapat disesuaikan dengan kebutuhan, misalnya meter, core, atau unit.</span></div>
              {user?.role === "ADMIN" ? <div className="pricing-actions">
                <button className="btn btn-outline-primary atlas-secondary-action" disabled={pricesQuery.isPending || pricesQuery.isError || save.isPending || !hasChanges || !canSave} onClick={() => save.mutate(prices)} type="button"><i aria-hidden="true" className="bi bi-check2-circle atlas-secondary-action-icon" />{save.isPending ? "Menyimpan..." : "Simpan perubahan"}</button>
              </div> : <span className="pricing-readonly"><i className="bi bi-lock-fill" /> Mode lihat saja · perubahan hanya oleh ADMIN</span>}
            </div>
          </>}
        </div>
      </section>
      <section className="card panel-card procurement-card">
        <div className="card-header procurement-card-header">
          <div><span className="pricing-eyebrow">KALKULASI & KELUARAN</span><h3>Estimasi procurement</h3><p>Masukkan kuantitas material; biaya dihitung dari tarif tersimpan.</p></div>
          <button className="btn btn-outline-primary atlas-secondary-action" disabled={!procurementLines.some((line) => line.quantity > 0) || pricesQuery.isPending || pricesQuery.isError || bookingsQuery.isPending} onClick={() => void exportProcurement()} type="button"><i aria-hidden="true" className="bi bi-file-earmark-spreadsheet atlas-secondary-action-icon" />Unduh XLSX</button>
        </div>
        <div className="card-body procurement-card-body">
          {hasChanges && <div className="alert alert-warning py-2">Simpan perubahan harga terlebih dahulu. Kalkulasi memakai tarif yang sudah tersimpan.</div>}
          <div className="row g-3 mb-4">
            <div className="col-md-6"><label className="form-label" htmlFor="procurement-reference">Referensi procurement</label><input className="form-control" id="procurement-reference" maxLength={100} onChange={(event) => setProcurementReference(event.target.value)} placeholder="Nama proyek atau nomor dokumen" value={procurementReference} /></div>
            <div className="col-md-6"><label className="form-label" htmlFor="procurement-booking">Tautkan booking core (opsional)</label><select className="form-select" id="procurement-booking" onChange={(event) => setProcurementBookingId(event.target.value)} value={procurementBookingId}><option value="">Isi kuantitas core manual</option>{bookingsQuery.data?.filter((booking) => !["Rejected", "Released", "Expired"].includes(booking.status)).map((booking) => <option key={booking.id} value={booking.id}>{booking.id} · {booking.customer} · {booking.cores} core · {booking.status}</option>)}</select><div className="form-text">Jika dipilih, kuantitas tarif bersatuan core mengikuti jumlah core booking.</div></div>
          </div>
          {pricesQuery.isError || bookingsQuery.isError ? <div className="alert alert-danger">Tarif atau daftar booking gagal dimuat, kalkulasi belum tersedia.</div> : <div className="table-responsive procurement-table-wrap"><table className="table align-middle procurement-table"><thead><tr><th>Item</th><th>Kuantitas</th><th>Satuan</th><th>Harga satuan</th><th>Spesifikasi / beamwidth</th><th>Status harga</th><th>Subtotal</th></tr></thead><tbody>{procurementLines.map((line) => <tr key={`${line.index}-${line.item.name}`}><td><strong>{line.item.name}</strong></td><td>{line.linkedCoreQuantity !== undefined ? <span className="procurement-linked-quantity">{line.quantity.toLocaleString("id-ID")} <i className="bi bi-link-45deg" title="Dari booking core" /></span> : <input aria-label={`Kuantitas ${line.item.name}`} className="form-control procurement-quantity" min="0" onChange={(event) => setProcurementQuantities((current) => ({ ...current, [line.index]: event.target.value }))} step="0.01" type="number" value={procurementQuantities[line.index] ?? ""} />}</td><td><span className="pricing-unit-badge">{line.item.unit}</span></td><td className="text-nowrap">{formatRupiah(Math.round(line.item.price * 100))}</td><td><input aria-label={`Spesifikasi ${line.item.name}`} className="form-control procurement-specification" maxLength={120} onChange={(event) => setProcurementSpecifications((current) => ({ ...current, [line.index]: event.target.value }))} placeholder={/beamwidth/iu.test(line.item.name) ? "Contoh: 18 GHz · beamwidth 3°" : "Catatan opsional"} value={line.specification} /></td><td>{line.item.price > 0 ? <span className="procurement-price-status is-set">Tersedia</span> : <span className="procurement-price-status">Belum diatur</span>}</td><td className="text-nowrap fw-semibold">{formatRupiah(line.subtotalCents)}</td></tr>)}{!procurementLines.length && <tr><td className="text-muted py-4 text-center" colSpan={7}>Tambahkan tarif di atas untuk mulai membuat estimasi.</td></tr>}</tbody><tfoot><tr><th colSpan={6} className="text-end">Total estimasi</th><th className="text-nowrap">{formatRupiah(totalProcurementCents)}</th></tr></tfoot></table></div>}
          {procurementLines.some((line) => line.quantity > 0 && line.item.price <= 0) && <div className="alert alert-warning mt-3 mb-0 py-2">Ada item berkuantitas yang harganya belum diatur. Total sementara belum mencakup biaya item tersebut.</div>}
          <div className="procurement-note"><i className="bi bi-info-circle" /><span>Kuantitas core dapat diambil dari booking; panjang kabel dan jumlah material lain diisi sesuai rencana. Spesifikasi mencakup beamwidth atau catatan teknis lain.</span></div>
        </div>
      </section>
    </div>
  );
}
