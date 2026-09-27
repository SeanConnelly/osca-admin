// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tasks › Schedule — when every task runs over the next seven days, as a
 * week grid or a day timeline, with the Task Manager (the process that
 * starts them) at the top.
 *
 * Actions:
 *  - Change schedule (%Admin_Task): how often, which days, what time, and
 *    the dates it runs between. Exercised live on osca_test_ tasks, which
 *    were deleted afterwards; no real task was changed.
 *  - Suspend / resume / start the Task Manager (%Admin_Task): built from the
 *    endpoint source and never run against the dev instance.
 * Chained tasks ("runs after …") are changed in the Management Portal: the
 * API has no way to name the task they follow.
 *
 * Run times are worked out from each task's schedule; the first one always
 * matches the Task Manager's own next run.
 */
import '../styles-apps.css';
import '../styles-disk.css';
import '../styles-settings.css';
import '../styles-web.css';
import { getTasks, getTask, getTaskInfo, type TaskSummary, type TaskDetail, type TaskInfo } from '../api-apps';
import { getManager, suspendManager, resumeManager, startManager, saveSchedule, type ScheduleBody } from '../api-settings';
import { takeSelection, linkTo } from '../api-security';
import { taskMeta, taskRuns, taskPeekHtml, taskFullView, type TaskView } from './task-detail';
import { taskActions } from '../task-actions';
import { requestNewTask } from '../api-web';
import { liveGate } from './apps-live';
import {
  isDate,
  esc, chip, num, when, relative, irisDate, skeleton, errorPanel, liveIndicator, viewTabs, bindViewTabs, noPermissionText,
  objectDetail, odSection, strip, type ObjectDetailHandle,
  type ScreenCtx, type Tone,
} from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, type MenuHandle, editorShell, panelWidth, section, textField, selectField, checkField, dateField,
  readForm, AdminError, type FieldProblem, type EditorHandle, type FormValues,
} from '../crud';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 60_000;
const DAY = 86_400_000;
const NO_TASK = noPermissionText('%Admin_Task', 'task management');
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'last'];
/** Task classes that read the disks hard; two of them starting together is worth a note. */
const HEAVY = /IntegrityCheck|AutoStatsCollection|Backup/i;

type View = 'week' | 'day';

interface Run { at: Date; chained: boolean }
interface Row {
  task: TaskSummary; detail?: TaskDetail; info?: TaskInfo;
  suspended: boolean; parent: TaskSummary | null;
  /** Runs from now to the end of the seventh day. */
  runs: Run[];
  next: Date | null;
}

// ── Schedule arithmetic ──────────────────────────────────────────────

const midnight = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s: string): Date | null => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null);
const daysBetween = (a: Date, b: Date): number => Math.round((midnight(b).getTime() - midnight(a).getTime()) / DAY);
/** "02:00:00" → minutes after midnight; NaN if not a time. */
const minutesOf = (t: string): number => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t ?? '').trim());
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const hhmm = (mins: number): string => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const clock = (d: Date): string => hhmm(d.getHours() * 60 + d.getMinutes());
const dayName = (d: Date, now = new Date()): string => {
  const n = daysBetween(now, d);
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : DAYS[d.getDay()];
};
const shortDate = (d: Date): string => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const period = (d: TaskDetail): string => String(d.TimePeriod ?? '');
const onDemand = (d: TaskDetail): boolean => /on demand/i.test(period(d));
const chainedPeriod = (d: TaskDetail): boolean => /run after/i.test(period(d));
const several = (d: Pick<TaskDetail, 'DailyFrequency'>): boolean => /several/i.test(String(d.DailyFrequency));

/** The start times (minutes after midnight) on a day the task runs. */
function timesOfDay(d: Pick<TaskDetail, 'DailyFrequency' | 'DailyFrequencyTime' | 'DailyIncrement' | 'DailyStartTime' | 'DailyEndTime'>): number[] {
  const start = minutesOf(d.DailyStartTime) || 0;
  if (!several(d)) return [start];
  const inc = Math.max(1, Number(d.DailyIncrement) || 1) * (/hour/i.test(String(d.DailyFrequencyTime)) ? 60 : 1);
  const endRaw = minutesOf(d.DailyEndTime);
  const end = !Number.isFinite(endRaw) || endRaw === 0 ? 24 * 60 - 1 : endRaw;
  const out: number[] = [];
  for (let m = start; m <= end && out.length < 1440; m += inc) out.push(m);
  return out;
}

/** Whether the task's period puts a run on this calendar day. */
function runsOnDay(d: TaskDetail, day: Date): boolean {
  const every = Math.max(1, Number(d.TimePeriodEvery) || 1);
  const start = parseYmd(d.StartDate) ?? day;
  if (day < midnight(start)) return false;
  const end = parseYmd(d.EndDate);
  if (end && day > end) return false;
  const p = period(d);
  const months = (day.getFullYear() - start.getFullYear()) * 12 + day.getMonth() - start.getMonth();
  if (/special/i.test(p)) {
    const [w, wd] = String(d.TimePeriodDay).split('^').map(Number);
    if (day.getDay() + 1 !== wd || months % every !== 0) return false;
    const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
    return w === 5 ? day.getDate() + 7 > last : Math.ceil(day.getDate() / 7) === w;
  }
  if (/monthly/i.test(p)) {
    const want = Number(d.TimePeriodDay) || 1;
    const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
    return months % every === 0 && day.getDate() === Math.min(want, last);
  }
  if (/weekly/i.test(p)) {
    const days = String(d.TimePeriodDay).split('').map(Number);
    if (!days.includes(day.getDay() + 1)) return false;
    const weeks = Math.floor(daysBetween(addDays(start, -start.getDay()), addDays(day, -day.getDay())) / 7);
    return weeks % every === 0;
  }
  if (/daily/i.test(p)) return daysBetween(start, day) % every === 0;
  return false;
}

/** Every run in [from, to). */
function runsBetween(d: TaskDetail, from: Date, to: Date): Date[] {
  if (onDemand(d) || chainedPeriod(d)) return [];
  const out: Date[] = [];
  const times = timesOfDay(d);
  for (let day = midnight(from); day < to && out.length < 5000; day = addDays(day, 1)) {
    if (!runsOnDay(d, day)) continue;
    for (const m of times) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(m / 60), m % 60);
      if (at >= from && at < to) out.push(at);
    }
  }
  return out;
}

const listOf = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The schedule as one plain-English phrase. `dates: false` leaves out "starting …" and "until …",
 * for the form, whose date fields right above already say them.
 */
