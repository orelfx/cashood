#!/usr/bin/env bash
# Ambil snapshot kedua dana lalu terbitkan ke branch `data`.
#   */10 * * * * /root/cashood/scripts/publish.sh >> /root/cashood/sync.log 2>&1
#
# Berkas data tidak pernah didorong ke `main`: GitHub Pages membangun ulang situs
# setiap kali `main` berubah dan batasnya sepuluh build per jam, sementara cron
# ini sendirian sudah memakai enam.
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$ROOT/.databranch"

# Satu dana gagal tidak boleh menjatuhkan dana lain.
/usr/bin/node scripts/sync.mjs || echo "PERINGATAN: snapshot reborn gagal"
MERIDIAN_HOME="${MERIDIAN_HOME:-/root/main/meridian}" /usr/bin/node scripts/sync-meridian.mjs || echo "PERINGATAN: snapshot meridian gagal"

[ -d "$WORK" ] || git worktree add -q "$WORK" data
for fund in reborn meridian; do
  mkdir -p "$WORK/$fund"
  for f in live.json nav.json heartbeat.json; do
    [ -f "data/$fund/$f" ] && cp "data/$fund/$f" "$WORK/$fund/$f"
  done
done

cd "$WORK"
if [ -z "$(git status --porcelain)" ]; then
  echo "no change"
  exit 0
fi

TOTAL=$(/usr/bin/node -e "
  const r=(p)=>{try{return require(p).totalUsd}catch{return null}};
  const a=r('$ROOT/data/reborn/live.json'), b=r('$ROOT/data/meridian/live.json');
  console.log(['reborn \$'+a, 'meridian \$'+b].join(' · '));
")
git add -A
git commit -q -m "data: $TOTAL $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q
echo "pushed $TOTAL"
