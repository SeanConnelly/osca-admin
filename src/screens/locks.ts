// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Locks — the live lock table: which process holds which lock,
 * who is waiting, and (with the operator privilege) removing a stuck lock.
 * Removing is a last resort: the owner isn't told, so the panel always points
 * at terminating the owner instead, and IRIS refuses while the owner is in a
 * transaction.
 */
import '../styles-security.css';
import '../styles-ops.css';
import { mountSecurityBanner, type LocalRisk } from '../security-view';
import { getLocks, removeLock, getDbNames, opsPortal, opsDocs, type LockRow } from '../api-ops';
import { kv, noPermissionText, cellId, cellRef, pruneColumns, esc, chip, cell, num, skeleton, errorPanel, liveIndicator, emptyState, type GridColumn, type ScreenCtx, type Tone } from '../ui';
import { AdminError, blockedAttrs, confirm, errorText, moreButton, moreMenu, toast, type MenuHandle } from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 5000;
const NO_OPERATE = noPermissionText('%Admin_Operate', 'system operation');

type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};
type Scope = 'all' | 'waiting' | 'app' | 'iris';

/* ───────────── Reading a lock ───────────── */

const keyOf = (l: LockRow): string => `${l.DeleteID}|${l.Pid}|${l.ModeCount}|${l.Reference}`;
const routineOf = (l: LockRow): string => { const i = l.RoutineInfo.indexOf('^'); return i >= 0 ? l.RoutineInfo.slice(i + 1) : l.RoutineInfo; };
const lineOf = (l: LockRow): string => { const i = l.RoutineInfo.indexOf('^'); return i > 0 ? l.RoutineInfo.slice(0, i) : ''; };
const isWaiting = (l: LockRow): boolean => /^Wait/.test(l.ModeCount);

