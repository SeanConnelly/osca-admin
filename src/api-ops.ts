// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Locks, Web sessions and Background jobs: reads and the few
 * actions IRIS allows on them. Everything here needs %Admin_Operate.
 *
 * Built from the %Api.Admin.Endpoints.Lock / WebSession / AsyncResult source
 * (read-only), so the behaviour notes below are IRIS's, not guesses:
 *  - GET /locks                 %SYS.LockQuery:WebListFilter (Removable is 0 for waiters and pending locks)
 *  - DELETE /lock?id=<DeleteID> SYS.Lock.DeleteOneLock; with checkTxn (default on) IRIS answers 409 when
 *                               the owner is in a transaction, and 404 when the lock has gone
 *  - GET /web-sessions          %CSP.Session:SessionInfo. Timeout is the idle expiry in UTC. AllowEndSession is
 *                               false for Management Portal (/csp/sys/…) and state-aware (Preserve=1) sessions,
 *                               but the delete itself doesn't check it, so the screen must
 *  - DELETE /web-session?id=    expires the session at once; the session daemon removes it within seconds
 *  - GET /async-results         only the signed-in user's jobs; IRIS purges them a day after they finish
 *  - GET /async-result?id=      full job: console output and result
 *  - POST /async-result/{cancel|pause|resume}?id=
 *                               Cancel: any queued job; running only for compact, defragment and integrity check.
 *                               Pause/Resume: only those three, while running/paused. Otherwise 409.
 */
import { get } from './api';
import { authFetch } from './auth';
import { writeJson } from './crud';

const q = encodeURIComponent;

/* ───────────── Locks ───────────── */

export interface LockRow {
  Pid: number;
  /** "Exclusive", "Shared/2", "Exclusive->Delock", "WaitExclusiveExact", "LockPending"… */
  ModeCount: string;
  Reference: string;
  Directory: string;
  /** Remote system name for ECP locks; '' when local. */
  System: string;
  Removable: boolean;
  DeleteID: string;
  CanBeExamined: boolean;
  RemoteOwner: boolean;
  /** "+214^LMFMON": line offset and routine the owner is running. */
  RoutineInfo: string;
  OSUserName: string;
}
export const getLocks = (): Promise<LockRow[]> => get('/locks');
/** Remove one lock. IRIS refuses (409) while the owner is in a transaction. */
export const removeLock = (deleteId: string): Promise<unknown> => writeJson('DELETE', `/lock?id=${q(deleteId)}`);

/* ───────────── Web sessions ───────────── */

export interface WebSession {
  ID: string;
  Username: string;
  /** 1 = state-aware: the session keeps its own process. */
  Preserve: number;
  Application: string;
  /** When the session expires if idle, "YYYY-MM-DD HH:MM:SS" in UTC. */
  Timeout: string;
  LicenseId: string;
  SesProcessId: string;
  AllowEndSession: boolean;
}
export const getWebSessions = (): Promise<WebSession[]> => get('/web-sessions');
export const endWebSession = (id: string): Promise<unknown> => writeJson('DELETE', `/web-session?id=${q(id)}`);
/** Session expiry: IRIS reports it in UTC. */
export const sessionExpiry = (s: WebSession): Date => new Date(`${s.Timeout.replace(' ', 'T')}Z`);

/* ───────────── Background jobs ───────────── */

export type JobState = 'Queued' | 'Running' | 'Finished' | 'Failed' | 'Canceled' | 'Paused';
export interface JobRow {
  GUID: string;
  /** How IRIS names the job: the request that started it, e.g. "POST /v2/database-dir/compact". */
  TaskName: string;
  State: JobState;
  FailureReason: string;
  TimeQueued: string;
  TimeStarted: string;
  TimeFinished: string;
}
export interface JobDetail extends Omit<JobRow, 'GUID'> {
  Console: string[];
  Result: unknown;
}
export const getJobs = (): Promise<JobRow[]> => get('/async-results');
export const getJob = (id: string): Promise<JobDetail> => get(`/async-result?id=${q(id)}`);
export const jobAction = (verb: 'cancel' | 'pause' | 'resume', id: string): Promise<unknown> =>
  writeJson('POST', `/async-result/${verb}?id=${q(id)}`);

/** Configured databases, for naming a directory. */
export const getDbNames = (): Promise<Array<{ Name: string; Directory: string }>> => get('/databases');

