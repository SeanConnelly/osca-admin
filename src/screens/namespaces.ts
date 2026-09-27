// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Databases › Namespaces — where code runs and which databases each
 * namespace reads: its data (globals), its code (routines and classes), its
 * temporary data, and anything mapped in from other databases. Answers "where
 * does USER's data live?", "which databases must someone be able to read to
 * open this namespace?" and "is interoperability switched on here?".
 *
 * New namespace (header): a form in the panel that creates the namespace on
 * existing databases or on new ones made in the same step, and can switch on
 * interoperability. Edit (header) changes its data, code and temporary
 * databases in the same form, and can switch interoperability on; from the
 * full view it takes the page body's place (as on Web applications), so the
 * address and ‹ n of N › stay. The full
 * view's Mappings card adds, changes and removes global, routine and package
 * mappings (each row's ⋯; interoperability's own are read only, behind a toggle
 * chip); ⋯ deletes a namespace (not %SYS, USER or one a web application runs
 * in). See api-db.ts for what was verified.
 */
import '../styles-security.css';
import '../styles-services.css';
import '../styles-db.css';
import {
  getNamespacesFull, getDatabases, linkToScreen, createDb, deleteDb, createNamespace, updateNamespace, enableInterop, namespaceExists, dirKey,
  saveMapping, deleteMapping, mappingExists, deleteNamespace, type NamespaceFull, type Db, type MappingKind,
} from '../api-db';
import { getWebAppList } from '../api-apps';
import { linkTo, takeSelection } from '../api-security';
import {
  newButton, scrollPanelTop, editorShell, panelWidth, section, textField, pathField, selectField, checkField, readForm,
  fieldError, focusField, toast, errorText, confirm, moreMenu, SubmitCancelled, type EditorHandle, type FieldProblem, type MenuItem, type MenuHandle,
} from '../crud';
import {
  plural,
  esc, chip, cell, cellId, cellRef, num, dataSize, skeleton, errorPanel, liveIndicator, emptyState, uniformKeys, noPermissionText, setChips,
  objectDetail, odMeta, odSection, odKv, type ScreenCtx, type GridColumn, type OdFull,
} from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const DB_ROUTE = 'databases/databases';
const NS_ROUTE = 'databases/namespaces';
/** Mappings listed per kind before "and N more". */
const SHOW = 12;

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; sortColumn: string; sortDirection: string; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
type View = 'all' | 'interop' | 'mapped';

const mappingCount = (n: NamespaceFull): number => n.globals.length + n.routines.length + n.packages.length;

const RES_ROUTE = 'security/resources';
/** A cross-reference the portal has a screen for: always a link (the grid's click handler opens it with the item selected). */
const refLink = (attr: 'db' | 'res', v: unknown, title: string): string => (v
  ? cellRef(v, `#/${attr === 'db' ? DB_ROUTE : RES_ROUTE}`, title)
  : cell.dim('—'));
