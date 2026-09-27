// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Users — every user account, with the full record for the one you
 * select, what that user can actually do (and why), an access checker, and
 * create / edit / change password / disable / copy / delete.
 *
 * Effective access, privilege and holder counts come from the shared security
 * graph (getSecurityGraph), filled in the background and dropped after every
 * write.
 */
import '../styles-security.css';
import '../styles-proc.css';
import '../styles-sec.css';
import {
  getUserList, getUser, decodeAuthe, builtInUser, getSecurityGraph, linkTo, takeSelection,
  createUser, updateUser, setUserPassword, deleteUser, invalidateSecurityGraph,
  hasBit, withBit, TWO_FACTOR_SMS, TWO_FACTOR_TOTP, PRIVILEGED_ROLES, POWERFUL_ROLES, UNDELETABLE_USERS, PUBLIC_USER, ANON_USER,
  privilegeText, groupOf, normPerms, stashNewRole,
  type UserSummary, type UserDetail, type SecurityGraph, type Source,
} from '../api-security';
import { apiAvailable, getLoginHistory, type LoginHistory } from '../api-osca';
import {
  newButton, confirm, toast, editorShell, panelWidth, section, textField, passwordField,
  textareaField, checkField, selectField, namespaceField, dateField, rolePicker, errorText, readForm,
  type EditorHandle, type FormValues, type MenuHandle, type FieldProblem, type MenuItem,
} from '../crud';
import { mountSecurityBanner, guardDialog, roleSummary, targetLabel, renderAccessCheck, runAccessCheck, type CheckFix, type CheckTarget, type ChainLinks, type GuardRisk } from '../security-view';
import { noPermissionText, esc, chip, cell, skeleton, errorPanel, liveIndicator, relative, when, uniformKeys, objectDetail, odMeta, odSection, odKv, type ScreenCtx, type OdFull, setChips } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';
import { anyoneNotice } from './services'; // the app's one "Anyone can connect" banner (with its styles)

const REFRESH_MS = 30000;
const EDIT_WIDTH = 520;
const ANON_TEXT = 'Unauthenticated requests run as this user. Its roles define what anyone can do without signing in.';
/** The app's one wording for this risk (Services, Web applications, Superservers say the same). */
const ANON_FULL_TITLE = 'Anyone can connect without signing in, with full access';
const ANON_FULL_TEXT = 'They run as UnknownUser, which holds %All.';
const NO_SECURE = noPermissionText('%Admin_Secure', 'security administration');
const NEXT_SIGN_IN = 'Changes apply the next time they sign in.';

/** "Password user" → "Password"; the list's Type names how the account signs in. */
const signIn = (type: string): string => type.replace(/\s*user$/i, '') || type;
const isPasswordUser = (type: string | undefined): boolean => !type || /^password/i.test(type);

/** Ellipsis at the column width: width 0 + min-width 100% keeps the text out of the auto layout sizing, so this (width-less) column takes the spare room and truncates only at its real edge. */
const clip = (v: unknown): string =>
  `<span style="display:block;width:0;min-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(v)}">${esc(v)}</span>`;

/** Privileged roles a user ends up with, and the role each arrives through. */
function privilege(g: SecurityGraph | null, user: string): Array<{ role: string; via: string }> | null {
  if (!g) return null;
  const direct = g.userRoles.get(user) ?? [];
  const out: Array<{ role: string; via: string }> = [];
  for (const p of PRIVILEGED_ROLES) {
    const via = direct.includes(p) ? p : direct.find((r) => g.effective(r).has(p));
    if (via) out.push({ role: p, via });
  }
  return out;
}
const privilegeLine = (p: Array<{ role: string; via: string }>): string =>
  p.map((x) => (x.role === x.via ? `Holds ${x.role}` : `Holds ${x.role} through ${x.via}`)).join('; ');

const COLUMNS: DataGridColumn[] = [
  { key: 'Name', label: 'Username', width: '150px', sortable: true, renderCell: (v) => cell.id(v) },
  { key: 'FullName', label: 'Full name', width: '360px', sortable: true, renderCell: (v) => (v ? clip(v) : cell.dim('—')) },
  { key: 'Enabled', label: 'State', width: '100px', sortable: true, renderCell: (v) => (v ? chip('Enabled', 'success') : chip('Disabled', 'neutral', 'This account cannot sign in')) },
  { key: 'Access', label: 'Access', width: '210px', sortable: true, renderCell: (v, row) => {
    if (v === 'pending') return cell.dim('—');
    const parts: string[] = [];
    // UnknownUser is anyone who connects without signing in: its access is the instance's biggest risk.
    // The row the page notice is about carries the same red.
    if (row.Anonymous) parts.push(row.AnonFull ? chip('Anyone can connect', 'danger', `${ANON_FULL_TITLE} · ${ANON_FULL_TEXT}`)
      : row.PrivTitle ? chip('Anyone can connect', 'danger', `Anyone can connect without signing in · ${String(row.PrivTitle)}`) : chip('Anyone can connect', 'warning', ANON_TEXT));
    // A classification, not a risk: plain text, regular weight, never amber.
    else if (row.PrivTitle) parts.push(`<span style="color:var(--ev-color-text-primary);white-space:nowrap" title="${esc(String(row.PrivTitle))}">Privileged</span>`);
    return parts.length ? `<span style="display:inline-flex;gap:4px">${parts.join('')}</span>` : cell.dim('Standard');
  } },
  { key: 'Origin', label: 'Origin', width: '110px', sortable: true, renderCell: (v) => (v === 'built-in' ? cell.dim('Built-in') : cell.text('Created here', 'Not one of the accounts IRIS installs')) },
  { key: 'Type', label: 'Signs in with', width: '130px', sortable: true, renderCell: (v) => cell.text(signIn(String(v)), String(v)) },
  { key: 'Namespace', label: 'Default namespace', width: '150px', sortable: true, renderCell: (v) => (v ? cell.mono(v) : cell.dim('—')) },
  { key: 'Routine', label: 'Startup routine', width: '160px', sortable: true, renderCell: (v) => (v ? cell.mono(v) : cell.dim('—')) },
];
const MAYBE_UNIFORM: Array<keyof UserSummary> = ['Type', 'Namespace', 'Routine'];
const SECONDARY = ['Origin', 'Type', 'Namespace', 'Routine'];

function toRow(u: UserSummary, g: SecurityGraph | null): DataGridRow {
  const p = privilege(g, u.Name);
  const anon = u.Name === ANON_USER && u.Enabled;
  const access = p === null ? 'pending' : `${anon ? 2 : 0}${p.length ? 1 : 0}`;
  return {
    Name: u.Name, FullName: u.FullName, Enabled: u.Enabled, Type: u.Type,
    Origin: builtInUser(u.Name) ? 'built-in' : 'custom', Namespace: u.Namespace, Routine: u.Routine,
    Access: access, Anonymous: anon, PrivTitle: p?.length ? privilegeLine(p) : '',
    AnonFull: anon && !!g?.userAccess(u.Name).full,
  };
}

type Scope = 'all' | 'enabled' | 'disabled';
type Mode = 'view' | 'edit' | 'create' | 'password';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const muted = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const roleChips = (names: string[], empty: string): string => names.length
  ? `<div class="chip-list">${names.map((r) => `<button type="button" class="chip-link" data-role="${esc(r)}" aria-label="Open role ${esc(r)}">${chip(r, 'neutral', 'Open this role')}</button>`).join('')}</div>`
  : `<p class="chip-list-empty">${esc(empty)}</p>`;

/** "2027-01-31" → the portal's date format plus how far away it is. */
function expiry(d: string): string {
  const at = new Date(`${d}T00:00:00`);
  if (Number.isNaN(at.getTime())) return esc(d);
  const past = at.getTime() < Date.now();
  return `${esc(when(at))} <span class="dim">· ${past ? 'expired' : esc(relative(at))}</span>`;
}
const today = (): string => new Date().toISOString().slice(0, 10);

/* ── The concrete access chain: "%DB_USER  RW  via %Developer" ── */

interface AccessGrant { src: Source; perms: string }
/** One row per resource: the union of the permission letters, and every role (or rule) they come through. */
interface AccessLine { res: string; perms: string; via: AccessGrant[]; everyone: boolean }
const isEveryone = (src: Source): boolean => src.kind === 'public' || src.kind === 'everyone-user';
/** Every resource the user reaches, with the permission letters and the roles (or rules) they come through. */
function accessLines(g: SecurityGraph, user: string): { full: Source | null; lines: AccessLine[] } {
  const a = g.userAccess(user);
  if (a.full) return { full: a.full, lines: [] };
  const lines: AccessLine[] = [];
  for (const [res, m] of a.grants) {
    const bySrc = new Map<string, { src: Source; letters: string }>();
    for (const [c, src] of m) {
      const k = JSON.stringify(src);
      const e = bySrc.get(k) ?? { src, letters: '' };
      e.letters += c;
      bySrc.set(k, e);
    }
    if (!bySrc.size) continue;
    // The user's own roles first; what every user gets after.
    const via = [...bySrc.values()].sort((x, y) => Number(isEveryone(x.src)) - Number(isEveryone(y.src)))
      .map((e) => ({ src: e.src, perms: normPerms(e.letters) }));
    lines.push({ res, perms: normPerms(via.map((v) => v.perms).join('')), via, everyone: via.every((v) => isEveryone(v.src)) });
  }
  // What this user gets through their own roles first; what everyone gets after.
  lines.sort((x, y) => Number(x.everyone) - Number(y.everyone) || x.res.localeCompare(y.res));
  return { full: null, lines };
}
// Not ui.ts roleLink: a monospace link to the Roles page, not a chip.
const roleLink = (r: string): string => `<a href="#/security/roles" data-role="${esc(r)}" class="mono">${esc(r)}</a>`;
/** "via %Developer" (the role the user holds), the whole path in the tooltip. */
function viaHtml(src: Source | null): { html: string; title: string } {
  if (!src) return { html: '', title: '' };
  switch (src.kind) {
    case 'role': return { html: `via ${roleLink(src.path[0])}`, title: `via ${src.path.join(' → ')}` };
    case 'everyone-user': return { html: `every user (${roleLink(src.path[src.path.length - 1] ?? PUBLIC_USER)})`, title: `Every user gets this through ${PUBLIC_USER}${src.path.length ? ` → ${src.path.join(' → ')}` : ''}` };
    case 'public': return { html: 'public', title: 'Public permission: every connection gets it' };
    case 'app': return { html: `in ${esc(src.app)}`, title: `Only while using ${src.app}` };
  }
}
/**
 * The effective-resources list: one row per resource, so its length is the "Resources" count everywhere.
 * `limit` rows show; with `expand`, the rest are in the list but hidden behind "Show all N".
 */
