# Cashood

Dashboard statis untuk Reborn Rich, Meridian, No Risk No Ferari, dan Safe Box.
Semua saldo berasal dari snapshot server. Browser **tidak membaca saldo wallet
langsung dari blockchain**. Label waktu menunjukkan umur sumber, bukan waktu fetch.

## Pengembangan dan validasi

Node.js 22 diperlukan untuk script. Frontend memakai DOMPurify yang dikunci versinya
(di `package-lock.json` dan `assets/vendor/`). Tidak ada CDN JavaScript runtime.

```bash
npm ci
npm test
npm run test:browser   # CHROME=/path/to/chromium jika tidak terdeteksi
npm run build
python3 -m http.server 8080 --directory dist
```

Build hanya menerbitkan daftar berkas yang diizinkan: HTML, aset dengan hash konten,
konfigurasi publik, dan laporan dalam manifest. Script operator, log, state lokal,
ledger treasury, dan input invoice tidak masuk artefak Pages.
Workflow menjalankan pemeriksaan sebelum deployment. Snapshot diterbitkan terpisah
ke branch `data`, dalam satu commit per siklus.

## Satu mesin pembukuan

`assets/core.js` dipakai oleh dashboard, pencatat transaksi, invoice, dan forecast.

- `deposit`: uang baru, menerbitkan unit pada NAV sebelum transaksi.
- `withdraw`: uang keluar investor, membakar unit; tidak boleh melebihi haknya.
- `reinvest`: reklasifikasi laba menjadi modal acuan; bukan uang masuk dan tidak
  menerbitkan unit. Misalnya reklasifikasi Meridian $441.
- `founding` hanya untuk setoran pembukaan pada tanggal yang sama.
- Setiap kejadian baru mempunyai `id` unik. Gunakan kembali ID yang sama ketika
  mengulang perintah; script akan menolak duplikasi.
- Transaksi simultan memakai `batchId` eksplisit dan NAV yang sama. Persamaan
  tanggal/NAV saja tidak menyatakan transaksi simultan.
- Tanggal memakai WIB dan harus cocok dengan timestamp `at`.

Transaksi historis lama telah diberi ID/batch eksplisit tanpa mengubah jumlah
setoran atau bagian investor Reborn. Perubahan jenis $441 Meridian menjadi
reinvestasi tidak memindahkan uang atau mengubah pemilik dananya.

```bash
node scripts/record.mjs deposit orel 500 --id deposit-unik \
  --at 2026-09-26T10:00:00+07:00 --nav 13000 --dry
node scripts/record.mjs withdraw --prorata 100 --id withdrawal-unik \
  --at 2026-09-26T10:00:00+07:00 --nav 13000 --dry
```

Lepas `--dry` hanya untuk mencatat transaksi yang sebenarnya. Script tidak mengirim
uang. `--push` menerbitkan perubahan konfigurasi melalui Git. Snapshot otomatis
untuk NAV hanya diterima jika lengkap dan lebih muda dari 30 menit. Transaksi
historis membutuhkan NAV historis yang telah diverifikasi.

## Snapshot dan gangguan sumber

Setiap exporter mengunci penulisnya, memvalidasi komponen, dan menulis JSON melalui
rename atomik. Snapshot dan grafik memakai generation yang sama. Publish menolak
pasangan generasi berbeda. Total NAV selalu merupakan jumlah komponen snapshot itu
sendiri; fee posisi masuk tepat satu kali.

- Kegagalan pembacaan tidak dianggap saldo nol.
- Posisi cadangan ditandai `stale`; snapshot parsial tidak menambah titik NAV valid.
- Perubahan NAV lebih dari 30% tanpa arus kas tercatat dikarantina untuk diperiksa,
  bukan dipotong atau diubah menjadi angka lain.
- Ketidaklengkapan realisasi profit Meridian ditampilkan sebagai data tidak tersedia,
  bukan direkonstruksi memakai harga SOL hari ini.
- Riwayat disampling dengan bucket waktu; cron yang terlambat tidak menghapus satu hari.

