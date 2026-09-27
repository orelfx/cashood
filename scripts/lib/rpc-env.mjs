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

// Solana: Meridian. Dipakai sebagai env proses CLI bot yang dijalankan exporter.
export function cashoodSolanaEnv(base = process.env) {
  const url = pick('CASHOOD_SOLANA_RPC');
  if (!url) return base;
  return { ...base, RPC_URL: url, RPC_URL_BACKUP: '', OPPORTUNITY_RPC_URL: '', RPC_EXTRA_URLS: '', RPC_WS_URL: '', RPC_WS_URL_BACKUP: '',
    // Saldo dompet: tanpa kunci Helius bot membaca saldo lewat RPC di atas
    // (getBalance + daftar token) dan harga Jupiter/DexScreener.
    HELIUS_API_KEY: '' };
}
