import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-19T06:00:00Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60e3).toISOString();
const MINT = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

function source(over = {}) {
  return {
    schema: 'devil-greed-live-solana/v1', label: 'label bot yang tidak dipakai', mode: 'LIVE', halt_reason: null,
    as_of: iso(2), started_at: iso(3000), start_capital_usd: 107, start_capital_sol: 1.016, sol_price_usd: 105.3,
    cash_usd: 60, equity_usd: 96.3,
    equity_curve: [{ t: iso(60), equity_usd: 107 }, { t: iso(30), equity_usd: 101 }, { t: iso(2), equity_usd: 96.3 }],
    positions: [{ symbol: 'WIF', name: `wif ${MINT}`, chart_url: `https://dexscreener.com/solana/${MINT}`, opened_at: iso(90), entry_price_usd: 0.000012345678, mark_price_usd: 0.000015, size_usd: 16, value_usd: 19.4, pnl_usd: 3.4, pnl_pct: 21.2, tp_stage: 1, tp_stages_total: 3, stop_price_usd: 0.0000086 }],
    closed_trades: [
      { symbol: 'AAA', chart_url: null, opened_at: iso(500), closed_at: iso(400), entry_price_usd: 1, exit_price_usd: 0.7, pnl_usd: -4.8, pnl_pct: -30, exit_reason: 'STOP', simulated: false },
      { symbol: 'BBB', chart_url: null, opened_at: iso(300), closed_at: iso(200), entry_price_usd: 1, exit_price_usd: 1.5, pnl_usd: 8, pnl_pct: 50, exit_reason: 'TP', simulated: true },
    ],
    guards: { ticket_pct: 15, stop_pct: -30, daily_halt_pct: -15, total_halt_pct: -40, daily_pnl_pct: -4, daily_room_pct: 11, drawdown_pct: 10, stop_button: false },
    disclaimer: `Uang asli; tx ${SIG}`,
    ...over,
  };
}
function run(src, now = NOW, dir = mkdtempSync(join(tmpdir(), 'solbot-'))) {
  const file = join(dir, 'src.json');
  if (src !== undefined) writeFileSync(file, typeof src === 'string' ? src : JSON.stringify(src));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-solbot.mjs')], {
    env: { ...process.env, CASHOOD_DATA_DIR: join(dir, 'data'), SOLBOT_SRC: file, SOLBOT_NOW: String(now) }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(dir, 'data', 'solbot', 'live.json'), 'utf8'));
}

test('solbot: berkas belum ada → waiting tanpa angka', () => {
  const d = run(undefined);
  assert.equal(d.status, 'waiting');
  assert.equal(d.equityUsd, undefined);
});

test('solbot: skema lain atau JSON rusak → waiting', () => {
  assert.equal(run(source({ schema: 'devil-greed-paper/v1' })).status, 'waiting');
  assert.equal(run('{rusak').status, 'waiting');
});

test('solbot: as_of lebih dari 15 menit → stale, angka terakhir tetap ada', () => {
  const d = run(source({ as_of: iso(16) }));
  assert.equal(d.status, 'stale');
  assert.equal(d.reason, 'Data tertunda');
  assert.ok(d.equityUsd != null && Array.isArray(d.positions));
});

test('solbot: as_of lebih dari 7 hari → stale tanpa angka', () => {
  const d = run(source({ as_of: iso(7 * 24 * 60 + 1) }));
  assert.equal(d.status, 'stale');
  for (const k of ['equityUsd', 'positions', 'closedTrades', 'guards', 'equityCurve']) assert.equal(d[k], undefined, k);
});

