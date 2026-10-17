import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReplay, frameAt } from '../assets/grokbot-timeline.mjs';
import { closeKind, exitRuleText, isPartial, isTrail, planText, stopCell, stopCellText } from '../assets/grokbot-rules.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const MINUS = '−';

test('alasan keluar memakai kode feed, level, dan reason_legacy', () => {
  const codes = {
    stop: ['STOP', 'skip'],
    stop_loss: ['STOP', 'skip'],
    breakeven_floor: ['BE FLOOR', 'tp'],
    'floor_+50': ['FLOOR +50', 'tp'],
    trail_runner: ['TRAIL', 'tp'],
    stale_72h: ['STALE 72H', 'close'],
    max_168h: ['MAX 168H', 'close'],
    liquidity: ['LIQUIDITY', 'close'],
    take_profit: ['TP', 'tp'],
    time_exit: ['TIME EXIT', 'close'],
  };
  for (const [reason, kind] of Object.entries(codes)) {
    assert.deepEqual(closeKind({ reason }), kind, reason);
    assert.equal(isPartial({ reason }), false, reason);
  }
  assert.deepEqual(closeKind({ reason: '', reason_legacy: 'stop_loss' }), ['STOP', 'skip']);
  assert.deepEqual(closeKind({ reason: 'manual', reason_legacy: 'time_exit' }), ['TIME EXIT', 'close']);
  assert.deepEqual(closeKind({ reason: 'take_profit', reason_legacy: 'stop' }), ['TP', 'tp']);
  assert.deepEqual(closeKind({ reason: 'weird', reason_legacy: 'stale_72h' }), ['STALE 72H', 'close']);
  assert.deepEqual(closeKind({ level: 'tp2', reason: 'stop' }), ['TP2', 'tp']);
  assert.deepEqual(closeKind({ level: 'TP3', reason: 'max_168h' }), ['TP3', 'tp']);
  assert.equal(isPartial({ level: 'tp1', reason: 'stop' }), true);
  assert.equal(isPartial({ level: 'tp3' }), true);
  assert.deepEqual(closeKind({ reason: 'take_profit', reasonDetail: 'Jual separuh di +50%' }), ['TP1 (legacy)', 'tp']);
  assert.equal(isPartial({ reasonDetail: 'jual separuh dulu' }), true);
  assert.equal(isTrail({ reason: 'trail_runner' }), true);
  assert.equal(isTrail({ reason: 'manual', reasonDetail: 'trailing stop setelah TP1' }), true);
  assert.deepEqual(closeKind({ reason: 'manual', reasonDetail: 'trailing stop setelah TP1' }), ['TRAIL', 'tp']);
  assert.deepEqual(closeKind({ reason: 'stop_loss', reasonDetail: 'trailing stop setelah TP1' }), ['STOP', 'skip']);
  assert.equal(isTrail({ reason: 'stop' }), false);
  assert.deepEqual(closeKind({ reason: 'manual' }), ['CLOSE', 'close']);
});

test('stop tidak menulis minus ganda, dan tanpa ladder tidak mengarang trail', () => {
  for (const stopPct of [-30, 30]) {
    const text = stopCellText({ stopPct, targetPct: 30, peakPct: 80, strategy: 'trailing stop' });
    assert.equal(text, `${MINUS}30% / +30%`);
    assert.doesNotMatch(text, /−-|−−/);
  }
  assert.equal(stopCellText({ stopPct: null, targetPct: null, peakPct: 80, strategy: 'trailing' }), '');
  assert.equal(stopCell({ peakPct: 80, strategy: 'trailing stop' }).mode, 'empty');
  assert.equal(stopCellText({ ladder: {}, stopPct: -30, targetPct: 100 }), `${MINUS}30% / +100%`);
  assert.equal(stopCellText({ ladder: 'bukan objek', stopPct: 30, targetPct: null }), `${MINUS}30%`);
  assert.equal(stopCellText({ ladder: { entry_mode_label: 'copy' }, stopPct: 30, targetPct: 30 }), `${MINUS}30% / +30%`);
});

