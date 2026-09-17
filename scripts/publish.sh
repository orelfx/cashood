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

# Tagihan sistem $155 itu satu tagihan untuk seluruh sistem, bukan satu per
# dana. Dibayar sekali dari dana yang ditandai `costs.primary` di config-nya;
# dana lain tidak dibebani lagi, supaya biaya yang sama tidak terhitung dua kali
# dan tidak memotong dividen dua kali.
/usr/bin/node -e '
  const fs = require("fs");
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const funds = ["reborn", "meridian"];
  const bill = (read("data/reborn/config.json")?.costs?.items || []).reduce((t, c) => t + (Number(c.usd) || 0), 0);
  const line = [];
  for (const f of funds) {
    const live = read(`data/${f}/live.json`);
    if (!live) continue;
    const primary = read(`data/${f}/config.json`)?.costs?.primary === true;
    live.costsShareUsd = primary ? bill : 0;
    live.costsTotalUsd = bill;
    fs.writeFileSync(`data/${f}/live.json`, JSON.stringify(live, null, 2) + "\n");
    line.push(`${f} $${live.costsShareUsd}`);
  }
  console.log(`[biaya] tagihan $${bill} → ` + line.join(" · "));
'

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
