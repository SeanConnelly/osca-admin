// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Databases › Databases — every database IRIS knows about: where its file
 * lives, how big it is and how much room it has (inside the file, up to its
 * maximum, and on the disk), whether it's mounted, journaled, encrypted and
 * mirrored, what protects it and which namespaces use it.
 *
 * The panel mounts and dismounts, expands, compacts, truncates, defragments
 * and integrity-checks a database, edits its size, journaling, resource and
 * startup settings, and creates and deletes databases. IRIS's own system
 * databases are protected: anything that would take one offline or rewrite
 * its file is blocked, with the reason on screen. See api-db.ts for what was
 * verified live and how.
 */
import '../styles-security.css';
import '../styles-services.css';
import '../styles-db.css';
import '../styles-web.css'; // .wa-kv2: the two-column key/value grid for wide full-view cards
import {
  getDatabases, getDbSettings, readDbInfo, cachedDbInfo, forgetDbInfo, getDbVolumes, getNamespacesFull, usesOf, parseSize, linkToScreen,
  mountDb, dismountDb, expandDb, compactDb, truncateDb, defragmentDb, checkDb, saveDbSettings, saveDbStartup, createDb, deleteDb,
  portalDb, SYSTEM_DBS, dirKey,
  type Db, type DbSettings, type DbInfo, type DbVolume, type NamespaceFull, type DbSettingsPatch,
} from '../api-db';
import { get } from '../api';
import { linkTo, takeSelection, getSecurityGraph, type SecurityGraph } from '../api-security';
import { metrics, samples } from '../metrics';
import { driveOf, nextGrowth } from '../api-disk';
import {
  toast, confirm, editorShell, panelWidth, section, textField, pathField, checkField, selectField, readForm,
  errorText, scrollPanelTop, newButton, fieldError, setBlocked, focusField, SubmitCancelled, type EditorHandle, type MenuHandle, type MenuItem, type FieldProblem,
} from '../crud';
import { guardDialog, type GuardRisk } from '../security-view';
import {
  plural,
  esc, chip, status, cell, cellId, cellRef, num, dataSize, dataPct, when, irisDate, middle, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, uniformKeys,
  setChips, objectDetail, odMeta, odSection, odKv, type ScreenCtx, type GridColumn, type OdFull,
} from '../ui';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 30000;
const EDIT_WIDTH = 520;
const NO_OPERATE = noPermissionText('%Admin_Operate', 'system operation');
const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');
const NS_ROUTE = 'databases/namespaces';

/** Disk or database this full (percent) counts as needing attention. */
const NEAR_FULL = 90;

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
type View = 'all' | 'mounted' | 'dismounted' | 'readonly' | 'attention';
type Act = 'mount' | 'dismount' | 'expand' | 'compact' | 'truncate' | 'defrag' | 'check' | 'edit' | 'delete';

/** Actions that take a database offline or rewrite its file: never on system databases. */
const GUARDED: Act[] = ['mount', 'dismount', 'compact', 'truncate', 'defrag', 'delete'];
const MANAGE_ACTS: Act[] = ['expand', 'edit', 'delete'];

const STATE_CHIP: Record<Db['state'], { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' | 'danger'; title: string }> = {
  mounted: { label: 'Mounted', tone: 'success', title: 'Online: namespaces can read and change its data' },
  readonly: { label: 'Read-only', tone: 'neutral', title: 'Online, but its data can only be read' },
  dismounted: { label: 'Dismounted', tone: 'warning', title: 'Offline: namespaces that use it can’t reach its data' },
  remote: { label: 'Remote', tone: 'neutral', title: 'Lives on another server, reached over ECP' },
  unknown: { label: 'Unknown', tone: 'neutral', title: '' },
};

/** A normal state that isn't news: a small neutral dot and plain text (Read-only), not a pill. */
const neutralDot = (text: string, title = ''): string => status(text, 'neutral', title);
/** The status cell or panel mark for a database state. */
const stateMark = (state: Db['state']): string => {
  const s = STATE_CHIP[state] ?? STATE_CHIP.unknown;
  return state === 'readonly' ? neutralDot(s.label, s.title) : chip(s.label, s.tone, s.title);
};
const listWords = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pctOf = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : NaN);

/** Journaling off on purpose: IRIS installs these without it (see the docs on configuring databases). */
const UNJOURNALED_BY_DESIGN = ['IRISTEMP', 'IRISLOCALDATA', 'IRISLIB'];
const COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'Database', width: '150px', sortable: true, renderCell: (v, row) => cellId(v, row.System ? 'A system database IRIS needs' : '') },
  { key: 'State', label: 'Status', width: '112px', sortable: true, renderCell: (v) => stateMark(v as Db['state']) },
  { key: 'Size', label: 'Size', width: '92px', sortable: true, align: 'right', renderCell: (v) => cell.num(dataSize(Number(v))) },
  { key: 'Max', label: 'Max size', description: 'The largest IRIS will let the file grow. Unlimited: until the disk is full', width: '96px', sortable: true, align: 'right',
    renderCell: (v, row) => (Number(v) > 0 ? (row.NearMax ? chip(dataSize(Number(v)), 'warning', 'Nearly at its maximum size') : cell.num(dataSize(Number(v)))) : cell.dim('Unlimited')) },
  { key: 'Free', label: 'Free space', description: 'Space inside the file not yet used by data. It is used up before the file grows', width: '124px', sortable: true, align: 'right',
    renderCell: (v, row) => (Number.isFinite(Number(v)) && v !== null ? cell.num(`${dataSize(Number(v))} · ${dataPct(Number(row.FreePct))}`) : `<span title="${esc(String(row.FreeWhy ?? ''))}">${cell.dim('—')}</span>`) },
  { key: 'DiskFree', label: 'Disk free', description: 'Free space on the disk (volume) the file is on. A database can’t grow past it', width: '100px', sortable: true, align: 'right',
    renderCell: (v, row) => (Number.isFinite(Number(v)) && v !== null
      ? (Number(row.DiskPct) >= NEAR_FULL ? chip(`${dataSize(Number(v))} · ${row.Volume}`, 'warning', `The disk is ${dataPct(Number(row.DiskPct))} full`) : cell.num(`${dataSize(Number(v))} · ${row.Volume}`, Number.isFinite(Number(row.DiskPct)) ? `The disk is ${dataPct(Number(row.DiskPct))} full` : ''))
      : `<span title="${esc(String(row.DiskWhy ?? ''))}">${cell.dim('—')}</span>`) },
  { key: 'Journal', label: 'Journaled', description: 'Whether changes are written to the journal, which crash recovery, transaction rollback and mirroring rely on. — : not applicable (read-only, or unjournaled by design)', width: '96px', sortable: true,
    renderCell: (v) => (v === 'Yes' ? cell.text('Yes') : v === 'No' ? chip('No', 'warning', 'Changes aren’t journaled: they can’t be recovered after a crash or rolled back')
      : `<span title="${esc(v === 'RO' ? 'Not applicable: it’s read-only, so nothing is written to it' : v === 'Design' ? 'Not journaled, by design: IRIS installs it that way' : '')}">${cell.dim('—')}</span>`) },
  { key: 'Encrypted', label: 'Encrypted', width: '88px', sortable: true, renderCell: (v) => (v === 'Yes' ? chip('Encrypted', 'info') : cell.dim('No')) },
  { key: 'Resource', label: 'Protected by', description: 'The resource people need Read on to read its data, or Read & change to change it', width: '150px', sortable: true, renderCell: (v) => (v ? cellRef(v, '#/security/resources', `Open ${String(v)} in Resources`) : cell.dim('—')) },
  { key: 'Mirrored', label: 'Mirrored', width: '84px', sortable: true, renderCell: (v) => (v === 'Yes' ? cell.text('Yes') : cell.dim('No')) },
];
const SECONDARY = ['Mirrored', 'Encrypted', 'Resource', 'DiskFree', 'Journal'];

