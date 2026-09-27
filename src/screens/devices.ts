// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Devices — the device names IRIS code opens (terminals,
 * printers, files, tapes, spoolers), what each one maps to, and the terminal
 * types that set their margins and control codes.
 *
 * Actions (Use on %Admin_Manage): create, edit, copy and delete devices; tried
 * live on osca_test_… devices only (see api-sys.ts). Terminal types, Telnet
 * and the default I/O routines are shown here and edited in the Management
 * Portal.
 */
import '../styles-security.css';
import '../styles-sys.css';
import {
  getDevices, getDeviceSubtypes, getDeviceSettings, saveDevice, deleteDevice, deviceType, DEVICE_TYPES, BUILTIN_DEVICES,
  sysDocs, sysPortal, type DeviceRow, type DeviceSubtype, type DeviceSettings,
} from '../api-sys';
import { kv, mono, portalButton, setSearch, cellId,
  esc, cell, num, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, viewTabs, bindViewTabs, setViewTabCount,
  type ScreenCtx, type GridColumn,
} from '../ui';
import { pathField,
  AdminError, blockedAttrs, confirm, editorShell, errorText, fieldError, focusField, moreButton, moreMenu, newButton, panelWidth, readForm,
  section, selectField, textField, toast, scrollPanelTop, type EditorHandle, type FieldProblem, type MenuHandle,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
type View = 'devices' | 'types' | 'defaults';

const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');
const dimText = (s: string): string => `<span class="dim">${esc(s)}</span>`;

const PROMPTS = [
  { value: '', label: 'Ask, offering this device as the default' },
  { value: '1', label: 'Use it without asking, if it’s the current device' },
  { value: '2', label: 'Use it without asking, with its preset margin and parameters' },
];
const promptWords = (p: unknown): string => PROMPTS.find((x) => x.value === String(p ?? ''))?.label ?? String(p);
/** Type filter groups: both tape kinds share one. */
const GROUPS: Array<{ value: string; label: string; types: string[] }> = [
  { value: 'all', label: 'All', types: [] },
  { value: 'TRM', label: 'Terminals', types: ['TRM'] },
  { value: 'OTH', label: 'Printers & files', types: ['OTH'] },
  { value: 'SPL', label: 'Spoolers', types: ['SPL'] },
  { value: 'TAPE', label: 'Tapes', types: ['MT', 'BT'] },
  { value: 'IPC', label: 'Interprocess', types: ['IPC'] },
];
/** Terminal-type prefixes, as IRIS names them. */
const subtypeKind = (n: string): string => (n.startsWith('C-') ? 'Screen terminal' : n.startsWith('P-') ? 'Printer' : n === 'M/UX' ? 'Tape or file' : n === 'MAIL' ? 'Mail' : 'Other');

export function devicesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    ${viewTabs('dev-view', [{ value: 'devices', label: 'Devices' }, { value: 'types', label: 'Terminal types' }, { value: 'defaults', label: 'Defaults' }], 'devices')}
    <div class="toolbar-row" id="dev-toolbar">
      <div class="search-box"><ev-search id="dev-search" size="sm" full-width placeholder="Filter by name, physical device or description" aria-label="Filter devices"></ev-search></div>
      <ev-segmented-button id="dev-scope" size="sm" aria-label="Device type"></ev-segmented-button>
    </div>
    <ev-detail-panel id="dev-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="dev-wrap">${skeleton(8)}</div>
      <aside slot="detail" class="detail" id="dev-detail" aria-label="Device"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="dev-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#dev-panel');
  const wrap = $('#dev-wrap');
  const detail = $('#dev-detail');
  // Physical device also takes device numbers and Windows devices (|PRN|): those aren't paths, so the
  // path field's "Not found on the server" check is kept from running on them.
  detail.addEventListener('focusout', (e) => {
    const input = e.target as HTMLElement & { value?: string };
    if (input.getAttribute?.('name') !== 'PhysicalDevice') return;
    const v = String(input.value ?? '').trim();
    if (!/^\d+$/.test(v) && !/^\|.*\|$/.test(v)) return;
    e.stopPropagation();
    const hint = input.closest('[data-path-field]')?.nextElementSibling as HTMLElement | null;
    if (hint?.classList.contains('crud-path-hint')) { hint.textContent = ''; hint.hidden = true; }
  });
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#dev-scope');
  const searchEl = $<HTMLElement & { value: string; placeholder: string }>('#dev-search');

  let alive = true;
  let devices: DeviceRow[] = [];
  let subtypes: DeviceSubtype[] = [];
  let settings: DeviceSettings | null = null;
  let loaded = false;
  let view: View = 'devices';
  let query = '';
  let group = 'all';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let gridView: View | null = null;
  let rowSig = '';
  let canEdit: boolean | null = null;
  let menu: MenuHandle | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; };
  const mayLeave = async (): Promise<boolean> => { if (editor && !(await editor.guard())) return false; leaveEdit(); return true; };
  ctx.onLeave(() => { alive = false; leaveEdit(); menu?.destroy(); });
  const blocked = (): string | null => (canEdit === false ? NO_MANAGE : null);

  // ── Defaults tab: Telnet and the default output routines ──
  const renderDefaults = (): void => {
    grid = null; gridView = null; rowSig = '';
    $('#dev-toolbar').hidden = true;
    setPanel(false);
    if (!settings) { wrap.innerHTML = emptyState({ icon: 'settings', title: 'Defaults not available', what: 'IRIS didn’t return its Telnet and output settings.' }); return; }
    const t = settings.TelnetSettings;
    const io = settings.IOSettings;
    const dns = String(t.DNSLookup).toUpperCase() === 'ON';
    wrap.innerHTML = `<div class="sys-defaults">
      <section class="sys-card" aria-label="Telnet">
        <header><h3>Telnet (Windows)</h3>${portalButton(sysPortal.telnet, 'Edit in Management Portal')}</header>
        <dl class="kv-list">
          ${kv('Port', mono(t.Port))}
          ${kv('Host name lookup', dns ? 'Enabled' : 'Disabled')}
        </dl>
      </section>
      <section class="sys-card" aria-label="Default output">
        <header><h3>Default output</h3>${portalButton(sysPortal.io, 'Edit in Management Portal')}</header>
        <dl class="kv-list">
          ${kv('Terminals', mono(io.Terminal))}
          ${kv('Files', mono(io.File))}
          ${kv('Tapes', mono(io.MagTape))}
          ${kv('Other devices', mono(io.Other))}
        </dl>
      </section>
    </div>`;
  };

  // ── Grids ──
  const DEV_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Name', width: '130px', sortable: true, description: 'What code opens, e.g. OPEN "TERM"', renderCell: (v) => cellId(v) },
    { key: 'TypeLabel', label: 'Type', width: '140px', sortable: true },
    { key: 'PhysicalDevice', label: 'Physical device', width: '180px', sortable: true, description: 'What IRIS actually opens: a device number, a Windows device, or a file path', renderCell: (v) => cell.num(String(v ?? ''), String(v ?? '')) },
    { key: 'SubType', label: 'Terminal type', width: '150px', sortable: true, description: 'Sets the margin, page length and control codes', renderCell: (v) => cell.text(v) },
    { key: 'Description', label: 'Description', sortable: true, renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('—')) },
    { key: 'Alias', label: 'Number', width: '80px', sortable: true, align: 'right', description: 'An optional number code can open instead of the name', renderCell: (v) => (v ? cell.num(String(v)) : cell.dim('—')) },
  ];
  const TYPE_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Name', width: '170px', sortable: true, renderCell: (v) => cellId(v) },
    { key: 'Kind', label: 'For', width: '140px', sortable: true },
    { key: 'RightMargin', label: 'Line width', width: '100px', sortable: true, align: 'right', description: 'Characters per line (right margin)', renderCell: (v) => cell.num(String(v)) },
    { key: 'ScreenLength', label: 'Page length', width: '110px', sortable: true, align: 'right', description: 'Lines per screen or page', renderCell: (v) => cell.num(String(v)) },
    { key: 'Used', label: 'Used by', sortable: true, align: 'right', width: '90px', description: 'Devices that use this terminal type', renderCell: (v) => (Number(v) ? cell.num(`${v} device${Number(v) === 1 ? '' : 's'}`) : cell.dim('—')) },
  ];
  const SECONDARY: Record<View, string[]> = { devices: ['Description', 'Alias'], types: ['Used'], defaults: [] };

  const inGroup = (d: DeviceRow, g: string): boolean => g === 'all' || (GROUPS.find((x) => x.value === g)?.types ?? []).includes(d.Type);
  const devRows = (): DataGridRow[] => devices.filter((d) => inGroup(d, group) && (!query || [d.Name, d.PhysicalDevice, d.Description, d.SubType, deviceType(d.Type), String(d.Alias ?? '')]
    .some((x) => String(x ?? '').toLowerCase().includes(query.toLowerCase()))))
    .map((d) => ({ Name: d.Name, TypeLabel: deviceType(d.Type), PhysicalDevice: d.PhysicalDevice, SubType: d.SubType, Description: d.Description, Alias: d.Alias || '' }));
  const typeRows = (): DataGridRow[] => subtypes.filter((s) => !query || [s.Name, subtypeKind(s.Name)].some((x) => x.toLowerCase().includes(query.toLowerCase())))
    .map((s) => ({ Name: s.Name, Kind: subtypeKind(s.Name), RightMargin: s.RightMargin, ScreenLength: s.ScreenLength, Used: devices.filter((d) => d.SubType === s.Name).length }));

  const uniformDevKeys = (): string[] => {
    if (devices.length < 2) return [];
    const val = (d: DeviceRow, k: string): string => (k === 'TypeLabel' ? deviceType(d.Type) : String((d as unknown as Record<string, unknown>)[k] ?? ''));
    return ['TypeLabel', 'SubType', 'Description'].filter((k) => devices.every((d) => val(d, k) === val(devices[0], k)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    for (const k of SECONDARY[view] ?? []) grid?.setColumnVisible(k, !open);
    if (view === 'devices' && !devices.some((d) => d.Alias)) grid?.setColumnVisible('Alias', false);
    if (view === 'devices') for (const k of uniformDevKeys()) grid?.setColumnVisible(k, false);
  };
  const closeDetail = (): void => { leaveEdit(); selected = null; grid?.select([]); setPanel(false); };

  const renderToolbar = (): void => {
    const groups = GROUPS.filter((g) => g.value === 'all' || devices.some((d) => inGroup(d, g.value)));
    scopeEl.options = groups.map((g) => ({ value: g.value, label: `${g.label} ${devices.filter((d) => inGroup(d, g.value)).length}` }));
    scopeEl.hidden = view !== 'devices';
    searchEl.placeholder = view === 'devices' ? 'Filter by name, physical device or description' : 'Filter terminal types';
    setViewTabCount(ctx.body, 'dev-view', 'devices', devices.length);
    setViewTabCount(ctx.body, 'dev-view', 'types', subtypes.length);
  };

  const renderGrid = (): void => {
    if (view === 'defaults') { renderDefaults(); return; }
    const total = view === 'devices' ? devices.length : subtypes.length;
    if (!total) {
      grid = null; gridView = null; rowSig = '';
      $('#dev-toolbar').hidden = true;
      wrap.innerHTML = view === 'devices'
        ? emptyState({ icon: 'terminal', title: 'No devices', what: 'IRIS has no device definitions, so code can only use devices it names in full.', why: 'Devices give code short names, such as TERM or a printer, for what it reads and writes.', docs: { href: sysDocs.devices, label: 'About devices' } })
        : emptyState({ icon: 'terminal', title: 'No terminal types', what: 'IRIS has no terminal types defined.', docs: { href: sysDocs.devices, label: 'About devices' } });
      return;
    }
    $('#dev-toolbar').hidden = false;
    setSearch(searchEl, total, { query, filtered: view === 'devices' && group !== 'all' });
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
      grid.setAttribute('aria-label', view === 'devices' ? 'Devices' : 'Terminal types');
      grid.columns = view === 'devices' ? DEV_COLUMNS : TYPE_COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => void select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name)));
      wrap.appendChild(grid);
    }
    const list = view === 'devices' ? devRows() : typeRows();
    const sig = JSON.stringify(list);
    if (sig !== rowSig) { rowSig = sig; grid.rows = list; }
    for (const k of SECONDARY[view]) grid.setColumnVisible(k, !panel.open);
    if (view === 'devices' && !devices.some((d) => d.Alias)) grid.setColumnVisible('Alias', false);
    // A column that says the same thing on every device steps aside.
    if (view === 'devices') for (const k of uniformDevKeys()) grid.setColumnVisible(k, false);
    if (selected) grid.select([selected]);
    wrap.querySelector('.sys-empty')?.remove();
    grid.hidden = !list.length;
    if (!list.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="sys-empty">${emptyState({
        icon: 'search', title: query ? `Nothing matches “${query}”` : 'No devices of this type',
        what: 'Try another name, or show everything.',
        action: '<button type="button" class="btn btn--sm" data-dev-clear>Show all</button>',
      })}</div>`);
      wrap.querySelector('[data-dev-clear]')?.addEventListener('click', () => { query = ''; group = 'all'; scopeEl.value = 'all'; searchEl.value = ''; renderGrid(); });
    }
  };

  const renderFoot = (): void => {
    const sep = '<span class="meta-sep">·</span>';
    const terminals = devices.filter((d) => inGroup(d, 'TRM')).length;
    $('#dev-foot').innerHTML = view === 'defaults' ? '' : view === 'devices'
      ? `<b>${num(devices.length)}</b> device${devices.length === 1 ? '' : 's'}${sep}<b>${num(terminals)}</b> terminal${terminals === 1 ? '' : 's'}`
      : `<b>${num(subtypes.length)}</b> terminal type${subtypes.length === 1 ? '' : 's'}${sep}<b>${num(subtypes.filter((s) => devices.some((d) => d.SubType === s.Name)).length)}</b> in use`;
  };

  // ── Detail ──
  const select = async (name: string): Promise<void> => {
    if (!(await mayLeave())) { if (selected) grid?.select([selected]); return; }
    selected = name;
    grid?.select([name]);
    renderDetail();
  };
  const goTo = (v: View, name: string): void => {
    if (view !== v) {
      view = v;
      ctx.body.querySelectorAll<HTMLElement>('#dev-view button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === v)));
      query = ''; searchEl.value = ''; group = 'all'; scopeEl.value = 'all';
      renderToolbar();
      renderFoot();
    }
    selected = name;
    renderGrid();
    renderDetail();
  };

  const renderDetail = (): void => {
    if (editor) return;
    menu?.destroy(); menu = null;
    if (view === 'defaults') return;
    if (view === 'types') { renderType(); return; }
    const d = devices.find((x) => x.Name === selected);
    if (!d) { closeDetail(); return; }
    const st = subtypes.find((s) => s.Name === d.SubType);
    const alt = d.AlternateDevice ? devices.find((x) => x.Name === d.AlternateDevice) : undefined;
    const altOf = devices.filter((x) => x.AlternateDevice === d.Name);
    const builtIn = BUILTIN_DEVICES.has(d.Name);
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">${esc(deviceType(d.Type))}</span><h2 class="mono">${esc(d.Name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="dev-close"></ev-icon-button>
      </header>
      <div class="detail-state"><span class="dim">${builtIn ? 'Comes with IRIS' : 'Added on this instance'}</span></div>
      <div class="detail-actions">
        <button type="button" class="btn btn--sm" id="dev-edit"${blockedAttrs(blocked())}>Edit</button>
        ${portalButton(sysPortal.device(d.Name), 'Management Portal')}
        ${moreButton('dev-more', `More actions for ${d.Name}`)}
      </div>
      ${canEdit === false ? `<p class="detail-note">${esc(NO_MANAGE)}</p>` : ''}
      <p class="sys-text">Code that opens <b class="mono">${esc(d.Name)}</b>${d.Alias ? ` (or number <b>${esc(d.Alias)}</b>)` : ''} gets <b class="mono">${esc(d.PhysicalDevice)}</b>${d.Description ? `: ${esc(d.Description)}` : ''}.</p>
      <h3 class="detail-section">Device</h3>
      <dl class="kv-list">
        ${kv('Type', esc(deviceType(d.Type)))}
        ${kv('Physical device', mono(d.PhysicalDevice), d.PhysicalDevice)}
        ${kv('Number', d.Alias ? mono(d.Alias) : dimText('—'))}
        ${kv('Open parameters', d.OpenParameters ? mono(d.OpenParameters) : dimText('—'), d.OpenParameters)}
        ${kv('At the device prompt', esc(promptWords(d.Prompt)), promptWords(d.Prompt))}
        ${kv('Alternate device', d.AlternateDevice ? (alt ? `<button type="button" class="link mono" data-dev="${esc(alt.Name)}">${esc(alt.Name)}</button>` : `${mono(d.AlternateDevice)} <span class="dim">· not defined</span>`) : dimText('—'))}
      </dl>
      <h3 class="detail-section">Terminal type</h3>
      <dl class="kv-list">
        ${kv('Type', `<button type="button" class="link mono" data-type="${esc(d.SubType)}">${esc(d.SubType)}</button>`)}
        ${st ? `${kv('Line width', `${esc(st.RightMargin)} characters`)}${kv('Page length', `${esc(st.ScreenLength)} lines`)}` : kv('Settings', dimText('Not defined'))}
      </dl>
      ${altOf.length ? `<h3 class="detail-section">Alternate device for</h3>
      <ul class="sys-list">${altOf.map((x) => `<li><button type="button" class="link mono" data-dev="${esc(x.Name)}">${esc(x.Name)}</button><span>${esc(deviceType(x.Type))}</span></li>`).join('')}</ul>` : ''}`;
    setPanel(true);
    detail.querySelector('#dev-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#dev-edit')?.addEventListener('click', () => void openEditor(d.Name));
    detail.querySelectorAll<HTMLElement>('[data-dev]').forEach((b) => b.addEventListener('click', () => void select(b.dataset.dev ?? '')));
    detail.querySelectorAll<HTMLElement>('[data-type]').forEach((b) => b.addEventListener('click', () => goTo('types', b.dataset.type ?? '')));
    const more = detail.querySelector<HTMLElement>('#dev-more');
    if (more) {
      const why = blocked() ?? undefined;
      menu = moreMenu(more, [
        { label: 'Copy…', icon: 'copy', disabled: !!why, reason: why, onSelect: () => void openEditor(null, d.Name) },
        { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!why, reason: why, onSelect: () => void doDelete(d) },
      ]);
    }
  };

  const renderType = (): void => {
    const s = subtypes.find((x) => x.Name === selected);
    if (!s) { closeDetail(); return; }
    const users = devices.filter((d) => d.SubType === s.Name);
    const code = (v: string): string => (v ? mono(v) : dimText('—'));
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">Terminal type · ${esc(subtypeKind(s.Name))}</span><h2 class="mono">${esc(s.Name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="dev-close"></ev-icon-button>
      </header>
      <div class="detail-actions">${portalButton(sysPortal.subtype(s.Name), 'Edit in Management Portal')}</div>
      <p class="sys-text">Tells IRIS how wide a line is, how long a page is, and which control codes clear the screen, move the cursor and start a new page on this kind of terminal or printer.</p>
      <h3 class="detail-section">Page</h3>
      <dl class="kv-list">
        ${kv('Line width', `${esc(s.RightMargin)} characters`)}
        ${kv('Page length', `${esc(s.ScreenLength)} lines`)}
      </dl>
      <h3 class="detail-section">Control codes</h3>
      <dl class="kv-list">
        ${kv('New page', code(s.FormFeed), s.FormFeed)}
        ${kv('Backspace', code(s.Backspace), s.Backspace)}
        ${kv('Move cursor', code(s.CursorControl), s.CursorControl)}
        ${kv('Clear to end of line', code(s.EraseEOL), s.EraseEOL)}
        ${kv('Clear to end of screen', code(s.EraseEOF), s.EraseEOF)}
      </dl>
      <h3 class="detail-section">Used by</h3>
      ${users.length ? `<ul class="sys-list">${users.map((d) => `<li><button type="button" class="link mono" data-dev="${esc(d.Name)}">${esc(d.Name)}</button><span>${esc(deviceType(d.Type))}</span></li>`).join('')}</ul>` : '<p class="sys-none">No device uses it.</p>'}`;
    setPanel(true);
    detail.querySelector('#dev-close')?.addEventListener('click', closeDetail);
    detail.querySelectorAll<HTMLElement>('[data-dev]').forEach((b) => b.addEventListener('click', () => goTo('devices', b.dataset.dev ?? '')));
  };

  // ── Delete ──
  const doDelete = async (d: DeviceRow): Promise<void> => {
    const builtIn = BUILTIN_DEVICES.has(d.Name);
    const altOf = devices.filter((x) => x.AlternateDevice === d.Name).map((x) => x.Name);
    const ok = await confirm({
      title: `Delete device ${d.Name}?`,
      body: `<p>Code that opens <b class="mono">${esc(d.Name)}</b>${d.Alias ? ` or number ${esc(d.Alias)}` : ''} by name stops finding it. The physical device${d.Type === 'OTH' ? ' or file' : ''} itself isn’t touched.</p>
        ${builtIn ? '<p><b>This device comes with IRIS.</b> Terminals, the device prompt and printing may rely on it.</p>' : ''}
        ${altOf.length ? `<p>It is the alternate device for <b class="mono">${esc(altOf.join(', '))}</b>, which will point at a device that doesn’t exist.</p>` : ''}`,
      confirmLabel: 'Delete device',
      danger: true,
      typeToConfirm: builtIn || altOf.length ? d.Name : undefined,
    });
    if (!ok) return;
    try {
      await deleteDevice(d.Name);
      closeDetail();
      await load();
      toast(`Device ${d.Name} deleted.`);
    } catch (err) {
      if (err instanceof AdminError && err.status === 404) { toast(`Device ${d.Name} no longer exists.`, 'info'); await load(); return; }
      toast(errorText(err), 'danger');
    }
  };

  // ── Create / edit ──
  const openEditor = async (name: string | null, copyOf?: string): Promise<void> => {
    if (!(await mayLeave())) return;
    const src = devices.find((x) => x.Name === (name ?? copyOf));
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    const creating = !name;
    const typeOpts = DEVICE_TYPES.map((t) => ({ value: t.value, label: t.label }));
    const stOpts = subtypes.map((s) => ({ value: s.Name, label: `${s.Name} · ${subtypeKind(s.Name)}` }));
    const altOpts = [{ value: '', label: 'None' }, ...devices.filter((x) => x.Name !== name).map((x) => ({ value: x.Name, label: `${x.Name} · ${deviceType(x.Type)}` }))];
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : copyOf ? `Copy of <span class="mono">${esc(copyOf)}</span>` : 'New device',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Create device',
      startDirty: !!copyOf,
      sections:
        section('Device',
          (creating ? textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'What code opens, e.g. OPEN "REPORTS".' }) : '') +
          selectField('Type', 'Type', typeOpts, src?.Type ?? 'OTH') +
          pathField('PhysicalDevice', 'Physical device', src?.PhysicalDevice ?? '', { required: true, mode: 'file', title: 'Choose a file for this device', hint: 'A device number, a Windows device such as |PRN|, or a file path.' }) +
          textField('Description', 'Description', src?.Description ?? '', { maxlength: 256, hint: 'Where it is or what it’s for.' })) +
        section('How it behaves',
          selectField('SubType', 'Terminal type', stOpts, src?.SubType ?? (subtypes.find((s) => s.Name === 'P-DEC') ? 'P-DEC' : subtypes[0]?.Name ?? ''), { searchable: stOpts.length > 8, hint: 'Sets the line width, page length and control codes.' }) +
          textField('OpenParameters', 'Open parameters', src?.OpenParameters ?? '', { mono: true, hint: 'Passed to OPEN as its parameters, e.g. "WNS" to write a new file.' }) +
          selectField('Prompt', 'At the device prompt', PROMPTS, String(src?.Prompt ?? ''))) +
        section('Other names',
          `<div class="crud-row">${textField('Alias', 'Number', src && name ? String(src.Alias || '') : '', { mono: true, width: '140px', hint: 'Optional. Unique.' })}${
            selectField('AlternateDevice', 'Alternate device', altOpts, src?.AlternateDevice ?? '', { searchable: altOpts.length > 8, hint: 'Offered as “A” at the device prompt.' })}</div>`),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (creating) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (/[,=]/.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Leave out commas and equals signs' });
          else if (devices.some((x) => x.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A device with this name already exists' });
        }
        if (!String(v.PhysicalDevice ?? '').trim()) out.push({ field: 'PhysicalDevice', label: 'Physical device', message: 'Enter what IRIS should open' });
        if (!String(v.SubType ?? '')) out.push({ field: 'SubType', label: 'Terminal type', message: 'Choose a terminal type' });
        const alias = String(v.Alias ?? '').trim();
        if (alias) {
          const n = Number(alias);
          if (!Number.isInteger(n) || n < 1) out.push({ field: 'Alias', label: 'Number', message: 'Enter a whole number, 1 or more' });
          else {
            const other = devices.find((x) => x.Name !== name && String(x.Alias) === String(n));
            if (other) out.push({ field: 'Alias', label: 'Number', message: `${other.Name} already uses number ${n}` });
          }
        }
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        const alias = String(v.Alias ?? '').trim();
        try {
          await saveDevice(target, {
            Type: String(v.Type), PhysicalDevice: String(v.PhysicalDevice).trim(), Description: String(v.Description ?? '').trim(),
            SubType: String(v.SubType), OpenParameters: String(v.OpenParameters ?? '').trim(), Prompt: String(v.Prompt ?? ''),
            Alias: alias ? Number(alias) : '', AlternateDevice: String(v.AlternateDevice ?? ''),
          });
        } catch (err) {
          if (err instanceof AdminError && /alias/i.test(err.message)) { fieldError(detail, 'Alias', err.message); focusField(detail, 'Alias'); }
          throw err;
        }
        leaveEdit();
        selected = target;
        await load();
        scrollPanelTop(detail);
        toast(name ? `Device ${target} saved.` : `Device ${target} created.`);
      },
      onCancel: () => { leaveEdit(); if (selected && devices.some((x) => x.Name === selected)) renderDetail(); else closeDetail(); },
    });
  };

  // ── Loading ──
  const paint = (): void => {
    renderToolbar();
    renderGrid();
    renderFoot();
    if (selected && !editor) renderDetail();
  };
  const updated = liveIndicator(ctx, () => void load(), { live: false });
  const load = async (): Promise<void> => {
    try {
      const [d, s, set] = await Promise.all([getDevices(), getDeviceSubtypes(), getDeviceSettings().catch(() => null)]);
      if (!alive) return;
      devices = d; subtypes = s; settings = set;
      loaded = true;
      const pool = view === 'devices' ? devices : subtypes;
      if (selected && !pool.some((x) => x.Name === selected) && !editor) closeDetail();
      updated(new Date());
      paint();
    } catch (err) {
      if (!alive || loaded) { if (loaded) toast(errorText(err), 'danger'); return; }
      grid = null;
      wrap.innerHTML = errorPanel(err, 'dev-retry');
      wrap.querySelector('#dev-retry')?.addEventListener('click', () => void load());
    }
  };

  const newBtn = newButton(ctx, 'New device', () => void openEditor(null));
  void sessionInfo().then((info) => can(info, 'Manage'), () => null).then((ok) => {
    canEdit = ok;
    newBtn.setHidden(canEdit === false);
    if (alive && selected && !editor) renderDetail();
  });

  bindViewTabs(ctx.body, 'dev-view', async (v) => {
    if (!(await mayLeave())) return;
    view = v as View;
    query = ''; searchEl.value = '';
    selected = null; setPanel(false);
    newBtn.setHidden(canEdit === false || view !== 'devices');
    if (loaded) { renderToolbar(); renderGrid(); renderFoot(); }
  });
  searchEl.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    if (loaded) renderGrid();
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => {
    group = (e as CustomEvent<{ value: string }>).detail.value;
    renderGrid();
  });
  scopeEl.value = 'all';

  void load();
}
