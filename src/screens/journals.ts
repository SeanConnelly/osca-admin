// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Journals — where IRIS records every change to journaled
 * databases, how much room that has, how long files are kept, and every
 * journal file still on disk.
 *
 * Actions (%Admin_Operate):
 *  - Switch journal file (header): closes the file in use and starts a new one.
 *  - Switch directory (the summary's Directory cell, typed confirmation): moves journaling between
 *    the primary and alternate directories.
 *  - Check integrity (file panel): reads a file and reports damage; read-only.
 * Both switches are built from the endpoint source and were never run against
 * the dev instance.
 *
 * Settings (%Admin_Manage): "Edit settings" (header only: the settings are instance-wide, not per
 * file) opens the journal settings form in the side
 * panel; it sends only what changed. Never saved against the dev instance.
 *
 * Addresses: #/operations/journals/<file> opens a file's panel, and
 * #/operations/journals/<file>/records its record browser (…/records/at/<address> with that record
 * selected, so Back from a full view lands on it), and
 * #/operations/journals/<file>/records/<address> one record's full view (<file>
 * is the file name without its directory, e.g. 20260926.001). Record values
 * never go in the address or the title.
 */
import '../styles-security.css';
import '../styles-disk.css';
import {
  getJournalSettings, getJournalFiles, getJournalFile, getDbConfigs, switchJournalFile, switchJournalDir, checkJournalFile,
  samePath, baseName, dirName, driveOf, bytesToMb, diskDocs, openSelected, saveJournalSettings, JOURNAL_LIMITS,
  type JournalSettings, type JournalSettingsPatch, type JournalFile, type JournalFileDetail, type DbConfigRow,
} from '../api-disk';
import { metrics, samples, type Snapshot } from '../metrics';
import { listJournalRecords, getJournalRecord, type JournalRecordRow, type JournalRecordDetail, type JournalRecordQuery } from '../api-disk';
import { objectDetail, odMeta, odSection, odKv, peekWidth, type OdFull } from '../ui';
import '../styles-ops.css';
import '../styles-journals.css';
import { plural, mono, cellRef,
  esc, chip, cell, skeleton, errorPanel, liveIndicator, num, dataSize, dataPct, when, irisDate, uniformKeys, emptyState, noPermissionText,
  type ScreenCtx, type Tone, type GridColumn,
} from '../ui';
import {
  confirm, toast, errorText, newButton, blockedAttrs, setBlocked, fieldError, AdminError, SubmitCancelled,
  editorShell, panelWidth, scrollPanelTop, section, textField, pathField, checkField, readForm,
  type EditorHandle, type FieldProblem,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const REFRESH_MS = 15_000;
const WARN = 85;
const CRIT = 95;
const NO_OPERATE = noPermissionText('%Admin_Operate', 'system operation');
const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');

interface Risk { tone: 'danger' | 'warning'; title: string; text: string }
interface DirSpace { free: number; pct: number }
interface Check { state: 'running' | 'ok' | 'failed'; at: Date; details: boolean; message?: string }

const band = (v: number): Tone => (!Number.isFinite(v) ? 'neutral' : v >= CRIT ? 'danger' : v >= WARN ? 'warning' : 'success');

/** Mid-sentence ("since today 00:00"): lowercase when()'s leading "Today" / "Yesterday" / "Tomorrow"; dates like "Sep 24" keep their capital. */
const lowerDay = (s: string): string => {
  const t = s.trimStart();
  return /^(today|yesterday|tomorrow)(?![a-z])/i.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
};

/** IRIS's switch reasons, as a sentence start. */
function reasonText(r: string): string {
  const s = String(r ?? '').trim();
  if (!s) return 'Not recorded';
  if (/task manager/i.test(s)) return 'Scheduled switch (Task Manager)';
  if (/start/i.test(s)) return 'IRIS started';
  if (/size|full|limit/i.test(s)) return 'Previous file reached its size limit';
  if (/user|operator|manual/i.test(s)) return 'Switched by someone';
  return s[0].toUpperCase() + s.slice(1);
}

/** The purge rule in words. */
function purgeWords(s: JournalSettings): { value: string; sub: string; tone: Tone } {
  const d = s.DaysBeforePurge;
  const b = s.BackupsBeforePurge;
  const days = plural(d, 'day');
  const backups = plural(b, 'backup');
  if (d > 0 && b > 0) return { value: `After ${days} or ${backups}`, sub: 'Whichever comes first. Files still needed by an open transaction are kept.', tone: 'neutral' };
  if (d > 0) return { value: `After ${days}`, sub: 'Files still needed by an open transaction are kept.', tone: 'neutral' };
  if (b > 0) return { value: `After ${backups}`, sub: 'Files are kept until that many backups have completed.', tone: 'neutral' };
  return { value: 'Never purged', sub: 'Journal files pile up until someone deletes them.', tone: 'warning' };
}

/**
 * A chart axis for sizes in MB: a round top at or above `topMb` (1, 2, 2.5 or 5 × a power of ten, in the
 * unit the top reads best in) and its half, as labels: { max: 50, label: "50 MB", mid: "25 MB" }.
 */
export function niceAxis(topMb: number): { max: number; label: string; mid: string } {
  const [unit, per] = topMb >= 1024 * 1024 ? ['TB', 1024 * 1024] : topMb >= 1024 ? ['GB', 1024] : ['MB', 1];
  const v = Math.max(topMb / per, 1e-3);
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * pow >= v - 1e-9) ?? 10;
  const max = step * pow;
  const fmt = (n: number): string => `${Number(n.toPrecision(3))} ${unit}`;
  return { max: max * per, label: fmt(max), mid: fmt(max / 2) };
}

// ── Global nodes: subscripts, middle truncation, differences ──

/** "^G" and its top-level subscripts, as written ("\"a\"", "1", "$c(0)"); null when it doesn't parse. */
export function splitNode(node: string): { name: string; subs: string[] } | null {
  const open = node.indexOf('(');
  if (open < 0) return node ? { name: node, subs: [] } : null;
  if (!node.endsWith(')')) return null;
  const body = node.slice(open + 1, -1);
  const subs: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') quoted = !quoted; // "" inside a string toggles twice
    else if (quoted) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { subs.push(body.slice(start, i)); start = i + 1; }
  }
  if (quoted || depth !== 0) return null;
  subs.push(body.slice(start));
  return { name: node.slice(0, open), subs };
}
const joinNode = (name: string, subs: string[]): string => (subs.length ? `${name}(${subs.join(',')})` : name);
/** Cut the middle out of a string: "abcd…wxyz". */
const midText = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const keep = Math.max(2, max - 1);
  return `${s.slice(0, Math.ceil(keep / 2))}…${s.slice(s.length - Math.floor(keep / 2))}`;
};
/** One subscript at most `max` characters, keeping its quotes: "\"9145…8607\"". */
const midSub = (s: string, max: number): string => {
  if (s.length <= max) return s;
  return s.length > 2 && s.startsWith('"') && s.endsWith('"') ? `"${midText(s.slice(1, -1), max - 2)}"` : midText(s, max);
};
/**
 * A global node in at most about `max` characters, cut in the middle: the global's name and the LAST
 * subscript stay whole where they can (they're what tells neighbouring nodes apart), earlier subscripts
 * are shortened in their middles first, then dropped for "…".
 */
export function midNode(node: string, max: number): string {
  if (node.length <= max) return node;
  const sp = splitNode(node);
  if (!sp || !sp.subs.length) return midText(node, max);
  const subs = sp.subs.slice();
  const len = (): number => joinNode(sp.name, subs).length;
  const last = subs.length - 1;
  for (let i = 0; i < last && len() > max; i++) subs[i] = midSub(subs[i], 12);
  if (len() > max && subs.length > 2) subs.splice(1, last - 1, '…');
  if (len() > max) subs[subs.length - 1] = midSub(subs[subs.length - 1], Math.max(12, max - (len() - subs[subs.length - 1].length)));
  if (len() > max && subs.length > 1) subs.splice(0, subs.length - 1, '…');
  const out = joinNode(sp.name, subs);
  return out.length > max ? midText(out, max) : out;
}
/**
 * Only what differs from `base` (another node of the same global): "(…,\"ListTask\")". Subscripts that
 * match base's at the same place become "…". Null when the nodes are the same; "" for the global itself.
 */
export function nodeDiff(node: string, base: string): string | null {
  if (node === base) return null;
  const a = splitNode(node);
  const b = splitNode(base);
  if (!a || !b || a.name !== b.name) return midNode(node, 60);
  const out: string[] = [];
  a.subs.forEach((s, i) => {
    const same = b.subs[i] === s;
    if (!same) out.push(midSub(s, 28));
    else if (out[out.length - 1] !== '…') out.push('…');
  });
  // Nothing of its own past base's (a parent of base): its subscripts, still without the global's name, as
  // every other row shows; the global itself (no subscripts) is "".
  if (out.every((s) => s === '…')) return a.subs.length ? `(${a.subs.map((s) => midSub(s, 28)).join(',')})` : '';
  return `(${out.join(',')})`;
}

/**
 * The record list last shown (rows hold no values), so Back to "<file>/records/at/<address>" puts back the
 * rows, filters, selection and scroll without reading the file again. In memory only.
 */
let recMemo: { file: string; rows: JournalRecordRow[]; end: boolean; global: string; pid: string; op: string; sig: string; scroll: number } | null = null;