```bash
RR_HOME=/root/robinhood node scripts/sync.mjs
MERIDIAN_HOME=/root/main/meridian node scripts/sync-meridian.mjs
RR_HOME=/root/robinhood node scripts/sync-ferari.mjs
RR_HOME=/root/robinhood node scripts/sync-safebox.mjs
```

Jangan menjalankan exporter produksi untuk menguji: gunakan `npm test`, yang memakai
bot dan jaringan tiruan dalam direktori sementara. `CASHOOD_DATA_DIR` tersedia untuk
pencatat, forecast, dan exporter selain Reborn; Reborn menerima path output eksplisit.

## Kas, biaya, dan dividen

Biaya dan persentase hanya berasal dari konfigurasi, bukan contoh angka di UI.
Biaya bersama dibayar oleh dana dengan `costs.shared` dan `costs.primary` bernilai
true; dana lain pada kelompok itu tidak ditagih lagi.

Dasar dividen dinyatakan oleh `dividend.basis`:

- `treasury`: kas laba yang benar-benar tercatat dan belum dibayarkan. Reborn dan
  Meridian menggunakan dasar ini. Saldo awal/lapisan lama mempertahankan hak
  investor yang berhak sebelum modal baru masuk.
- `nav`: kenaikan NAV di atas modal acuan. Ferari menampilkan simulasi dengan dasar
  ini; uang masuk/keluar wallet eksternal tetap perlu direkonsiliasi sebelum membayar.

Treasury mencatat masuk **dan keluar**. Setiap transfer memerlukan `tx` atau `id`
unik. Catatan tanpa identitas tidak ditebak berdasarkan tanggal + nominal. Lihat
`CONTRACT-treasury.md`.

```bash
node scripts/treasury.mjs expense --fund reborn --id biaya-2026-09 \
  --usd 250 --at 2026-10-01T10:00:00+07:00 --period 2026-09 --dry
node scripts/treasury.mjs dividend --fund reborn --id bayar-2026-09 \
  --usd 850 --at 2026-10-01T10:01:00+07:00 --period 2026-09 --dry
```

Perintah ini hanya mencatat transfer yang sudah terjadi; **tidak melakukan pembayaran**.
Jangan mencatat pembayaran sebagai withdrawal modal investor sekaligus pengeluaran
kas: itu dua klasifikasi berbeda untuk uang yang sama.

## Invoice

```bash
node scripts/statement.mjs --fund reborn --period 2026-09 \
  --withdrawn 1100 --balance 13000 --rate 17650 --revision 1
```

Default adalah draft. Untuk sumber kas yang sama dengan dashboard, gunakan
`--from-live --rate 17650 --period 2026-09` tanpa `--withdrawn`; snapshot lengkap
periode itu beserta lapisan haknya dibekukan. `--final` hanya diterima setelah periode
selesai dan harus memakai `--snapshot reports/private/<draft>.json` dari draft
`--from-live`. Simpan draft penutupan sebelum berganti periode. `--withdrawn`
adalah laba tersedia terverifikasi untuk perhitungan itu, bukan otomatis jumlah
seluruh withdrawal modal. Mesin yang sama menghitung hak per lapisan dan sen per
investor. ID investor menjadi kunci, sehingga nama sama tidak menggabungkan hak.
Investor yang keluar tetap dapat menerima lapisan laba lama.

Input dibekukan di `reports/private/`. Berkas yang sama tidak ditimpa; gunakan
`--revision 2`. `--snapshot <input-json>` membuat revisi dari input beku. Jangan
menggunakan config terbaru untuk merekonstruksi periode lama bila data tutup periode
aslinya sudah berubah. Laporan lama yang belum memiliki status final diperlakukan
sebagai draft di situs. Membuat invoice tidak menandai uang sudah dibayarkan.

## Safe Box

Pokok dan pemilik awal ada di konfigurasi. Pada migrasi pertama, hak bunga yang sudah
terlihat di snapshot terakhir dibekukan per pemilik; sistem tidak mengarang riwayat
kepemilikan yang tidak tersedia. State baru ada di `accrual-v2.local.json`.

