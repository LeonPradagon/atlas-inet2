# API Analisis ATLAS

Panduan ini untuk integrasi server-ke-server ke API analisis ATLAS. Endpoint analisis menerima sesi aplikasi atau API key. Endpoint lain tetap memerlukan sesi login.

## Akses dan autentikasi

- Base URL produksi: `https://<host>/api`
- Kirim key pada setiap request dengan header `X-API-Key`.
- Nilai key disimpan di environment server sebagai `ANALYSIS_API_KEY`; gunakan key dari pemilik server dan jangan taruh di repository atau kode browser.
- API key minimum 32 karakter. Server membandingkan key dengan perbandingan waktu konstan.
- Bila header hilang atau tidak valid, server mengembalikan `401 Unauthorized`.
- Satu key memakai identitas API bersama untuk menyimpan analisis dan memiliki job bulk. Endpoint riwayat tetap memerlukan sesi login.

```sh
export ATLAS_API_URL="https://<host>/api"
export ANALYSIS_API_KEY="<key-dari-pemilik-server>"
```

## Analisis satu lokasi

### `POST /analysis/address`

Header: `X-API-Key`, `Content-Type: application/json`.

Kirim `address` saja atau `coordinates` saja. Minimal salah satu harus tersedia:

- `address`: alamat bebas untuk dianalisis melalui geocoding.
- `coordinates`: berisi `longitude` dan `latitude`; `coordinateConfirmed` wajib `true`. Bila `address` tidak dikirim, sistem menggunakan pasangan koordinat sebagai label hasil.
- `structured`: opsional untuk memperjelas geocoding alamat; `province`, `city`, `district`, dan `subdistrict` harus lengkap agar data terstruktur dipakai. `street`, `number`, serta `postalCode` opsional.
- `coreRequirement` opsional: `services` minimal 1, `reserve` minimal 0, dan jumlah keduanya maksimal 4096.
- `allowExpand2km` opsional; `true` meminta perluasan pencarian.

Contoh dengan alamat saja:

```sh
curl -X POST "$ATLAS_API_URL/analysis/address" \
  -H "X-API-Key: $ANALYSIS_API_KEY" \
  -H "Content-Type: application/json" \\
  -d '{"address":"Jl. Sudirman, Jakarta"}'
```

