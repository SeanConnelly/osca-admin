// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One action set per task, whichever page shows it (Tasks › Upcoming or
 * Tasks › Schedule): the header's visible action and the ⋯ menu, with the
 * confirms for Run now, Suspend, Resume and Delete. The pages supply how to
 * change the schedule (Schedule's form, in the drawer or the full view) and
 * what to redraw afterwards.
 *
 * The visible action follows the task's state: Resume when it's suspended;
 * on a chained task (which can't be rescheduled here) the task it follows;
 * otherwise Change schedule.
 */
import { getTask, runTask, suspendTask, resumeTask, deleteTask, type TaskDetail } from './api-apps';
import { confirm, toast, errorText, AdminError, type MenuItem } from './crud';
import { esc, when, noPermissionText, type OdAction } from './ui';
import type { TaskView } from './screens/task-detail';

const NO_TASK = noPermissionText('%Admin_Task', 'task management');

/**
 * What each of IRIS's own task classes does when run, and what stops
 * happening while it's suspended, so confirms name the real effect.
 */
const EFFECTS: Record<string, { run: string; paused: string }> = {
  SwitchJournal: { run: 'switches the journal file now', paused: 'IRIS keeps writing to the current journal file until it’s switched some other way' },
  PurgeJournal: { run: 'deletes journal files past their retention now', paused: 'old journal files pile up on disk' },
  PurgeTaskHistory: { run: 'deletes Task Manager history older than the retention setting now', paused: 'the task history keeps growing' },
  IntegrityCheck: { run: 'checks every database’s integrity now, which puts heavy read load on the disks while it runs', paused: 'databases aren’t checked for structural problems' },
  SecurityScan: { run: 'scans the security database now, applying account and password expiry rules', paused: 'account and password expiry rules aren’t applied' },
  DiagnosticReport: { run: 'builds a diagnostic report now, and sends it to the WRC if that’s set up', paused: 'no scheduled diagnostic reports are made' },
  PurgeAudit: { run: 'deletes audit records older than the retention period now', paused: 'the audit database keeps growing' },
  InventoryScan: { run: 'scans the system inventory now', paused: 'the system inventory isn’t refreshed' },
  PurgeErrorsAndLogs: { run: 'purges old error-log and log entries now', paused: 'old error-log entries pile up' },
  CheckLogging: { run: 'checks for application logging left switched on now', paused: 'forgotten application logging isn’t caught' },
  PurgeBackupLog: { run: 'deletes backup-log messages older than 30 days now', paused: 'the backup log keeps growing' },
  PurgeZENReports: { run: 'deletes leftover Zen Reports temporary files now', paused: 'Zen Reports temporary files pile up' },
  FeatureTracker: { run: 'collects feature-usage data and sends it to InterSystems now', paused: 'no feature-usage data is sent' },
  CleanSourceJournal: { run: 'cleans old source-journal nodes now', paused: 'old source-journal nodes pile up' },
  PurgeInteropUsageMetrics: { run: 'consolidates and purges interoperability usage metrics now', paused: 'interoperability usage metrics pile up' },
  AutoStatsCollection: { run: 'collects SQL table statistics in every namespace now, which can take up to an hour', paused: 'SQL table statistics aren’t refreshed automatically' },
};
const effectOf = (d: TaskDetail | undefined): { run: string; paused: string } | undefined =>
  (d && /^%SYS\.Task\./.test(d.TaskClass) ? EFFECTS[d.TaskClass.slice('%SYS.Task.'.length)] : undefined);
const isDaily = (d: TaskDetail | undefined): boolean => !!d && /^daily$/i.test(String(d.TimePeriod)) && !/several/i.test(d.DailyFrequency);
const clock = (t: string): string => (t || '00:00').slice(0, 5);
/** "midnight" or "02:00": the clock time of a once-a-day run. */
const timeWord = (d: TaskDetail): string => { const t = clock(d.DailyStartTime); return t === '00:00' ? 'midnight' : t; };
/** /task/info "Error" is "Running" while a run is in progress. */
export const taskIsRunning = (v: TaskView): boolean => /^running$/i.test(v.info?.Error ?? '');

export interface TaskActionsOptions {
  /** %Admin_Task: false when known to be missing, null until known. */
  canTask(): boolean | null;
  /** The Task Manager's status ("Running", "Suspended"…). */
  manager(): string;
  /** A cached task detail, if the page has one. */
  cached(id: number): TaskDetail | undefined;
  /** The page's own Change schedule (Schedule's form), and why it's blocked right now. */
  changeSchedule(v: TaskView): void;
  changeBlocked(v: TaskView): string | null;
  navigate(path: string): void;
  /** Show another task (the one a chained task follows) the way this one is shown. */
  openTask(id: number): void;
  /** Something changed: re-read and redraw. */
  reload(): Promise<void>;
  /** The task is gone: leave its full view / peek, then reload. */
  deleted(id: number): Promise<void>;
}

export interface TaskActions {
  primary(v: TaskView): OdAction | null;
  menu(v: TaskView): MenuItem[];
}

export function taskActions(o: TaskActionsOptions): TaskActions {
  let busy = false;
  const noPriv = (): string | null => (o.canTask() === false ? NO_TASK : null);
  /** Runs one action at a time; errors become a toast. */
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (err) {
      toast(err instanceof AdminError && err.status === 404 ? 'That task no longer exists.' : errorText(err), 'danger');
      await o.reload();
    } finally { busy = false; }
  };
  const detail = async (id: number): Promise<TaskDetail | undefined> => {
    const d = o.cached(id);
    if (d) return d;
    try { return await getTask(id); } catch { return undefined; /* confirm falls back to general wording */ }
  };
  /** "the midnight run still happens" / "it still runs after Switch Journal" / "". */
  const stillRuns = (v: TaskView, d: TaskDetail | undefined): string => {
    if (v.after) return `it still runs after ${esc(v.after.Name)} as usual`;
    if (!v.next) return '';
    return isDaily(d) && d ? `the ${timeWord(d)} run still happens` : `the next scheduled run (${esc(when(v.next))}) still happens`;
  };
  /** "at midnight" / "after Switch Journal" / "at its scheduled times (next Mon 02:00)". */
  const whenItRuns = (v: TaskView, d: TaskDetail | undefined): string => {
    if (v.after) return `after ${esc(v.after.Name)}`;
    if (!v.next) return 'when started';
    return isDaily(d) && d ? `at ${timeWord(d)}` : `at its scheduled times (next ${esc(when(v.next))})`;
  };
  const managerNote = (): string => {
    const m = o.manager();
    return m && !/^running$/i.test(m) ? `<p>The Task Manager is ${esc(m.toLowerCase())}, so the task starts only once it’s resumed.</p>` : '';
  };

  const doRun = async (v: TaskView): Promise<void> => {
    const t = v.task;
    const d = await detail(t.Id);
    const effect = effectOf(d)?.run ?? (d ? `runs <span class="mono">${esc(d.TaskClass)}</span> in <span class="mono">${esc(d.NameSpace)}</span> now` : 'runs now');
    const after = stillRuns(v, d);
    const ok = await confirm({
      title: `Run ${t.Name} now?`,
      body: `<p>${esc(t.Name)} ${effect}${after ? `; ${after}` : ''}.</p><p>The Task Manager starts it at its next check, usually within a minute. The result appears in History.</p>${managerNote()}`,
      confirmLabel: 'Run now',
    });
    if (!ok) return;
    await runTask(t.Id);
    toast(`${t.Name} is queued to run. Its result appears in History.`);
    await o.reload();
  };
  const doSuspend = async (v: TaskView): Promise<void> => {
    const t = v.task;
    const d = await detail(t.Id);
    const paused = effectOf(d)?.paused;
    const ok = await confirm({
      title: `Suspend ${t.Name}?`,
      body: `<p>${esc(t.Name)} won’t run ${whenItRuns(v, d)} until it’s resumed${paused ? `, so ${paused}` : ''}.</p><p>A run already in progress isn’t stopped.</p>`,
      confirmLabel: 'Suspend task',
      danger: t.Type === 'System',
    });
    if (!ok) return;
    await suspendTask(t.Id);
    toast(`${t.Name} suspended. It won’t run until it’s resumed.`);
    await o.reload();
  };
  const doResume = async (v: TaskView): Promise<void> => {
    await resumeTask(v.task.Id);
    toast(`${v.task.Name} resumed. It runs at its next scheduled time.`);
    await o.reload();
  };
  const doDelete = async (v: TaskView): Promise<void> => {
    const t = v.task;
    const ok = await confirm({
      title: `Delete ${t.Name}?`,
      body: '<p>The task and its schedule are removed for good. Its past runs stay in History until they’re purged.</p><p>Type the task’s name to confirm.</p>',
      confirmLabel: 'Delete task',
      danger: true,
      typeToConfirm: t.Name,
      alternative: v.suspended ? undefined : { label: 'Suspend instead', onSelect: () => void act(() => doSuspend(v)) },
    });
    if (!ok) return;
    await deleteTask(t.Id);
    toast(`${t.Name} deleted.`);
    await o.deleted(t.Id);
  };

  const change = (v: TaskView): OdAction => ({ label: 'Change schedule', icon: 'calendar', run: () => o.changeSchedule(v), blocked: o.changeBlocked(v) });
  /** What the visible action is, so the menu never repeats it. */
  const primaryKind = (v: TaskView): 'resume' | 'follow' | 'change' | null =>
    (v.suspended ? 'resume' : v.after ? 'follow' : 'change');

  return {
    primary(v) {
      const kind = primaryKind(v);
      if (kind === 'resume') return { label: 'Resume', icon: 'play', run: () => void act(() => doResume(v)), blocked: noPriv() };
      if (kind === 'follow' && v.after) {
        const p = v.after;
        return { label: `Open ${p.Name}`, icon: 'link', run: () => o.openTask(p.Id) };
      }
      return change(v);
    },
    menu(v) {
      const np = noPriv();
      const kind = primaryKind(v);
      const t = v.task;
      const c = change(v);
      const items: MenuItem[] = [];
      if (kind !== 'change') items.push({ label: c.label, icon: c.icon, disabled: !!c.blocked, reason: c.blocked ?? '', onSelect: c.run });
      items.push({
        label: 'Run now…', icon: 'play', disabled: !!np || v.suspended || taskIsRunning(v),
        reason: np ?? (v.suspended ? 'Resume the task first: a suspended task doesn’t run' : 'It’s running now'), onSelect: () => void act(() => doRun(v)),
      });
      if (!v.suspended) items.push({ label: 'Suspend…', icon: 'pause', disabled: !!np, reason: np ?? '', onSelect: () => void act(() => doSuspend(v)) });
      items.push({ label: 'View run history', icon: 'file-text', onSelect: () => o.navigate('tasks/history') });
      items.push({
        label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!np || t.Type === 'System',
        reason: np ?? (v.suspended ? 'Built into IRIS, so it can’t be deleted. Suspended, it doesn’t run.' : 'Built into IRIS, so it can’t be deleted. Suspend it instead.'),
        onSelect: () => void act(() => doDelete(v)),
      });
      return items;
    },
  };
}
