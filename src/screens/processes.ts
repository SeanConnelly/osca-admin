// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Processes — every IRIS process, filterable, with a detail panel
 * for the one you select: what it is doing now, its live activity, who it runs
 * as, what it holds, and its variables (masked). The panel also suspends,
 * resumes, messages and terminates processes (needs the operator privilege).
 */
import { get, getProcesses, type Process } from '../api';
import { linkTo } from '../api-security';
import { metrics, value } from '../metrics';
import { getLocks, type LockRow } from '../api-ops';
import {
  mono,
  noPermissionText,
  esc, compact, elapsed, when, chip, status, cell, cellId, cellRef, middle, exportButton, gridExport, skeleton, errorPanel, emptyState, liveIndicator, sparkline, pruneColumns,
  objectDetail, odMeta, odSection, type OdFull, type GridColumn, type ScreenCtx, type Tone,
} from '../ui';
import '../styles-proc.css';
import {
  AdminError, confirm, editorShell, errorText, readForm, section,
  textareaField, toast, writeJson, type MenuItem,
} from '../crud';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';
import { apiAvailable, getClassShape, type ClassProp, type ClassShape } from '../api-osca';

const REFRESH_MS = 5000;

/** The single-process read: the fields the terminate confirmation needs. */
interface ProcessDetail {
  Pid: number;
  Routine: string;
  CurrentLineAndRoutine: string;
  InTransaction: number;
  NameSpace: string;
  UserName: string;
  CSPSessionID: string;
  CanBeTerminated: boolean;
  CanBeSuspended: boolean;
  State: string;
}
const getProcess = (pid: number): Promise<ProcessDetail> => get(`/process?id=${pid}`);
const processAction = (verb: 'suspend' | 'resume' | 'terminate', pid: number): Promise<unknown> =>
  writeJson('POST', `/process/${verb}?id=${pid}`);
const sendMessage = (pid: number, message: string): Promise<unknown> =>
  writeJson('POST', '/process/broadcast', { Message: message, PidList: [pid] });

/** Everything the single-process read returns that the detail panel shows. */
interface ProcessFull extends ProcessDetail {
  CurrentSrcLine: string;
  LastGlobalReference: string;
  LoginRoles: string[];
  Roles: string[];
  EscalatedRoles: string[];
  MemoryAllocated: number; // KB; 2147483646 means no limit
  MemoryUsed: number;      // KB
  MemoryPeak: number;      // KB
  OpenDevices: string[];
  CurrentDevice: string;
  PrincipalDevice: string;
  CommandsExecuted: number;
  GlobalReferences: number;
  GlobalUpdates: number;
  GlobalDiskReads: number;
  JournalEntries: number;
  PrivateGlobalReferences: number;
  PrivateGlobalUpdates: number;
  CPUTime: number;         // ms
  StartTimeUTC: string;    // "YYYY-MM-DD HH:MM:SS", UTC
  ClientNodeName: string;
  ClientIPAddress: string;
  ClientExecutableName: string;
  Variables: Array<{ Name: string; Value: unknown }>;
}
const getProcessFull = (pid: number): Promise<ProcessFull> => get(`/process?id=${pid}`);

type RateKey = 'cpu' | 'refs' | 'upd' | 'jrn';
const RATE_KEYS: RateKey[] = ['cpu', 'refs', 'upd', 'jrn'];
/** Rate history kept per process: 36 reads, 3 minutes at one read every 5 s. */
const SERIES_MAX = 36;
const RATE_LABEL: Record<RateKey, string> = { cpu: 'CPU', refs: 'Global refs', upd: 'Global updates', jrn: 'Journal entries' };

const NO_OPERATE = noPermissionText('%Admin_Operate', 'system operation');

/**
 * What kind of IRIS-owned process this is, if any: these need the PID typed
 * before they're terminated.
 *  - core: daemons with no user (IRIS mostly refuses to stop these anyway);
 *  - web: Web Gateway server processes, which also serve this portal;
 *  - service: other IRIS background services (task manager, work queues…).
 */
function systemKind(p: Process): 'core' | 'web' | 'service' | null {
  if (!p.Username) return 'core';
  if (/^%SYS\.cspServer/i.test(p.Routine)) return 'web';
  if (/^%?SYS\./i.test(p.Routine)) return 'service';
  return null;
}
/** Why Suspend (and maybe Terminate) isn't offered, as one muted line under the action row; '' when both are. */
function actionNote(p: Process): string {
  if (isSuspended(p.State) || (p.CanBeSuspended && p.CanBeTerminated)) return '';
  const both = !p.CanBeSuspended && !p.CanBeTerminated;
  const what = both ? 'suspended or stopped' : !p.CanBeSuspended ? 'suspended' : 'stopped';
  if (systemKind(p) === 'core') return `IRIS needs this process to run, so it can’t be ${what}.`;
  return `IRIS doesn’t allow this process to be ${what}.`;
}
/**
 * The process answering this portal's own request. Requests are picked up by whichever web server
 * process is free, so this is decided from each read on its own and never carried forward:
 *  - a list read: the row running the process-list class query (a %SYS.sqlcq… routine) at that
 *    moment, which IRIS won't let anyone suspend or stop;
 *  - a detail read: its current line is in %SYS.ProcessQuery, or its variables come back as
 *    "Cannot examine your own process".
 */
const SERVING_TIP = 'Serves this page’s process list. IRIS won’t suspend or stop it while it runs.';
function isServing(p: { Routine: string; State: string; CanBeSuspended: boolean; CanBeTerminated: boolean; Username: string }): boolean {
  return !!p.Username && !p.CanBeSuspended && !p.CanBeTerminated && p.Routine.startsWith('%SYS.sqlcq.') && parseState(p.State).base === 'RUN';
}
const servingNow = (d: { CurrentLineAndRoutine: string; Variables?: Array<{ Name: string }> }): boolean =>
  d.CurrentLineAndRoutine.includes('%SYS.ProcessQuery') || (varsUnavailable(d.Variables) && /own process/i.test(d.Variables?.[0]?.Name ?? ''));
/** Process state: normal states (running, waiting, sleeping) read as dot + word; problems stay pills. */
const stateMark = (label: string, tone: Tone, title: string): string =>
  tone === 'neutral' || tone === 'success' ? status(label, tone, title) : chip(label, tone, title);
const servingChip = (): string => chip('Serving this page', 'neutral', SERVING_TIP);
/** The variables read failed: IRIS returns one row carrying the reason instead of variables. */
const varsUnavailable = (vars: Array<{ Name: string }> | null | undefined): boolean =>
  !!vars && vars.length === 1 && /^(cannot|unable|error)/i.test(vars[0].Name);
/** The process is answering this portal's own request right now. */
const servingPortal = (d: ProcessDetail): boolean => /%SYS\.ProcessQuery|%Api\.Admin\./.test(d.CurrentLineAndRoutine);

/**
 * IRIS's own processes, by routine: what each does, what stopping it costs,
 * and what it is waiting for when it's idle.
 */
interface KnownProcess { re: RegExp; name: string; does: string; ifStopped: string; idle?: string }
const KNOWN: KnownProcess[] = [
  { re: /^%SYS\.TaskSuper\b/i, name: 'the Task Manager', does: 'It starts scheduled tasks on time.', ifStopped: 'Scheduled tasks won’t run until IRIS restarts.' },
  { re: /^%SYS\.WorkQueueMgr\b/i, name: 'a work queue worker', does: 'It runs work handed to IRIS work queues, such as parallel SQL queries and background jobs.', ifStopped: 'Work it is running fails. IRIS normally starts another worker when one is needed.' },
  { re: /^%SYS\.cspServer/i, name: 'a Web Gateway server process', does: 'It serves web pages and REST calls, including this portal’s.', ifStopped: 'A request it’s in the middle of fails; the Web Gateway starts another server process when it needs one.' },
  { re: /^%SYS\.SERVER\b/i, name: 'the superserver', does: 'It accepts every incoming connection: the Web Gateway, SQL, and terminal and IDE clients.', ifStopped: 'New connections fail until IRIS restarts.' },
  { re: /^%SYS\.Monitor\.Control\b/i, name: 'the System Monitor', does: 'It runs the health checks and sensors behind alerts and the system health state.', ifStopped: 'Health checks and alerts stop until IRIS restarts.' },
  { re: /^SYS\.VSSWriter\b/i, name: 'the Windows backup (VSS) writer', does: 'It lets Windows backups take consistent snapshots of the databases.', ifStopped: 'Windows snapshot backups won’t be consistent until IRIS restarts.' },
  { re: /^CONTROL$/, name: 'the control process', does: 'It coordinates the rest of IRIS.', ifStopped: 'IRIS stops working.', idle: 'Waiting for control requests' },
  { re: /^WRTDMN$/, name: 'the write daemon', does: 'It writes changed database blocks from memory to disk.', ifStopped: 'Changes stop reaching the databases on disk.', idle: 'Waiting for the next write cycle' },
  { re: /^JRNDMN$/, name: 'the journal daemon', does: 'It writes the journal, which transaction rollback, crash recovery and mirroring depend on.', ifStopped: 'Journaling stops, which puts recovery at risk.', idle: 'Waiting for journal entries to write' },
  { re: /^GARCOL$/, name: 'the garbage collector', does: 'It frees the space left behind by deleted globals.', ifStopped: 'Space from deleted globals isn’t reclaimed until IRIS restarts.', idle: 'Waiting for deleted globals to clean up' },
  { re: /^EXPDMN$/, name: 'the expansion daemon', does: 'It grows databases when they need more space.', ifStopped: 'Writes that need a database to grow will wait.', idle: 'Waiting for a database to grow' },
  { re: /^CLNDMN$/, name: 'the clean daemon', does: 'It cleans up after processes that end abnormally, releasing their locks and rolling back their transactions.', ifStopped: 'Locks and transactions of processes that die are left behind.', idle: 'Waiting for a process to clean up' },
  { re: /^MONITOR$/, name: 'the IRIS monitor', does: 'It watches the messages log and raises alerts for serious errors.', ifStopped: 'Alerts for serious errors stop until IRIS restarts.' },
  { re: /^LMFMON$/, name: 'the license monitor', does: 'It keeps track of license use.', ifStopped: 'License use stops being tracked until IRIS restarts.' },
];
const knownProcess = (routine: string): KnownProcess | undefined => KNOWN.find((k) => k.re.test(routine));

