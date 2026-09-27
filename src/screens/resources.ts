// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Resources — every resource, what it protects (databases, web
 * apps, services, admin powers) and who can use it (everyone, roles, the
 * users behind those roles, %All holders). New resource, Edit and Delete
 * happen in the detail panel.
 *
 * Public access can't be taken away through the API this portal uses (see
 * api-resources.ts): a resource can't be created without it, and once set it
 * can only be changed, not cleared. The form says so before anything is saved
 * and hands those cases to the Management Portal instead of silently making
 * something public.
 */
import '../styles-security.css';
import '../styles-resources.css';
import {
  getResourceList, getResource, getSecurityGraph, invalidateSecurityGraph, linkTo, takeSelection, portalLink,
  getNamespaceList, normPerms, sourceText, privilegeText,
  type ResourceSummary, type ResourceDetail, type SecurityGraph, type NamespaceInfo, type Source,
} from '../api-security';
import {
  getProtectedAssets, kindOf, kindLabel, kindHint, permText, permSentence, publicRisk,
  meaningfulPerms, nameProblem, saveResource, deleteResource, isDatabaseResource, PORTAL_RESOURCES, PERM_WORD,
  type Kind, type ProtectedAssets,
} from '../api-resources';
import {
  toast, confirm, newButton, moreButton, moreMenu, blockedAttrs, editorShell, panelWidth, section,
  textField, textareaField, checkField, readForm, fieldError, focusFirstError, errorText,
  type EditorHandle, type MenuHandle, type FormValues, type FieldProblem,
  scrollPanelTop,
} from '../crud';
import { SERVICES, getSuperservers, linkToScreen, ssKey, allAddresses, type Superserver } from '../api-services';
import { getWalletCollections, splitResource, type WalletCollection } from '../api-secrets';
import {
  assetOf, mountAccessCheck, mountSecurityBanner, ALL_CAVEAT, type ChainLinks,
} from '../security-view';
import { plural, roleLink, noPermissionText, esc, permChips, permWords, chip, cell, num, skeleton, errorPanel, liveIndicator, type ScreenCtx, type GridColumn, setChips } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 60000;

/** Ellipsis at the column width (see roles.ts). */
const clip = (v: unknown): string =>
  `<span style="display:block;width:0;min-width:100%;max-width:100%;box-sizing:border-box;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(v)}">${esc(v)}</span>`;

/** "Everyone: Read · Write", or null when not public. */
const publicText = (p: string): string | null => (normPerms(p) ? `Everyone: ${permText(p)}` : null);

const COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'Resource', width: '250px', sortable: true, renderCell: (v) => cell.id(v) },
  { key: 'Kind', label: 'Type', width: '130px', sortable: true, renderCell: (v) => cell.text(kindLabel(v as Kind), kindHint(v as Kind)) },
  { key: 'Public', label: 'Public access', description: 'What every user gets on this resource without any role, including anonymous callers', width: '170px', sortable: true, renderCell: (v, row) => {
    const t = publicText(String(v));
    if (!t) return cell.dim('—');
    return row.Risk ? chip(t, 'warning', String(row.Risk)) : cell.text(t, 'Every connection has this, signed in or not');
  } },
  { key: 'UsedBy', label: 'Used by', description: 'How many roles grant this resource', width: '88px', sortable: true, align: 'right', renderCell: (v, row) =>
    (Number(v) < 0 ? cell.dim('—') : Number(v) === 0 ? cell.dim('0') : cell.num(num(Number(v)), String(row.UsedByTitle))) },
  { key: 'Description', label: 'Description', width: '40%', sortable: true, renderCell: (v) => (v ? clip(v) : cell.dim('—')) },
];
/** Step aside while the detail panel is open. */
const SECONDARY = ['Description'];
/** A form section without a heading (the form's own title already names it). */
const untitled = (body: string): string => `<section class="crud-section"><div class="crud-section-body">${body}</div></section>`;


/** Roles granting a resource themselves (not through an included role). */
function directRoles(g: SecurityGraph, name: string): Array<{ role: string; perms: string }> {
  const out: Array<{ role: string; perms: string }> = [];
  for (const [role, d] of g.roles) {
    const hit = d.Resources.find((r) => r.Name === name);
    if (hit) out.push({ role, perms: normPerms(hit.Permissions) });
  }
  return out.sort((a, b) => a.role.localeCompare(b.role));
}

function toRow(r: ResourceSummary, g: SecurityGraph | null): DataGridRow {
  const roles = g ? directRoles(g, r.Name) : null;
  return {
    Name: r.Name, Kind: kindOf(r.ResourceType), Public: normPerms(r.PublicPermission), Description: r.Description,
    Risk: publicRisk(r.Name, r.ResourceType, r.PublicPermission) ?? '',
    UsedBy: roles ? roles.length : -1,
    UsedByTitle: roles ? `Granted by ${roles.length} role${roles.length === 1 ? '' : 's'}` : '',
  };
}

type KindFilter = 'all' | Kind;
type Access = 'all' | 'public';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const note = (html: string, warn = false): string =>
  `<div class="crud-note${warn ? ' crud-note--warning' : ''}"><ev-icon name="${warn ? 'alert-triangle' : 'info'}" size="sm"></ev-icon><div>${html}</div></div>`;
const none = (text: string): string => `<p class="chip-list-empty">${esc(text)}</p>`;
const userLink = (name: string, title = 'Open this user'): string =>
  `<button type="button" class="chip-link" data-user="${esc(name)}" aria-label="Open user ${esc(name)}">${chip(name, 'neutral', title)}</button>`;

interface Extra {
  assets: ProtectedAssets | null;
  namespaces: NamespaceInfo[];
  /** What the other Security screens hold that a resource guards (null until loaded). */
  guards: { superservers: Superserver[]; wallet: WalletCollection[] } | null;
}

/** Admin resources that unlock a whole Security screen. */
const SCREEN_OF: Record<string, { route: string; label: string; what: string }> = {
  '%Admin_Wallet': { route: 'security/wallet', label: 'Secrets wallet', what: 'Managing secret collections' },
  '%Admin_OAuth2_Client': { route: 'security/oauth', label: 'OAuth', what: 'OAuth client settings' },
  '%Admin_OAuth2_Server': { route: 'security/oauth', label: 'OAuth', what: 'The OAuth authorization server' },
  '%Admin_OAuth2_Registration': { route: 'security/oauth', label: 'OAuth', what: 'Registering OAuth clients' },
  '%Admin_FileSystemAccess': { route: 'security/fsaccess', label: 'Filesystem access', what: 'Filesystem access rules' },
  '%Admin_Secure': { route: 'security/services', label: 'Services', what: 'Every Security setting, including services, encryption and the wallet' },
  '%Service_SQL': { route: 'security/sqlpriv', label: 'SQL privileges', what: 'SQL connections; table and view rules are set on top' },
};

