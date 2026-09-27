// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Encryption — is data encrypted at rest, with which key, and what
 * happens at the next restart.
 *
 * The model (explained in the page help and the detail panel): a key file (on disk, locked by its
 * administrators' passwords) → a key is activated from it (held in memory
 * until IRIS stops) → the activated key encrypts databases, journal files and
 * the audit log. Data-element keys are activated the same way and used by
 * applications to encrypt individual values.
 *
 * Writes (request shapes verified from source; see api-crypto.ts): activate a
 * key, deactivate a key and create a key file, each behind typed confirmation.
 * Startup options, journal and audit encryption, and adding or removing keys
 * and administrators in a key file go to the matching Management Portal page.
 * Converting an existing database needs the ^EncryptionKey utility, which the
 * page explains.
 */
import '../styles-security.css';
import '../styles-secrets.css';
import '../styles-crypto.css';
import '../styles-sec.css';
import {
  getEncryptionSettings, getActivatedKeys, getDataElementKeys, getDatabaseEncryption, getKeysInFile, getFileAdmins,
  activateKey, deactivateKey, createKeyFile, keyBits, cryptoPortal, cryptoDocs,
  type EncryptionSettings, type ActivatedKey, type DbEncryption, type KeyKind, type KeyInFile,
} from '../api-crypto';
import {
  plural, kv, mono, portalButton,
  esc, chip, cell, skeleton, errorPanel, liveIndicator, viewTabs, bindViewTabs, setViewTabCount, num, uniformKeys, status, dataSize, strip,
  emptyState, noPermissionText,
  type ScreenCtx, type Tone, type GridColumn, setChips, setSearch,
} from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, passwordField,
  selectField, readForm, blockedAttrs, type FieldProblem, type EditorHandle, type MenuHandle, pathField,
} from '../crud';
import { linkTo, getSecurityGraph, type SecurityGraph } from '../api-security';
import { mountSecurityBanner } from '../security-view';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';
import { baseName } from '../api-disk';

type Tab = 'dbs' | 'keys' | 'files';
type DbFilter = 'all' | 'enc' | 'plain';
type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

/** One activated key, database or data-element, as the Keys tab lists it. */
interface KeyRow { Id: string; Kind: KeyKind; Bits: number; IsDefault: boolean; IsJournal: boolean }

/** Row name for journal files in the Databases grid (database names can't contain spaces, so it can't clash). */
const JOURNAL_ROW = 'Journal files';
/** File-picker filter for key files. */
const ENCKEY = [{ label: 'Key files', patterns: ['*.key'] }];
const NO_PRIV = noPermissionText('%Admin_Secure', 'security administration');
/** Key files seen this session (paths only), so the Key files tab can count them and the header knows one exists. */
const SEEN_FILES_KEY = 'osca-portal:key-files';
const seenFiles = (): string[] => { try { return JSON.parse(sessionStorage.getItem(SEEN_FILES_KEY) ?? '[]') as string[]; } catch { return []; } };
const rememberFile = (path: string): void => {
  try { sessionStorage.setItem(SEEN_FILES_KEY, JSON.stringify([...new Set([...seenFiles(), path])])); } catch { /* storage blocked */ }
};
/** IRIS's own databases whose encryption is a startup setting, not a per-database choice. */
const SYSTEM_DBS: Record<string, string> = {
  IRISTEMP: 'Encrypted together with IRISLOCALDATA through the startup setting “Encrypt IRISTEMP and IRISLOCALDATA”.',
  IRISLOCALDATA: 'Encrypted together with IRISTEMP through the startup setting “Encrypt IRISTEMP and IRISLOCALDATA”.',
  IRISSECURITY: 'Encrypted through the startup setting “Encrypt IRISSECURITY”. It holds users, roles and other security settings.',
  IRISAUDIT: 'Encrypted through the startup setting “Encrypt audit log”. Changing it deletes the existing audit data.',
};
const MIN_ROWS_TO_HIDE = 3;

const shortId = (id: string): string => (id.length > 13 ? `${id.slice(0, 8)}…` : id);
const muted = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const para = (html: string): string => `<p class="kv-text">${html}</p>`;
const docs = (href: string, label: string): string =>
  `<a class="docs-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}<ev-icon name="external-link" size="xs"></ev-icon></a>`;
const note = (html: string, warn = false): string =>
  `<div class="crud-note${warn ? ' crud-note--warning' : ''}"><ev-icon name="${warn ? 'alert-triangle' : 'info'}" size="sm"></ev-icon><div>${html}</div></div>`;

/** What happens at startup, in words. */
function startupWords(s: EncryptionSettings): { value: string; sub: string; tone: Tone } {
  switch (s.DBEncStartMode) {
    case 'Interactive': return { value: 'Asks for the key', sub: 'Someone enters a key file and administrator password each time IRIS starts.', tone: 'neutral' };
    case 'Unattended': return { value: 'Activates automatically', sub: s.DBEncStartKeyFile ? `From ${baseName(s.DBEncStartKeyFile)}, with no one present.` : 'From a key file on this server, with no one present.', tone: 'warning' };
    case 'KMIP': return { value: 'Activates from KMIP', sub: s.DBEncStartKMIPServer ? `Keys come from the KMIP server ${s.DBEncStartKMIPServer}.` : 'Keys come from a KMIP key server.', tone: 'neutral' };
    case 'None': return { value: 'No key activated', sub: 'After a restart, nothing encrypted can be read until someone activates its key.', tone: 'neutral' };
    default: return { value: 'Not known', sub: 'IRIS reported a startup option this portal doesn’t recognise.', tone: 'warning' };
  }
}

interface Risk { tone: 'danger' | 'warning'; title: string; text: string; link?: { href: string; label: string } }