/**
 * Process states, all mapped here. A state is a base (RUN, HANG, EVT…) plus
 * flags (W hibernating, GW global wait, S suspension requested, D dead…),
 * so HANG, HANGW or HANGS all read "Sleeping". The code stays in the tooltip.
 */
const STATE_BASES = ['LOCK', 'OPEN', 'CLOS', 'USE', 'READ', 'WRT', 'GET', 'GSET', 'GKLL', 'GORD', 'GQRY', 'GDEF', 'ZF', 'HANG', 'JOB', 'EXAM',
  'BRD', 'SUSP', 'INCR', 'BSET', 'BGET', 'EVT', 'SLCT', 'SEM', 'IPQ', 'DEQ', 'VSET', 'VKLL', 'RUN'].sort((a, b) => b.length - a.length);
const STATE_FLAGS = ['NL', 'DT', 'GW', 'NR', 'NH', 'S', 'D', 'H', 'N', 'W'];
const GLOBAL_BASES = new Set(['GET', 'GSET', 'GKLL', 'GORD', 'GQRY', 'GDEF', 'INCR', 'BSET', 'BGET', 'VSET', 'VKLL']);
const BASE_LABELS: Record<string, string> = {
  LOCK: 'Taking a lock', OPEN: 'Opening a device', CLOS: 'Closing a device', USE: 'Switching device', READ: 'Waiting for input',
  WRT: 'Writing output', GET: 'Reading a global', GSET: 'Writing a global', GKLL: 'Deleting a global', GORD: 'Reading globals',
  GQRY: 'Reading globals', GDEF: 'Reading globals', INCR: 'Incrementing a global', BSET: 'Writing a global', BGET: 'Reading a global',
  VSET: 'Writing a global', VKLL: 'Deleting a global', ZF: 'In an external call', HANG: 'Sleeping', JOB: 'Starting a job',
  EXAM: 'Being examined', BRD: 'Sending a message', SUSP: 'Suspended', EVT: 'Waiting for an event', SLCT: 'Waiting on a socket',
  SEM: 'Waiting on a semaphore', IPQ: 'Waiting on a queue', DEQ: 'Waiting on a queue', RUN: 'Running',
};
/** Codes seen on older versions that don't split cleanly into base + flags. */
const LEGACY_STATES: Record<string, { label: string; tone: Tone }> = {
  GGETW: { label: 'Blocked on global buffers', tone: 'warning' },
  GCOMW: { label: 'Blocked on global buffers', tone: 'warning' },
  JRNW: { label: 'Blocked on the journal', tone: 'warning' },
};

function parseState(code: string): { base: string; flags: Set<string> } {
  const base = STATE_BASES.find((b) => code.startsWith(b)) ?? '';
  const flags = new Set<string>();
  let rest = code.slice(base.length);
  while (rest) {
    const f = STATE_FLAGS.find((x) => rest.startsWith(x));
    if (!f) break;
    flags.add(f);
    rest = rest.slice(f.length);
  }
  return { base, flags };
}

function stateOf(code: string, routine = ''): { label: string; tone: Tone } {
  if (LEGACY_STATES[code]) return LEGACY_STATES[code];
  const { base, flags } = parseState(code);
  if (!base) return { label: code, tone: 'neutral' };
  if (flags.has('DT')) return { label: 'Ended with an open transaction', tone: 'danger' };
  if (flags.has('D')) return { label: 'Ended; being cleaned up', tone: 'warning' };
  if (flags.has('H')) return { label: 'Halting', tone: 'neutral' };
  if (base === 'SUSP') return { label: 'Suspended', tone: 'warning' };
  if (flags.has('S')) return { label: 'Being suspended', tone: 'warning' };
  if (flags.has('GW')) return { label: 'Waiting for global buffers', tone: 'warning' };
  if (flags.has('NL')) return { label: 'Waiting on a network lock', tone: 'warning' };
  if (base === 'HANG') return { label: 'Sleeping', tone: 'neutral' }; // ObjectScript HANG n: a deliberate pause, not a hung process
  if (base === 'LOCK' && flags.has('W')) return { label: 'Blocked on a lock', tone: 'warning' };
  if (GLOBAL_BASES.has(base) && flags.has('W')) return { label: 'Blocked on global buffers', tone: 'warning' };
  if (base === 'RUN') return flags.has('W') ? { label: knownProcess(routine)?.idle ?? 'Idle', tone: 'neutral' } : { label: 'Running', tone: 'success' };
  return { label: BASE_LABELS[base] ?? code, tone: 'neutral' };
}
const stateHint = (code: string): string =>
  parseState(code).base === 'HANG' ? `State code ${code}: pausing on a HANG command, which is intentional` : `State code ${code}`;
const isSuspended = (state: string): boolean => parseState(state).base === 'SUSP';
const isSystem = (p: Process): boolean => p.Username === '';
/** The account a process runs as, as IRIS names it; anonymous work runs as UnknownUser. */
const userLabel = (u: string): string => (u === 'Unauthenticated' ? 'UnknownUser' : u);
const ANON = 'UnknownUser';

/** CPU time in one unit (seconds), so the column compares at a glance. */
function cpu(ms: number): string {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '—';
}

/** A muted cell value with a tooltip saying what it means. */
const dimTip = (text: string, title: string): string =>
  `<span style="white-space:nowrap;color:var(--ev-color-text-tertiary)" title="${esc(title)}">${esc(text)}</span>`;

const COLUMNS: GridColumn[] = [
  { key: 'Pid', label: 'PID', width: '72px', sortable: true, align: 'right', renderCell: (v) => cell.num(String(v)) },
  { key: 'Routine', label: 'Current routine', description: 'What the process is running right now, not what it started with', width: '240px', sortable: true, renderCell: (v) => cellId(middle(String(v || '—'), 32), String(v)) },
  { key: 'Username', label: 'User', width: '130px', sortable: true, renderCell: (v) => (!v ? cell.dim('System') : cell.text(userLabel(String(v)))) },
  { key: 'State', label: 'State', description: 'What the process is doing. Sleeping (HANG) is a deliberate wait, not a problem', width: '168px', sortable: true, renderCell: (v, row) => { const s = stateOf(String(v), String(row.Routine ?? '')); return stateMark(s.label, s.tone, row.Serving ? `${stateHint(String(v))}. Serving this page: ${SERVING_TIP}` : stateHint(String(v))); } },
  { key: 'Nspace', label: 'Namespace', width: '110px', sortable: true, renderCell: (v) => (v ? cellRef(v) : cell.dim('—')) },
  { key: 'Commands', label: 'Commands', description: 'ObjectScript commands run since the process started', width: '96px', sortable: true, align: 'right', renderCell: (v) => cell.num(compact(Number(v)), Number(v).toLocaleString()) },
  { key: 'Globals', label: 'Global refs', description: 'Database reads and writes (global references) since the process started', width: '96px', sortable: true, align: 'right', renderCell: (v) => cell.num(compact(Number(v)), Number(v).toLocaleString()) },
  { key: 'CpuNow', label: 'CPU %', description: 'CPU used over the last five seconds, as a share of one core', width: '72px', sortable: true, align: 'right',
    // Idle and not-yet-sampled cells stay blank (a column of dashes is noise); only real use shows a figure.
    renderCell: (v) => (v === null || v === undefined || Number(v) < 0 ? dimTip('', `Needs two samples, about ${REFRESH_MS / 1000} s`)
      : Number(v) < 0.1 ? dimTip('', 'Under 0.1% of one core') : cell.num(Number(v).toFixed(1))) },
  { key: 'Elapsed', label: 'Running for', description: 'How long ago the process started', width: '100px', sortable: true, align: 'right', renderCell: (_v, row) => cell.num(elapsed(String(row.ElapsedTime))) },
];
/** Client and total CPU time live in the detail only (the list stays within 1100px). Columns that step aside while the detail panel is open (CPU figures and age are in the panel), so none is clipped. */
const SECONDARY = ['Nspace', 'Globals', 'CpuNow', 'Elapsed'];

/** cpuNow: % of one core since the previous poll; -1 until there is one. */
function toRow(p: Process, cpuNow: number): DataGridRow {
  const [h, m, s] = p.ElapsedTime.split(':').map(Number);
  return {
    Pid: p.Pid, Routine: p.Routine, Nspace: p.Nspace, Username: p.Username,
    Client: p.ClientName || p.IPAddress, State: p.State, Commands: p.Commands,
    Globals: p.Globals, CpuNow: cpuNow, CPUTime: p.CPUTime, ElapsedTime: p.ElapsedTime,
    Elapsed: h * 3600 + m * 60 + s, // numeric so the column sorts by time
    Serving: isServing(p),
  };
}

/* ───────────── Variables as a tree ─────────────
 * The detail read returns flat rows: x, x(1), x(1,"a"). They become a tree: a variable with subscripted
 * nodes expands to them, level by level. Only names are ever used as keys or attributes; values stay in
 * the process read (dv) and are rendered as text, masked unless revealed. */

interface VarNode {
  /** Stable key: the node's own name, e.g. `x(1,"a")` (plus " (private)" for private variables). */
  id: string;
  /** What the row shows: the variable name at the top, the last subscript below it. */
  label: string;
  /** The raw name IRIS gave, when this node has a value of its own (reveal / copy key). */
  raw: string | null;
  tag: string;
  kids: VarNode[];
}

