// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one issues model: everything on this instance that needs a person,
 * ranked by severity. Home's "Needs attention" list renders it; the status bar
 * and nav badges can read the same list so they never disagree with Home.
 *
 * buildIssues() is pure: it only reads facts other modules already hold (the
 * shared metrics snapshot, the alerts store, the cached security graph) plus a
 * few cheap reads cached here (dashboard, background jobs, task history,
 * journal settings). Nothing here scrapes metrics or reads per-database
 * figures (those start background jobs).
 */
import { value, samples, systemState, type Snapshot } from './metrics';
import { getDashboard, type Alert, type Dashboard } from './api';
import { getJobs, type JobRow } from './api-ops';
import { getTaskHistory, type TaskHistoryEntry } from './api-apps';
import { getJournalSettings, samePath, type JournalSettings } from './api-disk';
import { getSecurityGraph, type SecurityGraph } from './api-security';
import { riskBanner } from './security-view';
import { severity } from './alerts';
import { duration, irisDate, pct } from './ui';

export type IssueTone = 'danger' | 'warning' | 'info';

export interface IssueAction {
  label: string;
  /** Route to open ("operations/jobs"). */
  go?: string;
  /** Select this object on arrival (Users, Roles, Resources; see linkTo). */
  select?: string;
  /** Copy this text instead of navigating. */
  copy?: string;
}

export interface Issue {
  /** Stable id, e.g. "security", "alerts", "jobs"; usable as a Home address ("home/overview/security"). */
  id: string;
  tone: IssueTone;
  /** Short title, plain text. */
  title: string;
  /** One short sentence, plain text. */
  detail: string;
  action: IssueAction;
}

/** Everything buildIssues reads. Any part may be missing while it loads. */
export interface IssueFacts {
  snap?: Snapshot | null;
  dash?: Dashboard | null;
  /** Alerts the portal holds (newest first). */
  alerts?: Alert[];
  graph?: SecurityGraph | null;
  jobs?: JobRow[] | null;
  history?: TaskHistoryEntry[] | null;
  journal?: JournalSettings | null;
}

