# ATLAS Phase 2

Monorepo ATLAS dengan React/TanStack, NestJS, Better Auth, dan PostgreSQL/PostGIS.

## Development lokal

```sh
cp .env.example .env
docker compose up -d postgis
npm --prefix apps/backend install
npm --prefix apps/frontend install
```

Di terminal pertama jalankan backend:

```sh
npm run dev:backend
```

Di terminal kedua:

```sh
npm run dev:frontend
```

Buka <http://localhost:5176>. Backend menjalankan migrasi saat startup. Isi kredensial bootstrap admin di `.env`, lalu dari root jalankan `npm run bootstrap-admin:local`. ADMIN dapat membuat akun lewat `POST /api/users`; pendaftaran publik dinonaktifkan. PostGIS dipetakan ke port host `5434` agar tidak bentrok dengan PostgreSQL lokal; API dan frontend memakai port `3000` dan `5176`.

## Menjalankan stack Docker

Compose hanya menyalakan PostGIS secara default. Untuk menjalankan stack Compose lengkap (frontend, backend, PostGIS):

```sh
docker compose --profile deploy up --build -d
docker compose --profile deploy exec backend npm run bootstrap-admin
```

Ganti password database dan secret Better Auth sebelum penggunaan di luar komputer lokal.
Untuk profile `deploy`, isi `BETTER_AUTH_SECRET` di `.env` dengan secret acak minimal 32 karakter, misalnya hasil `openssl rand -base64 48`.

## Provider geospasial

`GEOCODER_URL` menerima base URL server Nominatim yang dikelola sendiri. `ROUTING_URL` menerima base URL server GraphHopper. Keduanya kosong secara default; API mengembalikan status provider belum tersedia tanpa menghasilkan data contoh. Siapkan dan impor data wilayah terlebih dahulu sebelum mengaktifkannya. Ekstrak OSM tidak dijalankan oleh Compose.

MapLibre menggunakan basemap OpenFreeMap. Impor KML/KMZ disimpan di PostGIS dengan geometri sumber disertakan. Analisis massal XLSX diproses backend dan hasilnya dapat diunduh sebagai XLSX.
ADMIN juga dapat mengimpor data jaringan melalui template Excel di halaman peta; kolom geometri menerima GeoJSON dengan koordinat longitude, latitude. Detail aset mendukung tinggi tiang 7 m dan 9 m, dan dashboard dapat mengekspor laporan utilisasi jaringan ke XLSX.

## Struktur

- `apps/frontend` — `app`, `components`, `features`, dan `lib` untuk React/TanStack
- `apps/backend` — `auth`, `atlas`, `network`, `geospatial`, `database`, dan `health` untuk NestJS
- `docker-compose.yml` — PostGIS lokal; profile `deploy` menambahkan frontend dan backend

Endpoint utama: `GET /api/health`, `GET /api/me`, `GET /api/dashboard`, `GET /api/assets`, `POST /api/assets/import`, `GET/POST /api/bookings`, `POST /api/bookings/:id/release`, `POST /api/analysis/address`, `POST /api/analysis/bulk`, dan `POST /api/routes/preview`. Semua kecuali health dan auth memerlukan sesi.
