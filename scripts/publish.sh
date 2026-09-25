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
RR_HOME="${RR_HOME:-/root/robinhood}" /usr/bin/node scripts/sync-safebox.mjs || echo "PERINGATAN: snapshot safebox gagal"
# Dana ini membaca dompet milik orang lain lewat RPC yang juga dipakai bot;
# saat RPC-nya sibuk, pembacaan bisa menggantung. Dibatasi supaya cron sepuluh
# menit tidak menumpuk proses di belakangnya.
RR_HOME="${RR_HOME:-/root/robinhood}" timeout 240 /usr/bin/node scripts/sync-ferari.mjs || echo "PERINGATAN: snapshot ferari gagal"

# Tagihan sistem $155 itu satu tagihan untuk seluruh sistem, bukan satu per
# dana. Dibayar sekali dari dana yang ditandai `costs.primary` di config-nya;
# dana lain tidak dibebani lagi, supaya biaya yang sama tidak terhitung dua kali
# dan tidak memotong dividen dua kali.
/usr/bin/node -e '
  const fs = require("fs");
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
  const funds = ["reborn", "meridian", "ferari"];
  const sum = (cfg) => (cfg?.costs?.items || []).reduce((t, c) => t + (Number(c.usd) || 0), 0);

  // Dua macam biaya. Yang BERBAGI (costs.shared) satu tagihan untuk seluruh
  // sistem, dibayar sekali oleh dana yang ditandai primary. Yang TIDAK berbagi
  // punya tagihannya sendiri dan membayarnya penuh — dana yang botnya terpisah,
  // seperti No Risk No Ferari dengan VPS, RPC dan modelnya sendiri.
  const cfgs = Object.fromEntries(funds.map((f) => [f, read(`data/${f}/config.json`)]));
  const bersamaPrimary = funds.find((f) => cfgs[f]?.costs?.shared && cfgs[f]?.costs?.primary);
  const tagihanBersama = sum(cfgs[bersamaPrimary]);

  const line = [];
  for (const f of funds) {
    const live = read(`data/${f}/live.json`);
    if (!live) continue;
    const cfg = cfgs[f];
    if (cfg?.costs?.shared) {
      live.costsShareUsd = cfg?.costs?.primary === true ? tagihanBersama : 0;
      live.costsTotalUsd = tagihanBersama;
    } else {
      const sendiri = sum(cfg);
      live.costsShareUsd = sendiri;
      live.costsTotalUsd = sendiri;
    }
    fs.writeFileSync(`data/${f}/live.json`, JSON.stringify(live, null, 2) + "\n");
    line.push(`${f} $${live.costsShareUsd}`);
  }
  console.log(`[biaya] tagihan bersama $${tagihanBersama} → ` + line.join(" · "));
'

[ -d "$WORK" ] || git worktree add -q "$WORK" data
for fund in reborn meridian ferari; do
  mkdir -p "$WORK/$fund"
  for f in live.json nav.json heartbeat.json forecast.json; do
    [ -f "data/$fund/$f" ] && cp "data/$fund/$f" "$WORK/$fund/$f"
  done
done

# Safe Box: HANYA live.json, yang isinya angka tampilan. nav.json memuat nilai
# posisi likuiditas yang sebenarnya dan ukuran itu tidak diterbitkan; halaman
# pun tidak membacanya.
mkdir -p "$WORK/safebox"
cp data/safebox/live.json "$WORK/safebox/live.json"
rm -f "$WORK/safebox/nav.json"

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
