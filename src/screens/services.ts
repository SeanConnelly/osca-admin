// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Services — the ways into IRIS (SQL, the Terminal, the Web
 * Gateway…). Answers "how can people get in?", "which ways in let people in
 * with No sign-in (anyone can connect)?" and "who can use SQL?" (the live chain: people → roles
 * → Use on the service's resource → the way in).
 *
 * Edit (in the detail panel) changes whether a service is on, its sign-in
 * methods and the addresses it accepts. Services can't be created or deleted.
 * Guard rails: a change that would cut off the Web Gateway, which this portal
 * runs through, needs the service name typed; switching off SQL or a Terminal
 * service, or opening a way in to anonymous callers, asks first and says what
 * happens. See api-services.ts for what was verified and how.
 */
import '../styles-security.css';
import '../styles-services.css';
import '../styles-sec.css';
import { listDialog } from '../sec-dialog';
import {
  getServices, getService, saveService, getWebAuth, getSuperservers, serviceInfo, methodOf, methodOn, withMethod, methodsIn,
  addressWords, addressEntry, addressProblem, isLocalAddress, tlsLabel, allAddresses, ssKey, linkToScreen,
  portalServices, METHODS, PORTAL_SERVICE, anonOf, anonGets, anonCanUse, noSignInOn, anyoneCanConnect, noSignInApps,
  methodWord, getEcpAppServers,
  type ServiceSummary, type ServiceDetail, type ServiceInfo, type ServicePatch, type WebAuth, type Superserver, type Method,
} from '../api-services';
import { getSecurityGraph, linkTo, takeSelection, ANON_USER, type SecurityGraph } from '../api-security';
import {
  toast, confirm, editorShell, panelWidth, section, checkField, textareaField, readForm,
  errorText, scrollPanelTop, SubmitCancelled, type EditorHandle, type MenuHandle, type FieldProblem, type FormValues,
} from '../crud';
import {
  mountAccessCheck, guardDialog,
  type ChainLinks, type GuardRisk,
} from '../security-view';
import { plural, roleLink, esc, chip, cell, num, status, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, objectDetail, odMeta, odSection, odKv, type ScreenCtx, type GridColumn, type OdFull, setChips, setSearch, viewTabs, bindViewTabs } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 60000;
const EDIT_WIDTH = 520;

/**
 * The one "anyone can connect" notice, shared by Services, Superservers and Web applications (and
 * matched by Users): the shared .page-notice, red when callers get full access (UnknownUser holds
 * %All), amber otherwise, always in the same words:
 *   "Anyone can connect without signing in, with full access · They run as UnknownUser, which holds %All."
 *   "Anyone can connect without signing in · They run as UnknownUser, which holds %DB_USER."
 * `scope` narrows the subject ("to 22 web applications", "to 2 services on this port").
 */
export function anyoneNotice(o: {
  full: boolean; roles: string[] | null; scope?: string; title?: string; link?: { href: string; label: string };
}): string {
  const holds = o.full ? ', which holds %All' : o.roles === null ? '' : o.roles.length ? `, which holds ${o.roles.join(', ')}` : ', which holds no roles';
  const head = `Anyone can connect${o.scope ? ` ${o.scope}` : ''} without signing in${o.full ? ', with full access' : ''}`;
  const text = `${head} · They run as UnknownUser${holds}.`;
  return `<div class="page-notice page-notice--${o.full ? 'danger' : 'warning'} anyone-notice" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon>`
    + `<span class="page-notice-text" title="${esc(o.title ? `${text} ${o.title}` : text)}"><strong>${esc(head)}</strong> · They run as `
    + `<a href="#/security/users" data-user="UnknownUser" title="Open UnknownUser in Users">UnknownUser</a>${esc(holds)}.</span>`
    + `${o.link ? `<a class="page-notice-link" href="${esc(o.link.href)}">${esc(o.link.label)}</a>` : ''}</div>`;
}

import { stickyEditHead } from '../ui';
export { stickyEditHead };

/**
 * The "What changes" preview, one shape in every editor here: the changes as "Field: before → after"
 * lines (or a quiet "No changes yet."), then a note for each risk the change itself brings.
 */
export function previewHtml(lines: string[], risks: Array<{ title: string; text: string }> = []): string {
  return `${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="svc-preview-none">No changes yet.</p>'}${
    risks.map((x) => `<div class="crud-note crud-note--warning" role="alert"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>${esc(x.title)}.</strong> ${esc(x.text)}</div></div>`).join('')}`;
}
const NO_PRIV = noPermissionText('%Admin_Secure', 'security administration');
const WEB_APPS = 'web/apps';
const BUILT_IN = 'Services are built into IRIS: they can’t be created or deleted, only switched on or off and set up.';

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
type View = 'all' | 'on' | 'open';
type KindFilter = 'all' | 'people' | 'system';

/** A service's settings, as the form and the guard rails see them. */
interface State { enabled: boolean; mask: number; ips: string[] }

/** Services whose "Any machine" warning only matters once something connects (ECP in use). */
const NEEDS_ECP = ['%Service_Sharding', '%Service_ECP'];
/** A system link that's on with no address limit. */
const openToAnyMachine = (s: ServiceSummary, info: ServiceInfo, ecpInUse: boolean): boolean =>
  s.Enabled && info.kind === 'system' && info.ips && !s.AllowedConnections.length && (ecpInUse || !NEEDS_ECP.includes(s.Name));

/** "Everyone" / "People with Use" / "Everyone for SQL, roles for objects" / "Allowed machines". */
function whoWords(s: ServiceSummary, info: ServiceInfo, g: SecurityGraph | null): { text: string; title: string } {
  if (info.kind === 'system') return { text: 'Allowed machines', title: 'No sign-in: the service is simply on or off, limited only by address' };
  if (!info.resources.length) return { text: '—', title: '' };
  const pub = info.resources.map((r) => (g ? (g.resource(r)?.PublicPermission ?? '').toUpperCase().includes('U') : s.Public === 'Yes'));
  if (pub.every(Boolean)) return { text: 'Everyone', title: 'Everyone has Use: anyone who gets through sign-in can use it, with no role needed' };
  if (!pub.some(Boolean)) return { text: 'Roles with Use', title: `Only people whose roles grant Use on ${info.resources.join(' or ')}` };
  const parts = info.resources.map((r, i) => `${pub[i] ? 'everyone · Use' : 'roles'} (${r.replace(/^%Service_/, '')})`);
  return { text: 'Mixed', title: parts.join(', ') };
}

function signInWords(s: ServiceSummary, info: ServiceInfo): string {
  if (info.kind === 'system') return 'No sign-in';
  if (!info.methods.length) return 'Set per application';
  return s.AuthenticationMethods.length ? s.AuthenticationMethods.map(methodWord).join(', ') : 'None allowed';
}

