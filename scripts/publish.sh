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

# Biaya bulanan dipakai bersama kedua dana. Dibagi rata akan mencekik dana
# kecil — $77,50 atas dana $978 itu 8% sebulan — jadi dibagi menurut ukuran,
# prinsip yang sama dengan pembagian di dalam tiap dana. Dihitung di sini,
# sesudah kedua snapshot ada, supaya angkanya bisa ditelusuri.
/usr/bin/node -e '
  const fs = require("fs");
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const funds = ["reborn", "meridian"];
  const live = Object.fromEntries(funds.map((f) => [f, read(`data/${f}/live.json`)]));
  const cfg  = Object.fromEntries(funds.map((f) => [f, read(`data/${f}/config.json`)]));
  const bill = (cfg.reborn?.costs?.items || []).reduce((t, c) => t + (Number(c.usd) || 0), 0);
  const navs = Object.fromEntries(funds.map((f) => [f, Number(live[f]?.totalUsd) || 0]));
  const total = funds.reduce((t, f) => t + navs[f], 0);
  for (const f of funds) {
    if (!live[f]) continue;
    live[f].costsShareUsd = total > 0 ? Number((bill * navs[f] / total).toFixed(2)) : Number((bill / funds.length).toFixed(2));
    live[f].costsTotalUsd = bill;
    fs.writeFileSync(`data/${f}/live.json`, JSON.stringify(live[f], null, 2) + "\n");
  }
  console.log(`[biaya] $${bill} dibagi: ` + funds.map((f) => `${f} $${live[f]?.costsShareUsd}`).join(" · "));
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
