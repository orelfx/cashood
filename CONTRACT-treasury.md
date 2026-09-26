# Kontrak ledger treasury v2

Satu baris JSON lengkap per transfer terkonfirmasi pada `data/<fund>/treasury.jsonl`.
Berkas bersifat lokal dan tidak dipublikasikan. Bot pencatat tetap hanya append;
tulis satu baris lengkap diakhiri newline dalam satu operasi.

```json
{"id":"sweep-unik","at":"2026-09-26T06:05:12+07:00","type":"sweep","usd":100,"asset":"USDG","tx":"hash-transaksi"}
```

- `at`: timestamp epoch milidetik atau ISO dengan zona waktu.
- `usd`: angka positif, maksimal dua desimal; arah dinyatakan oleh `type`.
- `type`: `sweep`/`deposit` menambah kas; `expense`/`dividend`/`withdraw` mengurangi kas.
- `tx` atau `id`: wajib unik. Hash yang sama dari dua sumber didedup. Jangan memakai
  ID lokal berbeda untuk transaksi yang sudah ada pada catatan bot.
- `period`: periode `YYYY-MM` untuk biaya/pembayaran bila berbeda dari bulan transfer.
- `asset`: simbol token; alamat dan hash tidak masuk keluaran publik.

Baris rusak, ID ambigu, saldo negatif, serta duplikat dengan nominal berbeda
membatalkan perhitungan baru. Data lama dipertahankan. Sistem tidak menebak identitas
transfer dari tanggal dan nominal. Transfer sebelum `treasury.countFromAt` sudah
terwakili saldo awal dan tidak dihitung ulang.

Saldo = saldo awal + pemasukan - pengeluaran. Lapisan laba tersimpan menurut waktu
haknya; pengeluaran mengurangi lapisan tertua lebih dahulu. Biaya yang sudah dibayar
pada periode berjalan tidak ditagih lagi dalam simulasi periode itu.

Contoh pemeriksaan tanpa menulis:

```bash
node scripts/treasury.mjs dividend --fund reborn --id pembayaran-unik \
  --usd 850 --at 2026-10-01T10:00:00+07:00 --period 2026-09 --dry
```

Lepas `--dry` untuk mencatat pembayaran yang benar-benar sudah dilakukan. Perintah
ini tidak mengirim uang. Jangan menambahkan transaksi percobaan ke ledger produksi.

Safe Box mempunyai `payouts.jsonl` terpisah: `type: interest`, `owner` ID pemilik,
`id`, `at`, dan `usd`. Pencatatan bunga tidak mengubah pokok atau saham dana lain.
