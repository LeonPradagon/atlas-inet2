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

### Image produksi

Gunakan `docker-compose.production.yaml` untuk menjalankan image statis Nginx, backend Node produksi, dan PostGIS dengan volume database terpisah. Isi `ATLAS_DATABASE_NAME`, `ATLAS_DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, dan `TRUSTED_ORIGINS` di `.env`. Frontend melayani HTTP port 80 hanya untuk ACME challenge dan mengalihkan trafik lain ke HTTPS port 443; sertifikat dipasang dari `LETSENCRYPT_DIR` (default `/etc/letsencrypt`).

Untuk deployment langsung menggunakan IP publik, pasang Certbot 5.4 atau lebih baru, siapkan webroot challenge di `./var/certbot`, lalu terbitkan sertifikat IP Let’s Encrypt dengan profil `shortlived` dan metode `webroot` sebelum menjalankan Compose. Sertifikat IP berlaku sekitar enam hari, jadi renewal otomatis harus aktif dan memakai deploy hook untuk me-reload Nginx setelah sertifikat diperbarui. Tetapkan `BETTER_AUTH_URL` dan `TRUSTED_ORIGINS` ke origin HTTPS yang sama.

Jalankan:

```sh
docker compose -f docker-compose.production.yaml up --build -d
docker compose -f docker-compose.production.yaml --profile bootstrap run --rm bootstrap-admin
```

Setelah akun ADMIN pertama dibuat, hapus `BOOTSTRAP_ADMIN_EMAIL` dan `BOOTSTRAP_ADMIN_PASSWORD` dari `.env`. Port HTTP frontend dapat diatur dengan `WEB_PORT` (default 80). Data PostGIS memakai volume `atlas_phase2_postgis_data` dan tidak ikut terhapus oleh `docker compose down` tanpa `-v`.

## Provider geospasial

Compose produksi menjalankan Photon dan GraphHopper pada jaringan internal. Letakkan data Photon (JAR dan `photon_data/`) di `./var/providers/photon`, serta data GraphHopper (JAR, PBF jalan, dan `graph-cache/`) di `./var/providers/graphhopper`. Backend memakai API Photon dan profil jalan `car` GraphHopper; provider tidak membuka port publik. Data provider tidak termasuk dalam repository.

ATLAS menyertakan konfigurasi GraphHopper di `deploy/graphhopper.yml`. Pastikan graph cache cocok dengan konfigurasi/profil tersebut. Layanan routing hanya membuat pratinjau mengikuti graf jalan OSM; hasilnya tetap perlu ditinjau untuk kelayakan pemasangan kabel.

MapLibre menggunakan basemap OpenFreeMap. Impor KML/KMZ disimpan di PostGIS dengan geometri sumber disertakan. Analisis massal XLSX diproses backend dan hasilnya dapat diunduh sebagai XLSX.
ADMIN juga dapat mengimpor data jaringan melalui template Excel di halaman peta; kolom geometri menerima GeoJSON dengan koordinat longitude, latitude. Detail aset mendukung tinggi tiang 7 m dan 9 m, dan dashboard dapat mengekspor laporan utilisasi jaringan ke XLSX.

## Struktur

- `apps/frontend` — `app`, `components`, `features`, dan `lib` untuk React/TanStack
- `apps/backend` — `auth`, `atlas`, `network`, `geospatial`, `database`, dan `health` untuk NestJS
- `docker-compose.yaml` — PostGIS lokal; profile `deploy` menambahkan frontend dan backend

Endpoint utama: `GET /api/health`, `GET /api/me`, `GET /api/dashboard`, `GET /api/assets`, `POST /api/assets/import`, `GET/POST /api/bookings`, `POST /api/bookings/:id/release`, `POST /api/analysis/address`, `POST /api/analysis/bulk`, dan `POST /api/routes/preview`. Semua kecuali health dan auth memerlukan sesi.
