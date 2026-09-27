// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › SQL privileges — who can do what with tables, views and
 * procedures through SQL, plus the admin-level SQL privileges (create table,
 * bulk-load shortcuts and so on). Two views of one namespace-wide index:
 * by user or role ("What can Jane do in SQL?") and by table ("Who can read
 * table X?"). Grant opens in the detail panel; revoke is per line.
 *
 * SQL privileges sit alongside resources: resources decide whether someone
 * can connect to SQL and reach the database at all; SQL privileges decide
 * which tables they can read or change once there. The user detail shows
 * both, so the two are never confused.
 */
import '../styles-security.css';
import '../styles-sql.css';
import {
  getObjectPrivs, getAdminPrivs, getColumnPrivs, getCatalog, pool, grantObject, revokeObject, grantColumn, revokeColumn,
  grantAdmin, revokeAdmin, viaWords, actionShort, actionLong, sortActions, typeWord, schemaOf, adminText,
  ADMIN_PRIVS, TYPE_ACTIONS, CHANGE_ACTIONS, COLUMN_ACTIONS, ACTION_ORDER,
  type SqlObjPriv, type SqlAdminPriv, type SqlColumnPriv, type SqlObject, type SqlObjectType,
} from '../api-sql';
import {
  getSecurityGraph, invalidateSecurityGraph, linkTo, namespaceChecks, PUBLIC_USER, ANON_USER,
  type SecurityGraph,
} from '../api-security';
import {
  newButton, moreButton, moreMenu, confirm, toast, editorShell, panelWidth, section, selectField, textField, checkField,
  readForm, errorText, scrollPanelTop, type EditorHandle, type FieldProblem, type MenuHandle, type MenuItem,
} from '../crud';
import { guardDialog, type GuardRisk } from '../security-view';
import {
  plural,
  esc, chip, cell, num, skeleton, errorPanel, liveIndicator, viewTabs, bindViewTabs, setViewTabCount,
  emptyState, noPermissionText, type ScreenCtx, type GridColumn, setChips,
} from '../ui';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const EDIT_WIDTH = 540;
const NO_SECURE = noPermissionText('%Admin_Secure', 'security administration');
const SEP = '\u0000';

/* ── Index types ───────────────────────────────────────── */

type Kind = 'User' | 'Role';
interface Grantee {
  name: string;
  kind: Kind;
  /** Users holding %All: IRIS reports every privilege on every object; not listed. */
  full: boolean;
  /** Roles that include %All: holders get full SQL access (the role itself lists nothing). */
  roleFull: boolean;
  enabled: boolean;
  privs: SqlObjPriv[];
  admin: SqlAdminPriv[];
  error?: string;
}
/** One grantee's privileges on one object, through one route. */
interface Line { object: string; type: string; via: string; actions: string[]; grantOption: string[]; columns: boolean }

const objKey = (type: string, object: string): string => `${type}${SEP}${object}`;
const splitKey = (k: string): { type: string; object: string } => { const [type, object] = k.split(SEP); return { type, object }; };
const isEveryone = (p: SqlObjPriv): boolean => p.GrantedVia === 'Owner Privilege';
const isProc = (t: string): boolean => t === 'STORED PROCEDURE';

/** Group a grantee's rows by object and route. Built-in "everyone" rows are kept apart. */
function linesOf(privs: SqlObjPriv[]): { lines: Line[]; everyone: Line[] } {
  const m = new Map<string, Line>();
  const every = new Map<string, Line>();
  for (const p of privs) {
    const target = isEveryone(p) ? every : m;
    const k = `${p.Type}${SEP}${p.Object}${SEP}${p.GrantedVia}`;
    let l = target.get(k);
    if (!l) { l = { object: p.Object, type: p.Type, via: p.GrantedVia, actions: [], grantOption: [], columns: false }; target.set(k, l); }
    if (p.Action) l.actions.push(p.Action);
    if (p.Action && p.GrantOption) l.grantOption.push(p.Action);
    if (p.HasColumnPriv) l.columns = true;
  }
  const sort = (a: Line, b: Line): number => a.object.localeCompare(b.object) || a.via.localeCompare(b.via);
  const fix = (l: Line): Line => ({ ...l, actions: sortActions(l.actions), grantOption: sortActions(l.grantOption) });
  return { lines: [...m.values()].map(fix).sort(sort), everyone: [...every.values()].map(fix).sort(sort) };
}

/* ── Small markup helpers ──────────────────────────────── */

const actChips = (actions: string[], grantOpt: string[] = []): string => `<span class="sql-acts">${actions.map((a) => {
  const change = CHANGE_ACTIONS.includes(a);
  return `<span class="sql-act${change ? ' sql-act--change' : ''}" title="${esc(actionLong(a))}${grantOpt.includes(a) ? ' · can pass it on' : ''}">${esc(actionShort(a))}${grantOpt.includes(a) ? '<sup aria-label="can pass it on">+</sup>' : ''}</span>`;
}).join('')}</span>`;
const granteeChip = (name: string, kind: Kind, title = ''): string =>
  `<button type="button" class="chip-link" data-grantee="${esc(name)}" aria-label="Show ${esc(name)}’s SQL privileges">${chip(name, 'neutral', title || `Show what ${name} can do in SQL`)}</button>`;
const objectLink = (type: string, object: string): string =>
  `<button type="button" class="sql-objlink mono" data-obj="${esc(objKey(type, object))}" title="Show who can use ${esc(object)}">${esc(object)}</button>`;
const callout = (tone: 'info' | 'warning' | 'danger', title: string, text = '', icon = tone === 'info' ? 'info' : 'alert-triangle'): string =>
  `<div class="sec-callout${tone === 'info' ? '' : ` sec-callout--${tone}`}" role="note"><ev-icon name="${icon}" size="sm"></ev-icon><div><strong>${esc(title)}</strong>${text ? `<span>${text}</span>` : ''}</div></div>`;
const listWords = (a: string[]): string => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

/** "Resources vs SQL privileges", said once per detail panel. */
const MODEL_NOTE = 'Resources control whether someone can reach the database at all (connect with SQL, read the namespace’s database). SQL privileges control which tables they can read or change once they’re there. Both are needed.';

/* ── Grids ─────────────────────────────────────────────── */

const count = (v: unknown, title: string): string => (v === 'All' ? cell.text('All', title) : v === '—' ? cell.dim('—') : Number(v) > 0 ? cell.num(num(Number(v)), title) : cell.dim('0'));
/** Secondary text, for facts that are expected rather than news. */
const secondary = (v: unknown, title = ''): string =>
  `<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;color:var(--ev-color-text-secondary)"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`;
const WHO_COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'User or role', width: '220px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
  { key: 'Kind', label: 'Kind', width: '84px', sortable: true,
    renderCell: (v) => `<span style="display:inline-flex;align-items:center;gap:4px;"><ev-icon name="${v === 'Role' ? 'users' : 'user'}" size="xs"></ev-icon>${esc(v)}</span>` },
  { key: 'Summary', label: 'SQL access', sortable: true, description: 'What they can do through SQL in this namespace. %All skips SQL privileges, but row-level security still applies, even to %All.',
    renderCell: (v, row) => (row.Full
      ? (row.Anon ? chip(String(v), 'danger', 'UnknownUser holds %All: anyone can connect and use every table')
        : secondary(v, row.RoleFull ? 'Includes %All: its holders get every SQL privilege on every object (row-level security still applies)' : 'Holds %All: every SQL privilege on every object (row-level security still applies)'))
      : row.NoWayIn ? `${chip('Has grants but no way in', 'warning', String(row.NoWayInWhy))} ${cell.text(v, String(v))}`
        : v ? cell.text(v, String(v)) : cell.dim('Nothing granted')) },
  { key: 'Objects', label: 'Tables & views', width: '112px', sortable: true, align: 'right', description: 'Tables and views they can use in some way',
    renderCell: (v) => count(v, 'Tables and views they can use') },
  { key: 'Changes', label: 'Read & change', width: '108px', sortable: true, align: 'right', description: 'Tables and views whose rows or definition they can change',
    renderCell: (v) => count(v, 'Tables and views they can add to, change, delete from or alter') },
  { key: 'Procs', label: 'Procedures', width: '96px', sortable: true, align: 'right', description: 'Stored procedures they can run (beyond the ones everyone can run)',
    renderCell: (v) => count(v, 'Stored procedures they can run') },
  { key: 'Admin', label: 'SQL admin rights', width: '124px', sortable: true, align: 'right', description: 'SQL admin rights: create table, drop view, bulk-load shortcuts and the like',
    renderCell: (v) => count(v, 'SQL admin rights: create table, drop view…') },
];
const WHO_SECONDARY = ['Kind', 'Procs', 'Admin'];