/** "What it protects" entries that live on the other Security screens, as links. */
function guardsBlock(r: ResourceSummary, x: Extra): string {
  const out: string[] = [];
  const link = (route: string, key: string, text: string): string =>
    `<button type="button" class="link" data-go-screen="${esc(route)}" data-go-key="${esc(key)}">${esc(text)}</button>`;
  // Ways in: services that check this resource, and the ports that carry them.
  const svcs = Object.entries(SERVICES).filter(([n, i]) => n === r.Name || i.resources.includes(r.Name));
  if (svcs.length) {
    out.push(`<p class="chip-sub">Services</p><ul class="res-list">${svcs.map(([n, i]) => {
      const ports = i.flag ? (x.guards?.superservers ?? []).filter((p) => p.Enabled && p[i.flag as keyof Superserver]) : [];
      const portText = ports.length ? `carried by ${ports.map((p) => link('security/superservers', ssKey(p), `port ${p.Port}${allAddresses(p.BindAddress) ? '' : ` on ${p.BindAddress}`}`)).join(', ')}` : '';
      return `<li><span class="res-what">${link('security/services', n, `The ${i.label} service`)}${portText ? `<br><span class="dim">${portText}</span>` : ''}</span><span class="res-meta">Use</span></li>`;
    }).join('')}</ul>`);
  }
  // Secrets wallet collections guarded by it.
  const cols = (x.guards?.wallet ?? []).flatMap((c) => {
    const hits: string[] = [];
    const use = c.UseResource ? splitResource(c.UseResource) : null;
    const edit = c.EditResource ? splitResource(c.EditResource) : null;
    if (use?.resource === r.Name) hits.push('use its secrets');
    if (edit?.resource === r.Name) hits.push('change its secrets');
    return hits.length ? [{ c, hits }] : [];
  });
  if (cols.length) {
    out.push(`<p class="chip-sub">Secrets wallet</p><ul class="res-list">${cols.map(({ c, hits }) =>
      `<li><span class="res-what">${link('security/wallet', c.Name, `Collection ${c.Name}`)}</span><span class="res-meta">${esc(hits.join(', '))}</span></li>`).join('')}</ul>`);
  }
  const screen = SCREEN_OF[r.Name];
  if (screen) out.push(`<p class="chip-sub">Settings</p><ul class="res-list"><li><span class="res-what">${esc(screen.what)}</span><span class="res-meta">${link(screen.route, '', `${screen.label} →`)}</span></li></ul>`);
  return out.join('');
}

function protectsBlock(r: ResourceSummary, g: SecurityGraph | null, x: Extra): string {
  const kind = kindOf(r.ResourceType);
  const parts: string[] = [];
  if (kind === 'Database' || /^%DB_/i.test(r.Name)) {
    const dbs = x.assets?.databases.get(r.Name.toLowerCase()) ?? [];
    if (dbs.length) {
      parts.push(`<p class="chip-sub">Databases</p><ul class="res-list">${dbs.map((d) => {
        const used = x.namespaces.filter((n) => [n.Globals, n.Routines].some((db) => db.toUpperCase() === d.name.toUpperCase()));
        const where = used.length ? `Data or code for ${used.map((n) => n.Name).join(', ')}` : '';
        return `<li><span class="res-what"><span class="mono">${esc(d.name)}</span>${where ? `<br><span class="dim">${esc(where)}</span>` : ''}</span><span class="res-meta">${esc(mountWords(d.status))}</span></li>`;
      }).join('')}</ul>`);
    } else if (x.assets) {
      parts.push(none('No database on this instance uses this resource at the moment'));
    }
  }
  if (kind === 'Service') {
    const s = (g?.services ?? []).find((v) => v.Name === r.Name);
    parts.push(`<p class="chip-sub">Service</p><ul class="res-list"><li><span class="res-what">${esc(s?.Description || privilegeText(r.Name, 'U'))}</span><span class="res-meta">${s ? (s.Enabled ? chip('Enabled', 'success') : chip('Disabled', 'neutral')) : ''}</span></li>${
      s?.AuthenticationMethods.length ? `<li><span class="res-what dim">Sign-in methods</span><span class="res-meta">${esc(s.AuthenticationMethods.join(', '))}</span></li>` : ''}</ul>`);
  }
  if (kind === 'System') {
    parts.push(`<p class="detail-para">${esc(privilegeText(r.Name, 'U'))}. Use of this resource is checked by IRIS itself; it gives no access to data on its own.</p>`);
  }
  const apps = (x.assets?.webApps ?? []).filter((a) => a.Resource === r.Name);
  if (apps.length) {
    parts.push(`<p class="chip-sub">Web apps that require Use on it</p><ul class="res-list">${apps.map((a) =>
      `<li><span class="res-what mono">${esc(a.Name)}</span><span class="res-meta">${a.Enabled ? esc(a.Namespace) : chip('Disabled', 'neutral')}</span></li>`).join('')}</ul>`);
  }
  const guards = guardsBlock(r, x);
  if (guards) parts.push(guards);
  if (!parts.length) {
    if (!x.assets) return '<p class="chip-sub">Working out what it protects…</p>';
    return none(kind === 'Application'
      ? 'Nothing on this instance requires it yet. A web app or routine can require Use on it; code can also check it directly'
      : 'IRIS checks this resource itself, for the feature it’s named after');
  }
  return parts.join('');
}

/** "Public access" block: the headline fact, with the risk spelled out. */
function publicBlock(r: ResourceSummary): string {
  const p = normPerms(r.PublicPermission);
  const row = (value: string, tip: string): string =>
    `<dl class="kv-list res-public-row"><div class="kv" title="${esc(tip)}"><dt>Public access</dt><dd>${value}</dd></div></dl>`;
  if (!p) return row('None', 'Only people whose roles grant this resource can use it.');
  const risk = publicRisk(r.Name, r.ResourceType, p);
  const text = `Everyone · ${permWords(p).join(' · ')}`;
  const tip = `${risk ?? `Every connection, signed in or not, can ${permSentence(p, r.Name, r.ResourceType).toLowerCase()}, without needing a role.`} Public access can be changed here; removing it is done in the Management Portal.`;
  return row(risk ? chip(text, 'warning', risk) : esc(text), tip);
}

