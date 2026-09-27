// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings › License — the license key this instance runs on, how many of
 * its units are in use and by whom, and the license servers it reports to.
 *
 * Actions (%Admin_Manage):
 *  - Activate a new key: paste or load the key file, IRIS checks it first
 *    (what would be lost, whether a restart is needed), then installs it.
 *    The check ran live with a junk key; installing was built from the
 *    endpoint source and never run against the dev instance.
 *  - License servers: create, change, delete. Built from source, never run
 *    here (no license settings were changed while testing).
 */
import '../styles-security.css';
import '../styles-disk.css';
import '../styles-settings.css';
import {
  getLicenseKey, getLicenseServers, getLicenseUsage, checkLicenseKey, activateLicenseKey, saveLicenseServer, deleteLicenseServer,
  usageFigure, settingsPortal, settingsDocs, type LicenseKey, type LicenseServer, type LicenseUsage, type KeyCheck,
} from '../api-settings';
import {
  plural, kv, portalButton,
  esc, chip, cell, num, duration, relative, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, viewTabs, bindViewTabs,
  setViewTabCount, type ScreenCtx, type Tone, type GridColumn,
} from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, pathField, textareaField, readForm,
  fieldError, focusField, blockedAttrs, scrollPanelTop, AdminError, SubmitCancelled, cleanMessage, type FieldProblem, type EditorHandle,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
/** "InterSystems IRIS Community license" → "Community license": the product name is the page's subject already. */
const shortCapacity = (s: string): string => { const t = s.replace(/^InterSystems\s+(IRIS\s+)?/i, '').replace(/\s+licen[cs]e$/i, '').trim(); return t ? t[0].toUpperCase() + t.slice(1) : s; };
/** Holder columns hidden when every row has the same value (or none); the footer says it once. */
let holderUniform = { kind: '', noWeb: false, noGrace: false };
type Tab = 'use' | 'key' | 'servers';

const REFRESH_MS = 30_000;
/** Holders shown in the grid; the footer says when there are more. */
const MAX_HOLDERS = 500;
const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');
const SERVER_NAME = /^[A-Za-z0-9._-]+$/;
const DAY = 86_400_000;

