// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The server's clock offset. The SysAdmin API gives times in the SERVER's local
 * time with no zone ("2026-09-28 00:00:00"); a browser in another zone (a UTC
 * container viewed from London, say) would otherwise read them as its own local
 * time and be hours out: an upcoming task shown as "58m ago".
 *
 * The offset is learned once after sign-in: /monitor/system-usage carries the
 * server's local "now" (LastUpdate), and the HTTP Date header is the same moment
 * in UTC. The difference, rounded to 15 minutes, is the server's UTC offset.
 * Until it's known (or if the read fails) times are read as browser-local, as before.
 */
import { authFetch } from './auth';

let offsetMin: number | null = null;

/** Server minutes east of UTC, or null when not known. */
export function serverUtcOffset(): number | null {
  return offsetMin;
}

/** Learn the offset (at most `timeoutMs`, so a slow server never holds up the first screen). */
export async function learnServerClock(timeoutMs = 2500): Promise<void> {
  const read = (async () => {
    const res = await authFetch('/api/admin/v2/monitor/system-usage', { headers: { Accept: 'application/json' } });
    const utc = Date.parse(res.headers.get('Date') ?? '');
    const json = (await res.json().catch(() => null)) as { result?: { LastUpdate?: string } } | null;
    const local = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(json?.result?.LastUpdate ?? '');
    if (!res.ok || !Number.isFinite(utc) || !local) return;
    const asUtc = Date.UTC(+local[1], +local[2] - 1, +local[3], +local[4], +local[5], +local[6]);
    offsetMin = Math.round((asUtc - utc) / 60_000 / 15) * 15;
  })().catch(() => { /* keep reading times as browser-local */ });
  await Promise.race([read, new Promise((r) => setTimeout(r, timeoutMs))]);
}