/** Everything worth a page-level warning, most serious first. */
function findRisks(s: EncryptionSettings, dbs: DbEncryption[], active: Set<string>): Risk[] {
  const out: Risk[] = [];
  const enc = dbs.filter((d) => d.Encrypted);
  const locked = enc.filter((d) => d.KeyId && !active.has(d.KeyId));
  const dbPage = { href: cryptoPortal.databaseEncryption, label: 'Startup settings' };
  if (locked.length) {
    out.push({ tone: 'danger', title: `${plural(locked.length, 'encrypted database')} can’t be read now`,
      text: `The key for ${locked.map((d) => d.Name).join(', ')} isn’t activated, so ${locked.length === 1 ? 'it can’t be mounted' : 'they can’t be mounted'}. Activate the key from its key file.` });
  }
  if (enc.length && s.DBEncStartMode === 'None') {
    const required = enc.filter((d) => d.MountRequired || d.MountAtStartup).map((d) => d.Name);
    out.push({ tone: 'warning', title: 'After a restart, encrypted databases stay locked',
      text: `No key is activated when IRIS starts, so ${plural(enc.length, 'encrypted database')} can’t be mounted until someone activates the key by hand${required.length ? `, including ${required.join(', ')}, which ${required.length === 1 ? 'is' : 'are'} set to mount at startup` : ''}.`, link: dbPage });
  }
  if (s.DBEncStartMode === 'Unattended') {
    out.push({ tone: 'warning', title: 'Unattended startup: the key and its password are on this server',
      text: 'IRIS activates the key with no one present, so the encryption is only as safe as the machine and its backups. Anyone who takes the disks with the key file can read the data.', link: dbPage });
  }
  if (enc.length && !s.DBEncJournal) {
    out.push({ tone: 'warning', title: 'Journal files aren’t encrypted',
      text: 'Journal files record changes to databases, including encrypted ones, so copies of that data sit unencrypted on disk.', link: dbPage });
  }
  if (enc.length && !s.AuditEncrypt) {
    out.push({ tone: 'warning', title: 'The audit log isn’t encrypted',
      text: 'The audit log can hold user names, addresses and parts of queries, and it’s stored unencrypted while databases are encrypted.', link: dbPage });
  }
  return out;
}

