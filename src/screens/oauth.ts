// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › OAuth 2.0 — one list of every OAuth 2.0 configuration on the
 * instance, whatever role IRIS plays in it:
 *   - Client: an application of ours that signs users in, or calls APIs, with
 *     tokens from an external issuer;
 *   - Issuer: an external authorization server IRIS knows (clients and
 *     resource servers point at one);
 *   - Resource server: lets web apps accept access tokens;
 *   - Authorization server: this instance issuing tokens itself (one per instance).
 * "New ▾" in the header creates any of the three kinds in-app. Rows open the
 * detail panel; editing happens in the same panel. Secrets are write-only:
 * set from a form, never read or shown.
 */
import '../styles-secrets.css';
import '../styles-security.css';
import '../styles-sec.css';
import {
  getOAuthServerDefinitions, getOAuthClientConfigs, getOAuthRegisteredClients, getOAuthResourceServers, getOAuthAuthServer,
  getOAuthServerDefinition, getOAuthClientConfig, getOAuthResourceServer, getTlsConfigs, getTlsConfig,
  createOAuthServerDefinition, updateOAuthServerDefinition, discoverOAuthServer, deleteOAuthServerDefinition,
  saveOAuthClientConfig, setOAuthClientSecret, deleteOAuthClientConfig,
  saveOAuthResourceServer, setOAuthResourceServerSecret, deleteOAuthResourceServer,
  saveOAuthAuthServer, deleteOAuthAuthServer, docsHref, isMasked,
  type OAuthServerDefinition, type OAuthClientConfig, type OAuthRegisteredClient, type OAuthResourceServer, type OAuthAuthServer,
  type OAuthServerDefinitionDetail, type OAuthClientConfigDetail, type OAuthResourceServerDetail, type TlsConfigSummary,
  type OAuthAuthServerBody,
} from '../api-secrets';
import { getSecurityGraph, type SecurityGraph } from '../api-security';
import { mountSecurityBanner, type LocalRisk } from '../security-view';
import { plural, kv, esc, chip, cell, num, skeleton, errorPanel, liveIndicator, noPermissionText, emptyState, type ScreenCtx, type Tone, setChips } from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, textareaField, passwordField,
  selectField, checkField, readForm, fieldError, blockedAttrs, AdminError, type FieldProblem, type EditorHandle, type MenuItem, type MenuHandle,
} from '../crud';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

// ── Vocabulary ─────────────────────────────────────────────────────────

type Kind = 'client' | 'issuer' | 'resource' | 'authserver';
const KIND_LABEL: Record<Kind, string> = { client: 'Client', issuer: 'Issuer', resource: 'Resource server', authserver: 'Authorization server' };
const KIND_HINT: Record<Kind, string> = {
  client: 'An application of ours that signs users in, or calls APIs, with tokens from an issuer',
  issuer: 'An external authorization server IRIS gets tokens from',
  resource: 'Lets web applications accept access tokens instead of passwords',
  authserver: 'This instance issues tokens to the applications registered with it',
};
const CLIENT_TYPES: Record<string, { label: string; hint: string }> = {
  confidential: { label: 'Confidential', hint: 'Runs on a server and proves who it is with a client secret' },
  public: { label: 'Public', hint: 'Can’t keep a secret, such as a browser or mobile app' },
  resource: { label: 'Resource server', hint: 'Only checks tokens, never requests them' },
};
const clientTypeChip = (t: string): string => {
  const c = CLIENT_TYPES[t.toLowerCase()];
  return c ? chip(c.label, 'neutral', c.hint) : t ? chip(t) : '';
};
const enabledChip = (on: boolean): string => (on ? chip('Enabled', 'success') : chip('Disabled', 'neutral'));
const hidden = (text = 'Never shown'): string => `<span class="masked" title="Secrets are write-only"><ev-icon name="eye-off" size="xs"></ev-icon>${text}</span>`;
const tokens = (list: string[]): string =>
  list.length ? `<ul class="token-list">${list.map((x) => `<li class="token">${esc(x)}</li>`).join('')}</ul>` : '<span class="dim">—</span>';
/** A TLS configuration name, linked to Certificates & TLS. */
const tlsLink = (name: string): string =>
  (name ? `<a class="mono" href="#/security/certs" title="Open Certificates &amp; TLS">${esc(name)}</a>` : '<span class="dim">—</span>');
const NO_PRIV = noPermissionText('%Admin_OAuth2_Client', 'OAuth 2.0 client administration');
const NO_PRIV_SERVER = noPermissionText('%Admin_OAuth2_Server', 'OAuth 2.0 authorization server administration');
/** Where IRIS receives sign-in responses, under the redirect server's address. */
const REDIRECT_PATH = '/csp/sys/oauth2/OAuth2.Response.cls';
const isUrl = (s: string, https = false): boolean => {
  try { const u = new URL(s); return https ? u.protocol === 'https:' : /^https?:$/.test(u.protocol); } catch { return false; }
};
const hostOf = (s: string): string => { try { return new URL(s).host; } catch { return s; } };
const metaText = (m: Record<string, unknown> | undefined, key: string): string => {
  const v = m?.[key];
  return typeof v === 'string' && !isMasked(v) ? v : '';
};
const metaList = (m: Record<string, unknown> | undefined, key: string): string[] => {
  const v = m?.[key];
  return Array.isArray(v) ? v.map(String) : [];
};
/** Grant types an authorization server can allow, in the order the form lists them. */
const GRANTS: Array<{ key: string; label: string; on: boolean }> = [
  { key: 'authorization_code', label: 'Authorization code', on: true },
  { key: 'client_credentials', label: 'Client credentials', on: true },
  { key: 'password', label: 'Resource owner password', on: false },
  { key: 'implicit', label: 'Implicit', on: false },
  { key: 'jwt_authorization', label: 'JWT authorization', on: false },
];
const DEFAULT_SCOPES = 'openid: Sign in with OpenID Connect\nprofile: Name and profile\nemail: Email address';
/** Scopes as "scope: description" lines. */
const parseScopes = (text: string): Array<{ Scope: string; Description: string }> =>
  text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf(':');
    return i < 0 ? { Scope: l, Description: '' } : { Scope: l.slice(0, i).trim(), Description: l.slice(i + 1).trim() };
  }).filter((s) => s.Scope);
const NEW_ISSUER = '__new';
const secs = (n: unknown): string => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v % 86400 === 0 && v >= 86400) return `${v / 86400} day${v === 86400 ? '' : 's'}`;
  if (v % 3600 === 0 && v >= 3600) return `${v / 3600} hour${v === 3600 ? '' : 's'}`;
  if (v % 60 === 0 && v >= 60) return `${v / 60} min`;
  return `${v} s`;
};

type Selection =
  | { kind: 'issuer'; id: number }
  | { kind: 'client'; app: string; server: number }
  | { kind: 'resource'; name: string }
  | { kind: 'authserver' }
  | null;
const selKey = (s: Selection): string =>
  !s ? '' : s.kind === 'issuer' ? `issuer:${s.id}` : s.kind === 'client' ? `client:${s.app}` : s.kind === 'resource' ? `resource:${s.name}` : 'authserver';

type Filter = 'all' | Kind;
type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

const COLUMNS: DataGridColumn[] = [
  { key: 'Name', label: 'Name', width: '280px', sortable: true, renderCell: (v, row) => (row.Mono ? cell.id(v, String(v)) : cell.text(v, String(v))) },
  { key: 'Role', label: 'Role', width: '170px', sortable: true, renderCell: (v, row) => cell.text(v, String(row.RoleHint)) },
  { key: 'Issuer', label: 'Issuer', sortable: true, renderCell: (v) => (v ? cell.mono(v, true, String(v)) : cell.dim('—')) },
  {
    key: 'Status', label: 'Status', width: '120px', sortable: true,
    renderCell: (v, row) => (row.StatusTone === 'plain' ? cell.text(v) : row.StatusTone === 'dim' ? cell.dim(String(v)) : chip(String(v), row.StatusTone as Tone)),
  },
];

