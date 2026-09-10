#!/usr/bin/env bash
# Ambil snapshot terbaru dari bot lalu terbitkan.
#   */10 * * * * /root/cashood/scripts/publish.sh >> /root/cashood/sync.log 2>&1
#
# File data TIDAK didorong ke `main`. GitHub Pages membangun ulang situs setiap
# kali `main` berubah, dan batas lunaknya sepuluh build per jam — cron sepuluh
# menitan sendirian sudah menghabiskan enam, dan begitu jatahnya habis SEMUA
# build gagal, termasuk yang membawa perbaikan kode. Data tinggal di branch
# `data`, yang tidak pernah memicu build; situs membacanya lewat raw.
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"     # cron tidak mewarisi PATH login
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$ROOT/.databranch"

/usr/bin/node scripts/sync.mjs

[ -d "$WORK" ] || git worktree add -q "$WORK" data
cp data/live.json data/nav.json "$WORK/"
[ -f data/heartbeat.json ] && cp data/heartbeat.json "$WORK/"

cd "$WORK"
if git diff --quiet -- . && [ -z "$(git status --porcelain)" ]; then
  echo "no change"
  exit 0
fi

TOTAL=$(/usr/bin/node -e "console.log(require('$ROOT/data/live.json').totalUsd)")
git add -A
git commit -q -m "data: \$${TOTAL} $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q
echo "pushed \$${TOTAL}"
