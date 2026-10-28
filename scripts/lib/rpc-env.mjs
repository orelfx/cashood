// RPC khusus website. Kunci di /root/cashood/.env (tidak ikut terbit) supaya
// bacaan situs tidak memakan jatah RPC bot. Selama kuncinya kosong, exporter
// tetap memakai RPC bot seperti dulu agar situs tidak berhenti diperbarui.
//
// Dipanggil SEBELUM .env bot dimuat: dotenv bot tidak menimpa variabel yang
// sudah ada, jadi nilai di sini yang menang, dan cadangan RPC bot dikosongkan.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

function readOwn() {
  const out = {};
  let text = '';
  try { text = readFileSync(FILE, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const own = readOwn();
const pick = (key) => String(process.env[key] || own[key] || '').trim();

// Robinhood: Reborn Rich, Safe Box, No Risk No Ferari.
export function useCashoodRobinhoodRpc() {
  const url = pick('CASHOOD_ROBINHOOD_RPC');
  if (!url) return false;
  Object.assign(process.env, { RR_RPC_MAIN: url, RR_RPC_BACKUP: '', RR_RPC_URLS: '', RR_RPC_URL: '' });
  return true;
}

// Urutan RPC Solana: utama situs, cadangan situs (opsional), lalu dua RPC
// publik. 2026-10-28: RPC utama dijeda penyedia (tagihan) beberapa jam dan
// Meridian/Staking/Robsol berhenti diperbarui; cadangan mencegah itu terulang.
export const PUBLIC_SOLANA_RPCS = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
export function solanaRpcList() {
  return [...new Set([pick('CASHOOD_SOLANA_RPC'), pick('CASHOOD_SOLANA_RPC_BACKUP'), ...PUBLIC_SOLANA_RPCS].filter(Boolean))];
}

// Panggil RPC Solana dengan cadangan: endpoint berikutnya dicoba kalau HTTP
// gagal, jawaban bukan JSON, atau RPC mengembalikan error (jeda, 429, kunci).
export async function solanaRpc(method, params, { urls = solanaRpcList(), fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  let last = null;
  for (const url of urls) {
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      const j = await res.json();
      if (j && j.result !== undefined) return j.result;
      last = new Error(`${method}: ${j?.error?.message || `HTTP ${res.status}`}`);
    } catch (e) { last = new Error(`${method}: ${e.message}`); }
  }
  throw last || new Error(`RPC ${method} gagal`);
}

// Solana: Meridian. Dipakai sebagai env proses CLI bot yang dijalankan exporter.
export function cashoodSolanaEnv(base = process.env) {
  const url = pick('CASHOOD_SOLANA_RPC');
  if (!url) return base;
  const backup = solanaRpcList().filter((u) => u !== url);
  return { ...base, RPC_URL: url, RPC_URL_BACKUP: backup[0] || '', OPPORTUNITY_RPC_URL: '', RPC_EXTRA_URLS: '', RPC_WS_URL: '', RPC_WS_URL_BACKUP: '',
    // Saldo dompet: tanpa kunci Helius bot membaca saldo lewat RPC di atas
    // (getBalance + daftar token) dan harga Jupiter/DexScreener.
    HELIUS_API_KEY: '' };
}

// Nilai lain dari .env situs (atau lingkungan proses), untuk exporter yang
// tidak memuat .env bot mana pun.
export const cashoodEnv = (key) => pick(key);
