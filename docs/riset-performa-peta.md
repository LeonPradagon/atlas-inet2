# Riset pemuatan Peta Jaringan

## Temuan lokal

Pada pengukuran sebelumnya, database lokal berisi 17.106 aset dan 11.634 core. Kueri daftar aset peta pada paket terbesar dengan cakupan luas mencapai batas pengukuran 12 detik. Penghitungan status core secara terpisah selesai sekitar 61 ms. Selisih ini menunjukkan perlunya melihat rencana eksekusi kueri gabungan sebelum menetapkan penyebab utama.

- Frontend sudah meminta aset berdasarkan batas area yang terlihat (bbox), zoom, provinsi, dan paket. Lihat `apps/web/src/features/map/MapPage.tsx` pada `mapAssetsQuery`.
- Backend menggabungkan filter spasial, metadata impor, geometri, dan agregasi status core dalam satu kueri. Penyederhanaan geometri tampilan saat ini mengecualikan aset KML. Lihat `apps/server/src/atlas/atlas.service.ts` pada `listMapAssets`.

## Urutan perbaikan yang disarankan

1. **Ukur kueri dan respons.** Bandingkan viewport provinsi dengan viewport yang diperbesar pada paket yang sama. Catat waktu database, jumlah aset, ukuran respons, dan waktu sampai layer tampil. Gunakan `EXPLAIN (ANALYZE, BUFFERS)` pada SELECT untuk menemukan operasi yang dominan. Periksa apakah indeks spasial digunakan sebelum menambah indeks. [PostgreSQL](https://www.postgresql.org/docs/current/using-explain.html), [PostGIS](https://postgis.net/docs/ST_Intersects.html).
2. **Ringankan respons peta.** Saring aset berdasarkan area dan paket, lalu kirim ID, geometri tampilan, dan atribut yang diperlukan untuk menggambar. Ambil detail serta kapasitas core saat segmen dipilih. Pertahankan geometri asli untuk edit dan ekspor. Ukur ulang sebelum menambah mekanisme lain. Pengurangan payload dan penyederhanaan geometri sesuai zoom sejalan dengan [panduan MapLibre](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/).
3. **Terapkan chunking geografis bila hasil ukur membutuhkannya.** Jika viewport luas masih terlalu berat, bagi geometri menurut area dan zoom. Jika banyak viewport tumpang tindih atau pengguna sering menggeser peta, tile vektor merupakan opsi untuk memuat dan menggunakan kembali potongan yang relevan. Ini membutuhkan perubahan pada sumber layer serta cara caching, sehingga layak dievaluasi setelah optimasi respons GeoJSON. [Panduan MapLibre](https://maplibre.org/maplibre-gl-js/docs/guides/large-data/).

Pagination berdasarkan jumlah baris bisa membantu pengiriman bertahap jika server sungguh memproses tiap batch secara mandiri. Untuk peta interaktif, pembagian geografis lebih sesuai karena potongan dapat dipilih berdasarkan viewport. Membagi respons setelah kueri lambat selesai tidak mempercepat munculnya aset pertama.

## Pengukuran setelah implementasi — 25 November 2026

Pengukuran memakai provinsi dan paket lokal yang sama (6.441 aset), tanpa filter perusahaan:

| Cakupan | Kueri sebelumnya | Mode geometri | Ukuran JSON mode geometri |
|---|---:|---:|---:|
| Luas, zoom 8 | >16 detik (timeout) | 114 ms | 5,73 MB |
| Sekitar pusat paket, zoom 16 | ≈7,74 detik | 33 ms | 2,20 MB (sebelumnya 2,30 MB) |

Waktu berasal dari `EXPLAIN (ANALYZE, BUFFERS)`. Rencana awal menunjukkan pencarian nama paket di log impor dijalankan per aset meski filter perusahaan kosong. Versi baru melewati pencarian tersebut bila filter perusahaan tidak digunakan, dan mode geometri tidak mengagregasi status core.

Kueri detail untuk satu kabel backbone tercatat sekitar 8 ms dan mengembalikan 3 core terpakai, 1 dibooking, dan 92 tersedia. Ukuran JSON di tabel dihitung sebelum kompresi. Waktu jaringan dan render browser belum diukur. Ukuran respons luas masih perlu diperhatikan sebelum memutuskan chunking atau tile vektor.