export function journalsScreen(ctx: ScreenCtx): void {
  /**
   * The address this screen opened on (the file name without its directory): "<file>", "<file>/records",
   * "<file>/records/at/<address>" (the list with that record selected) or "<file>/records/<address>" (its full view).
   */
  const linked = ((): { file: string; records: boolean; address: number | null; at: number | null } | null => {
    const m = /^([^/]+?)(?:\/(records)(?:\/(at\/)?(\d+))?)?\/?$/i.exec(ctx.param ?? '');
    if (!m) return null;
    const n = m[4] ? Number(m[4]) : null;
    return { file: m[1], records: !!m[2], address: m[3] ? null : n, at: m[3] ? n : null };
  })();
  /** This screen's own address (#/operations/journals), for keeping the selected record in it. */
  const routeBase = `#/${location.hash.replace(/^#\/?/, '').split('/').slice(0, 2).join('/')}`;
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="jrn-main" id="jrn-main">
    <section class="disk-summary" aria-label="Journaling at a glance">
      <div id="jrn-facts">${skeleton(2)}</div>
    </section>
    <section class="card jrn-volume" id="jrn-volume" aria-label="Journal data over time" hidden></section>
    <div class="toolbar-row" id="jrn-toolbar">
      <div class="search-box"><ev-search id="jrn-search" size="sm" full-width placeholder="Filter by file name or date" aria-label="Filter journal files"></ev-search></div>
    </div>
    <ev-detail-panel id="jrn-panel" detail-width="380" overlay-below="960" class="workspace disk-workspace">
      <div class="grid-wrap" id="jrn-wrap">${skeleton(8)}</div>
      <aside slot="detail" class="detail od-detail" id="jrn-detail" aria-label="Journal file"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="jrn-foot"></p>
    </div>
    <div class="jrn-rec" id="jrn-rec" hidden>
      <div class="jrn-rec-list" id="jrn-rec-list">
        <div class="toolbar-row">
          <div class="search-box"><ev-search id="jrn-rec-global" size="sm" full-width placeholder="Global contains, e.g. ^Orders" aria-label="Filter by global"></ev-search></div>
          <ev-segmented-button id="jrn-rec-op" size="sm" aria-label="Operation"></ev-segmented-button>
          <ev-search id="jrn-rec-pid" size="sm" full-width placeholder="PID" aria-label="Filter by PID" class="jrn-rec-pid"></ev-search>
        </div>
        <ev-detail-panel id="jrn-rec-panel" overlay-below="960" class="workspace">
          <div class="grid-wrap" id="jrn-rec-wrap">${linked?.records ? skeleton(8) : ''}</div>
          <aside slot="detail" class="detail" id="jrn-rec-detail" aria-label="Journal record"></aside>
        </ev-detail-panel>
        <div class="jrn-rec-foot"><p class="table-foot" id="jrn-rec-count" aria-live="polite"></p><span class="jrn-rec-foot-actions"><button type="button" class="btn btn--sm" id="jrn-rec-stop" hidden>Stop</button><button type="button" class="btn btn--sm" id="jrn-rec-more" hidden>Load older</button></span></div>
      </div>
      <div id="jrn-rec-full" hidden></div>
    </div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#jrn-panel');
  const wrap = $('#jrn-wrap');
  const detail = $('#jrn-detail');

  let alive = true;
  ctx.onLeave(() => { alive = false; });
  let settings: JournalSettings | null = null;
  let files: JournalFile[] = [];
  let configs: DbConfigRow[] = [];
  let snap: Snapshot | null = null;
  let loaded = false;
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let canOperate = true;
  let canManage = true;
  let busy = false;
  /** The settings form, while it's open in the side panel. */
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const details = new Map<string, JournalFileDetail | { error: string }>();
  const checks = new Map<string, Check>();
  let shownHtml = '';
  let factsHtml = '';
  let rowSig = '';

  const current = (): JournalFile | undefined => files[0]; // newest first: the file being written
  /** A directory as configured in the journal settings (IRIS reports file paths lowercased on Windows). */
  const configured = (dir: string): string => {
    if (!settings) return dir;
    return [settings.CurrentDirectory, settings.AlternateDirectory].find((c) => c && samePath(c, dir)) ?? dir;
  };
  const fileDir = (name: string): string => configured(dirName(name));
  const currentDir = (): string => (current() ? fileDir(current()!.Name) : settings?.CurrentDirectory ?? '');
  const sameDirs = (): boolean => !!settings && (!settings.AlternateDirectory || samePath(settings.CurrentDirectory, settings.AlternateDirectory));
  const onAlternate = (): boolean => !!settings && !sameDirs() && !!current() && samePath(currentDir(), settings.AlternateDirectory);
  /**
   * A database directory's name. The journal can record a directory the database no longer lives in (it was
   * moved, e.g. IRISLOCALDATA to another drive): then a database whose name is the folder's own name. Else null.
   */
  const dbNameOf = (path: string): string | null => {
    const local = configs.filter((c) => !c.Server);
    const exact = local.find((c) => samePath(c.Directory, path));
    if (exact) return exact.Name;
    const leaf = baseName(path).toLowerCase();
    const byLeaf = local.filter((c) => c.Name.toLowerCase() === leaf);
    return byLeaf.length === 1 ? byLeaf[0].Name : null;
  };
  const dbName = (path: string): string => dbNameOf(path) ?? path;
  /** A directory with no database name, cut in the middle so its drive and last folder show: "c:\…\irislocaldata\". */
  const midPath = (path: string, max: number): string => {
    if (path.length <= max) return path;
    const sep = path.includes('\\') ? '\\' : '/';
    const parts = path.split(/[\\/]/);
    const trail = path.endsWith(sep) ? sep : '';
    const leaf = baseName(path);
    const out = `${parts[0]}${sep}…${sep}${leaf}${trail}`;
    return out.length <= max ? out : midText(path, max);
  };

  /** Free space (metrics) and how full the volume is, for a journal directory. */
  const space = (dir: string, id: 'primary' | 'secondary'): DirSpace => {
    if (!snap || !dir) return { free: NaN, pct: NaN };
    const js = samples(snap, 'iris_jrn_free_space');
    const s = js.find((x) => x.labels.dir && samePath(x.labels.dir, dir)) ?? js.find((x) => x.labels.id === id);
    const free = s ? s.value : NaN;
    // The volume's percentage full: a database directory on the same drive, or (Unix) with the same free space.
    const drive = driveOf(dir);
    const full = samples(snap, 'iris_disk_percent_full');
    const spaceOf = (d: string): number => samples(snap!, 'iris_directory_space').find((x) => x.labels.dir === d)?.value ?? NaN;
    const same = full.find((x) => (drive ? driveOf(x.labels.dir ?? '') === drive : Math.abs(spaceOf(x.labels.dir ?? '') - free) < 64));
    return { free, pct: same ? same.value : NaN };
  };
  const primary = (): DirSpace => space(settings?.CurrentDirectory ?? '', 'primary');
  const alternate = (): DirSpace => space(settings?.AlternateDirectory ?? '', 'secondary');
  const inUse = (): DirSpace => (onAlternate() ? alternate() : primary());

  // ── Risks ──
  const risks = (): Risk[] => {
    if (!settings) return [];
    const s = settings;
    const out: Risk[] = [];
    const use = inUse();
    const failNote = s.FreezeOnError
      ? 'IRIS freezes updates to journaled databases until space is freed.'
      : 'journaling stops, and changes made after that can’t be recovered after a crash.';
    const where = sameDirs() ? `There is no separate alternate directory, so ${failNote}` : `IRIS moves to the ${onAlternate() ? 'primary' : 'alternate'} directory; if that fails too, ${failNote}`;
    if (Number.isFinite(use.free) && use.free < s.FileSizeLimit * 2) {
      out.push({ tone: 'danger', title: `Room for fewer than two more journal files (${dataSize(use.free)} free)`,
        text: `Each file can grow to ${dataSize(s.FileSizeLimit)}. When the disk fills, ${where}` });
    } else if (Number.isFinite(use.pct) && use.pct >= WARN) {
      const drive = driveOf(currentDir());
      out.push({ tone: use.pct >= CRIT ? 'danger' : 'warning', title: `The journal disk${drive ? ` ${drive}` : ''} is ${dataPct(use.pct)} full`,
        text: `${dataSize(use.free)} is left. When it fills, ${where}` });
    }
    if (onAlternate()) {
      out.push({ tone: 'warning', title: 'Journaling has moved to the alternate directory',
        text: `IRIS is writing to ${s.AlternateDirectory}, not the primary ${s.CurrentDirectory}. This usually follows a problem with the primary; switch back once it’s fixed.` });
    }
    // No separate alternate directory: shown in the Directory cell of the summary, not as a notice.
    if (s.DaysBeforePurge <= 0 && s.BackupsBeforePurge <= 0) {
      out.push({ tone: 'warning', title: 'Journal files are never purged', text: 'They pile up until someone deletes them, and will eventually fill the disk.' });
    }
    return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
  };

  const renderBanner = (): void => {
    const list = risks();
    const top = list[0];
    if (!top) { ctx.banners.innerHTML = ''; return; }
    const rest = list.slice(1).map((r) => r.title);
    // One line: the headline; the explanation (and any further risks) on hover.
    const tip = `${top.text}${rest.length ? ` Also: ${rest.join('; ')}.` : ''}`;
    ctx.banners.innerHTML = `<div class="sec-callout sec-callout--${top.tone} sec-banner disk-notice" role="status" title="${esc(tip)}">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <div><strong>${esc(top.title)}${rest.length ? ` <span class="disk-notice-more">+${rest.length} more</span>` : ''}</strong></div>
    </div>`;
  };

  // ── Summary ──
  const renderFacts = (): void => {
    if (!settings) return;
    const s = settings;
    const cur = current();
    const p = primary();
    const a = alternate();
    const purge = purgeWords(s);
    const curMb = cur ? bytesToMb(cur.Size) : NaN;
    const use = onAlternate() ? a : p;
    const useDir = onAlternate() ? s.AlternateDirectory : s.CurrentDirectory;
    // Three cells: a value and one caption line each. Explanations live in the file panel and the help.
    // The directory's dot: disk fullness only (a healthy disk has none). A missing alternate directory is
    // flagged where it's named, in the caption.
    const dirTone = (p: number): Tone => { const t = band(p); return t === 'success' ? 'neutral' : t; };
    // The directory as a path, the same as everywhere else on the page.
    const where = `<span class="mono">${esc(useDir)}</span>`;
    // Moving between the primary and alternate directories: an operation on the directory, so it sits with it.
    const switchDir = !sameDirs() && canOperate
      ? ` · <button type="button" class="link jrn-cell-link" data-jrn-switch-dir${blockedAttrs(busy ? 'Working…' : null)}>Switch to ${onAlternate() ? 'primary' : 'alternate'}…</button>` : '';
    const cellHtml = (label: string, value: string, tone: Tone, caption: string, title = ''): string =>
      `<div class="jrn-cell" data-tone="${tone}"><span class="jrn-cell-label">${esc(label)}</span><span class="jrn-cell-value"${title ? ` title="${esc(title)}"` : ''}>${tone === 'neutral' ? '' : '<span class="jrn-fact-dot" aria-hidden="true"></span>'}<span>${esc(value)}</span></span><span class="jrn-cell-cap">${caption}</span></div>`;
    const html = `<div class="jrn-cells">
      ${cellHtml('Writing to', cur ? baseName(cur.Name) : 'No file', cur ? 'neutral' : 'warning',
        cur ? esc(`${dataSize(curMb)} of ${dataSize(s.FileSizeLimit)} · since ${lowerDay(when(irisDate(cur.CreationTime)))}`) : 'IRIS reports no journal file')}
      ${cellHtml(onAlternate() ? 'Free space · alternate directory' : 'Free space', Number.isFinite(use.free) ? dataSize(use.free) : 'Not known', dirTone(use.pct),
        `${where} · ${esc(Number.isFinite(use.pct) ? `${dataPct(use.pct)} full` : 'use not known')}${sameDirs() ? ' · <span class="jrn-warn" title="If this directory fills or its disk fails, IRIS has nowhere else to write. Set an alternate directory with Edit settings, ideally on another disk.">No alternate directory</span>' : switchDir}`, useDir)}
      ${cellHtml('Purged', purge.value, purge.tone, esc(s.CompressFiles ? 'Closed files are compressed' : 'Closed files are kept uncompressed'))}
    </div>`;
    // Redraw only on change, so focus on "Switch to …" survives the live refresh.
    if (html === factsHtml) return;
    factsHtml = html;
    $('#jrn-facts').innerHTML = html;
    $('#jrn-facts').querySelector('[data-jrn-switch-dir]')?.addEventListener('click', (e) => { if (!(e.currentTarget as HTMLElement).hasAttribute('data-crud-blocked')) void doSwitchDir(); });
  };

  // ── Grid ──
  const COLUMNS: GridColumn[] = [
    // The file name is the row's identity: mono, full contrast (cellId would render "20260926.001" as a dimmer number).
    { key: 'File', label: 'File', width: '170px', sortable: true,
      renderCell: (v) => `<span style="white-space:nowrap;font-family:var(--ev-font-family-mono, monospace);font-weight:var(--mono-weight, 400);color:var(--ev-color-text-primary)">${esc(v)}</span>` },
    { key: 'InUse', label: 'State', width: '110px', sortable: true, renderCell: (v) => (Number(v) === 0 ? chip('In use', 'success') : cell.dim('Closed')) },
    { key: 'Created', label: 'Started', width: '150px', sortable: true, renderCell: (_v, row) => cell.num(when(new Date(Number(row.Created)))) },
    { key: 'Reason', label: 'Why it started', sortable: true, description: 'What made IRIS start this file' },
    { key: 'Data', label: 'Journal data', width: '120px', sortable: true, align: 'right',
      description: 'Journal data written to the file, before compression', renderCell: (v) => (Number(v) > 0 ? cell.num(dataSize(bytesToMb(Number(v)))) : cell.dim('—')) },
    { key: 'Size', label: 'Size on disk', width: '110px', sortable: true, align: 'right',
      description: 'Closed files are smaller when IRIS compresses them', renderCell: (v) => cell.num(dataSize(bytesToMb(Number(v)))) },
    { key: 'Dbs', label: 'Databases', width: '100px', sortable: true, align: 'right',
      description: 'Databases with changes in the file', renderCell: (v) => (Number(v) >= 0 ? cell.num(num(Number(v))) : cell.dim('—')) },
    { key: 'Dir', label: 'Directory', width: '300px', renderCell: (v) => cellRef(v, undefined, String(v)) },
  ];
  const SECONDARY = ['Reason', 'Data', 'Dbs', 'Dir'];
  let uniform = new Set<string>();

  const toRow = (f: JournalFile, i: number): DataGridRow => ({
    Name: f.Name, File: baseName(f.Name), InUse: i === 0 ? 0 : 1, Created: irisDate(f.CreationTime).getTime(),
    Reason: reasonText(f.Reason), Data: f.DataSize, Size: f.Size, Dir: fileDir(f.Name), Dbs: dbCount(f.Name),
  });
  /** Databases changed in a file, from its details (-1 until they're read). */
  const dbCount = (name: string): number => {
    const d = details.get(name);
    return d && !('error' in d) ? d.Databases.length : -1;
  };
  /** Read the details of files not read yet (the Databases column), a few at a time; newest first, at most 60 files. */
  let detailsBusy = false;
  const fillDetails = async (): Promise<void> => {
    if (detailsBusy) return;
    detailsBusy = true;
    try {
      // The file in use keeps changing, so it's read again each time.
      const todo = files.slice(0, 60).filter((f, i) => i === 0 || !details.has(f.Name));
      for (let i = 0; i < todo.length && alive; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map((f) => getJournalFile(f.Name).then((d) => { details.set(f.Name, d); }, () => { /* the column shows — */ })));
        if (alive && loaded) renderGrid();
      }
    } finally { detailsBusy = false; }
  };
  const matches = (r: DataGridRow): boolean => {
    if (!query) return true;
    const ql = query.toLowerCase();
    return [r.File, r.Dir, r.Reason, when(new Date(Number(r.Created)))].some((x) => String(x).toLowerCase().includes(ql));
  };
  const applyColumns = (): void => {
    if (!grid) return;
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  /** The side panel's width now (the peek's), or the standard peek width when it's shut. */
  const panelNow = (): number => {
    const w = (panel as HTMLElement & { detailWidth?: number }).detailWidth;
    return panel.open && w ? w : peekWidth(panel);
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => {
    selected = null; shownHtml = ''; grid?.select([]); syncParam(); renderVolume();
    if (!editor) setPanel(false); // the settings form keeps the panel
  };

  const renderGrid = (): void => {
    if (!files.length) {
      grid = null; rowSig = '';
      $('#jrn-toolbar').hidden = true;
      closeDetail();
      wrap.innerHTML = emptyState({
        icon: 'file-text', title: 'No journal files',
        what: 'IRIS reports no journal files, so changes to databases aren’t being recorded for recovery.',
        why: 'Journaling lets IRIS recover recent changes after a crash and restore a backup up to the minute.',
        docs: { href: diskDocs.journaling, label: 'About journaling' },
      });
      return;
    }
    $('#jrn-toolbar').hidden = files.length <= 12 && !query; // a short list needs no search box
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Created');
      grid.setAttribute('sort-direction', 'desc');
      grid.setAttribute('aria-label', 'Journal files');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        void (async () => {
          // The settings form asks before it gives the panel up.
          if (editor) {
            if (!(await editor.guard())) { grid?.select(selected !== null ? [selected] : []); return; }
            leaveEditor();
          }
          selected = name;
          shownHtml = '';
          syncParam();
          renderVolume();
          void renderDetail(true);
        })();
      });
      wrap.appendChild(grid);
    }
    const all = files.map(toRow);
    uniform = all.length < 2 ? new Set<string>() : (uniformKeys(all, ['Dir']) as Set<string>);
    const rows = all.filter(matches);
    const sig = JSON.stringify(rows);
    if (sig !== rowSig) { rowSig = sig; grid.rows = rows; }
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.disk-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="disk-empty">${emptyState({
        icon: 'search', title: `No journal file matches “${query}”`, what: 'Try a file name such as 20260926 or a day such as Yesterday.',
        action: '<button type="button" class="btn btn--sm" data-jrn-clear>Show all files</button>',
      })}</div>`);
      wrap.querySelector('[data-jrn-clear]')?.addEventListener('click', () => {
        query = ''; ($('#jrn-search') as HTMLElement & { value: string }).value = ''; renderGrid();
      });
    }
  };

  const renderFoot = (): void => {
    const total = files.reduce((a, f) => a + bytesToMb(f.Size), 0);
    const oldest = files[files.length - 1];
    const sep = '<span class="meta-sep">·</span>';
    $('#jrn-foot').innerHTML = files.length
      ? `<b>${num(files.length)}</b> file${files.length === 1 ? '' : 's'}${sep}${dataSize(total)}${sep}oldest ${esc(irisDate(oldest.CreationTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}`
      : '';
  };

  /**
   * Journal data over time: one bar per file, from when it started to when the next one did (the file in
   * use runs to now), as tall as the journal data written to it. Click a bar to open that file.
   */
  let volSig = '';
  const renderVolume = (): void => {
    const host = $('#jrn-volume');
    const chrono = [...files].reverse();
    if (chrono.length < 2) { host.hidden = true; host.innerHTML = ''; volSig = ''; return; }
    host.hidden = false;
    const now = Date.now();
    const spans = chrono.map((f, i) => {
      const start = irisDate(f.CreationTime).getTime();
      const end = i < chrono.length - 1 ? irisDate(chrono[i + 1].CreationTime).getTime() : now;
      return { f, start, end: Math.max(end, start), mb: bytesToMb(f.DataSize > 0 ? f.DataSize : f.Size), current: i === chrono.length - 1 };
    });
    const t0 = spans[0].start;
    const t1 = Math.max(now, t0 + 1);
    const x = (t: number): number => ((t - t0) / (t1 - t0)) * 100;
    const axis = niceAxis(Math.max(...spans.map((s) => s.mb), 0.001));
    const top = axis.max;
    const cur = spans[spans.length - 1];
    const hours = (cur.end - cur.start) / 3_600_000;
    const rate = hours > 0.05 ? `Writing about ${dataSize(cur.mb / hours)} an hour` : '';
    // Midnights inside the range, at most ~10 labelled.
    const days: number[] = [];
    const d = new Date(t0); d.setHours(24, 0, 0, 0);
    for (; d.getTime() < t1 && days.length < 400; d.setDate(d.getDate() + 1)) days.push(d.getTime());
    const every = Math.max(1, Math.ceil(days.length / 10));
    const dayHtml = days.map((t, i) => `<span class="jrn-vol-day" style="left:${x(t).toFixed(3)}%">${i % every === 0
      ? `<b>${esc(new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</b>` : ''}</span>`).join('');
    const bars = spans.map((s, i) => {
      const name = baseName(s.f.Name);
      const tip = `${name}${s.current ? ' (in use)' : ''} · ${dataSize(s.mb)} of journal data · ${when(new Date(s.start))} to ${s.current ? 'now' : lowerDay(when(new Date(s.end)))}`;
      return `<button type="button" class="jrn-vol-bar" data-file="${esc(s.f.Name)}" data-i="${i}" aria-pressed="${selected === s.f.Name}"
        style="left:calc(${x(s.start).toFixed(3)}% + 1px);width:max(3px, calc(${(x(s.end) - x(s.start)).toFixed(3)}% - 2px));height:max(2px, ${((s.mb / top) * 100).toFixed(2)}%)"
        aria-label="${esc(tip)}"></button>`;
    }).join('');
    // The y axis: each label centred on its line (0 on the baseline), a gridline at the top and the middle.
    const html = `<header class="card-head"><h2>Journal data over time</h2>${rate ? `<span class="jrn-vol-note">${esc(rate)}</span>` : ''}</header>
      <div class="jrn-vol">
        <div class="jrn-vol-y" aria-hidden="true"><span class="jrn-vol-y-size">${esc(axis.label)}</span>
          <span style="top:0">${esc(axis.label)}</span><span style="top:50%">${esc(axis.mid)}</span><span style="top:100%">0</span></div>
        <div class="jrn-vol-plot">
          <span class="jrn-vol-grid" style="top:0" aria-hidden="true"></span><span class="jrn-vol-grid" style="top:50%" aria-hidden="true"></span>
          ${dayHtml}
          <div class="jrn-vol-bars" role="group" aria-label="Journal files by time">${bars}</div>
          <div class="jrn-vol-tip" id="jrn-vol-tip" role="presentation" hidden></div>
        </div>
      </div>`;
    if (html === volSig) return;
    volSig = html;
    host.innerHTML = html;
    // A small card beside the hovered (or focused) bar: file, size, when it started, why.
    const tipEl = host.querySelector<HTMLElement>('#jrn-vol-tip')!;
    const plotEl = host.querySelector<HTMLElement>('.jrn-vol-plot')!;
    const showTip = (b: HTMLElement): void => {
      const s = spans[Number(b.dataset.i)];
      if (!s) return;
      tipEl.innerHTML = `<b class="mono">${esc(baseName(s.f.Name))}</b>${s.current ? ' <span class="jrn-vol-tip-dim">· in use</span>' : ''}
        <span>${esc(dataSize(s.mb))} of journal data</span>
        <span class="jrn-vol-tip-dim">Started ${esc(lowerDay(when(new Date(s.start))))}</span>
        <span class="jrn-vol-tip-dim">${esc(reasonText(s.f.Reason))}</span>`;
      tipEl.hidden = false;
      const pw = plotEl.clientWidth;
      const bl = b.offsetLeft;
      const br = bl + b.offsetWidth;
      const tw = tipEl.offsetWidth;
      // Right of the bar where it fits, else left of it; never outside the plot.
      const left = br + 8 + tw <= pw ? br + 8 : Math.max(0, bl - 8 - tw);
      tipEl.style.left = `${left}px`;
    };
    const hideTip = (): void => { tipEl.hidden = true; };
    host.querySelectorAll<HTMLElement>('.jrn-vol-bar').forEach((b) => {
      b.addEventListener('mouseenter', () => showTip(b));
      b.addEventListener('focus', () => showTip(b));
      b.addEventListener('mouseleave', hideTip);
      b.addEventListener('blur', hideTip);
    });
    host.querySelectorAll<HTMLElement>('.jrn-vol-bar').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.file ?? '';
      void (async () => {
        if (editor) {
          if (!(await editor.guard())) return;
          leaveEditor();
        }
        selected = name;
        shownHtml = '';
        syncParam();
        renderGrid();
        renderVolume();
        void renderDetail(true);
      })();
    }));
  };

  // ── Detail ──
  const checkLine = (name: string): string => {
    const c = checks.get(name);
    if (!c) return '<p class="jrn-check" id="jrn-check">Not checked in this session.</p>';
    if (c.state === 'running') return `<p class="jrn-check" id="jrn-check" role="status"><ev-spinner size="sm"></ev-spinner>Reading every record…</p>`;
    if (c.state === 'ok') return `<p class="jrn-check" id="jrn-check" data-tone="success" role="status"><ev-icon name="check" size="xs"></ev-icon>No problems found<span class="dim">· ${esc(when(c.at))}</span></p>`;
    return `<p class="jrn-check" id="jrn-check" data-tone="danger" role="alert"><ev-icon name="alert-triangle" size="xs"></ev-icon>${esc(c.message ?? 'IRIS found a problem.')}</p>`;
  };

  const renderDetail = async (fetch = false): Promise<void> => {
    if (editor) return; // the settings form owns the panel until it closes
    const idx = files.findIndex((f) => f.Name === selected);
    const f = files[idx];
    if (!f) { closeDetail(); return; }
    const isCur = idx === 0;
    if (fetch || !details.has(f.Name)) {
      getJournalFile(f.Name).then((d) => { details.set(f.Name, d); if (alive && selected === f.Name) void renderDetail(); },
        (err: unknown) => { details.set(f.Name, { error: errorText(err) }); if (alive && selected === f.Name) void renderDetail(); });
    }
    const d = details.get(f.Name);
    const det = d && !('error' in d) ? d : null;
    const compressed = !isCur && f.DataSize > 0 && f.Size < f.DataSize * 0.9;
    const running = checks.get(f.Name)?.state === 'running';
    const blocked = !canOperate ? NO_OPERATE : running ? 'Checking…' : null;
    const dbs = det ? det.Databases.map((x) => dbName(x.DatabasePathOrAlias)).sort() : [];
    const fileLink = (file: JournalFile): string => `<button type="button" class="link mono" data-file="${esc(file.Name)}">${esc(baseName(file.Name))}</button>`;
    // The files either side of this one in the list (newest first): what IRIS links, or else what's on disk.
    const newer = files[idx - 1];
    const older = files[idx + 1];
    const restarted = (file: JournalFile | undefined): boolean => !!file && reasonText(file.Reason) === 'IRIS started';
    const neighbour = (named: string | undefined, listed: JournalFile | undefined, label: string, which: 'previous' | 'next'): Array<[string, string, string?]> => {
      if (named) {
        const known = files.find((x) => samePath(x.Name, named));
        return [[label, known ? fileLink(known) : `${mono(baseName(named))} <span class="dim">· no longer on disk</span>`]];
      }
      if (which === 'next' && isCur) return [[label, '<span class="dim">None yet: IRIS is writing this file</span>']];
      if (!listed) return [[label, '<span class="dim">None on disk</span>']];
      // IRIS starts a new chain when it starts: the files aren't linked, but they follow on.
      const broke = restarted(which === 'next' ? listed : f);
      return [[label, broke ? `<span class="dim">IRIS restarted; the ${which} file is</span> ${fileLink(listed)}` : fileLink(listed),
        broke ? `IRIS restarted between these files, so the journal doesn’t link them. The ${which} file on disk is ${baseName(listed.Name)}.` : '']];
    };
    const title = baseName(f.Name);
    const facts = [compressed ? 'Compressed' : '', det?.EncryptionKeyID ? 'Encrypted' : ''];
    // The same anatomy as every other peek (objectDetail): a sticky two-row header, then sections.
    const html = `<div class="od-shell">
      <header class="od-head">
        <h2 class="od-title od-title--mono" title="${esc(title)}">${esc(title)}</h2>
        <div class="od-head-actions">
          <button type="button" class="btn btn--sm od-primary" id="jrn-records">Browse records</button>
          <span class="od-vsep" aria-hidden="true"></span>
          <ev-icon-button icon="x" label="Close" title="Close" id="jrn-close"></ev-icon-button>
        </div>
        <div class="od-meta">${odMeta(isCur ? { label: 'In use', tone: 'success' } : { label: 'Closed', tone: 'neutral' }, [`Started ${lowerDay(when(irisDate(f.CreationTime)))}`, ...facts])}</div>
      </header></div>
      <div class="od-body">
      ${odSection('File', odKv([
        ['Directory', mono(fileDir(f.Name)), fileDir(f.Name)],
        ['Why it started', esc(reasonText(f.Reason))],
        ['Size on disk', esc(dataSize(bytesToMb(f.Size)))],
        ...(det ? [['Journal data', `${esc(dataSize(bytesToMb(f.DataSize > 0 ? f.DataSize : det.End)))}${isCur && det.MaxSize ? ` <span class="dim">· switches at ${esc(dataSize(bytesToMb(det.MaxSize)))}</span>` : ''}`] as [string, string]] : []),
        ...(det?.EncryptionKeyID ? [['Encryption key', mono(det.EncryptionKeyID), det.EncryptionKeyID] as [string, string, string]] : []),
      ]))}
      ${odSection('Before and after', det
        ? odKv([...neighbour(det.PrevFile?.File, older, 'Previous file', 'previous'), ...neighbour(det.NextFile?.File, newer, 'Next file', 'next')] as Array<[string, string, string]>)
        : odKv([['Previous · next', d ? '<span class="dim">Not available</span>' : '<span class="dim">—</span>']]))}
      ${odSection('Databases with changes in it', det ? (dbs.length ? `<ul class="disk-list">${dbs.map((n) => `<li><button type="button" class="link mono" data-db="${esc(n)}">${esc(n)}</button><span></span></li>`).join('')}</ul>` : '<p class="disk-none">—</p>')
        : `<p class="disk-none">${d && 'error' in d ? esc(d.error) : '—'}</p>`)}
      ${odSection('Integrity', `<div class="detail-actions jrn-check-actions"><button type="button" class="btn btn--sm" id="jrn-check-run"${blockedAttrs(blocked)}>Check integrity</button></div>
        ${!canOperate ? `<p class="detail-note">${esc(NO_OPERATE)}</p>` : isCur ? '<p class="detail-note">IRIS is still writing this file, so a check sees it as it is right now.</p>' : ''}
        ${checkLine(f.Name)}`)}
      </div>`;
    setPanel(true);
    if (html === shownHtml) return;
    shownHtml = html;
    detail.innerHTML = html;
    detail.querySelector('#jrn-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#jrn-check-run')?.addEventListener('click', () => void runCheck(f));
    detail.querySelector('#jrn-records')?.addEventListener('click', () => openRecords(f.Name));
    detail.querySelectorAll<HTMLElement>('[data-file]').forEach((b) => b.addEventListener('click', () => {
      selected = b.dataset.file ?? null;
      syncParam();
      query = ''; ($('#jrn-search') as HTMLElement & { value: string }).value = '';
      renderGrid();
      renderVolume();
      void renderDetail(true);
    }));
    detail.querySelectorAll<HTMLElement>('[data-db]').forEach((b) => b.addEventListener('click', () => openSelected(ctx.navigate, 'databases/databases', b.dataset.db ?? '')));
  };

  // ── Records: a page at a time from IRIS, newest first; values only in the record peek, masked ──
  const recEl = $('#jrn-rec');
  const mainEl = $('#jrn-main');
  let recFile = '';
  let recRows: JournalRecordRow[] = [];
  let recEnd = false;
  let recBusy = false;
  let recGen = 0;
  let recGlobal = '';
  let recPid = '';
  let recOp = 'all';
  let recGrid: GridEl | null = null;
  let savedHead: { title: string; sub: string } | null = null;
  let recError = '';
  const REC_PAGE = 200;
  /** Reading ahead for a filter: pages read in this search, and whether the user stopped it. */
  const SCAN_PAGES = 5;
  const SCAN_WANT = 25;
  let recScan = 0;
  let recStopped = false;
  /** The server-side filter the loaded rows were read with. */
  let recMatchSig = '';
  /** A record opened from its address that isn't in the loaded rows (a link or reload). */
  const recExtra = new Map<string, JournalRecordRow>();
  /** The open record and its values (kept only while that record is shown), and which values are revealed. */
  let recShown: { address: number; d: JournalRecordDetail } | null = null;
  const recReveal = new Set<'old' | 'new'>();

  /** Where the list was scrolled, and whether to put it back when the list shows again (after a full view). */
  let recScrollTop = 0;
  let recScrollBack = false;
  /** A record to select once the first page is in (a link or Back to "<file>/records/at/<address>"). */
  let recPendingAt: string | null = null;

  /** The record browser's address: a record's full view, or the list with its selected record. Never a value. */
  const recParam = (): string => {
    const sel = recOd.selected();
    const full = recOd.mode() === 'full' ? sel : null;
    return `${baseName(recFile)}/records${full ? `/${full}` : sel ? `/at/${sel}` : ''}`;
  };
  /** The list's selection goes in the address without a new history entry, so Back returns to it. */
  const replaceParam = (p: string): void => {
    if (!alive || !(location.hash === routeBase || location.hash.startsWith(`${routeBase}/`))) return;
    const h = `${routeBase}/${p.split('/').map(encodeURIComponent).join('/')}`;
    if (h !== location.hash) history.replaceState(null, '', h);
  };
  /** Keep the address on what's showing: the record browser, a file's panel, or the list. Values never go in it. */
  const syncParam = (): void => {
    if (!alive) return;
    const recOpen = !recEl.hidden;
    const file = recOpen ? recFile : selected;
    ctx.setParam?.(file ? (recOpen ? recParam() : baseName(file)) : null);
  };
  /** The element that scrolls the record list: the grid itself once it windows its rows, else its frame. */
  const recScroller = (): HTMLElement | null => (recGrid?.hasAttribute('virtualized') ? recGrid : $('#jrn-rec-wrap'));
  const restoreScroll = (top: number): void => {
    const put = (): void => { const el = recScroller(); if (el && !recEl.hidden) el.scrollTop = top; };
    requestAnimationFrame(() => requestAnimationFrame(put));
    setTimeout(put, 150); // also when frames are held back (a background tab)
  };
  /** Bring a record's row into view (a record opened from a link, with no scroll position to go back to). */
  const scrollToRecord = (key: string): void => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = recScroller();
      const i = recGroups().findIndex((g) => g.key === rowKeyOf(key));
      if (!el || i < 0) return;
      const tr = (recGrid?.querySelector('tbody tr') ?? recGrid?.shadowRoot?.querySelector('tbody tr')) as HTMLElement | null | undefined;
      const h = tr?.offsetHeight || 28;
      const top = i * h;
      if (top < el.scrollTop || top + h > el.scrollTop + el.clientHeight - h) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }));
  };
  /** Back from a full view: keyboard focus on the record's row (once the scroll is put back), not on the page. */
  const focusRecRow = (key: string): void => {
    const put = (): boolean => {
      if (recEl.hidden || recOd.mode() !== 'list') return true;
      const td = recGrid?.shadowRoot?.querySelector<HTMLElement>(`td[data-row-key="${CSS.escape(key)}"]`);
      if (!td) return false;
      td.focus({ preventScroll: true });
      return true;
    };
    setTimeout(() => { if (!put()) { scrollToRecord(key); setTimeout(put, 120); } }, 200);
  };
  $('#jrn-rec-wrap').addEventListener('scroll', (e) => {
    if (recEl.hidden || $('#jrn-rec-list').hidden) return;
    const t = e.target as HTMLElement;
    if (t === recScroller()) recScrollTop = t.scrollTop;
  }, true);

  const opOf = (r: JournalRecordRow): string => r.ExtTypeName || r.TypeName;
  /**
   * An operation in words, sentence case throughout: IRIS's "BeginTrans" is "Begin transaction", "SET" is
   * "Set", "BitSET" is "Bit set".
   */
  const OP_WORDS: Array<[RegExp, string]> = [
    [/^(BeginTrans|TStart)\b/i, 'Begin transaction'], [/^(CommitTrans|TCommit)\b/i, 'Commit transaction'],
    [/^(RollbackTrans|TRollback)\b/i, 'Roll back transaction'], [/^JrnEnd$/i, 'End of journal'],
    [/^NetReq$/i, 'Network request'], [/^JrnMark$/i, 'Journal marker'],
    [/^BitSET$/i, 'Bit set'], [/^(Vector|vec)SET$/i, 'Vector set'], [/^(Vector|vec)KILL$/i, 'Vector kill'],
    [/^KILLdes$/i, 'Kill descendants'], [/^ZKILL$/i, 'ZKill'],
  ];
  const opWords = (op: string): string => {
    const hit = OP_WORDS.find(([re]) => re.test(op));
    if (hit) return op.replace(hit[0], hit[1]);
    // Anything else: split "wordWORD" runs, lowercase capitalised words (not "$I"-style functions), capitalise the first.
    const s = op.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/(^|[^$\w])([A-Za-z]{2,})/g, (_m, pre: string, w: string) => pre + w.toLowerCase()).trim();
    return s ? s[0].toUpperCase() + s.slice(1) : op;
  };
  const opLabel = (r: JournalRecordRow): string => opWords(opOf(r));
  const opGroup = (r: JournalRecordRow): string => (/KILL/i.test(r.TypeName) ? 'kill' : /SET/i.test(r.TypeName) ? 'set' : /Trans|^T(Start|Commit|Rollback)/i.test(r.TypeName) ? 'txn' : 'other');
  const recVisible = (): JournalRecordRow[] => recRows.filter((r) =>
    (recOp === 'all' || opGroup(r) === recOp)
    && (!recGlobal || r.GlobalNode.toLowerCase().includes(recGlobal.toLowerCase()))
    && (!recPid || String(r.ProcessID) === recPid));
  /**
   * Rows: identical consecutive records (same operation, node, process, database and transaction state)
   * fold into one, "· repeated 11×", as the Messages log folds repeated lines. A row is keyed on its
   * NEWEST record: older pages add to the bottom, so a row's key holds as more is read. The peek lists
   * every record in a fold.
   */
  interface RecGroup { key: string; head: JournalRecordRow; members: JournalRecordRow[] }
  const sameRec = (a: JournalRecordRow, b: JournalRecordRow): boolean => opOf(a) === opOf(b) && a.GlobalNode === b.GlobalNode
    && a.ProcessID === b.ProcessID && a.DatabaseName === b.DatabaseName && a.InTransaction === b.InTransaction;
  const recGroups = (): RecGroup[] => {
    const out: RecGroup[] = [];
    for (const r of recVisible()) {
      const g = out[out.length - 1];
      if (g && sameRec(g.head, r)) g.members.push(r);
      else out.push({ key: String(r.Address), head: r, members: [r] });
    }
    return out;
  };
  /** The row a record is folded into (its own key when it isn't folded or isn't shown). */
  const rowKeyOf = (addr: string): string => recGroups().find((g) => g.members.some((m) => String(m.Address) === addr))?.key ?? addr;
  const groupOf = (key: string): RecGroup | undefined => recGroups().find((g) => g.key === key);

  /**
   * Fixed columns (as the Messages log): the grid's table layout is auto, so each cell's content box is
   * set to exactly its column's width less the cell's padding; filtering, folding and the peek never move
   * them. The global node takes what's left, and gives way first when the peek opens.
   */
  const RW = { time: 132, pid: 72, op: 150, db: 180 };
  const fitR = (px: number, html: string, style = ''): string => `<span style="display:block;width:${px - 16}px;overflow:hidden;${style}">${html}</span>`;
  const TXT = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  /** The time of day with seconds (the journal records no finer time). */
  const clock = (d: Date): string => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  /** "Today", "Yesterday" or "Sep 26": when()'s day without its time. */
  const dayWord = (d: Date): string => when(d).replace(/,?\s+\d{1,2}:\d{2}.*$/, '');
  /**
   * An operation, with a quiet bracket down its left edge while it's inside a transaction. The bracket
   * runs through the cell's padding, so a transaction's rows join into one line.
   */
  const opCell = (op: string, label: string, txn: boolean): string => {
    // Newest first: a transaction's commit (or rollback) is its top row and its begin its bottom row, so
    // the bracket stops at their text and neighbouring transactions stay apart. The bracket sits in the
    // cell's left padding, so the text lines up under the column's header.
    const top = txn && /Commit|Rollback/i.test(op);
    const bottom = txn && /Begin|TStart/i.test(op);
    return `<span style="display:block;box-sizing:border-box;width:${RW.op - 6}px;margin:${top ? 0 : -4}px 0 ${bottom ? 0 : -4}px -10px;padding:${top ? 0 : 4}px 0 ${bottom ? 0 : 4}px 8px;border-left:2px solid ${txn ? 'var(--ev-border-2)' : 'transparent'};${TXT}color:var(--ev-color-text-secondary)"${txn ? ' title="In a transaction"' : ''}>${esc(label)}</span>`;
  };
  /**
   * A global node cut in the middle: its start gives way (with "…") before its last subscript does,
   * since neighbouring rows usually differ at the end. Then the fold count.
   */
  const nodeCell = (node: string, rep: number): string => {
    if (!node) return cell.dim('—');
    const sp = splitNode(node);
    const lastSub = sp && sp.subs.length ? sp.subs[sp.subs.length - 1] : '';
    const head = sp && sp.subs.length ? `${sp.name}(${sp.subs.slice(0, -1).map((s) => `${s},`).join('')}` : node;
    const tail = sp && sp.subs.length ? `${lastSub})` : '';
    const count = rep > 1 ? `<span style="flex:none;white-space:nowrap;font-family:var(--ev-font-family);color:var(--ev-color-text-tertiary)"><span style="margin:0 6px" aria-hidden="true">·</span>repeated ${esc(num(rep))}×</span>` : '';
    return `<span title="${esc(node)}" style="display:flex;width:0;min-width:100%;font-family:var(--ev-font-family-mono);font-size:12.5px;line-height:1.4;position:relative;top:var(--mono-nudge, 0px);font-weight:var(--mono-weight, 400);color:var(--ev-color-text-primary)">`
      + `<span style="${TXT}flex:0 1 auto;min-width:3ch">${esc(head)}</span>${tail ? `<span style="${TXT}flex:0 0 auto;max-width:70%">${esc(tail)}</span>` : ''}${count}</span>`;
  };
  const recColumns = (timeLabel: string): GridColumn[] => [
    { key: 'Time', label: timeLabel, width: `${RW.time}px`, renderCell: (v, row) => fitR(RW.time, cell.num(String(v), String(row.TimeTitle))) },
    { key: 'Pid', label: 'PID', width: `${RW.pid}px`, align: 'right', renderCell: (v) => fitR(RW.pid, cell.num(String(v)), 'text-align:right') },
    { key: 'Op', label: 'Operation', width: `${RW.op}px`, renderCell: (v, row) => opCell(String(v), String(row.OpLabel ?? v), !!row.Txn) },
    { key: 'Node', label: 'Global node', width: '100%', renderCell: (v, row) => nodeCell(String(v ?? ''), Number(row.Rep)) },
    { key: 'Db', label: 'Database', width: `${RW.db}px`, renderCell: (v, row) => fitR(RW.db, v ? cellRef(v, undefined, String(row.Dir)) : cell.dim('—')) },
  ];
  /**
   * The day is said once: in the Time header when every row shown is from one day ("Time · today"),
   * else on the first row of each day.
   */
  const recGridRows = (groups: RecGroup[]): { rows: DataGridRow[]; timeLabel: string } => {
    const days = new Set(groups.map((g) => irisDate(g.head.TimeStamp).toDateString()));
    const oneDay = days.size <= 1;
    let prev = '';
    const rows = groups.map((g) => {
      const r = g.head;
      const d = irisDate(r.TimeStamp);
      const day = d.toDateString();
      const time = !oneDay && day !== prev ? `${dayWord(d)} ${clock(d)}` : clock(d);
      prev = day;
      return {
        key: g.key, Time: time, TimeTitle: when(d, { seconds: true }), Pid: r.ProcessID, Op: opOf(r), OpLabel: opLabel(r), Txn: r.InTransaction,
        Node: r.GlobalNode, Rep: g.members.length, Db: r.DatabaseName ? dbNameOf(r.DatabaseName) ?? midPath(r.DatabaseName, 21) : '', Dir: r.DatabaseName,
      } as DataGridRow;
    });
    const first = groups[0];
    return { rows, timeLabel: oneDay && first ? `Time · ${lowerDay(dayWord(irisDate(first.head.TimeStamp)))}` : 'Time' };
  };
  let recTimeLabel = 'Time';
  /** While the peek is open the Database column steps aside, before the global node is squeezed. */
  let recPeekOpen = false;
  /** How far back the loaded rows reach, mid-sentence ("yesterday 22:13:46"). */
  const reachedBack = (): string => {
    const last = recRows[recRows.length - 1];
    return last ? lowerDay(when(irisDate(last.TimeStamp), { seconds: true })) : '';
  };
  const recFiltered = (): boolean => recOp !== 'all' || !!recGlobal || !!recPid;
  /** Reading ahead on its own: a filter is on, too few matches so far, more of the file to read. */
  const scanning = (): boolean => recBusy && recScan > 0;
  const renderRecords = (): void => {
    const wrapR = $('#jrn-rec-wrap');
    if (!recGrid) {
      wrapR.innerHTML = '';
      recGrid = document.createElement('ev-data-grid') as GridEl;
      recGrid.setAttribute('compact', '');
      recGrid.setAttribute('row-select', '');
      recGrid.setAttribute('row-key', 'key');
      recGrid.setAttribute('aria-label', 'Journal records');
      recGrid.columns = recColumns(recTimeLabel);
      recGrid.addEventListener('ev-data-grid-row-click', (e) => void recOd.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.key)));
      // While the peek is open it follows the keyboard, as in the Messages log: the arrow keys move the grid's
      // focused row, and the peek with it (read after the grid has moved, and again for rows it windows in).
      const g = recGrid;
      const follow = (): void => {
        if (!recPeekOpen || recOd.mode() !== 'list') return;
        const key = (g.shadowRoot?.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey;
        if (key && key !== recOd.selected() && groupOf(key)) void recOd.select(key);
      };
      g.addEventListener('keydown', (e) => {
        if (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End)$/.test(e.key)) return;
        setTimeout(follow, 0);
        setTimeout(follow, 80);
      });
      wrapR.appendChild(recGrid);
    }
    const rows = recVisible();
    const groups = recGroups();
    const view = recGridRows(groups);
    if (view.timeLabel !== recTimeLabel) { recTimeLabel = view.timeLabel; recGrid.columns = recColumns(recTimeLabel); }
    recGrid.setColumnVisible('Db', !recPeekOpen);
    recGrid.rows = view.rows;
    const sel = recOd.selected();
    if (sel) recGrid.select([rowKeyOf(sel)]);
    renderOpCounts();
    // The grid keeps its frame and header; an empty, loading or error state sits inside it.
    wrapR.querySelectorAll('.jrn-rec-over').forEach((x) => x.remove());
    const back = reachedBack();
    let over = '';
    if (recError) over = errorPanel(new Error(recError));
    else if (recBusy && !recRows.length) over = skeleton(8);
    else if (!rows.length) {
      over = !recFiltered()
        ? emptyState({ icon: 'file-text', title: 'No records', what: 'This file has no records you can read.' })
        : recEnd
          ? emptyState({ icon: 'search', title: 'No record in this file matches', what: 'The whole file was searched. Change or clear the filters.', button: { id: 'jrn-rec-clear', label: 'Clear filters' } })
          : scanning()
            ? emptyState({ icon: 'search', title: 'Searching older records…', what: back ? esc(`No match yet, back to ${back}.`) : 'No match yet.' })
            : emptyState({ icon: 'search', title: 'No match in the records searched', what: esc(`Searched back to ${back}. Load older records to search further back, or change the filters.`), button: { id: 'jrn-rec-clear', label: 'Clear filters' } });
    }
    wrapR.classList.toggle('jrn-rec-wrap--over', !!over);
    if (over) {
      wrapR.insertAdjacentHTML('beforeend', `<div class="jrn-rec-over">${over}</div>`);
      wrapR.querySelector('#jrn-rec-clear')?.addEventListener('click', clearRecFilters);
    }
    const busyScan = scanning();
    const more = $<HTMLButtonElement>('#jrn-rec-more');
    more.hidden = recEnd || !recRows.length || busyScan;
    more.disabled = recBusy;
    more.textContent = recBusy && recRows.length ? 'Loading…' : 'Load older';
    $<HTMLButtonElement>('#jrn-rec-stop').hidden = !busyScan;
    const sep = '<span class="meta-sep">·</span>';
    const reach = recEnd ? (recFiltered() ? 'whole file searched' : 'start of file') : back ? `${recFiltered() ? 'searched ' : ''}back to ${esc(back)}` : '';
    // Folded rows: the footer counts records, and says how many rows they fold into.
    const inRows = groups.length < rows.length ? ` <span title="Identical records in a row fold into one">in ${num(groups.length)} ${groups.length === 1 ? 'row' : 'rows'}</span>` : '';
    // The footer says the order (the page has no subtitle).
    const order = `${sep}newest first`;
    $('#jrn-rec-count').innerHTML = !recRows.length
      ? (recFiltered() && recEnd && !recError ? `<b>0</b> matching${sep}whole file searched` : '')
      : busyScan
        ? `<b>${num(rows.length)}</b> matching${inRows}${order}${sep}searching older records, back to ${esc(back)}…`
        : recFiltered()
          ? `<b>${num(rows.length)}</b> matching${inRows}${order}${sep}${reach}`
          : `<b>${num(rows.length)}</b> record${rows.length === 1 ? '' : 's'}${inRows}${order}${reach ? `${sep}${reach}` : ''}`;
  };
  /**
   * The operation chips' counts, from the records read (and the other filters). Every chip keeps a count:
   * while IRIS itself filters by operation (its reads then hold only that operation), the chips keep the
   * counts from the last unfiltered read, or "—" when there is none. How many match is the footer's.
   */
  let opLabelsSig = '';
  let opCountsKnown: Record<string, number> | null = null;
  /** The control never gets narrower while the browser is open, so the PID box beside it doesn't move. */
  let opMinWidth = 0;
  const OPS: Array<[string, string]> = [['all', 'All'], ['set', 'Sets'], ['kill', 'Kills'], ['txn', 'Transactions'], ['other', 'Other']];
  function renderOpCounts(): void {
    const byOp = recMatchSig.includes('"TypeName"');
    const known = recRows.length > 0 || recEnd;
    if (!byOp && known) {
      const base = recRows.filter((r) => (!recGlobal || r.GlobalNode.toLowerCase().includes(recGlobal.toLowerCase())) && (!recPid || String(r.ProcessID) === recPid));
      opCountsKnown = Object.fromEntries(OPS.map(([op]) => [op, op === 'all' ? base.length : base.filter((r) => opGroup(r) === op).length]));
    }
    const counts = byOp || known ? opCountsKnown : null;
    const n = (op: string): string => ` ${counts ? num(counts[op] ?? 0) : '—'}`;
    const options = OPS.map(([value, label]) => ({ value, label: `${label}${n(value)}` }));
    const sig = JSON.stringify(options);
    if (sig === opLabelsSig) return;
    opLabelsSig = sig;
    const opEl = $<OpEl>('#jrn-rec-op');
    opEl.options = options;
    opEl.value = recOp;
    // Reserve the widest the control has been: counts can only make it wider.
    requestAnimationFrame(() => {
      opEl.style.minWidth = '';
      const w = opEl.getBoundingClientRect().width;
      if (w > 0) { opMinWidth = Math.max(opMinWidth, Math.ceil(w)); opEl.style.minWidth = `${opMinWidth}px`; }
    });
  }

  /**
   * The one filter IRIS applies while it reads (it takes one): the global, else the process, else the
   * operation. Whatever it doesn't cover filters the rows read, and reading goes on ahead (see readAhead).
   */
  const serverMatch = (): JournalRecordQuery['match'] => (recGlobal ? { column: 'GlobalNode', op: '[', value: recGlobal }
    : recPid ? { column: 'ProcessID', op: '=', value: recPid }
      : recOp === 'set' ? { column: 'TypeName', op: '[', value: 'SET' }
        : recOp === 'kill' ? { column: 'TypeName', op: '[', value: 'KILL' }
          : recOp === 'txn' ? { column: 'TypeName', op: '[', value: 'Trans' } : undefined);

  /** Read a page: the first (fresh) or the next, older one. */
  const loadRecords = async (fresh: boolean, auto = false): Promise<void> => {
    const gen = fresh ? ++recGen : recGen;
    const match = serverMatch();
    if (fresh) { recRows = []; recEnd = false; recMatchSig = JSON.stringify(match ?? null); void recOd.select(null); }
    if (!auto) { recScan = 0; recStopped = false; }
    recBusy = true;
    recError = '';
    renderRecords();
    try {
      const last = recRows[recRows.length - 1];
      const page = await listJournalRecords({ file: recFile, match, offset: last?.Address, reverse: true, rows: REC_PAGE }, () => alive && gen === recGen);
      if (gen !== recGen) return;
      const seen = new Set(recRows.map((r) => r.Address));
      const added = page.filter((r) => !seen.has(r.Address));
      recRows = recRows.concat(added);
      recEnd = added.length === 0;
    } catch (err) {
      if (gen !== recGen) return;
      recError = errorText(err);
      recEnd = true;
    }
    if (gen !== recGen) return;
    if (readAhead()) return; // still busy: the next page is on its way
    recBusy = false;
    recScan = 0;
    renderRecords();
    if (recOd.mode() === 'full') recOd.refresh(); // "Same global" counts the rows just read
    if (recPendingAt !== null) {
      const k = recPendingAt;
      recPendingAt = null;
      // Back to "<file>/records/at/<address>" (the list read again): the record selected, in view, and focused.
      if (recOd.mode() === 'list' && recRows.some((r) => String(r.Address) === k)) void recOd.select(rowKeyOf(k)).then(() => { scrollToRecord(k); focusRecRow(rowKeyOf(k)); });
    }
  };
  /** With a filter on and few matches, read older pages on its own: up to SCAN_PAGES, until Stop. */
  const readAhead = (): boolean => {
    if (!recFiltered() || recEnd || recError || recStopped || recScan >= SCAN_PAGES - 1 || recVisible().length >= SCAN_WANT) return false;
    recScan++;
    void loadRecords(false, true);
    return true;
  };
  const stopReading = (): void => {
    recStopped = true;
    ++recGen; // the page in flight is dropped
    recBusy = false;
    recScan = 0;
    renderRecords();
  };
  /** A filter changed: read again when IRIS's filter changed, else filter what's read and read on if needed. */
  const applyRecFilters = (): void => {
    if (JSON.stringify(serverMatch() ?? null) !== recMatchSig) { void loadRecords(true); return; }
    if (recBusy) { renderRecords(); return; }
    recScan = 0; recStopped = false;
    if (!readAhead()) renderRecords();
  };
  function clearRecFilters(): void {
    recGlobal = ''; recPid = ''; recOp = 'all';
    ($('#jrn-rec-global') as HTMLElement & { value: string }).value = '';
    ($('#jrn-rec-pid') as HTMLElement & { value: string }).value = '';
    ($('#jrn-rec-op') as HTMLElement & { value: string }).value = 'all';
    applyRecFilters();
  }

  /**
   * Old and new value side by side, each masked until revealed; values are only text in the page while this
   * record is open, and never go in the address, the title or a log.
   */
  const valuesHtml = (): string => {
    const d = recShown?.d;
    const sk = d?.SetKill ?? {};
    // Records that change no value (transaction markers and the like) have no SetKill part.
    if (!d || !sk.GlobalNode) return '<p class="od-desc">This record changes no value.</p>';
    const kill = /KILL/i.test(d.TypeName);
    // NumberOfValues says what the journal holds: a SET stores its new value, and its old value only
    // when there was one inside a transaction (for rollback); a KILL stores the killed value only inside
    // a transaction. IRIS sends "" for a value it didn't store, so "" alone can't tell "empty" apart.
    const n = Number(sk.NumberOfValues);
    const counted = Number.isFinite(n);
    const stored = (which: 'old' | 'new'): boolean => {
      const v = which === 'old' ? sk.OldValue : sk.NewValue;
      if (v === undefined || v === null) return false;
      if (!counted) return v !== '';
      return kill ? which === 'old' && n >= 1 : which === 'new' ? n >= 1 : n >= 2;
    };
    const absent = (which: 'old' | 'new'): string => {
      if (kill && which === 'new') return '<span class="jr-absent" title="A kill leaves no value">—</span>';
      if (which === 'new') return '<span class="jr-absent">Not stored in the journal</span>';
      if (d.InTransaction && !kill) return '<span class="jr-absent">No value before: this set created the node</span>';
      return `<span class="jr-absent">Not stored in the journal <span class="jr-absent-why">IRIS keeps the ${kill ? 'killed' : 'old'} value only for changes inside a transaction</span></span>`;
    };
    const one = (which: 'old' | 'new', label: string, v: unknown): string => {
      const has = stored(which);
      const empty = has && v === '';
      const open = recReveal.has(which);
      const eye = has && !empty ? `<button type="button" class="pd-eye" data-rec-show="${which}" aria-pressed="${open}" aria-label="${open ? 'Hide' : 'Show'} the ${label.toLowerCase()}" title="${open ? 'Hide value' : 'Show value'}"><ev-icon name="${open ? 'eye-off' : 'eye'}" size="xs"></ev-icon></button>` : '';
      const text = !has ? absent(which)
        : empty ? '<span class="jr-value" title="An empty string">""</span>'
          : open ? `<span class="jr-value">${esc(String(v))}</span>` : '<span class="pd-var-mask">••••</span>';
      return `<div class="jr-diff-side" data-side="${which}"><div class="jr-diff-head"><span>${label}</span>${eye}</div><div class="jr-diff-val">${text}</div></div>`;
    };
    return `<div class="jr-diff">${one('old', kill ? 'Killed value' : 'Old value', sk.OldValue)}${one('new', 'New value', sk.NewValue)}</div>`;
  };
  const bindValues = (root: HTMLElement): void => {
    root.querySelectorAll<HTMLElement>('[data-rec-show]').forEach((b) => b.addEventListener('click', () => {
      const which = b.dataset.recShow as 'old' | 'new';
      if (recReveal.has(which)) recReveal.delete(which); else recReveal.add(which);
      const host = root.querySelector<HTMLElement>('.jr-diff');
      if (!host) return;
      host.outerHTML = valuesHtml();
      bindValues(root);
      root.querySelector<HTMLElement>(`[data-rec-show="${which}"]`)?.focus();
    }));
  };
  /** "^Orders" from "^Orders(1,2)". */
  const globalOf = (node: string): string => /^[^(]*/.exec(node)?.[0] ?? node;
  const isLoaded = (addr: number): boolean => recRows.some((x) => x.Address === addr) || recExtra.has(String(addr));
  /** A record's address: in the peek it selects that record, in the full view it opens it; plain when it isn't read. */
  const recLink = (addr: number | undefined, where: 'peek' | 'full', end: 'start' | 'end'): string => {
    if (!addr) return `<span class="dim">${end === 'start' ? 'Start of the file' : 'End of the file'}</span>`;
    return isLoaded(addr)
      ? `<button type="button" class="link mono" ${where === 'peek' ? 'data-rec-sel' : 'data-rec-open'}="${addr}">${esc(String(addr))}</button>`
      : `${mono(String(addr))} <span class="dim">· not read yet</span>`;
  };
  /** A process ID as a link to Processes (it opens there while the process is still running). */
  const processLink = (pid: number): string => (pid
    ? `<a class="link" href="#/operations/processes/${pid}" title="Open this process, if it’s still running">${esc(String(pid))}</a>`
    : '<span class="dim">—</span>');
  const txnText = (r: JournalRecordRow): string => (r.InTransaction ? 'In a transaction' : 'Not in a transaction');
  /** The peek's title holds about two lines of a node, the full view's heading about two wide lines. */
  const PEEK_TITLE_MAX = 64;
  const FULL_TITLE_MAX = 180;
  /** The whole node, when the title had to cut it. */
  const fullNodeKv = (r: JournalRecordRow, max: number): Array<[string, string]> =>
    (r.GlobalNode && midNode(r.GlobalNode, max) !== r.GlobalNode ? [['Global node', `<span class="mono jr-node-full">${esc(r.GlobalNode)}</span>`]] : []);
  /** The records folded into this one's row (itself first), when it heads a row. */
  const foldOf = (r: JournalRecordRow): JournalRecordRow[] => groupOf(String(r.Address))?.members ?? [r];
  /** Which record's fold is expanded ("Show all"), so a refresh keeps it open. */
  let foldOpen = '';
  /** A span of addresses, lowest to highest: "1400–1417" (identifiers: no thousands separators). */
  const addrSpan = (list: JournalRecordRow[]): string => {
    const a = list.map((x) => x.Address);
    const lo = Math.min(...a);
    const hi = Math.max(...a);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  };
  /** A run of records' times: "at 18:59:28", or "from 18:59:20 to 18:59:28". */
  const timeSpan = (list: JournalRecordRow[]): string => {
    const newest = clock(irisDate(list[0].TimeStamp));
    const oldest = clock(irisDate(list[list.length - 1].TimeStamp));
    return newest === oldest ? `at ${newest}` : `from ${oldest} to ${newest}`;
  };
  /**
   * A fold in one line: "18 identical records at 18:59:28 (addresses 1400–1417)", with "Show all" to list
   * every record (newest first, the first 50), each opening that record.
   */
  const foldList = (r: JournalRecordRow, where: 'peek' | 'full'): string => {
    const list = foldOf(r);
    const shown = list.slice(0, 50);
    const open = foldOpen === String(r.Address);
    return `<p class="jr-fold-line"><span>${esc(`${num(list.length)} identical records ${timeSpan(list)} (addresses ${addrSpan(list)})`)}</span>
        <button type="button" class="link" data-fold-all aria-expanded="${open}">${open ? 'Hide' : 'Show all'}</button></p>
      <div class="jr-fold-all"${open ? '' : ' hidden'}>
        <ul class="jr-same">${shown.map((x) => `<li><span class="jr-fold-time">${esc(clock(irisDate(x.TimeStamp)))}</span><button type="button" class="link mono" data-rec-open="${x.Address}" title="Open this record">${esc(String(x.Address))}</button></li>`).join('')}</ul>
        ${list.length > shown.length ? `<p class="jr-same-note">and ${num(list.length - shown.length)} earlier</p>` : ''}${where === 'peek' ? '<p class="jr-same-note">Identical but for the time and address. Open one to see its values.</p>' : ''}
      </div>`;
  };
  const foldHtml = (r: JournalRecordRow, where: 'peek' | 'full'): string => (foldOf(r).length > 1 ? odSection('Repeats', foldList(r, where)) : '');
  /**
   * Say each fact once. Subtitle: operation and time. The list already shows the database, so the peek
   * doesn't; the full view names it in the strip. Addresses are identifiers: never thousands separators.
   */
  const peekKv = (r: JournalRecordRow, d: JournalRecordDetail | null): string => odKv([
    ...fullNodeKv(r, PEEK_TITLE_MAX),
    ['Transaction', esc(txnText(r))],
    ['Process', processLink(r.ProcessID)],
    ['Address', mono(String(r.Address))],
    ['Previous record', d ? recLink(d.PrevAddress, 'peek', 'start') : '<span class="dim">—</span>'],
    ['Next record', d ? recLink(d.NextAddress, 'peek', 'end') : '<span class="dim">—</span>'],
    ...(d?.SetKill?.MirrorDatabaseName ? [['Mirror database', esc(d.SetKill.MirrorDatabaseName)] as [string, string]] : []),
  ]);
  /**
   * The records either side of this one in the file, as context (the header's pager steps through the list):
   * what each changed, by what differs from this node, then its operation and time.
   */
  const nearRecord = (addr: number | undefined, r: JournalRecordRow, end: 'start' | 'end'): string => {
    if (!addr) return `<span class="dim">${end === 'start' ? 'Start of the file' : 'End of the file'}</span>`;
    const x = recRows.find((y) => y.Address === addr) ?? recExtra.get(String(addr));
    if (!x) return `${mono(String(addr))} <span class="dim">· not read yet</span>`;
    const same = !!x.GlobalNode && !!r.GlobalNode && globalOf(x.GlobalNode) === globalOf(r.GlobalNode);
    const diff = same ? nodeDiff(x.GlobalNode, r.GlobalNode) : null;
    const what = !x.GlobalNode ? { text: opLabel(x), mono: false }
      : same ? { text: diff === null ? String(addr) : diff === '' ? 'The whole global' : diff, mono: diff !== '' }
        : { text: midNode(x.GlobalNode, 48), mono: true };
    // The same node: by its address, and whether it's identical to this one (a repeat) or not.
    const kind = diff === null && same ? (sameRec(x, r) ? 'identical · ' : 'same node · ') : '';
    const facts = x.GlobalNode ? `${kind}${opLabel(x)} · ${clock(irisDate(x.TimeStamp))}` : clock(irisDate(x.TimeStamp));
    return `<span class="jr-near"><button type="button" class="link${what.mono ? ' mono' : ''} jr-near-node" data-rec-open="${addr}" title="${esc(x.GlobalNode || opLabel(x))}">${esc(what.text)}</button><span class="dim">· ${esc(facts)}</span></span>`;
  };
  const fullKv = (r: JournalRecordRow, d: JournalRecordDetail | null): string => (d ? odKv([
    ...fullNodeKv(r, FULL_TITLE_MAX),
    ['Written before it', nearRecord(d.PrevAddress, r, 'start')],
    ['Written after it', nearRecord(d.NextAddress, r, 'end')],
    ...(d.SetKill?.MirrorDatabaseName ? [['Mirror database', esc(d.SetKill.MirrorDatabaseName)] as [string, string]] : []),
  ]) : '<p class="od-desc">Couldn’t read this record.</p>');
  /** Other loaded records that change the same global, newest first (not those in this record's own fold). */
  const sameGlobal = (r: JournalRecordRow): JournalRecordRow[] => {
    const g = globalOf(r.GlobalNode);
    if (!g) return [];
    const fold = new Set(foldOf(r).map((x) => x.Address));
    return recRows.filter((x) => x.Address !== r.Address && !fold.has(x.Address) && globalOf(x.GlobalNode) === g);
  };
  /** Those records run together into one line while they're identical (as the list folds them). */
  const sameRuns = (r: JournalRecordRow): JournalRecordRow[][] => {
    const runs: JournalRecordRow[][] = [];
    for (const x of sameGlobal(r)) {
      const last = runs[runs.length - 1];
      if (last && sameRec(last[0], x)) last.push(x); else runs.push([x]);
    }
    return runs;
  };
  /** How many: said once, under the peek's list and in the full view's card header. */
  const sameCount = (r: JournalRecordRow): string => `${num(sameGlobal(r).length)} in the ${num(recRows.length)} records read`;
  const sameGlobalHtml = (r: JournalRecordRow, where: 'peek' | 'full'): string => {
    const list = sameGlobal(r);
    if (!r.GlobalNode) return '<p class="od-desc">This record doesn’t change a global.</p>';
    if (!recRows.length) return `<p class="od-desc">${recBusy ? 'Reading the file…' : 'No records read yet.'}</p>`;
    if (!list.length) return `<p class="od-desc">${esc(`No other record in the ${num(recRows.length)} read changes ${globalOf(r.GlobalNode)}.`)}</p>`;
    const runs = sameRuns(r);
    const shown = runs.slice(0, where === 'peek' ? 5 : 12);
    const attr = where === 'peek' ? 'data-rec-sel' : 'data-rec-open';
    const today = irisDate(r.TimeStamp).toDateString();
    const at = (x: JournalRecordRow): string => {
      const d = irisDate(x.TimeStamp);
      return d.toDateString() === today ? clock(d) : when(d, { seconds: true });
    };
    // Each line by its address (a run by its span of addresses); another node also by what differs from
    // this one: "(…,\"ListTask\")". Then its operation and time (and how many, for a run). When every line is
    // this record's own node, the card's header says so once instead.
    const allSame = shown.every((run) => run[0].GlobalNode === r.GlobalNode);
    const line = (run: JournalRecordRow[]): string => {
      const x = run[0];
      const diff = nodeDiff(x.GlobalNode, r.GlobalNode);
      const what = diff === null ? (allSame ? '' : '<span class="jr-same-what">Same node</span>')
        : diff === '' ? '<span class="jr-same-what">The whole global</span>'
          : `<span class="jr-same-what mono" title="${esc(x.GlobalNode)}">${esc(diff)}</span>`;
      const oldest = run[run.length - 1];
      const span = run.length > 1 && at(oldest) !== at(x) ? `${at(oldest)}–${at(x)}` : at(x);
      const facts = `${opLabel(x)} · ${span}${run.length > 1 ? ` · ${num(run.length)} records` : ''}`;
      const tip = `${diff === null ? 'The same node as this record. ' : ''}${run.length > 1 ? `Open the newest of these ${run.length} records` : 'Open this record'}`;
      return `<li><button type="button" class="link mono jr-same-addr" ${attr}="${x.Address}" title="${esc(tip)}">${esc(addrSpan(run))}</button>${what}<span>${esc(facts)}</span></li>`;
    };
    return `<ul class="jr-same">${shown.map(line).join('')}</ul>
      ${where === 'peek' ? `<p class="jr-same-note">${esc(sameCount(r))}</p>`
        : runs.length > shown.length ? `<p class="jr-same-note"><button type="button" class="link" data-rec-filter="${esc(globalOf(r.GlobalNode))}">Show them all in the list</button></p>` : ''}`;
  };
  /** Read the record for the peek or full view; values are kept only for the record being shown. */
  const readRecord = async (r: JournalRecordRow): Promise<JournalRecordDetail | null> => {
    if (recShown?.address === r.Address) return recShown.d;
    recReveal.clear();
    recShown = null;
    try {
      const d = await getJournalRecord(recFile, r.Address);
      recShown = { address: r.Address, d };
      return d;
    } catch { return null; }
  };
  // Breadcrumbs: "Journals / <file>" on the list, "Journals / <file> / <node>" on a record's full view.
  const rootCrumb = (): string => `<a class="od-crumb" data-jrn-root href="${esc(routeBase)}">Journals</a>`;
  const CRUMB_SEP = '<span class="od-crumb-sep" aria-hidden="true">/</span>';
  const fileCrumb = (): string => `<a class="od-crumb od-crumb--mono" href="${esc(`${routeBase}/${encodeURIComponent(baseName(recFile))}/records`)}">${esc(baseName(recFile))}</a>`;
  // The full view has its own address: #/operations/journals/<file>/records/<address> (never a value).
  const recCtx: ScreenCtx = {
    ...ctx,
    param: linked?.records && linked.address !== null ? String(linked.address) : undefined,
    // objectDetail's trail is "Records / <node>": the record sits under its file, under Journals.
    heading: (html, sub) => {
      let h = html.replace(/^<a class="od-crumb" href="[^"]*">Records<\/a>/, () => `${rootCrumb()}${CRUMB_SEP}${fileCrumb()}`);
      // The node: cut in the middle to what two lines hold (not the peek's shorter cut), whole in the tooltip.
      const sel = recOd.selected();
      const row = sel ? recRows.find((x) => String(x.Address) === sel) ?? recExtra.get(sel) : undefined;
      if (row?.GlobalNode) {
        h = h.replace(/<span class="od-crumb-here od-crumb-here--mono"[^>]*>[\s\S]*?<\/span>$/,
          () => `<span class="od-crumb-here od-crumb-here--mono jr-crumb-node" title="${esc(row.GlobalNode)}">${esc(midNode(row.GlobalNode, FULL_TITLE_MAX))}</span>`);
      }
      ctx.heading(h, sub);
    },
    setParam: (p) => {
      if (!recFile || recEl.hidden) return;
      if (p) recScrollBack = true; // the list is hidden now: put its scroll back when it returns
      ctx.setParam?.(recParam());
    },
  };
  const recOd = objectDetail<JournalRecordRow>(recCtx, {
    collection: 'Records', noun: 'record',
    panel: $('#jrn-rec-panel'), detail: $('#jrn-rec-detail'), list: $('#jrn-rec-list'), full: $('#jrn-rec-full'),
    key: (r) => String(r.Address),
    find: (k) => recRows.find((r) => String(r.Address) === k) ?? recExtra.get(k),
    order: () => recGroups().map((g) => g.key),
    name: (r) => (r.GlobalNode ? midNode(r.GlobalNode, PEEK_TITLE_MAX) : opLabel(r)),
    mono: (r) => !!r.GlobalNode,
    meta: (r) => odMeta({ label: opLabel(r), tone: 'neutral' }, [when(irisDate(r.TimeStamp), { seconds: true })]),
    peek: async (r) => {
      const d = await readRecord(r);
      const g = globalOf(r.GlobalNode);
      return `${odSection('Values', d ? valuesHtml() : '<p class="od-desc">Couldn’t read this record.</p>')}
        ${foldHtml(r, 'peek')}
        ${odSection('Record', peekKv(r, d))}
        ${r.GlobalNode ? odSection(`Other changes to ${g}`, sameGlobalHtml(r, 'peek')) : ''}`;
    },
    loadFull: async (r): Promise<OdFull> => {
      const d = await readRecord(r);
      void readNear(r, d);
      const g = globalOf(r.GlobalNode);
      return {
        strip: [
          { label: 'Database', value: r.DatabaseName ? dbName(r.DatabaseName) : '—', title: r.DatabaseName },
          { label: 'Address', value: String(r.Address) },
          { label: 'Transaction', value: txnText(r) },
          { label: 'Process', value: r.ProcessID ? String(r.ProcessID) : '—', caption: r.ProcessID ? `<a class="link" href="#/operations/processes/${r.ProcessID}" title="Open this process, if it’s still running">Open in Processes</a>` : '' },
        ],
        main: [
          { title: 'Values', body: d ? valuesHtml() : '<p>Couldn’t read this record.</p>' },
          { title: 'In the file', body: fullKv(r, d) },
          // Its identical neighbours, in one line (the header's pager counts rows, not these).
          ...(foldOf(r).length > 1 ? [{ title: 'Repeats', body: foldList(r, 'full') }] : []),
        ],
        side: [
          {
            title: g ? `Other changes to ${g}` : 'Other changes to the global', body: sameGlobalHtml(r, 'full'),
            head: g && recRows.length && sameGlobal(r).length ? `<span class="jr-card-note">${esc(`${sameCount(r)}${sameGlobal(r).every((x) => x.GlobalNode === r.GlobalNode) ? ' · all to this node' : ''}`)}</span>` : '',
          },
        ],
      };
    },
    wire: (root) => {
      bindValues(root);
      // The peek's title is cut in the middle; its tooltip is the whole node.
      const sel = recOd.selected();
      const row = sel ? recRows.find((x) => String(x.Address) === sel) ?? recExtra.get(sel) : undefined;
      if (row?.GlobalNode) $('#jrn-rec-detail').querySelector('.od-title')?.setAttribute('title', row.GlobalNode);
      root.querySelectorAll<HTMLElement>('[data-fold-all]').forEach((b) => b.addEventListener('click', () => {
        const all = b.closest('.jr-fold-line')?.nextElementSibling as HTMLElement | null;
        if (!all) return;
        all.hidden = !all.hidden;
        foldOpen = all.hidden ? '' : recOd.selected() ?? '';
        b.textContent = all.hidden ? 'Show all' : 'Hide';
        b.setAttribute('aria-expanded', String(!all.hidden));
      }));
      root.querySelectorAll<HTMLElement>('[data-rec-open]').forEach((b) => b.addEventListener('click', () => void recOd.openFull(b.dataset.recOpen ?? '')));
      root.querySelectorAll<HTMLElement>('[data-rec-sel]').forEach((b) => b.addEventListener('click', () => {
        const k = rowKeyOf(b.dataset.recSel ?? '');
        void recOd.select(k).then(() => scrollToRecord(k));
      }));
      root.querySelectorAll<HTMLElement>('[data-rec-filter]').forEach((b) => b.addEventListener('click', () => {
        const g = b.dataset.recFilter ?? '';
        void recOd.closeFull().then(() => {
          recGlobal = g;
          ($('#jrn-rec-global') as HTMLElement & { value: string }).value = g;
          applyRecFilters();
        });
      }));
    },
    onPeek: (open) => { recPeekOpen = open; recGrid?.setColumnVisible('Db', !open); },
    onSelect: (k) => {
      if (!k) { recShown = null; recReveal.clear(); }
      recGrid?.select(k ? [rowKeyOf(k)] : []);
      if (recFile && !recEl.hidden && recOd.mode() === 'list') {
        replaceParam(recParam());
        if (recScrollBack) { recScrollBack = false; restoreScroll(recScrollTop); if (k) focusRecRow(rowKeyOf(k)); } else { const el = recScroller(); if (el) recScrollTop = el.scrollTop; }
      }
    },
  });
  /** A record read on its own, as a list row (no values). */
  function rowOf(address: number, d: JournalRecordDetail): JournalRecordRow {
    return {
      Address: address, TypeName: d.TypeName, ExtTypeName: d.ExtTypeName, TimeStamp: d.TimeStamp, InTransaction: !!d.InTransaction,
      ProcessID: Number(d.ProcessID) || 0, GlobalNode: d.SetKill?.GlobalNode ?? '', DatabaseName: d.SetKill?.DatabaseName ?? '',
    };
  }
  /** The full view's neighbours that aren't in the rows read: read on their own, keeping only what a row holds. */
  const nearTried = new Set<string>();
  const readNear = async (r: JournalRecordRow, d: JournalRecordDetail | null): Promise<void> => {
    const file = recFile;
    const todo = [d?.PrevAddress, d?.NextAddress].filter((a): a is number => !!a && !isLoaded(a) && !nearTried.has(`${file}:${a}`));
    if (!todo.length) return;
    todo.forEach((a) => nearTried.add(`${file}:${a}`));
    let got = false;
    await Promise.all(todo.map(async (a) => {
      try {
        const x = await getJournalRecord(file, a);
        if (alive && recFile === file) { recExtra.set(String(a), rowOf(a, x)); got = true; }
      } catch { /* said as "not read yet" */ }
    }));
    // Shown once they're in, if this record's full view is still up.
    if (got && recOd.mode() === 'full' && recOd.selected() === String(r.Address)) recOd.refresh();
  };
  /** A link or reload named a record: read it on its own (it may be far back in the file) and open its full view. */
  const openLinkedRecord = async (address: number): Promise<void> => {
    const gen = recGen;
    try {
      const d = await getJournalRecord(recFile, address);
      if (!alive || recEl.hidden) return;
      recExtra.set(String(address), rowOf(address, d));
      recShown = { address, d };
    } catch { /* refresh() says there is no such record */ }
    if (alive && !recEl.hidden && gen <= recGen) recOd.refresh();
  };

  const onRecTitle = (e: MouseEvent): void => {
    if (recEl.hidden) return;
    const a = (e.target as Element).closest('a.od-crumb');
    if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (recOd.mode() === 'full') {
      // The file crumb is objectDetail's (back to the list); "Journals" leaves the records altogether.
      if (!a.hasAttribute('data-jrn-root')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void recOd.closeFull().then(() => closeRecords());
      return;
    }
    e.preventDefault();
    closeRecords();
  };
  document.getElementById('page-title')?.addEventListener('click', onRecTitle);
  ctx.onLeave(() => document.getElementById('page-title')?.removeEventListener('click', onRecTitle));
  /** The record browser's heading: "Journals / <file>", keeping the list's own to come back to. */
  function recordsHead(name: string): void {
    const title = document.getElementById('page-title');
    const sub = document.getElementById('page-subtitle');
    savedHead ??= { title: title?.innerHTML ?? 'Journals', sub: sub && !sub.hidden ? sub.innerHTML : '' };
    ctx.heading(`${rootCrumb()}${CRUMB_SEP}<span class="od-crumb-here od-crumb-here--mono">${esc(name)}</span>`, '');
  }
  type OpEl = HTMLElement & { options: unknown; value: string };
  const setRecInputs = (): void => {
    ($('#jrn-rec-global') as HTMLElement & { value: string }).value = recGlobal;
    ($('#jrn-rec-pid') as HTMLElement & { value: string }).value = recPid;
    opLabelsSig = '';
    renderOpCounts();
  };
  /** Keep what the list showed (rows, filters, scroll: no values), for Back to it. */
  const rememberRecords = (): void => {
    if (recFile && recRows.length && !recError) {
      recMemo = { file: recFile, rows: recRows, end: recEnd, global: recGlobal, pid: recPid, op: recOp, sig: recMatchSig, scroll: recScrollTop };
    }
  };
  /** Open a file's records; `at` selects a record once it's in (Back to "<file>/records/at/<address>"). */
  function openRecords(file: string, at: number | null = null): void {
    if (file !== recFile) { opCountsKnown = null; opMinWidth = 0; }
    recFile = file;
    recordsHead(baseName(file));
    mainEl.hidden = true;
    recEl.hidden = false;
    if (at === null) syncParam(); // with a record named, the address already says where this is
    syncSwitch();
    const memo = recMemo?.file === file ? recMemo : null;
    if (memo && at !== null) {
      // Back to a list already read: the same rows, filters and scroll, with the record selected again.
      ++recGen;
      recRows = memo.rows.slice(); recEnd = memo.end; recMatchSig = memo.sig;
      recGlobal = memo.global; recPid = memo.pid; recOp = memo.op;
      recBusy = false; recScan = 0; recError = '';
      setRecInputs();
      renderRecords();
      recScrollTop = memo.scroll;
      const k = String(at);
      if (recRows.some((r) => String(r.Address) === k)) { recScrollBack = true; void recOd.select(rowKeyOf(k)); }
      else restoreScroll(memo.scroll);
      return;
    }
    recGlobal = ''; recPid = ''; recOp = 'all';
    setRecInputs();
    recScrollTop = 0;
    recPendingAt = at !== null ? String(at) : null;
    void loadRecords(true);
  }
  /** Back to the file list; `sync` false leaves the address alone (a records link that couldn't be opened). */
  function closeRecords(sync = true): void {
    rememberRecords();
    ++recGen;
    void recOd.select(null);
    recShown = null; recReveal.clear(); recRows = []; recError = ''; recExtra.clear(); recBusy = false; recScan = 0; recPendingAt = null;
    if (recGrid) recGrid.rows = [];
    recEl.hidden = true;
    mainEl.hidden = false;
    if (savedHead) ctx.heading(savedHead.title, savedHead.sub);
    savedHead = null;
    recFile = '';
    if (sync) syncParam();
    syncSwitch();
  }
  let recTimer: ReturnType<typeof setTimeout> | null = null;
  /** Typing waits a moment before reading again; a click applies at once. */
  const refilter = (typed: boolean): void => {
    if (recTimer) clearTimeout(recTimer);
    recTimer = setTimeout(applyRecFilters, typed ? 500 : 0);
  };
  $('#jrn-rec-global').addEventListener('ev-search-input', (e) => { recGlobal = (e as CustomEvent<{ value: string }>).detail.value.trim(); refilter(true); });
  $('#jrn-rec-pid').addEventListener('ev-search-input', (e) => { recPid = String((e as CustomEvent<{ value: string }>).detail.value ?? '').replace(/\D/g, ''); refilter(true); });
  $('#jrn-rec-op').addEventListener('ev-segmented-button-change', (e) => { recOp = (e as CustomEvent<{ value: string }>).detail.value; refilter(false); });
  $('#jrn-rec-more').addEventListener('click', () => void loadRecords(false));
  $('#jrn-rec-stop').addEventListener('click', stopReading);
  ctx.onLeave(() => { rememberRecords(); ++recGen; recShown = null; recReveal.clear(); if (recTimer) clearTimeout(recTimer); });

  // ── Actions ──
  const runCheck = async (f: JournalFile): Promise<void> => {
    checks.set(f.Name, { state: 'running', at: new Date(), details: true });
    void renderDetail();
    try {
      await checkJournalFile(f.Name, true);
      checks.set(f.Name, { state: 'ok', at: new Date(), details: true });
      toast(`${baseName(f.Name)}: no problems found.`);
    } catch (err) {
      const gone = err instanceof AdminError && err.status === 404;
      checks.set(f.Name, { state: 'failed', at: new Date(), details: true, message: gone ? 'This file is no longer on disk.' : errorText(err) });
      toast(gone ? `${baseName(f.Name)} is no longer on disk.` : `${baseName(f.Name)}: ${errorText(err)}`, 'danger');
      if (gone) await load();
    }
    if (alive && selected === f.Name) void renderDetail();
  };

  const run = async (work: () => Promise<{ CurrentFile: string }>, done: (file: string) => string): Promise<void> => {
    busy = true;
    renderFacts();
    if (selected) void renderDetail();
    try {
      const r = await work();
      toast(done(r?.CurrentFile ? baseName(r.CurrentFile) : 'a new file'));
    } catch (err) {
      toast(errorText(err), 'danger');
    } finally {
      busy = false;
      await load();
    }
  };

  async function doSwitchFile(): Promise<void> {
    if (!settings) return;
    const cur = current();
    const use = inUse();
    const low = Number.isFinite(use.free) && use.free < settings.FileSizeLimit * 2;
    const ok = await confirm({
      title: 'Switch to a new journal file?',
      body: `<p>IRIS closes ${cur ? `<b class="mono">${esc(baseName(cur.Name))}</b> (${esc(dataSize(bytesToMb(cur.Size)))})` : 'the current file'} and starts writing a new one in <span class="mono">${esc(currentDir())}</span>.</p>
        <p>Nothing is lost: open transactions carry on in the new file, and the closed file ${settings.CompressFiles ? 'is compressed and ' : ''}kept until the purge rules remove it. Switching is common before a backup, or to hand a complete file to someone.</p>
        ${low ? `<p><b>The journal disk has ${esc(dataSize(use.free))} free.</b> A new file starts small, but it grows to ${esc(dataSize(settings.FileSizeLimit))}.</p>` : ''}`,
      confirmLabel: 'Switch file',
    });
    if (ok) await run(switchJournalFile, (file) => `Journal switched. IRIS is now writing to ${file}.`);
  }

  async function doSwitchDir(): Promise<void> {
    if (!settings || sameDirs()) return;
    const toAlt = !onAlternate();
    const from = toAlt ? settings.CurrentDirectory : settings.AlternateDirectory;
    const to = toAlt ? settings.AlternateDirectory : settings.CurrentDirectory;
    const word = toAlt ? 'alternate' : 'primary';
    const target = toAlt ? alternate() : primary();
    const sameDisk = driveOf(from) && driveOf(from) === driveOf(to);
    const ok = await confirm({
      title: `Switch journaling to the ${word} directory?`,
      body: `<p>This switches journaling to another directory. IRIS closes the file in use and writes every new journal file to <span class="mono">${esc(to)}</span> instead of <span class="mono">${esc(from)}</span>, until someone switches back.</p>
        <p>${Number.isFinite(target.free) ? `That directory’s disk has <b>${esc(dataSize(target.free))}</b> free${Number.isFinite(target.pct) ? ` (${esc(dataPct(target.pct))} full)` : ''}.` : 'Its free space isn’t known.'}${sameDisk ? ' It is on the same disk as the current directory, so this doesn’t free any space.' : ''}</p>
        <p>Restores and backups then need journal files from both directories.</p>`,
      confirmLabel: `Switch to ${word}`,
      danger: true,
      typeToConfirm: word,
    });
    if (ok) await run(switchJournalDir, (file) => `Journaling moved to the ${word} directory. IRIS is now writing to ${file}.`);
  }

  // ── Settings: the form in the side panel ──
  const leaveEditor = (): void => {
    ctx.beforeLeave(null);
    editor?.close();
    editor = null;
    restoreWidth?.();
    restoreWidth = null;
    mainEl.classList.remove('jrn-main--editing');
  };
  /** Back to what the panel showed before the form: the selected file's panel, or nothing. */
  const afterEditor = (): void => {
    shownHtml = '';
    if (selected && files.some((f) => f.Name === selected)) void renderDetail();
    else { selected = null; grid?.select([]); setPanel(false); }
  };
  ctx.onLeave(() => { editor?.close(); editor = null; });

  type SettingsForm = {
    cur: string; useAlt: boolean; alt: string; prefix: string; size: string; days: string; backups: string;
    compress: boolean; freeze: boolean; purgeArchived: boolean; csp: boolean;
  };
  type SettingsRisk = { title: string; text: string; danger?: boolean };
  /** A whole number typed in a field, or null. */
  const whole = (t: string): number | null => (/^\d+$/.test(t) ? Number(t) : null);
  const onOff = (b: boolean): string => (b ? 'on' : 'off');
  const purgeText = (days: number, backups: number): string => purgeWords({ DaysBeforePurge: days, BackupsBeforePurge: backups } as JournalSettings).value;
  /** Letters, digits, "_", "-" and "." only: the prefix becomes part of every journal file name. */
  const PREFIX_OK = /^[A-Za-z0-9_.-]*$/;

  async function openSettings(): Promise<void> {
    if (!settings || !canManage) return;
    if (editor) { scrollPanelTop(detail); return; }
    const s: JournalSettings = { ...settings };
    const L = JOURNAL_LIMITS;
    const noArchive = !s.ArchiveName;
    /** IRIS has no "none": an alternate directory equal to the primary means there isn't one. */
    const hadAlt = !!s.AlternateDirectory && !samePath(s.CurrentDirectory, s.AlternateDirectory);
    // The settings are the instance's, not a file's: no file stays selected behind the form.
    selected = null; shownHtml = ''; grid?.select([]); syncParam(); renderVolume();
    setPanel(true);
    // The form takes the page's height: the chart steps aside while it's open.
    mainEl.classList.add('jrn-main--editing');
    // The form takes the peek's width, so the list beside it doesn't move when one replaces the other.
    restoreWidth ??= panelWidth(panel, panelNow());

    const sections =
      section('Where', pathField('CurrentDirectory', 'Primary directory', s.CurrentDirectory, {
        mode: 'dir', required: true, title: 'Choose the primary journal directory', pickerId: 'journal.current',
        hint: 'Where IRIS writes journal files.',
      }) + checkField('UseAlternate', 'Use an alternate directory', hadAlt, {
        toggle: true, hint: 'Where IRIS writes if the primary fills or fails. Best on another disk.',
      }) + pathField('AlternateDirectory', 'Alternate directory', hadAlt ? s.AlternateDirectory : '', {
        mode: 'dir', title: 'Choose the alternate journal directory', pickerId: 'journal.alternate',
      }))
      + section('Files', `<div class="crud-row">
          ${textField('FileSizeLimit', 'Start a new file at (MB)', String(s.FileSizeLimit), { mono: true, required: true, hint: `${L.FileSizeLimit.min}–${num(L.FileSizeLimit.max)} MB.` })}
          ${textField('JournalFilePrefix', 'File name prefix', s.JournalFilePrefix, { mono: true, maxlength: L.JournalFilePrefix.maxlen, placeholder: 'None', hint: 'Optional. Letters, digits, _ - and . only.' })}
        </div>
        ${checkField('CompressFiles', 'Compress closed files', s.CompressFiles, { toggle: true, hint: 'Saves disk space. Compressed files are read as usual.' })}`)
      + section('Purge', `<div class="crud-row">
          ${textField('DaysBeforePurge', 'After days', String(s.DaysBeforePurge), { mono: true, required: true, hint: `${L.DaysBeforePurge.min}–${L.DaysBeforePurge.max}. 0: not by age.` })}
          ${textField('BackupsBeforePurge', 'After backups', String(s.BackupsBeforePurge), { mono: true, required: true, hint: `${L.BackupsBeforePurge.min}–${L.BackupsBeforePurge.max}. 0: not by backups.` })}
        </div>
        ${checkField('PurgeArchived', 'Purge files once they are archived', s.PurgeArchived, {
          toggle: true, disabled: noArchive && !s.PurgeArchived,
          hint: noArchive ? 'No archive is set for journal files, so this has no effect.' : `Archived to ${s.ArchiveName}. Only the archived copies are kept.`,
        })}`, { hint: 'Files go at whichever comes first. Files IRIS still needs, such as those of an open transaction, are kept.' })
      + section('If journaling fails', checkField('FreezeOnError', 'Freeze updates until journaling works again', s.FreezeOnError, {
        toggle: true, hint: 'On: no change is lost, but updates wait until someone fixes it. Off: IRIS carries on, and changes made after the failure can’t be recovered after a crash.',
      }))
      + section('Web sessions', checkField('JournalcspSession', 'Journal web session data', s.JournalcspSession, {
        toggle: true,
        hint: 'Off (the default): web sessions live in temporary storage and end when IRIS restarts. On: they survive a restart and follow a failover.',
      }));

    const read = (): SettingsForm => {
      const v = readForm(detail);
      const t = (k: string): string => String(v[k] ?? '').trim();
      return {
        cur: t('CurrentDirectory'), useAlt: v.UseAlternate === true, alt: t('AlternateDirectory'), prefix: t('JournalFilePrefix'),
        size: t('FileSizeLimit'), days: t('DaysBeforePurge'), backups: t('BackupsBeforePurge'),
        compress: v.CompressFiles === true, freeze: v.FreezeOnError === true,
        purgeArchived: v.PurgeArchived === true, csp: v.JournalcspSession === true,
      };
    };
    /** Every value that can't be saved as typed, with the field it belongs to. */
    const problemsOf = (f: SettingsForm): FieldProblem[] => {
      const out: FieldProblem[] = [];
      if (!f.cur) out.push({ field: 'CurrentDirectory', label: 'Primary directory', message: 'Enter the directory IRIS writes journal files to' });
      if (f.useAlt && !f.alt) out.push({ field: 'AlternateDirectory', label: 'Alternate directory', message: 'Choose a directory, or turn the alternate directory off' });
      else if (f.useAlt && f.cur && samePath(f.alt, f.cur)) out.push({ field: 'AlternateDirectory', label: 'Alternate directory', message: 'Choose a directory other than the primary' });
      const range = (field: 'FileSizeLimit' | 'DaysBeforePurge' | 'BackupsBeforePurge', label: string, text: string, unit = ''): void => {
        const lim = L[field];
        const n = whole(text);
        if (n === null) out.push({ field, label, message: `Enter a whole number from ${lim.min} to ${num(lim.max)}${unit}` });
        else if (n < lim.min || n > lim.max) out.push({ field, label, message: `Must be ${lim.min}–${num(lim.max)}${unit}` });
      };
      range('FileSizeLimit', 'Start a new file at', f.size, ' MB');
      range('DaysBeforePurge', 'Purge after days', f.days);
      range('BackupsBeforePurge', 'Purge after backups', f.backups);
      if (f.prefix.length > L.JournalFilePrefix.maxlen) out.push({ field: 'JournalFilePrefix', label: 'File name prefix', message: `${L.JournalFilePrefix.maxlen} characters at most` });
      else if (!PREFIX_OK.test(f.prefix)) out.push({ field: 'JournalFilePrefix', label: 'File name prefix', message: 'Letters, digits, _ - and . only' });
      return out;
    };
    const check = (): FieldProblem[] => problemsOf(read());
    /** Only what differs from the settings the form opened with; values that fail the checks are left out. */
    const patchOf = (f: SettingsForm, bad = new Set(problemsOf(f).map((x) => x.field))): JournalSettingsPatch => {
      const p: JournalSettingsPatch = {};
      const ok = (k: string): boolean => !bad.has(k);
      if (ok('CurrentDirectory') && !samePath(f.cur, s.CurrentDirectory)) p.CurrentDirectory = f.cur;
      // No alternate directory is saved as the primary's own path.
      const newCur = p.CurrentDirectory ?? s.CurrentDirectory;
      const alt = f.useAlt ? f.alt : newCur;
      if (ok('AlternateDirectory') && alt && !samePath(alt, s.AlternateDirectory || s.CurrentDirectory)) p.AlternateDirectory = alt;
      if (ok('JournalFilePrefix') && f.prefix !== s.JournalFilePrefix) p.JournalFilePrefix = f.prefix;
      const size = whole(f.size);
      if (ok('FileSizeLimit') && size !== null && size !== s.FileSizeLimit) p.FileSizeLimit = size;
      const days = whole(f.days);
      if (ok('DaysBeforePurge') && days !== null && days !== s.DaysBeforePurge) p.DaysBeforePurge = days;
      const backups = whole(f.backups);
      if (ok('BackupsBeforePurge') && backups !== null && backups !== s.BackupsBeforePurge) p.BackupsBeforePurge = backups;
      if (f.compress !== s.CompressFiles) p.CompressFiles = f.compress;
      if (f.freeze !== s.FreezeOnError) p.FreezeOnError = f.freeze;
      if (f.purgeArchived !== s.PurgeArchived) p.PurgeArchived = f.purgeArchived;
      if (f.csp !== s.JournalcspSession) p.JournalcspSession = f.csp;
      return p;
    };

    /** An alternate directory in words: "none" when it's the primary's own path. */
    const altWords = (alt: string, cur: string): string => (!alt || samePath(alt, cur) ? 'none' : alt);
    /** Each change as "Name: before → after". */
    const changeLines = (p: JournalSettingsPatch): string[] => {
      const lines: string[] = [];
      if (p.CurrentDirectory !== undefined) lines.push(`Primary directory: ${s.CurrentDirectory} → ${p.CurrentDirectory}`);
      if (p.AlternateDirectory !== undefined) {
        const was = altWords(s.AlternateDirectory, s.CurrentDirectory);
        const now = altWords(p.AlternateDirectory, p.CurrentDirectory ?? s.CurrentDirectory);
        if (was !== now) lines.push(`Alternate directory: ${was} → ${now}`);
      }
      if (p.FileSizeLimit !== undefined) lines.push(`New file at: ${dataSize(s.FileSizeLimit)} → ${dataSize(p.FileSizeLimit)}`);
      if (p.JournalFilePrefix !== undefined) lines.push(`File name prefix: ${s.JournalFilePrefix || 'none'} → ${p.JournalFilePrefix || 'none'}`);
      if (p.CompressFiles !== undefined) lines.push(`Compress closed files: ${onOff(s.CompressFiles)} → ${onOff(p.CompressFiles)}`);
      if (p.DaysBeforePurge !== undefined || p.BackupsBeforePurge !== undefined) {
        lines.push(`Purged: ${purgeText(s.DaysBeforePurge, s.BackupsBeforePurge)} → ${purgeText(p.DaysBeforePurge ?? s.DaysBeforePurge, p.BackupsBeforePurge ?? s.BackupsBeforePurge)}`);
      }
      if (p.PurgeArchived !== undefined) lines.push(`Purge once archived: ${onOff(s.PurgeArchived)} → ${onOff(p.PurgeArchived)}`);
      if (p.FreezeOnError !== undefined) lines.push(`If journaling fails: ${s.FreezeOnError ? 'freeze updates' : 'carry on'} → ${p.FreezeOnError ? 'freeze updates' : 'carry on'}`);
      if (p.JournalcspSession !== undefined) lines.push(`Journal web session data: ${onOff(s.JournalcspSession)} → ${onOff(p.JournalcspSession)}`);
      return lines;
    };
    /** What the change puts at risk; `danger` marks what weakens recovery. */
    const risksOf = (p: JournalSettingsPatch): SettingsRisk[] => {
      const out: SettingsRisk[] = [];
      const cur = p.CurrentDirectory ?? s.CurrentDirectory;
      const alt = p.AlternateDirectory ?? s.AlternateDirectory;
      if (p.CurrentDirectory !== undefined) {
        out.push({ danger: true, title: 'Journaling moves to another directory',
          text: `IRIS writes new journal files to ${p.CurrentDirectory}. Files already written stay in ${s.CurrentDirectory}, so a restore needs both until they are purged. The directory must exist and have room.` });
      }
      if (samePath(cur, alt) && hadAlt) {
        out.push({ danger: true, title: 'There is no alternate directory any more', text: 'If the primary fills or fails, IRIS has nowhere else to write.' });
      } else if ((p.CurrentDirectory !== undefined || p.AlternateDirectory !== undefined) && !samePath(cur, alt) && driveOf(cur) && driveOf(cur) === driveOf(alt)) {
        out.push({ title: 'Both directories are on the same disk', text: 'A full or failed disk stops both.' });
      }
      if (p.FreezeOnError === false) {
        out.push({ danger: true, title: 'If journaling fails, IRIS carries on without it', text: 'Changes made after the failure can’t be recovered after a crash.' });
      } else if (p.FreezeOnError === true) {
        out.push({ title: 'If journaling fails, updates freeze', text: 'No change is lost, but updates to journaled databases wait until someone fixes journaling.' });
      }
      const days = p.DaysBeforePurge ?? s.DaysBeforePurge;
      const backups = p.BackupsBeforePurge ?? s.BackupsBeforePurge;
      if (days <= 0 && backups <= 0 && (s.DaysBeforePurge > 0 || s.BackupsBeforePurge > 0)) {
        out.push({ title: 'Journal files will never be purged', text: 'They pile up until someone deletes them, and will eventually fill the disk.' });
      } else if ((p.DaysBeforePurge !== undefined && days > 0 && (s.DaysBeforePurge <= 0 || days < s.DaysBeforePurge))
        || (p.BackupsBeforePurge !== undefined && backups > 0 && (s.BackupsBeforePurge <= 0 || backups < s.BackupsBeforePurge))) {
        out.push({ title: 'Journal files are purged sooner', text: 'Older files are deleted at the next purge. A restore can only replay journal files still on disk.' });
      }
      if (p.PurgeArchived === true) out.push({ title: 'Files are purged once archived', text: 'Only the archived copies are kept.' });
      if (p.CompressFiles === false) out.push({ title: 'Closed files stay uncompressed', text: 'They take more disk space.' });
      if (p.FileSizeLimit !== undefined && p.FileSizeLimit > s.FileSizeLimit) {
        const use = inUse();
        if (Number.isFinite(use.free) && use.free < p.FileSizeLimit * 2) out.push({ title: 'The journal disk is short of room', text: `Each file can grow to ${dataSize(p.FileSizeLimit)}, and the disk has ${dataSize(use.free)} free.` });
      }
      return out;
    };
    const noteHtml = (r: SettingsRisk): string =>
      `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>${esc(r.title)}.</strong> ${esc(r.text)}</div></div>`;

    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    const ed = editorShell(detail, {
      title: 'Journal settings',
      name: 'the journal settings',
      submitLabel: 'Save settings',
      sections,
      check,
      // A value that can't be saved still counts as a change (leaving asks first), and it blocks Save.
      changed: () => { const f = read(); return Object.keys(patchOf(f)).length > 0 || problemsOf(f).length > 0; },
      onSubmit: async () => {
        const f = read();
        if (problemsOf(f).length) throw new Error('Fix the values marked in red first.');
        const p = patchOf(f);
        if (!Object.keys(p).length) throw new Error('Nothing to save.');
        const risks = risksOf(p);
        const danger = risks.some((r) => r.danger);
        const lines = changeLines(p);
        const moving = p.CurrentDirectory !== undefined;
        const ok = await confirm({
          title: moving ? 'Move journaling to another directory?' : danger ? 'Save settings that weaken recovery?' : 'Save journal settings?',
          body: `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
            ${risks.length ? `<ul class="risk-list">${risks.map((r) => `<li><b>${esc(r.title)}.</b> ${esc(r.text)}</li>`).join('')}</ul>` : ''}`,
          confirmLabel: danger ? 'Save anyway' : 'Save settings',
          danger,
          typeToConfirm: moving ? 'move' : undefined,
        });
        if (!ok) {
          toast('Not saved. Your changes are still here.', 'info');
          throw new SubmitCancelled();
        }
        await saveJournalSettings(p);
        leaveEditor();
        toast(`Journal settings saved (${plural(lines.length, 'change')}).`);
        await load();
        afterEditor();
      },
      onCancel: () => { leaveEditor(); afterEditor(); },
    });
    editor = ed;

    // One status line in the button row: "1 change · 1 warning · 1 to fix". The count opens "What changes"
    // (the list and its warnings), pinned just above the buttons; "to fix" goes to the field.
    const foot = ed.form.querySelector<HTMLElement>('.crud-editor-foot');
    const submit = ed.form.querySelector<HTMLElement>('.crud-submit');
    const footHint = ed.form.querySelector<HTMLElement>('.crud-foot-hint');
    const sum = document.createElement('div');
    sum.className = 'jrn-sum';
    sum.id = 'jrn-sum';
    sum.hidden = true;
    sum.innerHTML = '<div class="jrn-preview" id="jrn-preview"></div>';
    foot?.before(sum);
    const preview = sum.querySelector('#jrn-preview') as HTMLElement;
    // A press on the line's buttons keeps focus where it is: moving it out of a field re-checks the form,
    // which redraws the line and would drop the button before its click lands.
    footHint?.addEventListener('mousedown', (e) => { if ((e.target as Element).closest('button')) e.preventDefault(); });
    footHint?.addEventListener('click', (e) => {
      if (!(e.target as Element).closest('[data-jrn-sum]')) return;
      sum.hidden = !sum.hidden;
      live();
    });
    const altField = detail.querySelector<HTMLElement>('[data-field="AlternateDirectory"]');

    /** Which fields differ from what the form opened with (a subtle mark beside each). */
    const FIELD_OF: Record<keyof JournalSettingsPatch, string> = {
      CurrentDirectory: 'CurrentDirectory', AlternateDirectory: 'AlternateDirectory', FileSizeLimit: 'FileSizeLimit', DaysBeforePurge: 'DaysBeforePurge',
      BackupsBeforePurge: 'BackupsBeforePurge', CompressFiles: 'CompressFiles', FreezeOnError: 'FreezeOnError', JournalFilePrefix: 'JournalFilePrefix',
      PurgeArchived: 'PurgeArchived', JournalcspSession: 'JournalcspSession',
    };
    let flagged = new Set<string>();
    const live = (): void => {
      if (editor !== ed) return;
      const f = read();
      if (altField) altField.hidden = !f.useAlt;
      const problems = problemsOf(f);
      const p = patchOf(f, new Set(problems.map((x) => x.field)));
      // Errors as the user types: under the field, and Save stays off until they're fixed.
      const now = new Set(problems.map((x) => x.field));
      for (const k of flagged) if (!now.has(k)) fieldError(detail, k, null);
      for (const x of problems) fieldError(detail, x.field, x.message);
      flagged = now;
      ed.refresh();
      if (problems.length && submit) setBlocked(submit, `Fix ${problems.map((x) => x.label.toLowerCase()).join(', ')} first`);
      // Edited fields.
      const changed = new Set<string>(Object.keys(p).map((k) => FIELD_OF[k as keyof JournalSettingsPatch]));
      for (const x of problems) changed.add(x.field);
      if (f.useAlt !== hadAlt) changed.add('UseAlternate');
      detail.querySelectorAll<HTMLElement>('.crud-editor-body [data-field]').forEach((el) => el.toggleAttribute('data-jrn-changed', changed.has(el.dataset.field ?? '')));
      // The status line. A field changed to a value that can't be saved is still a change (and one to
      // fix), so the count, "to fix" and the discard prompt ("Your changes haven't been saved") agree.
      const lines = changeLines(p);
      const risks = risksOf(p);
      const count = lines.length + problems.length;
      const any = lines.length + risks.length > 0;
      if (!any) sum.hidden = true;
      const parts: string[] = [];
      parts.push(!count ? 'No changes'
        : any ? `<button type="button" class="crud-foot-link" data-jrn-sum aria-expanded="${!sum.hidden}" aria-controls="jrn-sum" title="${sum.hidden ? 'Show what changes' : 'Hide what changes'}">${esc(plural(count, 'change'))}</button>`
          : esc(plural(count, 'change')));
      if (risks.length) parts.push(`<span class="jrn-sum-warn">${esc(plural(risks.length, 'warning'))}</span>`);
      if (problems.length) parts.push(`<button type="button" class="crud-foot-link jrn-sum-bad" data-crud-goto="${esc(problems[0].field)}" title="${esc(`Go to ${problems.map((x) => x.label).join(', ')}`)}">${esc(`${num(problems.length)} to fix`)}</button>`);
      if (footHint) footHint.innerHTML = parts.join('<span class="meta-sep">·</span>');
      preview.innerHTML = any
        ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${risks.map(noteHtml).join('')}`
        : '';
      if (foot) sum.style.setProperty('--jrn-foot-h', `${foot.offsetHeight}px`);
    };
    // After the editor's own checks (a microtask), so its refresh doesn't undo the block on Save.
    const onChange = (): void => { setTimeout(live, 0); };
    // Every event the editor refreshes on (crud.ts CHANGE_EVENTS), so its refresh never has the last word.
    for (const t of ['input', 'change', 'ev-input-input', 'ev-input-change', 'ev-checkbox-change', 'ev-toggle-change', 'focusout']) ed.form.addEventListener(t, onChange);
    live();
    requestAnimationFrame(() => setTimeout(live, 0));
  }

  // Header: "Switch journal file", then "Edit settings" (made first, so the switch lands ahead of it).
  const settingsBtn = newButton(ctx, 'Edit settings', () => void openSettings());
  settingsBtn.setHidden(true);
  const switchBtn = newButton(ctx, 'Switch journal file', () => void doSwitchFile());
  // Blue primary is for creating things; switching files is an operation, so the button is secondary.
  switchBtn.el.classList.remove('btn--primary');
  switchBtn.el.querySelector('ev-icon')?.remove();
  /** A page action for the file list: hidden in the record browser. */
  const syncSwitch = (): void => {
    switchBtn.setHidden(!canOperate || !files.length || !recEl.hidden);
    settingsBtn.setHidden(!settings || !recEl.hidden);
    settingsBtn.setBlocked(canManage ? null : NO_MANAGE);
  };

  void sessionInfo().then((info) => {
    canOperate = can(info, 'Operate') !== false;
    canManage = can(info, 'Manage') !== false;
    syncSwitch();
    if (!alive) return;
    if (loaded) renderBanner();
    renderFacts();
    if (selected) { shownHtml = ''; void renderDetail(); }
  }).catch(() => { /* keep defaults: IRIS still refuses what it must */ });

  const renderAll = (): void => {
    if (!loaded) return;
    renderBanner();
    renderFacts();
    renderFoot();
    renderGrid();
    renderVolume();
    void fillDetails();
    if (selected) void renderDetail(selected === files[0]?.Name);
  };

  // ── Loading ──
  const updated = liveIndicator(ctx, () => { void metrics.refresh(); void load(); });
  const load = async (): Promise<void> => {
    try {
      const [s, f, c] = await Promise.all([getJournalSettings(), getJournalFiles(), getDbConfigs().catch(() => configs)]);
      if (!alive) return;
      const switched = files[0]?.Name !== f[0]?.Name;
      settings = s;
      files = f;
      configs = c;
      if (switched) details.clear(); // the old current file now has a next file
      const first = !loaded;
      loaded = true;
      if (first) openLinked();
      syncSwitch();
      updated(new Date());
      renderAll();
    } catch (err) {
      if (!alive || loaded) return;
      if (!recEl.hidden) closeRecords(false); // a records link waits on the file list: show the error there
      grid = null;
      factsHtml = '';
      $('#jrn-facts').innerHTML = '';
      wrap.innerHTML = errorPanel(err, 'jrn-retry');
      wrap.querySelector('#jrn-retry')?.addEventListener('click', () => void load());
    }
  };
  ctx.onLeave(metrics.subscribe((sn) => { snap = sn; if (loaded) { renderBanner(); renderFacts(); } }, () => { /* free space waits for the next scrape */ }));

  ctx.body.querySelector('#jrn-search')?.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });

  /** Open what the address names, once the file list is in. A file no longer on disk leaves the list showing. */
  function openLinked(): void {
    if (!linked) return;
    const f = files.find((x) => baseName(x.Name).toLowerCase() === linked.file.toLowerCase());
    if (!f) {
      if (!recEl.hidden) closeRecords(false);
      toast(`${linked.file} is no longer on disk.`, 'danger');
      return;
    }
    selected = f.Name;
    if (linked.records) {
      openRecords(f.Name, linked.at);
      if (linked.address !== null) void openLinkedRecord(linked.address);
    }
  }
  // A records link shows the browser (its skeleton) straight away, not the list, until the files are in.
  if (linked?.records) {
    recordsHead(linked.file);
    mainEl.hidden = true;
    recEl.hidden = false;
  }

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