export function describe(d: TaskDetail, parent: TaskSummary | null, opts: { dates?: boolean } = {}): string {
  if (onDemand(d)) return 'Only when someone starts it';
  if (chainedPeriod(d)) return `Straight after ${parent ? `“${parent.Name}”` : 'another task'} finishes`;
  const n = Math.max(1, Number(d.TimePeriodEvery) || 1);
  const p = period(d);
  let base: string;
  if (/special/i.test(p)) {
    const [w, wd] = String(d.TimePeriodDay).split('^').map(Number);
    base = `On the ${ORDINAL[w] ?? `week ${w}`} ${DAYS[(wd || 1) - 1]} of ${n > 1 ? `every ${n} months` : 'every month'}`;
  } else if (/monthly/i.test(p)) {
    base = `On day ${Number(d.TimePeriodDay) || 1} of ${n > 1 ? `every ${n} months` : 'every month'}`;
  } else if (/weekly/i.test(p)) {
    const days = String(d.TimePeriodDay).split('').map((c) => DAYS[Number(c) - 1]).filter(Boolean);
    base = `${n > 1 ? `Every ${n} weeks` : 'Every week'}${days.length ? ` on ${listOf(days)}` : ''}`;
  } else {
    base = n > 1 ? `Every ${n} days` : 'Every day';
  }
  const start = minutesOf(d.DailyStartTime) || 0;
  let times: string;
  if (several(d)) {
    const inc = Math.max(1, Number(d.DailyIncrement) || 1);
    const unit = /hour/i.test(String(d.DailyFrequencyTime)) ? 'hour' : 'minute';
    const end = minutesOf(d.DailyEndTime);
    times = `every ${inc > 1 ? `${inc} ${unit}s` : unit} from ${hhmm(start)}${!Number.isFinite(end) || end === 0 ? ' until midnight' : ` to ${hhmm(end)}`}`;
  } else {
    times = start === 0 ? 'at midnight' : `at ${hhmm(start)}`;
  }
  const sd = opts.dates === false ? null : parseYmd(d.StartDate);
  const ed = opts.dates === false ? null : parseYmd(d.EndDate);
  const long = (x: Date): string => x.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${base}${several(d) ? ',' : ''} ${times}${sd && sd > new Date() ? `, starting ${long(sd)}` : ''}${ed ? `, until ${long(ed)}` : ''}`;
}

// ── The "when it runs" form: shared by Change schedule here and New task on Upcoming ──

export const WHEN_PERIODS = [
  { value: 'Daily', label: 'Every day, or every few days' },
  { value: 'Weekly', label: 'On days of the week' },
  { value: 'Monthly', label: 'Monthly, on a date' },
  { value: 'Monthly Special', label: 'Monthly, on a weekday' },
  { value: 'On Demand', label: 'Only when someone starts it' },
];
const UNIT = { Daily: 'days', Weekly: 'weeks', Monthly: 'months', 'Monthly Special': 'months' } as Record<string, string>;
/** Mon … Sun, with IRIS's day digits (1 = Sunday). */
const WEEK = [2, 3, 4, 5, 6, 7, 1];
const TIMED = ['Daily', 'Weekly', 'Monthly', 'Monthly Special'];

/** A schedule to start the form from: a task's own, or a blank for a new task. */
export type WhenBase = Pick<TaskDetail, 'TimePeriod' | 'TimePeriodEvery' | 'TimePeriodDay' | 'DailyFrequency' | 'DailyFrequencyTime' | 'DailyIncrement' | 'DailyStartTime' | 'DailyEndTime' | 'StartDate' | 'EndDate'>;
/** A new task: every day at 02:00, from today. */
export const NEW_WHEN: WhenBase = {
  TimePeriod: 'Daily', TimePeriodEvery: 1, TimePeriodDay: '', DailyFrequency: 'Once', DailyFrequencyTime: '', DailyIncrement: '',
  DailyStartTime: '02:00:00', DailyEndTime: '', StartDate: '', EndDate: '',
};

/**
 * The fields (sections "How often", "Time of day", "Dates" and the preview line), filled from `d`.
 * `first` renames the first section; `preview: false` leaves the preview line for the caller to place.
 */
export function whenSections(d: WhenBase, opts: { first?: string; preview?: boolean } = {}): string {
  const p = onDemand(d as TaskDetail) ? 'On Demand' : WHEN_PERIODS.some((x) => x.value === period(d as TaskDetail)) ? period(d as TaskDetail) : 'Daily';
  const weekDays = /weekly/i.test(period(d as TaskDetail)) ? String(d.TimePeriodDay).split('').map(Number) : [2];
  const [sw, sd] = /special/i.test(period(d as TaskDetail)) ? String(d.TimePeriodDay).split('^') : ['1', '2'];
  const start = minutesOf(d.DailyStartTime) || 0;
  const end = minutesOf(d.DailyEndTime);
  const sdStored = parseYmd(d.StartDate);
  const today = ymd(new Date());
  const startValue = sdStored && ymd(sdStored) > today ? ymd(sdStored) : today;
  const show = (whenP: string[], html: string, key: string): string => `<div data-sch-when="${esc(whenP.join(' '))}" data-sch-key="${key}">${html}</div>`;
  return section(opts.first ?? 'How often',
      selectField('Period', 'Runs', WHEN_PERIODS, p) +
      show(TIMED, textField('Every', 'Every', String(Math.max(1, Number(d.TimePeriodEvery) || 1)), { width: 'sm', hint: '1 for every one, 2 for every other, and so on.' }), 'every') +
      show(['Weekly'], `<p class="crud-section-hint">On</p><div class="sch-days">${WEEK.map((n) => checkField(`Day${n}`, DAYS[n - 1].slice(0, 3), weekDays.includes(n))).join('')}</div>`, 'week') +
      show(['Monthly'], selectField('MonthDay', 'Day of the month', Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })), String(Number(d.TimePeriodDay) || 1), { width: 'sm', hint: 'In shorter months, a day past the end means the last day.' }), 'month') +
      show(['Monthly Special'], `<div class="crud-row">${selectField('SpecWeek', 'Which', [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: ORDINAL[n][0].toUpperCase() + ORDINAL[n].slice(1) })), sw)}${
        selectField('SpecDay', 'Weekday', WEEK.map((n) => ({ value: String(n), label: DAYS[n - 1] })), sd)}</div>`, 'special')) +
    show(TIMED, section('Time of day',
      selectField('Freq', 'On those days', [{ value: 'Once', label: 'Once' }, { value: 'Several', label: 'Several times' }], several(d) ? 'Several' : 'Once') +
      `<div data-sch-freq="Once">${textField('At', 'At', hhmm(start), { width: 'sm', mono: true, placeholder: 'HH:MM', hint: '24-hour clock, server time.' })}</div>
       <div data-sch-freq="Several"><div class="crud-row">${textField('Inc', 'Every', String(Number(d.DailyIncrement) || 15), { width: 'sm' })}${
         selectField('Unit', 'Unit', [{ value: 'Minutes', label: 'minutes' }, { value: 'Hourly', label: 'hours' }], /hour/i.test(String(d.DailyFrequencyTime)) ? 'Hourly' : 'Minutes', { width: 'sm' })}</div>
         <div class="crud-row">${textField('From', 'From', hhmm(start), { width: 'sm', mono: true, placeholder: 'HH:MM' })}${
           textField('Until', 'Until', Number.isFinite(end) && end > 0 ? hhmm(end) : '', { width: 'sm', mono: true, placeholder: 'midnight', hint: 'Leave empty to keep going until midnight.' })}</div></div>`), 'time') +
    show(TIMED, section('Dates',
      `<div class="crud-row">${dateField('StartDate', 'First run on or after', startValue, { min: today, hint: '“Every few days or weeks” counts from here.' })}${
        dateField('EndDate', 'Last run by', d.EndDate || '', { min: today, hint: 'Optional.' })}</div>`), 'dates') +
    (opts.preview === false ? '' : '<p class="sch-preview" id="sch-preview" aria-live="polite"></p>');
}

/** The form's values as the schedule fields IRIS reads. */
export function whenBody(v: FormValues): ScheduleBody {
  const p = String(v.Period || 'Daily') as ScheduleBody['TimePeriod'];
  const sev = String(v.Freq) === 'Several';
  const day = p === 'Weekly' ? WEEK.filter((n) => v[`Day${n}`]).sort().join('')
    : p === 'Monthly' ? Number(v.MonthDay || 1)
      : p === 'Monthly Special' ? `${v.SpecWeek || 1}^${v.SpecDay || 2}` : '';
  const start = minutesOf(String(v.At ?? ''));
  const from = minutesOf(String(v.From ?? ''));
  const until = String(v.Until ?? '').trim();
  return {
    TimePeriod: p,
    TimePeriodEvery: Math.max(1, Number(String(v.Every ?? '1').trim()) || 1),
    TimePeriodDay: day,
    DailyFrequency: sev ? 'Several' : 'Once',
    DailyFrequencyTime: sev ? (String(v.Unit) === 'Hourly' ? 'Hourly' : 'Minutes') : '',
    DailyIncrement: sev ? Math.max(1, Number(String(v.Inc ?? '').trim()) || 1) : '',
    DailyStartTime: `${hhmm(sev ? (Number.isFinite(from) ? from : 0) : (Number.isFinite(start) ? start : 0))}:00`,
    DailyEndTime: sev && until ? `${hhmm(minutesOf(until) || 0)}:00` : '',
    StartDate: String(v.StartDate || ymd(new Date())),
    EndDate: String(v.EndDate || ''),
  };
}
const asDetail = (b: ScheduleBody, base: WhenBase): TaskDetail => ({ ...base, ...b } as TaskDetail);

/**
 * IRIS counts a schedule from its start date and refuses one whose first run
 * is already past, so a start date of today or earlier moves to the first day
 * whose first run is still ahead.
 */
export function settleStart(b: ScheduleBody, base: WhenBase): ScheduleBody {
  if (b.TimePeriod === 'On Demand') return b;
  const today = midnight(new Date());
  const chosen = parseYmd(b.StartDate) ?? today;
  if (chosen > today) return b;
  for (let i = 0; i < 2; i++) {
    const s = addDays(today, i);
    const first = runsBetween(asDetail({ ...b, StartDate: ymd(s) }, base), s, addDays(s, 400))[0];
    if (first && first > new Date()) return { ...b, StartDate: ymd(s) };
  }
  return { ...b, StartDate: ymd(addDays(today, 1)) };
}

/** Everything to fix in the schedule fields, per field. */
export function whenProblems(v: FormValues): FieldProblem[] {
  const out: FieldProblem[] = [];
  const per = String(v.Period);
  if (per === 'On Demand') return out;
  const every = String(v.Every ?? '').trim();
  if (!/^\d+$/.test(every) || Number(every) < 1) out.push({ field: 'Every', label: 'Every', message: 'Enter a whole number, 1 or more' });
  if (per === 'Weekly' && !WEEK.some((n) => v[`Day${n}`])) out.push({ field: 'Day2', label: 'Days of the week', message: 'Pick at least one day' });
  if (String(v.Freq) === 'Several') {
    const inc = String(v.Inc ?? '').trim();
    if (!/^\d+$/.test(inc) || Number(inc) < 1) out.push({ field: 'Inc', label: 'Every', message: 'Enter a whole number, 1 or more' });
    if (!Number.isFinite(minutesOf(String(v.From ?? '')))) out.push({ field: 'From', label: 'From', message: 'Enter a time such as 08:00' });
    const until = String(v.Until ?? '').trim();
    if (until && !Number.isFinite(minutesOf(until))) out.push({ field: 'Until', label: 'Until', message: 'Enter a time such as 18:00, or leave it empty' });
    else if (until && minutesOf(until) <= minutesOf(String(v.From ?? ''))) out.push({ field: 'Until', label: 'Until', message: 'Must be later than From' });
  } else if (!Number.isFinite(minutesOf(String(v.At ?? '')))) out.push({ field: 'At', label: 'At', message: 'Enter a time such as 02:00' });
  const sdv = String(v.StartDate ?? ''), edv = String(v.EndDate ?? '');
  if (edv && sdv && edv < sdv) out.push({ field: 'EndDate', label: 'Last run by', message: 'Must be on or after the first date' });
  return out;
}

/** The next `count` runs of the schedule the form describes (none for On demand, or while it has problems). */
export function whenNext(v: FormValues, base: WhenBase, count: number): Date[] {
  if (String(v.Period) === 'On Demand' || whenProblems(v).length) return [];
  const now = new Date();
  return runsBetween(asDetail(settleStart(whenBody(v), base), base), now, addDays(midnight(now), 62)).slice(0, count);
}
/** "Tomorrow 02:00", "Thursday 02:00", "Oct 12 02:00": one upcoming run. */
export const runLabel = (x: Date, now = new Date()): string =>
  `${dayName(x, now)} ${daysBetween(now, x) > 1 ? `${x.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ` : ''}${clock(x)}`;
/** The schedule in words, from the form. */
export const whenSentence = (v: FormValues, base: WhenBase): string =>
  (String(v.Period) === 'On Demand' ? 'Only when someone starts it' : describe(asDetail(settleStart(whenBody(v), base), base), null, { dates: false }));

/** Show the fields that apply to the chosen period and frequency, and refresh the preview line. */
export function syncWhen(host: HTMLElement, base: WhenBase, count: number, suspended = false): void {
  const v = readForm(host);
  const per = String(v.Period || 'Daily');
  host.querySelectorAll<HTMLElement>('[data-sch-when]').forEach((el) => { el.hidden = !(el.dataset.schWhen ?? '').split(' ').includes(per); });
  host.querySelectorAll<HTMLElement>('[data-sch-freq]').forEach((el) => { el.hidden = el.dataset.schFreq !== String(v.Freq || 'Once'); });
  host.querySelector('[data-sch-key="every"] ev-form-field')?.setAttribute('label', `Every (${UNIT[per] ?? 'days'})`);
  const prev = host.querySelector('#sch-preview');
  if (!prev) return;
  if (per === 'On Demand') { prev.textContent = 'It won’t run on its own; start it from Upcoming with Run now.'; return; }
  if (whenProblems(v).length) { prev.textContent = ''; return; }
  // A suspended task has no future runs: say so rather than listing times that won't happen.
  if (suspended) { prev.textContent = `${whenSentence(v, base)}. Suspended: no runs until it’s resumed.`; return; }
  const next = whenNext(v, base, count);
  // IRIS won't take a first run that's already past, so a start of today can become tomorrow: say why, once.
  const b = whenBody(v);
  const moved = next.length && settleStart(b, base).StartDate !== b.StartDate ? ' Today’s time has already passed.' : '';
  prev.textContent = `${whenSentence(v, base)}. ${next.length ? `Next: ${next.map((x) => runLabel(x)).join(', ')}.${moved}` : 'No run in the next two months.'}`;
}

/** Chained tasks ("runs after …") can't be rescheduled here: the API has no way to name the task they follow. */
export const isChained = (d: TaskDetail): boolean => chainedPeriod(d);
/** Why Change schedule is blocked on a chained task, in plain words. */
export const chainedReason = (after: Pick<TaskSummary, 'Name'> | null): string =>
  after ? `Runs straight after ${after.Name}, so it has no schedule of its own. Change ${after.Name}’s schedule instead.`
    : 'Runs straight after another task, so it has no schedule of its own. Change that task’s schedule instead.';

/**
 * Change schedule: one task's When form in `host`, which is Schedule's peek drawer, or the body of a
 * task's full view (Schedule's or Upcoming's), where the page title already names the task. It saves
 * the schedule, then hands over to onSaved; `signal` detaches its listeners when the form goes.
 */
export function scheduleEditor(host: HTMLElement, o: {
  task: TaskSummary; detail: TaskDetail; inFull: boolean; signal: AbortSignal;
  /** Suspended (the task, or per /task/info): the preview shows no future runs. */
  suspended?: boolean;
  onSaved: (body: ScheduleBody) => Promise<void>; onCancel: () => void;
}): EditorHandle {
  const { task: t, detail: d } = o;
  const suspended = o.suspended ?? t.Suspended;
  // The warning sits in the section gutter like every field, under What changes.
  const systemNote = t.Type === 'System' ? `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>${esc(t.Name)} is one of IRIS’s own tasks. Its default schedule is chosen to keep the instance tidy; if you change it, keep it running regularly.</div></div>` : '';
  const editor = editorShell(host, {
    subtitle: o.inFull ? undefined : `Task ${esc(t.Id)}`,
    title: o.inFull ? 'Change schedule' : `Schedule for ${esc(t.Name)}`,
    name: t.Name,
    submitLabel: 'Save schedule',
    sections: whenSections(d, { first: 'General', preview: false }) +
      section('What changes', `<p class="sch-change">Now: ${esc(describe(d, null))}.</p><p class="sch-preview sch-change" id="sch-preview" aria-live="polite"></p>${systemNote}`),
    check: () => whenProblems(readForm(host)),
    onSubmit: async (v) => {
      const body = settleStart(whenBody(v), d);
      await saveSchedule(t.Id, body);
      await o.onSaved(body);
    },
    onCancel: o.onCancel,
  });
  const key = (): string => JSON.stringify(whenBody(readForm(host)));
  const initial = key();
  const sync = (): void => {
    syncWhen(host, d, 4, suspended);
    const prev = host.querySelector('#sch-preview');
    if (!prev?.textContent) return;
    prev.textContent = key() === initial ? 'No changes yet.' : `After saving: ${prev.textContent}`;
  };
  for (const ev of ['ev-select-change', 'ev-input-input', 'ev-date-picker-change', 'ev-checkbox-change', 'change', 'input']) host.addEventListener(ev, sync, { signal: o.signal });
  sync();
  return editor;
}

// ── Screen ───────────────────────────────────────────────────────────

export function scheduleScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="wa-list-view" id="sch-list-view">
      <div id="sch-facts" aria-label="Schedule at a glance">${skeleton(2)}</div>
      ${viewTabs('sch-tabs', [{ value: 'week', label: 'Next 7 days' }, { value: 'day', label: 'Day timeline' }], 'week')}
      <div class="toolbar-row" id="sch-toolbar" hidden>
        <ev-segmented-button id="sch-daypick" size="sm" aria-label="Day to show"></ev-segmented-button>
      </div>
      <ev-detail-panel id="sch-panel" overlay-below="960" class="workspace sch-ws">
        <div class="sch-col">
          <div class="set-main sch-main" id="sch-main">${skeleton(10)}</div>
          <p class="table-foot" id="sch-foot"></p>
        </div>
        <aside slot="detail" class="detail" id="sch-detail" aria-label="Task schedule"></aside>
      </ev-detail-panel>
    </div>
    <div id="sch-full" hidden></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#sch-panel');
  const main = $('#sch-main');
  const detailEl = $('#sch-detail');
  const fullEl = $('#sch-full');
  const dayPick = $<HTMLElement & { options: unknown; value: string }>('#sch-daypick');

  let rows: Row[] = [];
  let manager = '';
  let loaded = false;
  let view: View = 'week';
  let dayIndex = 0;
  let selected: number | null = null;
  let canTask: boolean | null = null;
  let alive = true;
  let busy = false;
  let factsHtml = '';
  let mainHtml = '';
  /** The "N tasks run every day" group in the week grid: folded until opened. */
  let dailyOpen = false;
  let windowStart = midnight(new Date());
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let formEvents: AbortController | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; formEvents?.abort(); formEvents = null; ctx.beforeLeave(null); };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });
  ctx.beforeLeave(async () => (editor ? editor.guard() : true));
  let od: ObjectDetailHandle | null = null;
  const gate = liveGate(panel, ctx.onLeave);

  const running = (): boolean => /^running$/i.test(manager);
  const scheduled = (): Row[] => rows.filter((r) => r.runs.length);
  /** Suspended tasks: no runs until resumed; listed at the foot of the week grid, not in "not this week". */
  const suspendedRows = (): Row[] => rows.filter((r) => r.suspended).sort((a, b) => a.task.Name.localeCompare(b.task.Name));
  const unscheduled = (): Row[] => rows.filter((r) => !r.runs.length && !r.suspended);
  const willRun = (r: Row): boolean => !r.suspended && running();

  // ── Clashes: heavy tasks starting at the same minute ──
  interface Clash { at: Date; names: string[] }
  const clashes = (): Clash[] => {
    const by = new Map<number, Row[]>();
    for (const r of rows) {
      if (r.suspended || !r.detail || !HEAVY.test(r.detail.TaskClass)) continue;
      for (const run of r.runs) { const k = run.at.getTime(); by.set(k, [...(by.get(k) ?? []), r]); }
    }
    const out: Clash[] = [];
    const seen = new Set<string>();
    for (const [k, rs] of [...by].sort((a, b) => a[0] - b[0])) {
      if (rs.length < 2) continue;
      const names = [...new Set(rs.map((r) => r.task.Name))].sort();
      const sig = `${names.join('|')}@${clock(new Date(k))}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ at: new Date(k), names });
    }
    return out;
  };

  // ── Banner ──
  /** One notice line: the Task Manager being down beats a clash of heavy tasks. Detail on hover. */
  let bannerHtml = '';
  const renderBanner = (): void => {
    let html = '';
    if (manager && !running()) {
      const tip = `The times below are when tasks are due. None of them starts until the Task Manager is ${/suspend/i.test(manager) ? 'resumed' : 'started'}.`;
      html = `<div class="page-notice page-notice--warning" role="status" title="${esc(tip)}">
        <ev-icon name="alert-triangle" size="sm"></ev-icon>
        <span class="page-notice-text" title="The Task Manager is ${esc(manager.toLowerCase())}, so no scheduled task will run">The Task Manager is ${esc(manager.toLowerCase())}, so no scheduled task will run</span>
      </div>`;
    } else {
      const c = clashes();
      if (c.length) {
        const first = c[0];
        const tip = `They all read heavily from disk; moving one to another time lowers the load.${c.length > 1 ? ` It happens ${num(c.length)} times this week.` : ''}`;
        const target = rows.find((r) => r.task.Name === first.names[0]);
        const whenText = dayName(first.at) === 'Today' || dayName(first.at) === 'Tomorrow' ? dayName(first.at).toLowerCase() : `on ${dayName(first.at)}`;
        const line = `${listOf(first.names)} ${first.names.length === 2 ? 'both ' : ''}start at ${clock(first.at)} ${whenText}, loading the disks together`;
        html = `<div class="page-notice page-notice--warning" role="status">
          <ev-icon name="alert-triangle" size="sm"></ev-icon>
          <span class="page-notice-text" title="${esc(`${line}. ${tip}`)}">${esc(line)}</span>
          ${target ? `<button type="button" class="page-notice-link" data-sch-open="${target.task.Id}">Show it</button>` : ''}
        </div>`;
      }
    }
    if (html === bannerHtml) return;
    bannerHtml = html;
    ctx.banners.innerHTML = html;
    ctx.banners.querySelector<HTMLElement>('[data-sch-open]')?.addEventListener('click', (e) => void select(Number((e.currentTarget as HTMLElement).dataset.schOpen)));
  };

  // ── Summary ──
  const renderFacts = (): void => {
    const now = new Date();
    const live = scheduled().filter((r) => !r.suspended);
    const total = live.reduce((a, r) => a + r.runs.length, 0);
    const next = live.map((r) => ({ r, at: r.runs[0]?.at })).filter((x) => x.at).sort((a, b) => a.at!.getTime() - b.at!.getTime())[0];
    // "Not this week" is one number everywhere (strip and footer): tasks with no run in the next 7 days.
    // Its caption uses the task state's own word, "On demand" (Upcoming's "No next run" is a different set).
    const off = unscheduled();
    const demand = off.filter((r) => r.detail && onDemand(r.detail)).length;
    const susp = rows.filter((r) => r.suspended).length;
    const mTone: Tone = !manager ? 'neutral' : running() ? 'success' : 'warning';
    // The shared strip (labels top-aligned, captions one line). A dot only where the cell is a state
    // that can go wrong: the Task Manager, and suspended tasks when there are any.
    const nextText = next ? `Next: ${next.r.task.Name} ${relative(next.at!, now)}` : 'Nothing due';
    // Short enough for one line: "2 on demand · 2 due later".
    const offWhy = [demand ? `${num(demand)} on demand` : '', off.length - demand ? `${num(off.length - demand)} due later` : ''].filter(Boolean).join(' · ');
    const html = strip([
      { label: 'Task Manager', value: manager || 'Not known', tone: mTone,
        caption: manager && !running() && canTask !== false ? `<button type="button" class="link" data-mgr-act="${managerAct()}">${esc(managerLabel(managerAct()))}</button>` : '',
        title: running() ? 'Starts each task when it’s due' : manager ? 'No scheduled task runs until it’s running' : 'It didn’t respond' },
      { label: 'Next 7 days', value: `${num(total)} run${total === 1 ? '' : 's'}`, title: nextText },
      { label: 'Not this week', value: `${num(off.length)} task${off.length === 1 ? '' : 's'}`, caption: esc(offWhy),
        title: `${off.map((r) => r.task.Name).join(', ')}${demand ? '. On demand: they run only when someone starts them.' : ''}` },
      { label: 'Suspended', value: `${num(susp)} task${susp === 1 ? '' : 's'}`, tone: susp ? 'warning' : undefined,
        title: susp ? rows.filter((r) => r.suspended).map((r) => r.task.Name).join(', ') : 'Every task is active' },
    ]);
    renderHead();
    if (html !== factsHtml) {
      factsHtml = html;
      $('#sch-facts').innerHTML = html;
      $('#sch-facts').querySelector<HTMLElement>('[data-mgr-act]')?.addEventListener('click', (e) => void managerAction((e.currentTarget as HTMLElement).dataset.mgrAct ?? ''));
    }
  };

  // ── Header: one in-app primary (New task, which opens on Upcoming); the Task Manager's risky
  // suspend lives in ⋯, never beside it. When it isn't running, the strip's caption offers the fix too. ──
  const newBtn = newButton(ctx, 'New task', () => { requestNewTask(); ctx.navigate('tasks/upcoming'); });
  const head = document.createElement('span');
  head.className = 'set-head';
  head.innerHTML = moreButton('sch-head-more', 'More actions');
  const moreEl = head.querySelector('#sch-head-more') as HTMLElement;
  let headMenu: MenuHandle | null = null;
  let headSig = '';
  ctx.onLeave(() => headMenu?.destroy());
  const mountHead = (): void => { if (!head.isConnected) ctx.actions.append(head); };
  mountHead();
  // Re-attach only if the header is rewritten; never re-order (no fight with other header items).
  const headObserver = new MutationObserver(mountHead);
  headObserver.observe(ctx.actions, { childList: true });
  ctx.onLeave(() => headObserver.disconnect());
  const managerAct = (): string => (!manager ? '' : running() ? 'suspend' : /suspend/i.test(manager) ? 'resume' : 'start');
  const managerLabel = (act: string): string => (act === 'suspend' ? 'Suspend Task Manager…' : act === 'resume' ? 'Resume Task Manager' : 'Start Task Manager…');
  const renderHead = (): void => {
    const act = managerAct();
    moreEl.hidden = !act || canTask === false;
    const sig = `${act}|${busy}`;
    if (sig !== headSig) {
      headSig = sig;
      headMenu?.destroy();
      headMenu = act ? moreMenu(moreEl, [{
        label: managerLabel(act), icon: act === 'suspend' ? 'pause' : 'play', danger: act === 'suspend', disabled: busy, reason: 'Working…',
        onSelect: () => void managerAction(act),
      }]) : null;
    }
    newBtn.setHidden(canTask === false);
  };

  // ── Week grid ──
  const days = (): Date[] => Array.from({ length: 7 }, (_, i) => addDays(windowStart, i));
  const cellFor = (r: Row, day: Date): string => {
    const list = r.runs.filter((x) => daysBetween(day, x.at) === 0);
    if (!list.length) return '<span class="sch-empty" aria-hidden="true">—</span><span class="sr-only">No run</span>';
    const cls = `sch-times${willRun(r) ? '' : ' sch-times--off'}`;
    if (list.length <= 3) return `<span class="${cls}">${list.map((x) => clock(x.at)).join(' · ')}</span>`;
    return `<span class="${cls}" title="${esc(list.map((x) => clock(x.at)).join(', '))}"><b>${num(list.length)} runs</b> ${clock(list[0].at)}–${clock(list[list.length - 1].at)}</span>`;
  };
  /**
   * A task that runs the same way on all seven days (daily, every day, not
   * suspended or chained, no end date inside the week) gets one merged cell:
   * "Every day · 00:00". Only irregular rows show a cell per day, so the grid
   * reads as a scan for exceptions. Judged on whole days (today's earlier runs
   * included), so a run already past this morning doesn't break the pattern.
   */
  /** A daily task's start times ("00:30"), or null when it doesn't run the same way every day. */
  const dailyTimes = (r: Row): string[] | null => {
    const d = r.detail;
    if (!d || r.suspended || r.parent || !/^daily$/i.test(period(d)) || Math.max(1, Number(d.TimePeriodEvery) || 1) !== 1) return null;
    const whole = runsBetween(d, windowStart, addDays(windowStart, 7));
    const perDay = days().map((day) => whole.filter((x) => daysBetween(day, x) === 0).map(clock).join(','));
    if (!perDay[0] || perDay.some((x) => x !== perDay[0])) return null;
    return perDay[0].split(',');
  };
  /** "00:30", or "every 15 min 08:00–18:00" style for a task that runs several times a day. */
  const timesText = (times: string[]): string => (times.length <= 3 ? times.join(' · ') : `${num(times.length)} runs ${times[0]}–${times[times.length - 1]}`);
  const mergedLabel = (r: Row): string | null => { const t = dailyTimes(r); return t ? `Every day · ${timesText(t)}` : null; };
  /**
   * The Task column fits its longest name (plus a Suspended / After … tag), so
   * "Automatic Table Statistic Collection" isn't cut while the days have room.
   * Measured with the page's own font; clamped so the week keeps its space.
   */
  let measure: CanvasRenderingContext2D | null = null;
  const taskColWidth = (list: Row[]): number => {
    measure ??= document.createElement('canvas').getContext('2d');
    if (measure) measure.font = `500 12.5px ${getComputedStyle(document.body).fontFamily}`;
    const text = (t: string): number => (measure ? measure.measureText(t).width : t.length * 7);
    // The tag: "Suspended", or "After Switch Journal" (Upcoming's words for a chained task), plus the chip's padding.
    const tag = (r: Row): number => (r.suspended ? 84 : r.parent ? text(`After ${r.parent.Name}`) + 30 : 0);
    const w = Math.max(0, ...list.map((r) => text(r.task.Name) + tag(r)));
    return Math.round(Math.min(440, Math.max(200, w + 60))); // cell padding, plus the daily group's indent
  };
  const nameCell = (r: Row): string => {
    const tag = r.suspended ? chip('Suspended', 'warning', 'Won’t run until it’s resumed') : r.parent ? chip(`After ${r.parent.Name}`, 'neutral', `Runs straight after ${r.parent.Name} finishes`) : '';
    return `<button type="button" class="sch-task" data-id="${r.task.Id}" aria-current="${selected === r.task.Id}" title="${esc(r.task.Name)}">
      <span class="sch-task-name" title="${esc(r.task.Name)}">${esc(r.task.Name)}</span>${tag}</button>`;
  };
  /** The week grid's rows in screen order: the "every day" group, the rest by time of day, then suspended. */
  const weekGroups = (): { list: Row[]; daily: Row[]; other: Row[]; susp: Row[] } => {
    const list = [...scheduled()].sort((a, b) => {
      const ta = a.runs[0].at, tb = b.runs[0].at;
      const ma = ta.getHours() * 60 + ta.getMinutes(), mb = tb.getHours() * 60 + tb.getMinutes();
      return ma - mb || a.task.Name.localeCompare(b.task.Name);
    });
    return { list, daily: list.filter((r) => dailyTimes(r)), other: list.filter((r) => !dailyTimes(r)), susp: suspendedRows() };
  };
  /** The day timeline's rows in screen order: by first run that day. */
  const dayList = (day: Date): Row[] => scheduled().filter((r) => r.runs.some((x) => daysBetween(day, x.at) === 0))
    .sort((a, b) => {
      const fa = a.runs.find((x) => daysBetween(day, x.at) === 0)!.at.getTime();
      const fb = b.runs.find((x) => daysBetween(day, x.at) === 0)!.at.getTime();
      return fa - fb || a.task.Name.localeCompare(b.task.Name);
    });
  /**
   * ‹ › pages in the order the timetable shows its rows (the "every day" group counted as open,
   * since selecting one of its tasks opens it), then the tasks that aren't on it.
   */
  const visibleOrder = (): Row[] => {
    let shown: Row[];
    if (view === 'day') shown = dayList(days()[dayIndex]);
    else { const g = weekGroups(); shown = [...g.daily, ...g.other, ...g.susp]; }
    const seen = new Set(shown);
    return [...shown, ...rows.filter((r) => !seen.has(r)).sort((a, b) => a.task.Name.localeCompare(b.task.Name))];
  };
  const renderWeek = (): string => {
    const ds = days();
    // The grid is a scan for exceptions: tasks that run the same way every day fold into one summary
    // row at the top ("9 tasks run every day · 00:00 ×3, 00:30, 01:00 ×4"), which expands to list them.
    const { list, daily, other, susp } = weekGroups();
    if (!list.length && !susp.length) {
      return `<div class="empty-std"><ev-icon name="calendar" size="md"></ev-icon><div class="empty-std-body"><strong>Nothing is due in the next 7 days</strong><p>No task has a run scheduled this week.</p></div></div>`;
    }
    const counts = new Map<string, number>();
    for (const r of daily) { const t = timesText(dailyTimes(r) as string[]); counts.set(t, (counts.get(t) ?? 0) + 1); }
    const summaryTimes = [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
    const open = dailyOpen;
    // Suspended: one merged, dimmed cell (the Suspended tag is on the name), never times that won't happen.
    const suspRow = (r: Row): string => `<tr class="sch-susp-row${selected === r.task.Id ? ' sch-sel' : ''}"><th scope="row" title="${esc(r.task.Name)}">${nameCell(r)}</th>
      <td colspan="7" class="sch-merged"><span class="sch-merged-text sch-susp-text">No runs until it’s resumed</span></td></tr>`;
    const row = (r: Row): string => {
      const merged = mergedLabel(r);
      const cells = merged
        ? `<td colspan="7" class="sch-merged"><span class="sch-merged-text">${esc(merged)}</span></td>`
        : ds.map((d) => `<td>${cellFor(r, d)}</td>`).join('');
      return `<tr class="${[selected === r.task.Id ? 'sch-sel' : '', merged ? 'sch-daily-row' : ''].filter(Boolean).join(' ')}"><th scope="row" title="${esc(r.task.Name)}">${nameCell(r)}</th>${cells}</tr>`;
    };
    const summary = daily.length ? `<tr class="sch-daily-sum"><th scope="row"><button type="button" class="sch-daily-toggle" id="sch-daily-toggle" aria-expanded="${open}">
        <ev-icon name="${open ? 'chevron-down' : 'chevron-right'}" size="xs" aria-hidden="true"></ev-icon>${num(daily.length)} task${daily.length === 1 ? ' runs' : 's run'} every day</button></th>
        <td colspan="7" class="sch-merged"><span class="sch-merged-text" title="${esc(summaryTimes)}">${esc(summaryTimes)}</span></td></tr>` : '';
    return `
      <div class="sch-scroll"><table class="sch-week">
        <thead><tr><th scope="col" class="sch-col-task" style="width:${taskColWidth([...list, ...susp])}px">Task</th>${ds.map((d) => `<th scope="col"><span>${esc(dayName(d))}</span><small>${esc(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</small></th>`).join('')}</tr></thead>
        <tbody>${summary}${open ? daily.map(row).join('') : ''}${other.map(row).join('')}${susp.map(suspRow).join('')}</tbody>
      </table></div>`;
  };

  // ── Day timeline ──
  const renderDay = (): string => {
    const day = days()[dayIndex];
    const list = dayList(day);
    const susp = suspendedRows();
    const legend = susp.length ? `<p class="sch-legend" title="${esc(susp.map((r) => r.task.Name).join(', '))}">${num(susp.length)} suspended task${susp.length === 1 ? ' isn’t' : 's aren’t'} shown: no runs until resumed.</p>` : '';
    if (!list.length) {
      return `<div class="empty-std"><ev-icon name="calendar" size="md"></ev-icon><div class="empty-std-body"><strong>Nothing runs ${esc(dayIndex === 0 ? 'for the rest of today' : `on ${shortDate(day)}`)}</strong><p>Pick another day above.</p></div></div>${legend}`;
    }
    const pos = (d: Date): number => ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100;
    const now = new Date();
    const nowLine = dayIndex === 0 ? `<span class="sch-now" style="left:${pos(now).toFixed(2)}%" title="Now ${esc(clock(now))}"></span>` : '';
    const axis = [0, 3, 6, 9, 12, 15, 18, 21].map((h) => `<span style="left:${(h / 24) * 100}%">${hhmm(h * 60)}</span>`).join('');
    return `<div class="sch-day" role="table" aria-label="Runs on ${esc(shortDate(day))}">
      <div class="sch-day-row sch-day-head" role="row"><span role="columnheader">Task</span><div class="sch-axis" role="columnheader">${axis}</div></div>
      ${list.map((r) => {
        const runs = r.runs.filter((x) => daysBetween(day, x.at) === 0);
        const off = willRun(r) ? '' : ' sch-track--off';
        const marks = runs.length > 24
          ? `<span class="sch-band" style="left:${pos(runs[0].at).toFixed(2)}%;width:${Math.max(0.6, pos(runs[runs.length - 1].at) - pos(runs[0].at)).toFixed(2)}%" title="${esc(`${num(runs.length)} runs, ${clock(runs[0].at)} to ${clock(runs[runs.length - 1].at)}`)}"></span>`
          : runs.map((x) => `<span class="sch-mark" style="left:${pos(x.at).toFixed(2)}%" title="${esc(`${r.task.Name} · ${clock(x.at)}`)}"></span>`).join('');
        const label = runs.length <= 2 ? runs.map((x) => clock(x.at)).join(' · ') : `${num(runs.length)} runs`;
        return `<div class="sch-day-row${selected === r.task.Id ? ' sch-sel' : ''}" role="row">
          <span role="cell">${nameCell(r)}</span>
          <div class="sch-track${off}" role="cell" aria-label="${esc(`${r.task.Name}: ${runs.map((x) => clock(x.at)).join(', ')}`)}">${marks}${nowLine}<span class="sch-track-label">${esc(label)}</span></div>
        </div>`;
      }).join('')}
    </div>${legend}`;
  };

  const renderDayPick = (): void => {
    $('#sch-toolbar').hidden = view !== 'day';
    dayPick.options = days().map((d, i) => ({ value: String(i), label: i < 2 ? dayName(d) : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) }));
    dayPick.value = String(dayIndex);
  };

  const renderMain = (): void => {
    if (!loaded) return;
    const html = view === 'week' ? renderWeek() : renderDay();
    renderDayPick();
    if (html === mainHtml) return;
    mainHtml = html;
    main.innerHTML = html;
    main.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => b.addEventListener('click', () => void select(Number(b.dataset.id))));
    main.querySelector('#sch-daily-toggle')?.addEventListener('click', () => { dailyOpen = !dailyOpen; mainHtml = ''; renderMain(); });
  };

  const renderFoot = (): void => {
    const sep = '<span class="meta-sep">·</span>';
    const live = scheduled().filter((r) => !r.suspended);
    const total = live.reduce((a, r) => a + r.runs.length, 0);
    const off = unscheduled();
    const names = off.map((r) => r.task.Name).join(', ');
    const merged = scheduled().filter((r) => mergedLabel(r)).length;
    $('#sch-foot').innerHTML = `<b>${num(rows.length)}</b> tasks${sep}<b>${num(total)}</b> run${total === 1 ? '' : 's'} by ${esc(addDays(windowStart, 6).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}${
      merged ? `${sep}<b>${num(merged)}</b> every day` : ''}${
      off.length ? `${sep}<span title="${esc(names)}"><b>${num(off.length)}</b> not this week</span>` : ''}`;
  };

  // ── Detail: the shared task peek and full view (objectDetail; content in task-detail.ts) ──
  const editBlock = (r: Row): string | null => {
    if (canTask === false) return NO_TASK;
    if (!r.detail) return 'Loading the schedule…';
    if (r.parent || chainedPeriod(r.detail)) return chainedReason(r.parent);
    return null;
  };
  const viewOf = (r: Row): TaskView => ({ task: r.task, info: r.info, next: r.next, suspended: r.suspended, after: r.parent });
  /** Schedule's own addition to the peek: this week's runs from the timetable above. */
  const comingUpBody = (r: Row): string => {
    const upcoming = r.runs.slice(0, 8);
    if (!upcoming.length) return '';
    return `<ul class="disk-list">${upcoming.map((x) => `<li><span>${esc(dayName(x.at))}${daysBetween(new Date(), x.at) > 1 ? ` <span class="dim">${esc(x.at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>` : ''}</span><span class="mono">${esc(clock(x.at))}</span></li>`).join('')}
      ${r.runs.length > upcoming.length ? `<li><span class="dim">and ${num(r.runs.length - upcoming.length)} more this week</span><span></span></li>` : ''}</ul>`;
  };
  const comingUp = (r: Row): string => { const b = comingUpBody(r); return b ? odSection('Coming up', b) : ''; };
  const detailOf = async (r: Row): Promise<TaskDetail> => r.detail ?? await getTask(r.task.Id);
  const rowOf = (v: TaskView): Row | undefined => rows.find((x) => x.task.Id === v.task.Id);
  const actions = taskActions({
    canTask: () => canTask,
    manager: () => manager,
    cached: (id) => details.get(id),
    changeSchedule: (v) => void openEditor(v.task.Id),
    changeBlocked: (v) => { const r = rowOf(v); return r ? editBlock(r) : 'Loading the schedule…'; },
    navigate: (path) => ctx.navigate(path),
    openTask: (id) => void (od?.mode() === 'full' ? od.openFull(String(id)) : select(id)),
    reload: async () => { await load(true); od?.refresh(); },
    deleted: async () => {
      if (od?.mode() === 'full') await od.closeFull();
      await od?.select(null);
      await load(true);
    },
  });
  od = objectDetail<Row>(ctx, {
    collection: 'Schedule', noun: 'task', // the breadcrumb names the list it came from (the nav label)
    panel, detail: detailEl, list: $('#sch-list-view'), full: fullEl,
    key: (r) => String(r.task.Id),
    find: (k) => rows.find((r) => String(r.task.Id) === k),
    order: () => visibleOrder().map((r) => String(r.task.Id)),
    name: (r) => r.task.Name,
    meta: (r) => taskMeta(viewOf(r), od?.mode() === 'full'),
    description: (r) => r.task.Description,
    // One action set per task on Schedule and Upcoming (task-actions.ts): Resume leads when it's suspended.
    primary: (r) => actions.primary(viewOf(r)),
    menu: (r) => actions.menu(viewOf(r)),
    peek: async (r) => {
      try {
        const [d, runs] = await Promise.all([detailOf(r), taskRuns(r.task.Id).catch(() => [])]);
        return `${taskPeekHtml(viewOf(r), d, runs, describe(d, r.parent))}${comingUp(r)}`;
      } catch (err) { return errorPanel(err); }
    },
    loadFull: async (r) => {
      const [d, runs] = await Promise.all([detailOf(r), taskRuns(r.task.Id).catch(() => [])]);
      // A superset of the peek: Coming up joins the Schedule card's column.
      const f = taskFullView(viewOf(r), d, runs, describe(d, r.parent));
      const up = comingUpBody(r);
      if (up) f.main.splice(1, 0, { title: 'Coming up', body: up });
      return f;
    },
    // The timetable highlights the selected task's row.
    onSelect: (k) => {
      const id = k ? Number(k) : null;
      if (id === selected) return;
      selected = id;
      // Selecting a daily task (e.g. from the notice) opens the folded group, so its row is visible.
      const r = rows.find((x) => x.task.Id === id);
      if (r && dailyTimes(r)) dailyOpen = true;
      mainHtml = ''; renderMain();
    },
    canLeave: mayLeave,
  });
  ctx.body.addEventListener('click', (e) => {
    const u = (e.target as Element).closest<HTMLElement>('#sch-detail [data-user], #sch-full [data-user]');
    if (!u || (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey) return;
    e.preventDefault();
    linkTo(ctx.navigate, 'security/users', u.dataset.user ?? '');
  });
  const select = async (id: number): Promise<void> => { await od.select(String(id)); };

  // ── Change schedule ──
  // From the timetable or the peek it opens in the drawer; from the full view (#/tasks/schedule/<id>) it
  // takes the page body's place, so the address, title and ‹ › pager stay, and Cancel or Save bring the
  // full view back.
  const openEditor = async (id: number): Promise<void> => {
    if (!(await mayLeave())) return;
    const inFull = od.mode() === 'full' && od.selected() === String(id);
    if (od.mode() === 'full' && !inFull) await od.closeFull();
    const r = rows.find((x) => x.task.Id === id);
    const d = r?.detail;
    if (!r || !d || editBlock(r)) return;
    if (!inFull) {
      if (od.selected() !== String(id)) await od.select(String(id));
      restoreWidth ??= panelWidth(panel, 520);
      if (!panel.open) panel.open = true;
    }
    formEvents = new AbortController();
    editor = scheduleEditor(inFull ? fullEl : detailEl, {
      task: r.task, detail: d, inFull, signal: formEvents.signal, suspended: r.suspended,
      onSaved: async (body) => {
        leaveEdit();
        if (inFull) fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
        await load(true);
        od.refresh();
        const fresh = rows.find((x) => x.task.Id === id);
        toast(body.TimePeriod === 'On Demand' ? `${r.task.Name} now runs only when someone starts it.`
          : `Schedule for ${r.task.Name} saved.${fresh?.next ? ` Next run ${when(fresh.next)}.` : ''}`);
      },
      onCancel: () => { leaveEdit(); if (inFull) fullEl.innerHTML = ''; od.refresh(); },
    });
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
  };

  // ── Task Manager ──
  const managerAction = async (act: string): Promise<void> => {
    if (busy) return;
    const due = scheduled().filter((r) => !r.suspended);
    const next = due.map((r) => r.runs[0]?.at).filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0];
    if (act === 'suspend') {
      const ok = await confirm({
        title: 'Suspend the Task Manager?',
        body: `<p>No scheduled task starts until it’s resumed: that’s ${num(due.reduce((a, r) => a + r.runs.length, 0))} runs due in the next 7 days${next ? `, the first ${esc(relative(next))}` : ''}, including journal switches and purges.</p><p>Tasks already running carry on. Run now doesn’t start anything either while it’s suspended.</p>`,
        confirmLabel: 'Suspend Task Manager',
        danger: true,
      });
      if (!ok) return;
    } else if (act === 'start') {
      const ok = await confirm({
        title: 'Start the Task Manager?',
        body: '<p>IRIS starts the Task Manager process. Tasks whose time has already passed may run straight away, depending on each one’s “if IRIS was down when due” setting.</p>',
        confirmLabel: 'Start Task Manager',
      });
      if (!ok) return;
    }
    busy = true;
    factsHtml = '';
    renderFacts();
    try {
      if (act === 'suspend') await suspendManager(); else if (act === 'resume') await resumeManager(); else await startManager();
      toast(act === 'suspend' ? 'Task Manager suspended. No scheduled task starts until it’s resumed.' : act === 'resume' ? 'Task Manager resumed. Tasks run at their scheduled times.' : 'Task Manager started.');
    } catch (err) {
      toast(err instanceof AdminError && err.status === 409 ? 'The Task Manager is already running.' : errorText(err), 'danger');
    } finally {
      busy = false;
      factsHtml = '';
      await load(true);
    }
  };

  // ── Loading ──
  const details = new Map<number, TaskDetail>();
  const updated = liveIndicator(ctx, () => void load(true));
  const load = async (force = false): Promise<void> => {
    try {
      const [tasks, mgr] = await Promise.all([getTasks(), getManager().catch(() => ({ Status: '' }))]);
      const [dets, infos] = await Promise.all([
        Promise.allSettled(tasks.map((t) => (force || !details.has(t.Id) ? getTask(t.Id) : Promise.resolve(details.get(t.Id)!)))),
        Promise.allSettled(tasks.map((t) => getTaskInfo(t.Id))),
      ]);
      if (!alive) return;
      manager = mgr.Status;
      const now = new Date();
      windowStart = midnight(now);
      const to = addDays(windowStart, 7);
      const byId = new Map(tasks.map((t) => [t.Id, t]));
      const built: Row[] = tasks.map((t, i) => {
        const detail = dets[i].status === 'fulfilled' ? (dets[i] as PromiseFulfilledResult<TaskDetail>).value : undefined;
        if (detail) details.set(t.Id, detail);
        const info = infos[i].status === 'fulfilled' ? (infos[i] as PromiseFulfilledResult<TaskInfo>).value : undefined;
        const m = /Runs After #(\d+)/i.exec(t.NextScheduled);
        const parent = m ? byId.get(Number(m[1])) ?? null : null;
        const nextText = info?.NextScheduled && isDate(info.NextScheduled) ? info.NextScheduled : isDate(t.NextScheduled) ? t.NextScheduled : '';
        return { task: t, detail, info, parent, suspended: t.Suspended || !!info?.Suspended, runs: [], next: nextText ? irisDate(nextText) : null };
      });
      for (const r of built) {
        // Suspended: no future runs, whatever the schedule says (Upcoming shows no next run either).
        if (r.suspended) { r.next = null; continue; }
        if (!r.detail || r.parent) continue;
        let runs = runsBetween(r.detail, now, to);
        // The Task Manager's own next run wins: nothing runs before it, and it always appears.
        if (r.next) {
          const n = r.next;
          runs = runs.filter((x) => x.getTime() >= n.getTime());
          if (n >= now && n < to && !runs.some((x) => x.getTime() === n.getTime())) runs.unshift(n);
        }
        r.runs = runs.map((at) => ({ at, chained: false }));
      }
      for (const r of built) {
        if (!r.parent || r.suspended) continue;
        const p = built.find((x) => x.task.Id === r.parent!.Id);
        r.runs = (p?.runs ?? []).map((x) => ({ at: x.at, chained: true }));
        r.next = r.runs[0]?.at ?? null;
      }
      rows = built;
      loaded = true;
      updated(new Date());
      renderBanner();
      renderFacts();
      renderFoot();
      gate.run(() => {
        renderMain();
        if (!editor) od?.refresh();
      }, force || !mainHtml || od?.mode() === 'full');
    } catch (err) {
      if (!alive || loaded) return;
      $('#sch-facts').innerHTML = '';
      main.innerHTML = errorPanel(err, 'sch-retry');
      main.querySelector('#sch-retry')?.addEventListener('click', () => void load(true));
    }
  };

  bindViewTabs(ctx.body, 'sch-tabs', (value) => { view = value as View; mainHtml = ''; renderMain(); });
  dayPick.addEventListener('ev-segmented-button-change', (e) => {
    dayIndex = Number((e as CustomEvent<{ value: string }>).detail.value) || 0;
    mainHtml = '';
    renderMain();
  });

  sessionInfo().then((info) => {
    canTask = can(info, 'Task');
    if (!alive) return;
    factsHtml = '';
    renderFacts();
    if (!editor) od?.refreshHeader();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });


  // Arriving from Upcoming’s “Change schedule”: open that task's schedule form once the list is in.
  const wanted = Number(takeSelection() ?? '');
  void load(true).then(() => {
    if (!alive || !Number.isInteger(wanted) || wanted <= 0) return;
    const r = rows.find((x) => x.task.Id === wanted);
    if (r) void (editBlock(r) ? select(wanted) : openEditor(wanted));
  });
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
