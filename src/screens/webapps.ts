// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web & APIs › Web applications — every web application IRIS serves, with how
 * it authenticates, what it runs and what it needs. Applications that accept
 * unauthenticated requests are flagged, because that is the setting that most
 * often matters.
 *
 * The list, a peek and a full view (#/web/apps/<path>) through objectDetail().
 * New web application and Edit are one form in the drawer (the same fields
 * either way; Edit starts from the application's current settings). Disable…
 * and Delete… live in ⋯.
 */
import '../styles-apps.css';
import '../styles-web.css';
import '../styles-services.css';
import {
  getWebAppList, getWebApp, setWebAppEnabled, deleteWebApp,
  type WebAppSummary, type WebAppDetail,
} from '../api-apps';
import { getNamespaces } from '../api';
import {
  confirm, toast, errorText, newButton, editorShell, panelWidth, section, textField, pathField, selectField, checkField,
  readForm, fieldError, focusField, rolePicker, isDatabaseResource, AdminError,
  type EditorHandle, type FieldProblem, type FormValues, type MenuItem,
} from '../crud';
import { liveGate } from './apps-live';
import { openInExplorer, createWebApp, updateWebApp, webAppNameFree, getPctAccesses, savePctAccess, deletePctAccess, type PctAccess, type NewWebAppBody } from '../api-web';
import { SIGN_IN, formFromApp, webAppBody, type WebAppFormValues } from '../webapp-body';
import { getSecurityGraph, getRoleList, getResourceList, type SecurityGraph, type RoleSummary, type ResourceSummary } from '../api-security';
import { mountSecurityBanner } from '../security-view';
import { anonOf, anonGets, getWebAuth, type WebAuth } from '../api-services';
import { getWebSessions, sessionExpiry, type WebSession } from '../api-ops';
import { anyoneNotice, stickyEditHead, previewHtml } from './services';
import {
  mono,
  noPermissionText,
  esc, cell, cellId, cellRef, pill, duration, num, when, skeleton, errorPanel, liveIndicator, uniformKeys, setChips,
  objectDetail, odMeta, odSection, odKv, type ScreenCtx, type OdFull,
} from '../ui';
import { getUser, linkTo, PRIVILEGED_ROLES } from '../api-security';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 30000;

const isRest = (a: WebAppSummary): boolean => a.DispatchClass !== '';
/** IsSystemApp is false for every app on 2026.2; Type carries "System" for the apps IRIS ships. */
const isSystem = (a: WebAppSummary): boolean => a.IsSystemApp || /\bSystem\b/i.test(a.Type);
/**
 * Applications IRIS ships: flagged System, or served by an InterSystems class
 * (%-prefixed dispatch class), or under IRIS's own paths. They can be switched
 * off with care but are never deleted from here.
 */
const isBuiltIn = (a: WebAppSummary): boolean =>
  isSystem(a) || a.DispatchClass.startsWith('%') || /^\/(csp\/(sys|broker|documatic)(\/|$)|isc\/|api\/(atelier|mgmnt|monitor|docdb|deepsee|iknow|iam|interop-editors)$)/i.test(a.Name);
/** The Admin API this portal runs on, or the web app serving this page. */
const isOwnApp = (a: WebAppSummary): boolean =>
  a.Name === '/api/admin' || (a.Name.length > 1 && (location.pathname === a.Name || location.pathname.startsWith(`${a.Name}/`)));
const isOpen = (a: { AuthenticationMethods: string[] }): boolean => a.AuthenticationMethods.some((m) => /unauthenticated/i.test(m));
const kindLabel = (a: WebAppSummary): string => (isRest(a) ? 'REST API' : 'Web pages');

/** Auth methods as plain text, comma-joined, in the Security section's words ("No sign-in" first). Display only. */
const methodWord = (m: string): string => (/^unauthenticated$/i.test(m) ? 'No sign-in' : m);
const authText = (methods: string[]): string => (methods.length
  ? [...methods].sort((x, y) => Number(!/^unauth/i.test(x)) - Number(!/^unauth/i.test(y))).map(methodWord).join(', ') : 'None enabled');
const OPEN_HINT = 'Anyone can connect: a request with no sign-in runs as UnknownUser';
/**
 * The page notice carries the alarm, so a row carries at most one amber dot:
 * enabled apps that allow No sign-in read "● No sign-in", the rest are plain
 * text. Shadow-DOM cell, so inline styles.
 */
function authCell(methods: string[], enabled: boolean): string {
  const text = authText(methods);
  const anyone = enabled && methods.some((m) => /unauthenticated/i.test(m));
  // Plain text: the banner and the "Anyone can connect" chip own the risk, so rows carry no dot.
  return enabled ? cell.text(text, anyone ? `${text}. ${OPEN_HINT}` : text) : cell.dim(text);
}
/** A code reference in a disabled row: mono 400 like cellRef, but tertiary with the rest of the row. */
const offRef = (v: unknown): string =>
  `<span style="display:block;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:400 12.5px/1.4 var(--ev-font-family-mono);color:var(--ev-color-text-tertiary)" title="${esc(v)}">${esc(v)}</span>`;
const refOf = (v: unknown, off: boolean): string => (off ? offRef(v) : cell.ref(v, undefined, String(v)));
const sessionsOf = (sessions: WebSession[], name: string): WebSession[] =>
  sessions.filter((s) => s.Application.replace(/\/+$/, '').toLowerCase() === name.replace(/\/+$/, '').toLowerCase());

const COLUMNS: DataGridColumn[] = [
  // No Status column: enabled is the normal state and carries no mark; a disabled row is all tertiary
  // text with one neutral "Disabled" pill after its path.
  { key: 'Name', label: 'Path', width: '300px', sortable: true, renderCell: (v, row) => (row.Enabled ? cellId(v, String(v))
    : `<span style="display:flex;align-items:center;gap:8px;min-width:0">${offRef(v)}<span style="flex:none">${pill('Disabled', 'neutral', 'IRIS refuses requests to this path')}</span></span>`) },
  { key: 'Namespace', label: 'Namespace', width: '110px', sortable: true, renderCell: (v, row) => refOf(v, !row.Enabled) },
  { key: 'Kind', label: 'Type', width: '100px', sortable: true, renderCell: (v, row) => (row.Enabled ? cell.text(v, row.DispatchClass ? `Dispatch class ${row.DispatchClass}` : 'CSP pages or static files') : cell.dim(String(v))) },
  { key: 'DispatchClass', label: 'Dispatch class', width: '220px', sortable: true, renderCell: (v, row) => (v ? refOf(v, !row.Enabled) : cell.dim('—')) },
  { key: 'Auth', label: 'Sign-in', width: '200px', sortable: true,
    renderCell: (_v, row) => authCell(String(row.Methods).split('|').filter(Boolean), Boolean(row.Enabled)) },
  { key: 'Resource', label: 'Resource required', width: '160px', sortable: true, renderCell: (v, row) => (v ? refOf(v, !row.Enabled) : cell.dim('—')) },
];
/** Columns that step aside while the peek is open, least informative first. */
const SECONDARY = ['Resource', 'DispatchClass', 'Kind'];
/** Columns hidden when every row has the same value. */
const UNIFORM_CANDIDATES = ['Namespace', 'Kind', 'Resource', 'DispatchClass'];

function toRow(a: WebAppSummary): DataGridRow {
  return {
    Name: a.Name, Namespace: a.Namespace, Kind: kindLabel(a), DispatchClass: a.DispatchClass,
    // Sort key puts open apps first; the cell renders from Methods.
    Auth: `${isOpen(a) ? 0 : 1}${a.AuthenticationMethods.join(',')}`, Methods: a.AuthenticationMethods.join('|'),
    Resource: a.Resource, Enabled: a.Enabled,
  };
}

type Scope = 'all' | 'rest' | 'system' | 'custom';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[]; sortColumn: string; sortDirection: string;
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');
const orDash = (s: string, none = '—'): string => (s ? mono(s) : `<span class="dim">${none}</span>`);
// Not ui.ts roleLink: a monospace link to the Roles page, not a chip.
const roleLink = (r: string): string => `<a class="link mono" href="#/security/roles" data-role="${esc(r)}">${esc(r)}</a>`;

/** Match roles → sentences: "Every user gets %DB_USER", "Holders of X also get Y". Roles link to Roles. */
function matchRoles(d: WebAppDetail): string {
  if (!d.MatchRoles.length) return '<span class="dim">None: callers keep only their own roles</span>';
  return d.MatchRoles.map((m) => {
    const targets = m.TargetRoles.map(roleLink).join(', ');
    return m.MatchRole
      ? `Holders of ${roleLink(m.MatchRole)} also get ${targets || '<span class="dim">nothing</span>'}`
      : `Every user gets ${targets}`;
  }).join('<br>');
}
const rolesGranted = (d: WebAppDetail): string[] => [...new Set(d.MatchRoles.flatMap((m) => m.TargetRoles))];

/** Path rules for a new application: starts with "/", no spaces or trailing "/". */
const PATH_OK = /^\/[A-Za-z0-9_.~%\-/]*[A-Za-z0-9_.~%-]$/;
const CLASS_NAME = /^%?[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

/** Security.Applications' display lists, which the web-app PUT converts back (…DisplayToLogical). */
const SERVE_FILES = ['No', 'Always', 'Always and cached', 'Use CSP security'] as const;
const USE_COOKIES = ['Never', 'AutoDetect', 'Always'] as const;
const COOKIE_SCOPE = ['None', 'Lax', 'Strict'] as const;
const pick = <T extends string>(list: readonly T[], v: string | undefined, fallback: T): T =>
  list.find((x) => x.toLowerCase() === String(v ?? '').toLowerCase()) ?? fallback;
/** "https://a.example, https://b.example" → the origins, trimmed, empties dropped. */
const originsOf = (v: unknown): string[] => String(v ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

/**
 * The settings the editor adds on top of webapp-body's form (as form values), from the
 * application's current record, or IRIS's own defaults (Security.Applications' initial values)
 * for a new one.
 */
interface MoreValues {
  TwoFactorEnabled: boolean; JWTAccessTokenTimeout: string; JWTRefreshTokenTimeout: string; CSRFToken: boolean;
  GroupById: string; LoginPage: string;
  ServeFiles: typeof SERVE_FILES[number]; ServeFilesTimeout: string; Recurse: boolean; CSPZENEnabled: boolean;
  UseCookies: typeof USE_COOKIES[number]; SessionScope: typeof COOKIE_SCOPE[number]; CorsAllowlist: string; CorsCredentialsAllowed: boolean;
}
function moreFromApp(d: WebAppDetail | null): MoreValues {
  return {
    TwoFactorEnabled: d?.TwoFactorEnabled ?? false,
    JWTAccessTokenTimeout: String(d?.JWTAccessTokenTimeout ?? 60),
    JWTRefreshTokenTimeout: String(d?.JWTRefreshTokenTimeout ?? 900),
    CSRFToken: d?.CSRFToken ?? true,
    GroupById: d?.GroupById ?? '',
    LoginPage: d?.LoginPage ?? '',
    ServeFiles: pick(SERVE_FILES, d?.ServeFiles, 'Always'),
    ServeFilesTimeout: String(d?.ServeFilesTimeout ?? 3600),
    Recurse: d?.Recurse ?? true,
    CSPZENEnabled: d?.CSPZENEnabled ?? true,
    UseCookies: pick(USE_COOKIES, d?.UseCookies, 'Always'),
    SessionScope: pick(COOKIE_SCOPE, d?.SessionScope, 'Strict'),
    CorsAllowlist: (d?.CorsAllowlist ?? []).join(', '),
    CorsCredentialsAllowed: d?.CorsCredentialsAllowed ?? true,
  };
}
/** The extra settings whose form value differs from where the form started, in the PUT's shape. */
function changedMore(v: FormValues, start: MoreValues): Partial<NewWebAppBody> {
  const out: Record<string, unknown> = {};
  const txt = (k: keyof MoreValues): string => String(v[k] ?? '').trim();
  for (const k of Object.keys(start) as Array<keyof MoreValues>) {
    const was = start[k];
    if (typeof was === 'boolean') { if (!!v[k] !== was) out[k] = !!v[k]; continue; }
    if (k === 'CorsAllowlist') {
      const now = originsOf(v[k]);
      if (now.join(',') !== originsOf(was).join(',')) out[k] = now;
    } else if (k === 'JWTAccessTokenTimeout' || k === 'JWTRefreshTokenTimeout' || k === 'ServeFilesTimeout') {
      if (txt(k) !== was && /^\d+$/.test(txt(k))) out[k] = Number(txt(k));
    } else if (txt(k) !== was) out[k] = txt(k);
  }
  return out as Partial<NewWebAppBody>;
}

export function webAppsScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="wa-list-view" id="wa-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="wa-search" size="sm" full-width placeholder="Filter by path, namespace, class or resource"></ev-search></div>
        <ev-segmented-button id="wa-scope" size="sm" aria-label="Show applications"></ev-segmented-button>
        <button type="button" class="chip-toggle" id="wa-open" aria-pressed="false" hidden></button>
      </div>
      <ev-detail-panel id="wa-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="wa-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="wa-detail" aria-label="Web application details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="wa-foot"></p>
    </div>
    <div id="wa-full" hidden></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const scopeEl = $('#wa-scope');
  const panel = $<HTMLElement & { open: boolean; detailWidth: number }>('#wa-panel');
  const wrap = $('#wa-grid-wrap');
  const detailEl = $('#wa-detail');
  const fullEl = $('#wa-full');
  // The list's banner ("N web applications let anyone connect") belongs to the list: a full view shows
  // only its own application's notice (as Users does).
  const listView = $('#wa-list-view');
  const bannerSync = new MutationObserver(() => { ctx.banners.hidden = listView.hidden; });
  bannerSync.observe(listView, { attributes: true, attributeFilter: ['hidden'] });
  ctx.onLeave(() => { bannerSync.disconnect(); ctx.banners.hidden = false; });
  let grid: GridEl | null = null;
  let all: WebAppSummary[] = [];
  let sessions: WebSession[] = [];
  let query = '';
  let scope: Scope = 'all';
  let openOnly = false;
  let graph: SecurityGraph | null = null;
  /** Does an unauthenticated caller get full access? From the security graph, else UnknownUser's own roles. */
  const anonFull = (): boolean => anonOf(graph)?.full ?? (unknownRoles?.includes('%All') ?? false);
  let uniform = new Set<string>();
  /** UnknownUser's roles: what an unauthenticated caller actually gets. null = not known. */
  let unknownRoles: string[] | null = null;
  /** Security privilege (%Admin_Secure) from /api/admin/info; null until known. */
  let canSecure: boolean | null = null;
  let busy = false;
  const gate = liveGate(panel, ctx.onLeave);
  const NO_SECURE = noPermissionText('%Admin_Secure', 'security administration');
  const details = new Map<string, WebAppDetail>();

  // The New / Edit form, while it's open in the drawer.
  let editor: EditorHandle | null = null;
  let formEvents: AbortController | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEdit = (): void => {
    editor?.close(); editor = null; formEvents?.abort(); formEvents = null; restoreWidth?.(); restoreWidth = null; ctx.beforeLeave(null);
  };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => leaveEdit());

  const inScope = (a: WebAppSummary, s: Scope): boolean =>
    s === 'all' || (s === 'rest' ? isRest(a) : s === 'system' ? isSystem(a) : !isSystem(a));
  const visible = (): WebAppSummary[] => all.filter((a) => {
    if (!inScope(a, scope)) return false;
    if (openOnly && !(a.Enabled && isOpen(a))) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [a.Name, a.Namespace, a.DispatchClass, a.Resource, kindLabel(a), ...a.AuthenticationMethods.map(methodWord)].some((f) => f?.toLowerCase().includes(q));
  });

  const renderToolbar = (): void => {
    const n = (s: Scope): number => all.filter((a) => inScope(a, s)).length;
    setChips(scopeEl, all.length, [
      { value: 'all', label: `All ${n('all')}` },
      { value: 'rest', label: `REST APIs ${n('rest')}` },
      { value: 'system', label: `System ${n('system')}` },
      { value: 'custom', label: `Custom ${n('custom')}` },
    ], { active: scope, search: $('#wa-search'), query });
    const open = all.filter((a) => a.Enabled && isOpen(a)).length;
    const btn = $<HTMLButtonElement>('#wa-open');
    if (!open) openOnly = false;
    // A risk chip that filters to them (the banner's "Show them" turns it on too); hidden while there are none.
    btn.hidden = !open;
    btn.setAttribute('aria-pressed', String(openOnly));
    btn.title = openOnly ? 'Showing only applications anyone can connect to; click to show every application' : 'Show only the applications anyone can connect to';
    btn.innerHTML = `${pill(`Anyone can connect ${open}`, anonFull() ? 'danger' : 'warning')}${openOnly ? '<ev-icon name="x" size="xs" aria-hidden="true"></ev-icon>' : ''}`;
    renderBanner(open);
  };

  /** The Security section's one banner: a local headline for apps anyone can connect to, plus the shared Review. */
  const renderBanner = (open: number): void => {
    const host = ctx.banners;
    if (!host) return;
    // Drawn whatever is showing: while a full view is open the banners are hidden (bannerSync above).
    const full = anonFull();
    mountSecurityBanner(host, graph, open ? {
      tone: full ? 'danger' : 'warning',
      headline: `${open} web application${open === 1 ? ' lets' : 's let'} anyone connect${full ? ', with full access' : ''}`,
      detail: full ? undefined : `No sign-in is allowed there, so callers get ${anonGets(anonOf(graph))}.`,
      showThem: { label: 'Show them', run: () => { openOnly = true; renderToolbar(); renderGrid(); } },
    } : null, { review: false });
  };

  const renderFoot = (): void => {
    const enabled = all.filter((a) => a.Enabled).length;
    const rest = all.filter(isRest).length;
    $('#wa-foot').innerHTML =
      // "Anyone can connect" is said by the banner and its chip; the footer doesn't repeat it.
      `<b>${all.length}</b> applications<span class="meta-sep">·</span><b>${enabled}</b> enabled<span class="meta-sep">·</span><b>${rest}</b> REST APIs`;
  };

  const applyColumns = (): void => {
    for (const c of COLUMNS) grid?.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };

  /** What an unauthenticated caller can do here, from UnknownUser's actual roles. */
  const unknownConsequence = (a: WebAppSummary): string => {
    const needs = a.Resource ? ` The app requires ${a.Resource}, so the caller also needs Use on it.` : '';
    if (unknownRoles === null) return `The caller gets whatever roles UnknownUser holds.${needs}`;
    if (unknownRoles.includes('%All')) return `UnknownUser holds %All, so any caller has full access to this ${isRest(a) ? 'API' : 'application'}.`;
    if (unknownRoles.length === 0) return `UnknownUser holds no roles, so the caller gets only public privileges.${needs}`;
    const power = unknownRoles.filter((r) => PRIVILEGED_ROLES.includes(r));
    return `UnknownUser holds ${unknownRoles.join(', ')}, so any caller gets ${unknownRoles.length === 1 ? 'that role’s' : 'those roles’'} privileges${power.length ? ', which include administrator-level access' : ''}.${needs}`;
  };
  /** This object's own risk as it stands now: the shared notice, the UnknownUser explanation in its tooltip. */
  const openWarn = (a: WebAppSummary): string => {
    if (!(isOpen(a) && a.Enabled)) return '';
    const why = `${unknownConsequence(a)}${a.Name === '/api/admin' ? ' This is the SysAdmin API this portal is built on.' : ''}`;
    return anyoneNotice({ full: anonFull(), roles: anonOf(graph)?.roles ?? unknownRoles, title: why });
  };

  // ─── Detail content (peek sections and full-view cards) ───
  const detailOf = async (name: string): Promise<WebAppDetail> => {
    const d = details.get(name) ?? await getWebApp(name);
    details.set(name, d);
    return d;
  };
  const resourceLink = (r: string): string => (r ? `<a class="link mono" href="#/security/resources" data-resource="${esc(r)}">${esc(r)}</a>` : '<span class="dim">—</span>');
  /*
   * The detail's groups are the editor's sections, with the same names in the same order:
   * What it serves, Access, Session and cookies. Every row is a setting Edit can change,
   * except "For role holders", which Edit keeps as it is (its title says so).
   */
  const timeoutText = (d: WebAppDetail): string => (d.Timeout > 0 ? duration(d.Timeout) : 'Never');
  const accessRows = (a: WebAppSummary, d: WebAppDetail, full = false): Array<[string, string] | [string, string, string]> => {
    const rules = d.MatchRoles.filter((m) => m.MatchRole);
    return [
      // The full view's notice owns the "No sign-in" risk; the row states the setting in the same words as the editor.
      ['Allowed sign-in', esc(authText(a.AuthenticationMethods))],
      ['Two-factor', d.TwoFactorEnabled ? 'Required' : 'Not required'],
      ['JWT bearer tokens', !isRest(a) ? '<span class="dim">Only for REST APIs</span>'
        : d.JWTAuthEnabled ? `Accepted · access ${duration(d.JWTAccessTokenTimeout)}, refresh ${duration(d.JWTRefreshTokenTimeout)}` : 'Not accepted'],
      ['CSRF token', d.CSRFToken ? 'Checked' : 'Not checked'],
      ['Sign-in group', orDash(d.GroupById)],
      ['Login page', orDash(d.LoginPage, 'Default')],
      // The full view's strip names the resource.
      ...(full ? [] : [['Resource required', resourceLink(d.Resource)] as [string, string]]),
      ...(full ? [['For role holders', rules.length ? matchRoles({ ...d, MatchRoles: rules }) : '<span class="dim">No extra roles</span>',
        'Extra roles for holders of a role. Edit keeps these rules as they are.'] as [string, string, string]] : []),
    ];
  };
  /** The namespace is in the subtitle; in the full view the class or path is in the strip, so those rows go there. */
  const servesRows = (a: WebAppSummary, d: WebAppDetail, full = false): Array<[string, string] | [string, string, string]> => {
    if (isRest(a)) {
      return [
        ...(full ? [] : [['Dispatch class', mono(d.DispatchClass)] as [string, string]]),
        ['Physical path', orDash(d.Path)],
        ['Files and pages', '<span class="dim">Not served</span>', 'The dispatch class answers every request'],
      ];
    }
    // "Always and cached" reads as "Always · cached 1h": the word "cached" once.
    const cached = /\s+and cached$/i.test(d.ServeFiles);
    return [
      ...(full ? [] : [['Physical path', orDash(d.Path)] as [string, string]]),
      ['Serve static files', `${esc(d.ServeFiles.replace(/\s+and cached$/i, ''))}${cached ? ` · cached${d.ServeFilesTimeout ? ` ${duration(d.ServeFilesTimeout)}` : ''}` : ''}`],
      ['Include subfolders', yesNo(d.Recurse)],
      ['CSP / Zen pages', d.CSPZENEnabled ? 'Allowed' : 'Not allowed'],
    ];
  };
  const sessionRows = (d: WebAppDetail, full = false): Array<[string, string]> => [
    // The full view's strip carries the timeout.
    ...(full ? [] : [['Session timeout', d.Timeout > 0 ? duration(d.Timeout) : '<span class="dim">Never</span>'] as [string, string]]),
    ['Use cookies', esc(d.UseCookies)],
    ['Cookie path', orDash(d.CookiePath)],
    ['Session cookie scope', esc(d.SessionScope || '—')],
    ['Cross-origin (CORS)', d.CorsAllowlist.length
      ? `${d.CorsAllowlist.map((o) => mono(o)).join(', ')}${d.CorsCredentialsAllowed ? ' · with credentials' : ''}` : '<span class="dim">Not configured</span>'],
  ];
  const liveBody = (a: WebAppSummary): string => {
    const list = sessionsOf(sessions, a.Name).sort((x, y) => sessionExpiry(y).getTime() - sessionExpiry(x).getTime());
    if (!list.length) return '<p class="wa-empty">No one is connected right now.</p>';
    const byUser = new Map<string, number>();
    for (const s of list) byUser.set(s.Username || '—', (byUser.get(s.Username || '—') ?? 0) + 1);
    return `${odKv([...byUser].slice(0, 8).map(([u, n]): [string, string] => [u, `${num(n)} session${n === 1 ? '' : 's'}`]))}
      ${odKv([['Latest expiry if idle', esc(when(sessionExpiry(list[0])))]])}
      <p class="wa-card-link"><a class="link" href="#/operations/sessions" data-go-sessions>Open in Web sessions ›</a></p>`;
  };

  // ─── Class allow-list: which % classes the application may call through CSP ───
  const pcts = new Map<string, PctAccess[]>();
  const pctOf = async (name: string): Promise<PctAccess[] | null> => {
    if (!pcts.has(name)) { try { pcts.set(name, await getPctAccesses(name)); } catch { return null; } }
    return pcts.get(name) ?? null;
  };
  /**
   * The list as facts: each class (or a whole package, ending in *) in mono,
   * Allowed or Denied, and who set it. Entries IRIS set come with the
   * application and can't be removed; the full view (`edit`) offers Remove on
   * the others. Adding is the card header's "Add class" and its dialog.
   */
  const pctBody = (a: WebAppSummary, list: PctAccess[] | null, edit = false): string => {
    if (!list) return '<p class="wa-empty">Couldn’t read the class allow-list.</p>';
    if (!list.length) return '<p class="wa-empty">None added. Pages can call your own classes, and the % classes IRIS allows every application.</p>';
    const canRemove = edit && canSecure !== false;
    const rows = list.map((x) => {
      const pkg = x.AllowType === 'AllowPrefix';
      const what = cellRef(`${x.Class}${pkg ? '*' : ''}`, undefined, pkg ? `Every class in ${x.Class}` : x.Class);
      const state = x.AllowAccess ? 'Allowed' : '<span class="dim">Denied</span>';
      const tail = x.System ? '<span class="dim" title="It comes with the application">Set by IRIS</span>'
        : canRemove ? `<button type="button" class="link link--inline" data-pct-remove data-app="${esc(a.Name)}" data-type="${esc(x.AllowType)}" data-class="${esc(x.Class)}" aria-label="Remove ${esc(x.Class)}" title="Remove it from the list">Remove</button>` : '';
      return `<div class="od-kv-row wa-pct-row"><dt>${what}</dt><dd>${state}${tail}</dd></div>`;
    }).join('');
    return `<dl class="od-kv">${rows}</dl>`;
  };

  /**
   * The allow-list only matters where IRIS serves CSP or Zen pages. A REST API
   * (or an app with pages off) shows it only when IRIS already lists something.
   */
  const pctEditable = (a: WebAppSummary, d: WebAppDetail): boolean => !isRest(a) && d.CSPZENEnabled;
  const pctApplies = (a: WebAppSummary, d: WebAppDetail, list: PctAccess[] | null): boolean => pctEditable(a, d) || !!list?.length;
  /** Rows two to a line: label and value sit together, not at opposite ends of a wide card. */
  const kvPairs = (rows: Array<[string, string] | [string, string, string]>): string => odKv(rows).replace('class="od-kv"', 'class="od-kv wa-kv2"');

  const peekBody = async (a: WebAppSummary): Promise<string> => {
    let d: WebAppDetail;
    try { d = await detailOf(a.Name); } catch (err) { return errorPanel(err); }
    const pct = await pctOf(a.Name);
    return `${openWarn(a)}
      ${odSection('What it serves', odKv(servesRows(a, d)))}
      ${odSection('Access', odKv(accessRows(a, d)))}
      ${odSection('Roles granted', `<div class="wa-roles">${matchRoles(d)}</div>`)}
      ${odSection('Session and cookies', odKv(sessionRows(d)))}
      ${pctApplies(a, d, pct) ? odSection('Class allow-list', pctBody(a, pct)) : ''}`;
  };
  /**
   * Every application gets the same cards in the same places, so paging with ‹ › never rearranges
   * the page: the settings on the left (in the editor's order), what's happening on the right, each
   * with a calm empty state when there's nothing to list. CSS stretches the last card of each column
   * so both end on the same line.
   */
  const fullView = async (a: WebAppSummary): Promise<OdFull> => {
    const d = await detailOf(a.Name);
    const pct = await pctOf(a.Name);
    const roles = rolesGranted(d);
    const addBtn = canSecure !== false && pct && pctEditable(a, d)
      ? `<button type="button" class="btn btn--sm" data-pct-add data-app="${esc(a.Name)}"><ev-icon name="plus" size="xs"></ev-icon>Add class</button>` : '';
    const lead = d.Description ? `<p class="wa-lead">${esc(d.Description)}</p>` : '';
    return {
      // The state, namespace and kind are in the subtitle; the strip holds what no card repeats.
      strip: [
        { label: 'Serves', value: isRest(a) ? d.DispatchClass : d.Path || 'CSP pages', title: isRest(a) ? d.DispatchClass : d.Path },
        { label: 'Roles granted', value: roles.length ? roles.join(', ') : 'None', title: roles.join(', ') },
        { label: 'Resource required', value: d.Resource || 'None', title: d.Resource ? `Callers need Use on ${d.Resource}` : 'Anyone who can sign in' },
        { label: 'Session timeout', value: timeoutText(d) },
      ],
      notice: openWarn(a),
      // The description is the first card's lead line, never a label row. Wide cards list rows two to a line.
      main: [
        { title: 'What it serves', body: `${lead}${kvPairs(servesRows(a, d, true))}` },
        { title: 'Access', body: kvPairs(accessRows(a, d, true)) },
        { title: 'Session and cookies', body: kvPairs(sessionRows(d, true)) },
      ],
      side: [
        { title: 'Who’s connected', body: liveBody(a) },
        { title: 'Class allow-list', head: addBtn, body: pctApplies(a, d, pct) ? pctBody(a, pct, true)
          : `<p class="wa-empty">Not used: ${isRest(a) ? 'a REST API serves no CSP pages' : 'CSP / Zen pages aren’t allowed here'}.</p>` },
      ],
    };
  };

  const menuFor = (a: WebAppSummary): MenuItem[] => {
    const np = canSecure === false ? NO_SECURE : null;
    // The portal can't switch its own API back on, so that one is blocked outright.
    const ownBlock = a.Enabled && isOwnApp(a);
    return [
      { label: a.Enabled ? 'Disable…' : 'Enable', icon: a.Enabled ? 'pause' : 'play', disabled: !!np || ownBlock,
        reason: np ?? `This portal runs on ${a.Name}, so it can’t be switched off from here.`, onSelect: () => void act(() => doToggle(a)) },
      ...(isRest(a) ? [{ label: 'View API spec', icon: 'globe', onSelect: () => openInExplorer(ctx.navigate, a.Name) }] : []),
      { label: 'Copy path', icon: 'copy', onSelect: () => { void navigator.clipboard.writeText(a.Name).then(() => toast(`Copied ${a.Name}.`, 'info')); } },
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!np || isBuiltIn(a) || isOwnApp(a) || a.NamespaceDefault,
        reason: np ?? (isOwnApp(a) ? 'This portal runs on it, so it can’t be deleted from here.'
          : isBuiltIn(a) ? 'IRIS’s own applications can’t be deleted. Disable it instead.'
          : `It’s the default application for ${a.Namespace}. Make another one the default first.`),
        onSelect: () => void act(() => doDelete(a)) },
    ];
  };

  const od = objectDetail<WebAppSummary>(ctx, {
    collection: 'Web applications', noun: 'web application',
    panel, detail: detailEl, list: $('#wa-list-view'), full: $('#wa-full'),
    key: (a) => a.Name,
    find: (k) => all.find((a) => a.Name === k),
    order: () => {
      const rows = visible().map(toRow);
      const key = grid?.sortColumn || 'Name';
      const dir = (grid ? grid.sortDirection : 'asc') === 'desc' ? -1 : 1;
      rows.sort((x, y) => String(x[key] ?? '').localeCompare(String(y[key] ?? '')) * dir);
      return rows.map((r) => String(r.Name));
    },
    name: (a) => a.Name, mono: true,
    meta: (a) => odMeta(a.Enabled ? { label: 'Enabled', tone: 'success' } : { label: 'Disabled', tone: 'neutral', title: 'IRIS refuses requests to this path' },
      [a.NamespaceDefault ? `Default app for ${a.Namespace}` : a.Namespace, kindLabel(a), isSystem(a) ? 'System' : '']),
    description: (a) => details.get(a.Name)?.Description ?? '',
    primary: (a) => ({
      label: 'Edit', icon: 'edit-2', run: () => void openEditor(a.Name),
      blocked: canSecure === false ? NO_SECURE : isOwnApp(a) ? 'This portal runs on this application; changing it here could lock you out of the portal.' : null,
    }),
    menu: menuFor,
    peek: (a) => peekBody(a),
    loadFull: (a) => fullView(a),
    onSelect: (k) => grid?.select(k ? [k] : []),
    onPeek: () => { applyColumns(); renderBanner(all.filter((a) => a.Enabled && isOpen(a)).length); },
    canLeave: mayLeave,
  });

  // Links inside the peek and the full view: roles, resources, users and sessions go to their screens.
  ctx.body.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (!t.closest('#wa-detail, #wa-full')) return;
    if ((e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey || (e as MouseEvent).shiftKey) return;
    const role = t.closest<HTMLElement>('[data-role]');
    const res = t.closest<HTMLElement>('[data-resource]');
    const user = t.closest<HTMLElement>('[data-user]');
    const sess = t.closest<HTMLElement>('[data-go-sessions]');
    if (role) { e.preventDefault(); linkTo(ctx.navigate, 'security/roles', role.dataset.role ?? ''); }
    else if (res) { e.preventDefault(); linkTo(ctx.navigate, 'security/resources', res.dataset.resource ?? ''); }
    else if (user) { e.preventDefault(); linkTo(ctx.navigate, 'security/users', user.dataset.user ?? ''); }
    else if (sess) { e.preventDefault(); ctx.navigate('operations/sessions'); }
    const rm = t.closest<HTMLElement>('[data-pct-remove]');
    const add = t.closest<HTMLElement>('[data-pct-add]');
    if (rm) void act(() => removePct(rm.dataset.app ?? '', rm.dataset.type ?? '', rm.dataset.class ?? ''));
    else if (add && !busy) pctDialog(add.dataset.app ?? '');
  });

  /** % classes only (IRIS refuses others): a full class name, or a package for the whole-package case. */
  const PCT_NAME = /^%[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*\.?$/;
  /** Add a class or a whole package to the allow-list: a small form in a dialog. */
  const pctDialog = (app: string): void => {
    const dlg = document.createElement('ev-dialog') as HTMLElement & { open: boolean; close(): void };
    dlg.setAttribute('heading', `Allow a class in ${app}`);
    dlg.innerHTML = `<div slot="body" class="crud-dialog-body">
        ${textField('Class', 'Class or package', '', { required: true, mono: true, placeholder: 'e.g. %ZEN.Component.page', hint: 'Class names must start with %. Your own classes are always allowed, so they never need adding.' })}
        ${checkField('Prefix', 'Whole package', false, { hint: 'Every class whose name starts with this.' })}
      </div>
      <div slot="footer" class="crud-dialog-foot"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn--primary" data-save>Add class</button></div>`;
    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => dlg.close());
    const save = dlg.querySelector('[data-save]') as HTMLButtonElement;
    const fail = (msg: string): void => { fieldError(dlg, 'Class', msg); focusField(dlg, 'Class'); };
    const submit = async (): Promise<void> => {
      const v = readForm(dlg);
      const cls = String(v.Class ?? '').trim();
      const prefix = !!v.Prefix;
      fieldError(dlg, 'Class', null);
      if (!cls) return fail('Enter a class or package, starting with %.');
      if (!PCT_NAME.test(cls)) return fail('Only % classes can be allowed here, e.g. %ZEN.Component.page.');
      if ((pcts.get(app) ?? []).some((x) => x.Class.toLowerCase() === cls.toLowerCase() && (x.AllowType === 'AllowPrefix') === prefix)) return fail('It’s already on the list.');
      save.disabled = true;
      try {
        await savePctAccess(app, prefix ? 'AllowPrefix' : 'AllowClass', cls, true);
      } catch (err) {
        save.disabled = false;
        return fail(errorText(err));
      }
      dlg.close();
      pcts.delete(app);
      toast(`${app} may now call ${prefix ? `every class in ${cls}` : cls}.`);
      od.refresh();
    };
    save.addEventListener('click', () => void submit());
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !save.disabled) { e.preventDefault(); void submit(); } });
    dlg.addEventListener('ev-dialog-close', () => setTimeout(() => dlg.remove(), 0), { once: true });
    document.body.appendChild(dlg);
    dlg.open = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { if (dlg.open) focusField(dlg, 'Class'); }));
  };
  const removePct = async (app: string, type: string, cls: string): Promise<void> => {
    const ok = await confirm({
      title: `Remove ${cls} from ${app}’s allow-list?`,
      body: `<p>Pages in <span class="mono">${esc(app)}</span> can no longer call ${type === 'AllowPrefix' ? `classes in <span class="mono">${esc(cls)}</span>` : `<span class="mono">${esc(cls)}</span>`} unless IRIS allows it for every application.</p>`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    await deletePctAccess(app, type, cls);
    pcts.delete(app);
    toast(`${cls} removed from ${app}’s allow-list.`);
    od.refresh();
  };

  /** One action at a time; errors become a toast and the list reloads. */
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (err) {
      toast(err instanceof AdminError && err.status === 404 ? 'That application no longer exists.' : errorText(err), 'danger');
      await load(true);
    } finally { busy = false; }
  };

  const doToggle = async (a: WebAppSummary): Promise<void> => {
    if (a.Enabled && isOwnApp(a)) { toast(`This portal runs on ${a.Name}, so it can’t be switched off from here.`, 'warning'); return; }
    if (a.Enabled) {
      const builtIn = isBuiltIn(a);
      const ok = await confirm({
        title: `Disable ${a.Name}?`,
        body: `<p>IRIS refuses every request to <span class="mono">${esc(a.Name)}</span> until it’s enabled again. Its settings are kept.</p>${builtIn
          ? '<p><strong>This is one of IRIS’s own applications.</strong> Tools that rely on it stop working until it’s enabled again.</p>' : ''}`,
        confirmLabel: 'Disable',
        danger: builtIn,
      });
      if (!ok) return;
    }
    await setWebAppEnabled(a.Name, !a.Enabled);
    details.delete(a.Name);
    toast(a.Enabled ? `${a.Name} is now disabled. IRIS refuses requests to it.` : `${a.Name} is now enabled.`);
    await load(true);
  };

  const doDelete = async (a: WebAppSummary): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${a.Name}?`,
      body: `<p>The application definition is removed for good: its authentication, roles and other settings go with it. Files and classes it served are not touched.</p><p>Type the path to confirm.</p>`,
      confirmLabel: 'Delete application',
      danger: true,
      typeToConfirm: a.Name,
      alternative: a.Enabled ? { label: 'Disable instead', onSelect: () => void act(() => doToggle(a)) } : undefined,
    });
    if (!ok) return;
    await deleteWebApp(a.Name);
    details.delete(a.Name);
    toast(`${a.Name} deleted.`);
    if (od.mode() === 'full') await od.closeFull();
    await od.select(null);
    await load(true);
  };

  const renderGrid = (): void => {
    const rows = visible().map(toRow);
    const creating = !grid;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => void od.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name)));
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    // Uniformity is judged on every application, so filtering never makes columns jump.
    const next = uniformKeys(all.map(toRow), UNIFORM_CANDIDATES) as Set<string>;
    if (creating || [...next].join() !== [...uniform].join()) { uniform = next; applyColumns(); }
    const sel = od.selected();
    grid.select(sel && !editor ? [sel] : []);
    wrap.querySelector('.grid-empty')?.remove();
    if (rows.length === 0) {
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">${query ? `No applications match “${esc(query)}”.` : openOnly ? 'No application in this group lets anyone connect.' : 'No applications in this group.'}</div>`);
    }
  };

  // ─── New / Edit web application: one form ───
  // From the list it opens in the drawer; from the full view (#/web/apps/<path>) it takes the page
  // body's place, like Processes' "Send a message", so the address, the ‹ › pager and the page stay,
  // and Cancel or Save bring the full view back.
  const openEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    const inFull = od.mode() === 'full' && !!name;
    if (od.mode() === 'full' && !inFull) await od.closeFull();
    const host = inFull ? fullEl : detailEl;
    const app = name ? all.find((a) => a.Name === name) : undefined;
    if (name && !app) return;
    let namespaces: string[]; let roles: RoleSummary[]; let resources: ResourceSummary[]; let auth: WebAuth | null; let d: WebAppDetail | null = null;
    try {
      [namespaces, roles, resources, auth, d] = await Promise.all([
        getNamespaces().then((l) => l.map((n) => n.Name)),
        getRoleList(), getResourceList(), getWebAuth().catch(() => null),
        name ? getWebApp(name) : Promise.resolve(null), // Edit always starts from a fresh read
      ]);
    } catch (err) { toast(errorText(err), 'danger'); return; }
    // The user may have paged or gone back to the list while the reads were out.
    if (inFull && (od.mode() !== 'full' || od.selected() !== name)) return;
    if (d && name) details.set(name, d);
    const nsDefault = namespaces.includes('USER') ? 'USER' : namespaces[0] ?? '';
    const init = formFromApp(name ?? '', d, { namespace: nsDefault });
    const more = moreFromApp(d);
    const base = d ? { AutheEnabled: d.AutheEnabled, MatchRoles: d.MatchRoles, Timeout: d.Timeout, IsNameSpaceDefault: d.IsNameSpaceDefault } : null;
    if (!inFull) {
      if (!name) { await od.select(null); grid?.select([]); }
      restoreWidth ??= panelWidth(panel, 560);
      if (!panel.open) { panel.open = true; applyColumns(); }
    }
    const resNames = resources.filter((r) => !isDatabaseResource(r)).map((r) => r.Name);
    if (init.Resource && !resNames.includes(String(init.Resource))) resNames.push(String(init.Resource));
    const resOptions = [{ value: '', label: 'None: anyone who can sign in' }, ...resNames.sort((x, y) => x.localeCompare(y)).map((n) => ({ value: n, label: n }))];
    const nsOptions = [...new Set([...namespaces, ...(init.NameSpace ? [String(init.NameSpace)] : [])])].map((n) => ({ value: n, label: n }));
    const methodBox = (m: typeof SIGN_IN[number]): string => {
      // A method switched off for the whole instance can't be turned on here; one the app already has stays as it is.
      const off = auth ? auth[m.system as keyof WebAuth] === false : false;
      const on = !!init[m.key];
      return checkField(m.key, m.label, on, { disabled: off && !on, hint: off ? 'Turned off for the whole instance (Security › Services › web sign-in).' : m.hint });
    };
    // Two-factor needs a second factor turned on for the whole instance; an app that already requires it keeps the box.
    const twoOff = auth ? !auth.AutheTwoFactorPW && !auth.AutheTwoFactorSMS : false;
    const opt = (values: readonly string[], labels: Record<string, string> = {}): Array<{ value: string; label: string }> => values.map((x) => ({ value: x, label: labels[x] ?? x }));
    const kept = d ? d.MatchRoles.filter((m) => m.MatchRole).length : 0;
    editor = editorShell(host, {
      // The full view's title already names the application.
      title: inFull ? 'Edit settings' : name ? `Edit ${esc(name)}` : 'New web application',
      name: name ?? 'the new web application',
      submitLabel: name ? 'Save changes' : 'Create application',
      // Sections carry the detail's card names, in the same order: What it serves, Access, Session and cookies.
      sections:
        // The risk as it stands now is the notice's (the same one the view shows); "What changes" speaks only of changes.
        (app ? openWarn(app) : '') +
        (app && isBuiltIn(app) ? `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>This is one of IRIS’s own applications. Tools that rely on it can stop working if its settings change.</div></div>` : '') +
        section('General',
          textField('Path', 'Path', String(init.Path), { required: true, mono: true, disabled: !!name, placeholder: '/csp/myapp', hint: name ? 'The path can’t be changed.' : 'The URL path it answers on, starting with /.' }) +
          selectField('NameSpace', 'Namespace', nsOptions, String(init.NameSpace), { required: true, searchable: nsOptions.length > 8, hint: 'Where its code and data live.' }) +
          textField('Description', 'Description', String(init.Description), { maxlength: 256 }) +
          checkField('Enabled', 'Enabled', !!init.Enabled, { toggle: true, disabled: !!app && isOwnApp(app), hint: 'While it’s off, IRIS refuses every request to the path.' })) +
        section('What it serves',
          selectField('Kind', 'It serves', [{ value: 'rest', label: 'A REST API (dispatch class)' }, { value: 'csp', label: 'Web pages and files (CSP)' }], String(init.Kind)) +
          `<div data-wa-kind="rest">${textField('DispatchClass', 'Dispatch class', String(init.DispatchClass), { mono: true, placeholder: 'e.g. MyApp.REST.Dispatch', hint: 'A subclass of %CSP.REST in the namespace above.' })}</div>
           <div data-wa-kind="csp" hidden class="wa-form-group">${pathField('FilePath', 'Physical path', String(init.FilePath), { mode: 'dir', title: 'Choose the folder its files are served from', placeholder: 'e.g. /opt/myapp/web/', hint: 'Optional. The folder on the server its static files are served from.' })}
             <div class="crud-row">${selectField('ServeFiles', 'Serve static files', opt(SERVE_FILES, { 'Use CSP security': 'Only to signed-in callers' }), more.ServeFiles)}<div data-wa-cached>${
               textField('ServeFilesTimeout', 'Browser cache (seconds)', more.ServeFilesTimeout, { width: 'sm', hint: 'How long a browser keeps them.' })}</div></div>
             ${checkField('Recurse', 'Include subfolders', more.Recurse, { hint: 'Serve files and pages from folders under the physical path too.' })}
             ${checkField('CSPZENEnabled', 'Allow CSP / Zen pages', more.CSPZENEnabled, { hint: 'Off: only static files are served.' })}</div>`) +
        section('Access',
          `<p class="crud-section-hint">Allowed sign-in</p>${SIGN_IN.map(methodBox).join('')}` +
          checkField('TwoFactorEnabled', 'Require two-factor', more.TwoFactorEnabled, { disabled: twoOff && !more.TwoFactorEnabled,
            hint: twoOff ? 'Turned off for the whole instance (Security › System-wide settings).' : 'Callers confirm a code after their password.' }) +
          `<div data-wa-kind="rest" class="wa-form-group">${checkField('Jwt', 'Accept JWT bearer tokens', !!init.Jwt, { hint: 'Clients send a token from this API’s /login instead of a password on every call.' })}
             <div class="crud-row" data-wa-jwt>${textField('JWTAccessTokenTimeout', 'Access token lasts (seconds)', more.JWTAccessTokenTimeout, { width: 'sm' })}${
               textField('JWTRefreshTokenTimeout', 'Refresh token lasts (seconds)', more.JWTRefreshTokenTimeout, { width: 'sm' })}</div></div>` +
          checkField('CSRFToken', 'Check a CSRF token', more.CSRFToken, { hint: 'Pages must send back the token IRIS gave them, so other sites can’t post on a caller’s behalf.' }) +
          selectField('Resource', 'Resource required', resOptions, String(init.Resource), { searchable: true, hint: 'Callers need Use on it, on top of signing in.' }) +
          '<div id="wa-roles"></div>' +
          (kept ? `<p class="crud-section-hint">${num(kept)} rule${kept === 1 ? '' : 's'} for holders of a role ${kept === 1 ? 'is' : 'are'} kept as ${kept === 1 ? 'it is' : 'they are'}.</p>` : '') +
          `<div class="crud-row">${textField('GroupById', 'Sign-in group', more.GroupById, { mono: true, placeholder: 'None', hint: 'Apps in one group share a sign-in.' })}${
            textField('LoginPage', 'Login page', more.LoginPage, { mono: true, placeholder: 'Default', hint: 'A page of your own, or empty.' })}</div>`,
          { hint: 'Who can use it, and what they get while they do.' }) +
        section('Session and cookies',
          `<div class="crud-row">${textField('Timeout', 'Session timeout (minutes)', String(init.Timeout), { width: 'sm', hint: 'Idle time before a session ends.' })}${
            textField('CookiePath', 'Cookie path', String(init.CookiePath), { width: 'md', mono: true, placeholder: 'Same as the path', hint: 'Leave empty to use the path.' })}</div>
           <div class="crud-row">${selectField('UseCookies', 'Use cookies', opt(USE_COOKIES, { AutoDetect: 'When the browser accepts them' }), more.UseCookies)}${
             selectField('SessionScope', 'Session cookie scope', opt(COOKIE_SCOPE, { None: 'None (sent on every request)' }), more.SessionScope)}</div>` +
          textField('CorsAllowlist', 'Cross-origin (CORS) origins', more.CorsAllowlist, { mono: true, placeholder: 'e.g. https://app.example.com', hint: 'Sites allowed to call it from a browser, separated by commas. Empty: none.' }) +
          `<div data-wa-cors>${checkField('CorsCredentialsAllowed', 'Allow credentials from those sites', more.CorsCredentialsAllowed, { hint: 'Their requests may carry cookies and sign-in headers.' })}</div>`) +
        section(name ? 'What changes' : 'What happens', '<div id="wa-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => problems(readForm(host)),
      onSubmit: async (v) => {
        const path = name ?? String(v.Path ?? '').trim();
        if (!name && !(await webAppNameFree(path))) {
          fieldError(host, 'Path', 'That path is taken by another application');
          focusField(host, 'Path');
          throw new Error('Choose another path: an application with this name already exists.');
        }
        // Only the extra settings that changed are sent, so IRIS keeps (or, for a new app, defaults) the rest.
        const body = { ...webAppBody({ ...(v as WebAppFormValues), Path: path }, base), ...changedMore(v, more) };
        // Opening it to everyone is confirmed whenever this save would turn No sign-in on.
        if (body.Enabled && v.AuthNone && !(app && app.Enabled && isOpen(app))) {
          const full = anonFull();
          const ok = await confirm({
            title: `Let anyone connect to ${path}?`,
            body: `<p>No sign-in is allowed, so a request without a username runs as UnknownUser${full ? ', which holds %All: full access to the instance' : unknownRoles?.length ? `, with ${esc(unknownRoles.join(', '))}` : ''}.</p>`,
            confirmLabel: name ? 'Save anyway' : 'Create anyway',
            danger: full,
          });
          if (!ok) throw new Error(`Not ${name ? 'saved' : 'created'}. Clear “No sign-in” to require a sign-in.`);
        }
        // updateWebApp checks it still exists first: IRIS's PUT would otherwise create it again.
        if (name) await updateWebApp(name, body); else await createWebApp(path, body);
        leaveEdit();
        details.delete(path);
        if (inFull) {
          fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
          await load(true);
          od.refresh();
        } else {
          await load(true);
          await od.select(path);
          od.refresh();
          requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
        }
        toast(name ? `${path} saved.` : `${path} created.`);
      },
      onCancel: () => {
        leaveEdit();
        if (inFull) { fullEl.innerHTML = ''; od.refresh(); }
        else if (od.selected()) od.refresh(); else { panel.open = false; applyColumns(); }
      },
    });
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    rolePicker(host.querySelector('#wa-roles') as HTMLElement, {
      all: roles, selected: Array.isArray(init.Roles) ? init.Roles : [], name: 'Roles', label: 'Application roles', emptyText: 'None: callers keep only their own roles',
      onChange: () => sync(),
    });

    function problems(v: FormValues): FieldProblem[] {
      const out: FieldProblem[] = [];
      if (!name) {
        const path = String(v.Path ?? '').trim();
        if (!path) out.push({ field: 'Path', label: 'Path', message: 'Enter a path such as /csp/myapp' });
        else if (!path.startsWith('/')) out.push({ field: 'Path', label: 'Path', message: 'Start the path with /' });
        else if (path.length > 1 && path.endsWith('/')) out.push({ field: 'Path', label: 'Path', message: 'Leave off the trailing /' });
        else if (!PATH_OK.test(path)) out.push({ field: 'Path', label: 'Path', message: 'Letters, digits, / . _ - and ~ only; no spaces' });
        else if (all.some((a) => a.Name.toLowerCase() === path.toLowerCase())) out.push({ field: 'Path', label: 'Path', message: 'An application already uses this path' });
      }
      if (!String(v.NameSpace ?? '') || !nsOptions.some((o) => o.value === String(v.NameSpace))) out.push({ field: 'NameSpace', label: 'Namespace', message: 'Choose a namespace' });
      const rest = String(v.Kind) === 'rest';
      if (rest) {
        const c = String(v.DispatchClass ?? '').trim();
        if (!c) out.push({ field: 'DispatchClass', label: 'Dispatch class', message: 'Enter the class that handles requests' });
        else if (!CLASS_NAME.test(c)) out.push({ field: 'DispatchClass', label: 'Dispatch class', message: 'Give the full class name, e.g. MyApp.REST.Dispatch' });
      } else if (String(v.ServeFiles) === 'Always and cached' && !/^\d+$/.test(String(v.ServeFilesTimeout ?? '').trim())) {
        out.push({ field: 'ServeFilesTimeout', label: 'Browser cache', message: 'Enter whole seconds, e.g. 3600' });
      }
      if (!SIGN_IN.some((m) => v[m.key])) out.push({ field: 'AuthPassword', label: 'Allowed sign-in', message: 'Allow at least one way to sign in' });
      if (rest && v.Jwt) {
        for (const [f, label] of [['JWTAccessTokenTimeout', 'Access token'], ['JWTRefreshTokenTimeout', 'Refresh token']] as const) {
          const s = String(v[f] ?? '').trim();
          if (!/^\d+$/.test(s) || Number(s) < 1) out.push({ field: f, label, message: 'Enter whole seconds, 1 or more' });
        }
      }
      const t = String(v.Timeout ?? '').trim();
      if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) out.push({ field: 'Timeout', label: 'Session timeout', message: 'Enter minutes, more than 0' });
      const cp = String(v.CookiePath ?? '').trim();
      if (cp && !cp.startsWith('/')) out.push({ field: 'CookiePath', label: 'Cookie path', message: 'Start the cookie path with /' });
      const bad = originsOf(v.CorsAllowlist).find((o) => o !== '*' && !/^https?:\/\/[^\s/]+$/i.test(o));
      if (bad) out.push({ field: 'CorsAllowlist', label: 'CORS origins', message: `“${bad}” isn’t an origin: use https://host (no path), or *` });
      return out;
    }
    const sync = (): void => {
      const v = readForm(host);
      const kind = String(v.Kind || 'rest');
      host.querySelectorAll<HTMLElement>('[data-wa-kind]').forEach((el) => { el.hidden = el.dataset.waKind !== kind; });
      const toggle = (sel: string, show: boolean): void => { const el = host.querySelector<HTMLElement>(sel); if (el) el.hidden = !show; };
      toggle('[data-wa-cached]', String(v.ServeFiles) === 'Always and cached');
      toggle('[data-wa-jwt]', !!v.Jwt);
      toggle('[data-wa-cors]', originsOf(v.CorsAllowlist).length > 0);
      renderPreview(v);
    };
    /** A field's label as the form shows it (the field helper's label, or the checkbox text). */
    const labelOf = (key: string): string => {
      const f = host.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"]`);
      return (f?.getAttribute('label') ?? f?.querySelector('ev-checkbox, ev-toggle')?.textContent ?? key).trim();
    };
    /** A value in words: an option's own label for selects, on/off for switches, a list joined. */
    const wordsOf = (key: string, val: unknown): string => {
      if (typeof val === 'boolean') return val ? 'on' : 'off';
      if (Array.isArray(val)) return val.length ? val.map(String).join(', ') : 'none';
      const opt = host.querySelector(`[data-field="${CSS.escape(key)}"] option[value="${CSS.escape(String(val))}"]`);
      return (opt?.textContent ?? String(val)).trim() || 'none';
    };
    const signInOf = (v: FormValues): string => SIGN_IN.filter((m) => v[m.key]).map((m) => m.label).join(', ') || 'none';
    // The values the form opened with, taken once the pickers have mounted (as the editor's own baseline is).
    let start: FormValues | null = null;
    const renderPreview = (v: FormValues): void => {
      const prev = host.querySelector<HTMLElement>('#wa-preview');
      if (!prev || !start) return;
      const opens = !!v.Enabled && !!v.AuthNone && !(app && app.Enabled && isOpen(app));
      const risk = opens ? [{
        title: anonFull() ? 'Anyone can connect without signing in, with full access' : 'Anyone can connect without signing in',
        text: `Requests with no sign-in run as UnknownUser${anonFull() ? ', which holds %All' : unknownRoles?.length ? `, which holds ${unknownRoles.join(', ')}` : ''}.`,
      }] : [];
      if (!name) {
        const path = String(v.Path ?? '').trim() || '…';
        prev.innerHTML = previewHtml([
          `Creates ${path} in ${String(v.NameSpace || '…')}, ${v.Enabled ? 'enabled' : 'switched off'}.`,
          `Serves ${String(v.Kind) === 'rest' ? `a REST API${v.DispatchClass ? ` (${String(v.DispatchClass)})` : ''}` : 'web pages and files'}.`,
          `Allowed sign-in: ${signInOf(v)}.`,
        ], risk);
        return;
      }
      const lines: string[] = [];
      if (signInOf(v) !== signInOf(start)) lines.push(`Allowed sign-in: ${signInOf(start)} → ${signInOf(v)}.`);
      const skip = new Set(['Path', ...SIGN_IN.map((m) => m.key)]);
      for (const k of Object.keys(v)) {
        if (skip.has(k) || JSON.stringify(v[k]) === JSON.stringify(start[k])) continue;
        if (k === 'Kind') { lines.push(`It serves: ${wordsOf(k, start[k])} → ${wordsOf(k, v[k])}.`); continue; }
        lines.push(`${k === 'Roles' ? 'Application roles' : labelOf(k)}: ${wordsOf(k, start[k])} → ${wordsOf(k, v[k])}.`);
      }
      prev.innerHTML = previewHtml(lines, risk);
    };
    requestAnimationFrame(() => { start = readForm(host); renderPreview(start); });
    if (inFull) stickyEditHead(host, name ?? '', true);
    formEvents = new AbortController();
    for (const ev of ['ev-select-change', 'ev-input-input', 'ev-checkbox-change', 'ev-toggle-change', 'change', 'input']) host.addEventListener(ev, sync, { signal: formEvents.signal });
    sync();
  };

  const updated = liveIndicator(ctx, () => void load(true));
  const newBtn = newButton(ctx, 'New web application', () => void openEditor(null));
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    if (!editor) od.refreshHeader();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });
  /** `force`: the user asked (refresh button, after an action), so apply even mid-interaction. */
  const load = async (force = false): Promise<void> => {
    try {
      const [list, unknown, g, ss] = await Promise.all([
        getWebAppList(), getUser('UnknownUser').catch(() => null),
        getSecurityGraph(force).catch(() => null),
        getWebSessions().catch(() => [] as WebSession[]),
      ]);
      if (!alive) return;
      updated(new Date());
      // Held while the pointer is over the workspace or a menu or dialog is open, so rows
      // don't reorder under the cursor; the selection is kept by path either way.
      gate.run(() => {
        unknownRoles = unknown ? unknown.Roles : null;
        if (g) graph = g;
        all = list;
        sessions = ss;
        renderToolbar();
        renderGrid();
        renderFoot();
        if (editor) return; // never replace the form under the user's hands
        // Settings may have changed: the view shown stays until a fresh read lands.
        const sel = od.selected();
        if (sel && all.some((a) => a.Name === sel)) {
          getWebApp(sel).then((d) => { details.set(sel, d); if (!editor && od.selected() === sel) od.refresh(); }).catch(() => { /* keep what's shown */ });
        }
        od.refresh();
      }, force || all.length === 0 || od.mode() === 'full');
    } catch (err) {
      if (od.mode() === 'full') return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'wa-retry');
      wrap.querySelector('#wa-retry')?.addEventListener('click', () => void load(true));
    }
  };

  $('#wa-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  $('#wa-open').addEventListener('click', () => {
    openOnly = !openOnly;
    renderToolbar();
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
