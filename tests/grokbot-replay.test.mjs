import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildReplay, frameAt, stepTime, isBigClose } from '../assets/grokbot-timeline.mjs';

const live = {
  updatedAt: 1_000_000,
  totalUsd: 1100,
  trading: { initialUsd: 1000, startedAt: 0, cashUsd: 400 },
  positions: [{ symbol: 'AAA', bookLabel: 'low', costUsd: 10, valueUsd: 25, pnlUsd: 15, pnlPct: 150, ageMinutes: 5, stopPct: 30, targetPct: 30, strategy: 'copydesk' }],
  copyTrade: { decisions: [
    { at: 700_000, action: 'enter', symbol: 'AAA', reason: 'beli paper $10' },
    { at: 500_000, action: 'skip', symbol: 'ZZ', reason: 'full_book' },
    { at: 250_000, action: 'enter', symbol: 'tanpa simbol', reason: 'beli paper $9' },
  ] },
};
const nav = { points: [{ t: 800_000, usd: 1050 }, { t: 200_000, usd: 1000 }] };
const closes = [
  { symbol: 'BBB', investedUsd: 20, netUsd: 30, netPct: 50, holdMinutes: 5, closedAt: 400_000, reason: 'take_profit', reasonDetail: 'Jual separuh di +50%', strategy: 'low' },
  { symbol: 'BBB', investedUsd: 20, netUsd: 5, netPct: 25, holdMinutes: 10, closedAt: 700_000, reason: 'manual', reasonDetail: 'sisa', strategy: 'low' },
  { symbol: 'CCC', investedUsd: 40, netUsd: -10, netPct: -25, holdMinutes: 3, closedAt: 300_000, reason: 'stop_loss', reasonDetail: 'stop', strategy: 'degen' },
  { symbol: 'DDD', investedUsd: 5, netUsd: 1, netPct: 10, closedAt: 600_000, reason: 'manual', reasonDetail: 'keluar' },
];

const replay = buildReplay(live, nav, closes);

