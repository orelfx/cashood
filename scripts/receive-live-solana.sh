#!/usr/bin/env bash
# SolBot: terima live-solana-public.json lewat stdin dan taruh di kotak masuk.
#
# Dipakai sebagai forced command di /root/.ssh/authorized_keys server ini, untuk
# bot/Grok yang berjalan di luar server:
#   command="/root/cashood/scripts/receive-live-solana.sh",restrict ssh-ed25519 AAAA… solbot-push
# Pengirim cukup:  ssh -i <key> root@<server> < live-solana-public.json
# Key itu tidak bisa login, tidak bisa menjalankan perintah lain, dan hanya bisa
# menulis berkas ini. Isi yang bukan JSON utuh berskema
# devil-greed-live-solana/v1 ditolak; berkas lama dibiarkan.
set -euo pipefail
inbox=/root/cashood-inbox
dest="$inbox/live-solana-public.json"
mkdir -p "$inbox"
tmp="$(mktemp "$inbox/.live-solana-public.XXXXXX")"; trap 'rm -f "$tmp"' EXIT
# Batas 5 MB: berkas publik ini kecil; yang lebih besar pasti salah.
head -c 5242881 > "$tmp"
[ "$(stat -c %s "$tmp")" -le 5242880 ] || { echo "ditolak: lebih dari 5 MB" >&2; exit 1; }
/usr/bin/node -e '
  let j; try { j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
  if (j?.schema !== "devil-greed-live-solana/v1") { console.error("ditolak: schema harus devil-greed-live-solana/v1"); process.exit(3); }
  if (!Number.isFinite(Date.parse(j.as_of))) { console.error("ditolak: as_of bukan waktu ISO"); process.exit(3); }
' "$tmp" || { echo "ditolak: bukan JSON utuh/skema salah; berkas lama dibiarkan" >&2; exit 1; }
chmod 644 "$tmp"
mv -f "$tmp" "$dest"
echo "ok"
