// Process heartbeat and exchange snapshot freshness are separate facts.
export function binanceHealth(status, api, heartbeat, now = Date.now()) {
  const recent = (t, age) => Number.isFinite(t) && t > 0 && now - t >= -30000 && now - t <= age;
  const accountAt = Number(status?.updated_ms) || null;
  const accountFresh = recent(accountAt, 10 * 60000);
  const beatAt = Number(heartbeat?.updated_ms ?? api?.updated_ms ?? accountAt) || null;
  const alive = heartbeat ? heartbeat.state === 'ALIVE' && recent(beatAt, 120000)
    : recent(beatAt, api ? 120000 : 10 * 60000);
  const until = Number(api?.until_ms) || null;
  let label;
  if (!alive) label = 'tidak aktif';
  else if (api?.state === 'COOLDOWN' && until > now) label = 'menunggu Binance (cooldown API)';
  else if (api?.state === 'RATE_LIMIT_WAIT' && until > now) label = 'menunggu anggaran request';
  else if (api?.state === 'ERROR' || api?.state === 'DEGRADED') label = 'gangguan koneksi / rekonsiliasi';
  else if (api?.state && api.state !== 'CONNECTED') label = 'memulihkan koneksi Binance';
  else if (status?.paused) label = 'dijeda';
  else if (status?.daily_halt) label = 'berhenti hari ini (batas rugi)';
  else if (!accountFresh) label = 'hidup · menunggu data akun';
  else label = 'berjalan';
  const usable = alive && accountFresh && (!api?.state || api.state === 'CONNECTED');
  return { alive, accountFresh, accountAt, heartbeatAt: beatAt, until, status: label,
    healthy: usable && !status?.paused && !status?.daily_halt, usable };
}
