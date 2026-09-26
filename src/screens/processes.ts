/**
 * Operations › Processes — every IRIS process, filterable, with a detail panel
 * for the one you select. Read-only for now: the panel shows the actions each
 * process allows, enabled once sign-in lands.
 */
import { getProcesses, type Process } from '../api';
import { metrics, value } from '../metrics';
import { esc, compact, elapsed, chip, cell, middle, skeleton, errorPanel, liveIndicator, type ScreenCtx, type Tone } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

const REFRESH_MS = 5000;

/** Process state codes → plain language; the code stays in the tooltip. */
const STATES: Record<string, { label: string; tone: Tone }> = {
  RUN: { label: 'Running', tone: 'success' },
  RUNW: { label: 'Waiting', tone: 'neutral' },
  READ: { label: 'Waiting for input', tone: 'neutral' },
  WRT: { label: 'Writing output', tone: 'neutral' },
  EVTW: { label: 'Waiting for an event', tone: 'neutral' },
  HANGW: { label: 'Sleeping', tone: 'neutral' }, // ObjectScript HANG n — a deliberate pause, not a hung process
  SEMW: { label: 'Waiting on a semaphore', tone: 'neutral' },
  LOCKW: { label: 'Blocked on a lock', tone: 'warning' },
  GSETW: { label: 'Blocked on global buffers', tone: 'warning' },
  GGETW: { label: 'Blocked on global buffers', tone: 'warning' },
  GCOMW: { label: 'Blocked on global buffers', tone: 'warning' },
  JRNW: { label: 'Blocked on the journal', tone: 'warning' },
};
const stateOf = (code: string): { label: string; tone: Tone } => STATES[code] ?? { label: code, tone: 'neutral' };
const stateHint = (code: string): string =>
  code === 'HANGW' ? 'State code HANGW: pausing on a HANG command, which is intentional' : `State code ${code}`;
const isSystem = (p: Process): boolean => p.Username === '';
const userLabel = (u: string): string => (u === 'UnknownUser' ? 'Unauthenticated' : u);

/** CPU time in one unit (seconds), so the column compares at a glance. */
function cpu(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—';
}

const COLUMNS: DataGridColumn[] = [
  { key: 'Pid', label: 'PID', width: '72px', sortable: true, align: 'right', renderCell: (v) => cell.mono(v, true) },
  { key: 'Routine', label: 'Current routine', width: '240px', sortable: true, renderCell: (v) => cell.mono(middle(String(v || '—'), 32), false, String(v)) },
  { key: 'Username', label: 'User', width: '130px', sortable: true, renderCell: (v) => (!v ? cell.dim('System') : v === 'UnknownUser' ? cell.dim('Unauthenticated') : cell.text(v)) },
  { key: 'State', label: 'State', width: '180px', sortable: true, renderCell: (v) => { const s = stateOf(String(v)); return chip(s.label, s.tone, stateHint(String(v))); } },
  { key: 'Nspace', label: 'Namespace', width: '110px', sortable: true, renderCell: (v) => (v ? cell.mono(v) : cell.dim('—')) },
  { key: 'Client', label: 'Client', width: '130px', sortable: true, renderCell: (v) => (v ? cell.text(v) : cell.dim('—')) },
  { key: 'Commands', label: 'Commands', width: '96px', sortable: true, align: 'right', renderCell: (v) => cell.num(compact(Number(v)), Number(v).toLocaleString()) },
  { key: 'Globals', label: 'Global refs', width: '96px', sortable: true, align: 'right', renderCell: (v) => cell.num(compact(Number(v)), Number(v).toLocaleString()) },
  { key: 'CpuNow', label: 'CPU %', width: '72px', sortable: true, align: 'right',
    renderCell: (v) => (v === null || v === undefined || Number(v) < 0 ? cell.dim('…') : Number(v) < 0.1 ? cell.dim('–') : cell.num(Number(v).toFixed(1))) },
  { key: 'CPUTime', label: 'CPU time', width: '88px', sortable: true, align: 'right', renderCell: (v) => cell.num(cpu(Number(v))) },
  { key: 'Elapsed', label: 'Running for', width: '100px', sortable: true, align: 'right', renderCell: (_v, row) => cell.num(elapsed(String(row.ElapsedTime))) },
];
/** Columns that step aside while the detail panel is open. */
const SECONDARY = ['Nspace', 'Client', 'Globals'];