/** Split `a,"b,c",$lb(1,2)` at top-level commas, keeping quoted strings and nested parentheses whole. */
function splitSubscripts(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let q = false; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') q = !q; // a doubled quote inside a string toggles twice: still inside
    else if (!q && ch === '(') depth++;
    else if (!q && ch === ')') depth--;
    else if (!q && depth === 0 && ch === ',') { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}
/** `Errors(1,"a") (private)` → base `Errors`, subscripts `1`, `"a"`, tag `private`. */
function parseVarName(raw: string): { base: string; subs: string[]; tag: string } {
  const m = /^(.*?)[ ]*[(]private[)]$/i.exec(raw);
  const name = m ? m[1] : raw;
  const tag = m ? 'private' : '';
  const open = name.indexOf('(');
  if (open <= 0 || !name.endsWith(')')) return { base: name, subs: [], tag };
  return { base: name.slice(0, open), subs: splitSubscripts(name.slice(open + 1, -1)), tag };
}
/** The flat rows as a tree, in the order IRIS returned them. */
function varTree(vars: Array<{ Name: string }>): VarNode[] {
  const roots: VarNode[] = [];
  const byId = new Map<string, VarNode>();
  for (const v of vars) {
    const { base, subs, tag } = parseVarName(v.Name);
    const suffix = tag ? ' (private)' : '';
    let parent: VarNode | null = null;
    for (let depth = 0; depth <= subs.length; depth++) {
      const id = `${depth ? `${base}(${subs.slice(0, depth).join(',')})` : base}${suffix}`;
      let node = byId.get(id);
      if (!node) {
        node = { id, label: depth ? subs[depth - 1] : base, raw: null, tag: depth ? '' : tag, kids: [] };
        byId.set(id, node);
        (parent ? parent.kids : roots).push(node);
      }
      if (depth === subs.length) node.raw = v.Name;
      parent = node;
    }
  }
  return roots;
}

/* ───────────── Objects: the class behind an object reference ─────────────
 * `1@%CSP.Request` is an object; its class's structure (property names and types, never values) comes from
 * the OSCA API when it is installed. */

let oscaUp: boolean | null = null; // null: not asked yet
const shapes = new Map<string, Promise<ClassShape | null>>(); // per session, by namespace and class
function classShape(cls: string, ns: string): Promise<ClassShape | null> {
  const key = `${ns.toUpperCase()}|${cls}`;
  let p = shapes.get(key);
  if (!p) {
    p = getClassShape(cls, ns).catch(() => null);
    shapes.set(key, p);
    void p.then((v) => { if (!v) shapes.delete(key); }); // a failure can be retried
  }
  return p;
}
const OREF = /^\d+@([%\w.]+)$/;
/** A class worth opening: not a datatype (%String, %Library.Integer…). */
const isObjectType = (t: string): boolean => !!t && !/^%(Library\.)?[A-Za-z]+$/.test(t) && !/^%Library\./.test(t);
const typeText = (p: ClassProp): string => (p.collection ? `${p.collection} of ${p.type}` : p.type) + (p.relationship ? ' · relationship' : '') + (p.calculated ? ' · calculated' : '');

type Scope = 'all' | 'user' | 'system';

type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[]; sortColumn: string; sortDirection: string;
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

export function processesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  // Two levels through objectDetail(): the list with a peek, and a full view of one process (#/operations/processes/<pid>).
  ctx.body.innerHTML = `
    <div class="proc-list-view" id="proc-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="proc-search" size="sm" full-width placeholder="Filter by routine, user, namespace or PID"></ev-search></div>
        <ev-segmented-button id="proc-scope" size="sm"></ev-segmented-button>
        <span id="proc-blocked"></span>
        <span id="proc-export-slot" hidden></span>
      </div>
      <ev-detail-panel id="proc-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="proc-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="proc-detail"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="proc-foot"></p>
    </div>
    <div id="proc-full" hidden></div>`;
  const listView = ctx.body.querySelector('#proc-list-view') as HTMLElement;
  // Export: the process list as shown (visible columns, current sort). Only list columns: no variables.
  { const slot = ctx.body.querySelector('#proc-export-slot') as HTMLElement; slot.replaceWith(exportButton(() => gridExport(ctx.body.querySelector('#proc-list-view ev-data-grid'), 'processes'))); }
  const fullEl = ctx.body.querySelector('#proc-full') as HTMLElement;

  const scopeEl = ctx.body.querySelector('#proc-scope') as HTMLElement & { options: unknown; value: string };
  scopeEl.value = 'all';
  const panel = ctx.body.querySelector('#proc-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#proc-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#proc-detail') as HTMLElement;
  let grid: GridEl | null = null;
  let all: Process[] = [];
  let query = '';
  let scope: Scope = 'all';
  /** The process shown in the peek or the full view (objectDetail owns which; this mirrors it). */
  let selected: number | null = null;
  // CPU now: CPU time used between the last two polls, as % of one core.
  let prevCpu: { at: number; byPid: Map<number, number> } | null = null;
  let cpuNow = new Map<number, number>();
  // Actions: the operator privilege, an in-flight action, and the Send message form (while it's open, polls leave the detail alone).
  let canOperate = true;
  let busy = false;
  let editor: ReturnType<typeof editorShell> | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; };
  ctx.onLeave(() => leaveEdit());

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
    const blocked = all.filter((p) => stateOf(p.State, p.Routine).tone === 'warning').length;
    (ctx.body.querySelector('#proc-blocked') as HTMLElement).innerHTML = blocked ? chip(`${blocked} blocked`, 'warning', 'Waiting on locks, global buffers or the journal') : '';
  };

  let listLoaded = false;
  /** The full view's process ended under it; the peek's process ended (its last data stays, dimmed). */
  let endedPid: number | null = null;
  let peekEnded: { pid: number; at: number } | null = null;
  /** A process the user closed after it ended: find() no longer answers for it. */
  let forgotten: number | null = null;
  let lastShown: Process | null = null;

  // Links inside the peek and the full view are delegated: parts of both are redrawn on every refresh.
  ctx.body.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (!t.closest('#proc-detail, #proc-full')) return;
    const user = t.closest<HTMLElement>('a[data-user]');
    const role = t.closest<HTMLElement>('[data-role]');
    const pidLink = t.closest<HTMLElement>('[data-pid]');
    const lock = t.closest<HTMLElement>('[data-go-locks]');
    const copy = t.closest<HTMLElement>('[data-copy-field]');
    const back = t.closest<HTMLElement>('[data-proc-back]');
    if (copy) { e.preventDefault(); copyField(copy.dataset.copyField ?? ''); return; }
    if (back) { e.preventDefault(); forgotten = selected; void od.select(null); return; }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (user) { e.preventDefault(); linkTo(ctx.navigate, 'security/users', user.dataset.user ?? ''); }
    else if (role) { e.preventDefault(); linkTo(ctx.navigate, 'security/roles', role.dataset.role ?? ''); }
    else if (pidLink) { e.preventDefault(); void od.select(String(pidLink.dataset.pid)); }
    else if (lock) { e.preventDefault(); ctx.navigate('operations/locks'); }
  });

  // ─── Live detail: one single-process read every 5 s while the peek or full view is open ───
  let dv: ProcessFull | null = null;            // the latest read of the selected process
  let dvPid: number | null = null;
  let samplesPrev: { at: number; d: ProcessFull } | null = null;
  const series: Record<RateKey, number[]> = { cpu: [], refs: [], upd: [], jrn: [] };
  /**
   * History from the list polls, per PID, so a process opened from the list has sparklines at once.
   * The list carries cumulative CPU time and global references (not updates or journal entries),
   * so only those two rows are seeded. Capped to the PIDs in the latest list and 3 minutes.
   */
  const listHistory = new Map<number, { at: number[]; cpu: number[]; refs: number[] }>();
  let prevGlobals: Map<number, number> | null = null;
  function recordListHistory(rows: Process[], at: number, secs: number, cpuMap: Map<number, number>): void {
    const live = new Set(rows.map((r) => r.Pid));
    for (const pid of [...listHistory.keys()]) if (!live.has(pid)) listHistory.delete(pid);
    if (prevGlobals && secs > 0) {
      for (const r of rows) {
        const before = prevGlobals.get(r.Pid);
        const cpuPct = cpuMap.get(r.Pid) ?? -1;
        if (before === undefined || cpuPct < 0) continue;
        const h = listHistory.get(r.Pid) ?? { at: [], cpu: [], refs: [] };
        h.at.push(at); h.cpu.push(cpuPct); h.refs.push(Math.max(0, (r.Globals - before) / secs));
        while (h.at.length > SERIES_MAX || (h.at.length && at - h.at[0] > SERIES_MAX * REFRESH_MS)) { h.at.shift(); h.cpu.shift(); h.refs.shift(); }
        listHistory.set(r.Pid, h);
      }
    }
    prevGlobals = new Map(rows.map((r) => [r.Pid, r.Globals]));
  }
  /** Start a process's series from the list's history (CPU and global refs), with its latest values shown. */
  function seedFromList(pid: number): void {
    const h = listHistory.get(pid);
    if (!h || !h.at.length) return;
    series.cpu = [...h.cpu];
    series.refs = [...h.refs];
    rates = { cpu: h.cpu[h.cpu.length - 1], refs: h.refs[h.refs.length - 1] };
  }
  let rates: Partial<Record<RateKey, number>> | null = null;
  let locks: LockRow[] | null = null;
  let tick = 0;
  // Variables: values live only in `dv` for the open process; never cached, logged, or put in titles/URLs.
  let varQuery = '';
  let revealAll = false;
  const revealed = new Set<string>();
  /** Open tree nodes (variable names and object property paths only, never values), and the row with keyboard focus. */
  const openNodes = new Set<string>();
  let focusId: string | null = null;
  let detailTimer: ReturnType<typeof setInterval> | null = null;

  const forgetValues = (): void => { varQuery = ''; revealAll = false; revealed.clear(); openNodes.clear(); focusId = null; };
  function resetDetail(): void {
    dv = null; dvPid = null; samplesPrev = null; rates = null; locks = null; tick = 0;
    for (const k of RATE_KEYS) series[k] = [];
    forgetValues();
    stopDetail();
  }
  function stopDetail(): void { if (detailTimer) { clearInterval(detailTimer); detailTimer = null; } }
  function startDetail(): void {
    if (detailTimer || selected === null || endedPid === selected || peekEnded?.pid === selected) return;
    // A hidden tab (or a window Chrome counts as covered) still gets one read, so what's opened is filled in;
    // it just doesn't keep polling until the tab is visible again.
    if (document.hidden) { if (dvPid !== selected && !detailInflight) void pollDetail(); return; }
    detailTimer = setInterval(() => void pollDetail(), REFRESH_MS);
    void pollDetail();
  }
  const isFull = (): boolean => od.mode() === 'full';
  const onVisibility = (): void => { if (document.hidden) stopDetail(); else if (isFull() || panel.open) startDetail(); };
  document.addEventListener('visibilitychange', onVisibility);
  ctx.onLeave(() => { document.removeEventListener('visibilitychange', onVisibility); stopDetail(); });

  let detailInflight = false;
  async function pollDetail(): Promise<void> {
    const pid = selected;
    if (pid === null) { stopDetail(); return; }
    detailInflight = true;
    try {
      const d = await getProcessFull(pid);
      if (selected !== pid) return;
      const at = performance.now();
      if (!samplesPrev && !series.cpu.length) seedFromList(pid);
      if (samplesPrev && samplesPrev.d.Pid === pid) {
        const secs = Math.max(0.001, (at - samplesPrev.at) / 1000);
        const prev = samplesPrev.d;
        const next: Record<RateKey, number> = {
          cpu: Math.max(0, (d.CPUTime - prev.CPUTime) / 10 / secs), // ms of CPU per second → % of one core
          refs: Math.max(0, (d.GlobalReferences - prev.GlobalReferences) / secs),
          upd: Math.max(0, (d.GlobalUpdates - prev.GlobalUpdates) / secs),
          jrn: Math.max(0, (d.JournalEntries - prev.JournalEntries) / secs),
        };
        rates = next;
        for (const k of RATE_KEYS) { series[k].push(next[k]); if (series[k].length > SERIES_MAX) series[k].shift(); }
      }
      samplesPrev = { at, d };
      dv = d; dvPid = pid;
      // Locks change less often than counters: every third read (15 s).
      if (tick++ % 3 === 0) {
        try { locks = (await getLocks()).filter((l) => l.Pid === pid); } catch { locks = null; }
        if (selected !== pid) return;
      }
      renderDetail();
    } catch (err) {
      if (selected !== pid) return;
      if (err instanceof AdminError && err.status === 404) {
        stopDetail();
        if (isFull()) showEnded(pid); else markPeekEnded(pid);
      }
    } finally {
      detailInflight = false;
    }
  }

  // ─── Header parts (objectDetail draws them) ───────────────────────────

  /** The current detail response (and only that) says this process is serving this page. */
  const servingDetail = (p: Process): boolean => dvPid === p.Pid && !!dv && servingNow(dv);
  const ended = (pid: number): boolean => endedPid === pid || peekEnded?.pid === pid;
  /** "● State · Serving this page · In a transaction · PID 4816 · for 2h 12m". */
  const metaFor = (p: Process): string => {
    if (ended(p.Pid)) return odMeta({ label: 'Ended', tone: 'neutral' }, [`PID ${p.Pid}`]);
    const s = stateOf(p.State, p.Routine);
    return odMeta({ label: s.label, tone: s.tone, title: stateHint(p.State) }, [`PID ${p.Pid}`, `for ${elapsed(p.ElapsedTime)}`], [
      servingDetail(p) ? servingChip() : '',
      dvPid === p.Pid && dv && dv.InTransaction > 0 ? chip('In a transaction', 'warning', 'Terminating it rolls back every change it hasn’t committed') : '',
    ]);
  };
  /** No visible action: Suspend…, Resume, Send message… and Terminate… all live in ⋯. */
  const menuFor = (p: Process): MenuItem[] => {
    if (ended(p.Pid)) return [];
    const why = (allowed: boolean, no: string): string | undefined => (!canOperate ? NO_OPERATE : busy ? 'Working…' : allowed ? undefined : no);
    const coreNo = systemKind(p) === 'core' ? 'IRIS needs this process to run, so it can’t be' : 'IRIS doesn’t allow this process to be';
    const suspWhy = why(p.CanBeSuspended, `${coreNo} suspended.`);
    const msgWhy = why(p.CanReceiveBroadcast, 'This process has no terminal to show a message on.');
    const termWhy = why(p.CanBeTerminated, `${coreNo} stopped.`);
    return [
      isSuspended(p.State)
        ? { label: 'Resume', icon: 'check', disabled: !!why(true, ''), reason: why(true, ''), onSelect: () => void resume(p) }
        : { label: 'Suspend…', icon: 'pause', disabled: !!suspWhy, reason: suspWhy, onSelect: () => void suspend(p) },
      { label: 'Send message…', icon: 'edit-2', disabled: !!msgWhy, reason: msgWhy, onSelect: () => openMessage(p) },
      { label: 'Terminate…', icon: 'x', danger: true, disabled: !!termWhy, reason: termWhy, onSelect: () => void terminate(p) },
    ];
  };
  /** Why an action is missing, in text (tooltips don't reach keyboard or touch users); the serving process gets its chip instead. */
  const noteFor = (p: Process): string => (ended(p.Pid) ? '' : !canOperate ? NO_OPERATE : servingDetail(p) || isServing(p) ? '' : actionNote(p));

  // ─── Body frames ──────────────────────────────────────────────────────

  const rateRow = (k: RateKey, full: boolean): string => full ? `
    <div class="pd-rate pd-rate--full" data-rate="${k}">
      <span class="pd-rate-label">${RATE_LABEL[k]}</span>
      <span class="pd-trend spark-slot"></span>
      <span class="pd-rate-cell"><span class="pd-rate-value">—</span><span class="pd-rate-peak"></span></span>
    </div>` : `
    <div class="pd-rate" data-rate="${k}">
      <span class="pd-rate-label">${RATE_LABEL[k]}</span>
      <span class="pd-trend spark-slot"></span>
      <span class="pd-rate-value">—</span>
    </div>`;
  const varTools = `
    <div class="pd-var-tools">
      <ev-search data-pd="var-search" size="sm" full-width placeholder="Filter by name" aria-label="Filter variables by name"></ev-search>
      <button type="button" class="btn btn--sm" data-pd="var-all">Show all</button>
    </div>`;
  const peekFrame = (pid: number): string => `
    <div class="pd-frame" data-pd-frame="peek:${pid}">
      <p class="pd-notice" data-pd="notice" hidden></p>
      ${odSection('Now', '<dl class="od-kv" data-pd="now"></dl>')}
      ${odSection('Activity', `<div class="pd-rates">${RATE_KEYS.map((k) => rateRow(k, false)).join('')}</div><p class="pd-totals" data-pd="totals"></p>`)}
      ${odSection('Runs as', '<dl class="od-kv" data-pd="runs"></dl>')}
      ${odSection('Holds', '<dl class="od-kv" data-pd="holds"></dl>')}
      <details class="pd-vars od-section" data-pd="var-details">
        <summary class="od-section-head" data-pd="var-summary">Variables <span class="dim" data-pd="var-count"></span></summary>
        <div data-pd="var-tools">${varTools}</div>
        <div data-pd="var-rows" class="pd-var-list"></div>
      </details>
    </div>`;
  /** Wire a frame's Variables controls once; the values are only ever re-rendered by renderVars. */
  function bindFrame(frame: HTMLElement): void {
    if (frame.dataset.pdBound) return;
    frame.dataset.pdBound = '1';
    frame.querySelector('[data-pd="var-summary"]')?.addEventListener('click', (e) => {
      if ((e.currentTarget as HTMLElement).closest('details')?.classList.contains('is-unavailable')) e.preventDefault();
    });
    frame.querySelector('[data-pd="var-search"]')?.addEventListener('ev-search-input', (e) => {
      varQuery = (e as CustomEvent<{ value: string }>).detail.value.trim().toLowerCase();
      renderVars(frame);
    });
    frame.querySelector('[data-pd="var-all"]')?.addEventListener('click', () => {
      // Straight to the values: they are shown only here, and masked again when you leave this process.
      if (revealAll) { revealAll = false; revealed.clear(); } else revealAll = true;
      renderVars(frame);
    });
    const rowsEl = frame.querySelector<HTMLElement>('[data-pd="var-rows"]');
    const toggleNode = (id: string, open?: boolean): void => {
      const want = open ?? !openNodes.has(id);
      if (want) openNodes.add(id); else openNodes.delete(id);
      focusId = id;
      renderVars(frame);
    };
    rowsEl?.addEventListener('focusin', (e) => { const r = (e.target as Element).closest<HTMLElement>('[data-var-row]'); if (r) focusId = r.dataset.varRow ?? null; });
    // Tree keys: Up/Down move, Right opens (or steps into), Left closes (or steps out to the parent).
    rowsEl?.addEventListener('keydown', (e) => {
      const rowEl = (e.target as Element).closest<HTMLElement>('[data-var-row]');
      if (!rowEl || !rowsEl) return;
      const rows = [...rowsEl.querySelectorAll<HTMLElement>('[data-var-row]')];
      const i = rows.indexOf(rowEl);
      const level = Number(rowEl.getAttribute('aria-level'));
      const expanded = rowEl.getAttribute('aria-expanded');
      const go = (r: HTMLElement | undefined): void => { if (!r) return; rows.forEach((x) => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); };
      const id = rowEl.dataset.varRow ?? '';
      if (e.key === 'ArrowDown') go(rows[i + 1]);
      else if (e.key === 'ArrowUp') go(rows[i - 1]);
      else if (e.key === 'ArrowRight') { if (expanded === 'false') toggleNode(id, true); else if (expanded === 'true') go(rows[i + 1]); else return; }
      else if (e.key === 'ArrowLeft') {
        if (expanded === 'true') toggleNode(id, false);
        else go(rows.slice(0, i).reverse().find((r) => Number(r.getAttribute('aria-level')) < level));
      } else if (e.key === 'Enter' && expanded !== null) toggleNode(id);
      else return;
      e.preventDefault();
    });
    rowsEl?.addEventListener('click', (e) => {
      const tog = (e.target as Element).closest<HTMLElement>('[data-var-toggle]');
      if (tog) { toggleNode(tog.dataset.varToggle ?? ''); return; }
      const btn = (e.target as Element).closest<HTMLElement>('[data-var-show], [data-var-copy]');
      if (!btn) return;
      const name = btn.dataset.varShow ?? btn.dataset.varCopy ?? '';
      if (btn.dataset.varShow !== undefined) {
        if (revealAll) return;
        if (revealed.has(name)) revealed.delete(name); else revealed.add(name);
        renderVars(frame);
      } else {
        const v = dv?.Variables.find((x) => x.Name === name)?.Value ?? '';
        void navigator.clipboard.writeText(String(v)).then(() => toast(`Copied the value of ${varName(name).name}.`, 'info'), () => toast('Couldn’t copy to the clipboard.', 'warning'));
      }
    });
  }
  /** The frame being shown: the peek's, or the full view's body. */
  const currentFrame = (): HTMLElement | null => (isFull()
    ? fullEl.querySelector<HTMLElement>('.od-full[data-pd-frame]')
    : detailEl.querySelector<HTMLElement>('.od-body > [data-pd-frame]'));

  /** Full view: a strip of quantities, the Activity card led by where it is, Variables; Runs as and Holds on the right. */
  const fullView = (p: Process): OdFull => ({
    strip: [
      { label: 'Namespace', value: p.Nspace || '—' },
      { label: 'Started', value: '—', title: `Running for ${elapsed(p.ElapsedTime)}` },
      { label: 'Commands', value: compact(p.Commands), title: p.Commands.toLocaleString() },
      { label: 'Global refs', value: compact(p.Globals), title: p.Globals.toLocaleString() },
    ],
    notice: '<p class="pf-note" data-pd="notice" hidden></p>',
    main: [
      { title: 'Activity', head: `<span class="card-hint">Per second · last ${Math.round((SERIES_MAX * REFRESH_MS) / 60000)} min</span>`,
        body: `<dl class="od-kv pf-where" data-pd="where"></dl><div class="pd-rates">${RATE_KEYS.map((k) => rateRow(k, true)).join('')}</div><p class="pd-totals" data-pd="totals"></p>` },
      { title: 'Variables', id: 'pf-vars-card', head: '<span class="card-hint" data-pd="var-count"></span>',
        body: `<div data-pd="var-tools">${varTools}</div>
          <div class="pf-vars">
            <div class="pd-vrow pd-vrow--full pf-var--head" data-pd="var-head" aria-hidden="true"><span></span><span>Name</span><span>Value</span></div>
            <div data-pd="var-rows" aria-label="Variables"></div>
          </div>` },
    ],
    side: [
      { title: 'Runs as', body: '<dl class="od-kv" data-pd="runs"></dl>' },
      { title: 'Holds', body: '<dl class="od-kv" data-pd="holds"></dl>' },
    ],
  });

  /** Copy a non-secret field (the last global reference) from the current read. */
  function copyField(field: string): void {
    const v = field === 'lastglobal' ? dv?.LastGlobalReference ?? '' : '';
    if (!v) return;
    void navigator.clipboard.writeText(v).then(() => toast('Copied the last global reference.', 'info'), () => toast('Couldn’t copy to the clipboard.', 'warning'));
  }

  // Not ui.ts kv: rows of the object-detail list (od-kv-row).
  const kv = (k: string, v: string, title = ''): string => `<div class="od-kv-row"><dt>${k}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${v}</dd></div>`;
  const dash = '<span class="dim">—</span>';
  const roleChips = (names: string[], tone: Tone = 'neutral', title = ''): string => names.length
    ? `<span class="pd-chips">${names.map((r) => `<button type="button" class="pd-chip-link" data-role="${esc(r)}" aria-label="Open role ${esc(r)}">${chip(r, tone, title)}</button>`).join('')}</span>`
    : dash;
  const pidLink = (pid: number): string => all.some((x) => x.Pid === pid)
    ? `<button type="button" class="link pd-pid" data-pid="${pid}">${pid}</button>`
    : esc(String(pid));
  const kb = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} MB` : `${n} KB`);
  /** One formatter for rates, used by both the value and its peak: K from 1,000 up, so they never mix styles. */
  const rateNum = (n: number): string => {
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return a > 0 && a < 10 ? n.toFixed(1).replace(/[.]0$/, '') : String(Math.round(n));
  };
  const rateText = (k: RateKey, r: number): string => (k === 'cpu' ? `${r < 10 ? r.toFixed(1) : Math.round(r)}%` : `${rateNum(r)}/s`);
  const copyBtn = (field: string, label: string): string =>
    `<button type="button" class="pd-copy" data-copy-field="${field}" aria-label="${esc(label)}" title="${esc(label)}"><ev-icon name="copy" size="xs"></ev-icon></button>`;
  /** Put a value in a strip cell in place (the strip is drawn once per open). */
  const setStripCell = (i: number, value: string, title = ''): void => {
    const c = fullEl.querySelectorAll<HTMLElement>('.od-strip .strip-cell')[i];
    const v = c?.querySelector<HTMLElement>('.strip-value > span:last-child');
    if (!c || !v) return;
    if (v.textContent !== value) v.textContent = value;
    c.title = title;
  };

  /** Everything below the header. */
  function renderBody(): void {
    const p = findP(selected);
    const frame = currentFrame();
    if (!p || !frame || editor) return;
    bindFrame(frame);
    const full = isFull();
    frame.classList.toggle('pd-frame--ended', peekEnded?.pid === p.Pid);
    const d = dvPid === p.Pid ? dv : null;
    const q = (k: string): HTMLElement | null => frame.querySelector<HTMLElement>(`[data-pd="${k}"]`);

    // A one-line notice: the process ended (peek), or why an action is missing.
    const notice = q('notice');
    if (notice) {
      if (peekEnded?.pid === p.Pid) {
        const secs = Math.max(0, Math.round((Date.now() - peekEnded.at) / 1000));
        notice.innerHTML = `Ended ${secs < 60 ? `${secs} s` : `${Math.round(secs / 60)} min`} ago <span class="meta-sep">·</span> <button type="button" class="link" data-proc-back>Back to list</button>`;
        notice.hidden = false;
      } else {
        const note = noteFor(p);
        notice.textContent = note;
        notice.hidden = !note;
      }
    }

    // Where it is: the line it's on and the last global it touched.
    const cur = d?.CurrentLineAndRoutine ?? '';
    const src = d?.CurrentSrcLine?.trim() ?? '';
    const lastGlobal = d?.LastGlobalReference ?? '';
    const started = d?.StartTimeUTC ? when(new Date(`${d.StartTimeUTC.replace(' ', 'T')}Z`)) : '';
    const lineRow = kv('Line', cur ? `<span class="mono pd-ell" title="${esc(src ? `${cur}: ${src}` : cur)}">${esc(cur)}${src ? `<span class="dim"> · ${esc(src)}</span>` : ''}</span>` : dash);
    const globalRow = `<div class="od-kv-row pd-copy-host"><dt>Last global</dt><dd>${lastGlobal ? `<span class="mono pd-ell" title="${esc(lastGlobal)}">${esc(lastGlobal)}</span>${copyBtn('lastglobal', 'Copy the last global reference')}` : dash}</dd></div>`;
    const cmds = d?.CommandsExecuted ?? p.Commands;
    const globals = d?.GlobalReferences ?? p.Globals;
    if (full) {
      (q('where') as HTMLElement).innerHTML = lineRow + globalRow;
      setStripCell(0, p.Nspace || '—');
      setStripCell(1, started || '—', `Running for ${elapsed(p.ElapsedTime)}`);
      setStripCell(2, compact(cmds), `${cmds.toLocaleString()} commands run since it started`);
      setStripCell(3, compact(globals), `${globals.toLocaleString()} global references since it started`);
    } else {
      (q('now') as HTMLElement).innerHTML = [
        lineRow,
        kv('Namespace', p.Nspace ? mono(p.Nspace) : dash),
        kv('Started', started ? esc(started) : dash, `Running for ${elapsed(p.ElapsedTime)}`),
        globalRow,
      ].join('');
    }

    // Activity: per-second rates between reads; totals (not rates) on one muted line under them.
    const totals: Record<RateKey, string> = {
      cpu: `CPU time since it started: ${cpu(d?.CPUTime ?? p.CPUTime)}`,
      refs: `Global references since it started: ${globals.toLocaleString()}`,
      upd: `Global updates since it started: ${d ? d.GlobalUpdates.toLocaleString() : '—'}`,
      jrn: `Journal entries since it started: ${d ? d.JournalEntries.toLocaleString() : '—'}`,
    };
    for (const k of RATE_KEYS) {
      const row = frame.querySelector(`[data-rate="${k}"]`) as HTMLElement;
      const r = rates?.[k];
      const values = series[k];
      const peakV = values.length ? Math.max(...values) : 0;
      const now = r === undefined ? '—' : rateText(k, r);
      const peakText = peakV > 0 && rateText(k, peakV) !== now ? `peak ${rateText(k, peakV)}` : '';
      const valueEl = row.querySelector('.pd-rate-value') as HTMLElement;
      valueEl.textContent = now;
      valueEl.title = r === undefined ? 'Needs a few samples' : '';
      const peakEl = row.querySelector('.pd-rate-peak') as HTMLElement | null;
      if (peakEl) peakEl.textContent = peakText;
      const slot = row.querySelector('.pd-trend') as HTMLElement;
      slot.innerHTML = sparkline(values, { height: full ? 28 : 20 });
      slot.title = values.length < 6 ? 'Needs a few samples' : peakText && !peakEl ? `${peakText} in the last 3 min` : '';
      row.querySelector('.pd-rate-label')?.setAttribute('title', totals[k]);
    }
    const reads = d ? d.GlobalDiskReads : null;
    const priv = d && (d.PrivateGlobalReferences || d.PrivateGlobalUpdates) ? d.PrivateGlobalReferences : null;
    const totalsEl = q('totals') as HTMLElement;
    totalsEl.textContent = [full ? '' : `${compact(cmds)} commands`, `${reads === null ? '—' : reads.toLocaleString()} disk reads`, priv === null ? '' : `${compact(priv)} private global refs`].filter(Boolean).join(' · ');
    totalsEl.title = [`${cmds.toLocaleString()} commands run`, reads === null ? '' : `${reads.toLocaleString()} global blocks read from disk`, priv === null ? '' : `${priv.toLocaleString()} private global references`].filter(Boolean).join(' · ');

    // Runs as
    const user = userLabel(d?.UserName || p.Username);
    const login = d?.LoginRoles ?? [];
    const current = d?.Roles ?? [];
    const escalated = d?.EscalatedRoles ?? [];
    const same = login.length === current.length && login.every((r) => current.includes(r));
    const children = all.filter((x) => x.ParentPid === p.Pid);
    const client = [d?.ClientNodeName || p.ClientName, d?.ClientIPAddress || p.IPAddress].filter(Boolean).join(' · ');
    (q('runs') as HTMLElement).innerHTML = [
      kv('User', user
        ? `<a class="link" href="#/security/users" data-user="${esc(user)}">${esc(user)}</a>${user === ANON ? ' <span class="dim">· no sign-in</span>' : ''}`
        : '<span class="dim">System process</span>'),
      kv('OS user', p.OSUserName ? esc(p.OSUserName) : dash),
      kv('Login roles', d ? roleChips(login) : dash),
      d && !same ? kv('Current roles', roleChips(current.filter((r) => !escalated.includes(r)))) : '',
      escalated.length ? kv('Escalated to', roleChips(escalated, 'warning', 'Escalated role: it replaces the login roles while in use')) : '',
      d?.CSPSessionID ? kv('Web session', mono(d.CSPSessionID), d.CSPSessionID) : '',
      client ? kv('Client', esc(client), [client, d?.ClientExecutableName || p.EXEname].filter(Boolean).join(' · ')) : '',
      kv('Parent', p.ParentPid ? pidLink(p.ParentPid) : dash),
      children.length ? kv(`Children (${children.length})`, `<span class="pd-chips">${children.map((c) => pidLink(c.Pid)).join('')}</span>`) : '',
    ].join('');

    // Holds
    const devs = d?.OpenDevices ?? [];
    const principal = (d?.PrincipalDevice ?? p.Device).replace(/[*]$/, '');
    const lockRows = locks ?? [];
    const unlimited = !d || d.MemoryAllocated >= 2147483646 || d.MemoryAllocated <= 0;
    const lockList = lockRows.length
      ? `<span class="pd-locks">${lockRows.slice(0, 3).map((l) => `<span class="pd-lock"><button type="button" class="link pd-lockname mono" data-go-locks title="${esc(`${l.Reference}: open Locks`)}">${esc(l.Reference)}</button>${chip(l.ModeCount, 'neutral')}</span>`).join('')}${lockRows.length > 3 ? `<button type="button" class="link" data-go-locks>+ ${lockRows.length - 3} more · View in Locks</button>` : ''}</span>`
      : '<span class="dim">None</span>';
    const deviceNames = devs.length ? devs.map((x) => x.replace(/[*]$/, '')) : principal ? [principal] : [];
    (q('holds') as HTMLElement).innerHTML = [
      // Lock names are long: stacked under the label, left-aligned, so a wrap never strands a bracket.
      lockRows.length && locks !== null
        ? `<div class="od-kv-row kv--stack pd-locks-row"><dt>Locks (${lockRows.length})</dt><dd>${lockList}</dd></div>`
        : kv('Locks', locks === null ? dash : lockList),
      kv('Devices', deviceNames.length
        ? `<span class="pd-devs">${deviceNames.map((name) => `<span class="pd-dev"><span class="mono" title="${esc(name)}">${esc(name)}</span>${name === principal ? '<span class="pd-tag">principal</span>' : ''}</span>`).join('')}</span>`
        : dash),
      kv('Memory', d ? `${kb(d.MemoryUsed)} <span class="dim">· peak ${kb(d.MemoryPeak)} · ${unlimited ? 'No limit' : `limit ${kb(d.MemoryAllocated)}`}</span>` : dash),
    ].join('');
    frame.querySelectorAll<HTMLElement>('[data-pd="runs"] .od-kv-row dd').forEach((dd) => { if (!dd.title && !dd.querySelector('button, a')) dd.title = dd.textContent?.trim() ?? ''; });
    renderVars(frame);
  }

  /** "Errors (private)" → name "Errors" + a muted "private" tag. */
  const varName = (raw: string): { name: string; tag: string } => {
    const m = /^(.*?)[ ]*[(]private[)]$/i.exec(raw);
    return m ? { name: m[1], tag: 'private' } : { name: raw, tag: '' };
  };

  /**
   * Variables, masked unless revealed. A value is only ever text in its row (never an attribute
   * or a title). An eye button at the start of the value shows or hides it; revealed values get a
   * copy button. The peek keeps values to one line; the full view wraps them.
   */
  function renderVars(frame: HTMLElement): void {
    const list = frame.querySelector('[data-pd="var-rows"]') as HTMLElement | null;
    if (!list) return;
    const full = frame.classList.contains('od-full');
    const vars = dvPid === selected ? dv?.Variables ?? null : null;
    const unavailable = varsUnavailable(vars);
    // Not available (the process serving this page): one muted line; no count, filter, header or Show all.
    const tools = frame.querySelector('[data-pd="var-tools"]') as HTMLElement | null;
    if (tools) tools.hidden = unavailable;
    const head = frame.querySelector('[data-pd="var-head"]') as HTMLElement | null;
    if (head) head.hidden = unavailable;
    const details = frame.querySelector('[data-pd="var-details"]') as HTMLDetailsElement | null;
    if (details) {
      details.classList.toggle('is-unavailable', unavailable);
      if (unavailable) details.open = false;
      const sum = frame.querySelector('[data-pd="var-summary"]') as HTMLElement;
      sum.firstChild!.textContent = unavailable ? 'Variables: not available' : 'Variables ';
      sum.setAttribute('aria-disabled', String(unavailable));
    }
    (frame.querySelector('[data-pd="var-count"]') as HTMLElement).textContent = vars && !unavailable ? (full ? `${vars.length}` : `(${vars.length})`) : '';
    if (unavailable) { list.innerHTML = '<div class="pd-var-empty dim">Not available: this process is serving this page.</div>'; return; }
    (frame.querySelector('[data-pd="var-all"]') as HTMLElement).textContent = revealAll ? 'Hide all' : 'Show all';
    const note = (text: string): string => `<div class="pd-var-empty dim">${esc(text)}</div>`;
    if (!vars) { list.innerHTML = note('—'); return; }
    if (oscaUp === null) {
      oscaUp = false;
      void apiAvailable().catch(() => false).then((up) => { oscaUp = up; if (up) rerenderVars(); });
    }
    const values = new Map(vars.map((v) => [v.Name, v.Value]));
    const shown = vars.filter((v) => !varQuery || v.Name.toLowerCase().includes(varQuery));
    const limit = full ? 500 : 200;
    const ns = (dvPid === selected ? dv?.NameSpace : '') || findP(selected)?.Nspace || '';
    const out: string[] = [];
    let count = 0;
    const chev = (id: string, open: boolean, label: string): string =>
      `<button type="button" class="pd-vchev" data-var-toggle="${esc(id)}" tabindex="-1" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(label)}"><ev-icon name="${open ? 'chevron-down' : 'chevron-right'}" size="xs"></ev-icon></button>`;
    const row = (o: { id: string; level: number; name: string; title: string; toggle: boolean; open: boolean; cell: string; kind?: string }): string =>
      `<div class="pd-vrow${full ? ' pd-vrow--full' : ''}${o.kind ? ` pd-vrow--${o.kind}` : ''}" role="treeitem" aria-level="${o.level + 1}"${o.toggle ? ` aria-expanded="${o.open}"` : ''} tabindex="-1" data-var-row="${esc(o.id)}" style="--lvl:${o.level}">
        <span class="pd-vchev-col">${o.toggle ? chev(o.id, o.open, o.title) : ''}</span>
        <span class="pd-var-name" title="${esc(o.title)}">${o.name}</span>
        <span class="pd-var-cell" data-var-cell="${esc(o.id)}">${o.cell}</span>
      </div>`;
    const nodes = (n: number): string => `<span class="pd-vcount">${n} node${n === 1 ? '' : 's'}</span>`;

    /** An object's class: a one-line caption, then its properties (names and types only); class-typed ones open again. */
    const objectRows = (id: string, cls: string, level: number, depth: number): void => {
      const got = loadedShape(cls, ns);
      if (got === undefined) { out.push(row({ id: `${id}~`, level, name: '<span class="dim">Loading…</span>', title: cls, toggle: false, open: false, cell: '', kind: 'note' })); return; }
      if (got === null) { out.push(row({ id: `${id}~`, level, name: '<span class="dim">Couldn’t read this class’s structure</span>', title: cls, toggle: false, open: false, cell: '', kind: 'note' })); return; }
      out.push(row({ id: `${id}~`, level, name: `<span class="pd-vcaption">Structure of <span class="mono">${esc(got.name || cls)}</span> · values stay inside the process</span>`, title: got.description || cls, toggle: false, open: false, cell: '', kind: 'note' }));
      for (const prop of got.properties) {
        if (count >= limit) return;
        const pid = `${id}/${prop.name}`;
        const openable = depth < 6 && isObjectType(prop.type);
        const open = openable && openNodes.has(pid);
        count++;
        out.push(row({ id: pid, level, name: `<span class="mono">${esc(prop.name)}</span>`, title: prop.description || prop.name, toggle: openable, open, cell: `<span class="pd-vtype">${esc(typeText(prop))}</span>` }));
        if (open) objectRows(pid, prop.type, level + 1, depth + 1);
      }
    };
    const walk = (list: VarNode[], level: number): void => {
      for (const n of list) {
        if (count >= limit) return;
        count++;
        const raw = n.raw;
        const shownValue = raw !== null && (revealAll || revealed.has(raw));
        const value = raw !== null ? values.get(raw) : undefined;
        const oref = shownValue && oscaUp ? OREF.exec(String(value)) : null;
        const kidsOpen = n.kids.length > 0 && openNodes.has(n.id);
        const objOpen = !n.kids.length && !!oref && openNodes.has(n.id);
        let cell: string;
        if (raw === null) cell = `<span class="pd-var-value dim">—</span>${nodes(n.kids.length)}`;
        else {
          const { name } = varName(raw);
          const eye = revealAll ? '<span class="pd-eye-gap"></span>' : `<button type="button" class="pd-eye" data-var-show="${esc(raw)}" aria-pressed="${shownValue}" aria-label="${shownValue ? 'Hide' : 'Show'} the value of ${esc(name)}" title="${shownValue ? 'Hide value' : 'Show value'}"><ev-icon name="${shownValue ? 'eye-off' : 'eye'}" size="xs"></ev-icon></button>`;
          const text = shownValue ? `<span class="pd-var-value mono">${esc(String(value))}</span>` : '<span class="pd-var-value pd-var-mask">••••</span>';
          const copy = shownValue ? `<button type="button" class="pd-copy pd-copy--always" data-var-copy="${esc(raw)}" aria-label="Copy the value of ${esc(name)}" title="Copy value"><ev-icon name="copy" size="xs"></ev-icon></button>` : '';
          cell = `${eye}${text}${copy}${n.kids.length ? nodes(n.kids.length) : ''}`;
        }
        const label = `<span class="mono">${esc(n.label)}</span>${n.tag ? `<span class="pd-tag">${n.tag}</span>` : ''}`;
        out.push(row({ id: n.id, level, name: label, title: n.id, toggle: n.kids.length > 0 || !!oref, open: kidsOpen || objOpen, cell }));
        if (kidsOpen) walk(n.kids, level + 1);
        else if (objOpen && oref) objectRows(n.id, oref[1], level + 1, 0);
      }
    };
    walk(varTree(shown), 0);
    const hadFocus = list.contains(document.activeElement) ? focusId : null;
    list.setAttribute('role', 'tree');
    list.innerHTML = out.length
      ? out.join('') + (count >= limit ? note('More variables: filter by name to find one') : '')
      : note(vars.length ? 'No variables match that name' : 'No variables');
    // Keep the keyboard where it was across the 5-second refresh.
    const rows = [...list.querySelectorAll<HTMLElement>('[data-var-row]')];
    const target = rows.find((r) => r.dataset.varRow === (hadFocus ?? focusId)) ?? rows[0];
    if (target) target.tabIndex = 0;
    if (hadFocus && target) target.focus({ preventScroll: true });
  }

  /** Class shapes already answered (undefined: still loading, or not asked). */
  const shapeDone = new Map<string, ClassShape | null>();
  function loadedShape(cls: string, ns: string): ClassShape | null | undefined {
    const key = `${ns.toUpperCase()}|${cls}`;
    if (shapeDone.has(key)) return shapeDone.get(key);
    void classShape(cls, ns).then((v) => { shapeDone.set(key, v); rerenderVars(); });
    return undefined;
  }
  const rerenderVars = (): void => { const f = currentFrame(); if (f) renderVars(f); };

  // ─── Levels: objectDetail() ───────────────────────────────────────────

  /** A process by PID: listed, or the one that just ended under the peek / full view (its last data). */
  function findP(pid: number | null): Process | undefined {
    if (pid === null || pid === forgotten) return undefined;
    return all.find((x) => x.Pid === pid) ?? (lastShown?.Pid === pid && ended(pid) ? lastShown : undefined);
  }
  /** Rows in the list's current filter and sort, as PIDs: what previous/next steps through. */
  function orderedPids(): number[] {
    const rows = visible().map((p) => toRow(p, cpuNow.get(p.Pid) ?? -1));
    const key = grid?.sortColumn || 'Commands';
    const dir = (grid ? grid.sortDirection : 'desc') === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = a[key]; const vb = b[key];
      if (va === null || va === undefined) return dir;
      if (vb === null || vb === undefined) return -dir;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return rows.map((r) => Number(r.Pid));
  }
  /** Take over a process for the detail: a different one starts its reads (and masking) afresh. */
  const adopt = (pid: number): void => {
    if (selected !== pid) { resetDetail(); peekEnded = null; endedPid = null; }
    selected = pid;
    forgotten = null;
  };

  const od = objectDetail<Process>(ctx, {
    collection: 'Processes', noun: 'process',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (p) => String(p.Pid),
    find: (k) => findP(Number(k)),
    order: () => orderedPids().map(String),
    name: (p) => p.Routine || '(no routine)',
    mono: true,
    meta: metaFor,
    menu: menuFor,
    // The body is a live frame (filled every 5 s in place, so Variables keeps its filter and reveals).
    peek: (p) => { adopt(p.Pid); return peekFrame(p.Pid); },
    loadFull: (p) => {
      if (selected === p.Pid) forgetValues(); else adopt(p.Pid);
      return fullView(p);
    },
    wire: (root, p, where) => {
      if (where === 'full') {
        const body = root.querySelector<HTMLElement>('.od-full');
        if (body) body.dataset.pdFrame = `full:${p.Pid}`;
        // Layout: Activity beside Runs as + Holds (same height), then Variables across the full width.
        const vars = root.querySelector<HTMLElement>('#pf-vars-card');
        const cols = root.querySelector<HTMLElement>('.od-cols');
        if (vars && cols) { cols.classList.add('pf-cols'); cols.after(vars); }
      }
      lastShown = findP(p.Pid) ?? lastShown;
      renderBody();
      startDetail();
    },
    onSelect: (k) => {
      if (k === null) { selected = null; peekEnded = null; resetDetail(); grid?.select([]); return; }
      adopt(Number(k));
      grid?.select([k]);
    },
    onPeek: () => applyColumns(),
    canLeave: async () => {
      if (editor && !(await editor.guard())) return false;
      leaveEdit();
      return true;
    },
  });

  /** Header and body for the latest data; the header only when something in it changed, so an open ⋯ menu survives a poll. */
  let headSig = '';
  const renderDetail = (): void => {
    if (editor || selected === null) return;
    const full = isFull();
    if (!full && !panel.open) return;
    // Gone from the list while the peek is open: keep it, dimmed.
    if (!full && !all.some((x) => x.Pid === selected) && lastShown?.Pid === selected && !peekEnded) { markPeekEnded(selected); return; }
    const p = findP(selected);
    if (!p) { if (full && listLoaded && endedPid !== selected) showEnded(selected); return; }
    if (endedPid === p.Pid) return;
    lastShown = p;
    const order = full ? orderedPids() : [];
    const sig = JSON.stringify([full, p.Pid, metaFor(p), menuFor(p).map((m) => [m.label, m.disabled, m.reason]), full ? [order.indexOf(p.Pid), order.length] : 0]);
    // Redrawing the header rebuilds its ⋯ menu: wait while that menu (or any dialog) is open.
    if (sig !== headSig && !document.querySelector('.crud-menu, ev-dialog')) { headSig = sig; od.refreshHeader(); }
    renderBody();
    startDetail();
  };

  /** Full view: the process is gone. */
  function showEnded(pid: number): void {
    endedPid = pid;
    stopDetail();
    forgetValues();
    headSig = '';
    if (lastShown?.Pid === pid) od.refreshHeader();
    fullEl.innerHTML = emptyState({
      icon: 'info',
      title: `Process ${pid} has ended`,
      what: 'It’s no longer running on this instance.',
      button: { id: 'pf-ended-back', label: 'Back to processes' },
    });
    fullEl.querySelector('#pf-ended-back')?.addEventListener('click', () => { forgotten = pid; void od.closeFull(); });
  }

  /** Peek: the process is gone. Keep its last data dimmed (values masked again) under a one-line notice. */
  function markPeekEnded(pid: number): void {
    if (peekEnded?.pid === pid) return;
    peekEnded = { pid, at: Date.now() };
    stopDetail();
    revealAll = false; revealed.clear();
    headSig = '';
    od.refreshHeader();
    renderBody();
  }

  // ─── Actions ───────────────────────────────────────────────────────

  /** Run one action, report it, and refresh. A 404 means the process already ended. */
  const run = async (pid: number, work: () => Promise<unknown>, done: string): Promise<void> => {
    busy = true;
    renderDetail();
    try {
      await work();
      toast(done);
    } catch (err) {
      if (err instanceof AdminError && err.status === 404) toast(`Process ${pid} has already ended.`, 'info');
      else toast(errorText(err), 'danger');
    } finally {
      busy = false;
      await load(true);
      renderDetail();
    }
  };

  /** Read the process fresh (transaction, exact line); null, with a toast, if that fails. */
  const fresh = async (pid: number): Promise<ProcessDetail | null> => {
    try {
      return await getProcess(pid);
    } catch (err) {
      if (err instanceof AdminError && err.status === 404) toast(`Process ${pid} has already ended.`, 'info');
      else toast(errorText(err), 'danger');
      await load(true);
      return null;
    }
  };
  /** "Process N is running <routine> in NS for user." plus the line it's at, on its own line. */
  const whereText = (p: Process, d: ProcessDetail): string => {
    const cur = d.CurrentLineAndRoutine || '';
    const hat = cur.indexOf('^');
    const offset = hat > 0 ? cur.slice(0, hat) : '';
    const curRoutine = hat >= 0 ? cur.slice(hat + 1) : '';
    const routine = p.Routine || d.Routine || curRoutine;
    const user = d.UserName || p.Username;
    const ns = d.NameSpace || p.Nspace;
    return `<p>Process <b>${esc(p.Pid)}</b> is running <span class="mono">${esc(routine || 'no routine')}</span>${ns ? ` in <span class="mono">${esc(ns)}</span>` : ''}${user ? ` for ${esc(userLabel(user))}` : ''}.</p>
      ${offset ? `<p class="dim">At line <span class="mono">${esc(offset)}</span>${curRoutine && curRoutine !== routine ? ` of <span class="mono">${esc(curRoutine)}</span>` : ''}.</p>` : ''}`;
  };

  /** Names the IRIS process and what the action costs; '' for ordinary processes. */
  const systemNote = (p: Process, verb: 'terminate' | 'suspend'): string => {
    if (!systemKind(p)) return '';
    const k = knownProcess(p.Routine);
    const what = k ? `This is ${k.name}, an IRIS system process.` : 'This is an IRIS system process.';
    const impact = verb === 'terminate'
      ? (k ? `${k.does} ${k.ifStopped}` : 'Stopping it can disrupt work IRIS does for everyone.')
      : (k ? `${k.does} ${systemKind(p) === 'web' ? 'A request it’s handling stalls until you resume it.' : 'That stops while it’s suspended.'}` : 'While it’s suspended, work IRIS does for everyone may stall.');
    return `<p><b>${esc(what)}</b> ${esc(impact)}</p>`;
  };

  async function suspend(p: Process): Promise<void> {
    const d = await fresh(p.Pid);
    if (!d) return;
    if (servingPortal(d)) { toast('That process is answering this portal’s request right now, so it can’t be suspended from here.', 'warning'); return; }
    if (!d.CanBeSuspended) { toast(`IRIS doesn’t allow process ${p.Pid} to be suspended.`, 'warning'); await load(true); return; }
    const body = `${whereText(p, d)}
      <p>It stops until you resume it. While it waits it keeps its locks and ${d.InTransaction > 0 ? '<b>its open transaction</b>' : 'any open transaction'}, so other processes that need them wait too.</p>
      ${systemNote(p, 'suspend')}`;
    const ok = await confirm({
      title: `Suspend process ${p.Pid}?`, body, confirmLabel: 'Suspend process',
      danger: !!systemKind(p), typeToConfirm: systemKind(p) ? String(p.Pid) : undefined,
    });
    if (ok) await run(p.Pid, () => processAction('suspend', p.Pid), `Process ${p.Pid} suspended. Resume it from here when you’re ready.`);
  }

  async function resume(p: Process): Promise<void> {
    await run(p.Pid, () => processAction('resume', p.Pid), `Process ${p.Pid} resumed.`);
  }

  async function terminate(p: Process): Promise<void> {
    const pid = p.Pid;
    // Read it fresh: whether it's in a transaction and exactly where it is.
    const d = await fresh(pid);
    if (!d) return;
    if (servingPortal(d)) { toast('That process is answering this portal’s request right now, so it can’t be stopped from here.', 'warning'); return; }
    if (!d.CanBeTerminated) { toast(`IRIS doesn’t allow process ${pid} to be stopped.`, 'warning'); await load(true); return; }
    const kind = systemKind(p);
    const body = `${whereText(p, d)}
      <p>${d.InTransaction > 0
        ? '<b>It has an open transaction, which will be rolled back:</b> every change it hasn’t committed is lost.'
        : 'It has no open transaction, so no uncommitted changes are lost.'}
        Whatever it’s doing stops and can’t be resumed, its locks are released, and anyone connected to it is disconnected.</p>
      ${systemNote(p, 'terminate')}`;
    // Suspending an IRIS system process isn't a safe alternative, so it's only offered for ordinary ones.
    const canSuspend = !kind && d.CanBeSuspended && !isSuspended(d.State);
    const ok = await confirm({
      title: `Terminate process ${pid}?`,
      body,
      confirmLabel: 'Terminate process',
      danger: true,
      typeToConfirm: kind ? String(pid) : undefined,
      alternative: canSuspend ? { label: 'Suspend instead', onSelect: () => void suspend(p) } : undefined,
    });
    if (ok) await run(pid, () => processAction('terminate', pid), `Process ${pid} terminated.`);
  }

  function openMessage(p: Process): void {
    const pid = p.Pid;
    // In the full view the form takes the body's place; in the peek it takes the panel.
    const host = isFull() ? fullEl : detailEl;
    stopDetail();
    editor = editorShell(host, {
      subtitle: `Process ${esc(pid)}`,
      title: 'Send a message',
      name: `the message to process ${pid}`,
      submitLabel: 'Send message',
      sections: section('Message',
        textareaField('Message', 'Message', '', { rows: 4, required: true, maxlength: 1000 }),
        { hint: 'Shown on the process’s terminal, for example to warn someone before you stop their session.' }),
      check: () => (String(readForm(host).Message ?? '').trim() ? [] : [{ field: 'Message', label: 'Message', message: 'Enter a message' }]),
      onSubmit: async (v) => {
        try {
          await sendMessage(pid, String(v.Message).trim());
        } catch (err) {
          if (err instanceof AdminError && err.status === 404) throw new Error(`Process ${pid} has already ended.`);
          throw err;
        }
        leaveEdit();
        headSig = '';
        od.refresh();
        toast(`Message sent to process ${pid}.`);
      },
      onCancel: () => { leaveEdit(); headSig = ''; od.refresh(); },
    });
  }

  void sessionInfo().then((info) => {
    canOperate = can(info, 'Operate') !== false;
    if (selected !== null) renderDetail();
  }).catch(() => { /* keep defaults: IRIS still refuses what it must */ });

  /**
   * Columns: secondary ones step aside while the peek is open; CPU % and Namespace also step aside when
   * they'd say the same thing on every visible row (the footer says it once).
   */
  let pruned: string[] = [];
  const applyColumns = (): void => {
    for (const c of COLUMNS) grid?.setColumnVisible(c.key, !(panel.open && SECONDARY.includes(c.key)) && !pruned.includes(c.key));
  };
  const renderGrid = (): void => {
    const rows = visible().map((p) => toRow(p, cpuNow.get(p.Pid) ?? -1));
    const probe = rows.map((r) => ({ CpuNow: Number(r.CpuNow) >= 0.1 ? r.CpuNow : '', Nspace: r.Nspace }));
    pruned = pruneColumns(probe, COLUMNS.filter((c) => c.key === 'CpuNow' || c.key === 'Nspace')).dropped;
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
        void od.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Pid));
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([String(selected)]);
    wrap.querySelector('.grid-empty')?.remove();
    if (rows.length === 0) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">No processes match “${esc(query)}”.</div>`);
  };

  let systemCpu = NaN;
  const renderFoot = (): void => {
    const known = [...cpuNow.values()].filter((v) => v >= 0);
    const iris = known.reduce((a, v) => a + v, 0);
    if (!grid) return; // no list yet: don't claim 0 processes
    const sys = all.filter(isSystem).length;
    const sep = '<span class="meta-sep">·</span>';
    const counts = `<b>${all.length}</b> process${all.length === 1 ? '' : 'es'}${sep}<b>${all.length - sys}</b> user${sep}<b>${sys}</b> system`;
    const ns = pruned.includes('Nspace') ? visible()[0]?.Nspace : '';
    const nsNote = ns ? `${sep}all in ${esc(ns)}` : '';
    (ctx.body.querySelector('#proc-foot') as HTMLElement).innerHTML = known.length
      ? `${counts}${nsNote}${sep}IRIS <b>${iris.toFixed(1)}%</b> of one core${sep}System CPU <b>${Number.isFinite(systemCpu) ? Math.round(systemCpu) : '—'}%</b>`
      : `${counts}${nsNote}${sep}CPU not sampled`;
  };
  ctx.onLeave(metrics.subscribe((snap) => { systemCpu = value(snap, 'iris_cpu_usage'); renderFoot(); }));

  // Live refresh never moves things under the user: while the pointer is over
  // the grid, or a menu or dialog is open, a poll's data is held back (row
  // order frozen, clicks land on the row they aimed at) and shown afterwards.
  let hovering = false;
  let held: { rows: Process[]; cpu: Map<number, number>; at: Date } | null = null;
  const frozen = (): boolean => !isFull() && (hovering || !!document.querySelector('.crud-menu, ev-dialog'));
  wrap.addEventListener('pointerenter', () => { hovering = true; });
  wrap.addEventListener('pointerleave', () => { hovering = false; flush(); });
  const paint = (rows: Process[], cpuMap: Map<number, number>, at: Date): void => {
    all = rows;
    const first = !listLoaded;
    listLoaded = true;
    cpuNow = cpuMap;
    updated(at);
    renderToolbar();
    renderGrid();
    renderFoot();
    // The first load answers a deep link (#/operations/processes/<pid>); later ones update what's open in place.
    if (first) od.refresh();
    else if (selected !== null) renderDetail();
  };
  function flush(): void {
    if (!held || frozen()) return;
    const h = held;
    held = null;
    paint(h.rows, h.cpu, h.at);
  }
  // Catch the moment a menu or dialog closes without waiting for the next poll.
  const flushTimer = setInterval(flush, 400);
  ctx.onLeave(() => clearInterval(flushTimer));

  const updated = liveIndicator(ctx, () => void load(true));
  /** force: paint now even if frozen (after the user's own action, or an explicit refresh). */
  const load = async (force = false): Promise<void> => {
    try {
      const rows = await getProcesses();
      const at = performance.now();
      let cpuMap = cpuNow;
      const listSecs = prevCpu ? (at - prevCpu.at) / 1000 : 0;
      if (prevCpu) {
        const secs = listSecs;
        const prev = prevCpu.byPid;
        cpuMap = new Map(rows.map((p) => [p.Pid, prev.has(p.Pid) ? Math.max(0, ((p.CPUTime - (prev.get(p.Pid) ?? 0)) / 1000 / secs) * 100) : -1]));
      }
      prevCpu = { at, byPid: new Map(rows.map((p) => [p.Pid, p.CPUTime])) };
      recordListHistory(rows, at, listSecs, cpuMap);
      if (grid && !force && frozen()) { held = { rows, cpu: cpuMap, at: new Date() }; return; }
      held = null;
      paint(rows, cpuMap, new Date());
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-proc');
      wrap.querySelector('#retry-proc')?.addEventListener('click', () => void load());
    }
  };

  ctx.body.querySelector('#proc-search')?.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
    renderFoot();
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => {
    scope = (e as CustomEvent<{ value: Scope }>).detail.value;
    renderGrid();
    renderFoot();
  });

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
