#!/usr/bin/env bash
# Publish validated snapshots; cron: */10 * * * * /root/cashood/scripts/publish.sh
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="$ROOT/.databranch"
exec 9>"$ROOT/publish.lock.local"
flock -n 9 || { echo 'publish already running'; exit 0; }
failed=0
run_snapshot() {
  local script="$1"
  if ! timeout --kill-after=10 240 /usr/bin/node "$script"; then
    echo "PERINGATAN: $script gagal; snapshot terakhir dipertahankan" >&2
    failed=1
  fi
}
# Independent funds may finish separately. Each exporter has its own writer lock.
run_snapshot scripts/sync.mjs
run_snapshot scripts/sync-meridian.mjs
run_snapshot scripts/sync-safebox.mjs
run_snapshot scripts/sync-ferari.mjs
[ -d "$WORK" ] || git worktree add -q "$WORK" data
/usr/bin/node scripts/stage-data.mjs "$WORK" || failed=1
cd "$WORK"
if [ -n "$(git status --porcelain)" ]; then
  git add -- reborn meridian ferari safebox
  git commit -q -m "data: validated snapshots $(date -u +%Y-%m-%dT%H:%MZ)"
fi
# Retry an earlier unpushed commit even when there are no file changes this run.
git push -q origin HEAD:data
echo 'data publication complete'
exit "$failed"