Perubahan pemilik/pokok berikutnya memakai `ownerEvents: [{ at, owners: [...] }]`
dengan waktu efektif, bukan menimpa pokok awal. Hak lama tidak dibagi ulang.
Kenaikan fee dialokasikan terhadap interval pengamatan. Jeda lebih dari dua jam
ditandai estimasi; hari terlewat tidak dikenai batas bunga hanya satu hari.
Nilai fee tidak wajar membatalkan pengamatan sebelum baseline berubah.

Pembayaran bunga menggunakan `scripts/treasury.mjs interest --fund safebox
--owner <id> --id <unik> --usd <jumlah> --at <ISO>`. Hak tercatat dikurangi pembayaran,
bukan mengurangi bunga historis yang pernah dihasilkan. Fee posisi eksternal masih
merupakan estimasi bila log claim yang terkonfirmasi belum tersedia.

## Forecast

Forecast memerlukan sedikitnya tujuh hari selesai dengan NAV tervalidasi dan arus
kas tercatat. Riwayat lama yang belum diverifikasi tidak diberi stempel valid.
Selama belum cukup, situs menampilkan alasan penundaan. Ferari ditandai arus kas
belum lengkap, sehingga proyeksinya ditunda sampai rekonsiliasi selesai.

Model memisahkan uang bekerja, kas cadangan, biaya, dan dividen. Pembayaran mengikuti
kalender WIB; sapuan bukan kerugian. Skenario mengambil satu lintasan berdasarkan
total kekayaan, bukan menjumlahkan persentil komponen yang berbeda. Angka 0% berarti
kejadian tidak muncul dalam simulasi, bukan kejadian mustahil. Tidak ada probabilitas
minimum buatan maupun tambahan kejutan sintetis yang tersembunyi.

## Memasang perubahan pada server yang sudah berjalan

1. Simpan backup data lokal dan konfigurasi sebelum migrasi.
2. Jalankan `node scripts/preflight.mjs /root/cashood` dari checkout baru.
3. Jalankan seluruh tes dan build; pasang kode secara konsisten pada checkout cron.
4. Jalankan satu siklus exporter, periksa kualitas dan rekonsiliasi totalnya, lalu
   terbitkan dengan `scripts/publish.sh`.
5. Pantau exit status cron. Lock mencegah tumpang tindih; kegagalan satu dana
   mempertahankan data terakhir dan tidak memalsukan timestamp sumber.

Cron tidak diubah otomatis oleh pengujian. `publish.sh` memakai `flock` dan timeout
per exporter. Untuk jadwal forecast, konfigurasikan zona waktu cron secara eksplisit;
jangan menganggap zona waktu mesin sama dengan WIB.

## Privasi dan batas hosting

Identitas on-chain posisi tidak lagi diterbitkan. ID publik berasal dari hash dengan
kunci lokal acak (`publication-key.local.json`). Berkas lokal tersebut jangan dipush.
Data investor, angka, dan laporan yang memang ditampilkan tetap publik; situs ini
bukan portal dengan autentikasi. Pola angka/waktu masih bisa dikorelasikan dengan
blockchain, sehingga penghilangan ID bukan jaminan anonimitas.

CSP dipasang pada halaman utama. GitHub Pages tidak menyediakan konfigurasi header
HTTP kustom untuk aplikasi ini. HSTS, `frame-ancestors`, dan `nosniff` perlu dipasang
pada proxy/CDN yang benar-benar melayani domain, lalu diverifikasi di respons HTTP.
Mengunggah `_headers` ke Pages saja tidak mengaktifkannya. Jangan memasukkan
`frame-ancestors` ke meta CSP: directive itu memerlukan header HTTP.

Alamat/identitas yang sudah terbit di riwayat Git atau salinan pihak lain tidak dapat
ditarik kembali oleh perubahan kode ini. Penulisan ulang riwayat adalah tindakan
operasional terpisah dan tidak dilakukan otomatis.
