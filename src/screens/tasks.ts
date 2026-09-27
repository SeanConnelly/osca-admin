// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tasks › Upcoming — every task the Task Manager knows about, soonest first,
 * with when it last finished and whether it is suspended. The Task Manager's
 * own state leads the page: if it isn't running, nothing here will run.
 * A task's peek and full view (#/tasks/upcoming/<id>) show its schedule, the
 * last 10 runs and the last output. New task (a four-step wizard in the
 * drawer), Run now, Suspend/Resume and Delete work here. Change schedule on a
 * full view edits it in place (the form is Schedule's); from the list it opens
 * Tasks › Schedule.
 */
import '../styles-apps.css';
import '../styles-web.css';
import {
  getTasks, getTaskRuns, getTask, getTaskInfo, getTaskManager,
  type TaskSummary, type TaskRun, type TaskDetail, type TaskInfo,
} from '../api-apps';
import { takeNewTaskRequest } from '../api-web';
import { openNewTaskWizard, type NewTaskHandle } from './task-new';
import { toast, errorText, newButton, type EditorHandle } from '../crud';
import { linkTo } from '../api-security';
import { describe as describePlain, scheduleEditor, isChained, chainedReason } from './schedule';
import { taskMeta, taskRuns, taskPeekHtml, taskFullView } from './task-detail';
import { taskActions } from '../task-actions';
import { liveGate } from './apps-live';
import { isDate, noPermissionText, esc, cell, chip, pill, future, setChips, relative, when, irisDate, skeleton, errorPanel, liveIndicator, uniformKeys, objectDetail, type ScreenCtx } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 60000;
/** Sort key for tasks with no next run, so they sit after every dated one. */
const NEVER = 8.64e15;

type Group = 'today' | 'tomorrow' | 'later' | 'none';
const GROUP_LABEL: Record<Group, string> = { today: 'Today', tomorrow: 'Tomorrow', later: 'Later', none: 'No next run' };


function groupOf(d: Date | null, now = new Date()): Group {
  if (!d) return 'none';
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  return diff <= 0 ? 'today' : diff === 1 ? 'tomorrow' : 'later';
}

/** "Runs After #1:00" → 1 */
const runAfterId = (s: string): number | null => { const m = /Runs After #(\d+)/i.exec(s); return m ? Number(m[1]) : null; };

interface Row { task: TaskSummary; info?: TaskInfo; next: Date | null; suspended: boolean; after: TaskSummary | null }

/** /task/info "Error" holds the last run's result: "Success", an error message, or "" if it never ran. */
function lastResultOf(r: Row): 'ok' | 'failed' | 'running' | '' {
  const e = r.info?.Error ?? '';
  return !e ? '' : /^success$/i.test(e) ? 'ok' : /^running$/i.test(e) ? 'running' : 'failed';
}


const COLUMNS: DataGridColumn[] = [
  { key: 'Name', label: 'Task', width: '260px', sortable: true, renderCell: (v) => cell.text(v, String(v)) },
  // The Next run cell carries the exceptions (there is no Status column): a suspended task is an
  // amber pill with no time; a chained one reads "After Switch Journal"; on demand is tertiary.
  { key: 'NextAt', label: 'Next run', width: '210px', sortable: true, renderCell: (_v, row) => {
    if (row.Suspended) return pill('Suspended', 'warning', 'Won’t run until it’s resumed');
    if (row.After) return `<span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ev-color-text-secondary)" title="${esc(`Runs straight after ${row.After} finishes`)}">After ${esc(row.After)}</span>`;
    if (!row.NextLabel) return cell.dim('On demand');
    // "Today 01:30" reads first; " · in 24m" steps back in tertiary.
    return `<span style="display:block;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums">${future(new Date(Number(row.NextAt)))}</span>`;
  } },
  { key: 'LastResult', label: 'Last result', width: '110px', sortable: true,
    // The normal outcome carries no mark (plain tertiary text); only Failed is a pill.
    renderCell: (v, row) => (v === 'ok' ? cell.dim('Succeeded') : v === 'failed' ? pill('Failed', 'danger', String(row.LastError))
      : v === 'running' ? cell.text('Running', 'Running now') : cell.dim('—')) },
  { key: 'LastAt', label: 'Last finished', width: '130px', sortable: true,
    renderCell: (v, row) => (Number(v) > 0 ? cell.text(relative(new Date(Number(v))), String(row.LastFull)) : cell.dim('—')) },
  // ev-data-grid uses table-layout:auto, so a width-less column grows to its nowrap text and the host's
  // overflow clips it hard. A % width bounds the column; width:0 + min-width:100% stops the span
  // contributing its text width, so the ellipsis shows (same as Resources).
  { key: 'Description', label: 'Description', width: '100%', renderCell: (v) => (v
    ? `<span style="display:block;width:0;min-width:100%;max-width:100%;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(v)}">${esc(v)}</span>`
    : cell.dim('—')) },
  { key: 'Namespace', label: 'Namespace', width: '100px', sortable: true, renderCell: (v) => cell.mono(v) },
  { key: 'Type', label: 'Type', width: '90px', sortable: true, renderCell: (v) => cell.text(v, v === 'System' ? 'Created by IRIS' : 'Created by a user') },
];
/** Columns that step aside while the detail panel is open, least informative first. */
const SECONDARY = ['Description', 'Namespace', 'Type', 'LastAt'];
/** Columns hidden when every task has the same value (all %SYS system tasks on a fresh instance). */
const UNIFORM_CANDIDATES = ['Namespace', 'Type', 'LastResult'];

function toRow(r: Row): DataGridRow {
  const last = isDate(r.task.LastFinished) ? irisDate(r.task.LastFinished) : null;
  return {
    Id: r.task.Id, Name: r.task.Name, Description: r.task.Description, Namespace: r.task.Namespace, Type: r.task.Type,
    NextAt: r.next ? r.next.getTime() : NEVER,
    NextLabel: r.next ? when(r.next) : '',
    After: r.after ? r.after.Name : '',
    In: r.next ? relative(r.next) : '',
    Suspended: r.suspended,
    LastResult: lastResultOf(r), LastError: r.info?.Error ?? '',
    LastAt: last ? last.getTime() : 0, LastFull: last ? when(last) : '',
  };
}

type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};
type Filter = 'all' | Group | 'suspended';

export function tasksScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="wa-list-view" id="task-list-view">
      <div class="callout callout--banner callout--warning" id="task-banner" role="alert" hidden></div>
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="task-search" size="sm" full-width placeholder="Filter by name, description or namespace"></ev-search></div>
        <ev-segmented-button id="task-filter" size="sm" aria-label="Show tasks by next run"></ev-segmented-button>
        <div class="toolbar-spacer"></div>
      </div>
      <ev-detail-panel id="task-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="task-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="task-detail" aria-label="Task details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="task-foot"></p>
    </div>
    <div id="task-full" hidden></div>`;

  const $ = (id: string): HTMLElement => ctx.body.querySelector(`#${id}`) as HTMLElement;
  const filterEl = $('task-filter') as HTMLElement & { options: unknown; value: string };
  filterEl.value = 'all';
  const panel = $('task-panel') as HTMLElement & { open: boolean };
  const wrap = $('task-grid-wrap');
  const detailEl = $('task-detail');
  const fullEl = $('task-full');
  let grid: GridEl | null = null;
  let rows: Row[] = [];
  let manager = '';
  let query = '';
  let filter: Filter = 'all';
  const details = new Map<number, TaskDetail>();
  let uniform = new Set<string>();
  /** Task privilege (%Admin_Task) from /api/admin/info; null until known (IRIS refuses what isn't allowed). */
  let canTask: boolean | null = null;
  /** The New task wizard while it's open in the drawer; the drawer is left alone until it closes. */
  let wizard: NewTaskHandle | null = null;
  let me = '';
  const leaveWizard = (): void => { wizard?.editor.close(); wizard?.dispose(); wizard = null; ctx.beforeLeave(null); };
  /** Change schedule while it's open in a full view's body. */
  let sched: EditorHandle | null = null;
  let schedEvents: AbortController | null = null;
  const leaveSched = (): void => { sched?.close(); sched = null; schedEvents?.abort(); schedEvents = null; ctx.beforeLeave(null); };
  const mayLeave = async (): Promise<boolean> => {
    if (wizard && !(await wizard.editor.guard())) return false;
    if (sched && !(await sched.guard())) return false;
    leaveWizard();
    leaveSched();
    return true;
  };
  ctx.onLeave(() => { leaveWizard(); leaveSched(); });
  const gate = liveGate(panel, ctx.onLeave);
  const baseTitle = document.querySelector('#page-title')?.textContent?.trim() || 'Upcoming';
  const NO_TASK = noPermissionText('%Admin_Task', 'task management');

  const visible = (): Row[] => rows.filter((r) => {
    if (filter === 'suspended' ? !r.suspended : filter !== 'all' && groupOf(r.next) !== filter) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [r.task.Name, r.task.Description, r.task.Namespace, r.task.Type, String(r.task.Id)].some((f) => f?.toLowerCase().includes(q));
  });

  const renderManager = (): void => {
    if (od.mode() === 'full') return; // the full view's title is the task's breadcrumb
    const running = /^running$/i.test(manager);
    // Tasks › Schedule carries the Task Manager's state; here a pill appears only when something's wrong.
    ctx.heading(running ? esc(baseTitle) : `${esc(baseTitle)} ${manager
      ? chip(`Task Manager ${manager.toLowerCase()}`, 'warning', 'The Task Manager is the IRIS process that starts scheduled tasks; none will run until it’s running')
      : chip('Task Manager status unknown', 'neutral', 'The Task Manager didn’t respond')}`);
    const banner = $('task-banner');
    banner.hidden = !manager || running;
    if (!running && manager) {
      banner.innerHTML = `<ev-icon name="alert-triangle" size="sm"></ev-icon><div>
        <strong>The Task Manager is ${esc(manager.toLowerCase())}, so no scheduled task will run</strong>
        <span>The times below are when tasks are due. None of them starts until an administrator resumes the Task Manager.</span></div>`;
    }
  };

  const renderToolbar = (): void => {
    const n = (f: Filter): number => rows.filter((r) => f === 'all' || (f === 'suspended' ? r.suspended : groupOf(r.next) === f)).length;
    // Chips hide on a tiny list; a zero "Suspended" (a risk state) is hidden rather than dimmed.
    setChips(filterEl, rows.length, (['all', 'today', 'tomorrow', 'later', 'none', 'suspended'] as Filter[]).map((f) => ({
      value: f, label: `${f === 'all' ? 'All' : f === 'suspended' ? 'Suspended' : GROUP_LABEL[f]} ${n(f)}`, disabled: f !== 'all' && f !== filter && n(f) === 0,
    })), { active: filter, risk: ['suspended'], search: $('task-search'), query });
  };

  const renderFoot = (): void => {
    const soon = rows.filter((r) => r.next && !r.suspended && r.next.getTime() - Date.now() < 86400000).length;
    const susp = rows.filter((r) => r.suspended).length;
    $('task-foot').innerHTML = `<b>${rows.length}</b> tasks<span class="meta-sep">·</span><b>${soon}</b> due in 24 hours`
      + (susp ? `<span class="meta-sep">·</span><b>${susp}</b> suspended` : '');
  };

  const applyColumns = (): void => {
    for (const c of COLUMNS) grid?.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };

  // ─── Peek and full view (objectDetail, shared content in task-detail.ts) ───
  const detailOf = async (id: number): Promise<TaskDetail> => {
    const d = details.get(id) ?? await getTask(id);
    details.set(id, d);
    return d;
  };
  const sentenceOf = (r: Row, d: TaskDetail): string => describePlain(d, r.after);
  const changeSchedule = (r: Row): void => {
    if (od.mode() === 'full') { void scheduleInFull(r); return; }
    // Tasks › Schedule picks this up to open the task (shared cross-screen selection key).
    try { sessionStorage.setItem('osca-portal:select', String(r.task.Id)); } catch { /* storage blocked: Schedule opens unselected */ }
    ctx.navigate('tasks/schedule');
  };
  const actions = taskActions({
    canTask: () => canTask,
    manager: () => manager,
    cached: (id) => details.get(id),
    changeSchedule: (v) => { const r = rows.find((x) => x.task.Id === v.task.Id); if (r) changeSchedule(r); },
    changeBlocked: (v) => (canTask === false ? NO_TASK : v.after ? chainedReason(v.after) : null),
    navigate: (path) => ctx.navigate(path),
    openTask: (id) => void (od.mode() === 'full' ? od.openFull(String(id)) : od.select(String(id))),
    reload: () => load(true),
    deleted: async (id) => {
      details.delete(id);
      if (od.mode() === 'full') await od.closeFull();
      await od.select(null);
      await load(true);
    },
  });
  /** The full view is showing (od isn't assigned while objectDetail() is being set up). */
  const isFull = (): boolean => { try { return od.mode() === 'full'; } catch { return false; } };
  const od = objectDetail<Row>(ctx, {
    collection: 'Upcoming', noun: 'task', // the breadcrumb names the list it came from (the nav label)
    panel, detail: detailEl, list: $('task-list-view'), full: $('task-full'),
    key: (r) => String(r.task.Id),
    find: (k) => rows.find((r) => String(r.task.Id) === k),
    order: () => visible().map(toRow).sort((a, b) => Number(a.NextAt) - Number(b.NextAt)).map((x) => String(x.Id)),
    name: (r) => r.task.Name,
    meta: (r) => taskMeta(r, isFull()),
    description: (r) => r.task.Description,
    // One action set per task on Upcoming and Schedule (task-actions.ts): Resume leads when it's suspended.
    primary: (r) => actions.primary(r),
    menu: (r) => actions.menu(r),
    peek: async (r) => {
      try {
        const [d, runs] = await Promise.all([detailOf(r.task.Id), taskRuns(r.task.Id).catch(() => [])]);
        return taskPeekHtml(r, d, runs, sentenceOf(r, d));
      } catch (err) { return errorPanel(err); }
    },
    loadFull: async (r) => {
      const [d, runs] = await Promise.all([detailOf(r.task.Id), taskRuns(r.task.Id).catch(() => [])]);
      return taskFullView(r, d, runs, sentenceOf(r, d));
    },
    onSelect: (k) => grid?.select(k ? [k] : []),
    onPeek: () => applyColumns(),
    canLeave: mayLeave,
  });
  /**
   * Change schedule on the full view (#/tasks/upcoming/<id>): Schedule's form takes the page body's place,
   * so the address, title and ‹ › pager stay, and Cancel or Save bring the full view back.
   */
  const scheduleInFull = async (r: Row): Promise<void> => {
    if (!(await mayLeave())) return;
    const id = r.task.Id;
    let d: TaskDetail;
    try { d = await getTask(id); } catch (err) { toast(errorText(err), 'danger'); return; } // the form starts from a fresh read
    // The user may have paged or gone back to the list while the read was out.
    if (sched || od.mode() !== 'full' || od.selected() !== String(id)) return;
    details.set(id, d);
    if (isChained(d)) { toast(chainedReason(r.after), 'warning'); return; }
    schedEvents = new AbortController();
    sched = scheduleEditor(fullEl, {
      task: r.task, detail: d, inFull: true, signal: schedEvents.signal, suspended: r.suspended,
      onSaved: async (body) => {
        leaveSched();
        details.delete(id);
        fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
        await load(true); // redraws the full view
        if (od.mode() === 'full' && !fullEl.childElementCount) od.refresh(); // the list read failed: show it from what's known
        const next = rows.find((x) => x.task.Id === id)?.next;
        toast(body.TimePeriod === 'On Demand' ? `${r.task.Name} now runs only when someone starts it.`
          : `Schedule for ${r.task.Name} saved.${next ? ` Next run ${when(next)}.` : ''}`);
      },
      onCancel: () => { leaveSched(); fullEl.innerHTML = ''; od.refresh(); },
    });
    ctx.beforeLeave(() => (sched ? sched.guard() : Promise.resolve(true)));
  };
  // Links in the peek and full view (Runs as → Users).
  ctx.body.addEventListener('click', (e) => {
    const u = (e.target as Element).closest<HTMLElement>('#task-detail [data-user], #task-full [data-user]');
    if (!u || (e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey) return;
    e.preventDefault();
    linkTo(ctx.navigate, 'security/users', u.dataset.user ?? '');
  });

  const renderGrid = (): void => {
    const shown = visible().map(toRow);
    const creating = !grid;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Id');
      grid.setAttribute('sort-column', 'NextAt');
      grid.setAttribute('sort-direction', 'asc');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => void od.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Id)));
      wrap.appendChild(grid);
    }
    grid.rows = shown;
    // Judged on every task, so filtering never makes columns jump.
    const next = uniformKeys(rows.map(toRow), UNIFORM_CANDIDATES) as Set<string>;
    if (creating || [...next].join() !== [...uniform].join()) { uniform = next; applyColumns(); }
    const sel = od.selected();
    grid.select(sel && !wizard ? [sel] : []);
    wrap.querySelector('.grid-empty')?.remove();
    if (shown.length === 0) {
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">${query ? `No tasks match “${esc(query)}”.` : rows.length ? 'No tasks in this group.' : 'The Task Manager has no tasks defined.'}</div>`);
    }
  };

  const updated = liveIndicator(ctx, () => void load(true));
  /** New task: the wizard takes the drawer; once IRIS has created it, its row is selected and its peek opens. */
  let opening = false;
  const openWizard = async (): Promise<void> => {
    if (wizard || opening || !(await mayLeave())) return;
    opening = true;
    try { await showWizard(); } finally { opening = false; }
  };
  const showWizard = async (): Promise<void> => {
    if (od.mode() === 'full') await od.closeFull();
    if (!me) me = (await sessionInfo().catch(() => null))?.username ?? '';
    await od.select(null);
    grid?.select([]);
    const h = await openNewTaskWizard({
      host: detailEl, panel,
      existingNames: rows.map((r) => r.task.Name),
      me,
      onCreated: async (id) => {
        leaveWizard();
        details.delete(id);
        await load(true);
        await od.select(String(id));
        requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
      },
      onCancel: () => { leaveWizard(); panel.open = false; applyColumns(); },
    });
    if (!h) return;
    wizard = h;
    applyColumns();
    ctx.beforeLeave(() => (wizard ? wizard.editor.guard() : Promise.resolve(true)));
  };
  const newBtn = newButton(ctx, 'New task', () => void openWizard());
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  sessionInfo().then((info) => {
    canTask = can(info, 'Task');
    me = info.username ?? '';
    if (!alive) return;
    newBtn.setHidden(canTask === false);
    if (!wizard && !sched) od.refreshHeader();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });
  /** `force`: the user asked (refresh button, after an action), so apply even mid-interaction. */
  const load = async (force = false): Promise<void> => {
    try {
      const [tasks, runs, mgr] = await Promise.all([getTasks(), getTaskRuns().catch((): TaskRun[] => []), getTaskManager().catch(() => ({ Status: '' }))]);
      // /tasks and /task/upcoming can disagree on Suspended; per-task info is the tiebreaker.
      const infos = await Promise.allSettled(tasks.map((t) => getTaskInfo(t.Id)));
      manager = mgr.Status;
      const runAt = new Map<number, TaskRun>();
      for (const r of runs) if (!runAt.has(r.Id)) runAt.set(r.Id, r);
      const byId = new Map(tasks.map((t) => [t.Id, t]));
      const nextOf = (t: TaskSummary, info?: TaskInfo, depth = 0): Date | null => {
        const up = runAt.get(t.Id)?.Datetime;
        const s = up || (info?.NextScheduled && isDate(info.NextScheduled) ? info.NextScheduled : t.NextScheduled);
        if (isDate(s)) return irisDate(s);
        const parent = runAfterId(t.NextScheduled);
        const p = parent !== null ? byId.get(parent) : undefined;
        return p && depth < 5 ? nextOf(p, undefined, depth + 1) : null;
      };
      const next = tasks.map((t, i) => {
        const info = infos[i].status === 'fulfilled' ? (infos[i] as PromiseFulfilledResult<TaskInfo>).value : undefined;
        const parent = runAfterId(t.NextScheduled);
        return {
          task: t, info,
          next: nextOf(t, info),
          suspended: t.Suspended || !!runAt.get(t.Id)?.Suspended || !!info?.Suspended,
          after: parent !== null ? byId.get(parent) ?? null : null,
        };
      });
      if (!alive) return;
      updated(new Date());
      renderManager();
      // Held while the pointer is over the workspace or a menu or dialog is open, so rows
      // don't reorder under the cursor; selection is by task ID, so it survives either way.
      gate.run(() => {
        rows = next;
        renderToolbar();
        renderGrid();
        renderFoot();
        if (!wizard && !sched) od.refresh(); // never replace a form under the user's hands
      }, force || rows.length === 0 || od.mode() === 'full');
    } catch (err) {
      if (od.mode() === 'full') return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'task-retry');
      wrap.querySelector('#task-retry')?.addEventListener('click', () => void load(true));
    }
  };

  $('task-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  filterEl.addEventListener('ev-segmented-button-change', (e) => {
    filter = (e as CustomEvent<{ value: Filter }>).detail.value;
    renderGrid();
  });

  // Arriving from Schedule's "New task": open the wizard once the list is in.
  const wantNew = takeNewTaskRequest();
  void load().then(() => { if (alive && wantNew) void openWizard(); });
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