test('solbot: data ok — angka, harga kecil, ringkasan real vs simulasi', () => {
  const d = run(source());
  assert.equal(d.status, 'ok');
  assert.equal(d.mode, 'LIVE');
  assert.equal(d.realMoney, true);
  assert.equal(d.changeUsd, -10.7);
  assert.equal(d.changePct, -10);
  assert.equal(d.positions[0].entryPriceUsd, 0.0000123457);
  assert.equal(d.positions[0].tpStage, 1);
  assert.equal(d.closedTrades[0].symbol, 'BBB');            // terbaru dulu
  assert.equal(d.closedTrades[0].simulated, true);
  assert.equal(d.closedStats.real.count, 1);
  assert.equal(d.closedStats.real.pnlUsd, -4.8);
  assert.equal(d.closedStats.simulated, 1);
  assert.equal(d.guards.stopButton, false);
});

test('solbot: tanpa alamat mint, signature, chart_url, atau label', () => {
  const raw = JSON.stringify(run(source()));
  assert.ok(!raw.includes(MINT));
  assert.ok(!raw.includes(SIG));
  assert.ok(!/chart|dexscreener|label bot/i.test(raw));
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{32,}/.test(raw));
});

test('solbot: mode tak dikenal tidak ditebak', () => {
  assert.equal(run(source({ mode: 'turbo' })).mode, null);
  assert.equal(run(source({ mode: 'halted', halt_reason: 'halt harian -15%' })).haltReason, 'halt harian -15%');
});

test('funds.json: SolBot di High risk tanpa badge', () => {
  const f = JSON.parse(readFileSync(join(ROOT, 'data', 'funds.json'), 'utf8'));
  assert.equal(f.solbot.label, 'SolBot');
  assert.equal(f.solbot.risk, 'high');
  assert.equal(f.solbot.badge, undefined);
  assert.ok(!f.funds.some((x) => x.id === 'solbot'), 'SolBot bukan dana investor dan tidak masuk index');
});

test('solbot: field tambahan — arus dana, 24 jam, strategi', () => {
  const d = run(source({
    equity_curve: [{ t: iso(26 * 60), equity_usd: 100 }, { t: iso(23 * 60), equity_usd: 104 }, { t: iso(2), equity_usd: 146.3 }],
    equity_usd: 146.3, flows: [{ t: iso(60), usd: 50, type: 'deposit' }, { t: iso(30), usd: 5, type: 'aneh' }],
    realized_pnl_usd: -3.2, unrealized_pnl_usd: 1.1, fees_usd: 0.9, strategy: `Beli meme coin baru ${MINT}`,
    stats: { trades_total: 40, wins: 18, losses: 22, win_rate_pct: 45 },
  }));
  assert.equal(d.netFlowUsd, 50);
  assert.equal(d.basisUsd, 157);
  assert.equal(d.changeUsd, -10.7);
  assert.equal(d.change24hUsd, -7.7);                       // 146.3 − 50 setoran − 104 (titik 23 jam lalu)
  assert.equal(d.flows.length, 1);
  assert.equal(d.totals.trades, 40);
  assert.ok(!d.strategy.includes(MINT));
});

test('solbot: flows dengan nama field at/amount_usd/amount_sol juga dihitung sebagai modal', () => {
  const d = run(source({ equity_usd: 125.3, flows: [{ at: iso(30), type: 'deposit', amount_usd: 29, amount_sol: 0.27, note: 'modal masuk' }] }));
  assert.equal(d.netFlowUsd, 29);
  assert.equal(d.basisUsd, 136);
  assert.equal(d.changeUsd, -10.7);
});

test('solbot: sleeve (degen/low) ikut terbit di posisi dan trade tertutup', () => {
  const src = source();
  src.positions[0].sleeve = 'Degen';
  src.closed_trades[0].sleeve = 'low';
  const d = run(src);
  assert.equal(d.positions[0].sleeve, 'degen');
  assert.equal(d.closedTrades.find((c) => c.symbol === 'AAA').sleeve, 'low');
});

test('solbot: kiriman rusak sesudah data sah → angka terakhir dipertahankan (stale)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solbot-'));
  const ok = run(source(), NOW, dir);
  assert.equal(ok.status, 'ok');
  const d = run('{rusak', NOW + 60e3, dir);
  assert.equal(d.status, 'stale');
  assert.equal(d.equityUsd, ok.equityUsd);
  assert.equal(d.asOf, ok.asOf);
});
