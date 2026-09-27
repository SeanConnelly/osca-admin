// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Background jobs — the long-running work the signed-in user
 * started through the portal (integrity checks, compacting, audit searches…):
 * its state, progress, output and why it failed. IRIS keeps only the
 * signed-in user's jobs, and clears each a day after it finishes.
 * Compact, defragment and integrity check can be paused, resumed and
 * cancelled while they run; any job can be cancelled while it's queued.
 */
import '../styles-security.css';
import '../styles-ops.css';
import { redFailed, getJobs, getJob, jobAction, getDbNames, stripErrorPrefix, opsDocs, type JobRow, type JobDetail, type JobState } from '../api-ops';
import { kv, noPermissionText, setSearch, exportButton, gridExport, esc, chip, cell, num, skeleton, errorPanel, liveIndicator, emptyState, when, irisDate, duration, middle, type GridColumn, type ScreenCtx, type Tone } from '../ui';
import { AdminError, blockedAttrs, confirm, errorText, toast } from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 5000;
const NO_OPERATE = noPermissionText('%Admin_Operate', 'system operation');

type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};
type Scope = 'all' | 'active' | 'failed';

/* ───────────── What each job is ───────────── */

interface Kind { name: string; verb: string; pausable: boolean; routine?: boolean }
/** Keyed by the request IRIS names the job after (method + path, without the version). */
const KINDS: Record<string, Kind> = {
  'database-dir/integrity-check': { name: 'Integrity check', verb: 'the integrity check', pausable: true },
  'database-dir/compact': { name: 'Compact database', verb: 'compacting', pausable: true },
  'database-dir/defragment': { name: 'Defragment database', verb: 'defragmenting', pausable: true },
  'database-dir/truncate': { name: 'Return free space to disk', verb: 'returning free space', pausable: false },
  'database-dir/modify-size': { name: 'Expand database', verb: 'expanding the database', pausable: false },
  'database-dir/expand-volume': { name: 'Add a database volume', verb: 'adding a volume', pausable: false },
  'database-dir/info': { name: 'Read database figures', verb: 'reading the figures', pausable: false, routine: true },
  'database-dir/mount': { name: 'Mount database', verb: 'mounting', pausable: false },
  'database-dir/dismount': { name: 'Dismount database', verb: 'dismounting', pausable: false },
  'journal/file/integrity-check': { name: 'Check journal file', verb: 'the journal check', pausable: false },
  'security/audit/records': { name: 'Search the audit log', verb: 'the audit search', pausable: false },
  'journal/file/records': { name: 'Read journal records', verb: 'reading journal records', pausable: false },
  'ecp/data-server/action': { name: 'ECP data server change', verb: 'the data server change', pausable: false },
  'namespace/enable-interop': { name: 'Enable interoperability', verb: 'enabling interoperability', pausable: false },
};
/** Words that stay upper case when a path becomes a job name. */
const ACRONYMS = new Set(['ecp', 'tls', 'sql', 'wij', 'csp', 'api', 'mft', 'oauth', 'ssl', 'db']);
const kindKey = (taskName: string): string => taskName.replace(/^[A-Z]+\s+/, '').replace(/^\/?(api\/admin\/)?v\d+\//, '').replace(/\?.*$/, '');
function kindOf(taskName: string): Kind {
  const k = KINDS[kindKey(taskName)];
  if (k) return k;
  // Unknown work: a sentence-case name from the path's words, never the path itself ("ECP data server").
  const words = kindKey(taskName).split(/[/-]/).filter((w) => w && w !== 'action').map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  const joined = words.join(' ');
  const name = joined ? joined.charAt(0).toUpperCase() + joined.slice(1) : 'Background work';
  return { name, verb: 'this job', pausable: false };
}

const STATE: Record<JobState, { label: string; tone: Tone }> = {
  Queued: { label: 'Waiting to start', tone: 'neutral' },
  Running: { label: 'Running', tone: 'info' },
  Paused: { label: 'Paused', tone: 'warning' },
  Finished: { label: 'Finished', tone: 'success' },
  Failed: { label: 'Failed', tone: 'danger' },
  Canceled: { label: 'Cancelled', tone: 'neutral' },
};
const stateOf = (s: string): { label: string; tone: Tone } => STATE[s as JobState] ?? { label: s, tone: 'neutral' };
const isActive = (j: { State: string }): boolean => j.State === 'Queued' || j.State === 'Running' || j.State === 'Paused';
const dateOr = (s: string): Date | null => (s ? irisDate(s) : null);
function took(j: { TimeStarted: string; TimeFinished: string; State: string }): number {
  const a = dateOr(j.TimeStarted);
  const b = j.TimeFinished ? dateOr(j.TimeFinished) : isActive(j) ? new Date() : null;
  return a && b ? Math.max(0, (b.getTime() - a.getTime()) / 1000) : NaN;
}

/** What the user can do with a job, and why not. */
function actionsOf(j: { State: string; TaskName: string }): { pause: boolean; resume: boolean; cancel: boolean; note: string } {
  const k = kindOf(j.TaskName);
  if (j.State === 'Queued') return { pause: false, resume: false, cancel: true, note: '' };
  if (j.State === 'Running') {
    return k.pausable
      ? { pause: true, resume: false, cancel: true, note: '' }
      : { pause: false, resume: false, cancel: false, note: 'IRIS can’t pause or cancel this kind of job once it has started; it stops on its own when the work is done.' };
  }
  if (j.State === 'Paused') return { pause: false, resume: true, cancel: true, note: '' };
  return { pause: false, resume: false, cancel: false, note: '' };
}

/** Long file paths inside a message, middle-truncated so the file name stays visible. */
const shortPaths = (text: string): string => text.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]{36,}/g, (p) => middle(p, 36));

