// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Managed file transfer — connections that let interoperability
 * productions send and fetch files in a Box, Dropbox or Kiteworks account.
 *
 * A connection names the service, the account, the TLS configuration for the
 * calls, and the OAuth 2.0 client it signs in with. An administrator
 * authorizes it once in a browser; IRIS then keeps the access token.
 *
 * Everything happens here: create (with an existing OAuth 2.0 client, or a
 * new one made for it from the client ID and secret the service issued),
 * edit, authorize (the browser goes to the service's sign-in and comes back),
 * set a new client secret, revoke the access token, delete. Tested end to end
 * with throwaway osca_test_ objects; see api-crypto.ts.
 */
import '../styles-sec.css';
import '../styles-security.css';
import '../styles-secrets.css';
import '../styles-crypto.css';
import {
  getMftConnections, getMftConnection, saveMftConnection, mftExists, deleteMftConnection, revokeMftToken,
  MFT_SERVICES, MFT_DEFAULT_URL, MFT_SCOPE, cryptoDocs, getMftAuthUrl, createMftClient, mftIssuer,
  type MftSummary, type MftConnection, type MftService,
} from '../api-crypto';
import { getTlsConfigs, getOAuthServerDefinitions, getOAuthClientConfigs, setOAuthClientSecret, type TlsConfigSummary } from '../api-secrets';
import {
  kv, mono,
  esc, chip, cell, skeleton, errorPanel, liveIndicator, uniformKeys, num, emptyState, noPermissionText,
  type ScreenCtx, type GridColumn,
} from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, selectField, passwordField,
  readForm, fieldError, focusField, blockedAttrs, AdminError, type FieldProblem, type EditorHandle, type MenuHandle,
} from '../crud';
import { getSecurityGraph, type SecurityGraph } from '../api-security';
import { mountSecurityBanner } from '../security-view';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const urlOrigin = (u: string): string => { try { return new URL(u.trim()).origin; } catch { return ''; } };

type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

/** Where an OAuth 2.0 client lives, for "what else does deleting remove". */
interface OAuthClientInfo { issuer: string; serverClients: number }

const NO_PRIV = noPermissionText('%Admin_Secure', 'security administration');
const SERVICE_WORDS: Record<string, string> = {
  Box: 'Box, the cloud content service',
  Dropbox: 'Dropbox, the cloud file service',
  Kiteworks: 'Kiteworks, a self-hosted secure file-sharing server',
};
const isAuthorized = (s: MftSummary | undefined): boolean => s?.IsAuthorized === 'Authorized';
const muted = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const para = (html: string): string => `<p class="kv-text">${html}</p>`;
/** "Create one for this connection" in the OAuth 2.0 client select. */
const NEW_CLIENT = '__new';
const docs = (href: string, label: string): string =>
  `<a class="docs-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}<ev-icon name="external-link" size="xs"></ev-icon></a>`;
const note = (html: string, warn = false): string =>
  `<div class="crud-note${warn ? ' crud-note--warning' : ''}"><ev-icon name="${warn ? 'alert-triangle' : 'info'}" size="sm"></ev-icon><div>${html}</div></div>`;

const COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'Connection', width: '220px', sortable: true, renderCell: (v) => cell.id(v) },
  { key: 'Service', label: 'Service', width: '110px', sortable: true },
  { key: 'Auth', label: 'Authorization', width: '150px', sortable: true, description: 'Whether IRIS holds an access token, so productions can transfer files now',
    renderCell: (v) => (v === 'yes' ? chip('Authorized', 'success') : chip('Not authorized', 'warning', 'Authorize it before productions can use it')) },
  { key: 'Username', label: 'Account', width: '200px', sortable: true, renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('—')) },
  { key: 'Client', label: 'OAuth 2.0 client', width: '180px', sortable: true, description: 'The OAuth 2.0 client the connection signs in with',
    renderCell: (v, row) => (!v ? cell.dim('—') : row.ClientMissing ? chip(String(v), 'danger', 'No OAuth 2.0 client has this name, so the connection can’t sign in') : cell.mono(v)) },
  { key: 'Tls', label: 'TLS configuration', renderCell: (v) => (v ? cell.mono(v, true) : cell.dim('—')) },
];
const SECONDARY = ['Tls', 'Username'];
const UNIFORM = ['Service', 'Tls', 'Client'];

