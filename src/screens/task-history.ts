// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tasks › History — what the Task Manager has run and how each run ended.
 * Three views of one feed: every run, one row per task (is anything failing?),
 * and the Task Manager's own log (creating tasks, changing settings, queueing
 * chained tasks), which is kept apart so run counts stay honest.
 */
import '../styles-apps.css';
import { getTaskHistory, type TaskHistoryEntry } from '../api-apps';
import {
  isDate,
  kv,
  esc, cell, chip, pill, setChips, exportButton, gridExport, relative, when, irisDate, duration, num, skeleton, errorPanel, liveIndicator, uniformKeys,
  viewTabs, bindViewTabs, setViewTabCount, type ScreenCtx,
} from '../ui';
import { liveGate } from './apps-live';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

const REFRESH_MS = 30000;

const isManagerEvent = (h: TaskHistoryEntry): boolean => h.Routine === 'TASKMGR';
/** A run failed if IRIS logged an error, or neither the status nor the result says success (e.g. Status "" with "Unable to obtain license"). */
const failed = (h: TaskHistoryEntry): boolean => !isManagerEvent(h) && (h.ErrNumber > 0 || (h.Status !== '1' && !/^success$/i.test(h.Result)));
/** Seconds between start and completion; NaN if either is missing. */
function secs(h: TaskHistoryEntry): number {
  if (!isDate(h.LastStart) || !isDate(h.Completed)) return NaN;
  return Math.max(0, (irisDate(h.Completed).getTime() - irisDate(h.LastStart).getTime()) / 1000);
}
const took = (s: number): string => (!Number.isFinite(s) ? '—' : s < 1 ? '< 1s' : duration(s));
const errorOf = (h: TaskHistoryEntry): string =>
  [h.Result, h.Status !== '1' && h.Status !== h.Result ? h.Status : ''].filter(Boolean).join('\n');

/** A past event is its time only ("Today 01:30"); how long ago is the tooltip. Inline styles: grid cells live in shadow DOM. */
function whenCell(ms: number): string {
  if (!(ms > 0)) return cell.dim('—');
  const d = new Date(ms);
  return `<span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums" title="${esc(relative(d))}">${esc(when(d))}</span>`;
}
/** "Succeeded" plain; "Failed" a red pill with IRIS's error as its tooltip. */
const resultChip = (outcome: unknown, error = ''): string =>
  (outcome === 'failed' ? pill('Failed', 'danger', error) : outcome === 'ok' ? cell.dim('Succeeded') : cell.dim('—'));
/**
 * A column that takes the free width: width:0 + min-width:100% stops the
 * text widening the table, so it ends in an ellipsis instead.
 */
const fill = (inner: string, title: string): string =>
  `<span style="display:block;width:0;min-width:100%;max-width:100%;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(title)}">${inner}</span>`;
/**
 * Run by / Output: for a failed run, the first line of IRIS's error; otherwise
 * who ran it and the routine it ran, whichever the row has.
 */
const runByCell = (row: DataGridRow): string => {
  if (row.Outcome === 'failed' && row.Error) {
    const first = String(row.Error).split(/\r?\n/)[0];
    return fill(`<span style="color:var(--ev-color-text-secondary)">${esc(first)}</span>`, String(row.Error));
  }
  // _SYSTEM runs almost everything, so it's said once in the footer; only other users show here.
  const user = /^_SYSTEM$/i.test(String(row.Username ?? '')) ? '' : String(row.Username ?? '');
  const routine = String(row.Routine ?? '');
  if (!user && !routine) return cell.dim('—');
  return fill(`${user ? `<span style="color:var(--ev-color-text-secondary)">${esc(user)}</span>` : ''}${user && routine ? '<span style="color:var(--ev-color-text-tertiary)"> · </span>' : ''}${
    routine ? `<span style="font-family:var(--ev-font-family-mono);font-size:12.5px;color:var(--ev-color-text-tertiary)">${esc(routine)}</span>` : ''}`, [user, routine].filter(Boolean).join(' · '));
};