/** One reading-path line: who, their permission chips, then how (and the raw code) underneath. */
const line = (main: string, perms: string, sub: string, raw: string): string => `
  <li class="res-line">
    <div class="res-line-main">${main}<span class="res-perms-tip"${raw ? ` title="${esc(raw)}"` : ''}>${permChips(perms)}</span></div>
    ${sub ? `<div class="res-line-sub">${sub}</div>` : ''}
  </li>`;

/** How a user gets it, said only as much as needed: "through %Developer", "through %Manager → %Developer". */
const howText = (src: Source): string => (src.kind === 'role' ? `through ${src.path.join(' → ')}` : sourceText(src));

/** IRIS mount states in words: "Mounted/R" → "Mounted, read-only". */
function mountWords(status: string): string {
  const m = /^mounted\s*\/\s*(rw|r)$/i.exec(status.trim());
  if (m) return m[1].toUpperCase() === 'RW' ? 'Mounted, read and write' : 'Mounted, read-only';
  if (/^dismounted$/i.test(status.trim())) return 'Not mounted';
  return status;
}

function whoBlock(r: ResourceSummary, g: SecurityGraph | null): string {
  if (!g) return '<p class="chip-sub">Working out who can use it…</p>';
  const who = g.whoCan(r.Name);
  const p = normPerms(r.PublicPermission);
  const out: string[] = [];
  if (p) out.push(`<ul class="res-list">${line('<strong>Everyone</strong>', p, 'public: every user, and connections that don’t sign in', `${r.Name}:${p}`)}</ul>`);
  if (who.roles.length) {
    out.push(`<p class="chip-sub">Roles</p><ul class="res-list">${who.roles.map((x) =>
      line(roleLink(x.role), x.perms, x.path.length > 1 ? `through ${esc(x.path.slice(1).join(' → '))}` : '', `${r.Name}:${x.perms}`)).join('')}</ul>`);
  } else {
    out.push(none('No role grants this resource'));
  }
  const users = who.users.filter((u) => u.source !== 'all');
  if (users.length) {
    out.push(`<p class="chip-sub">Users, through those roles</p><ul class="res-list">${users.map((u) =>
      line(userLink(u.user), u.perms, u.source === 'all' ? '' : esc(howText(u.source)), `${r.Name}:${u.perms}`)).join('')}</ul>`);
  } else if (who.roles.length) {
    out.push(none('No user holds those roles'));
  }
  if (who.allHolders.length) {
    out.push(`<p class="chip-sub">Anyone with %All (full access to everything)</p><div class="chip-list">${who.allHolders.map((u) => userLink(u, 'Holds %All')).join('')}</div>`);
  }
  return out.join('');
}

/**
 * How people reach this resource, drawn as lanes into ONE target box:
 *
 *   Everyone ─────── Read (public, no role needed) ──▶ ┌────────────┐
 *   2 users → 5 roles ─ Read or Read & change ──────▶ │ %DB_IRISLIB │
 *                                                     └────────────┘
 *                                                       protects ▼
 *                                                     IRISLIB database
 *
 * Each lane carries only its own permission. When the panel is too narrow
 * for columns (container query), each lane becomes a full row that repeats
 * the target, so no arrow ends in empty space.
 */