export function mftScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="mft-toolbar">
      <div class="search-box"><ev-search id="mft-search" size="sm" full-width placeholder="Filter by name, account or client" aria-label="Filter"></ev-search></div>
      <div class="toolbar-spacer"></div>
    </div>
    <ev-detail-panel id="mft-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="mft-wrap">${skeleton(6)}</div>
      <aside slot="detail" class="detail" id="mft-detail" aria-label="Connection details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="mft-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#mft-panel');
  const wrap = $('#mft-wrap');
  const detail = $('#mft-detail');

  let list: MftSummary[] = [];
  const details = new Map<string, MftConnection>();
  let tls: TlsConfigSummary[] = [];
  /** Application name → where the client lives; null when the lookup failed (then nothing is called missing). */
  let clients: Map<string, OAuthClientInfo> | null = null;
  let selected: string | null = null;
  let query = '';
  let grid: GridEl | null = null;
  let uniform = new Set<string>();
  let loaded = false;
  let alive = true;
  let canSecure: boolean | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  ctx.onLeave(() => { alive = false; });

  const leaveEdit = (): void => {
    ctx.beforeLeave(null);
    editor?.close(); editor = null;
    restoreWidth?.(); restoreWidth = null;
  };
  ctx.onLeave(() => { menu?.destroy(); leaveEdit(); });
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };

  const applyColumns = (): void => {
    if (!grid) return;
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => { selected = null; grid?.select([]); setPanel(false); };

  const clientMissing = (app: string): boolean => !!app && clients !== null && !clients.has(app);
  const sharing = (app: string, except: string): string[] =>
    [...details.entries()].filter(([n, d]) => n !== except && d.ApplicationName === app).map(([n]) => n);

  // ── Grid ──
  const rows = (): DataGridRow[] => list.map((s) => {
    const d = details.get(s.Name);
    return {
      Name: s.Name, Service: s.Service, Auth: isAuthorized(s) ? 'yes' : 'no',
      Username: d?.Username ?? '', Client: d?.ApplicationName ?? '', ClientMissing: clientMissing(d?.ApplicationName ?? ''),
      Tls: d?.SSLConfiguration ?? '',
    };
  });
  const matches = (r: DataGridRow): boolean => !query
    || [r.Name, r.Service, r.Username, r.Client, r.Tls].some((f) => String(f ?? '').toLowerCase().includes(query.toLowerCase()));

  const renderGrid = (): void => {
    const all = rows();
    if (!all.length) {
      grid = null;
      if (!editor) closeDetail();
      $('#mft-toolbar').hidden = true;
      wrap.innerHTML = emptyState({
        icon: 'send', title: 'No connections yet',
        what: 'A connection lets productions send and fetch files in a Box, Dropbox or Kiteworks account.',
        docs: { href: cryptoDocs.mftSetup, label: 'Learn more' },
      });
      return;
    }
    $('#mft-toolbar').hidden = false;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Managed file transfer connections');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', async (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        if (!(await mayLeave())) { grid?.select(selected !== null ? [selected] : []); return; }
        selected = name;
        renderDetail();
      });
      wrap.appendChild(grid);
    }
    uniform = all.length < 3 ? new Set<string>() : new Set([...uniformKeys(all, UNIFORM)].map(String));
    const shown = all.filter(matches);
    grid.rows = shown;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    if (!shown.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">Nothing matches “${esc(query)}”.</div>`);
  };

  /** The one Security banner: connections that can't sign in come first, then ones waiting to be authorized. */
  let graph: SecurityGraph | null = null;
  const renderBanner = (): void => {
    const missing = list.filter((s) => clientMissing(details.get(s.Name)?.ApplicationName ?? '')).map((s) => s.Name);
    const unauth = list.filter((s) => !isAuthorized(s)).map((s) => s.Name);
    const show = (names: string[]): { label: string; run: () => void } => ({ label: 'Show them', run: () => {
      query = ''; ($('#mft-search') as HTMLElement & { value: string }).value = '';
      renderGrid();
      if (names.length === 1) { selected = names[0]; renderDetail(); grid?.select([names[0]]); }
    } });
    mountSecurityBanner(ctx.banners, graph, missing.length
      ? { tone: 'danger', headline: `${missing.length === 1 ? `${missing[0]} names` : `${num(missing.length)} connections name`} an OAuth 2.0 client that doesn’t exist`, detail: 'They can’t be authorized or sign in until they point at an existing client.', showThem: show(missing) }
      : unauth.length
        ? { tone: 'warning', headline: `${unauth.length === 1 ? `${unauth[0]} isn’t` : `${num(unauth.length)} connections aren’t`} authorized yet`, detail: 'Productions can’t transfer files through them until someone authorizes them.', showThem: show(unauth) }
        : null);
  };
  getSecurityGraph().then((g) => { if (!alive) return; graph = g; renderBanner(); }).catch(() => { /* Review fetches it on demand */ });

  const renderFlags = (): void => {
    renderBanner();
    const unauth = list.filter((s) => !isAuthorized(s)).length;
    const missing = list.filter((s) => clientMissing(details.get(s.Name)?.ApplicationName ?? '')).length;
    const nClients = clients === null ? '—' : num(clients.size);
    // Short figures only; hidden while there's nothing to count.
    $('#mft-foot').innerHTML = list.length
      ? `<b>${num(list.length)}</b> connection${list.length === 1 ? '' : 's'}<span class="meta-sep">·</span>${num(list.length - unauth)} authorized${missing ? `<span class="meta-sep">·</span>${num(missing)} missing client` : ''}<span class="meta-sep">·</span>${nClients} OAuth 2.0 client${clients?.size === 1 ? '' : 's'}`
      : '';
  };

  // ── Detail ──
  const renderDetail = (): void => {
    if (selected === null) { setPanel(false); return; }
    const s = list.find((x) => x.Name === selected);
    if (!s) { closeDetail(); return; }
    const d = details.get(s.Name);
    const auth = isAuthorized(s);
    const app = d?.ApplicationName ?? '';
    const missing = clientMissing(app);
    const service = SERVICE_WORDS[s.Service] ?? s.Service;
    const editReason = canSecure === false ? NO_PRIV : null;
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">${esc(s.Service)} connection</span><h2 class="mono">${esc(s.Name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="mft-close"></ev-icon-button>
      </header>
      <div class="detail-state">${auth ? chip('Authorized', 'success') : chip('Not authorized', 'warning')}${missing ? chip('Client missing', 'danger') : ''}</div>
      <div class="detail-actions">
        <button type="button" class="btn btn--sm" id="mft-edit"${blockedAttrs(editReason)}><ev-icon name="edit-2" size="xs"></ev-icon>Edit</button>
        <button type="button" class="btn btn--sm" id="mft-auth"${blockedAttrs(editReason ?? (missing ? 'Its OAuth 2.0 client doesn’t exist, so it can’t sign in.' : null))}>${auth ? 'Authorize again' : 'Authorize'}</button>
        ${moreButton('mft-more')}
      </div>
      ${para(`Lets productions send and fetch files in a ${esc(service)} account${d?.Username ? ` (${esc(d.Username)})` : ''}. It signs in with the OAuth 2.0 client ${app ? `<span class="mono">${esc(app)}</span>` : 'it names'}.`)}
      ${missing ? `<div class="sec-callout sec-callout--danger"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>No OAuth 2.0 client is called ${esc(app)}</strong><span>So this connection can’t be authorized or sign in. Point it at an existing client, or create one for it, with Edit.</span></div></div>` : ''}
      <h3 class="detail-section">Authorization</h3>
      ${para(auth
        ? 'IRIS holds an access token for this connection, so productions can transfer files now. Revoking it stops them until someone authorizes it again.'
        : `There’s no valid access token, so productions can’t use it yet. <b>Authorize</b> takes you to ${esc(s.Service)} to sign in and grant access, then back here; IRIS keeps the token.`)}
      <h3 class="detail-section">Connection</h3>
      <dl class="kv-list">
        ${kv('Service', esc(s.Service))}
        ${kv('Base URL', d?.URL ? mono(d.URL) : muted('—'), d?.URL ?? '')}
        ${kv('Account', d?.Username ? esc(d.Username) : muted('—'), d?.Username ?? '')}
        ${kv('TLS configuration', d?.SSLConfiguration ? `<a class="link mono" href="#/security/certs" title="Open Certificates &amp; TLS">${esc(d.SSLConfiguration)}</a>` : muted('—'))}
        ${kv('OAuth 2.0 client', app ? `<a class="link mono" href="#/security/oauth" title="Open OAuth 2.0">${esc(app)}</a>` : muted('—'))}
        ${app && clients?.get(app)?.issuer ? kv('Authorization server', mono(clients.get(app)!.issuer), clients.get(app)!.issuer) : ''}
      </dl>
      <p class="kv-text">${docs(cryptoDocs.mft, 'Using managed file transfer in productions')}</p>`;
    detail.querySelector('#mft-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#mft-edit')?.addEventListener('click', () => void openEditor(s.Name));
    detail.querySelector('#mft-auth')?.addEventListener('click', (e) => { if (!(e.currentTarget as HTMLElement).hasAttribute('data-crud-blocked')) void doAuthorize(s.Name); });
    menu?.destroy();
    menu = moreMenu(detail.querySelector('#mft-more') as HTMLElement, [
      { label: 'Revoke access token', icon: 'x', disabled: !auth || canSecure === false,
        reason: canSecure === false ? NO_PRIV : 'Not authorized, so there’s no token to revoke.', onSelect: () => void doRevoke(s.Name) },
      { label: 'Set new client secret', icon: 'key-round', disabled: canSecure === false || !app || missing,
        reason: canSecure === false ? NO_PRIV : 'Its OAuth 2.0 client doesn’t exist.', onSelect: () => void openSecret(s.Name, app) },
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: canSecure === false, reason: NO_PRIV, onSelect: () => void doDelete(s.Name) },
    ]);
    setPanel(true);
  };

  // ── Create and edit ──
  const openEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    menu?.destroy(); menu = null;
    if (!name) { selected = null; grid?.select([]); }
    setPanel(true);
    restoreWidth = panelWidth(panel, 520);
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    const cur = name ? details.get(name) ?? await getMftConnection(name).catch(() => null) : null;
    const service = (cur?.Service ?? 'Box') as MftService;
    const tlsOptions = [
      { value: '', label: 'Choose a TLS configuration' },
      ...tls.filter((t) => t.Type === 'Client' || t.Name === cur?.SSLConfiguration).map((t) => ({ value: t.Name, label: t.Enabled ? t.Name : `${t.Name} (disabled)` })),
    ];
    const apps = [...new Set([...(clients?.keys() ?? []), ...(cur?.ApplicationName ? [cur.ApplicationName] : [])])].sort();
    const noClients = clients !== null && clients.size === 0;
    const clientOptions = [
      ...(noClients ? [] : [{ value: '', label: 'Choose an OAuth 2.0 client' }]),
      ...apps.map((a) => ({ value: a, label: clients?.has(a) ? a : `${a} (doesn’t exist)` })),
      { value: NEW_CLIENT, label: 'Create one for this connection' },
    ];
    const clientNow = cur?.ApplicationName ?? (noClients ? NEW_CLIENT : '');

    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : 'New connection',
      name: name ?? 'the new connection',
      submitLabel: name ? 'Save changes' : 'Create connection',
      sections:
        section('Connection',
          (name ? '' : textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'How productions refer to it. Fixed once created.' })) +
          (name ? `<p class="crud-section-hint">Service: <b>${esc(service)}</b>. The service can’t be changed; create a new connection instead.</p>`
            : selectField('Service', 'Service', MFT_SERVICES.map((v) => ({ value: v, label: v })), service)) +
          textField('URL', 'Base URL', cur ? cur.URL : MFT_DEFAULT_URL[service], { required: true, mono: true, placeholder: 'https://', hint: 'The service’s API address. Box and Dropbox have a standard one; for Kiteworks use your own server’s.' }) +
          textField('Username', 'Account email', cur?.Username ?? '', { required: true, autocomplete: 'off', hint: 'The email address of the account the connection works as.' })) +
        section('Signing in',
          selectField('SSLConfiguration', 'TLS configuration', tlsOptions, cur?.SSLConfiguration ?? '', { required: true, searchable: tlsOptions.length > 8, hint: 'A client TLS configuration, used for every call to the service.' }) +
          selectField('ApplicationName', 'OAuth 2.0 client', clientOptions, clientNow, { required: true, searchable: clientOptions.length > 8, hint: 'The client registered with the service for this connection.' }) +
          `<div data-new-client>
            ${textField('ClientId', 'Client ID', '', { mono: true, hint: 'From the app you registered with the service.' })}
            ${passwordField('ClientSecret', 'Client secret', { hint: 'Stored by IRIS and never shown again.' })}
            ${textField('RedirectBase', 'Address users come back to', location.origin, { mono: true, hint: 'The address you reach IRIS at. The service must list the redirect URL below.' })}
            <p class="w-preview" id="mft-redirect" aria-live="polite"></p>
          </div>`) +
        (name ? '' : note('After it’s created, authorize it once: you sign in to the service in the browser and IRIS keeps the access token.')),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (n.length > 64) out.push({ field: 'Name', label: 'Name', message: 'Use 64 characters or fewer' });
          else if (list.some((c) => c.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A connection with this name already exists' });
        }
        const url = String(v.URL ?? '').trim();
        if (!url) out.push({ field: 'URL', label: 'Base URL', message: 'Enter the service’s API address' });
        else if (!/^https:\/\/[^\s/]+/i.test(url)) out.push({ field: 'URL', label: 'Base URL', message: 'Enter a full https:// address' });
        if (!String(v.Username ?? '').trim()) out.push({ field: 'Username', label: 'Account email', message: 'Enter the account’s email address' });
        if (!v.SSLConfiguration) out.push({ field: 'SSLConfiguration', label: 'TLS configuration', message: 'Choose a TLS configuration' });
        const app = String(v.ApplicationName ?? '');
        if (!app) out.push({ field: 'ApplicationName', label: 'OAuth 2.0 client', message: 'Choose the OAuth 2.0 client' });
        else if (app === NEW_CLIENT) {
          const clientName = name ?? String(v.Name ?? '').trim();
          if (clientName && clients?.has(clientName)) out.push({ field: 'ApplicationName', label: 'OAuth 2.0 client', message: `A client called ${clientName} already exists; choose it instead` });
          if (!String(v.ClientId ?? '').trim()) out.push({ field: 'ClientId', label: 'Client ID', message: 'Enter the client ID the service issued' });
          if (!v.ClientSecret) out.push({ field: 'ClientSecret', label: 'Client secret', message: 'Enter the client secret the service issued' });
          const rb = String(v.RedirectBase ?? '').trim();
          if (!/^https?:\/\/[^\s/]+/i.test(rb)) out.push({ field: 'RedirectBase', label: 'Address users come back to', message: 'Enter a full http(s):// address' });
        }
        else if (clients !== null && !clients.has(app) && app !== cur?.ApplicationName) out.push({ field: 'ApplicationName', label: 'OAuth 2.0 client', message: 'This client doesn’t exist; choose another' });
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        if (!name && await mftExists(target)) {
          fieldError(detail, 'Name', 'A connection with this name already exists');
          focusField(detail, 'Name');
          throw new AdminError('A connection with this name already exists.', 409);
        }
        const svc = (name ? service : String(v.Service)) as MftService;
        let app = String(v.ApplicationName ?? '');
        if (app === NEW_CLIENT) {
          // The client is named after the connection, as IRIS's own setup does.
          app = await createMftClient({
            service: svc, name: target, tls: String(v.SSLConfiguration), clientId: String(v.ClientId).trim(),
            clientSecret: String(v.ClientSecret), redirectBase: String(v.RedirectBase).trim(), kiteworksServer: urlOrigin(String(v.URL)),
          });
          clients = await loadClients();
        }
        const body: Partial<MftConnection> = {
          URL: String(v.URL).trim(), SSLConfiguration: String(v.SSLConfiguration), Username: String(v.Username).trim(), ApplicationName: app,
        };
        if (!name) body.Service = svc;
        await saveMftConnection(target, body);
        leaveEdit();
        selected = target;
        await load();
        toast(name ? `Connection ${target} saved.` : `Connection ${target} created. Authorize it before productions use it.`);
      },
      onCancel: () => { leaveEdit(); if (name) renderDetail(); else closeDetail(); },
    });

    // The new-client fields show only when "Create one for this connection" is chosen.
    const syncClient = (): void => {
      const v = readForm(detail);
      const box = detail.querySelector<HTMLElement>('[data-new-client]');
      if (box) box.hidden = v.ApplicationName !== NEW_CLIENT;
      const svc = (name ? service : String(v.Service ?? service)) as MftService;
      const rb = String(v.RedirectBase ?? '').trim().replace(/\/+$/, '');
      const pre = detail.querySelector('#mft-redirect');
      if (pre) {
        const iss = mftIssuer(svc, urlOrigin(String(v.URL ?? ''))).issuer;
        pre.textContent = rb ? `Redirect URL to register with ${svc}: ${rb}/csp/sys/oauth2/OAuth2.Response.cls${svc === 'Kiteworks' && iss ? ` · signs in at ${iss}` : ''}` : '';
      }
    };
    for (const ev of ['ev-select-change', 'ev-input-input']) detail.addEventListener(ev, syncClient);
    syncClient();

    // New connection: the base URL follows the service until someone edits it.
    if (!name) {
      const urlEl = detail.querySelector('ev-input[name="URL"]') as (HTMLElement & { value: string }) | null;
      let lastDefault = MFT_DEFAULT_URL[service];
      detail.querySelector('ev-select[name="Service"]')?.addEventListener('ev-select-change', () => {
        const next = String(readForm(detail).Service) as MftService;
        if (urlEl && (urlEl.value === lastDefault || !urlEl.value)) urlEl.value = MFT_DEFAULT_URL[next] ?? '';
        lastDefault = MFT_DEFAULT_URL[next] ?? '';
        editor?.refresh();
      });
    }
  };

  // ── Authorize, new secret ──
  /** Sends the browser to the service's sign-in; it comes back to this screen with IRIS holding the token. */
  const doAuthorize = async (name: string): Promise<void> => {
    if (!(await mayLeave())) return;
    const svc = (list.find((s) => s.Name === name)?.Service ?? 'Box') as MftService;
    try {
      const url = await getMftAuthUrl(name, `${location.origin}${location.pathname}#/security/mft`, MFT_SCOPE[svc] ?? '');
      if (!url) throw new Error('IRIS didn’t return a sign-in address.');
      location.assign(url);
    } catch (err) { toast(`Couldn’t start authorization. ${errorText(err)}`, 'danger'); }
  };
  const openSecret = async (conn: string, app: string): Promise<void> => {
    if (!(await mayLeave())) return;
    menu?.destroy(); menu = null;
    setPanel(true);
    restoreWidth = panelWidth(panel, 520);
    editor = editorShell(detail, {
      title: `New client secret for <span class="mono">${esc(app)}</span>`,
      subtitle: `Used by ${esc(conn)}`,
      name: app,
      submitLabel: 'Set secret',
      sections: section('Secret', passwordField('Secret', 'Client secret', { required: true }) + passwordField('Secret2', 'Confirm'),
        { hint: 'Replaces the current secret. Copy it from the service; it’s never shown here.' }),
      check: () => {
        const v = readForm(detail);
        if (!v.Secret) return [{ field: 'Secret', label: 'Client secret', message: 'Enter the secret' }];
        if (!v.Secret2) return [{ field: 'Secret2', label: 'Confirm', message: 'Enter it again' }];
        if (v.Secret !== v.Secret2) return [{ field: 'Secret2', label: 'Confirm', message: 'The two don’t match' }];
        return [];
      },
      onSubmit: async (v) => {
        await setOAuthClientSecret(app, String(v.Secret));
        leaveEdit();
        renderDetail();
        toast(`New client secret set for ${app}.`);
      },
      onCancel: () => { leaveEdit(); renderDetail(); },
    });
  };

  // ── Revoke and delete ──
  const doRevoke = async (name: string): Promise<void> => {
    if (!(await mayLeave())) return;
    const ok = await confirm({
      title: `Revoke access for ${name}?`,
      body: `<p>IRIS discards the access token for <b class="mono">${esc(name)}</b>. Productions that use it can’t transfer files until someone authorizes it again.</p>`,
      confirmLabel: 'Revoke access token',
      danger: true,
    });
    if (!ok) return;
    try { await revokeMftToken(name); } catch (err) { toast(`Couldn’t revoke the token. ${errorText(err)}`, 'danger'); return; }
    await load();
    toast(`Access token for ${name} revoked. Authorize it again to resume transfers.`);
  };

  const doDelete = async (name: string): Promise<void> => {
    if (!(await mayLeave())) return;
    const d = details.get(name);
    const app = d?.ApplicationName ?? '';
    const info = app ? clients?.get(app) : undefined;
    const others = app ? sharing(app, name) : [];
    const takesClient = !!info && others.length === 0;
    const takesServer = takesClient && info.serverClients <= 1;
    const body = [
      `<p>Productions that use <b class="mono">${esc(name)}</b> stop being able to transfer files. Files already in the ${esc(d?.Service ?? 'service')} account aren’t touched.</p>`,
      takesClient ? `<p><strong>IRIS also deletes the OAuth 2.0 client <span class="mono">${esc(app)}</span></strong>, including its client ID and secret, because no other connection uses it${takesServer ? `, and the authorization server definition for <span class="mono">${esc(info.issuer)}</span>, which has no other clients` : ''}.</p>` : '',
      others.length ? `<p>Its OAuth 2.0 client <span class="mono">${esc(app)}</span> is kept: ${others.map((o) => `<span class="mono">${esc(o)}</span>`).join(', ')} also ${others.length === 1 ? 'uses' : 'use'} it.</p>` : '',
      '<p>This can’t be undone.</p>',
    ].join('');
    const ok = await confirm({
      title: `Delete ${name}?`, body, confirmLabel: 'Delete connection', danger: true,
      typeToConfirm: takesClient || isAuthorized(list.find((s) => s.Name === name)) ? name : undefined,
    });
    if (!ok) return;
    try { await deleteMftConnection(name); } catch (err) { toast(`Couldn’t delete ${name}. ${errorText(err)}`, 'danger'); return; }
    closeDetail();
    await load();
    toast(takesClient ? `Connection ${name} and its OAuth 2.0 client deleted.` : `Connection ${name} deleted.`);
  };

  // ── Load ──
  const loadClients = async (): Promise<Map<string, OAuthClientInfo> | null> => {
    try {
      const servers = await getOAuthServerDefinitions();
      const per = await Promise.all(servers.map((s) => getOAuthClientConfigs(s.ID).then((cs) => cs.map((c) => [c.ApplicationName, { issuer: s.IssuerEndpoint, serverClients: s.ClientCount }] as const))));
      return new Map(per.flat());
    } catch { return null; }
  };

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  const load = async (): Promise<void> => {
    try {
      const [l, t, c] = await Promise.all([getMftConnections(), getTlsConfigs().catch(() => []), loadClients()]);
      const got = await Promise.allSettled(l.map((s) => getMftConnection(s.Name)));
      if (!alive) return;
      list = l; tls = t; clients = c;
      details.clear();
      got.forEach((r, i) => { if (r.status === 'fulfilled') details.set(l[i].Name, r.value); });
      loaded = true;
      updated(new Date());
      renderGrid();
      renderFlags();
      setNewState();
      if (!editor) renderDetail();
    } catch (err) {
      if (!alive) return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-mft');
      wrap.querySelector('#retry-mft')?.addEventListener('click', () => void load());
    }
  };

  const newBtn = newButton(ctx, 'New connection', () => void openEditor(null));
  const setNewState = (): void => { newBtn.setHidden(canSecure === false); };
  $('#mft-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });

  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    setNewState();
    if (loaded && !editor) renderDetail();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
}