type View = 'runs' | 'tasks' | 'log';
type Filter = 'all' | 'failed';

const RUN_COLUMNS: DataGridColumn[] = [
  // Task · Started · Duration · Result · Run by / Output, the last taking the free width so the right side carries data.
  { key: 'Name', label: 'Task', width: '30%', sortable: true, renderCell: (v) => fill(esc(v), String(v)) },
  { key: 'StartAt', label: 'Started', width: '160px', sortable: true, renderCell: (v) => whenCell(Number(v)) },
  { key: 'Secs', label: 'Duration', width: '90px', sortable: true, align: 'right', renderCell: (v) => (Number(v) >= 0 ? cell.num(took(Number(v))) : cell.dim('—')) },
  { key: 'Outcome', label: 'Result', width: '120px', sortable: true, renderCell: (v, row) => resultChip(v, String(row.Error)) },
  { key: 'RunBy', label: 'Run by / Output', sortable: true, renderCell: (_v, row) => runByCell(row) },
];
const TASK_COLUMNS: DataGridColumn[] = [
  { key: 'Name', label: 'Task', sortable: true, renderCell: (v) => fill(esc(v), String(v)) },
  { key: 'LastAt', label: 'Last run', width: '160px', sortable: true, renderCell: (v) => whenCell(Number(v)) },
  { key: 'Runs', label: 'Runs', width: '72px', sortable: true, align: 'right', renderCell: (v) => cell.num(num(Number(v))) },
  { key: 'Rate', label: 'Success rate', width: '120px', sortable: true, align: 'right',
    renderCell: (v, row) => cell.num(`${Math.round(Number(v))}%`, `${row.Ok} of ${row.Runs} runs succeeded`) },
  { key: 'FailAt', label: 'Last failure', width: '160px', sortable: true, renderCell: (v) => (Number(v) > 0 ? whenCell(Number(v)) : cell.dim('—')) },
  { key: 'Namespace', label: 'Namespace', width: '110px', sortable: true, renderCell: (v) => cell.mono(v, true) },
  { key: 'Outcome', label: 'Last result', width: '120px', sortable: true, renderCell: (v, row) => resultChip(v, String(row.Error)) },
];
const LOG_COLUMNS: DataGridColumn[] = [
  { key: 'Name', label: 'Entry', width: '30%', sortable: true, renderCell: (v) => fill(esc(v), String(v)) },
  { key: 'LogAt', label: 'Logged', width: '160px', sortable: true, renderCell: (v) => whenCell(Number(v)) },
  { key: 'Result', label: 'Details', renderCell: (v) => (v && v !== 'Success' ? fill(esc(v), String(v)) : cell.dim('—')) },
];
const COLUMNS: Record<View, DataGridColumn[]> = { runs: RUN_COLUMNS, tasks: TASK_COLUMNS, log: LOG_COLUMNS };
const ROW_KEY: Record<View, string> = { runs: 'Key', tasks: 'Key', log: 'Key' };
const SORT: Record<View, string> = { runs: 'StartAt', tasks: 'LastAt', log: 'LogAt' };
/** Columns that step aside while the detail panel is open, least informative first. */
const SECONDARY: Record<View, string[]> = { runs: ['Secs'], tasks: ['Namespace', 'FailAt', 'Rate'], log: ['Result'] };
const UNIFORM: Record<View, string[]> = { runs: [], tasks: ['Namespace'], log: [] };

type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

interface Entry { key: string; h: TaskHistoryEntry }
interface TaskStats { key: string; name: string; taskId: number; namespace: string; runs: Entry[]; ok: number; bad: number; last: Entry; lastFail?: Entry }

const dim = (s: string): string => `<span class="dim">${s}</span>`;
const startMs = (h: TaskHistoryEntry): number => (isDate(h.LastStart) ? irisDate(h.LastStart).getTime() : 0);

