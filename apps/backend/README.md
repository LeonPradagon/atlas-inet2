# ATLAS API

NestJS API; migrasi PostGIS dijalankan saat startup. `DATABASE_URL` wajib tersedia.

## Struktur

- `src/auth` — Better Auth, sesi, role, dan bootstrap administrator
- `src/atlas` — endpoint dan aturan aset, core, booking, analisis, serta notifikasi
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

Production Compose menghubungkan backend ke Photon dan GraphHopper melalui jaringan internal. Frontend mempublikasikan endpoint provider melalui HTTPS di `/photon` dan `/graphhopper` dengan pembatasan laju. Untuk development lokal, `.env` memakai URL publik tersebut pada `GEOCODER_URL` dan `ROUTING_URL`. Untuk membuat administrator pertama pada development lokal, isi `BOOTSTRAP_ADMIN_EMAIL` dan `BOOTSTRAP_ADMIN_PASSWORD` (minimal 12 karakter) di `.env` root, lalu dari folder `apps/backend` jalankan `npm run bootstrap-admin:local`. Script ini memakai `.env` root dan tidak membuat akun jika password belum disetel.

## Utilisasi, FIFO, dan aset terkait

Semua segmen, termasuk hasil impor KML/KMZ, dapat dilengkapi kapasitas dan detailnya oleh ADMIN. Kapasitas nol berarti belum diisi; sistem tidak menebak jumlah core dari nama kabel. Waiting list memakai FIFO ketat per segmen: permintaan pertama yang belum dapat dipenuhi menghalangi permintaan berikutnya. Booking baru, release, kedaluwarsa, core yang kembali Available, dan perubahan kapasitas memakai alokasi transaksi yang sama. Release mengembalikan `allocated` (ID pertama atau null) dan `allocatedBookingIds` (seluruh ID yang dialokasikan).

- `GET /api/assets/:id/relations`: membaca aset terkait, tersedia bagi pengguna yang sudah masuk.
- `PUT /api/assets/:id/relations`: ADMIN mengganti seluruh relasi segmen dengan payload `{"relations":[{"assetId":"id-aset-titik","kind":"POLE"}]}`. Jenis yang didukung: `POLE`, `ODC`, `ODP`. Daftar kosong menghapus relasi tanpa menghapus aset.
- `PATCH /api/assets/:id` dengan `{"poleHeight":"9 m"}` mengubah tinggi aset tiang; `7 m` dan `null` (belum diketahui) juga didukung. Tinggi tersebut terlihat pada seluruh segmen yang memakai aset yang sama.

Relasi disimpan terpisah dari geometri/atribut impor. Teks tiang/ODC/ODP lama tetap menjadi informasi sumber; pemilihan aset dilakukan manual tanpa klasifikasi otomatis. Laporan utilisasi menyertakan `relatedAssets` dan frontend mengekspor nama aset serta tinggi tiang.

### Pengujian transaksi

Dari `apps/backend`, jalankan `npm run test:integration:local`. Script membuat database PostGIS baru dengan nama acak berawalan `atlas_test_`, menjalankan skenario FIFO, konkurensi, rollback, relasi, laporan, dan akses HTTP ADMIN/PRESALES dengan sesi pengujian, lalu menutup koneksi dan menghapus database tersebut. Akun dan data aplikasi tidak dipakai sebagai data pengujian. Pengguna database perlu izin membuat database; pengujian ini tidak memvalidasi login Better Auth atau provider geocoding/routing.
