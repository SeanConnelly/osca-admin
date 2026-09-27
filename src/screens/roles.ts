// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Roles — every role, with what the selected role grants (in plain
 * English, including through the roles it includes), who holds it, who would
 * gain from it, and create / edit / copy / delete for custom roles.
 *
 * Holder, resource and included-role counts come from the shared security
 * graph (getSecurityGraph), filled in the background and dropped after every
 * write.
 */
import '../styles-security.css';
import '../styles-sec.css';
import { listDialog } from '../sec-dialog';
import {
  getRoleList, getRole, getRoleOwners, isBuiltInRole, getSecurityGraph, linkTo, takeSelection,
  saveRole, deleteRole, invalidateSecurityGraph, powerfulPrivilege, POWERFUL_ROLES, PUBLIC_USER, ANON_USER, normPerms,
  privilegeText, takeNewRole, type NewRolePrefill,
  type RoleSummary, type RoleDetail, type RoleOwner, type SecurityGraph,
} from '../api-security';
import {
  newButton, confirm, toast, editorShell, panelWidth, section, textField, textareaField, checkField,
  fieldError, rolePicker, resourcePermissionEditor, readForm, errorText, AdminError,
  type EditorHandle, type FormValues, type MenuHandle, type ResourceGrant, type FieldProblem,
} from '../crud';
import { roleWarnings, wouldGain, roleSummary, mountSecurityBanner, guardDialog, type GuardRisk } from '../security-view';
import { noPermissionText, esc, chip, cell, skeleton, errorPanel, liveIndicator, uniformKeys, pruneColumns, objectDetail, odMeta, odSection, odKv, type ScreenCtx, type GridColumn, type OdFull, setChips } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 30000;
const EDIT_WIDTH = 520;
const SUPER = '%All';
const NO_SECURE = noPermissionText('%Admin_Secure', 'security administration');
const BUILT_IN_EDIT = 'InterSystems recommends copying built-in roles instead of changing them, so this portal doesn’t edit them.';
const BUILT_IN_DELETE = 'Built-in roles can’t be deleted. Copy it to make your own version.';
const NEXT_SIGN_IN = 'Users get changes the next time they sign in.';

/** Ellipsis at the column width (see users.ts). */
const clip = (v: unknown): string =>
  `<span style="display:block;width:0;min-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(v)}">${esc(v)}</span>`;
const count = (v: unknown, title: unknown): string =>
  Number(v) < 0 ? cell.dim('—') : cell.count(Number(v), String(title ?? ''));

const COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'Role', width: '300px', sortable: true, renderCell: (v, row) => (row.Reach
    ? `<span style="display:inline-flex;align-items:center;gap:6px;max-width:100%">${cell.id(v)}${row.Reach === 'anon' ? chip('Held by UnknownUser', 'danger', 'Anyone who connects without signing in gets this role') : chip('Every user', 'warning', 'The _PUBLIC account holds it, so every user gets it')}</span>`
    : cell.id(v)) },
  // The counts sit right after Role; Description, the one long text column, comes last and takes the free space.
  { key: 'Holders', label: 'Held by', description: 'Users who hold this role, directly or through other roles (accounts with %All are not counted)', width: '96px', sortable: true, align: 'right', renderCell: (v, row) => count(v, row.HoldersTitle || 'Users who hold it, directly or through other roles') },
  // The same count as the peek and the full view: every resource holders get, its own and through included roles.
  { key: 'Resources', label: 'Resources', description: 'Resources holders get: its own and those from the roles it includes', width: '96px', sortable: true, align: 'right',
    renderCell: (v, row) => (row.ResFull ? cell.text('All', row.Name === SUPER ? 'The super-user role grants every resource' : 'It includes %All, so it grants every resource') : count(v, row.ResourcesTitle)) },
  { key: 'Includes', label: 'Includes roles', description: 'Other roles that anyone holding this role also gets', width: '96px', sortable: true, align: 'right', renderCell: (v, row) => count(v, row.IncludesTitle) },
  { key: 'Origin', label: 'Origin', width: '100px', sortable: true, renderCell: (v) => (v === 'built-in' ? cell.dim('Built-in') : cell.text('Custom')) },
  { key: 'CreatedBy', label: 'Created by', width: '110px', sortable: true, renderCell: (v) => (v ? cell.mono(v, true) : cell.dim('—')) },
  { key: 'EscalationOnly', label: 'Escalation only', width: '130px', sortable: true,
    renderCell: (v) => (v ? chip('Escalation only', 'info', 'Only taken on by switching into it, never held all the time') : cell.dim('No')) },
  { key: 'Description', label: 'Description', sortable: true, renderCell: (v) => (v ? clip(v) : cell.dim('—')) },
];
const MAYBE_UNIFORM: Array<keyof DataGridRow> = ['Origin', 'CreatedBy', 'EscalationOnly'];
const SECONDARY = ['Origin', 'CreatedBy', 'EscalationOnly', 'Description'];


/** Resources a role gives: its own, and those only its included roles give. The one count list, peek and full view show. */
function resCount(g: SecurityGraph, name: string): { full: boolean; total: number; own: number; through: number } {
  const a = g.roleAccess(name);
  if (name === SUPER || a.full) return { full: true, total: 0, own: 0, through: 0 };
  let own = 0;
  for (const m of a.grants.values()) if ([...m.values()].some((src) => src.kind !== 'role' || src.path.length <= 1)) own++;
  return { full: false, total: a.grants.size, own, through: a.grants.size - own };
}
const resBreakdown = (c: { own: number; through: number }): string =>
  c.through ? `${c.own} of its own, ${c.through} through included roles` : '';
/** Holders: users who hold it directly or through other roles (one count everywhere; %All accounts are named apart). */
function holdersOf(g: SecurityGraph, name: string, allH: string[]): { total: number; direct: number; through: number; all: number } {
  const h = g.holders(name);
  const direct = new Set(h.direct);
  const users = new Set([...h.direct, ...h.inherited.map((x) => x.user)]);
  const all = name === SUPER ? 0 : allH.filter((u) => !users.has(u)).length;
  return { total: users.size, direct: direct.size, through: users.size - direct.size, all };
}

