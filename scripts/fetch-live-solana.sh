#!/usr/bin/env bash
# SolBot (Devil Greed live Solana, UANG ASLI): tarik satu berkas publik dari VPS
# tempat bot-nya berjalan ke kotak masuk lokal.
#
# Jalur ini sengaja terpisah dari key pull dua buku paper Devil Greed:
#   - key sendiri:  /root/.ssh/cashood_live_pull (komentar cashood-live-pull)
#   - di VPS sana key itu dikunci ke SATU perintah, hanya membaca berkas ini:
#       command="cat /root/cashood-inbox/live-solana-public.json",restrict ssh-ed25519 … cashood-live-pull
# Target memakai CASHOOD_SOLBOT_SSH di .env, kalau kosong CASHOOD_DEVIL_SSH.
# Berkas lama hanya diganti oleh JSON utuh berskema devil-greed-live-solana/v1;
# kalau tarikan gagal, berkas lama dibiarkan dan halaman menilai umurnya sendiri
# (lebih dari 15 menit → "tertunda", angka lama tidak ditampilkan).
set -euo pipefail
cd "$(dirname "$0")/.."
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true; }
target="$(env_get CASHOOD_SOLBOT_SSH)"; [ -n "$target" ] || target="$(env_get CASHOOD_DEVIL_SSH)"
port="$(env_get CASHOOD_SOLBOT_SSH_PORT)"; [ -n "$port" ] || port="$(env_get CASHOOD_DEVIL_SSH_PORT)"
[ -n "$target" ] || exit 0
key=/root/.ssh/cashood_live_pull
[ -f "$key" ] || exit 0
inbox=/root/cashood-inbox
dest="$inbox/live-solana-public.json"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
# Batas 5 MB: berkas publik ini kecil; yang lebih besar pasti salah.
ssh -i "$key" -p "${port:-22}" -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes "$target" true 2>/dev/null \
  | head -c 5242880 > "$tmp" || true
[ -s "$tmp" ] || { echo "PERINGATAN: SolBot live-solana-public.json tidak bisa ditarik" >&2; exit 1; }
/usr/bin/node -e '
  const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (j?.schema !== "devil-greed-live-solana/v1") process.exit(3);
' "$tmp" 2>/dev/null || { echo "PERINGATAN: SolBot: berkas bukan JSON devil-greed-live-solana/v1; dilewati" >&2; exit 1; }
mv -f "$tmp" "$inbox/.live-solana-public.json.tmp" && mv -f "$inbox/.live-solana-public.json.tmp" "$dest"
