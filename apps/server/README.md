# ATLAS API

NestJS API; migrasi PostGIS dijalankan saat startup. `DATABASE_URL` wajib tersedia.

## Struktur

- `src/auth` — Better Auth, sesi, role, dan bootstrap administrator
- `src/atlas` — endpoint dan aturan aset, core, analisis, serta notifikasi
- `src/booking` — endpoint dan aturan booking core, waiting list FIFO, dan kedaluwarsa booking
- `src/network` — parsing dan penyimpanan impor jaringan
- `src/geospatial` — adapter geocoding dan routing
- `src/database` — koneksi PostgreSQL dan migrasi PostGIS
- `src/health` — pemeriksaan kesiapan API
- `src/app.module.ts`, `src/main.ts` — komposisi dan startup NestJS

- `GET /api/health` — pemeriksaan liveness
- `/api/auth/*`, `GET /api/me`, `POST /api/users` — Better Auth dan provision akun ADMIN
- `/api/assets`, `POST /api/assets/import`, `POST /api/assets/import/xlsx` — aset jaringan dan impor KML/KMZ/XLSX
- `GET /api/reports/network-usage` — ekspor data utilisasi jaringan
- `/api/bookings`, `/api/settings/booking-duration`, `/api/notifications` — utilisasi, booking, antrean, dan notifikasi
- `/api/analysis/address`, `/api/analysis/bulk` — analisis alamat tunggal atau XLSX
- `POST /api/routes/preview` — pratinjau rute GraphHopper

Production Compose menghubungkan backend ke Photon dan GraphHopper melalui jaringan internal. Frontend mempublikasikan endpoint provider melalui HTTPS di `/photon` dan `/graphhopper` dengan pembatasan laju. Untuk development lokal, `.env` memakai URL publik tersebut pada `GEOCODER_URL` dan `ROUTING_URL`. Untuk membuat administrator pertama pada development lokal, isi `BOOTSTRAP_ADMIN_EMAIL` dan `BOOTSTRAP_ADMIN_PASSWORD` (minimal 12 karakter) di `.env` root, lalu dari folder `apps/server` jalankan `npm run bootstrap-admin:local`. Script ini memakai `.env` root dan tidak membuat akun jika password belum disetel.

## Utilisasi, FIFO, dan aset terkait

Semua segmen, termasuk hasil impor KML/KMZ, dapat dilengkapi kapasitas dan detailnya oleh ADMIN. Kapasitas nol berarti belum diisi; sistem tidak menebak jumlah core dari nama kabel. Waiting list memakai FIFO ketat per segmen: permintaan pertama yang belum dapat dipenuhi menghalangi permintaan berikutnya. Booking baru, release, kedaluwarsa, core yang kembali Available, dan perubahan kapasitas memakai alokasi transaksi yang sama. Release mengembalikan `allocated` (ID pertama atau null) dan `allocatedBookingIds` (seluruh ID yang dialokasikan).

- `GET /api/assets/:id/relations`: membaca aset terkait, tersedia bagi pengguna yang sudah masuk.
- `PUT /api/assets/:id/relations`: ADMIN mengganti seluruh relasi segmen dengan payload `{"relations":[{"assetId":"id-aset-titik","kind":"POLE"}]}`. Jenis yang didukung: `POLE`, `ODC`, `ODP`. Daftar kosong menghapus relasi tanpa menghapus aset.
- `PATCH /api/assets/:id` dengan `{"poleHeight":"9 m"}` mengubah tinggi aset tiang; `7 m` dan `null` (belum diketahui) juga didukung. Tinggi tersebut terlihat pada seluruh segmen yang memakai aset yang sama.

Relasi disimpan terpisah dari geometri/atribut impor. Teks tiang/ODC/ODP lama tetap menjadi informasi sumber; pemilihan aset dilakukan manual tanpa klasifikasi otomatis. Laporan utilisasi menyertakan `relatedAssets` dan frontend mengekspor nama aset serta tinggi tiang.

### Unit test

Dari `apps/server`, jalankan `npm test`. Unit test geocoding dan impor jaringan tidak memerlukan database atau provider eksternal.

### Pengujian transaksi

Dari `apps/server`, jalankan `npm run test:integration:local`. Script membuat database PostGIS baru dengan nama acak berawalan `atlas_test_`, menjalankan skenario FIFO, konkurensi, rollback, relasi, laporan, dan akses HTTP ADMIN/PRESALES dengan sesi pengujian, lalu menutup koneksi dan menghapus database tersebut. Akun dan data aplikasi tidak dipakai sebagai data pengujian. Pengguna database perlu izin membuat database; pengujian ini tidak memvalidasi login Better Auth atau provider geocoding/routing.
# Two-point network analysis

Authenticated `POST /api/analysis/connection` (controller path `analysis/connection`):