test('sel ladder hanya menampilkan bidang yang terbit', () => {
  const text = stopCellText({
    stopPct: -30,
    targetPct: 30,
    peakPct: 180,
    ladder: {
      label: 'TP2 hit · floor +50%',
      level: 'tp2',
      floor: '+50%',
      exit_line_pct: -30,
      exit_line_kind: 'floor',
      next_tp: 'TP3',
      next_tp_pct: 300,
      runner_trail_pct: -30,
      hits: ['tp1', 'tp2'],
      entry_mode_label: 'copy',
    },
  });
  assert.match(text, /TP2 hit · floor \+50%/);
  assert.match(text, /floor \+50%/);
  assert.match(text, /exit −30% floor/);
  assert.match(text, /next TP3 \+300%/);
  assert.match(text, /trail −30%/);
  assert.match(text, /hits tp1, tp2/);
  assert.doesNotMatch(text, /−-|−−|copy|30% \/ \+30%/);
  const thin = stopCellText({ ladder: { level: 'tp1', floor: 'entry', next_tp: 'TP2' } });
  assert.match(thin, /TP1/);
  assert.match(thin, /floor entry/);
  assert.match(thin, /next TP2/);
  assert.doesNotMatch(thin, /trail|hits|exit |\+30%|\+100%|\+300%/);
  assert.equal(exitRuleText({ exit_ladder: { text: '  TP1 +30% jual 30%, lalu floor di harga isi.  ' } }), 'TP1 +30% jual 30%, lalu floor di harga isi.');
  assert.equal(exitRuleText({}), null);
  assert.equal(exitRuleText({ exit_ladder: {} }), null);
  assert.equal(exitRuleText({ exit_ladder: { text: '   ' } }), null);
  assert.equal(planText({ bookLabel: 'low', firstWallet: 'anon', ladder: { entry_mode_label: 'copy' } }), 'low · copy · via anon');
  assert.doesNotMatch(planText({ book: 'low', partial: true, ladder: { label: 'TP1 selesai' } }), /TP1 selesai|25%/);
});

