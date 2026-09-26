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
  return [...buckets.values()].sort((a,b)=>a.t-b.t).slice(-4000);
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