Contoh PowerShell (gunakan URL lengkap dengan prefix `/api`; tanda `\` sebagai penerus baris hanya berlaku untuk shell seperti Bash):

```powershell
$uri = "https://<host>/api/analysis/address"
$headers = @{ "X-API-Key" = $env:ANALYSIS_API_KEY }
$body = @{ address = "Jl. Sudirman, Jakarta" } | ConvertTo-Json
Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

Contoh dengan koordinat saja:

```sh
curl -X POST "$ATLAS_API_URL/analysis/address" \
  -H "X-API-Key: $ANALYSIS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "coordinates": {"longitude": 106.8229, "latitude": -6.2088},
    "coordinateConfirmed": true,
    "coreRequirement": {"services": 20, "reserve": 4}
  }'
```

Respons memuat hasil analisis seperti `status`, koordinat, jaringan/rute/terminasi yang ditemukan, dan `historyId`. Isi detail analisis dapat berkembang.

### `POST /analysis/connection`

Menganalisis sambungan antara dua titik koordinat. `start` dan `end` wajib memiliki `longitude` dan `latitude`; `label` opsional. `coreRequirement` dan `allowExpand2km` mengikuti aturan analisis alamat.

```json
{
  "start": {"longitude": 106.8229, "latitude": -6.2088, "label": "Titik A"},
  "end": {"longitude": 106.8301, "latitude": -6.2142, "label": "Titik B"},
  "coreRequirement": {"services": 20, "reserve": 4}
}
```

## Endpoint lokasi pendukung

Semua endpoint berikut juga menerima `X-API-Key`:

| Method dan path | Kegunaan |
| --- | --- |
| `GET /analysis/address/suggestions?q=...` | Saran alamat; `q` minimal 3 karakter. Bisa diberi filter `province`, `city`, `district`, `subdistrict`, dan `postalCode`. |
| `GET /analysis/address/reverse?longitude=...&latitude=...` | Mencari alamat dari koordinat. |
| `GET /analysis/terminations?longitude=...&latitude=...&expand=true` | Mencari terminasi jaringan dekat koordinat; `expand` opsional. |

## Analisis XLSX bulk

Gunakan job asinkron untuk file besar. File dibaca dari sheet pertama, maksimal **15 MB** dan **5.000 lokasi**.

### Format XLSX

Baris pertama adalah header. Minimal salah satu:

- Kolom alamat bernama `Alamat` atau `Address`; atau
- Pasangan koordinat `Latitude`/`Lat` dan `Longitude`/`Lon`/`Lng`.

Kolom tambahan alamat dikenali sebagai `Provinsi`/`Province`, `Kabupaten`/`Kabupaten/Kota`/`Kota`/`City`, `Kecamatan`/`District`, `Kelurahan`/`Kelurahan/Desa`/`Desa`/`Village`, `Nomor Rumah`/`No Rumah`/`House Number`, dan `Kode Pos`/`Postal Code`/`Postcode`. Jika koordinat tidak diisi, alamat, provinsi, kabupaten/kota, dan kecamatan harus tersedia. Baris lokasi kosong dilewati.

### `POST /analysis/bulk/jobs`

Kirim `multipart/form-data` dengan field file bernama `file` dan ekstensi `.xlsx`.

```sh
curl -X POST "$ATLAS_API_URL/analysis/bulk/jobs" \
  -H "X-API-Key: $ANALYSIS_API_KEY" \
  -F "file=@alamat.xlsx"
```

Respons awal berisi `jobId`, `historyId`, `fileName`, `status`, `total`, `processed`, `succeeded`, `failed`, `cancelRequested`, `createdAt`, dan `updatedAt`. Simpan `jobId` untuk mengambil progres dan hasil.

### Progres dan hasil job

| Method dan path | Kegunaan |
| --- | --- |
| `GET /analysis/bulk/jobs/{jobId}` | Status dan jumlah baris diproses/berhasil/gagal. |
| `GET /analysis/bulk/jobs/{jobId}/rows?page=1&pageSize=50` | Hasil berpaginasi; `pageSize` maksimum 100. Filter opsional: `search` dan `status`. |
| `GET /analysis/bulk/jobs/{jobId}/map-points` | Baris yang mempunyai koordinat untuk ditampilkan pada peta. |
| `POST /analysis/bulk/jobs/{jobId}/rows/{row}/expand` | Ulang analisis baris dengan radius pencarian lebih luas; body harus `{"confirmed":true}`. |
| `POST /analysis/bulk/jobs/{jobId}/cancel` | Membatalkan baris yang belum diproses. Baris yang sedang berjalan dapat selesai lebih dulu. |

Status job: `QUEUED`, `RUNNING`, `COMPLETED`, `COMPLETED_WITH_ERRORS`, `CANCELLED`, atau `FAILED`. Status baris: `QUEUED`, `PROCESSING`, `OK`, `ERROR`, atau `CANCELLED`. Respons baris berisi nomor baris, alamat, koordinat, status, pesan, serta hasil analisis jika tersedia.

Contoh polling:

```sh
curl "$ATLAS_API_URL/analysis/bulk/jobs/<jobId>" \
  -H "X-API-Key: $ANALYSIS_API_KEY"

curl "$ATLAS_API_URL/analysis/bulk/jobs/<jobId>/rows?page=1&pageSize=100" \
  -H "X-API-Key: $ANALYSIS_API_KEY"
```

### `POST /analysis/bulk` (sinkron)

Endpoint ini menerima XLSX yang sama, tetapi dibatasi **500 lokasi**. Request menunggu seluruh baris selesai dan mengembalikan `providerAvailable`, `rows`, serta `historyId`. Untuk file yang lebih besar atau proses yang lama, gunakan `/analysis/bulk/jobs`.

## Error umum

| HTTP | Arti |
| --- | --- |
| `400 Bad Request` | Header/file/parameter tidak valid, sheet kosong, atau file/baris melewati batas. Respons JSON berisi `message`. |
| `401 Unauthorized` | `X-API-Key` hilang/tidak valid dan tidak ada sesi login. |
| `404 Not Found` | Job bulk tidak ditemukan atau tidak dapat diakses oleh identitas pemiliknya. |

## Swagger

Dokumentasi OpenAPI yang dihasilkan server tersedia di `/api/docs` dan `/api/docs-json`. Di Swagger UI, tekan **Authorize** lalu masukkan key pada skema `AnalysisApiKey`.
