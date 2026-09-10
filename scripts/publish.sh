#!/usr/bin/env bash
# Ambil snapshot terbaru dari bot lalu push ke GitHub Pages.
#   0 * * * * /root/cashood/scripts/publish.sh >> /var/log/cashood.log 2>&1
set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin"     # cron tidak mewarisi PATH login
cd "$(dirname "$0")/.."

/usr/bin/node scripts/sync.mjs

if git diff --quiet -- data/live.json; then
  echo "no change"
  exit 0
fi

TOTAL=$(/usr/bin/node -e "console.log(require('./data/live.json').totalUsd)")
git add data/live.json
git commit -q -m "chore: snapshot \$${TOTAL} $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q
echo "pushed \$${TOTAL}"