export function taskHistoryScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    ${viewTabs('th-view', [
      { value: 'runs', label: 'Runs', count: 0 },
      { value: 'tasks', label: 'By task', count: 0 },
      { value: 'log', label: 'Task Manager log', count: 0 },
    ], 'runs')}
    <div class="toolbar-row">
      <div class="search-box"><ev-search id="th-search" size="sm" full-width placeholder="Filter by task, routine, result or user"></ev-search></div>
      <ev-segmented-button id="th-filter" size="sm" aria-label="Show runs"></ev-segmented-button>
    </div>
    <ev-detail-panel id="th-panel" detail-width="360" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="th-grid-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="th-detail" aria-label="Details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="th-foot"></p>`;

  const $ = (id: string): HTMLElement => ctx.body.querySelector(`#${id}`) as HTMLElement;
  const filterEl = $('th-filter') as HTMLElement & { options: unknown; value: string };
  filterEl.value = 'all';
  const panel = $('th-panel') as HTMLElement & { open: boolean };
  const wrap = $('th-grid-wrap');
  const detailEl = $('th-detail');
  let grid: GridEl | null = null;
  let all: Entry[] = [];
  let runs: Entry[] = [];
  let log: Entry[] = [];
  let tasks: TaskStats[] = [];
  let view: View = 'runs';
  // Export: the Runs view's rows as shown (visible columns, current sort).
  const exportBtn = exportButton(() => (view === 'runs' ? gridExport(ctx.body.querySelector('#th-grid-wrap ev-data-grid'), 'task-runs') : null));
  (ctx.body.querySelector('.toolbar-row') as HTMLElement).append(exportBtn);
  let query = '';
  let filter: Filter = 'all';
  let selected: string | null = null;
  let hidden = new Set<string>();

  const matches = (fields: unknown[]): boolean => {
    if (!query) return true;
    const q = query.toLowerCase();
    return fields.some((f) => String(f ?? '').toLowerCase().includes(q));
  };
  const entryFields = (h: TaskHistoryEntry): unknown[] => [h.Name, h.Routine, h.Result, h.Namespace, h.Username, h.TaskId, h.Pid];

  const runRow = ({ key, h }: Entry): DataGridRow => ({
    Key: key, Name: h.Name, Namespace: h.Namespace, Username: h.Username, Routine: h.Routine,
    RunBy: failed(h) ? errorOf(h) : `${h.Username} ${h.Routine}`,
    StartAt: startMs(h), Secs: Number.isFinite(secs(h)) ? secs(h) : -1,
    Outcome: failed(h) ? 'failed' : 'ok', Error: failed(h) ? errorOf(h) : '',
  });
  const taskRow = (t: TaskStats): DataGridRow => ({
    Key: t.key, Name: t.name, Namespace: t.namespace, LastAt: startMs(t.last.h),
    Outcome: failed(t.last.h) ? 'failed' : 'ok', Error: failed(t.last.h) ? errorOf(t.last.h) : '',
    Runs: t.runs.length, Ok: t.ok, Rate: t.runs.length ? (t.ok / t.runs.length) * 100 : 0,
    FailAt: t.lastFail ? startMs(t.lastFail.h) : 0,
  });
  const logRow = ({ key, h }: Entry): DataGridRow => ({
    Key: key, Name: h.Name, Result: h.Result, LogAt: isDate(h.LogDatetime) ? irisDate(h.LogDatetime).getTime() : 0,
  });

  const rowsFor = (v: View): DataGridRow[] => {
    if (v === 'runs') return runs.filter(({ h }) => (filter === 'all' || failed(h)) && matches(entryFields(h))).map(runRow);
    if (v === 'tasks') return tasks.filter((t) => (filter === 'all' || t.bad > 0) && matches([t.name, t.namespace, t.taskId])).map(taskRow);
    return log.filter(({ h }) => matches(entryFields(h))).map(logRow);
  };

  const renderToolbar = (): void => {
    setViewTabCount(ctx.body, 'th-view', 'runs', runs.length);
    setViewTabCount(ctx.body, 'th-view', 'tasks', tasks.length);
    setViewTabCount(ctx.body, 'th-view', 'log', log.length);
    const bad = view === 'tasks' ? tasks.filter((t) => t.bad > 0).length : runs.filter(({ h }) => failed(h)).length;
    const total = view === 'tasks' ? tasks.length : runs.length;
    setChips(filterEl, total, [
      { value: 'all', label: `All ${num(total)}` },
      { value: 'failed', label: `${view === 'tasks' ? 'With failures' : 'Failed'} ${num(bad)}` },
    ], { active: filter, risk: ['failed'], search: $('th-search'), query });
    if (view === 'log') filterEl.hidden = true;
    (ctx.body.querySelector('.toolbar-row') as HTMLElement).hidden = all.length === 0;
  };

  const renderFoot = (): void => {
    if (!all.length) { $('th-foot').innerHTML = ''; return; }
    // The Task Manager logs its purge setting ("TASKMGR Set Purge 7"); the newest one is in force.
    const keep = log.map(({ h }) => /^TASKMGR Set Purge (\d+)/i.exec(h.Name)?.[1]).find(Boolean);
    const kept = keep ? `<span class="meta-sep">·</span>Kept ${esc(keep)} days` : '';
    if (view === 'log') {
      $('th-foot').innerHTML = `<b>${num(log.length)}</b> Task Manager log entr${log.length === 1 ? 'y' : 'ies'}${kept}`;
      return;
    }
    const days = new Set(runs.map(({ h }) => h.LastStart.slice(0, 10)).filter(Boolean)).size;
    const bad = runs.filter(({ h }) => failed(h));
    const lastFail = bad.reduce<Entry | null>((a, e) => (!a || startMs(e.h) > startMs(a.h) ? e : a), null);
    $('th-foot').innerHTML = `<b>${num(runs.length)}</b> run${runs.length === 1 ? '' : 's'} over <b>${days}</b> day${days === 1 ? '' : 's'}`
      + `<span class="meta-sep">·</span>${bad.length ? `<span title="${esc(lastFail ? `Last failed ${when(new Date(startMs(lastFail.h)))}` : '')}"><b>${num(bad.length)}</b> failed</span>` : 'none failed'}`
      + `<span class="meta-sep">·</span>run by _SYSTEM unless shown` + kept;
  };

  const applyColumns = (): void => {
    for (const c of COLUMNS[view]) grid?.setColumnVisible(c.key, !hidden.has(c.key) && !(panel.open && SECONDARY[view].includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const close = (): void => { selected = null; grid?.select([]); setPanel(false); };
  const head = (kicker: string, title: string): string => `
    <header class="detail-head">
      <div class="detail-title"><span class="detail-kicker">${kicker}</span><h2>${esc(title)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="th-close"></ev-icon-button>
    </header>`;
  // A past event: its time only; how long ago is the tooltip.
  const at = (v: string): string => (isDate(v) ? `<span title="${esc(relative(irisDate(v)))}">${esc(when(irisDate(v)))}</span>` : dim('—'));

  const entryDetail = (h: TaskHistoryEntry): string => {
    const event = isManagerEvent(h);
    const bad = failed(h);
    const s = secs(h);
    return `${head(event ? 'Task Manager log entry' : `Run of task ${esc(h.TaskId)}`, h.Name)}
      <div class="detail-state">${event ? chip('Log entry', 'neutral', 'Recorded by the Task Manager itself, not a task run') : bad ? chip('Failed', 'danger') : chip('Succeeded', 'success')}</div>
      ${bad ? `<div class="callout callout--danger" role="note"><ev-icon name="alert-circle" size="sm"></ev-icon><div>
          <strong>This run ended with an error${h.ErrNumber ? ` (#${esc(h.ErrNumber)})` : ''}</strong>
          <span>${isDate(h.ErrDate) ? `Recorded ${esc(when(irisDate(h.ErrDate)))}. ` : ''}The message IRIS recorded is below.</span></div></div>
        <p class="pre-block">${esc(errorOf(h))}</p>
        <div class="detail-row-actions"><button type="button" class="btn btn--sm" id="th-copy"><ev-icon name="copy" size="xs"></ev-icon>Copy error</button></div>` : ''}
      ${event && h.Result && h.Result !== 'Success' ? `<p class="detail-desc" style="margin-top:4px">${esc(h.Result)}</p>` : ''}
      <h3 class="detail-section">Timing</h3>
      <dl class="kv-list">
        ${kv('Started', at(h.LastStart))}
        ${kv('Completed', at(h.Completed))}
        ${kv('Duration', `${esc(took(s))}${Number.isFinite(s) && s < 1 ? ' <span class="dim">(timed to the second)</span>' : ''}`)}
        ${kv('Logged', at(h.LogDatetime))}
      </dl>
      <h3 class="detail-section">Where it ran</h3>
      <dl class="kv-list">
        ${kv('Routine', `<span class="mono">${esc(h.Routine || '—')}</span>`)}
        ${kv('Namespace', `<span class="mono">${esc(h.Namespace || '—')}</span>`)}
        ${kv('Run by', h.Username ? esc(h.Username) : dim('—'))}
        ${kv('Process ID', h.Pid ? `<span class="mono">${esc(h.Pid)}</span>` : dim('—'))}
        ${kv('Task ID', h.TaskId ? `<span class="mono">${esc(h.TaskId)}</span>` : dim('—'))}
      </dl>`;
  };

  const taskDetail = (t: TaskStats): string => {
    const times = t.runs.map(({ h }) => secs(h)).filter(Number.isFinite);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : NaN;
    const recent = [...t.runs].sort((a, b) => startMs(b.h) - startMs(a.h)).slice(0, 10);
    return `${head(`Task ${esc(t.taskId)}`, t.name)}
      <div class="detail-state">${failed(t.last.h) ? chip('Last run failed', 'danger') : chip('Last run succeeded', 'success')}</div>
      <h3 class="detail-section">In the kept history</h3>
      <dl class="kv-list">
        ${kv('Runs', num(t.runs.length))}
        ${kv('Succeeded', num(t.ok))}
        ${kv('Failed', t.bad ? `<span style="color:var(--ev-color-danger)">${num(t.bad)}</span>` : '0')}
        ${kv('Success rate', `${Math.round(t.runs.length ? (t.ok / t.runs.length) * 100 : 0)}%`)}
        ${kv('Typical duration', esc(took(avg)))}
        ${kv('Last run', at(t.last.h.LastStart))}
        ${kv('Last failure', t.lastFail ? at(t.lastFail.h.LastStart) : dim('Never'))}
        ${kv('Namespace', `<span class="mono">${esc(t.namespace)}</span>`)}
      </dl>
      <h3 class="detail-section">Recent runs</h3>
      <table class="mini-table"><thead><tr><th>Started</th><th class="r">Duration</th><th>Result</th></tr></thead><tbody>
        ${recent.map(({ h }) => `<tr><td>${esc(when(irisDate(h.LastStart)))}</td><td class="r">${esc(took(secs(h)))}</td><td>${failed(h) ? chip('Failed', 'danger', errorOf(h)) : 'Succeeded'}</td></tr>`).join('')}
      </tbody></table>`;
  };

  const renderDetail = (): void => {
    let html = '';
    if (view === 'tasks') { const t = tasks.find((x) => x.key === selected); if (t) html = taskDetail(t); }
    else { const e = (view === 'runs' ? runs : log).find((x) => x.key === selected); if (e) html = entryDetail(e.h); }
    if (!html) { setPanel(false); return; }
    detailEl.innerHTML = html;
    detailEl.querySelectorAll<HTMLElement>('.kv dd').forEach((dd) => { if (!dd.title) dd.title = dd.textContent?.trim() ?? ''; });
    detailEl.querySelector('#th-close')?.addEventListener('click', close);
    const copy = detailEl.querySelector<HTMLButtonElement>('#th-copy');
    const text = detailEl.querySelector('.pre-block')?.textContent ?? '';
    copy?.addEventListener('click', () => {
      void navigator.clipboard.writeText(text).then(() => {
        copy.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
        setTimeout(() => { copy.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy error'; }, 1600);
      });
    });
    setPanel(true);
  };

  const renderGrid = (): void => {
    if (all.length === 0) {
      grid = null;
      wrap.innerHTML = `<div class="empty"><div class="empty-main"><ev-icon name="clock" size="md"></ev-icon><div class="empty-text">
        <strong>No task history yet</strong>
        <span>The Task Manager adds a line each time a task runs. The Purge Tasks task clears old lines, so an empty list usually means nothing has run since the last purge.</span>
      </div></div></div>`;
      return;
    }
    const shown = rowsFor(view);
    const creating = !grid;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', ROW_KEY[view]);
      grid.setAttribute('sort-column', SORT[view]);
      grid.setAttribute('sort-direction', 'desc');
      grid.columns = COLUMNS[view];
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        selected = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Key);
        renderDetail();
      });
      wrap.appendChild(grid);
    }
    grid.rows = shown;
    // Uniform columns are judged on the whole view, so filtering never makes them jump;
    // the Error column shows only with the Failed filter (otherwise it's all "—"; the Result tooltip carries the error).
    const whole = view === 'runs' ? runs.map(runRow) : view === 'tasks' ? tasks.map(taskRow) : log.map(logRow);
    const next = uniformKeys(whole, UNIFORM[view]) as Set<string>;
    if (creating || [...next].join() !== [...hidden].join()) { hidden = next; applyColumns(); }
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    if (shown.length === 0) {
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">${query ? `Nothing matches “${esc(query)}”.` : filter === 'failed' ? 'No failed runs in the kept history.' : 'Nothing to show.'}</div>`);
    }
  };

  const gate = liveGate(panel, ctx.onLeave);
  const updated = liveIndicator(ctx, () => void load(true));
  /** `force`: the user asked (refresh button), so apply even mid-interaction. */
  const load = async (force = false): Promise<void> => {
    try {
      const list = await getTaskHistory();
      updated(new Date());
      // Held while the pointer is over the workspace or a menu or dialog is open, so rows
      // don't shift under the cursor; the selection is kept by row key either way.
      gate.run(() => apply(list), force || all.length === 0);
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'th-retry');
      wrap.querySelector('#th-retry')?.addEventListener('click', () => void load(true));
    }
  };
  const apply = (list: TaskHistoryEntry[]): void => {
      // No id in the payload: key on what identifies a line, with a counter for exact repeats.
      const seen = new Map<string, number>();
      all = list.map((h) => {
        const base = `${h.LogDatetime}|${h.Pid}|${h.TaskId}|${h.Name}|${h.Result}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return { key: n ? `${base}#${n}` : base, h };
      });
      runs = all.filter(({ h }) => !isManagerEvent(h));
      log = all.filter(({ h }) => isManagerEvent(h));
      const byTask = new Map<string, TaskStats>();
      for (const e of runs) {
        const k = `${e.h.TaskId}|${e.h.Name}`;
        let t = byTask.get(k);
        if (!t) { t = { key: k, name: e.h.Name, taskId: e.h.TaskId, namespace: e.h.Namespace, runs: [], ok: 0, bad: 0, last: e }; byTask.set(k, t); }
        t.runs.push(e);
        if (failed(e.h)) { t.bad++; if (!t.lastFail || startMs(e.h) > startMs(t.lastFail.h)) t.lastFail = e; } else t.ok++;
        if (startMs(e.h) > startMs(t.last.h)) t.last = e;
      }
      tasks = [...byTask.values()];
      renderToolbar();
      renderGrid();
      renderFoot();
      if (selected !== null) renderDetail();
  };

  bindViewTabs(ctx.body, 'th-view', (v) => {
    view = v as View;
    exportBtn.hidden = view !== 'runs';
    selected = null;
    setPanel(false);
    grid = null; // each view has its own columns, key and default sort
    if (filter === 'failed' && view === 'log') filter = 'all';
    filterEl.value = filter;
    renderToolbar();
    renderGrid();
    renderFoot();
  });
  $('th-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  filterEl.addEventListener('ev-segmented-button-change', (e) => {
    filter = (e as CustomEvent<{ value: Filter }>).detail.value;
    renderGrid();
  });

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