export function databasesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  // Two levels (objectDetail): the list with a peek panel, and a full view of one database (#/databases/databases/<name>).
  ctx.body.innerHTML = `
    <div class="od-list" id="db-list-view">
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="db-search" size="sm" full-width placeholder="Filter by name, directory or resource"></ev-search></div>
        <ev-segmented-button id="db-view" size="sm" aria-label="Show databases"></ev-segmented-button>
        <span class="db-chip-sep" aria-hidden="true"></span>
        <button type="button" class="db-toggle-chip" id="db-sys" aria-pressed="true" title="Include IRIS’s own system databases">System <span class="db-toggle-count" id="db-sys-count"></span></button>
      </div>
      <ev-detail-panel id="db-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="db-grid-wrap">${skeleton(10)}</div>
        <aside slot="detail" class="detail" id="db-detail" aria-label="Database details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="db-foot"></p>
    </div>
    <div id="db-full" hidden></div>`;
  const listView = ctx.body.querySelector('#db-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#db-full') as HTMLElement;

  const viewEl = ctx.body.querySelector('#db-view') as HTMLElement & { options: unknown; value: string };
  /** The "System n" toggle chip after the view chips: a pressed button, standing in for a checkbox. */
  const sysBtn = ctx.body.querySelector('#db-sys') as HTMLButtonElement;
  const sysEl = {
    get checked(): boolean { return sysBtn.getAttribute('aria-pressed') === 'true'; },
    set checked(on: boolean) { sysBtn.setAttribute('aria-pressed', String(on)); },
  };
  const searchEl = ctx.body.querySelector('#db-search') as HTMLElement & { value: string };
  const panel = ctx.body.querySelector('#db-panel') as HTMLElement & { open: boolean };
  const wrap = ctx.body.querySelector('#db-grid-wrap') as HTMLElement;
  const detailEl = ctx.body.querySelector('#db-detail') as HTMLElement;
  viewEl.value = 'all';

  let all: Db[] = [];
  /** Disk % full per volume, from the shared metrics feed (it has no row for some databases, e.g. IRISLOCALDATA). */
  let diskPctByVolume = new Map<string, number>();
  /** Each database's volume files (a quick read): their DiskFree is the free space on its disk. null = IRIS didn't say. */
  const vols = new Map<string, DbVolume[] | null>();
  const settings = new Map<string, DbSettings | null>();
  /**
   * IRIS's figures per database, by name, over the cache shared with Capacity
   * (api-db.ts): read once per visit, on the refresh button, and after an
   * action on that database; never on the auto-refresh.
   */
  const dirOfName = (name: string): string => all.find((x) => x.name === name)?.directory ?? '';
  const infos = {
    get: (name: string): DbInfo | undefined => { const dir = dirOfName(name); return dir ? cachedDbInfo(dir) : undefined; },
    has: (name: string): boolean => infos.get(name) !== undefined,
    delete: (name: string): void => { const dir = dirOfName(name); if (dir) forgetDbInfo(dir); },
  };
  const readable = (d: Db): boolean => d.state === 'mounted' || d.state === 'readonly';
  let spaces: NamespaceFull[] | null = null;
  let dbResources: string[] = [];
  let grid: GridEl | null = null;
  let view: View = 'all';
  /** Show IRIS's own system databases (on by default). */
  let withSystem = true;
  let query = '';
  let selected: string | null = null;
  let pending = takeSelection();
  let token = 0;
  let alive = true;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  // Where the open form lives: the list's drawer, or (from the full view) the full view's body.
  let formFull = false;
  let formEl: HTMLElement = detailEl;
  let menu: MenuHandle | null = null;
  let canOperate: boolean | null = null;
  let canManage: boolean | null = null;
  /** Work in progress per database ("Compacting…"), so its actions wait. */
  const busy = new Map<string, string>();
  ctx.onLeave(() => { alive = false; });

  const byName = (n: string | null): Db | undefined => all.find((d) => d.name === n);
  const uses = (d: Db): ReturnType<typeof usesOf> => (spaces ? usesOf(d.name, spaces) : []);
  const journaled = (d: Db): boolean | null => { const s = settings.get(d.name); return s ? s.GlobalJournalState : null; };
  /*
   * One source for every figure about the inside of a file: IRIS's on-demand
   * database figures (what the Management Portal shows). The metrics feed's
   * free-space sensor is sampled only now and then, so it lags (IRISSYS: 5.0 MB
   * there, 3.1 MB here) and has no row for read-only databases.
   */
  const sizeOf = (d: Db): number => infos.get(d.name)?.Size ?? d.sizeMb;
  const freeOf = (d: Db): number => (d.state === 'mounted' || d.state === 'readonly' ? infos.get(d.name)?.AvailableSpace ?? NaN : NaN);
  const freeWhy = (d: Db): string => (d.state === 'dismounted' ? 'Dismounted' : d.state === 'remote' ? 'On another server' : infos.has(d.name) ? '' : 'Loading');
  /** The disk a database's file is on: its drive (C:), else a filesystem told apart by its free space. */
  const volumeOf = (d: Db): string => {
    const drive = driveOf(d.directory);
    if (drive) return drive;
    const f = vols.get(d.name)?.[0]?.DiskFree;
    return f === undefined ? '' : `disk-${f}`;
  };
  const volumeLabel = (key: string): string => (key.startsWith('disk-') ? 'its disk' : key);
  const diskFreeOf = (d: Db): number => {
    const v = vols.get(d.name);
    if (v?.length) return v[0].DiskFree;
    const i = infos.get(d.name);
    return i ? parseSize(i.DiskFree) : NaN;
  };
  const diskWhy = (d: Db): string => (d.state === 'remote' ? 'It lives on another server, so its disk isn’t visible from here'
    : vols.get(d.name) === null ? 'IRIS didn’t report the disk for this database' : 'Loading');
  const diskPctOf = (d: Db): number => diskPctByVolume.get(volumeOf(d)) ?? NaN;
  const nearMax = (d: Db): boolean => d.maxMb > 0 && sizeOf(d) >= d.maxMb * (NEAR_FULL / 100);
  const diskFull = (d: Db): boolean => diskPctOf(d) >= NEAR_FULL;
  /** Journaling as shown: Yes, No (a real issue), No by design, not applicable (read-only), or not known yet. */
  const journalWord = (d: Db): 'Yes' | 'No' | 'Design' | 'RO' | '' => {
    if (d.state === 'readonly') return 'RO';
    const j = journaled(d);
    if (j === null) return '';
    if (j) return 'Yes';
    return UNJOURNALED_BY_DESIGN.includes(d.name.toUpperCase()) ? 'Design' : 'No';
  };
  const volumes = (): string[] => [...new Set(all.filter((d) => d.state !== 'remote').map(volumeOf).filter(Boolean))];

  /** Why a database needs a look, in short phrases ("is dismounted"). */
  const attention = (d: Db): string[] => {
    const out: string[] = [];
    if (d.state === 'dismounted') out.push(d.mountRequired ? 'is dismounted, and IRIS needs it to start' : 'is dismounted');
    if (nearMax(d)) out.push(`is at ${dataPct(pctOf(sizeOf(d), d.maxMb))} of its maximum size`);
    if (infos.get(d.name)?.Full) out.push('is full');
    if (diskFull(d)) out.push(`is on a disk that is ${dataPct(diskPctOf(d))} full`);
    return out;
  };

  const matchView = (d: Db, v: View): boolean =>
    v === 'all' || (v === 'mounted' ? d.state === 'mounted' || d.state === 'readonly' : v === 'dismounted' ? d.state === 'dismounted' : v === 'readonly' ? d.state === 'readonly' : attention(d).length > 0);
  const matchKind = (d: Db): boolean => withSystem || !d.system;
  const visible = (): Db[] => all.filter((d) => {
    if (!matchView(d, view) || !matchKind(d)) return false;
    if (!query) return true;
    const qq = query.toLowerCase();
    return [d.name, d.directory, d.resource, d.server].some((f) => f.toLowerCase().includes(qq));
  });

  const toRow = (d: Db): DataGridRow => {
    const free = freeOf(d);
    const sz = sizeOf(d);
    const disk = diskFreeOf(d);
    return {
      Name: d.name, State: d.state, System: d.system, Size: sz, Max: d.maxMb, NearMax: nearMax(d),
      Free: Number.isFinite(free) ? free : null, FreePct: Number.isFinite(free) ? pctOf(free, sz) : NaN, FreeWhy: freeWhy(d),
      DiskFree: Number.isFinite(disk) ? disk : null, DiskPct: diskPctOf(d), DiskWhy: diskWhy(d), Volume: volumeLabel(volumeOf(d)),
      Journal: journalWord(d),
      Encrypted: d.encrypted ? 'Yes' : 'No', Mirrored: d.mirrored ? 'Yes' : 'No',
      Resource: d.resource,
    };
  };

  const renderToolbar = (): void => {
    const nv = (v: View): number => all.filter((d) => matchView(d, v) && matchKind(d)).length;
    const att = nv('attention');
    // A risk chip with nothing in it is hidden, not dimmed: the footer already says nothing needs attention.
    setChips(viewEl, all.length, [
      { value: 'all', label: `All ${nv('all')}` },
      { value: 'mounted', label: `Mounted ${nv('mounted')}` },
      { value: 'dismounted', label: `Dismounted ${nv('dismounted')}` },
      { value: 'readonly', label: `Read-only ${nv('readonly')}`, disabled: nv('readonly') === 0 && view !== 'readonly' },
      { value: 'attention', label: `Needs attention ${att}` },
    ], { active: view, risk: ['dismounted', 'attention'], search: searchEl, query });
    const sys = all.filter((d) => d.system && matchView(d, view)).length;
    (ctx.body.querySelector('#db-sys-count') as HTMLElement).textContent = String(sys);
  };

  const renderFoot = (): void => {
    if (!grid) return;
    const sep = '<span class="meta-sep">·</span>';
    const mounted = all.filter((d) => d.state === 'mounted' || d.state === 'readonly').length;
    const total = all.reduce((a, d) => a + (Number.isFinite(sizeOf(d)) ? sizeOf(d) : 0), 0);
    const enc = all.filter((d) => d.encrypted).length;
    const mir = all.filter((d) => d.mirrored).length;
    const notJ = all.filter((d) => journalWord(d) === 'No').length;
    const vs = volumes();
    const one = vs.length === 1 ? all.find((d) => volumeOf(d) === vs[0] && Number.isFinite(diskFreeOf(d))) : undefined;
    const diskNote = one ? `${sep}<b>${esc(dataSize(diskFreeOf(one)))}</b> free on ${esc(volumeLabel(vs[0]) === 'its disk' ? 'the disk' : vs[0])}${Number.isFinite(diskPctOf(one)) ? ` (${esc(dataPct(diskPctOf(one)))} full)` : ''}` : '';
    const down = all.length - mounted - all.filter((d) => d.state === 'remote').length;
    const none = [all.some((d) => d.maxMb > 0) ? '' : 'size-limited', enc ? '' : 'encrypted', mir ? '' : 'mirrored'].filter(Boolean);
    const parts = [
      `<b>${num(all.length)}</b> database${all.length === 1 ? '' : 's'}`,
      `<b>${esc(dataSize(total))}</b> in all`,
      down ? `<b>${num(down)}</b> dismounted` : '',
      notJ ? `<b>${num(notJ)}</b> not journaled` : '',
      diskNote.replace(sep, ''),
      none.length ? `none ${listWords(none).replace(/ and ([^ ]+)$/, ' or $1')}` : '',
    ].filter(Boolean);
    (ctx.body.querySelector('#db-foot') as HTMLElement).innerHTML = parts.join(sep);
  };

  /** One banner for databases that need a look; "Show them" filters to them. */
  const renderBanner = (): void => {
    const bad = all.map((d) => ({ d, why: attention(d) })).filter((x) => x.why.length);
    if (!bad.length) { ctx.banners.innerHTML = ''; return; }
    const offline = bad.some((x) => x.d.state === 'dismounted' && x.d.mountRequired);
    const lines = bad.slice(0, 3).map((x) => `${x.d.name} ${listWords(x.why)}`);
    ctx.banners.innerHTML = `<div class="sec-callout sec-callout--${offline ? 'danger' : 'warning'} sec-banner" role="status">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <div><strong>${esc(bad.length === 1 ? '1 database needs attention.' : `${num(bad.length)} databases need attention.`)}</strong><span>${esc(lines.join('. '))}${bad.length > 3 ? ` and ${num(bad.length - 3)} more` : ''}.</span></div>
      <div class="sec-banner-actions"><button type="button" class="btn btn--sm" data-db-show>Show them</button></div>
    </div>`;
    ctx.banners.querySelector('[data-db-show]')?.addEventListener('click', () => {
      view = 'attention'; viewEl.value = 'attention'; withSystem = true; sysEl.checked = true;
      renderToolbar(); renderGrid();
    });
  };

  const applyColumns = (): void => {
    if (!grid) return;
    const uniform = uniformKeys(all.map(toRow), ['Mirrored', 'Encrypted']);
    // Only hide what the footer can say once ("none encrypted or mirrored").
    for (const k of ['Mirrored', 'Encrypted']) if (all.some((d) => (k === 'Mirrored' ? d.mirrored : d.encrypted))) uniform.delete(k);
    if (volumes().length <= 1) uniform.add('DiskFree');
    // Every database unlimited: the column would repeat "Unlimited"; the footer says it once.
    if (!all.some((d) => d.maxMb > 0)) uniform.add('Max');
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };

  const renderGrid = (): void => {
    const order = (d: Db): number => (d.system ? 1 : 0);
    const rows = visible().sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map(toRow);
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('aria-label', 'Databases');
      grid.columns = COLUMNS;
      grid.addEventListener('click', (e) => {
        const a = e.composedPath().find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement && n.getAttribute('href') === '#/security/resources');
        if (!a) return;
        e.preventDefault(); e.stopPropagation();
        linkTo(ctx.navigate, 'security/resources', a.textContent ?? '');
      }, true);
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        void selectRow(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name));
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.db-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      const what = view === 'attention' ? 'databases that need attention' : view === 'dismounted' ? 'dismounted databases' : view === 'readonly' ? 'read-only databases' : view === 'mounted' ? 'mounted databases' : 'databases';
      wrap.insertAdjacentHTML('beforeend', `<div class="db-empty">${emptyState({
        icon: 'search', title: `No ${what}${query ? ` match “${query}”` : ''}`,
        what: view === 'attention' ? 'Every database is mounted, below its maximum size and on a disk with room to spare.' : 'Change the filters above to see more.',
        action: '<button type="button" class="btn btn--sm" data-db-clear>Show all databases</button>',
      })}</div>`);
      wrap.querySelector('[data-db-clear]')?.addEventListener('click', () => {
        view = 'all'; query = ''; viewEl.value = 'all'; searchEl.value = ''; withSystem = true; sysEl.checked = true;
        renderToolbar(); renderGrid();
      });
    }
  };

  const close = (): void => {
    selected = null; token++; menu?.destroy(); menu = null;
    grid?.select([]);
    if (od.mode() === 'full') { void od.closeFull().then(() => od.select(null)); return; }
    void od.select(null);
    setPanel(false);
  };
  const open = (name: string): void => {
    if (!byName(name)) return;
    if (!visible().some((d) => d.name === name)) {
      view = 'all'; query = ''; withSystem = true;
      viewEl.value = 'all'; searchEl.value = ''; sysEl.checked = true;
      renderToolbar();
    }
    selected = name;
    renderGrid();
    void renderDetail();
    requestAnimationFrame(() => grid?.shadowRoot?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
  };

  const leaveEditor = (): void => {
    ctx.beforeLeave(null);
    editor?.close();
    editor = null;
    restoreWidth?.();
    restoreWidth = null;
    // A form in the full view's body gives it back: the full view's skeleton shows until it's re-read.
    if (formFull) fullEl.innerHTML = '';
    formFull = false;
    formEl = detailEl;
  };
  /** Cancel on a form: back to the peek, or to the full view it replaced. */
  const cancelForm = (): void => { leaveEditor(); void renderDetail(); };
  const keepEditing = (): never => {
    toast('Not saved. Your changes are still here.', 'info');
    throw new SubmitCancelled();
  };
  /** A row click: objectDetail asks the open form (if any) before it switches. */
  const selectRow = async (name: string): Promise<void> => {
    await od.select(name);
    if (od.selected() !== name) grid?.select(selected !== null ? [selected] : []);
  };

  /* ───────────── What may be done ───────────── */

  const VERB: Record<Act, string> = {
    mount: 'mounted', dismount: 'dismounted', expand: 'expanded', compact: 'compacted', truncate: 'truncated',
    defrag: 'defragmented', check: 'checked', edit: 'changed', delete: 'deleted',
  };
  /** Why an action can't be done now, or null when it can. */
  const whyNot = (d: Db, a: Act): string | null => {
    if (d.state === 'remote') return 'It lives on another server; manage it there.';
    const work = busy.get(d.name);
    if (work) return `${work} Wait for it to finish.`;
    const priv = MANAGE_ACTS.includes(a) ? canManage : canOperate;
    if (priv === false) return MANAGE_ACTS.includes(a) ? NO_MANAGE : NO_OPERATE;
    if (d.system && GUARDED.includes(a)) return `${d.name} is a system database IRIS needs, so it can’t be ${VERB[a]} here.`;
    if (a === 'mount') return d.state === 'dismounted' ? null : 'It’s already mounted.';
    if (a === 'delete') {
      if (!spaces) return 'Loading which namespaces use it.';
      const u = uses(d).filter((x) => x.roles.length);
      if (u.length) return `The ${listWords(u.map((x) => x.namespace))} namespace${u.length === 1 ? ' uses' : 's use'} it. Point ${u.length === 1 ? 'it' : 'them'} at another database first.`;
      return null;
    }
    if (d.state === 'dismounted' && a !== 'edit') return 'It’s dismounted. Mount it first.';
    if (d.state === 'readonly' && ['expand', 'compact', 'truncate', 'defrag'].includes(a)) return 'It’s mounted read-only, so its file can’t be changed.';
    const info = infos.get(d.name);
    if (a === 'compact' && info && info.AvailableSpace < 0.1) return 'There’s no free space inside it to move.';
    if (a === 'truncate' && info && info.EndFree !== '' && Number(info.EndFree) < 1) return 'There’s no free space at the end of the file to give back. Compact it first.';
    if (a === 'expand' && d.maxMb > 0 && sizeOf(d) >= d.maxMb) return 'It’s already at its maximum size. Raise the maximum first.';
    return null;
  };
  /** The visible reason lines under the action row (tooltips don't reach keyboard or touch users). */
  const reasonLines = (d: Db): string[] => {
    const out: string[] = [];
    if (d.state === 'remote') return ['It lives on another server; manage it there.'];
    if (busy.get(d.name)) out.push(`${busy.get(d.name)} Its other actions wait until it finishes.`);
    if (canOperate === false) out.push(`${NO_OPERATE}`);
    if (canManage === false) out.push(`${NO_MANAGE}`);
    // One short line; each blocked item in the ⋯ menu carries its own reason.
    if (d.system) out.push('System database: can’t be dismounted, compacted or deleted here.');
    else if (d.state === 'dismounted') out.push('It’s dismounted, so it can’t be checked, resized or compacted until you mount it.');
    else if (d.state === 'readonly') out.push(`It’s mounted read-only${infos.get(d.name)?.ReadOnlyReason ? ` (${infos.get(d.name)?.ReadOnlyReason})` : ''}, so its file can’t be expanded, compacted, truncated or defragmented.`);
    return out;
  };

  /* ───────────── Detail: the peek and the full view (objectDetail) ───────────── */

  /** A bar: used / free inside / room to the maximum (the track). */
  const sizeBar = (d: Db, info: DbInfo | undefined): string => {
    const sz = sizeOf(d);
    const free = info ? info.AvailableSpace : NaN;
    if (!Number.isFinite(sz) || sz <= 0 || !Number.isFinite(free)) return '';
    const used = Math.max(0, sz - free);
    const cap = d.maxMb > 0 ? d.maxMb : sz;
    const w = (x: number): string => `${Math.max(0, Math.min(100, (x / cap) * 100)).toFixed(1)}%`;
    return `<div class="db-bar" role="img" aria-label="${esc(`${dataSize(used)} used, ${dataSize(free)} free${d.maxMb > 0 ? `, ${dataSize(Math.max(0, d.maxMb - sz))} more it may grow` : ''}`)}">
        <span class="db-bar-used" style="width:${w(used)}"></span><span class="db-bar-free" style="width:${w(free)}"></span>
      </div>
      <div class="db-bar-key"><span><i class="db-key-used"></i>Used ${esc(dataSize(used))}</span><span><i class="db-key-free"></i>Free ${esc(dataSize(free))}</span>${d.maxMb > 0 ? `<span><i class="db-key-room"></i>May grow ${esc(dataSize(Math.max(0, d.maxMb - sz)))}</span>` : ''}</div>`;
  };

  /** What one database's detail is drawn from. */
  interface Facts { d: Db; s: DbSettings | null; info: DbInfo | undefined; files: DbVolume[] | null }
  const dash = (title = ''): string => `<span class="dim"${title ? ` title="${esc(title)}"` : ''}>—</span>`;

  const note = (html: string, tone: 'warning' | 'danger'): string =>
    `<div class="sec-callout sec-callout--${tone}" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>${html}</div></div>`;
  const warnHtml = (d: Db): string => {
    const warn = attention(d).map((w) => `${d.name} ${w}.`);
    return warn.length ? note(`<strong>Needs attention.</strong><span>${esc(warn.join(' '))}</span>`, d.state === 'dismounted' && d.mountRequired ? 'danger' : 'warning') : '';
  };
  const reasonsHtml = (d: Db): string => reasonLines(d).map((r) => `<p class="detail-note">${esc(r)}</p>`).join('');

  /** Row 2 of the peek and the full-view subtitle: "● State", then any exception as a pill. The directory is in Where it lives. */
  const metaOf = (d: Db): string => {
    const st = STATE_CHIP[d.state] ?? STATE_CHIP.unknown;
    const tone = d.state === 'mounted' ? 'success' : d.state === 'dismounted' ? 'warning' : 'neutral';
    const info = infos.get(d.name);
    return odMeta({ label: st.label, tone, title: st.title }, [], [
      busy.get(d.name) ? chip(String(busy.get(d.name)).replace(/\.$/, ''), 'info') : '',
      journalWord(d) === 'No' ? chip('Not journaled', 'warning', 'Changes can’t be recovered after a crash or rolled back') : '',
      info?.Full ? chip('Full', 'danger', 'It can’t grow any more') : '',
    ]);
  };

  /** How much the file grows next: "+10 MB", and whether that's IRIS's default. */
  const growthOf = ({ d, s, info }: Facts): { text: string; dflt: boolean } | null => {
    const expansion = s?.ExpansionSize ?? info?.ExpansionSize;
    if (expansion === undefined) return null;
    return expansion > 0 ? { text: `+${dataSize(expansion)}`, dflt: false } : { text: `+${dataSize(nextGrowth(sizeOf(d), 0))}`, dflt: true };
  };
  /**
   * Space rows. `short`: the full view, whose strip has Size (with the size limit) and Next growth,
   * and whose bar's key has the free space inside, so none of them is said twice.
   */
  const spaceKv = ({ d, s, info }: Facts, short = false): string => {
    const sz = sizeOf(d);
    const endFree = info && info.EndFree !== '' ? Number(info.EndFree) : NaN;
    const expansion = s?.ExpansionSize ?? info?.ExpansionSize;
    const step = nextGrowth(sz, expansion ?? 0);
    const rows: Array<[string, string] | [string, string, string]> = [];
    if (!short) {
      rows.push(['Size', esc(dataSize(sz))]);
      rows.push(['Free space', info ? esc(`${dataSize(info.AvailableSpace)} · ${dataPct(pctOf(info.AvailableSpace, sz))}`) : dash()]);
    }
    rows.push(['Unused at end of file', Number.isFinite(endFree) ? esc(dataSize(endFree)) : dash(),
      'The part of the free space inside that sits at the end of the file: Truncate can hand it back to the disk. — : not known while the database isn’t writable']);
    if (short) return odKv(rows.concat(info?.LastExpansionTime ? [['Last grew', esc(when(irisDate(info.LastExpansionTime)))]] : []));
    rows.push(['Maximum size', d.maxMb > 0 ? esc(`${dataSize(d.maxMb)} · ${dataPct(pctOf(sz, d.maxMb))} used`) : 'Unlimited']);
    if (d.state === 'mounted') {
      rows.push(['Next growth', expansion === undefined ? '—' : expansion > 0 ? esc(`+${dataSize(expansion)}`) : `${esc(`+${dataSize(step)}`)} <span class="dim">(IRIS default)</span>`,
        'How much the file grows the next time it needs more room. IRIS’s default is 12% of its size, at least 10 MB and at most 1 GB']);
    }
    if (info?.LastExpansionTime) rows.push(['Last grew', esc(when(irisDate(info.LastExpansionTime)))]);
    return odKv(rows);
  };

  /** `short`: the full view, whose strip already has Disk free. */
  const whereKv = ({ d, info, files }: Facts, short = false): string => {
    const diskFree = diskFreeOf(d);
    const diskPct = diskPctOf(d);
    const rows: Array<[string, string] | [string, string, string]> = [['Directory', `<span class="mono">${esc(d.directory)}</span>`, d.directory]];
    if (d.server) rows.push(['Server', esc(d.server)]);
    if (files && files.length > 1) rows.push(['Files', `${num(files.length)} volume files`, files.map((v) => `${v.File} ${dataSize(v.Size)}`).join(', ')]);
    if (!short) rows.push(['Disk free', Number.isFinite(diskFree) ? esc(`${dataSize(diskFree)} on ${volumeLabel(volumeOf(d)) === 'its disk' ? 'its disk' : volumeOf(d)}${Number.isFinite(diskPct) ? ` · ${dataPct(diskPct)} full` : ''}`) : dash(diskWhy(d))]);
    rows.push(['Block size', info ? esc(`${num(info.BlockSize / 1024)} KB`) : '—']);
    return odKv(rows);
  };
  const capacityLink = '<p class="detail-para"><a class="svc-link" href="#/databases/capacity" data-go="databases/capacity">Disk space for every database in Capacity</a></p>';

  const usesHtml = (d: Db): string => {
    const u = uses(d);
    return !spaces ? '<p class="detail-para dim">—</p>'
      : !u.length ? `<p class="detail-para">No namespace uses it${d.system ? ' directly; IRIS uses it itself' : ', so nothing can reach its data yet. Create a namespace for it in Namespaces to use it'}.</p>`
        : `<ul class="svc-list">${u.map((x) => `<li><a class="svc-link" href="#/${NS_ROUTE}" data-ns="${esc(x.namespace)}">${esc(x.namespace)}</a><span class="svc-meta">${esc([...x.roles, x.mapped ? `${plural(x.mapped, 'mapping')}` : ''].filter(Boolean).join(', '))}</span></li>`).join('')}</ul>`;
  };

  const journalHtml = (d: Db): string => {
    const w = journalWord(d);
    const text = w === 'Yes' ? 'Changes to its data are written to the journal, so they can be recovered after a crash, rolled back in a transaction and mirrored.'
      : w === 'No' ? 'Changes to its data aren’t journaled: they can’t be recovered after a crash or rolled back. Turn journaling on with Edit.'
        : w === 'Design' ? 'Not journaled, by design: IRIS installs it that way.'
          : w === 'RO' ? 'Not applicable: it’s read-only, so nothing is written to it.' : '—';
    return `<p class="detail-para">${esc(text)} <a class="svc-link" href="#/operations/journals" data-go="operations/journals">Journals</a></p>`;
  };

  const resourceHtml = (d: Db): string => (d.resource
    ? `<p class="detail-para">People need Read on <a class="svc-link mono" href="#/security/resources" data-res="${esc(d.resource)}">${esc(d.resource)}</a> to read its data, and Read &amp; change to change it.${d.resource === '%DB_%DEFAULT' ? ' It shares this default resource with any other database that has no resource of its own.' : ''}</p>`
    : '<p class="detail-para dim">Not recorded.</p>');

  const encryptionHtml = ({ d, info }: Facts): string => `<p class="detail-para">${d.encrypted
    ? `Encrypted on disk${info?.EncryptionKeyID ? ` with key <span class="mono">${esc(middle(info.EncryptionKeyID, 24))}</span>` : ''}. It can only be mounted while that key is activated.`
    : 'Not encrypted. A database is encrypted when it’s created, or by converting it offline.'} <a class="svc-link" href="#/security/encryption" data-go="security/encryption">Encryption</a></p>`;

  const mirrorKv = ({ d, info }: Facts): string => (d.mirrored || info?.MirrorSetName
    ? odKv([['Mirror', esc(info?.MirrorSetName || '—')], ['Name in the mirror', esc(info?.MirrorDBName || '—')], ['Fails over', info?.MirrorFailoverDB ? 'Yes' : 'No']]) : '');

  const startupKv = (d: Db): string => odKv([
    ['Mounted when IRIS starts', d.mountAtStartup ? 'Yes' : 'No, on first use'],
    ['IRIS needs it to start', d.mountRequired ? 'Yes' : 'No'],
  ]);

  /** Who holds each resource: the security graph, read once when a full view opens (shared, cached for 2 minutes). */
  let graph: SecurityGraph | null = null;
  let graphFailed = false;
  const rolesHtml = (d: Db): string => {
    if (!d.resource) return '';
    if (!graph) return graphFailed ? '' : '<p class="detail-para dim">Loading which roles grant it…</p>';
    const who = graph.whoCan(d.resource);
    const roles = who.roles.filter((r) => /[RW]/.test(r.perms));
    if (!roles.length) return `<p class="detail-para">No role grants it${who.public ? `; everyone has ${esc(/W/.test(who.public) ? 'Read & change' : 'Read')} on it` : ''}.</p>`;
    const SHOW_ROLES = 10;
    return `<p class="chip-sub">Roles that grant it · ${num(roles.length)}</p>
      <ul class="svc-list db-roles">${roles.slice(0, SHOW_ROLES).map((r) => `<li><a class="svc-link mono" href="#/security/roles" data-role="${esc(r.role)}">${esc(r.role)}</a><span class="svc-meta">${esc(/W/.test(r.perms) ? 'Read & change' : 'Read')}${r.path.length > 1 ? `<span class="db-roles-via">via ${esc(r.path[r.path.length - 1])}</span>` : ''}</span></li>`).join('')}</ul>
      ${roles.length > SHOW_ROLES ? `<p class="ns-more">and ${num(roles.length - SHOW_ROLES)} more in <a class="svc-link" href="#/security/resources" data-res="${esc(d.resource)}">Resources</a>.</p>` : ''}`;
  };

  /** Links inside the peek and the full view: another screen, with the item selected. */
  const wireLinks = (root: HTMLElement): void => {
    root.querySelectorAll<HTMLElement>('[data-ns]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); linkToScreen(ctx.navigate, NS_ROUTE, a.dataset.ns ?? ''); }));
    root.querySelectorAll<HTMLElement>('[data-res]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); linkTo(ctx.navigate, 'security/resources', a.dataset.res ?? ''); }));
    root.querySelectorAll<HTMLElement>('[data-role]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); linkTo(ctx.navigate, 'security/roles', a.dataset.role ?? ''); }));
    root.querySelectorAll<HTMLElement>('[data-go]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); ctx.navigate(a.dataset.go ?? ''); }));
  };

  /**
   * The reads behind a database's detail: its settings and volume files (quick reads), and IRIS's
   * figures from the shared cache. The figures are a background job in IRIS, so this never forces one:
   * readDbInfo reads only when the cache is older than 10 minutes, and at most two run at a time.
   */
  const readFacts = async (d: Db): Promise<Facts> => {
    if (d.state === 'remote') return { d, s: null, info: undefined, files: null };
    const [s, files, info] = await Promise.all([
      getDbSettings(d.directory).catch(() => settings.get(d.name) ?? null),
      getDbVolumes(d.directory).catch(() => vols.get(d.name) ?? null),
      // A read that lands here fills the list's Free space cell too.
      readable(d) ? readDbInfo(d.directory).then((i) => { if (alive) paintFigures(); return i; }, () => undefined) : Promise.resolve(infos.get(d.name)),
    ]);
    if (s) settings.set(d.name, s);
    if (files) vols.set(d.name, files);
    return { d, s: s ?? settings.get(d.name) ?? null, info: info ?? infos.get(d.name), files };
  };

  const peekBody = (f: Facts): string => {
    const { d } = f;
    const mirror = mirrorKv(f);
    return `${warnHtml(d)}${reasonsHtml(d)}
      ${odSection('Size and free space', sizeBar(d, f.info) + spaceKv(f))}
      ${odSection('Where it lives', whereKv(f) + capacityLink)}
      ${odSection('Mapped by', usesHtml(d))}
      ${odSection('Journal', journalHtml(d))}
      ${odSection('Protected by', resourceHtml(d))}
      ${odSection('Encryption', encryptionHtml(f))}
      ${mirror ? odSection('Mirroring', mirror) : ''}
      ${odSection('Startup', startupKv(d))}`;
  };

  const kv2 = (html: string): string => html.replace('class="od-kv"', 'class="od-kv wa-kv2"');
  const fullOf = (f: Facts): OdFull => {
    const { d, info } = f;
    const sz = sizeOf(d);
    const diskFree = diskFreeOf(d);
    const diskPct = diskPctOf(d);
    const u = spaces ? uses(d) : null;
    const mirror = mirrorKv(f);
    const reasons = reasonsHtml(d);
    const growth = growthOf(f);
    return {
      // Never repeats the subtitle: the state is there already.
      strip: [
        { label: 'Size', value: Number.isFinite(sz) ? dataSize(sz) : '—', caption: esc(d.maxMb > 0 ? `Limit ${dataSize(d.maxMb)}` : 'No size limit') },
        // Free inside is in the Space card's bar key; the strip has the next growth instead (not in the card).
        { label: 'Next growth', value: growth && d.state === 'mounted' ? growth.text : '—', caption: growth && d.state === 'mounted' ? (growth.dflt ? 'IRIS default' : 'Set for this database') : '',
          title: 'How much the file grows the next time it needs more room. IRIS’s default is 12% of its size, at least 10 MB and at most 1 GB' },
        { label: 'Disk free', value: Number.isFinite(diskFree) ? dataSize(diskFree) : '—', caption: esc(Number.isFinite(diskPct) ? `${volumeLabel(volumeOf(d))} · ${dataPct(diskPct)} full` : volumeLabel(volumeOf(d))) },
        { label: 'Mapped by', value: u === null ? '—' : plural(u.length, 'namespace'),
          caption: u ? u.map((x) => `<a class="svc-link" href="#/${NS_ROUTE}" data-ns="${esc(x.namespace)}">${esc(x.namespace)}</a>`).join(', ') : '',
          title: u ? u.map((x) => `${x.namespace}: ${x.roles.join(', ') || plural(x.mapped, 'mapping')}`).join('; ') : '' },
      ],
      notice: warnHtml(d) + (reasons ? `<div class="db-full-notes">${reasons}</div>` : ''),
      main: [
        // Wide cards list their rows two to a line, label beside value (Web applications' grid).
        { title: 'Space', body: `${d.system ? `<p>${esc(SYSTEM_DBS[d.name.toUpperCase()] ?? '')}</p>` : ''}${sizeBar(d, info)}${kv2(spaceKv(f, true))}` },
        { title: 'Where it lives', body: kv2(whereKv(f, true)) + capacityLink },
        { title: 'Startup', body: kv2(startupKv(d)) + (mirror ? `<h3 class="od-section-head db-subhead">Mirroring</h3>${kv2(mirror)}` : '') },
      ],
      side: [
        { title: 'Protected by', body: resourceHtml(d) + rolesHtml(d) },
        { title: 'Journal', body: journalHtml(d) },
        { title: 'Encryption', body: encryptionHtml(f) },
      ],
    };
  };

  /** Databases in the list's current filter and sort: what ‹ › and J/K step through. */
  const orderedNames = (): string[] => {
    const rows = visible().map(toRow);
    const g = grid as (GridEl & { sortColumn?: string; sortDirection?: string }) | null;
    const key = g?.sortColumn;
    if (!key) {
      const order = (r: DataGridRow): number => (r.System ? 1 : 0);
      return rows.sort((a, b) => order(a) - order(b) || String(a.Name).localeCompare(String(b.Name))).map((r) => String(r.Name));
    }
    const dir = g?.sortDirection === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = a[key]; const vb = b[key];
      if (va === null || va === undefined) return dir;
      if (vb === null || vb === undefined) return -dir;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
    return rows.map((r) => String(r.Name));
  };

  /**
   * Forms open where the user is looking: in the peek from the list; from the full view
   * (#/system/databases/<name>) in the body's place, so the address, title and ‹ › pager stay,
   * and Cancel or Save bring the full view back.
   */
  const here = (fn: (full: boolean) => void) => (): void => fn(od.mode() === 'full');

  const menuItems = (d: Db): MenuItem[] => {
    if (d.state === 'remote') return [];
    const item = (a: Act, label: string, onSelect: () => void, extra: Partial<MenuItem> = {}): MenuItem => {
      const r = whyNot(d, a);
      return { label, disabled: !!r, reason: r ?? undefined, onSelect, ...extra };
    };
    const items: MenuItem[] = [];
    if (d.state === 'dismounted') items.push(item('mount', 'Mount…', () => void doMount(d), { icon: 'eye' }));
    items.push(
      item('expand', 'Expand…', here((full) => void openExpand(d, full)), { icon: 'plus' }),
      item('compact', 'Compact…', here((full) => void openCompact(d, full))),
      item('truncate', 'Truncate…', () => void doTruncate(d)),
      item('defrag', 'Defragment…', () => void doDefrag(d)),
      item('check', 'Check integrity…', () => void doCheck(d), { icon: 'check' }),
    );
    if (d.state !== 'dismounted') items.push(item('dismount', 'Dismount…', () => void doDismount(d), { icon: 'eye-off', danger: true }));
    items.push(item('delete', 'Delete…', () => void doDelete(d), { icon: 'trash-2', danger: true }));
    return items;
  };

  const od = objectDetail<Db>(ctx, {
    collection: 'Databases', noun: 'database',
    panel, detail: detailEl, list: listView, full: fullEl,
    key: (d) => d.name,
    find: (k) => byName(k),
    order: orderedNames,
    name: (d) => d.name,
    meta: metaOf,
    description: (d) => (d.system ? SYSTEM_DBS[d.name.toUpperCase()] ?? '' : ''),
    primary: (d) => (d.state === 'remote' ? null : { label: 'Edit', icon: 'edit-2', run: here((full) => void openEditor(d, full)), blocked: whyNot(d, 'edit') }),
    menu: menuItems,
    peek: async (d) => peekBody(await readFacts(d)),
    loadFull: async (d) => {
      if (!graph && !graphFailed) {
        getSecurityGraph().then((g) => { graph = g; if (alive && od.mode() === 'full' && !formFull) od.refresh(); }, () => { graphFailed = true; });
      }
      return fullOf(await readFacts(d));
    },
    wire: (root) => wireLinks(root),
    onSelect: (k) => { selected = k; grid?.select(k ? [k] : []); },
    onPeek: () => applyColumns(),
    canLeave: async () => {
      if (!editor && !formFull) return true;
      if (editor && !(await editor.guard())) return false;
      leaveEditor();
      return true;
    },
  });

  /** Show the selected database (peek or full view), or close; never over an open form. */
  const renderDetail = async (_quiet = false): Promise<void> => {
    if (editor || formFull) return;
    // Never pull an open menu or dialog out from under the user.
    if (_quiet && document.querySelector('.crud-menu, ev-dialog')) return;
    if (od.mode() === 'full') { od.refresh(); return; }
    const want = selected;
    if (want === null) { if (od.selected() !== null) await od.select(null); return; }
    if (od.selected() !== want || !panel.open) await od.select(want); else od.refresh();
  };

  /** Refresh after an action and put the panel back in view mode with fresh figures. */
  const afterAction = async (name: string, message: string, reopen = selected === name): Promise<void> => {
    // Background work that ends while someone is looking at (or editing) another database leaves them alone.
    if (reopen) leaveEditor();
    if (message) toast(message);
    infos.delete(name);
    await load(true, false);
    const done = byName(name);
    if (done && readable(done)) void readDbInfo(done.directory).then(() => { if (alive) paintAll(); }, () => { /* keeps "…" */ });
    if (!reopen) return;
    if (byName(name)) open(name); else close();
  };

  /** Run background work: the database's actions wait, the panel says so, and a toast reports the end. */
  const background = async (d: Db, label: string, work: () => Promise<string>): Promise<void> => {
    busy.set(d.name, label);
    if (selected === d.name) void renderDetail();
    try {
      const done = await work();
      busy.delete(d.name);
      if (alive) await afterAction(d.name, done);
    } catch (err) {
      busy.delete(d.name);
      if (!alive) return;
      toast(`${d.name}: ${errorText(err)}`, 'danger');
      await afterAction(d.name, '');
    }
  };

  const nsWords = (d: Db): string => {
    const u = uses(d).filter((x) => x.roles.length);
    return u.length ? `The ${listWords(u.map((x) => `<b>${esc(x.namespace)}</b>`))} namespace${u.length === 1 ? '' : 's'}` : '';
  };

  async function doMount(d: Db): Promise<void> {
    if (whyNot(d, 'mount')) return;
    let readOnly = false;
    const ok = await confirm({
      title: `Mount ${d.name}?`,
      body: `<p>It comes back online. ${nsWords(d) ? `${nsWords(d)} can read and change its data again.` : 'No namespace uses it yet.'}</p>${d.encrypted ? '<p>It’s encrypted, so its key must be activated.</p>' : ''}`,
      confirmLabel: 'Mount',
      alternative: { label: 'Mount read-only', onSelect: () => { readOnly = true; void mountNow(d, true); } },
    });
    if (ok && !readOnly) await mountNow(d, false);
  }
  async function mountNow(d: Db, readOnly: boolean): Promise<void> {
    try {
      await mountDb(d.directory, readOnly);
    } catch (err) {
      toast(`Couldn’t mount ${d.name}. ${errorText(err)}`, 'danger');
      return;
    }
    await afterAction(d.name, `${d.name} mounted${readOnly ? ' read-only' : ''}.`);
  }

  async function doDismount(d: Db): Promise<void> {
    if (whyNot(d, 'dismount')) return;
    const u = uses(d).filter((x) => x.roles.length);
    const risks: GuardRisk[] = [{
      title: `This takes ${d.name} offline`,
      text: u.length
        ? `The ${listWords(u.map((x) => x.namespace))} namespace${u.length === 1 ? ' loses' : 's lose'} ${listWords([...new Set(u.flatMap((x) => x.roles))])} until it’s mounted again; programs using it get errors.`
        : 'Nothing can read or change its data until it’s mounted again.',
      impact: `Nothing in it is deleted.${d.mountRequired ? ' IRIS is set to need it at startup, so a restart while it’s dismounted fails.' : ''}`,
    }];
    const g = guardDialog(risks);
    const ok = await confirm({ title: `Dismount ${d.name}?`, body: g.body, confirmLabel: 'Dismount', danger: true, typeToConfirm: u.length ? d.name : undefined });
    if (!ok) return;
    try {
      await dismountDb(d.directory);
    } catch (err) {
      toast(`Couldn’t dismount ${d.name}. ${errorText(err)}`, 'danger');
      return;
    }
    await afterAction(d.name, `${d.name} dismounted. Mount it again from here when you’re ready.`);
  }

  async function doTruncate(d: Db): Promise<void> {
    if (whyNot(d, 'truncate')) return;
    const info = infos.get(d.name);
    const end = info && info.EndFree !== '' ? Number(info.EndFree) : NaN;
    const sz = sizeOf(d);
    const ok = await confirm({
      title: `Truncate ${d.name}?`,
      body: `<p>Gives ${Number.isFinite(end) ? `the <b>${esc(dataSize(end))}</b>` : 'the'} free space at the end of the file back to the disk${Number.isFinite(end) ? `, so the file shrinks from ${esc(dataSize(sz))} to about ${esc(dataSize(Math.max(0, sz - end)))}` : ''}. No data is removed.</p>
        <p class="dim">It runs in the background while the database stays in use. The file grows again when it needs room.</p>`,
      confirmLabel: 'Truncate',
    });
    if (!ok) return;
    await background(d, 'Truncating…', async () => {
      await truncateDb(d.directory, 0);
      return `${d.name} truncated.`;
    });
  }

  async function doDefrag(d: Db): Promise<void> {
    if (whyNot(d, 'defrag')) return;
    const info = infos.get(d.name);
    const ok = await confirm({
      title: `Defragment ${d.name}?`,
      body: `<p>IRIS rearranges the blocks inside the file so each global’s data sits together, which can make reading it faster. No data is changed.</p>
        <p>It runs in the background while the database stays in use, and adds disk activity until it finishes. It needs free space inside the database to work in${info ? ` (now ${esc(dataSize(info.AvailableSpace))})` : ''}, and the file may grow.</p>`,
      confirmLabel: 'Defragment',
    });
    if (!ok) return;
    await background(d, 'Defragmenting…', async () => {
      await defragmentDb(d.directory);
      return `${d.name} defragmented.`;
    });
  }

  async function doCheck(d: Db): Promise<void> {
    if (whyNot(d, 'check')) return;
    const ok = await confirm({
      title: `Check ${d.name} for damage?`,
      body: `<p>IRIS reads every global in the database and checks its structure. Nothing is changed.</p><p class="dim">On a large database this takes a while and adds disk reads. You’ll see the report here when it finishes.</p>`,
      confirmLabel: 'Run check',
    });
    if (!ok) return;
    await background(d, 'Checking integrity…', async () => {
      const r = await checkDb(d.directory);
      if (alive) showReport(d, r);
      return r.ok ? `${d.name}: no errors found.` : '';
    });
  }

  /** The integrity report in a dialog. */
  function showReport(d: Db, r: { ok: boolean; lines: string[]; reason?: string }): void {
    const dlg = document.createElement('ev-dialog') as HTMLElement & { open: boolean; close(): void };
    dlg.setAttribute('heading', `Integrity check: ${d.name}`);
    dlg.setAttribute('size', 'lg');
    const body = r.lines.slice(3).join('\n').trim();
    dlg.innerHTML = `<div slot="body" class="db-report-body">
        <div class="sec-callout${r.ok ? '' : ' sec-callout--danger'}" role="status"><ev-icon name="${r.ok ? 'check' : 'alert-triangle'}" size="sm"></ev-icon>
          <div><strong>${r.ok ? 'No errors were found.' : 'IRIS found problems.'}</strong><span>${esc(r.ok ? `Every global in ${d.name} checked out.` : r.reason ? r.reason : 'Read the report below; contact InterSystems support before repairing a database.')}</span></div></div>
        ${body ? `<pre class="db-report">${esc(body)}</pre>` : ''}
      </div>
      <div slot="footer" class="crud-dialog-foot"><button type="button" class="btn btn--primary" data-dismiss>Close</button></div>`;
    dlg.querySelector('[data-dismiss]')?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('ev-dialog-close', () => setTimeout(() => dlg.remove(), 0), { once: true });
    document.body.appendChild(dlg);
    dlg.open = true;
  }

  async function doDelete(d: Db): Promise<void> {
    if (whyNot(d, 'delete')) return;
    const mapped = uses(d).reduce((a, x) => a + x.mapped, 0);
    const ok = await confirm({
      title: `Delete ${d.name}?`,
      body: `<p>This removes ${esc(d.name)} from IRIS and <b>deletes its file</b>, with all the data in it:</p>
        <p class="mono db-confirm-path">${esc(d.directory)}IRIS.DAT</p>
        <p>It can’t be undone. Make sure you have a backup.${mapped ? ` ${esc(plural(mapped, 'mapping'))} in namespaces still point at it and will stop working.` : ''}</p>`,
      confirmLabel: 'Delete database and file',
      danger: true,
      typeToConfirm: d.name,
      alternative: { label: 'Keep the file', onSelect: () => void removeOnly(d) },
    });
    if (!ok) return;
    try {
      await deleteDb(d.name, d.directory, true);
    } catch (err) {
      toast(`Couldn’t delete ${d.name}. ${errorText(err)}`, 'danger');
      await load(true);
      return;
    }
    close();
    await afterAction(d.name, `${d.name} and its file deleted.`);
  }
  async function removeOnly(d: Db): Promise<void> {
    const ok = await confirm({
      title: `Remove ${d.name} from IRIS?`,
      body: `<p>IRIS forgets the name ${esc(d.name)}; the file stays at <span class="mono">${esc(d.directory)}</span>, and you can add it back later in the Management Portal.</p>`,
      confirmLabel: 'Remove, keep the file',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteDb(d.name, d.directory, false);
    } catch (err) {
      toast(`Couldn’t remove ${d.name}. ${errorText(err)}`, 'danger');
      return;
    }
    close();
    await afterAction(d.name, `${d.name} removed from IRIS. Its file is kept.`);
  }

  /* ───────────── Forms ───────────── */

  const mbField = (name: string, label: string, value: number | '', hint: string, opts: { placeholder?: string } = {}): string =>
    textField(name, label, value === '' ? '' : String(value), { hint, mono: true, width: '140px', placeholder: opts.placeholder });
  /** "" → blank; anything else must be a whole number of MB ≥ 0. */
  const readMb = (v: unknown): number | null => {
    const t = String(v ?? '').trim();
    if (t === '') return 0;
    return /^\d+$/.test(t) ? Number(t) : null;
  };
  /** Get the form's host ready: the peek (opened at edit width), or the full view's body when `full`. */
  const beginForm = (d: Db | null, full = false): void => {
    menu?.destroy(); menu = null;
    formFull = full;
    formEl = full ? fullEl : detailEl;
    if (!full) {
      setPanel(true);
      restoreWidth ??= panelWidth(panel, EDIT_WIDTH);
    }
    if (d) selected = d.name;
  };
  /** The user paged or went back to the list while a full-view form's reads were out. */
  const movedOn = (d: Db, full: boolean): boolean => full && (od.mode() !== 'full' || od.selected() !== d.name);
  /**
   * `blocked`: why Save can't be used right now (a value that can never be saved, shown on its field
   * as it's typed). Applied after the editor's own refresh, which only knows "no changes yet".
   */
  const wirePreview = (ed: EditorHandle, update: () => void, blocked?: () => string | null): void => {
    const submit = ed.form.querySelector<HTMLElement>('.crud-submit');
    const block = (): void => { if (editor === ed && submit && blocked) { const why = blocked(); if (why) setBlocked(submit, why); } };
    const onChange = (): void => { if (editor === ed) { update(); ed.refresh(); setTimeout(block, 0); } };
    for (const t of ['input', 'change', 'ev-input-input', 'ev-select-change', 'ev-checkbox-change', 'ev-toggle-change']) ed.form.addEventListener(t, onChange);
    update();
    scrollPanelTop(formEl);
    requestAnimationFrame(() => { if (editor === ed) { update(); ed.refresh(); block(); } });
  };
  const previewHtml = (lines: string[], notes: GuardRisk[] = []): string =>
    `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${notes.map((x) => `<div class="crud-note crud-note--warning" role="alert"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>${esc(x.title)}.</strong> ${esc(x.text)}</div></div>`).join('')}`;

  const openEditor = async (d: Db, full = false): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    if (whyNot(d, 'edit')) { void renderDetail(); return; }
    const my = ++token;
    beginForm(d, full);
    const box = formEl;
    box.innerHTML = skeleton(6);
    let s: DbSettings;
    try {
      s = await getDbSettings(d.directory);
      if (!dbResources.length) dbResources = await loadDbResources();
    } catch (err) {
      if (my !== token || movedOn(d, full)) return;
      if (full) { leaveEditor(); toast(errorText(err), 'danger'); void renderDetail(); return; }
      restoreWidth?.(); restoreWidth = null;
      box.innerHTML = errorPanel(err);
      return;
    }
    if (my !== token || movedOn(d, full)) return;
    const sys = d.system;
    const res = [...new Set([s.ResourceName, ...dbResources])].filter(Boolean).sort();
    const sections =
      section('Size and growth', `<div class="crud-row">
          ${mbField('MaxSize', 'Maximum size (MB)', s.MaxSize || '', 'Empty for unlimited: it grows until the disk is full.', { placeholder: 'Unlimited' })}
          ${mbField('ExpansionSize', 'Grow by (MB)', s.ExpansionSize || '', 'Empty for IRIS’s default.', { placeholder: 'Default' })}
        </div>`)
      + (sys ? section('Other settings', `<p class="svc-hint">Journaling, the resource and startup settings of system databases are left as IRIS set them here. <a href="${esc(portalDb.properties(d.directory, d.name))}" target="_blank" rel="noopener">Management Portal ↗</a></p>`) : section('Journaling', checkField('GlobalJournalState', 'Journal changes to its data', s.GlobalJournalState, {
        toggle: true, hint: 'Crash recovery, transaction rollback and mirroring rely on the journal. Turn it off only for data you can rebuild.',
      }))
      + section('Protected by', selectField('ResourceName', 'Resource', res.map((r) => ({ value: r, label: r })), s.ResourceName, {
        searchable: res.length > 8, hint: 'People need Read on this resource to read its data, and Read & change to change it.',
      }))
      + section('Startup', checkField('MountAtStartup', 'Mount when IRIS starts', d.mountAtStartup, { hint: 'Otherwise it’s mounted the first time something uses it.' })
        + checkField('MountRequired', 'IRIS needs it to start', d.mountRequired, { hint: 'If it can’t be mounted, IRIS won’t start.' })))
      + section('What changes', '<div id="db-preview" class="svc-preview" aria-live="polite"></div>');

    type Form = { max: number | null; exp: number | null; journal: boolean; resource: string; atStart: boolean; required: boolean };
    const read = (): Form => {
      const v = readForm(box);
      return {
        max: readMb(v.MaxSize), exp: readMb(v.ExpansionSize),
        journal: sys ? s.GlobalJournalState : v.GlobalJournalState === true,
        resource: sys ? s.ResourceName : String(v.ResourceName ?? s.ResourceName),
        atStart: sys ? d.mountAtStartup : v.MountAtStartup === true,
        required: sys ? d.mountRequired : v.MountRequired === true,
      };
    };
    const patchOf = (f: Form): { dir: DbSettingsPatch; cfg: { MountAtStartup?: boolean; MountRequired?: boolean } } => {
      const dir: DbSettingsPatch = {};
      if (f.max !== null && f.max !== (s.MaxSize || 0)) dir.MaxSize = f.max;
      if (f.exp !== null && f.exp !== (s.ExpansionSize || 0)) dir.ExpansionSize = f.exp;
      if (f.journal !== s.GlobalJournalState) dir.GlobalJournalState = f.journal;
      if (f.resource !== s.ResourceName) dir.ResourceName = f.resource;
      const cfg: { MountAtStartup?: boolean; MountRequired?: boolean } = {};
      if (f.atStart !== d.mountAtStartup) cfg.MountAtStartup = f.atStart;
      if (f.required !== d.mountRequired) cfg.MountRequired = f.required;
      return { dir, cfg };
    };
    const changes = (f: Form): number => { const p = patchOf(f); return Object.keys(p.dir).length + Object.keys(p.cfg).length; };
    const tooSmall = (f: Form): boolean => f.max !== null && f.max > 0 && f.max < Math.ceil(sizeOf(d));
    const risksOf = (f: Form): GuardRisk[] => {
      const out: GuardRisk[] = [];
      if (s.GlobalJournalState && !f.journal) out.push({ title: `This stops journaling ${d.name}`, text: 'Changes to its data can’t be recovered after a crash, rolled back in a transaction or mirrored.' });
      if (f.resource !== s.ResourceName) out.push({ title: `This changes who can use ${d.name}`, text: `Access will come from ${f.resource}. Roles that grant ${s.ResourceName} no longer reach its data; people who need it must hold a role that grants ${f.resource}.` });
      // Below the current size is a field error (tooSmall), not a risk to confirm.
      if (f.max && f.max > 0 && !tooSmall(f) && sizeOf(d) >= f.max * (NEAR_FULL / 100)) {
        out.push({ title: `${d.name} would be nearly full`, text: `It’s ${dataSize(sizeOf(d))} already, so it could grow only ${dataSize(Math.max(0, f.max - sizeOf(d)))} more before writes fail.` });
      }
      if (!d.mountRequired && f.required) out.push({ title: 'IRIS won’t start without it', text: `If ${d.name} can’t be mounted at startup (a missing file, a key not activated), IRIS stops starting.` });
      return out;
    };
    const minMax = (): number => Math.ceil(sizeOf(d));
    /** A maximum below the current size: IRIS can't shrink a database this way, so it can never be saved. */
    const tooSmallText = (): string => `Must be at least ${num(minMax())} MB, its current size`;
    const check = (): FieldProblem[] => {
      const f = read();
      const out: FieldProblem[] = [];
      if (f.max === null) out.push({ field: 'MaxSize', label: 'Maximum size', message: 'Enter a whole number of MB, or leave it empty for unlimited' });
      else if (tooSmall(f)) out.push({ field: 'MaxSize', label: 'Maximum size', message: tooSmallText() });
      if (f.exp === null) out.push({ field: 'ExpansionSize', label: 'Grow by', message: 'Enter a whole number of MB, or leave it empty for the default' });
      return out;
    };
    const update = (): void => {
      const f = read();
      const lines: string[] = [];
      const mbText = (n: number, zero: string): string => (n > 0 ? dataSize(n) : zero);
      if (f.max !== null && f.max !== (s.MaxSize || 0)) lines.push(`Maximum size: ${mbText(s.MaxSize, 'unlimited')} → ${mbText(f.max, 'unlimited')}.`);
      if (f.exp !== null && f.exp !== (s.ExpansionSize || 0)) lines.push(`Grows by: ${mbText(s.ExpansionSize, 'IRIS’s default')} → ${mbText(f.exp, 'IRIS’s default')}.`);
      if (f.journal !== s.GlobalJournalState) lines.push(`Journaling: ${s.GlobalJournalState ? 'on' : 'off'} → ${f.journal ? 'on' : 'off'}.`);
      if (f.resource !== s.ResourceName) lines.push(`Protected by: ${s.ResourceName} → ${f.resource}.`);
      if (f.atStart !== d.mountAtStartup) lines.push(`Mounted when IRIS starts: ${d.mountAtStartup ? 'yes' : 'no'} → ${f.atStart ? 'yes' : 'no'}.`);
      if (f.required !== d.mountRequired) lines.push(`IRIS needs it to start: ${d.mountRequired ? 'yes' : 'no'} → ${f.required ? 'yes' : 'no'}.`);
      if (!lines.length) lines.push('No changes yet.');
      const host = box.querySelector('#db-preview');
      if (host) host.innerHTML = previewHtml(lines, risksOf(f));
      // Shown as it's typed, not only when Save is pressed: this value can never be saved.
      fieldError(box, 'MaxSize', tooSmall(f) ? tooSmallText() : null);
    };

    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(box, {
      subtitle: sys ? 'System database' : undefined,
      // The full view's title already names the database.
      title: full ? 'Edit settings' : `Edit <span class="mono">${esc(d.name)}</span>`,
      name: d.name,
      submitLabel: 'Save changes',
      sections,
      check,
      changed: () => changes(read()) > 0,
      onSubmit: async () => {
        const f = read();
        const p = patchOf(f);
        if (!changes(f)) throw new Error('Nothing to save.');
        const risks = risksOf(f);
        if (risks.length) {
          const g = guardDialog(risks);
          if (!(await confirm({ title: g.title, body: g.body, confirmLabel: 'Save anyway', danger: risks.some((r) => /journaling|who can use/.test(r.title)) }))) keepEditing();
        }
        if (Object.keys(p.dir).length) await saveDbSettings(d.directory, p.dir);
        if (Object.keys(p.cfg).length) await saveDbStartup(d.name, p.cfg);
        settings.delete(d.name);
        await afterAction(d.name, `${d.name} saved.${p.dir.ResourceName ? ' People get the new access the next time they sign in.' : ''}`);
      },
      onCancel: cancelForm,
    });
    wirePreview(editor, update, () => (tooSmall(read()) ? tooSmallText() : null));
  };

  const openExpand = async (d: Db, full = false): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    if (whyNot(d, 'expand')) { void renderDetail(); return; }
    beginForm(d, full);
    const box = formEl;
    const sz = sizeOf(d);
    const diskFree = diskFreeOf(d);
    const suggest = Math.ceil(sz * 2);
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    const read = (): number | null => readMb(readForm(box).Size);
    editor = editorShell(box, {
      title: full ? 'Expand' : `Expand <span class="mono">${esc(d.name)}</span>`,
      name: `the new size of ${d.name}`,
      submitLabel: 'Expand',
      sections: section('New size', mbField('Size', 'Size (MB)', '', `Now ${dataSize(sz)}.${d.maxMb > 0 ? ` Its maximum is ${dataSize(d.maxMb)}.` : ''}${Number.isFinite(diskFree) ? ` The disk has ${dataSize(diskFree)} free.` : ''}`, { placeholder: String(suggest) }),
        { hint: 'Grow the file now, ahead of need, so it doesn’t have to grow while people are working.' })
        + section('What changes', '<div id="db-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => {
        const n = read();
        if (!n) return [{ field: 'Size', label: 'Size', message: 'Enter the new size in MB' }];
        if (n <= sz) return [{ field: 'Size', label: 'Size', message: `Enter more than its current ${num(Math.ceil(sz))} MB` }];
        if (d.maxMb > 0 && n > d.maxMb) return [{ field: 'Size', label: 'Size', message: `Its maximum is ${num(d.maxMb)} MB. Raise the maximum first` }];
        if (Number.isFinite(diskFree) && n - sz > diskFree) return [{ field: 'Size', label: 'Size', message: `The disk has only ${dataSize(diskFree)} free` }];
        return [];
      },
      onSubmit: async () => {
        const n = read() ?? 0;
        const target = d;
        leaveEditor();
        void background(target, 'Expanding…', async () => {
          await expandDb(target.directory, n);
          return `${target.name} expanded to ${dataSize(n)}.`;
        });
      },
      onCancel: cancelForm,
    });
    wirePreview(editor, () => {
      const n = read();
      const host = box.querySelector('#db-preview');
      if (!host) return;
      host.innerHTML = previewHtml(n && n > sz
        ? [`Grows from ${dataSize(sz)} to ${dataSize(n)} (${dataSize(n - sz)} more).`, ...(Number.isFinite(diskFree) ? [`Leaves ${dataSize(Math.max(0, diskFree - (n - sz)))} free on the disk.`] : [])]
        : ['No changes yet.']);
    });
  };

  const openCompact = async (d: Db, full = false): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    if (whyNot(d, 'compact')) { void renderDetail(); return; }
    beginForm(d, full);
    const box = formEl;
    const my = token;
    let info = infos.get(d.name);
    if (!info) {
      box.innerHTML = skeleton(4);
      info = await readDbInfo(d.directory).catch(() => undefined);
      if (my !== token || movedOn(d, full)) return;
    }
    const free = info?.AvailableSpace ?? NaN;
    const endFree = info && info.EndFree !== '' ? Number(info.EndFree) : 0;
    const read = (): number | null => readMb(readForm(box).Target);
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(box, {
      title: full ? 'Compact' : `Compact <span class="mono">${esc(d.name)}</span>`,
      name: `compacting ${d.name}`,
      submitLabel: 'Compact',
      submitAlways: true,
      sections: section('Free space to move', mbField('Target', 'Move to the end (MB)', Number.isFinite(free) ? Math.floor(free) : '', `${Number.isFinite(free) ? `${dataSize(free)} is free inside now, ${dataSize(endFree)} of it already at the end.` : ''} Empty moves as much as it can.`),
        { hint: 'Compacting moves data toward the start of the file so its free space collects at the end. The file doesn’t shrink until you truncate it.' })
        + section('What changes', '<div id="db-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => {
        const n = read();
        if (n === null) return [{ field: 'Target', label: 'Free space to move', message: 'Enter a whole number of MB' }];
        if (Number.isFinite(free) && n > Math.ceil(free)) return [{ field: 'Target', label: 'Free space to move', message: `Only ${dataSize(free)} is free inside` }];
        return [];
      },
      onSubmit: async () => {
        const n = read() || Math.floor(Number.isFinite(free) ? free : 0);
        const target = d;
        leaveEditor();
        void background(target, 'Compacting…', async () => {
          await compactDb(target.directory, n);
          return `${target.name} compacted. Truncate it to give the free space at the end back to the disk.`;
        });
      },
      onCancel: cancelForm,
    });
    wirePreview(editor, () => {
      const n = read();
      const host = box.querySelector('#db-preview');
      if (host) host.innerHTML = previewHtml([
        `Moves up to ${dataSize(n || (Number.isFinite(free) ? free : 0))} of free space to the end of the file.`,
        'Runs in the background; the database stays in use, with extra disk activity until it finishes.',
      ]);
    });
  };

  /* ───────────── New database ───────────── */

  const mgrDir = (): string => {
    const sys = byName('IRISSYS');
    return sys?.directory ?? '';
  };
  const sepOf = (dir: string): string => (dir.includes('\\') ? '\\' : '/');
  const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const openNew = async (): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEditor();
    const my = ++token;
    selected = null;
    grid?.select([]);
    beginForm(null);
    detailEl.innerHTML = skeleton(6);
    try { if (!dbResources.length) dbResources = await loadDbResources(); } catch { /* the default resource still works */ }
    if (my !== token) return;
    const base = mgrDir();
    const sep = sepOf(base);
    const dirFor = (n: string): string => (base && n ? `${base}${n.toLowerCase()}${sep}` : '');
    let dirTouched = false;
    const res = [...new Set(['%DB_%DEFAULT', ...dbResources])].sort();
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(detailEl, {
      title: 'New database',
      name: 'the new database',
      submitLabel: 'Create database',
      sections:
        section('Name and place', textField('Name', 'Name', '', { required: true, mono: true, hint: 'Letters, digits, - and _. IRIS keeps names in capitals.' })
          + pathField('Directory', 'Directory', '', { required: true, mode: 'dir', title: 'Choose where the new database goes', hint: 'A new folder for its IRIS.DAT file. IRIS creates it: browse to its parent and type the new folder’s name.' }))
        + section('Size', `<div class="crud-row">
            ${mbField('Size', 'Initial size (MB)', 1, 'It grows by itself as data arrives.')}
            ${mbField('MaxSize', 'Maximum size (MB)', '', 'Empty for unlimited.', { placeholder: 'Unlimited' })}
          </div>${mbField('ExpansionSize', 'Grow by (MB)', '', 'Empty for IRIS’s default.', { placeholder: 'Default' })}`)
        + section('Journaling', checkField('Journal', 'Journal changes to its data', true, { toggle: true, hint: 'Keep this on unless the data can be rebuilt: crash recovery, rollback and mirroring rely on it.' }))
        + section('Protected by', selectField('Resource', 'Resource', res.map((r) => ({ value: r, label: r })), '%DB_%DEFAULT', {
          searchable: res.length > 8, hint: 'People need Read on it to read the data. For a resource of its own, create one in Resources first.',
        }))
        + section('What happens', '<div id="db-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => {
        const v = readForm(detailEl);
        const out: FieldProblem[] = [];
        const name = String(v.Name ?? '').trim();
        const dir = String(v.Directory ?? '').trim();
        if (!name) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
        else if (!NAME_RE.test(name)) out.push({ field: 'Name', label: 'Name', message: 'Use letters, digits, - and _ only (up to 64)' });
        else if (byName(name.toUpperCase())) out.push({ field: 'Name', label: 'Name', message: 'A database with this name already exists' });
        if (!dir) out.push({ field: 'Directory', label: 'Directory', message: 'Enter a directory' });
        else if (all.some((x) => dirKey(x.directory) === dirKey(dir))) out.push({ field: 'Directory', label: 'Directory', message: 'Another database already lives there' });
        const sz = readMb(v.Size);
        if (!sz) out.push({ field: 'Size', label: 'Initial size', message: 'Enter a whole number of MB, at least 1' });
        const mx = readMb(v.MaxSize);
        if (mx === null) out.push({ field: 'MaxSize', label: 'Maximum size', message: 'Enter a whole number of MB, or leave it empty' });
        else if (mx > 0 && sz && mx < sz) out.push({ field: 'MaxSize', label: 'Maximum size', message: 'Make it at least the initial size' });
        if (readMb(v.ExpansionSize) === null) out.push({ field: 'ExpansionSize', label: 'Grow by', message: 'Enter a whole number of MB, or leave it empty' });
        return out;
      },
      onSubmit: async (v) => {
        const name = String(v.Name).trim().toUpperCase();
        const directory = String(v.Directory).trim();
        const journal = v.Journal === true;
        if (!journal && !(await confirm({ title: `Create ${name} without journaling?`, body: '<p>Changes to its data can’t be recovered after a crash, rolled back in a transaction or mirrored.</p>', confirmLabel: 'Create anyway', danger: true }))) keepEditing();
        try {
          await createDb({ name, directory, sizeMb: readMb(v.Size) || 1, maxMb: readMb(v.MaxSize) || 0, expansionMb: readMb(v.ExpansionSize) || 0, journal, resource: String(v.Resource || '%DB_%DEFAULT') });
        } catch (err) {
          if (/exist/i.test(errorText(err))) { fieldError(detailEl, 'Name', 'A database with this name or directory already exists'); focusField(detailEl, 'Name'); }
          throw err;
        }
        await afterAction(name, `Database ${name} created and mounted. Create a namespace for it to use it.`, true);
      },
      onCancel: () => { ctx.beforeLeave(null); editor = null; restoreWidth?.(); restoreWidth = null; close(); },
    });
    const ed = editor;
    const nameEl = detailEl.querySelector<HTMLElement & { value: string }>('ev-input[name="Name"]');
    const dirEl = detailEl.querySelector<HTMLElement & { value: string }>('ev-input[name="Directory"]');
    dirEl?.addEventListener('ev-input-input', () => { dirTouched = true; });
    nameEl?.addEventListener('ev-input-input', () => {
      if (dirTouched || !dirEl) return;
      dirEl.value = dirFor(String(nameEl.value ?? '').trim());
    });
    wirePreview(ed, () => {
      const v = readForm(detailEl);
      const name = String(v.Name ?? '').trim().toUpperCase() || 'The database';
      const host = detailEl.querySelector('#db-preview');
      if (host) host.innerHTML = previewHtml([
        `${name} is created as ${String(v.Directory ?? '').trim() || '…'}IRIS.DAT, ${dataSize(readMb(v.Size) || 1)} to start, and mounted.`,
        `It’s protected by ${String(v.Resource || '%DB_%DEFAULT')}${v.Journal === true ? ' and journaled' : ', without journaling'}.`,
        'No namespace uses it yet: create one for it in Namespaces.',
      ]);
    });
  };

  const newBtn = newButton(ctx, 'New database', () => void openNew());

  /* ───────────── Loading ───────────── */

  async function loadDbResources(): Promise<string[]> {
    const rows = await get<Array<{ Name: string; ResourceType: string }>>('/security/resources');
    return rows.filter((r) => r.ResourceType === 'Database' || /^%DB_/i.test(r.Name)).map((r) => r.Name);
  }

  /** Journaling per database: one read each, on first load and after changes. */
  const fillSettings = (force: boolean): void => {
    const todo = all.filter((d) => d.state !== 'remote' && (force || !settings.has(d.name)));
    if (!todo.length) return;
    void Promise.all(todo.flatMap((d) => [
      getDbSettings(d.directory).then((s) => settings.set(d.name, s), () => settings.set(d.name, null)),
      getDbVolumes(d.directory).then((v) => vols.set(d.name, v), () => vols.set(d.name, null)),
    ])).then(() => {
      if (!alive) return;
      paintAll();
    });
  };
  /** IRIS's figures for every online database; each is a short background job, so they're reused for a while. */
  const fillInfos = (force: boolean): void => {
    const todo = all.filter(readable);
    if (!todo.length) return;
    // Reads run at most two at a time (api-db.ts), so each one repaints the figures as it lands,
    // instead of the list waiting for the slowest.
    void Promise.all(todo.map((d) => readDbInfo(d.directory, force).then(() => { if (alive) paintFigures(); }, () => { /* keeps "—" */ }))).then(() => {
      if (!alive) return;
      paintFigures();
      if (selected !== null && !editor && todo.some((d) => d.name === selected)) void renderDetail(true);
    });
  };
  const fillSpaces = (): void => {
    getNamespacesFull().then((n) => {
      if (!alive) return;
      spaces = n;
      if (selected !== null && !editor) void renderDetail(true);
    }).catch(() => { spaces = []; });
  };

  // How full each disk is comes from the shared metrics feed.
  // While the pointer is over the grid, or a menu or dialog is open, repaints wait.
  let hovering = false;
  let held = false;
  const frozen = (): boolean => hovering || !!document.querySelector('.crud-menu, ev-dialog');
  wrap.addEventListener('pointerenter', () => { hovering = true; });
  wrap.addEventListener('pointerleave', () => { hovering = false; if (held) paintAll(); });
  const paintAll = (): void => {
    if (grid && frozen()) { held = true; return; }
    held = false;
    renderToolbar(); renderGrid(); renderFoot(); renderBanner();
  };
  const flushTimer = setInterval(() => { if (held && !frozen()) paintAll(); }, 500);
  /**
   * New figures (free space inside) from the shared cache: repaint once per frame however many reads land.
   * A figure filling in doesn't move rows, so it isn't held back while the pointer is over the grid;
   * only an open menu or dialog holds it.
   */
  let figuresQueued = false;
  const paintFigures = (): void => {
    if (figuresQueued) return;
    figuresQueued = true;
    requestAnimationFrame(() => {
      figuresQueued = false;
      if (!alive || !grid) return;
      if (document.querySelector('.crud-menu, ev-dialog')) { held = true; return; }
      held = false;
      renderToolbar(); renderGrid(); renderFoot(); renderBanner();
    });
  };
  ctx.onLeave(() => clearInterval(flushTimer));
  ctx.onLeave(metrics.subscribe((snap, at) => {
    const next = new Map<string, number>();
    for (const x of samples(snap, 'iris_disk_percent_full')) {
      const drive = driveOf(x.labels.dir ?? '');
      const db = all.find((d) => d.name === x.labels.id);
      const key = drive ?? (db ? volumeOf(db) : '');
      if (key) next.set(key, x.value);
    }
    diskPctByVolume = next;
    if (all.length) { updated(at); paintAll(); }
  }));

  // The refresh button is the only thing that re-reads every database's figures.
  const updated = liveIndicator(ctx, () => void load(true, true, true));
  let loaded = false;
  /** detail: also refresh the open panel (quietly). */
  async function load(fresh = false, detail = true, figures = false): Promise<void> {
    try {
      all = await getDatabases();
      if (!alive) return;
      updated(new Date());
      if (fresh || !grid) { held = false; renderToolbar(); renderGrid(); renderFoot(); renderBanner(); } else paintAll();
      if (!loaded || fresh) { fillSettings(fresh); fillSpaces(); }
      if (!loaded || figures) fillInfos(figures);
      const first = !loaded;
      loaded = true;
      if (first) od.refresh();
      if (pending !== null) { const n = pending; pending = null; open(n); }
      else if (detail && !editor && (selected !== null || od.mode() === 'full')) {
        if (od.mode() === 'full' || (selected !== null && byName(selected))) void renderDetail(true); else close();
      }
    } catch (err) {
      grid = null;
      wrap.innerHTML = errorPanel(err, 'retry-db-list');
      wrap.querySelector('#retry-db-list')?.addEventListener('click', () => void load());
    }
  }

  searchEl.addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });
  viewEl.addEventListener('ev-segmented-button-change', (e) => { view = (e as CustomEvent<{ value: View }>).detail.value; renderToolbar(); renderGrid(); });
  sysBtn.addEventListener('click', () => { sysEl.checked = !sysEl.checked; withSystem = sysEl.checked; renderToolbar(); renderGrid(); });

  sessionInfo().then((info) => {
    canOperate = can(info, 'Operate');
    canManage = can(info, 'Manage');
    newBtn.setHidden(canManage === false);
    od.refreshHeader();
    if (!alive || editor || selected === null) return;
    void renderDetail(true);
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
  const timer = setInterval(() => { if (!editor) void load(); }, REFRESH_MS);
  ctx.onLeave(() => { clearInterval(timer); token++; menu?.destroy(); leaveEditor(); });
}