function resourceChain(r: ResourceSummary, g: SecurityGraph, x: Extra): string {
  const who = g.whoCan(r.Name);
  const pub = normPerms(r.PublicPermission);
  const roleUsers = who.users.filter((u) => u.source !== 'all').length;
  const roles = who.roles;
  const levels = [...new Set(roles.map((y) => permText(y.perms)))].sort((p, q) => p.length - q.length).join(' or ');

  // Not ui.ts roleLink: a plain inline link inside a sentence, not a chip.
  const roleLink = (n: string): string => `<button type="button" class="chain-link" data-role="${esc(n)}" title="Open role ${esc(n)}">${esc(n)}</button>`;
  const dbs = x.assets?.databases.get(r.Name.toLowerCase()) ?? [];
  const a = dbs.length
    ? { label: dbs.length === 1 ? `the ${dbs[0].name} database` : `the ${dbs.map((d) => d.name).join(', ')} databases` }
    : { label: assetOf(g, r.Name).label };
  const res = `<span class="chain-name chain-here">${esc(r.Name)}</span>`;
  const protect = `, protecting ${esc(a.label)}`;
  // One line of text per path: public access, and through roles. No boxes or arrows.
  const lines: string[] = [];
  if (pub) lines.push(`Everyone has ${res} <span class="chain-sub">(${esc(permText(pub))}, public, no role needed)</span>${protect}`);
  if (roles.length) {
    const shown = roles.slice(0, 3).map((y) => roleLink(y.role)).join(', ') + (roles.length > 3 ? ` and ${num(roles.length - 3)} more` : '');
    lines.push(`${esc(plural(roleUsers, 'user'))} ${roleUsers === 1 ? 'holds' : 'hold'} ${shown}, which give ${res} <span class="chain-sub">(${esc(levels)})</span>${protect}`);
  } else if (!pub) {
    lines.push(`<span class="chain-missing">No role grants ${esc(r.Name)}</span>${protect}`);
  }
  const all = who.allHolders.length
    ? `<p class="res-lane-note">Plus ${plural(who.allHolders.length, 'account')} with %All: ${ALL_CAVEAT.charAt(0).toLowerCase()}${ALL_CAVEAT.slice(1)}</p>`
    : '';
  return `<div class="chain-lines" role="group" aria-label="Who reaches ${esc(r.Name)}">${lines.map((l) => `<p class="chain-line">${l}</p>`).join('')}${all}</div>`;
}
export function resourcesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row">
      <div class="search-box"><ev-search id="res-search" size="sm" full-width placeholder="Filter by resource name or description"></ev-search></div>
      <ev-segmented-button id="res-seg" size="sm" aria-label="Show resources"></ev-segmented-button>
    </div>
    <ev-detail-panel id="res-panel" detail-width="400" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="res-grid-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="res-detail" aria-label="Resource details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="res-foot"></p>`;

  const segEl = ctx.body.querySelector('#res-seg') as HTMLElement & { options: unknown; value: string };
  segEl.value = 'all';
  const panel = ctx.body.querySelector('#res-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#res-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#res-detail') as HTMLElement;
  const searchEl = ctx.body.querySelector('#res-search') as HTMLElement & { value: string };
  let grid: GridEl | null = null;
  let all: ResourceSummary[] = [];
  let graph: SecurityGraph | null = null;
  const extra: Extra = { assets: null, namespaces: [], guards: null };
  let query = '';
  let kind: KindFilter = 'all';
  let access: Access = 'all';
  /** Only resources created on this instance (the ones that can be deleted). */
  let customOnly = false;
  let selected: string | null = null;
  let pending = takeSelection();
  let token = 0;
  let alive = true;
  ctx.onLeave(() => { alive = false; });

  const matchKind = (r: ResourceSummary, k: KindFilter): boolean => k === 'all' || kindOf(r.ResourceType) === k;
  const matchAccess = (r: ResourceSummary, a: Access): boolean => a === 'all' || !!normPerms(r.PublicPermission);
  const visible = (): ResourceSummary[] => all.filter((r) => {
    if (!matchKind(r, kind) || !matchAccess(r, access) || (customOnly && !r.AllowDelete)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return r.Name.toLowerCase().includes(q) || r.Description.toLowerCase().includes(q);
  });

  /** One row of chips: all, the four main types, custom, public. Each is its own filter. */
  type Seg = 'all' | 'System' | 'Database' | 'Service' | 'Application' | 'custom' | 'public';
  const segOf = (): Seg => (customOnly ? 'custom' : access === 'public' ? 'public' : kind === 'all' ? 'all' : kind as Seg);
  const setSeg = (s: Seg): void => {
    customOnly = s === 'custom';
    access = s === 'public' ? 'public' : 'all';
    kind = s === 'all' || s === 'custom' || s === 'public' ? 'all' : s;
  };
  const renderToolbar = (): void => {
    const n = (s: Seg): number => all.filter((r) => (s === 'all' ? true : s === 'custom' ? r.AllowDelete : s === 'public' ? matchAccess(r, 'public') : matchKind(r, s))).length;
    const cur = segOf();
    const opt = (value: Seg, label: string): { value: Seg; label: string; disabled: boolean } =>
      ({ value, label: `${label} ${num(n(value))}`, disabled: n(value) === 0 && cur !== value });
    setChips(segEl, all.length, [
      opt('all', 'All'), opt('System', 'Administrative'), opt('Database', 'Database'), opt('Service', 'Service'),
      opt('Application', 'Application'), opt('custom', 'Custom'), opt('public', 'Public'),
    ], { active: cur, search: searchEl, query });
  };

  const renderFoot = (): void => {
    const pub = all.filter((r) => normPerms(r.PublicPermission)).length;
    const custom = all.filter((r) => r.AllowDelete).length;
    const risky = all.filter((r) => publicRisk(r.Name, r.ResourceType, r.PublicPermission)).length;
    (ctx.body.querySelector('#res-foot') as HTMLElement).innerHTML =
      `<b>${num(all.length)}</b> resources<span class="meta-sep">·</span><b>${num(pub)}</b> public<span class="meta-sep">·</span><b>${num(custom)}</b> custom`
      + (risky ? `<span class="meta-sep">·</span><b>${num(risky)}</b> risky` : '');
  };

  const applyColumns = (): void => {
    if (!grid) return;
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !(panel.open && SECONDARY.includes(c.key)));
    // One type chosen: every row says the same, so the column steps aside. Public access shows only under the Public chip.
    grid.setColumnVisible('Kind', kind === 'all');
    grid.setColumnVisible('Public', access === 'public');
  };

  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };

  const close = (): void => { selected = null; token++; grid?.select([]); setPanel(false); };

  const open = (name: string): void => {
    if (!all.some((r) => r.Name === name)) return;
    if (!visible().some((r) => r.Name === name)) {
      query = ''; setSeg('all');
      searchEl.value = '';
      renderToolbar();
    }
    selected = name;
    renderGrid();
    void renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  const wireDetail = (): void => {
    detailEl.querySelector('#res-close')?.addEventListener('click', close);
    detailEl.querySelectorAll<HTMLButtonElement>('.chip-link[data-role], .chain-link[data-role]').forEach((b) =>
      b.addEventListener('click', () => linkTo(ctx.navigate, 'security/roles', b.dataset.role ?? '')));
    detailEl.querySelectorAll<HTMLButtonElement>('.chip-link[data-user]').forEach((b) =>
      b.addEventListener('click', () => linkTo(ctx.navigate, 'security/users', b.dataset.user ?? '')));
    detailEl.querySelectorAll<HTMLButtonElement>('[data-go-screen]').forEach((b) =>
      b.addEventListener('click', () => linkToScreen(ctx.navigate, b.dataset.goScreen ?? '', b.dataset.goKey ?? '')));
  };

  /** Chain boxes link to the other screens, or to a resource in place. */
  const chainLinks: ChainLinks = {
    user: (n) => linkTo(ctx.navigate, 'security/users', n),
    role: (n) => linkTo(ctx.navigate, 'security/roles', n),
    resource: (n) => open(n),
  };

  const head = (name: string): string => `
    <header class="detail-head">
      <div class="detail-title"><h2 class="mono">${esc(name)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="res-close"></ev-icon-button>
    </header>`;

  const detailBody = (s: ResourceSummary, d: ResourceDetail): string => {
    const r: ResourceSummary = { ...s, Description: d.Description, PublicPermission: d.PublicPermission };
    const k = kindOf(r.ResourceType);
    return `
      ${r.Description ? `<p class="sec-desc">${esc(r.Description)}</p>` : ''}
      <div class="detail-state">
        ${chip(kindLabel(k), 'neutral', kindHint(k))}
        ${r.AllowDelete ? chip('Custom', 'neutral', 'Created on this instance') : chip('Built-in', 'neutral', 'Defined by IRIS')}
      </div>
      ${graph ? resourceChain(r, graph, extra) : '<p class="chip-sub">Working out who reaches what…</p>'}
      <div class="detail-actions sec-actions" id="res-actions"></div>

      ${publicBlock(r)}

      <h3 class="detail-section">What it protects</h3>
      ${protectsBlock(r, graph, extra)}

      <h3 class="detail-section" id="res-who">Who can use it</h3>
      ${whoBlock(r, graph)}

      <h3 class="detail-section" id="res-check-h">Can someone use this?</h3>
      <p class="detail-para">Pick a user to see whether they can use ${esc(r.Name)}, and why or why not.</p>
      <div id="res-check" aria-labelledby="res-check-h">${graph ? '' : '<p class="chip-sub">Available once who can use it is worked out…</p>'}</div>`;
  };

  const renderDetail = async (quiet = false): Promise<void> => {
    const name = selected;
    if (name === null) { setPanel(false); return; }
    const s = all.find((r) => r.Name === name);
    if (!s) { close(); return; }
    const my = ++token;
    if (!quiet) { detailEl.innerHTML = head(name) + skeleton(8); wireDetail(); scrollPanelTop(detailEl); }
    setPanel(true);
    try {
      const d = await getResource(name);
      if (my !== token) return;
      // Don't wipe an answer someone is reading on a background refresh.
      if (quiet && detailEl.querySelector('#res-check .check-answer')) return;
      detailEl.innerHTML = head(name) + detailBody(s, d);
      renderActions(s);
      const checkHost = detailEl.querySelector<HTMLElement>('#res-check');
      if (graph && checkHost) {
        mountAccessCheck(checkHost, graph, {
          resource: name,
          links: chainLinks,
          // Fixes are made where users and roles are edited.
          onFix: (fix) => (fix.kind === 'new-role' ? linkTo(ctx.navigate, 'security/roles', '') : linkTo(ctx.navigate, 'security/users', fix.user)),
        });
      }
    } catch (err) {
      if (my !== token) return;
      detailEl.innerHTML = head(name) + errorPanel(err, 'retry-res');
      detailEl.querySelector('#retry-res')?.addEventListener('click', () => void renderDetail());
    }
    wireDetail();
  };

  /** Edit / More, filled in by the CRUD section below. */
  let renderActions = (_s: ResourceSummary): void => { /* set below */ };

  const renderGrid = (): void => {
    const rows = visible().map((r) => toRow(r, graph));
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Resources');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        void selectRow(name);
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) {
      const what = [access === 'public' ? 'public' : '', kind === 'all' ? '' : kindLabel(kind).toLowerCase()].filter(Boolean).join(' ');
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">No ${esc(what ? `${what} ` : '')}resources${query ? ` match “${esc(query)}”` : ''}.</div>`);
    }
  };

  /** Row click; the CRUD section wraps this with the unsaved-changes guard. */
  let selectRow = async (name: string): Promise<void> => { selected = name; await renderDetail(); };

  /** Instance-wide risk banner, the same one Users and Roles show. */
  const renderRisk = (): void => {
    const host = ctx.banners;
    if (!host) return;
    mountSecurityBanner(host, graph);
  };

  const fillGraph = (fresh: boolean): void => {
    getSecurityGraph(fresh).then((g) => {
      if (!alive) return;
      graph = g;
      renderGrid();
      renderRisk();
      if (selected !== null && !editing()) void renderDetail(true);
    }).catch(() => { /* counts stay "…" */ });
  };
  const fillAssets = (): void => {
    Promise.all([getProtectedAssets(), getNamespaceList().catch(() => [])]).then(([a, ns]) => {
      if (!alive) return;
      extra.assets = a; extra.namespaces = ns;
      if (selected !== null && !editing()) void renderDetail(true);
    }).catch(() => { /* the panel says it couldn't work it out */ });
    Promise.all([getSuperservers().catch(() => []), getWalletCollections().catch(() => [])]).then(([superservers, wallet]) => {
      if (!alive) return;
      extra.guards = { superservers, wallet };
      if (selected !== null && !editing()) void renderDetail(true);
    }).catch(() => { /* links to other screens are extra */ });
  };

  /** True while the panel holds a form; set by the CRUD section. */
  let editing = (): boolean => false;

  const updated = liveIndicator(ctx, () => void load(true), { live: false });
  const load = async (fresh = false): Promise<void> => {
    try {
      all = await getResourceList();
      if (!alive) return;
      updated(new Date());
      renderToolbar();
      renderGrid();
      renderFoot();
      if (pending !== null) { const name = pending; pending = null; open(name); }
      else if (selected !== null && !editing()) {
        if (all.some((r) => r.Name === selected)) void renderDetail(true);
        else close();
      }
      fillGraph(fresh);
      if (fresh || !extra.assets) fillAssets();
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-res-list');
      wrap.querySelector('#retry-res-list')?.addEventListener('click', () => void load());
    }
  };

  searchEl.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  segEl.addEventListener('ev-segmented-button-change', (e) => {
    setSeg((e as CustomEvent<{ value: Seg }>).detail.value);
    renderToolbar(); renderGrid();
  });

  /* ───────────── Create, edit, delete ───────────── */

  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  /** Can the signed-in user change security? null until known (treated as yes; IRIS refuses otherwise). */
  let canSecure: boolean | null = null;
  const NO_PRIV = noPermissionText('%Admin_Secure', 'security administration');

  editing = () => editor !== null;

  const leaveEditor = (): void => {
    ctx.beforeLeave(null);
    editor?.close();
    editor = null;
    restoreWidth?.();
    restoreWidth = null;
  };

  selectRow = async (name: string): Promise<void> => {
    if (editor) {
      if (!(await editor.guard())) { grid?.select(selected !== null ? [selected] : []); return; }
      leaveEditor();
    }
    selected = name;
    await renderDetail();
  };

  renderActions = (s: ResourceSummary): void => {
    const bar = detailEl.querySelector('#res-actions');
    if (!bar) return;
    menu?.destroy();
    const editReason = canSecure === false ? NO_PRIV : null;
    const delReason = canSecure === false ? NO_PRIV
      : !s.AllowDelete ? 'Resources defined by IRIS can’t be deleted.' : null;
    bar.innerHTML = `<button type="button" class="btn btn--sm" id="res-edit"${blockedAttrs(editReason)}${editReason ? ` title="${esc(editReason)}"` : ''}><ev-icon name="edit-2" size="xs"></ev-icon>Edit</button>${moreButton('res-more')}`;
    bar.querySelector('#res-edit')?.addEventListener('click', () => void openEditor(s));
    menu = moreMenu(bar.querySelector('#res-more') as HTMLElement, [
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: !!delReason, reason: delReason ?? undefined, onSelect: () => void doDelete(s) },
    ]);
  };

  /** The public-access letters chosen in the form, limited to those that mean something here. */
  const chosenPerms = (v: FormValues, allowed: string[]): string =>
    v.mode === 'public' ? allowed.filter((c) => v[`perm_${c}`] === true).join('') : '';

  const openEditor = async (s: ResourceSummary | null): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    menu?.destroy(); menu = null;
    const my = ++token;
    if (!s) { selected = null; grid?.select([]); }
    setPanel(true);
    restoreWidth = panelWidth(panel, 520);
    let current: ResourceDetail = { Description: '', PublicPermission: '' };
    if (s) {
      detailEl.innerHTML = head(s.Name) + skeleton(6);
      current = await getResource(s.Name).catch(() => ({ Description: s.Description, PublicPermission: s.PublicPermission }));
      if (my !== token) return;
    }
    const system = !!s && !s.AllowDelete;
    const type = s?.ResourceType ?? '';
    const cur = normPerms(current.PublicPermission);
    const MP_LABEL = 'Continue in Management Portal ↗';

    const about = !s
      ? untitled(`
          ${textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'Fixed once created. Up to 64 characters, no commas or colons. Database resources start with %DB_; other names can’t start with %. Case matters when roles refer to it.' })}
          <div id="res-name-taken"></div>
          ${textareaField('Description', 'Description', '', { hint: 'Say what it protects, so whoever grants it knows what they’re giving.' })}`)
      : system
        ? untitled(`
            ${current.Description ? `<p class="res-perm-hint">${esc(current.Description)}</p>` : ''}
            ${note('IRIS defines this resource, so its description can’t be changed and it can’t be deleted. Only its public access can be changed, and that affects everyone on this instance.', true)}`)
        : untitled(textareaField('Description', 'Description', current.Description));

    const permBox = ['R', 'W', 'U'].map((c) => checkField(`perm_${c}`, PERM_WORD[c], cur.includes(c))).join('');
    /** The smallest public grant for the "create now, remove later" route. */
    const minimal = (n: string): string => (isDatabaseResource(n, type) ? 'R' : 'U');
    const publicSec = section('Public access', `
      <div class="res-choice" role="radiogroup" aria-label="Who can use it">
        <label><input type="radio" name="mode" value="roles"${cur ? '' : ' checked'}><span>Only people whose roles grant it<small>Recommended. You choose who gets it by adding it to roles.${s ? '' : ' It’s created in the Management Portal, which this portal opens for you with the name copied.'}</small></span></label>
        <label><input type="radio" name="mode" value="public"${cur ? ' checked' : ''}><span>Everyone<small>Every connection gets the permissions ticked below, signed in or not, with no role needed.</small></span></label>
        ${s ? '' : `<label><input type="radio" name="mode" value="temp"><span id="res-temp-label">Create now with public Use, then remove it in the Management Portal<small>Created here straight away, but everyone can use it until you clear its public access there.</small></span></label>`}
      </div>
      <div id="res-perm-box">
        <div class="res-perms">${permBox}</div>
        <p class="res-perm-hint" id="res-perm-meaning"></p>
      </div>
      <div id="res-public-note"></div>`, { hint: 'Public access is given to every user and to connections that don’t sign in.' });

    const nameNow = (): string => (s ? s.Name : String(readForm(detailEl).Name ?? ''));
    const allowedNow = (): string[] => meaningfulPerms(nameNow(), type, cur);
    const taken = (n: string): boolean => all.some((r) => r.Name.toLowerCase() === n.toLowerCase());
    /** Is the primary action "go to the Management Portal" rather than save? */
    const handsOff = (v: FormValues): boolean => v.mode === 'roles' && (!s || !!cur);

    /** Per-field problems, shown inline when Save is pressed (Save itself stays enabled). */
    const check = (): FieldProblem[] => {
      const v = readForm(detailEl);
      const out: FieldProblem[] = [];
      if (!s) {
        const p = nameProblem(String(v.Name ?? ''), taken);
        if (p) out.push({ field: 'Name', label: 'Name', message: p });
      }
      if (v.mode === 'public' && !chosenPerms(v, allowedNow())) {
        out.push({ field: `perm_${allowedNow()[0] ?? 'U'}`, label: 'Public permissions', message: 'Tick at least one, or choose “Only people whose roles grant it”' });
      }
      return out;
    };

    /** Show the right permissions, notes and button label for what's chosen. */
    const update = (): void => {
      const v = readForm(detailEl);
      const name = nameNow();
      const allowed = allowedNow();
      (detailEl.querySelector('#res-perm-box') as HTMLElement).hidden = v.mode !== 'public';
      for (const c of ['R', 'W', 'U']) {
        const wrapEl = detailEl.querySelector<HTMLElement>(`[data-field="perm_${c}"]`);
        const el = wrapEl?.querySelector('ev-checkbox') as (HTMLElement & { checked: boolean }) | null;
        if (!wrapEl || !el) continue;
        const on = allowed.includes(c);
        wrapEl.hidden = !on;
        if (!on && el.checked) el.checked = false;
      }
      // Read & change includes Read: tick Read and hold it while Read & change is on.
      const r = detailEl.querySelector<HTMLElement & { checked: boolean; disabled: boolean }>('[data-field="perm_R"] ev-checkbox');
      const w = detailEl.querySelector<HTMLElement & { checked: boolean }>('[data-field="perm_W"] ev-checkbox');
      if (r && w && allowed.includes('R') && allowed.includes('W')) {
        if (w.checked && !r.checked) r.checked = true;
        r.disabled = !!w.checked;
      }
      const v2 = readForm(detailEl);
      const perms = chosenPerms(v2, allowed);
      (detailEl.querySelector('#res-perm-meaning') as HTMLElement).textContent = perms
        ? `Everyone will be able to ${permSentence(perms, name, type).toLowerCase()}.`
        : isDatabaseResource(name, type) ? 'Read lets people see the data and run the code; Read & change also lets them change both.' : 'Use lets people use what this resource protects.';
      const tempLabel = detailEl.querySelector('#res-temp-label');
      if (tempLabel?.firstChild) tempLabel.firstChild.textContent = `Create now with public ${permText(minimal(name))}, then remove it in the Management Portal`;

      const link = (href: string, label: string): string => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;
      const parts: string[] = [];
      if (v2.mode === 'roles' && !s) {
        parts.push(note('IRIS only lets this portal create resources that have some public access, so this one is finished in the Management Portal. <strong>Continue</strong> opens its Resources page and copies the name; there, choose Create New Resource, paste the name and leave the public boxes empty.'));
      } else if (v2.mode === 'roles' && s && cur) {
        parts.push(note(`IRIS only lets this portal change public access, not remove it. <strong>Continue</strong> opens ${esc(name)} in the Management Portal; clear its public boxes there and save.${!system ? ' Any description change is saved here first.' : ''}`, true));
      } else if (v2.mode === 'temp') {
        const p = minimal(name);
        parts.push(note(`<strong>Everyone can ${esc(permSentence(p, name, type).toLowerCase())} until you remove it.</strong> That includes connections that don’t sign in. After it’s created, open it in the Management Portal and clear its public box. ${link(PORTAL_RESOURCES, 'Resources in the Management Portal')}`, true));
      } else if (v2.mode === 'public' && perms) {
        const risk = publicRisk(name, type, perms);
        if (risk) parts.push(note(`<strong>Risky.</strong> ${esc(risk)}`, true));
        if (!cur) parts.push(note('Once saved, public access can be changed here but not removed. Removing it later has to be done in the Management Portal.'));
      }
      (detailEl.querySelector('#res-public-note') as HTMLElement).innerHTML = parts.join('');

      const label = detailEl.querySelector('.crud-submit > span:last-child');
      if (label) label.textContent = handsOff(v2) ? MP_LABEL : s ? 'Save changes' : 'Create resource';

      // Name taken: say so, with a way to the existing one.
      const takenEl = detailEl.querySelector('#res-name-taken');
      if (takenEl) {
        const hit = all.find((x) => x.Name.toLowerCase() === name.toLowerCase());
        takenEl.innerHTML = !s && hit ? `<p class="res-perm-hint">A resource with this name already exists. <button type="button" class="btn btn--sm btn--quiet" id="res-open-taken">Open it</button></p>` : '';
        takenEl.querySelector('#res-open-taken')?.addEventListener('click', () => void openExisting(hit?.Name ?? ''));
      }
    };

    const openExisting = async (name: string): Promise<void> => {
      if (!name || (editor && !(await editor.guard()))) return;
      leaveEditor();
      open(name);
    };

    /** Name problems block the save even if the shell let the click through. */
    const nameGate = (name: string): void => {
      const p = nameProblem(name, taken);
      if (!p) return;
      fieldError(detailEl, 'Name', p);
      update();
      focusFirstError(detailEl);
      throw new Error(`${p}. Nothing was saved.`);
    };

    const afterSave = async (name: string, message: string, tone: 'success' | 'warning' = 'success'): Promise<void> => {
      leaveEditor();
      invalidateSecurityGraph();
      toast(message, tone);
      selected = name;
      await load(true);
      open(name); // select it and scroll the grid to it
    };

    const onSubmit = async (values: FormValues): Promise<void> => {
      const allowed = allowedNow();
      const perms = chosenPerms(values, allowed);
      const desc = String(values.Description ?? '');

      // Recommended path with no public access: hand over to the Management Portal.
      // The window opens first, while the click still counts as the user's.
      if (handsOff(values)) {
        const name = s ? s.Name : String(values.Name ?? '');
        if (!s) nameGate(name);
        window.open(s ? portalLink.resource(name) : PORTAL_RESOURCES, '_blank', 'noopener');
        if (!s) {
          const copied = await copyText(name);
          leaveEditor();
          showHandoff(name, desc, copied);
          return;
        }
        if (!system && desc !== current.Description) await saveResource(s.Name, { Description: desc });
        leaveEditor();
        invalidateSecurityGraph();
        toast(`Opened ${name} in the Management Portal. Clear its public boxes there and save, then refresh this page.`, 'info');
        selected = name;
        await load(true);
        return;
      }

      if (!s) {
        const name = String(values.Name ?? '');
        nameGate(name);
        // Saving under an existing name would overwrite it: check against a fresh list.
        all = await getResourceList();
        nameGate(name);
        const give = values.mode === 'temp' ? minimal(name) : perms;
        const risk = publicRisk(name, '', give);
        if (risk && !(await confirm({
          title: `Make ${name} public?`, danger: true, confirmLabel: 'Create resource',
          body: `<p>${esc(risk)}</p><p>Removing public access later has to be done in the Management Portal.</p>`,
        }))) throw new Error('Nothing was saved.');
        await saveResource(name, { Description: desc, PublicPermission: give });
        await afterSave(name, values.mode === 'temp'
          ? `Resource ${name} created with public ${permText(give)}. Open it in the Management Portal and clear its public box to make it private. Users get changes the next time they sign in.`
          : `Resource ${name} created. Users get changes the next time they sign in.`, values.mode === 'temp' ? 'warning' : 'success');
        return;
      }

      const body: Partial<ResourceDetail> = {};
      if (!system && desc !== current.Description) body.Description = desc;
      if (perms && perms !== cur) body.PublicPermission = perms;
      if (body.PublicPermission) {
        const risk = publicRisk(s.Name, type, perms);
        const was = cur ? `Everyone: ${permText(cur)}` : 'not public';
        if ((risk || system) && !(await confirm({
          title: `Change public access to ${s.Name}?`, danger: !!risk, confirmLabel: 'Save changes',
          body: `<p>From <b>${esc(was)}</b> to <b>Everyone: ${esc(permText(perms))}</b>.</p>${risk ? `<p>${esc(risk)}</p>` : ''}${system ? '<p>IRIS defines this resource; the change applies to every user and every connection that doesn’t sign in.</p>' : ''}`,
        }))) throw new Error('Nothing was saved.');
      }
      if (Object.keys(body).length) await saveResource(s.Name, body);
      await afterSave(s.Name, `Resource ${s.Name} saved. Users get changes the next time they sign in.`);
    };

    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(detailEl, {
      title: s ? `Edit <span class="mono">${esc(s.Name)}</span>` : 'New resource',
      sections: about + publicSec,
      submitLabel: s ? 'Save changes' : MP_LABEL,
      name: s?.Name,
      // Create: the primary action is live from the start (pressing it says what to fill in).
      submitAlways: !s,
      check,
      onSubmit,
      onCancel: () => {
        ctx.beforeLeave(null);
        editor = null;
        restoreWidth?.(); restoreWidth = null;
        if (selected !== null) void renderDetail(); else setPanel(false);
      },
    });
    const ed = editor;
    const onChange = (): void => { if (editor === ed) { update(); ed.refresh(); } };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-checkbox-change']) ed.form.addEventListener(t, onChange);
    const nameField = detailEl.querySelector('[data-field="Name"]');
    nameField?.addEventListener('focusout', () => fieldError(detailEl, 'Name', nameProblem(nameNow(), taken)));
    nameField?.addEventListener('ev-input-input', () => {
      if (nameField.hasAttribute('error')) fieldError(detailEl, 'Name', nameProblem(nameNow(), taken));
    });
    // Settle the form and focus straight away, so typing starts in Name at once
    // and nothing lands late on top of what's been typed.
    update();
    scrollPanelTop(detailEl);
    const first = (): HTMLElement | null => detailEl.querySelector(s ? 'input[name="mode"]:checked' : '[data-field="Name"] ev-input');
    first()?.focus();
    requestAnimationFrame(() => {
      if (editor !== ed) return;
      update();
      if (s) ed.markClean();
      scrollPanelTop(detailEl);
      // Only if focus didn't take (the field wasn't ready yet) and the user hasn't moved on.
      if (!ed.form.contains(document.activeElement)) first()?.focus();
    });
  };

  /** Copy to the clipboard; false when the browser refuses. */
  const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  };

  /**
   * After "Continue in Management Portal": what to do there, the values to
   * paste (each with its own copy button), and a way back once it exists.
   */
  const showHandoff = (name: string, desc: string, copied: boolean): void => {
    setPanel(true);
    const row = (label: string, value: string, id: string): string => `
      <li><span class="res-what"><span class="dim">${esc(label)}</span><br><span class="${id === 'name' ? 'mono' : ''}">${esc(value)}</span></span>
      <button type="button" class="btn btn--sm" data-copy="${id}"><ev-icon name="copy" size="xs"></ev-icon>Copy</button></li>`;
    detailEl.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">New resource</span><h2 class="mono">${esc(name)}</h2></div>
        <ev-icon-button icon="x" label="Close" id="res-close"></ev-icon-button>
      </header>
      <h3 class="detail-section">Finish in the Management Portal</h3>
      <ol class="res-steps">
        <li>On its Resources page (opened in a new tab), choose <b>Create New Resource</b>.</li>
        <li>Paste the name${desc ? ' and description' : ''}.</li>
        <li>Leave <b>Public permission</b> Read, Write and Use unticked, and save.</li>
        <li>Come back here and choose <b>Show it here</b>.</li>
      </ol>
      <ul class="res-list">${row('Name', name, 'name')}${desc ? row('Description', desc, 'desc') : ''}</ul>
      <div class="detail-actions sec-actions">
        <button type="button" class="btn btn--sm btn--primary" id="res-handoff-done">Show it here</button>
        <a class="btn btn--sm" href="${esc(PORTAL_RESOURCES)}" target="_blank" rel="noopener">Open the Management Portal again ↗</a>
      </div>
      <p class="detail-note" id="res-handoff-msg" aria-live="polite"></p>`;
    toast(copied ? `Opened the Management Portal and copied the name ${name}.` : 'Opened the Management Portal. Copy the name from the panel.', 'info');
    detailEl.querySelector('#res-close')?.addEventListener('click', close);
    detailEl.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      void copyText(b.dataset.copy === 'name' ? name : desc).then((ok) => toast(ok ? 'Copied.' : 'Couldn’t copy; select the text instead.', ok ? 'success' : 'warning'));
    }));
    detailEl.querySelector('#res-handoff-done')?.addEventListener('click', () => {
      void getResourceList().then((list) => {
        all = list;
        if (all.some((r) => r.Name === name)) {
          invalidateSecurityGraph();
          toast(`Resource ${name} created. Users get changes the next time they sign in.`);
          renderToolbar(); renderFoot();
          open(name);
          fillGraph(true);
        } else {
          (detailEl.querySelector('#res-handoff-msg') as HTMLElement).textContent = `${name} doesn’t exist yet. Save it in the Management Portal, then try again.`;
        }
      }, (err: unknown) => toast(errorText(err), 'danger'));
    });
  };

  const doDelete = async (s: ResourceSummary): Promise<void> => {
    const g = graph ?? (await getSecurityGraph().catch(() => null));
    const roles = g ? directRoles(g, s.Name) : [];
    const users = g ? g.whoCan(s.Name).users.filter((u) => u.source !== 'all') : [];
    const apps = (extra.assets?.webApps ?? []).filter((a) => a.Resource === s.Name);
    const dbs = extra.assets?.databases.get(s.Name.toLowerCase()) ?? [];
    const inUse = roles.length > 0 || apps.length > 0 || dbs.length > 0;
    const body = [
      roles.length
        ? `<p>Removes <b class="mono">${esc(s.Name)}</b> from ${plural(roles.length, 'role')} (${roles.map((r) => `<span class="mono">${esc(r.role)}</span>`).join(', ')}), affecting ${plural(users.length, 'user')}.</p>`
        : `<p>No role grants <b class="mono">${esc(s.Name)}</b>${g ? ', so no user loses access through a role' : ''}.</p>`,
      apps.length ? `<p>${apps.length === 1 ? 'This web app requires' : 'These web apps require'} it: ${apps.map((a) => `<span class="mono">${esc(a.Name)}</span>`).join(', ')}. Afterwards only people with %All can use ${apps.length === 1 ? 'it' : 'them'}.</p>` : '',
      dbs.length ? `<p>${dbs.map((d) => `<span class="mono">${esc(d.name)}</span>`).join(', ')} ${dbs.length === 1 ? 'uses' : 'use'} it; IRIS will ask to recreate it before mounting.</p>` : '',
      '<p>This can’t be undone.</p>',
    ].join('');
    const ok = await confirm({
      title: `Delete ${s.Name}?`, body, confirmLabel: 'Delete resource', danger: true,
      typeToConfirm: inUse ? s.Name : undefined,
    });
    if (!ok) return;
    try {
      await deleteResource(s.Name);
    } catch (err) {
      toast(`Couldn’t delete ${s.Name}. ${errorText(err)}`, 'danger');
      return;
    }
    invalidateSecurityGraph();
    toast(`Resource ${s.Name} deleted. Users get changes the next time they sign in.`);
    close();
    await load(true);
  };

  const newBtn = newButton(ctx, 'New resource', () => void openEditor(null));
  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    const s = all.find((r) => r.Name === selected);
    if (s && !editor) renderActions(s);
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
  const timer = setInterval(() => { if (!editing()) void load(); }, REFRESH_MS);
  ctx.onLeave(() => { clearInterval(timer); token++; menu?.destroy(); leaveEditor(); });
}