function accessListHtml(g: SecurityGraph, user: string, limit = Infinity, expand = false, opened = false): { html: string; total: number; full: boolean } {
  const { full, lines } = accessLines(g, user);
  if (full) {
    // %All is named in the Roles strip cell; here it's simply everything (the path is a hover away).
    return { html: `<ul class="sec-access"><li><span class="sec-res" title="${esc(viaHtml(full).title)}">Everything</span><span class="sec-via"></span></li></ul>`, total: 0, full: true };
  }
  if (!lines.length) return { html: '<p class="sec-access-more">Nothing beyond what every user gets.</p>', total: 0, full: false };
  const shown = expand ? lines : lines.slice(0, limit);
  const more = expand && lines.length > limit;
  return {
    total: lines.length, full: false,
    html: `<ul class="sec-access">${shown.map((l, i) => {
      const first = viaHtml(l.via[0]?.src ?? null);
      const title = l.via.map((v) => `${v.perms} ${viaHtml(v.src).title}`).join('\n');
      const extra = l.via.length > 1 ? ` <span class="dim">+ ${l.via.length - 1}</span>` : '';
      return `<li${i >= limit ? `${opened ? '' : ' hidden'} data-more-row` : ''}><span class="sec-res"><a href="#/security/resources" data-res="${esc(l.res)}" class="mono">${esc(l.res)}</a> <b class="sec-perm">${esc(l.perms)}</b></span><span class="sec-via" title="${esc(title)}">${first.html}${extra}</span></li>`;
    }).join('')}</ul>${more ? `<p class="sec-access-more"><button type="button" class="link" data-show-all data-total="${lines.length}" aria-expanded="${opened}">${opened ? 'Show fewer' : `Show all ${lines.length}`}</button></p>` : ''}`,
  };
}

/** Two-factor as one choice: IRIS allows only one kind at a time. */
const twoFactorOf = (mask: number): string => (hasBit(mask, TWO_FACTOR_SMS) ? 'sms' : hasBit(mask, TWO_FACTOR_TOTP) ? 'totp' : 'off');
function twoFactorMask(mask: number, choice: string): number {
  let m = withBit(mask, TWO_FACTOR_SMS, choice === 'sms');
  m = withBit(m, TWO_FACTOR_TOTP, choice === 'totp');
  return m;
}

/** Blank record for "New user"; also the base a copy starts from. */
const BLANK: UserDetail = {
  FullName: '', Enabled: true, AccountNeverExpires: false, PasswordNeverExpires: false, ExpirationDate: '',
  ChangePassword: true, AutheEnabled: 0, HOTPKeyDisplay: false, Roles: [], EscalationRoles: [],
  NameSpace: '', Routine: '', EmailAddress: '', PhoneNumber: '', PhoneProvider: '', Comment: '',
};

