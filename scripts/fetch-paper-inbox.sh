#!/usr/bin/env bash
# Tarik berkas buku paper dari VPS tempat bot-nya berjalan ke kotak masuk lokal.
# Aktif hanya kalau CASHOOD_DEVIL_SSH (mis. root@1.2.3.4) diisi di .env; kunci SSH
# di sisi sana dibatasi ke satu perintah (tar dua berkas), jadi tidak bisa login.
set -euo pipefail
cd "$(dirname "$0")/.."
target="$(grep -E '^CASHOOD_DEVIL_SSH=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
port="$(grep -E '^CASHOOD_DEVIL_SSH_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d ' ' || true)"
[ -n "$target" ] || exit 0
inbox=/root/cashood-inbox
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
ssh -i /root/.ssh/cashood_inbox_pull -p "${port:-22}" -o BatchMode=yes -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes "$target" true 2>/dev/null \
  | tar -x -C "$tmp" --no-same-owner 2>/dev/null || { echo "PERINGATAN: kotak masuk devil greed tidak bisa ditarik" >&2; exit 1; }
for f in devil-greed-robin-hood.json devil-greed-solana.json; do
  [ -f "$tmp/$f" ] || continue
  # Hanya JSON utuh yang boleh menggantikan berkas lama.
  /usr/bin/node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$tmp/$f" 2>/dev/null || { echo "PERINGATAN: $f bukan JSON utuh; dilewati" >&2; continue; }
  mv -f "$tmp/$f" "$inbox/.$f.tmp" && mv -f "$inbox/.$f.tmp" "$inbox/$f"
done
