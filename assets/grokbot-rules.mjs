/*
 * Aturan keluar buku paper. Angka dan label hanya dari feed.
 * Kalau ladder atau exit_ladder tidak ada, pemanggil jatuh ke stop/target
 * yang terbit — tidak mengarang trail dari puncak.
 */
const MINUS = '−';

const LEVELS = { tp1: 'TP1', tp2: 'TP2', tp3: 'TP3' };

const REASONS = {
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

const finite = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

const absPct = (n) => `${Math.abs(n).toFixed(0)}%`;

export function reasonCode(c) {
  const primary = String(c?.reason ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(REASONS, primary)) return primary;
  const legacy = String(c?.reason_legacy ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(REASONS, legacy)) return legacy;
  return '';
}

export function isPartial(c) {
  if (LEVELS[String(c?.level ?? '').trim().toLowerCase()]) return true;
  return /^jual separuh/i.test(c?.reasonDetail || '');
}

export function isTrail(c) {
  if (reasonCode(c) === 'trail_runner') return true;
  return /trailing stop setelah/i.test(c?.reasonDetail || '');
}

export function closeKind(c) {
  const level = LEVELS[String(c?.level ?? '').trim().toLowerCase()];
  if (level) return [level, 'tp'];
  if (/^jual separuh/i.test(c?.reasonDetail || '')) return ['TP1 (legacy)', 'tp'];
  const code = reasonCode(c);
  if (code) return REASONS[code];
  if (/trailing stop setelah/i.test(c?.reasonDetail || '')) return ['TRAIL', 'tp'];
  return ['CLOSE', 'close'];
}

export function ladderBits(ladder) {
  if (!ladder || typeof ladder !== 'object' || Array.isArray(ladder)) return null;
  const bits = [];
  const label = String(ladder.label || ladder.text || '').trim();
  if (label) bits.push(label);
  const level = String(ladder.level || '').trim();
  if (level && !label.toLowerCase().includes(level.toLowerCase())) bits.push(level.toUpperCase());
  const floor = ladder.floor == null ? '' : String(ladder.floor).trim();
  if (floor && !label.toLowerCase().includes(floor.toLowerCase())) bits.push(`floor ${floor}`);
  const line = finite(ladder.exit_line_pct);
  if (line != null) {
    const kind = String(ladder.exit_line_kind || '').trim();
    const sign = line < 0 ? MINUS : line > 0 ? '+' : '';
    bits.push(`exit ${sign}${absPct(line)}${kind ? ` ${kind}` : ''}`);
  }
  if (ladder.next_tp || finite(ladder.next_tp_pct) != null) {
    const name = String(ladder.next_tp || 'next').trim() || 'next';
    const next = finite(ladder.next_tp_pct);
    const pctv = next == null ? '' : ` ${next < 0 ? MINUS : '+'}${absPct(next)}`;
    bits.push(`next ${name}${pctv}`);
  }
  const trail = finite(ladder.runner_trail_pct);
  if (trail != null) bits.push(`trail ${MINUS}${absPct(trail)}`);
  const hits = Array.isArray(ladder.hits) ? ladder.hits.map((h) => String(h).trim()).filter(Boolean) : [];
  if (hits.length) bits.push(`hits ${hits.join(', ')}`);
  return bits.length ? bits : null;
}

export function stopCell(row) {
  const bits = ladderBits(row?.ladder);
  if (bits) return { mode: 'ladder', text: bits.join(' · ') };
  const stopN = finite(row?.stopPct);
  const targetN = finite(row?.targetPct);
  if (stopN == null && targetN == null) return { mode: 'empty' };
  return {
    mode: 'levels',
    stop: stopN == null ? null : `${MINUS}${absPct(stopN)}`,
    target: targetN == null ? null : `${targetN < 0 ? MINUS : '+'}${absPct(targetN)}`,
  };
}

export function stopCellText(row) {
  const cell = stopCell(row);
  if (cell.mode === 'ladder') return cell.text;
  if (cell.mode === 'empty') return '';
  return [cell.stop, cell.target].filter(Boolean).join(' / ');
}

export function exitRuleText(live) {
  const text = live?.exit_ladder?.text;
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed || null;
}

export function planText(row) {
  if (!row || typeof row !== 'object') return '';
  const ladder = row.ladder && typeof row.ladder === 'object' && !Array.isArray(row.ladder) ? row.ladder : null;
  const book = String(row.bookLabel || row.book || '').trim();
  const mode = String(ladder?.entry_mode_label || row.entry_mode_label || row.entryMode || '').trim();
  const who = String(row.firstWallet || '').trim();
  return [book, mode, who ? `via ${who}` : ''].filter(Boolean).join(' · ');
}