/** IRIS's own locks: its daemons and system globals. Removing one can stop part of IRIS. */
const IRIS_ROUTINES = /^(%|LMFMON$|NETWORK$|CONTROL$|WRTDMN$|JRNDMN$|GARCOL$|EXPDMN$|CLNDMN$|MONITOR$|ECP|SYS\.)/;
const IRIS_GLOBALS = /^\^(%|IRIS\.|ISC\.|SYS\b|SYS\(|Config\.|TASKMGR|rOBJ|oddDEF|ROUTINE)/;
const isIris = (l: LockRow): boolean => IRIS_ROUTINES.test(routineOf(l)) || IRIS_GLOBALS.test(l.Reference);

interface Mode { label: string; tone: Tone; means: string; waiting: boolean }
/** ModeCount in words (see "Interpreting ModeCount Values" in the docs). */
function modeOf(l: LockRow): Mode {
  const m = l.ModeCount;
  const w = /^Wait(Shared|Exclusive)(Exact|Parent|Child)$/.exec(m);
  if (w) {
    const kind = w[1] === 'Shared' ? 'a shared' : 'an exclusive';
    const where = w[2] === 'Exact' ? 'this lock' : w[2] === 'Parent' ? 'a lock above this one in the same global' : 'a lock below this one in the same global';
    return { label: `Waiting · ${w[1].toLowerCase()}`, tone: 'warning', waiting: true,
      means: `Process ${l.Pid} is waiting for ${kind} lock on ${where}. It carries on once the holder releases it, or when its own lock timeout runs out.` };
  }
  if (m === 'LockPending' || m === 'SharePending') return { label: 'Being granted', tone: 'neutral', waiting: false, means: 'IRIS is granting this lock right now.' };
  if (m === 'DelockPending') return { label: 'Being released', tone: 'neutral', waiting: false, means: 'IRIS is releasing this lock right now.' };
  if (m === 'Lost') return { label: 'Lost', tone: 'danger', waiting: false, means: 'The lock was lost when a network connection to another server was reset.' };
  const delock = /->Delock/.test(m);
  const hasX = /Exclusive/.test(m);
  const hasS = /Shared/.test(m);
  const count = (re: RegExp): number => { const x = re.exec(m); return x ? Number(x[1]) + (x[2] ? Number(x[2]) : 0) : 1; };
  const xn = hasX ? count(/Exclusive(?:_[eE])?\/(\d+)(?:\+(\d+)e)?/) : 0;
  const sn = hasS ? count(/Shared(?:_[eE])?\/(\d+)(?:\+(\d+)e)?/) : 0;
  const escalated = /_E\b/.test(m);
  const label = hasX && hasS ? 'Exclusive + shared' : hasX ? 'Exclusive' : hasS ? 'Shared' : m;
  const times = Math.max(xn, sn) > 1 ? ` It has taken it ${Math.max(xn, sn)} times, so it must release it as often.` : '';
  if (delock) {
    return { label: 'Held to transaction end', tone: 'info', waiting: false,
      means: `Process ${l.Pid} has unlocked this, but IRIS keeps the lock until its transaction commits or rolls back, so nobody sees uncommitted changes.` };
  }
  const base = hasX
    ? `Process ${l.Pid} holds this lock exclusively: no other process can take it, or a lock above or below it in the same global, until it’s released.`
    : `Process ${l.Pid} holds a shared lock: other processes can share it, but none can take it exclusively until it’s released.`;
  return { label, tone: hasX ? 'info' : 'neutral', waiting: false,
    means: `${base}${escalated ? ' IRIS merged many smaller locks on this global into this one to save lock table space.' : ''}${times}` };
}

/** A held lock is normal, so its state is plain text; only waiting and lost locks get a pill. */
function stateCell(m: Mode, raw = ''): string {
  const title = raw ? `IRIS mode: ${raw}` : '';
  if (m.tone === 'warning' || m.tone === 'danger') return chip(m.label, m.tone, title);
  return `<span style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ev-color-text-${m.label.startsWith('Being') ? 'tertiary' : 'secondary'})" title="${esc(title ? `${m.label} · ${title}` : m.label)}">${esc(m.label)}</span>`;
}

const portalLink = (href: string, label: string, title = ''): string =>
  `<a class="btn btn--sm" href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${esc(label)} ↗</a>`;

export function locksScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="lk-toolbar">
      <div class="search-box"><ev-search id="lk-search" size="sm" full-width placeholder="Filter by lock name, PID, routine or database" aria-label="Filter locks"></ev-search></div>
      <ev-segmented-button id="lk-scope" size="sm" aria-label="Show"></ev-segmented-button>
    </div>
    <ev-detail-panel id="lk-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap ops-wrap" id="lk-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="lk-detail" aria-label="Lock"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="lk-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#lk-panel');
  const wrap = $('#lk-wrap');
  const detail = $('#lk-detail');
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#lk-scope');
  scopeEl.addEventListener('ev-segmented-button-change', (e) => { scope = (e as CustomEvent<{ value: Scope }>).detail.value; renderGrid(); });

  let all: LockRow[] = [];
  let loaded = false;
  let dbByDir = new Map<string, string>();
  let query = '';
  let scope: Scope = 'all';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let canOperate = true;
  let busy = false;
  let menu: MenuHandle | null = null;
  let shownSig = '';
  ctx.onLeave(() => menu?.destroy());

  const dirKey = (d: string): string => d.toLowerCase().replace(/[\\/]+$/, '');
  const dbName = (dir: string): string => dbByDir.get(dirKey(dir)) ?? '';
  const dbLabel = (l: LockRow): string => (l.System ? `${dbName(l.Directory) || l.Directory} on ${l.System}` : dbName(l.Directory) || l.Directory);

  const inScope = (l: LockRow, s: Scope): boolean =>
    s === 'all' || (s === 'waiting' ? isWaiting(l) : s === 'iris' ? isIris(l) : !isIris(l));
  const matches = (l: LockRow): boolean => {
    if (!query) return true;
    const ql = query.toLowerCase();
    return [l.Reference, String(l.Pid), l.RoutineInfo, l.Directory, dbName(l.Directory), l.OSUserName, modeOf(l).label].some((f) => f?.toLowerCase().includes(ql));
  };
  const visible = (): LockRow[] => all.filter((l) => inScope(l, scope) && matches(l));
  /** Waiters queue on the lock at the head of their queue, which is the Reference they report. */
  const waitersOf = (l: LockRow): LockRow[] => all.filter((w) => isWaiting(w) && w.Reference === l.Reference && w.Directory === l.Directory);
  const holdersOf = (l: LockRow): LockRow[] => all.filter((h) => !isWaiting(h) && h.Reference === l.Reference && h.Directory === l.Directory);
  const heldBy = (pid: number): LockRow[] => all.filter((h) => h.Pid === pid && !isWaiting(h));

  /* ───── Notice: somebody is stuck (one line; the detail is its tooltip) ───── */
  let bannerSig = '';
  const renderBanner = (): void => {
    const waiting = all.filter(isWaiting);
    const lost = all.filter((l) => l.ModeCount === 'Lost');
    let local: LocalRisk | null = null;
    if (lost.length) {
      local = { tone: 'danger', headline: `${num(lost.length)} lock${lost.length === 1 ? ' was' : 's were'} lost when a network connection reset`,
        detail: 'The processes that held them may be working on data another process can now change. Check them and the remote server.' };
    } else if (waiting.length) {
      // The busiest queue: the held lock with the most waiters.
      const counts = new Map<string, number>();
      for (const w of waiting) counts.set(`${w.Directory}|${w.Reference}`, (counts.get(`${w.Directory}|${w.Reference}`) ?? 0) + 1);
      const [topKey] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0];
      const head = all.find((l) => !isWaiting(l) && `${l.Directory}|${l.Reference}` === topKey);
      const who = new Set(waiting.map((w) => w.Pid)).size;
      local = { tone: 'warning', headline: `${num(who)} process${who === 1 ? ' is' : 'es are'} waiting for a lock`,
        detail: `${head ? `The longest queue is for ${head.Reference}, held by process ${head.Pid} (${routineOf(head) || 'no routine'}). ` : ''}Short waits are normal; a wait that doesn’t clear usually means the holder is stuck.`,
        showThem: { label: 'Show waiting', run: () => { scope = 'waiting'; renderToolbar(); renderGrid(); } } };
    }
    const sig = JSON.stringify(local ? [local.tone, local.headline, local.detail] : null);
    if (sig === bannerSig) return;
    bannerSig = sig;
    mountSecurityBanner(ctx.banners, null, local);
  };
  ctx.onLeave(() => { ctx.banners.innerHTML = ''; });

  /* ───── Grid ───── */

  /*
   * The wall: many locks with the same routine, the same mode and the same first subscript (IRIS's work
   * queues hold one per job) collapse into one row that expands, like Schedule's every-day row. Locks that
   * matter (waiting, with waiters, lost) and small groups stay as their own rows, first.
   */
  const GROUP_MIN = 5;
  const expanded = new Set<string>();
  /** `^IRIS.WorkQueue("Group",12,"x")` → `^IRIS.WorkQueue("Group",…)`; a name with one subscript or none is its own prefix. */
  const prefixOf = (ref: string): string => {
    const open = ref.indexOf('(');
    if (open < 0 || !ref.endsWith(')')) return ref;
    let q = false;
    for (let i = open + 1; i < ref.length - 1; i++) {
      const ch = ref[i];
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) return `${ref.slice(0, i + 1)}…)`;
    }
    return ref;
  };
  const matters = (l: LockRow): boolean => isWaiting(l) || l.ModeCount === 'Lost' || waitersOf(l).length > 0;
  const groupOf = (l: LockRow): string => [routineOf(l), modeOf(l).label, prefixOf(l.Reference), l.Directory].join('|');
  /** Rows in triage order: locks that matter, then single locks, then each group (with its members when open). */
  const triage = (list: LockRow[]): DataGridRow[] => {
    if (query || scope === 'waiting') return list.map(toRow);
    const groups = new Map<string, LockRow[]>();
    const singles: LockRow[] = [];
    for (const l of list) {
      if (matters(l)) { singles.push(l); continue; }
      const g = groupOf(l);
      groups.set(g, [...(groups.get(g) ?? []), l]);
    }
    const out: DataGridRow[] = [];
    const big: Array<[string, LockRow[]]> = [];
    for (const [g, ls] of groups) { if (ls.length >= GROUP_MIN && prefixOf(ls[0].Reference) !== ls[0].Reference) big.push([g, ls]); else singles.push(...ls); }
    singles.sort((a, b) => Number(matters(b)) - Number(matters(a)) || Number(isWaiting(b)) - Number(isWaiting(a)) || a.Reference.localeCompare(b.Reference));
    out.push(...singles.map(toRow));
    big.sort((a, b) => b[1].length - a[1].length);
    for (const [g, ls] of big) {
      const first = ls[0];
      const open = expanded.has(g);
      out.push({
        key: `grp:${g}`, Group: g, Open: open ? 1 : 0, Count: ls.length, Owners: new Set(ls.map((l) => l.Pid)).size,
        ModeCount: first.ModeCount, Reference: prefixOf(first.Reference), Mode: modeOf(first).label, Waiters: 0, Pid: first.Pid,
        Routine: routineOf(first), RoutineInfo: first.RoutineInfo, Kind: isIris(first) ? 'IRIS' : 'Application', Database: dbLabel(first), Directory: first.Directory,
      });
      if (open) out.push(...[...ls].sort((a, b) => a.Reference.localeCompare(b.Reference)).map((l) => ({ ...toRow(l), Child: 1 })));
    }
    return out;
  };
  /** The Lock cell: a group shows a chevron, its prefix and how many; a member is indented under it. */
  const lockCell = (v: unknown, row: DataGridRow): string => {
    if (row.Group) {
      return `<span style="display:flex;align-items:center;gap:6px;min-width:280px;cursor:pointer" title="${esc(`${num(Number(row.Count))} locks: click to ${row.Open ? 'collapse' : 'expand'}`)}">`
        + `<ev-icon name="${row.Open ? 'chevron-down' : 'chevron-right'}" size="xs" style="flex:none;color:var(--ev-color-text-tertiary)"></ev-icon>`
        + `<span style="min-width:0;overflow:hidden">${cellId(v)}</span>`
        + `<span style="flex:none;color:var(--ev-color-text-tertiary);white-space:nowrap">· ${num(Number(row.Count))} ${esc(String(row.Mode).toLowerCase())} · ${num(Number(row.Owners))} owner${Number(row.Owners) === 1 ? '' : 's'}</span></span>`;
    }
    return `<span style="display:block;min-width:280px;${row.Child ? 'padding-left:20px;' : ''}">${cellId(v, String(v))}</span>`;
  };
  const COLUMNS: GridColumn[] = [
    { key: 'Reference', label: 'Lock', sortable: true, description: 'The name that is locked, usually a global node', renderCell: (v, row) => lockCell(v, row) },
    { key: 'Mode', label: 'State', width: '110px', sortable: true, renderCell: (_v, row) => stateCell(modeOf({ Pid: Number(row.Pid), ModeCount: String(row.ModeCount) } as LockRow), String(row.ModeCount)) },
    { key: 'Waiters', label: 'Waiting', width: '84px', sortable: true, align: 'right', description: 'Processes queued for this lock', renderCell: (v) => (Number(v) > 0 ? cell.num(num(Number(v))) : cell.dim('—')) },
    { key: 'Pid', label: 'PID', width: '80px', sortable: true, align: 'right', renderCell: (v, row) => `<span style="display:block;padding-right:24px">${row.Group ? cell.dim('—') : cell.num(String(v))}</span>` },
    { key: 'Routine', label: 'Routine', sortable: true, description: 'The routine the owning process is running now', renderCell: (v, row) => (v ? cellRef(v, undefined, String(row.RoutineInfo)) : cell.dim('—')) },
    { key: 'Kind', label: 'Owner', width: '100px', sortable: true, renderCell: (v) => (v === 'IRIS' ? cell.dim('IRIS') : cell.text('Application')) },
    { key: 'Database', label: 'Database', width: '160px', sortable: true, renderCell: (v, row) => cellRef(v, undefined, String(row.Directory)) },
  ];
  const SECONDARY = ['Routine', 'Kind', 'Database'];
  /** Columns that say the same thing on every row step aside; the footer says it once. */
  const allIris = (): boolean => all.length > 0 && all.every(isIris);
  const noWaiters = (): boolean => !all.some(isWaiting);
  /** Database, when every visible row shares one (pruneColumns): the column steps aside and the footer names it. */
  let oneDbName = '';
  const oneDb = (): string => oneDbName;
  const applyColumns = (): void => {
    if (!grid) return;
    for (const c of COLUMNS) {
      const hide = (panel.open && SECONDARY.includes(c.key)) || (c.key === 'Kind' && allIris()) || (c.key === 'Waiters' && noWaiters()) || (c.key === 'Database' && !!oneDb());
      grid.setColumnVisible(c.key, !hide);
    }
  };
  const toRow = (l: LockRow): DataGridRow => ({
    key: keyOf(l), ModeCount: l.ModeCount, Reference: l.Reference, Mode: modeOf(l).label,
    Waiters: isWaiting(l) ? 0 : waitersOf(l).length, Pid: l.Pid, Routine: routineOf(l), RoutineInfo: l.RoutineInfo,
    Kind: isIris(l) ? 'IRIS' : 'Application', Database: dbLabel(l), Directory: l.Directory,
  });

  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => { selected = null; shownSig = ''; grid?.select([]); setPanel(false); };

  let rowSig = '';
  const renderToolbar = (): void => {
    const n = (s: Scope): number => all.filter((l) => inScope(l, s)).length;
    scopeEl.options = [
      { value: 'all', label: `All ${n('all')}` },
      { value: 'waiting', label: `Waiting ${n('waiting')}`, disabled: n('waiting') === 0 && scope !== 'waiting' },
      { value: 'app', label: `Application ${n('app')}`, disabled: n('app') === 0 && scope !== 'app' },
      { value: 'iris', label: `IRIS ${n('iris')}`, disabled: n('iris') === 0 && scope !== 'iris' },
    ];
    scopeEl.value = scope;
  };
  const renderGrid = (): void => {
    if (loaded && !all.length) {
      grid = null; rowSig = '';
      $('#lk-toolbar').hidden = true;
      closeDetail();
      wrap.innerHTML = emptyState({
        icon: 'check', title: 'No locks right now',
        what: 'No process holds or is waiting for a lock right now.',
        docs: { href: opsDocs.locks, label: 'About locks' },
      });
      return;
    }
    $('#lk-toolbar').hidden = false;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'key');
      // No default sort: rows come in triage order (what matters first, then the collapsed groups).
      grid.setAttribute('aria-label', 'Locks');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const row = (e as CustomEvent<{ row: DataGridRow }>).detail.row;
        if (row.Group) {
          // A group row expands or collapses; it has no detail of its own.
          const g = String(row.Group);
          if (expanded.has(g)) expanded.delete(g); else expanded.add(g);
          grid?.select(selected ? [selected] : []);
          renderGrid();
          return;
        }
        selected = String(row.key);
        shownSig = '';
        renderDetail();
      });
      wrap.appendChild(grid);
    }
    const rows = triage(visible());
    // Compare the database a lock is in, not its display text: rows with no directory (a lock being granted or
    // released) say nothing about it, and names compare without regard to case.
    const known = rows.filter((r) => !r.Group).filter((r) => String(r.Database ?? '').trim()).map((r) => ({ Database: String(r.Database).trim().toUpperCase() }));
    oneDbName = known.length >= 2 && pruneColumns(known, COLUMNS.filter((c) => c.key === 'Database')).dropped.length
      ? String(rows.find((r) => String(r.Database ?? '').trim())?.Database ?? '').trim() : '';
    renderFoot();
    const sig = JSON.stringify(rows.map((r) => [r.key, r.Waiters, r.Database, r.Count, r.Open]));
    if (sig !== rowSig) { rowSig = sig; grid.rows = rows; }
    applyColumns();
    if (selected) grid.select([selected]);
    wrap.querySelector('.ops-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      const what = query ? `No lock matches “${esc(query)}”${scope !== 'all' ? ' in this view' : ''}.` : scope === 'waiting' ? 'No process is waiting for a lock right now.' : 'No locks in this view.';
      wrap.insertAdjacentHTML('beforeend', `<div class="ops-empty">${emptyState({
        icon: query ? 'search' : 'check', title: query ? 'Nothing matches' : scope === 'waiting' ? 'Nobody is waiting' : 'Nothing here', what,
        action: '<button type="button" class="btn btn--sm" data-lk-clear>Show all locks</button>',
      })}</div>`);
      wrap.querySelector('[data-lk-clear]')?.addEventListener('click', () => {
        query = ''; scope = 'all'; renderToolbar();
        ($('#lk-search') as HTMLElement & { value: string }).value = '';
        renderGrid();
      });
    }
  };

  const renderFoot = (): void => {
    if (!loaded) return;
    const waiting = all.filter(isWaiting);
    const owners = new Set(all.filter((l) => !isWaiting(l)).map((l) => l.Pid)).size;
    const sep = '<span class="meta-sep">·</span>';
    const figs = [`<b>${num(all.length)}</b> lock${all.length === 1 ? '' : 's'}`, `<b>${num(owners)}</b> owner${owners === 1 ? '' : 's'}`, `<b>${num(waiting.length)}</b> waiting`];
    if (allIris()) figs.push('all held by IRIS');
    if (oneDb()) figs.push(`all in ${esc(oneDb())}`);
    $('#lk-foot').innerHTML = all.length ? figs.join(sep) : '';
  };

  /* ───── Detail ───── */
  const renderDetail = (): void => {
    const l = all.find((x) => keyOf(x) === selected);
    if (!l) { if (selected) closeDetail(); return; }
    const m = modeOf(l);
    const iris = isIris(l);
    const waiters = m.waiting ? [] : waitersOf(l);
    const holders = m.waiting ? holdersOf(l) : [];
    const others = heldBy(l.Pid).filter((h) => keyOf(h) !== keyOf(l));
    // Why Remove isn't offered, in words (a tooltip doesn't reach keyboard or touch users).
    const why = !canOperate ? NO_OPERATE
      : m.waiting ? 'This is a request that is still waiting, not a lock anyone holds. It goes away when the process gets the lock or gives up.'
        : !l.Removable ? 'IRIS is granting or releasing this lock right now, so it can’t be removed.'
          : l.RemoteOwner ? 'The owner is on another server. Remove it from that server’s Management Portal.'
            : '';
    const sig = JSON.stringify([selected, l.ModeCount, waiters.map((w) => w.Pid), holders.map((h) => h.Pid), others.length, canOperate, busy, dbLabel(l)]);
    if (sig === shownSig) return;
    shownSig = sig;
    const blocked = blockedAttrs(busy ? 'Working…' : null);
    const pidLine = (x: LockRow): string =>
      `<li><span><b class="mono">${esc(x.Pid)}</b><span class="ops-sub">${esc(routineOf(x) || 'no routine')}</span></span><span class="ops-meta">${stateCell(modeOf(x))}</span></li>`;
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">Lock${iris ? ' · IRIS' : ''}</span><h2 class="mono ops-wrap-name" title="${esc(l.Reference)}">${esc(l.Reference)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="lk-close"></ev-icon-button>
      </header>
      <div class="detail-state">${stateCell(m, l.ModeCount)}<span class="dim">in ${esc(dbLabel(l))}</span></div>
      <div class="detail-actions">
        ${why ? '' : `<button type="button" class="btn btn--sm" id="lk-remove"${blocked}>Remove lock…</button>`}
        ${portalLink(opsPortal.process(l.Pid), `Process ${l.Pid}`, 'What the owner is doing: call stack, variables, and terminate')}
        ${!why && others.length ? moreButton('lk-more', `More actions for this lock`) : ''}
      </div>
      ${why ? `<p class="detail-note">${esc(why)}</p>` : ''}
      <p class="detail-para">${esc(m.means)}</p>
      ${iris ? '<p class="detail-para">This lock belongs to IRIS itself. It is normal for IRIS to hold it for as long as it runs.</p>' : ''}
      ${waiters.length ? `<h3 class="detail-section">Waiting for it · ${num(waiters.length)}</h3><ul class="ops-list">${waiters.map(pidLine).join('')}</ul>` : ''}
      ${m.waiting ? `<h3 class="detail-section">Held by</h3>${holders.length ? `<ul class="ops-list">${holders.map(pidLine).join('')}</ul>` : '<p class="detail-para">The holder is releasing it, or holds a lock above or below this one.</p>'}` : ''}
      <h3 class="detail-section">${m.waiting ? 'Waiting process' : 'Owner'}</h3>
      <dl class="kv-list">
        ${kv('Process', `<span class="mono">${esc(l.Pid)}</span>`)}
        ${kv('Running', l.RoutineInfo ? `<span class="mono">${esc(routineOf(l))}</span>${lineOf(l) ? ` <span class="dim">at ${esc(lineOf(l))}</span>` : ''}` : '—', l.RoutineInfo)}
        ${kv('OS user', esc(l.OSUserName || '—'))}
        ${kv('Database', esc(dbName(l.Directory) || '—'))}
        ${kv('Directory', `<span class="mono">${esc(l.Directory)}</span>`, l.Directory)}
        ${l.System ? kv('Server', esc(l.System)) : ''}
      </dl>
      ${others.length ? `<h3 class="detail-section">Also held by process ${esc(l.Pid)} · ${num(others.length)}</h3>
        <ul class="ops-list">${others.slice(0, 8).map((o) => `<li><span class="mono ops-ref" title="${esc(o.Reference)}">${esc(o.Reference)}</span><span class="ops-meta">${stateCell(modeOf(o))}</span></li>`).join('')}</ul>
        ${others.length > 8 ? `<p class="detail-note">And ${num(others.length - 8)} more.</p>` : ''}` : ''}`;
    detail.querySelector('#lk-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#lk-remove')?.addEventListener('click', () => void remove(l));
    menu?.destroy();
    menu = null;
    const more = detail.querySelector<HTMLElement>('#lk-more');
    if (more) {
      const mine = heldBy(l.Pid).filter((h) => h.Removable && !h.RemoteOwner);
      menu = moreMenu(more, [
        { label: `Remove all ${mine.length} locks held by process ${l.Pid}…`, icon: 'trash-2', danger: true, onSelect: () => void removeAll(l.Pid) },
      ]);
    }
    setPanel(true);
  };

  /* ───── Actions ───── */
  const inTxnText = (pid: number): string =>
    `Process ${pid} is in a transaction, so IRIS won’t remove its lock: others could see or change data it hasn’t committed. Terminate the process instead; that rolls its transaction back and releases its locks.`;

  const warningBody = (l: LockRow, count: number): string => {
    const waiting = count === 1 ? waitersOf(l).length : all.filter((w) => isWaiting(w) && heldBy(l.Pid).some((h) => h.Reference === w.Reference)).length;
    return `<p><b>Process ${esc(l.Pid)} isn’t told.</b> It carries on as if it still held ${count === 1 ? 'the lock' : 'its locks'}, so another process can change the same data at the same time.</p>
      ${waiting ? `<p>${num(waiting)} waiting process${waiting === 1 ? '' : 'es'} will get ${count === 1 ? 'it' : 'them'} straight away.</p>` : ''}
      <p><b>Usually better:</b> terminate process ${esc(l.Pid)}. That rolls back its open transaction and releases all its locks together.</p>
      ${isIris(l) ? `<p><b>This lock belongs to IRIS.</b> Removing it can stop the part of IRIS that holds it (${esc(routineOf(l) || 'a system process')}) from working correctly.</p>` : ''}`;
  };

  const after = async (): Promise<void> => { busy = false; shownSig = ''; await load(true); };

  async function remove(l: LockRow): Promise<void> {
    const ok = await confirm({
      title: `Remove the lock on ${l.Reference}?`,
      body: `<p>Process <b>${esc(l.Pid)}</b> holds <span class="mono">${esc(l.Reference)}</span> in ${esc(dbLabel(l))}.</p>${warningBody(l, 1)}`,
      confirmLabel: 'Remove lock', danger: true,
      typeToConfirm: isIris(l) ? String(l.Pid) : undefined,
      alternative: { label: 'Go to Processes', onSelect: () => ctx.navigate('operations/processes') },
    });
    if (!ok) return;
    busy = true; shownSig = ''; renderDetail();
    try {
      await removeLock(l.DeleteID);
      toast(`Lock on ${l.Reference} removed.`);
    } catch (err) {
      if (err instanceof AdminError && err.status === 409) toast(inTxnText(l.Pid), 'warning');
      else if (err instanceof AdminError && err.status === 404) toast('That lock has already been released.', 'info');
      else toast(errorText(err), 'danger');
    } finally { await after(); }
  }

  async function removeAll(pid: number): Promise<void> {
    const mine = heldBy(pid).filter((h) => h.Removable && !h.RemoteOwner);
    if (!mine.length) return;
    const iris = mine.some(isIris);
    const ok = await confirm({
      title: `Remove all ${mine.length} locks held by process ${pid}?`,
      body: `${warningBody(mine[0], mine.length)}${iris ? '<p>Some of these locks belong to IRIS.</p>' : ''}`,
      confirmLabel: `Remove ${mine.length} locks`, danger: true,
      typeToConfirm: String(pid),
      alternative: { label: 'Go to Processes', onSelect: () => ctx.navigate('operations/processes') },
    });
    if (!ok) return;
    busy = true; shownSig = ''; renderDetail();
    let done = 0;
    try {
      for (const h of mine) {
        try { await removeLock(h.DeleteID); done++; } catch (err) {
          if (err instanceof AdminError && err.status === 404) continue; // already released
          throw err;
        }
      }
      toast(`${done} lock${done === 1 ? '' : 's'} held by process ${pid} removed.`);
    } catch (err) {
      const msg = err instanceof AdminError && err.status === 409 ? inTxnText(pid) : errorText(err);
      toast(done ? `${done} removed, then IRIS stopped: ${msg}` : msg, 'warning');
    } finally { await after(); }
  }

  void sessionInfo().then((info) => {
    canOperate = can(info, 'Operate') !== false;
    shownSig = '';
    renderDetail();
  }).catch(() => { /* keep defaults: IRIS still refuses what it must */ });
  void getDbNames().then((dbs) => {
    dbByDir = new Map(dbs.map((d) => [dirKey(d.Directory), d.Name]));
    rowSig = '';
    if (loaded) paint(all, new Date());
  }).catch(() => { /* directories stay as paths */ });

  /* ───── Live refresh that never moves rows under the pointer ───── */
  let hovering = false;
  let held: { rows: LockRow[]; at: Date } | null = null;
  const frozen = (): boolean => hovering || !!document.querySelector('.crud-menu, ev-dialog') || busy;
  wrap.addEventListener('pointerenter', () => { hovering = true; });
  wrap.addEventListener('pointerleave', () => { hovering = false; flush(); });
  function paint(rows: LockRow[], at: Date): void {
    all = rows;
    loaded = true;
    updated(at);
    renderBanner();
    renderToolbar();
    renderGrid();
    renderFoot();
    if (selected) renderDetail();
  }
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
      const rows = await getLocks();
      if (!alive) return;
      if (grid && !force && frozen()) { held = { rows, at: new Date() }; return; }
      held = null;
      paint(rows, new Date());
    } catch (err) {
      if (!alive) return;
      grid = null; rowSig = '';
      wrap.innerHTML = errorPanel(err, 'lk-retry');
      wrap.querySelector('#lk-retry')?.addEventListener('click', () => void load(true));
    }
  };

  $('#lk-search').addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