test('kejadian terurut dan hanya jenis yang nyata', () => {
  const times = replay.events.map((e) => e.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(replay.events.every((e) => ['nav', 'open', 'partial', 'close'].includes(e.type)));
  const same = replay.events.filter((e) => e.t === 700_000).map((e) => e.type);
  assert.deepEqual(same, [...same].sort((a, b) => ({ open: 0, partial: 1, close: 2, nav: 3 })[a] - ({ open: 0, partial: 1, close: 2, nav: 3 })[b]));
});

test('tidak ada kejadian karangan', () => {
  const navEvents = replay.events.filter((e) => e.type === 'nav');
  assert.deepEqual(navEvents.map((e) => [e.t, e.usd]), [[200_000, 1000], [800_000, 1050], [1_000_000, 1100]]);
  assert.equal(navEvents.at(-1).source, 'live');
  const tradeEvents = replay.events.filter((e) => e.type === 'partial' || e.type === 'close');
  assert.equal(tradeEvents.length, closes.length);
  assert.equal(tradeEvents.filter((e) => e.type === 'partial').length, 1);
  assert.deepEqual(tradeEvents.map((e) => e.symbol).sort(), ['BBB', 'BBB', 'CCC', 'DDD']);
  const opens = replay.events.filter((e) => e.type === 'open');
  assert.deepEqual(opens.map((e) => e.symbol).sort(), ['AAA', 'BBB', 'CCC']);
  assert.equal(opens.filter((e) => e.symbol === 'AAA').length, 1);
  assert.equal(opens.find((e) => e.symbol === 'BBB').t, 100_000);
  assert.equal(opens.find((e) => e.symbol === 'CCC').t, 120_000);
  assert.equal(opens.find((e) => e.symbol === 'AAA').t, 700_000);
  assert.ok(!replay.events.some((e) => e.symbol === 'ZZ' || e.symbol === 'QQ' || e.symbol === 'tanpa simbol'));
  const noHold = buildReplay({ trading: { initialUsd: 1000, startedAt: 0 }, updatedAt: 10, totalUsd: 1000 }, { points: [{ t: 10, usd: 1000 }] }, closes);
  assert.equal(noHold.events.filter((e) => e.type === 'nav').length, 1);
});

test('saldo di antara titik nav tidak disisipkan', () => {
  const before = frameAt(replay, 100_000);
  assert.equal(before.balance, 1000);
  assert.equal(before.pnl, 0);
  assert.equal(before.navPoints.length, 0);
  const mid = frameAt(replay, 500_000);
  assert.equal(mid.balance, 1000);
  assert.notEqual(mid.balance, 1025);
  assert.deepEqual(mid.navPoints.map((p) => p.usd), [1000]);
  const after = frameAt(replay, 900_000);
  assert.equal(after.balance, 1050);
  assert.equal(after.pnl, 50);
  const end = frameAt(replay, 1_000_000);
  assert.equal(end.balance, 1100);
  assert.equal(end.pnl, 100);
  assert.equal(end.cash, 400);
  assert.equal(frameAt(replay, 900_000).cash, null);
});

test('ubin pada jam replay mengikuti tutup dan posisi yang sudah nyata', () => {
  const early = frameAt(replay, 250_000);
  assert.equal(early.wins, 0);
  assert.equal(early.losses, 0);
  assert.equal(early.winRate, null);
  assert.equal(early.largestWin, null);
  assert.deepEqual(early.positions.map((p) => p.symbol), ['BBB', 'CCC']);
  assert.equal(early.positions.find((p) => p.symbol === 'CCC').cost, 40);
  assert.equal(early.positions.find((p) => p.symbol === 'BBB').cost, 40);
  assert.equal(early.positions.find((p) => p.symbol === 'BBB').partial, false);
  assert.equal(early.positions.find((p) => p.symbol === 'CCC').value, null);

  const held = frameAt(replay, 350_000);
  assert.equal(held.positions.find((p) => p.symbol === 'CCC'), undefined);
  assert.equal(held.losses, 1);
  assert.equal(held.realized, -10);
  assert.equal(held.largestWin, null);

  const half = frameAt(replay, 400_000);
  const bbb = half.positions.find((p) => p.symbol === 'BBB');
  assert.ok(bbb);
  assert.equal(bbb.cost, 20);
  assert.equal(bbb.partial, true);
  assert.equal(bbb.value, null);
  assert.equal(half.wins, 1);
  assert.equal(half.largestWin.netUsd, 30);
  assert.equal(half.largestWin.symbol, 'BBB');
  assert.equal(half.winRate, 50);

  const gone = frameAt(replay, 700_000);
  assert.equal(gone.positions.find((p) => p.symbol === 'BBB'), undefined);
  assert.equal(gone.positions.find((p) => p.symbol === 'AAA').value, null);
  assert.equal(gone.wins, 3);
  assert.equal(gone.realized, 26);

  const marked = frameAt(replay, 1_000_000);
  const aaa = marked.positions.find((p) => p.symbol === 'AAA');
  assert.equal(aaa.value, 25);
  assert.equal(aaa.pnl, 15);
  assert.equal(marked.navPoints.length, 3);
});

test('langkah pindah ke kejadian nyata, dan tutup besar memakai ambang yang terbit', () => {
  assert.equal(stepTime(replay, 0, 1), 100_000);
  assert.equal(stepTime(replay, 100_000, -1), 0);
  assert.equal(stepTime(replay, 350_000, 1), 400_000);
  const atClose = frameAt(replay, stepTime(replay, 350_000, 1));
  assert.equal(atClose.largestWin.netUsd, 30);
  assert.equal(isBigClose({ type: 'partial', netUsd: 19, netPct: 29 }), false);
  assert.equal(isBigClose({ type: 'close', netUsd: 20, netPct: 1 }), true);
  assert.equal(isBigClose({ type: 'close', netUsd: 2, netPct: 30 }), true);
  assert.equal(isBigClose({ type: 'close', netUsd: -40, netPct: 80 }), false);
  assert.equal(isBigClose({ type: 'open', netUsd: 50, netPct: 50 }), false);
});

test('halaman dan gaya replay tetap di skrip sendiri', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  for (const page of ['grokbot/solana/index.html', 'grokbot/robinhood/index.html']) {
    const html = read(page);
    assert.match(html, /id="replayToggle"/);
    assert.match(html, /id="replayPlay"/);
    assert.match(html, /id="replayScrub"/);
    assert.match(html, /id="replayExit"/);
    for (const speed of [1, 10, 60, 300]) assert.match(html, new RegExp(`data-speed="${speed}"`));
    assert.match(html, /script-src 'self'/);
    assert.doesNotMatch(html, /script-src [^"']*https?:/);
  }
  assert.match(read('assets/grokbot.js'), /prefers-reduced-motion/);
  assert.match(read('assets/grokbot.css'), /prefers-reduced-motion/);
  assert.doesNotMatch(read('assets/grokbot-timeline.mjs'), /fetch\(|document|localStorage|githubusercontent/);
});