```json
{
  "start": { "longitude": 106.299322745, "latitude": -6.174154567, "label": "A" },
  "end": { "longitude": 106.293075471, "latitude": -6.175394679, "label": "B" },
  "allowExpand2km": false,
  "coreRequirement": { "services": 1, "reserve": 0 }
}
```

Coordinates are mandatory; existing frontend geocoding endpoints can resolve addresses first. Labels, expansion, and core requirement are optional. Invalid, non-finite, out-of-range, and equal coordinates return HTTP 400. Authentication runs before analysis.

The standalone response includes `mode: "connection"`, `inputMode: "connection"`, `status`, `message`, `historyId`, `start`, `end`, `address`, `latitude`, `longitude`, `network`, `terminationPlan`, `terminalToleranceMeters: 20`, `searchRadiusMeters`, `selectionStrategy`, and `routes`.

Each route has:

```ts
{
  id: 'A' | 'B';
  distanceMeters: number;
  newCableMeters: number;
  existingNetworkMeters: number;
  unverifiedGapMeters: number;
  source: { id: string; name: string; coordinate: [number, number] };
  destination: { id: string; name: string; coordinate: [number, number] };
  networkConfirmation: 'recorded' | 'survey_required';
  capacityConfirmation: 'survey_required';
  legs: {
    kind: 'new' | 'existing'; name: string; segmentId?: string;
    distanceMeters: number;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    confirmation: 'recorded' | 'survey_required';
  }[];
  terminalLinks: { name: string; terminalId?: string; gapMeters: number;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    confirmation: string; basis: 'termination_attachment_gap' }[];
  roadSnapGaps: { name: string; gapMeters: number;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
    confirmation: 'survey_required'; basis: 'road_snap_gap' }[];
  terminationPlan: object;
}
```

`distanceMeters = newCableMeters + existingNetworkMeters + unverifiedGapMeters`. Gap geometry is evidence for survey, not an existing cable or a planned new asset. New cable legs use road routing; snapped-road gaps are disclosed separately. No straight-line replacement is returned when access routing fails.

Status is `PLANNING_CONNECTION` for geometric candidates, `RECORDED_CONNECTION` for recorded network continuity, `NO_CONFIRMED_NETWORK_CONNECTION` with no routes when no network path exists, or `ACCESS_ROUTING_UNAVAILABLE` with no routes when access routing fails. Capacity and new cable feasibility always require survey. Recorded allocation status alone never establishes connectivity. Shared termination proximity may form an unconfirmed interchange within 20 m; crossings elsewhere do not. Known different companies cannot be joined by proximity. Unknown ownership is explicitly unverified. Disconnected MultiLineString parts are excluded rather than bridged.

The graph searches actual cable polylines, retains bends and midspan attachments, and checks continuous mapped core identities across splices. It considers up to twelve nearest-access terminal pairs, continuing after inaccessible access routes until two distinct routes are found. This bounded candidate selection is **not a globally optimal A-to-B route**. Alternative routes may use different access terminals. Consecutive pieces of one segment are merged; duplicate geometries are removed.

History is saved as `ADDRESS`, input `inputMode: "connection"`. To submit a survey, use authenticated `POST /api/surveys`:

```json
{ "historyId": "<returned UUID>", "routeId": "A" }
```

`routeId` must select a persisted A/B route. Omit `plan` and `proposal`; connection surveys reject client geometry. `rowNumber` can be omitted or zero. The server selects the stored route and its plan, retaining both endpoints and selected route evidence. The plan contains only two disconnected new access cables and zero new points; reused segments are never included as new plan cables. The original single-address linear plan validator is unchanged. Duplicate checks distinguish both endpoints; a history row can be submitted only once.

Verification: `npm run build` and `node --import tsx --test test/connection-routing.test.cjs`.

# Dokumentasi API

Saat server berjalan, buka Swagger UI di <http://localhost:3000/api/docs>.
Dokumen OpenAPI tersedia di <http://localhost:3000/api/docs-json>. Login melalui
endpoint autentikasi di Swagger atau aplikasi untuk memakai sesi cookie yang sama.
Daftar endpoint NestJS dibuat otomatis. Request JSON, unggahan file, serta
parameter path, query, dan respons berhasil didokumentasikan di Swagger. Data
impor, respons provider, dan hasil analisis yang dinamis dapat memiliki field
tambahan. DTO ini mendokumentasikan input dan tidak menambahkan validasi runtime
baru.

Untuk autentikasi integrasi server-ke-server, endpoint analisis juga menerima
header `X-API-Key` dari environment `ANALYSIS_API_KEY`. Lihat
[`docs/api-analisis.md`](../../docs/api-analisis.md) untuk format request,
template XLSX, status job, dan contoh polling.
