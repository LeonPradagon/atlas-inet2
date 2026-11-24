# Rencana implementasi Booking Core per bagian kabel

Status: booking jalur terverifikasi, waiting list, dan pengajuan kandidat sudah diimplementasikan. Kandidat memakai titik ujung yang tercatat, perangkat terdekat dalam 25 meter dari ujung kabel, atau perangkat awal dan tujuan dalam 25 meter dari bagian tengah kabel. Kandidat bisa diajukan ulang setelah sambungan core dikonfirmasi dan kapasitas mencukupi. Validasi browser dengan data KMZ masih terbuka.
Tanggal: 23 November 2026.

## Tujuan dan lingkup

Pengguna memesan satu atau lebih jalur core khusus antara dua perangkat yang berbeda. Satu jalur dapat menggunakan sebagian kabel dan melewati beberapa kabel dengan sambungan core yang tercatat. Satu permintaan memilih satu jalur kabel yang sama untuk semua core. Jalur utama dan cadangan diajukan secara terpisah.

Tahap ini mencakup booking jalur core khusus. Pemakaian bersama melalui splitter PON dibahas pada tahap berikutnya.

## Kondisi saat ini

- Data KMZ menghasilkan objek kabel dengan geometri dan core yang terkait dengan objek kabel. Satu objek dapat melewati beberapa titik pada peta.
- Posisi perangkat yang dekat dengan kabel merupakan kandidat dan belum memastikan sambungan fisik.
- Status core dan persetujuan booking saat ini dihitung per objek kabel. Persetujuan memilih core tersedia per kabel dan belum membuktikan kesinambungan core sepanjang jalur.
- ATLAS sudah memiliki data sambungan core, akses tengah kabel, booking, persetujuan, waiting list, masa berlaku, PO, release, notifikasi, dan riwayat yang perlu dipetakan sebelum perubahan.

## Contoh perhitungan

Anggap satu kabel memiliki 96 core yang seluruhnya kosong dan titik akses B dan C telah dipastikan.

```text
A ───── B ───── C ───── D
```

Booking pertama menggunakan core 01–02 dari A sampai C. Booking kedua menggunakan core 03–04 dari B sampai D. A–B memiliki 94 core tersedia, B–C memiliki 92, dan C–D memiliki 94. Kedua booking memakai core berbeda pada bagian yang bertumpuk. Ini contoh terpisah dari kondisi data aktual.

Core yang sama dapat dialokasikan pada bagian yang tidak bertumpuk hanya jika titik akses dan sambungan fisiknya mendukung penggunaan terpisah. Jumlah core yang benar-benar tersedia untuk seluruh jalur dihitung dari identitas dan kesinambungan core, bukan hanya angka terkecil kapasitas tiap bagian.

### Batas contoh dan sambungan fisik

Angka 96 pada bagian C–D setelah booking A–C adalah asumsi contoh: kedua serat yang dipesan dapat diakses dan digunakan secara terpisah pada bagian C–D. Akses ke kabel saja tidak membuktikan bahwa serat tersebut dipotong, diterminasi, atau tersedia untuk layanan lain. Jika core masih menerus atau keadaan sambungannya tidak diketahui, jangan tawarkan bagian tersebut sebagai tersedia sampai kondisi fisiknya dicatat dan dikonfirmasi.

Dua alokasi yang bertemu pada titik yang sama tidak otomatis aman meskipun interval panjangnya tidak bertumpuk. ATLAS harus memeriksa sisi serat dan sambungan di titik tersebut, termasuk apakah kedua layanan akan terhubung secara fisik. Ketika kondisi itu belum diketahui, tandai perlu verifikasi.

## Aturan domain