const dim = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const kindWord = (t: string): string => (/^csp$/i.test(t) ? 'Web session' : t ? t : 'Connection');
const dateOf = (s: string): Date | null => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null);
const longDate = (d: Date): string => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function licenseScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <section class="disk-summary" aria-label="License at a glance">
      <div id="lic-facts">${skeleton(2)}</div>
    </section>
    ${viewTabs('lic-tabs', [{ value: 'use', label: 'Units in use' }, { value: 'key', label: 'Key' }, { value: 'servers', label: 'License servers' }], 'use')}
    <ev-detail-panel id="lic-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap set-main" id="lic-main">${skeleton(8)}</div>
      <aside slot="detail" class="detail" id="lic-detail" aria-label="License details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="lic-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#lic-panel');
  const main = $('#lic-main');
  const detail = $('#lic-detail');

  let key: LicenseKey | null = null;
  let usage: LicenseUsage | null = null;
  let servers: LicenseServer[] = [];
  let loaded = false;
  let tab: Tab = 'use';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let gridTab: Tab | null = null;
  let canManage: boolean | null = null;
  let alive = true;
  let factsHtml = '';
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });
  ctx.beforeLeave(async () => (editor ? editor.guard() : true));
  const blocked = (): string => (canManage === false ? NO_MANAGE : '');

  // ── Figures ──
  const figures = (): { used: number; peak: number; allowed: number; conns: number } => {
    const u = usage;
    const allowed = u ? usageFigure(u, /authori[sz]ed/i) : NaN;
    return {
      used: u ? usageFigure(u, /current .*units/i) : NaN,
      peak: u ? usageFigure(u, /maximum .*units/i) : NaN,
      allowed: Number.isFinite(allowed) && allowed > 0 ? allowed : key?.LicenseUnits ?? NaN,
      conns: u ? usageFigure(u, /current .*connections/i) : NaN,
    };
  };
  const expiry = (): { date: Date | null; days: number } => {
    const d = key ? dateOf(key.ExpirationDate) : null;
    return { date: d, days: d ? Math.floor((d.getTime() - Date.now()) / DAY) : NaN };
  };
  const webHeld = (): number => (usage?.UsageByUser ?? []).filter((h) => /^csp$/i.test(h.Type)).reduce((a, h) => a + (Number(h.LU) || 0), 0);

  // ── Banner ──
  interface Risk { tone: 'danger' | 'warning'; title: string; text: string; action?: string }
  const risks = (): Risk[] => {
    const out: Risk[] = [];
    const f = figures();
    if (Number.isFinite(f.used) && Number.isFinite(f.allowed) && f.allowed > 0) {
      const web = webHeld();
      const webNote = web ? ` ${plural(web, 'unit is', 'units are')} held by web sessions; ending sessions nobody is using frees them.` : '';
      if (f.used >= f.allowed) out.push({ tone: 'danger', title: `Every license unit is in use (${num(f.used)} of ${num(f.allowed)})`, text: `New users and connections are refused until a unit is freed.${webNote}`, action: web ? 'sessions' : undefined });
      else if (f.used / f.allowed >= 0.8) out.push({ tone: 'warning', title: `${num(f.used)} of ${num(f.allowed)} license units are in use`, text: `When all ${num(f.allowed)} are taken, new users and connections are refused.${webNote}`, action: web ? 'sessions' : undefined });
    }
    const e = expiry();
    if (e.date && e.days < 0) out.push({ tone: 'danger', title: `The license key expired on ${longDate(e.date)}`, text: 'Install a renewed key from InterSystems.' });
    else if (e.date && e.days <= 30) out.push({ tone: e.days <= 7 ? 'danger' : 'warning', title: `The license key expires ${e.days === 0 ? 'today' : `in ${plural(e.days, 'day')}`}`, text: `It stops on ${longDate(e.date)}. Ask InterSystems for a renewed key and activate it here.` });
    return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
  };
  const renderBanner = (): void => {
    const list = risks();
    const top = list[0];
    if (!top) { ctx.banners.innerHTML = ''; return; }
    const rest = list.slice(1).map((r) => r.title);
    // One line: the headline; the explanation (and any further risks) on hover.
    const tip = `${top.text}${rest.length ? ` Also: ${rest.join('; ')}.` : ''}`;
    ctx.banners.innerHTML = `<div class="page-notice page-notice--${top.tone}" role="status" title="${esc(tip)}">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <span class="page-notice-text">${esc(top.title)}${rest.length ? ` (+${rest.length} more)` : ''}</span>
      ${top.action === 'sessions' ? '<button type="button" class="page-notice-link" id="lic-to-sessions">Web sessions ›</button>' : ''}
    </div>`;
    ctx.banners.querySelector('#lic-to-sessions')?.addEventListener('click', () => ctx.navigate('operations/sessions'));
  };

  // ── Summary ──
  const renderFacts = (): void => {
    if (!key) return;
    const f = figures();
    const e = expiry();
    const share = Number.isFinite(f.used) && f.allowed > 0 ? f.used / f.allowed : NaN;
    const useTone: Tone = !Number.isFinite(share) ? 'neutral' : share >= 1 ? 'danger' : share >= 0.8 ? 'warning' : 'success';
    const expTone: Tone | null = !e.date ? null : e.days < 0 || e.days <= 7 ? 'danger' : e.days <= 30 ? 'warning' : 'success';
    // A value and one caption line per cell; the key's details live on the Key tab.
    // A dot only where the value is a state that can go bad: Expires always, Units in use once it nears the limit.
    const cellHtml = (label: string, value: string, tone: Tone | null, caption: string): string =>
      `<div class="jrn-cell"${tone ? ` data-tone="${tone}"` : ''}><span class="jrn-cell-label">${esc(label)}</span><span class="jrn-cell-value">${tone ? '<span class="jrn-fact-dot" aria-hidden="true"></span>' : ''}<span title="${esc(value)}">${esc(value)}</span></span><span class="jrn-cell-cap" title="${esc(caption)}">${esc(caption)}</span></div>`;
    const html = `<div class="jrn-cells set-cells4">
      ${cellHtml('License', key.LicenseCapacity ? shortCapacity(key.LicenseCapacity) : key.Product || 'Not recorded', null, [key.LicenseType ? key.LicenseType[0].toUpperCase() + key.LicenseType.slice(1).toLowerCase() : '', key.Server ? `${key.Server.toLowerCase()} server` : ''].filter(Boolean).join(' · '))}
      ${cellHtml('Units in use', Number.isFinite(f.used) ? `${num(f.used)} of ${num(f.allowed)}` : `${num(key.LicenseUnits)} allowed`, useTone === 'warning' || useTone === 'danger' ? useTone : null,
        [Number.isFinite(share) ? `${Math.round(share * 100)}% used` : '', Number.isFinite(f.peak) ? `peak ${num(f.peak)}` : ''].filter(Boolean).join(' · '))}
      ${cellHtml('Expires', e.date ? longDate(e.date) : 'Never', expTone, e.date ? (e.days < 0 ? 'Expired' : relative(e.date)) : 'No end date')}
      ${cellHtml('CPU cores', `${num(key.CoresLicensed)} licensed`, null, key.CoresEnforced ? `Using ${num(key.CoresEnforced)}` : 'Not enforced')}
    </div>`;
    if (html !== factsHtml) { factsHtml = html; $('#lic-facts').innerHTML = html; }
  };

  // ── Main area ──
  const HOLDER_COLUMNS: GridColumn[] = [
    { key: 'UserId', label: 'Held by', width: '170px', sortable: true, description: 'The user name, or the ID IRIS gives a web session or client', renderCell: (v) => cell.mono(v, false, String(v)) },
    { key: 'Kind', label: 'Kind', width: '120px', sortable: true },
    { key: 'LU', label: 'Units', width: '80px', sortable: true, align: 'right', renderCell: (v) => cell.num(num(Number(v))) },
    { key: 'Connects', label: 'Connections', width: '110px', sortable: true, align: 'right', description: 'Connections sharing these units right now', renderCell: (v) => cell.num(num(Number(v))) },
    { key: 'CSPCon', label: 'Web sessions', width: '120px', sortable: true, align: 'right', renderCell: (v) => (Number(v) ? cell.num(num(Number(v))) : cell.dim('—')) },
    { key: 'Active', label: 'Held for', width: '110px', sortable: true, description: 'How long the units have been held', renderCell: (v) => cell.num(duration(Number(v))) },
    { key: 'Grace', label: 'Grace left', sortable: true, description: 'After the last connection ends, IRIS keeps the unit for a grace period before releasing it',
      renderCell: (v) => (Number(v) > 0 ? cell.num(duration(Number(v))) : cell.dim('—')) },
  ];
  const SERVER_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Name', width: '170px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Address', label: 'Address', width: '180px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Port', label: 'Port', width: '90px', sortable: true, align: 'right', renderCell: (v) => cell.num(String(v)) },
    { key: 'KeyDirectory', label: 'Key directory', description: 'Where this server keeps keys it hands out to instances', renderCell: (v) => (v ? cell.mono(v, true, String(v)) : cell.dim('—')) },
  ];

  const ensureGrid = (t: Tab, cols: GridColumn[], rowKey: string, label: string, sort?: string): GridEl => {
    if (grid && gridTab === t) return grid;
    main.innerHTML = '';
    grid = document.createElement('ev-data-grid') as GridEl;
    gridTab = t;
    grid.setAttribute('compact', '');
    grid.setAttribute('row-key', rowKey);
    grid.setAttribute('aria-label', label);
    if (sort) { grid.setAttribute('sort-column', sort); grid.setAttribute('sort-direction', 'desc'); }
    if (t === 'servers') {
      grid.setAttribute('row-select', '');
      grid.addEventListener('ev-data-grid-row-click', (e) => void selectServer(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name)));
    }
    grid.columns = cols;
    main.appendChild(grid);
    return grid;
  };
  const dropGrid = (): void => { grid = null; gridTab = null; };

  const renderUse = (): void => {
    const holders = usage?.UsageByUser ?? [];
    if (!holders.length) {
      dropGrid();
      main.innerHTML = emptyState({ icon: 'users', title: 'No license units in use', what: 'Each user, web session or client takes one unit while it’s connected.', docs: { href: settingsDocs.license, label: 'About licensing' } });
      return;
    }
    const g = ensureGrid('use', HOLDER_COLUMNS, 'UserId', 'License units in use', 'Active');
    // Longest-held first, capped: a busy instance can have hundreds of holders.
    g.rows = [...holders].sort((a, b) => (Number(b.Active) || 0) - (Number(a.Active) || 0)).slice(0, MAX_HOLDERS).map((h) => ({ ...h, Kind: kindWord(h.Type) }));
    const kinds = new Set(holders.map((h) => kindWord(h.Type)));
    holderUniform = {
      kind: holders.length > 1 && kinds.size === 1 ? [...kinds][0] : '',
      noWeb: holders.every((h) => !Number(h.CSPCon)) || holders.every((h) => Number(h.CSPCon) === Number(h.LU)),
      noGrace: holders.every((h) => !(Number(h.Grace) > 0)),
    };
    g.setColumnVisible('Kind', !holderUniform.kind);
    g.setColumnVisible('CSPCon', !holderUniform.noWeb);
    g.setColumnVisible('Grace', !holderUniform.noGrace);
  };

  const renderKey = (): void => {
    dropGrid();
    if (!key) { main.innerHTML = skeleton(8); return; }
    const k = key;
    const e = expiry();
    const feats = k.ExtendedFeaturesList ?? [];
    const apps = k.AuthorizedApplications ?? [];
    main.innerHTML = `<div class="set-page">
      <div class="set-card">
        <h3 class="detail-section">This key</h3>
        <dl class="kv-list">
          ${kv('License', esc(k.LicenseCapacity || '—'))}
          ${kv('Licensed to', esc(k.CustomerName || '—'))}
          ${kv('Order number', k.OrderNumber ? `<span class="mono">${esc(k.OrderNumber)}</span>` : dim('Not recorded'))}
          ${kv('Product', esc(k.Product || '—'))}
          ${kv('Counted by', esc(k.LicenseType || '—'))}
          ${kv('Server type', esc(k.Server || '—'))}
          ${kv('Platform', esc(k.Platform || '—'))}
          ${kv('License units', esc(num(k.LicenseUnits)))}
          ${kv('CPU cores', `${esc(num(k.CoresLicensed))} licensed${k.CoresEnforced ? ` <span class="dim">· ${esc(num(k.CoresEnforced))} enforced</span>` : ''}`)}
          ${kv('Expires', e.date ? `${esc(longDate(e.date))} <span class="dim">· ${esc(e.days < 0 ? 'expired' : relative(e.date))}</span>` : dim('Never'))}
          ${kv('Authorization key', `<span class="mono">${esc(k.AuthorizationKey || '—')}</span>`, k.AuthorizationKey)}
        </dl>
      </div>
      <div class="set-card">
        <h3 class="detail-section">What it unlocks · ${num(feats.length)}</h3>
        ${feats.length ? `<div class="chip-list set-chips">${feats.map((f) => chip(f)).join('')}</div>` : '<p class="disk-none">No extra features.</p>'}
        <h3 class="detail-section">Applications it authorizes</h3>
        ${apps.length ? `<div class="chip-list set-chips">${apps.map((a) => chip(a)).join('')}</div>` : '<p class="disk-none">None: it isn’t tied to particular applications.</p>'}
        <div class="set-card-actions">${portalButton(settingsPortal.licenseKey, 'License key in Management Portal')}</div>
      </div>
    </div>`;
  };

  const renderServers = (): void => {
    if (!servers.length) {
      dropGrid();
      main.innerHTML = emptyState({
        icon: 'globe', title: 'No license servers',
        what: 'A license server tracks units across instances that share one key. A single instance normally counts its own units.',
        docs: { href: settingsDocs.licenseServer, label: 'About license servers' },
      });
      return;
    }
    const g = ensureGrid('servers', SERVER_COLUMNS, 'Name', 'License servers');
    g.rows = servers.map((s) => ({ ...s }));
    if (selected) g.select([selected]);
  };

  const renderMain = (): void => {
    if (!loaded) return;
    if (tab === 'use') renderUse(); else if (tab === 'key') renderKey(); else renderServers();
    renderFoot();
  };

  const renderFoot = (): void => {
    const sep = '<span class="meta-sep">·</span>';
    const f = figures();
    if (tab === 'use') {
      const holders = usage?.UsageByUser ?? [];
      const web = holders.filter((h) => /^csp$/i.test(h.Type)).length;
      const kind = holderUniform.kind ? `${sep}all ${holderUniform.kind.toLowerCase()}s` : web ? `${sep}${plural(web, 'web session')}` : '';
      $('#lic-foot').innerHTML = holders.length
        ? `<b>${num(holders.length)}</b> holder${holders.length === 1 ? '' : 's'}${holders.length > MAX_HOLDERS ? ` · ${num(MAX_HOLDERS)} shown` : ''}${sep}<b>${Number.isFinite(f.used) ? num(f.used) : '—'}</b> of ${Number.isFinite(f.allowed) ? num(f.allowed) : '—'} units${kind}`
        : '';
    } else if (tab === 'key') {
      $('#lic-foot').innerHTML = key ? `${plural((key.ExtendedFeaturesList ?? []).length, 'feature')} unlocked${sep}${plural(key.LicenseUnits, 'unit')} allowed` : '';
    } else {
      $('#lic-foot').innerHTML = `<b>${num(servers.length)}</b> license server${servers.length === 1 ? '' : 's'}`;
    }
  };

  // ── Detail: license servers ──
  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => { selected = null; if (gridTab === 'servers') grid?.select([]); setPanel(false); };

  const renderServer = (): void => {
    const s = servers.find((x) => x.Name === selected);
    if (!s) { closeDetail(); return; }
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><h2 class="mono">${esc(s.Name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="lic-close"></ev-icon-button>
      </header>
      <div class="detail-actions">
        <button type="button" class="btn btn--sm" id="lic-edit"${blockedAttrs(blocked())}>Edit</button>
        ${moreButton('lic-more', `More actions for ${s.Name}`)}
      </div>
      ${canManage === false ? `<p class="detail-note">${esc(NO_MANAGE)}</p>` : ''}
      <dl class="kv-list">
        ${kv('Address', `<span class="mono">${esc(s.Address)}</span>`)}
        ${kv('Port', `<span class="mono">${esc(s.Port)}</span>`)}
        ${kv('Key directory', s.KeyDirectory ? `<span class="mono">${esc(s.KeyDirectory)}</span>` : dim('—'), s.KeyDirectory)}
      </dl>
      <p class="detail-desc set-gap">IRIS reports the units it uses to this server, which counts them for every instance sharing the key.${/^(127\.|localhost$)/i.test(s.Address) ? ' This one runs on the same machine.' : ''}</p>`;
    detail.querySelector('#lic-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#lic-edit')?.addEventListener('click', () => void openServerEditor(s.Name));
    moreMenu(detail.querySelector('#lic-more') as HTMLElement, [
      { label: 'Edit in Management Portal ↗', icon: 'external-link', onSelect: () => { window.open(settingsPortal.licenseServers, '_blank', 'noopener'); } },
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: canManage === false, reason: NO_MANAGE, onSelect: () => void removeServer(s.Name) },
    ]);
    setPanel(true);
  };

  const selectServer = async (name: string): Promise<void> => {
    if (!(await mayLeave())) { if (selected && gridTab === 'servers') grid?.select([selected]); return; }
    selected = name;
    renderServer();
    scrollPanelTop(detail);
  };

  const openServerEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    const s = name ? servers.find((x) => x.Name === name) : undefined;
    if (name && !s) return;
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : 'New license server',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Add license server',
      sections:
        (name ? '' : section('Name', textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'How this instance refers to the server. Letters, digits, periods, - and _.' }))) +
        section('Where it runs',
          `<div class="crud-row">${textField('Address', 'Address', s?.Address ?? '', { required: true, mono: true, placeholder: 'e.g. 10.0.0.12 or licsrv.example.com' })}${
            textField('Port', 'Port', String(s?.Port ?? 4002), { required: true, width: 'sm', mono: true })}</div>`,
          { hint: 'The machine running the license server, and the port it listens on (4002 unless changed).' }) +
        section('Keys it hands out', pathField('KeyDirectory', 'Key directory', s?.KeyDirectory ?? '', { mode: 'dir', title: 'Choose the key directory', hint: 'Optional. A directory on the server holding keys it gives to instances that start without one.' })) +
        `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>IRIS counts units through its license servers. A wrong address or port can leave this instance unable to get units after it restarts.</div></div>`,
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (!SERVER_NAME.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Use letters, digits, periods, - or _' });
          else if (servers.some((x) => x.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A license server with this name already exists' });
        }
        if (!String(v.Address ?? '').trim()) out.push({ field: 'Address', label: 'Address', message: 'Enter the server’s address' });
        const port = Number(String(v.Port ?? '').trim());
        if (!Number.isInteger(port) || port < 1 || port > 65535) out.push({ field: 'Port', label: 'Port', message: 'Enter a port from 1 to 65535' });
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        if (!name) {
          // A save on an existing name changes it: make sure it's still free.
          const fresh = await getLicenseServers().catch(() => servers);
          if (fresh.some((x) => x.Name.toLowerCase() === target.toLowerCase())) {
            fieldError(detail, 'Name', 'A license server with this name already exists');
            focusField(detail, 'Name');
            throw new Error('A license server with this name already exists.');
          }
        }
        await saveLicenseServer(target, { Address: String(v.Address).trim(), Port: Number(String(v.Port).trim()), KeyDirectory: String(v.KeyDirectory ?? '').trim() });
        leaveEdit();
        selected = target;
        await load(true);
        renderServer();
        scrollPanelTop(detail);
        toast(name ? `License server ${target} saved.` : `License server ${target} added.`);
      },
      onCancel: () => { leaveEdit(); if (selected) renderServer(); else setPanel(false); },
    });
  };

  const removeServer = async (name: string): Promise<void> => {
    const last = servers.length === 1;
    const ok = await confirm({
      title: `Delete license server ${name}?`,
      body: `<p>This instance stops reporting its units to <b class="mono">${esc(name)}</b>.${last ? ' <b>It’s the only license server here</b>, so units are no longer counted through a server.' : ''}</p><p>Type the name to confirm.</p>`,
      confirmLabel: 'Delete license server',
      danger: true,
      typeToConfirm: name,
    });
    if (!ok) return;
    try {
      await deleteLicenseServer(name);
      closeDetail();
      await load(true);
      toast(`License server ${name} deleted.`);
    } catch (err) {
      toast(err instanceof AdminError && err.status === 404 ? `${name} no longer exists.` : errorText(err), 'danger');
      await load(true);
    }
  };

  // ── Activate a new key ──
  const reductionLines = (c: KeyCheck): string[] => {
    const words: Record<string, string> = { Cores: 'CPU cores', Users: 'License units', Server: 'Server type', LicenseType: 'Counted by', Product: 'Product' };
    const out: string[] = [];
    for (const [k, v] of Object.entries(c.Reductions ?? {})) {
      if (k === 'Features' && Array.isArray(v)) { if (v.length) out.push(`Loses ${v.map((f) => esc(f)).join(', ')}`); continue; }
      if (v && !Array.isArray(v)) out.push(`${esc(words[k] ?? k)}: ${esc(String(v.From))} → ${esc(String(v.To))}`);
    }
    return out;
  };

  const openActivate = async (): Promise<void> => {
    if (!(await mayLeave())) return;
    selected = null;
    if (gridTab === 'servers') grid?.select([]);
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    editor = editorShell(detail, {
      title: 'Activate a new key',
      submitLabel: 'Check and activate…',
      sections:
        section('The key file',
          `${textareaField('Key', 'Key file contents', '', { rows: 12, mono: true, hint: 'Paste the whole iris.key file InterSystems sent you, or load it below.' })}
           <label class="set-file"><input type="file" id="lic-file" accept=".key,text/plain"><span>Load a key file…</span></label>`,
          { hint: 'IRIS checks the key before anything changes, and shows you what it would lose.' }),
      check: () => {
        const text = String(readForm(detail).Key ?? '').trim();
        return text ? [] : [{ field: 'Key', label: 'Key file contents', message: 'Paste the key, or load the file' }];
      },
      onSubmit: async (v) => {
        const text = String(v.Key ?? '');
        let c: KeyCheck;
        try { c = await checkLicenseKey(text); } catch (err) {
          fieldError(detail, 'Key', 'IRIS can’t use this key');
          throw err;
        }
        if (!c.IsValid) {
          fieldError(detail, 'Key', 'IRIS can’t use this key');
          throw new Error(cleanMessage(c.InvalidReason) || 'IRIS can’t use this key.');
        }
        const lost = reductionLines(c);
        const ok = await confirm({
          title: 'Activate this license key?',
          body: `<p>IRIS replaces the current key with this one${c.RequiresRestart ? '' : ' and applies it straight away'}.</p>
            ${lost.length ? `<p><b>Compared with the current key, it gives less:</b></p><ul>${lost.map((l) => `<li>${l}</li>`).join('')}</ul>` : '<p>It gives at least what the current key does.</p>'}
            ${c.RequiresRestart ? `<p><b>IRIS must be restarted before it takes effect</b>${c.RestartReason ? `: ${esc(c.RestartReason)}` : ''}.</p>` : ''}`,
          confirmLabel: 'Activate key',
          danger: lost.length > 0,
          typeToConfirm: lost.length ? 'activate' : undefined,
        });
        if (!ok) throw new SubmitCancelled();
        await activateLicenseKey(text);
        leaveEdit();
        setPanel(false);
        await load(true);
        toast(c.RequiresRestart ? 'Key installed. It takes effect when IRIS restarts.' : 'Key activated.', c.RequiresRestart ? 'warning' : 'success');
      },
      onCancel: () => { leaveEdit(); setPanel(false); },
    });
    detail.querySelector<HTMLInputElement>('#lic-file')?.addEventListener('change', (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 64 * 1024) { toast('That file is too big to be a license key.', 'warning'); return; }
      void file.text().then((t) => {
        const area = detail.querySelector('ev-textarea[name="Key"]') as (HTMLElement & { value: string }) | null;
        if (area) { area.value = t; area.setAttribute('value', t); }
        fieldError(detail, 'Key', null);
        editor?.refresh();
      });
    });
  };

  // ── Header, tabs, loading ──
  // ONE header button whose label follows the tab. Two newButton()s on a page fight over first place in
  // the header (each one's observer re-prepends it), which loops forever and freezes the tab.
  const primaryBtn = newButton(ctx, 'Activate new key', () => { if (tab === 'servers') void openServerEditor(null); else void openActivate(); });
  const syncButtons = (): void => {
    const label = tab === 'servers' ? 'New license server' : 'Activate new key';
    const span = primaryBtn.el.querySelector('span');
    if (span && span.textContent !== label) span.textContent = label;
    // Blue is for creating something; activating a key replaces one, so it's a secondary button.
    primaryBtn.el.classList.toggle('btn--primary', tab === 'servers');
    const icon = primaryBtn.el.querySelector('ev-icon');
    if (icon) (icon as HTMLElement).style.display = tab === 'servers' ? '' : 'none';
    primaryBtn.setHidden(canManage === false);
  };
  syncButtons();

  bindViewTabs(ctx.body, 'lic-tabs', (value) => {
    void (async () => {
      if (!(await mayLeave())) {
        ctx.body.querySelectorAll<HTMLElement>('#lic-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === tab)));
        return;
      }
      tab = value as Tab;
      closeDetail();
      dropGrid();
      syncButtons();
      renderMain();
    })();
  });

  const updated = liveIndicator(ctx, () => void load(true));
  /** `all`: key and servers too (they change only when someone changes them). */
  const load = async (all = false): Promise<void> => {
    try {
      const [u, k, s] = await Promise.all([
        getLicenseUsage(),
        all || !key ? getLicenseKey() : Promise.resolve(key),
        all || !loaded ? getLicenseServers() : Promise.resolve(servers),
      ]);
      if (!alive) return;
      usage = u; key = k; servers = [...s].sort((a, b) => a.Name.localeCompare(b.Name));
      loaded = true;
      updated(new Date());
      setViewTabCount(ctx.body, 'lic-tabs', 'use', u.UsageByUser.length);
      setViewTabCount(ctx.body, 'lic-tabs', 'servers', servers.length);
      renderBanner();
      renderFacts();
      // Keep the key tab's text still while it's being read; the grid tabs update in place.
      if (tab !== 'key' || all) renderMain(); else renderFoot();
      if (!editor && selected) renderServer();
    } catch (err) {
      if (!alive) return;
      if (loaded) return; // keep the last good view; the freshness text shows its age
      dropGrid();
      $('#lic-facts').innerHTML = '';
      main.innerHTML = errorPanel(err, 'lic-retry');
      main.querySelector('#lic-retry')?.addEventListener('click', () => void load(true));
    }
  };

  sessionInfo().then((info) => {
    canManage = can(info, 'Manage');
    if (!alive) return;
    syncButtons();
    if (!editor && selected) renderServer();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load(true);
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
