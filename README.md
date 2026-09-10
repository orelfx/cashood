# cashood

Pemantau wallet patungan di **Robinhood Chain**. Satu wallet, beberapa pemilik,
pembagian saham otomatis. Situs statis — HTML + CSS + JS polos, tanpa build,
tanpa dependency, siap di-host di GitHub Pages.

**Yang ada di repo ini cuma address publik.** Tidak ada private key, seed, atau
API key. Aman di-share.

Wallet: `0xd84be45d81750b178d98fb1e3fbacc43c002d202`

---

## Cara jalanin lokal

```bash
cd cashood
python3 -m http.server 8080
```

Buka `http://localhost:8080`. (Harus lewat http — buka file langsung lewat
`file://` bakal gagal karena `fetch` diblok browser.)

## Deploy ke GitHub Pages

1. Bikin repo baru di GitHub, push isi folder ini.
2. Settings → Pages → Source: `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. Selesai. Situs jalan di `https://<user>.github.io/<repo>/`.

---

## Cara ngatur pemilik & transaksi

Semua diatur dari satu file: [`data/config.json`](data/config.json). Edit, commit, push.

```json
{
  "owners": [
    { "id": "orel", "name": "Orel", "color": "#4ade80" },
    { "id": "as",   "name": "A$",   "color": "#60a5fa" }
  ],
  "events": [
    { "date": "2026-09-01", "type": "deposit", "owner": "orel", "usd": 6000, "founding": true },
    { "date": "2026-09-01", "type": "deposit", "owner": "as",   "usd": 2000, "founding": true }
  ]
}
```

### Aturan `events`

| field | isi |
|---|---|
| `date` | `YYYY-MM-DD` |
| `type` | `deposit` atau `withdraw` |
| `owner` | `id` dari daftar `owners` |
| `usd` | jumlah dolar |
| `founding` | `true` **hanya** untuk setoran awal (harga 1 unit = $1) |
| `navBefore` | total nilai wallet **sebelum** transaksi ini. Wajib untuk semua event non-founding |
| `note` | bebas |

`navBefore` itu yang bikin pembagiannya adil. Kalau ada orang baru masuk waktu
wallet lagi untung, dia beli unit di harga saat itu — untung yang sudah ada
tetap milik pemilik lama, tidak ikut kebagi.

Transaksi yang terjadi barengan (mis. tarik pro-rata dibagi ke 2 orang) tulis
dengan `date` dan `navBefore` yang sama — dihitung sebagai satu momen.

### Nambah orang baru

```json
{ "id": "budi", "name": "Budi", "color": "#f472b6" }
```

lalu setorannya:

```json
{ "date": "2026-10-01", "type": "deposit", "owner": "budi", "usd": 2000, "navBefore": 10000 }
```

### Nyatat penarikan

Pakai **kalkulator penarikan** di situsnya: isi jumlah, dia keluarin baris JSON
siap tempel ke `events` (lengkap dengan `navBefore` hari itu).

---

## Cara hitungnya (unit / saham)

Bukan `setoran gue ÷ total setoran`, tapi sistem unit seperti reksa dana:

- Setoran awal: $1 = 1 unit. Orel 6000 unit, A$ 2000 unit → total 8000 unit.
- Saham = unit ÷ total unit → Orel 75%, A$ 25%.
- Nilai wallet naik jadi $10.000 → harga unit $1,25 → Orel $7.500, A$ $2.500.
- Tarik $800 pro-rata → Orel $600, A$ $200, saham tetap 75/25.
- Orang baru setor $2.000 saat NAV $10.000 → dia dapat 1.600 unit, bukan
  langsung ikut untung yang lama.

---

## Dari mana angka saldonya

Tiga sumber, dipakai berurutan:

1. **`navOverrideUsd`** di `config.json` — kalau diisi angka, itu yang dipakai. Buat kunci manual.
2. **`data/live.json`** — snapshot dari bot. Ini yang paling akurat karena
   **termasuk nilai posisi LP**, bukan cuma token nganggur di wallet.
3. **RPC publik** `https://rpc.mainnet.chain.robinhood.com` — dibaca langsung dari
   browser, gratis, tanpa API key. Harga ETH dari CoinGecko (cadangan: DexScreener).
   Kekurangannya: **posisi LP tidak kehitung**, jadi angkanya cuma saldo token di wallet.

Hasilnya di-cache 1 jam di browser biar tidak kena rate limit. Tombol **refresh**
memaksa ambil ulang. Ganti intervalnya di `app.refreshMinutes`.

### Bikin `live.json` (biar posisi LP ikut kehitung)

```bash
RR_HOME=/root/robinhood node scripts/sync.mjs
```

Script ini baca kode bot yang sudah ada (`bookValueUsd` + `readBook`) dan nulis
`data/live.json`. Isinya cuma angka — total USD, saldo token, dan nilai tiap
posisi LP. Tidak ada key yang ikut tertulis.

Otomatis tiap jam + auto-push:

```bash
crontab -e
# tambahkan:
0 * * * * /root/cashood/scripts/publish.sh >> /tmp/cashood.log 2>&1
```

---

## Isi folder

```
index.html            halaman
assets/style.css      tampilan
assets/app.js         ledger unit, ambil data, render
data/config.json      pemilik + riwayat transaksi  <- yang kamu edit
data/live.json        snapshot bot (otomatis)
scripts/sync.mjs      bikin live.json dari bot
scripts/publish.sh    sync + commit + push
```