1. Pengguna memilih perangkat awal dan tujuan yang berbeda, jumlah core, lalu satu jalur yang ditampilkan ATLAS.
2. Jumlah yang diminta harus dipenuhi sebagai jalur core khusus yang tersambung dari awal hingga tujuan. Tidak ada alokasi sebagian.
3. Jalur terverifikasi ditampilkan berdasarkan panjang kabel. Pengguna memilih jalur. Kandidat yang belum lengkap dapat ditampilkan setelah jalur terverifikasi dengan lokasi yang perlu diperiksa.
4. Titik dekat kabel dapat dipilih untuk mencari kandidat. Permintaan boleh diajukan sebagai perlu verifikasi, tetapi tidak dapat disetujui sampai hubungan yang dibutuhkan dikonfirmasi.
5. Petugas atau admin berwenang mencatat dan mengonfirmasi sambungan. Setelah verifikasi, periksa ulang permintaan yang sama dan beri tahu pemohon apakah siap diperiksa admin atau kapasitas belum cukup.
6. Jika verifikasi menunjukkan jalur tidak dapat digunakan, tandai permintaan dan beri tahu pemohon agar mencari jalur baru.
7. ATLAS memilih core yang tersedia dan tersambung secara otomatis. Semua core dalam satu booking mengikuti jalur kabel yang sama, meskipun nomor core dapat berubah ketika berpindah kabel.
8. Permintaan yang menunggu persetujuan atau verifikasi belum mencadangkan core. Admin melihat nomor core akhir sebelum menyetujui.
9. Jika pilihan core berubah, ATLAS dapat memilih core lain pada jalur yang sama dan meminta admin memeriksa rincian terbaru. Jika data berubah lagi saat persetujuan, tahan persetujuan dan tampilkan kondisi terbaru.
10. Persetujuan memeriksa ketersediaan dan kesinambungan ulang, lalu mengalokasikan seluruh jalur secara atomik. Dua persetujuan bersamaan tidak boleh mengalokasikan core yang sama pada bagian yang bertumpuk.
11. Jika kapasitas kurang, pengguna dapat memilih jalur lain, mengubah kebutuhan melalui permintaan baru, atau masuk waiting list. Ketika kapasitas tersedia, beri notifikasi berdasarkan urutan waiting list untuk pengajuan ulang, tanpa mengalokasikan otomatis.
12. Perubahan jalur atau jumlah core dilakukan dengan membatalkan permintaan lama dan membuat permintaan baru.
13. Perubahan data jaringan yang memutus booking aktif ditahan dan menampilkan booking terdampak.
14. Persetujuan membuat alokasi dibooking. PO terbit mengubahnya menjadi terpakai. Pelepasan layanan terpakai memerlukan konfirmasi admin dan menyimpan riwayat.
15. Booking yang habis masa berlakunya dan belum memiliki PO dilepas otomatis. Pemohon dan waiting list mendapat pemberitahuan.
16. Nomor dan status core dapat ditampilkan sesuai kebutuhan pengguna. Identitas pelanggan pemilik booking lain dibatasi sesuai kewenangan.

## Tahapan implementasi

### 1. Pemetaan dan model data

- Audit alur booking dan kontrak yang ada, termasuk hak akses, penolakan, release, PO, kedaluwarsa, waiting list, audit, notifikasi, dan riwayat.
- Perbarui glosarium untuk istilah core, akses tengah, jalur, kandidat, dan alokasi per bagian.
- Rancang penyimpanan posisi awal dan akhir bagian core, identitas kabel, hubungan ke booking, kondisi core, serta status dan sumber konfirmasi titik dan sambungan.
- Gunakan data sambungan dan posisi yang sudah tersedia. Pastikan orientasi kabel A/B dipakai konsisten untuk menyimpan dan membandingkan posisi, termasuk arah perjalanan sebaliknya.
- Tentukan batas bagian yang bersentuhan agar dua alokasi yang hanya bertemu pada titik akses tidak dianggap tumpang tindih secara keliru. Validasi bahwa pemisahan fisiknya benar.
- Tentukan representasi sisi sambungan dan kondisi core sebelum dan sesudah titik akses. Simpan bukti apakah serat menerus, berakhir, disambung, atau belum diketahui; jangan menyimpulkan pemisahan dari posisi geometris saja.

### 2. Migrasi dan kompatibilitas

- Inventarisasi booking aktif, booking terpakai, core rusak atau terpakai, identitas core, status verifikasi, dan data sambungan.
- Pertahankan alokasi lama. Jika batas bagian tidak dapat dipastikan, anggap alokasi berlaku sepanjang kabel sampai diperinci.
- Perlakukan core terpakai tanpa batas yang diketahui sebagai terpakai sepanjang kabel.
- Jika hanya jumlah terpakai diketahui tanpa nomor core, tandai kapasitas jalur sebagai belum dapat dipastikan dan minta petugas melengkapi data. Jangan memilih nomor core secara spekulatif.
- Siapkan migrasi yang dapat dijalankan dengan aman serta pemeriksaan sebelum dan sesudah migrasi. Pertahankan riwayat, identitas booking, dan status yang relevan.
- Petakan semua pembaca dan penulis status core lama, termasuk Peta Jaringan, analisis, dashboard, ekspor, dan booking. Tetapkan satu sumber kebenaran untuk alokasi per bagian dan aturan ringkasan kompatibilitasnya sebelum migrasi. Cegah pembaruan status seluruh kabel menimpa alokasi parsial.

### 3. Ketersediaan dan penelusuran jalur

