// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › ECP — distributed caching. One screen for both sides:
 *  - Data servers: other instances whose databases this one uses (this
 *    instance is their application server).
 *  - Application servers: instances using this one's databases (this instance
 *    is their data server), and certificates waiting for TLS approval.
 *
 * Actions (Use on %Admin_Manage): add, edit and delete data servers, connect /
 * disconnect / disable them, and authorize, reject or remove TLS approvals.
 * Data-server create, edit, disable, disconnect and delete ran live once on
 * a test server (OSCA_TEST_ECP, removed); connect and the TLS actions are
 * built from the endpoint source. ECP settings are edited in the Management
 * Portal.
 */
import '../styles-security.css';
import '../styles-sys.css';
import '../styles-ops.css';
import {
  getEcpSettings, getEcpDataServers, getEcpDataServerDbs, getEcpAppServers, getEcpTls, getEcpDashboard, getEcpService,
  saveEcpDataServer, deleteEcpDataServer, ecpDataServerAction, authorizeEcpTls, rejectEcpTls, removeEcpTls,
  sysDocs, sysPortal, 
  type EcpSettings, type EcpDataServer, type EcpAppServer, type EcpTlsConnection, type EcpDashboard,
} from '../api-sys';
import { linkTo } from '../api-security';
import { plural, kv, mono, portalButton, setSearch,
  esc, chip, cell, num, compact, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, viewTabs, bindViewTabs, setViewTabCount,
  type ScreenCtx, type Tone, type GridColumn,
} from '../ui';
import {
  AdminError, blockedAttrs, confirm, editorShell, errorText, fieldError, moreButton, moreMenu, newButton, panelWidth, readForm,
  section, textField, checkField, toast, scrollPanelTop, type EditorHandle, type FieldProblem, type MenuHandle,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
type View = 'data' | 'app' | 'tls';

const REFRESH_MS = 10_000;
const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');
const dimText = (s: string): string => `<span class="dim">${esc(s)}</span>`;

/** Data-server connection states, as IRIS reports them. */
function dsState(s: string): { tone: Tone; text: string; connected: boolean } {
  switch (s) {
    case 'Normal': return { tone: 'success', text: 'Connected and working.', connected: true };
    case 'Trouble': return { tone: 'danger', text: 'The connection has stopped answering. IRIS keeps trying; processes that need its data wait.', connected: true };
    case 'Recovery': return { tone: 'warning', text: 'The connection came back and IRIS is recovering work that was in flight.', connected: true };
    case 'Connection in Progress': return { tone: 'warning', text: 'IRIS is connecting.', connected: true };
    case 'Initializing': return { tone: 'warning', text: 'IRIS is setting the connection up.', connected: true };
    case 'Connection Failed': return { tone: 'danger', text: 'The last attempt to connect failed. Check the address, the port, and that ECP is on at the other end.', connected: false };
    case 'Disabled': return { tone: 'neutral', text: 'Switched off: IRIS won’t connect, even when code needs its databases.', connected: false };
    case 'Not Connected': return { tone: 'neutral', text: 'Not connected. IRIS connects the first time code uses one of its databases.', connected: false };
    default: return { tone: 'neutral', text: s ? `IRIS reports “${s}”.` : 'IRIS reports no state.', connected: false };
  }
}
const asTone = (s: string): Tone => (s === 'Normal' ? 'success' : s === 'Trouble' ? 'danger' : s === 'Recovering' || s === 'Restart' ? 'warning' : 'neutral');
const TLS_MODE = ['Not used', 'Allowed', 'Required'];

export function ecpScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <section class="sys-summary" id="ecp-summary" aria-label="ECP at a glance" hidden>
      <dl class="sys-facts" id="ecp-facts"></dl>
    </section>
    ${viewTabs('ecp-view', [{ value: 'data', label: 'Data servers' }, { value: 'app', label: 'Application servers' }, { value: 'tls', label: 'TLS approvals' }], 'data')}
    <div class="toolbar-row" id="ecp-toolbar">
      <div class="search-box"><ev-search id="ecp-search" size="sm" full-width placeholder="Filter by name or address" aria-label="Filter"></ev-search></div>
    </div>
    <ev-detail-panel id="ecp-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="ecp-wrap">${skeleton(4)}</div>
      <aside slot="detail" class="detail" id="ecp-detail" aria-label="ECP connection"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="ecp-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#ecp-panel');
  const wrap = $('#ecp-wrap');
  const detail = $('#ecp-detail');
  const searchEl = $<HTMLElement & { value: string }>('#ecp-search');

  let alive = true;
  let settings: EcpSettings | null = null;
  let dataServers: EcpDataServer[] = [];
  let appServers: EcpAppServer[] = [];
  let tls: EcpTlsConnection[] = [];
  let dash: EcpDashboard | null = null;
  let serviceOn: boolean | null = null;
  const dbs = new Map<string, Array<{ Name: string; Directory: string }> | { error: string }>();
  let loaded = false;
  let view: View = 'data';
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let gridView: View | null = null;
  let rowSig = '';
  let shownHtml = '';
  let factsHtml = '';
  let canManage: boolean | null = null;
  let busy: string | null = null;
  let menu: MenuHandle | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; shownHtml = ''; };
  const mayLeave = async (): Promise<boolean> => { if (editor && !(await editor.guard())) return false; leaveEdit(); return true; };
  const followUps: number[] = [];
  ctx.onLeave(() => { alive = false; leaveEdit(); menu?.destroy(); followUps.forEach(clearTimeout); });
  const blocked = (): string | null => (canManage === false ? NO_MANAGE : null);

  // ── Summary ──
  const renderFacts = (): void => {
    const s = settings;
    const fig = (label: string, value: string, caption: string, tone: Tone = 'neutral'): string =>
      `<div class="sys-fig" data-tone="${tone}"><dt>${esc(label)}</dt><dd>${esc(value)}</dd><small>${esc(caption)}</small></div>`;
    const up = dataServers.filter((d) => d.Status === 'Normal').length;
    const bad = dataServers.filter((d) => dsState(d.Status).tone === 'danger').length;
    const a = dash?.AppServer;
    const d = dash?.DataServer;
    const pending = tls.filter((x) => x.Status === 'Pending').length;
    const html = `
      ${fig('Data servers', num(dataServers.length), bad ? `${num(bad)} not answering` : `${num(up)} connected${s ? ` · max ${num(s.AppServerSettings.MaxServers)}` : ''}`, bad ? 'danger' : 'neutral')}
      ${fig('Application servers', serviceOn === false ? 'Service off' : num(appServers.length), s ? `max ${num(s.DataServerSettings.MaxServerConn)}` : '—')}
      ${fig('Incoming TLS', s ? TLS_MODE[s.DataServerSettings.SSLECPServer] ?? String(s.DataServerSettings.SSLECPServer) : '—', pending ? `${num(pending)} waiting for approval` : `${num(tls.length)} certificates`, pending ? 'warning' : 'neutral')}
      ${fig('Remote global refs', a ? compact(a.GloRefRemote) : '—', d ? `${compact(d.ReqRcvd)} requests served` : '—')}`;
    if (html === factsHtml) return;
    factsHtml = html;
    $('#ecp-facts').innerHTML = html;
  };
  const noneConfigured = (): boolean => !dataServers.length && !appServers.length && !tls.length;

  const renderBanner = (): void => {
    const bad = dataServers.filter((d) => dsState(d.Status).tone === 'danger');
    const pending = tls.filter((x) => x.Status === 'Pending');
    const top = bad.length
      ? { tone: 'danger', title: bad.length === 1 ? `Data server ${bad[0].Name} isn’t answering` : `${bad.length} data servers aren’t answering`, text: 'Code that reads or writes their databases waits or fails until the connection is back.', view: 'data' as View, name: bad[0].Name }
      : pending.length
        ? { tone: 'warning', title: pending.length === 1 ? 'An application server is waiting for TLS approval' : `${pending.length} application servers are waiting for TLS approval`, text: 'They can’t use this instance’s databases until you authorize their certificate.', view: 'tls' as View, name: pending[0].SSLComputerName }
        : null;
    if (!top) { ctx.banners.innerHTML = ''; return; }
    ctx.banners.innerHTML = `<div class="sec-callout sec-callout--${top.tone} sec-banner" role="status">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <div><strong>${esc(top.title)}</strong><span>${esc(top.text)}</span></div>
      <div class="sec-banner-actions"><button type="button" class="btn btn--sm" id="ecp-show">Show ${top.view === 'tls' ? 'them' : 'it'}</button></div>
    </div>`;
    ctx.banners.querySelector('#ecp-show')?.addEventListener('click', () => void goTo(top.view, top.name));
  };

  // ── Grids ──
  const DATA_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Name', width: '170px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Address', label: 'Address', width: '200px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Status', label: 'State', width: '180px', sortable: true, renderCell: (v) => chip(String(v || 'Unknown'), dsState(String(v)).tone) },
    { key: 'Kind', label: 'Connection', sortable: true, description: 'Mirror: follows whichever mirror member is primary. TLS: the connection is encrypted', renderCell: (v) => cell.text(v) },
  ];
  const APP_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Application server', width: '220px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Address', label: 'Address', width: '200px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Status', label: 'State', sortable: true, renderCell: (v) => chip(String(v || 'Unknown'), asTone(String(v))) },
  ];
  const TLS_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Certificate (distinguished name)', width: '360px', sortable: true, renderCell: (v) => cell.mono(v, false, String(v)) },
    { key: 'Address', label: 'From', width: '160px', sortable: true, renderCell: (v) => (v ? cell.mono(v) : cell.dim('—')) },
    { key: 'Status', label: 'State', sortable: true, renderCell: (v) => (v === 'Pending' ? chip('Waiting for approval', 'warning') : chip('Authorized', 'success')) },
  ];
  const columnsFor = (v: View): GridColumn[] => (v === 'data' ? DATA_COLUMNS : v === 'app' ? APP_COLUMNS : TLS_COLUMNS);
  const kindWords = (d: EcpDataServer): string => [d.MirrorConnection ? 'Mirror' : 'Direct', d.SSLConfig ? 'TLS' : '', d.BatchMode ? 'Batch' : ''].filter(Boolean).join(' · ');
  const rowsFor = (v: View): DataGridRow[] => {
    const ql = query.toLowerCase();
    const hit = (...xs: unknown[]): boolean => !ql || xs.some((x) => String(x ?? '').toLowerCase().includes(ql));
    if (v === 'data') return dataServers.filter((d) => hit(d.Name, d.RemoteAddress, d.RemotePort, d.Status)).map((d) => ({ Name: d.Name, Address: `${d.RemoteAddress}:${d.RemotePort}`, Status: d.Status, Kind: kindWords(d) }));
    if (v === 'app') return appServers.filter((a) => hit(a.ClientName, a.IPAddress, a.Status)).map((a) => ({ Name: a.ClientName, Address: a.IPAddress ? `${a.IPAddress}${a.IPPort ? `:${a.IPPort}` : ''}` : '', Status: a.Status }));
    return tls.filter((t) => hit(t.SSLComputerName, t.ClientIP, t.Status)).map((t) => ({ Name: t.SSLComputerName, Address: t.ClientIP, Status: t.Status }));
  };
  const countOf = (v: View): number => (v === 'data' ? dataServers.length : v === 'app' ? appServers.length : tls.length);

  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => { leaveEdit(); selected = null; shownHtml = ''; grid?.select([]); setPanel(false); };

  const renderTabs = (): void => {
    setViewTabCount(ctx.body, 'ecp-view', 'data', dataServers.length);
    setViewTabCount(ctx.body, 'ecp-view', 'app', appServers.length);
    setViewTabCount(ctx.body, 'ecp-view', 'tls', tls.length);
    newBtn.setHidden(canManage === false || view !== 'data');
  };

  const renderGrid = (): void => {
    if (!countOf(view)) {
      grid = null; gridView = null; rowSig = '';
      $('#ecp-toolbar').hidden = true;
      const docs = { href: sysDocs.ecp, label: 'About distributed caching' };
      // Opens Services with the ECP service selected; the switch itself stays there, where its consequences are explained.
      const servicesLink = serviceOn === false ? '<button type="button" class="btn btn--sm ops-btn-28" data-ecp-service>Turn on ECP service</button>' : undefined;
      wrap.innerHTML = view === 'data'
        ? emptyState({ icon: 'globe', title: noneConfigured() ? 'ECP isn’t set up' : 'No data servers',
          what: 'Add a data server to use another instance’s databases here over ECP.', action: noneConfigured() ? servicesLink : undefined, docs })
        : view === 'app'
          ? emptyState({ icon: 'globe', title: 'No application servers connected',
            what: serviceOn === false ? 'The ECP service is off, so no other instance can use this one’s databases.' : 'No other instance is using this one’s databases right now.',
            action: servicesLink, docs })
          : emptyState({ icon: 'key-round', title: 'No TLS approvals',
            what: 'Certificates from application servers wait here for approval the first time they connect.', docs });
      wrap.querySelector('[data-ecp-service]')?.addEventListener('click', () => linkTo(ctx.navigate, 'security/services' as 'security/users', '%Service_ECP'));
      return;
    }
    $('#ecp-toolbar').hidden = false;
    setSearch(searchEl, countOf(view), { query });
    if (!grid || gridView !== view) {
      wrap.innerHTML = '';
      rowSig = '';
      gridView = view;
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', view === 'data' ? 'Data servers' : view === 'app' ? 'Application servers' : 'TLS approvals');
      grid.columns = columnsFor(view);
      grid.addEventListener('ev-data-grid-row-click', (e) => void select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name)));
      wrap.appendChild(grid);
    }
    const list = rowsFor(view);
    const sig = JSON.stringify(list);
    if (sig !== rowSig) { rowSig = sig; grid.rows = list; }
    if (selected) grid.select([selected]);
    wrap.querySelector('.sys-empty')?.remove();
    grid.hidden = !list.length;
    if (!list.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="sys-empty">${emptyState({ icon: 'search', title: `Nothing matches “${query}”`, what: 'Try another name or address.',
        action: '<button type="button" class="btn btn--sm" data-ecp-clear>Show all</button>' })}</div>`);
      wrap.querySelector('[data-ecp-clear]')?.addEventListener('click', () => { query = ''; searchEl.value = ''; renderGrid(); });
    }
  };

  const renderFoot = (): void => {
    const sep = '<span class="meta-sep">·</span>';
    const el = $('#ecp-foot');
    if (view === 'data') el.innerHTML = `<b>${num(dataServers.length)}</b> data server${dataServers.length === 1 ? '' : 's'}${sep}<b>${num(dataServers.filter((d) => d.Status === 'Normal').length)}</b> connected`;
    else if (view === 'app') el.innerHTML = `<b>${num(appServers.length)}</b> application server${appServers.length === 1 ? '' : 's'} connected${settings ? `${sep}up to ${num(settings.DataServerSettings.MaxServerConn)}` : ''}`;
    else el.innerHTML = `<b>${num(tls.filter((t) => t.Status === 'Pending').length)}</b> waiting${sep}<b>${num(tls.filter((t) => t.Status === 'Authorized').length)}</b> authorized`;
  };

  // ── Detail ──
  const select = async (name: string): Promise<void> => {
    if (!(await mayLeave())) { if (selected) grid?.select([selected]); return; }
    selected = name;
    shownHtml = '';
    if (view === 'data') void fetchDbs(name);
    grid?.select([name]);
    renderDetail();
  };
  const goTo = async (v: View, name: string): Promise<void> => {
    if (!(await mayLeave())) return;
    if (view !== v) {
      view = v;
      ctx.body.querySelectorAll<HTMLElement>('#ecp-view button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === v)));
      query = ''; searchEl.value = '';
      renderTabs(); renderFoot();
    }
    renderGrid();
    await select(name);
  };
  const fetchDbs = async (name: string): Promise<void> => {
    try { dbs.set(name, (await getEcpDataServerDbs(name)) as Array<{ Name: string; Directory: string }>); } catch (err) { dbs.set(name, { error: errorText(err) }); }
    if (alive && selected === name && view === 'data' && !editor) renderDetail();
  };

  const renderDetail = (): void => {
    if (editor) return;
    if (view === 'data') renderDataServer();
    else if (view === 'app') renderAppServer();
    else renderTls();
  };

  const paintDetail = (html: string, bind: () => void): void => {
    setPanel(true);
    if (html === shownHtml) return;
    shownHtml = html;
    detail.innerHTML = html;
    detail.querySelector('#ecp-close')?.addEventListener('click', closeDetail);
    bind();
  };
  const head = (kicker: string, name: string): string => `
    <header class="detail-head">
      <div class="detail-title"><span class="detail-kicker">${esc(kicker)}</span><h2 class="mono">${esc(name)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="ecp-close"></ev-icon-button>
    </header>`;

  const renderDataServer = (): void => {
    const d = dataServers.find((x) => x.Name === selected);
    if (!d) { closeDetail(); return; }
    const st = dsState(d.Status);
    const working = busy === d.Name;
    const why = blocked() ?? (working ? 'Working…' : null);
    const list = dbs.get(d.Name);
    const dbList = Array.isArray(list) ? list : [];
    const primary = st.connected
      ? `<button type="button" class="btn btn--sm" id="ecp-disconnect"${blockedAttrs(why)}>${working ? '<ev-spinner size="sm"></ev-spinner>' : ''}Disconnect…</button>`
      : `<button type="button" class="btn btn--sm" id="ecp-connect"${blockedAttrs(why)}>${working ? '<ev-spinner size="sm"></ev-spinner>' : ''}Connect</button>`;
    const html = `${head('Data server', d.Name)}
      <div class="detail-state">${chip(d.Status || 'Unknown', st.tone)}</div>
      <div class="detail-actions">
        ${primary}
        <button type="button" class="btn btn--sm" id="ecp-edit"${blockedAttrs(blocked())}>Edit</button>
        ${moreButton('ecp-more', `More actions for ${d.Name}`)}
      </div>
      ${canManage === false ? `<p class="detail-note">${esc(NO_MANAGE)}</p>` : ''}
      <p class="sys-text">${esc(st.text)}</p>
      <h3 class="detail-section">Connection</h3>
      <dl class="kv-list">
        ${kv('Address', mono(d.RemoteAddress))}
        ${kv('Port', mono(d.RemotePort))}
        ${kv('Mirror', d.MirrorConnection ? 'Follows the primary mirror member' : 'No: connects to this address only')}
        ${kv('TLS', d.SSLConfig ? 'Encrypted' : 'Not encrypted')}
        ${kv('Batch mode', d.BatchMode ? 'On: bulk work, kept out of the cache' : 'Off')}
      </dl>
      <h3 class="detail-section">Its databases used here</h3>
      ${!list ? '<p class="sys-none">Loading…</p>' : 'error' in list ? `<p class="sys-none">${esc(list.error)}</p>`
        : dbList.length ? `<ul class="sys-list">${dbList.map((x) => `<li><span class="mono">${esc(x.Name)}</span><span class="mono" title="${esc(x.Directory)}">${esc(x.Directory)}</span></li>`).join('')}</ul>`
          : '<p class="sys-none">None yet. Add a remote database that points at this server to use its data.</p>'}`;
    paintDetail(html, () => {
      detail.querySelector('#ecp-connect')?.addEventListener('click', () => void act(d, 3));
      detail.querySelector('#ecp-disconnect')?.addEventListener('click', () => void act(d, 1));
      detail.querySelector('#ecp-edit')?.addEventListener('click', () => void openEditor(d.Name));
      menu?.destroy();
      const more = detail.querySelector<HTMLElement>('#ecp-more');
      if (more) {
        const w = why ?? undefined;
        const inUse = dbList.length ? `IRIS won’t delete it while ${plural(dbList.length, 'remote database')} use${dbList.length === 1 ? 's' : ''} it.` : undefined;
        menu = moreMenu(more, [
          { label: 'Disable…', icon: 'x', disabled: !!w || d.Status === 'Disabled', reason: w ?? (d.Status === 'Disabled' ? 'It’s already disabled.' : undefined), onSelect: () => void act(d, 2) },
          { label: 'Open in Management Portal', icon: 'external-link', onSelect: () => window.open(sysPortal.ecpDataServers, '_blank', 'noopener') },
          { label: 'ECP settings', icon: 'external-link', onSelect: () => window.open(sysPortal.ecp, '_blank', 'noopener') },
          { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!(w ?? inUse), reason: w ?? inUse, onSelect: () => void doDelete(d) },
        ]);
      }
    });
  };

  const renderAppServer = (): void => {
    const a = appServers.find((x) => x.ClientName === selected);
    if (!a) { closeDetail(); return; }
    const html = `${head('Application server', a.ClientName)}
      <div class="detail-state">${chip(a.Status || 'Unknown', asTone(a.Status))}</div>
      <div class="detail-actions">${portalButton(sysPortal.ecpAppServers, 'Management Portal')}${portalButton(sysPortal.ecp, 'ECP settings')}</div>
      <p class="sys-text">This instance uses this one’s databases over ECP. It connects and disconnects itself; there is nothing to change on this side.</p>
      <h3 class="detail-section">Connection</h3>
      <dl class="kv-list">
        ${kv('Address', a.IPAddress ? mono(a.IPAddress) : dimText('Not recorded'))}
        ${kv('Port', a.IPPort ? mono(a.IPPort) : dimText('Not recorded'))}
      </dl>`;
    paintDetail(html, () => { /* read only */ });
  };

  const renderTls = (): void => {
    const t = tls.find((x) => x.SSLComputerName === selected);
    if (!t) { closeDetail(); return; }
    const why = blocked() ?? (busy === t.SSLComputerName ? 'Working…' : null);
    const pending = t.Status === 'Pending';
    const html = `${head(pending ? 'Waiting for TLS approval' : 'Authorized certificate', t.SSLComputerName)}
      <div class="detail-state">${pending ? chip('Waiting for approval', 'warning') : chip('Authorized', 'success')}</div>
      <div class="detail-actions">
        ${pending
          ? `<button type="button" class="btn btn--sm" id="ecp-auth"${blockedAttrs(why)}><ev-icon name="check" size="xs"></ev-icon>Authorize</button>
             <button type="button" class="btn btn--sm" id="ecp-reject"${blockedAttrs(why)}>Reject…</button>`
          : `<button type="button" class="btn btn--sm" id="ecp-remove"${blockedAttrs(why)}>Remove…</button>`}
      </div>
      ${canManage === false ? `<p class="detail-note">${esc(NO_MANAGE)}</p>` : ''}
      <p class="sys-text">${pending
        ? 'An application server presented this certificate. Authorize it only if you recognise the machine: once authorized, it can use this instance’s databases.'
        : 'Application servers presenting this certificate can connect without asking again.'}</p>
      <h3 class="detail-section">Certificate</h3>
      <dl class="kv-list">
        ${kv('Distinguished name', mono(t.SSLComputerName), t.SSLComputerName)}
        ${kv('From', t.ClientIP ? mono(t.ClientIP) : dimText('Not recorded'))}
      </dl>`;
    paintDetail(html, () => {
      detail.querySelector('#ecp-auth')?.addEventListener('click', () => void tlsAct(t, 'authorize'));
      detail.querySelector('#ecp-reject')?.addEventListener('click', () => void tlsAct(t, 'reject'));
      detail.querySelector('#ecp-remove')?.addEventListener('click', () => void tlsAct(t, 'remove'));
    });
  };

  // ── Actions ──
  /** IRIS runs connection changes in the background: re-read a few times so the new state shows. */
  const followUp = (): void => { for (const ms of [1500, 4000, 8000]) followUps.push(window.setTimeout(() => { if (alive) void load(); }, ms)); };
  const act = async (d: EcpDataServer, action: 1 | 2 | 3): Promise<void> => {
    if (action !== 3) {
      const users = dbs.get(d.Name);
      const n = Array.isArray(users) ? users.length : 0;
      const ok = await confirm({
        title: action === 1 ? `Disconnect from ${d.Name}?` : `Disable ${d.Name}?`,
        body: `<p>${action === 1
          ? 'IRIS closes the connection. It connects again the next time code uses one of this server’s databases.'
          : 'IRIS closes the connection and won’t reconnect, even when code needs this server’s databases, until you connect it again.'}</p>
          <p>${n ? `Code using its ${plural(n, 'remote database')} gets errors${action === 1 ? ' until it reconnects' : ''}. ` : ''}Work in progress on it is rolled back.</p>`,
        confirmLabel: action === 1 ? 'Disconnect' : 'Disable',
        danger: action === 2,
      });
      if (!ok) return;
    }
    busy = d.Name;
    shownHtml = '';
    renderDetail();
    try {
      await ecpDataServerAction(d.Name, action);
      toast(action === 3 ? `Connecting to ${d.Name}…` : action === 1 ? `Disconnecting from ${d.Name}…` : `Disabling ${d.Name}…`, 'info');
      followUp();
    } catch (err) {
      if (err instanceof AdminError && err.status === 409) toast(`IRIS can’t do that while ${d.Name} is ${d.Status.toLowerCase()}.`, 'warning');
      else toast(errorText(err), 'danger');
    } finally {
      busy = null;
      await load();
    }
  };
  const doDelete = async (d: EcpDataServer): Promise<void> => {
    const ok = await confirm({
      title: `Delete data server ${d.Name}?`,
      body: `<p>This instance stops knowing about <span class="mono">${esc(d.RemoteAddress)}:${esc(d.RemotePort)}</span>. Nothing on the data server changes. This can’t be undone.</p>`,
      confirmLabel: 'Delete data server',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteEcpDataServer(d.Name);
      dbs.delete(d.Name);
      closeDetail();
      await load();
      toast(`Data server ${d.Name} deleted.`);
    } catch (err) {
      if (err instanceof AdminError && err.status === 409) toast(`IRIS won’t delete ${d.Name}: remote databases still use it.`, 'warning');
      else toast(errorText(err), 'danger');
    }
  };
  const tlsAct = async (t: EcpTlsConnection, what: 'authorize' | 'reject' | 'remove'): Promise<void> => {
    const cn = t.SSLComputerName;
    if (what !== 'authorize') {
      const ok = await confirm({
        title: what === 'reject' ? 'Reject this certificate?' : 'Remove this authorization?',
        body: `<p class="mono">${esc(cn)}</p><p>${what === 'reject'
          ? 'The application server can’t connect. If it tries again, it waits here for approval again.'
          : 'Application servers with this certificate must be approved again before they can connect. Connections already open aren’t closed.'}</p>`,
        confirmLabel: what === 'reject' ? 'Reject' : 'Remove',
        danger: true,
      });
      if (!ok) return;
    }
    busy = cn;
    shownHtml = '';
    renderDetail();
    try {
      await (what === 'authorize' ? authorizeEcpTls(cn) : what === 'reject' ? rejectEcpTls(cn) : removeEcpTls(cn));
      toast(what === 'authorize' ? 'Certificate authorized. The application server can connect now.' : what === 'reject' ? 'Certificate rejected.' : 'Authorization removed.');
    } catch (err) { toast(errorText(err), 'danger'); }
    busy = null;
    await load();
  };

  // ── Create / edit ──
  const openEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    const src = dataServers.find((x) => x.Name === name);
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : 'New data server',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Add data server',
      sections:
        section('Server',
          (name ? '' : textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'How remote databases refer to it. IRIS stores it in capitals.' })) +
          `<div class="crud-row">${textField('Address', 'Address', src?.RemoteAddress ?? '', { required: true, mono: true, hint: 'Host name or IP address of the data server.' })}${
            textField('Port', 'Port', String(src?.RemotePort ?? 1972), { required: true, mono: true, width: '140px', hint: 'Its superserver port.' })}</div>`) +
        section('Connection',
          checkField('MirrorConnection', 'It’s a mirror: follow whichever member is primary', src?.MirrorConnection ?? false) +
          checkField('SSLConfig', 'Encrypt the connection with TLS', src?.SSLConfig ?? false, { hint: 'Uses this instance’s %ECPClient TLS configuration.' }) +
          checkField('BatchMode', 'Batch mode', src?.BatchMode ?? false, { hint: 'For bulk loads and reports: its blocks aren’t kept in this instance’s cache.' })),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (/[,:=\s]/.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Leave out spaces, commas, colons and equals signs' });
          else if (dataServers.some((x) => x.Name.toUpperCase() === n.toUpperCase())) out.push({ field: 'Name', label: 'Name', message: 'A data server with this name already exists' });
        }
        if (!String(v.Address ?? '').trim()) out.push({ field: 'Address', label: 'Address', message: 'Enter the data server’s address' });
        const port = Number(String(v.Port ?? '').trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) out.push({ field: 'Port', label: 'Port', message: 'Enter a whole number from 1 to 65535' });
        return out;
      },
      onSubmit: async (v) => {
        const target = (name ?? String(v.Name).trim()).toUpperCase();
        try {
          await saveEcpDataServer(target, {
            Address: String(v.Address).trim(), Port: Number(String(v.Port).trim()),
            MirrorConnection: v.MirrorConnection ? 1 : 0, SSLConfig: v.SSLConfig ? 1 : 0, BatchMode: !!v.BatchMode,
          });
        } catch (err) {
          if (err instanceof AdminError && /address|host/i.test(err.message)) fieldError(detail, 'Address', err.message);
          throw err;
        }
        leaveEdit();
        selected = target;
        await load();
        void fetchDbs(target);
        scrollPanelTop(detail);
        toast(name ? `Data server ${target} saved.` : `Data server ${target} added. IRIS connects when code first uses one of its databases.`);
      },
      onCancel: () => { leaveEdit(); if (selected && dataServers.some((x) => x.Name === selected)) renderDetail(); else closeDetail(); },
    });
  };

  // ── Loading ──
  const paint = (): void => {
    const none = noneConfigured();
    $('#ecp-summary').hidden = none;
    ($('#ecp-view') as HTMLElement).hidden = none;
    $('#ecp-foot').hidden = none;
    if (none && view !== 'data') { view = 'data'; ctx.body.querySelectorAll<HTMLElement>('#ecp-view button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === 'data'))); }
    ctx.body.querySelector<HTMLElement>('#ecp-view button[data-value="tls"]')!.hidden = !tls.length;
    renderBanner();
    renderFacts();
    renderTabs();
    renderGrid();
    renderFoot();
    if (selected && !editor) {
      const exists = view === 'data' ? dataServers.some((x) => x.Name === selected) : view === 'app' ? appServers.some((x) => x.ClientName === selected) : tls.some((x) => x.SSLComputerName === selected);
      if (exists) renderDetail(); else closeDetail();
    }
  };
  const updated = liveIndicator(ctx, () => void load());
  const load = async (): Promise<void> => {
    try {
      const [s, d, a, t, db, svc] = await Promise.all([
        getEcpSettings().catch(() => settings), getEcpDataServers(), getEcpAppServers(), getEcpTls().catch(() => tls),
        getEcpDashboard().catch(() => dash), getEcpService().then((x) => x.Enabled).catch(() => serviceOn),
      ]);
      if (!alive) return;
      settings = s; dataServers = d; appServers = a; tls = t; dash = db; serviceOn = svc;
      loaded = true;
      updated(new Date());
      paint();
    } catch (err) {
      if (!alive || loaded) return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'ecp-retry');
      wrap.querySelector('#ecp-retry')?.addEventListener('click', () => void load());
    }
  };

  const newBtn = newButton(ctx, 'New data server', () => void openEditor(null));
  void sessionInfo().then((info) => can(info, 'Manage'), () => null).then((ok) => {
    canManage = ok;
    if (!alive) return;
    renderTabs();
    if (selected && !editor) { shownHtml = ''; renderDetail(); }
  });

  bindViewTabs(ctx.body, 'ecp-view', async (v) => {
    if (!(await mayLeave())) { ctx.body.querySelectorAll<HTMLElement>('#ecp-view button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === view))); return; }
    view = v as View;
    query = ''; searchEl.value = '';
    selected = null; setPanel(false);
    if (loaded) { renderTabs(); renderGrid(); renderFoot(); }
  });
  searchEl.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    if (loaded) renderGrid();
  });

  void load();
  const timer = setInterval(() => { if (!busy) void load(); }, REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