function toRow(r: RoleSummary, g: SecurityGraph | null, allH: string[] = []): DataGridRow {
  const d = g?.roles.get(r.Name);
  const h = g ? holdersOf(g, r.Name, allH) : null;
  const rc = g ? resCount(g, r.Name) : null;
  return {
    Name: r.Name, Description: r.Description, CreatedBy: r.CreatedBy, EscalationOnly: r.EscalationOnly,
    Origin: isBuiltInRole(r.Name) ? 'built-in' : 'custom',
    // Where the instance-wide risk lives: roles that anyone (or every user) gets.
    Reach: !g ? '' : g.userList.find((u) => u.Name === ANON_USER)?.Enabled && g.userEffective(ANON_USER).has(r.Name) ? 'anon'
      : g.publicRoles.some((p) => g.effective(p).has(r.Name)) ? 'public' : '',
    Holders: h ? h.total : -1,
    HoldersTitle: h ? `Users who hold it: ${h.direct} directly, ${h.through} through other roles${h.all ? `. Not counted: ${h.all} more with %All, which gives them this access anyway` : ''}` : '',
    // "All" sorts above every count.
    Resources: rc ? (rc.full ? Number.MAX_SAFE_INTEGER : rc.total) : -1,
    ResFull: !!rc?.full,
    ResourcesTitle: rc ? resBreakdown(rc) || `${rc.total} of its own` : '',
    Includes: d ? d.GrantedRoles.length : -1,
    IncludesTitle: d?.GrantedRoles.length ? `Also gives ${d.GrantedRoles.join(', ')}` : 'Gives no other roles',
  };
}

type Scope = 'all' | 'builtin' | 'custom';
type Mode = 'view' | 'edit' | 'create';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const canGrant = (o: RoleOwner): boolean => o.AdminOption === true || o.AdminOption === '1';
const roleChip = (name: string, title = 'Open this role'): string =>
  `<button type="button" class="chip-link" data-role="${esc(name)}" aria-label="Open role ${esc(name)}">${chip(name, 'neutral', title)}</button>`;
const userChip = (name: string, title = 'Open this user'): string =>
  `<button type="button" class="chip-link" data-user="${esc(name)}" aria-label="Open user ${esc(name)}">${chip(name, 'neutral', title)}</button>`;
const chipList = (items: string[]): string => `<div class="chip-list">${items.join('')}</div>`;
const none = (text: string): string => `<p class="chip-list-empty">${esc(text)}</p>`;

function heldBy(name: string, owners: RoleOwner[] | null, g: SecurityGraph | null, opts: { noAll?: boolean; noSummary?: boolean } = {}): string {
  if (owners === null && g === null) return none('Couldn’t load who holds this role');
  const fromOwners = owners ?? [];
  const directSet = new Set([...fromOwners.filter((o) => o.Type === 'User').map((o) => o.Name), ...(g?.holders(name).direct ?? [])]);
  const direct = [...directSet].sort();
  const grants = new Map(fromOwners.filter((o) => o.Type === 'User').map((o) => [o.Name, canGrant(o)]));
  const inherited = (g?.holders(name).inherited ?? []).filter((x) => !directSet.has(x.user));
  const escalate = [...new Set(fromOwners.filter((o) => /escalation/i.test(o.Type)).map((o) => o.Name))]
    .filter((n) => !directSet.has(n) && !inherited.some((x) => x.user === n)).sort();
  const roles = fromOwners.filter((o) => o.Type === 'Role').map((o) => o.Name).sort();
  const everyone = g?.publicRoles.some((r) => g.effective(r).has(name));
  const pathTo = (user: string, via: string): string => {
    const p = g?.rolePaths(via).get(name);
    return p ? p.slice(0, -1).join(' → ') : via;
  };
  const row = (user: string, how: string, title = 'Open this user'): string =>
    `<li>${userChip(user, title)}<span class="holder-how">${esc(how)}</span></li>`;
  // Holders of %All can do everything this role allows anyway.
  const allHolders = name === '%All' ? [] : (g?.allHolders() ?? []).filter((u) => !directSet.has(u) && !inherited.some((x) => x.user === u));
  const anonAll = allHolders.includes(ANON_USER);
  return `
    ${everyone ? `<p class="chip-sub">Every user</p><p class="detail-para">The ${PUBLIC_USER} account holds it, so every user gets it.</p>` : ''}
    ${direct.length
    // The heading says how they hold it, once; only the exception (may grant it) is named after the chips.
    ? `<p class="chip-sub">Directly</p>${chipList(direct.map((u) => userChip(u)))}${direct.some((u) => grants.get(u)) ? `<p class="holder-note">May grant it to others: ${esc(direct.filter((u) => grants.get(u)).join(', '))}</p>` : ''}`
    : opts.noSummary ? '' : none(`Directly: none${inherited.length ? ` · ${inherited.length} through roles` : ''}`)}
    ${inherited.length ? `<p class="chip-sub">Through another role</p><ul class="holder-list">${inherited.map((x) => row(x.user, `via ${pathTo(x.user, x.via)}`, `Holds it through ${x.via}`)).join('')}</ul>` : ''}
    ${!g ? '<p class="chip-sub">Working out who holds it through other roles…</p>' : ''}
    ${escalate.length ? `<p class="chip-sub">Can switch to it</p>${chipList(escalate.map((u) => userChip(u, 'Has it as an escalation role')))}` : ''}
    ${roles.length ? `<p class="chip-sub">Part of these roles</p>${chipList(roles.map((r) => roleChip(r)))}` : ''}
    ${allHolders.length && !opts.noAll ? `<p class="chip-sub">Not counted: ${allHolders.length} more with %All</p><p class="detail-para">%All already gives ${allHolders.length === 1 ? 'this account' : 'these accounts'} everything this role does${anonAll ? ', including anyone who connects without signing in' : ''}: ${esc(allHolders.join(', '))}.</p>` : ''}`;
}

/** Suggest a free name for a copy: "%Developer" → "Developer_copy". */
function copyName(from: string, taken: (n: string) => boolean): string {
  const base = `${from.replace(/^%+/, '').replace(/[,:/]/g, '_')}_copy`;
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken(`${base}${i}`)) return `${base}${i}`;
  return base;
}

