import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildTokens, walletTotal, mapExcluded } from '../scripts/lib/gmsol-tokens.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-10-21T12:00:00Z');
const src = (over = {}) => ({ fund: 'gmsol', mode: 'live', updatedAt: new Date(NOW - 60e3).toISOString(), t0At: new Date(NOW - 3600e3).toISOString(),
  // r4.1: modal dikunci mesin saat deploy (tanpa ini sync menunggu).
  capitalUsd: 1200, capitalUsdAtDeploy: { usd: 1200, lockedAt: new Date(NOW - 3600e3).toISOString(), solUsd: 100, freeSol: 12, reserveSol: 0 },
  equityLedgerUsd: 1195.5, walletSolShared: { sol: 8.7, label: 'dipakai bersama Meridian' }, sizing: { sizeUsd: 50, maxOpen: 5 }, brakes: { dailyPct: 25, totalFloorUsd: 600, halted: false }, openSeats: [{ symbol: 'ABC-SOL', basisUsd: 50 }], closeHistory: [{ symbol: 'XYZ-SOL', netUsd: 1 }], ...over });
function run(source, { passed = false, now = NOW, engine = '/nonexistent-gmsol' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gmsol-')), data = join(dir, 'data'), file = join(dir, 'src.json');
  mkdirSync(join(data, 'gmsol'), { recursive: true });
  if (passed) writeFileSync(join(data, 'gmsol', 'test-passed.local'), '');
  if (source !== undefined) writeFileSync(file, JSON.stringify(source));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-gmsol.mjs')], { env: { ...process.env, CASHOOD_DATA_DIR: data, GMSOL_SRC: file, GMSOL_NOW: String(now), GMSOL_ENGINE_DIR: engine }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(data, 'gmsol', 'live.json'), 'utf8'));
}

test('gmsol v3: kinerja dari equityLedgerUsd, wallet hanya info bersama', () => {
  const d = run(src({ preDeployHistory: [{ atWib: 'x', type: 'pre_deploy_close', symbol: 'PANGEA/SOL', resultUsd: -17.6, note: 'dibuka meridian2' }], excludedTokens: { valueUsd: 0, items: [{ label: 'token#0', kind: 'spl_token', symbol: 'A', units: 1, readUsd: 5 }] }, equityUsd: 900, specStatus: 'DRAFT', solPriceUsd: 100 }));
  assert.ok(!JSON.stringify(d).includes('DRAFT')); assert.equal(d.walletSolShared, undefined);
  assert.equal(d.status, 'ok'); assert.equal(d.risk, 'high');
  assert.equal(d.equityUsd, 1195.5); assert.equal(d.pnlUsd, -4.5);
  assert.equal(d.headline.usd, 1195.5); assert.equal(d.headline.pnlUsd, -4.5); assert.equal(d.headline.source, 'engine.equityUsd');
  assert.equal(d.preDeployHistory[0].resultUsd, -17.6); assert.equal(d.preDeployHistory[0].inPnl, false); assert.equal(d.preDeployHistory[0].note, null); assert.equal(d.pnlUsd, -4.5);
  assert.equal(d.excludedTokens.count, 1); assert.equal(d.excludedTokens.items[0].valueUsd, 0); assert.equal(d.excludedTokens.items[0].readUsd, undefined);
  assert.equal(d.brakes.totalFloorUsd, 600); assert.equal(d.sizing.maxOpen, 5);
  assert.equal(d.openSeats.length, 1); assert.equal(d.closes.length, 1);
});
test('gmsol: v2 lama, basi, bukan live, tanpa berkas, ledger null → tanpa angka', () => {
  const { equityLedgerUsd, ...v2 } = src();
  for (const d of [run({ ...v2, equityUsd: 942 }), run(src({ updatedAt: new Date(NOW - 20 * 60e3).toISOString() })), run(src({ mode: 'dry_run' })), run(undefined), run(src({ equityLedgerUsd: null }))]) {
    assert.equal(d.status, 'waiting'); assert.equal(d.equityUsd, undefined); assert.equal(d.pnlUsd, undefined);
  }
});
test('gmsol: data live basi → mesin berhenti, tanpa angka, waktu terakhir tetap ada', () => {
  const at = NOW - 30 * 60e3, d = run(src({ updatedAt: new Date(at).toISOString() }));
  assert.equal(d.status, 'waiting'); assert.equal(d.reason, 'Mesin berhenti, menunggu restart');
  assert.equal(d.asOf, at); assert.equal(d.equityUsd, undefined); assert.equal(d.openSeats, undefined);
});
test('gmsol: ringkasan screening dari scan terakhir, t0 dari state engine, tanpa alamat', () => {
  const eng = mkdtempSync(join(tmpdir(), 'gmeng-')); mkdirSync(join(eng, 'logs')); mkdirSync(join(eng, 'state'));
  writeFileSync(join(eng, 'state', 'live.json'), JSON.stringify({ created: '2026-10-22T03:34:29.332Z' }));
  const old = '2026-10-22T07:37:00.000Z', last = '2026-10-22T07:42:53.742Z', addr = '7b6dX3nE25xrfNViEKZHL9wVJFcBxQYuWPpmzHUxx28H';
  const rows = [{ ts: old, pool_symbol: 'OLD-SOL', reasons: ['pool.tvl=1 !>=10000'] },
    { ts: last, pool_symbol: '*', reasons: ['discovery_summary sol_dlmm=330 inactive_1h=122 tvl_zero=0'] },
    { ts: last, pool_symbol: 'AAA-SOL', bs: 100, reasons: ['pool.fee_active_tvl_ratio=0.5 !>=2'] },
    { ts: last, pool_symbol: 'BBB-SOL', bs: 80, reasons: ['pool.tvl=10 !>=10000', `pool.fee_active_tvl_ratio=0.1 !>=2 ${addr}`] }];
  writeFileSync(join(eng, 'logs', 'screen-2026-10-22.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const d = run(src({ t0At: null }), { engine: eng }), sc = d.screening;
  // r4.1: mulai live = waktu modal dikunci mesin (sebelum t0At / state engine).
  assert.equal(d.t0At, NOW - 3600e3);
  assert.equal(sc.scannedAt, Date.parse(last)); assert.equal(sc.solPools, 330); assert.equal(sc.checked, 2); assert.equal(sc.passed, 0);
  assert.deepEqual(sc.topReasons[0], { reason: 'pool.fee_active_tvl_ratio', pools: 2 });
  assert.equal(sc.closest[0].symbol, 'AAA-SOL'); assert.ok(!JSON.stringify(d).includes(addr)); assert.ok(!JSON.stringify(d).includes('OLD-SOL'));
});
test('gmsol wallet.tokens: simbol + jumlah + harga, tanpa alamat, id stabil, tanpa harga → null', () => {
  const A = '7b6dX3nE25xrfNViEKZHL9wVJFcBxQYuWPpmzHUxx28H', B = 'EHPugw1ghE46BeySAa7cHvoZHwYometbp1aK1Q7jpump', W = 'So11111111111111111111111111111111111111112';
  const ids = {};
  const r = buildTokens([{ mint: A, amount: 100 }, { mint: W, amount: 1 }, { mint: B, amount: 5 }, { mint: A, amount: 20 }, { mint: B, amount: 0 }],
    { [A]: { usdPrice: 0.5 } }, { [A]: { symbol: 'NITA' }, [B]: { symbol: `x${A}` } }, ids, [W]);
  assert.deepEqual(r.tokens[0], { id: 'token#1', symbol: 'NITA', amount: 120, priceUsd: 0.5, usd: 0, quotedUsd: 60, countedUsd: 0 });
  assert.deepEqual(r.tokens[1], { id: 'token#2', symbol: null, amount: 5, priceUsd: null, usd: 0, quotedUsd: null, countedUsd: 0 });
  assert.equal(r.tokens.length, 2); assert.equal(r.tokensUsd, 0); assert.equal(r.tokensQuotedUsd, 60); assert.equal(r.tokensUnpriced, 1);
  assert.ok(!/[1-9A-HJ-NP-Za-km-z]{32,}/.test(JSON.stringify(r)));
  // nomor tetap antar run, token baru dapat nomor berikutnya
  const r2 = buildTokens([{ mint: B, amount: 1 }, { mint: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', amount: 2 }], {}, {}, ids, [W]);
  assert.deepEqual(r2.tokens.map((t) => t.id), ['token#2', 'token#3']);
  assert.deepEqual(buildTokens([], {}, {}, {}, []), { tokens: [], tokensUsd: 0, tokensQuotedUsd: 0, tokensUnpriced: 0 });
  // token yang hilang (mis. di-swap ke SOL) cukup tidak muncul; nomor token lain tetap
  const r3 = buildTokens([{ mint: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', amount: 2 }], {}, {}, ids, [W]);
  assert.deepEqual(r3.tokens.map((t) => t.id), ['token#3']);
});
test('gmsol wallet.tokens: token tidak pernah mengubah nilai/headline/PnL', () => {
  const base = { solUsd: 100, lpUsd: 50, unclaimedUsd: 1.25 };
  const big = buildTokens([{ mint: 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', amount: 1e9 }], { DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD: { usdPrice: 5 } }, {}, {}, []);
  assert.equal(big.tokensQuotedUsd, 5e9); assert.equal(big.tokensUsd, 0); assert.ok(big.tokens.every((t) => t.usd === 0 && t.countedUsd === 0));
  assert.equal(walletTotal({ ...base, tokens: big.tokens, tokensUsd: big.tokensQuotedUsd }), 151.25);
  assert.equal(walletTotal(base), 151.25); assert.equal(walletTotal({ ...base, lpUsd: null }), null);
});

test('gmsol wallet.tokens: nomor token = label excludedTokens mesin (satu sumber)', () => {
  const items = [{ label: 'damm_v2_position_permanent_lock', kind: 'damm_v2_position_permanent_lock', symbol: 'NITA' },
    { label: 'token#0', kind: 'spl_token', symbol: 'AAA', units: 1e-6 }, { label: 'token#1', kind: 'spl_token', symbol: 'AAA', units: 500 }, { label: 'token#6', kind: 'spl_token', symbol: null, units: 2003 }];
  const out = mapExcluded([{ id: 'token#9', symbol: 'AAA', amount: 500, usd: 0 }, { id: 'token#2', symbol: 'ZZZ', amount: 2003, usd: 0 }, { id: 'token#3', symbol: 'AAA', amount: 0.000001, usd: 0 }, { id: 'token#4', symbol: 'NEW', amount: 7, usd: 0 }], items);
  assert.deepEqual(out.map((t) => t.id), ['token#1', 'token#6', 'token#0', null]);
  assert.deepEqual(out.map((t) => t.inExcluded), [true, true, true, false]);
  assert.ok(out.every((t) => t.usd === 0));
  assert.deepEqual(mapExcluded([], items), []);
});

test('gmsol r4.5: specDocStatus + tuningLabel di tingkat sistem, posisi terbuka apa adanya dari mesin, tanpa alamat', () => {
  const addr = '7b6dX3nE25xrfNViEKZHL9wVJFcBxQYuWPpmzHUxx28H';
  const d = run(src({ specDocStatus: 'audited_pass', tuningLabel: 'tuned_on_live_sample', tuningNote: 'catatan', tuningCashoodRequirement: 'wajib tampil',
    openSeats: [{ symbol: 'PHP-SOL', lane: 'meme', openedAt: new Date(NOW - 600e3).toISOString(), basisUsd: 54.54, pnlUsd: -0.15, pnlPct: -0.269, peakPct: -0.0537, troughPct: -0.2948,
      snaps: [[NOW - 300e3, -0.221], ['x', 1]], inRange: false, binStep: 100, bins: 70, shape: 'bid_ask', entryNote: 'lolos ' + addr, specRev: 'r4.4.1', sizeUsd: 50, rentSol: 0.0419 },
      { symbol: 'B-SOL', basisUsd: 1 }] }));
  assert.equal(d.specDocStatus, 'audited_pass'); assert.equal(d.tuningLabel, 'tuned_on_live_sample'); assert.equal(d.tuningNote, 'catatan');
  const p = d.openSeats[0], q = d.openSeats[1];
  assert.equal(p.symbol, 'PHP-SOL'); assert.equal(p.basisUsd, 54.54); assert.equal(p.pnlUsd, -0.15); assert.equal(p.inRange, false); assert.equal(p.bins, 70); assert.equal(p.shape, 'bid_ask');
  assert.equal(p.peakPct, -0.054); assert.equal(p.troughPct, -0.295); assert.equal(p.snaps.length, 1);
  // label tuning hanya di tingkat sistem; rev spec per posisi hanya bila mesin menulisnya
  assert.equal(p.tuningLabel, undefined); assert.equal(p.specRev, 'r4.4.1'); assert.equal(p.sizeUsd, 50); assert.equal(p.rentSol, 0.0419);
  assert.equal(q.specRev, null); assert.equal(q.sizeUsd, null); assert.equal(q.rentSol, null); assert.equal(q.status, null);
  // SOL-denominated hanya diteruskan bila mesin menulisnya
  assert.equal(d.equitySol, null); assert.equal(d.pnlSol, null);
  assert.equal(d.headline.usd, d.equityUsd); assert.ok(!JSON.stringify(d).includes(addr));
});
