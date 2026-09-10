#!/usr/bin/env bash
# Ambil snapshot terbaru dari bot lalu push ke GitHub.
#   */60 * * * * /root/cashood/scripts/publish.sh >> /tmp/cashood.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/sync.mjs

if ! git diff --quiet -- data/live.json; then
  git add data/live.json
  git commit -m "chore: snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
  git push
  echo "pushed"
else
  echo "no change"
fi