/** cpuNow: % of one core since the previous poll; -1 until there is one. */
function toRow(p: Process, cpuNow: number): DataGridRow {
  const [h, m, s] = p.ElapsedTime.split(':').map(Number);
  return {
    Pid: p.Pid, Routine: p.Routine, Nspace: p.Nspace, Username: p.Username,
    Client: p.ClientName || p.IPAddress, State: p.State, Commands: p.Commands,
    Globals: p.Globals, CpuNow: cpuNow, CPUTime: p.CPUTime, ElapsedTime: p.ElapsedTime,
    Elapsed: h * 3600 + m * 60 + s, // numeric so the column sorts by time
  };
}

type Scope = 'all' | 'user' | 'system';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

export function processesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row">
      <div class="search-box"><ev-search id="proc-search" size="sm" full-width placeholder="Filter by routine, user, namespace or PID"></ev-search></div>
      <ev-segmented-button id="proc-scope" size="sm"></ev-segmented-button>
      <span id="proc-blocked"></span>
    </div>
    <ev-detail-panel id="proc-panel" detail-width="340" class="workspace">
      <div class="grid-wrap" id="proc-grid-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="proc-detail"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="proc-foot"></p>`;

  const scopeEl = ctx.body.querySelector('#proc-scope') as HTMLElement & { options: unknown; value: string };
  scopeEl.value = 'all';
  const panel = ctx.body.querySelector('#proc-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#proc-grid-wrap') as HTMLElement;
  let grid: GridEl | null = null;
  let all: Process[] = [];
  let query = '';
  let scope: Scope = 'all';
  let selected: number | null = null;
  // CPU now: CPU time used between the last two polls, as % of one core.
  let prevCpu: { at: number; byPid: Map<number, number> } | null = null;
  let cpuNow = new Map<number, number>();

  const inScope = (p: Process, s: Scope): boolean => s === 'all' || (s === 'user' ? !isSystem(p) : isSystem(p));
  const visible = (): Process[] => all.filter((p) => {
    if (!inScope(p, scope)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [p.Routine, p.Username, userLabel(p.Username), p.Nspace, String(p.Pid), p.ClientName, p.IPAddress].some((f) => f?.toLowerCase().includes(q));
  });

  const renderToolbar = (): void => {
    const n = (s: Scope): number => all.filter((p) => inScope(p, s)).length;
    scopeEl.options = [
      { value: 'all', label: `All ${n('all')}` },
      { value: 'user', label: `User ${n('user')}` },
      { value: 'system', label: `System ${n('system')}` },
    ];
    const blocked = all.filter((p) => stateOf(p.State).tone === 'warning').length;
    (ctx.body.querySelector('#proc-blocked') as HTMLElement).innerHTML = blocked ? chip(`${blocked} blocked`, 'warning', 'Waiting on locks, global buffers or the journal') : '';
  };

  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    for (const key of SECONDARY) grid?.setColumnVisible(key, !open);
  };

  const renderDetail = (): void => {
    const el = ctx.body.querySelector('#proc-detail') as HTMLElement;
    const p = all.find((x) => x.Pid === selected);
    if (!p) { setPanel(false); return; }
    const s = stateOf(p.State);
    const kv = (k: string, v: string): string => `<div class="kv"><dt>${k}</dt><dd>${v}</dd></div>`;
    const action = (label: string, allowed: boolean, danger = false): string => allowed
      ? `<button type="button" class="btn btn--sm btn--locked${danger ? ' btn--danger' : ''}" disabled title="Sign in to manage processes"><ev-icon name="key-round" size="xs"></ev-icon>${label}</button>` : '';
    const actions = [action('Suspend', p.CanBeSuspended), action('Send message', p.CanReceiveBroadcast), action('Terminate…', p.CanBeTerminated, true)].join('');
    el.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">Process ${esc(p.Pid)}</span><h2 class="mono" title="${esc(p.Routine)}">${esc(p.Routine || '(no routine)')}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="proc-close"></ev-icon-button>
      </header>
      <div class="detail-state">${chip(s.label, s.tone, stateHint(p.State))}<span class="dim">for ${esc(elapsed(p.ElapsedTime))}</span></div>
      ${actions ? `<div class="detail-actions">${actions}</div><p class="detail-note">Actions become available once you sign in.</p>` : ''}
      <h3 class="detail-section">Identity</h3>
      <dl class="kv-list">
        ${kv('User', p.Username ? esc(userLabel(p.Username)) : '<span class="dim">System process</span>')}
        ${kv('OS user', esc(p.OSUserName || '—'))}
        ${kv('Namespace', p.Nspace ? `<span class="mono">${esc(p.Nspace)}</span>` : '—')}
        ${kv('Client', esc(p.ClientName || '—'))}
        ${kv('IP address', p.IPAddress ? `<span class="mono">${esc(p.IPAddress)}</span>` : '—')}
        ${kv('Executable', esc(p.EXEname || '—'))}
        ${kv('Device', p.Device ? `<span class="mono">${esc(p.Device)}</span>` : '—')}
        ${kv('Job · parent PID', `<span class="mono">${esc(p.Job)} · ${p.ParentPid ? esc(p.ParentPid) : '—'}</span>`)}
      </dl>
      <h3 class="detail-section">Activity</h3>
      <dl class="kv-list">
        ${kv('Commands run', p.Commands.toLocaleString())}
        ${kv('Global references', p.Globals.toLocaleString())}
        ${kv('Private global blocks', p.PrvGblBlkCnt.toLocaleString())}
        ${kv('CPU now', cpuNow.has(p.Pid) && (cpuNow.get(p.Pid) ?? -1) >= 0 ? `${(cpuNow.get(p.Pid) ?? 0).toFixed(1)}% of a core` : 'Measuring…')}
        ${kv('CPU time', cpu(p.CPUTime))}
      </dl>`;
    // Long values (devices, executables) truncate; the full text is one hover away.
    el.querySelectorAll<HTMLElement>('.kv dd').forEach((dd) => { dd.title = dd.textContent?.trim() ?? ''; });
    el.querySelector('#proc-close')?.addEventListener('click', () => { selected = null; grid?.select([]); setPanel(false); });
    setPanel(true);
  };

  const renderGrid = (): void => {
    const rows = visible().map((p) => toRow(p, cpuNow.get(p.Pid) ?? -1));
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Pid');
      grid.setAttribute('sort-column', 'Commands');
      grid.setAttribute('sort-direction', 'desc');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        selected = Number((e as CustomEvent<{ row: DataGridRow }>).detail.row.Pid);
        renderDetail();
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    if (selected !== null) grid.select([String(selected)]);
    wrap.querySelector('.grid-empty')?.remove();
    if (rows.length === 0) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">No processes match “${esc(query)}”.</div>`);
  };

  let systemCpu = NaN;
  const renderFoot = (): void => {
    const known = [...cpuNow.values()].filter((v) => v >= 0);
    const iris = known.reduce((a, v) => a + v, 0);
    (ctx.body.querySelector('#proc-foot') as HTMLElement).innerHTML = known.length
      ? `IRIS processes together: <b>${iris.toFixed(1)}%</b> of one core<span class="meta-sep">·</span>System CPU <b>${Number.isFinite(systemCpu) ? Math.round(systemCpu) : '—'}%</b> across the whole machine`
      : 'Measuring CPU use…';
  };
  ctx.onLeave(metrics.subscribe((snap) => { systemCpu = value(snap, 'iris_cpu_usage'); renderFoot(); }));

  const updated = liveIndicator(ctx, () => void load());
  const load = async (): Promise<void> => {
    try {
      all = await getProcesses();
      const at = performance.now();
      if (prevCpu) {
        const secs = (at - prevCpu.at) / 1000;
        const prev = prevCpu.byPid;
        cpuNow = new Map(all.map((p) => [p.Pid, prev.has(p.Pid) ? Math.max(0, ((p.CPUTime - (prev.get(p.Pid) ?? 0)) / 1000 / secs) * 100) : -1]));
      }
      prevCpu = { at, byPid: new Map(all.map((p) => [p.Pid, p.CPUTime])) };
      updated(new Date());
      renderToolbar();
      renderGrid();
      renderFoot();
      if (selected !== null) renderDetail();
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-proc');
      wrap.querySelector('#retry-proc')?.addEventListener('click', () => void load());
    }
  };

  ctx.body.querySelector('#proc-search')?.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => {
    scope = (e as CustomEvent<{ value: Scope }>).detail.value;
    renderGrid();
  });

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
