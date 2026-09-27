// SPDX-License-Identifier: AGPL-3.0-or-later
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

/**
 * One scrape costs IRIS ~55,000 global references, so the status bar and most
 * pages read every 60s; Activity, which charts the figures, asks for 20s while
 * it is open. Nothing is read while the tab is hidden.
 */
export const METRICS_POLL_MS = 20000;
const SLOW_POLL_MS = 60000;
/** Samples kept per series: a ring of 60 from app start (the status bar subscribes at once), so charts have lines on arrival. */
const HISTORY = 60;

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

/**
 * The ring survives a page reload (sessionStorage, this tab only), so a reload
 * doesn't leave every chart on a bare baseline until six new readings arrive.
 * Readings older than an hour are dropped on load.
 */
const RING_KEY = 'osca-portal:metrics-ring';
function loadRing(): { times: number[]; ring: Map<string, number[]> } {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RING_KEY) ?? 'null') as { times: number[]; ring: Array<[string, number[]]> } | null;
    if (!saved || !Array.isArray(saved.times)) return { times: [], ring: new Map() };
    const cut = Date.now() - HISTORY * SLOW_POLL_MS;
    const keep = saved.times.filter((t) => t >= cut).length;
    if (!keep) return { times: [], ring: new Map() };
    const ring = new Map(saved.ring.map(([k, v]) => [k, v.slice(-keep)] as [string, number[]]).filter(([, v]) => v.length));
    return { times: saved.times.slice(-keep), ring };
  } catch { return { times: [], ring: new Map() }; }
}

class MetricsStore {
  private latest: Snapshot | null = null;
  private latestAt: Date | null = null;
  private saved = loadRing();
  private ring = this.saved.ring;
  /** When each scrape landed (ms since epoch), aligned with the tail of every series. */
  private times: number[] = this.saved.times;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<(err: unknown) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private fast = false;

  /** Poll every 20s instead of 60s (Activity, while it is open). */
  setFast(on: boolean): void {
    if (this.fast === on) return;
    this.fast = on;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.poll(), on ? METRICS_POLL_MS : SLOW_POLL_MS);
      if (on) void this.poll();
    }
  }

  /** Subscribe; the listener fires immediately if data is already cached. */
  subscribe(fn: Listener, onError?: (err: unknown) => void): () => void {
    this.listeners.add(fn);
    if (onError) this.errorListeners.add(onError);
    if (this.latest && this.latestAt) fn(this.latest, this.latestAt);
    if (!this.timer) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.fast ? METRICS_POLL_MS : SLOW_POLL_MS);
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

  /** Fetch now, even in a hidden tab: someone asked for it (the refresh button, R). */
  refresh(): Promise<void> {
    return this.poll(true);
  }

  private poll(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    // A hidden tab needs no fresh figures; the next visible tick (or the
    // visibilitychange handler) catches up.
    if (!force && typeof document !== 'undefined' && document.hidden && this.latest) return Promise.resolve();
    this.inflight = (async () => {
      try {
        const res = await authFetch('/api/monitor/metrics', { headers: { Accept: 'text/plain' } });
        if (!res.ok) throw new Error(`Monitor API /metrics → HTTP ${res.status} ${res.statusText}`);
        const snap = parsePrometheus(await res.text());
        this.times.push(Date.now());
        if (this.times.length > HISTORY) this.times.shift();
        for (const [name, samples] of snap) {
          for (const s of samples) {
            const key = seriesKey(name, s.labels);
            const h = this.ring.get(key) ?? [];
            h.push(s.value);
            if (h.length > HISTORY) h.shift();
            this.ring.set(key, h);
          }
        }
        try { sessionStorage.setItem(RING_KEY, JSON.stringify({ times: this.times, ring: [...this.ring] })); } catch { /* storage full or blocked: the ring still lives in memory */ }
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
    return [...(this.ring.get(seriesKey(name, labels)) ?? [])];
  }

  /**
   * The ring buffer for one series (up to 60 samples since the app started):
   * values oldest first, with the time each was read. With no labels given,
   * the metric's first series is used, whatever labels it carries.
   */
  history(name: string, labels?: Record<string, string>): { values: number[]; times: number[] } {
    const l = labels ?? this.latest?.get(name)?.[0]?.labels ?? {};
    const values = this.trend(name, l);
    return { values, times: this.times.slice(-values.length) };
  }
}

export const metrics = new MetricsStore();
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) void metrics.refresh(); });

/** First sample of a metric (optionally matching some labels). */
export function value(snap: Snapshot, name: string, match: Record<string, string> = {}): number {
  const s = snap.get(name)?.find((x) => Object.entries(match).every(([k, v]) => x.labels[k] === v));
  return s ? s.value : NaN;
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