export function usersScreen(ctx: ScreenCtx): void {
  ctx.fill();
  // Two levels, as in Processes: the list with a peek, and a full view of one user (#/security/users/<name>).
  ctx.body.innerHTML = `
    <div class="od-list" id="user-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="user-search" size="sm" full-width placeholder="Filter by username, full name or namespace"></ev-search></div>
        <ev-segmented-button id="user-scope" size="sm" aria-label="Show users"></ev-segmented-button>
      </div>
      <ev-detail-panel id="user-panel" detail-width="500" class="workspace">
        <div class="grid-wrap grid-wrap--sec" id="user-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="user-detail" aria-label="User details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="user-foot"></p>
    </div>
    <div id="user-full" hidden></div>`;
  const listView = ctx.body.querySelector('#user-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#user-full') as HTMLElement;
  // The instance-wide security banner belongs to the list; the full view shows only this user's own facts.
  const bannerSync = new MutationObserver(() => { ctx.banners.hidden = listView.hidden; });
  bannerSync.observe(listView, { attributes: true, attributeFilter: ['hidden'] });
  ctx.onLeave(() => { bannerSync.disconnect(); ctx.banners.hidden = false; });

  const scopeEl = ctx.body.querySelector('#user-scope') as HTMLElement & { options: unknown; value: string };
  scopeEl.value = 'all';
  const panel = ctx.body.querySelector('#user-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#user-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#user-detail') as HTMLElement;
  const searchEl = ctx.body.querySelector('#user-search') as HTMLElement & { value: string };
  let grid: GridEl | null = null;
  let all: UserSummary[] = [];
  let graph: SecurityGraph | null = null;
  let query = '';
  let scope: Scope = 'all';
  let selected: string | null = null;
  let current: UserDetail | null = null;
  let pending = takeSelection();
  let token = 0;
  let alive = true;
  let mode: Mode = 'view';
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  let canSecure = true;
  let me = '';

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
  /** True when it's fine to leave the current form (or there isn't one). */
  const guard = async (): Promise<boolean> => (editor ? editor.guard() : true);
  /** Paging, the breadcrumb or Esc in the full view: ask about unsaved changes, then drop a form that took the body's place. */
  const canLeaveFull = async (): Promise<boolean> => {
    if (!(await guard())) return false;
    if (formFull) endEdit();
    return true;
  };

  /** Boxes in a chain open what they name. */
  const chainLinks: ChainLinks = {
    user: (n) => void selectUser(n),
    role: (n) => linkTo(ctx.navigate, 'security/roles', n),
    resource: (n) => linkTo(ctx.navigate, 'security/resources', n),
  };
  /** "Create a read-only role" from the role picker: New role, pre-filled with Read. */
  const createReadOnly = (dbRole: string): void => {
    stashNewRole({ resources: [{ Name: dbRole, Permissions: 'R' }], description: `Read-only access to ${dbRole.replace(/^%DB_/i, '')}` });
    linkTo(ctx.navigate, 'security/roles', '');
  };
  /** A fix from Check access. */
  const applyFix = async (f: CheckFix): Promise<void> => {
    if (!(await guard())) return;
    const u = current ?? (await getUser(f.user).catch(() => null));
    // Every fix opens a pre-filled form; saving it goes through the usual warnings.
    const full = od.mode() === 'full';
    if (f.kind === 'enable' && u) { endEdit(); openEdit(f.user, u, { Enabled: true }, full); return; }
    if (f.kind === 'add-role' && u) { endEdit(); openEdit(f.user, u, { Roles: [...u.Roles, f.role] }, full); return; }
    if (f.kind === 'new-role') {
      stashNewRole({ resources: [{ Name: f.resource, Permissions: f.perm }], forUser: f.user });
      linkTo(ctx.navigate, 'security/roles', '');
    }
  };
  /** Select a user in this screen (after the guard), clearing filters that would hide it. */
  const selectUser = async (name: string): Promise<void> => {
    const hit = all.find((u) => u.Name.toLowerCase() === name.toLowerCase());
    if (!hit || !(await guard())) return;
    endEdit();
    if (!visible().some((u) => u.Name === hit.Name)) { query = ''; scope = 'all'; searchEl.value = ''; scopeEl.value = 'all'; renderToolbar(); }
    selected = hit.Name;
    renderGrid();
    void renderDetail();
    scrollToSelected();
  };
  const scrollToSelected = (): void => {
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };
  const renderRisk = (): void => {
    const host = ctx.banners;
    mountSecurityBanner(host, graph, null, { shared: true }); // instance-wide posture: shown here, where UnknownUser lives
  };

  const newBtn = newButton(ctx, 'New user', () => { void guard().then((ok) => { if (ok) openCreate(null); }); });
  void sessionInfo().then((info) => {
    canSecure = can(info, 'Secure') !== false;
    me = info.username;
    newBtn.setHidden(!canSecure);
    if (mode === 'view' && selected) void renderDetail(true);
  }).catch(() => { /* keep defaults; IRIS still refuses what isn't allowed */ });

  const inScope = (u: UserSummary, s: Scope): boolean => s === 'all' || (s === 'enabled' ? u.Enabled : !u.Enabled);
  const visible = (): UserSummary[] => all.filter((u) => {
    if (!inScope(u, scope)) return false;
    if (!query) return true;
    const ql = query.toLowerCase();
    return [u.Name, u.FullName, u.Namespace, u.Routine, u.Type].some((f) => f?.toLowerCase().includes(ql));
  });

  const renderToolbar = (): void => {
    const n = (s: Scope): number => all.filter((u) => inScope(u, s)).length;
    const opt = (value: Scope, label: string): { value: Scope; label: string; disabled: boolean } =>
      ({ value, label: `${label} ${n(value)}`, disabled: n(value) === 0 && scope !== value });
    setChips(scopeEl, all.length, [opt('all', 'All'), opt('enabled', 'Enabled'), opt('disabled', 'Disabled')], { active: scope, search: searchEl, query });
  };

  const renderFoot = (): void => {
    const enabled = all.filter((u) => u.Enabled).length;
    const priv = graph ? all.filter((u) => u.Enabled && privilege(graph, u.Name)?.length).length : null;
    (ctx.body.querySelector('#user-foot') as HTMLElement).innerHTML =
      `<b>${all.length}</b> users<span class="meta-sep">·</span><b>${enabled}</b> enabled`
      + (priv === null ? '' : `<span class="meta-sep">·</span><b>${priv}</b> privileged`);
  };

  const applyColumns = (): void => {
    if (!grid) return;
    const uniform = uniformKeys(all, MAYBE_UNIFORM) as Set<string>;
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  /** Forms open the panel themselves (objectDetail opens it for the peek). */
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const close = (): void => {
    // A form in the full view's body gives the body back (the full view then says the user is gone).
    if (formFull) { endEdit(); fullEl.innerHTML = ''; od.refresh(); }
    endEdit(); current = null; token++;
    if (od.selected() !== null) { void od.select(null); return; }
    selected = null; grid?.select([]); setPanel(false);
  };

  /* ── Guard rails ───────────────────────────────────────── */

  /** Enabled holders of %All other than `name` — IRIS needs at least one. */
  const otherAllHolders = (name: string): string[] => (graph?.allHolders() ?? []).filter((u) => u !== name);
  const holdsAll = (name: string): boolean => !!graph?.userAccess(name).full;
  const lastAllHolder = (name: string): boolean => !!graph && holdsAll(name) && otherAllHolders(name).length === 0;
  const deleteReason = (name: string): string | null => {
    if (!canSecure) return NO_SECURE;
    if (UNDELETABLE_USERS.includes(name)) return 'IRIS needs this account, so it can’t be deleted. You can disable it instead.';
    if (lastAllHolder(name)) return 'This is the last account with full access (%All). Give another account %All first.';
    return null;
  };
  const disableReason = (name: string, enabled: boolean): string | null => {
    if (!canSecure) return NO_SECURE;
    if (name === PUBLIC_USER) return 'This account never signs in, so it has nothing to disable. Its roles still apply to every user.';
    if (enabled && lastAllHolder(name)) return 'This is the last account with full access (%All). Give another account %All first.';
    return null;
  };
  const passwordReason = (name: string, type: string | undefined): string | null => {
    if (!canSecure) return NO_SECURE;
    if (name === PUBLIC_USER || name === ANON_USER) return 'This account never signs in with a password.';
    if (!isPasswordUser(type)) return `This account signs in with ${signIn(type ?? '')}, so its password is kept outside IRIS.`;
    return null;
  };

  /* ── View mode ─────────────────────────────────────────── */

  /** "Holds %All directly → full access", or the actual path, for the account anyone connects as. */
  function anonPath(g: SecurityGraph | null, name: string, roles: string[]): string {
    if (!roles.length) return 'Holds no roles → only what every user gets';
    const full = g?.userAccess(name).full;
    if (full && full.kind === 'role') {
      return full.path.length === 1 ? `Holds ${full.path[0]} directly → full access` : `Holds ${full.path.join(' → ')} → full access`;
    }
    return `Holds ${roles.join(', ')} → what anyone gets without signing in`;
  }

  /* ── Peek and full view: objectDetail() ─────────────────── */

  /** The detail record of the user shown, so the header's menu can act without another read. */
  let currentName = '';
  const withUser = async (name: string, fn: (u: UserDetail) => void): Promise<void> => {
    try { fn(current && currentName === name ? current : await getUser(name)); } catch (e) { toast(errorText(e), 'danger'); }
  };
  const stateOf = (name: string, enabled: boolean): { label: string; tone: 'success' | 'neutral'; title?: string } =>
    name === PUBLIC_USER ? { label: 'Never signs in', tone: 'neutral' }
      : name === ANON_USER ? (enabled ? { label: 'No sign-in', tone: 'success', title: ANON_TEXT } : { label: 'Disabled', tone: 'neutral', title: 'Unauthenticated requests are refused' })
        : enabled ? { label: 'Enabled', tone: 'success' } : { label: 'Disabled', tone: 'neutral', title: 'This account cannot sign in' };
  /** "● Enabled · Full name · Privileged · Built-in": row 2 of the peek and the full-view subtitle. */
  const metaOf = (s: UserSummary): string => {
    const priv = privilege(graph, s.Name);
    return odMeta(stateOf(s.Name, s.Enabled), [
      s.FullName,
      priv?.length ? 'Privileged' : '',
      builtInUser(s.Name) ? 'Built-in' : '',
      s.Name === me ? 'Current session' : '',
    ]);
  };
  /* ── Sign-in history (OSCA API; hidden when it isn't installed) ── */
  /** null until known; false hides every sign-in fact. */
  let oscaOk: boolean | null = null;
  apiAvailable().then((ok) => { oscaOk = ok; if (alive && selected !== null && mode === 'view') void renderDetail(true); }).catch(() => { oscaOk = false; });
  /** One read per user per minute: the list polls every 30 s. */
  const historyCache = new Map<string, { at: number; h: LoginHistory | null }>();
  const history = async (name: string): Promise<LoginHistory | null> => {
    if (!oscaOk) return null;
    const c = historyCache.get(name);
    if (c && Date.now() - c.at < 60_000) return c.h;
    const h = await getLoginHistory(name, 10).catch(() => null);
    historyCache.set(name, { at: Date.now(), h });
    return h;
  };
  const loginsOff = (h: LoginHistory): boolean => h.auditing === false || h.loginEventsEnabled === false;
  const OFF_LINE = '<span class="dim">Sign-ins aren’t recorded: login auditing is off</span> · <a class="link" href="#/logs/audit">Audit log</a>';
  const loginTime = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : when(d); };
  /** The peek's row value: the last successful sign-in, or why there isn't one. */
  const lastLoginValue = (h: LoginHistory): string => {
    if (loginsOff(h)) return OFF_LINE;
    const ok = h.items.find((x) => x.success);
    return ok ? `${esc(loginTime(ok.time))}${ok.ip || ok.client ? ` <span class="dim">· ${esc(ok.client || ok.ip)}</span>` : ''}` : `<span class="dim">None in ${h.days} days</span>`;
  };
  /** Recent sign-ins: time, event, client or address, service. */
  const loginsCard = (h: LoginHistory): string => {
    if (loginsOff(h)) return `<p class="sec-access-more">${OFF_LINE}</p>`;
    if (!h.items.length) return `<p class="sec-access-more">No sign-ins in the last ${h.days} days.</p>`;
    return `<table class="sec-logins"><thead><tr><th>Time</th><th>Event</th><th>From</th><th>Service</th></tr></thead><tbody>${h.items.slice(0, 10).map((x) => `
      <tr><td>${esc(loginTime(x.time))}</td>
        <td>${x.success ? 'Signed in' : `<span style="color:var(--ev-color-warning)"${x.reason ? ` title="${esc(x.reason)}"` : ''}>Failed</span>`}</td>
        <td class="mono" title="${esc([x.client, x.ip].filter(Boolean).join(' · '))}">${esc(x.client || x.ip || '—')}</td>
        <td title="${esc(x.application || '')}">${esc(x.service || '—')}</td></tr>`).join('')}</tbody></table>`;
  };
  const menuFor = (s: UserSummary): MenuItem[] => {
    const name = s.Name;
    const dis = disableReason(name, s.Enabled);
    const pw = passwordReason(name, s.Type);
    const del = deleteReason(name);
    return [
      { label: 'Change password', icon: 'key-round', disabled: !!pw, reason: pw ?? undefined, onSelect: () => { void formHere((full) => openPassword(name, full)); } },
      { label: s.Enabled ? 'Disable…' : 'Enable', icon: s.Enabled ? 'eye-off' : 'eye', disabled: !!dis, reason: dis ?? undefined, onSelect: () => void withUser(name, (u) => void toggleEnabled(name, u)) },
      { label: 'Copy…', icon: 'copy', disabled: !canSecure, reason: canSecure ? undefined : NO_SECURE, onSelect: () => void withUser(name, (u) => { void formHere((full) => openCreate({ from: name, user: u }, full)); }) },
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!del, reason: del ?? undefined, onSelect: () => void withUser(name, (u) => void remove(name, u)) },
    ];
  };
  /**
   * Open a form where the user is looking: from the list it opens in the drawer; from the full view
   * (#/security/users/<name>) it takes the body's place, so the address, title and ‹ › pager stay,
   * and Cancel or Save bring the full view back. An open form is asked about first.
   */
  const formHere = async (fn: (full: boolean) => void): Promise<void> => {
    if (!(await guard())) return;
    endEdit();
    fn(od.mode() === 'full');
  };

  /**
   * UnknownUser, enabled: the app's one "Anyone can connect" callout (the same component, colour and
   * words as Web applications and Services), red when it holds %All. The role path is its tooltip.
   */
  const anonNotice = (name: string, u: UserDetail, roles: string[]): string => {
    if (name !== ANON_USER || !u.Enabled) return '';
    return anyoneNotice({ full: !!graph?.userAccess(name).full, roles, title: anonPath(graph, name, roles) });
  };
  /** The notes above a user's facts: who this account is and where its details come from. */
  const notesHtml = (s: UserSummary, u: UserDetail, _roles: string[]): string => {
    const name = s.Name;
    const builtIn = builtInUser(name);
    const anon = name === ANON_USER && u.Enabled;
    return `
      ${name === PUBLIC_USER ? `<div class="sec-callout" role="note"><ev-icon name="info" size="sm"></ev-icon><div>
          <strong>Every user gets this account’s roles</strong><span>It never signs in itself. Give it a role only if everyone, including unauthenticated requests, should have it.</span>
        </div></div>` : ''}
      ${builtIn && !anon && name !== PUBLIC_USER ? `<p class="sec-desc">${esc(builtIn)}</p>` : ''}
      ${!isPasswordUser(s.Type) ? `<p class="sec-desc">Details for this account come from ${esc(signIn(s.Type))}; changes made here may be replaced the next time they sign in.</p>` : ''}`;
  };
  /** Account facts, the same rows in the peek and the full view (the full view has Last sign-in in its strip). */
  const accountKv = (u: UserDetail, h: LoginHistory | null): string => odKv([
    ['Account expires', u.ExpirationDate ? expiry(u.ExpirationDate) : 'No expiry date'],
    ['Inactivity lockout', u.AccountNeverExpires ? 'Exempt' : 'System limit applies', u.AccountNeverExpires ? 'Never disabled for being unused' : 'Disabled automatically after the system-wide inactivity limit'],
    ['Password expiry', u.PasswordNeverExpires ? 'Never expires' : 'System policy applies'],
    ['Change password at next sign-in', u.ChangePassword ? 'Yes' : 'No'],
    ...(h ? [['Last sign-in', lastLoginValue(h)] as [string, string]] : []),
  ]);
  /** How the account signs in (the full view has "Signs in with" in its strip). */
  const signInKv = (s: UserSummary, u: UserDetail, withType: boolean): string => {
    const methods = decodeAuthe(u.AutheEnabled);
    const twoFactor = methods.filter((m) => m.startsWith('Two-factor'));
    const other = methods.filter((m) => !m.startsWith('Two-factor'));
    const ns = u.NameSpace || s.Namespace || '';
    const routine = u.Routine || s.Routine || '';
    return odKv([
      ...(withType && s.Name !== ANON_USER ? [['Signs in with', esc(signIn(s.Type))] as [string, string]] : []),
      ['Two-factor', twoFactor.length ? esc(twoFactor.map((m) => m.replace('Two-factor by ', '')).join(', ')) : muted('Off')],
      ...(other.length ? [['Other methods', esc(other.join(', '))] as [string, string]] : []),
      ['Default namespace', ns ? `<span class="mono">${esc(ns)}</span>` : muted('Instance default')],
      ['Startup routine', routine ? `<span class="mono">${esc(routine)}</span>` : muted('—')],
    ]);
  };
  const contactKv = (u: UserDetail): string => odKv([
    ['Email', u.EmailAddress ? esc(u.EmailAddress) : muted('—')],
    ['Mobile phone', u.PhoneNumber ? `<span class="mono">${esc(u.PhoneNumber)}</span>` : muted('—')],
  ]);

  async function peekBody(s: UserSummary): Promise<string> {
    const name = s.Name;
    const [u, h] = await Promise.all([getUser(name), history(name)]);
    current = u; currentName = name;
    const g = graph;
    const roles = [...u.Roles].sort();
    const through = g ? [...g.userEffective(name)].filter((r) => !roles.includes(r)).sort() : [];
    const access = g ? accessListHtml(g, name, PEEK_LINES) : null;
    // "Effective resources · 100": one row per resource, the same number as the full view's Resources.
    return `
      ${anonNotice(name, u, roles)}
      ${notesHtml(s, u, roles)}
      ${odSection('Roles', `${roleChips(roles, 'No roles: only what every user gets')}${through.length ? `<p class="chip-sub">Also through those roles</p>${roleChips(through, '')}` : ''}`)}
      ${odSection(`Effective resources${access?.total ? ` · ${access.total}` : ''}`, g && access
        ? `<p class="acc-headline">${esc(accessHeadline(g, name))}</p>${access.html}${access.total > PEEK_LINES ? `<p class="sec-access-more"><button type="button" class="link" data-full="${esc(name)}">All ${access.total} in the full view</button></p>` : ''}`
        : '<p class="chip-list-empty">Working it out…</p>')}
      ${odSection('Account', accountKv(u, h))}
      ${odSection('Sign-in', signInKv(s, u, true))}
      ${u.EmailAddress || u.PhoneNumber ? odSection('Contact', contactKv(u)) : ''}
      ${u.Comment ? odSection('Comment', `<p class="detail-para">${esc(u.Comment)}</p>`) : ''}`;
  }

  const PEEK_LINES = 8;
  const accessHeadline = (g: SecurityGraph, name: string): string => {
    const a = g.userAccess(name);
    if (a.full) return 'Full access to everything.';
    const p = privilege(g, name);
    return p?.length ? `Privileged: ${privilegeLine(p)}.` : 'Standard access.';
  };

  /** Check access, compact: one select in the Effective resources header, the answer at the top of the card. */
  const checkSelect = (g: SecurityGraph): string => {
    const targets = [
      ...g.namespaces.map((n) => ({ v: `ns:${n.Name}`, t: `Namespace ${n.Name}` })),
      ...[...g.resources].sort((a, b) => a.Name.localeCompare(b.Name)).map((x) => ({ v: `res:${x.Name}`, t: targetLabel(g, x.Name) })),
    ];
    return `<ev-select id="su-check" class="su-check" size="sm" searchable placeholder="Check access…" aria-label="Check access to">${targets.map((x) => `<option value="${esc(x.v)}">${esc(x.t)}</option>`).join('')}</ev-select>`;
  };

  /** "Resources 100" (caption "6 admin powers"): distinct resources the user reaches, and how many of those are admin powers. */
  const resourcesCell = (g: SecurityGraph | null, name: string): { label: string; value: string; caption?: string; title?: string } => {
    if (!g) return { label: 'Resources', value: '—' };
    const a = g.userAccess(name);
    if (a.full) return { label: 'Resources', value: 'All', title: 'Holds %All: every resource' };
    const res = [...a.grants.keys()].filter((r) => a.grants.get(r)?.size);
    const admin = res.filter((r) => groupOf(g.resource(r)?.ResourceType, r) === 'Admin powers').length;
    return { label: 'Resources', value: String(res.length), caption: admin ? `${admin} admin power${admin === 1 ? '' : 's'}` : '' };
  };

  /** Rows of the full view's resource list before "Show all N". */
  const FULL_LINES = 12;
  /** The user whose full resource list is open: kept across the 30 s refresh. */
  let allResFor = '';
  async function fullOf(s: UserSummary): Promise<OdFull> {
    const name = s.Name;
    selected = name; // a deep link opens here directly: later loads (the graph) refresh what's shown
    const [u, h] = await Promise.all([getUser(name), history(name)]);
    const lastOk = h && !loginsOff(h) ? h.items.find((x) => x.success) : undefined;
    current = u; currentName = name;
    const g = graph;
    const roles = [...u.Roles].sort();
    const through = g ? [...g.userEffective(name)].filter((r) => !roles.includes(r)).sort() : [];
    const list = g ? accessListHtml(g, name, FULL_LINES, true, allResFor === name) : null;
    const apps = g ? g.webApps.filter((a) => a.Enabled && (!a.Resource || g.check(name, a.Resource, 'U').ok)).map((a) => a.Name).sort() : [];
    // Everything the peek says, and more: its notes and the comment open the first card.
    // A long resource list keeps the account facts beside it on the first screen; a short one (Everything, a few rows) has them under it.
    const facts = [{ title: 'Account', body: accountKv(u, null), id: 'su-c-account' }, { title: 'Sign-in', body: signInKv(s, u, false), id: 'su-c-signin' }];
    const factsBeside = !!list && list.total > 4;
    const notes = `${notesHtml(s, u, roles)}${u.Comment ? `<p class="sec-desc">${esc(u.Comment)}</p>` : ''}`;
    return {
      strip: [
        { label: 'Signs in with', value: name === ANON_USER ? 'No sign-in' : name === PUBLIC_USER ? 'Never signs in' : signIn(s.Type) },
        // A count, never a list: names don't fit a tile. The Roles card lists them; the tooltip names them too.
        { label: 'Roles', value: roles.length ? `${roles.length} role${roles.length === 1 ? '' : 's'}` : 'None', caption: through.length ? `+ ${through.length} through them` : '',
          title: [roles.length ? `Holds ${roles.join(', ')}` : 'Holds no roles', through.length ? `Also through them: ${through.join(', ')}` : ''].filter(Boolean).join(' · ') },
        // "Privileged" is already in the subtitle: the strip gives the quantity instead.
        resourcesCell(g, name),
        ...(h ? [loginsOff(h)
          ? { label: 'Last sign-in', value: 'Not recorded', caption: '<a class="link" href="#/logs/audit">Login auditing is off</a>' }
          : { label: 'Last sign-in', value: lastOk ? loginTime(lastOk.time) : 'None', caption: lastOk ? esc(lastOk.client || lastOk.ip || '') : `in ${h.days} days`, title: lastOk ? `${lastOk.service} · ${lastOk.authentication}` : '' }] : []),
      ],
      notice: anonNotice(name, u, roles) || undefined,
      main: [
        { title: 'Effective resources', head: g ? checkSelect(g) : '', id: 'su-res',
          body: `${notes}<div id="su-check-out" class="check-result" aria-live="polite"></div>${g ? `<p class="acc-headline">${esc(accessHeadline(g, name))}</p>` : ''}${list ? list.html : '<p class="sec-access-more">Working it out…</p>'}${list?.total ? '<p class="sec-access-more">Includes what every user gets.</p>' : ''}` },
        ...(factsBeside ? [] : facts),
        ...(h ? [{ title: 'Recent sign-ins', body: loginsCard(h) }] : []),
      ],
      side: [
        // Their own roles first (the fact that makes an account privileged), then what those roles bring.
        { title: 'Roles', body: `${roleChips(roles, 'No roles: only what every user gets')}${through.length ? `<p class="chip-sub">Also through their roles</p>${roleChips(through, '')}` : ''}${u.EscalationRoles.length ? `<p class="chip-sub">Can switch to</p>${roleChips([...u.EscalationRoles].sort(), '')}` : ''}` },
        ...(factsBeside ? facts : []),
        { title: 'Contact', body: contactKv(u), id: 'su-c-contact' },
        { title: 'Web applications they can open', id: 'su-c-apps', head: g ? `<span class="card-hint">${apps.length}</span>` : '', body: !g ? '<p class="sec-access-more">Working it out…</p>' : apps.length
          ? `<ul class="su-apps">${apps.slice(0, 12).map((a) => `<li class="mono">${esc(a)}</li>`).join('')}</ul>${apps.length > 12 ? `<p class="sec-access-more">+ ${apps.length - 12} more in <a href="#/web/apps">Web applications</a></p>` : ''}`
          : '<p class="sec-access-more">None</p>' },
      ],
    };
  }

  /** The full view's cards that may sit in either column, in reading order (Recent sign-ins, a table, stays in the wide one). */
  const MOVABLE = ['su-c-account', 'su-c-signin', 'su-c-contact', 'su-c-apps'];
  /**
   * Even the two columns: Effective resources heads the left, Roles the right, and the other cards go
   * where the two columns end closest together (reading order kept inside each column). Measured, not
   * guessed: a user's resource list, roles and apps vary from a line to a screen.
   */
  const balanceColumns = (root: HTMLElement): void => {
    const [left, right] = [...root.querySelectorAll<HTMLElement>('.od-cols > .od-col')];
    if (!left || !right || left.getBoundingClientRect().top !== right.getBoundingClientRect().top) return; // one column: nothing to balance
    const cards = MOVABLE.map((id) => root.querySelector<HTMLElement>(`#${id}`)).filter((c): c is HTMLElement => !!c);
    const gap = parseFloat(getComputedStyle(left).rowGap) || 16;
    const fixed = (col: HTMLElement): number => [...col.children].filter((c) => !cards.includes(c as HTMLElement)).reduce((n, c) => n + (c as HTMLElement).offsetHeight + gap, 0);
    const baseL = fixed(left); const baseR = fixed(right);
    const hs = cards.map((c) => c.offsetHeight + gap);
    let best = -1; let bestDiff = Infinity;
    for (let mask = 0; mask < 1 << cards.length; mask++) {
      let l = baseL; let r = baseR;
      hs.forEach((hgt, i) => { if (mask & (1 << i)) l += hgt; else r += hgt; });
      // Account and Sign-in read as a pair: split them only when that evens the columns by more than a card row or two.
      const d = Math.abs(l - r) + (cards[0]?.id === 'su-c-account' && cards[1]?.id === 'su-c-signin' && ((mask & 1) ^ ((mask >> 1) & 1)) ? 80 : 0);
      if (d < bestDiff - 1) { bestDiff = d; best = mask; }
    }
    cards.forEach((c, i) => ((best & (1 << i)) ? left : right).appendChild(c));
  };

  const od = objectDetail<UserSummary>(ctx, {
    collection: 'Users', noun: 'user',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (u) => u.Name,
    find: (k) => all.find((u) => u.Name === k) ?? all.find((u) => u.Name.toLowerCase() === k.toLowerCase()),
    order: () => visible().map((u) => u.Name).sort((a, b) => a.localeCompare(b)),
    name: (u) => u.Name, mono: true,
    meta: metaOf,
    primary: (s) => ({ label: 'Edit', icon: 'edit-2', blocked: canSecure ? null : NO_SECURE, run: () => void withUser(s.Name, (u) => { void formHere((full) => openEdit(s.Name, u, undefined, full)); }) }),
    menu: menuFor,
    peek: peekBody,
    loadFull: fullOf,
    wire: (root, s, where) => {
      if (where === 'full') balanceColumns(root);
      if (where !== 'full' || !graph) return;
      const g = graph;
      const out = root.querySelector<HTMLElement>('#su-check-out');
      root.querySelector('#su-check')?.addEventListener('ev-select-change', (e) => {
        const v = (e as CustomEvent<{ value: string | string[] }>).detail.value;
        const target = Array.isArray(v) ? v[0] ?? '' : v;
        if (!out || !target) return;
        const t: CheckTarget = target.startsWith('ns:') ? { kind: 'namespace', name: target.slice(3) }
          : { kind: 'resource', name: target.slice(4), perm: /^%DB_/i.test(target.slice(4)) ? 'R' : 'U' };
        out.innerHTML = renderAccessCheck(runAccessCheck(g, s.Name, t, chainLinks), (f) => void applyFix(f));
      });
    },
    onSelect: (k) => {
      selected = k;
      if (k === null) { current = null; currentName = ''; }
      grid?.select(k ? [k] : []);
    },
    onPeek: () => applyColumns(),
    canLeave: canLeaveFull,
    widthKey: 'osca-portal:peek-width:security/users',
  });

  /** Show the selected user in the peek (or refresh what's shown), unless a form is open. */
  const renderDetail = async (_quiet = false): Promise<void> => {
    if (mode !== 'view') return;
    if (selected === null) { if (od.selected() !== null) await od.select(null); else setPanel(false); return; }
    if (od.selected() === selected) od.refresh(); else await od.select(selected);
  };

  // Links in the peek and the full view: roles, resources, "All N in the full view".
  const onLink = (e: Event): void => {
    const t = e.target as HTMLElement;
    const role = t.closest<HTMLElement>('a[data-role], .chip-link[data-role]');
    const res = t.closest<HTMLElement>('a[data-res]');
    const fullBtn = t.closest<HTMLElement>('[data-full]');
    if (role) { e.preventDefault(); linkTo(ctx.navigate, 'security/roles', role.dataset.role ?? ''); }
    else if (res) { e.preventDefault(); linkTo(ctx.navigate, 'security/resources', res.dataset.res ?? ''); }
    else if (fullBtn) { e.preventDefault(); void od.openFull(fullBtn.dataset.full ?? ''); }
    else if (t.closest('[data-show-all]')) {
      // Full view: the rest of the resource list opens in place (and folds back).
      const btn = t.closest<HTMLButtonElement>('[data-show-all]') as HTMLButtonElement;
      const rows = fullEl.querySelectorAll<HTMLElement>('[data-more-row]');
      const open = btn.getAttribute('aria-expanded') !== 'true';
      rows.forEach((r) => { r.hidden = !open; });
      btn.setAttribute('aria-expanded', String(open));
      allResFor = open ? selected ?? '' : '';
      btn.textContent = open ? 'Show fewer' : `Show all ${btn.dataset.total ?? ''}`.trim();
    }
  };
  detailEl.addEventListener('click', onLink);
  fullEl.addEventListener('click', onLink);

  /* ── Forms ─────────────────────────────────────────────── */

  const namespaces = (): string[] => graph?.namespaces.map((n) => n.Name) ?? [];
  const roleNames = (): Set<string> => new Set((graph?.roleList ?? []).map((r) => r.Name.toLowerCase()));

  /** Live "X will be able to…" preview for a set of login roles. */
  const previewHtml = (label: string, roles: string[]): string => {
    if (!graph) return '';
    const g = graph;
    const reach = new Set<string>();
    for (const r of [...roles, ...g.publicRoles]) for (const e of g.effective(r)) reach.add(e);
    if (reach.has('%All')) return `<p class="preview-line preview-line--warn"><b>${esc(label)}</b> will have full access to everything (%All).</p>`;
    const byGroup = new Map<string, string[]>();
    const seen = new Map<string, string>();
    for (const r of reach) for (const res of g.roles.get(r)?.Resources ?? []) seen.set(res.Name, normPerms((seen.get(res.Name) ?? '') + res.Permissions));
    for (const res of g.resources) if (res.PublicPermission) seen.set(res.Name, normPerms((seen.get(res.Name) ?? '') + res.PublicPermission));
    for (const [res, p] of seen) {
      const grp = groupOf(g.resource(res)?.ResourceType, res);
      byGroup.set(grp, [...(byGroup.get(grp) ?? []), privilegeText(res, p, g)]);
    }
    const parts = ['Databases', 'Services', 'Admin powers', 'Apps'].filter((k) => byGroup.get(k)?.length).map((k) => {
      const list = (byGroup.get(k) ?? []).sort();
      return `<li><span class="preview-group">${esc(k)}</span> ${esc(list.slice(0, 3).join('; '))}${list.length > 3 ? ` <span class="dim">and ${list.length - 3} more</span>` : ''}</li>`;
    });
    return `<p class="preview-line"><b>${esc(label)}</b> will be able to:</p><ul class="preview-list">${parts.join('')}</ul>
      <p class="preview-note">Includes what every user gets. ${NEXT_SIGN_IN}</p>`;
  };

  function userSections(u: UserDetail, isCreate: boolean, name: string): string {
    const tf = twoFactorOf(u.AutheEnabled);
    return [
      section('General', [
        isCreate ? textField('Name', 'Username', name, { required: true, mono: true, maxlength: 160, autocomplete: 'off', hint: 'Can’t be changed later. Not case-sensitive.' }) : '',
        textField('FullName', 'Full name', u.FullName, { maxlength: 2048 }),
        textareaField('Comment', 'Comment', u.Comment, { rows: 2, maxlength: 2048 }),
      ].join('')),
      section('Sign-in', [
        isCreate ? passwordField('Password', 'Password', { required: true, hint: 'Must meet the instance’s password rules.' }) : '',
        isCreate ? passwordField('Confirm', 'Confirm password', { required: true }) : '',
        checkField('Enabled', 'Enabled', u.Enabled, { toggle: true, hint: 'A disabled account can’t sign in. Existing sessions carry on until they end.' }),
        checkField('ChangePassword', 'Must change password at next sign-in', u.ChangePassword),
        dateField('ExpirationDate', 'Account expires', u.ExpirationDate, { hint: 'Leave empty to never expire.' }),
        checkField('AccountNeverExpires', 'Exempt from inactivity lockout', u.AccountNeverExpires, { hint: 'Otherwise the account is disabled after the instance’s inactivity limit.' }),
        checkField('PasswordNeverExpires', 'Password never expires', u.PasswordNeverExpires),
      ].join('')),
      section('Roles', `<div id="uf-roles"></div><div id="uf-preview" class="preview" aria-live="polite"></div>`,
        { hint: 'Everything this user can do comes from their roles, plus what every user gets.' }),
      section('Startup', [
        namespaceField('NameSpace', 'Default namespace', namespaces(), u.NameSpace),
        textField('Routine', 'Startup routine', u.Routine, { mono: true, maxlength: 64, placeholder: 'tag^routine', hint: 'Terminal only. Runs at sign-in instead of the prompt. Leave empty for the usual prompt.' }),
      ].join('')),
      section('Contact', [
        textField('EmailAddress', 'Email', u.EmailAddress, { maxlength: 512, autocomplete: 'off' }),
        textField('PhoneNumber', 'Mobile phone', u.PhoneNumber, { maxlength: 256, hint: 'Needed for text-message two-factor.' }),
        textField('PhoneProvider', 'Mobile provider', u.PhoneProvider, { maxlength: 256 }),
      ].join('')),
      section('Two-factor', [
        selectField('TwoFactor', 'Second step at sign-in', [
          { value: 'off', label: 'Off' }, { value: 'sms', label: 'Text message code' }, { value: 'totp', label: 'Authenticator app code' },
        ], tf, { hint: 'Only one kind can be on. It applies where the service or app has two-factor switched on.' }),
        checkField('HOTPKeyDisplay', 'Show the authenticator setup key at next sign-in', u.HOTPKeyDisplay),
      ].join('')),
      section('Advanced: escalation roles', `<div id="uf-esc"></div>`,
        { hint: 'Roles the user can switch into for a while, for example to do admin work: in the Terminal, or from the Management Portal home page. While switched, the escalation role replaces their usual roles. Switching needs the Escalate Login service.' }),
      // Edit: what changes appears once something has; New: what happens is there from the start (as on Namespaces).
      `<div data-uf-changes${isCreate ? '' : ' hidden'}>${section(isCreate ? 'What happens' : 'What changes', '<div id="uf-changes" class="preview" aria-live="polite"></div>')}</div>`,
    ].join('');
  }

  /** "What changes": one line per setting that differs from the account as it is. */
  const changeLines = (b: UserDetail, a: UserDetail): string[] => {
    const q = (v: string): string => (v ? `“${v}”` : 'empty');
    const yes = (v: boolean): string => (v ? 'yes' : 'no');
    const list = (xs: string[]): string => xs.join(', ');
    const setDiff = (was: string[], now: string[]): string => [
      ...now.filter((r) => !was.includes(r)).map((r) => `+ ${r}`),
      ...was.filter((r) => !now.includes(r)).map((r) => `− ${r}`),
    ].join(', ');
    const tf = (m: number): string => ({ off: 'off', sms: 'text message code', totp: 'authenticator app code' } as Record<string, string>)[twoFactorOf(m)];
    return [
      b.Enabled !== a.Enabled ? (a.Enabled ? 'Enabled: they can sign in again.' : 'Disabled: they can’t sign in. Sessions already open carry on until they end.') : '',
      b.FullName !== a.FullName ? `Full name: ${q(b.FullName)} → ${q(a.FullName)}.` : '',
      b.Comment !== a.Comment ? 'Comment changes.' : '',
      b.ChangePassword !== a.ChangePassword ? `Must change password at next sign-in: ${yes(a.ChangePassword)}.` : '',
      b.ExpirationDate !== a.ExpirationDate ? `Account expires: ${a.ExpirationDate || 'never'}.` : '',
      b.AccountNeverExpires !== a.AccountNeverExpires ? `Exempt from inactivity lockout: ${yes(a.AccountNeverExpires)}.` : '',
      b.PasswordNeverExpires !== a.PasswordNeverExpires ? `Password never expires: ${yes(a.PasswordNeverExpires)}.` : '',
      JSON.stringify([...b.Roles].sort()) !== JSON.stringify([...a.Roles].sort()) ? `Roles: ${setDiff(b.Roles, a.Roles)}. ${NEXT_SIGN_IN}` : '',
      b.NameSpace !== a.NameSpace ? `Default namespace: ${b.NameSpace || 'instance default'} → ${a.NameSpace || 'instance default'}.` : '',
      b.Routine !== a.Routine ? `Startup routine: ${b.Routine || 'none'} → ${a.Routine || 'none'}.` : '',
      b.EmailAddress !== a.EmailAddress ? `Email: ${q(a.EmailAddress)}.` : '',
      b.PhoneNumber !== a.PhoneNumber || b.PhoneProvider !== a.PhoneProvider ? 'Mobile phone details change.' : '',
      twoFactorOf(b.AutheEnabled) !== twoFactorOf(a.AutheEnabled) ? `Two-factor: ${tf(b.AutheEnabled)} → ${tf(a.AutheEnabled)}.` : '',
      b.HOTPKeyDisplay !== a.HOTPKeyDisplay ? `Show the authenticator setup key at next sign-in: ${yes(a.HOTPKeyDisplay)}.` : '',
      JSON.stringify([...b.EscalationRoles].sort()) !== JSON.stringify([...a.EscalationRoles].sort()) ? `Escalation roles: ${setDiff(b.EscalationRoles, a.EscalationRoles) || list(a.EscalationRoles)}.` : '',
    ].filter(Boolean);
  };
  /** "What happens" for a new user: the account, its sign-in state and its roles. */
  const createLines = (name: string, a: UserDetail): string[] => [
    `${name || 'The new user'} is created ${a.Enabled ? 'and can sign in' : 'disabled, so it can’t sign in yet'}${a.ChangePassword ? ', and must choose a new password at first sign-in' : ''}.`,
    a.Roles.length ? `Roles: ${a.Roles.join(', ')}. Everything they can do comes from these, plus what every user gets.` : 'No roles: only what every user gets.',
    a.ExpirationDate ? `The account expires on ${a.ExpirationDate}.` : '',
  ].filter(Boolean);
  /** Keep the form's "What changes" / "What happens" in step with the fields and pickers. */
  const wireChanges = (host: HTMLElement, lines: () => string[], alwaysShown: boolean): (() => void) => {
    const update = (): void => {
      const out = host.querySelector<HTMLElement>('#uf-changes');
      const box = host.querySelector<HTMLElement>('[data-uf-changes]');
      if (!out || !box) return;
      const ls = lines();
      out.innerHTML = ls.length ? `<ul class="preview-list">${ls.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
      box.hidden = !alwaysShown && !ls.length;
    };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-textarea-input', 'ev-checkbox-change', 'ev-toggle-change', 'ev-select-change', 'ev-date-picker-change']) host.addEventListener(t, update);
    update();
    return update;
  };

  const mountPickers = (label: string, u: UserDetail, onChange: () => void): { roles: () => string[]; esc: () => string[] } => {
    const list = graph?.roleList ?? [];
    const rolesHost = formEl.querySelector('#uf-roles') as HTMLElement;
    const escHost = formEl.querySelector('#uf-esc') as HTMLElement;
    const preview = formEl.querySelector('#uf-preview') as HTMLElement;
    const update = (names: string[]): void => { preview.innerHTML = previewHtml(label || 'This user', names); onChange(); };
    const summary = (r: string): string | null => (graph ? roleSummary(graph, r) : null);
    const rp = rolePicker(rolesHost, { name: 'Roles', label: 'Login roles', all: list, selected: u.Roles, onChange: update, summary, onCreateReadOnly: createReadOnly });
    const ep = rolePicker(escHost, { name: 'EscalationRoles', label: 'Escalation roles', all: list, selected: u.EscalationRoles, onChange: () => onChange(), summary });
    preview.innerHTML = previewHtml(label || 'This user', u.Roles);
    return { roles: () => rp.value(), esc: () => ep.value() };
  };

  const touched = new Set<string>();
  const LABELS: Record<string, string> = {
    Name: 'Username', Password: 'Password', Confirm: 'Confirm password', EmailAddress: 'Email',
    PhoneNumber: 'Mobile phone', PhoneProvider: 'Mobile provider', Routine: 'Startup routine',
  };
  /** Every problem with the form, by field (the shell shows them when Save is pressed). */
  const problems = (v: FormValues, isCreate: boolean): FieldProblem[] => {
    const out: FieldProblem[] = [];
    const add = (field: string, message: string): void => { out.push({ field, label: LABELS[field] ?? field, message }); };
    const str = (k: string): string => String(v[k] ?? '').trim();
    if (isCreate) {
      const n = str('Name');
      if (!n) add('Name', 'Enter a username');
      else if (/[@*]/.test(n)) add('Name', 'A username can’t contain @ or *');
      else if (n.length > 160) add('Name', 'Use 160 characters or fewer');
      else if (all.some((u) => u.Name.toLowerCase() === n.toLowerCase())) add('Name', 'A user with this name already exists');
      else if (roleNames().has(n.toLowerCase())) add('Name', 'A role already has this name; users and roles need different names');
    }
    if (isCreate || 'Password' in v) {
      const p = String(v.Password ?? ''); const c = String(v.Confirm ?? '');
      if (!p) add('Password', 'Enter a password');
      else if (!c) add('Confirm', 'Re-enter the password');
      else if (c !== p) add('Confirm', 'The passwords don’t match');
    }
    const email = str('EmailAddress');
    if (email && !/^[^\s@]+@[^\s@]+$/.test(email)) add('EmailAddress', 'Enter an email address like name@example.com');
    if (v.TwoFactor === 'sms') {
      if (!str('PhoneNumber')) add('PhoneNumber', 'Text-message two-factor needs a mobile number');
      if (!str('PhoneProvider')) add('PhoneProvider', 'Text-message two-factor needs the mobile provider');
    }
    const r = str('Routine');
    if (r && !/^[%\w.]*(\^[%\w.]+)?$/.test(r)) add('Routine', 'Use the form tag^routine or ^routine');
    return out;
  };

  /** The fields a form edits, as IRIS expects them. */
  const toRecord = (v: FormValues, base: UserDetail, roles: string[], escRoles: string[]): UserDetail => ({
    ...base,
    FullName: String(v.FullName ?? '').trim(),
    Comment: String(v.Comment ?? '').trim(),
    Enabled: !!v.Enabled,
    ChangePassword: !!v.ChangePassword,
    ExpirationDate: String(v.ExpirationDate ?? ''),
    AccountNeverExpires: !!v.AccountNeverExpires,
    PasswordNeverExpires: !!v.PasswordNeverExpires,
    NameSpace: String(v.NameSpace ?? ''),
    Routine: String(v.Routine ?? '').trim(),
    EmailAddress: String(v.EmailAddress ?? '').trim(),
    PhoneNumber: String(v.PhoneNumber ?? '').trim(),
    PhoneProvider: String(v.PhoneProvider ?? '').trim(),
    AutheEnabled: twoFactorMask(base.AutheEnabled, String(v.TwoFactor ?? 'off')),
    HOTPKeyDisplay: !!v.HOTPKeyDisplay,
    Roles: roles,
    EscalationRoles: escRoles,
  });
  const diff = (before: UserDetail, after: UserDetail): Partial<UserDetail> => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(after) as Array<keyof UserDetail>) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = after[k];
    }
    return out as Partial<UserDetail>;
  };

  /** Warnings to accept before saving; resolves false to go back to the form. */
  const confirmRisks = async (name: string, before: UserDetail | null, after: UserDetail): Promise<boolean> => {
    const added = after.Roles.filter((r) => !(before?.Roles ?? []).includes(r));
    const addedEsc = after.EscalationRoles.filter((r) => !(before?.EscalationRoles ?? []).includes(r));
    const holdersOf = (r: string): string => {
      const h = graph?.holders(r);
      const n = h ? h.direct.length + h.inherited.length : 0;
      return `${n} user${n === 1 ? ' holds' : 's hold'} ${r} now.`;
    };
    const enabledUsers = all.filter((u) => u.Enabled && u.Name !== PUBLIC_USER).length;
    const risks: GuardRisk[] = [];
    if (name === ANON_USER && added.length) {
      risks.push({ title: `Anyone who connects without signing in would get ${added.join(', ')}`, text: 'UnknownUser is the identity for unauthenticated connections, so its roles are what anyone can do without a password.', impact: 'Applies to every service and web app that allows unauthenticated access.' });
    }
    if (name === PUBLIC_USER && added.length) {
      risks.push({ title: `Every user would get ${added.join(', ')}`, text: `The ${PUBLIC_USER} account’s roles are added to every user, including unauthenticated connections.`, impact: `${enabledUsers} enabled accounts, plus anyone who connects without signing in.` });
    }
    for (const r of [...added, ...addedEsc]) {
      const full = !!graph?.roleAccess(r).full;
      const w = POWERFUL_ROLES[r] ?? (full ? 'Gives full access to everything' : undefined);
      if (!w) continue;
      const esc_ = addedEsc.includes(r) && !added.includes(r);
      risks.push({
        title: `${esc_ ? `${name} could switch to` : `${name} would get`} ${r}`,
        text: `${w}.${esc_ ? ' As an escalation role it replaces their usual roles while they use it.' : ''}`,
        impact: holdersOf(r),
      });
    }
    const loses = before && holdsAll(name) && otherAllHolders(name).length === 0 && (
      (before.Enabled && !after.Enabled)
      || (after.ExpirationDate && after.ExpirationDate !== before.ExpirationDate && after.ExpirationDate <= today())
      || !after.Roles.some((r) => graph?.effective(r).has('%All')));
    if (loses) risks.push({ title: 'No one would have full access', text: `${name} is the last enabled account with %All. IRIS needs at least one, so the change may be refused, or leave no one able to manage the instance.`, impact: 'Give another account %All first.' });
    if (before && name === me && before.Enabled && !after.Enabled) risks.push({ title: 'You would lock yourself out', text: 'You are signed in as this user. Once it’s disabled you can’t sign in again with it.' });
    if (before && name === ANON_USER && before.Enabled && !after.Enabled) risks.push({ title: 'Unauthenticated requests would be refused', text: 'Anything that connects without signing in stops working, including this portal if it runs without sign-in.' });
    if (after.ExpirationDate && after.ExpirationDate < today() && after.ExpirationDate !== before?.ExpirationDate) risks.push({ title: 'The account would expire straight away', text: 'The expiry date is in the past, so the account can’t sign in from now on.' });
    if (name === 'CSPSystem' && before) risks.push({ title: 'Web access may stop', text: 'The Web Gateway signs in as CSPSystem. If its settings change, update the gateway’s configuration too.' });
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
  const trackTouched = (): void => {
    formEl.addEventListener('focusout', (e) => {
      const f = (e.target as Element | null)?.closest?.('[data-field]') as HTMLElement | null;
      if (f?.dataset.field) { touched.add(f.dataset.field); editor?.refresh(); }
    });
  };
  const backToView = (name: string | null): void => {
    if (formFull) {
      // The full view's cards come back: this user's, or the new one's after a copy.
      endEdit();
      fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
      if (name && name !== od.selected() && all.some((u) => u.Name === name)) void od.openFull(name); else od.refresh();
      return;
    }
    endEdit();
    if (name && all.some((u) => u.Name === name)) { selected = name; grid?.select([name]); void renderDetail(); }
    else close();
  };

  function openEdit(name: string, u: UserDetail, prefill?: Partial<UserDetail>, full = false): void {
    if (!canSecure) return;
    startForm(full);
    mode = 'edit';
    const shown: UserDetail = { ...u, ...prefill };
    const s = all.find((x) => x.Name === name);
    let pick: { roles: () => string[]; esc: () => string[] } | null = null;
    const host = formEl;
    editor = editorShell(host, {
      // The full view's title already names the user.
      title: full ? 'Edit settings' : `Edit <span class="mono">${esc(name)}</span>`,
      name,
      sections: (s && !isPasswordUser(s.Type) ? `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>Details for this account come from ${esc(signIn(s.Type))}; changes made here may be replaced the next time they sign in.</div></div>` : '') + userSections(shown, false, name),
      submitLabel: 'Save changes',
      startDirty: !!prefill,
      check: () => problems(readForm(host), false),
      onCancel: () => backToView(name),
      onSubmit: async (v) => {
        const after = toRecord(v, u, pick?.roles() ?? u.Roles, pick?.esc() ?? u.EscalationRoles);
        const patch = diff(u, after);
        if (!Object.keys(patch).length) return;
        if (!(await confirmRisks(name, u, after))) throw new Error('Not saved. Review the warnings, then save again.');
        await updateUser(name, patch);
        editor?.markClean();
        toast(`${name} saved. ${patch.Roles || patch.EscalationRoles || patch.Enabled !== undefined ? NEXT_SIGN_IN : ''}`.trim());
        await reload(true);
        backToView(name);
      },
    });
    let showChanges: (() => void) | null = null;
    pick = mountPickers(name, shown, () => { showChanges?.(); editor?.refresh(); });
    showChanges = wireChanges(host, () => changeLines(u, toRecord(readForm(host), u, pick?.roles() ?? u.Roles, pick?.esc() ?? u.EscalationRoles)), false);
    trackTouched();
  }

  function openCreate(copy: { from: string; user: UserDetail } | null, full = false): void {
    if (!canSecure) return;
    endEdit();
    // A copy from the full view keeps the source user's page underneath; Cancel brings it back.
    if (!(full && copy)) { selected = null; grid?.select([]); }
    startForm(full && !!copy);
    const host = formEl;
    mode = 'create';
    const base: UserDetail = copy ? {
      ...BLANK, Roles: copy.user.Roles, EscalationRoles: copy.user.EscalationRoles, NameSpace: copy.user.NameSpace,
      Routine: copy.user.Routine, AccountNeverExpires: copy.user.AccountNeverExpires, PasswordNeverExpires: copy.user.PasswordNeverExpires,
      ExpirationDate: copy.user.ExpirationDate, Comment: copy.user.Comment,
    } : BLANK;
    let pick: { roles: () => string[]; esc: () => string[] } | null = null;
    editor = editorShell(host, {
      subtitle: copy ? `Copy of ${esc(copy.from)}` : undefined,
      title: 'New user',
      name: 'the new user',
      sections: userSections(base, true, ''),
      submitLabel: 'Create user',
      startDirty: !!copy,
      check: () => problems(readForm(host), true),
      onCancel: () => backToView(copy?.from ?? null),
      onSubmit: async (v) => {
        const name = String(v.Name ?? '').trim();
        const after = toRecord(v, base, pick?.roles() ?? base.Roles, pick?.esc() ?? base.EscalationRoles);
        if (!(await confirmRisks(name, null, after))) throw new Error('Not created. Review the warnings, then try again.');
        const { ...fields } = after;
        try {
          await createUser(name, String(v.Password ?? ''), fields);
        } catch (e) {
          // IRIS creates the account first and applies the settings second; if the
          // second step failed, the account exists and the form becomes an edit.
          const now = await getUserList().catch(() => all);
          if (now.some((u) => u.Name.toLowerCase() === name.toLowerCase())) {
            all = now;
            toast(`${name} was created, but some settings weren’t saved: ${errorText(e)}`, 'warning');
            await reload(true);
            const wasFull = formFull;
            endEdit();
            selected = now.find((u) => u.Name.toLowerCase() === name.toLowerCase())?.Name ?? name;
            const fresh = await getUser(selected).catch(() => null);
            // From the full view: the new user's full view, with its form in the body.
            if (wasFull && od.mode() === 'full') await od.openFull(selected);
            if (fresh) openEdit(selected, fresh, undefined, wasFull && od.mode() === 'full');
            else if (!wasFull) backToView(selected);
            return;
          }
          throw e;
        }
        editor?.markClean();
        toast(after.Roles.length ? `${name} created. Their roles apply from the next time they sign in.` : `${name} created.`);
        await reload(true);
        backToView(all.find((u) => u.Name.toLowerCase() === name.toLowerCase())?.Name ?? name);
        scrollToSelected();
      },
    });
    let showChanges: (() => void) | null = null;
    pick = mountPickers('The new user', base, () => { showChanges?.(); editor?.refresh(); });
    showChanges = wireChanges(host, () => { const v = readForm(host); return createLines(String(v.Name ?? '').trim(), toRecord(v, base, pick?.roles() ?? base.Roles, pick?.esc() ?? base.EscalationRoles)); }, true);
    trackTouched();
  }

  function openPassword(name: string, full = false): void {
    if (!canSecure) return;
    startForm(full);
    mode = 'password';
    const host = formEl;
    editor = editorShell(host, {
      title: full ? 'Change password' : `Change password for <span class="mono">${esc(name)}</span>`,
      name: `the password for ${name}`,
      sections: section('New password', [
        passwordField('Password', 'New password', { required: true, hint: 'Must meet the instance’s password rules. You don’t need the old one.' }),
        passwordField('Confirm', 'Confirm new password', { required: true }),
        checkField('ChangePassword', 'Must change password at next sign-in', true, { hint: 'Recommended when you set a password for someone else.' }),
      ].join('')) + (name === 'CSPSystem' ? '<p class="detail-para check-warn">The Web Gateway signs in as CSPSystem. Update the password in the gateway’s configuration too, or web access will stop.</p>' : ''),
      submitLabel: 'Change password',
      check: () => problems(readForm(host), false).filter((p) => p.field === 'Password' || p.field === 'Confirm'),
      onCancel: () => backToView(name),
      onSubmit: async (v) => {
        await setUserPassword(name, String(v.Password ?? ''));
        const want = !!v.ChangePassword;
        // Setting a password clears "must change", so set it again when wanted.
        if (want) await updateUser(name, { ChangePassword: true });
        editor?.markClean();
        toast(`Password changed for ${name}.${want ? ' They’ll be asked for a new one when they next sign in.' : ''}`);
        await reload(true);
        backToView(name);
      },
    });
    trackTouched();
  }

  async function toggleEnabled(name: string, u: UserDetail, confirmed = false): Promise<void> {
    const enable = !u.Enabled;
    if (!enable && !confirmed) {
      const warn: string[] = [];
      if (name === me) warn.push('You are signed in as this user. Disabling it will lock you out.');
      if (name === ANON_USER) warn.push('Unauthenticated requests will be refused, including this portal if it runs without sign-in.');
      const ok = await confirm({
        title: `Disable ${name}?`,
        body: `<p>${esc(name)} won’t be able to sign in. The account, its roles and its audit history are kept, and you can enable it again at any time.</p>
          <p>Sessions already open carry on until they end; you can end them from Processes.</p>
          ${warn.length ? `<ul class="risk-list">${warn.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`,
        confirmLabel: 'Disable',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await updateUser(name, { Enabled: enable });
      toast(enable ? `${name} enabled. They can sign in again.` : `${name} disabled. Sessions already open carry on until they end.`);
      await reload(true);
      void renderDetail(true);
    } catch (e) { toast(errorText(e), 'danger'); }
  }

  async function remove(name: string, u: UserDetail): Promise<void> {
    const inUse = u.Roles.length > 0 || u.Enabled;
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: `<p>This permanently removes the account${u.Roles.length ? ` and its ${u.Roles.length} role assignment${u.Roles.length === 1 ? '' : 's'}` : ''}. It can’t be undone.</p>
        <p><b>Disable instead</b> stops them signing in and keeps the account and its audit history.</p>
        ${name === me ? '<p class="check-warn">You are signed in as this user.</p>' : ''}`,
      confirmLabel: 'Delete user',
      danger: true,
      typeToConfirm: inUse ? name : undefined,
      alternative: u.Enabled && !disableReason(name, true) ? { label: 'Disable instead', onSelect: () => void toggleEnabled(name, u, true) } : undefined,
    });
    if (!ok) return;
    try {
      await deleteUser(name);
      toast(`${name} deleted.`);
      close();
      await reload(true);
    } catch (e) { toast(errorText(e), 'danger'); }
  }

  /* ── Grid and loading ──────────────────────────────────── */

  const renderGrid = (): void => {
    const rows = visible().map((u) => toRow(u, graph));
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Users');
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
    wrap.querySelector('.grid-empty')?.remove();
    if (rows.length === 0) {
      const why = query ? `No users match “${esc(query)}”${scope === 'all' ? '' : ` among ${scope} accounts`}.`
        : scope === 'disabled' ? 'No disabled accounts: every user can sign in.' : 'No enabled accounts.';
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">${why}</div>`);
    }
  };

  const applyPending = (): void => {
    if (pending === null) return;
    const name = pending;
    pending = null;
    const hit = all.find((u) => u.Name.toLowerCase() === name.toLowerCase());
    if (!hit) return;
    query = ''; scope = 'all';
    searchEl.value = ''; scopeEl.value = 'all';
    selected = hit.Name;
    renderToolbar();
    renderGrid();
    void renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  const fillGraph = async (fresh: boolean): Promise<void> => {
    try {
      const g = await getSecurityGraph(fresh);
      if (!alive) return;
      graph = g;
      renderGrid();
      renderFoot();
      renderRisk();
      if (selected !== null && mode === 'view') void renderDetail(true);
    } catch { /* privilege stays "…"; the list itself still works */ }
  };

  /** Reload the list (and, after a write, the graph) keeping the selection. */
  async function reload(afterWrite = false): Promise<void> {
    if (afterWrite) invalidateSecurityGraph();
    all = await getUserList();
    updated(new Date());
    renderToolbar();
    renderGrid();
    renderFoot();
    await fillGraph(afterWrite);
  }

  const updated = liveIndicator(ctx, () => void load(true));
  const load = async (fresh = false): Promise<void> => {
    try {
      all = await getUserList();
      if (!alive) return;
      updated(new Date());
      renderToolbar();
      renderGrid();
      renderFoot();
      if (!opened) { opened = true; od.refresh(); } // a deep link (#/security/users/<name>) opens its full view now
      if (pending !== null) applyPending();
      else if (selected !== null && mode === 'view') {
        if (all.some((u) => u.Name === selected)) { if (od.mode() !== 'full') void renderDetail(true); } // the full view keeps its check result between polls
        else close();
      }
      void fillGraph(fresh);
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-users');
      wrap.querySelector('#retry-users')?.addEventListener('click', () => void load());
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
