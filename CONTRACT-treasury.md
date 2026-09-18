# Kontrak berkas: catatan transfer kas

Ditulis oleh **bot pencatat**, dibaca oleh **cashood**. Satu baris JSON per transfer.

## Berkas

```
/root/cashood/data/reborn/treasury.jsonl
```

Satu baris = satu transfer. **Hanya menambah baris di akhir**, jangan pernah menulis
ulang berkasnya — cashood membacanya tiap sepuluh menit, dan penulisan ulang bisa
tertangkap separuh jalan.

## Bentuk satu baris

```json
{"at":"2026-09-18T09:00:00Z","usd":500,"asset":"USDG","tx":"0x…","note":""}
```

| Field | Wajib | Isi |
|---|---|---|
| `at` | ya | waktu transfer, ISO 8601 UTC |
| `usd` | ya | nilai dolar yang dipindahkan, angka positif |
| `asset` | tidak | `USDG`, `ETH`, dan seterusnya |
| `tx` | tidak | hash transaksi — **tidak pernah diterbitkan ke situs**, disimpan lokal saja |
| `note` | tidak | keterangan bebas |

## Aturan penarikan

Modal bot dikunci **$9.300**. Yang ditarik hanya kelebihannya, dibulatkan ke bawah
ke kelipatan **$100**:

```
tarik = floor((saldo_bot − 9300) / 100) × 100
```

| Saldo bot | Kelebihan | Ditarik | Sisa |
|---|---|---|---|
| $9.250 | — | $0 | $9.250 |
| $9.350 | $50 | $0 | $9.350 |
| $9.850 | $550 | $500 | $9.350 |
| $10.000 | $700 | $700 | $9.300 |

## Yang dilakukan cashood dengan berkas ini

- Menjumlahkan seluruh `usd` menjadi saldo kas, dan **menambahkannya ke nilai dana** —
  uang yang dipindah tetap milik investor, jadi memindahkannya tidak boleh terbaca
  sebagai kerugian.
- Menampilkan riwayat transfer di tab Data investor: tanggal, jumlah, aset.
- `tx` dan alamat dompet tidak pernah ikut terbit.

Kalau `usd` sebuah baris tidak masuk akal (nol, negatif, atau bukan angka), baris itu
dilewati dan sisanya tetap dihitung.
