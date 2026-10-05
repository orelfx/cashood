import { test } from 'node:test'; import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path'; import { tmpdir } from 'node:os'; import { spawnSync } from 'node:child_process';

// Bentuk berkas yang dikirim SnipeHunt (lihat /root/cashood-inbox/snipehunt.json).
const iso = (ms) => new Date(ms).toISOString();
function book(now, extra = {}) {
  const start = now - 6 * 3600e3;
  return {
    schema: 1, label: 'SnipeHunt', as_of: iso(now), started_at: iso(start), initial_usd: 1000,
    cash_usd: 940, equity_usd: 1002.5, pnl_usd: 2.5, realized_usd: 4, unrealized_usd: -1.5, peak_equity_usd: 1010,
    positions: [
      { symbol: 'BONK', sleeve: 'degen', opened_at: iso(now - 3600e3), notional_usd: 25, unrealized_usd: -1.5, entry_price_usd: 0.00002, mark_price_usd: 0.0000188,
        quantity: 1250000, stop_pct: 25, targets: [{ pct: 40, size_pct: 50, hit: true }, { pct: 120, size_pct: 50, hit: false }], trailing: false,
        wallets_joined: 3, wallet_labels: ['smart', 'kol', 'smart'], thesis: '3 wallet smart membeli dalam 12 menit', llm_verdict: 'kelompok wallet sehat', stale: false },
      { symbol: 'WIF', sleeve: 'mid', opened_at: iso(now - 1800e3), notional_usd: 39, unrealized_usd: 0, entry_price_usd: 2.1, mark_price_usd: null, stale: true, wallets_joined: 2 },
    ],
    closed_trades: [
      { symbol: 'POPCAT', sleeve: 'low', opened_at: iso(now - 5 * 3600e3), closed_at: iso(now - 4 * 3600e3), notional_usd: 40, realized_usd: 6, realized_pct: 15, fees_usd: 0.1, exit_reason: 'follow exit', wallets_joined: 3 },
      { symbol: 'MEW', sleeve: 'degen', opened_at: iso(now - 3 * 3600e3), closed_at: iso(now - 2 * 3600e3), notional_usd: 20, realized_usd: -2, realized_pct: -10, exit_reason: 'stop' },
    ],
    equity_history: [{ t: iso(start + 3600e3), equity_usd: 1001 }, { t: iso(start + 2 * 3600e3), equity_usd: 1004 }],
    bot: { status: 'running', version: 'v3', model: 'MiniMax-M2.7', last_scan_at: iso(now - 60e3), last_decision: 'masuk BONK: 3 wallet smart', activity_24h: { signals: 7, vetoed: 2, entered: 3, closed: 2 } },
    baskets: [{ id: 'degen', label: 'degen (launch)', alloc_pct: 50, seat_pct: 2.5, open: 1, cap: 500 }],
    wallets: { tracked: 1344, active: 103, by_label: { smart: 484, kol: 86, lp: 0 } },
    rules: ['Masuk hanya saat beberapa wallet terverifikasi membeli coin yang sama.', 'Dry run: semua transaksi simulasi.'],
    about: 'SnipeHunt tidak menebak coin.',
    reserve_pct: 5,
    reason_stats_24h: { test: { solo: 2, explore: 1 }, solo_entries: 3, exit: { rotation: 1 } },
    ...extra,
  };
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cashood-paper-')), data = join(root, 'data');
  mkdirSync(join(data, 'snh'), { recursive: true });
  copyFileSync(resolve('data/snh/config.json'), join(data, 'snh/config.json'));
  const run = (src) => { const f = join(root, 'snipehunt.json'); writeFileSync(f, JSON.stringify(src));
    return spawnSync(process.execPath, [resolve('scripts/import-paper-book.mjs'), 'snh', f], { env: { ...process.env, CASHOOD_DATA_DIR: data }, encoding: 'utf8', timeout: 15000 }); };
  return { root, data, run };
}

test('SnipeHunt: berkas copy-trade diimpor apa adanya, alasan keluar diterjemahkan, basket/wallet/aturan ikut terbit', () => {
  const f = setup(); try {
    const now = Date.now(), r = f.run(book(now)); assert.equal(r.status, 0, r.stderr);
    const live = JSON.parse(readFileSync(join(f.data, 'snh/live.json'), 'utf8'));
    assert.equal(live.totalUsd, 1002.5); assert.equal(live.trading.paper, true);
    const bonk = live.positions.find((p) => p.symbol === 'BONK');
    assert.equal(bonk.targetPct, 120, 'target berikutnya = target pertama yang belum kena');
    assert.match(bonk.strategy, /ikut 3 wallet \(smart, kol\)/); assert.match(bonk.thesis, /LLM: kelompok wallet sehat/);
    assert.equal(live.positions.find((p) => p.symbol === 'WIF').stale, true);
    assert.equal(live.stats.closedCount, 2);
    const days = readdirSync(join(f.data, 'snh/trades')); const rows = days.flatMap((d) => JSON.parse(readFileSync(join(f.data, 'snh/trades', d), 'utf8')).rows);
    assert.equal(rows.find((x) => x.symbol === 'POPCAT').reason, 'ikut wallet keluar'); assert.equal(rows.find((x) => x.symbol === 'POPCAT').netPct, 15);
    assert.equal(rows.find((x) => x.symbol === 'MEW').reason, 'stop loss');
    assert.ok(live.trading.tiles.some((t) => t.k === 'Sinyal wallet' && t.v === '7'));
    assert.deepEqual(live.strategy.ruleList.length, 2); assert.equal(live.strategy.requirementsTitle, 'Basket modal');
    assert.ok(live.strategy.system.some(([k, v]) => k === 'Label wallet' && /smart 484/.test(v) && !/lp/.test(v)));
    assert.equal(live.trading.llm.lastReason, 'masuk BONK: 3 wallet smart');
    // Tahap 3: angka tunggal (solo_entries) tidak hilang; cadangan kas ikut terbit.
    assert.deepEqual(live.copyTrade.reasonStats.solo_entries, { jumlah: 3 });
    assert.equal(live.copyTrade.reasonStats.test.explore, 1);
    assert.ok(live.strategy.system.some(([k, v]) => k === 'Cadangan kas' && /5%/.test(v)));
    const nav = JSON.parse(readFileSync(join(f.data, 'snh/nav.json'), 'utf8')).points;
    assert.ok(nav.some((p) => p.usd === 1004), 'riwayat equity dari bot masuk ke deret nilai');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('SnipeHunt: berkas berisi alamat atau equity yang tidak cocok ditolak tanpa menulis apa pun', () => {
  const f = setup(); try {
    const now = Date.now();
    const leak = book(now, { about: 'lihat wallet 8DzzczUygbh47yEKvgfjzCyAjeB3tqMCeFoeB5nfAu' });
    // Teks bebas dipangkas, jadi alamat di `about` tidak terbit sama sekali.
    assert.equal(f.run(leak).status, 0);
    assert.equal(readFileSync(join(f.data, 'snh/live.json'), 'utf8').includes('8DzzczUygbh47'), false);
    const bad = book(now + 1000, { equity_usd: 1500 });
    const before = readFileSync(join(f.data, 'snh/live.json'), 'utf8');
    assert.notEqual(f.run(bad).status, 0); assert.equal(readFileSync(join(f.data, 'snh/live.json'), 'utf8'), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
