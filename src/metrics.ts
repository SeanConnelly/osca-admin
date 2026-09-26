/**
 * Live metrics from %Api.Monitor's Prometheus feed (/api/monitor/metrics).
 * One shared poller for the whole app: screens and the toolbar subscribe,
 * polling runs only while someone is listening, and a short rolling history
 * is kept per series so trends survive navigating between screens.
 */
import { authFetch } from './auth';

export interface Sample {
  labels: Record<string, string>;
  value: number;
}

export type Snapshot = Map<string, Sample[]>;

export const METRICS_POLL_MS = 10000;
const POLL_MS = METRICS_POLL_MS; // gentle on SAM: its *_per_sec sensors are computed between scrapes
const HISTORY = 30; // 5 minutes

/** Parse the Prometheus text exposition format (the subset IRIS emits). */
export function parsePrometheus(text: string): Snapshot {
  const out: Snapshot = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[3]) {
      for (const lm of m[3].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[lm[1]] = lm[2].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    }
    const value = Number(m[4]);
    const list = out.get(m[1]) ?? [];
    list.push({ labels, value });
    out.set(m[1], list);
  }
  return out;
}

const seriesKey = (name: string, labels: Record<string, string> = {}): string =>
  `${name}${JSON.stringify(Object.entries(labels).sort())}`;

type Listener = (snap: Snapshot, at: Date) => void;

class MetricsStore {
  private latest: Snapshot | null = null;
  private latestAt: Date | null = null;
  private history = new Map<string, number[]>();
  private listeners = new Set<Listener>();
  private errorListeners = new Set<(err: unknown) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  /** Subscribe; the listener fires immediately if data is already cached. */
  subscribe(fn: Listener, onError?: (err: unknown) => void): () => void {
    this.listeners.add(fn);
    if (onError) this.errorListeners.add(onError);
    if (this.latest && this.latestAt) fn(this.latest, this.latestAt);
    if (!this.timer) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), POLL_MS);
    }
    return () => {
      this.listeners.delete(fn);
      if (onError) this.errorListeners.delete(onError);
      if (this.listeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  refresh(): Promise<void> {
    return this.poll();
  }

  private poll(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await authFetch('/api/monitor/metrics', { headers: { Accept: 'text/plain' } });
        if (!res.ok) throw new Error(`Monitor API /metrics → HTTP ${res.status} ${res.statusText}`);
        const snap = parsePrometheus(await res.text());
        for (const [name, samples] of snap) {
          for (const s of samples) {
            const key = seriesKey(name, s.labels);
            const h = this.history.get(key) ?? [];
            h.push(s.value);
            if (h.length > HISTORY) h.shift();
            this.history.set(key, h);
          }
        }
        this.latest = snap;
        this.latestAt = new Date();
        for (const fn of this.listeners) fn(snap, this.latestAt);
      } catch (err) {
        for (const fn of this.errorListeners) fn(err);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  trend(name: string, labels: Record<string, string> = {}): number[] {
    return [...(this.history.get(seriesKey(name, labels)) ?? [])];
  }
}

export const metrics = new MetricsStore();

/** First sample of a metric (optionally matching some labels). */
export function value(snap: Snapshot, name: string, match: Record<string, string> = {}): number {
  const s = snap.get(name)?.find((x) => Object.entries(match).every(([k, v]) => x.labels[k] === v));
  return s ? s.value : NaN;
}

/** History for a metric's first series, whatever labels it carries. */
export function trendOf(snap: Snapshot, name: string): number[] {
  return metrics.trend(name, snap.get(name)?.[0]?.labels ?? {});
}

export function samples(snap: Snapshot, name: string): Sample[] {
  return snap.get(name) ?? [];
}

/** iris_system_state → label + tone. */
export function systemState(state: number): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  switch (state) {
    case 0: return { label: 'Healthy', tone: 'success' };
    case 1: return { label: 'Warning', tone: 'warning' };
    case 2: return { label: 'Alert', tone: 'danger' };
    case -1: return { label: 'Hung', tone: 'danger' };
    default: return { label: 'Unknown', tone: 'neutral' };
  }
}