const OBJ_COLUMNS: GridColumn[] = [
  { key: 'Object', label: 'Table, view or procedure', width: '300px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
  { key: 'TypeWord', label: 'Type', width: '100px', sortable: true, renderCell: (v) => cell.text(v) },
  { key: 'Readers', label: 'Read / Run', width: '96px', sortable: true, align: 'right', description: 'Users and roles that can read it (tables and views) or run it (procedures), not counting %All holders',
    renderCell: (v, row) => (row.Everyone ? cell.num('All', `Everyone can ${row.Proc ? 'run' : 'read'} this (granted to PUBLIC)`)
      : count(v, row.Proc ? 'Users and roles that can run it' : 'Users and roles that can read it')) },
  { key: 'Changers', label: 'Read & change', width: '108px', sortable: true, align: 'right', description: 'Users and roles that can change its rows or definition (not counting %All holders). Procedures are only run, so this doesn’t apply.',
    renderCell: (v, row) => (row.Proc ? cell.dim('—') : count(v, 'Users and roles that can change it')) },
  { key: 'Who', label: 'Granted to', sortable: true, description: 'Who holds privileges on it, not counting %All holders',
    renderCell: (v, row) => whoCell(String(row.WhoList ?? ''), !!row.EveryoneAny, String(v)) },
];
const OBJ_SECONDARY = ['TypeWord', 'Changers'];

/** "Everyone (PUBLIC)" then up to three names, each with a user or role icon, then "+N more". */
function whoCell(list: string, everyone: boolean, all: string): string {
  const names = list ? list.split('\n').map((x) => ({ kind: x.slice(0, 1), name: x.slice(2) })) : [];
  if (!names.length && !everyone) return cell.dim('Only %All holders');
  const MAX = everyone ? 1 : 2;
  const item = (n: { kind: string; name: string }): string =>
    `<span style="display:inline-flex;align-items:center;gap:3px;white-space:nowrap"><ev-icon name="${n.kind === 'R' ? 'users' : 'user'}" size="xs" label="${n.kind === 'R' ? 'Role' : 'User'}"></ev-icon>${esc(n.name)}</span>`;
  const parts = [
    ...(everyone ? ['<span style="white-space:nowrap">Everyone (PUBLIC)</span>'] : []),
    ...names.slice(0, MAX).map(item),
  ];
  const rest = names.length - Math.min(names.length, MAX);
  const more = rest > 0 ? `<span style="flex:0 0 auto;white-space:nowrap;color:var(--ev-color-text-secondary)">+${rest} more</span>` : '';
  // A comma straight after each name but the last; the names shrink (ellipsis) before "+N more" ever does.
  const joined = parts.map((x, i) => `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${x}${i < parts.length - 1 || more ? ',' : ''}</span>`).join('');
  return `<span style="display:flex;flex-wrap:nowrap;align-items:center;gap:6px;overflow:hidden" title="${esc(all)}">${joined}${more}</span>`;
}

type Tab = 'who' | 'objects';
type WhoScope = 'granted' | 'users' | 'roles' | 'all';
type ObjScope = 'granted' | 'all';
type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

interface GrantPrefill { grantee?: string; type?: SqlObjectType; object?: string; kind?: 'objects' | 'admin' }

/* ══ Screen ═══════════════════════════════════════════════ */

export function sqlPrivilegesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    ${viewTabs('sql-tabs', [{ value: 'who', label: 'By user or role', count: 0 }, { value: 'objects', label: 'By table', count: 0 }], 'who')}
    <div class="toolbar-row sql-toolbar">
      <div class="search-box"><ev-search id="sql-search" size="sm" full-width placeholder="Filter by name"></ev-search></div>
      <ev-segmented-button id="sql-scope" size="sm" aria-label="Show"></ev-segmented-button>
      <div class="toolbar-spacer"></div>
      <label class="sql-ns"><span>Namespace</span><ev-select id="sql-ns" size="sm" aria-label="Namespace"></ev-select></label>
      <ev-checkbox id="sql-sys" size="sm" hidden>Include system tables</ev-checkbox>
    </div>
    <ev-detail-panel id="sql-panel" detail-width="420" overlay-below="960" class="workspace">
      <div class="grid-wrap sql-grid-wrap" id="sql-grid-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="sql-detail" aria-label="SQL privilege details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="sql-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(s: string): T => ctx.body.querySelector(s) as T;
  const panel = $<HTMLElement & { open: boolean }>('#sql-panel');
  const wrap = $('#sql-grid-wrap');
  const detail = $('#sql-detail');
  const nsEl = $<HTMLElement & { value: string }>('#sql-ns');
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#sql-scope');
  const sysEl = $<HTMLElement & { checked: boolean }>('#sql-sys');
  const searchEl = $<HTMLElement & { value: string }>('#sql-search');

  let tab: Tab = 'who';
  let whoScope: WhoScope = 'granted';
  let objScope: ObjScope = 'granted';
  let includeSystem = false;
  let ns = 'USER';
  let query = '';
  let selected: string | null = null;
  let graph: SecurityGraph | null = null;
  let grantees: Grantee[] = [];
  let catalog: SqlObject[] = [];
  let loaded = false;
  let alive = true;
  let loadSeq = 0;
  let grid: GridEl | null = null;
  let gridTab: Tab | null = null;
  let canSecure = true;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  const columnCache = new Map<string, SqlColumnPriv[]>();

  const endEdit = (): void => {
    editor?.close(); editor = null;
    restoreWidth?.(); restoreWidth = null;
    ctx.beforeLeave(null);
  };
  ctx.onLeave(() => { alive = false; endEdit(); menu?.destroy(); });
  const guard = async (): Promise<boolean> => (editor ? editor.guard() : true);

  const newBtn = newButton(ctx, 'Grant privilege', () => { void guard().then((ok) => { if (ok) openGrant({}); }); });
  void sessionInfo().then((info) => {
    canSecure = can(info, 'Secure') !== false;
    newBtn.setHidden(!canSecure);
    if (!editor) renderDetail();
  }).catch(() => { /* keep defaults */ });

  /* ── Derived data ──────────────────────────────────────── */

  const granteeOf = (name: string): Grantee | undefined => grantees.find((g) => g.name === name);
  const allHolders = (): string[] => grantees.filter((g) => g.full).map((g) => g.name);

  /** object key → every grantee's lines on it (built-in rows and %All excluded). */
  const byObject = (): Map<string, Array<{ g: Grantee; line: Line }>> => {
    const m = new Map<string, Array<{ g: Grantee; line: Line }>>();
    for (const g of grantees) {
      if (g.full) continue;
      for (const line of linesOf(g.privs).lines) {
        // A schema grant names each table it covers; a column-only row names the table.
        const k = objKey(line.type, line.object);
        let a = m.get(k);
        if (!a) { a = []; m.set(k, a); }
        a.push({ g, line });
      }
    }
    return m;
  };
  const everyoneObjects = (): Set<string> => {
    const s = new Set<string>();
    // Grants to PUBLIC appear on every grantee as built-in rows, and on the _PUBLIC account itself.
    for (const g of grantees) for (const p of g.privs) if (isEveryone(p) || (g.name === PUBLIC_USER && p.Action)) s.add(objKey(p.Type, p.Object));
    return s;
  };

  const granteeStats = (g: Grantee): { objects: number; changes: number; procs: number; admin: number; summary: string } => {
    const { lines } = linesOf(g.privs);
    const objs = new Map<string, Set<string>>();
    for (const l of lines) {
      const k = objKey(l.type, l.object);
      const s = objs.get(k) ?? new Set<string>();
      l.actions.forEach((a) => s.add(a));
      if (l.columns) s.add('col');
      objs.set(k, s);
    }
    const tv = [...objs].filter(([k]) => !isProc(splitKey(k).type));
    const objects = tv.length;
    const changes = tv.filter(([, s]) => CHANGE_ACTIONS.some((a) => s.has(a))).length;
    const procs = [...objs].filter(([k]) => isProc(splitKey(k).type)).length;
    const admin = g.admin.length;
    const bits: string[] = [];
    if (objects) bits.push(changes === objects ? `Reads & changes ${plural(objects, 'table')}` : changes ? `Reads ${plural(objects, 'table')} (reads & changes ${changes})` : `Reads ${plural(objects, 'table')}`);
    if (procs) bits.push(`runs ${plural(procs, 'procedure')}`);
    if (admin) bits.push(plural(admin, 'SQL admin right'));
    const summary = bits.join(' · ').replace(/^\w/, (c) => c.toUpperCase());
    return { objects, changes, procs, admin, summary: g.roleFull ? `Holders get everything (includes %All)${summary ? ` · ${summary}` : ''}` : summary };
  };
  const hasGrants = (g: Grantee): boolean => {
    if (g.full || g.roleFull) return true;
    const s = granteeStats(g);
    return s.objects + s.procs + s.admin > 0;
  };

  /* ── Toolbar ───────────────────────────────────────────── */

  const renderScope = (): void => {
    if (tab === 'who') {
      const n = (s: WhoScope): number => grantees.filter((g) => inWho(g, s)).length;
      const opt = (value: WhoScope, label: string): { value: WhoScope; label: string; disabled: boolean } =>
        ({ value, label: `${label} ${n(value)}`, disabled: n(value) === 0 && whoScope !== value });
      setChips(scopeEl, grantees.length, [opt('granted', 'With access'), opt('users', 'Users'), opt('roles', 'Roles'), opt('all', 'All')], { active: whoScope, search: searchEl, query });
    } else {
      const idx = byObject();
      const ev = everyoneObjects();
      const n = catalog.filter((o) => idx.has(objKey(o.Type, o.Object)) || ev.has(objKey(o.Type, o.Object))).length;
      setChips(scopeEl, catalog.length, [
        { value: 'granted', label: `With grants ${n}`, disabled: n === 0 && objScope !== 'granted' },
        { value: 'all', label: `All ${catalog.length}`, disabled: catalog.length === 0 && objScope !== 'all' },
      ], { active: objScope, search: searchEl, query });
    }
    sysEl.hidden = tab !== 'objects';
    searchEl.setAttribute('placeholder', tab === 'who' ? 'Filter users and roles' : 'Filter tables, views and procedures');
  };
  const inWho = (g: Grantee, s: WhoScope): boolean =>
    s === 'all' || (s === 'users' ? g.kind === 'User' : s === 'roles' ? g.kind === 'Role' : hasGrants(g));

  /* ── Grid ──────────────────────────────────────────────── */

  /** %All holders first (UnknownUser at the very top), then everyone else by name. */
  const pinRank = (g: Grantee): number => (g.full && g.name === ANON_USER ? 0 : g.full ? 1 : g.roleFull ? 2 : 3);
  const whoRows = (): DataGridRow[] => grantees.filter((g) => inWho(g, whoScope)).filter((g) => !query || g.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => pinRank(a) - pinRank(b) || a.name.localeCompare(b.name)).map((g): DataGridRow => {
      if (g.full || g.roleFull) {
        const anon = g.name === ANON_USER;
        // The SQL access cell says it once; the counts stay blank rather than repeating "All" four times.
        const label = anon ? 'Anyone · everything' : 'Everything via %All';
        return { Name: g.name, Kind: g.kind, Full: true, Anon: anon, RoleFull: !g.full && g.roleFull, Summary: label, Objects: '—', Changes: '—', Procs: '—', Admin: '—', NoWayIn: false, NoWayInWhy: '' };
      }
      const s = granteeStats(g);
      const w = g.kind === 'User' && hasGrants(g) ? wayIn(g.name) : null;
      return {
        Name: g.name, Kind: g.kind, Full: false, Anon: false, Summary: g.error ? 'Couldn’t load' : s.summary, Objects: s.objects, Changes: s.changes, Procs: s.procs, Admin: s.admin,
        NoWayIn: !!w && !w.ok, NoWayInWhy: w?.why ?? '',
      };
    });

  /** Can this user reach SQL in the namespace at all (the resource side)? */
  const wayIn = (user: string): { ok: boolean; why: string } => {
    if (!graph) return { ok: true, why: '' };
    const u = graph.userList.find((x) => x.Name === user);
    if (u && !u.Enabled) return { ok: false, why: 'The account is disabled.' };
    const svc = graph.services.find((x) => x.Name === '%Service_Bindings');
    if (svc && !svc.Enabled) return { ok: false, why: 'The SQL way in (%Service_Bindings) is turned off.' };
    if (!graph.check(user, '%Service_SQL', 'U').ok) return { ok: false, why: 'No Use on %Service_SQL, so they can’t connect with SQL.' };
    const miss = namespaceChecks(graph, user, ns).find((c) => c.check && !c.check.ok);
    if (miss?.check) return { ok: false, why: `No Read on ${miss.check.resource} (the ${miss.db} database), so they can’t enter ${ns}.` };
    return { ok: true, why: '' };
  };
  const objRows = (): DataGridRow[] => {
    const idx = byObject();
    const ev = everyoneObjects();
    const ql = query.toLowerCase();
    return catalog.filter((o) => {
      const k = objKey(o.Type, o.Object);
      if (objScope === 'granted' && !idx.has(k) && !ev.has(k)) return false;
      return !ql || o.Object.toLowerCase().includes(ql);
    }).map((o) => {
      const k = objKey(o.Type, o.Object);
      const holders = idx.get(k) ?? [];
      const names = new Map<string, Set<string>>();
      for (const h of holders) { const s = names.get(h.g.name) ?? new Set<string>(); h.line.actions.forEach((a) => s.add(a)); if (h.line.columns) s.add('col'); names.set(h.g.name, s); }
      const readers = [...names.values()].filter((s) => s.has('SELECT') || s.has('EXECUTE') || s.has('USE') || s.has('col')).length;
      const changers = [...names.values()].filter((s) => CHANGE_ACTIONS.some((a) => s.has(a))).length;
      const roles = [...names.keys()].filter((n) => granteeOf(n)?.kind === 'Role').sort();
      const users = [...names.keys()].filter((n) => granteeOf(n)?.kind === 'User' && n !== PUBLIC_USER).sort();
      const everyone = ev.has(k);
      const who = [...(everyone ? ['Everyone (PUBLIC)'] : []), ...roles, ...users];
      return {
        Key: k, Object: o.Object, Type: o.Type, TypeWord: typeWord(o.Type), Proc: isProc(o.Type),
        Everyone: everyone && !holders.some((h) => h.g.name !== PUBLIC_USER), EveryoneAny: everyone,
        Readers: readers, Changers: changers,
        Who: who.join(', '), WhoList: [...roles.map((n) => `R:${n}`), ...users.map((n) => `U:${n}`)].join('\n'),
      };
    });
  };

  const applyColumns = (): void => {
    if (!grid) return;
    const cols = tab === 'who' ? WHO_COLUMNS : OBJ_COLUMNS;
    const sec = tab === 'who' ? WHO_SECONDARY : OBJ_SECONDARY;
    for (const c of cols) grid.setColumnVisible(c.key, !(panel.open && sec.includes(c.key)));
  };
  const setPanel = (open: boolean): void => { if (panel.open === open) return; panel.open = open; applyColumns(); };
  const close = (): void => { endEdit(); selected = null; grid?.select([]); setPanel(false); };

  const renderGrid = (): void => {
    if (!loaded) return;
    const rows = tab === 'who' ? whoRows() : objRows();
    if (!grid || gridTab !== tab) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', tab === 'who' ? 'Name' : 'Key');
      // By user or role: rows arrive pinned (%All holders first), so no initial sort.
      if (tab === 'objects') { grid.setAttribute('sort-column', 'Object'); grid.setAttribute('sort-direction', 'asc'); }
      grid.setAttribute('aria-label', tab === 'who' ? 'Users and roles' : 'Tables, views and procedures');
      grid.columns = tab === 'who' ? WHO_COLUMNS : OBJ_COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const row = (e as CustomEvent<{ row: DataGridRow }>).detail.row;
        const key = String(tab === 'who' ? row.Name : row.Key);
        if (key === selected && !editor) return;
        void guard().then((ok) => {
          if (!ok) { grid?.select(selected ? [selected] : []); return; }
          endEdit();
          selected = key;
          renderDetail();
        });
      });
      wrap.appendChild(grid);
      gridTab = tab;
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.grid-empty, .empty-std')?.remove();
    if (rows.length) return;
    if (!query && tab === 'objects' && objScope === 'granted') {
      wrap.insertAdjacentHTML('beforeend', emptyState({
        icon: 'info', title: `No SQL grants in ${ns}`,
        what: 'Only accounts with %All can use its tables through SQL.',
        why: 'Grant a role access to a table, then give the role to the people who need it.',
      }));
    } else {
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">Nothing matches${query ? ` “${esc(query)}”` : ''}.</div>`);
    }
  };

  const renderFoot = (): void => {
    const foot = $('#sql-foot');
    if (!loaded) { foot.innerHTML = ''; return; }
    // The same three numbers as the "With SQL access" filter, so they always add up.
    const withGrants = grantees.filter((g) => !g.full && !g.roleFull && hasGrants(g)).length;
    const full = grantees.filter((g) => g.full || g.roleFull).length;
    const noWay = grantees.filter((g) => g.kind === 'User' && !g.full && !g.roleFull && hasGrants(g) && !wayIn(g.name).ok).length;
    if (tab === 'objects') {
      const idx = byObject();
      const ev = everyoneObjects();
      const granted = catalog.filter((o) => { const k = objKey(o.Type, o.Object); return idx.has(k) || ev.has(k); }).length;
      foot.innerHTML = catalog.length ? `<b>${num(granted)}</b> with grants<span class="meta-sep">·</span><b>${num(catalog.length)}</b> tables, views and procedures` : '';
      return;
    }
    foot.innerHTML = withGrants + full ? `<b>${withGrants + full}</b> with SQL access<span class="meta-sep">·</span><b>${full}</b> through %All<span class="meta-sep">·</span><b>${num(catalog.length)}</b> tables${noWay ? `<span class="meta-sep">·</span><b>${noWay}</b> without a way in` : ''}` : '';
  };

  /* ── Detail: a user or role ────────────────────────────── */

  const head = (kicker: string, name: string, mono = true): string => `
    <header class="detail-head">
      <div class="detail-title"><span class="detail-kicker">${esc(kicker)}</span><h2${mono ? ' class="mono"' : ''}>${esc(name)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="sql-close"></ev-icon-button>
    </header>`;

  /** "Before SQL privileges apply": the resource side, for a user. */
  const gateHtml = (user: string): string => {
    if (!graph) return '';
    const g = graph;
    const svc = g.check(user, '%Service_SQL', 'U');
    const nsc = namespaceChecks(g, user, ns);
    const line = (ok: boolean | null, title: string, why: string): string =>
      `<li class="check-line check-line--${ok === null ? 'info' : ok ? 'yes' : 'no'}"><ev-icon name="${ok === null ? 'info' : ok ? 'check' : 'x'}" size="sm"></ev-icon><div><strong>${esc(title)}</strong><span>${esc(why)}</span></div></li>`;
    const src = (c: ReturnType<SecurityGraph['check']>): string => {
      if (!c.ok) return c.suggestions.length ? `Not granted. Roles that give it: ${c.suggestions.join(', ')}.` : 'Not granted.';
      if (c.source === 'all') return 'Through %All.';
      const s = c.source;
      if (!s) return 'Granted.';
      if (s.kind === 'public') return 'Everyone can (public).';
      if (s.kind === 'everyone-user') return `Every user can, through ${PUBLIC_USER}.`;
      if (s.kind === 'role') return `Through ${s.path.join(' → ')}.`;
      return 'Granted.';
    };
    const u = g.userList.find((x) => x.Name === user);
    const bindings = g.services.find((x) => x.Name === '%Service_Bindings');
    return `<h3 class="detail-section">Can ${esc(user)} reach SQL in ${esc(ns)}?</h3>
      <p class="detail-para">${esc(MODEL_NOTE)}</p>
      <ul class="check-list">
        ${u && !u.Enabled ? line(false, 'Account is disabled', 'Nothing below applies until it’s enabled.') : ''}
        ${bindings ? line(bindings.Enabled, bindings.Enabled ? 'The SQL way in is on' : 'The SQL way in is off', `%Service_Bindings carries ODBC and JDBC connections.`) : ''}
        ${line(svc.ok, 'Connect with SQL (ODBC, JDBC)', `Needs Use on %Service_SQL. ${src(svc)}`)}
        ${nsc.map((c) => line(c.check ? c.check.ok : null, `${c.label}`, c.check ? `Needs Read on ${c.check.resource} (${c.db} database). ${src(c.check)}` : `The ${c.db} database has no resource.`)).join('')}
      </ul>
      <p class="detail-para"><a class="link sql-inline" href="#/security/services">Open Services</a> to see how the SQL way in is set up. Embedded SQL in class code doesn’t check SQL privileges; ODBC, JDBC, the SQL shell and dynamic SQL do.</p>`;
  };

  /** Lines for one group (tables & views / procedures / other). */
  const lineGroups = new Map<string, Line[]>();
  const lineList = (g: Grantee, lines: Line[], revocable: boolean, group: string): string => { lineGroups.set(group, lines); return `<ul class="sql-lines" data-group="${group}">${lines.map((l, i) => {
    const v = viaWords(l.via, l.object);
    const canRevoke = revocable && canSecure && (v.kind === 'direct' || v.kind === 'schema');
    const colKey = `${g.name}${SEP}${l.object}`;
    const cols = l.columns ? columnCache.get(colKey) : undefined;
    const why = v.kind === 'role'
      ? `through role <button type="button" class="link sql-inline" data-grantee="${esc(v.role ?? '')}">${esc(v.role ?? '')}</button>`
      : esc(v.text);
    return `<li class="sql-line">
      <div class="sql-line-main">${objectLink(l.type, l.object)}${l.actions.length ? actChips(l.actions, l.grantOption) : ''}</div>
      <div class="sql-line-why">${l.actions.length ? why : ''}${l.grantOption.length ? `${l.actions.length ? ' · ' : ''}can pass ${esc(listWords(l.grantOption.map(actionShort).map((x) => x.toLowerCase())))} on to others` : ''}</div>
      ${l.columns ? `<div class="sql-cols" data-cols="${esc(colKey)}">${cols ? columnsHtml(l, cols) : '<span class="dim">Some columns: loading…</span>'}</div>` : ''}
      ${canRevoke ? `<button type="button" class="btn btn--sm btn--quiet sql-revoke" data-line="${i}">${v.kind === 'schema' ? 'Revoke schema grant' : 'Revoke'}</button>` : ''}
    </li>`;
  }).join('')}</ul>`; };

  const columnsHtml = (l: Line, cols: SqlColumnPriv[]): string => {
    if (!cols.length) return '<span class="dim">Column grants: none found</span>';
    const byAct = new Map<string, SqlColumnPriv[]>();
    for (const c of cols) { const a = byAct.get(c.Action) ?? []; a.push(c); byAct.set(c.Action, a); }
    return `<span class="sql-cols-head">Only some columns:</span><ul class="sql-col-list">${sortActions([...byAct.keys()]).map((a) => (byAct.get(a) ?? []).map((c) => {
      const direct = c.GrantedVia === 'Direct';
      return `<li>${actChips([a], c.GrantOption ? [a] : [])}<span class="mono">${esc(c.Column)}</span><span class="dim">${esc(viaWords(c.GrantedVia, l.object).text)}</span>${direct && canSecure ? `<button type="button" class="crud-icon-btn sql-col-revoke" data-col="${esc(c.Column)}" data-act="${esc(a)}" data-obj="${esc(objKey(l.type, l.object))}" aria-label="Revoke ${esc(actionShort(a))} on column ${esc(c.Column)}" title="Revoke"><ev-icon name="x" size="xs"></ev-icon></button>` : ''}</li>`;
    }).join('')).join('')}</ul>`;
  };

  const renderGranteeDetail = (name: string): void => {
    const g = granteeOf(name);
    if (!g) { close(); return; }
    const kicker = g.kind === 'User' ? 'User · SQL privileges' : 'Role · SQL privileges';
    const held = g.kind === 'Role' && graph ? graph.holders(name) : null;
    const heldN = held ? held.direct.length + held.inherited.length : 0;
    const actions = `<div class="detail-actions sec-actions">
        ${canSecure ? '<button type="button" class="btn btn--sm" id="sql-grant-here"><ev-icon name="plus" size="xs"></ev-icon>Grant…</button>' : ''}
        <button type="button" class="btn btn--sm" id="sql-open-sec">${g.kind === 'User' ? 'Open user' : 'Open role'}</button>
        ${moreButton('sql-more', `More actions for ${name}`)}
      </div>${canSecure ? '' : `<p class="detail-note">${esc(NO_SECURE)}</p>`}`;
    const stateChips = [
      g.kind === 'User' && graph && !graph.userList.find((u) => u.Name === name)?.Enabled ? chip('Disabled', 'neutral') : '',
      g.full ? chip('Everything (%All)', 'warning', 'Holds %All') : '',
      g.roleFull ? chip('Includes %All', 'warning', 'Holders get full access') : '',
      name === ANON_USER ? chip('Anyone can connect', 'warning', 'UnknownUser is the account used for No sign-in connections') : '',
      name === PUBLIC_USER ? chip('Every user', 'info') : '',
    ].filter(Boolean).join('');
    let body = '';
    if (g.full) {
      const anon = name === ANON_USER;
      body = `${callout(anon ? 'danger' : 'warning', anon ? 'Anyone can connect and read and change every table.' : `${name} can do everything in SQL.`,
        esc(`${name} holds %All, so IRIS treats them as a SQL superuser: every privilege on every table, view and procedure, in every namespace. Specific grants make no difference while that’s true.${anon ? ' UnknownUser is the account used by No sign-in connections.' : ''}`))}
        ${g.kind === 'User' ? gateHtml(name) : ''}`;
    } else {
      const { lines, everyone } = linesOf(g.privs);
      const tv = lines.filter((l) => !isProc(l.type) && l.type !== 'ML CONFIGURATION');
      const procs = lines.filter((l) => isProc(l.type));
      const other = lines.filter((l) => l.type === 'ML CONFIGURATION');
      const direct = g.kind === 'User' && lines.some((l) => l.via === 'Direct');
      const empty = !lines.length && !g.admin.length;
      body = `
        ${g.error ? callout('warning', 'Couldn’t load everything', esc(g.error)) : ''}
        ${g.roleFull ? callout('warning', 'This role includes %All', 'Everyone holding it can do everything in SQL, whatever is listed here.') : ''}
        ${g.kind === 'Role' ? `<p class="detail-para">${heldN ? `${plural(heldN, 'user holds', 'users hold')} this role and get${heldN === 1 ? 's' : ''} everything below.` : 'No user holds this role yet, so nobody gets these privileges through it.'} ${esc(MODEL_NOTE)}</p>` : ''}
        ${g.kind === 'User' && !empty && !g.roleFull && !wayIn(name).ok ? callout('warning', 'Has grants but no way in', `${esc(wayIn(name).why)} The grants below do nothing until that’s fixed.`) : ''}
        ${g.kind === 'User' ? gateHtml(name) : ''}
        ${direct ? callout('info', 'Some privileges are granted to this user directly', 'InterSystems recommends granting to roles and giving people the role: it’s easier to see and change who can do what.') : ''}
        ${empty ? `<h3 class="detail-section">In SQL</h3><p class="chip-list-empty">No SQL privileges in ${esc(ns)}${everyone.length ? ', apart from the built-in ones everyone has' : ''}.</p>` : ''}
        ${tv.length ? `<h3 class="detail-section">Tables and views <span class="acc-count">${tv.length}</span></h3>${lineList(g, tv, true, 'tv')}` : ''}
        ${procs.length ? `<h3 class="detail-section">Procedures <span class="acc-count">${procs.length}</span></h3>${lineList(g, procs, true, 'procs')}` : ''}
        ${other.length ? `<h3 class="detail-section">Machine learning</h3>${lineList(g, other, true, 'other')}` : ''}
        ${g.admin.length ? `<h3 class="detail-section">Admin privileges <span class="acc-count">${g.admin.length}</span></h3>
          <ul class="sql-lines">${g.admin.map((a) => {
            const v = viaWords(a.GrantedVia);
            return `<li class="sql-line"><div class="sql-line-main"><span>${esc(adminText(a.Privilege))}</span><span class="sql-code">${esc(a.Privilege)}</span></div>
              <div class="sql-line-why">${v.kind === 'role' ? `through role <button type="button" class="link sql-inline" data-grantee="${esc(v.role ?? '')}">${esc(v.role ?? '')}</button>` : esc(v.text)}${a.GrantOption ? ' · can pass it on' : ''}</div>
              ${v.kind === 'direct' && canSecure ? `<button type="button" class="btn btn--sm btn--quiet sql-admin-revoke" data-priv="${esc(a.Privilege)}">Revoke</button>` : ''}</li>`;
          }).join('')}</ul>` : ''}
        ${everyone.length ? `<details class="gain-toggle"><summary>Built-in procedures everyone can run (${everyone.length})</summary>${lineList(g, everyone, false, 'everyone')}</details>` : ''}`;
    }
    detail.innerHTML = `${head(kicker, name)}<div class="detail-state">${stateChips}</div>${actions}${body}`;
    wireGrantee(g);
    // Column-level grants load on demand.
    if (!g.full) {
      for (const l of linesOf(g.privs).lines.filter((x) => x.columns)) {
        const key = `${g.name}${SEP}${l.object}`;
        if (columnCache.has(key)) continue;
        void getColumnPrivs(g.name, ns, l.object).catch(() => [] as SqlColumnPriv[]).then((cols) => {
          columnCache.set(key, cols);
          if (selected === g.name && tab === 'who' && !editor) renderDetail(true);
        });
      }
    }
  };

  const wireGrantee = (g: Grantee): void => {
    detail.querySelector('#sql-close')?.addEventListener('click', close);
    detail.querySelector('#sql-grant-here')?.addEventListener('click', () => openGrant({ grantee: g.name }));
    detail.querySelector('#sql-open-sec')?.addEventListener('click', () => void guard().then((ok) => { if (ok) linkTo(ctx.navigate, g.kind === 'User' ? 'security/users' : 'security/roles', g.name); }));
    wireCommon();
    const { lines } = linesOf(g.privs);
    detail.querySelectorAll<HTMLUListElement>('.sql-lines[data-group]').forEach((ul) => {
      const list = lineGroups.get(ul.dataset.group ?? '');
      if (!list) return;
      ul.querySelectorAll<HTMLButtonElement>('.sql-revoke').forEach((b) => b.addEventListener('click', () => void revokeLine(g, list[Number(b.dataset.line)])));
    });
    detail.querySelectorAll<HTMLButtonElement>('.sql-admin-revoke').forEach((b) => b.addEventListener('click', () => void revokeAdminPriv(g, b.dataset.priv ?? '')));
    detail.querySelectorAll<HTMLButtonElement>('.sql-col-revoke').forEach((b) => b.addEventListener('click', () => {
      const { type, object } = splitKey(b.dataset.obj ?? '');
      void revokeCol(g, type, object, b.dataset.col ?? '', b.dataset.act ?? '');
    }));
    const more = detail.querySelector<HTMLElement>('#sql-more');
    menu?.destroy(); menu = null;
    if (more) {
      const directLines = lines.filter((l) => l.via === 'Direct' || l.via === 'Schema Privilege');
      const directAdmin = g.admin.filter((a) => a.GrantedVia === 'Direct');
      const n = directLines.length + directAdmin.length;
      const items: MenuItem[] = [
        { label: 'Grant an admin privilege…', icon: 'plus', disabled: !canSecure, reason: canSecure ? undefined : NO_SECURE, onSelect: () => openGrant({ grantee: g.name, kind: 'admin' }) },
        { label: 'Revoke everything granted directly…', icon: 'trash-2', danger: true,
          disabled: !canSecure || g.full || n === 0,
          reason: !canSecure ? NO_SECURE : g.full ? 'Holds %All: there are no specific grants to revoke.' : 'Nothing is granted to it directly in this namespace.',
          onSelect: () => void revokeAll(g, directLines, directAdmin) },
      ];
      menu = moreMenu(more, items);
    }
  };

  /** Links shared by both detail kinds: grantee chips and object names. */
  const wireCommon = (): void => {
    detail.querySelectorAll<HTMLButtonElement>('[data-grantee]').forEach((b) => b.addEventListener('click', () => void showGrantee(b.dataset.grantee ?? '')));
    detail.querySelectorAll<HTMLButtonElement>('.sql-objlink[data-obj]').forEach((b) => b.addEventListener('click', () => void showObject(b.dataset.obj ?? '')));
  };

  /* ── Detail: a table, view or procedure ────────────────── */

  const renderObjectDetail = (key: string): void => {
    const { type, object } = splitKey(key);
    const holders = byObject().get(key) ?? [];
    const everyone = everyoneObjects().has(key);
    const full = allHolders();
    const anonFull = full.includes(ANON_USER);
    const roles = holders.filter((h) => h.g.kind === 'Role');
    const users = holders.filter((h) => h.g.kind === 'User');
    const proc = isProc(type);
    const readers = new Set(holders.filter((h) => h.line.actions.some((a) => a === 'SELECT' || a === 'EXECUTE' || a === 'USE') || h.line.columns).map((h) => h.g.name));
    const changers = new Set(holders.filter((h) => h.line.actions.some((a) => CHANGE_ACTIONS.includes(a))).map((h) => h.g.name));
    const holderLine = (h: { g: Grantee; line: Line }): string => {
      const v = viaWords(h.line.via, object);
      const canRevoke = canSecure && (v.kind === 'direct' || v.kind === 'schema');
      const why = v.kind === 'role' ? `through role <button type="button" class="link sql-inline" data-grantee="${esc(v.role ?? '')}">${esc(v.role ?? '')}</button>` : esc(v.text);
      return `<li class="sql-line">
        <div class="sql-line-main">${granteeChip(h.g.name, h.g.kind)}${h.line.actions.length ? actChips(h.line.actions, h.line.grantOption) : ''}</div>
        <div class="sql-line-why">${why}${h.line.grantOption.length ? ' · can pass it on' : ''}</div>
        ${canRevoke ? `<button type="button" class="btn btn--sm btn--quiet sql-revoke-h" data-g="${esc(h.g.name)}" data-via="${esc(h.line.via)}">${v.kind === 'schema' ? 'Revoke schema grant' : 'Revoke'}</button>` : ''}
      </li>`;
    };
    const verbRead = proc ? 'run it' : 'read it';
    const summary = holders.length
      ? `${plural(readers.size, proc ? 'user or role can' : 'user or role can', 'users and roles can')} ${verbRead}${proc ? '' : `; ${changers.size} can change it`}${full.length ? `, plus ${plural(full.length, 'account')} with %All` : ''}.`
      : everyone ? 'Every user can run it: it’s built in.' : `Nobody has been granted anything on it. Only ${plural(full.length, 'account')} with %All can use it through SQL.`;
    detail.innerHTML = `${head(typeWord(type), object)}
      <div class="detail-state">${chip(typeWord(type), 'neutral')}<span class="dim">in schema ${esc(schemaOf(object))} · ${esc(ns)}</span></div>
      <div class="detail-actions sec-actions">
        ${canSecure ? '<button type="button" class="btn btn--sm" id="sql-grant-obj"><ev-icon name="plus" size="xs"></ev-icon>Grant access…</button>' : ''}
        ${moreButton('sql-more', `More actions for ${object}`)}
      </div>${canSecure ? '' : `<p class="detail-note">${esc(NO_SECURE)}</p>`}
      <p class="acc-headline">${esc(summary)}</p>
      <p class="detail-para">${esc(MODEL_NOTE)}</p>
      ${anonFull ? callout('danger', 'Anyone can connect and use it', 'UnknownUser holds %All, so No sign-in SQL connections get every privilege.') : ''}
      ${roles.length ? `<h3 class="detail-section">Roles <span class="acc-count">${new Set(roles.map((r) => r.g.name)).size}</span></h3><ul class="sql-lines" data-group="roles">${roles.map(holderLine).join('')}</ul>` : ''}
      ${users.length ? `<h3 class="detail-section">Users <span class="acc-count">${new Set(users.map((r) => r.g.name)).size}</span></h3><ul class="sql-lines" data-group="users">${users.map(holderLine).join('')}</ul>` : ''}
      ${everyone ? `<h3 class="detail-section">Everyone</h3><p class="detail-para">IRIS lets every user run this procedure; it isn’t a grant you can revoke here.</p>` : ''}
      ${full.length ? `<h3 class="detail-section">Everything, through %All <span class="acc-count">${full.length}</span></h3>
        <div class="chip-list">${full.map((n) => granteeChip(n, 'User', 'Holds %All')).join('')}</div>` : ''}`;
    detail.querySelector('#sql-close')?.addEventListener('click', close);
    detail.querySelector('#sql-grant-obj')?.addEventListener('click', () => openGrant({ type: type as SqlObjectType, object }));
    wireCommon();
    detail.querySelectorAll<HTMLButtonElement>('.sql-revoke-h').forEach((b) => b.addEventListener('click', () => {
      const h = holders.find((x) => x.g.name === b.dataset.g && x.line.via === b.dataset.via);
      if (h) void revokeLine(h.g, h.line);
    }));
    const more = detail.querySelector<HTMLElement>('#sql-more');
    menu?.destroy(); menu = null;
    if (more) {
      menu = moreMenu(more, [
        { label: `Grant on the whole ${schemaOf(object)} schema…`, icon: 'plus', disabled: !canSecure, reason: canSecure ? undefined : NO_SECURE,
          onSelect: () => openGrant({ type: 'SCHEMA', object: schemaOf(object) }) },
        { label: `Show only the ${schemaOf(object)} schema`, icon: 'eye', onSelect: () => { searchEl.value = `${schemaOf(object)}.`; query = `${schemaOf(object)}.`; renderGrid(); } },
      ]);
    }
  };

  const renderDetail = (quiet = false): void => {
    if (editor) return;
    if (selected === null || !loaded) { setPanel(false); return; }
    const top = detail.scrollTop;
    if (tab === 'who') renderGranteeDetail(selected); else renderObjectDetail(selected);
    if (selected !== null) setPanel(true);
    if (quiet) detail.scrollTop = top; else scrollPanelTop(detail);
  };

  /** Jump to a grantee, switching to that view. */
  const showGrantee = async (name: string): Promise<void> => {
    if (!granteeOf(name)) {
      if (graph?.userList.some((u) => u.Name === name)) linkTo(ctx.navigate, 'security/users', name);
      else if (graph?.roleList.some((r) => r.Name === name)) linkTo(ctx.navigate, 'security/roles', name);
      return;
    }
    if (!(await guard())) return;
    endEdit();
    if (tab !== 'who') setTab('who');
    if (!inWho(granteeOf(name) as Grantee, whoScope)) { whoScope = 'all'; renderScope(); }
    query = ''; searchEl.value = '';
    selected = name;
    renderGrid();
    renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };
  const showObject = async (key: string): Promise<void> => {
    if (!(await guard())) return;
    endEdit();
    if (tab !== 'objects') setTab('objects');
    query = ''; searchEl.value = '';
    if (!catalog.some((o) => objKey(o.Type, o.Object) === key)) {
      const { type, object } = splitKey(key);
      catalog = [...catalog, { Type: type, Object: object, Schema: schemaOf(object) }];
    }
    if (objScope === 'granted' && !byObject().has(key) && !everyoneObjects().has(key)) { objScope = 'all'; renderScope(); }
    selected = key;
    renderGrid();
    renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  /* ── Revoke ────────────────────────────────────────────── */

  const impactFor = (g: Grantee): string => {
    if (g.kind === 'User') return g.name === PUBLIC_USER ? 'Every user loses it, unless they have it another way.' : g.name === ANON_USER ? 'No sign-in connections lose it.' : `${g.name} loses it unless they have it another way (for example through a role).`;
    const h = graph?.holders(g.name);
    const n = h ? h.direct.length + h.inherited.length : 0;
    return n ? `${plural(n, 'user holds', 'users hold')} ${g.name}; they lose it too, unless they have it another way.` : `No user holds ${g.name}, so nobody loses access right now.`;
  };

  async function revokeLine(g: Grantee, l: Line): Promise<void> {
    const schema = l.via === 'Schema Privilege';
    const target = schema ? schemaOf(l.object) : l.object;
    const type: SqlObjectType = schema ? 'SCHEMA' : l.type as SqlObjectType;
    // For a schema grant, revoke what this grantee holds through it (same on every table of the schema).
    const actions = l.actions;
    const what = schema ? `every table in the ${target} schema` : target;
    const opt = l.grantOption.length > 0;
    const ok = await confirm({
      title: `Revoke ${g.name}’s access to ${what}?`,
      body: `<p><b class="mono">${esc(g.name)}</b> will no longer be able to ${esc(listWords(actions.map((a) => actionLong(a).replace(/ \(.*\)$/, '').toLowerCase())))} on <b class="mono">${esc(what)}</b>${schema ? ', or on tables added to the schema later' : ''}.</p>
        <p>${esc(impactFor(g))}</p>
        ${opt ? '<p>To keep their access but stop them passing it on, remove only the grant option instead.</p>' : ''}`,
      confirmLabel: 'Revoke',
      danger: true,
      alternative: opt ? { label: 'Remove only the grant option', onSelect: () => void doRevoke(g, { type, object: target, actions: l.grantOption, grantOptionOnly: true }) } : undefined,
    });
    if (ok) await doRevoke(g, { type, object: target, actions });
  }
  async function doRevoke(g: Grantee, r: { type: SqlObjectType; object: string; actions: string[]; grantOptionOnly?: boolean }): Promise<void> {
    try {
      await revokeObject({ ns, grantee: g.name, type: r.type, object: r.object, actions: r.actions, grantOptionOnly: r.grantOptionOnly });
      toast(r.grantOptionOnly ? `${g.name} can no longer pass on access to ${r.object}.` : `Revoked ${g.name}’s access to ${r.object}.`);
      await reload();
    } catch (err) { toast(errorText(err), 'danger'); }
  }
  async function revokeCol(g: Grantee, type: string, object: string, column: string, action: string): Promise<void> {
    const ok = await confirm({
      title: `Revoke ${actionShort(action)} on ${object}.${column}?`,
      body: `<p><b class="mono">${esc(g.name)}</b> will no longer be able to ${esc(actionLong(action).replace(/ \(.*\)$/, '').toLowerCase())} in column <b class="mono">${esc(column)}</b> of <b class="mono">${esc(object)}</b>.</p><p>${esc(impactFor(g))}</p>`,
      confirmLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    try {
      await revokeColumn({ ns, grantee: g.name, type: type === 'VIEW' ? 'VIEW' : 'TABLE', object, column, action });
      columnCache.delete(`${g.name}${SEP}${object}`);
      toast(`Revoked ${actionShort(action)} on ${object}.${column} from ${g.name}.`);
      await reload();
    } catch (err) { toast(errorText(err), 'danger'); }
  }
  async function revokeAdminPriv(g: Grantee, priv: string): Promise<void> {
    const ok = await confirm({
      title: `Revoke ${priv} from ${g.name}?`,
      body: `<p><b class="mono">${esc(g.name)}</b> will no longer be able to ${esc(adminText(priv).toLowerCase())} in ${esc(ns)}.</p><p>${esc(impactFor(g))}</p>`,
      confirmLabel: 'Revoke', danger: true,
    });
    if (!ok) return;
    try {
      await revokeAdmin(ns, g.name, priv);
      toast(`Revoked ${priv} from ${g.name}.`);
      await reload();
    } catch (err) { toast(errorText(err), 'danger'); }
  }
  async function revokeAll(g: Grantee, lines: Line[], admin: SqlAdminPriv[]): Promise<void> {
    const objs = new Set(lines.map((l) => (l.via === 'Schema Privilege' ? `${schemaOf(l.object)} schema` : l.object)));
    const ok = await confirm({
      title: `Revoke everything granted to ${g.name}?`,
      body: `<p>Revokes ${esc(g.name)}’s direct grants in ${esc(ns)}: access to <b>${plural(objs.size, 'object')}</b>${admin.length ? ` and <b>${plural(admin.length, 'admin privilege')}</b>` : ''}. Privileges it gets through roles are left alone.</p><p>${esc(impactFor(g))}</p>`,
      confirmLabel: 'Revoke all', danger: true, typeToConfirm: g.name,
    });
    if (!ok) return;
    const done = new Set<string>();
    let failed = 0;
    for (const l of lines) {
      const schema = l.via === 'Schema Privilege';
      const object = schema ? schemaOf(l.object) : l.object;
      const k = `${schema ? 'SCHEMA' : l.type}${SEP}${object}`;
      if (done.has(k)) continue;
      done.add(k);
      try { await revokeObject({ ns, grantee: g.name, type: (schema ? 'SCHEMA' : l.type) as SqlObjectType, object, actions: l.actions }); } catch { failed++; }
    }
    for (const a of admin) { try { await revokeAdmin(ns, g.name, a.Privilege); } catch { failed++; } }
    toast(failed ? `Revoked most of ${g.name}’s grants; ${failed} couldn’t be revoked.` : `Revoked everything granted directly to ${g.name} in ${ns}.`, failed ? 'warning' : 'success');
    await reload();
  }

  /* ── Grant form ────────────────────────────────────────── */

  const granteeOptions = (): Array<{ value: string; label: string }> => {
    const users = (graph?.userList ?? []).map((u) => ({ value: u.Name, label: `${u.Name} (user${u.Name === PUBLIC_USER ? ': every user' : u.Name === ANON_USER ? ': No sign-in connections' : ''})` }));
    const roles = (graph?.roleList ?? []).map((r) => ({ value: r.Name, label: `${r.Name} (role)` }));
    return [...roles, ...users];
  };
  const objectOptions = (type: SqlObjectType): Array<{ value: string; label: string }> => {
    if (type === 'SCHEMA') return [...new Set(catalog.filter((o) => o.Type === 'TABLE' || o.Type === 'VIEW').map((o) => o.Schema))].sort().map((s) => ({ value: s, label: s }));
    return catalog.filter((o) => o.Type === type).map((o) => ({ value: o.Object, label: o.Object }));
  };
  const TYPE_OPTIONS: Array<{ value: SqlObjectType; label: string }> = [
    { value: 'TABLE', label: 'Table' }, { value: 'VIEW', label: 'View' }, { value: 'SCHEMA', label: 'Every table in a schema' },
    { value: 'STORED PROCEDURE', label: 'Stored procedure' }, { value: 'ML CONFIGURATION', label: 'ML configuration' },
  ];
  const actField = (a: string): string => `act_${a.replace('%', '')}`;
  const admField = (p: string): string => `adm_${p.replace('%', '')}`;

  function openGrant(pre: GrantPrefill): void {
    if (!canSecure || !loaded) return;
    endEdit();
    menu?.destroy(); menu = null;
    setPanel(true);
    restoreWidth = panelWidth(panel, EDIT_WIDTH);
    ctx.beforeLeave(() => guard());
    const startType: SqlObjectType = pre.type ?? 'TABLE';
    const kind = pre.kind ?? 'objects';
    const actRow = ACTION_ORDER.map((a) => `<div class="sql-act-field" data-act="${esc(a)}">${checkField(actField(a), actionLong(a), a === 'SELECT' && !!pre.object && !isProc(startType), {})}</div>`).join('');
    const groups = [...new Set(ADMIN_PRIVS.map((p) => p.group))];
    const adminHtml = groups.map((gname) => `<fieldset class="sql-adm-group"><legend>${esc(gname)}</legend>${ADMIN_PRIVS.filter((p) => p.group === gname).map((p) => checkField(admField(p.name), `${p.text}`, false, { hint: p.name })).join('')}</fieldset>`).join('');
    editor = editorShell(detail, {
      subtitle: `SQL privilege · ${esc(ns)}`,
      title: 'Grant privilege',
      name: 'this grant',
      submitLabel: 'Grant',
      startDirty: !!(pre.grantee || pre.object),
      sections: [
        section('Who', `${selectField('Grantee', 'User or role', [{ value: '', label: 'Choose a user or role' }, ...granteeOptions()], pre.grantee ?? '', { searchable: true, required: true })}
          <div id="sg-who-note" class="sg-note"></div>`, { hint: 'Grant to a role, then give the role to people: it’s easier to see and change who can do what.' }),
        section('What', `${selectField('Kind', 'Kind of privilege', [{ value: 'objects', label: 'Use tables, views or procedures' }, { value: 'admin', label: 'Admin privilege (create tables, bulk loading…)' }], kind)}
          <div id="sg-objects">
            ${selectField('Type', 'On', TYPE_OPTIONS, startType)}
            <div id="sg-objpick"></div>
            <div class="sg-sub">What they can do</div>
            <div class="sql-act-grid">${actRow}</div>
            <div id="sg-cols">${textField('Columns', 'Only these columns (optional)', '', { mono: true, placeholder: 'Name, DOB', hint: 'Comma-separated. Leave empty for the whole table. Only Read, Add, Change and Reference can be limited to columns.' })}</div>
          </div>
          <div id="sg-admin">${adminHtml}</div>`),
        section('Passing it on', checkField('WithGrant', 'They can grant this to others too (WITH GRANT OPTION)', false, { hint: 'Leave off unless they manage access for others.' })),
        `<div id="sg-preview" class="preview" aria-live="polite"></div>`,
      ].join(''),
      check: () => problems(),
      onCancel: () => { endEdit(); if (selected) renderDetail(); else close(); },
      onSubmit: async () => submit(),
    });
    const form = editor.form;
    const objPick = form.querySelector('#sg-objpick') as HTMLElement;
    let curType: SqlObjectType = startType;
    const mountObject = (value: string): void => {
      const opts = objectOptions(curType);
      const label = curType === 'SCHEMA' ? 'Schema' : typeWord(curType);
      objPick.innerHTML = selectField('Object', label, [{ value: '', label: opts.length ? `Choose a ${label.toLowerCase()}` : `No ${label.toLowerCase()}s in ${ns}` }, ...opts], value, { searchable: true, required: true, mono: true });
    };
    mountObject(pre.object ?? '');
    const sync = (): void => {
      const v = readForm(form);
      const k = String(v.Kind || 'objects');
      (form.querySelector('#sg-objects') as HTMLElement).hidden = k !== 'objects';
      (form.querySelector('#sg-admin') as HTMLElement).hidden = k !== 'admin';
      const t = String(v.Type || 'TABLE') as SqlObjectType;
      if (t !== curType) { curType = t; mountObject(''); }
      const allowed = TYPE_ACTIONS[curType];
      form.querySelectorAll<HTMLElement>('.sql-act-field').forEach((el) => { el.hidden = !allowed.includes(el.dataset.act ?? ''); });
      if (allowed.length === 1) {
        const only = form.querySelector(`[name="${actField(allowed[0])}"]`) as (HTMLElement & { checked: boolean }) | null;
        if (only && !only.checked) only.checked = true;
      }
      (form.querySelector('#sg-cols') as HTMLElement).hidden = !(curType === 'TABLE' || curType === 'VIEW');
      whoNote(String(v.Grantee || ''));
      preview();
    };
    const whoNote = (name: string): void => {
      const el = form.querySelector('#sg-who-note') as HTMLElement;
      const g = granteeOf(name);
      let html = '';
      if (name === PUBLIC_USER) html = '<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>Granting to _PUBLIC gives it to every user.</div></div>';
      else if (name === ANON_USER) html = '<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>UnknownUser is the account No sign-in connections use. Anyone can connect and get this.</div></div>';
      else if (g?.full) html = `<div class="crud-note"><ev-icon name="info" size="sm"></ev-icon><div>${esc(name)} holds %All and can already do everything; this grant only matters if %All is taken away.</div></div>`;
      else if (g?.kind === 'User') html = '<div class="crud-note"><ev-icon name="info" size="sm"></ev-icon><div>This grants to one person. To grant to a group, choose a role instead.</div></div>';
      else if (g?.kind === 'Role' && graph) { const h = graph.holders(name); const n = h.direct.length + h.inherited.length; html = `<p class="preview-note">${n ? `${plural(n, 'user holds', 'users hold')} ${esc(name)}.` : `No user holds ${esc(name)} yet.`}</p>`; }
      el.innerHTML = html;
    };
    const preview = (): void => {
      const el = form.querySelector('#sg-preview') as HTMLElement;
      const s = summarize();
      el.innerHTML = s ? `<p class="preview-line">${s}</p>` : '';
    };
    const summarize = (): string => {
      const v = readForm(form);
      const who = String(v.Grantee || '');
      if (!who) return '';
      if (v.Kind === 'admin') {
        const picked = ADMIN_PRIVS.filter((p) => v[admField(p.name)] === true);
        return picked.length ? `<b class="mono">${esc(who)}</b> will be able to: ${esc(picked.map((p) => p.text.toLowerCase()).join('; '))}, in ${esc(ns)}.` : '';
      }
      const obj = String(v.Object || '');
      const acts = TYPE_ACTIONS[curType].filter((a) => v[actField(a)] === true);
      if (!obj || !acts.length) return '';
      const cols = String(v.Columns || '').split(',').map((c) => c.trim()).filter(Boolean);
      const where = curType === 'SCHEMA' ? `every table and view in the <b class="mono">${esc(obj)}</b> schema, including ones added later` : `<b class="mono">${esc(obj)}</b>${cols.length ? ` (columns ${esc(cols.join(', '))} only)` : ''}`;
      return `<b class="mono">${esc(who)}</b> will be able to ${esc(listWords(acts.map((a) => actionLong(a).replace(/ \(.*\)$/, '').toLowerCase())))} on ${where}${v.WithGrant ? ', and pass that on to others' : ''}.`;
    };
    const problems = (): FieldProblem[] => {
      const v = readForm(form);
      const out: FieldProblem[] = [];
      if (!v.Grantee) out.push({ field: 'Grantee', label: 'User or role', message: 'Choose who gets it' });
      if (v.Kind === 'admin') {
        if (!ADMIN_PRIVS.some((p) => v[admField(p.name)] === true)) out.push({ field: admField(ADMIN_PRIVS[0].name), label: 'Admin privilege', message: 'Tick at least one admin privilege' });
        return out;
      }
      if (!v.Object) out.push({ field: 'Object', label: curType === 'SCHEMA' ? 'Schema' : typeWord(curType), message: `Choose a ${curType === 'SCHEMA' ? 'schema' : typeWord(curType).toLowerCase()}` });
      const acts = TYPE_ACTIONS[curType].filter((a) => v[actField(a)] === true);
      if (!acts.length) out.push({ field: actField(TYPE_ACTIONS[curType][0]), label: 'What they can do', message: 'Tick at least one thing they can do' });
      const cols = String(v.Columns || '').split(',').map((c) => c.trim()).filter(Boolean);
      if (cols.length && (curType === 'TABLE' || curType === 'VIEW')) {
        const bad = acts.filter((a) => !COLUMN_ACTIONS.includes(a));
        if (bad.length) out.push({ field: 'Columns', label: 'Columns', message: `${listWords(bad.map(actionShort))} can’t be limited to columns; untick ${bad.length === 1 ? 'it' : 'them'} or clear the columns` });
        if (cols.some((c) => /[\s;'"]/.test(c))) out.push({ field: 'Columns', label: 'Columns', message: 'Separate column names with commas' });
      }
      return out;
    };
    const submit = async (): Promise<void> => {
      const v = readForm(form);
      const who = String(v.Grantee);
      const withGrant = v.WithGrant === true;
      const risks: GuardRisk[] = [];
      if (who === PUBLIC_USER) risks.push({ title: 'This gives it to every user', text: 'Every account gets privileges granted to _PUBLIC.' });
      if (who === ANON_USER) risks.push({ title: 'Anyone can connect and get this', text: 'UnknownUser is the account No sign-in connections use.' });
      if (withGrant) risks.push({ title: `${who} could pass this on`, text: 'With the grant option they can give the same access to any other user or role.' });
      if (v.Kind === 'admin') {
        const picked = ADMIN_PRIVS.filter((p) => v[admField(p.name)] === true);
        const bulk = picked.filter((p) => p.group.startsWith('Bulk'));
        if (bulk.length) risks.push({ title: 'Some of these skip safety checks', text: `${listWords(bulk.map((p) => p.name))} let loads bypass constraints, triggers, indexes, locks or journaling, which can leave data inconsistent or unrecoverable.` });
        if (picked.some((p) => p.name === '%DROP_UNOWNED')) risks.push({ title: `${who} could drop other people’s tables`, text: '%DROP_UNOWNED allows dropping tables and views they don’t own.' });
        if (risks.length) { const d = guardDialog(risks); if (!(await confirm({ title: d.title, body: d.body, confirmLabel: 'Grant anyway', danger: true }))) throw new Error('Not granted. Review the warnings, then try again.'); }
        const failed: string[] = [];
        for (const p of picked) {
          try { await grantAdmin(ns, who, p.name, withGrant); } catch (err) { failed.push(`${p.name}: ${errorText(err)}`); }
        }
        if (failed.length === picked.length) throw new Error(failed[0].replace(/^[^:]+: /, ''));
        editor?.markClean();
        toast(failed.length ? `Granted some admin privileges to ${who}; ${failed.length} failed.` : `Granted ${plural(picked.length, 'admin privilege')} to ${who} in ${ns}.`, failed.length ? 'warning' : 'success');
      } else {
        const obj = String(v.Object);
        const acts = TYPE_ACTIONS[curType].filter((a) => v[actField(a)] === true);
        const cols = String(v.Columns || '').split(',').map((c) => c.trim()).filter(Boolean);
        if (curType === 'SCHEMA' && acts.some((a) => CHANGE_ACTIONS.includes(a))) risks.push({ title: `${who} could change every table in ${obj}`, text: 'A schema grant covers every table and view in it, including ones created later.' });
        if (acts.includes('%ALTER')) risks.push({ title: `${who} could change the definition`, text: 'ALTER lets them add, drop or change columns.' });
        if (risks.length) { const d = guardDialog(risks); if (!(await confirm({ title: d.title, body: d.body, confirmLabel: 'Grant anyway', danger: true }))) throw new Error('Not granted. Review the warnings, then try again.'); }
        if (cols.length && (curType === 'TABLE' || curType === 'VIEW')) {
          for (const c of cols) for (const a of acts) await grantColumn({ ns, grantee: who, type: curType, object: obj, column: c, action: a, withGrant });
          columnCache.delete(`${who}${SEP}${obj}`);
        } else {
          await grantObject({ ns, grantee: who, type: curType, object: obj, actions: acts, withGrant });
        }
        editor?.markClean();
        toast(`Granted ${listWords(acts.map(actionShort))} on ${curType === 'SCHEMA' ? `the ${obj} schema` : obj} to ${who}.`);
      }
      endEdit();
      await reload();
      await showGrantee(who);
    };
    for (const t of ['input', 'change', 'ev-select-change', 'ev-checkbox-change', 'ev-input-input']) form.addEventListener(t, () => queueMicrotask(sync));
    sync();
    if (pre.grantee || pre.object) queueMicrotask(() => editor?.refresh());
  }


  /* ── Loading ───────────────────────────────────────────── */

  const setTab = (next: Tab): void => {
    ctx.body.querySelectorAll<HTMLButtonElement>('#sql-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === next)));
    tab = next;
    selected = null;
    setPanel(false);
    renderScope();
    renderFoot();
  };

  const updated = liveIndicator(ctx, () => void load(true), { live: false });

  /** Fetch every grantee's privileges in the namespace. */
  async function buildIndex(g: SecurityGraph, space: string, sys: boolean): Promise<Grantee[]> {
    const people: Grantee[] = g.userList.map((u) => ({
      name: u.Name, kind: 'User' as Kind, full: !!g.userAccess(u.Name).full && u.Name !== PUBLIC_USER, roleFull: false, enabled: u.Enabled, privs: [], admin: [],
    }));
    const roles: Grantee[] = g.roleList.map((r) => ({
      name: r.Name, kind: 'Role' as Kind, full: false, roleFull: r.Name === '%All' || !!g.roleAccess(r.Name).full, enabled: true, privs: [], admin: [],
    }));
    const all = [...roles, ...people];
    await pool(all.filter((x) => !x.full), 6, async (x) => {
      try {
        [x.privs, x.admin] = await Promise.all([getObjectPrivs(x.name, space, sys), getAdminPrivs(x.name, space)]);
      } catch (err) { x.error = errorText(err); }
    });
    return all;
  }

  async function load(fresh = false): Promise<void> {
    const my = ++loadSeq;
    try {
      if (fresh) invalidateSecurityGraph();
      const g = await getSecurityGraph(fresh);
      if (!alive || my !== loadSeq) return;
      graph = g;
      const spaces = g.namespaces.map((n) => n.Name);
      if (!spaces.includes(ns) && spaces.length) ns = spaces.includes('USER') ? 'USER' : spaces[0];
      nsEl.innerHTML = spaces.map((n) => `<option value="${esc(n)}"${n === ns ? ' selected' : ''}>${esc(n)}</option>`).join('');
      nsEl.value = ns;
      const superUser = g.userList.find((u) => u.Name !== PUBLIC_USER && g.userAccess(u.Name).full)?.Name ?? null;
      const [idx, cat] = await Promise.all([buildIndex(g, ns, includeSystem), getCatalog(ns, superUser, includeSystem).catch(() => [] as SqlObject[])]);
      if (!alive || my !== loadSeq) return;
      grantees = idx.sort((a, b) => a.name.localeCompare(b.name));
      // Objects seen in grants but missing from the catalog (no %All account to ask) still get a row.
      const seen = new Set(cat.map((o) => objKey(o.Type, o.Object)));
      for (const x of grantees) for (const p of x.privs) {
        const k = objKey(p.Type, p.Object);
        if (!seen.has(k)) { seen.add(k); cat.push({ Type: p.Type, Object: p.Object, Schema: schemaOf(p.Object) }); }
      }
      catalog = cat.sort((a, b) => a.Object.localeCompare(b.Object));
      loaded = true;
      columnCache.clear();
      updated(new Date());
      setViewTabCount(ctx.body, 'sql-tabs', 'who', grantees.filter((x) => hasGrants(x)).length);
      setViewTabCount(ctx.body, 'sql-tabs', 'objects', catalog.length);
      renderScope();
      renderGrid();
      renderFoot();
      if (selected !== null) {
        const still = tab === 'who' ? !!granteeOf(selected) : catalog.some((o) => objKey(o.Type, o.Object) === selected);
        if (still) renderDetail(true); else close();
      }
    } catch (err) {
      if (my !== loadSeq) return;
      grid = null; gridTab = null;
      wrap.innerHTML = errorPanel(err, 'retry-sql');
      wrap.querySelector('#retry-sql')?.addEventListener('click', () => void load(true));
    }
  }
  /** After a write: the grants changed, the graph didn't. */
  const reload = (): Promise<void> => load(false);

  /* ── Events ────────────────────────────────────────────── */

  bindViewTabs(ctx.body, 'sql-tabs', (value) => {
    const next = value as Tab;
    if (next === tab) return;
    void guard().then((ok) => {
      if (!ok) { ctx.body.querySelectorAll<HTMLButtonElement>('#sql-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === tab))); return; }
      endEdit();
      setTab(next);
      query = ''; searchEl.value = '';
      renderGrid();
    });
  });
  nsEl.addEventListener('ev-select-change', (e) => {
    const v = (e as CustomEvent<{ value: string | string[] }>).detail.value;
    const next = Array.isArray(v) ? v[0] ?? '' : v;
    if (!next || next === ns) return;
    void guard().then((ok) => {
      if (!ok) { nsEl.value = ns; return; }
      endEdit();
      ns = next;
      close();
      loaded = false;
      grid = null; gridTab = null;
      wrap.innerHTML = skeleton(10);
      void load();
    });
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => {
    const v = (e as CustomEvent<{ value: string }>).detail.value;
    if (tab === 'who') whoScope = v as WhoScope; else objScope = v as ObjScope;
    renderScope();
    renderGrid();
  });
  sysEl.addEventListener('ev-checkbox-change', () => {
    includeSystem = !!sysEl.checked;
    void load();
  });
  searchEl.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });

  void load();
}