/** "BlocksScanned" → "Blocks scanned". */
const words = (key: string): string => { const w = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(); return w.charAt(0).toUpperCase() + w.slice(1); };
const scalar = (v: unknown): v is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof v);

export function jobsScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="jb-toolbar">
      <div class="search-box"><ev-search id="jb-search" size="sm" full-width placeholder="Filter by job, state or reason" aria-label="Filter jobs"></ev-search></div>
      <ev-segmented-button id="jb-scope" size="sm" aria-label="Show"></ev-segmented-button>
      <div class="toolbar-spacer"></div>
      <ev-checkbox id="jb-own" size="sm">Show monitoring jobs</ev-checkbox>
      <span id="jb-export-slot" hidden></span>
    </div>
    <ev-detail-panel id="jb-panel" detail-width="420" overlay-below="960" class="workspace">
      <div class="grid-wrap ops-wrap" id="jb-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="jb-detail" aria-label="Background job"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="jb-foot"></p>`;
  // Export: the jobs shown (visible columns, current sort).
  { const slot = ctx.body.querySelector('#jb-export-slot') as HTMLElement; slot.replaceWith(exportButton(() => gridExport(ctx.body.querySelector('#jb-panel ev-data-grid'), 'background-jobs'))); }

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#jb-panel');
  const wrap = $('#jb-wrap');
  const detail = $('#jb-detail');
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#jb-scope');
  scopeEl.addEventListener('ev-segmented-button-change', (e) => { scope = (e as CustomEvent<{ value: Scope }>).detail.value; renderGrid(); });

  let all: JobRow[] = [];
  let loaded = false;
  let query = '';
  // "#/operations/jobs/failed" (Home's "Show failed") opens on the failures; otherwise everything.
  let scope: Scope = ctx.param === 'failed' || ctx.param === 'active' ? ctx.param : 'all';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let canOperate = true;
  let busy = false;
  let me = '';
  let dbByDir = new Map<string, string>();
  const details = new Map<string, JobDetail | { error: string }>();
  let shownSig = '';

  const dirKey = (d: string): string => d.toLowerCase().replace(/[\\/]+$/, '');
  const matches = (j: JobRow): boolean => {
    if (!query) return true;
    const ql = query.toLowerCase();
    return [kindOf(j.TaskName).name, stateOf(j.State).label, j.FailureReason, when(irisDate(j.TimeQueued))].some((f) => String(f ?? '').toLowerCase().includes(ql));
  };
  /** The portal's own figure reads (database free space etc.) stay out of the way unless asked for. */
  let withOwn = false;
  const isOwn = (j: JobRow): boolean => !!kindOf(j.TaskName).routine;
  const shown = (): JobRow[] => (withOwn ? all : all.filter((j) => !isOwn(j)));
  const inScope = (j: JobRow, s: Scope): boolean => s === 'all' || (s === 'active' ? isActive(j) : j.State === 'Failed');
  const visible = (): JobRow[] => shown().filter((j) => inScope(j, scope) && matches(j));


  /* ───── Grid ───── */
  const COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Job', width: '240px', sortable: true, renderCell: (v, row) => (row.Routine ? cell.dim(String(v)) : cell.text(v)) },
    { key: 'State', label: 'State', width: '150px', sortable: true, renderCell: (v) => { const s = stateOf(String(v)); return chip(s.label, s.tone); } },
    { key: 'Queued', label: 'Started', width: '150px', sortable: true, align: 'right', description: 'When you asked for it', renderCell: (v) => cell.num(when(new Date(Number(v)))) },
    { key: 'Took', label: 'Took', width: '90px', sortable: true, align: 'right', description: 'From starting to finishing', renderCell: (v, row) => (Number.isFinite(Number(v)) && v !== '' ? cell.num(`${duration(Number(v))}${row.Active ? ' so far' : ''}`) : cell.dim('—')) },
    { key: 'Reason', label: 'Why it failed', sortable: true, renderCell: (v) => (v ? cell.text(shortPaths(String(v)), String(v)) : cell.dim('')) },
  ];
  const SECONDARY = ['Took', 'Reason'];
  const toRow = (j: JobRow): DataGridRow => {
    const t = took(j);
    return {
      GUID: j.GUID, Name: kindOf(j.TaskName).name, Routine: kindOf(j.TaskName).routine ? 1 : 0, State: j.State,
      Queued: irisDate(j.TimeQueued).getTime(), Took: Number.isFinite(t) ? Math.round(t) : '', Active: isActive(j) ? 1 : 0,
      Reason: j.State === 'Failed' ? stripErrorPrefix(j.FailureReason) : '',
    };
  };
  /** Every listed job in the same state: the State column steps aside and the footer says it once. */
  const oneState = (): string => { const l = shown(); return l.length > 1 && l.every((j) => j.State === l[0].State) ? l[0].State : ''; };
  const applyColumns = (): void => {
    for (const k of SECONDARY) grid?.setColumnVisible(k, !panel.open && (k !== 'Reason' || visible().some((j) => j.State === 'Failed')));
    grid?.setColumnVisible('State', !oneState());
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => { selected = null; shownSig = ''; grid?.select([]); setPanel(false); };

  const renderToolbar = (): void => {
    const n = (s: Scope): number => shown().filter((j) => inScope(j, s)).length;
    scopeEl.options = [
      { value: 'all', label: `All ${n('all')}` },
      { value: 'active', label: `Active ${n('active')}`, disabled: n('active') === 0 && scope !== 'active' },
      { value: 'failed', label: `Failed ${n('failed')}`, disabled: n('failed') === 0 && scope !== 'failed' },
    ];
    scopeEl.value = scope;
    redFailed(scopeEl, n('failed') > 0);
  };

  let rowSig = '';
  const renderGrid = (): void => {
    if (loaded && !all.length) {
      grid = null; rowSig = '';
      $('#jb-toolbar').hidden = true;
      closeDetail();
      wrap.innerHTML = emptyState({
        icon: 'clock', title: 'No background jobs',
        what: 'Integrity checks, compacting, audit searches and other long work you start appear here while they run and for a day after.',
        docs: { href: opsDocs.jobs, label: 'About background work' },
      });
      return;
    }
    $('#jb-toolbar').hidden = false;
    setSearch($('#jb-search'), shown().length, { query, filtered: scope !== 'all' });
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'GUID');
      grid.setAttribute('sort-column', 'Queued');
      grid.setAttribute('sort-direction', 'desc');
      grid.setAttribute('aria-label', 'Background jobs');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        selected = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.GUID);
        shownSig = '';
        renderDetail();
        void fetchDetail(selected);
      });
      wrap.appendChild(grid);
    }
    const rows = visible().map(toRow);
    const sig = JSON.stringify(rows);
    if (sig !== rowSig) { rowSig = sig; grid.rows = rows; }
    applyColumns();
    if (selected) grid.select([selected]);
    wrap.querySelector('.ops-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      const hidden = all.length - shown().length;
      const what = query ? `No job matches “${esc(query)}”${scope !== 'all' ? ' in this view' : ''}.` : scope === 'active' ? 'Nothing is running or waiting to start.' : scope === 'failed' ? 'No job has failed.'
        : `The only jobs are ${num(hidden)} monitoring job${hidden === 1 ? '' : 's'} the portal starts itself. Tick “Show monitoring jobs” to see them.`;
      wrap.insertAdjacentHTML('beforeend', `<div class="ops-empty">${emptyState({
        icon: query ? 'search' : 'check', title: query ? 'Nothing matches' : scope === 'active' ? 'Nothing running' : scope === 'failed' ? 'No failures' : 'No jobs you started', what,
        action: '<button type="button" class="btn btn--sm" data-jb-clear>Show all jobs</button>',
      })}</div>`);
      wrap.querySelector('[data-jb-clear]')?.addEventListener('click', () => {
        query = ''; scope = 'all'; renderToolbar();
        ($('#jb-search') as HTMLElement & { value: string }).value = '';
        renderGrid();
      });
    }
  };

  const renderFoot = (): void => {
    if (!loaded) return;
    const sep = '<span class="meta-sep">·</span>';
    const list = shown();
    const hidden = all.length - list.length;
    const active = list.filter(isActive).length;
    const failed = list.filter((j) => j.State === 'Failed').length;
    const one = oneState();
    const figs = [`<b>${num(list.length)}</b> job${list.length === 1 ? '' : 's'}`];
    if (one) figs.push(`all ${esc(stateOf(one).label.toLowerCase())}`);
    else figs.push(`<b>${num(active)}</b> active`, `<b>${num(failed)}</b> failed`);
    if (hidden) figs.push(`${num(hidden)} monitoring job${hidden === 1 ? '' : 's'} hidden`);
    $('#jb-foot').innerHTML = all.length && (list.length || hidden) ? figs.join(sep) : '';
  };

  /* ───── Detail ───── */
  const fetchDetail = async (id: string): Promise<void> => {
    try {
      const d = await getJob(id);
      details.set(id, d);
    } catch (err) {
      details.set(id, { error: err instanceof AdminError && err.status === 404 ? 'IRIS no longer has this job.' : errorText(err) });
    }
    if (selected === id) renderDetail();
  };

  const resultHtml = (j: JobRow, d: JobDetail): string => {
    const r = d.Result as Record<string, unknown> | unknown[] | null;
    const out: string[] = [];
    if (Array.isArray(r)) {
      out.push(`<h3 class="detail-section">Result</h3><p class="detail-para">${num(r.length)} ${kindKey(j.TaskName) === 'security/audit/records' ? `audit record${r.length === 1 ? '' : 's'} found` : `row${r.length === 1 ? '' : 's'}`}. They were shown on the page that asked for them.</p>`);
    } else if (r && typeof r === 'object') {
      const obj = r as Record<string, unknown>;
      const dir = typeof obj.Database === 'string' ? obj.Database : '';
      if (dir) out.push(`<p class="detail-para">Database <b>${esc(dbByDir.get(dirKey(dir)) ?? dir)}</b>${dbByDir.has(dirKey(dir)) ? ` <span class="mono dim">${esc(dir)}</span>` : ''}</p>`);
      const total = Number(obj.ProgressTotal);
      const cur = Number(obj.ProgressCurrent);
      if (Number.isFinite(total) && total > 0) {
        const pctDone = Math.max(0, Math.min(100, (cur / total) * 100));
        const units = String(obj.ProgressUnits ?? '');
        out.push(`<h3 class="detail-section">Progress</h3>
          <div class="ops-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pctDone)}"><span style="width:${pctDone}%"></span></div>
          <p class="detail-note ops-progress-text">${num(cur)} of ${num(total)}${units ? ` ${esc(units)}` : ''} · ${Math.round(pctDone)}%</p>`);
      }
      const skip = new Set(['Database', 'ProgressTotal', 'ProgressCurrent', 'ProgressUnits', 'ProgressDetails']);
      const rows = Object.entries(obj).filter(([k, v]) => !skip.has(k) && scalar(v) && v !== '').slice(0, 14);
      if (rows.length) {
        out.push(`<h3 class="detail-section">Result</h3><dl class="kv-list">${rows.map(([k, v]) =>
          kv(words(k), typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'number' ? num(v) : esc(v), String(v))).join('')}</dl>`);
      }
    }
    if (d.Console?.length) {
      const text = d.Console.join('\n');
      out.push(`<h3 class="detail-section">Output · ${num(d.Console.length)} line${d.Console.length === 1 ? '' : 's'}</h3>
        <pre class="ops-console" tabindex="0" aria-label="Job output">${esc(text)}</pre>
        <div class="detail-actions"><button type="button" class="btn btn--sm" id="jb-copy"><ev-icon name="copy" size="xs"></ev-icon>Copy output</button></div>`);
    }
    return out.join('');
  };

  const renderDetail = (): void => {
    const j = all.find((x) => x.GUID === selected);
    if (!j) { if (selected) closeDetail(); return; }
    const d = details.get(j.GUID);
    const a = actionsOf(j);
    const note = !canOperate && (a.pause || a.resume || a.cancel) ? NO_OPERATE : a.note;
    const sig = JSON.stringify([j, d ? ('error' in d ? d.error : [d.State, d.Console?.length, d.Result]) : null, canOperate, busy]);
    if (sig === shownSig) return;
    shownSig = sig;
    const k = kindOf(j.TaskName);
    const s = stateOf(j.State);
    const t = took(j);
    const blocked = blockedAttrs(busy ? 'Working…' : null);
    const can = canOperate;
    const reason = stripErrorPrefix(j.FailureReason || (d && !('error' in d) ? d.FailureReason : ''));
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><h2>${esc(k.name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="jb-close"></ev-icon-button>
      </header>
      <div class="detail-state">${chip(s.label, s.tone)}<span class="dim">${Number.isFinite(t) ? `${isActive(j) ? 'for' : 'took'} ${esc(duration(Math.round(t)))}` : ''}</span></div>
      ${can && (a.pause || a.resume || a.cancel) ? `<div class="detail-actions">
        ${a.pause ? `<button type="button" class="btn btn--sm" id="jb-pause"${blocked}>Pause</button>` : ''}
        ${a.resume ? `<button type="button" class="btn btn--sm" id="jb-resume"${blocked}><ev-icon name="check" size="xs"></ev-icon>Resume</button>` : ''}
        ${a.cancel ? `<button type="button" class="btn btn--sm" id="jb-cancel"${blocked}>Cancel job…</button>` : ''}
      </div>` : ''}
      ${note ? `<p class="detail-note">${esc(note)}</p>` : ''}
      ${j.State === 'Failed' ? `<div class="sec-callout sec-callout--danger ops-callout" role="status"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>Why it failed</strong><span>${esc(reason || 'IRIS gave no reason.')}</span></div></div>` : ''}
      ${k.routine ? '<p class="detail-para">The portal starts this itself whenever it shows a database’s figures, such as free space inside the file.</p>' : ''}
      <h3 class="detail-section">When</h3>
      <dl class="kv-list">
        ${kv('Asked for', esc(when(irisDate(j.TimeQueued), { seconds: true })))}
        ${kv('Started', j.TimeStarted ? esc(when(irisDate(j.TimeStarted), { seconds: true })) : '<span class="dim">Not yet</span>')}
        ${kv(j.State === 'Canceled' ? 'Cancelled' : 'Finished', j.TimeFinished ? esc(when(irisDate(j.TimeFinished), { seconds: true })) : isActive(j) ? '<span class="dim">Not yet</span>' : '—')}
        ${kv('Started as', esc(me || '—'))}
      </dl>
      <div id="jb-result">${!d ? skeleton(3) : 'error' in d ? `<p class="detail-note">${esc(d.error)}</p>` : resultHtml(j, d)}</div>`;
    detail.querySelector('#jb-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#jb-pause')?.addEventListener('click', () => void act(j, 'pause'));
    detail.querySelector('#jb-resume')?.addEventListener('click', () => void act(j, 'resume'));
    detail.querySelector('#jb-cancel')?.addEventListener('click', () => void cancel(j));
    detail.querySelector('#jb-copy')?.addEventListener('click', () => {
      const dd = details.get(j.GUID);
      if (!dd || 'error' in dd) return;
      void navigator.clipboard.writeText(dd.Console.join('\n')).then(() => toast('Output copied.'), () => toast('Couldn’t copy: the browser blocked it.', 'warning'));
    });
    setPanel(true);
  };

  /* ───── Actions ───── */
  /** IRIS's refusal in words: the job moved on before the request arrived. */
  const refusal = (err: unknown, verb: 'pause' | 'resume' | 'cancel'): string => {
    if (err instanceof AdminError && err.status === 404) return 'IRIS no longer has this job.';
    if (err instanceof AdminError && err.status === 409) {
      return verb === 'cancel' ? 'IRIS can’t cancel this job now: it has already started or finished.'
        : verb === 'pause' ? 'IRIS can’t pause this job now: it isn’t running any more.'
          : 'IRIS can’t resume this job now: it isn’t paused any more.';
    }
    return errorText(err);
  };
  const run = async (j: JobRow, verb: 'pause' | 'resume' | 'cancel', done: string): Promise<void> => {
    busy = true; shownSig = ''; renderDetail();
    try {
      await jobAction(verb, j.GUID);
      toast(done);
    } catch (err) {
      toast(refusal(err, verb), err instanceof AdminError && (err.status === 409 || err.status === 404) ? 'warning' : 'danger');
    } finally {
      busy = false; shownSig = '';
      await load(true);
      if (selected === j.GUID) void fetchDetail(j.GUID);
    }
  };
  const act = (j: JobRow, verb: 'pause' | 'resume'): Promise<void> => {
    const k = kindOf(j.TaskName);
    return run(j, verb, verb === 'pause' ? `${k.name} paused. Resume it from here when you’re ready.` : `${k.name} resumed.`);
  };
  async function cancel(j: JobRow): Promise<void> {
    const k = kindOf(j.TaskName);
    const started = j.State !== 'Queued';
    const ok = await confirm({
      title: `Cancel ${k.verb}?`,
      body: started
        ? `<p>IRIS stops ${esc(k.verb)} at the next safe point. Work it has already done stays done${kindKey(j.TaskName) === 'database-dir/compact' ? ': data it has moved stays where it now is' : ''}; it doesn’t roll back.</p><p>You can start it again later from the database’s page.</p>`
        : '<p>It hasn’t started, so nothing has changed yet. It won’t run.</p>',
      confirmLabel: 'Cancel job', cancelLabel: 'Keep it', danger: started,
      alternative: j.State === 'Running' && k.pausable ? { label: 'Pause instead', onSelect: () => void act(j, 'pause') } : undefined,
    });
    if (ok) await run(j, 'cancel', `${k.name} cancelled.`);
  }

  void sessionInfo().then((info) => {
    me = info.username;
    canOperate = can(info, 'Operate') !== false;
    shownSig = '';
    renderFoot();
    renderDetail();
    if (loaded && !all.length) renderGrid();
  }).catch(() => { /* keep defaults */ });
  void getDbNames().then((dbs) => { dbByDir = new Map(dbs.map((d) => [dirKey(d.Directory), d.Name])); shownSig = ''; renderDetail(); }).catch(() => { /* paths stay */ });

  /* ───── Live refresh ───── */
  let hovering = false;
  let held: { rows: JobRow[]; at: Date } | null = null;
  const frozen = (): boolean => hovering || !!document.querySelector('.crud-menu, ev-dialog') || busy;
  wrap.addEventListener('pointerenter', () => { hovering = true; });
  wrap.addEventListener('pointerleave', () => { hovering = false; flush(); });
  const paint = (rows: JobRow[], at: Date): void => {
    const before = selected ? all.find((x) => x.GUID === selected) : undefined;
    all = rows;
    loaded = true;
    updated(at);
    renderToolbar();
    renderGrid();
    renderFoot();
    if (selected) {
      const now = all.find((x) => x.GUID === selected);
      // Re-read the open job while it runs, and once more when it changes state.
      if (now && (isActive(now) || now.State !== before?.State)) void fetchDetail(selected);
      renderDetail();
    }
  };
  function flush(): void {
    if (!held || frozen()) return;
    const h = held; held = null;
    paint(h.rows, h.at);
  }
  const flushTimer = setInterval(flush, 400);
  ctx.onLeave(() => clearInterval(flushTimer));

  const updated = liveIndicator(ctx, () => void load(true));
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  const load = async (force = false): Promise<void> => {
    try {
      const rows = await getJobs();
      if (!alive) return;
      if (grid && !force && frozen()) { held = { rows, at: new Date() }; return; }
      held = null;
      paint(rows, new Date());
    } catch (err) {
      if (!alive) return;
      grid = null; rowSig = '';
      wrap.innerHTML = errorPanel(err, 'jb-retry');
      wrap.querySelector('#jb-retry')?.addEventListener('click', () => void load(true));
    }
  };

  const ownEl = $<HTMLElement & { checked: boolean }>('#jb-own');
  ownEl.addEventListener('ev-checkbox-change', () => {
    withOwn = !!ownEl.checked;
    if (selected && !withOwn && all.some((j) => j.GUID === selected && isOwn(j))) closeDetail();
    renderToolbar(); renderGrid(); renderFoot();
  });
  $('#jb-search').addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