const COLUMNS: GridColumn[] = [
  { key: 'Label', label: 'Service', width: '210px', sortable: true, renderCell: (v, row) => cell.text(v, String(row.What)) },
  { key: 'Name', label: 'Resource', width: '180px', sortable: true, renderCell: (v) => cell.ref(v) },
  { key: 'Status', label: 'Status', width: '80px', sortable: true, renderCell: (v) => (v === 'On'
    ? status('On', 'success')
    : status('Off', 'neutral', 'Switched off: nobody can connect through it', { dim: true })) },
  { key: 'Who', label: 'Access', description: 'After sign-in: everyone (public), or only people whose roles grant Use on the service', width: '140px', sortable: true, renderCell: (v, row) => cell.text(v, String(row.WhoTitle)) },
  { key: 'SignIn', label: 'Sign-in', description: 'How people may prove who they are on this service', width: '220px', sortable: true, renderCell: (v, row) => cell.text(v, String(row.SignInTitle || v)) },
  { key: 'From', label: 'Allowed addresses', description: 'Client addresses this service accepts; — when it can’t be limited by address', width: '120px', sortable: true, renderCell: (v) => (v === 'Any address' ? cell.dim(String(v)) : cell.text(v)) },
  { key: 'Risk', label: 'Risk', description: 'Anyone: anyone can connect with No sign-in. Any machine: no sign-in and no address limit', width: '120px', sortable: true, renderCell: (v, row) => (v ? chip(String(v), row.RiskTone as 'danger' | 'warning', String(row.RiskTitle)) : '') },
];
const SECONDARY = ['Name', 'From', 'Who'];

