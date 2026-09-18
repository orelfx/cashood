# Panduan untuk bot pencatat transfer

Bot pencatat **menulis**, situs cashood **membaca**. Satu berkas, satu arah, tidak
ada yang lain di antaranya.

## 1. Berkas yang harus ditulis

```
/root/cashood/data/reborn/treasury.jsonl
```

Format **JSON Lines**: satu baris = satu transfer, satu objek JSON per baris,
tanpa koma di akhir dan tanpa tanda kurung siku pembungkus.

```json
{"at":"2026-09-19T06:05:12Z","usd":600,"asset":"USDG","tx":"0x…","note":"sapuan harian"}
```

| Field | Wajib | Isi |
|---|---|---|
| `at` | ya | waktu transfer. ISO 8601 UTC (`2026-09-19T06:05:12Z`) atau epoch milidetik |
| `usd` | ya | nilai dolar yang dipindahkan. Angka positif, bukan string |
| `asset` | tidak | `USDG`, `ETH`, dan seterusnya. Kosong dianggap `USDG` |
| `tx` | tidak | hash transaksi. **Tidak pernah terbit ke situs**, hanya dipakai untuk dedup |
| `note` | tidak | keterangan bebas, tidak ditampilkan |

## 2. Aturan menulis

- **Hanya menambah baris di akhir** (`appendFile`, mode `a`). Jangan pernah membaca
  seluruh berkas lalu menulis ulang — situs membacanya tiap sepuluh menit dan bisa
  menangkapnya separuh jalan.
- **Satu baris harus selesai dalam satu tulisan**, diakhiri `\n`. Baris yang terpotong
  akan dilewati.
- **Jangan menulis ulang sapuan yang dikirim bot Reborn Rich sendiri.** Bot itu sudah
  mencatat sendiri tiap transfer yang ia kirim, dan situs sudah membacanya. Berkas ini
  untuk transfer yang terjadi **di luar** bot — kirim manual, koreksi, atau transfer
  dari dompet lain.
- Kalaupun dobel, tidak fatal: situs menggabungkan kedua sumber dan membuang duplikat
  memakai `tx`, atau kalau `tx` kosong memakai tanggal + nominal. Tapi **kalau `tx`
  dikosongkan dan nominal serta tanggalnya sama persis, dua transfer berbeda akan
  dianggap satu.** Isi `tx` kalau ada.
- Baris yang `usd`-nya nol, negatif, atau bukan angka akan dilewati diam-diam, sisanya
  tetap dihitung. Satu baris rusak tidak menjatuhkan sinkronisasi.
- Baris yang diawali `#` dianggap komentar.

## 3. Aturan penarikan yang dicatat

Modal kerja bot dipatok **$9.300**. Yang ditarik hanya kelebihannya, dibulatkan ke
bawah ke kelipatan **$100**:

```
tarik = floor((saldo_bot − 9300) / 100) × 100
```

| Saldo bot | Kelebihan | Ditarik | Sisa |
|---|---|---|---|
| $9.250 | — | $0 | $9.250 |
| $9.350 | $50 | $0 | $9.350 |
| $9.850 | $550 | $500 | $9.350 |
| $10.000 | $700 | $700 | $9.300 |

Sapuan berjalan sekali sehari, 06:05 WIB. Kalau USDG bebas di dompet tidak cukup
membayar penuh, yang dikirim adalah kelipatan $100 terbesar yang sanggup dibayar dan
sisanya menunggu hari berikutnya — jadi **nominal yang dicatat belum tentu sama dengan
rumus di atas**. Catat yang benar-benar terkirim, bukan yang seharusnya.

## 4. Yang TIDAK boleh ditulis ke berkas ini

- Alamat dompet mana pun, termasuk dompet tujuan.
- Private key, seed, atau isi `.env` — dalam bentuk apa pun.

Berkas ini ada di server dan tidak ikut ter-commit (masuk `.gitignore`), tapi
angkanya terbit. Hash transaksi dan alamat dibuang sebelum apa pun dipublikasikan,
karena satu hash saja cukup untuk menemukan dompet yang sengaja disembunyikan.

## 5. Yang dilakukan situs dengan berkas ini

`scripts/sync.mjs` berjalan tiap sepuluh menit dan menulis ke `data/reborn/live.json`:

| Field | Isi |
|---|---|
| `treasuryUsd` | jumlah seluruh transfer — **ditambahkan ke nilai dana**, karena uang yang dipindah tetap milik investor |
| `treasuryMoves` | 40 transfer terakhir, `{at, usd, asset}` saja — tanpa `tx`, tanpa alamat |
| `fixedCapitalUsd` | 9300 |
| `sweepStepUsd` | 100 |
| `sweepDueUsd` | yang akan tersapu kalau sapuan jalan sekarang |
| `botWalletUsd` | yang masih dipegang bot |
| `totalUsd` | `botWalletUsd + treasuryUsd` |

Tampil di tab **Data investor**, kartu "Kas cadangan": modal kerja, yang dipegang bot,
yang sudah dipindahkan, yang antre keluar, dan delapan transfer terakhir.

## 6. Cara menguji tanpa mengirim uang

```bash
printf '%s\n' '{"at":"2026-09-19T06:05:00Z","usd":600,"asset":"USDG","tx":"0xTES"}' \
  >> /root/cashood/data/reborn/treasury.jsonl
cd /root/cashood && node scripts/sync.mjs
node -e "const d=require('./data/reborn/live.json');console.log(d.treasuryUsd,d.treasuryMoves.slice(-2))"
```

Hapus lagi baris tesnya setelah selesai, lalu jalankan `node scripts/sync.mjs` sekali
lagi supaya angkanya kembali benar.
