// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web & APIs › DocDB applications — the security record IRIS keeps for each
 * document database: which namespace it lives in, whether it can be used,
 * and the resource people need to work with it. Full create, edit,
 * enable/disable and delete. A record is identified by name and namespace,
 * so both are fixed once created.
 */
import '../styles-apps.css';
import '../styles-security.css';
import '../styles-web.css';
import {
  getDocDbs, saveDocDb, deleteDocDb, docsWeb, DOCDB_NAME, type DocDbApp,
} from '../api-web';
import { getSecurityGraph, getResourceList, getNamespaceList, getServiceList, linkTo, normPerms, ANON_USER, type SecurityGraph, type ResourceSummary, type ServiceRow } from '../api-security';
import { mountSecurityBanner, type LocalRisk } from '../security-view';
import { noPermissionText, esc, cell, chip, num, skeleton, errorPanel, liveIndicator, emptyState, uniformKeys, type ScreenCtx } from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, selectField, checkField,
  readForm, fieldError, focusField, blockedAttrs, scrollPanelTop, AdminError, isDatabaseResource,
  type FieldProblem, type EditorHandle,
} from '../crud';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const NO_SECURE = noPermissionText('%Admin_Secure', 'security administration');
const SERVICE = '%Service_DocDB';
const keyOf = (a: { Name: string; Namespace: string }): string => `${a.Namespace}\u0000${a.Name}`;
// Not ui.ts kv: the third argument wraps the value (kv-wrap) instead of setting a tooltip.
const kv = (k: string, v: string, wrap = false): string => `<div class="kv"><dt>${k}</dt><dd${wrap ? ' class="kv-wrap"' : ''}>${v}</dd></div>`;

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

