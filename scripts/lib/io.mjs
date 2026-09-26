import { writeFileSync, readFileSync, renameSync, mkdirSync, openSync, closeSync, fsyncSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export const readJSON = (path, fallback = null) => {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
};
export function atomicJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try { fd = openSync(tmp, 'wx', 0o600); writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); closeSync(fd); fd = null; renameSync(tmp, path); }
  finally { if (fd != null) closeSync(fd); if (existsSync(tmp)) unlinkSync(tmp); }
}
export function lock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch (e) { if (e.code !== 'EEXIST') throw e; const pid = Number(readFileSync(path, 'utf8')); let alive = true;
    try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
    if (alive || !pid) throw new Error(`Proses lain masih berjalan: ${path}`); unlinkSync(path); return lock(path); }
  let done = false; const release = () => { if (!done) { done = true; try { unlinkSync(path); } catch {} } };
  process.once('exit', release); process.once('SIGTERM', () => process.exit(143)); process.once('SIGINT', () => process.exit(130)); return release;
}
export const generation = () => randomUUID();
export function downsample(points, now = Date.now()) {
  const buckets = new Map();
  for (const p of [...points].sort((a,b)=>a.t-b.t)) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.usd) || p.usd < 0) continue;
    const age = now - p.t, span = age < 86400000 ? 600000 : age < 7*86400000 ? 3600000 : 86400000;
    buckets.set(`${span}:${Math.floor(p.t/span)}`, p);
  }
  return dropSpikes([...buckets.values()].sort((a,b)=>a.t-b.t)).slice(-4000);
}

/**
 * Lekukan satu-dua titik yang langsung kembali adalah bacaan meleset, bukan
 * pasar. Bot Robinhood menghitung saldo token yang gagal dibaca sebagai nol,
 * sehingga grafik Reborn Rich berulang kali turun ±$700 selama sepuluh menit
 * lalu pulih. Yang dibuang HANYA deretan 1–2 titik yang menyimpang lebih dari
 * `limit` ke arah yang sama dari kedua tetangganya, sementara kedua tetangga
 * itu sendiri hampir sama (selisih < `settle`) — artinya nilainya pulih.
 * Setoran menaikkan grafik secara permanen, jadi tidak pernah memenuhi syarat
 * "pulih" dan tidak pernah terhapus.
 */
export function dropSpikes(points, limit = 0.03, settle = 0.015) {
  // Bacaan yang mustahil lebih dulu: dana tidak kehilangan separuh nilainya lalu
  // pulih dalam sepuluh menit. Satu titik yang kurang dari separuh — atau lebih
  // dari dua kali — KEDUA tetangga langsungnya adalah bacaan gagal (misalnya
  // posisi LP yang tidak terbaca sehingga hanya saldo dompet yang terhitung).
  // Setoran tidak pernah membuat satu titik berdiri sendirian di sisi yang
  // berbeda dari kedua tetangganya, jadi tidak tersentuh.
  let pts = points.filter((p, i, all) => {
    if (i === 0 || i === all.length - 1) return true;
    const a = all[i - 1].usd, b = all[i + 1].usd;
    return !(p.usd < 0.5 * Math.min(a, b) || p.usd > 2 * Math.max(a, b));
  });
  for (let pass = 0; pass < 3; pass += 1) {
    const drop = new Set();
    for (let i = 1; i < pts.length - 1; i += 1) {
      for (const len of [1, 2]) {
        const before = pts[i - 1], after = pts[i + len];
        if (!before || !after) continue;
        const base = (before.usd + after.usd) / 2;
        if (!(base > 0) || Math.abs(before.usd - after.usd) / base > settle) continue;
        const run = pts.slice(i, i + len);
        const dirs = run.map((p) => Math.sign(p.usd - base));
        const off = run.every((p) => Math.abs(p.usd - base) / base > limit);
        if (off && dirs.every((d) => d !== 0 && d === dirs[0])) { for (let k = i; k < i + len; k += 1) drop.add(k); break; }
      }
    }
    if (!drop.size) break;
    pts = pts.filter((_, i) => !drop.has(i));
  }
  return pts;
}
export function privateId(dir, id) {
  const file = resolve(dir, 'publication-key.local.json');
  if (!existsSync(file)) atomicJSON(file, { key: randomUUID() + randomUUID() });
  const { key } = JSON.parse(readFileSync(file, 'utf8'));
  return 'pos-' + createHash('sha256').update(key + ':' + id).digest('hex').slice(0, 20);
}
export function publicSnapshot(snapshot, dir) {
  const copy = structuredClone(snapshot);
  copy.positions = (copy.positions || []).map(p => { const { tokenId, position, address, staleReason, ...rest } = p; return { ...rest, tokenId: privateId(dir, tokenId || position || '') }; });
  copy.closedRecent = (copy.closedRecent || []).map(p => { const { tokenId, position, address, ...rest } = p; return rest; });
  assertPublic(copy);
  return copy;
}
export function assertPublic(value) {
  const text = JSON.stringify(value);
  if (/0x[0-9a-f]{40}\b|\b(?:0x)?[0-9a-f]{64}\b|\b\d{6,}:[A-Za-z0-9_-]{30,}\b|(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE|BOT_TOKEN|api[_-]?key)\s*[:=]/i.test(text)) throw new Error('Data publik mengandung identitas/rahasia; publikasi dibatalkan');
  if (/https?:\/\/[^\s"<>]+[?&](?:key|token|api_key)=/i.test(text)) throw new Error('URL rahasia dalam data publik');
}