export function rolesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="od-list sec-list" id="role-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="role-search" size="sm" full-width placeholder="Filter by role name or description"></ev-search></div>
        <ev-segmented-button id="role-scope" size="sm" aria-label="Show roles"></ev-segmented-button>
      </div>
      <ev-detail-panel id="role-panel" detail-width="500" class="workspace">
        <div class="grid-wrap grid-wrap--sec" id="role-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="role-detail" aria-label="Role details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="role-foot"></p>
    </div>
    <div id="role-full" hidden></div>`;
  const listView = ctx.body.querySelector('#role-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#role-full') as HTMLElement;

  const scopeEl = ctx.body.querySelector('#role-scope') as HTMLElement & { options: unknown; value: string };
  scopeEl.value = 'all';
  const panel = ctx.body.querySelector('#role-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#role-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#role-detail') as HTMLElement;
  const searchEl = ctx.body.querySelector('#role-search') as HTMLElement & { value: string };
  let grid: GridEl | null = null;
  let all: RoleSummary[] = [];
  let graph: SecurityGraph | null = null;
  let query = '';
  let scope: Scope = 'all';
  let selected: string | null = null;
  let pending = takeSelection();
  let pendingNew: NewRolePrefill | null = takeNewRole();
  let token = 0;
  let alive = true;
  let mode: Mode = 'view';
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  let canSecure = true;

  // Where the open form lives: the list's drawer, or (from the full view) the full view's body.
  let formFull = false;
  let formEl: HTMLElement = detailEl;
  const endEdit = (): void => {
    editor?.close();
    editor = null;
    restoreWidth?.();
    restoreWidth = null;
    mode = 'view';
    formFull = false;
    formEl = detailEl;
    ctx.beforeLeave(null);
  };
  ctx.onLeave(() => { alive = false; endEdit(); menu?.destroy(); });
  const guard = async (): Promise<boolean> => (editor ? editor.guard() : true);
  /** Paging, the breadcrumb or Esc in the full view: ask about unsaved changes, then drop a form that took the body's place. */
  const canLeaveFull = async (): Promise<boolean> => {
    if (!(await guard())) return false;
    if (formFull) endEdit();
    return true;
  };
  /** End a form in the full view's body and bring the full view back. */
  const dropFullForm = (): void => {
    if (!formFull) return;
    endEdit();
    fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
    od.refresh();
  };
  const renderRisk = (): void => {
    const host = ctx.banners;
    mountSecurityBanner(host, graph);
  };

  const newBtn = newButton(ctx, 'New role', () => { void guard().then((ok) => { if (ok) openCreate(null); }); });
  void sessionInfo().then((info) => {
    canSecure = can(info, 'Secure') !== false;
    newBtn.setHidden(!canSecure);
    if (mode === 'view' && selected) void renderDetail(true);
  }).catch(() => { /* keep defaults */ });

  const inScope = (r: RoleSummary, s: Scope): boolean => s === 'all' || (s === 'builtin' ? isBuiltInRole(r.Name) : !isBuiltInRole(r.Name));
  const visible = (): RoleSummary[] => all.filter((r) => {
    if (!inScope(r, scope)) return false;
    if (!query) return true;
    const ql = query.toLowerCase();
    return [r.Name, r.Description, r.CreatedBy].some((f) => f?.toLowerCase().includes(ql));
  });

  const renderToolbar = (): void => {
    const n = (s: Scope): number => all.filter((r) => inScope(r, s)).length;
    const opt = (value: Scope, label: string): { value: Scope; label: string; disabled: boolean } =>
      ({ value, label: `${label} ${n(value)}`, disabled: n(value) === 0 && scope !== value });
    setChips(scopeEl, all.length, [opt('all', 'All'), opt('builtin', 'Built-in'), opt('custom', 'Custom')], { active: scope, search: searchEl, query });
  };

  const renderFoot = (): void => {
    const custom = all.filter((r) => !isBuiltInRole(r.Name)).length;
    const unused = graph ? all.filter((r) => { const h = graph?.holders(r.Name); return h && !h.direct.length && !h.inherited.length; }).length : null;
    (ctx.body.querySelector('#role-foot') as HTMLElement).innerHTML =
      `<b>${all.length}</b> roles<span class="meta-sep">·</span><b>${custom}</b> custom`
      + (unused === null ? '' : `<span class="meta-sep">·</span><b>${unused}</b> unused`);
  };

  const applyColumns = (): void => {
    if (!grid) return;
    const uniform = uniformKeys(all.map((r) => toRow(r, null)), MAYBE_UNIFORM) as Set<string>;
    // Counts identical on every row shown (e.g. "Includes roles" all 0) are dropped: pruneColumns' constant-column rule.
    const shownRows = visible().map((x) => toRow(x, graph));
    const pruned = new Set(pruneColumns(shownRows, COLUMNS.filter((c) => c.key === 'Includes')).dropped);
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !pruned.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const close = (): void => {
    dropFullForm();
    endEdit(); token++;
    if (od.selected() !== null) { void od.select(null); return; }
    selected = null; grid?.select([]); setPanel(false);
  };

  /** Select a role by name (after the guard), clearing filters that would hide it. */
  const open = async (name: string): Promise<void> => {
    const hit = all.find((r) => r.Name.toLowerCase() === name.toLowerCase());
    if (!hit) return;
    if (!(await guard())) return;
    dropFullForm();
    endEdit();
    if (!visible().some((r) => r.Name === hit.Name)) {
      query = ''; scope = 'all';
      searchEl.value = ''; scopeEl.value = 'all';
      renderToolbar();
    }
    selected = hit.Name;
    renderGrid();
    if (od.mode() === 'full') void od.openFull(hit.Name); else void renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  /* ── View mode ─────────────────────────────────────────── */

  const deleteReason = (name: string): string | null => {
    if (!canSecure) return NO_SECURE;
    if (isBuiltInRole(name)) return BUILT_IN_DELETE;
    return null;
  };
  const editReason = (name: string): string | null => {
    if (!canSecure) return NO_SECURE;
    if (isBuiltInRole(name)) return BUILT_IN_EDIT;
    return null;
  };

  /* ── Peek and full view: objectDetail() ─────────────────── */

  /** The role shown, read once per render, so ⋯ can act without another read. */
  let shown: { name: string; role: RoleDetail; owners: RoleOwner[] | null } | null = null;
  const withRole = async (name: string, fn: (r: RoleDetail, owners: RoleOwner[] | null) => void): Promise<void> => {
    try {
      if (shown?.name === name) { fn(shown.role, shown.owners); return; }
      const [role, owners] = await Promise.all([getRole(name), getRoleOwners(name).catch(() => null)]);
      fn(role, owners);
    } catch (e) { toast(errorText(e), 'danger'); }
  };
  const load2 = async (name: string): Promise<{ role: RoleDetail; owners: RoleOwner[] | null }> => {
    const [role, owners] = await Promise.all([getRole(name), getRoleOwners(name).catch(() => null)]);
    shown = { name, role, owners };
    return { role, owners };
  };
  const metaOf = (s: RoleSummary): string => {
    const full = s.Name === SUPER || !!graph?.roleAccess(s.Name).full;
    const meta = odMeta(full ? { label: 'Full access', tone: 'warning', title: 'Holders can do anything on this instance' } : { label: isBuiltInRole(s.Name) ? 'Built-in' : 'Custom', tone: 'neutral' },
      [full ? (isBuiltInRole(s.Name) ? 'Built-in' : 'Custom') : ''],
      [s.EscalationOnly ? '<span style="color:var(--ev-color-warning)" title="Only taken on by switching into it, never held all the time">Escalation only</span>' : '']);
    // The full view's subtitle: the description on its own line under the state line (the peek shows it at the top of its body).
    return !fullEl.hidden && s.Description ? `${meta}<span class="role-lead" title="${esc(s.Description)}">${esc(s.Description)}</span>` : meta;
  };
  /** %All holders, worked out once per graph (every user's access is folded for it). */
  let allH: { g: SecurityGraph; list: string[] } | null = null;
  const allHolders = (g: SecurityGraph): string[] => {
    if (allH?.g !== g) allH = { g, list: g.allHolders() };
    return allH.list;
  };
  /** "%DB_USER  RW", with "through %Developer" when it comes from an included role. */
  const grantLines = (g: SecurityGraph, name: string, limit = Infinity, cols = false): { html: string; total: number } => {
    const a = g.roleAccess(name);
    if (a.full) return { html: '<ul class="sec-access"><li><span class="sec-res">Everything (%All)</span><span class="sec-via">every privilege on every resource</span></li></ul>', total: 1 };
    const lines: Array<{ res: string; perms: string; via: string; title: string }> = [];
    for (const [res, m] of a.grants) {
      const by = new Map<string, { letters: string; path: string[] }>();
      for (const [c, src] of m) {
        const path = src.kind === 'role' ? src.path : [];
        const k = path.join('>');
        const e = by.get(k) ?? { letters: '', path };
        e.letters += c;
        by.set(k, e);
      }
      for (const { letters, path } of by.values()) {
        lines.push({ res, perms: normPerms(letters), via: path.length > 1 ? path[1] : '', title: path.length > 1 ? `through ${path.slice(1).join(' → ')}` : 'granted by this role itself' });
      }
    }
    lines.sort((x, y) => Number(!!x.via) - Number(!!y.via) || x.res.localeCompare(y.res));
    if (!lines.length) return { html: none('Nothing of its own: holders get only what their other roles give.'), total: 0 };
    return {
      total: lines.length,
      html: `<ul class="sec-access${cols && Math.min(limit, lines.length) > COLS_FROM ? ' sec-access--cols' : ''}">${lines.slice(0, limit).map((l) => `<li><span class="sec-res"><a href="#/security/resources" data-res="${esc(l.res)}" class="mono">${esc(l.res)}</a> <b class="sec-perm">${esc(l.perms)}</b></span><span class="sec-via" title="${esc(l.title)}">${l.via ? `through <a href="#/security/roles" data-role="${esc(l.via)}" class="mono">${esc(l.via)}</a>` : ''}</span></li>`).join('')}</ul>`,
    };
  };
  const PEEK_LINES = 10;
  /** In the full view, more resource lines than this flow into two columns. */
  const COLS_FROM = 14;
  const warningsOf = (name: string): string =>
    (graph ? roleWarnings(graph, name) : []).map((w) => `<div class="sec-callout sec-callout--warning" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><span>${esc(w)}</span></div></div>`).join('');

  async function peekBody(s: RoleSummary): Promise<string> {
    const name = s.Name;
    const { role, owners } = await load2(name);
    const g = graph;
    const res = g ? grantLines(g, name, PEEK_LINES) : null;
    const rc = g ? resCount(g, name) : null;
    const hc = g ? holdersOf(g, name, allHolders(g)) : null;
    return `
      ${warningsOf(name)}
      ${odSection(`Resources${rc && !rc.full && rc.total ? ` · ${rc.total}` : ''}`, res
        ? `${rc && resBreakdown(rc) ? `<p class="chip-sub">${esc(resBreakdown(rc))}</p>` : ''}${res.html}${res.total > PEEK_LINES ? `<p class="sec-access-more"><button type="button" class="link" data-full="${esc(name)}">See them all in the full view</button></p>` : ''}`
        : '<p class="chip-list-empty">Working it out…</p>')}
      ${odSection(`Held by${hc?.total ? ` · ${hc.total}` : ''}`, heldBy(name, owners, g))}
      ${odSection('Includes roles', role.GrantedRoles.length ? chipList([...role.GrantedRoles].sort().map((x) => roleChip(x))) : none('No other roles'))}
      ${odSection('About', aboutKv(s, role))}`;
  }
  function aboutKv(s: RoleSummary, role: RoleDetail): string {
    return odKv([
      ...(s.CreatedBy && !(isBuiltInRole(s.Name) && s.CreatedBy === '_SYSTEM') ? [['Created by', `<span class="mono">${esc(s.CreatedBy)}</span>`] as [string, string]] : []),
      ['Escalation only', role.EscalationOnly ? 'Yes' : 'No', 'An escalation-only role is never held all the time; a user switches into it for a while'],
    ]);
  }

  async function fullOf(s: RoleSummary): Promise<OdFull> {
    const name = s.Name;
    selected = name; // a deep link opens here directly: later loads (the graph) refresh what's shown
    const { role, owners } = await load2(name);
    const g = graph;
    const res = g ? grantLines(g, name, Infinity, true) : null;
    const gain = g && name !== SUPER ? wouldGain(g, name) : [];
    const hc = g ? holdersOf(g, name, allHolders(g)) : null;
    const rc = g ? resCount(g, name) : null;
    const apps = g?.appsGranting?.(name) ?? [];
    const inc = [...role.GrantedRoles].sort();
    const roleLink = (x: string): string => `<a href="#/security/roles" data-role="${esc(x)}" class="mono">${esc(x)}</a>`;
    return {
      strip: [
        // The same counts as the list: holders directly or through roles; %All accounts are named apart.
        { label: 'Held by', value: !hc ? '—' : hc.total ? `${hc.total} user${hc.total === 1 ? '' : 's'}` : 'None',
          caption: hc ? esc([hc.through ? `${hc.through} through roles` : '', hc.all ? `+${hc.all} with %All` : ''].filter(Boolean).join(' · ')) : '' },
        { label: 'Resources', value: !rc ? '—' : rc.full ? 'All' : rc.total ? String(rc.total) : 'None', caption: rc ? esc(resBreakdown(rc)) : '' },
        // Named here once (as links); the cards don't repeat them.
        { label: 'Includes roles', value: inc.length ? String(inc.length) : 'None', title: inc.join(', '),
          caption: inc.length ? `${inc.slice(0, 2).map(roleLink).join(', ')}${inc.length > 2 ? esc(` and ${inc.length - 2} more`) : ''}` : '' },
        { label: 'Web apps', value: g ? (apps.length ? String(apps.length) : 'None') : '—', title: apps.length ? `Granted inside ${apps.join(', ')}` : 'No web application grants it' },
      ],
      notice: warningsOf(name) || undefined,
      // The description is the subtitle, under the title (see metaOf), as the peek shows it at the top.
      main: [
        { title: 'Resources', body: res ? res.html : '<p class="chip-list-empty">Working it out…</p>' },
      ],
      side: [
        { title: 'Held by', body: `${heldBy(name, owners, g, { noSummary: true })}${gain.length ? `<details class="gain-toggle"><summary>Enabled users who’d gain new access if given this role (${gain.length})</summary>${chipList(gain.map((u) => userChip(u)))}</details>` : ''}` },
        { title: 'About', id: 'rf-c-about', body: aboutKv(s, role) },
      ],
    };
  }

  const od = objectDetail<RoleSummary>(ctx, {
    collection: 'Roles', noun: 'role',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (x) => x.Name,
    find: (k) => all.find((x) => x.Name === k) ?? all.find((x) => x.Name.toLowerCase() === k.toLowerCase()),
    order: () => visible().map((x) => x.Name).sort((a, b) => a.localeCompare(b)),
    name: (x) => x.Name, mono: true,
    meta: metaOf,
    description: (x) => x.Description,
    // Built-in roles aren't edited here: their visible action is Duplicate role (the reason is its tooltip).
    primary: (x) => (isBuiltInRole(x.Name)
      ? { label: 'Duplicate role', icon: 'copy', blocked: canSecure ? null : NO_SECURE, run: () => void withRole(x.Name, (role) => { void formHere((full) => openCreate({ from: x.Name, role }, undefined, full)); }) }
      : { label: 'Edit', icon: 'edit-2', blocked: editReason(x.Name), run: () => void withRole(x.Name, (role) => { void formHere((full) => openEdit(x.Name, role, full)); }) }),
    menu: (x) => {
      const del = deleteReason(x.Name);
      return [
        ...(isBuiltInRole(x.Name) ? [] : [{ label: 'Copy…', icon: 'copy', disabled: !canSecure, reason: canSecure ? undefined : NO_SECURE, onSelect: () => void withRole(x.Name, (role) => { void formHere((full) => openCreate({ from: x.Name, role }, undefined, full)); }) }]),
        { label: 'Everyone with this access…', icon: 'users', disabled: !graph, reason: 'Still working out who holds it', onSelect: () => showEveryone(x.Name) },
        { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!del, reason: del ?? undefined, onSelect: () => void withRole(x.Name, (_r, owners) => void remove(x.Name, owners)) },
      ];
    },
    peek: peekBody,
    loadFull: fullOf,
    wire: (root, x, where) => {
      if (where === 'full') { markNone(root); balanceColumns(root); }
      if (!isBuiltInRole(x.Name)) return;
      document.getElementById(where === 'full' ? 'od-full-primary' : 'od-peek-primary')?.setAttribute('title', BUILT_IN_EDIT);
    },
    onSelect: (k) => { selected = k; if (k === null) shown = null; grid?.select(k ? [k] : []); },
    onPeek: () => applyColumns(),
    canLeave: canLeaveFull,
    widthKey: 'osca-portal:peek-width:security/roles',
  });
  /** Everyone who gets this role's access: holders (directly or through roles) and every %All account. */
  const showEveryone = (name: string): void => {
    const g = graph;
    if (!g) return;
    const h = g.holders(name);
    const via = new Map(h.inherited.map((x) => [x.user, x.via]));
    const all = name === SUPER ? [] : g.allHolders().filter((u) => !h.direct.includes(u) && !via.has(u));
    listDialog(`Everyone with ${name}’s access`, [
      ...h.direct.slice().sort().map((u) => ({ name: u, how: 'holds it' })),
      ...[...via].sort(([a], [b]) => a.localeCompare(b)).filter(([u]) => !h.direct.includes(u)).map(([u, v]) => ({ name: u, how: `through ${v}` })),
      ...all.sort().map((u) => ({ name: u, how: u === ANON_USER ? 'holds %All: anyone who connects without signing in' : 'holds %All' })),
    ]);
  };
  /**
   * A small role leaves Resources short: About then moves under it, beside Held by, when that evens the
   * two columns (measured, so a long resource list keeps About on the right).
   */
  const balanceColumns = (root: HTMLElement): void => {
    const [left, right] = [...root.querySelectorAll<HTMLElement>('.od-cols > .od-col')];
    const about = root.querySelector<HTMLElement>('#rf-c-about');
    if (!left || !right || !about || left.getBoundingClientRect().top !== right.getBoundingClientRect().top) return;
    const h = about.offsetHeight + (parseFloat(getComputedStyle(right).rowGap) || 16);
    const l = left.offsetHeight; const r = right.offsetHeight - h;
    if (Math.abs(l + h - r) < Math.abs(r + h - l)) left.appendChild(about);
  };
  /** Strip values that say "None" read in tertiary text (the strip helper takes plain text). */
  const markNone = (root: HTMLElement): void => {
    root.querySelectorAll<HTMLElement>('.strip-value > span').forEach((el) => { if (el.textContent?.trim() === 'None') el.classList.add('sec-none'); });
  };
  /**
   * Open a form where the user is looking: from the list it opens in the drawer; from the full view
   * (#/security/roles/<name>) it takes the body's place, so the address, title and ‹ › pager stay,
   * and Cancel or Save bring the full view back. An open form is asked about first.
   */
  const formHere = async (fn: (full: boolean) => void): Promise<void> => {
    if (!(await guard())) return;
    endEdit();
    fn(od.mode() === 'full');
  };

  /** Show the selected role in the peek (or refresh what's shown), unless a form is open. */
  const renderDetail = async (_quiet = false): Promise<void> => {
    if (mode !== 'view') return;
    if (selected === null) { if (od.selected() !== null) await od.select(null); else setPanel(false); return; }
    if (od.selected() === selected) od.refresh(); else await od.select(selected);
  };

  // Links in the peek and the full view: roles open here, users and resources on their screens.
  const onLink = (e: Event): void => {
    const t = e.target as HTMLElement;
    const role = t.closest<HTMLElement>('[data-role]');
    const user = t.closest<HTMLElement>('[data-user]');
    const res = t.closest<HTMLElement>('a[data-res]');
    const fullBtn = t.closest<HTMLElement>('[data-full]');
    if (role) { e.preventDefault(); void open(role.dataset.role ?? ''); }
    else if (user) { e.preventDefault(); linkTo(ctx.navigate, 'security/users', user.dataset.user ?? ''); }
    else if (res) { e.preventDefault(); linkTo(ctx.navigate, 'security/resources', res.dataset.res ?? ''); }
    else if (fullBtn) { e.preventDefault(); void od.openFull(fullBtn.dataset.full ?? ''); }
  };
  detailEl.addEventListener('click', onLink);
  fullEl.addEventListener('click', onLink);

  /* ── Forms ─────────────────────────────────────────────── */

  const taken = (n: string): boolean => all.some((r) => r.Name.toLowerCase() === n.toLowerCase());
  const isUserName = (n: string): boolean => !!graph?.userList.some((u) => u.Name.toLowerCase() === n.toLowerCase());
  const touched = new Set<string>();

  const problems = (v: FormValues, isCreate: boolean): FieldProblem[] => {
    const out: FieldProblem[] = [];
    const add = (field: string, label: string, message: string): void => { out.push({ field, label, message }); };
    if (isCreate) {
      const n = String(v.Name ?? '').trim();
      if (!n) add('Name', 'Name', 'Enter a role name');
      else if (n.startsWith('%')) add('Name', 'Name', 'Names starting with % are reserved for built-in roles');
      else if (/[,:/]/.test(n)) add('Name', 'Name', 'A role name can’t contain , : or /');
      else if (n.length > 64) add('Name', 'Name', 'Use 64 characters or fewer');
      else if (taken(n)) add('Name', 'Name', 'A role with this name already exists');
      else if (isUserName(n)) add('Name', 'Name', 'A user already has this name; users and roles need different names');
    }
    if (String(v.Description ?? '').length > 256) add('Description', 'Description', 'Use 256 characters or fewer');
    return out;
  };
  /** "Already exists" gets a way to open the existing role; runs on every change. */
  const showExists = (v: FormValues): void => {
    const exists = formEl.querySelector('#rf-exists') as HTMLElement | null;
    if (!exists) return;
    const n = String(v.Name ?? '').trim();
    const hit = n && taken(n) ? all.find((r) => r.Name.toLowerCase() === n.toLowerCase()) : undefined;
    exists.hidden = !hit;
    if (hit) exists.dataset.role = hit.Name;
  };

  const trackTouched = (): void => {
    formEl.addEventListener('focusout', (e) => {
      const f = (e.target as Element | null)?.closest?.('[data-field]') as HTMLElement | null;
      if (f?.dataset.field) { touched.add(f.dataset.field); editor?.refresh(); }
    });
  };

  /** Roles that can't be included: the role itself and any role that already includes it (that would loop). */
  const cycleExclusions = (name: string): string[] =>
    name ? all.filter((r) => r.Name === name || graph?.effective(r.Name).has(name)).map((r) => r.Name) : [];

  function roleSections(r: RoleDetail, isCreate: boolean, name: string): string {
    return [
      section('General', [
        isCreate ? textField('Name', 'Name', name, { required: true, mono: true, maxlength: 64, hint: 'Can’t be changed later. Can’t start with %, or contain commas, colons or slashes.' }) : '',
        isCreate ? '<p class="crud-inline-note" id="rf-exists" hidden>A role with this name already exists. <button type="button" class="link" id="rf-open">Open it</button></p>' : '',
        textareaField('Description', 'Description', r.Description, { rows: 2, maxlength: 256 }),
      ].join('')),
      section('Resources', '<div id="rf-res"></div>', { hint: 'What holders can do. Databases take Read or Read & change; everything else takes Use.' }),
      section('Also gives these roles', '<div id="rf-inc"></div>', { hint: 'Anyone holding this role also gets everything these roles give.' }),
      section('Escalation', checkField('EscalationOnly', 'Escalation only', r.EscalationOnly, {
        hint: 'Only offered as a role users switch into for a while (their escalation roles), never as one they hold all the time.',
      })),
      // New: what happens is there from the start. Edit: the lines that differ, then what holders end up with.
      `<div data-rf-changes${isCreate ? '' : ' hidden'}>${section(isCreate ? 'What happens' : 'What changes', '<div id="rf-changes" class="preview" aria-live="polite"></div><div id="rf-summary" class="preview" aria-live="polite"></div>')}</div>`,
    ].join('');
  }

  /** Live summary of what the form's role would grant. */
  const summaryHtml = (res: ResourceGrant[], inc: string[]): string => {
    if (!graph) return '';
    const g = graph;
    const reach = new Set<string>();
    for (const r of inc) for (const e of g.effective(r)) reach.add(e);
    if (reach.has(SUPER)) return '<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>This role will give full access to everything, because it includes %All.</div></div>';
    const perms = new Map<string, string>();
    for (const x of res) perms.set(x.Name, normPerms(x.Permissions));
    for (const r of reach) for (const x of g.roles.get(r)?.Resources ?? []) perms.set(x.Name, normPerms((perms.get(x.Name) ?? '') + x.Permissions));
    const risky = [...perms].map(([n, p]) => powerfulPrivilege(n, p)).filter(Boolean) as string[];
    const powerful = inc.filter((r) => POWERFUL_ROLES[r]);
    return `<p class="preview-line">Holders will get <b>${perms.size}</b> privilege${perms.size === 1 ? '' : 's'}${reach.size ? `, including those from ${esc([...inc].join(', '))}` : ''}.</p>
      ${risky.length || powerful.length ? `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><ul>${[...new Set([...risky, ...powerful.map((r) => `${r}: ${POWERFUL_ROLES[r]}`)])].map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div></div>` : ''}
      <p class="preview-note">${NEXT_SIGN_IN}</p>`;
  };

  /** Edit's "What changes": one line per difference from the role as it is. */
  const changeLines = (b: RoleDetail, v: FormValues, res: ResourceGrant[], inc: string[]): string[] => {
    const was = new Map(b.Resources.map((x) => [x.Name, normPerms(x.Permissions)]));
    const now = new Map(res.filter((x) => x.Permissions).map((x) => [x.Name, normPerms(x.Permissions)]));
    const resLines = [
      ...[...now].filter(([n, p]) => was.get(n) !== p).map(([n, p]) => (was.has(n) ? `${n}: ${was.get(n)} → ${p}.` : `Adds ${n} ${p}.`)),
      ...[...was.keys()].filter((n) => !now.has(n)).map((n) => `Removes ${n}.`),
    ];
    const desc = String(v.Description ?? '').trim();
    return [
      desc !== b.Description ? 'Description changes.' : '',
      ...resLines,
      ...inc.filter((x) => !b.GrantedRoles.includes(x)).map((x) => `Also gives ${x}.`),
      ...b.GrantedRoles.filter((x) => !inc.includes(x)).map((x) => `No longer gives ${x}.`),
      !!v.EscalationOnly !== b.EscalationOnly ? `Escalation only: ${v.EscalationOnly ? 'yes' : 'no'}.` : '',
    ].filter(Boolean);
  };

  const mountPickers = (name: string, r: RoleDetail, onChange: () => void, before: RoleDetail | null = null): { res: () => ResourceGrant[]; inc: () => string[] } => {
    const resHost = formEl.querySelector('#rf-res') as HTMLElement;
    const incHost = formEl.querySelector('#rf-inc') as HTMLElement;
    const sum = formEl.querySelector('#rf-summary') as HTMLElement;
    const changes = formEl.querySelector('#rf-changes') as HTMLElement;
    const host = formEl;
    let res = r.Resources.map((x) => ({ ...x }));
    let inc = [...r.GrantedRoles];
    const showChanges = (): void => {
      if (!before) return;
      const ls = changeLines(before, readForm(host), res, inc);
      changes.innerHTML = ls.length ? `<ul class="preview-list">${ls.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
      // Edit: the section appears once something has changed (as on Namespaces).
      const box = host.querySelector<HTMLElement>('[data-rf-changes]');
      if (box) box.hidden = !ls.length;
    };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-textarea-input', 'ev-checkbox-change', 'ev-toggle-change']) host.addEventListener(t, showChanges);
    const upd = (): void => { sum.innerHTML = summaryHtml(res, inc); showChanges(); onChange(); };
    resourcePermissionEditor(resHost, {
      name: 'Resources', label: '',
      describe: (n, p) => privilegeText(n, p, graph),
      resources: (graph?.resources ?? []).map((x) => ({ Name: x.Name, ResourceType: x.ResourceType, Description: x.Description })),
      value: res, onChange: (v) => { res = v; upd(); },
    });
    rolePicker(incHost, {
      name: 'GrantedRoles', label: '', all: graph?.roleList ?? all, selected: inc,
      exclude: cycleExclusions(name), onChange: (v) => { inc = v; upd(); },
      summary: (x) => (graph ? roleSummary(graph, x) : null),
      onCreateReadOnly: (dbRole) => void guard().then((ok) => { if (ok) openCreate(null, { resources: [{ Name: dbRole, Permissions: 'R' }], description: `Read-only access to ${dbRole.replace(/^%DB_/i, '')}` }); }),
    });
    sum.innerHTML = summaryHtml(res, inc);
    showChanges();
    return { res: () => res, inc: () => inc };
  };

  /** Warnings to accept before saving; resolves false to go back. */
  const confirmRisks = async (name: string, before: RoleDetail | null, after: RoleDetail): Promise<boolean> => {
    const risks: GuardRisk[] = [];
    const h = graph && before ? graph.holders(name) : null;
    const n = h ? h.direct.length + h.inherited.length : 0;
    const impact = before ? `${n} user${n === 1 ? ' holds' : 's hold'} ${name} now.` : 'Nobody holds it yet.';
    const addedInc = after.GrantedRoles.filter((x) => !(before?.GrantedRoles ?? []).includes(x));
    for (const x of addedInc) {
      const w = POWERFUL_ROLES[x] ?? (graph?.roleAccess(x).full ? 'Gives full access to everything' : undefined);
      if (w) risks.push({ title: `${name} would include ${x}`, text: `${w}, to everyone who holds ${name}.`, impact });
    }
    for (const x of after.Resources) {
      const was = before?.Resources.find((b) => b.Name === x.Name)?.Permissions ?? '';
      const gained = normPerms(x.Permissions.split('').filter((c) => !was.includes(c)).join(''));
      const w = gained ? powerfulPrivilege(x.Name, gained) : null;
      if (w) risks.push({ title: `${name} would grant ${privilegeText(x.Name, gained, graph).replace(/^Can /, 'the power to ').replace(/^\w/, (c) => c.toLowerCase())}`, text: `${w}.`, impact });
    }
    if (graph && before) {
      const anon = graph.userEffective(ANON_USER).has(name);
      const pub = graph.publicRoles.some((r) => graph?.effective(r).has(name));
      const widened = addedInc.length || after.Resources.some((x) => x.Permissions !== before.Resources.find((b) => b.Name === x.Name)?.Permissions);
      if ((anon || pub) && widened) {
        risks.push(pub
          ? { title: 'This change applies to every user', text: `The ${PUBLIC_USER} account holds ${name}, so everyone gets what it grants.`, impact: 'Includes anyone who connects without signing in.' }
          : { title: 'This change applies to unauthenticated requests', text: `UnknownUser holds ${name}, so anyone who connects without signing in gets what it grants.` });
      }
    }
    if (!risks.length) return true;
    const d = guardDialog(risks);
    return confirm({ title: d.title, body: d.body, confirmLabel: before ? 'Save anyway' : 'Create anyway', danger: true });
  };

  /** Get the form's host ready: the drawer (opened at edit width), or the full view's body when `full`. */
  const startForm = (full = false): void => {
    menu?.destroy(); menu = null;
    token++;
    touched.clear();
    formFull = full;
    formEl = full ? fullEl : detailEl;
    if (!full) {
      setPanel(true);
      if (!restoreWidth) restoreWidth = panelWidth(panel, EDIT_WIDTH);
    }
    // Sidebar, palette and back/forward ask first while the form has changes.
    ctx.beforeLeave(() => guard());
  };
  const backToView = (name: string | null): void => {
    if (formFull) {
      // The full view's cards come back: this role's, or the new one's after a copy.
      endEdit();
      fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
      if (name && name !== od.selected() && all.some((r) => r.Name === name)) void od.openFull(name); else od.refresh();
      return;
    }
    endEdit();
    if (name && all.some((r) => r.Name === name)) { selected = name; grid?.select([name]); void renderDetail(); }
    else close();
  };
  const toRole = (v: FormValues, res: ResourceGrant[], inc: string[]): RoleDetail => ({
    Description: String(v.Description ?? '').trim(),
    EscalationOnly: !!v.EscalationOnly,
    Resources: res.filter((x) => x.Permissions).map((x) => ({ Name: x.Name, Permissions: normPerms(x.Permissions) })),
    GrantedRoles: inc,
  });

  function openEdit(name: string, r: RoleDetail, full = false): void {
    if (editReason(name)) return;
    startForm(full);
    mode = 'edit';
    let pick: { res: () => ResourceGrant[]; inc: () => string[] } | null = null;
    editor = editorShell(formEl, {
      // The full view's title already names the role.
      title: full ? 'Edit settings' : `Edit <span class="mono">${esc(name)}</span>`,
      name,
      sections: roleSections(r, false, name),
      submitLabel: 'Save changes',
      check: () => problems(readForm(formEl), false),
      onCancel: () => backToView(name),
      onSubmit: async (v) => {
        const after = toRole(v, pick?.res() ?? r.Resources, pick?.inc() ?? r.GrantedRoles);
        if (!(await confirmRisks(name, r, after))) throw new Error('Not saved. Review the warnings, then save again.');
        await saveRole(name, after);
        editor?.markClean();
        toast(`Role ${name} saved. ${NEXT_SIGN_IN}`);
        await reload(true);
        backToView(name);
      },
    });
    pick = mountPickers(name, r, () => editor?.refresh(), r);
    trackTouched();
  }

  function openCreate(copy: { from: string; role: RoleDetail } | null, prefill?: NewRolePrefill, full = false): void {
    if (!canSecure) return;
    endEdit();
    // A copy from the full view keeps the source role's page underneath; Cancel brings it back.
    const inFull = full && !!copy;
    if (!inFull) { selected = null; grid?.select([]); }
    startForm(inFull);
    mode = 'create';
    const base: RoleDetail = copy
      ? { Description: copy.role.Description, EscalationOnly: copy.role.EscalationOnly, Resources: copy.role.Resources.map((x) => ({ ...x })), GrantedRoles: [...copy.role.GrantedRoles] }
      : { Description: prefill?.description ?? '', EscalationOnly: false, Resources: prefill?.resources.map((x) => ({ ...x })) ?? [], GrantedRoles: [] };
    // Copying %All would copy nothing (it lists no resources); include it instead, with the warning that brings.
    if (copy?.from === SUPER) base.GrantedRoles = [SUPER];
    const suggested = copy ? copyName(copy.from, taken) : '';
    let pick: { res: () => ResourceGrant[]; inc: () => string[] } | null = null;
    editor = editorShell(formEl, {
      subtitle: copy ? `Copy of ${esc(copy.from)}` : undefined,
      title: 'New role',
      name: 'the new role',
      sections: roleSections(base, true, suggested),
      submitLabel: 'Create role',
      startDirty: !!copy || !!prefill,
      check: () => { const v = readForm(formEl); showExists(v); return problems(v, true); },
      onCancel: () => backToView(copy?.from ?? null),
      onSubmit: async (v) => {
        const name = String(v.Name ?? '').trim();
        // Saving a role overwrites one that exists, so make sure the name is free right now.
        const clash = await getRole(name).then(() => true, (e: unknown) => !(e instanceof AdminError && e.status === 404));
        if (clash) {
          all = await getRoleList().catch(() => all);
          showExists(v);
          fieldError(formEl, 'Name', 'A role with this name already exists');
          throw new Error('A role with this name already exists');
        }
        const after = toRole(v, pick?.res() ?? base.Resources, pick?.inc() ?? base.GrantedRoles);
        if (!(await confirmRisks(name, null, after))) throw new Error('Not created. Review the warnings, then try again.');
        await saveRole(name, after);
        editor?.markClean();
        toast(prefill?.forUser ? `Role ${name} created. Now give it to ${prefill.forUser} on the Users page. ${NEXT_SIGN_IN}` : `Role ${name} created. ${NEXT_SIGN_IN}`);
        await reload(true);
        backToView(all.find((r) => r.Name.toLowerCase() === name.toLowerCase())?.Name ?? name);
        requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
      },
    });
    formEl.querySelector('#rf-open')?.addEventListener('click', () => {
      const n = (formEl.querySelector('#rf-exists') as HTMLElement | null)?.dataset.role;
      if (n) void open(n);
    });
    pick = mountPickers('', base, () => editor?.refresh());
    trackTouched();
    if (copy) queueMicrotask(() => editor?.refresh());
  }

  async function remove(name: string, owners: RoleOwner[] | null): Promise<void> {
    const h = graph?.holders(name);
    const users = (h?.direct.length ?? 0) + (h?.inherited.length ?? 0);
    const direct = h?.direct.length ?? (owners ?? []).filter((o) => o.Type === 'User').length;
    const roles = (owners ?? []).filter((o) => o.Type === 'Role').length;
    const inUse = users > 0 || roles > 0;
    const impact = inUse
      ? `<p>This removes it from <b>${direct}</b> user${direct === 1 ? '' : 's'}${roles ? ` and <b>${roles}</b> role${roles === 1 ? '' : 's'} that include it` : ''}, affecting <b>${users}</b> user${users === 1 ? '' : 's'} in all. They lose what it gave them the next time they sign in.</p>`
      : '<p>Nobody holds this role, so no one loses access.</p>';
    const ok = await confirm({
      title: `Delete role ${name}?`,
      body: `${impact}<p>This can’t be undone.${inUse ? ' To keep it but stop it giving access, edit it and remove its resources instead.' : ''}</p>`,
      confirmLabel: 'Delete role',
      danger: true,
      typeToConfirm: inUse ? name : undefined,
    });
    if (!ok) return;
    try {
      await deleteRole(name);
      toast(`Role ${name} deleted.${inUse ? ` ${NEXT_SIGN_IN}` : ''}`);
      close();
      await reload(true);
    } catch (e) { toast(errorText(e), 'danger'); }
  }

  /* ── Grid and loading ──────────────────────────────────── */

  const renderGrid = (): void => {
    const rows = visible().map((r) => toRow(r, graph, graph ? allHolders(graph) : []));
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Roles');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        if (name === selected && mode === 'view' && panel.open) return;
        void guard().then((ok) => {
          if (!ok) { grid?.select(selected ? [selected] : []); return; }
          endEdit();
          selected = name;
          void od.select(name);
        });
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.grid-empty, .empty')?.remove();
    if (rows.length > 0) return;
    const noCustom = scope === 'custom' && !query && !all.some((r) => !isBuiltInRole(r.Name));
    wrap.insertAdjacentHTML('beforeend', noCustom
      ? `<div class="empty"><div class="empty-main">
          <ev-icon name="info" size="md"></ev-icon>
          <div class="empty-text">
            <strong>No custom roles yet</strong>
            <span class="lead">Every role here was installed with IRIS; their names start with %.</span>
            <span>A custom role bundles exactly the access one group of people needs, such as read-only access to one database.${canSecure ? ' Use New role, or copy a built-in role to start from it.' : ''}</span>
          </div>
        </div></div>`
      : `<div class="grid-empty">No ${scope === 'all' ? '' : scope === 'builtin' ? 'built-in ' : 'custom '}roles match “${esc(query)}”.</div>`);
  };

  const fillGraph = async (fresh: boolean): Promise<void> => {
    try {
      const g = await getSecurityGraph(fresh);
      if (!alive) return;
      graph = g;
      renderGrid();
      renderFoot();
      renderRisk();
      if (pendingNew && canSecure && mode === 'view') { const p = pendingNew; pendingNew = null; openCreate(null, p); }
      if (selected !== null && mode === 'view') void renderDetail(true);
      else if (od.mode() === 'full' && !formFull) od.refresh(); // a form in the full view's body stays put
    } catch { /* counts stay "…"; the list itself still works */ }
  };

  async function reload(afterWrite = false): Promise<void> {
    if (afterWrite) invalidateSecurityGraph();
    all = await getRoleList();
    updated(new Date());
    renderToolbar();
    renderGrid();
    renderFoot();
    await fillGraph(afterWrite);
  }

  const updated = liveIndicator(ctx, () => void load(true));
  const load = async (fresh = false): Promise<void> => {
    try {
      all = await getRoleList();
      if (!alive) return;
      updated(new Date());
      renderToolbar();
      renderGrid();
      renderFoot();
      if (!opened) { opened = true; od.refresh(); } // a deep link (#/security/roles/<name>) opens its full view now
      if (pending !== null) { const name = pending; pending = null; void open(name); }
      else if (selected !== null && mode === 'view') {
        if (all.some((r) => r.Name === selected)) { if (od.mode() !== 'full') void renderDetail(true); }
        else close();
      }
      void fillGraph(fresh);
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-roles');
      wrap.querySelector('#retry-roles')?.addEventListener('click', () => void load());
    }
  };

  searchEl.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => {
    scope = (e as CustomEvent<{ value: Scope }>).detail.value;
    renderToolbar();
    renderGrid();
  });

  let opened = false;
  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => { clearInterval(timer); token++; });
}
