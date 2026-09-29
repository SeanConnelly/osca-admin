// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The task peek and full view, shared by Tasks › Upcoming and Tasks › Schedule
 * through objectDetail(): the schedule, the last 10 runs and the last output.
 * Read-only: the actions (Change schedule, Run now…, Suspend…, Delete…) are the
 * screens' own. Run history comes from /task/history, read at most every 30 s.
 */
import { getTaskHistory, type TaskSummary, type TaskInfo, type TaskDetail, type TaskHistoryEntry } from '../api-apps';
import { isDate, irisDate, mono, esc, pill, when, relative, future, duration, num, odMeta, odSection, odKv, type OdFull, type Tone } from '../ui';

/** One task as both screens know it. */
export interface TaskView { task: TaskSummary; info?: TaskInfo; next: Date | null; suspended: boolean; after: TaskSummary | null }

const dim = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const SECRET = /pass|secret|token/i;

/** The row's state for the meta line: Suspended and Failed are the exceptions. */
export function taskState(v: TaskView): { label: string; tone: Tone; title?: string } {
  if (v.suspended) return { label: 'Suspended', tone: 'warning', title: 'Won’t run until it’s resumed' };
  // The same words as Upcoming's Next run cell and Schedule's tag: "After Switch Journal".
  if (v.after) return { label: `After ${v.after.Name}`, tone: 'neutral', title: `Runs straight after ${v.after.Name} finishes` };
  if (!v.next) return { label: 'On demand', tone: 'neutral', title: 'No schedule: it runs only when started' };
  return { label: 'Scheduled', tone: 'success' };
}
/**
 * "● Scheduled · %SYS · System task". In the full view (`full`) the description joins the line under the
 * title, where the peek shows it under the name, so it is never a row of the first card.
 */
export const taskMeta = (v: TaskView, full = false): string =>
  odMeta(taskState(v), [v.task.Namespace, v.task.Type === 'System' ? 'System task' : 'User task'],
    full && v.task.Description ? [`<span class="td-meta-desc" title="${esc(v.task.Description)}">${esc(v.task.Description)}</span>`] : []);
/** Whether it has ever finished a run (the summary's Last finished, or a run in the kept history). */
const everRan = (v: TaskView, runs: TaskHistoryEntry[]): boolean => runs.length > 0 || isDate(v.task.LastFinished);

// ── Run history ──
let hist: { at: number; list: TaskHistoryEntry[] } | null = null;
let pending: Promise<TaskHistoryEntry[]> | null = null;
/** The task's runs, newest first (Task Manager log lines left out). */
export async function taskRuns(id: number): Promise<TaskHistoryEntry[]> {
  if (!hist || Date.now() - hist.at > 30_000) {
    pending ??= getTaskHistory().finally(() => { pending = null; });
    hist = { at: Date.now(), list: await pending };
  }
  const start = (h: TaskHistoryEntry): number => (isDate(h.LastStart) ? irisDate(h.LastStart).getTime() : 0);
  return hist.list.filter((h) => h.TaskId === id && h.Routine !== 'TASKMGR').sort((a, b) => start(b) - start(a));
}
const failed = (h: TaskHistoryEntry): boolean => h.ErrNumber > 0 || (h.Status !== '1' && !/^success$/i.test(h.Result));
const errorOf = (h: TaskHistoryEntry): string => [h.Result, h.Status !== '1' && h.Status !== h.Result ? h.Status : ''].filter(Boolean).join('\n');
const secsOf = (h: TaskHistoryEntry): number =>
  (isDate(h.LastStart) && isDate(h.Completed) ? Math.max(0, (irisDate(h.Completed).getTime() - irisDate(h.LastStart).getTime()) / 1000) : NaN);
const took = (s: number): string => (!Number.isFinite(s) ? '—' : s < 1 ? '< 1s' : duration(s));
const past = (s: string): string => (isDate(s) ? `<span title="${esc(relative(irisDate(s)))}">${esc(when(irisDate(s)))}</span>` : dim('Never'));
/** As in History: "Succeeded" in tertiary text, "Failed" a red pill. */
const resultWord = (h: TaskHistoryEntry): string => (failed(h) ? pill('Failed', 'danger', errorOf(h)) : '<span style="color:var(--ev-color-text-tertiary)">Succeeded</span>');