export function oauthScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="o-toolbar" hidden>
      <div class="search-box"><ev-search id="o-search" size="sm" full-width placeholder="Filter by name or issuer" aria-label="Filter"></ev-search></div>
      <ev-segmented-button id="o-filter" size="sm" aria-label="Show"></ev-segmented-button>
    </div>
    <ev-detail-panel id="o-panel" detail-width="400" overlay-below="960" class="workspace">
      <div class="grid-wrap grid-wrap--sec" id="o-wrap">${skeleton(6)}</div>
      <aside slot="detail" class="detail" id="o-detail" aria-label="OAuth 2.0 details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="o-foot" hidden></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#o-panel');
  const wrap = $('#o-wrap');
  const detail = $('#o-detail');
  const filterEl = $<HTMLElement & { options: unknown; value: string }>('#o-filter');
  filterEl.value = 'all';

  // Data
  let defs: OAuthServerDefinition[] = [];
  const configs = new Map<number, OAuthClientConfig[] | Error>();
  const clientDetail = new Map<string, OAuthClientConfigDetail>();
  const rsDetail = new Map<string, OAuthResourceServerDetail>();
  let authServer: OAuthAuthServer | null = null;
  let registered: OAuthRegisteredClient[] = [];
  let resourceServers: OAuthResourceServer[] = [];
  let loadError: unknown = null;
  let tlsClients: TlsConfigSummary[] | null = null;
  let loaded = false;
  let canEdit: boolean | null = null;
  let canServer: boolean | null = null;
  let alive = true;
  let selected: Selection = null;
  let token = 0;
  let filter: Filter = 'all';
  let query = '';
  let grid: GridEl | null = null;

  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let formEvents: AbortController | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; formEvents?.abort(); formEvents = null; };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); newMenu?.destroy(); });
  const blocked = (): string => (canEdit === false ? NO_PRIV : '');

  const allClients = (): Array<OAuthClientConfig & { server: number }> =>
    defs.flatMap((d) => { const c = configs.get(d.ID); return Array.isArray(c) ? c.map((x) => ({ ...x, server: d.ID })) : []; });
  const defByIssuer = (issuer: string): OAuthServerDefinition | undefined => defs.find((d) => d.IssuerEndpoint === issuer);

  // ── Header: "New ▾" with the kinds IRIS can create ──
  const newBtn = newButton(ctx, 'New configuration', () => { /* the menu opens on click */ });
  newBtn.el.insertAdjacentHTML('beforeend', '<ev-icon name="chevron-down" size="xs"></ev-icon>');
  newBtn.el.classList.add('sec-new-menu');
  newBtn.el.setAttribute('aria-label', 'New OAuth 2.0 configuration');
  let newMenu: MenuHandle | null = null;
  const buildNewMenu = (): void => {
    newMenu?.destroy();
    newMenu = moreMenu(newBtn.el, [
      { label: 'Client', icon: 'user', disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void openClientEditor(null, null) },
      { label: 'Resource server', icon: 'link', disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void openResourceEditor(null) },
      {
        label: 'Authorization server', icon: 'key-round',
        disabled: !!authServer || canServer === false,
        reason: authServer ? 'This instance already is one. Open it to change its settings.' : NO_PRIV_SERVER,
        onSelect: () => void openAuthServerEditor(false),
      },
    ]);
  };
  buildNewMenu();

  // ── Rows ──
  const allRows = (): Array<DataGridRow & { Kind: Kind; Sel: string }> => {
    const rows: Array<DataGridRow & { Kind: Kind; Sel: string }> = [];
    if (authServer) {
      rows.push({
        Key: 'authserver', Kind: 'authserver', Sel: JSON.stringify({ kind: 'authserver' } as Selection), Name: 'This instance', Mono: false,
        Role: KIND_LABEL.authserver, RoleHint: KIND_HINT.authserver, Issuer: metaText(authServer.Metadata as Record<string, unknown> | undefined, 'issuer') || authServer.IssuerEndpoint,
        Status: plural(registered.length, 'client'), StatusTone: 'plain',
      });
    }
    for (const c of allClients()) {
      const d = clientDetail.get(c.ApplicationName);
      const s = defs.find((x) => x.ID === c.server);
      rows.push({
        Key: `client:${c.ApplicationName}`, Kind: 'client', Sel: JSON.stringify({ kind: 'client', app: c.ApplicationName, server: c.server } as Selection), Name: c.ApplicationName, Mono: true,
        Role: KIND_LABEL.client, RoleHint: KIND_HINT.client, Issuer: s?.IssuerEndpoint ?? '',
        Status: d ? (d.Enabled ? 'Enabled' : 'Disabled') : '—', StatusTone: d ? (d.Enabled ? 'success' : 'neutral') : 'dim',
      });
    }
    for (const d of defs) {
      const used = d.ClientCount + d.ResourceCount;
      rows.push({
        Key: `issuer:${d.ID}`, Kind: 'issuer', Sel: JSON.stringify({ kind: 'issuer', id: d.ID } as Selection), Name: hostOf(d.IssuerEndpoint), Mono: true,
        Role: KIND_LABEL.issuer, RoleHint: KIND_HINT.issuer, Issuer: d.IssuerEndpoint,
        Status: used ? `Used by ${used}` : 'Unused', StatusTone: used ? 'plain' : 'dim',
      });
    }
    for (const r of resourceServers) {
      const d = rsDetail.get(r.Name);
      rows.push({
        Key: `resource:${r.Name}`, Kind: 'resource', Sel: JSON.stringify({ kind: 'resource', name: r.Name } as Selection), Name: r.Name, Mono: true,
        Role: KIND_LABEL.resource, RoleHint: KIND_HINT.resource, Issuer: r.ServerDefinition,
        Status: d ? (d.Enabled ? 'Enabled' : 'Disabled') : '—', StatusTone: d ? (d.Enabled ? 'success' : 'neutral') : 'dim',
      });
    }
    return rows;
  };
  const matches = (r: DataGridRow & { Kind: Kind }): boolean =>
    (filter === 'all' || r.Kind === filter) && (!query || [r.Name, r.Issuer].some((f) => String(f ?? '').toLowerCase().includes(query.toLowerCase())));

  const renderToolbar = (rows: Array<{ Kind: Kind }>): void => {
    const n = (k: Filter): number => (k === 'all' ? rows.length : rows.filter((r) => r.Kind === k).length);
    const opt = (value: Filter, label: string): { value: Filter; label: string; disabled: boolean } =>
      ({ value, label: `${label} ${n(value)}`, disabled: n(value) === 0 && filter !== value });
    setChips(filterEl, rows.length, [opt('all', 'All'), opt('client', 'Clients'), opt('issuer', 'Issuers'), opt('resource', 'Resource servers'), opt('authserver', 'Authorization server')], { active: filter, search: $('#o-search'), query });
    $('#o-toolbar').hidden = rows.length === 0;
  };

  const renderFoot = (): void => {
    const figs: Array<[number, string]> = [[allClients().length, 'client'], [defs.length, 'issuer'], [resourceServers.length, 'resource server']];
    if (authServer) figs.push([registered.length, 'registered client']);
    const foot = $('#o-foot');
    foot.hidden = figs.every(([n]) => !n) && !authServer;
    foot.innerHTML = figs.map(([n, w]) => `<b>${num(n)}</b> ${w}${n === 1 ? '' : 's'}`).join('<span class="meta-sep">·</span>');
  };

  const renderGrid = (): void => {
    if (loadError) {
      grid = null;
      wrap.innerHTML = errorPanel(loadError, 'o-retry');
      wrap.querySelector('#o-retry')?.addEventListener('click', () => void load());
      return;
    }
    const all = allRows();
    renderToolbar(all);
    if (!all.length) {
      grid = null;
      wrap.innerHTML = emptyState({
        icon: 'key-round', title: 'OAuth isn’t set up',
        what: 'Let applications sign users in with tokens, accept tokens on REST APIs, or have IRIS issue tokens itself.',
        docs: { href: docsHref('oauthClient'), label: 'Learn more' },
      });
      return;
    }
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Key');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const row = (e as CustomEvent<{ row: DataGridRow }>).detail.row;
        void select(JSON.parse(String(row.Sel ?? 'null')) as Selection);
      });
      wrap.appendChild(grid);
    }
    const rows = all.filter(matches);
    grid.rows = rows;
    grid.select(selected ? [selKey(selected)] : []);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">Nothing matches${query ? ` “${esc(query)}”` : ''}.</div>`);
  };

  // ── Detail (view) ──
  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => { selected = null; grid?.select([]); setPanel(false); };
  // Not ui.ts mono: an empty value shows a dim dash.
  const mono = (s: string): string => (s ? `<span class="mono">${esc(s)}</span>` : '<span class="dim">—</span>');
  const selLink = (s: Selection, label: string): string => `<button type="button" class="link mono" data-sel="${esc(JSON.stringify(s))}">${esc(label)}</button>`;
  const head = (kicker: string, title: string, state: string, monoTitle = false): string => `
    <header class="detail-head">
      <div class="detail-title"><span class="detail-kicker">${esc(kicker)}</span><h2${monoTitle ? ' class="mono"' : ''}>${esc(title)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="o-close"></ev-icon-button>
    </header>
    <div class="detail-state">${state}</div>`;
  const actions = (editLabel: string, extra = '', reason = blocked()): string => `
    <div class="detail-actions">
      <button type="button" class="btn btn--sm" id="o-edit"${blockedAttrs(reason)}>${editLabel}</button>
      ${extra}
      ${moreButton('o-more')}
    </div>`;
  const wire = (onEdit: () => void, items: MenuItem[]): void => {
    detail.querySelector('#o-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#o-edit')?.addEventListener('click', (e) => { if (!(e.currentTarget as HTMLElement).hasAttribute('data-crud-blocked')) onEdit(); });
    detail.querySelectorAll<HTMLElement>('[data-sel]').forEach((b) => b.addEventListener('click', () => void select(JSON.parse(b.dataset.sel ?? 'null') as Selection)));
    const more = detail.querySelector<HTMLElement>('#o-more');
    if (more) moreMenu(more, items);
  };
  const rowList = (items: Array<{ sel: Selection; label: string; right?: string }>): string =>
    `<ul class="rows">${items.map((i) => `<li><button type="button" class="row row-button" data-sel="${esc(JSON.stringify(i.sel))}"><span class="row-main mono">${esc(i.label)}</span>${i.right ? `<span class="row-chips">${i.right}</span>` : ''}</button></li>`).join('')}</ul>`;

  const renderIssuer = (id: number, d: OAuthServerDefinitionDetail): void => {
    const s = defs.find((x) => x.ID === id);
    if (!s) { closeDetail(); return; }
    const clients = configs.get(id);
    const rs = resourceServers.filter((r) => r.ServerDefinition === s.IssuerEndpoint);
    const inUse = s.ClientCount + s.ResourceCount;
    const m = d.Metadata;
    detail.innerHTML = `
      ${head('Issuer', hostOf(s.IssuerEndpoint), `<span class="dim">${inUse ? `Used by ${plural(inUse, 'configuration')}` : 'Unused'}</span>`, true)}
      ${actions('Edit', `<button type="button" class="btn btn--sm" id="o-add-client"${blockedAttrs(blocked())}>New client</button>`)}
      <h3 class="detail-section">Connection</h3>
      <dl class="kv-list">
        ${kv('Issuer', mono(s.IssuerEndpoint), s.IssuerEndpoint)}
        ${kv('TLS configuration', tlsLink(d.SSLConfiguration), d.SSLConfiguration)}
      </dl>
      <h3 class="detail-section">Endpoints</h3>
      <dl class="kv-list">
        ${kv('Sign-in page', mono(metaText(m, 'authorization_endpoint')), metaText(m, 'authorization_endpoint'))}
        ${kv('Tokens', mono(metaText(m, 'token_endpoint')), metaText(m, 'token_endpoint'))}
        ${kv('User info', mono(metaText(m, 'userinfo_endpoint')), metaText(m, 'userinfo_endpoint'))}
        ${kv('Signing keys', mono(metaText(m, 'jwks_uri')), metaText(m, 'jwks_uri'))}
        ${metaText(m, 'introspection_endpoint') ? kv('Token checks', mono(metaText(m, 'introspection_endpoint')), metaText(m, 'introspection_endpoint')) : ''}
        ${metaText(m, 'revocation_endpoint') ? kv('Revocation', mono(metaText(m, 'revocation_endpoint')), metaText(m, 'revocation_endpoint')) : ''}
      </dl>
      <h3 class="detail-section">Clients using it · ${num(s.ClientCount)}</h3>
      ${Array.isArray(clients) && clients.length
        ? rowList(clients.map((c) => ({ sel: { kind: 'client', app: c.ApplicationName, server: id }, label: c.ApplicationName, right: clientTypeChip(c.ClientType) })))
        : '<p class="chip-list-empty">None yet.</p>'}
      ${rs.length ? `<h3 class="detail-section">Resource servers trusting it · ${num(rs.length)}</h3>
        ${rowList(rs.map((r) => ({ sel: { kind: 'resource', name: r.Name }, label: r.Name })))}` : ''}`;
    wire(() => void openIssuerEditor(id, d), [
      { label: 'Refresh settings from the issuer', icon: 'refresh-cw', disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void refreshIssuer(id) },
      {
        label: 'Delete', icon: 'trash-2', danger: true,
        disabled: canEdit === false || inUse > 0,
        reason: canEdit === false ? NO_PRIV : `Used by ${[s.ClientCount ? plural(s.ClientCount, 'client') : '', s.ResourceCount ? plural(s.ResourceCount, 'resource server') : ''].filter(Boolean).join(' and ')}. Delete those first.`,
        onSelect: () => void removeIssuer(id),
      },
    ]);
    detail.querySelector('#o-add-client')?.addEventListener('click', (e) => { if (!(e.currentTarget as HTMLElement).hasAttribute('data-crud-blocked')) void openClientEditor(null, id); });
  };

  const renderClient = (app: string, server: number, d: OAuthClientConfigDetail): void => {
    const s = defs.find((x) => x.ID === server);
    const confidential = d.ClientType.toLowerCase() !== 'public';
    const redirect = d.RedirectionEndpoint ? `${d.RedirectionEndpoint.replace(/\/$/, '')}${REDIRECT_PATH}` : '';
    detail.innerHTML = `
      ${head('Client', app, `${enabledChip(d.Enabled)}${clientTypeChip(d.ClientType)}`, true)}
      ${actions('Edit')}
      ${d.Description ? `<p class="detail-para">${esc(d.Description)}</p>` : ''}
      <h3 class="detail-section">With the provider</h3>
      <dl class="kv-list">
        ${kv('Issuer', s ? selLink({ kind: 'issuer', id: server }, s.IssuerEndpoint) : '<span class="dim">—</span>', s?.IssuerEndpoint)}
        ${kv('Client ID', mono(d.ClientId), d.ClientId)}
        ${confidential ? kv('Client secret', hidden()) : ''}
        ${kv('Redirect URL', mono(redirect), redirect)}
      </dl>
      <p class="kv-text">Register the redirect URL with the provider exactly as shown.</p>
      <h3 class="detail-section">Requests</h3>
      <dl class="kv-list">
        ${kv('Default scopes', tokens(d.DefaultScope.split(/\s+/).filter(Boolean)))}
        ${kv('TLS configuration', tlsLink(d.SSLConfiguration), d.SSLConfiguration)}
      </dl>`;
    wire(() => void openClientEditor({ app, detail: d }, server), [
      ...(confidential ? [{ label: 'Set new client secret', icon: 'key-round', disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void openSecretEditor('client', app) }] : []),
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void removeClient(app) },
    ]);
  };

  const renderResource = (name: string, d: OAuthResourceServerDetail): void => {
    const def = defByIssuer(d.IssuerEndpoint);
    detail.innerHTML = `
      ${head('Resource server', name, enabledChip(d.Enabled), true)}
      ${actions('Edit')}
      ${d.Description ? `<p class="detail-para">${esc(d.Description)}</p>` : ''}
      <h3 class="detail-section">Which tokens it accepts</h3>
      <dl class="kv-list">
        ${kv('Trusts', def ? selLink({ kind: 'issuer', id: def.ID }, d.IssuerEndpoint) : mono(d.IssuerEndpoint), d.IssuerEndpoint)}
        ${kv('Audiences', tokens(d.Audiences.filter(Boolean)))}
        ${kv('Scope required', d.ScopeRequiredToConnect ? mono(d.ScopeRequiredToConnect) : '<span class="dim">—</span>')}
        ${kv('Token format', d.AccessTokenIsJWT ? 'JWT, checked locally' : 'Opaque, checked with the server')}
        ${kv('Asks the server about every token', d.AlwaysCallIntrospection ? 'Yes' : 'No')}
      </dl>
      <h3 class="detail-section">Its own credentials</h3>
      <dl class="kv-list">
        ${kv('Client ID', mono(d.ClientId), d.ClientId)}
        ${kv('Client secret', hidden())}
      </dl>
      <p class="kv-text">Web applications choose it as their token check in <a href="#/web/apps">Web applications</a>.</p>`;
    wire(() => void openResourceEditor({ name, detail: d }), [
      { label: 'Set new client secret', icon: 'key-round', disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void openSecretEditor('resource', name) },
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void removeResource(name) },
    ]);
  };

  const renderAuthServer = (a: OAuthAuthServer): void => {
    const m = a.Metadata as Record<string, unknown> | undefined;
    const issuer = metaText(m, 'issuer') || a.IssuerEndpoint;
    const scopes = (a.SupportedScopes ?? []).map((s) => s.Scope);
    const grants = metaList(m, 'grant_types_supported').filter((g) => g !== 'refresh_token');
    const grantLabel = (g: string): string => GRANTS.find((x) => x.key === g)?.label ?? g;
    detail.innerHTML = `
      ${head('Authorization server', 'This instance', `<span class="dim">${plural(registered.length, 'registered client')}</span>`)}
      ${actions('Edit', '', canServer === false ? NO_PRIV_SERVER : '')}
      ${a.Description ? `<p class="detail-para">${esc(String(a.Description))}</p>` : ''}
      <h3 class="detail-section">Issuer</h3>
      <dl class="kv-list">
        ${kv('Issuer', mono(issuer), issuer)}
        ${kv('Sign-in page', mono(metaText(m, 'authorization_endpoint')), metaText(m, 'authorization_endpoint'))}
        ${kv('Tokens', mono(metaText(m, 'token_endpoint')), metaText(m, 'token_endpoint'))}
        ${kv('TLS configuration', tlsLink(String(a.SSLConfiguration ?? '')), String(a.SSLConfiguration ?? ''))}
      </dl>
      <h3 class="detail-section">What it issues</h3>
      <dl class="kv-list">
        ${kv('Scopes', tokens(scopes))}
        ${kv('Grant types', grants.length ? esc(grants.map(grantLabel).join(', ')) : '<span class="dim">—</span>')}
        ${kv('Access tokens last', esc(secs(a.AccessTokenInterval)))}
        ${kv('Refresh tokens last', esc(secs(a.RefreshTokenInterval)))}
        ${kv('Signing', esc(String(a.SigningAlgorithm || '—')))}
      </dl>
      <h3 class="detail-section">Registered clients · ${num(registered.length)}</h3>
      ${registered.length ? `<ul class="rows">${registered.map((c) => `
          <li class="row"><span class="row-stack"><span class="row-main">${esc(c.Name || c.ClientId)}</span><span class="row-sub mono" title="Client ID">${esc(c.ClientId)}</span></span>
          <span class="row-chips">${clientTypeChip(c.ClientType)}</span></li>`).join('')}</ul>`
        : '<p class="chip-list-empty">None yet. Applications register with it dynamically, or an administrator adds them.</p>'}`;
    wire(() => void openAuthServerEditor(true), [
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: canServer === false, reason: NO_PRIV_SERVER, onSelect: () => void removeAuthServer() },
    ]);
  };

  /** Fetches the selected object's settings, then renders it. */
  const renderDetail = async (): Promise<void> => {
    const sel = selected;
    if (!sel) { setPanel(false); return; }
    const my = ++token;
    setPanel(true);
    detail.innerHTML = `<div class="detail-head"><div class="detail-title"><span class="detail-kicker">Loading…</span></div></div>${skeleton(6)}`;
    try {
      if (sel.kind === 'issuer') { const d = await getOAuthServerDefinition(sel.id); if (my === token && !editor) renderIssuer(sel.id, d); }
      else if (sel.kind === 'client') { const d = await getOAuthClientConfig(sel.app); if (my === token && !editor) renderClient(sel.app, sel.server, d); }
      else if (sel.kind === 'resource') { const d = await getOAuthResourceServer(sel.name); if (my === token && !editor) renderResource(sel.name, d); }
      else { const a = await getOAuthAuthServer(); if (my !== token || editor) return; if (!a) { closeDetail(); return; } authServer = a; renderAuthServer(a); }
    } catch (err) {
      if (my !== token || editor) return;
      if (err instanceof AdminError && err.status === 404) { closeDetail(); return; }
      detail.innerHTML = `<header class="detail-head"><div class="detail-title"></div><ev-icon-button icon="x" label="Close details" id="o-close"></ev-icon-button></header>${errorPanel(err)}`;
      detail.querySelector('#o-close')?.addEventListener('click', closeDetail);
    }
  };
  const select = async (s: Selection): Promise<void> => {
    if (!(await mayLeave())) { grid?.select(selected ? [selKey(selected)] : []); return; }
    selected = s;
    grid?.select(s ? [selKey(s)] : []);
    void renderDetail();
  };

  // ── Forms ──
  const tlsOptions = async (current = '', none = ''): Promise<Array<{ value: string; label: string }>> => {
    try { tlsClients ??= (await getTlsConfigs()).filter((t) => t.Type === 'Client'); } catch { tlsClients = []; }
    const names = tlsClients.map((t) => t.Name);
    if (current && !names.includes(current)) names.push(current);
    const first = none ? { value: '', label: none } : { value: '', label: names.length ? 'Choose a TLS configuration' : 'No client TLS configuration yet' };
    return [first, ...names.map((n) => ({ value: n, label: n }))];
  };
  const tlsNote = (opts: Array<{ value: string }>): string => (opts.length > 1 ? '' : `
    <div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>IRIS talks to the server over TLS, so it needs a client TLS configuration. <a href="#/security/certs">Create one in Certificates &amp; TLS</a>, then come back.</div></div>`);
  const openEditor = (opts: Parameters<typeof editorShell>[1]): void => {
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    editor = editorShell(detail, opts);
  };
  const back = (): void => { leaveEdit(); if (selected) void renderDetail(); else setPanel(false); };
  /** After a create or save: reload, select the object and show it. */
  const land = async (s: Selection, message: string, tone: 'success' | 'warning' = 'success'): Promise<void> => {
    leaveEdit();
    selected = s;
    await load();
    toast(message, tone);
  };
  const endpointChecks = (v: Record<string, unknown>, fields: Array<[string, string, boolean]>, out: FieldProblem[]): void => {
    for (const [f, label, req] of fields) {
      const val = String(v[f] ?? '').trim();
      if (req && !val) out.push({ field: f, label, message: 'Enter the address' });
      else if (val && !isUrl(val)) out.push({ field: f, label, message: 'Enter a full http(s):// address' });
    }
  };
  const issuerTaken = (iss: string): boolean => defs.some((x) => x.IssuerEndpoint.replace(/\/$/, '') === iss.replace(/\/$/, ''));

  /** Issuer (server definition): create needs the two endpoints IRIS insists on; the rest comes from the issuer. */
  const openIssuerEditor = async (id: number | null, d?: OAuthServerDefinitionDetail): Promise<void> => {
    if (!(await mayLeave())) return;
    const tls = await tlsOptions(d?.SSLConfiguration ?? '');
    const m = d?.Metadata;
    const endpoint = (name: string, label: string, key: string, hint: string, required = false): string =>
      textField(name, label, metaText(m, key), { required, mono: true, hint, placeholder: 'https://' });
    openEditor({
      title: id !== null ? `Edit <span class="mono">${esc(hostOf(d?.IssuerEndpoint ?? ''))}</span>` : 'New issuer',
      name: d?.IssuerEndpoint,
      submitLabel: id !== null ? 'Save changes' : 'Add issuer',
      sections:
        section('Server',
          (id !== null ? '' : textField('Issuer', 'Issuer URL', '', { required: true, mono: true, placeholder: 'https://login.example.com', hint: 'The address the provider publishes as its issuer.' })) +
          selectField('Tls', 'TLS configuration', tls, d?.SSLConfiguration ?? '', { required: true }) + tlsNote(tls)) +
        section('Endpoints',
          endpoint('AuthEp', 'Sign-in page (authorization endpoint)', 'authorization_endpoint', '', true) +
          endpoint('TokenEp', 'Token endpoint', 'token_endpoint', '', true) +
          (id !== null ? endpoint('UserinfoEp', 'User info endpoint', 'userinfo_endpoint', 'Optional.') + endpoint('JwksEp', 'Signing keys (JWKS URL)', 'jwks_uri', 'Optional.') : ''),
          { hint: id !== null ? 'Refresh settings from the issuer (in ⋯) fills these in from the provider.' : 'From the provider’s documentation, or its /.well-known/openid-configuration page. After saving, IRIS reads the rest of its settings from the issuer.' }),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (id === null) {
          const iss = String(v.Issuer ?? '').trim();
          if (!iss) out.push({ field: 'Issuer', label: 'Issuer URL', message: 'Enter the issuer URL' });
          else if (!isUrl(iss, true)) out.push({ field: 'Issuer', label: 'Issuer URL', message: 'Enter an https:// address' });
          else if (issuerTaken(iss)) out.push({ field: 'Issuer', label: 'Issuer URL', message: 'This issuer is already added' });
        }
        if (!v.Tls) out.push({ field: 'Tls', label: 'TLS configuration', message: 'Choose a TLS configuration' });
        const eps: Array<[string, string, boolean]> = [['AuthEp', 'Sign-in page', true], ['TokenEp', 'Token endpoint', true], ['UserinfoEp', 'User info endpoint', false], ['JwksEp', 'Signing keys', false]];
        endpointChecks(v, eps.filter(([f]) => f in v), out);
        return out;
      },
      onSubmit: async (v) => {
        const tlsName = String(v.Tls);
        if (id !== null) {
          const meta: Record<string, string> = { authorization_endpoint: String(v.AuthEp).trim(), token_endpoint: String(v.TokenEp).trim() };
          if (String(v.UserinfoEp ?? '').trim()) meta.userinfo_endpoint = String(v.UserinfoEp).trim();
          if (String(v.JwksEp ?? '').trim()) meta.jwks_uri = String(v.JwksEp).trim();
          await updateOAuthServerDefinition(id, { SSLConfiguration: tlsName, Metadata: meta });
          await land({ kind: 'issuer', id }, 'Issuer saved.');
          return;
        }
        const { created, note } = await createIssuer(String(v.Issuer).trim(), tlsName, String(v.AuthEp).trim(), String(v.TokenEp).trim());
        await land(created !== null ? { kind: 'issuer', id: created } : null, `Issuer added.${note}`, note ? 'warning' : 'success');
      },
      onCancel: back,
    });
  };
  /** Adds an issuer, then asks IRIS to read the rest of its settings from it. Resolves to its ID. */
  const createIssuer = async (issuer: string, tlsName: string, auth: string, tokenEp: string): Promise<{ created: number | null; note: string }> => {
    try {
      await createOAuthServerDefinition(issuer, tlsName, { authorization_endpoint: auth, token_endpoint: tokenEp });
    } catch (err) {
      if (err instanceof AdminError && err.status === 409) { fieldError(detail, 'Issuer', 'This issuer is already added'); throw new AdminError('An issuer with this URL already exists.', 409); }
      throw err;
    }
    defs = await getOAuthServerDefinitions();
    const created = defByIssuer(issuer)?.ID ?? null;
    let note = '';
    if (created !== null) {
      try { await discoverOAuthServer(created); } catch (err) { note = ` IRIS couldn’t read the rest of its settings from the issuer: ${errorText(err)}`; }
    }
    return { created, note };
  };

  /** Client configuration: an application of ours registered with an issuer. `server` null = choose, or add one here. */
  const openClientEditor = async (existing: { app: string; detail: OAuthClientConfigDetail } | null, server: number | null): Promise<void> => {
    if (!(await mayLeave())) return;
    const d = existing?.detail;
    const tls = await tlsOptions(d?.SSLConfiguration ?? '');
    const s = server !== null ? defs.find((x) => x.ID === server) : undefined;
    const type = (d?.ClientType ?? 'confidential').toLowerCase();
    /** Set once an issuer added from this form exists, so a retry doesn't add it twice. */
    let addedIssuer: number | null = null;
    const issuerChoice = server !== null ? '' : selectField('Server', 'Issuer', [
      ...defs.map((x) => ({ value: String(x.ID), label: x.IssuerEndpoint })),
      { value: NEW_ISSUER, label: 'Add a new issuer…' },
    ], defs.length ? String(defs[0].ID) : NEW_ISSUER, { required: true }) +
      `<div data-new-issuer>
        ${textField('Issuer', 'Issuer URL', '', { mono: true, placeholder: 'https://login.example.com', hint: 'The address the provider publishes as its issuer.' })}
        ${textField('AuthEp', 'Sign-in page (authorization endpoint)', '', { mono: true, placeholder: 'https://' })}
        ${textField('TokenEp', 'Token endpoint', '', { mono: true, placeholder: 'https://', hint: 'From the provider’s /.well-known/openid-configuration page. IRIS reads the rest from the issuer after saving.' })}
      </div>`;
    openEditor({
      subtitle: s ? `Client of ${esc(s.IssuerEndpoint)}` : undefined,
      title: existing ? `Edit <span class="mono">${esc(existing.app)}</span>` : 'New client',
      name: existing?.app,
      submitLabel: existing ? 'Save changes' : 'Create client',
      sections:
        section('Application',
          (existing ? '' : textField('App', 'Name', '', { required: true, mono: true, maxlength: 128, hint: 'Your code uses this name to ask for tokens.' })) +
          textField('Description', 'Description', d?.Description ?? '') +
          selectField('Type', 'Kind of client', Object.entries(CLIENT_TYPES).map(([value, t]) => ({ value, label: `${t.label}: ${t.hint}` })), type) +
          checkField('Enabled', 'Enabled', d?.Enabled ?? true, { toggle: true })) +
        (issuerChoice ? section('Issuer', issuerChoice) : '') +
        section('From the provider',
          textField('ClientId', 'Client ID', d?.ClientId ?? '', { mono: true, hint: 'Issued when you register the application with the provider.' }) +
          `<div data-secret-row${type === 'public' ? ' hidden' : ''}>${passwordField('Secret', existing ? 'New client secret' : 'Client secret', { hint: existing ? 'Leave empty to keep the current secret. It’s never shown.' : 'Stored by IRIS and never shown again.' })}</div>`) +
        section('Redirect',
          textField('Redirect', 'Address users come back to', d?.RedirectionEndpoint || location.origin, { required: true, mono: true, hint: 'The address users reach IRIS at, including any web-gateway prefix.' }) +
          '<p class="w-preview" id="o-redirect" aria-live="polite"></p>' +
          `<div class="crud-note"><ev-icon name="info" size="sm"></ev-icon><div>Saving a client also turns on the <span class="mono">/csp/sys/oauth2</span> web application, which receives the sign-in responses.</div></div>`) +
        section('Requests',
          textField('Scope', 'Default scopes', d?.DefaultScope ?? 'openid profile', { mono: true, hint: 'Space-separated.' }) +
          selectField('Tls', 'TLS configuration', tls, d?.SSLConfiguration ?? '', { required: true }) + tlsNote(tls)),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!existing) {
          const app = String(v.App ?? '').trim();
          if (!app) out.push({ field: 'App', label: 'Name', message: 'Enter a name' });
          else if (allClients().some((c) => c.ApplicationName.toLowerCase() === app.toLowerCase())) out.push({ field: 'App', label: 'Name', message: 'A client with this name already exists' });
        }
        if (server === null && v.Server === NEW_ISSUER && addedIssuer === null) {
          const iss = String(v.Issuer ?? '').trim();
          if (!iss) out.push({ field: 'Issuer', label: 'Issuer URL', message: 'Enter the issuer URL' });
          else if (!isUrl(iss, true)) out.push({ field: 'Issuer', label: 'Issuer URL', message: 'Enter an https:// address' });
          else if (issuerTaken(iss)) out.push({ field: 'Issuer', label: 'Issuer URL', message: 'Already added: pick it above' });
          endpointChecks(v, [['AuthEp', 'Sign-in page', true], ['TokenEp', 'Token endpoint', true]], out);
        }
        const r = String(v.Redirect ?? '').trim();
        if (!r) out.push({ field: 'Redirect', label: 'Redirect address', message: 'Enter the address' });
        else if (!isUrl(r)) out.push({ field: 'Redirect', label: 'Redirect address', message: 'Enter a full http(s):// address' });
        if (!v.Tls) out.push({ field: 'Tls', label: 'TLS configuration', message: 'Choose a TLS configuration' });
        if (!existing && v.Type === 'confidential' && !v.Secret) out.push({ field: 'Secret', label: 'Client secret', message: 'Enter the secret the provider gave you' });
        return out;
      },
      onSubmit: async (v) => {
        const app = existing?.app ?? String(v.App).trim();
        let target = server;
        let note = '';
        if (target === null) {
          if (v.Server !== NEW_ISSUER) target = Number(v.Server);
          else if (addedIssuer !== null) target = addedIssuer;
          else {
            const r = await createIssuer(String(v.Issuer).trim(), String(v.Tls), String(v.AuthEp).trim(), String(v.TokenEp).trim());
            if (r.created === null) throw new AdminError('The issuer was added, but IRIS didn’t report it back. Refresh and try again.', 500);
            addedIssuer = target = r.created;
            note = r.note;
          }
        }
        await saveOAuthClientConfig(app, {
          ServerDefinition: String(target), Description: String(v.Description ?? ''), ClientType: String(v.Type), Enabled: !!v.Enabled,
          ClientId: String(v.ClientId ?? '').trim(), RedirectionEndpoint: String(v.Redirect).trim().replace(/\/$/, ''),
          DefaultScope: String(v.Scope ?? '').trim().split(/\s+/).filter(Boolean).join(' '), SSLConfiguration: String(v.Tls),
        });
        if (v.Secret && v.Type !== 'public') {
          try { await setOAuthClientSecret(app, String(v.Secret)); } catch (err) { note += ` The secret wasn’t saved: ${errorText(err)}`; }
        }
        await land({ kind: 'client', app, server: target }, `${existing ? 'Client saved' : `Client ${app} created`}.${note}`, note ? 'warning' : 'success');
      },
      onCancel: back,
    });
    const sync = (): void => {
      const v = readForm(detail);
      const r = String(v.Redirect ?? '').trim().replace(/\/$/, '');
      const el = detail.querySelector('#o-redirect');
      if (el) el.textContent = isUrl(r) ? `Register this redirect URL with the provider: ${r}${REDIRECT_PATH}` : '';
      const row = detail.querySelector<HTMLElement>('[data-secret-row]');
      if (row) row.hidden = v.Type === 'public';
      const ni = detail.querySelector<HTMLElement>('[data-new-issuer]');
      if (ni) ni.hidden = v.Server !== NEW_ISSUER || addedIssuer !== null;
    };
    formEvents = new AbortController();
    for (const ev of ['ev-select-change', 'ev-input-input', 'change']) detail.addEventListener(ev, sync, { signal: formEvents.signal });
    sync();
  };

  /** Resource server definition. */
  const openResourceEditor = async (existing: { name: string; detail: OAuthResourceServerDetail } | null): Promise<void> => {
    if (!(await mayLeave())) return;
    if (!defs.length) { toast('A resource server trusts tokens from an issuer, so add the issuer first.', 'info'); void openIssuerEditor(null); return; }
    const d = existing?.detail;
    const issuers = defs.map((x) => ({ value: x.IssuerEndpoint, label: x.IssuerEndpoint }));
    openEditor({
      title: existing ? `Edit <span class="mono">${esc(existing.name)}</span>` : 'New resource server',
      name: existing?.name,
      submitLabel: existing ? 'Save changes' : 'Create resource server',
      sections:
        section('Resource server',
          (existing ? '' : textField('Name', 'Name', '', { required: true, mono: true, maxlength: 128 })) +
          textField('Description', 'Description', d?.Description ?? '') +
          checkField('Enabled', 'Enabled', d?.Enabled ?? true, { toggle: true })) +
        section('Which tokens it accepts',
          selectField('Issuer', 'Trusts tokens from', issuers, d?.IssuerEndpoint ?? issuers[0].value, { required: true }) +
          textField('Audiences', 'Audiences', (d?.Audiences ?? []).filter(Boolean).join(', '), { required: true, mono: true, hint: 'Comma-separated. A token must name one of these.' }) +
          textField('Scope', 'Scope required', d?.ScopeRequiredToConnect ?? '', { mono: true, hint: 'Optional. A token without it is refused.' }) +
          checkField('Jwt', 'Access tokens are JWTs (checked locally)', d?.AccessTokenIsJWT ?? true) +
          checkField('Introspect', 'Ask the server about every token', d?.AlwaysCallIntrospection ?? false, { hint: 'Slower, but notices tokens revoked early.' })) +
        section('Its own credentials',
          textField('ClientId', 'Client ID', d?.ClientId ?? '', { mono: true }) +
          passwordField('Secret', existing ? 'New client secret' : 'Client secret', { hint: existing ? 'Leave empty to keep the current secret. It’s never shown.' : 'Stored by IRIS and never shown again.' }),
          { hint: 'Needed only when it asks the authorization server to check tokens.' }),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!existing) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (resourceServers.some((r) => r.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A resource server with this name already exists' });
        }
        if (!v.Issuer) out.push({ field: 'Issuer', label: 'Trusts tokens from', message: 'Choose an issuer' });
        if (!String(v.Audiences ?? '').split(',').some((x) => x.trim())) out.push({ field: 'Audiences', label: 'Audiences', message: 'Name at least one audience' });
        if (v.Introspect && !String(v.ClientId ?? '').trim()) out.push({ field: 'ClientId', label: 'Client ID', message: 'Needed to ask the server about tokens' });
        return out;
      },
      onSubmit: async (v) => {
        const name = existing?.name ?? String(v.Name).trim();
        await saveOAuthResourceServer(name, {
          Description: String(v.Description ?? ''), Enabled: !!v.Enabled, IssuerEndpoint: String(v.Issuer),
          Audiences: String(v.Audiences ?? '').split(',').map((a) => a.trim()).filter(Boolean),
          ScopeRequiredToConnect: String(v.Scope ?? '').trim(), AccessTokenIsJWT: !!v.Jwt, AlwaysCallIntrospection: !!v.Introspect,
          ClientId: String(v.ClientId ?? '').trim(),
        });
        let note = '';
        if (v.Secret) {
          try { await setOAuthResourceServerSecret(name, String(v.Secret)); } catch (err) { note = ` The secret wasn’t saved: ${errorText(err)}`; }
        }
        await land({ kind: 'resource', name }, `${existing ? 'Resource server saved' : `Resource server ${name} created`}.${note}`, note ? 'warning' : 'success');
      },
      onCancel: back,
    });
  };

  /**
   * This instance as the authorization server. IRIS wants every setting on
   * create, so the form carries its defaults; the rarely changed ones sit
   * behind "More settings".
   */
  const openAuthServerEditor = async (edit: boolean): Promise<void> => {
    if (!(await mayLeave())) return;
    const a = edit ? authServer : null;
    if (edit && !a) return;
    const tls = await tlsOptions(String(a?.SSLConfiguration ?? ''), 'None');
    const m = a?.Metadata as Record<string, unknown> | undefined;
    const grantsNow = a ? metaList(m, 'grant_types_supported') : GRANTS.filter((g) => g.on).map((g) => g.key);
    const scopesText = a ? (a.SupportedScopes ?? []).map((s) => (s.Description ? `${s.Scope}: ${s.Description}` : s.Scope)).join('\n') : DEFAULT_SCOPES;
    const val = (k: string, dflt: unknown): string => String(a?.[k] ?? dflt);
    const flag = (k: string, dflt: boolean): boolean => (a && typeof a[k] === 'boolean' ? a[k] as boolean : dflt);
    const base = a ? a.IssuerEndpoint : `https://${location.hostname}`;
    openEditor({
      title: edit ? 'Edit authorization server' : 'New authorization server',
      subtitle: edit ? undefined : 'This instance issues tokens',
      submitLabel: edit ? 'Save changes' : 'Create authorization server',
      submitAlways: !edit,
      sections:
        section('Issuer',
          textField('Base', 'Address clients reach IRIS at', base, { required: true, mono: true, placeholder: 'https://iris.example.com', hint: 'Host, port and any web-gateway prefix. IRIS adds /oauth2 to form the issuer.' }) +
          '<p class="w-preview" id="o-issuer" aria-live="polite"></p>' +
          textField('Description', 'Description', val('Description', '')) +
          selectField('Tls', 'TLS configuration', tls, val('SSLConfiguration', ''), { hint: 'Used when it fetches a client’s signing keys. Optional.' })) +
        section('What it issues',
          textareaField('Scopes', 'Scopes', scopesText, { rows: 4, hint: 'One per line, as scope: description.' }) +
          textField('DefaultScope', 'Default scope', val('DefaultScope', 'openid'), { mono: true, hint: 'Space-separated. Used when a client asks for none.' }) +
          `<div class="crud-check-group" role="group" aria-label="Grant types">${GRANTS.map((g) => checkField(`Grant_${g.key}`, g.label, grantsNow.includes(g.key))).join('')}</div>`) +
        section('Token lifetimes',
          `<div class="crud-row">${textField('AccessTokenInterval', 'Access token (s)', val('AccessTokenInterval', 3600), { mono: true })}${textField('RefreshTokenInterval', 'Refresh token (s)', val('RefreshTokenInterval', 86400), { mono: true })}</div>` +
          `<div class="crud-row">${textField('AuthorizationCodeInterval', 'Authorization code (s)', val('AuthorizationCodeInterval', 60), { mono: true })}${textField('SessionInterval', 'Sign-in session (s)', val('SessionInterval', 86400), { mono: true, hint: '0 ends it with the browser.' })}</div>`) +
        section('Security',
          checkField('ForcePKCEForPublicClients', 'Public clients must use PKCE', flag('ForcePKCEForPublicClients', true)) +
          checkField('ForcePKCEForConfidentialClients', 'Confidential clients must use PKCE', flag('ForcePKCEForConfidentialClients', false)) +
          checkField('AllowPublicClientRefresh', 'Give public clients refresh tokens', flag('AllowPublicClientRefresh', false)) +
          checkField('AllowUnsupportedScope', 'Accept scopes not listed above', flag('AllowUnsupportedScope', false)) +
          selectField('SigningAlgorithm', 'Token signing', ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'HS256'].map((x) => ({ value: x, label: x })), val('SigningAlgorithm', 'RS256'))) +
        `<details class="sec-adv sec-adv--gutter"><summary>More settings</summary>
          ${checkField('SupportSession', 'Keep a sign-in session (users sign in once)', flag('SupportSession', true))}
          ${checkField('AudRequired', 'Requests must name an audience', flag('AudRequired', false))}
          ${textField('ClientSecretInterval', 'Client secrets expire after (s)', val('ClientSecretInterval', 0), { mono: true, hint: '0 means never.' })}
          ${textField('CustomizationNamespace', 'Namespace for customization code', val('CustomizationNamespace', '%SYS'), { mono: true })}
          ${textField('CustomizationRoles', 'Roles for customization code', (Array.isArray(a?.CustomizationRoles) ? (a?.CustomizationRoles as string[]) : ['%DB_IRISSYS', '%Manager']).join(', '), { mono: true, hint: 'Comma-separated. The code that authenticates users runs with these.' })}
          ${textField('AuthenticateClass', 'Authenticate class', val('AuthenticateClass', '%OAuth2.Server.Authenticate'), { mono: true })}
          ${textField('ValidateUserClass', 'Validate user class', val('ValidateUserClass', '%OAuth2.Server.Validate'), { mono: true })}
          ${textField('GenerateTokenClass', 'Generate token class', val('GenerateTokenClass', '%OAuth2.Server.Generate'), { mono: true, hint: '%OAuth2.Server.JWT issues JWT access tokens.' })}
          ${textField('SessionClass', 'Session class', val('SessionClass', 'OAuth2.Server.Session'), { mono: true })}
          ${textField('RevokeTokenClass', 'Revoke token class', val('RevokeTokenClass', '%OAuth2.Server.Revoke'), { mono: true })}
        </details>`,
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        const b = String(v.Base ?? '').trim();
        if (!b) out.push({ field: 'Base', label: 'Address', message: 'Enter the address' });
        else if (!isUrl(b)) out.push({ field: 'Base', label: 'Address', message: 'Enter a full http(s):// address' });
        if (!parseScopes(String(v.Scopes ?? '')).length) out.push({ field: 'Scopes', label: 'Scopes', message: 'List at least one scope' });
        if (!GRANTS.some((g) => v[`Grant_${g.key}`])) out.push({ field: `Grant_${GRANTS[0].key}`, label: 'Grant types', message: 'Allow at least one grant type' });
        for (const [f, label, min] of [['AccessTokenInterval', 'Access token', 1], ['RefreshTokenInterval', 'Refresh token', 1], ['AuthorizationCodeInterval', 'Authorization code', 1], ['SessionInterval', 'Sign-in session', 0], ['ClientSecretInterval', 'Client secrets', 0]] as const) {
          const n = Number(String(v[f] ?? '').trim());
          if (!Number.isInteger(n) || n < min) out.push({ field: f, label, message: min ? 'Enter whole seconds, at least 1' : 'Enter whole seconds' });
        }
        if (!listOf(v.CustomizationRoles).length) out.push({ field: 'CustomizationRoles', label: 'Roles for customization code', message: 'Name at least one role' });
        return out;
      },
      onSubmit: async (v) => {
        const body: OAuthAuthServerBody = {
          IssuerEndpoint: String(v.Base).trim().replace(/\/+$/, ''), Description: String(v.Description ?? '').trim(),
          AccessTokenInterval: Number(v.AccessTokenInterval), AuthorizationCodeInterval: Number(v.AuthorizationCodeInterval),
          RefreshTokenInterval: Number(v.RefreshTokenInterval), SessionInterval: Number(v.SessionInterval), ClientSecretInterval: Number(v.ClientSecretInterval),
          SupportedScopes: parseScopes(String(v.Scopes ?? '')), DefaultScope: String(v.DefaultScope ?? '').trim().split(/\s+/).filter(Boolean).join(' '),
          AllowUnsupportedScope: !!v.AllowUnsupportedScope, ReturnRefreshToken: String(a?.ReturnRefreshToken ?? ''),
          SupportSession: !!v.SupportSession, AudRequired: !!v.AudRequired, AllowPublicClientRefresh: !!v.AllowPublicClientRefresh,
          ForcePKCEForPublicClients: !!v.ForcePKCEForPublicClients, ForcePKCEForConfidentialClients: !!v.ForcePKCEForConfidentialClients,
          CustomizationRoles: listOf(v.CustomizationRoles), CustomizationNamespace: String(v.CustomizationNamespace ?? '').trim(),
          AuthenticateClass: String(v.AuthenticateClass).trim(), SessionClass: String(v.SessionClass).trim(), ValidateUserClass: String(v.ValidateUserClass).trim(),
          GenerateTokenClass: String(v.GenerateTokenClass).trim(), RevokeTokenClass: String(v.RevokeTokenClass).trim(),
          ServerCredentials: String(a?.ServerCredentials ?? ''), SigningAlgorithm: String(v.SigningAlgorithm),
          EncryptionAlgorithm: String(a?.EncryptionAlgorithm ?? ''), KeyAlgorithm: String(a?.KeyAlgorithm ?? ''), SSLConfiguration: String(v.Tls ?? ''),
          Metadata: { grant_types_supported: [...GRANTS.filter((g) => v[`Grant_${g.key}`]).map((g) => g.key), 'refresh_token'] },
        };
        await saveOAuthAuthServer(body);
        await land({ kind: 'authserver' }, edit ? 'Authorization server saved.' : 'This instance is now an authorization server.');
      },
      onCancel: back,
    });
    const sync = (): void => {
      const b = String(readForm(detail).Base ?? '').trim().replace(/\/+$/, '');
      const el = detail.querySelector('#o-issuer');
      if (el) el.textContent = isUrl(b) ? `Issuer: ${b}/oauth2` : '';
    };
    formEvents = new AbortController();
    for (const ev of ['ev-input-input', 'change']) detail.addEventListener(ev, sync, { signal: formEvents.signal });
    sync();
  };
  const listOf = (v: unknown): string[] => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  /** Write-only: a new client secret, for a client or a resource server. */
  const openSecretEditor = async (kind: 'client' | 'resource', name: string): Promise<void> => {
    if (!(await mayLeave())) return;
    openEditor({
      title: `New client secret for <span class="mono">${esc(name)}</span>`,
      name,
      submitLabel: 'Set secret',
      sections: section('Secret', passwordField('Secret', 'Client secret', { required: true }) + passwordField('Secret2', 'Confirm'),
        { hint: 'Replaces the current secret. Copy it from the provider; it’s never shown here.' }),
      check: () => {
        const v = readForm(detail);
        if (!v.Secret) return [{ field: 'Secret', label: 'Client secret', message: 'Enter the secret' }];
        if (!v.Secret2) return [{ field: 'Secret2', label: 'Confirm', message: 'Enter it again' }];
        if (v.Secret !== v.Secret2) return [{ field: 'Secret2', label: 'Confirm', message: 'The two don’t match' }];
        return [];
      },
      onSubmit: async (v) => {
        await (kind === 'client' ? setOAuthClientSecret(name, String(v.Secret)) : setOAuthResourceServerSecret(name, String(v.Secret)));
        leaveEdit();
        void renderDetail();
        toast(`New client secret set for ${name}.`);
      },
      onCancel: back,
    });
  };

  // ── Other actions ──
  const refreshIssuer = async (id: number): Promise<void> => {
    try {
      await discoverOAuthServer(id);
      toast('Settings refreshed from the issuer.');
      void renderDetail();
    } catch (err) { toast(`IRIS couldn’t read the issuer’s settings: ${errorText(err)}`, 'danger'); }
  };
  const removeIssuer = async (id: number): Promise<void> => {
    const s = defs.find((x) => x.ID === id);
    if (!s) return;
    const ok = await confirm({
      title: 'Remove this issuer?',
      body: `<p>IRIS forgets <b class="mono">${esc(s.IssuerEndpoint)}</b>. Nothing uses it now. You can add it again later.</p>`,
      confirmLabel: 'Remove issuer', danger: true,
    });
    if (!ok) return;
    try { await deleteOAuthServerDefinition(id); closeDetail(); await load(); toast('Issuer removed.'); }
    catch (err) { toast(errorText(err), 'danger'); }
  };
  const removeClient = async (app: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete client ${app}?`,
      body: `<p>Code that signs users in or asks for tokens as <b class="mono">${esc(app)}</b> stops working. Tokens IRIS holds for it are discarded.</p><p>The provider still has the application registered; remove it there too if it’s no longer needed.</p>`,
      confirmLabel: 'Delete client', danger: true, typeToConfirm: app,
    });
    if (!ok) return;
    try { await deleteOAuthClientConfig(app); closeDetail(); await load(); toast(`Client ${app} deleted.`); }
    catch (err) { toast(errorText(err), 'danger'); }
  };
  const removeResource = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete resource server ${name}?`,
      body: `<p>Web applications it protects stop accepting access tokens and go back to their other sign-in methods.</p>`,
      confirmLabel: 'Delete resource server', danger: true, typeToConfirm: name,
    });
    if (!ok) return;
    try { await deleteOAuthResourceServer(name); closeDetail(); await load(); toast(`Resource server ${name} deleted.`); }
    catch (err) { toast(errorText(err), 'danger'); }
  };
  const removeAuthServer = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Stop being an authorization server?',
      body: `<p>This instance stops issuing tokens. Applications registered with it can no longer sign users in, and tokens it issued stop being accepted.</p><p>${registered.length ? `${plural(registered.length, 'registered client')} will need to be registered again if you set it up later.` : 'No clients are registered with it.'}</p>`,
      confirmLabel: 'Delete authorization server', danger: true, typeToConfirm: 'delete',
    });
    if (!ok) return;
    try { await deleteOAuthAuthServer(); closeDetail(); await load(); toast('This instance is no longer an authorization server.'); }
    catch (err) { toast(errorText(err), 'danger'); }
  };

  // ── Loading ──
  const updated = liveIndicator(ctx, () => void load(), { live: false });

  const load = async (): Promise<void> => {
    try {
      const [list, a, reg, rs] = await Promise.all([
        getOAuthServerDefinitions(), getOAuthAuthServer(), getOAuthRegisteredClients().catch(() => [] as OAuthRegisteredClient[]), getOAuthResourceServers(),
      ]);
      const next = new Map<number, OAuthClientConfig[] | Error>();
      await Promise.all(list.map(async (d) => {
        try { next.set(d.ID, await getOAuthClientConfigs(d.ID)); } catch (e) { next.set(d.ID, e instanceof Error ? e : new Error(String(e))); }
      }));
      defs = list; authServer = a; registered = reg; resourceServers = rs;
      configs.clear();
      for (const [k, v] of next) configs.set(k, v);
      // Status comes from each object's own settings; one failure blanks only its row.
      const cs = allClients();
      const [cd, rd] = await Promise.all([
        Promise.allSettled(cs.map((c) => getOAuthClientConfig(c.ApplicationName))),
        Promise.allSettled(rs.map((r) => getOAuthResourceServer(r.Name))),
      ]);
      clientDetail.clear(); rsDetail.clear();
      cd.forEach((r, i) => { if (r.status === 'fulfilled') clientDetail.set(cs[i].ApplicationName, r.value); });
      rd.forEach((r, i) => { if (r.status === 'fulfilled') rsDetail.set(rs[i].Name, r.value); });
      loadError = null;
    } catch (err) {
      loadError = err;
    }
    if (!alive) return;
    loaded = true;
    tlsClients = null;
    updated(new Date());
    buildNewMenu();
    renderGrid();
    renderFoot();
    if (!editor) void renderDetail();
    void checkTls();
  };

  $('#o-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    if (loaded) renderGrid();
  });
  filterEl.addEventListener('ev-segmented-button-change', (e) => {
    filter = (e as CustomEvent<{ value: Filter }>).detail.value;
    if (loaded) renderGrid();
  });

  // ── Banner: OAuth connections whose TLS configuration doesn't verify the provider ──
  let graph: SecurityGraph | null = null;
  let tlsRisk: LocalRisk | null = null;
  const banner = (): void => { if (alive) mountSecurityBanner(ctx.banners, graph, tlsRisk); };
  const checkTls = async (): Promise<void> => {
    const uses: Array<{ what: string; tls: string }> = [];
    for (const [app, d] of clientDetail) if (d.SSLConfiguration) uses.push({ what: app, tls: d.SSLConfiguration });
    await Promise.all(defs.map(async (d) => {
      try { const x = await getOAuthServerDefinition(d.ID); if (x.SSLConfiguration) uses.push({ what: d.IssuerEndpoint, tls: x.SSLConfiguration }); } catch { /* shown as unknown: no warning */ }
    }));
    const verifies = new Map<string, boolean>();
    await Promise.all([...new Set(uses.map((u) => u.tls))].map(async (n) => {
      try { verifies.set(n, (await getTlsConfig(n)).VerifyPeer !== 0); } catch { /* unknown: no warning */ }
    }));
    const bad = uses.filter((u) => verifies.get(u.tls) === false);
    const configsUsed = [...new Set(bad.map((b) => b.tls))];
    tlsRisk = bad.length ? {
      tone: 'warning',
      headline: `${plural(bad.length, 'OAuth 2.0 connection')} ${bad.length === 1 ? 'doesn’t' : 'don’t'} check the provider’s certificate (TLS configuration ${configsUsed.join(', ')}), so the provider could be impersonated.`,
      detail: `${configsUsed.join(', ')} ${configsUsed.length === 1 ? 'carries' : 'carry'} on even when the certificate fails verification, so anyone who can intercept the traffic could pose as the provider. Used by ${bad.map((b) => b.what).join(', ')}.`,
      showThem: { label: 'Open Certificates & TLS', run: () => { location.hash = '#/security/certs'; } },
    } : null;
    banner();
  };
  banner();
  getSecurityGraph().then((g) => { graph = g; banner(); }).catch(() => { /* Review loads it on demand */ });

  sessionInfo().then((info) => {
    canEdit = can(info, 'OAuth2_Client');
    canServer = info.privileges ? !!(info.privileges.OAuth2_Server?.use ?? info.privileges.OAuth2_Client?.use) : null;
    if (!alive) return;
    buildNewMenu();
    if (!editor && selected) void renderDetail();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
}