- Bangun penelusuran berdasarkan bagian kabel, titik akses, dan sambungan core terkonfirmasi.
- Pisahkan kandidat geometris dari jalur yang kesinambungan corenya sudah diketahui.
- Hitung ketersediaan berdasarkan core yang benar-benar tersedia pada seluruh bagian jalur. Tampilkan kapasitas per bagian jika kesinambungan belum diketahui.
- Terapkan pemeriksaan tumpang tindih, kondisi core, dan akses pada titik awal serta akhir.
- Urutkan jalur terverifikasi berdasarkan panjang kabel, dengan kandidat belum lengkap setelahnya.

### 4. Transaksi dan siklus booking

- Simpan pilihan jalur dan kebutuhan core pada permintaan. Permintaan belum mengunci alokasi.
- Sebelum persetujuan, tampilkan jalur dan nomor core hasil pemeriksaan terbaru kepada admin.
- Kunci data yang diperlukan dan periksa ulang dalam transaksi sebelum membuat seluruh alokasi. Batalkan transaksi jika terjadi konflik atau jalur berubah.
- Kunci berdasarkan identitas core dan bagian yang dapat bertabrakan dengan urutan konsisten. Perlindungan konflik harus tetap berlaku bagi semua titik masuk yang mengubah alokasi dan sambungan, termasuk ketika dua transaksi sama-sama melihat bagian kosong.
- Simpan versi atau identitas rincian yang telah ditinjau admin dan periksa pada persetujuan. Jika nomor core, jalur, atau sambungan berubah, tampilkan ulang untuk ditinjau sebelum persetujuan baru.
- Sesuaikan penolakan, waiting list, notifikasi, PO, release, kedaluwarsa, dan audit dengan alokasi per bagian.
- Tahan perubahan sambungan atau titik akses yang akan memutus booking aktif, dan tampilkan dampaknya.
- Terapkan pemeriksaan dampak juga pada perubahan geometri, urutan koordinat, impor ulang, penghapusan aset, dan perubahan kondisi core. Posisikan ulang titik hanya jika identitas dan batas alokasi tetap terbukti, jika tidak tahan perubahan untuk penanganan.

### 5. Antarmuka Booking Core

Formulir baru:

```text
Perangkat awal     [Pilih perangkat]
Perangkat tujuan   [Pilih perangkat]
Jumlah core        [2]

[Cari jalur]
```

- Tampilkan pilihan jalur, kabel yang dilalui, panjang, jumlah core yang tersambung dan tersedia, serta status verifikasi.
- Tampilkan titik yang perlu diperiksa pada kandidat dan izinkan pengajuan untuk verifikasi.
- Tampilkan rincian nomor core akhir kepada admin sebelum persetujuan.
- Tampilkan alasan jika kapasitas, sambungan, kondisi core, atau perubahan data menghalangi persetujuan.
- Sesuaikan tabel, rincian, dan ringkasan kapasitas agar menunjukkan bagian kabel dan status aktual. Batasi identitas pelanggan sesuai kewenangan.

### 6. Verifikasi

Tambahkan dan jalankan pengujian yang mencakup:

1. Booking sepanjang satu kabel dan pada bagian tengah kabel.
2. Dua alokasi bertumpuk, bagian yang hanya bersentuhan, dan bagian terpisah dengan titik akses yang sah.
3. Jalur melalui beberapa kabel dengan nomor core berbeda pada sambungan.
4. Kapasitas per bagian mencukupi tetapi jalur core tersambung tidak mencukupi.
5. Titik dekat kabel, sambungan belum dikonfirmasi, sambungan tidak valid, dan verifikasi selesai.
6. Core rusak, kapasitas tidak cukup, waiting list, notifikasi, serta permintaan tanpa alokasi sebagian.
7. Dua persetujuan bersamaan dan perubahan sambungan antara pemeriksaan dan persetujuan.
8. PO, release, kedaluwarsa, perubahan jalur, audit, hak akses, dan riwayat.
9. Migrasi booking lama, penggunaan seluruh kabel, dan jumlah terpakai tanpa nomor core.
10. Alur browser lengkap dengan kabel contoh KMZ ATLAS, termasuk arah sebaliknya.
11. Akses tengah tanpa pemutusan, sambungan pada titik yang sama, dan core yang secara fisik masih menerus melewati batas dua alokasi.
12. Pembaca status lama, impor ulang atau pembalikan geometri, dan transaksi bersamaan yang melibatkan perubahan sambungan dan persetujuan.

## Kriteria selesai

- Pengguna dapat memilih dua perangkat, mencari dan memilih jalur, lalu mengajukan jumlah core.
- ATLAS menghitung dan mengalokasikan core yang tersambung pada bagian kabel yang benar tanpa alokasi ganda.
- Sambungan yang belum pasti terlihat sebagai kandidat dan tidak disetujui sebelum verifikasi.
- Fitur booking yang telah digunakan, data lama, hak akses, dan riwayat tetap dapat digunakan sesuai aturan migrasi.
- Pengujian transaksi, data lama, serta alur browser lulus.
