// SPDX-License-Identifier: AGPL-3.0-or-later
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
/** One hour of readings at 5 s, kept for the whole app session (Activity's "1h" range). */
const HISTORY = 720;

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
/** History and times survive a page reload (sessionStorage, this tab only); readings older than an hour are dropped. */
const HIST_KEY = 'osca-portal:usage-history';
const history = new Map<RateKey, number[]>();
/** When each reading landed (ms), aligned with the tail of every series. */
const times: number[] = [];
try {
  const saved = JSON.parse(sessionStorage.getItem(HIST_KEY) ?? 'null') as { times: number[]; history: Array<[RateKey, number[]]> } | null;
  if (saved && Array.isArray(saved.times)) {
    const keep = saved.times.filter((t) => t >= Date.now() - HISTORY * POLL_MS).length;
    if (keep) {
      times.push(...saved.times.slice(-keep));
      for (const [k, v] of saved.history) history.set(k, v.slice(-keep));
    }
  }
} catch { /* start empty */ }
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
    times.push(at);
    if (times.length > HISTORY) times.shift();
    try { sessionStorage.setItem(HIST_KEY, JSON.stringify({ times, history: [...history] })); } catch { /* memory only */ }
    latest = r;
    for (const fn of listeners) fn(r, new Date());
  } catch { /* the metrics poller reports connectivity */ }
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
  /** A series with the time of each reading, oldest first. */
  history: (k: RateKey): { values: number[]; times: number[] } => {
    const values = [...(history.get(k) ?? [])];
    return { values, times: times.slice(-values.length) };
  },
};
