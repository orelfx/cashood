import test from 'node:test';
import assert from 'node:assert/strict';
import { accrue, fixedMonthPct } from '../scripts/lib/accrual.mjs';

const cfg = { owners: [{ id: 'a', name: 'A', principalUsd: 1000 }],
  rate: { minMonthlyPct: 0.5, maxMonthlyPct: 3, dailyFrom: '2026-10-01', fixedFrom: '2026-10-28', fixedMinMonthlyPct: 1, fixedMaxMonthlyPct: 3 } };

test('Safe Box mode tetap: tiap bulan bersih 1–3%, harian bervariasi, tanpa Index', () => {
  const st = accrue(cfg, null, { at: Date.parse('2026-12-01T00:30:00+07:00'), points: [], requireQuality: true });
  for (const m of ['2026-10', '2026-11']) {
    const days = st.days.filter((d) => d.date.startsWith(m)), total = days.reduce((t, d) => t + d.owners.a, 0);
    const pct = total / 1000 * 100;
    assert.ok(pct >= 1 - 1e-6 && pct <= 3 + 1e-6, `${m} ${pct}`);
    assert.ok(Math.abs(pct - fixedMonthPct(cfg, m)) < 0.01, `${m} sesuai undian bulan itu`);
  }
  const nov = st.days.filter((d) => d.date.startsWith('2026-11')).map((d) => d.owners.a);
  assert.ok(Math.max(...nov) > Math.min(...nov) * 1.5, 'jumlah harian bervariasi');
  assert.ok(nov.every((v) => v > 0), 'tiap hari ada bunga');
});

test('Safe Box mode tetap: hari berjalan tidak berubah antar siklus', () => {
  const a = accrue(cfg, null, { at: Date.parse('2026-11-10T09:00:00+07:00'), points: [] }).today.usd;
  const b = accrue(cfg, null, { at: Date.parse('2026-11-10T21:00:00+07:00'), points: [] }).today.usd;
  assert.equal(a, b);
});