test('replay memakai level sebagai jual sebagian dan tidak mengarang ladder sebelum snapshot', () => {
  const live = {
    updatedAt: 1_000_000,
    totalUsd: 1200,
    trading: { initialUsd: 1000, startedAt: 0, cashUsd: 100 },
    exit_ladder: { text: '  staged ladder  ' },
    positions: [
      {
        symbol: 'RUN', bookLabel: 'low', costUsd: 20, valueUsd: 50, pnlUsd: 30, pnlPct: 150,
        ageMinutes: 10, stopPct: null, targetPct: null, peakPct: 180, strategy: 'trailing', firstWallet: 'anon',
        ladder: { label: 'TP2 hit', level: 'tp2', floor: '+50%', runner_trail_pct: 30, hits: ['tp1', 'tp2'], entry_mode_label: 'copy', wallet: 'should-not-copy' },
      },
      { symbol: 'PLAIN', bookLabel: 'degen', costUsd: 15, valueUsd: 12, pnlUsd: -3, pnlPct: -20, ageMinutes: 4, stopPct: -30, targetPct: 30, ladder: {} },
      { symbol: 'GLOW', bookLabel: 'low', costUsd: 8, valueUsd: 9, pnlUsd: 1, pnlPct: 12, ageMinutes: 2, stopPct: null, targetPct: null, peakPct: 80, strategy: 'trailing stop' },
    ],
  };
  const closes = [
    { symbol: 'RUN', investedUsd: 30, netUsd: 9, netPct: 30, holdMinutes: 2, closedAt: 500_000, level: 'tp1', reason: 'stop', reasonDetail: 'tp1' },
    { symbol: 'RUN', investedUsd: 25, netUsd: 25, netPct: 100, holdMinutes: 5, closedAt: 700_000, level: 'tp2', reason: 'take_profit' },
    { symbol: 'OLD', investedUsd: 10, netUsd: 4, netPct: 40, holdMinutes: 1, closedAt: 200_000, reason: 'take_profit', reasonDetail: 'Jual separuh di +40%' },
    { symbol: 'OLD', investedUsd: 10, netUsd: -3, netPct: -30, holdMinutes: 4, closedAt: 380_000, reason: 'stop', reason_legacy: 'stop_loss' },
    { symbol: 'TR', investedUsd: 10, netUsd: 8, netPct: 80, holdMinutes: 3, closedAt: 600_000, reason: 'trail_runner' },
    { symbol: 'ST', investedUsd: 10, netUsd: -4, netPct: -40, holdMinutes: 2, closedAt: 450_000, reason: 'weird', reason_legacy: 'stale_72h' },
  ];
  const replay = buildReplay(live, { points: [{ t: 100_000, usd: 1000 }] }, closes);
  const tp1 = replay.events.find((e) => e.symbol === 'RUN' && e.t === 500_000);
  assert.equal(tp1.type, 'partial');
  assert.equal(tp1.level, 'tp1');
  assert.equal(replay.events.find((e) => e.symbol === 'OLD' && e.t === 200_000).type, 'partial');
  const trail = replay.events.find((e) => e.symbol === 'TR' && e.type === 'close');
  assert.equal(trail.reason, 'trail_runner');
  const stale = replay.events.find((e) => e.symbol === 'ST' && e.type === 'close');
  assert.equal(stale.reason_legacy, 'stale_72h');
  assert.deepEqual(closeKind(stale), ['STALE 72H', 'close']);
  assert.deepEqual(closeKind(replay.events.find((e) => e.symbol === 'OLD' && e.t === 200_000)), ['TP1 (legacy)', 'tp']);

  const afterTp1 = frameAt(replay, 500_000);
  const run = afterTp1.positions.find((p) => p.symbol === 'RUN');
  assert.ok(run);
  assert.equal(run.partial, true);
  assert.equal(run.cost, 45);
  assert.equal(run.ladder, null);
  assert.equal(afterTp1.exitRule, null);
  assert.equal(stopCellText(run), '');

  const afterTp2 = frameAt(replay, 700_000);
  assert.equal(afterTp2.positions.find((p) => p.symbol === 'RUN').cost, 20);
  assert.equal(afterTp2.positions.find((p) => p.symbol === 'TR'), undefined);
  assert.equal(afterTp2.positions.find((p) => p.symbol === 'OLD'), undefined);

  const end = frameAt(replay, 1_000_000);
  const marked = end.positions.find((p) => p.symbol === 'RUN');
  assert.equal(marked.ladder.level, 'tp2');
  assert.equal(marked.ladder.wallet, undefined);
  assert.match(stopCellText(marked), /trail −30%/);
  assert.match(stopCellText(marked), /hits tp1, tp2/);
  assert.equal(planText(marked), 'low · copy · via anon');
  assert.equal(stopCellText(end.positions.find((p) => p.symbol === 'PLAIN')), `${MINUS}30% / +30%`);
  assert.equal(stopCellText(end.positions.find((p) => p.symbol === 'GLOW')), '');
  assert.equal(end.exitRule, 'staged ladder');
  assert.doesNotMatch(JSON.stringify(end), /should-not-copy|turun 25%|TP1 selesai/);
});

test('skrip dashboard tidak lagi mengunci trail 75% atau teks aturan lama', () => {
  const js = read('assets/grokbot.js');
  assert.doesNotMatch(js, /TRAIL_KEEP|trailPct|turun 25%|TP1 selesai|TP1 sudah jual/);
  assert.doesNotMatch(read('assets/grokbot-timeline.mjs'), /TRAIL_KEEP|turun 25%|TP1 selesai/);
  assert.doesNotMatch(read('assets/grokbot-rules.mjs'), /TRAIL_KEEP|0\.75|turun 25%|TP1 selesai/);
  for (const page of ['grokbot/solana/index.html', 'grokbot/robinhood/index.html']) {
    const html = read(page);
    assert.match(html, /Stop \/ ladder/);
    assert.match(html, /id="exitRule"/);
    assert.match(html, /script-src 'self'/);
    assert.doesNotMatch(html, /Stop \/ trailing/);
  }
});
