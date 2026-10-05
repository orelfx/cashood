#!/usr/bin/env bash
# Publish validated snapshots; cron: */5 * * * * /root/cashood/scripts/publish.sh
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
run_snapshot scripts/sync-ferari.mjs
run_snapshot scripts/sync-charon.mjs
run_snapshot scripts/sync-robsol.mjs
run_snapshot scripts/sync-forex.mjs
run_snapshot scripts/sync-binance.mjs
# Buku paper devil greed: bot-nya menaruh berkas di kotak masuk; diimpor kalau ada.
run_paper() {
  [ -f "$2" ] || return 0
  if ! timeout --kill-after=10 60 /usr/bin/node scripts/import-paper-book.mjs "$1" "$2"; then
    echo "PERINGATAN: impor $1 gagal; snapshot terakhir dipertahankan" >&2
    failed=1
  fi
}
timeout --kill-after=5 40 scripts/fetch-paper-inbox.sh || true   # bot-nya di VPS lain
run_paper dgrh /root/cashood-inbox/devil-greed-robin-hood.json
run_paper dgsol /root/cashood-inbox/devil-greed-solana.json
# Cashood Index dihitung terakhir, dari snapshot dana yang baru saja ditulis.
run_snapshot scripts/sync-index.mjs
# Bunga Safe Box mengikuti gerak harian index, jadi dihitung sesudahnya.
run_snapshot scripts/sync-safebox.mjs
[ -d "$WORK" ] || git worktree add -q "$WORK" data
/usr/bin/node scripts/stage-data.mjs "$WORK" || failed=1
cd "$WORK"
if [ -n "$(git status --porcelain)" ]; then
  git add -- reborn meridian ferari robsol charon forex binance safebox index
  [ -d dgrh ] && git add -- dgrh; [ -d dgsol ] && git add -- dgsol
  git commit -q -m "data: validated snapshots $(date -u +%Y-%m-%dT%H:%MZ)"
fi
# Retry an earlier unpushed commit even when there are no file changes this run.
git push -q origin HEAD:data
echo 'data publication complete'
exit "$failed"
