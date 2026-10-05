/**
 * Margin satu posisi Binance untuk tabel posisi (kolom "margin" dan ROE).
 *
 * Sejak bot v2.7 ("kursi"), setelah SL/TP terpasang bot menambahkan sisa jatah
 * kursi ke margin isolated posisi itu dan mencatat totalnya di
 * `isolated_margin_usd`. Sebelum tambahan itu terjadi — dan untuk posisi dari
 * versi lama — yang ada hanya `planned_initial_margin` (margin awal saat entry).
 * Tidak ada angka yang ditebak: kalau dua-duanya tidak ada, hasilnya null.
 */
const r2 = (n) => Number((Number(n) || 0).toFixed(2));

export function positionMarginUsd(t) {
  const isolated = Number(t?.isolated_margin_usd);
  if (t?.isolated_margin_usd != null && Number.isFinite(isolated) && isolated > 0) return r2(isolated);
  return Number.isFinite(Number(t?.planned_initial_margin)) ? r2(t.planned_initial_margin) : null;
}
