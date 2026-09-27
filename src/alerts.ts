// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * System alerts from %Api.Monitor (/api/monitor/alerts). The endpoint hands
 * each alert out once, so the portal keeps every alert it has seen (per
 * instance, in this browser) and merges new ones in on each poll.
 */
import { getAlerts, type Alert } from './api';

const KEY = 'osca-portal:alerts';
const LIMIT = 500;
const POLL_MS = 30000;

function load(): Alert[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Alert[]; } catch { return []; }
}
function save(list: Alert[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}

let seen = load();
const listeners = new Set<(list: Alert[]) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function poll(): Promise<void> {
  try {
    const fresh = await getAlerts();
    if (fresh.length === 0) return;
    const ids = new Set(seen.map((a) => a.time + a.message));
    const added = fresh.filter((a) => !ids.has(a.time + a.message));
    if (added.length === 0) return;
    seen = [...added, ...seen].sort((a, b) => b.time.localeCompare(a.time)).slice(0, LIMIT);
    save(seen);
    for (const fn of listeners) fn(seen);
  } catch { /* the Pulse and the alerts screen surface connectivity separately */ }
}

export const alerts = {
  subscribe(fn: (list: Alert[]) => void): () => void {
    listeners.add(fn);
    fn(seen);
    if (!timer) { void poll(); timer = setInterval(() => void poll(), POLL_MS); }
    return () => { listeners.delete(fn); };
  },
  refresh: poll,
  count: (): number => seen.length,
  clear(): void { seen = []; save(seen); for (const fn of listeners) fn(seen); },
};

/** IRIS severities: 0 info, 1 warning, 2 severe, 3 fatal. */
export function severity(s: string): { label: string; tone: 'info' | 'warning' | 'danger' } {
  switch (Number(s)) {
    case 0: return { label: 'Info', tone: 'info' };
    case 1: return { label: 'Warning', tone: 'warning' };
    case 3: return { label: 'Fatal', tone: 'danger' };
    default: return { label: 'Severe', tone: 'danger' };
  }
}