/** IRIS error texts sometimes arrive localised ("خطأ #82: …"); strip any "<word> #n:" prefixes. */
export const stripErrorPrefix = (s: string): string =>
  String(s ?? '').replace(/^(\s*[^\s#]{0,16}\s*#\s*-?\d+\s*:\s*)+/u, '').trim();

/* ───────────── Management Portal pages ───────────── */

export const opsPortal = {
  process: (pid: number): string => `/csp/sys/op/%25CSP.UI.Portal.ProcessDetails.zen?PID=${pid}&DISPLAYID=${pid}&$ID1=${pid}`,
};
const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
export const opsDocs = {
  locks: `${DOCS}GAPPS_locktable`,
  sessions: `${DOCS}GCSP_session`,
  jobs: `${DOCS}GSA_manage_background`,
};

/* ───────────── Failed count in red (Background jobs) ───────────── */

let redSheet: CSSStyleSheet | null = null;
/**
 * ev-segmented-button has no tone per segment, so its shadow root gets one
 * token-only rule: the "failed" segment turns red while there are failures.
 */
export function redFailed(seg: HTMLElement, on: boolean): void {
  const root = seg.shadowRoot;
  if (root && typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in root) {
    if (!redSheet) {
      redSheet = new CSSStyleSheet();
      redSheet.replaceSync(':host([data-failed]) .segment[data-value="failed"]:not(.segment--disabled):not(.segment--active) { color: var(--ev-color-danger); font-weight: 600; }');
    }
    if (!root.adoptedStyleSheets.includes(redSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, redSheet];
  }
  seg.toggleAttribute('data-failed', on);
}

/* ───────────── The portal's own monitoring load (Activity) ───────────── */

/** The cumulative counters behind Activity's throughput figures. */
export const RATE_KEYS = ['AllGlobalReferences', 'GlobalUpdateReferences', 'RoutineCalls', 'LogicalBlockRequests', 'BlockReads', 'BlockWrites', 'JournalEntries'] as const;
export type RateCounter = typeof RATE_KEYS[number];
export type CounterSet = Record<RateCounter, number>;
/** The reads the portal makes while Activity is open: a counters read, a metrics scrape, a process list. */
export type PortalRead = 'usage' | 'scrape' | 'proc';
export type ReadCosts = Record<PortalRead, CounterSet>;

const readCounters = (): Promise<CounterSet> => get<CounterSet>('/monitor/system-usage');
const diff = (a: CounterSet, b: CounterSet): CounterSet => Object.fromEntries(RATE_KEYS.map((k) => [k, b[k] - a[k]])) as CounterSet;

/**
 * What one of each portal read costs IRIS, per counter, measured rather than
 * assumed: two back-to-back counter reads give one counters read; a metrics
 * scrape and a process list, each bracketed by counter reads, give theirs.
 * Every read made here is reported through `onRead` so it can be counted too.
 * Other readers only ever inflate a measurement, so callers keep the minimum.
 */
export async function measureReadCosts(onRead: (kind: PortalRead, at: number) => void): Promise<ReadCosts> {
  const a = await readCounters(); onRead('usage', Date.now());
  const b = await readCounters(); onRead('usage', Date.now());
  await authFetchText('/api/monitor/metrics'); onRead('scrape', Date.now());
  const c = await readCounters(); onRead('usage', Date.now());
  await get('/processes'); onRead('proc', Date.now());
  const d = await readCounters(); onRead('usage', Date.now());
  const usage = diff(a, b);
  const less = (x: CounterSet): CounterSet => Object.fromEntries(RATE_KEYS.map((k) => [k, Math.max(0, x[k] - usage[k])])) as CounterSet;
  return { usage, scrape: less(diff(b, c)), proc: less(diff(c, d)) };
}
async function authFetchText(url: string): Promise<void> {
  const res = await authFetch(url, { headers: { Accept: 'text/plain' } });
  await res.text();
}

/** Keep the smaller of two measurements, per read and counter. */
export function minCosts(a: ReadCosts | null, b: ReadCosts): ReadCosts {
  if (!a) return b;
  const pick = (x: CounterSet, y: CounterSet): CounterSet => Object.fromEntries(RATE_KEYS.map((k) => [k, Math.min(x[k], y[k])])) as CounterSet;
  return { usage: pick(a.usage, b.usage), scrape: pick(a.scrape, b.scrape), proc: pick(a.proc, b.proc) };
}

/** The portal's own reads that landed in (start, end], per second of that window, per counter. */
export function portalRate(events: Array<{ kind: PortalRead; at: number }>, costs: ReadCosts, start: number, end: number): CounterSet {
  const secs = (end - start) / 1000;
  const out = Object.fromEntries(RATE_KEYS.map((k) => [k, 0])) as CounterSet;
  if (secs <= 0) return out;
  for (const e of events) {
    if (e.at <= start || e.at > end) continue;
    for (const k of RATE_KEYS) out[k] += costs[e.kind][k];
  }
  for (const k of RATE_KEYS) out[k] /= secs;
  return out;
}

/* ───────────── Shared memory by subsystem (Activity) ───────────── */

/** One row of IRIS's shared-memory use: heap (SMH) allocated / used, plus SMT and GST; bytes. */
export interface ShmRow { Description: string; SMHAllocated: number; SMHAvailable: number; SMHUsed: number; SMTUsed: number; GSTUsed: number; AllUsed: number }
export const getSharedMemory = (): Promise<ShmRow[]> => get('/monitor/system-usage/shared-memory');