export function docDbScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div id="dd-service"></div>
    <div class="toolbar-row" id="dd-toolbar" hidden>
      <div class="search-box"><ev-search id="dd-search" size="sm" full-width placeholder="Filter by name, namespace or resource" aria-label="Filter applications"></ev-search></div>
    </div>
    <ev-detail-panel id="dd-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="dd-wrap">${skeleton(6)}</div>
      <aside slot="detail" class="detail" id="dd-detail" aria-label="Application details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="dd-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#dd-panel');
  const wrap = $('#dd-wrap');
  const detail = $('#dd-detail');
  const toolbar = $('#dd-toolbar');

  let apps: DocDbApp[] = [];
  let loaded = false;
  let selected: string | null = null;
  let query = '';
  let grid: GridEl | null = null;
  let graph: SecurityGraph | null = null;
  let resources: ResourceSummary[] | null = null;
  let namespaces: string[] | null = null;
  let service: ServiceRow | null = null;
  let canSecure: boolean | null = null;
  let alive = true;
  let busy = false;
  let uniform = new Set<string>();

  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let formEvents: AbortController | null = null;
  const leaveEdit = (): void => {
    editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; formEvents?.abort(); formEvents = null; ctx.beforeLeave(null);
  };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });
  const blocked = (): string => (canSecure === false ? NO_SECURE : '');

  // ── Who can use it ──
  interface Who { open: boolean; exists: boolean; users: string[]; roles: string[]; anon: boolean; pub: string }
  const whoOf = (resource: string): Who => {
    if (!resource) return { open: true, exists: true, users: [], roles: [], anon: true, pub: '' };
    const r = graph?.resource(resource);
    const pub = normPerms(r?.PublicPermission ?? '');
    const who = graph?.whoCan(resource);
    const users = [...new Set((who?.users ?? []).map((u) => u.user))];
    return { open: !!pub, exists: graph ? !!r : true, users, roles: (who?.roles ?? []).map((x) => x.role), anon: !!pub || users.includes(ANON_USER), pub };
  };
  const serviceOn = (): boolean | null => (service ? service.Enabled : null);
  const openApps = (): DocDbApp[] => apps.filter((a) => a.Enabled && !a.Resource);

  // ── Grid ──
  const COLUMNS: DataGridColumn[] = [
    { key: 'Name', label: 'Database', width: '220px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
    { key: 'Namespace', label: 'Namespace', width: '120px', sortable: true, renderCell: (v) => cell.mono(v) },
    { key: 'Who', label: 'Required resource', width: '200px', sortable: true, description: '— means no resource: anyone who reaches the document service can use it',
      renderCell: (v) => (v ? cell.mono(v, false, String(v)) : cell.dim('—')) } as DataGridColumn,
    { key: 'Description', label: 'Description', width: '240px', sortable: true, renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('—')) },
    { key: 'Enabled', label: 'Status', width: '96px', sortable: true, renderCell: (v) => (v ? chip('Enabled', 'success') : chip('Disabled', 'neutral')) },
  ];
  const toRow = (a: DocDbApp): DataGridRow => ({
    Key: keyOf(a), Name: a.Name, Namespace: a.Namespace, Who: a.Resource, Description: a.Description, Enabled: a.Enabled,
  });
  const matches = (a: DocDbApp): boolean => {
    if (!query) return true;
    const ql = query.toLowerCase();
    return [a.Name, a.Namespace, a.Resource, a.Description].some((f) => f.toLowerCase().includes(ql));
  };
  const applyColumns = (): void => {
    for (const c of COLUMNS) grid?.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && c.key === 'Description'));
  };
  const setPanel = (open: boolean): void => { if (panel.open === open) return; panel.open = open; applyColumns(); };

  const renderEmpty = (): void => {
    grid = null;
    toolbar.hidden = true;
    wrap.innerHTML = emptyState({
      icon: 'archive',
      title: 'No DocDB applications',
      what: 'A DocDB application names the resource people need to read or change the documents in one document database.',
      docs: { href: docsWeb.docDb, label: 'About DocDB applications' },
    });
  };
  const renderGrid = (): void => {
    if (!apps.length) { renderEmpty(); return; }
    toolbar.hidden = false;
    const rows = apps.filter(matches).map(toRow);
    const creating = !grid;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Key');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => void select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Key)));
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    const next = uniformKeys(apps.map(toRow), ['Namespace', 'Enabled']) as Set<string>;
    if (creating || [...next].join() !== [...uniform].join()) { uniform = next; applyColumns(); }
    grid.select(selected ? [selected] : []);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">No applications match “${esc(query)}”.</div>`);
  };
  const renderFoot = (): void => {
    const on = apps.filter((a) => a.Enabled).length;
    const ns = new Set(apps.map((a) => a.Namespace)).size;
    const open = openApps().length;
    if (!apps.length) { $('#dd-foot').innerHTML = ''; return; }
    $('#dd-foot').innerHTML = `<b>${num(apps.length)}</b> application${apps.length === 1 ? '' : 's'}<span class="meta-sep">·</span><b>${num(on)}</b> enabled<span class="meta-sep">·</span><b>${num(ns)}</b> namespace${ns === 1 ? '' : 's'}`
      + (open ? `<span class="meta-sep">·</span><b>${num(open)}</b> with no resource` : '');
  };
  /** The service line: off means no DocDB application can be reached over the document API. */
  const renderService = (): void => {
    const host = $('#dd-service');
    const on = serviceOn();
    if (on === null || !apps.length) { host.innerHTML = ''; return; }
    host.innerHTML = on ? '' : `<div class="callout callout--banner web-service-note" role="note"><ev-icon name="info" size="sm"></ev-icon><div><span>The document database service is off, so clients can’t reach these. Turn it on in <a class="link link--inline" href="#/security/services">Services</a>.</span></div></div>`;
  };
  const banner = (): void => {
    if (!alive) return;
    const open = openApps();
    let local: LocalRisk | null = null;
    if (open.length && serviceOn()) {
      local = {
        tone: 'warning',
        headline: `${open.length === 1 ? `${open[0].Name} needs` : `${num(open.length)} document databases need`} no resource, so anyone who reaches the document service can use ${open.length === 1 ? 'it' : 'them'}`,
        showThem: { label: open.length === 1 ? 'Show it' : 'Show the first', run: () => void select(keyOf(open[0])) },
      };
    }
    mountSecurityBanner(ctx.banners, graph, local);
  };

  // ── Detail ──
  const closeDetail = (): void => { selected = null; grid?.select([]); setPanel(false); };
  const renderDetail = (): void => {
    const a = apps.find((x) => keyOf(x) === selected);
    if (!a) { closeDetail(); return; }
    const w = whoOf(a.Resource);
    const noPriv = blocked();
    const perms = w.pub ? w.pub.split('').map((c) => ({ R: 'Read', W: 'Read & change', U: 'Use' }[c] ?? c)).filter((x, i, arr) => !(x === 'Read' && arr.includes('Read & change'))).join(' · ') : '';
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><h2 class="mono">${esc(a.Name)}</h2>${a.Description ? `<p class="detail-subtitle">${esc(a.Description)}</p>` : ''}</div>
        <ev-icon-button icon="x" label="Close details" id="dd-close"></ev-icon-button>
      </header>
      <div class="detail-state">${a.Enabled ? chip('Enabled', 'success') : chip('Disabled', 'neutral', 'IRIS refuses to open this database through the document API')}<span class="dim">in <span class="mono">${esc(a.Namespace)}</span></span></div>
      <div class="detail-actions detail-actions--nowrap">
        <button type="button" class="btn btn--sm" id="dd-edit"${blockedAttrs(noPriv)}>Edit</button>
        <button type="button" class="btn btn--sm" id="dd-toggle"${blockedAttrs(noPriv)}>${a.Enabled ? 'Disable…' : 'Enable'}</button>
        ${moreButton('dd-more', `More actions for ${a.Name}`)}
      </div>
      ${a.Enabled && !a.Resource ? `<div class="callout callout--warning" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>
        <strong>No resource protects this database</strong>
        <span>Anyone who reaches the document service can use it${serviceOn() === false ? ', once the service is on' : ''}. Choose a resource so only its holders can.</span></div></div>` : ''}
      <h3 class="detail-section">Who can use it</h3>
      ${a.Resource ? `
        <p class="detail-para">People need permission on <button type="button" class="link link--inline mono" id="dd-res">${esc(a.Resource)}</button>: Read to fetch documents, Read &amp; change to save or delete them, Use to search.</p>
        ${!w.exists ? `<p class="detail-para check-warn">There’s no resource called ${esc(a.Resource)}, so only %All holders can use this database.</p>`
          : w.open ? `<p class="detail-para check-warn">It’s public: everyone gets ${esc(perms)}, including anyone who connects without signing in.</p>`
          : graph ? `<p class="detail-para">Today that’s ${num(w.users.length)} user${w.users.length === 1 ? '' : 's'}${w.roles.length ? ` through ${w.roles.length <= 3 ? esc(w.roles.join(', ')) : `${num(w.roles.length)} roles`}` : ''}, plus anyone with %All.</p>
            ${w.users.length ? `<div class="chip-list">${w.users.slice(0, 12).map((u) => `<button type="button" class="chip-link" data-user="${esc(u)}" aria-label="Open user ${esc(u)}">${chip(u, u === ANON_USER ? 'warning' : 'neutral', 'Open this user')}</button>`).join('')}${w.users.length > 12 ? `<span class="dim">and ${num(w.users.length - 12)} more</span>` : ''}</div>` : ''}` : ''}`
        : '<p class="detail-para">Anyone who reaches the document service. No resource is required.</p>'}
      <h3 class="detail-section">Reaching it</h3>
      <dl class="kv-list">
        ${kv('Document service', serviceOn() === null ? '<span class="dim">Not known</span>' : serviceOn() ? 'On' : '<span class="check-warn">Off</span>')}
        ${kv('Namespace', `<span class="mono">${esc(a.Namespace)}</span>`)}
      </dl>`;
    detail.querySelector('#dd-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#dd-edit')?.addEventListener('click', () => void openEditor(a));
    detail.querySelector('#dd-toggle')?.addEventListener('click', (e) => void act(e.currentTarget as HTMLButtonElement, () => toggle(a)));
    detail.querySelector('#dd-res')?.addEventListener('click', () => linkTo(ctx.navigate, 'security/resources', a.Resource));
    detail.querySelectorAll<HTMLElement>('[data-user]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/users', b.dataset.user ?? '')));
    moreMenu(detail.querySelector('#dd-more') as HTMLElement, [
      { label: 'Copy name', icon: 'copy', onSelect: () => { void navigator.clipboard.writeText(a.Name).then(() => toast(`Copied ${a.Name}.`, 'info')); } },
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!noPriv, reason: noPriv, onSelect: () => void act(null, () => remove(a)) },
    ]);
    setPanel(true);
  };
  const select = async (key: string): Promise<void> => {
    if (!(await mayLeave())) { grid?.select(selected ? [selected] : []); return; }
    selected = key;
    grid?.select([key]);
    renderDetail();
    scrollPanelTop(detail);
  };

  // ── Actions ──
  const act = async (btn: HTMLButtonElement | null, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try { await fn(); } catch (err) {
      toast(err instanceof AdminError && err.status === 404 ? 'That application no longer exists.' : errorText(err), 'danger');
      await load();
    } finally {
      busy = false;
      if (btn?.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  };
  const toggle = async (a: DocDbApp): Promise<void> => {
    if (a.Enabled) {
      const ok = await confirm({
        title: `Disable ${a.Name}?`,
        body: `<p>Clients can’t use <span class="mono">${esc(a.Name)}</span> in ${esc(a.Namespace)} through the document API until it’s enabled again. The documents and settings are kept.</p>`,
        confirmLabel: 'Disable',
      });
      if (!ok) return;
    }
    await saveDocDb(a.Name, a.Namespace, { Enabled: !a.Enabled });
    toast(a.Enabled ? `${a.Name} is disabled.` : `${a.Name} is enabled.`);
    await load();
  };
  const remove = async (a: DocDbApp): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${a.Name}?`,
      body: `<p>Removes the security record for <span class="mono">${esc(a.Name)}</span> in ${esc(a.Namespace)}${a.Resource ? `, so ${esc(a.Resource)} no longer protects it` : ''}. The documents themselves are not deleted.</p>${a.Resource ? '<p>Type the name to confirm.</p>' : ''}`,
      confirmLabel: 'Delete application',
      danger: true,
      typeToConfirm: a.Resource ? a.Name : undefined,
      alternative: a.Enabled ? { label: 'Disable instead', onSelect: () => void act(null, () => toggle(a)) } : undefined,
    });
    if (!ok) return;
    await deleteDocDb(a.Name, a.Namespace);
    closeDetail();
    toast(`${a.Name} deleted.`);
    await load();
  };

  // ── Editor ──
  const resourceOptions = (current: string): Array<{ value: string; label: string }> => {
    // IRIS refuses database resources here.
    const names = (resources ?? []).filter((r) => !isDatabaseResource(r)).map((r) => r.Name);
    if (current && !names.includes(current)) names.push(current);
    return [{ value: '', label: 'None: anyone who reaches the service' }, ...names.sort((x, y) => x.localeCompare(y)).map((n) => ({ value: n, label: n }))];
  };
  const preview = (): void => {
    const el = detail.querySelector('#dd-preview');
    const warn = detail.querySelector<HTMLElement>('#dd-open-warn');
    const v = readForm(detail);
    const res = String(v.Resource ?? '');
    const w = whoOf(res);
    if (el) el.textContent = !res ? '' : !w.exists ? `There’s no resource called ${res}.` : w.open ? `${res} is public, so everyone can use it.` : graph ? `Today that’s ${num(w.users.length)} user${w.users.length === 1 ? '' : 's'}, plus anyone with %All.` : '';
    if (warn) warn.hidden = !!res || !v.Enabled;
  };
  const openEditor = async (a: DocDbApp | null): Promise<void> => {
    if (!(await mayLeave())) return;
    try {
      [resources, namespaces] = await Promise.all([
        resources ? Promise.resolve(resources) : getResourceList(),
        namespaces ? Promise.resolve(namespaces) : getNamespaceList().then((l) => l.map((n) => n.Name).sort()),
      ]);
    } catch (err) { toast(errorText(err), 'danger'); return; }
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    editor = editorShell(detail, {
      title: a ? `Edit <span class="mono">${esc(a.Name)}</span>` : 'New DocDB application',
      name: a?.Name,
      submitLabel: a ? 'Save changes' : 'Create application',
      sections:
        (a ? '' : section('Database',
          textField('Name', 'Database name', '', { required: true, mono: true, maxlength: 220, placeholder: 'e.g. Demo.People', hint: 'The document database’s class name: Package.Name, letters and digits.' }) +
          selectField('Namespace', 'Namespace', [{ value: '', label: 'Choose a namespace' }, ...(namespaces ?? []).map((n) => ({ value: n, label: n }))], '', { required: true, searchable: (namespaces?.length ?? 0) > 8 }),
          { hint: 'Name and namespace can’t be changed later.' })) +
        section('Settings',
          textField('Description', 'Description', a?.Description ?? '', { maxlength: 256 }) +
          checkField('Enabled', 'Enabled', a?.Enabled ?? true, { toggle: true, hint: 'While it’s off, clients can’t use it through the document API.' })) +
        section('Who can use it',
          selectField('Resource', 'Resource required', resourceOptions(a?.Resource ?? ''), a?.Resource ?? '', { searchable: true, hint: 'Read to fetch documents, Read & change to save or delete, Use to search.' }) +
          `<p class="web-preview" id="dd-preview" aria-live="polite"></p>
           <div class="crud-note crud-note--warning" id="dd-open-warn" hidden><ev-icon name="alert-triangle" size="sm"></ev-icon><div>With no resource, anyone who reaches the document service can use this database.</div></div>`),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!a) {
          const n = String(v.Name ?? '').trim();
          const ns = String(v.Namespace ?? '');
          if (!n) out.push({ field: 'Name', label: 'Database name', message: 'Enter the database name' });
          else if (!DOCDB_NAME.test(n)) out.push({ field: 'Name', label: 'Database name', message: 'Use Package.Name: letters and digits, parts joined by dots' });
          if (!ns) out.push({ field: 'Namespace', label: 'Namespace', message: 'Choose a namespace' });
          if (n && ns && apps.some((x) => x.Name.toLowerCase() === n.toLowerCase() && x.Namespace.toLowerCase() === ns.toLowerCase())) {
            out.push({ field: 'Name', label: 'Database name', message: `${ns} already has an application for this database` });
          }
        }
        return out;
      },
      onSubmit: async (v) => {
        const name = a?.Name ?? String(v.Name).trim();
        const ns = a?.Namespace ?? String(v.Namespace);
        // A save to an existing record changes it, so create re-checks against the server.
        if (!a) {
          const fresh = await getDocDbs().catch(() => apps);
          if (fresh.some((x) => x.Name.toLowerCase() === name.toLowerCase() && x.Namespace.toLowerCase() === ns.toLowerCase())) {
            fieldError(detail, 'Name', `${ns} already has an application for this database`);
            focusField(detail, 'Name');
            throw new Error('Someone else just created this application. Open it to change it.');
          }
        }
        await saveDocDb(name, ns, { Description: String(v.Description ?? ''), Enabled: !!v.Enabled, Resource: String(v.Resource ?? '') });
        leaveEdit();
        selected = keyOf({ Name: name, Namespace: ns });
        await load();
        scrollPanelTop(detail);
        toast(a ? `${name} saved.` : `${name} created in ${ns}.`);
      },
      onCancel: () => { leaveEdit(); if (a && selected) renderDetail(); else closeDetail(); },
    });
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    formEvents = new AbortController();
    for (const ev of ['ev-select-change', 'ev-toggle-change', 'change']) detail.addEventListener(ev, preview, { signal: formEvents.signal });
    preview();
  };

  // ── Header, loading ──
  const newBtn = newButton(ctx, 'New application', () => void openEditor(null));
  const updated = liveIndicator(ctx, () => void load(), { live: false });

  const load = async (): Promise<void> => {
    try {
      const [list, services] = await Promise.all([getDocDbs(), getServiceList().catch(() => null)]);
      if (!alive) return;
      apps = list.sort((x, y) => x.Name.localeCompare(y.Name) || x.Namespace.localeCompare(y.Namespace));
      service = services?.find((s) => s.Name === SERVICE) ?? null;
      loaded = true;
      updated(new Date());
      renderService();
      renderGrid();
      renderFoot();
      banner();
      if (!editor) { if (selected && apps.some((x) => keyOf(x) === selected)) renderDetail(); else closeDetail(); }
    } catch (err) {
      if (!alive) return;
      grid = null;
      toolbar.hidden = true;
      wrap.innerHTML = errorPanel(err, 'dd-retry');
      wrap.querySelector('#dd-retry')?.addEventListener('click', () => void load());
    }
  };

  $('#dd-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    if (loaded) renderGrid();
  });

  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    if (!editor && selected) renderDetail();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  getSecurityGraph().then((g) => {
    graph = g;
    if (!alive || !loaded) return;
    renderGrid(); banner();
    if (!editor && selected) renderDetail();
  }).catch(() => { /* who-can lines say nothing rather than guess */ });

  void load();
}