export function encryptionScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div id="enc-strip" hidden></div>
    ${viewTabs('enc-tabs', [
      { value: 'dbs', label: 'Databases' },
      { value: 'keys', label: 'Activated keys', count: 0 },
      { value: 'files', label: 'Key files', count: 0 },
    ], 'dbs')}
    <div class="toolbar-row" id="enc-toolbar">
      <div class="search-box"><ev-search id="enc-search" size="sm" full-width placeholder="Filter by name" aria-label="Filter"></ev-search></div>
      <ev-segmented-button id="enc-filter" size="sm" aria-label="Which databases"></ev-segmented-button>
    </div>
    <ev-detail-panel id="enc-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="enc-wrap">${skeleton(8)}</div>
      <aside slot="detail" class="detail" id="enc-detail" aria-label="Details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="enc-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#enc-panel');
  const wrap = $('#enc-wrap');
  const detail = $('#enc-detail');
  const filterEl = $<HTMLElement & { options: unknown; value: string }>('#enc-filter');
  filterEl.value = 'all';

  let tab: Tab = 'dbs';
  let filter: DbFilter = 'all';
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let gridTab: Tab | null = null;
  let loaded = false;
  let alive = true;
  let settings: EncryptionSettings | null = null;
  let dbs: DbEncryption[] = [];
  let dbKeys: ActivatedKey[] = [];
  let deKeys: Array<{ Id: string }> = [];
  let canSecure: boolean | null = null;
  /** Key-file tab state: the path looked at last, and what was found. */
  let filePath = '';
  let fileResult: { path: string; keys: KeyInFile[]; admins: string[] } | { path: string; error: string } | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let menu: MenuHandle | null = null;
  ctx.onLeave(() => { alive = false; });

  const activeIds = (): Set<string> => new Set(dbKeys.map((k) => k.Id));
  const keyRows = (): KeyRow[] => [
    ...dbKeys.map((k) => ({ Id: k.Id, Kind: 'database' as KeyKind, Bits: keyBits(k.KeyLen), IsDefault: k.IsDefault || k.Id === settings?.DBEncDefaultKeyID, IsJournal: !!settings?.DBEncJournalKeyID && k.Id === settings.DBEncJournalKeyID })),
    ...deKeys.map((k) => ({ Id: k.Id, Kind: 'data-element' as KeyKind, Bits: 0, IsDefault: false, IsJournal: false })),
  ];
  const usersOf = (id: string): DbEncryption[] => dbs.filter((d) => d.Encrypted && d.KeyId === id);

  // ── Editing (activate, new key file) ──
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

  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => { selected = null; grid?.select([]); setPanel(false); };

  // ── Header ──
  /** Key files this page knows of: the startup key file and any looked inside this session. */
  const knownFiles = (): string[] => [...new Set([...(settings?.DBEncStartKeyFile ? [settings.DBEncStartKeyFile] : []), ...seenFiles()])];
  /** No key file known and nothing activated or encrypted → the first step is creating one; otherwise activating a key. */
  const needsFile = (): boolean => !knownFiles().length && !dbKeys.length && !deKeys.length && !dbs.some((d) => d.Encrypted);
  const headerLabel = (): string => (needsFile() ? 'Create key file' : 'Activate key');
  const newBtn = newButton(ctx, headerLabel(), () => void (needsFile() ? openNewFile() : openActivate(filePath || settings?.DBEncStartKeyFile || knownFiles()[0] || '')));
  const setHeader = (): void => {
    const span = newBtn.el.querySelector('span');
    if (span) span.textContent = headerLabel();
  };

  // ── Page notice ──
  /** The one Security banner: the most serious encryption risk as its headline, the rest listed after it. */
  let graph: SecurityGraph | null = null;
  const renderRisks = (): void => {
    const risks = settings ? findRisks(settings, dbs, activeIds()) : [];
    const top = risks[0];
    const rest = risks.slice(1).map((r) => r.title);
    const locked = !!top && top.tone === 'danger';
    if (top) {
      mountSecurityBanner(ctx.banners, graph, {
        tone: top.tone,
        headline: `${top.title}${rest.length ? ` (+${rest.length} more)` : ''}`,
        detail: `${top.text}${rest.length ? ` Also: ${rest.join('; ')}.` : ''}`,
        showThem: locked
          ? { label: 'Show them', run: () => void showEncrypted() }
          : top.link ? { label: `${top.link.label} ↗`, run: () => { window.open(top.link!.href, '_blank', 'noopener'); } } : undefined,
      });
      return;
    }
    mountSecurityBanner(ctx.banners, graph, null);
  };
  getSecurityGraph().then((g) => { if (!alive) return; graph = g; renderRisks(); }).catch(() => { /* Review fetches it on demand */ });

  // ── Grids ──
  const DB_COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Database', width: '200px', sortable: true, renderCell: (v, row) => cell.id(v, row.MappedBy ? `Mapped by ${String(row.MappedBy)}` : '') },
    { key: 'Enc', label: 'Status', width: '200px', sortable: true, description: 'Whether the database file is encrypted on disk',
      renderCell: (_v, row) => (row.Encrypted
        ? (row.KeyActive ? status('Encrypted', 'success') : chip('Encrypted · key not activated', 'danger', 'The key isn’t activated, so the database can’t be mounted'))
        : status('Not encrypted', 'neutral', '', { dim: true })) },
    { key: 'Size', label: 'Size', width: '96px', sortable: true, align: 'right', renderCell: (v) => (Number(v) > 0 ? cell.num(dataSize(Number(v))) : cell.dim('—')) },
    { key: 'Journaled', label: 'Journaled', width: '110px', sortable: true, description: 'Whether changes to it are journaled. Journal files hold copies of those changes',
      renderCell: (v) => (v === 'yes' ? cell.text('Yes') : v === 'no' ? cell.dim('No') : '') },
    { key: 'MappedBy', label: 'Mapped by', sortable: true, description: 'Namespaces whose data or code lives in it',
      renderCell: (v) => (v ? cell.text(v, `Namespaces: ${String(v)}`) : '') },
    { key: 'KeyId', label: 'Key ID', sortable: true, description: 'The key the database is encrypted with',
      renderCell: (v) => (v ? cell.mono(shortId(String(v)), false, String(v)) : cell.dim('—')) },
  ];
  const DB_SECONDARY: string[] = [];
  const KEY_COLUMNS: GridColumn[] = [
    { key: 'Id', label: 'Key ID', width: '300px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
    { key: 'KindLabel', label: 'Used for', width: '150px', sortable: true, description: 'Database keys encrypt databases, journal files and the audit log; data-element keys are used by applications' },
    { key: 'Bits', label: 'Length', width: '90px', sortable: true, renderCell: (v) => (Number(v) ? cell.text(`${v}-bit`) : cell.dim('—')) },
    { key: 'Roles', label: 'Default for', width: '200px', description: 'What IRIS uses this key for when nothing else is chosen', renderCell: (v) => (v ? cell.text(v) : cell.dim('—')) },
    { key: 'Uses', label: 'Encrypts', sortable: true, description: 'Databases encrypted with a database key. Data-element keys encrypt values chosen by applications, so there’s nothing to count',
      renderCell: (v) => (Number(v) > 0 ? cell.text(plural(Number(v), 'database')) : cell.dim('—')) },
  ];
  const KEY_SECONDARY = ['Roles'];
  let uniform = new Set<string>();

  const dbRows = (): DataGridRow[] => {
    const active = activeIds();
    const none = settings?.DBEncStartMode === 'None';
    const rows: DataGridRow[] = dbs.map((d) => {
      const startup = d.MountRequired ? 'Required' : d.MountAtStartup ? 'Optional' : 'On first use';
      return {
        Name: d.Name, Encrypted: d.Encrypted, KeyActive: !d.Encrypted || active.has(d.KeyId),
        Enc: d.Encrypted ? (active.has(d.KeyId) ? 1 : 0) : 2, KeyId: d.KeyId, Status: d.Status, Startup: startup,
        StartupRisk: d.Encrypted && none && (d.MountRequired || d.MountAtStartup), Resource: d.Resource, Size: d.SizeMB,
        Journaled: d.Journaled === null ? '' : d.Journaled ? 'yes' : 'no', MappedBy: d.MappedBy.join(', '),
      };
    });
    // Journal files aren't a database, but they hold copies of database changes: one row, so every place data rests is listed.
    if (settings) {
      const jk = settings.DBEncJournalKeyID;
      rows.push({
        Name: JOURNAL_ROW, Encrypted: settings.DBEncJournal, KeyActive: !settings.DBEncJournal || !jk || active.has(jk),
        Enc: settings.DBEncJournal ? (!jk || active.has(jk) ? 1 : 0) : 2, KeyId: settings.DBEncJournal ? jk : '',
        Status: 'Always on', Startup: 'Required', StartupRisk: false, Resource: '', Size: 0,
      });
    }
    return rows;
  };
  const keyGridRows = (): DataGridRow[] => keyRows().map((k) => ({
    Id: k.Id, Kind: k.Kind, KindLabel: k.Kind === 'database' ? 'Databases' : 'Data elements', Bits: k.Bits,
    Roles: [k.IsDefault ? 'New databases' : '', k.IsJournal ? 'Journal files' : ''].filter(Boolean).join(' · '),
    Uses: k.Kind === 'database' ? usersOf(k.Id).length : -1,
  }));
  const matches = (r: DataGridRow): boolean => {
    if (tab === 'dbs' && filter !== 'all' && (filter === 'enc') !== !!r.Encrypted) return false;
    return !query || [r.Name, r.Id, r.KeyId, r.Resource].some((f) => String(f ?? '').toLowerCase().includes(query.toLowerCase()));
  };

  const applyColumns = (): void => {
    if (!grid || tab === 'files') return;
    const cols = tab === 'dbs' ? DB_COLUMNS : KEY_COLUMNS;
    const secondary = tab === 'dbs' ? DB_SECONDARY : KEY_SECONDARY;
    for (const c of cols) {
      const show = !uniform.has(c.key) && !(panel.open && secondary.includes(c.key));
      grid.setColumnVisible(c.key, show);
    }
  };

  const renderGrid = (): void => {
    if (tab === 'files') { grid = null; gridTab = null; renderFiles(); return; }
    const every = tab === 'dbs' ? dbRows() : keyGridRows();
    const all = every.filter((r) => r.Name !== JOURNAL_ROW);
    const sysRows = every.filter((r) => r.Name === JOURNAL_ROW);
    if (!all.length) {
      grid = null; gridTab = null;
      if (!editor) closeDetail();
      wrap.innerHTML = tab === 'keys'
        ? emptyState({
          icon: 'key-round', title: 'No keys are activated',
          what: 'Nothing has been activated since IRIS last started.',
          why: 'IRIS needs one before it can create or mount an encrypted database, encrypt journal files or the audit log, or let applications encrypt values.',
          docs: { href: cryptoDocs.keys, label: 'About keys and key files' },
        })
        : emptyState({ icon: 'archive', title: 'No local databases', what: 'This instance reports no local databases.' });
      return;
    }
    if (!grid || gridTab !== tab) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', tab === 'dbs' ? 'Name' : 'Id');
      grid.setAttribute('sort-column', tab === 'dbs' ? 'Name' : 'KindLabel');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', tab === 'dbs' ? 'Databases and their encryption' : 'Activated keys');
      grid.columns = tab === 'dbs' ? DB_COLUMNS : KEY_COLUMNS;
      // "Protected by" is a link to the resource: open it pre-selected instead of opening the row.
      grid.addEventListener('click', (e) => {
        const a = e.composedPath().find((n): n is HTMLElement => n instanceof HTMLElement && !!n.dataset.res);
        if (!a) return;
        e.preventDefault(); e.stopPropagation();
        linkTo(ctx.navigate, 'security/resources', a.dataset.res ?? '');
      }, true);
      grid.addEventListener('ev-data-grid-row-click', async (e) => {
        const row = (e as CustomEvent<{ row: DataGridRow }>).detail.row;
        if (!(await mayLeave())) { grid?.select(selected !== null ? [selected] : []); return; }
        selected = String(tab === 'dbs' ? row.Name : row.Id);
        renderDetail();
      });
      wrap.appendChild(grid);
      gridTab = tab;
    }
    const keys = tab === 'dbs' ? ['Enc', 'KeyId'] : ['Bits', 'Roles', 'KindLabel', 'Uses'];
    uniform = all.length < MIN_ROWS_TO_HIDE ? new Set<string>()
      : new Set([...uniformKeys(all, keys), ...keys.filter((k) => all.every((r) => r[k] === '' || r[k] === undefined))].map(String));
    // Mapped by filled on 2 rows or fewer: the column goes, the fact stays in the name's tooltip.
    if (tab === 'dbs' && all.filter((r) => r.MappedBy).length <= 2) uniform.add('MappedBy');
    const rows = all.filter(matches);
    grid.rows = rows;
    void sysRows; // Journal files are said once, in the strip above the tabs.
    applyColumns();
    if (selected !== null && selected !== JOURNAL_ROW) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">${query ? `Nothing matches “${esc(query)}”.` : filter === 'enc' ? 'No database is encrypted.' : 'Every database is encrypted.'}</div>`);
  };

  const renderToolbar = (): void => {
    setViewTabCount(ctx.body, 'enc-tabs', 'keys', dbKeys.length + deKeys.length);
    setViewTabCount(ctx.body, 'enc-tabs', 'files', knownFiles().length);
    // Databases only: journal files are in the strip, so the counts match the Databases tab.
    const all = dbRows().filter((r) => r.Name !== JOURNAL_ROW);
    const enc = all.filter((r) => r.Encrypted).length;
    // The count appears once, in All; the split only when there is one to make.
    const split = enc > 0 && enc < all.length;
    setChips(filterEl, all.length, [
      { value: 'all', label: `All ${num(all.length)}` },
      ...(split || filter !== 'all' ? [
        { value: 'enc', label: `Encrypted ${num(enc)}`, disabled: enc === 0 && filter !== 'enc' },
        { value: 'plain', label: `Not encrypted ${num(all.length - enc)}`, disabled: all.length - enc === 0 && filter !== 'plain' },
      ] : []),
    ], { active: filter });
    filterEl.hidden = filterEl.hidden || tab !== 'dbs' || !(split || filter !== 'all');
    setSearch($('#enc-search'), tab === 'dbs' ? all.length : dbKeys.length + deKeys.length, { query, filtered: tab === 'dbs' && filter !== 'all' });
    $('#enc-toolbar').hidden = tab === 'files' || (tab === 'keys' && !(dbKeys.length + deKeys.length)) || (tab === 'dbs' && !dbs.length);
  };

  const renderFoot = (): void => {
    const foot = $('#enc-foot');
    if (tab === 'dbs') {
      const enc = dbs.filter((d) => d.Encrypted).length;
      const total = dbs.reduce((s, d) => s + d.SizeMB, 0);
      foot.innerHTML = `<b>${num(dbs.length)}</b> database${dbs.length === 1 ? '' : 's'}<span class="meta-sep">·</span>${num(enc)} encrypted${total ? `<span class="meta-sep">·</span>${esc(dataSize(total))} in all` : ''}`;
    } else if (tab === 'keys') {
      foot.innerHTML = `<b>${num(dbKeys.length + deKeys.length)}</b> activated key${dbKeys.length + deKeys.length === 1 ? '' : 's'}<span class="meta-sep">·</span>${num(dbKeys.length)} for databases, ${num(deKeys.length)} for data elements`;
    } else {
      const n = knownFiles().length;
      const k = dbKeys.length + deKeys.length;
      foot.innerHTML = `<b>${num(n)}</b> key file${n === 1 ? '' : 's'} known${settings?.DBEncStartKeyFile ? '<span class="meta-sep">·</span>1 used at startup' : ''}<span class="meta-sep">·</span>${num(k)} key${k === 1 ? '' : 's'} activated`;
    }
  };

  // ── Detail: database ──
  const head = (kicker: string, title: string, state: string): string => `
    <header class="detail-head">
      <div class="detail-title"><span class="detail-kicker">${esc(kicker)}</span><h2 class="mono">${esc(title)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="enc-close"></ev-icon-button>
    </header>
    <div class="detail-state">${state}</div>`;

  const restartText = (d: DbEncryption): string => {
    if (!settings) return '';
    if (!d.Encrypted) return 'Nothing to activate: the database mounts as usual.';
    const when = d.MountRequired || d.MountAtStartup ? 'IRIS mounts it at startup' : 'It isn’t mounted at startup, so it’s mounted when someone asks';
    switch (settings.DBEncStartMode) {
      case 'None': return `No key is activated when IRIS starts, so after a restart this database can’t be read until someone activates key ${shortId(d.KeyId)} from its key file.`;
      case 'Interactive': return `IRIS asks for a key file and an administrator’s password as it starts. ${when} once the key is activated. On Windows, this can’t work when IRIS starts as a service.`;
      case 'Unattended': return `IRIS activates the keys in ${settings.DBEncStartKeyFile ? baseName(settings.DBEncStartKeyFile) : 'its startup key file'} by itself. ${when}, provided key ${shortId(d.KeyId)} is in that file.`;
      case 'KMIP': return `IRIS fetches its keys from the KMIP server ${settings.DBEncStartKMIPServer || ''} as it starts. ${when}, provided key ${shortId(d.KeyId)} is among them.`;
      default: return '';
    }
  };

  const renderJournalDetail = (): void => {
    if (!settings) { closeDetail(); return; }
    const on = settings.DBEncJournal;
    const jk = settings.DBEncJournalKeyID;
    detail.innerHTML = `${head('System data', JOURNAL_ROW, on ? chip('Encrypted', 'success') : chip('Not encrypted', 'neutral'))}
      <div class="detail-actions">${portalButton(cryptoPortal.databaseEncryption, 'Startup settings in Management Portal')}</div>
      ${para(on
        ? 'Journal files are written encrypted, so the changes they record can’t be read from a copy of the files without the key.'
        : 'Journal files record every change to journaled databases, including encrypted ones, and are written unencrypted.')}
      <dl class="kv-list">
        ${on && jk ? kv('Key', `${mono(shortId(jk))} ${activeIds().has(jk) ? chip('Activated', 'success') : chip('Not activated', 'danger')}`, jk) : ''}
        ${kv('Changed in', 'Startup settings')}
      </dl>
      ${para('Journal encryption is a startup setting and needs a key activated at startup. Keep the key file: it’s needed to restore from these journal files later.')}`;
  };

  const renderDbDetail = (name: string): void => {
    if (name === JOURNAL_ROW) { renderJournalDetail(); return; }
    const d = dbs.find((x) => x.Name === name);
    if (!d) { closeDetail(); return; }
    const active = activeIds().has(d.KeyId);
    const sys = SYSTEM_DBS[d.Name.toUpperCase()];
    const state = d.Encrypted
      ? `${chip('Encrypted', 'success')}${active ? '' : chip('Key not activated', 'danger')}`
      : chip('Not encrypted', 'neutral');
    detail.innerHTML = `${head('Database', d.Name, state)}
      <div class="detail-actions">${portalButton(cryptoPortal.database(d.Name), 'Open in Management Portal')}</div>
      <h3 class="detail-section">On disk</h3>
      ${para(d.Encrypted
        ? 'Everything IRIS writes to this database’s file is encrypted. A copy of the file, or a backup of it, can’t be read without the key.'
        : 'Stored unencrypted. Anyone who can read the database file, or a backup of it, can read the data.')}
      <dl class="kv-list">
        ${d.Encrypted ? kv('Key', `${mono(shortId(d.KeyId))} ${active ? chip('Activated', 'success') : chip('Not activated', 'danger')}`, d.KeyId) : ''}
        ${kv('Status', esc(d.Status))}
        ${kv('File location', mono(d.Directory), d.Directory)}
        ${d.Mirrored ? kv('Mirrored', 'Yes') : ''}
      </dl>
      ${d.Encrypted ? `<h3 class="detail-section">At the next restart</h3>${para(esc(restartText(d)))}` : ''}
      ${!d.Encrypted ? `<h3 class="detail-section">How to encrypt it</h3>${sys
        ? `${para(esc(sys))}<p class="kv-text">${portalButton(cryptoPortal.databaseEncryption, 'Startup settings in Management Portal')}</p>`
        : `${para('An existing database can’t be switched to encrypted from a web page. Either create a new encrypted database and copy the data across, or convert this one with the <span class="mono">^EncryptionKey</span> utility in the Terminal (Database encryption › Modify encrypted status). Both need an activated database key; back the database up first.')}
           <p class="kv-text">${docs(cryptoDocs.databases, 'Converting a database')}</p>`}` : ''}
      <h3 class="detail-section">Who can use it</h3>
      <dl class="kv-list">
        ${kv('Protected by', d.Resource ? `<button type="button" class="link mono" data-res="${esc(d.Resource)}">${esc(d.Resource)}</button>` : muted('—'))}
        ${kv('Who can change encryption', '<button type="button" class="link mono" data-res="%Admin_Secure">%Admin_Secure</button>')}
      </dl>
      ${para('Encryption protects the file on disk; who can read the data inside IRIS is still decided by the resource and the roles that grant it.')}`;
  };

  // ── Detail: key ──
  const renderKeyDetail = (id: string): void => {
    const k = keyRows().find((x) => x.Id === id);
    if (!k) { closeDetail(); return; }
    const used = k.Kind === 'database' ? usersOf(k.Id) : [];
    const mounted = used.filter((d) => /^Mounted/i.test(d.Status));
    const roles = [k.IsDefault ? chip('Default for new databases', 'info') : '', k.IsJournal ? chip('Journal files', 'info') : ''].join('');
    detail.innerHTML = `${head(k.Kind === 'database' ? 'Database encryption key' : 'Data-element encryption key', shortId(k.Id), `${chip('Activated', 'success')}${roles}`)}
      <div class="detail-actions">
        ${portalButton(k.Kind === 'database' ? cryptoPortal.databaseEncryption : cryptoPortal.dataElement, 'Manage in Management Portal')}
        ${moreButton('key-more')}
      </div>
      <dl class="kv-list">
        ${kv('Key ID', mono(k.Id), k.Id)}
        ${k.Bits ? kv('Length', `${k.Bits}-bit AES`) : ''}
      </dl>
      ${para(k.Kind === 'database'
        ? 'IRIS can read and write databases encrypted with it until it’s deactivated.'
        : 'Held in memory for applications that encrypt individual values with it. Each encrypted value records the key’s ID, so it can only be decrypted while this key is activated.')}
      ${k.Kind === 'database' ? `
        <h3 class="detail-section">Databases encrypted with it</h3>
        ${used.length ? `<ul class="enc-list">${used.map((d) => `<li><button type="button" class="link mono" data-db="${esc(d.Name)}">${esc(d.Name)}</button><span>${esc(/^Mounted/i.test(d.Status) ? 'Mounted' : d.Status)}</span></li>`).join('')}</ul>`
          : '<p class="enc-empty">None yet.</p>'}
        ${k.IsJournal ? para('Journal files are encrypted with this key, so it’s needed to restore from them.') : ''}` : ''}
      <h3 class="detail-section">Where it comes from</h3>
      ${para('A key file on disk. IRIS doesn’t remember which file once the key is activated. Keep copies of that file and its administrator passwords somewhere safe and apart from this server: a lost key can’t be re-created, and data encrypted with it is lost with it.')}`;
    const more = detail.querySelector<HTMLElement>('#key-more');
    if (more) {
      menu?.destroy();
      const reason = canSecure === false ? NO_PRIV
        : mounted.length ? `${mounted.map((d) => d.Name).join(', ')} ${mounted.length === 1 ? 'is' : 'are'} mounted with this key. Dismount ${mounted.length === 1 ? 'it' : 'them'} first.`
          : undefined;
      menu = moreMenu(more, [{
        label: 'Deactivate key', icon: 'x', danger: true, disabled: !!reason, reason,
        onSelect: () => void doDeactivate(k),
      }]);
    }
  };

  const renderDetail = (): void => {
    if (selected === null || tab === 'files') { setPanel(false); return; }
    if (tab === 'dbs') renderDbDetail(selected); else renderKeyDetail(selected);
    detail.querySelector('#enc-close')?.addEventListener('click', closeDetail);
    detail.querySelectorAll<HTMLElement>('[data-res]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/resources', b.dataset.res ?? '')));
    detail.querySelectorAll<HTMLElement>('[data-db]').forEach((b) => b.addEventListener('click', () => void showDatabase(b.dataset.db ?? '')));
    if (selected !== null) setPanel(true);
  };

  const selectTab = (next: Tab): void => {
    ctx.body.querySelectorAll<HTMLButtonElement>('#enc-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === next)));
    tab = next;
  };
  const showEncrypted = async (): Promise<void> => {
    if (!(await mayLeave())) return;
    selectTab('dbs');
    closeDetail();
    filter = 'enc'; filterEl.value = 'enc';
    render();
  };
  const showDatabase = async (name: string): Promise<void> => {
    if (!(await mayLeave())) return;
    selectTab('dbs');
    filter = 'all'; filterEl.value = 'all';
    selected = name;
    render();
  };

  // ── Key files tab ──
  const renderFiles = (): void => {
    const active = activeIds();
    let result = '';
    if (fileResult && 'error' in fileResult) {
      result = `<div class="sec-callout sec-callout--warning" role="alert"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>Couldn’t open ${esc(baseName(fileResult.path))}</strong><span>${esc(fileResult.error)}</span></div></div>`;
    } else if (fileResult) {
      const r = fileResult;
      result = `
        <div class="enc-file-card">
          <h3>Keys in ${esc(baseName(r.path))} (${num(r.keys.length)})</h3>
          ${r.keys.length ? `<ul class="enc-list">${r.keys.map((k) => `<li><span><span class="mono" title="${esc(k.Id)}">${esc(k.Id)}</span>${k.Description ? `<span class="enc-key-desc">${esc(k.Description)}</span>` : ''}</span>
            <span>${keyBits(Number(k.KeyLen)) ? `${keyBits(Number(k.KeyLen))}-bit · ` : ''}${active.has(k.Id) ? 'Activated' : 'Not activated'}</span></li>`).join('')}</ul>` : '<p class="enc-empty">This file holds no keys.</p>'}
        </div>
        <div class="enc-file-card">
          <h3>Administrators (${num(r.admins.length)})</h3>
          <p class="enc-empty">Each can activate any key in this file with their own password. They aren’t IRIS user accounts.</p>
          ${r.admins.length ? `<ul class="enc-list">${r.admins.map((a) => `<li><span class="mono">${esc(a)}</span><span></span></li>`).join('')}</ul>` : ''}
        </div>
        <div class="enc-file-actions">
          <button type="button" class="btn btn--sm" id="enc-file-activate"${blockedAttrs(canSecure === false ? NO_PRIV : '')}>Activate a key from this file</button>
          ${portalButton(cryptoPortal.manageKeyFile, 'Add or remove keys and administrators in Management Portal')}
        </div>`;
    }
    wrap.innerHTML = `
      <div class="enc-files">
        <p class="enc-files-intro">A <b>key file</b> holds up to 256 keys, each locked with the password of every administrator listed in it. IRIS doesn’t keep a list of key files, so enter the path of one on the IRIS server to see what’s inside. Nothing is activated or changed by looking.</p>
        <form class="enc-file-form" id="enc-file-form">
          ${pathField('path', 'Key file path', filePath, { mode: 'file', filters: ENCKEY, title: 'Choose the key file', placeholder: 'C:\\keys\\iris.key' })}
          <button type="submit" class="btn btn--sm" id="enc-file-open">Look inside</button>
        </form>
        ${settings?.DBEncStartKeyFile && settings.DBEncStartKeyFile !== filePath ? `<p class="enc-files-intro">IRIS activates keys from <button type="button" class="link mono" id="enc-file-startup">${esc(settings.DBEncStartKeyFile)}</button> at startup.</p>` : ''}
        ${result}
        <p class="enc-files-intro">${docs(cryptoDocs.keys, 'About keys and key files')} ${docs(cryptoDocs.protect, 'Protecting against key loss')}</p>
      </div>`;
    const pathEl = wrap.querySelector('ev-input[name="path"]') as HTMLElement & { value: string };
    wrap.querySelector('#enc-file-form')?.addEventListener('submit', (e) => { e.preventDefault(); void inspect(String(pathEl.value ?? '').trim()); });
    pathEl.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void inspect(String(pathEl.value ?? '').trim()); } });
    wrap.querySelector('#enc-file-startup')?.addEventListener('click', () => void inspect(settings?.DBEncStartKeyFile ?? ''));
    wrap.querySelector('#enc-file-activate')?.addEventListener('click', () => void openActivate(fileResult?.path ?? filePath));
  };

  const inspect = async (path: string): Promise<void> => {
    if (!path) return;
    filePath = path;
    const btn = wrap.querySelector('#enc-file-open') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      const [keys, admins] = await Promise.all([getKeysInFile(path), getFileAdmins(path)]);
      fileResult = { path, keys, admins: admins.map((a) => a.Name).filter(Boolean) };
      rememberFile(path);
    } catch (err) {
      fileResult = { path, error: errorText(err) };
    }
    if (!alive) return;
    if (tab === 'files') renderFiles();
    setHeader(); renderStrip(); renderToolbar(); renderFoot();
  };

  // ── Writes ──
  const openPanelEditor = (): void => {
    menu?.destroy(); menu = null;
    selected = null; grid?.select([]);
    setPanel(true);
    restoreWidth ??= panelWidth(panel, 520);
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
  };
  const afterEditor = (): void => { leaveEdit(); closeDetail(); };

  const openActivate = async (prefill: string): Promise<void> => {
    if (!(await mayLeave())) return;
    openPanelEditor();
    editor = editorShell(detail, {
      title: 'Activate a key',
      name: 'the key activation',
      submitLabel: 'Activate key',
      submitAlways: !!prefill,
      sections:
        section('Key file', pathField('File', 'Key file path', prefill, { required: true, mode: 'file', filters: ENCKEY, title: 'Choose the key file', placeholder: 'C:\\keys\\iris.key', hint: 'On the IRIS server. A name without a folder is looked for in the instance’s manager directory.' })) +
        section('What the key is for', selectField('Kind', 'Use it for', [
          { value: 'database', label: 'Databases, journal files and the audit log' },
          { value: 'data-element', label: 'Data-element encryption in applications' },
        ], 'database')) +
        section('Key administrator',
          textField('AdminName', 'Administrator name', '', { required: true, autocomplete: 'off' }) + passwordField('AdminPassword', 'Password', { required: true }),
          { hint: 'One of the administrators recorded in the key file. These are separate from IRIS user accounts.' }) +
        note(`Activating loads the key into memory; the key file isn’t changed. It stays activated until it’s deactivated or IRIS stops. To have it activated again after a restart, set the startup option in the Management Portal. <a href="${esc(cryptoPortal.databaseEncryption)}" target="_blank" rel="noopener">Database encryption ↗</a>`),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!String(v.File ?? '').trim()) out.push({ field: 'File', label: 'Key file path', message: 'Enter the path of the key file' });
        if (!String(v.AdminName ?? '').trim()) out.push({ field: 'AdminName', label: 'Administrator name', message: 'Enter an administrator named in the key file' });
        if (!v.AdminPassword) out.push({ field: 'AdminPassword', label: 'Password', message: 'Enter the administrator’s password' });
        return out;
      },
      onSubmit: async (v) => {
        const file = String(v.File).trim();
        const kind = (v.Kind === 'data-element' ? 'data-element' : 'database') as KeyKind;
        const ok = await confirm({
          title: `Activate a key from ${baseName(file)}?`,
          body: `<p>IRIS loads the key from <b class="mono">${esc(file)}</b> into memory and uses it for ${kind === 'database' ? 'databases encrypted with it, and for new encrypted databases, journal files or the audit log if it becomes their key' : 'data-element encryption by applications'}.</p><p>Type the file name to confirm.</p>`,
          confirmLabel: 'Activate key',
          typeToConfirm: baseName(file),
        });
        if (!ok) return;
        await activateKey(file, kind, String(v.AdminName).trim(), String(v.AdminPassword));
        afterEditor();
        await load();
        toast(`Key activated from ${baseName(file)}. It stays activated until IRIS restarts or it’s deactivated.`);
      },
      onCancel: () => afterEditor(),
    });
  };

  const openNewFile = async (): Promise<void> => {
    if (!(await mayLeave())) return;
    openPanelEditor();
    editor = editorShell(detail, {
      title: 'New key file',
      name: 'the new key file',
      submitLabel: 'Create key file',
      sections:
        section('Key file',
          pathField('File', 'Path for the new file', '', { required: true, mode: 'file', filters: ENCKEY, title: 'Choose a folder, then type the new file’s name', placeholder: 'C:\\keys\\iris.key', hint: 'On the IRIS server. A name without a folder goes in the manager directory. An existing file is never overwritten.' }) +
          textField('Description', 'Description of the first key', '', { placeholder: 'For example: Production databases, 2026' })) +
        section('Key', selectField('KeyLen', 'Key length', [
          { value: '256', label: '256-bit AES (recommended)' }, { value: '192', label: '192-bit AES' }, { value: '128', label: '128-bit AES' },
        ], '256')) +
        section('First administrator',
          textField('AdminName', 'Administrator name', '', { required: true, autocomplete: 'off', hint: 'Anyone with this name and password can activate the key. It isn’t an IRIS user account.' }) +
          passwordField('AdminPassword', 'Password', { required: true }) + passwordField('AdminPassword2', 'Confirm password', { required: true })) +
        note('<strong>Keep a copy of the key file and the administrator password somewhere safe, away from this server.</strong> Every key is unique and can’t be re-created: if both are lost, anything encrypted with it can never be read again.', true),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!String(v.File ?? '').trim()) out.push({ field: 'File', label: 'Path', message: 'Enter where to create the key file' });
        if (!String(v.AdminName ?? '').trim()) out.push({ field: 'AdminName', label: 'Administrator name', message: 'Enter an administrator name' });
        else if (/[^\x20-\x7e]/.test(String(v.AdminName))) out.push({ field: 'AdminName', label: 'Administrator name', message: 'Use plain letters, digits and punctuation only' });
        if (!v.AdminPassword) out.push({ field: 'AdminPassword', label: 'Password', message: 'Enter a password' });
        else if (!v.AdminPassword2) out.push({ field: 'AdminPassword2', label: 'Confirm password', message: 'Re-enter the password' });
        else if (v.AdminPassword !== v.AdminPassword2) out.push({ field: 'AdminPassword2', label: 'Confirm password', message: 'The passwords don’t match' });
        return out;
      },
      onSubmit: async (v) => {
        const file = String(v.File).trim();
        const bits = Number(v.KeyLen) as 128 | 192 | 256;
        const ok = await confirm({
          title: `Create ${baseName(file)}?`,
          body: `<p>IRIS creates <b class="mono">${esc(file)}</b> holding one new ${bits}-bit key, with <b>${esc(String(v.AdminName).trim())}</b> as its administrator. The key isn’t activated yet.</p><p>Type the file name to confirm.</p>`,
          confirmLabel: 'Create key file',
          typeToConfirm: baseName(file),
        });
        if (!ok) return;
        await createKeyFile(file, String(v.AdminName).trim(), String(v.AdminPassword), bits, String(v.Description ?? '').trim());
        afterEditor();
        toast(`Key file ${baseName(file)} created with one ${bits}-bit key. Back it up, then activate the key to use it.`);
        await inspect(file);
      },
      onCancel: () => afterEditor(),
    });
  };

  const doDeactivate = async (k: KeyRow): Promise<void> => {
    if (!(await mayLeave())) return;
    const used = usersOf(k.Id);
    const body = k.Kind === 'database'
      ? [
        used.length ? `<p>${used.map((d) => `<span class="mono">${esc(d.Name)}</span>`).join(', ')} ${used.length === 1 ? 'is' : 'are'} encrypted with it and can’t be mounted again until it’s reactivated.</p>` : '<p>No database is encrypted with it.</p>',
        k.IsDefault ? '<p>It’s the default key for new encrypted databases.</p>' : '',
        k.IsJournal ? '<p><strong>Journal files are encrypted with it.</strong> IRIS may refuse, or journaling may stop, until another key is set for journal files.</p>' : '',
        '<p>To use it again you need its key file and an administrator’s password.</p>',
      ].join('')
      : '<p>Applications that encrypt or decrypt values with this key will fail until it’s activated again from its key file.</p>';
    const ok = await confirm({
      title: `Deactivate key ${shortId(k.Id)}?`,
      body: `${body}<p>Type <b>deactivate</b> to confirm.</p>`,
      confirmLabel: 'Deactivate key',
      danger: true,
      typeToConfirm: 'deactivate',
    });
    if (!ok) return;
    try {
      await deactivateKey(k.Id, k.Kind);
    } catch (err) {
      toast(`Couldn’t deactivate the key. ${errorText(err)}`, 'danger');
      return;
    }
    closeDetail();
    await load();
    toast(`Key ${shortId(k.Id)} deactivated.`);
  };

  // ── Load and render ──
  /** Three facts above the tabs: databases encrypted, journal files, the key at startup. */
  const STARTUP_SHORT: Record<string, string> = { None: 'None', Interactive: 'Asked for', Unattended: 'Automatic', KMIP: 'From KMIP' };
  const renderStrip = (): void => {
    const el = $('#enc-strip');
    if (!settings) { el.hidden = true; return; }
    el.hidden = false;
    const enc = dbs.filter((d) => d.Encrypted).length;
    const jk = settings.DBEncJournalKeyID;
    const jOn = settings.DBEncJournal;
    const jWord = jOn ? (!jk || activeIds().has(jk) ? 'Encrypted' : 'Key not activated') : 'Not encrypted';
    const st = startupWords(settings);
    el.innerHTML = strip([
      { label: 'Databases encrypted', value: `${num(enc)} of ${num(dbs.length)}` },
      { label: 'Journal files', value: jWord, tone: jOn && jWord !== 'Encrypted' ? 'danger' : undefined, title: 'Journal files hold copies of every change to journaled databases' },
      { label: 'Key at startup', value: STARTUP_SHORT[settings.DBEncStartMode] ?? st.value, title: st.sub },
    ]);
  };

  const render = (): void => {
    renderStrip();
    if (!loaded) return;
    setHeader();
    renderRisks();
    renderToolbar();
    renderGrid();
    if (!editor) renderDetail();
    renderFoot();
  };

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  const load = async (): Promise<void> => {
    try {
      const [s, d, k, de] = await Promise.all([
        getEncryptionSettings(), getDatabaseEncryption(), getActivatedKeys(), getDataElementKeys().catch(() => []),
      ]);
      if (!alive) return;
      settings = s; dbs = d; dbKeys = k; deKeys = de;
      loaded = true;
      updated(new Date());
      render();
    } catch (err) {
      if (!alive) return;
      grid = null; gridTab = null;

      wrap.innerHTML = errorPanel(err, 'retry-enc');
      wrap.querySelector('#retry-enc')?.addEventListener('click', () => void load());
    }
  };

  bindViewTabs(ctx.body, 'enc-tabs', async (value) => {
    const next = value as Tab;
    if (next === tab) return;
    if (!(await mayLeave())) { selectTab(tab); return; }
    closeDetail();
    tab = next;
    query = '';
    ($('#enc-search') as HTMLElement & { value: string }).value = '';
    render();
  });
  $('#enc-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  filterEl.addEventListener('ev-segmented-button-change', (e) => {
    filter = (e as CustomEvent<{ value: DbFilter }>).detail.value;
    renderGrid();
  });

  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    if (loaded && !editor) { renderDetail(); if (tab === 'files') renderFiles(); }
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
}
