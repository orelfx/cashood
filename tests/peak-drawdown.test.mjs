import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPeakDrawdown, peakRows, groupStats } from '../scripts/lib/peak-drawdown.mjs';

const T = (h) => new Date(Date.parse('2026-10-06T00:00:00Z') + h * 3600e3).toISOString();
const entries = [
  // Sebelum 6 Okt: tanpa data puncak/terendah → tidak ikut sama sekali.
  { position: 'P'.repeat(44), base_mint: 'M'.repeat(44), pool_name: 'OLD-SOL', close_pnl_pct: 3, close_ts: T(-30) },
  { position: 'A1', pool_name: 'ASH-SOL', book: 'mid', close_pnl_pct: 3.2, close_ts: T(5), peak_pnl_pct: 6, peak_at: T(4), max_drawdown_pct: -12, max_drawdown_at: T(2), drawdown_tracked_since: T(0), realized_pnl_usd: 10.5, exit_detail: 'Target untung tercapai.' },
  { position: 'A2', pool_name: 'ASH-SOL', book: 'mid', close_pnl_pct: -4, close_ts: T(9), peak_pnl_pct: 2, peak_at: T(6), max_drawdown_pct: -8, max_drawdown_at: T(8), drawdown_tracked_since: T(5) },
  // Titik terendah tidak diketahui (null) → tidak dihitung sebagai 0.
  { position: 'A3', pool_name: 'ASH-SOL', book: 'mid', close_pnl_pct: 1, close_ts: T(12), peak_pnl_pct: 4, peak_at: T(11), max_drawdown_pct: null, max_drawdown_at: null, drawdown_tracked_since: null },
  { position: 'B1', pool_name: 'BIG-SOL', book: 'bigcap', close_pnl_pct: 2, close_ts: T(7), peak_pnl_pct: 3, peak_at: T(6), max_drawdown_pct: -2, max_drawdown_at: T(6.5), drawdown_tracked_since: T(3) },
];
const opened = { A1: Date.parse(T(0)), A2: Date.parse(T(1)), A3: Date.parse(T(10)), B1: Date.parse(T(3)) };

test('hanya posisi dengan data puncak/terendah; alamat tidak ikut terbit', () => {
  const rows = peakRows(entries, (e) => opened[e.position] ?? null);
  assert.equal(rows.length, 4);
  assert.equal(JSON.stringify(rows).includes('P'.repeat(44)), false);
  assert.equal(JSON.stringify(rows).includes('M'.repeat(44)), false);
});

test('urutan puncak/terendah, parsial, dan null tetap null', () => {
  const rows = peakRows(entries, (e) => opened[e.position] ?? null);
  const by = Object.fromEntries(rows.map((r) => [r.closePct, r]));
  assert.equal(by[3.2].first, 'terendah');          // terendah jam 2, puncak jam 4
  assert.equal(by[-4].first, 'puncak');
  assert.equal(by[3.2].partial, false);              // dicatat sejak posisi dibuka
  assert.equal(by[-4].partial, true);                // dibuka jam 1, dicatat mulai jam 5
  assert.equal(by[1].ddPct, null);                   // tidak diketahui, bukan 0
  assert.equal(by[1].first, null);
});

test('ringkasan per basket: rata-rata/median, null dikecualikan, pulih dari ≤ −10%', () => {
  const pd = buildPeakDrawdown(entries, (e) => opened[e.position] ?? null);
  const mid = pd.books.find((b) => b.label === 'Mid');
  assert.equal(mid.closes, 3);
  assert.equal(mid.avgPeak, 4);                      // (6 + 2 + 4) / 3
  assert.equal(mid.medPeak, 4);
  assert.equal(mid.avgDd, -10);                      // (−12 + −8) / 2 — null tidak jadi 0
  assert.equal(mid.ddKnown, 2);
  assert.equal(mid.worstDd, -12);
  assert.equal(mid.recovered, 1);                    // ASH −12% lalu +3,2%
  assert.equal(mid.medClose, 1);
  assert.equal(pd.books.find((b) => b.label === 'Big cap').closes, 1);
});

test('per koin hanya yang minimal 3 penutupan', () => {
  const pd = buildPeakDrawdown(entries, (e) => opened[e.position] ?? null);
  assert.deepEqual(pd.coins.map((c) => c.label), ['ASH-SOL']);
});

test('tanpa data sama sekali: struktur kosong, tidak gagal', () => {
  const pd = buildPeakDrawdown([{ pool_name: 'X', close_pnl_pct: 1, close_ts: T(1) }]);
  assert.deepEqual(pd.rows, []);
  assert.equal(groupStats([]).avgPeak, null);
});