export function servicesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="od-list sec-list" id="svc-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="svc-search" size="sm" full-width placeholder="Filter by service or resource"></ev-search></div>
        <ev-segmented-button id="svc-view" size="sm" aria-label="Show services"></ev-segmented-button>
        <span class="sec-divider" aria-hidden="true"></span>
        <ev-segmented-button id="svc-kind" class="sec-seg" size="sm" aria-label="Kind of service"></ev-segmented-button>
      </div>
      <ev-detail-panel id="svc-panel" detail-width="500" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="svc-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="svc-detail" aria-label="Service details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="svc-foot"></p>
    </div>
    <div id="svc-full" hidden></div>`;
  const listView = ctx.body.querySelector('#svc-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#svc-full') as HTMLElement;

  const viewEl = ctx.body.querySelector('#svc-view') as HTMLElement & { options: unknown; value: string };
  const kindEl = ctx.body.querySelector('#svc-kind') as HTMLElement & { options: unknown; value: string };
  const searchEl = ctx.body.querySelector('#svc-search') as HTMLElement & { value: string };
  const panel = ctx.body.querySelector('#svc-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#svc-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#svc-detail') as HTMLElement;
  viewEl.value = 'all';
  kindEl.value = 'all';

  let all: ServiceSummary[] = [];
  let graph: SecurityGraph | null = null;
  let webAuth: WebAuth | null = null;
  let supers: Superserver[] | null = null;
  /** Something connects over ECP (so sharding / ECP are really in use). */
  let ecpInUse = false;
  /** Anyone can connect: the way in itself, or (Web Gateway) web apps that allow No sign-in. */
  const risky = (s: ServiceSummary): boolean =>
    anyoneCanConnect(s, infoOf(s), graph) || (s.Name === PORTAL_SERVICE && s.Enabled && noSignInApps(graph).length > 0);
  let grid: GridEl | null = null;
  let view: View = 'all';
  let kind: KindFilter = 'all';
  let query = '';
  let selected: string | null = null;
  let pending = takeSelection();
  let token = 0;
  let alive = true;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  let canSecure: boolean | null = null;
  /** Which of a service's resources the chain and check are showing (SQL or objects). */
  let resIndex = 0;
  /** The superserver / web-auth reads have come back (each may have failed). */
  let extrasLoaded = false;
  ctx.onLeave(() => { alive = false; });

  const infoOf = (s: ServiceSummary): ServiceInfo => serviceInfo(s);
  const matchView = (s: ServiceSummary, v: View): boolean =>
    v === 'all' || (v === 'on' ? s.Enabled : risky(s));
  const matchKind = (s: ServiceSummary, k: KindFilter): boolean => k === 'all' || infoOf(s).kind === k;
  const visible = (): ServiceSummary[] => all.filter((s) => {
    if (!matchView(s, view) || !matchKind(s, kind)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    const i = infoOf(s);
    return s.Name.toLowerCase().includes(q) || i.label.toLowerCase().includes(q) || i.what.toLowerCase().includes(q);
  });
  /** On first, then ways in for people before links between systems, then by name. */
  const order = (s: ServiceSummary): number => (s.Enabled ? 0 : 2) + (infoOf(s).kind === 'people' ? 0 : 1);

  const toRow = (s: ServiceSummary): DataGridRow => {
    const i = infoOf(s);
    const who = whoWords(s, i, graph);
    const anon = anyoneCanConnect(s, i, graph);
    const apps = s.Name === PORTAL_SERVICE && s.Enabled ? noSignInApps(graph) : [];
    const machine = openToAnyMachine(s, i, ecpInUse);
    const a = anonOf(graph);
    return {
      Name: s.Name, Label: i.label, What: i.what, Status: s.Enabled ? 'On' : 'Off',
      Who: who.text, WhoTitle: who.title,
      SignIn: s.Name === PORTAL_SERVICE && i.methods.length ? `${signInWords(s, i)} · set per web app` : signInWords(s, i),
      SignInTitle: s.Name === PORTAL_SERVICE ? 'How the Web Gateway itself connects to IRIS. How people sign in is set on each web application.' : '',
      Unauth: s.Enabled && noSignInOn(s) && i.kind === 'people' && s.Name !== PORTAL_SERVICE,
      From: i.ips ? addressWords(s.AllowedConnections) : '—',
      // Short chip (fits with the panel open); the full sentence is its tooltip.
      Risk: anon || apps.length ? 'Anyone' : machine ? 'Any machine' : '',
      // "Anyone" with full access is red, as on every screen; with less, and "Any machine", amber.
      RiskTone: (anon || apps.length) && a?.full ? 'danger' : 'warning',
      RiskTitle: anon ? `Anyone can connect: No sign-in is allowed, so anyone who reaches it gets ${anonGets(a)}`
        : apps.length ? `Anyone can connect: ${apps.length} web app${apps.length === 1 ? '' : 's'} allow No sign-in; callers get ${anonGets(a)}`
          : machine ? 'On with no address limit: any machine that can reach it connects' : '',
    };
  };

  const renderToolbar = (): void => {
    const nv = (v: View): number => all.filter((s) => matchView(s, v) && matchKind(s, kind)).length;
    // One chip group; a zero-count chip is dimmed (disabled) unless it's the one chosen.
    setChips(viewEl, all.length, [
      { value: 'all', label: `All ${nv('all')}` },
      { value: 'on', label: `On ${nv('on')}` },
      { value: 'open', label: `Anyone can connect ${nv('open')}`, disabled: nv('open') === 0 && view !== 'open' },
    ], { active: view, risk: ['open'] });
    // Second chip group, after the divider: what kind of service.
    const nk = (k: KindFilter): number => all.filter((s) => matchView(s, view) && matchKind(s, k)).length;
    setChips(kindEl, all.length, [
      { value: 'all', label: 'Any kind' },
      { value: 'people', label: `For people ${nk('people')}`, disabled: nk('people') === 0 && kind !== 'people' },
      { value: 'system', label: `Between systems ${nk('system')}`, disabled: nk('system') === 0 && kind !== 'system' },
    ], { active: kind });
    // Both chip groups count as a filter: the search box stays while either is set.
    setSearch(searchEl, all.length, { query, filtered: view !== 'all' || kind !== 'all' });
    const divider = ctx.body.querySelector<HTMLElement>('.sec-divider');
    if (divider) divider.hidden = kindEl.hidden || viewEl.hidden;
  };

  const renderFoot = (): void => {
    const on = all.filter((s) => s.Enabled).length;
    const open = all.filter(risky).length;
    (ctx.body.querySelector('#svc-foot') as HTMLElement).innerHTML =
      `<b>${num(all.length)}</b> services<span class="meta-sep">·</span><b>${num(on)}</b> on`
      + (open ? `<span class="meta-sep">·</span><b>${num(open)}</b> anyone can connect` : '');
  };

  /**
   * No page notice here (design v2): the red "Anyone can connect N" filter
   * chip and the Risk column's "Anyone" badges carry the risk. Clear anything
   * a previous screen left.
   */
  const renderBanner = (): void => { if (ctx.banners) ctx.banners.innerHTML = ''; };

  const applyColumns = (): void => {
    if (!grid) return;
    // Allowed addresses only earns a column when at least 2 services have a list; otherwise it's in the detail.
    const withAddresses = all.filter((s) => s.AllowedConnections.length).length;
    for (const c of COLUMNS) {
      const hide = (panel.open && SECONDARY.includes(c.key)) || (c.key === 'From' && withAddresses < 2);
      grid.setColumnVisible(c.key, !hide);
    }
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };

  const renderGrid = (): void => {
    const rows = visible().sort((a, b) => order(a) - order(b) || infoOf(a).label.localeCompare(infoOf(b).label)).map(toRow);
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('aria-label', 'Services');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        void selectRow(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name));
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.svc-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      const what = view === 'open' ? 'services anyone can connect to' : view === 'on' ? 'services that are on' : 'services';
      wrap.insertAdjacentHTML('beforeend', `<div class="svc-empty">${emptyState({
        icon: 'search', title: `No ${what}${query ? ` match “${query}”` : ''}`,
        what: view === 'open' ? 'Every service asks callers to sign in, or refuses them.' : 'Change the filters above to see more.',
        why: esc(BUILT_IN),
        action: '<button type="button" class="btn btn--sm" data-svc-clear>Show all services</button>',
      })}</div>`);
      wrap.querySelector('[data-svc-clear]')?.addEventListener('click', () => {
        view = 'all'; kind = 'all'; query = ''; viewEl.value = 'all'; kindEl.value = 'all'; searchEl.value = '';
        renderToolbar(); renderGrid();
      });
    }
  };

  const close = (): void => {
    token++;
    if (od.selected() !== null) { void od.select(null); return; }
    selected = null; grid?.select([]); setPanel(false);
  };
  const open = (name: string): void => {
    if (!all.some((s) => s.Name === name)) return;
    if (!visible().some((s) => s.Name === name)) {
      view = 'all'; kind = 'all'; query = '';
      viewEl.value = 'all'; kindEl.value = 'all'; searchEl.value = '';
      renderToolbar();
    }
    if (selected !== name) resIndex = 0;
    selected = name;
    renderGrid();
    if (od.mode() === 'full') void od.openFull(name); else void renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  const leaveEditor = (): void => {
    ctx.beforeLeave(null);
    editor?.close();
    editor = null;
    restoreWidth?.();
    restoreWidth = null;
  };
  /** The user backed out at a guard dialog: stay in the form, changes kept, no error. */
  const keepEditing = (): never => {
    toast('Not saved. Your changes are still here.', 'info');
    throw new SubmitCancelled();
  };
  const selectRow = async (name: string): Promise<void> => {
    if (editor) {
      if (!(await editor.guard())) { grid?.select(selected !== null ? [selected] : []); return; }
      leaveEditor();
    }
    if (selected !== name) resIndex = 0;
    selected = name;
    await od.select(name);
  };

  const chainLinks: ChainLinks = {
    user: (n) => linkTo(ctx.navigate, 'security/users', n),
    role: (n) => linkTo(ctx.navigate, 'security/roles', n),
    resource: (n) => linkTo(ctx.navigate, 'security/resources', n),
  };

  /* ───────────── Detail (view mode) ───────────── */

  /** Header while the editor loads (the editor then brings its own title). */
  const head = (s: ServiceSummary): string => `
    <header class="detail-head">
      <div class="detail-title"><h2>${esc(infoOf(s).label)}</h2><span class="svc-code">${esc(s.Name)}</span></div>
    </header>`;

  /**
   * Who gets past the Use check, as one line of text (no diagram):
   * "Everyone may use it without a role · also held by 2 users through 5 roles · plus 4 accounts with %All".
   * Counts link to Users and Roles; a single role links to that role.
   */
  const accessLine = (s: ServiceSummary, info: ServiceInfo, res: string, g: SecurityGraph): string => {
    const who = g.whoCan(res);
    const pub = (g.resource(res)?.PublicPermission ?? '').toUpperCase().includes('U');
    const roleUsers = who.users.filter((u) => u.source !== 'all').length;
    const noSignIn = s.Enabled && noSignInOn(s) && s.Name !== PORTAL_SERVICE;
    const parts: string[] = [];
    // "Anyone can connect" is the page notice's, "Every user" the strip's, %All accounts are in ⋯: this line keeps to the role grants.
    void noSignIn;
    const roles = who.roles;
    if (roles.length) {
      const users = `<a class="svc-link" href="#/security/users">${plural(roleUsers, 'user')}</a>`;
      const via = roles.length === 1
        ? `<a class="svc-link" href="#/security/roles" data-go-role="${esc(roles[0].role)}">${esc(roles[0].role)}</a>`
        : `<a class="svc-link" href="#/security/roles">${plural(roles.length, 'role')}</a>`;
      parts.push(`${parts.length ? 'also held' : 'Held'} by ${users} through ${via}`);
    } else if (!pub) parts.push('No role grants Use on it');
    if (!parts.length) return '<p class="chip-list-empty">No role is needed: everyone has Use.</p>';
    const off = s.Enabled ? '' : '<span class="dim"> (the service is off, so nobody gets in)</span>';
    return `<p class="detail-para svc-access-line" title="${esc(`Use on ${res}`)}">${parts.join(' · ')}.${off}</p>`;
  };

  /** "Who can use it": everyone, the roles, the users through them, %All. */
  const whoBlock = (res: string, g: SecurityGraph): string => {
    const who = g.whoCan(res);
    const pub = (g.resource(res)?.PublicPermission ?? '').toUpperCase().includes('U');
    const userLink = (n: string, title = 'Open this user'): string => `<button type="button" class="chip-link" data-user="${esc(n)}" aria-label="Open user ${esc(n)}">${chip(n, 'neutral', title)}</button>`;
    const out: string[] = [];
    if (who.roles.length) {
      out.push(`<ul class="svc-list">${who.roles.map((r) =>
        `<li><span>${roleLink(r.role)}</span><span class="svc-meta">${r.path.length > 1 ? `through ${esc(r.path.slice(1).join(' → '))}` : 'directly'}</span></li>`).join('')}</ul>`);
    } else if (!pub) out.push('<p class="chip-list-empty">No role grants Use on it</p>');
    const users = who.users.filter((u) => u.source !== 'all');
    if (users.length) {
      out.push(`<p class="chip-sub">Users, through those roles</p><div class="chip-list">${users.map((u) => userLink(u.user, u.source !== 'all' && 'path' in u.source ? `through ${u.source.path.join(' → ')}` : 'Open this user')).join('')}</div>`);
    }
    if (res === '%Service_SQL') out.push('<p class="detail-para dim">IRIS also lets a signed-in user use SQL for the length of a connection if they hold SQL privileges on a table, even without this.</p>');
    return out.join('');
  };

  /** Sign-in methods, with what each means here. */
  const listWords = (a: string[]): string => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const methodsBlock = (s: ServiceSummary, info: ServiceInfo, d: ServiceDetail): string => {
    if (info.kind === 'system') return `<p class="detail-para">No sign-in. The service is simply on or off; ${info.ips ? 'limit it to the machines that need it with allowed addresses.' : 'every connection it receives is trusted.'}</p>`;
    if (!info.methods.length) return `<p class="detail-para">How people sign in is set on each ${s.Name === '%Service_DocDB' ? 'document database application' : 'application'}, not here.</p>`;
    const list = METHODS.filter((m) => info.methods.includes(m.key) || methodOn(d.AutheEnabled, m));
    const sysOffOf = (m: Method): boolean => !!m.system && webAuth !== null && !webAuth[m.system];
    // "Off for the whole instance" is said once, as the card's lead line; the rows stay short.
    const off = list.filter(sysOffOf).map((m) => m.label);
    const lead = off.length ? `<p>${esc(listWords(off))} ${off.length === 1 ? 'is' : 'are'} off for the whole instance.</p>` : '';
    return `${lead}<ul class="svc-list">${list.map((m) => {
      const on = methodOn(d.AutheEnabled, m);
      const sysOff = sysOffOf(m);
      const gateway = m.key === 'unauth' && s.Name === PORTAL_SERVICE;
      const risk = on && m.key === 'unauth' && !gateway && s.Enabled && anonCanUse(s, info, graph);
      const meta = on ? (sysOff ? chip('On, unused', 'neutral', 'Off for the whole instance, so it isn’t used') : chip('Allowed', risk ? 'warning' : 'success')) : cell.dim('Not allowed');
      const extra = gateway ? 'Here it’s how the gateway itself connects; what a browser needs is set on each web application.' : '';
      return `<li class="svc-line${on ? '' : ' svc-line--off'}"><span><b>${esc(m.label)}</b><span class="svc-sub">${esc(m.means)}${extra ? `. ${esc(extra)}` : ''}</span></span><span class="svc-meta">${meta}</span></li>`;
    }).join('')}</ul>`;
  };

  const addressesBlock = (s: ServiceSummary, info: ServiceInfo, d: ServiceDetail): string => {
    if (!info.ips) return '<p class="detail-para dim">This service can’t be limited by address.</p>';
    if (!d.ClientSystems.length) {
      return `<p class="detail-para">Any address.${openToAnyMachine(s, info, ecpInUse) ? ' <span class="svc-risk">Any machine that can reach this server’s port connects; there’s no sign-in.</span>' : ''}</p>`;
    }
    return `<ul class="svc-list">${d.ClientSystems.map((e) => {
      const x = addressEntry(e);
      return `<li><span class="mono">${esc(x.address)}</span><span class="svc-meta">${x.roles.length ? `only ${esc(x.roles.join(', '))}` : isLocalAddress(e) ? 'this server' : ''}</span></li>`;
    }).join('')}</ul>`;
  };

  /** The superservers (network ports) that carry this way in. */
  const reachBlock = (s: ServiceSummary, info: ServiceInfo): string => {
    if (!info.flag) {
      const local = ['%Service_Console', '%Service_Terminal', '%Service_CallIn', '%Service_Login', '%Service_EscalateLogin'];
      const text = local.includes(s.Name) ? 'On this server only; no network port.'
        : s.Name === '%Service_Telnet' ? 'Its own Telnet port, not a superserver.'
          : s.Name === '%Service_ComPort' ? 'Serial ports on this server.'
            : s.Name === '%Service_DocDB' ? 'Through the Web Gateway.' : 'Not through a superserver.';
      return `<p class="detail-para">${esc(text)}</p>`;
    }
    if (!supers) return extrasLoaded ? '<p class="chip-list-empty">—</p>' : '<p class="chip-sub">Working out which ports carry it…</p>';
    const carrying = supers.filter((x) => x[info.flag as keyof Superserver]);
    if (!carrying.length) return `<p class="detail-para">No superserver accepts these connections${s.Enabled ? ', so nobody can use this service over the network' : ''}.</p>`;
    const live = carrying.filter((x) => x.Enabled);
    return `<ul class="svc-list">${carrying.map((x) => `<li><a class="svc-link" href="#/security/superservers" data-ss="${esc(ssKey(x))}">Port ${x.Port}${allAddresses(x.BindAddress) ? '' : ` on ${esc(x.BindAddress)}`} ›</a>
      <span class="svc-meta">${x.Enabled ? (x.SSLSupportLevel === 0 ? chip('TLS off', 'warning', 'Connections on this port aren’t encrypted') : `TLS ${esc(tlsLabel(x.SSLSupportLevel).toLowerCase())}`) : chip('Off', 'neutral')}</span></li>`).join('')}</ul>
      ${s.Enabled && !live.length ? '<p class="detail-para svc-risk">Every superserver that accepts it is off, so nobody can use it over the network.</p>' : ''}`;
  };

  /**
   * This service's own risk as it stands now, in the shared notice (peek, full view, and the top of
   * its editor): the one "anyone can connect" wording, or "any machine can connect". '' when none.
   */
  const noticeOf = (s: ServiceSummary, info: ServiceInfo): string => {
    const a = anonOf(graph);
    const apps = s.Name === PORTAL_SERVICE ? noSignInApps(graph) : [];
    if (anyoneCanConnect(s, info, graph)) return anyoneNotice({ full: !!a?.full, roles: a ? a.roles : null });
    if (s.Enabled && apps.length) {
      return anyoneNotice({ full: !!a?.full, roles: a ? a.roles : null, scope: `to ${num(apps.length)} web application${apps.length === 1 ? '' : 's'}`, link: { href: `#/${WEB_APPS}`, label: 'Show them' } });
    }
    if (openToAnyMachine(s, info, ecpInUse)) {
      const text = 'Any machine can connect: no sign-in and no address limit.';
      return `<div class="page-notice page-notice--warning" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon><span class="page-notice-text" title="${esc(text)}">${esc(text)}</span></div>`;
    }
    return '';
  };
  const signInText = (s: ServiceSummary, info: ServiceInfo): string =>
    (s.Name === PORTAL_SERVICE && info.methods.length ? `${signInWords(s, info)} (gateway)` : signInWords(s, info));
  /** SQL / Objects: real tabs (the shared view-tab style), since each shows a different part of the service. */
  const resTabs = (info: ServiceInfo): string => (info.resources.length > 1
    ? viewTabs('svc-res', info.resources.map((x, i) => ({ value: String(i), label: x === '%Service_SQL' ? 'SQL' : x === '%Service_Object' ? 'Objects & Native API' : x })), String(Math.min(resIndex, info.resources.length - 1)))
    : '');
  /**
   * For a way in for people: `how` (who gets past the Use check: the roles that grant it and the
   * users through them) and `check` (a user picker that answers "can this user use it, and why").
   */
  const peopleBlocks = (s: ServiceSummary, info: ServiceInfo): { how: string; check: string } => {
    const res = info.resources[Math.min(resIndex, info.resources.length - 1)];
    if (info.kind !== 'people' || !res) return { how: '', check: '' };
    const roles = graph ? graph.whoCan(res).roles.length : 0;
    const off = s.Enabled ? '' : '<p class="detail-para dim">The service is off, so nobody gets in.</p>';
    return {
      how: `${resTabs(info)}${!graph ? '<p class="chip-sub">Working out who gets in…</p>'
        : roles ? `${whoBlock(res, graph)}${off}` : accessLine(s, info, res, graph)}`,
      check: `<p class="detail-para">Pick a user to see whether they pass the Use check on ${esc(res)}, and why or why not.</p>
        <div id="svc-check">${graph ? '' : '<p class="chip-sub">Available once who can use it is worked out…</p>'}</div>`,
    };
  };

  /** The service read for the peek / full view, so ⋯ can switch it without another read. */
  let shownDetail: { name: string; d: ServiceDetail } | null = null;
  const detailOf = async (name: string): Promise<ServiceDetail> => {
    const d = await getService(name);
    shownDetail = { name, d };
    return d;
  };

  async function peekBody(s: ServiceSummary): Promise<string> {
    const d = await detailOf(s.Name);
    const info = infoOf(s);
    const who = whoWords(s, info, graph);
    const apps = s.Name === PORTAL_SERVICE ? noSignInApps(graph) : [];
    const type = ['Built in', info.kind === 'system' ? 'between systems' : 'for people', info.legacy ? 'legacy' : '', info.platform ? `${info.platform} only` : ''].filter(Boolean).join(' · ');
    const callout = noticeOf(s, info);
    const p = peopleBlocks(s, info);
    return `
      ${callout}
      ${odSection('', odKv([
        ['Access', esc(who.text), who.title],
        ['Sign-in', esc(signInText(s, info)), s.Name === PORTAL_SERVICE ? 'How the Web Gateway itself connects to IRIS; how people sign in is set on each web application' : ''],
        ['Allowed from', info.ips ? esc(addressWords(d.ClientSystems)) : '—', info.ips ? '' : 'This service can’t be limited by address'],
        ...(s.Name === PORTAL_SERVICE ? [['Web applications', `${num(apps.length)} allow no sign-in · <a class="svc-link" href="#/${WEB_APPS}">Show ›</a>`] as [string, string]] : []),
        ['Type', esc(type), BUILT_IN],
      ]))}
      ${p.how ? odSection('How people get in', p.how) : ''}
      ${odSection('Sign-in methods', methodsBlock(s, info, d))}
      ${d.ClientSystems.length ? odSection('Allowed from', addressesBlock(s, info, d)) : ''}
      ${odSection('Network ports', reachBlock(s, info))}
      ${p.check ? odSection('Check a user', p.check) : ''}`;
  }

  async function fullOf(s: ServiceSummary): Promise<OdFull> {
    selected = s.Name; // later loads (graph, ports) refresh what's shown
    const d = await detailOf(s.Name);
    const info = infoOf(s);
    const p = peopleBlocks(s, info);
    const callout = noticeOf(s, info);
    // One place per fact: a short "allowed from" is a strip cell; a list of addresses is a card.
    const from = info.ips ? addressWords(d.ClientSystems) : 'Any address (can’t be limited)';
    const fromShort = !d.ClientSystems.length || from.length <= 28;
    const res = info.resources[Math.min(resIndex, info.resources.length - 1)];
    const whoCell = ((): { label: string; value: string; title?: string } => {
      if (info.kind !== 'people' || !res) return { label: 'Who can use it', value: 'Any allowed machine' };
      if (!graph) return { label: 'Who can use it', value: '—' };
      const w = graph.whoCan(res);
      if ((graph.resource(res)?.PublicPermission ?? '').toUpperCase().includes('U')) return { label: 'Who can use it', value: 'Every user', title: `Everyone has Use on ${res}` };
      const n = new Set(w.users.map((u) => u.user)).size;
      return { label: 'Who can use it', value: `${num(n)} user${n === 1 ? '' : 's'}`, title: `Users who pass the Use check on ${res}, including %All holders` };
    })();
    // The ports themselves (and their TLS) are the Network ports card's; the strip counts them.
    const portCell = ((): { label: string; value: string; title?: string; tone?: 'warning' } => {
      if (!info.flag) return { label: 'Network ports', value: 'None', title: 'Not through a superserver' };
      if (!supers) return { label: 'Network ports', value: '—' };
      const carry = supers.filter((x) => x[info.flag as keyof Superserver]);
      const plain = carry.filter((x) => x.Enabled && x.SSLSupportLevel === 0).length;
      return { label: 'Network ports', value: carry.length ? `${num(carry.length)}${plain ? ` · ${num(plain)} without TLS` : ''}` : 'None', tone: plain ? 'warning' : undefined,
        title: carry.length ? carry.map((x) => `${x.Port}${x.Enabled ? '' : ' (off)'}`).join(', ') : 'No superserver accepts these connections' };
    })();
    // The peek's one-line description leads the first card, so the full view never shows less than the peek.
    const lead = `<p class="svc-lead">${esc(infoOf(s).what)}</p>`;
    const methods = { title: 'Sign-in methods', body: methodsBlock(s, info, d) };
    const main = [
      ...(p.how ? [{ title: 'How people get in', body: p.how }] : []),
      ...(p.check ? [{ title: 'Check a user', body: p.check }] : []),
      ...(p.how ? [] : [methods]),
    ];
    main[0] = { ...main[0], body: `${lead}${main[0].body}` };
    return {
      strip: [
        // Sign-in is the Sign-in methods card's; the strip says what kind of service it is.
        { label: 'Type', value: `${info.kind === 'system' ? 'Between systems' : 'For people'}${info.legacy ? ' · legacy' : ''}`, title: BUILT_IN },
        whoCell,
        fromShort ? { label: 'Allowed from', value: from } : { label: 'Allowed addresses', value: String(d.ClientSystems.length) },
        portCell,
      ],
      notice: callout || undefined,
      main,
      side: [
        ...(p.how ? [methods] : []),
        { title: 'Network ports', body: reachBlock(s, info) },
        ...(fromShort ? [] : [{ title: 'Allowed from', body: addressesBlock(s, info, d) }]),
      ],
    };
  }

  /** Bind what the peek or full view just drew: the SQL / Objects switch and the access check. */
  const wireBody = (root: HTMLElement, s: ServiceSummary): void => {
    const info = infoOf(s);
    if (root.querySelector('#svc-res')) {
      bindViewTabs(root, 'svc-res', (v) => { resIndex = Number(v) || 0; od.refresh(); });
    }
    const checkHost = root.querySelector<HTMLElement>('#svc-check');
    const res = info.resources[Math.min(resIndex, info.resources.length - 1)];
    if (graph && checkHost && res) {
      mountAccessCheck(checkHost, graph, {
        resource: res, links: chainLinks,
        onFix: (fix) => (fix.kind === 'new-role' ? linkTo(ctx.navigate, 'security/roles', '') : linkTo(ctx.navigate, 'security/users', fix.user)),
      });
    }
  };

  const od = objectDetail<ServiceSummary>(ctx, {
    collection: 'Services', noun: 'service',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (x) => x.Name,
    find: (k) => all.find((x) => x.Name === k) ?? all.find((x) => x.Name.toLowerCase() === k.toLowerCase()),
    order: () => visible().sort((a, b) => order(a) - order(b) || infoOf(a).label.localeCompare(infoOf(b).label)).map((x) => x.Name),
    name: (x) => infoOf(x).label,
    meta: (x) => odMeta(x.Enabled ? { label: 'On', tone: 'success' } : { label: 'Off', tone: 'neutral', title: 'Nobody can connect through it' },
      [x.Name]),
    description: (x) => infoOf(x).what.split(/(?<=\.)\s/)[0],
    primary: (x) => ({ label: 'Edit', icon: 'edit-2', blocked: canSecure === false ? NO_PRIV : null, run: () => void openEditor(x) }),
    menu: (x) => {
      const reason = canSecure === false ? NO_PRIV : null;
      const res = infoOf(x).resources[Math.min(resIndex, infoOf(x).resources.length - 1)];
      return [...(infoOf(x).kind === 'people' && res ? [{
        label: 'Everyone with this access…', icon: 'users', disabled: !graph, reason: 'Still working out who can use it',
        onSelect: () => showEveryone(res),
      }] : []), {
        label: x.Enabled ? 'Switch off…' : 'Switch on…', icon: x.Enabled ? 'eye-off' : 'eye', disabled: !!reason, reason: reason ?? undefined,
        onSelect: () => void (async () => {
          try {
            const d = shownDetail?.name === x.Name ? shownDetail.d : await getService(x.Name);
            await toggle(x, d);
          } catch (e) { toast(errorText(e), 'danger'); }
        })(),
      }];
    },
    peek: peekBody,
    loadFull: fullOf,
    wire: (root, x) => wireBody(root, x),
    onSelect: (k) => { selected = k; if (k === null) shownDetail = null; grid?.select(k ? [k] : []); },
    onPeek: () => applyColumns(),
    // Paging, the breadcrumb and Esc leave an open form only through its unsaved-changes check.
    canLeave: async () => { if (editor && !(await editor.guard())) return false; leaveEditor(); return true; },
    widthKey: 'osca-portal:peek-width:security/services',
  });
  /** Everyone who passes the Use check on a service's resource: through roles, and every %All account. */
  const showEveryone = (res: string): void => {
    const g = graph;
    if (!g) return;
    const w = g.whoCan(res);
    const pub = (g.resource(res)?.PublicPermission ?? '').toUpperCase().includes('U');
    const seen = new Set<string>();
    const items = w.users.filter((u) => u.source !== 'all').map((u) => {
      seen.add(u.user);
      const how = u.source !== 'all' && 'path' in u.source ? `through ${u.source.path.join(' → ')}` : 'holds a role with Use';
      return { name: u.user, how };
    });
    for (const u of w.allHolders) if (!seen.has(u)) items.push({ name: u, how: u === ANON_USER ? 'holds %All: anyone who connects without signing in' : 'holds %All' });
    listDialog(`Everyone with Use on ${res}`, items.sort((a, b) => a.name.localeCompare(b.name)), pub ? 'Every user: everyone has Use.' : 'Nobody.');
  };
  /** Show the selected service in the peek (or refresh what's shown), unless a form is open. */
  const renderDetail = async (quiet = false): Promise<void> => {
    if (editor) return;
    if (selected === null) { if (od.selected() !== null) await od.select(null); else setPanel(false); return; }
    // A quiet refresh leaves an answered access check alone.
    if (quiet && (detailEl.querySelector('#svc-check .check-answer') || fullEl.querySelector('#svc-check .check-answer'))) return;
    if (od.selected() === selected) od.refresh(); else await od.select(selected);
  };

  // Links in the peek and the full view: roles and users on their screens, ports on Superservers.
  const onLink = (e: Event): void => {
    const t = e.target as HTMLElement;
    const goRole = t.closest<HTMLElement>('[data-go-role]');
    const role = t.closest<HTMLElement>('.chip-link[data-role]');
    const user = t.closest<HTMLElement>('[data-user]');
    const ss = t.closest<HTMLElement>('[data-ss]');
    if (goRole) { e.preventDefault(); chainLinks.role?.(goRole.dataset.goRole ?? ''); }
    else if (role) chainLinks.role?.(role.dataset.role ?? '');
    else if (user) { e.preventDefault(); chainLinks.user?.(user.dataset.user ?? ''); }
    else if (ss) { e.preventDefault(); linkToScreen(ctx.navigate, 'security/superservers', ss.dataset.ss ?? ''); }
  };
  detailEl.addEventListener('click', onLink);
  fullEl.addEventListener('click', onLink);

  /* ───────────── Guard rails ───────────── */

  /**
   * What a change would do that deserves a second look. `typed` when the
   * change could lock everyone out of the web (this portal included).
   */
  const risksOf = (s: ServiceSummary, before: State, after: State): { risks: GuardRisk[]; typed: boolean; danger: boolean } => {
    const info = infoOf(s);
    const risks: GuardRisk[] = [];
    let typed = false;
    let danger = false;
    const pw = methodOf('password');
    const un = methodOf('unauth');
    const lost = (m: Method): boolean => methodOn(before.mask, m) && !methodOn(after.mask, m);
    if (s.Name === PORTAL_SERVICE) {
      // "This portal runs through it" lives here, in the dialog, not permanently in the panel.
      const lock = 'This portal runs through it: this portal and the Management Portal both reach IRIS through the Web Gateway, so they will stop working for everyone, including you. Undoing it needs the Terminal or IRIS’s emergency access.';
      if (before.enabled && !after.enabled) { risks.push({ title: 'This switches off the Web Gateway', text: `Every web page and REST call stops. ${lock}` }); typed = true; }
      if (after.enabled && lost(un)) { risks.push({ title: 'This removes No sign-in from the Web Gateway', text: `The gateway must then sign in with the username and password in its own settings (normally CSPSystem). If it has none, ${lock.charAt(0).toLowerCase()}${lock.slice(1)}` }); typed = true; }
      if (after.enabled && lost(pw)) { risks.push({ title: 'This removes Password from the Web Gateway', text: `If the gateway signs in with a username and password (normally CSPSystem), it will be refused. ${lock}` }); typed = true; }
      const ipsChanged = after.ips.join(';') !== before.ips.join(';');
      if (after.enabled && ipsChanged && after.ips.length && !after.ips.some(isLocalAddress)) {
        risks.push({ title: 'This blocks the Web Gateway on this server', text: `Only the listed addresses may connect, and the gateway on this server connects from 127.0.0.1. ${lock}` }); typed = true;
      }
      danger = typed;
    }
    if (s.Name !== PORTAL_SERVICE && before.enabled && !after.enabled && (s.Name === '%Service_Bindings' || info.sensitive)) {
      risks.push({
        title: `This switches off ${info.label}`,
        text: s.Name === '%Service_Bindings'
          ? 'Every SQL tool, ODBC or JDBC application, object connection and Native API client is refused, including your own tools.'
          : `Nobody can open the ${info.label} any more, including you.`,
        impact: 'Connections already open carry on until they end.',
      });
      danger = true;
    }
    // Opening a way in to anonymous callers.
    const g = graph;
    const wasOpen = before.enabled && methodOn(before.mask, un);
    const nowOpen = after.enabled && methodOn(after.mask, un);
    if (info.kind === 'people' && s.Name !== PORTAL_SERVICE && nowOpen && !wasOpen && anonCanUse(s, info, g)) {
      const a = anonOf(g);
      risks.push({ title: `Anyone can connect to ${info.label}`, text: `With No sign-in allowed, callers get ${anonGets(a)}.${info.sensitive ? ' A Terminal session can read or change anything that allows.' : ''}` });
      danger = true;
      if (a?.full && info.sensitive) typed = true;
    } else if (info.kind === 'people' && s.Name !== PORTAL_SERVICE && nowOpen && wasOpen && anonCanUse(s, info, g)
      && (before.mask !== after.mask || before.ips.join(';') !== after.ips.join(';'))) {
      // Other changes while it stays open: still say so before saving (not red, not typed: nothing new is opened).
      risks.push({ title: `Anyone can connect to ${info.label} (unchanged)`, text: `No sign-in stays allowed, so callers still get ${anonGets(anonOf(g))}.` });
    }
    // Switching on a system link with no address limit.
    if (info.kind === 'system' && info.ips && after.enabled && !before.enabled && !after.ips.length) {
      risks.push({ title: `${info.label} would accept any machine`, text: 'It has no sign-in, and no allowed addresses are set. Add the machines that need it first.' });
    }
    return { risks, typed, danger };
  };

  /** Ask about the risks (if any); true to go ahead. */
  const askRisks = async (s: ServiceSummary, before: State, after: State, label: string): Promise<boolean> => {
    const r = risksOf(s, before, after);
    if (!r.risks.length) return true;
    const d = guardDialog(r.risks);
    return confirm({
      title: d.title, danger: r.danger, confirmLabel: label,
      body: d.body,
      typeToConfirm: r.typed ? s.Name : undefined,
    });
  };

  const patchOf = (before: State, after: State): ServicePatch => {
    const p: ServicePatch = {};
    if (before.enabled !== after.enabled) p.Enabled = after.enabled;
    if (before.mask !== after.mask) p.AutheEnabled = after.mask;
    if (before.ips.join(';') !== after.ips.join(';')) p.ClientSystems = after.ips;
    return p;
  };

  const afterSave = async (name: string, message: string): Promise<void> => {
    leaveEditor();
    toast(message);
    selected = name;
    if (od.mode() === 'full') fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
    await load(true);
    if (od.mode() === 'full') od.refresh(); else open(name);
  };

  /* ───────────── Actions and editing ───────────── */

  /** Switch a service on or off from the menu, with the same guard rails as Edit. */
  const toggle = async (s: ServiceSummary, d: ServiceDetail): Promise<void> => {
    const info = infoOf(s);
    const before: State = { enabled: d.Enabled, mask: d.AutheEnabled, ips: d.ClientSystems };
    const after: State = { ...before, enabled: !d.Enabled };
    const r = risksOf(s, before, after);
    const verb = after.enabled ? 'Switch on' : 'Switch off';
    if (!r.risks.length) {
      const ok = await confirm({
        title: `${verb} ${info.label}?`, confirmLabel: verb,
        body: after.enabled
          ? `<p>People who pass its sign-in and Use checks can then connect this way (${esc(s.AuthenticationMethods.map(methodWord).join(', ') || 'no method allowed')}).</p>`
          : `<p>Nobody can connect this way afterwards. Connections already open carry on until they end.</p>`,
      });
      if (!ok) return;
    } else if (!(await askRisks(s, before, after, verb))) return;
    try {
      await saveService(s.Name, { Enabled: after.enabled });
    } catch (err) {
      toast(`Couldn’t change ${info.label}. ${errorText(err)}`, 'danger');
      return;
    }
    await afterSave(s.Name, `${info.label} switched ${after.enabled ? 'on' : 'off'}. Connections already open aren’t affected.`);
  };

  // From the list it opens in the drawer; from the full view (#/security/services/<name>) it takes the
  // page body's place, so the address, title and ‹ › pager stay, and Cancel or Save bring the full view back.
  const openEditor = async (s: ServiceSummary): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    menu?.destroy(); menu = null;
    const my = ++token;
    const inFull = od.mode() === 'full';
    const host = inFull ? fullEl : detailEl;
    if (!inFull) {
      setPanel(true);
      restoreWidth = panelWidth(panel, EDIT_WIDTH);
      detailEl.innerHTML = head(s) + skeleton(6);
    }
    let d: ServiceDetail;
    try {
      d = await getService(s.Name);
      if (!webAuth) webAuth = await getWebAuth().catch(() => null);
    } catch (err) {
      if (my !== token) return;
      if (inFull) { toast(errorText(err), 'danger'); return; }
      restoreWidth?.(); restoreWidth = null;
      detailEl.innerHTML = head(s) + errorPanel(err);
      return;
    }
    if (my !== token) return;
    // The user may have paged or gone back to the list while the read was out.
    if (inFull && (od.mode() !== 'full' || od.selected() !== s.Name)) return;
    const info = infoOf(s);
    const before: State = { enabled: d.Enabled, mask: d.AutheEnabled, ips: d.ClientSystems };
    const sysOn = (m: Method): boolean => !m.system || !webAuth || !!webAuth[m.system];
    /** Methods with a switch here: supported, editable, and on for the instance (or on here already, so they can be cleared). */
    const offered = METHODS.filter((m) => m.editable && info.methods.includes(m.key) && (sysOn(m) || methodOn(d.AutheEnabled, m)));
    const kept = methodsIn(d.AutheEnabled).filter((m) => !offered.includes(m));
    const instanceOff = METHODS.filter((m) => info.methods.includes(m.key) && !sysOn(m) && !methodOn(d.AutheEnabled, m));
    const link = (href: string, text: string): string => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;

    const statusSec = section('General', checkField('Enabled', 'Enabled', d.Enabled, {
      toggle: true, hint: info.kind === 'system' ? 'It has no sign-in: while it’s on, every allowed machine connects.' : 'While it’s off, nobody can connect through this service, whatever their roles.',
    }));
    // The risk as it stands now is the notice's (the same one the view shows); the preview speaks only of changes.
    const nowNotice = noticeOf(s, info);
    const methodsSec = info.kind === 'people' && info.methods.length ? section('Sign-in methods', `
      ${offered.map((m) => checkField(`m_${m.key}`, m.label, methodOn(d.AutheEnabled, m), {
        hint: sysOn(m) ? m.means : `${m.means}. Switched off for the whole instance, so it isn’t used; you can still clear it.`,
      })).join('')}
      ${kept.length ? `<p class="svc-hint">Kept as they are: ${esc(kept.map((m) => m.label).join(', '))}. ${link(portalServices.edit(s.Name), 'Change them in the Management Portal')}</p>` : ''}
      ${instanceOff.length ? `<p class="svc-hint">${esc(instanceOff.map((m) => m.label).join(', '))} ${instanceOff.length === 1 ? 'is' : 'are'} off for the whole instance. ${link(portalServices.authentication, 'Turn on in Authentication options')}</p>` : ''}`,
    { hint: 'If more than one is allowed, IRIS tries the strongest first and No sign-in last.' }) : '';
    const ipsSec = info.ips ? section('Allowed from', `
      ${textareaField('ClientSystems', 'Addresses', d.ClientSystems.join('\n'), {
        rows: 4, mono: true,
        hint: `One per line; leave empty for any address. An IP address, a range (10.0.0.1-20), a wildcard (192.168.1.*) or a host name.${info.ipRoles ? ' Add |RoleA,RoleB after an address to limit what that machine gets.' : ''}`,
      })}`) : '';
    const preview = '<div id="svc-preview" class="svc-preview" aria-live="polite"></div>';

    const stateOf = (v: FormValues): State => {
      let mask = d.AutheEnabled;
      for (const m of offered) mask = withMethod(mask, m, v[`m_${m.key}`] === true);
      const ips = info.ips ? String(v.ClientSystems ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : before.ips;
      return { enabled: v.Enabled === true, mask, ips };
    };

    const check = (): FieldProblem[] => {
      const v = readForm(host);
      const st = stateOf(v);
      const out: FieldProblem[] = [];
      if (offered.length && st.enabled && !methodsIn(st.mask).some((m) => m.key !== 'totp' && m.key !== 'sms')) {
        out.push({ field: `m_${offered[0].key}`, label: 'Sign-in methods', message: 'Allow at least one sign-in method, or switch the service off' });
      }
      if (info.ips) {
        const bad = st.ips.map(addressProblem).find(Boolean);
        if (bad) out.push({ field: 'ClientSystems', label: 'Addresses', message: bad });
      }
      return out;
    };

    const update = (): void => {
      const st = stateOf(readForm(host));
      const r = risksOf(s, before, st);
      const lines: string[] = [];
      // Only what this edit changes, against the saved state; unchanged fields are left out.
      const onOff = (b: boolean): string => (b ? 'On' : 'Off');
      const methodList = (mask: number): string => methodsIn(mask).map((m) => m.label).join(', ') || 'none allowed';
      const fromList = (ips: string[]): string => (ips.length ? ips.map((x) => addressEntry(x).address).join(', ') : 'any address');
      if (st.enabled !== before.enabled) {
        lines.push(`${info.label}: ${onOff(before.enabled)} → ${onOff(st.enabled)}${st.enabled ? '' : ' (nobody will be able to connect through it)'}.`);
      }
      if (st.mask !== before.mask) lines.push(`Sign-in: ${methodList(before.mask)} → ${methodList(st.mask)}.`);
      if (st.ips.join(';') !== before.ips.join(';')) lines.push(`Allowed from: ${fromList(before.ips)} → ${fromList(st.ips)}.`);
      const prev = host.querySelector('#svc-preview') as HTMLElement | null;
      if (prev) prev.innerHTML = previewHtml(lines, r.risks.filter((x) => !/\(unchanged\)$/.test(x.title)));
    };

    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(host, {
      // The full view's title already names the service.
      title: inFull ? 'Edit settings' : `Edit ${esc(info.label)} <span class="svc-code">${esc(s.Name)}</span>`,
      name: info.label,
      submitLabel: 'Save changes',
      sections: nowNotice + statusSec + methodsSec + ipsSec + section('What changes', preview),
      check,
      // Same test as the preview: a real difference from the saved service.
      changed: () => Object.keys(patchOf(before, stateOf(readForm(host)))).length > 0,
      onSubmit: async (v) => {
        const after = stateOf(v);
        const patch = patchOf(before, after);
        if (!Object.keys(patch).length) throw new Error('Nothing to save.');
        if (!(await askRisks(s, before, after, 'Save anyway'))) keepEditing();
        await saveService(s.Name, patch);
        await afterSave(s.Name, `${info.label} saved. Connections already open aren’t affected.`);
      },
      onCancel: () => {
        ctx.beforeLeave(null);
        editor?.close();
        editor = null;
        restoreWidth?.(); restoreWidth = null;
        if (inFull) { fullEl.innerHTML = ''; od.refresh(); } else void renderDetail();
      },
    });
    const ed = editor;
    if (inFull) stickyEditHead(host, info.label);
    const onChange = (): void => { if (editor === ed) { update(); ed.refresh(); } };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-textarea-input', 'ev-checkbox-change', 'ev-toggle-change']) ed.form.addEventListener(t, onChange);
    update();
    scrollPanelTop(host);
    requestAnimationFrame(() => { if (editor === ed) { update(); ed.refresh(); } });
  };

  /* ───────────── Loading ───────────── */

  const fillGraph = (fresh: boolean): void => {
    getSecurityGraph(fresh).then((g) => {
      if (!alive) return;
      graph = g;
      renderToolbar(); renderGrid(); renderFoot(); renderBanner();
      if (selected !== null && !editor) void renderDetail(true);
    }).catch(() => { /* the panel says it's still working it out */ });
  };
  const fillExtras = (): void => {
    Promise.all([getSuperservers().catch(() => null), getWebAuth().catch(() => null), getEcpAppServers().catch(() => [])]).then(([ss, wa, ecp]) => {
      if (!alive) return;
      supers = ss; webAuth = wa; extrasLoaded = true;
      if (ecpInUse !== ecp.length > 0) { ecpInUse = ecp.length > 0; renderGrid(); }
      if (selected !== null && !editor) void renderDetail(true);
    }).catch(() => { /* optional detail */ });
  };

  const updated = liveIndicator(ctx, () => void load(true), { live: false });
  const load = async (fresh = false): Promise<void> => {
    try {
      all = await getServices();
      if (!alive) return;
      updated(new Date());
      renderToolbar(); renderGrid(); renderFoot(); renderBanner();
      if (!opened) { opened = true; od.refresh(); } // a deep link (#/security/services/<name>) opens its full view now
      if (pending !== null) { const n = pending; pending = null; open(n); }
      else if (selected !== null && !editor) {
        if (all.some((s) => s.Name === selected)) void renderDetail(true); else close();
      }
      fillGraph(fresh);
      fillExtras();
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-svc-list');
      wrap.querySelector('#retry-svc-list')?.addEventListener('click', () => void load());
    }
  };

  searchEl.addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });
  viewEl.addEventListener('ev-segmented-button-change', (e) => { view = (e as CustomEvent<{ value: View }>).detail.value; renderToolbar(); renderGrid(); });
  kindEl.addEventListener('ev-segmented-button-change', (e) => {
    kind = ((e as CustomEvent<{ value: string }>).detail.value || 'all') as KindFilter;
    renderToolbar(); renderGrid();
  });

  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive || editor || selected === null) return;
    void renderDetail(true);
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  let opened = false;
  void load();
  const timer = setInterval(() => { if (!editor) void load(); }, REFRESH_MS);
  ctx.onLeave(() => { clearInterval(timer); token++; menu?.destroy(); leaveEditor(); });
}
