// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Superservers — the network ports IRIS listens on, what each one
 * accepts (SQL, the Web Gateway, ECP…), and whether it uses TLS. Each
 * connection a superserver accepts then goes through its service's own
 * checks (on, sign-in, Use), so every accepted kind links to Services.
 *
 * Full create / edit / delete (tested live on throwaway osca_test ports; see
 * api-services.ts). Guard rails: the system default superserver carries the
 * Web Gateway connection this portal runs through, so switching it off,
 * turning off its web connections or requiring TLS needs the port typed; it
 * can't be deleted. New ports that clash with another superserver or the web
 * server are refused before anything is sent, because IRIS accepts them.
 */
import '../styles-security.css';
import '../styles-services.css';
import {
  getSuperservers, saveSuperserver, deleteSuperserver, getServices, getTlsConfigs, FLAGS, TLS_LEVELS, tlsLabel, allAddresses, ssKey,
  serviceInfo, linkToScreen, anyoneCanConnect, noSignInApps, anonOf, anonGets, PORTAL_SERVICE,
  type Superserver, type SuperserverFlag, type SuperserverPatch, type ServiceSummary, type TlsConfig,
} from '../api-services';
import { takeSelection, getSecurityGraph, linkTo, type SecurityGraph } from '../api-security';
import { anyoneNotice, stickyEditHead, previewHtml } from './services';
import {
  toast, confirm, newButton, editorShell, panelWidth, section, textField, checkField, selectField,
  readForm, fieldError, errorText, scrollPanelTop, SubmitCancelled, type EditorHandle, type MenuHandle, type FieldProblem, type FormValues,
} from '../crud';
import { guardDialog, mountSecurityBanner, type GuardRisk } from '../security-view';
import { esc, chip, cell, num, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, objectDetail, odMeta, odSection, odKv, type ScreenCtx, type GridColumn, type OdFull } from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 60000;
const EDIT_WIDTH = 520;
const NO_PRIV = noPermissionText('%Admin_Secure', 'security administration');
const CERTS = 'security/certs';
/** IRIS's own wording for the default superserver; the "System default" chip already says it. */
const descOf = (s: { Description: string; SystemDefault: boolean }): string =>
  (s.SystemDefault && /^system default port$/i.test(s.Description.trim()) ? '' : s.Description);

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

const bindWords = (bind: string): string => (allAddresses(bind) ? 'All addresses' : bind === '127.0.0.1' || bind === '::1' ? `${bind} (this machine only)` : bind);
const accepted = (s: Superserver): typeof FLAGS => FLAGS.filter((f) => s[f.flag]);
/** Does this port carry anything TLS can protect, while TLS is off? */
const plainClients = (s: Superserver): boolean => s.SSLSupportLevel === 0 && accepted(s).some((f) => f.tls);

/** Plain secondary text: the notice above the list already owns "no TLS". */
const secondaryText = (v: string, title: string): string =>
  `<span style="white-space:nowrap;color:var(--ev-color-text-secondary)" title="${esc(title)}">${esc(v)}</span>`;

const COLUMNS: GridColumn[] = [
  // The row's identifier: left-aligned at a fixed 96px, so it leads the row even when the peek hides the rest.
  { key: 'Port', label: 'Port', width: '96px', sortable: true, renderCell: (v) => cell.num(String(v)) },
  { key: 'Bind', label: 'Listens on', description: 'Which network address it listens on', width: '160px', sortable: true, renderCell: (v) => cell.text(v) },
  { key: 'Status', label: 'Status', width: '80px', sortable: true, renderCell: (v) => (v === 'Running' ? chip('Running', 'success', 'Listening on its port') : chip('Stopped', 'neutral', 'Not listening')) },
  { key: 'Accepts', label: 'Accepts', description: 'The kinds of connection it takes; each then goes through its service’s checks', sortable: true, renderCell: (v, row) => {
    // Two names read at a glance; more becomes a count, with the full list a hover away.
    const list = String(v ?? '').split(', ').filter(Boolean);
    if (!list.length) return cell.dim('—');
    return list.length <= 2 ? cell.text(list.join(', '), String(row.AcceptsTitle)) : cell.text(`${list.length} services`, `${list.join(', ')}. ${String(row.AcceptsTitle)}`);
  } },
  { key: 'TLS', label: 'TLS', description: 'Encryption for client connections: Off, Accepted (optional) or Required', width: '120px', sortable: true, renderCell: (v, row) => (row.Plain ? secondaryText(String(v), 'Client connections on this port aren’t encrypted') : cell.text(v)) },
  { key: 'Description', label: 'Description', width: '200px', sortable: true, renderCell: (v, row) => (row.Default ? cell.text(v ? `System default · ${String(v)}` : 'System default', 'IRIS’s own superserver, set in the configuration') : v ? cell.text(v) : cell.dim('—')) },
];
/** Step aside while the detail panel is open (Port, Status and TLS stay). */
const SECONDARY = ['Description', 'Bind', 'Accepts'];

