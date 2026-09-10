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

### Nyatat setoran / penarikan

Paling aman lewat script — dia yang ngisi `navBefore` dari nilai wallet terkini
dan mastiin penarikan pro-rata dibagi di harga unit yang sama:

```bash
node scripts/record.mjs deposit  orel 500 --note "topup"
node scripts/record.mjs withdraw as   200
node scripts/record.mjs withdraw --prorata 800 --push
```

- `--dry` cuma nampilin hasilnya, config tidak disentuh
- `--push` langsung commit + push
- `--nav <angka>` kalau mau paksa nilai wallet sendiri
- nolak kalau jumlahnya lebih besar dari jatah orangnya, atau kalau snapshot
  sudah lebih tua dari 30 menit

Hitungannya bukan salinan: script ini menjalankan mesin ledger di
`assets/app.js` apa adanya, jadi angkanya pasti sama dengan yang di situs.

Cara manual masih bisa: **kalkulator penarikan** di situsnya keluarin baris JSON
siap tempel ke `events`.

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

Nilai wallet dirakit dari dua bagian:

| Bagian | Sumber | Sesegar apa |
|---|---|---|
| Saldo token (ETH, USDG, WETH) | RPC publik, dibaca browser langsung dari address | **live** — tiap halaman dibuka, lalu tiap 5 menit |
| Nilai posisi LP | `data/live.json`, ditulis bot | tiap 10 menit lewat cron |

Kenapa LP tidak ikut live: nilainya tidak bisa dibaca dengan satu panggilan
RPC. Butuh tick math + quoter per posisi — itu kerjaan bot, bukan browser.
Jadi bagian itu dititip di snapshot.

Situsnya baca snapshot dari `raw.githubusercontent.com`, bukan dari file yang
ikut ke-deploy — begitu bot push, angkanya kepakai tanpa nunggu Pages build
ulang (CDN raw nahan maksimal 5 menit).

Alamatnya **dihitung sendiri dari alamat halaman**: `orelfx.github.io/cashood`
→ `raw.githubusercontent.com/orelfx/cashood/data/`. Jadi repo yang di-rename
atau di-fork tetap baca datanya sendiri. `app.snapshotUrl`, `app.navUrl` dan
`app.heartbeatUrl` di config cuma cadangan buat domain sendiri.

### Kenapa datanya di branch `data`, bukan `main`

GitHub Pages membangun ulang situs tiap kali `main` berubah, dan batas
lunaknya **10 build per jam**. Cron 10 menitan sendirian sudah makan 6 — pas
ditambah beberapa push kode, jatahnya habis dan **semua** build gagal, termasuk
yang bawa perbaikan. Kejadian beneran tanggal 10 Sep: situs nyangkut 25 menit
di versi lama.

Sekarang `live.json`, `nav.json` dan `heartbeat.json` tinggal di branch `data`
yang tidak pernah memicu build. `main` cuma berubah kalau kodenya berubah.

Kalau RPC lagi mati, situs pakai snapshot bulat-bulat. Kalau snapshot yang
hilang, situs tetap jalan dengan saldo token saja dan kasih peringatan bahwa
LP belum kehitung. `navOverrideUsd` di config selalu menang di atas keduanya.

Harga ETH dari CoinGecko, cadangan DexScreener. Dua-duanya gratis, tanpa API key.

### Bikin `live.json`

```bash
RR_HOME=/root/robinhood node scripts/sync.mjs
```

Script ini baca kode bot yang sudah ada (`bookValueUsd` + `readBook`) dan nulis
`data/live.json`. Isinya cuma angka — total USD, saldo token, dan nilai tiap
posisi LP. Tidak ada key yang ikut tertulis.

### Auto-update

Sudah terpasang di cron:

```
*/10 * * * * /root/cashood/scripts/publish.sh >> /root/cashood/sync.log 2>&1
```

`publish.sh` = sync + commit + push, dan diam saja kalau angkanya tidak berubah.
Jangan dibikin lebih rapat dari 10 menit: GitHub Pages punya batas lunak
10 build per jam.

---

## Nilai wallet dari waktu ke waktu

