import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tradeStats, equityStats, strategyScore, buildPerformance } from '../scripts/lib/performance.mjs';

const H = 3600000, D = 86400000;

test('trade stats: win rate excludes flat closes, profit factor and streaks are exact', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const rows = [10, 20, -5, 0.1, 15, -10, -2].map((usd, i) => ({ netUsd: usd, netPct: usd, closedAt: t0 + i * H, holdMinutes: 60, symbol: 'X' + i }));
  const s = tradeStats(rows);
  assert.equal(s.count, 7); assert.equal(s.wins, 3); assert.equal(s.losses, 3); assert.equal(s.flat, 1);
  assert.equal(s.winRate, 50);
  assert.equal(s.grossProfitUsd, 45.1); assert.equal(s.grossLossUsd, -17);
  assert.equal(s.profitFactor, Number((45.1 / 17).toFixed(2)));
  assert.equal(s.longestWinStreak, 2); assert.equal(s.longestLossStreak, 2);
  assert.equal(s.best.usd, 20); assert.equal(s.worst.usd, -10);
});

test('equity stats: a deposit is not a return, and the deepest fall is read from the adjusted index', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  // 1000 → turun ke 900 (−10%) → setor 1000 → 1900 → naik ke 2090 (+10%)
  const points = [{ t: t0, usd: 1000 }, { t: t0 + D, usd: 900 }, { t: t0 + 2 * D, usd: 1900 }, { t: t0 + 3 * D, usd: 2090 }];
  const flows = [{ at: t0 + 1.5 * D, usd: 1000 }];
  const e = equityStats(points, flows);
  assert.equal(e.maxDrawdownPct, 10);                 // bukan +111% dari setoran
  assert.equal(e.returnPct, Number(((0.9 * 1.0 * 1.1 - 1) * 100).toFixed(2)));
});

test('ratios are withheld on short samples instead of annualising noise', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const points = Array.from({ length: 6 }, (_, i) => ({ t: t0 + i * D, usd: 1000 * (1 + 0.01 * (i % 2 ? -1 : 1)) }));
  const e = equityStats(points);
  assert.equal(e.sharpe, null); assert.equal(e.calmar, null);
});

test('score axes follow the published formulas', () => {
  const s = strategyScore({ winRate: 70, profitFactor: 2 }, { maxDrawdownPct: 10, positiveDaysPct: 60 }, 2.5);
  assert.deepEqual(s.axes, { winRate: 70, profitFactor: 50, risk: 75, recovery: 50, consistency: 60 });
  assert.equal(s.overall, 61); assert.equal(s.complete, true);
});

test('buildPerformance works with no closes', () => {
  const p = buildPerformance({ closes: [], points: [], navUsd: 100, capitalUsd: 100 });
  assert.equal(p.trades, null); assert.equal(p.equity, null); assert.equal(p.profitUsd, 0);
});

test('percent-only closes still give a win rate, and dollar stats are withheld', () => {
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const rows = [2, 3, -1, 0.01, 4].map((pct, i) => ({ netUsd: NaN, netPct: pct, closedAt: t0 + i * H }));
  const s = tradeStats(rows, { flatBand: 0.05 });
  assert.equal(s.count, 5); assert.equal(s.winRate, 75); assert.equal(s.usdComplete, false);
  assert.equal(s.netUsd, null); assert.equal(s.profitFactorBasis, 'pct'); assert.equal(s.profitFactor, 9.01);  // impas +0,01% tetap ikut laba kotor
});
