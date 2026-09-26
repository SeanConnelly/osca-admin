/**
 * Throughput rates computed by the portal from cumulative counters
 * (%Api.Admin /v2/monitor/system-usage), not taken from the Prometheus
 * feed's *_per_sec sensors: those are computed between consecutive scrapes,
 * so any second reader (another tab, a Prometheus server) corrupts them.
 *
 * Rates are averaged over a 20-second window. Load on an idle instance comes
 * in bursts — collecting /api/monitor/metrics alone costs ~55K global
 * references — and a per-sample rate draws those bursts as a sawtooth.
 */
import { authFetch } from './auth';

const POLL_MS = 5000;
const WINDOW_MS = 20000;
const HISTORY = 60;

interface Counters {
  AllGlobalReferences: number;
  GlobalUpdateReferences: number;
  RoutineCalls: number;
  LogicalBlockRequests: number;
  BlockReads: number;
  BlockWrites: number;
  JournalEntries: number;
}
export type RateKey = keyof Counters;
export type Rates = Record<RateKey, number>;

const KEYS: RateKey[] = ['AllGlobalReferences', 'GlobalUpdateReferences', 'RoutineCalls', 'LogicalBlockRequests', 'BlockReads', 'BlockWrites', 'JournalEntries'];

let raw: Array<{ at: number; c: Counters }> = [];
let latest: Rates | null = null;
const history = new Map<RateKey, number[]>();
const listeners = new Set<(r: Rates, at: Date) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    const res = await authFetch('/api/admin/v2/monitor/system-usage', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const c = (await res.json()).result as Counters;
    const at = Date.now();
    raw.push({ at, c });
    // Keep the newest sample at least WINDOW_MS old as the window's start.
    while (raw.length > 2 && at - raw[1].at >= WINDOW_MS) raw.shift();
    const first = raw[0];
    const secs = (at - first.at) / 1000;
    if (raw.length < 2 || secs <= 0) return;
    const r = {} as Rates;
    for (const k of KEYS) {
      r[k] = Math.max(0, (c[k] - first.c[k]) / secs); // counters reset on restart
      const h = history.get(k) ?? [];
      h.push(r[k]);
      if (h.length > HISTORY) h.shift();
      history.set(k, h);
    }
    latest = r;
    for (const fn of listeners) fn(r, new Date());
  } catch { /* the metrics poller reports connectivity */ }
}

async function counters(): Promise<Counters> {
  const res = await authFetch('/api/admin/v2/monitor/system-usage', { headers: { Accept: 'application/json' } });
  return (await res.json()).result as Counters;
}

/**
 * What the portal's own monitoring costs, per second, in each counter:
 * counters read either side of one metrics scrape, minus a no-scrape
 * baseline read, spread over the metrics poll interval.
 */
export async function observerCost(pollSeconds: number): Promise<Rates | null> {
  try {
    const a = await counters();
    await authFetch('/api/monitor/metrics', { headers: { Accept: 'text/plain' } });
    const b = await counters();
    const c = await counters();
    const out = {} as Rates;
    for (const k of KEYS) out[k] = Math.max(0, (b[k] - a[k]) - (c[k] - b[k])) / pollSeconds;
    return out;
  } catch {
    return null;
  }
}

export const usage = {
  subscribe(fn: (r: Rates, at: Date) => void): () => void {
    listeners.add(fn);
    if (latest) fn(latest, new Date());
    if (!timer) { void poll(); timer = setInterval(() => void poll(), POLL_MS); }
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; raw = []; }
    };
  },
  trend: (k: RateKey): number[] => [...(history.get(k) ?? [])],
};