export function superserversScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="od-list sec-list" id="ss-list-view">
      <ev-detail-panel id="ss-panel" detail-width="500" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="ss-grid-wrap">${skeleton(4)}</div>
        <aside slot="detail" class="detail" id="ss-detail" aria-label="Superserver details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="ss-foot"></p>
    </div>
    <div id="ss-full" hidden></div>`;
  const listView = ctx.body.querySelector('#ss-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#ss-full') as HTMLElement;
  const panel = ctx.body.querySelector('#ss-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#ss-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#ss-detail') as HTMLElement;
  // The page's security banner belongs to the list; the full view carries its port's own notice under the strip.
  const bannerSync = new MutationObserver(() => { ctx.banners.hidden = listView.hidden; });
  bannerSync.observe(listView, { attributes: true, attributeFilter: ['hidden'] });
  ctx.onLeave(() => { bannerSync.disconnect(); ctx.banners.hidden = false; });

  let all: Superserver[] = [];
  let services: ServiceSummary[] = [];
  let tls: TlsConfig[] | null = null;
  let grid: GridEl | null = null;
  let selected: string | null = null;
  let pending = takeSelection();
  let token = 0;
  let alive = true;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  let canSecure: boolean | null = null;
  ctx.onLeave(() => { alive = false; });

  let graph: SecurityGraph | null = null;
  const svc = (name?: string): ServiceSummary | undefined => (name ? services.find((s) => s.Name === name) : undefined);
  /** Is this kind of connection one where anyone can connect (No sign-in, and they pass the Use check)? */
  const anyoneOn = (serviceName?: string): boolean => {
    const sv = svc(serviceName);
    if (!sv || !sv.Enabled) return false;
    if (sv.Name === PORTAL_SERVICE) return noSignInApps(graph).length > 0;
    return anyoneCanConnect(sv, serviceInfo(sv), graph);
  };
  /** The ways in a listening port carries where anyone can connect. */
  const openWays = (s: Superserver): typeof FLAGS => (s.Enabled ? accepted(s).filter((f) => anyoneOn(f.service)) : []);

  /** The port the page banner is about: its peek doesn't say it again. */
  let bannerKey: string | null = null;
  /** One Security banner: a port that carries ways in where anyone can connect, without TLS. */
  const renderBanner = (): void => {
    const host = ctx.banners;
    if (!host) return;
    const hit = all.filter((s) => openWays(s).length).sort((a, b) => a.SSLSupportLevel - b.SSLSupportLevel)[0];
    bannerKey = hit ? ssKey(hit) : null;
    if (!hit) { mountSecurityBanner(host, graph, null); return; }
    const ways = openWays(hit);
    const a = anonOf(graph);
    mountSecurityBanner(host, graph, {
      tone: a?.full ? 'danger' : 'warning',
      // One sentence that stands on its own; the names and what callers get are in the tooltip.
      headline: `Port ${hit.Port} carries ${num(ways.length)} service${ways.length === 1 ? '' : 's'} anyone can connect to${hit.SSLSupportLevel === 0 ? ', without TLS' : ''}.`,
      detail: `${ways.map((f) => f.label).join(', ')}. No sign-in is allowed there, so callers get ${anonGets(a)}.`,
      // One action only: Set up TLS when TLS is off (the fix that belongs here); otherwise Review.
      showThem: hit.SSLSupportLevel === 0 ? { label: 'Set up TLS', run: () => ctx.navigate(CERTS) } : undefined,
    }, { review: hit.SSLSupportLevel !== 0 });
  };
  /** The web server's own port (the page's, in production): never a superserver port. */
  const webPort = Number(location.port) || (location.protocol === 'https:' ? 443 : 80);

  const toRow = (s: Superserver): DataGridRow => {
    const acc = accepted(s);
    return {
      Key: ssKey(s), Port: s.Port, Bind: bindWords(s.BindAddress), Status: s.Enabled ? 'Running' : 'Stopped',
      Accepts: acc.map((f) => f.label.replace(/ \(.*\)$/, '')).join(', '), AcceptsTitle: acc.map((f) => f.what).join('; '),
      TLS: tlsLabel(s.SSLSupportLevel), Plain: s.Enabled && plainClients(s),
      Description: descOf(s), Default: s.SystemDefault,
    };
  };

  const applyColumns = (): void => { if (grid) for (const c of COLUMNS) grid.setColumnVisible(c.key, !(panel.open && SECONDARY.includes(c.key))); };
  const setPanel = (open: boolean): void => { if (panel.open !== open) { panel.open = open; applyColumns(); } };

  const renderGrid = (): void => {
    const rows = [...all].sort((a, b) => Number(b.SystemDefault) - Number(a.SystemDefault) || a.Port - b.Port).map(toRow);
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Key');
      grid.setAttribute('aria-label', 'Superservers');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => void selectRow(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Key)));
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
  };

  const renderFoot = (): void => {
    const on = all.filter((s) => s.Enabled).length;
    const plain = all.filter((s) => s.Enabled && plainClients(s)).length;
    (ctx.body.querySelector('#ss-foot') as HTMLElement).innerHTML =
      `<b>${num(all.length)}</b> superserver${all.length === 1 ? '' : 's'}<span class="meta-sep">·</span><b>${num(on)}</b> running`
      + (plain ? `<span class="meta-sep">·</span><b>${num(plain)}</b> without TLS` : '');
  };

  const close = (): void => {
    token++;
    if (od.selected() !== null) { void od.select(null); return; }
    selected = null; grid?.select([]); setPanel(false);
  };
  /** Short lists open their first row once per visit, unless the user has closed it this session. */
  const AUTO_KEY = 'osca-portal:auto-peek-closed:security/superservers';
  let autoTried = false;
  const wasClosed = (): boolean => { try { return sessionStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } };
  const closedByUser = (): void => { try { sessionStorage.setItem(AUTO_KEY, '1'); } catch { /* storage blocked: it opens again next visit */ } };
  const open = (key: string): void => {
    if (!all.some((s) => ssKey(s) === key)) return;
    selected = key;
    renderGrid();
    if (od.mode() === 'full') void od.openFull(key); else renderDetail();
  };
  const leaveEditor = (): void => { ctx.beforeLeave(null); editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; };
  /** Backed out at a guard dialog: stay in the form with changes kept and no error (see services.ts). */
  const keepEditing = (): never => {
    toast('Not saved. Your changes are still here.', 'info');
    throw new SubmitCancelled();
  };
  const selectRow = async (key: string): Promise<void> => {
    if (editor) {
      if (!(await editor.guard())) { grid?.select(selected !== null ? [selected] : []); return; }
      leaveEditor();
    }
    selected = key;
    await od.select(key);
  };

  /* ───────────── Detail ───────────── */

  const head = (title: string, sub: string): string => `
    <header class="detail-head">
      <div class="detail-title"><h2>${esc(title)}</h2><span class="svc-code">${esc(sub)}</span></div>
      <ev-icon-button icon="x" label="Close details" id="ss-close"></ev-icon-button>
    </header>`;

  /** Each kind of connection: this port → the service it then passes through, with that service's state. */
  const acceptsBlock = (s: Superserver): string => {
    const acc = accepted(s);
    if (!acc.length) return '<p class="detail-para">Nothing: it listens but accepts no kind of connection.</p>';
    return `<ul class="svc-list">${acc.map((f) => {
      const sv = svc(f.service);
      const info = sv ? serviceInfo(sv) : null;
      const state = !f.service ? cell.dim('no service') : !sv ? '' : !sv.Enabled ? chip('Service off', 'neutral', 'Accepted here, but the service refuses every connection')
        : anyoneOn(f.service) ? chip('Anyone can connect', anonOf(graph)?.full ? 'danger' : 'warning', sv.Name === PORTAL_SERVICE ? 'Some web applications allow No sign-in' : 'The service allows No sign-in') : chip('Service on', 'success');
      const name = sv
        ? `<a class="svc-link" href="#/security/services" data-svc="${esc(sv.Name)}" title="Open the ${esc(info?.label ?? sv.Name)} service">${esc(f.label)}</a>`
        : `<b>${esc(f.label)}</b>`;
      return `<li class="svc-line"><span>${name}<span class="svc-sub">${esc(f.what)}${sv ? `; then checked by the ${esc(info?.label ?? sv.Name)} service` : ''}${f.tls ? '' : '. Not covered by this port’s TLS setting'}</span></span>
        <span class="svc-meta">${state}</span></li>`;
    }).join('')}</ul>`;
  };

  /**
   * This port's own notice, as it stands now (peek, full view, top of its editor), or ''. "Anyone can
   * connect" in the shared wording; TLS is not repeated here, since the subtitle says "TLS off".
   */
  const noticeOf = (s: Superserver): string => {
    const open = openWays(s);
    const offSvc = accepted(s).filter((f) => f.service && svc(f.service) && !svc(f.service)?.Enabled);
    if (s.Enabled && open.length) {
      const a = anonOf(graph);
      return anyoneNotice({ full: !!a?.full, roles: a ? a.roles : null, scope: `to ${num(open.length)} service${open.length === 1 ? '' : 's'} on this port`, title: `${open.map((f) => f.label).join(', ')}.` });
    }
    if (s.Enabled && offSvc.length) {
      const text = `Accepted here but switched off as services: ${offSvc.map((f) => f.label).join(', ')}.`;
      return `<div class="page-notice page-notice--info" role="note"><ev-icon name="info" size="sm"></ev-icon><span class="page-notice-text" title="${esc(text)}">${esc(text)}</span></div>`;
    }
    return '';
  };
  const tlsText = (s: Superserver): string => `TLS ${tlsLabel(s.SSLSupportLevel).toLowerCase()}`;
  const find = (k: string): Superserver | undefined => all.find((x) => ssKey(x) === k);

  /** Identity facts no strip cell or subtitle carries: the type, and the TLS configuration when TLS is on. */
  const aboutRows = (s: Superserver): Array<[string, string, string]> => [
    ['Type', s.SystemDefault ? 'System default' : 'Added here', s.SystemDefault ? 'IRIS’s own superserver, set in the configuration. The Web Gateway, and so this portal, reaches IRIS through it.' : 'Added to the configuration by an administrator'],
    ...(s.SSLConfig && s.SSLSupportLevel > 0 ? [['TLS configuration', `<span class="mono">${esc(s.SSLConfig)}</span>`, s.SSLConfig] as [string, string, string]] : []),
  ];
  const peekBody = (s: Superserver): string => {
    // The page banner already names this port's risk; TLS is in the subtitle (Set up TLS is in ⋯).
    const notice = ssKey(s) === bannerKey ? '' : noticeOf(s);
    return `
      ${notice}
      ${odSection('', odKv(aboutRows(s)))}
      ${odSection('What it accepts', acceptsBlock(s))}`;
  };
  const fullOf = (s: Superserver): OdFull => {
    selected = ssKey(s); // a deep link opens here directly: later loads refresh what's shown
    const acc = accepted(s);
    const on = acc.filter((f) => !f.service || svc(f.service)?.Enabled !== false);
    const kindOf = (f: (typeof FLAGS)[number]): 'people' | 'system' => {
      const sv = svc(f.service);
      return f.defaultOnly || f.flag === 'EnableSNMP' ? 'system' : sv ? serviceInfo(sv).kind : 'people';
    };
    const people = acc.filter((f) => kindOf(f) === 'people');
    const systems = acc.filter((f) => kindOf(f) === 'system');
    const covered = acc.filter((f) => f.tls);
    // Each fact once: the title has the port and the subtitle has the address and TLS level; the strip
    // holds only counts, the cards the details (type and TLS configuration are in About).
    return {
      strip: [
        { label: 'For people', value: `${num(people.length)} kind${people.length === 1 ? '' : 's'}`, title: people.map((f) => f.label).join(', ') || 'None' },
        { label: 'Between systems', value: `${num(systems.length)} kind${systems.length === 1 ? '' : 's'}`, title: systems.map((f) => f.label).join(', ') || 'None' },
        // Who can connect is the notice's job; the strip says how many of those services are switched on.
        { label: 'Services on', value: `${num(on.length)} of ${num(acc.length)}`, title: on.map((f) => f.label).join(', ') || 'None of its services is on' },
        { label: 'TLS setting covers', value: `${num(covered.length)} of ${num(acc.length)}`, title: 'Kinds this port’s TLS setting applies to. ECP, mirroring and SNMP set their own.' },
      ],
      notice: noticeOf(s) || undefined,
      main: [{ title: 'What it accepts', body: acceptsBlock(s) }],
      side: [{ title: 'About', body: `${descOf(s) ? `<p class="detail-para">${esc(descOf(s))}</p>` : ''}${odKv(aboutRows(s))}` }],
    };
  };

  const od = objectDetail<Superserver>(ctx, {
    collection: 'Superservers', noun: 'superserver',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (s) => ssKey(s), find,
    order: () => [...all].sort((a, b) => Number(b.SystemDefault) - Number(a.SystemDefault) || a.Port - b.Port).map((s) => ssKey(s)),
    name: (s) => `Port ${s.Port}`,
    meta: (s) => odMeta(s.Enabled ? { label: 'Running', tone: 'success', title: 'Listening on its port' } : { label: 'Stopped', tone: 'neutral', title: 'Not listening' },
      [bindWords(s.BindAddress)], [s.SSLSupportLevel === 0 && s.Enabled && plainClients(s) ? '<span style="color:var(--ev-color-warning)">TLS off</span>' : esc(tlsText(s))]),
    description: (s) => descOf(s),
    primary: (s) => ({ label: 'Edit', icon: 'edit-2', blocked: canSecure === false ? NO_PRIV : null, run: () => void openEditor(s) }),
    menu: (s) => {
      const reason = canSecure === false ? NO_PRIV : null;
      const delReason = reason ?? (s.SystemDefault ? 'The system default superserver can’t be deleted; it’s set in the configuration.' : null);
      return [
        ...(s.SSLSupportLevel === 0 ? [{ label: 'Set up TLS', icon: 'key-round', onSelect: () => ctx.navigate(CERTS) }] : []),
        { label: s.Enabled ? 'Stop listening…' : 'Start listening…', icon: s.Enabled ? 'eye-off' : 'eye', disabled: !!reason, reason: reason ?? undefined, onSelect: () => void toggle(s) },
        { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!delReason, reason: delReason ?? undefined, onSelect: () => void doDelete(s) },
      ];
    },
    peek: peekBody,
    loadFull: fullOf,
    onSelect: (k) => {
      if (k === null && selected !== null && od.mode() === 'list') closedByUser(); // closed: don't auto-open again this session
      selected = k; grid?.select(k ? [k] : []);
    },
    onPeek: () => applyColumns(),
    // Paging, the breadcrumb and Esc leave an open form only through its unsaved-changes check.
    canLeave: async () => { if (editor && !(await editor.guard())) return false; leaveEditor(); return true; },
    widthKey: 'osca-portal:peek-width:security/superservers',
  });
  /** Show the selected superserver in the peek (or refresh what's shown), unless a form is open. */
  const renderDetail = (): void => {
    if (editor) return;
    if (selected === null) { if (od.selected() !== null) void od.select(null); else setPanel(false); return; }
    if (od.selected() === selected) od.refresh(); else void od.select(selected);
  };
  const onLink = (e: Event): void => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-svc]');
    const u = (e.target as HTMLElement).closest<HTMLElement>('[data-user]');
    if (b) { e.preventDefault(); linkToScreen(ctx.navigate, 'security/services', b.dataset.svc ?? ''); }
    else if (u) { e.preventDefault(); linkTo(ctx.navigate, 'security/users', u.dataset.user ?? ''); }
  };
  detailEl.addEventListener('click', onLink);
  fullEl.addEventListener('click', onLink);

  /* ───────────── Guard rails ───────────── */

  const risksOf = (s: Superserver | null, after: Superserver): { risks: GuardRisk[]; typed: boolean; danger: boolean } => {
    const risks: GuardRisk[] = [];
    let typed = false;
    let danger = false;
    const lock = 'The Web Gateway reaches IRIS on this port, so this portal and the Management Portal would stop working for everyone, including you. Undoing it needs the Terminal.';
    if (s?.SystemDefault) {
      if (s.Enabled && !after.Enabled) { risks.push({ title: `This stops the default superserver (port ${s.Port})`, text: `Every connection on this port is refused. ${lock}` }); typed = true; }
      if (after.Enabled && s.EnableCSP && !after.EnableCSP) { risks.push({ title: 'This turns off web connections on the default superserver', text: lock }); typed = true; }
      if (after.Enabled && after.EnableCSP && s.SSLSupportLevel !== 2 && after.SSLSupportLevel === 2) { risks.push({ title: 'This requires TLS on the default superserver', text: `Unless the Web Gateway is set up to connect with TLS, it will be refused. ${lock}` }); typed = true; }
      danger = typed;
    }
    const lost = s ? accepted(s).filter((f) => !after[f.flag] || (s.Enabled && !after.Enabled)) : [];
    const people = lost.filter((f) => f.flag === 'EnableClients' || (f.flag === 'EnableCSP' && !s?.SystemDefault));
    if (people.length) {
      risks.push({ title: `This stops port ${after.Port} accepting ${people.map((f) => f.label).join(' and ')}`, text: 'Clients that connect on this port are refused, unless another superserver accepts them.', impact: 'Connections already open carry on until they end.' });
      danger = true;
    }
    if (after.Enabled && after.SSLSupportLevel === 0 && accepted(after).some((f) => f.tls) && allAddresses(after.BindAddress) && (!s || s.SSLSupportLevel > 0 || !s.Enabled)) {
      risks.push({ title: `This leaves port ${after.Port} unencrypted on every address`, text: `Client connections on port ${after.Port} will travel without TLS, from any network.` });
    }
    return { risks, typed, danger };
  };

  const askRisks = async (s: Superserver | null, after: Superserver, label: string): Promise<boolean> => {
    const r = risksOf(s, after);
    if (!r.risks.length) return true;
    const d = guardDialog(r.risks);
    return confirm({
      title: d.title, danger: r.danger, confirmLabel: label,
      body: d.body,
      typeToConfirm: r.typed ? String(after.Port) : undefined,
    });
  };

  const afterSave = async (key: string, message: string): Promise<void> => {
    leaveEditor();
    toast(message);
    selected = key;
    if (od.mode() === 'full') fullEl.innerHTML = ''; // the full view's skeleton shows until the fresh read lands
    await load();
    if (od.mode() === 'full') od.refresh(); else open(key);
  };

  /* ───────────── Actions ───────────── */

  const toggle = async (s: Superserver): Promise<void> => {
    const after: Superserver = { ...s, Enabled: !s.Enabled };
    const r = risksOf(s, after);
    const verb = after.Enabled ? 'Start listening' : 'Stop listening';
    if (!r.risks.length) {
      const what = accepted(s).map((f) => f.label).join(', ') || 'nothing';
      if (!(await confirm({
        title: `${verb} on port ${s.Port}?`, confirmLabel: verb, danger: !after.Enabled,
        body: after.Enabled ? `<p>IRIS starts listening on port ${s.Port} straight away, accepting: ${esc(what)}.</p>` : `<p>New connections on port ${s.Port} (${esc(what)}) are refused. Connections already open carry on.</p>`,
      }))) return;
    } else if (!(await askRisks(s, after, verb))) return;
    try {
      await saveSuperserver(s.Port, s.BindAddress, { Enabled: after.Enabled });
    } catch (err) { toast(`Couldn’t change port ${s.Port}. ${errorText(err)}`, 'danger'); return; }
    await afterSave(ssKey(s), `Port ${s.Port} ${after.Enabled ? 'is listening' : 'stopped listening'}.`);
  };

  const doDelete = async (s: Superserver): Promise<void> => {
    const what = accepted(s).map((f) => f.label);
    const ok = await confirm({
      title: `Delete the superserver on port ${s.Port}?`, danger: true, confirmLabel: 'Delete superserver',
      body: `<p>${s.Enabled ? `IRIS stops listening on port ${s.Port}${what.length ? `; clients that connect there (${esc(what.join(', '))}) are refused unless another superserver accepts them` : ''}.` : 'It isn’t listening, so nothing connects through it now.'}</p><p>This can’t be undone.</p>`,
      typeToConfirm: s.Enabled ? String(s.Port) : undefined,
      alternative: s.Enabled ? { label: 'Stop listening instead', onSelect: () => void toggle(s) } : undefined,
    });
    if (!ok) return;
    try { await deleteSuperserver(s.Port, s.BindAddress); } catch (err) { toast(`Couldn’t delete port ${s.Port}. ${errorText(err)}`, 'danger'); return; }
    toast(`Superserver on port ${s.Port} deleted.`);
    close();
    await load();
  };

  /* ───────────── Create and edit ───────────── */

  // New opens in the drawer (from the full view it goes back to the list first). Edit from the list opens
  // in the drawer; from the full view (#/security/superservers/<key>) it takes the page body's place, so
  // the address, title and ‹ › pager stay, and Cancel or Save bring the full view back.
  const openEditor = async (s: Superserver | null): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    const inFull = od.mode() === 'full' && !!s;
    if (od.mode() === 'full' && !inFull) await od.closeFull();
    const host = inFull ? fullEl : detailEl;
    menu?.destroy(); menu = null;
    const my = ++token;
    if (!s) { selected = null; grid?.select([]); }
    if (!inFull) {
      setPanel(true);
      restoreWidth = panelWidth(panel, EDIT_WIDTH);
      detailEl.innerHTML = head(s ? `Port ${s.Port}` : 'New superserver', s ? bindWords(s.BindAddress) : '') + skeleton(6);
    }
    if (!tls) tls = await getTlsConfigs().catch(() => []);
    if (my !== token) return;
    // The user may have paged or gone back to the list while the read was out.
    if (inFull && (!s || od.mode() !== 'full' || od.selected() !== ssKey(s))) return;
    const servers = (tls ?? []).filter((t) => /server/i.test(t.Type));
    const isDefault = !!s?.SystemDefault;
    const flagBox = (f: (typeof FLAGS)[number]): string => checkField(f.flag, f.label, s ? s[f.flag] : f.flag === 'EnableClients', { hint: f.what });
    const main = FLAGS.filter((f) => !f.legacy && !f.defaultOnly);
    const sys = FLAGS.filter((f) => f.defaultOnly);
    const legacy = FLAGS.filter((f) => f.legacy);

    // General: where it listens (a new one only; fixed once created), what it's for, and whether it's on.
    const aboutSec = section('General', `
      ${s ? '' : `<div class="crud-row">
        ${textField('Port', 'Port', '', { required: true, mono: true, maxlength: 5, width: '120px', hint: '100 to 65535, not used by anything else' })}
        ${textField('BindAddress', 'Bind address', '', { mono: true, placeholder: 'All addresses', hint: 'Empty: every network address. 127.0.0.1: this machine only.' })}
      </div>
      <p class="svc-hint">Port and address are fixed once created. IRIS doesn’t check whether another program already uses the port.</p>`}
      ${textField('Description', 'Description', s?.Description ?? '', { maxlength: 256, placeholder: 'What connects here' })}
      ${checkField('Enabled', 'Enabled', s ? s.Enabled : true, { toggle: true, hint: 'While it’s on, IRIS listens on the port. It starts or stops as soon as you save.' })}`);
    const acceptSec = section('What it accepts', `
      ${main.map(flagBox).join('')}
      ${isDefault ? `<p class="svc-sub-head">Between systems (system default only)</p>${sys.map(flagBox).join('')}` : `<p class="svc-hint">ECP, mirroring and sharding can only use the system default superserver.</p>`}
      <details class="svc-legacy"${legacy.some((f) => s?.[f.flag]) ? ' open' : ''}><summary>Legacy connections</summary>${legacy.map(flagBox).join('')}</details>`,
    { hint: 'Each connection then goes through its own service’s checks (Services).' });
    const tlsSec = section('Encryption (TLS)', `
      ${selectField('SSLSupportLevel', 'TLS for client connections', TLS_LEVELS.map((t) => ({ value: String(t.value), label: `${t.label}: ${t.means}` })), String(s?.SSLSupportLevel ?? 0))}
      ${selectField('SSLConfig', 'Server TLS configuration', [{ value: '', label: servers.length ? 'Choose a configuration' : 'None available' }, ...servers.map((t) => ({ value: t.Name, label: t.Name }))], s?.SSLConfig ?? '')}
      ${servers.length ? '' : '<p class="svc-hint">There’s no server TLS configuration yet. <button type="button" class="svc-link svc-link--btn" id="ss-go-certs">Create one in Certificates &amp; TLS ›</button></p>'}`,
    { hint: 'Applies to SQL, web, DataCheck and legacy client connections; ECP, mirroring and SNMP set their own.' });
    // A new port is described whole ("What happens"); an edit lists only what it changes.
    const preview = section(s ? 'What changes' : 'What happens', '<div id="ss-preview" class="svc-preview" aria-live="polite"></div>');

    const stateOf = (v: FormValues): Superserver => {
      const port = s ? s.Port : Number(String(v.Port ?? '').trim());
      const bind = s ? s.BindAddress : String(v.BindAddress ?? '').trim();
      const flags = Object.fromEntries(FLAGS.map((f) => [f.flag, f.defaultOnly && !isDefault ? false : v[f.flag] === true])) as Record<SuperserverFlag, boolean>;
      return {
        ...(s ?? { SystemDefault: false }), ...flags, Port: port, BindAddress: bind,
        Description: String(v.Description ?? ''), Enabled: v.Enabled === true,
        SSLSupportLevel: Number(v.SSLSupportLevel ?? 0) || 0, SSLConfig: String(v.SSLConfig ?? ''),
      } as Superserver;
    };

    const portProblem = (st: Superserver): string | null => {
      if (s) return null;
      const raw = String(readForm(host).Port ?? '').trim();
      if (!raw) return 'Enter a port number';
      if (!/^\d+$/.test(raw) || st.Port < 100 || st.Port > 65535) return 'Use a whole number from 100 to 65535';
      if (st.Port === webPort) return `Port ${st.Port} is the web server’s port`;
      const clash = all.find((x) => x.Port === st.Port && (allAddresses(x.BindAddress) || allAddresses(st.BindAddress) || x.BindAddress === st.BindAddress));
      if (clash) return `Port ${st.Port} is already used by a superserver${allAddresses(clash.BindAddress) ? '' : ` on ${clash.BindAddress}`}`;
      return null;
    };
    const check = (): FieldProblem[] => {
      const st = stateOf(readForm(host));
      const out: FieldProblem[] = [];
      const p = portProblem(st);
      if (p) out.push({ field: 'Port', label: 'Port', message: p });
      if (!s && st.BindAddress && !/^[A-Za-z0-9.:\-[\]]+$/.test(st.BindAddress)) out.push({ field: 'BindAddress', label: 'Bind address', message: 'Use an IP address or host name' });
      if (st.SSLSupportLevel > 0 && !st.SSLConfig) out.push({ field: 'SSLConfig', label: 'TLS configuration', message: servers.length ? 'Choose the server TLS configuration to use' : 'Create a server TLS configuration first, or set TLS to Off' });
      return out;
    };

    const update = (): void => {
      const st = stateOf(readForm(host));
      const acc = accepted(st);
      const tlsWords = (x: Superserver): string => `${tlsLabel(x.SSLSupportLevel).toLowerCase()}${x.SSLSupportLevel > 0 && x.SSLConfig ? ` (${x.SSLConfig})` : ''}`;
      const accWords = (x: Superserver): string => accepted(x).map((f) => f.label).join(', ') || 'nothing';
      const lines = !s ? [
        st.Enabled ? `Listens on port ${Number.isFinite(st.Port) && st.Port ? st.Port : '…'}, ${allAddresses(st.BindAddress) ? 'on every address' : `on ${st.BindAddress} only`}.` : 'Created switched off: not listening.',
        acc.length ? `Accepts: ${acc.map((f) => f.label).join(', ')}.` : 'Accepts nothing.',
        `TLS: ${tlsWords(st)}.`,
      ] : [
        ...(st.Enabled !== s.Enabled ? [`Enabled: ${s.Enabled ? 'on' : 'off'} → ${st.Enabled ? 'on' : 'off'}${st.Enabled ? ' (starts listening)' : ' (stops listening)'}.`] : []),
        ...(st.Description !== s.Description ? [`Description: ${s.Description || 'none'} → ${st.Description || 'none'}.`] : []),
        ...(accWords(st) !== accWords(s) ? [`Accepts: ${accWords(s)} → ${accWords(st)}.`] : []),
        ...(tlsWords(st) !== tlsWords(s) ? [`TLS: ${tlsWords(s)} → ${tlsWords(st)}.`] : []),
      ];
      const r = risksOf(s, st);
      const prev = host.querySelector('#ss-preview') as HTMLElement | null;
      if (prev) prev.innerHTML = previewHtml(lines, r.risks);
      const cfg = host.querySelector<HTMLElement>('[data-field="SSLConfig"]');
      if (cfg) cfg.hidden = st.SSLSupportLevel === 0;
    };

    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(host, {
      // The full view's title already names the port.
      title: inFull ? 'Edit settings' : s ? `Edit port ${s.Port}` : 'New superserver',
      name: s ? `port ${s.Port}` : undefined,
      submitLabel: s ? 'Save changes' : 'Create superserver',
      submitAlways: !s,
      sections: (s ? noticeOf(s) : '') + aboutSec + acceptSec + tlsSec + preview,
      check,
      onSubmit: async (v) => {
        const st = stateOf(v);
        const p = portProblem(st);
        if (p) { fieldError(host, 'Port', p); throw new Error(`${p}. Nothing was saved.`); }
        if (!s) {
          // A fresh list: saving an existing port + address would change it instead of creating one.
          all = await getSuperservers();
          const p2 = portProblem(st);
          if (p2) { fieldError(host, 'Port', p2); throw new Error(`${p2}. Nothing was saved.`); }
        }
        if (!(await askRisks(s, st, s ? 'Save anyway' : 'Create anyway'))) keepEditing();
        const body: SuperserverPatch = {};
        const put = <K extends keyof SuperserverPatch>(k: K, val: SuperserverPatch[K]): void => { if (!s || s[k as keyof Superserver] !== val) body[k] = val; };
        put('Description', st.Description);
        put('Enabled', st.Enabled);
        for (const f of FLAGS) if (!f.defaultOnly || isDefault) put(f.flag, st[f.flag]);
        put('SSLSupportLevel', st.SSLSupportLevel);
        put('SSLConfig', st.SSLSupportLevel > 0 ? st.SSLConfig : (s?.SSLConfig ?? ''));
        if (s && !Object.keys(body).length) throw new Error('Nothing to save.');
        try {
          await saveSuperserver(st.Port, st.BindAddress, body);
        } catch (err) {
          if (/bind/i.test(errorText(err))) fieldError(host, 'BindAddress', 'IRIS didn’t accept this address');
          throw err;
        }
        const key = ssKey({ Port: st.Port, BindAddress: st.BindAddress });
        await afterSave(key, s ? `Superserver on port ${st.Port} saved.` : `Superserver on port ${st.Port} created${st.Enabled ? ' and listening' : ''}.`);
      },
      onCancel: () => {
        ctx.beforeLeave(null);
        editor?.close();
        editor = null;
        restoreWidth?.(); restoreWidth = null;
        if (inFull) { fullEl.innerHTML = ''; od.refresh(); } else if (selected !== null) renderDetail(); else setPanel(false);
      },
    });
    const ed = editor;
    if (inFull && s) stickyEditHead(host, `Port ${s.Port}`);
    const onChange = (): void => { if (editor === ed) { update(); ed.refresh(); } };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-select-change', 'ev-checkbox-change', 'ev-toggle-change']) ed.form.addEventListener(t, onChange);
    host.querySelector('#ss-go-certs')?.addEventListener('click', async () => { if (await ed.guard()) { leaveEditor(); ctx.navigate('security/certs'); } });
    update();
    scrollPanelTop(host);
    (host.querySelector(s ? '[data-field="Description"] ev-input' : '[data-field="Port"] ev-input') as HTMLElement | null)?.focus();
    requestAnimationFrame(() => { if (editor === ed) { update(); if (s) ed.markClean(); } });
  };

  /* ───────────── Loading ───────────── */

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  const load = async (): Promise<void> => {
    try {
      const [list, svcs] = await Promise.all([getSuperservers(), getServices().catch(() => [] as ServiceSummary[])]);
      if (!alive) return;
      all = list; services = svcs;
      updated(new Date());
      if (!all.length) {
        grid = null;
        wrap.innerHTML = emptyState({
          icon: 'server', title: 'No superservers',
          what: 'IRIS isn’t listening on any network port, so nothing can connect over the network: no SQL tools, no Web Gateway, no ECP.',
          why: 'Normally the system default superserver is always here. Use <b>New superserver</b> above to add one.',
        });
      } else renderGrid();
      renderFoot();
      renderBanner();
      getSecurityGraph().then((g) => {
        if (!alive) return;
        graph = g;
        renderBanner();
        if (!editor && (selected !== null || od.mode() === 'full')) { if (od.mode() === 'full') od.refresh(); else renderDetail(); }
      }).catch(() => { /* banner falls back; Review fetches on demand */ });
      if (pending !== null) { const k = pending; pending = null; open(k); }
      else if (selected !== null && !editor) {
        if (all.some((s) => ssKey(s) === selected)) renderDetail(); else close();
      } else if (od.mode() === 'full') {
        od.refresh();
      } else if (!autoTried) {
        // A short list opens its first row, so the page shows the object instead of empty space (the address is left alone).
        autoTried = true;
        const first = [...all].sort((a, b) => Number(b.SystemDefault) - Number(a.SystemDefault) || a.Port - b.Port)[0];
        if (first && all.length <= 3 && !wasClosed() && !ctx.param) { selected = ssKey(first); grid?.select([selected]); renderDetail(); }
      }
      if (!opened) { opened = true; od.refresh(); } // a deep link (#/security/superservers/<key>) opens its full view now
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-ss');
      wrap.querySelector('#retry-ss')?.addEventListener('click', () => void load());
    }
  };

  const newBtn = newButton(ctx, 'New superserver', () => void openEditor(null));
  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    if (!editor) od.refreshHeader();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  let opened = false;
  void load();
  const timer = setInterval(() => { if (!editor) void load(); }, REFRESH_MS);
  ctx.onLeave(() => { clearInterval(timer); token++; menu?.destroy(); leaveEditor(); });
}
