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

Set `GEOCODER_URL` dan `ROUTING_URL` ke server yang dikelola sendiri. Jika kosong, layanan terkait mengembalikan status unavailable. Untuk membuat administrator pertama pada development lokal, isi `BOOTSTRAP_ADMIN_EMAIL` dan `BOOTSTRAP_ADMIN_PASSWORD` (minimal 12 karakter) di `.env` root, lalu dari folder `apps/backend` jalankan `npm run bootstrap-admin:local`. Script ini memakai `.env` root dan tidak membuat akun jika password belum disetel.