/** The last 10 runs as a small table: Started · Duration · Result. */
function runsTable(runs: TaskHistoryEntry[]): string {
  if (!runs.length) return '<p>No runs in the kept history.</p>';
  return `<table class="mini-table"><thead><tr><th>Started</th><th class="r">Duration</th><th>Result</th></tr></thead><tbody>
    ${runs.slice(0, 10).map((h) => `<tr><td>${past(h.LastStart)}</td><td class="r">${esc(took(secsOf(h)))}</td><td>${resultWord(h)}</td></tr>`).join('')}
  </tbody></table>`;
}
/** What the last run left behind: its error in full, or its result line, and where output goes. */
function lastOutput(v: TaskView, runs: TaskHistoryEntry[], d: TaskDetail, full = false): string {
  const out = d.OutputDirectory || d.OutputFilename ? `${d.OutputDirectory}${d.OutputFilename}` : '';
  const last = runs[0];
  const file = (full ? kv2 : odKv)([['Output file', out ? mono(out) : dim('Not saved')]]);
  // Never run: Last finished (peek) or Last result (full view) already says so, once.
  if (!last) return everRan(v, runs) ? `<p>Its last run is older than the kept history.</p>${file}` : file;
  if (failed(last)) return `<pre class="pre-block td-output">${esc(errorOf(last))}</pre>${file}`;
  const text = last.Result && !/^success$/i.test(last.Result) ? last.Result : 'Finished without errors.';
  return `<p>${esc(text)}</p>${file}`;
}
/** The full view's strip has Next run and Runs as, and the subtitle has the namespace. */
function scheduleRows(v: TaskView, d: TaskDetail, full = false, runs: TaskHistoryEntry[] = []): Array<[string, string]> {
  return [
    ...(full ? [] : [['Next run', v.suspended ? dim('Not until it’s resumed') : v.next ? future(v.next) : v.after ? `After ${esc(v.after.Name)}` : dim('On demand')] as [string, string]]),
    // Kept in the full view too: it's a superset of the peek, and the history may not reach back that far.
    // In the full view the strip's Last result says "Never run", so the row goes when it never has.
    ...(full && !everRan(v, runs) ? [] : [['Last finished', past(v.task.LastFinished)] as [string, string]]),
    ['If IRIS was down when due', d.RescheduleOnStart ? 'Runs when IRIS starts' : 'Waits for the next time'],
    ['Runs on', /primary/i.test(d.MirrorStatus) ? (/not/i.test(d.MirrorStatus) ? 'Mirror members, not the primary' : 'The mirror primary only') : 'Any instance'],
  ];
}
function runsRows(d: TaskDetail, full = false): Array<[string, string]> {
  return [
    ['Task class', mono(d.TaskClass)],
    ...(full ? [] : [['Runs as', d.RunAsUser ? `<a class="link" href="#/security/users" data-user="${esc(d.RunAsUser)}">${esc(d.RunAsUser)}</a>` : dim('—')] as [string, string]]),
    ['Priority', esc(d.Priority)],
  ];
}
function wrongRows(d: TaskDetail): Array<[string, string]> {
  const mails = (xs: string[]): string => (xs.length ? xs.map(esc).join(', ') : dim('—'));
  return [
    ['On error', d.SuspendOnError ? 'Suspend the task' : 'Keep the schedule'],
    ['If terminated', d.SuspendTerminated ? 'Suspend the task' : 'Keep the schedule'],
    ['E-mail on completion', mails(d.EmailOnCompletion)],
    ['E-mail on error', mails(d.EmailOnError)],
  ];
}
/** Task-class settings; anything secret-shaped shows only whether it's set. */
function settingsRows(d: TaskDetail): Array<[string, string]> {
  const words = (k: string): string => {
    const s = k.replace(/^z+/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return s.charAt(0).toUpperCase() + s.slice(1).replace(/ ([A-Z][a-z])/g, (m) => m.toLowerCase());
  };
  return Object.entries(d.Settings ?? {}).map(([k, val]): [string, string] => {
    if (SECRET.test(k)) return [words(k), dim(val ? 'Set · hidden' : 'Not set')];
    if (val === '' || val === null || val === undefined) return [words(k), dim(/KeepDays$/i.test(k) ? 'Default' : '—')];
    const n = Number(val);
    // Units and plain words for the numbers IRIS keeps raw: days kept (0 = never purged), seconds.
    if (/KeepDays$/i.test(k) && Number.isInteger(n)) return ['Kept for', n <= 0 ? 'Forever (never purged)' : `${num(n)} day${n === 1 ? '' : 's'}`];
    if (/(Duration|Timeout|Seconds|Secs)$/i.test(k) && Number.isFinite(n)) return [words(k), n <= 0 ? 'No limit' : esc(duration(n))];
    return [words(k), mono(String(val))];
  });
}

/** Peek body: schedule, last output, the last 10 runs, what it runs. `sentence` is the schedule in words (plain text). */
export function taskPeekHtml(v: TaskView, d: TaskDetail, runs: TaskHistoryEntry[], sentence: string): string {
  return `${odSection('Schedule', `<p class="td-sentence">${esc(sentence)}</p>${odKv(scheduleRows(v, d))}`)}
    ${odSection('Last output', lastOutput(v, runs, d))}
    ${runs.length ? odSection('Last runs', runsTable(runs)) : ''}
    ${odSection('What it runs', odKv(runsRows(d)))}`;
}

/** Wide cards list their rows two to a line (label beside value), as Web applications does. */
const kv2 = (rows: Array<[string, string]>): string => odKv(rows).replace('class="od-kv"', 'class="od-kv wa-kv2"');
/** The last result from the task's own summary, when that run is older than the kept history. */
const priorResult = (v: TaskView): string => { const e = v.info?.Error ?? ''; return !e || /^task has expired/i.test(e) ? '—' : /^success$/i.test(e) ? 'Succeeded' : /^running$/i.test(e) ? 'Running' : 'Failed'; };

/** Full view: strip, a notice when its last run failed, then Schedule · Last runs · Last output | What it runs · When things go wrong. */
export function taskFullView(v: TaskView, d: TaskDetail, runs: TaskHistoryEntry[], sentence: string): OdFull {
  const kept = runs.length;
  const ok = runs.filter((h) => !failed(h)).length;
  const last = runs[0];
  return {
    // The state is in the subtitle, so the strip never repeats it.
    strip: [
      { label: 'Next run', value: v.suspended ? 'Suspended' : v.next ? when(v.next) : v.after ? `After ${v.after.Name}` : 'On demand', title: v.next ? relative(v.next) : undefined },
      // No red dot here: when it failed, the notice below carries the one red mark (with the error).
      { label: 'Last result', value: last ? (failed(last) ? 'Failed' : 'Succeeded') : everRan(v, runs) ? priorResult(v) : 'Never run' },
      { label: 'Success rate', value: kept ? `${Math.round((ok / kept) * 100)}%` : '—', caption: kept ? `${num(ok)} of ${num(kept)} kept runs` : '' },
      { label: 'Runs as', value: d.RunAsUser || '—' },
    ],
    notice: last && failed(last)
      ? `<div class="callout callout--one callout--danger td-notice" role="note"><ev-icon name="alert-circle" size="sm"></ev-icon><div><strong>The last run failed</strong><span> · ${esc(errorOf(last).split(/\r?\n/)[0])}</span></div></div>` : '',
    main: [
      // The description leads, then the schedule rule, as in the peek (the full view never shows less).
      // The description is in the subtitle (taskMeta full), as the peek has it under the name.
      { title: 'Schedule', body: `<p class="td-sentence">${esc(sentence)}</p>${kv2(scheduleRows(v, d, true, runs))}` },
      // Never run in the kept history: Last output says so once, with no empty Last runs card beside it.
      ...(kept ? [{ title: 'Last runs', head: kept > 10 ? `<span class="card-hint">${num(10)} of ${num(kept)}</span>` : '', body: runsTable(runs) }] : []),
      { title: 'Last output', body: lastOutput(v, runs, d, true) },
    ],
    side: [
      { title: 'What it runs', body: odKv(runsRows(d, true)) },
      { title: 'When things go wrong', body: odKv(wrongRows(d)) },
      ...(Object.keys(d.Settings ?? {}).length ? [{ title: 'Task settings', body: odKv(settingsRows(d)) }] : []),
    ],
  };
}