Kartu **Nilai wallet** gambar garis nilai total dari waktu ke waktu, lengkap
sama garis putus-putus **modal** — di atas garis berarti untung.

Datanya dikumpulin sendiri: tiap `sync.mjs` jalan, satu titik masuk ke
`data/nav.json`. Chain cuma tahu saldo *sekarang*, ga nyimpen saldo kemarin,
jadi ga ada cara lain selain nyatet sambil jalan. Artinya grafik ini mulai dari
nol dan makin panjang tiap 10 menit (6 titik per jam).

Yang lama diencerkan biar filenya ga bengkak: 2 hari terakhir utuh, sebulan
terakhir sejam sekali, lebih tua dari itu sehari sekali.

---

## Tab Bot — laporan heartbeat

Tab **💓 Bot** nampilin laporan yang dikirim bot ke Telegram tiap jam, apa
adanya: posisi yang lagi jalan, tick range, fee yang belum dipanen, hasil
screening, hall of fame/shame, sampai jadwal cron-nya.

Alurnya:

1. Bot nulis salinan laporannya ke `.state/heartbeat.json` tiap kali ngirim ke
   Telegram (satu blok `try/catch` di `heartbeat.js` — gagal nulis tidak
   menghentikan denyut).
2. `scripts/heartbeat.mjs` di sini nyalin teks itu ke `data/heartbeat.json`.
3. `publish.sh` push, situs baca.

Kalau salinannya belum ada, script-nya nyusun ulang laporan lewat `gather()` +
`renderReport()` punya bot — sama isinya, tapi baris `Agent`, `Uptime`, `Model`
dan `RPC calls` dibuang karena angka itu milik proses bot yang lagi jalan, bukan
milik proses yang cuma numpang render. Situs kasih tanda kalau lagi mode ini.

**Yang diambil cuma teks laporan itu.** Tidak ada `.env`, tidak ada log, tidak
ada kunci. Sebelum nulis, script-nya nyaring: kalau nemu sesuatu sepanjang
private key, seed phrase, token bot, atau nama variabel rahasia — dia berhenti
dan tidak nerbitin apa-apa.

Cron: `7 * * * *` (bot kirim heartbeat menit :04).

---

## Riwayat profit

Kartu **Riwayat profit** ambil angka dari buku posisi bot — semua posisi yang
sudah ditutup, dikelompokkan per hari.

- **Grafik**: batang naik = untung, turun = rugi. Bisa harian / mingguan /
  bulanan, rentang 7 hari / 30 hari / semua. Arahkan kursor ke batangnya buat
  lihat jumlah dan berapa posisi yang ditutup hari itu.
- **Kalender**: satu kotak satu hari, ala LP Agent. Warna makin pekat makin
  besar angkanya, dan tandanya tetap ditulis (`+`/`−`) biar tidak cuma
  mengandalkan warna.
- **Statistik**: profit terkunci, win rate, jumlah posisi ditutup, rata-rata
  modal per posisi, hari terbaik.

Yang dihitung di kartu ini cuma profit yang **sudah terkunci**. Untung/rugi
posisi yang masih jalan tidak dicampur ke situ — bagian itu sudah kehitung di
**Nilai sekarang** paling atas. Makanya angkanya bisa beda jauh sama LP Agent:
mereka pakai basis dan perhitungan fee sendiri.

> LP Agent tidak dipakai sebagai sumber data — API-nya ditutup Cloudflare, tidak
> ada endpoint gratis yang bisa dipanggil browser. Semua angka di sini datang
> dari RPC publik dan buku posisi bot sendiri.

---

## Lisensi

MIT — lihat [LICENSE](LICENSE).

---

## Isi folder

```
index.html            halaman
assets/style.css      tampilan
assets/app.js         ledger unit, ambil data, render
data/config.json      pemilik + riwayat transaksi  <- yang kamu edit
data/live.json        snapshot bot (otomatis)
data/nav.json         deret nilai wallet (otomatis)
data/heartbeat.json   laporan bot terakhir (otomatis)
scripts/sync.mjs      bikin live.json + nav.json dari bot
scripts/record.mjs    catat setoran / penarikan
scripts/heartbeat.mjs ambil laporan bot
scripts/publish.sh    sync + commit + push
```
