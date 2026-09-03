# Pembatalan tiket dan PO

Status pembatalan adalah CANCELLED, bukan COMPLETED atau EXPIRED.
SPV, ADMIN, dan DEVELOPER dapat membatalkan dari Waiting List:

- Batalkan Tiket: seluruh PO yang belum Done GR, alasan wajib 1-500 karakter.
- Detail PO > Batalkan PO: hanya PO tersebut. PO lainnya tetap diproses.
- PO Done GR dan tiket Completed/Expired tidak dapat dibatalkan.
- Jika semua PO batal, tiket dibatalkan. Jika PO tersisa semuanya Done GR,
  tiket selesai berdasarkan waktu GR terakhir, tanpa menghitung PO batal.

Alasan, waktu, pelaku, dan event audit disimpan. Tidak ada penghapusan riwayat.
Clear Task mengabaikan tiket/PO batal. Perubahan dari tab lama ditolak di
backend; seluruh jalur mutasi mengunci parent ticket terlebih dahulu.

## Verifikasi lokal

Jalankan npm test. Tes database menggunakan Postgres lokal in-memory (PGlite)
dengan tabel, fungsi, view, dan trigger dari migration aplikasi. Extension
network/cron tidak dimuat. Ini tidak menggunakan tiket operasional.
Tes ini bukan uji konkurensi multi-koneksi di server production.

## Urutan rilis

1. Periksa schema production dan migration history secara read-only.
2. Terapkan 20260903010000_ticket_cancellation.sql setelah migration sebelumnya.
   Migration ini transaksional dan dijalankan satu kali melalui migration runner.
3. Deploy Supabase inbound-api dengan dua action baru cancel_ticket/cancel_po.
4. Deploy frontend Cloudflare termasuk js/cancellation.js dan versi cache 26.0.
5. Verifikasi file live dan akses role; jangan membatalkan tiket operasional
   hanya untuk menguji fitur. Minta operator memilih target dan alasan.

Tidak ada scheduler atau integrasi GSheet yang diaktifkan oleh migration ini.