/** Interoperability is a feature flag, not health: plain words, no dot. Enabled in primary text, Disabled in tertiary. */
const flag = (on: boolean, text: string, title = ''): string =>
  `<span style="white-space:nowrap;color:var(--ev-color-text-${on ? 'primary' : 'tertiary'})"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

const COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'Namespace', width: '150px', sortable: true, renderCell: (v) => cellId(v) },
  { key: 'Globals', label: 'Data database', description: 'The database that holds its data (globals) unless a mapping says otherwise', width: '150px', sortable: true, renderCell: (v, row) => (row.GlobalsDown ? chip(String(v), 'warning', 'This database is dismounted') : refLink('db', v, `Open ${v} in Databases`)) },
  { key: 'Routines', label: 'Code database', description: 'The database that holds its code (routines and classes) unless a mapping says otherwise', width: '150px', sortable: true, renderCell: (v, row) => (row.RoutinesDown ? chip(String(v), 'warning', 'This database is dismounted') : refLink('db', v, `Open ${v} in Databases`)) },
  { key: 'Temp', label: 'Temporary database', description: 'Where its temporary globals go; normally IRISTEMP, which is emptied at every restart', width: '140px', sortable: true, renderCell: (v) => cell.mono(v, true) },
  { key: 'Interop', label: 'Interoperability', description: 'Whether productions (interoperability) are enabled in this namespace', width: '120px', sortable: true, renderCell: (v) => flag(v === 'On', v === 'On' ? 'Enabled' : 'Disabled') },
  { key: 'Mappings', label: 'Mappings', description: 'Globals, routines and packages this namespace reads from other databases', width: '96px', sortable: true, align: 'right',
    renderCell: (v, row) => (row.Unknown ? `<span title="Its mappings couldn’t be read">${cell.dim('—')}</span>` : cell.count(Number(v), String(row.MapTitle))) },
  { key: 'Needs', label: 'Required resource', description: 'The resource on its data database: people need Read on it to open the namespace', width: '160px', sortable: true, renderCell: (v) => refLink('res', v, `Open ${v} in Resources`) },
];
const SECONDARY = ['Temp', 'Needs'];

export function namespacesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  // Two levels (objectDetail): the list with a peek, and a full view of one namespace (#/databases/namespaces/<name>).
  ctx.body.innerHTML = `
    <div class="od-list" id="ns-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="ns-search" size="sm" full-width placeholder="Filter by namespace or database"></ev-search></div>
        <ev-segmented-button id="ns-view" size="sm" aria-label="Show namespaces"></ev-segmented-button>
      </div>
      <ev-detail-panel id="ns-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="ns-grid-wrap">${skeleton(6)}</div>
        <aside slot="detail" class="detail" id="ns-detail" aria-label="Namespace details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="ns-foot"></p>
    </div>
    <div id="ns-full" hidden></div>`;
  const listView = ctx.body.querySelector('#ns-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#ns-full') as HTMLElement;

  const viewEl = ctx.body.querySelector('#ns-view') as HTMLElement & { options: unknown; value: string };
  const searchEl = ctx.body.querySelector('#ns-search') as HTMLElement & { value: string };
  const panel = ctx.body.querySelector('#ns-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#ns-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#ns-detail') as HTMLElement;
  viewEl.value = 'all';

  let all: NamespaceFull[] = [];
  let dbs: Db[] = [];
  let grid: GridEl | null = null;
  let view: View = 'all';
  let query = '';
  let selected: string | null = null;
  let pending = takeSelection();
  let loaded = false;
  let alive = true;
  ctx.onLeave(() => { alive = false; });

  const db = (name: string): Db | undefined => dbs.find((d) => d.name === name);
  const down = (name: string): boolean => db(name)?.state === 'dismounted';
  const matchView = (n: NamespaceFull, v: View): boolean => v === 'all' || (v === 'interop' ? n.interop : mappingCount(n) > 0);
  const visible = (): NamespaceFull[] => all.filter((n) => {
    if (!matchView(n, view)) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return [n.Name, n.Globals, n.Routines, n.TempGlobals].some((f) => f.toLowerCase().includes(q));
  });

  const toRow = (n: NamespaceFull): DataGridRow => ({
    Name: n.Name, Globals: n.Globals, Routines: n.Routines, Temp: n.TempGlobals,
    GlobalsDown: down(n.Globals), RoutinesDown: down(n.Routines),
    Interop: n.interop ? 'On' : 'Off', Mappings: mappingCount(n), Unknown: n.mappingsUnknown,
    MapTitle: `${plural(n.globals.length, 'global mapping')}, ${plural(n.routines.length, 'routine mapping')}, ${plural(n.packages.length, 'package mapping')}`,
    Needs: db(n.Globals)?.resource ?? '',
  });

  const renderToolbar = (): void => {
    const nv = (v: View): number => all.filter((n) => matchView(n, v)).length;
    // Filter chips can't help on a short list: setChips hides them at 5 rows or fewer.
    setChips(viewEl, all.length, [
      { value: 'all', label: `All ${nv('all')}` },
      { value: 'interop', label: `Interoperability enabled ${nv('interop')}`, disabled: nv('interop') === 0 && view !== 'interop' },
      { value: 'mapped', label: `With mappings ${nv('mapped')}`, disabled: nv('mapped') === 0 && view !== 'mapped' },
    ], { active: view, search: searchEl, query });
  };
  const renderFoot = (): void => {
    const sep = '<span class="meta-sep">·</span>';
    const used = new Set(all.flatMap((n) => [n.Globals, n.Routines]));
    const unused = dbs.filter((d) => !d.system && d.state !== 'remote' && !used.has(d.name) && !all.some((n) => n.globals.some((m) => m.Database === d.name) || n.routines.some((m) => m.Database === d.name) || n.packages.some((m) => m.Database === d.name)));
    (ctx.body.querySelector('#ns-foot') as HTMLElement).innerHTML =
      `<b>${num(all.length)}</b> namespace${all.length === 1 ? '' : 's'}${sep}<b>${num(all.filter((n) => n.interop).length)}</b> with interoperability${sep}<b>${num(used.size)}</b> database${used.size === 1 ? '' : 's'} in use`
      + (unused.length ? `${sep}<b>${num(unused.length)}</b> database${unused.length === 1 ? '' : 's'} in no namespace` : '');
  };
  const renderBanner = (): void => {
    const broken = all.filter((n) => down(n.Globals) || down(n.Routines));
    if (!broken.length) { ctx.banners.innerHTML = ''; return; }
    const lines = broken.slice(0, 3).map((n) => {
      const gone = [n.Globals, n.Routines].filter((x, i, a) => down(x) && a.indexOf(x) === i);
      return `${n.Name} uses ${gone.join(' and ')}, which ${gone.length === 1 ? 'is' : 'are'} dismounted`;
    });
    ctx.banners.innerHTML = `<div class="sec-callout sec-callout--warning sec-banner" role="status">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <div><strong>${esc(broken.length === 1 ? '1 namespace can’t reach its data or code.' : `${num(broken.length)} namespaces can’t reach their data or code.`)}</strong><span>${esc(`${lines.join('. ')}${broken.length > 3 ? `, and ${num(broken.length - 3)} more` : ''}.`)}</span></div>
      <div class="sec-banner-actions"><button type="button" class="btn btn--sm" data-ns-dbs>Open Databases</button></div>
    </div>`;
    ctx.banners.querySelector('[data-ns-dbs]')?.addEventListener('click', () => ctx.navigate(DB_ROUTE));
  };

  /** Names in the order the grid shows them (its sort, as the user last set it): what ‹ › steps through. */
  const listOrder = (): string[] => {
    const key = grid?.sortColumn || 'Name';
    const dir = grid?.sortDirection === 'desc' ? -1 : 1;
    return visible().map(toRow).sort((a, b) => {
      const va = a[key]; const vb = b[key];
      if (va === null || va === undefined) return dir;
      if (vb === null || vb === undefined) return -dir;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    }).map((r) => String(r.Name));
  };

  const applyColumns = (): void => {
    if (!grid) return;
    const uniform = uniformKeys(all.map(toRow), ['Temp']);
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };

  const renderGrid = (): void => {
    const rows = visible().map(toRow);
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Namespaces');
      grid.columns = COLUMNS;
      grid.addEventListener('click', (e) => {
        const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && /^#\/(databases\/databases|security\/resources)$/.test(n.getAttribute('href') ?? ''));
        if (!a) return;
        e.preventDefault(); e.stopPropagation();
        const text = a.textContent ?? '';
        if (a.getAttribute('href') === `#/${DB_ROUTE}`) linkToScreen(ctx.navigate, DB_ROUTE, text); else linkTo(ctx.navigate, RES_ROUTE, text);
      }, true);
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        // objectDetail asks the New namespace form (if open) before it switches.
        void od.select(name).then(() => { if (od.selected() !== name) grid?.select(selected !== null ? [selected] : []); });
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.ns-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="ns-empty">${emptyState({
        icon: 'search', title: `No namespaces${query ? ` match “${query}”` : ' match these filters'}`,
        what: 'Change the filters above to see more.',
        action: '<button type="button" class="btn btn--sm" data-ns-clear>Show all namespaces</button>',
      })}</div>`);
      wrap.querySelector('[data-ns-clear]')?.addEventListener('click', () => {
        view = 'all'; query = ''; viewEl.value = 'all'; searchEl.value = '';
        renderToolbar(); renderGrid();
      });
    }
  };

  const close = (): void => {
    selected = null;
    grid?.select([]);
    if (od.mode() === 'full') { void od.closeFull().then(() => od.select(null)); return; }
    void od.select(null);
    setPanel(false);
  };
  const open = (name: string): void => {
    if (!all.some((n) => n.Name === name)) return;
    if (!visible().some((n) => n.Name === name)) { view = 'all'; query = ''; viewEl.value = 'all'; searchEl.value = ''; renderToolbar(); }
    selected = name;
    renderGrid();
    renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  /* ───────────── Detail: peek and full view (objectDetail), read only ───────────── */

  const dbLink = (name: string): string => {
    const d = db(name);
    const state = d?.state === 'dismounted' ? ` ${chip('Dismounted', 'warning')}` : d?.state === 'readonly' ? ` <span class="dim">read-only</span>` : '';
    return `<a class="svc-link ns-db" href="#/${DB_ROUTE}" data-db="${esc(name)}">${esc(name)}</a>${state}`;
  };
  const resLink = (name: string): string => `<a class="svc-link mono" href="#/security/resources" data-res="${esc(name)}">${esc(name)}</a>`;

  /** The full view's address; its Mappings card lists every mapping. */
  const fullHref = (name: string): string => `#/${NS_ROUTE}/${encodeURIComponent(name)}`;
  const mappingList = <T extends { Name: string; Database: string }>(n: NamespaceFull, kind: MappingKind, title: string, rows: T[], label: (m: T) => string, show: number): string => {
    if (!rows.length) return '';
    const byDb = new Map<string, number>();
    for (const m of rows) byDb.set(m.Database, (byDb.get(m.Database) ?? 0) + 1);
    return `<p class="chip-sub">${esc(title)} · ${esc([...byDb].map(([d, c]) => `${num(c)} from ${d}`).join(', '))}</p>
      <ul class="ns-mappings">${rows.slice(0, show).map((m) => `<li><span title="${esc(label(m))}">${esc(label(m))}</span><a class="svc-link" href="#/${DB_ROUTE}" data-db="${esc(m.Database)}">${esc(m.Database)}</a></li>`).join('')}</ul>
      ${rows.length > show ? `<p class="ns-more">and ${num(rows.length - show)} more. <a class="svc-link" href="${esc(fullHref(n.Name))}" data-map-all="${esc(kind)}">See them all</a></p>` : ''}`;
  };

  /**
   * Mappings that switching on interoperability made: everything to ENSLIB, plus the whole-global
   * mapping IRIS adds next to each subscript-level one (^EnsEDI.Schema → the namespace's own data
   * database, beside ^EnsEDI.Schema("HIPAA_5010") → ENSLIB). Left as IRIS set them.
   */
  const interopMap = (n: NamespaceFull, kind: MappingKind, m: { Name: string; Database: string; Subscript?: string }): boolean => {
    if (!n.interop) return false;
    if (m.Database === 'ENSLIB') return true;
    return kind === 'global' && !m.Subscript && m.Database === n.Globals
      && n.globals.some((g) => g.Database === 'ENSLIB' && g.Name.startsWith(`${m.Name}(`));
  };
  const interopMapsOf = (n: NamespaceFull): number =>
    n.globals.filter((m) => interopMap(n, 'global', m)).length
    + n.routines.filter((m) => interopMap(n, 'routine', m)).length
    + n.packages.filter((m) => interopMap(n, 'package', m)).length;
  const downOf = (n: NamespaceFull): string[] => [n.Globals, n.Routines].filter((x, i, a) => down(x) && a.indexOf(x) === i);

  const whereHtml = (n: NamespaceFull): string => {
    const where = [
      { what: 'Data', sub: 'globals', dbName: n.Globals },
      { what: 'Code', sub: 'routines and classes', dbName: n.Routines },
      { what: 'Temporary data', sub: 'emptied at every restart', dbName: n.TempGlobals },
      { what: 'System code', sub: '% routines and classes, shared by every namespace', dbName: n.Library },
      { what: 'System data', sub: '% globals, shared by every namespace', dbName: n.SysGlobals },
    ].filter((x) => x.dbName);
    return `<ul class="ns-map">${where.map((w) => `<li><span class="ns-what"><b>${esc(w.what)}</b><span>${esc(w.sub)}</span></span><span>${dbLink(w.dbName)}</span></li>`).join('')}</ul>`;
  };
  /** Two rows: what opening it needs, and what changing its data needs; mapped databases are noted once. */
  const whoHtml = (n: NamespaceFull): string => {
    const res = [...new Set([n.Globals, n.Routines].map((x) => db(x)?.resource ?? '').filter(Boolean))];
    if (!res.length) return '<p class="detail-para dim">—</p>';
    // The resource is named once; what each permission on it allows follows.
    return `${odKv([[res.length === 1 ? 'Resource' : 'Resources', res.map(resLink).join(' and ')], ['Read', 'Opens the namespace'], ['Read & change', 'Also changes its data']])}
      <p class="detail-para dim">Mapped databases have their own resources.</p>`;
  };
  const mappingsHtml = (n: NamespaceFull, show: number): string => {
    const count = mappingCount(n);
    const interopMaps = interopMapsOf(n);
    if (n.mappingsUnknown) return '<p class="detail-para dim">—</p>';
    if (!count) return `<p class="detail-para">None: everything comes from ${esc(n.Globals)}${n.Routines !== n.Globals ? ` and ${esc(n.Routines)}` : ''}.</p>`;
    return `${interopMaps ? `<p class="detail-para">${esc(interopMaps === count ? (count === 1 ? 'It comes' : `All ${num(count)} come`) : `${num(interopMaps)} of them come`)} from switching on interoperability.</p>` : ''}
      ${mappingList(n, 'global', 'Globals', n.globals, (m) => `^${m.Name}`, show)}
      ${mappingList(n, 'routine', 'Routines', n.routines, (m) => m.Name, show)}
      ${mappingList(n, 'package', 'Packages', n.packages, (m) => m.Name, show)}`;
  };

  /** "● Available · Interoperability enabled · 4 mappings", or the databases it can't reach. */
  const metaOf = (n: NamespaceFull): string => {
    const gone = downOf(n);
    return odMeta(gone.length
      ? { label: `${gone.join(' and ')} dismounted`, tone: 'warning', title: 'It can’t reach its data or code until that database is mounted' }
      : { label: 'Available', tone: 'success', title: 'Its data and code databases are mounted' },
    [n.interop ? 'Interoperability enabled' : 'Interoperability disabled']);
  };

  /* ───────────── Delete and mappings (the full view's Mappings card) ───────────── */

  let apps: Array<{ Name: string; Namespace: string }> = [];
  let canManage: boolean | null = null;
  /** Namespaces whose mappings changed on this visit: their card says when the change takes effect. */
  const changed = new Set<string>();
  const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');

  /** Why a namespace can't be deleted here, or null. */
  const deleteWhy = (n: NamespaceFull): string | null => {
    if (n.Name === '%SYS') return 'It’s IRIS’s own namespace.';
    if (n.Name === 'USER') return 'USER is the namespace IRIS installs for applications; it isn’t deleted here.';
    if (canManage === false) return NO_MANAGE;
    // Its own /csp/<ns> web application goes with it; any other web application that runs in it blocks.
    const own = `/csp/${n.Name.toLowerCase()}`;
    const deps = apps.filter((a) => a.Namespace.toUpperCase() === n.Name.toUpperCase() && a.Name.toLowerCase() !== own).map((a) => a.Name);
    if (deps.length) return `${deps.length === 1 ? 'The web application' : 'Web applications'} ${deps.slice(0, 3).join(', ')}${deps.length > 3 ? ` and ${num(deps.length - 3)} more` : ''} ${deps.length === 1 ? 'runs' : 'run'} in it. Move or delete ${deps.length === 1 ? 'it' : 'them'} first.`;
    return null;
  };

  const doDelete = async (n: NamespaceFull): Promise<void> => {
    if (deleteWhy(n)) return;
    const data = n.Globals;
    const kept = [...new Set([n.Globals, n.Routines])];
    // What interoperability made beside it (only when it was switched on, and only what's there).
    const extraDbs = n.interop ? [`${data}ENSTEMP`, `${data}SECONDARY`].filter((x) => db(x)) : [];
    const own = `/csp/${n.Name.toLowerCase()}`;
    const hasApp = apps.some((a) => a.Name.toLowerCase() === own);
    const ok = await confirm({
      title: `Delete namespace ${n.Name}?`,
      body: `<p>IRIS removes the namespace${hasApp ? ` and its web application <span class="mono">${esc(own)}</span>` : ''}, with its mappings. Programs can no longer open it.</p>
        <p>These stay, with their data: ${kept.map((x) => `<b class="mono">${esc(x)}</b>`).join(' and ')}${extraDbs.length ? `, and from interoperability ${extraDbs.map((x) => `<b class="mono">${esc(x)}</b>`).join(' and ')}, the <span class="mono">${esc(`%DB_${data}SECONDARY`)}</span> resource and the <span class="mono">${esc(`%EnsRole_ProdPrivs_${n.Name}`)}</span> role` : ''}. Delete them separately if nothing else needs them.</p>
        <p>Type the name to confirm.</p>`,
      confirmLabel: 'Delete namespace',
      danger: true,
      typeToConfirm: n.Name,
    });
    if (!ok) return;
    try {
      await deleteNamespace(n.Name);
    } catch (err) {
      toast(`Couldn’t delete ${n.Name}. ${errorText(err)}`, 'danger');
      return;
    }
    close();
    await load();
    toast(`Namespace ${n.Name} deleted. Its databases are kept.`);
  };

  const KINDS: Array<{ kind: MappingKind; label: string; plural: string; list: (n: NamespaceFull) => Array<{ Name: string; Database: string; Subscript?: string }> }> = [
    { kind: 'global', label: 'Global', plural: 'Globals', list: (n) => n.globals },
    { kind: 'routine', label: 'Routine', plural: 'Routines', list: (n) => n.routines },
    { kind: 'package', label: 'Package', plural: 'Packages', list: (n) => n.packages },
  ];
  /** Mappings can be changed here, except in %SYS (IRIS's own) and without the manage privilege. */
  const canMap = (n: NamespaceFull): boolean => n.Name !== '%SYS' && canManage !== false && !n.mappingsUnknown;
  const LOCKED_TITLE = 'Set by IRIS: added by switching on interoperability, and read only here';
  /** The read-only cue in an interoperability row's actions cell (the icon set has no lock). */
  const LOCK_ICON = `<span role="img" aria-label="${esc(LOCKED_TITLE)}" title="${esc(LOCKED_TITLE)}" style="display:inline-flex;vertical-align:middle;color:var(--ev-color-text-tertiary)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></span>`;

  /*
   * The Mappings card's grid: Name, Kind, Database and a ⋯ per row (Change, Remove), so every row
   * keeps the grid's height. Interoperability's own mappings sit behind the "Interoperability n"
   * toggle chip and are read only. The filters are kept per namespace across refreshes.
   */
  type MapKindView = 'all' | MappingKind;
  const mapView = { ns: '', kind: 'all' as MapKindView, interop: false, query: '' };
  let mapMenu: MenuHandle | null = null;
  let mapMenuAnchor: HTMLElement | null = null;
  const MAP_BTN = 'display:inline-flex;align-items:center;justify-content:center;width:24px;height:20px;margin:-2px 0;padding:0;border:0;border-radius:4px;background:none;color:var(--ev-color-text-secondary);cursor:pointer;vertical-align:middle';
  const MAP_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Name', sortable: true, renderCell: (v, row) => (row.Interop ? cellRef(v, undefined, LOCKED_TITLE) : cellId(v)) },
    { key: 'Kind', label: 'Kind', width: '96px', sortable: true, renderCell: (v) => cell.text(v) },
    { key: 'Database', label: 'Database', width: '160px', sortable: true, renderCell: (v) => cellRef(v, `#/${DB_ROUTE}`, `Open ${v} in Databases`) },
  ];
  const ACT_COLUMN: GridColumn = { key: 'Act', label: '', width: '40px', align: 'center',
    renderCell: (_v, row) => (row.Interop ? LOCK_ICON : row.Locked ? '' : `<button type="button" data-map-more data-kind="${esc(row.K)}" data-name="${esc(row.Raw)}" data-database="${esc(row.Database)}" aria-label="${esc(`Change or remove ${row.Name}`)}" title="Change or remove" style="${MAP_BTN}"><ev-icon name="more-horizontal" size="xs"></ev-icon></button>`) };

  /**
   * The full view's Mappings card: a toolbar (search, kind chips, and the Interoperability chip pinned
   * to the right end, so it never moves when the others appear), the grid and its empty state. When
   * every mapping is interoperability's and they're hidden, the card says what the peek says (how
   * many, from which databases, by kind) with the grid one click away.
   */
  const mappingsEditHtml = (n: NamespaceFull): string => {
    if (mapView.ns !== n.Name) Object.assign(mapView, { ns: n.Name, kind: 'all', interop: false, query: '' });
    const note = changed.has(n.Name) ? '<p class="detail-para ns-apply-note">Changes apply to new processes. Processes already in the namespace keep the old mappings.</p>' : '';
    if (n.mappingsUnknown) return '<p class="detail-para dim">—</p>';
    if (!mappingCount(n)) return `${note}<p class="detail-para">None: everything comes from ${esc(n.Globals)}${n.Routines !== n.Globals ? ` and ${esc(n.Routines)}` : ''}.</p>`;
    return `${note}
      <div data-map-summary hidden></div>
      <div class="toolbar-row ns-map-bar">
        <div class="search-box ns-map-search"><ev-search data-map-search size="sm" full-width placeholder="Filter by name or database"></ev-search></div>
        <ev-segmented-button data-map-kind size="sm" aria-label="Show mappings of one kind"></ev-segmented-button>
        <button type="button" class="db-toggle-chip ns-map-interop" data-map-interop aria-pressed="false">Interoperability <span class="db-toggle-count" data-map-interop-count></span></button>
      </div>
      <div data-map-grid></div>
      <div class="detail-para ns-map-empty" data-map-empty hidden></div>`;
  };

  /** The grid's first and last columns start at the card's content gutter (--portal-pad), like the toolbar above. */
  let gutterSheet: CSSStyleSheet | null = null;
  const alignGrid = (mg: HTMLElement, tries = 0): void => {
    const root = mg.shadowRoot;
    // The grid adopts its own styles when it first renders: add ours after that.
    const done = (mg as HTMLElement & { updateComplete?: Promise<unknown> }).updateComplete;
    if (!root || !root.adoptedStyleSheets.length) {
      if (tries < 5) requestAnimationFrame(() => { void (done ?? Promise.resolve()).then(() => alignGrid(mg, tries + 1)); });
      return;
    }
    gutterSheet ??= (() => {
      const sh = new CSSStyleSheet();
      sh.replaceSync('th:first-child, td:first-child { padding-inline-start: var(--portal-pad, 16px) !important; } th:last-child, td:last-child { padding-inline-end: var(--portal-pad, 16px) !important; }');
      return sh;
    })();
    if (!root.adoptedStyleSheets.includes(gutterSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, gutterSheet];
  };

  /** Fill the Mappings card's summary, toolbar, grid and empty state from `mapView`. */
  const renderMappings = (root: HTMLElement, n: NamespaceFull): void => {
    const host = root.querySelector<HTMLElement>('[data-map-grid]');
    if (!host) return;
    const summary = root.querySelector('[data-map-summary]') as HTMLElement;
    const bar = root.querySelector('.ns-map-bar') as HTMLElement;
    const kindEl = root.querySelector('[data-map-kind]') as HTMLElement;
    const searchBox = root.querySelector('[data-map-search]') as HTMLElement & { value: string };
    const toggle = root.querySelector('[data-map-interop]') as HTMLButtonElement;
    const emptyEl = root.querySelector('[data-map-empty]') as HTMLElement;
    const edit = canMap(n);
    /** Change the view from a link in the card, then put focus back in the search. */
    const reset = (patch: Partial<typeof mapView>): void => {
      Object.assign(mapView, patch);
      if (patch.query === '') searchBox.value = '';
      renderMappings(root, n);
      searchBox.focus();
    };

    const every = KINDS.flatMap(({ kind, label, list }) => list(n).map((m) => ({ kind, label, m, locked: interopMap(n, kind, m) })));
    const nInterop = every.filter((r) => r.locked).length;
    if (!nInterop) mapView.interop = false;
    // Every mapping is interoperability's: they're all there is, so the grid lists them (read only) from the start,
    // under one line that says where they came from. The full view always shows at least what the peek does.
    const allInterop = nInterop > 0 && nInterop === every.length;
    if (allInterop) mapView.interop = true;
    const set = every.filter((r) => mapView.interop || !r.locked);

    summary.hidden = !allInterop;
    let mg = host.querySelector('ev-data-grid') as GridEl | null;
    if (allInterop) {
      // The counts are the chips' below: the line says only where they came from.
      const dbsFrom = [...new Set(every.map((r) => r.m.Database))].sort();
      summary.innerHTML = `<p class="detail-para">${esc(`${nInterop === 1 ? 'It was' : 'All were'} added by switching on interoperability and read from ${dbsFrom.join(' and ')}, so ${nInterop === 1 ? 'it is' : 'they are'} read only here.`)}</p>`;
    } else summary.innerHTML = '';
    bar.style.display = '';

    if (mapView.kind !== 'all' && !set.some((r) => r.kind === mapView.kind)) mapView.kind = 'all';
    // The chip counts follow the search: they say how many each chip would show now.
    const q = mapView.query.toLowerCase();
    const hit = (r: (typeof every)[number]): boolean => !q || `^${r.m.Name}`.toLowerCase().includes(q) || r.m.Database.toLowerCase().includes(q);
    const found = set.filter(hit);
    const nKind = (k: MappingKind): number => found.filter((r) => r.kind === k).length;

    // The toggle chip first: setChips (through setSearch) hides the toolbar row when nothing in it shows.
    toggle.style.display = nInterop && !allInterop ? '' : 'none';
    toggle.setAttribute('aria-pressed', String(mapView.interop));
    toggle.title = mapView.interop ? 'Hide the mappings interoperability added' : 'Show the mappings interoperability added (read only)';
    (toggle.querySelector('[data-map-interop-count]') as HTMLElement).textContent = num(every.filter((r) => r.locked && hit(r)).length);
    setChips(kindEl, set.length, [
      { value: 'all', label: `All ${num(found.length)}` },
      ...KINDS.map((k) => ({ value: k.kind, label: `${k.plural} ${num(nKind(k.kind))}`, disabled: !nKind(k.kind) && mapView.kind !== k.kind })),
    ], { active: mapView.kind, search: searchBox, query: mapView.query });

    const shown = found
      .filter((r) => mapView.kind === 'all' || r.kind === mapView.kind)
      .sort((a, b) => Number(a.locked) - Number(b.locked)
        || KINDS.findIndex((k) => k.kind === a.kind) - KINDS.findIndex((k) => k.kind === b.kind)
        || a.m.Name.localeCompare(b.m.Name));
    const rows: DataGridRow[] = shown.map((r) => ({
      Key: `${r.kind}:${r.m.Name}`, Name: r.kind === 'global' ? `^${r.m.Name}` : r.m.Name, Kind: r.label, Database: r.m.Database,
      Raw: r.m.Name, K: r.kind, Interop: r.locked, Locked: r.locked || !edit, Act: '',
    }));

    // The columns belong to the namespace, not the filter: they never change shape as you filter.
    const cols = every.some((r) => r.locked || edit) ? [...MAP_COLUMNS, ACT_COLUMN] : MAP_COLUMNS;

    // The grid's empty state, where the grid would be: it names what hides the rows, and undoes it.
    const kindName = KINDS.find((k) => k.kind === mapView.kind)?.plural.toLowerCase() ?? '';
    const hiddenHits = mapView.interop ? 0 : every.filter((r) => r.locked && hit(r) && (mapView.kind === 'all' || r.kind === mapView.kind)).length;
    const undo: string[] = [];
    let why = '';
    if (!rows.length) {
      if (q && mapView.kind !== 'all') {
        // Both filters are on: say which one hides the rows.
        why = found.length ? `No ${kindName} match “${mapView.query}”. Other kinds do.` : `Nothing matches “${mapView.query}”, in ${kindName} or any other kind.`;
        undo.push(found.length
          ? '<button type="button" class="link ns-inline" data-map-undo="kind">Show all kinds</button>'
          : '<button type="button" class="link ns-inline" data-map-undo="query">Clear the search</button>');
      } else if (q) {
        why = `No mappings match “${mapView.query}”.`;
        undo.push('<button type="button" class="link ns-inline" data-map-undo="query">Clear the search</button>');
      } else if (mapView.kind !== 'all') {
        why = `No ${kindName} here.`;
        undo.push('<button type="button" class="link ns-inline" data-map-undo="kind">Show all kinds</button>');
      }
      if (why && hiddenHits) undo.push(`<button type="button" class="link ns-inline" data-map-undo="interop">${esc(`Show ${num(hiddenHits)} added by interoperability`)}</button>`);
    }
    emptyEl.innerHTML = why ? `<span>${esc(why)}</span> ${undo.join('<span class="meta-sep">·</span>')}` : '';
    emptyEl.hidden = !why;
    emptyEl.querySelectorAll<HTMLElement>('[data-map-undo]').forEach((b) => b.addEventListener('click', () => {
      const what = b.dataset.mapUndo;
      reset(what === 'kind' ? { kind: 'all' } : what === 'interop' ? { interop: true } : { query: '' });
    }));

    if (!mg) {
      mg = document.createElement('ev-data-grid') as GridEl;
      mg.setAttribute('compact', '');
      mg.setAttribute('row-key', 'Key');
      mg.setAttribute('aria-label', `Mappings in ${n.Name}`);
      // Inside the card: its top rule only, and a bounded height that scrolls, so the page stays one screen tall.
      // A stable scrollbar gutter, so columns don't move when a filter removes the scrollbar.
      mg.style.cssText = 'border:0;border-top:1px solid var(--ev-border-1);border-radius:0;max-height:360px;scrollbar-gutter:stable';
      mg.addEventListener('click', (e) => {
        const path = e.composedPath();
        const a = path.find((x): x is HTMLAnchorElement => x instanceof HTMLAnchorElement && x.getAttribute('href') === `#/${DB_ROUTE}`);
        if (a) { e.preventDefault(); linkToScreen(ctx.navigate, DB_ROUTE, a.textContent ?? ''); return; }
        const b = path.find((x): x is HTMLElement => x instanceof HTMLElement && x.hasAttribute('data-map-more'));
        // A ⋯ that already has its menu opens and closes it itself.
        if (!b || b === mapMenuAnchor) return;
        mapMenu?.destroy();
        mapMenuAnchor = b;
        const kind = b.dataset.kind as MappingKind;
        const name = b.dataset.name ?? '';
        mapMenu = moreMenu(b, [
          { label: 'Change database…', icon: 'edit-2', onSelect: () => mappingDialog(n, { kind, name, database: b.dataset.database ?? '' }) },
          { label: 'Remove…', icon: 'trash-2', danger: true, onSelect: () => void removeMapping(n, kind, name) },
        ]);
        mapMenu.open();
      });
      host.appendChild(mg);
    }
    // Set once per namespace: re-setting the same columns would reset widths the user dragged.
    if (mg.columns?.length !== cols.length) mg.columns = cols;
    mg.rows = rows;
    alignGrid(mg);
    mg.hidden = !rows.length;
  };

  const NAME_RULES: Record<MappingKind, { re: RegExp; hint: string }> = {
    global: { re: /^[A-Za-z][A-Za-z0-9.]*\*?$/, hint: 'Without the ^. End with * for every global that starts with it, e.g. Orders*.' },
    routine: { re: /^[A-Za-z%][A-Za-z0-9.%]*\*?$/, hint: 'End with * for every routine that starts with it, e.g. Report*.' },
    package: { re: /^[A-Za-z%][A-Za-z0-9.]*$/, hint: 'A class package, e.g. MyApp.Data.' },
  };
  const SUBSCRIPT_RE = /^\(.+\)(:\(.+\))?$/;

  /** Add a mapping, or change the database of one (`existing`). A small form in a dialog. */
  const mappingDialog = (n: NamespaceFull, existing?: { kind: MappingKind; name: string; database: string }): void => {
    const dlg = document.createElement('ev-dialog') as HTMLElement & { open: boolean; close(): void };
    dlg.setAttribute('heading', existing ? `Change mapping ${existing.kind === 'global' ? `^${existing.name}` : existing.name}` : `New mapping in ${n.Name}`);
    const dbOpts = dbs.filter((d) => d.state !== 'unknown').map((d) => ({ value: d.name, label: d.name })).sort((a, b) => a.value.localeCompare(b.value));
    const kind0: MappingKind = existing?.kind ?? 'global';
    dlg.innerHTML = `<div slot="body" class="ns-map-form">
        ${existing ? '' : selectField('Kind', 'Type', KINDS.map((k) => ({ value: k.kind, label: k.label })), kind0)}
        ${existing ? '' : textField('Name', 'Name', '', { required: true, mono: true, hint: NAME_RULES[kind0].hint })}
        ${existing ? '' : `<div data-when-global>${textField('Subscript', 'Subscript range', '', { mono: true, placeholder: '("A"):("M")', hint: 'Optional: only part of the global, from one subscript to another. IRIS also maps the whole global.' })}</div>`}
        ${selectField('Database', 'Database', dbOpts, existing?.database ?? '', { searchable: dbOpts.length > 8, hint: 'Where its data or code lives from now on. Nothing is copied: what is in the old database stays there.' })}
        <p class="ns-map-error" role="alert" hidden></p>
      </div>
      <div slot="footer" class="crud-dialog-foot"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn--primary" data-save>${existing ? 'Save' : 'Add mapping'}</button></div>`;
    const errEl = dlg.querySelector('.ns-map-error') as HTMLElement;
    const fail = (msg: string): void => { errEl.textContent = msg; errEl.hidden = !msg; };
    const syncKind = (): void => {
      const k = String(readForm(dlg).Kind ?? kind0) as MappingKind;
      const g = dlg.querySelector<HTMLElement>('[data-when-global]');
      if (g) g.hidden = k !== 'global';
      dlg.querySelector('[data-field="Name"]')?.setAttribute('hint', NAME_RULES[k].hint);
    };
    dlg.addEventListener('ev-select-change', syncKind);
    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => dlg.close());
    const save = dlg.querySelector('[data-save]') as HTMLButtonElement;
    save.addEventListener('click', () => void (async () => {
      const v = readForm(dlg);
      const kind = existing?.kind ?? (String(v.Kind ?? 'global') as MappingKind);
      const base = existing ? existing.name : String(v.Name ?? '').trim().replace(/^\^/, '');
      const sub = existing || kind !== 'global' ? '' : String(v.Subscript ?? '').trim();
      const database = String(v.Database ?? '');
      if (!existing) {
        if (!base) return fail('Enter a name.');
        if (!NAME_RULES[kind].re.test(base)) return fail(`That isn’t a ${kind} name IRIS accepts. ${NAME_RULES[kind].hint}`);
        if (sub && !SUBSCRIPT_RE.test(sub)) return fail('Write the range as ("A"):("M"), or one subscript as ("A").');
        if (sub && base.endsWith('*')) return fail('A subscript range needs one global, not a pattern ending in *.');
      }
      if (!database) return fail('Choose a database.');
      if (existing && database === existing.database) { dlg.close(); return; }
      const name = base + sub;
      save.disabled = true;
      try {
        // The same call that adds a mapping changes an existing one: check first.
        if (!existing && await mappingExists(kind, n.Name, name)) { save.disabled = false; return fail(`${n.Name} already maps ${kind === 'global' ? `^${name}` : name}. Change that one instead.`); }
        await saveMapping(kind, n.Name, name, database);
      } catch (err) {
        save.disabled = false;
        return fail(errorText(err));
      }
      dlg.close();
      changed.add(n.Name);
      await load();
      toast(existing ? `Mapping changed. New processes in ${n.Name} use ${database}.` : `Mapping added. New processes in ${n.Name} use it.`);
    })());
    dlg.addEventListener('ev-dialog-close', () => setTimeout(() => dlg.remove(), 0), { once: true });
    document.body.appendChild(dlg);
    dlg.open = true;
    requestAnimationFrame(syncKind);
    // ev-dialog moves focus to its surface a frame after opening: focus the first field after that.
    requestAnimationFrame(() => requestAnimationFrame(() => { if (dlg.open) focusField(dlg, existing ? 'Database' : 'Kind'); }));
  };

  const removeMapping = async (n: NamespaceFull, kind: MappingKind, name: string): Promise<void> => {
    const label = kind === 'global' ? `^${name}` : name;
    const ok = await confirm({
      title: `Remove mapping ${label}?`,
      body: `<p>New processes in ${esc(n.Name)} read <span class="mono">${esc(label)}</span> from ${esc(kind === 'global' ? n.Globals : n.Routines)} again, its default database. Nothing is deleted from either database.</p>`,
      confirmLabel: 'Remove mapping',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteMapping(kind, n.Name, name);
    } catch (err) {
      toast(`Couldn’t remove ${label}. ${errorText(err)}`, 'danger');
      return;
    }
    changed.add(n.Name);
    await load();
    toast(`Mapping ${label} removed.`);
  };

  const wireMappings = (root: HTMLElement, n: NamespaceFull): void => {
    mapMenu?.destroy(); mapMenu = null; mapMenuAnchor = null;
    root.querySelector('[data-map-add]')?.addEventListener('click', () => mappingDialog(n));
    const redraw = (): void => renderMappings(root, n);
    const search = root.querySelector('[data-map-search]') as (HTMLElement & { value: string }) | null;
    if (search) search.value = mapView.query;
    search?.addEventListener('ev-search-input', (e) => { mapView.query = (e as CustomEvent<{ value: string }>).detail.value.trim(); redraw(); });
    root.querySelector('[data-map-kind]')?.addEventListener('ev-segmented-button-change', (e) => { mapView.kind = (e as CustomEvent<{ value: MapKindView }>).detail.value; redraw(); });
    root.querySelector('[data-map-interop]')?.addEventListener('click', () => { mapView.interop = !mapView.interop; redraw(); });
    /*
     * Esc inside the Mappings card only dismisses what's local: the search text first, then focus
     * (which moves to the card itself, so a further Esc is still inside it). It never changes a chip
     * and never reaches objectDetail, so it can't take you off the full page. Caught on the way down,
     * before ev-search's own Esc handling, so the card alone decides what an Esc does here.
     */
    const card = root.querySelector('[data-map-grid]')?.closest<HTMLElement>('.od-card');
    if (card) {
      card.tabIndex = -1;
      card.classList.add('ns-map-card');
      card.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || document.querySelector('ev-dialog, .crud-menu')) return;
        e.preventDefault();
        e.stopPropagation();
        if (search && e.composedPath().includes(search) && (mapView.query || search.value)) {
          mapView.query = '';
          search.value = '';
          redraw();
          return;
        }
        card.focus({ preventScroll: true });
      }, true);
    }
    redraw();
  };

  const menuOf = (n: NamespaceFull): MenuItem[] => {
    const why = deleteWhy(n);
    return [{ label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!why, reason: why ?? undefined, onSelect: () => void doDelete(n) }];
  };
  /** Why a namespace can't be edited here, or null. %SYS is IRIS's own: no Edit at all. */
  const editWhy = (n: NamespaceFull): string | null => (n.Name === '%SYS' ? 'It’s IRIS’s own namespace.' : canManage === false ? NO_MANAGE : null);
  /**
   * Edit: in the peek from the list; from the full view in the page body's place (so the address and
   * ‹ n of N › stay, and Cancel or Save come back to the same page). The button says it's working at
   * once, even when the browser or the server is slow to answer.
   */
  const startEdit = (n: NamespaceFull): void => {
    const btn = document.getElementById(od.mode() === 'full' ? 'od-full-primary' : 'od-peek-primary') as HTMLButtonElement | null;
    if (btn?.getAttribute('aria-busy') === 'true') return;
    btn?.setAttribute('aria-busy', 'true');
    btn?.classList.add('ns-busy');
    void openForm(n, od.mode() === 'full' ? 'full' : 'peek').finally(() => {
      btn?.removeAttribute('aria-busy');
      btn?.classList.remove('ns-busy');
    });
  };

  const fullOf = (n: NamespaceFull): OdFull => {
    // Facts the cards don't give: how big it is, how many databases it touches, and what serves it on the web.
    const own = [...new Set([n.Globals, n.Routines])];
    const sizes = own.map((x) => db(x)?.sizeMb ?? NaN);
    const known = sizes.every((x) => Number.isFinite(x));
    const base = [n.Globals, n.Routines, n.TempGlobals, n.Library, n.SysGlobals, n.SysRoutines].filter(Boolean);
    const mapped = [...n.globals, ...n.routines, ...n.packages].map((m) => m.Database);
    /** Every database it reads: its data, code, temporary and system ones, and any a mapping points at. */
    const reached = [...new Set([...base, ...mapped])];
    const viaMaps = reached.filter((x) => !base.includes(x)).length;
    const webApps = apps.filter((a) => a.Namespace.toUpperCase() === n.Name.toUpperCase()).map((a) => a.Name).sort();
    return {
      strip: [
        { label: 'Size', value: known ? dataSize(sizes.reduce((t, x) => t + x, 0)) : '—', caption: esc(own.length === 1 ? 'its data and code database' : 'its data and code databases') },
        { label: 'Databases reached', value: n.mappingsUnknown ? '—' : num(reached.length), caption: viaMaps ? esc(`${num(viaMaps)} only through mappings`) : '', title: reached.join(', ') },
        { label: 'Web applications', value: webApps.length ? num(webApps.length) : 'None', caption: webApps.length ? `<span class="mono">${esc(webApps.slice(0, 2).join(', '))}</span>${webApps.length > 2 ? esc(` and ${num(webApps.length - 2)} more`) : ''}` : '', title: webApps.join(', ') },
      ],
      // Where its content lives leads the wide column, the mappings (the exceptions to it) follow; who can open it sits beside.
      main: [
        { title: 'Where its content lives', body: `${n.Name === '%SYS' ? '<p>IRIS’s own namespace, where system code and configuration live. Leave its mappings as IRIS set them.</p>' : ''}${whereHtml(n)}` },
        { title: 'Mappings', body: mappingsEditHtml(n), head: canMap(n) ? '<button type="button" class="btn btn--sm" data-map-add><ev-icon name="plus" size="xs"></ev-icon>Add mapping</button>' : '' },
      ],
      side: [
        { title: 'Who can open it', body: whoHtml(n) },
      ],
    };
  };

  const wireLinks = (root: HTMLElement): void => {
    root.querySelectorAll<HTMLElement>('[data-db]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); linkToScreen(ctx.navigate, DB_ROUTE, a.dataset.db ?? ''); }));
    root.querySelectorAll<HTMLElement>('[data-res]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); linkTo(ctx.navigate, 'security/resources', a.dataset.res ?? ''); }));
  };

  const od = objectDetail<NamespaceFull>(ctx, {
    collection: 'Namespaces', noun: 'namespace',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (n) => n.Name,
    find: (k) => all.find((n) => n.Name === k),
    order: () => listOrder(),
    name: (n) => n.Name,
    meta: metaOf,
    description: (n) => (n.Name === '%SYS' ? 'IRIS’s own namespace, where system code and configuration live.' : ''),
    primary: (n) => (n.Name === '%SYS' ? null : { label: 'Edit', icon: 'edit-2', run: () => startEdit(n), blocked: editWhy(n) ?? undefined }),
    menu: menuOf,
    peek: (n) => `
      ${odSection('Where its content lives', whereHtml(n))}
      ${odSection('Who can open it', whoHtml(n))}
      ${odSection('Mappings', mappingsHtml(n, SHOW))}`,
    loadFull: (n) => fullOf(n),
    wire: (root, n, where) => {
      wireLinks(root);
      if (where === 'full') { wireMappings(root, n); return; }
      // "See them all": the full view, its Mappings card on that kind with everything shown.
      root.querySelectorAll<HTMLElement>('[data-map-all]').forEach((a) => a.addEventListener('click', (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        Object.assign(mapView, { ns: n.Name, kind: a.dataset.mapAll as MappingKind, interop: true, query: '' });
        void od.openFull(n.Name);
      }));
    },
    onSelect: (k) => { selected = k; grid?.select(k ? [k] : []); },
    onPeek: () => applyColumns(),
    canLeave: async () => {
      if (!editor) return true;
      if (!(await editor.guard())) return false;
      leaveEditor();
      return true;
    },
  });

  /** Show the selected namespace (peek or full view); never over the New namespace form. */
  const renderDetail = (): void => {
    if (editor) return;
    if (od.mode() === 'full') { od.refresh(); return; }
    if (selected === null) { if (od.selected() !== null) void od.select(null); return; }
    if (od.selected() !== selected || !panel.open) void od.select(selected); else od.refresh();
  };

  /* ───────────── New namespace ───────────── */

  const NEW = '__new__';
  const SAME = '__same__';
  const NS_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
  const DB_NAME = /^[A-Za-z0-9_-]{1,64}$/;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEditor = (): void => {
    ctx.beforeLeave(null);
    editor?.close();
    editor = null;
    restoreWidth?.();
    restoreWidth = null;
  };
  ctx.onLeave(leaveEditor);
  /** The full view's cards again, after an edit made in their place; focus back on Edit. */
  const backToFull = (): void => {
    fullEl.innerHTML = ''; // the form goes; the cards render in its place
    od.refresh();
    // After the frame in which a closing confirm dialog hands focus back (to the form's Cancel, now gone).
    requestAnimationFrame(() => setTimeout(() => (document.getElementById('od-full-primary') as HTMLElement | null)?.focus({ preventScroll: true }), 50));
  };

  /** New database files go in a folder of their own under IRIS's mgr directory, as the Management Portal does. */
  const baseDir = (): string => db('IRISSYS')?.directory ?? '';
  const dirFor = (dbName: string): string => {
    const base = baseDir();
    const sep = base.includes('\\') ? '\\' : '/';
    return base && dbName ? `${base}${dbName.toLowerCase()}${sep}` : '';
  };
  const dbTaken = (name: string): boolean => dbs.some((d) => d.name.toUpperCase() === name.toUpperCase());
  const dirTaken = (dir: string): boolean => dbs.some((d) => dirKey(d.directory) === dirKey(dir));

  type Values = ReturnType<typeof readForm>;
  type Plan = { data: string; code: string; temp: string; creates: Array<{ name: string; dir: string }>; interop: boolean };
  /** What the form will do: the databases to create, the ones the namespace uses, and interoperability. */
  const planOf = (v: Values, n?: NamespaceFull): Plan => {
    const creates: Array<{ name: string; dir: string }> = [];
    const pick = (key: 'Data' | 'Code'): string => {
      if (v[key] !== NEW) return String(v[key] ?? '');
      const name = String(v[`${key}Name`] ?? '').trim().toUpperCase();
      creates.push({ name, dir: String(v[`${key}Dir`] ?? '').trim() });
      return name;
    };
    const data = pick('Data');
    const code = v.Code === SAME ? data : pick('Code');
    const temp = n ? String(v.Temp ?? n.TempGlobals) : 'IRISTEMP';
    return { data, code, temp, creates, interop: !n?.interop && v.Interop === true };
  };
  /** Edit: what differs from the namespace as it is, one line each. */
  const changesOf = (p: Plan, n: NamespaceFull): string[] => [
    ...p.creates.map((x) => `New database ${x.name || '…'} is created as ${x.dir || '…'}IRIS.DAT: 1 MB to start, journaled, protected by %DB_%DEFAULT.`),
    p.data !== n.Globals ? `Data: ${n.Globals} → ${p.data || '…'}.` : '',
    p.code !== n.Routines ? `Code: ${n.Routines} → ${p.code || '…'}.` : '',
    p.temp !== n.TempGlobals ? `Temporary data: ${n.TempGlobals} → ${p.temp}.` : '',
    p.interop ? `Interoperability is enabled: its classes come from ENSLIB, and IRIS adds the databases ${p.data}ENSTEMP and ${p.data}SECONDARY and the web application /csp/${n.Name.toLowerCase()}. This takes a few seconds.` : '',
    whoLine(p, n),
  ].filter(Boolean);
  /** The resources its data and code databases need (a database the form creates is protected by %DB_%DEFAULT). */
  const resourcesOf = (data: string, code: string, creates: Plan['creates'] = []): string[] =>
    [...new Set([data, code].map((x) => (creates.some((c) => c.name === x) ? '%DB_%DEFAULT' : db(x)?.resource ?? '')).filter(Boolean))];
  /** Who can open it after saving, when moving its data or code changes that. */
  const whoLine = (p: Plan, n: NamespaceFull): string => {
    if (!p.data || !p.code) return '';
    const was = resourcesOf(n.Globals, n.Routines);
    const now = resourcesOf(p.data, p.code, p.creates);
    if (!now.length || now.join() === was.join()) return '';
    return `Who can open it: people with Read on ${now.join(' and ')}${was.length ? ` (now ${was.join(' and ')})` : ''}.`;
  };
  const previewOf = (v: Values, n?: NamespaceFull): string => {
    const p = planOf(v, n);
    if (n) {
      const lines = changesOf(p, n);
      const moved = [p.data !== n.Globals ? ['data', n.Globals] : null, p.code !== n.Routines && p.code !== p.data ? ['code', n.Routines] : null].filter((x): x is string[] => !!x);
      const note = moved.length
        ? `<div class="crud-note crud-note--warning" role="alert"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>Nothing is copied.</strong> ${esc(`Its ${moved.map(([w, d]) => `${w} in ${d}`).join(' and ')} stays there, out of sight of ${n.Name}. Mappings stay as they are.`)}</div></div>`
        : '';
      return `<ul>${(lines.length ? lines : ['No changes yet.']).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${note}`;
    }
    const ns = String(v.Name ?? '').trim().toUpperCase();
    const lines = [
      ...p.creates.map((x) => `New database ${x.name || '…'} is created as ${x.dir || '…'}IRIS.DAT: 1 MB to start, journaled, protected by %DB_%DEFAULT.`),
      `${ns || 'The namespace'} is created with its data in ${p.data || '…'} and its code in ${p.code || '…'}. Temporary data goes to IRISTEMP.`,
      p.interop ? `Interoperability is enabled: its classes come from ENSLIB, and IRIS adds the databases ${p.data || '…'}ENSTEMP and ${p.data || '…'}SECONDARY and the web application /csp/${ns ? ns.toLowerCase() : '…'}. This takes a few seconds.` : '',
      'People need Read on the data database’s resource to open it.',
    ].filter(Boolean);
    return `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  };

  /**
   * New namespace, or Edit `n`: the same form, with n's databases filled in. In the list's panel, or
   * (`where` 'full') in the full view's body, in the cards' place, until Cancel or Save brings them back.
   */
  const openForm = async (n?: NamespaceFull, where: 'peek' | 'full' = 'peek'): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    if (n && editWhy(n)) return;
    const inFull = !!n && where === 'full' && od.mode() === 'full' && od.selected() === n.Name;
    // From the full view the form takes the whole body, as on every screen (the shared 720px card);
    // "What changes" says who can open it after saving.
    const host: HTMLElement = inFull ? fullEl : detailEl;
    if (!inFull) {
      if (od.mode() === 'full') await od.closeFull();
      selected = n ? n.Name : null;
      grid?.select(n ? [n.Name] : []);
      setPanel(true);
      restoreWidth = panelWidth(panel, 520);
    }
    // Databases a namespace can use: this instance's own, not IRIS's system ones, and writable
    // (plus, when editing, the ones it uses now, whatever they are).
    const usable = dbs.filter((d) => !d.system && d.state !== 'remote' && d.state !== 'readonly').map((d) => d.name);
    const opts = (...extra: string[]): Array<{ value: string; label: string }> =>
      [...new Set([...usable, ...extra.filter(Boolean)])].sort().map((d) => ({ value: d, label: d }));
    const dataOpts = [{ value: NEW, label: 'Create new…' }, ...opts(n?.Globals ?? '')];
    const codeOpts = [{ value: SAME, label: 'Same as data' }, { value: NEW, label: 'Create new…' }, ...opts(n?.Routines ?? '')];
    const tempOpts = opts('IRISTEMP', n?.TempGlobals ?? '');
    const data0 = n ? n.Globals : NEW;
    const code0 = n ? (n.Routines === n.Globals ? SAME : n.Routines) : SAME;
    const newDbFields = (key: 'Data' | 'Code', shown: boolean): string => `<div class="ns-new-db" data-when="${key}"${shown ? '' : ' hidden'}>
        ${textField(`${key}Name`, 'New database name', '', { mono: true, hint: 'Letters, digits, - and _. It starts at 1 MB, journaled, and grows as data arrives.' })}
        ${pathField(`${key}Dir`, 'Directory', '', { mode: 'dir', title: 'Choose where the new database goes', hint: 'A new folder for its IRIS.DAT file. IRIS creates it: browse to its parent and type the new folder’s name.' })}
      </div>`;
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(host, {
      // In the full view, its title already names the namespace.
      title: inFull ? 'Edit settings' : n ? `Edit <span class="mono">${esc(n.Name)}</span>` : 'New namespace',
      name: n ? n.Name : 'the new namespace',
      submitLabel: n ? 'Save changes' : 'Create namespace',
      // One "General" section, as every editor starts, then what saving would do.
      sections:
        `<section class="crud-section"><h3 class="crud-section-title">General</h3><div class="crud-section-body ns-form">
          ${n ? '' : textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'Letters, digits, - and _, starting with a letter. IRIS keeps names in capitals.' })}
          <div>${selectField('Data', 'Data database', dataOpts, data0, { searchable: dataOpts.length > 8, hint: 'Holds its globals.' })}${newDbFields('Data', data0 === NEW)}</div>
          <div>${selectField('Code', 'Code database', codeOpts, code0, { searchable: codeOpts.length > 8, hint: 'Holds its routines and classes.' })}${newDbFields('Code', false)}</div>
          ${n ? selectField('Temp', 'Temporary database', tempOpts, n.TempGlobals, { searchable: tempOpts.length > 8, hint: 'Holds its temporary globals. IRISTEMP is emptied at every restart and never journaled.' }) : ''}
          ${n?.interop ? '' : checkField('Interop', 'Enable interoperability', false, {
            toggle: true, hint: 'Lets productions run here. IRIS also adds two databases and a web application for them.',
          })}
        </div></section>`
        // What changes is always there: "No changes yet" until something has.
        + section('What changes', '<div id="ns-preview" class="svc-preview" aria-live="polite"></div>'),
      changed: n ? () => changesOf(planOf(readForm(host), n), n).length > 0 : undefined,
      check: () => {
        const v = readForm(host);
        const out: FieldProblem[] = [];
        if (!n) {
          const name = String(v.Name ?? '').trim();
          if (!name) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (!NS_NAME.test(name)) out.push({ field: 'Name', label: 'Name', message: 'Use letters, digits, - and _, starting with a letter' });
          else if (all.some((x) => x.Name.toUpperCase() === name.toUpperCase())) out.push({ field: 'Name', label: 'Name', message: 'A namespace with this name already exists' });
        }
        const newNames: string[] = [];
        const newDirs: string[] = [];
        for (const key of ['Data', 'Code'] as const) {
          if (v[key] !== NEW) continue;
          const label = key === 'Data' ? 'Data database' : 'Code database';
          const dbName = String(v[`${key}Name`] ?? '').trim();
          const dir = String(v[`${key}Dir`] ?? '').trim();
          if (!dbName) out.push({ field: `${key}Name`, label, message: 'Enter a name for the new database' });
          else if (!DB_NAME.test(dbName)) out.push({ field: `${key}Name`, label, message: 'Use letters, digits, - and _ only (up to 64)' });
          else if (dbTaken(dbName)) out.push({ field: `${key}Name`, label, message: 'A database with this name already exists. Pick it from the list instead' });
          else if (newNames.includes(dbName.toUpperCase())) out.push({ field: `${key}Name`, label, message: 'Give the two new databases different names' });
          newNames.push(dbName.toUpperCase());
          if (!dir) out.push({ field: `${key}Dir`, label: `${label} directory`, message: 'Enter a directory' });
          else if (dirTaken(dir)) out.push({ field: `${key}Dir`, label: `${label} directory`, message: 'Another database already lives there' });
          else if (newDirs.includes(dirKey(dir))) out.push({ field: `${key}Dir`, label: `${label} directory`, message: 'Give the two new databases different directories' });
          newDirs.push(dirKey(dir));
        }
        return out;
      },
      onSubmit: async (v) => {
        const name = n ? n.Name : String(v.Name).trim().toUpperCase();
        const plan = planOf(v, n);
        if (n) {
          if (!changesOf(plan, n).length) throw new Error('Nothing to save.');
          // Moving its data or code hides what's in the old database from it: say so before saving.
          if (plan.data !== n.Globals || plan.code !== n.Routines) {
            const ok = await confirm({
              title: `Change where ${n.Name}’s content lives?`,
              body: `<p>Programs in ${esc(n.Name)} will read ${plan.data !== n.Globals ? `data from <b class="mono">${esc(plan.data)}</b>` : ''}${plan.data !== n.Globals && plan.code !== n.Routines ? ' and ' : ''}${plan.code !== n.Routines ? `code from <b class="mono">${esc(plan.code)}</b>` : ''}. Nothing is copied: what is in ${esc([...new Set([plan.data !== n.Globals ? n.Globals : '', plan.code !== n.Routines ? n.Routines : ''].filter(Boolean))].join(' and '))} stays there.</p>`,
              confirmLabel: 'Save changes',
            });
            if (!ok) { toast('Not saved. Your changes are still here.', 'info'); throw new SubmitCancelled(); }
          }
        } else if (await namespaceExists(name)) {
          // The call that creates a namespace changes an existing one: check again right before.
          fieldError(host, 'Name', 'A namespace with this name already exists');
          focusField(host, 'Name');
          throw new Error(`A namespace named ${name} already exists.`);
        }
        const made: Array<{ name: string; dir: string }> = [];
        try {
          for (const x of plan.creates) {
            await createDb({ name: x.name, directory: x.dir, sizeMb: 1, maxMb: 0, expansionMb: 0, journal: true, resource: '%DB_%DEFAULT' });
            made.push(x);
          }
          if (n) await updateNamespace(name, { Globals: plan.data, Routines: plan.code, TempGlobals: plan.temp });
          else await createNamespace(name, plan.data, plan.code);
        } catch (err) {
          // Nothing half-made is left behind: databases made for it are deleted again, with their files.
          for (const x of made.reverse()) await deleteDb(x.name, x.dir, true).catch(() => { /* best effort */ });
          throw err;
        }
        let interopErr = '';
        if (plan.interop) {
          try { await enableInterop(name); } catch (err) { interopErr = errorText(err); }
        }
        leaveEditor();
        if (inFull) fullEl.innerHTML = '';
        await load();
        open(name); // in the full view, its cards again (the address never changed)
        if (inFull) requestAnimationFrame(() => (document.getElementById('od-full-primary') as HTMLElement | null)?.focus({ preventScroll: true }));
        const done = n ? `${name} saved` : `Namespace ${name} created`;
        toast(interopErr
          ? `${done}, but interoperability couldn’t be enabled. ${interopErr}`
          : `${done}${plan.interop ? ' with interoperability' : ''}.`, interopErr ? 'warning' : 'success');
      },
      onCancel: () => {
        leaveEditor();
        if (inFull) { backToFull(); return; }
        if (n) renderDetail(); else close();
      },
    });
    const ed = editor;
    const input = (x: string): (HTMLElement & { value: string }) | null => host.querySelector(`ev-input[name="${x}"]`);
    const touched = new Set<string>();
    for (const x of ['DataName', 'DataDir', 'CodeName', 'CodeDir']) input(x)?.addEventListener('ev-input-input', () => touched.add(x));
    /** Suggested names and folders follow the namespace name until the user types their own. */
    const suggest = (): void => {
      const ns = n ? n.Name : String(input('Name')?.value ?? '').trim().toUpperCase();
      const set = (x: string, value: string): void => { const el = input(x); if (el && !touched.has(x) && el.value !== value) el.value = value; };
      set('DataName', n ? '' : ns);
      set('CodeName', ns && !n ? `${ns}_CODE` : '');
      set('DataDir', dirFor(String(input('DataName')?.value ?? '').trim()));
      set('CodeDir', dirFor(String(input('CodeName')?.value ?? '').trim()));
    };
    const showNew = (v: Values): void => {
      for (const key of ['Data', 'Code']) {
        const box = host.querySelector<HTMLElement>(`[data-when="${key}"]`);
        if (box) box.hidden = v[key] !== NEW;
      }
    };
    const update = (): void => {
      suggest();
      const v = readForm(host);
      showNew(v);
      const preview = host.querySelector('#ns-preview');
      if (preview) preview.innerHTML = previewOf(v, n);
    };
    const onChange = (): void => { if (editor === ed) { update(); ed.refresh(); } };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-select-change', 'ev-toggle-change']) ed.form.addEventListener(t, onChange);
    update();
    scrollPanelTop(host);
    requestAnimationFrame(() => { if (editor === ed) { update(); ed.refresh(); focusField(host, n ? 'Data' : 'Name'); } });
  };

  const nsNew = newButton(ctx, 'New namespace', () => void openForm());
  sessionInfo().then((info) => {
    if (!alive) return;
    canManage = can(info, 'Manage');
    if (canManage === false) nsNew.setBlocked(NO_MANAGE);
    // Delete, Edit and the mapping buttons follow the privilege. With it, nothing on screen changes: leave
    // the page alone, so a click on Edit that's under way isn't lost to a re-render.
    if (canManage !== false || editor) return;
    if (od.mode() === 'full') od.refresh(); else od.refreshHeader();
  }).catch(() => { /* unknown: leave it on; IRIS refuses what isn't allowed */ });

  /* ───────────── Loading ───────────── */

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  async function load(): Promise<void> {
    try {
      const [ns, d, a] = await Promise.all([getNamespacesFull(), getDatabases().catch(() => [] as Db[]), getWebAppList().catch(() => apps)]);
      if (!alive) return;
      all = ns;
      dbs = d;
      apps = a;
      updated(new Date());
      renderToolbar(); renderGrid(); renderFoot(); renderBanner();
      const first = !loaded;
      loaded = true;
      if (first) od.refresh(); // a deep link (#/databases/namespaces/<name>) opens its full view now
      if (pending !== null) { const p = pending; pending = null; open(p); }
      else if (selected !== null && !editor) renderDetail();
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-ns');
      wrap.querySelector('#retry-ns')?.addEventListener('click', () => void load());
    }
  }

  searchEl.addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });
  viewEl.addEventListener('ev-segmented-button-change', (e) => { view = (e as CustomEvent<{ value: View }>).detail.value; renderToolbar(); renderGrid(); });

  void load();
}