const RANK: Record<IssueTone, number> = { danger: 0, warning: 1, info: 2 };
// Not ui.ts plural: the count is written without thousands separators.
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "3h ago", "25m ago": minutes at most, never seconds. */
export function agoShort(d: Date, now = Date.now()): string {
  const s = Math.max(0, (now - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  return `${duration(Math.floor(s / 60) * 60)} ago`;
}

/** A task run failed if IRIS logged an error, or neither the status nor the result says success (same rule as Task history). */
const runFailed = (h: TaskHistoryEntry): boolean => h.Routine !== 'TASKMGR' && (h.ErrNumber > 0 || (h.Status !== '1' && !/^success$/i.test(h.Result)));
/** The portal's own figure reads (database free space) are routine work, not the user's jobs. */
const monitoringJob = (j: JobRow): boolean => /database-dir\/info\b/.test(j.TaskName);

export function buildIssues(f: IssueFacts): Issue[] {
  const out: Issue[] = [];
  const snap = f.snap ?? null;
  const now = Date.now();

  // ── Security posture (the status bar's "Security" item) ──
  if (f.graph) {
    const risk = riskBanner(f.graph);
    const open = f.graph.webApps.filter((a) => a.Enabled && a.AuthenticationMethods.some((m) => /unauthenticated/i.test(m))).length;
    const openText = open ? `${plural(open, 'web application')} ${open === 1 ? 'needs' : 'need'} no sign-in` : '';
    if (risk?.tone === 'danger') {
      out.push({ id: 'security', tone: 'danger', title: 'Anyone has full access without signing in',
        detail: `UnknownUser holds %All${openText ? `, and ${openText}` : ''}.`, action: { label: 'Review', go: 'security/users', select: 'UnknownUser' } });
    } else if (risk) {
      out.push({ id: 'security', tone: 'warning', title: 'Security needs review', detail: risk.text, action: { label: 'Review', go: 'security/users' } });
    }
    if (open && risk?.tone !== 'danger') {
      out.push({ id: 'webapps', tone: 'warning', title: `${plural(open, 'web application')} ${open === 1 ? 'needs' : 'need'} no sign-in`,
        detail: 'Anyone who can reach them gets UnknownUser’s access.', action: { label: 'Open web apps', go: 'web/apps' } });
    }
  }

  // ── IRIS's own state and alerts ──
  if (snap) {
    const s = systemState(value(snap, 'iris_system_state'));
    if (s.tone === 'warning' || s.tone === 'danger') {
      out.push({ id: 'state', tone: s.tone, title: `IRIS reports a ${s.label.toLowerCase()} state`, detail: 'The instance has flagged its own overall health.', action: { label: 'Open alerts', go: 'logs/alerts' } });
    }
  }
  const dayAgo = now - 86_400_000;
  const recent = (f.alerts ?? []).filter((a) => Date.parse(a.time) >= dayAgo);
  if (recent.length) {
    const severe = recent.filter((a) => severity(a.severity).tone === 'danger').length;
    const latest = new Date(Date.parse(recent[0].time));
    out.push({ id: 'alerts', tone: 'warning', title: `${plural(recent.length, 'alert')} in the last 24 hours`,
      detail: `${severe === recent.length ? 'All severe' : `${severe} severe`}, latest ${agoShort(latest, now)}.`,
      action: { label: 'Open alerts', go: 'logs/alerts' } });
  } else if (snap) {
    const raised = value(snap, 'iris_system_alerts');
    if (raised > 0) {
      out.push({ id: 'alerts', tone: 'info', title: `${plural(raised, 'alert')} since IRIS started`, detail: 'None in the last 24 hours.', action: { label: 'Open alerts', go: 'logs/alerts' } });
    }
  }

  // ── Failed work ──
  if (f.jobs) {
    const failed = f.jobs.filter((j) => j.State === 'Failed' && !monitoringJob(j));
    if (failed.length) {
      const last = failed.map((j) => irisDate(j.TimeFinished || j.TimeQueued)).sort((a, b) => b.getTime() - a.getTime())[0];
      out.push({ id: 'jobs', tone: 'warning', title: `${plural(failed.length, 'background job')} failed`,
        detail: `The latest failed ${agoShort(last, now)}.`, action: { label: 'Show failed', go: 'operations/jobs/failed' } });
    }
  }
  if (f.history) {
    // A task whose most recent run failed: earlier failures that have since succeeded aren't news.
    const latest = new Map<number, TaskHistoryEntry>();
    for (const h of f.history) {
      if (h.Routine === 'TASKMGR') continue;
      const cur = latest.get(h.TaskId);
      if (!cur || h.LastStart > cur.LastStart) latest.set(h.TaskId, h);
    }
    const bad = [...latest.values()].filter(runFailed).sort((a, b) => b.LastStart.localeCompare(a.LastStart));
    if (bad.length) {
      out.push({ id: 'tasks', tone: 'warning', title: bad.length === 1 ? `Task “${bad[0].Name}” failed` : `${plural(bad.length, 'task')} failed on their last run`,
        detail: bad.length === 1 ? `Its last run was ${agoShort(irisDate(bad[0].LastStart), now)}.` : `Latest: ${bad[0].Name}, ${agoShort(irisDate(bad[0].LastStart), now)}.`,
        action: { label: 'Open history', go: 'tasks/history' } });
    }
  }

  // ── Capacity and machine pressure ──
  if (snap) {
    const volumes = new Set<string>();
    for (const d of samples(snap, 'iris_disk_percent_full')) {
      const vol = /^([a-z]:)/i.exec(d.labels.dir ?? '')?.[1]?.toUpperCase() ?? d.labels.dir ?? '';
      if (d.value < 85 || volumes.has(vol)) continue;
      volumes.add(vol);
      out.push({ id: `disk-${vol}`, tone: d.value >= 95 ? 'danger' : 'warning', title: `${vol} is ${pct(d.value)} full`, detail: 'Databases on this volume stop growing when it fills.', action: { label: 'Open capacity', go: 'databases/capacity' } });
    }
    for (const m of samples(snap, 'iris_db_max_size_mb')) {
      if (m.value <= 0) continue;
      const size = value(snap, 'iris_db_size_mb', { id: m.labels.id });
      if (size / m.value >= 0.9) out.push({ id: `dbmax-${m.labels.id}`, tone: 'warning', title: `${m.labels.id} is near its size limit`, detail: `${Math.round(size)} of ${Math.round(m.value)} MB used.`, action: { label: 'Open capacity', go: 'databases/capacity' } });
    }
    const used = value(snap, 'iris_license_consumed');
    const free = value(snap, 'iris_license_available');
    const total = used + free;
    if (Number.isFinite(total) && total > 0) {
      const p = (used / total) * 100;
      if (free <= 0) out.push({ id: 'license', tone: 'danger', title: 'Every license unit is in use', detail: 'New connections may be refused.', action: { label: 'Open license', go: 'settings/license' } });
      else if (p >= 80) out.push({ id: 'license', tone: 'warning', title: `License ${pct(p)} used`, detail: 'New connections are refused when units run out.', action: { label: 'Open license', go: 'settings/license' } });
    }
    const page = value(snap, 'iris_page_space_percent_used');
    if (page >= 70) out.push({ id: 'pagefile', tone: page >= 90 ? 'danger' : 'warning', title: `Page file ${pct(page)} used`, detail: 'The machine is short of memory and swapping to disk.', action: { label: 'Open activity', go: 'operations/overview' } });
    const cpu = value(snap, 'iris_cpu_usage');
    if (cpu >= 80) out.push({ id: 'cpu', tone: cpu >= 95 ? 'danger' : 'warning', title: `Machine CPU at ${pct(cpu)}`, detail: 'Everything on this machine slows down when the CPU is saturated.', action: { label: 'Open processes', go: 'operations/processes' } });
    const mem = value(snap, 'iris_phys_mem_percent_used');
    if (mem >= 85) out.push({ id: 'memory', tone: mem >= 95 ? 'danger' : 'warning', title: `Memory at ${pct(mem)}`, detail: 'The machine may start swapping to disk.', action: { label: 'Open activity', go: 'operations/overview' } });
    const longest = value(snap, 'iris_trans_open_secs_max');
    if (longest >= 60) out.push({ id: 'transaction', tone: 'warning', title: 'A transaction has been open a long time', detail: `The longest started ${duration(Math.floor(longest / 60) * 60)} ago.`, action: { label: 'Open processes', go: 'operations/processes' } });
  }

  // ── Resilience ──
  if (f.dash?.Status.LastBackup === 'Never') {
    out.push({ id: 'backup', tone: 'warning', title: 'No backup has ever run', detail: 'There is no recorded backup of this instance.', action: { label: 'Open tasks', go: 'tasks/upcoming' } });
  }
  if (f.journal && (!f.journal.AlternateDirectory || samePath(f.journal.CurrentDirectory, f.journal.AlternateDirectory))) {
    out.push({ id: 'journal', tone: 'info', title: 'Journals have no alternate directory', detail: 'If the journal disk fills or fails, IRIS has nowhere else to write.', action: { label: 'Open journals', go: 'operations/journals' } });
  }
  if (f.dash && !f.dash.Status.SystemMonitor) {
    out.push({ id: 'sysmon', tone: 'info', title: 'System Monitor is not running', detail: 'IRIS raises no health alerts of its own until it runs.', action: { label: 'Copy command', copy: 'do ^%SYSMONMGR' } });
  }

  // IRIS's overall state is driven by its alerts: when an alerts item is listed, it says the same thing.
  const list = out.some((x) => x.id === 'alerts') ? out.filter((x) => x.id !== 'state') : out;
  return list.map((x, i) => ({ x, i })).sort((a, b) => RANK[a.x.tone] - RANK[b.x.tone] || a.i - b.i).map(({ x }) => x);
}

/* ── Cheap reads, cached so Home and the status bar can share them ── */

interface Cached<T> { at: number; value: T | null; inflight: Promise<T | null> | null }
function cached<T>(load: () => Promise<T>, ttlMs: number): (fresh?: boolean) => Promise<T | null> {
  const c: Cached<T> = { at: 0, value: null, inflight: null };
  return (fresh = false) => {
    if (!fresh && c.value !== null && Date.now() - c.at < ttlMs) return Promise.resolve(c.value);
    if (c.inflight) return c.inflight;
    c.inflight = load().then((v) => { c.value = v; c.at = Date.now(); return v; }, () => c.value).finally(() => { c.inflight = null; });
    return c.inflight;
  };
}

export const issueSources = {
  dashboard: cached(getDashboard, 25_000),
  jobs: cached(getJobs, 55_000),
  history: cached(getTaskHistory, 55_000),
  journal: cached(getJournalSettings, 300_000),
  /** The security graph is shared with the status bar, which rebuilds it every two minutes. */
  graph: (): Promise<SecurityGraph | null> => getSecurityGraph().catch(() => null),
};
