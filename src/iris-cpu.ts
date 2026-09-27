// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * IRIS's own CPU use, measured from per-process CPU time between polls.
 * Shared so every screen states the same figure the same way:
 * "IRIS x% of one core" (the API exposes no core count, so it can't be
 * turned into a share of the machine honestly).
 */
import { getProcesses, type Process } from './api';

const POLL_MS = 5000;

export interface IrisCpu {
  procs: Process[];
  /** Per PID, % of one core since the previous poll. */
  pct: Map<number, number>;
  /** All IRIS processes together, % of one core. */
  total: number;
  /** Seconds the measurement covers. */
  secs: number;
}

let prev: { at: number; byPid: Map<number, number> } | null = null;
let latest: IrisCpu | null = null;
const listeners = new Set<(c: IrisCpu | null, err?: unknown) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    const procs = await getProcesses();
    const at = performance.now();
    const byPid = new Map(procs.map((p) => [p.Pid, p.CPUTime]));
    if (prev) {
      const secs = (at - prev.at) / 1000;
      const last = prev.byPid;
      const pct = new Map(procs.map((p) => [p.Pid, last.has(p.Pid) ? Math.max(0, ((p.CPUTime - (last.get(p.Pid) ?? 0)) / 1000 / secs) * 100) : 0]));
      latest = { procs, pct, total: [...pct.values()].reduce((a, v) => a + v, 0), secs };
      for (const fn of listeners) fn(latest);
    }
    prev = { at, byPid };
  } catch (err) {
    for (const fn of listeners) fn(null, err);
  }
}

export const irisCpu = {
  subscribe(fn: (c: IrisCpu | null, err?: unknown) => void): () => void {
    listeners.add(fn);
    if (latest) fn(latest);
    if (!timer) { void poll(); timer = setInterval(() => void poll(), POLL_MS); }
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; prev = null; latest = null; }
    };
  },
};

export const irisCaption = (total: number | null): string =>
  total === null ? 'whole machine' : `IRIS ${total.toFixed(1)}% of one core`;
