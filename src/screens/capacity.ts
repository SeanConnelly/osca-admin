// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Databases › Capacity — the "disks" answer: every volume that holds IRIS
 * data, how full it is and what lives on it; every database's size, the
 * space left inside it, its size limit and how much room it has left to grow.
 *
 * Room to grow = the smaller of (size limit − size) and the free space on
 * its volume, which it shares with every other database and journal file
 * there. At risk: a volume over 85% (95% critical), a database within 10% of
 * its size limit, or one whose next growth step no longer fits.
 *
 * Read-only screen: database changes (size limits, expansion) belong to the
 * Databases screen and the Management Portal, which are linked.
 */
import '../styles-security.css';
import '../styles-disk.css';
import '../styles-db.css';
import {
  getDbDirs, getDbConfigs, getDbVolumes, getJournalSettings, getJournalFiles,
  samePath, baseName, dirName, driveOf, commonDir, bytesToMb, nextGrowth, openSelected, diskDocs, diskPortal,
  type LocalDbDir, type DbConfigRow, type VolumeFile, type JournalSettings, type JournalFile,
} from '../api-disk';
import { readDbInfo, cachedDbInfo, type DbInfo } from '../api-db';
import { apiAvailable, fsRoots, type FsRoot as OscaRoot } from '../api-osca';

/** A drive from the OSCA API's list; sample data also names its role ("Journals"). */
type FsRoot = OscaRoot & { role?: string };
import { metrics, samples, type Snapshot } from '../metrics';
import {
  plural, kv, mono, portalButton,
  esc, chip, cell, cellId, setSearch, exportButton, gridExport, skeleton, errorPanel, liveIndicator, num, dataSize, dataPct, when, irisDate, uniformKeys, emptyState,
  type ScreenCtx, type Tone, type GridColumn,
} from '../ui';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

type Filter = 'all' | 'risk' | 'limited';
type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const REFRESH_MS = 60_000;
const WARN = 85;
const CRIT = 95;

interface Db {
  name: string;
  dir: string;
  /** MB. */
  size: number;
  /** MB; 0 = no limit. */
  max: number;
  /** MB; 0 = IRIS's default (12%). */
  expansion: number;
  /** MB free inside the file; NaN when IRIS doesn't report it. */
  freeInside: number;
  status: string;
  mounted: boolean;
  readOnly: boolean;
  files: VolumeFile[];
  volKey: string;
}
interface Volume {
  key: string;
  label: string;
  /** MB. */
  free: number;
  /** MB; NaN when the percentage full isn't known. */
  total: number;
  used: number;
  dbs: Db[];
  /** MB of journal files and the write image journal on this volume. */
  journal: number;
  wij: number;
  /** A drive the server has that holds no IRIS files. */
  empty?: boolean;
  /** Its drive in the OSCA API's list, when known. */
  rootPath?: string;
}
interface Risk { tone: 'danger' | 'warning'; title: string; text: string; db?: string; vol?: string }

const band = (v: number): Tone => (!Number.isFinite(v) ? 'neutral' : v >= CRIT ? 'danger' : v >= WARN ? 'warning' : 'success');
const para = (html: string): string => `<p class="disk-text">${html}</p>`;

/** Room to grow and what limits it; NaN when the database doesn't grow (read-only or not mounted). */
function roomOf(d: Db, v: Volume | undefined): { room: number; by: 'limit' | 'disk' | '' } {
  if (d.readOnly || !d.mounted) return { room: NaN, by: '' };
  const disk = v ? v.free : NaN;
  if (d.max > 0) {
    const toLimit = Math.max(0, d.max - d.size);
    return !Number.isFinite(disk) || toLimit <= disk ? { room: toLimit, by: 'limit' } : { room: disk, by: 'disk' };
  }
  return { room: disk, by: 'disk' };
}

/** A database's own risk (the volume's is reported once, for the volume). */
function dbRisk(d: Db, v: Volume | undefined): Risk | null {
  if (d.readOnly || !d.mounted) return null;
  const step = nextGrowth(d.size, d.expansion);
  const free = Number.isFinite(d.freeInside) ? d.freeInside : 0;
  if (d.max > 0) {
    const toLimit = d.max - d.size;
    if (toLimit + free < step) {
      return { tone: 'danger', db: d.name, title: `${d.name} is at its size limit`,
        text: `It uses ${dataSize(d.size)} of its ${dataSize(d.max)} limit and can’t grow again, so writes that need more space will fail. Raise the limit or free space inside it.` };
    }
    if (d.size / d.max >= 0.9) {
      return { tone: 'warning', db: d.name, title: `${d.name} is near its size limit`,
        text: `It uses ${dataSize(d.size)} of its ${dataSize(d.max)} limit (${dataPct((d.size / d.max) * 100)}).` };
    }
  }
  if (v && Number.isFinite(v.free) && v.free < step && free < step) {
    return { tone: 'danger', db: d.name, title: `${d.name} can’t grow: ${v.label} is out of space`,
      text: `Its next growth needs ${dataSize(step)}, and ${v.label} has ${dataSize(v.free)} free.` };
  }
  return null;
}

function volumeRisk(v: Volume): Risk | null {
  if (v.empty) return null; // not IRIS's disk: its space is someone else's concern
  const p = (v.used / v.total) * 100;
  if (!Number.isFinite(p) || p < WARN) return null;
  const what = [v.dbs.length ? plural(v.dbs.length, 'database') : '', v.journal ? 'journal files' : ''].filter(Boolean).join(' and ');
  return {
    tone: p >= CRIT ? 'danger' : 'warning', vol: v.key,
    title: `${v.label} is ${dataPct(p)} full`,
    text: `${dataSize(v.free)} is left for ${what || 'IRIS data'}. When it fills, databases stop growing${v.journal ? ' and journaling stops' : ''}.`,
  };
}

export function capacityScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <section class="disk-summary" aria-label="Disk space at a glance">
      <div class="disk-vols" id="cap-vols">${skeleton(2)}</div>
    </section>
    <div class="toolbar-row" id="cap-toolbar">
      <div class="search-box"><ev-search id="cap-search" size="sm" full-width placeholder="Filter by database or directory" aria-label="Filter databases"></ev-search></div>
      <ev-segmented-button id="cap-filter" size="sm" aria-label="Which databases"></ev-segmented-button>
      <div class="toolbar-spacer"></div>
      <span id="cap-vol-scope" class="disk-scope"></span>
    </div>
    <ev-detail-panel id="cap-panel" detail-width="380" overlay-below="960" class="workspace disk-workspace">
      <div class="grid-wrap" id="cap-wrap">${skeleton(9)}</div>
      <aside slot="detail" class="detail" id="cap-detail" aria-label="Database space"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="cap-foot"></p>`;
  // Export: the database list as shown (visible columns, current sort).
  // A page action, in the header, so the summary strip sits directly on the table.
  ctx.actions.append(exportButton(() => gridExport(ctx.body.querySelector('#cap-wrap ev-data-grid'), 'capacity')));

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#cap-panel');
  const wrap = $('#cap-wrap');
  const detail = $('#cap-detail');
  const filterEl = $<HTMLElement & { options: unknown; value: string }>('#cap-filter');
  const searchEl = $<HTMLElement & { value: string }>('#cap-search');
  filterEl.value = 'all';

  let alive = true;
  ctx.onLeave(() => { alive = false; });
  let dirs: LocalDbDir[] = [];
  let configs: DbConfigRow[] = [];
  let volFiles = new Map<string, VolumeFile[]>();
  let jset: JournalSettings | null = null;
  let jfiles: JournalFile[] = [];
  /** The server's drives with their size (OSCA API); [] when it isn't installed. */
  let roots: FsRoot[] = [];
  let snap: Snapshot | null = null;
  let dbs: Db[] = [];
  let vols: Volume[] = [];
  let loaded = false;
  let filter: Filter = 'all';
  let volFilter: string | null = null;
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let infoFor: { name: string; info: DbInfo | null; error: string } | null = null;
  /** Reads of the database figures in progress (first load or refresh). */
  let infoLoading = false;
  let shownHtml = '';
  let rowSig = '';

  // ── Model: databases and the volumes they live on ──
  const nameOf = (dir: string): string =>
    configs.find((c) => !c.Server && samePath(c.Directory, dir))?.Name ?? baseName(dir).toUpperCase();
  const metricAt = (name: string, dir: string): number => {
    const s = snap ? samples(snap, name).find((x) => x.labels.dir && samePath(x.labels.dir, dir)) : undefined;
    return s ? s.value : NaN;
  };
  const metricById = (name: string, id: string): number => {
    const s = snap ? samples(snap, name).find((x) => x.labels.id === id) : undefined;
    return s ? s.value : NaN;
  };
  /** Same drive letter, or (on Unix) the same free space to within 64 MB. */
  const keyFor = (path: string, free: number): string => driveOf(path) ?? `fs:${Number.isFinite(free) ? Math.round(free / 64) : path}`;

  const build = (): void => {
    const byKey = new Map<string, Volume & { paths: string[]; pcts: Array<{ pct: number; free: number }> }>();
    const volume = (path: string, free: number): Volume & { paths: string[]; pcts: Array<{ pct: number; free: number }> } => {
      const key = keyFor(path, free);
      let v = byKey.get(key);
      if (!v) {
        v = { key, label: driveOf(path) ?? '', free, total: NaN, used: NaN, dbs: [], journal: 0, wij: 0, paths: [], pcts: [] };
        byKey.set(key, v);
      }
      v.paths.push(path);
      if (Number.isFinite(free) && !Number.isFinite(v.free)) v.free = free;
      return v;
    };
    dbs = dirs.map((d) => {
      const name = nameOf(d.Directory);
      const files = volFiles.get(d.Directory) ?? [];
      // Disk free comes from the volume-files read, as on the Databases screen; the metric is only a fallback.
      const free = files[0]?.DiskFree ?? metricAt('iris_directory_space', d.Directory);
      const db: Db = {
        name, dir: d.Directory, size: Number(d.Size) || 0,
        max: typeof d.MaxSize === 'number' ? d.MaxSize : Number(d.MaxSize) || 0,
        expansion: metricById('iris_db_expansion_size_mb', name) || 0,
        freeInside: cachedDbInfo(d.Directory)?.AvailableSpace ?? NaN,
        status: d.Status, mounted: /^Mounted/i.test(d.Status), readOnly: /^Mounted\/R$/i.test(d.Status),
        files, volKey: '',
      };
      const v = volume(d.Directory, free);
      db.volKey = v.key;
      v.dbs.push(db);
      // % full and free space from the same scrape give the volume's total size.
      const p = metricAt('iris_disk_percent_full', d.Directory);
      const pFree = metricAt('iris_directory_space', d.Directory);
      if (Number.isFinite(p) && Number.isFinite(pFree)) v.pcts.push({ pct: p, free: pFree });
      return db;
    });
    // Journal files: sizes from the file list, by directory; free space from the journal metrics.
    const jdirs = new Map<string, number>();
    for (const f of jfiles) { const d = dirName(f.Name); jdirs.set(d, (jdirs.get(d) ?? 0) + bytesToMb(f.Size)); }
    if (jset) for (const d of [jset.CurrentDirectory, jset.AlternateDirectory]) if (d && ![...jdirs.keys()].some((k) => samePath(k, d))) jdirs.set(d, 0);
    for (const [d, mbUsed] of jdirs) {
      const s = snap ? samples(snap, 'iris_jrn_free_space').find((x) => x.labels.dir && samePath(x.labels.dir, d)) : undefined;
      const v = volume(d, s ? s.value : NaN);
      v.journal += mbUsed;
    }
    const wij = metricById('iris_jrn_size', 'WIJ');
    if (Number.isFinite(wij)) {
      const mgr = jset?.wijdir || dirs.find((d) => nameOf(d.Directory) === 'IRISSYS')?.Directory || dirs[0]?.Directory || '';
      if (mgr) volume(mgr, metricAt('iris_directory_space', mgr)).wij += wij;
    }
    vols = [...byKey.values()].map((v) => {
      const ref = v.pcts[0];
      if (ref && Number.isFinite(ref.free) && ref.pct < 100) {
        v.total = ref.free / (1 - ref.pct / 100);
        if (!Number.isFinite(v.free)) v.free = ref.free;
        v.used = Math.max(0, v.total - v.free);
      }
      if (!v.label) v.label = commonDir(v.paths);
      // No percentage from the databases (a journal-only drive, say): the drive's own size.
      const root = rootOf(v.paths);
      v.rootPath = root?.path;
      if (!Number.isFinite(v.total) && root?.totalBytes) {
        v.total = bytesToMb(root.totalBytes);
        if (!Number.isFinite(v.free) && root.freeBytes !== undefined) v.free = bytesToMb(root.freeBytes);
        v.used = Math.max(0, v.total - v.free);
      }
      return v;
    }).sort((a, b) => b.dbs.length - a.dbs.length || a.label.localeCompare(b.label));
    // Drives that hold no IRIS files, after the rest.
    for (const r of roots) {
      if (!r.totalBytes || r.path === '/' || r.type === 'allowed' || vols.some((v) => v.rootPath === r.path)) continue;
      const total = bytesToMb(r.totalBytes);
      const free = bytesToMb(r.freeBytes ?? NaN);
      vols.push({ key: `root:${r.path}`, label: driveOf(r.path) ?? r.path, free, total, used: Math.max(0, total - free), dbs: [], journal: 0, wij: 0, empty: true });
    }
    if (volFilter && !vols.some((v) => v.key === volFilter)) volFilter = null;
  };
  const volOf = (d: Db): Volume | undefined => vols.find((v) => v.key === d.volKey);
  /** The drive (or mounted root other than "/") holding all these paths, from the OSCA API's list. */
  function rootOf(paths: string[]): FsRoot | undefined {
    const inside = (p: string, r: FsRoot): boolean => p.toLowerCase().startsWith(r.path.toLowerCase());
    return roots.filter((r) => r.path !== '/' && r.type !== 'allowed' && paths.length > 0 && paths.every((p) => inside(p, r)))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }
  const risks = (): Risk[] => {
    const out: Risk[] = [];
    for (const v of vols) { const r = volumeRisk(v); if (r) out.push(r); }
    for (const d of dbs) { const r = dbRisk(d, volOf(d)); if (r) out.push(r); }
    return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'danger' ? -1 : 1));
  };
  const atRisk = (d: Db): boolean => !!dbRisk(d, volOf(d)) || !!(volOf(d) && volumeRisk(volOf(d)!));

  // ── Banner ──
  const renderBanner = (): void => {
    const list = risks();
    const top = list[0];
    if (!top) { ctx.banners.innerHTML = ''; return; }
    const rest = list.slice(1).map((r) => r.title);
    const count = dbs.filter(atRisk).length;
    // One line: the headline; the explanation (and any further risks) on hover.
    const tip = `${top.text}${rest.length ? ` Also: ${rest.join('; ')}.` : ''}`;
    ctx.banners.innerHTML = `<div class="sec-callout sec-callout--${top.tone} sec-banner disk-notice" role="status" title="${esc(tip)}">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <div><strong>${esc(top.title)}${rest.length ? ` <span class="disk-notice-more">+${rest.length} more</span>` : ''}</strong></div>
      ${count && filter !== 'risk' ? `<button type="button" class="link" data-cap-show>Show ${count === 1 ? 'it' : 'them'}</button>` : ''}
    </div>`;
    ctx.banners.querySelector('[data-cap-show]')?.addEventListener('click', () => { filter = 'risk'; filterEl.value = 'risk'; volFilter = null; renderAll(); });
  };

  // ── Volumes strip ──
  let volSig = '';
  /** A drive's role, when the server's drive list names one (sample data does; a real server doesn't). */
  const roleOf = (v: Volume): string => roots.find((r) => r.path === v.rootPath)?.role ?? '';
  const renderVolumes = (): void => {
    const host = $('#cap-vols');
    if (!vols.length) { host.innerHTML = `<p class="disk-vols-empty">No volume information yet.</p>`; volSig = ''; return; }
    const sig = vols.map((v) => v.key).join('|');
    // More than three drives: an even grid (2×2 for four, otherwise three across), the spare cell a summary.
    const n = vols.length;
    const across = n > 3 ? (n === 4 ? 2 : 3) : 0;
    const summary = across === 3 && n % 3 !== 0;
    if (sig !== volSig) {
      volSig = sig;
      // The top of the tile filters the grid; the "holds" line under it links to the screens for what it holds.
      host.innerHTML = vols.map((v) => `
        <div class="disk-vol" data-vol="${esc(v.key)}">
          <button type="button" class="disk-vol-main" aria-pressed="false" title="${v.empty ? `${esc(v.label)} holds no IRIS files` : `Show only the databases on ${esc(v.label)}`}">
            <span class="disk-vol-id">
              <span class="disk-vol-name mono"></span>
              <span class="disk-vol-role" hidden></span>
            </span>
            <span class="disk-bar" title="Flagged at ${WARN}%, critical at ${CRIT}%"><span class="cap-stack" role="img"><span class="cap-seg cap-seg--db"></span><span class="cap-seg cap-seg--jrn"></span><span class="cap-seg cap-seg--wij"></span><span class="cap-seg cap-seg--other"></span></span><span class="disk-tick" style="left:${WARN}%"></span><span class="disk-tick disk-tick--crit" style="left:${CRIT}%"></span><span class="disk-tick-label" style="left:${WARN}%" aria-hidden="true">${WARN}%</span><span class="disk-tick-label" style="left:${CRIT}%" aria-hidden="true">${CRIT}%</span></span>
            <span class="disk-vol-pct"></span>
          </button>
          <span class="cap-legend"></span>
        </div>`).join('') + (summary ? '<div class="disk-vol disk-vol--sum"><span class="k"></span><span class="s"></span></div>' : '');
      if (across) host.setAttribute('data-rows', String(across)); else host.removeAttribute('data-rows');
      host.querySelectorAll<HTMLElement>('[data-vol]').forEach((t) => t.querySelector('.disk-vol-main')?.addEventListener('click', () => {
        if (vols.find((v) => v.key === t.dataset.vol)?.empty) return; // no databases to show
        volFilter = volFilter === t.dataset.vol ? null : t.dataset.vol ?? null;
        renderAll();
      }));
    }
    for (const v of vols) {
      const el = host.querySelector<HTMLElement>(`[data-vol="${CSS.escape(v.key)}"]`);
      if (!el) continue;
      const p = (v.used / v.total) * 100;
      const tone = band(p);
      el.dataset.tone = tone;
      el.querySelector('.disk-vol-main')?.setAttribute('aria-pressed', String(volFilter === v.key));
      (el.querySelector('.disk-vol-name') as HTMLElement).textContent = v.label;
      const roleEl = el.querySelector('.disk-vol-role') as HTMLElement;
      const role = roleOf(v);
      roleEl.textContent = role;
      roleEl.hidden = !role;
      (el.querySelector('.disk-vol-pct') as HTMLElement).textContent = Number.isFinite(p) ? `${dataPct(p)} full` : 'Size not known';
      // One stacked bar: databases, journal files, the write image journal and everything else on the disk; the track is free space.
      const dbTotal = v.dbs.reduce((a, d) => a + d.size, 0);
      const known = Number.isFinite(v.total) && v.total > 0;
      const other = known ? Math.max(0, v.used - dbTotal - v.journal - v.wij) : NaN;
      const parts: Array<{ key: string; label: string; mb: number; href?: string; title?: string }> = [
        { key: 'db', label: 'Databases', mb: dbTotal, href: '#/databases/databases' },
        { key: 'jrn', label: 'Journals', mb: v.journal, href: '#/operations/journals' },
        { key: 'wij', label: 'WIJ', mb: v.wij, title: 'Write image journal' },
        { key: 'other', label: 'Other', mb: other },
      ];
      const stack = el.querySelector('.cap-stack') as HTMLElement;
      for (const part of parts) {
        const seg = stack.querySelector(`.cap-seg--${part.key}`) as HTMLElement;
        const w = known && part.mb > 0 ? Math.min(100, (part.mb / v.total) * 100) : 0;
        seg.hidden = w <= 0;
        seg.style.width = `${w}%`;
        seg.title = `${part.title ?? part.label}: ${dataSize(part.mb)}`;
      }
      stack.setAttribute('aria-label', `${parts.filter((x) => x.mb > 0).map((x) => `${x.title ?? x.label} ${dataSize(x.mb)}`).join(', ')}, ${dataSize(v.free)} free`);
      stack.title = `${dataSize(v.free)} free${known ? ` of ${dataSize(v.total)}` : ''}`;
      // One label, so it's plain how small a share IRIS is: "IRIS 746 MB · other files 173.8 GB · free 62.9 GB".
      const iris = dbTotal + v.journal + v.wij;
      const irisTip = parts.filter((x) => x.key !== 'other' && x.mb > 0).map((x) => `${x.title ?? x.label} ${dataSize(x.mb)}`).join(', ');
      const legend = [
        v.empty ? '<span class="cap-key">No IRIS files</span>'
          : `<span class="cap-key" title="${esc(irisTip)}"><i class="cap-sw cap-sw--db" aria-hidden="true"></i>IRIS ${esc(dataSize(iris))}</span>`,
        known ? `<span class="cap-key"><i class="cap-sw cap-sw--other" aria-hidden="true"></i>other files ${esc(dataSize(other))}</span>` : '',
        // No swatch: the bar's track is the free space.
        `<span class="cap-key">free ${esc(dataSize(v.free))}</span>`,
      ].filter(Boolean).join('<span class="cap-sep" aria-hidden="true">·</span>');
      const legendEl = el.querySelector('.cap-legend') as HTMLElement;
      if (legendEl.innerHTML !== legend) legendEl.innerHTML = legend;
    }
    const sum = host.querySelector('.disk-vol--sum');
    if (sum) {
      const sized = vols.filter((v) => Number.isFinite(v.total) && v.total > 0);
      const free = sized.reduce((a, v) => a + (Number.isFinite(v.free) ? v.free : 0), 0);
      const total = sized.reduce((a, v) => a + v.total, 0);
      const fullest = sized.reduce<Volume | null>((a, v) => (!a || v.used / v.total > a.used / a.total ? v : a), null);
      (sum.querySelector('.k') as HTMLElement).textContent = `${dataSize(free)} free of ${dataSize(total)}`;
      (sum.querySelector('.s') as HTMLElement).textContent = `${n} drives${fullest ? ` · fullest ${fullest.label} ${Math.round((fullest.used / fullest.total) * 100)}%` : ''}`;
    }
  };

  // ── Grid ──
  const COLUMNS: GridColumn[] = [
    // Same styles as the Databases list: the name is the row's identifier. The figures follow it directly,
    // and the drive comes last, taking the space left over, so there's no gap in the middle of a row.
    { key: 'Name', label: 'Database', width: '240px', sortable: true, renderCell: (v) => cellId(v) },
    { key: 'Size', label: 'Size', width: '96px', sortable: true, align: 'right', description: 'Size of the database file on disk', renderCell: (v) => cell.num(dataSize(Number(v))) },
    { key: 'FreeInside', label: 'Free inside', width: '104px', sortable: true, align: 'right',
      description: 'Space inside the file not holding data yet. It is used up before the file grows',
      renderCell: (v) => (Number(v) >= 0 ? cell.num(dataSize(Number(v))) : cell.dim('—')) },
    { key: 'LimitPct', label: 'Size limit', width: '170px', sortable: true,
      description: 'The largest the database may grow. Most databases have none and grow until the disk is full',
      renderCell: (_v, row) => (Number(row.Max) > 0 ? limitCell(Number(row.Size), Number(row.Max)) : cell.dim('No limit')) },
    { key: 'Growth', label: 'Grows by', width: '96px', sortable: true, align: 'right',
      description: 'How much the file grows next time it fills. By default 12% of its size, at least 10 MB and at most 1 GB',
      renderCell: (v, row) => (row.Grows ? cell.num(`+${dataSize(Number(v))}`) : cell.dim('—')) },
    { key: 'Room', label: 'Headroom', width: '150px', sortable: true, align: 'right',
      description: 'How much bigger it can get before its size limit or a full disk, whichever comes first. “Shared”: limited by the disk, whose free space (on the volume above) all its databases share. “—”: read-only or not mounted, so it doesn’t grow',
      renderCell: (v, row) => (Number(v) >= 0 ? roomCell(Number(v), row) : cell.dim('—')) },
    { key: 'Health', label: 'Status', width: '120px', sortable: true, renderCell: (_v, row) => healthCell(row) },
    // "Drive" on Windows (set on load), "Volume" on Unix. The role shows when the drive list names one. No width.
    { key: 'Volume', label: 'Volume', sortable: true,
      renderCell: (v, row) => `<span class="mono">${esc(v)}</span>${row.VolRole ? ` <span class="dim">${esc(row.VolRole)}</span>` : ''}` },
  ];
  const SECONDARY = ['Volume', 'Growth', 'FreeInside'];

  function limitCell(s: number, max: number): string {
    const p = Math.min(100, (s / max) * 100);
    const color = p >= 98 ? 'var(--ev-color-danger)' : p >= 90 ? 'var(--ev-color-warning)' : 'var(--ev-color-primary)';
    return `<span style="display:flex;align-items:center;gap:8px;white-space:nowrap;font-variant-numeric:tabular-nums">
      <span style="flex:0 0 56px;height:6px;border-radius:3px;background:var(--ev-surface-inset, var(--ev-neutral-3));overflow:hidden"><span style="display:block;height:100%;width:${p}%;background:${color}"></span></span>
      <span style="flex:0 0 auto">${esc(dataPct(p))} of ${esc(dataSize(max))}</span></span>`;
  }
  /**
   * Limited by its own size limit: the figure is its own. Limited by the disk: that space is shared
   * with everything else on the volume, so the row says so (the figure is stated once, on the tile).
   */
  function roomCell(room: number, row: DataGridRow): string {
    const style = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;font-variant-numeric:tabular-nums';
    if (row.RoomBy === 'limit') return `<span style="${style}" title="Until it reaches its size limit">${esc(dataSize(room))}</span>`;
    const others = Number(row.Sharers);
    if (!others && !row.VolJournal) return `<span style="${style}" title="The free space on ${esc(row.Volume)}">${esc(dataSize(room))}</span>`;
    const tip = `Up to ${dataSize(room)}: the free space on ${row.Volume}, shared with ${others ? plural(others, 'other database') : ''}${others && row.VolJournal ? ' and ' : ''}${row.VolJournal ? 'journal files' : ''}`;
    return `<span style="${style}" title="${esc(tip)}">Shared</span>`;
  }
  function healthCell(row: DataGridRow): string {
    const t = String(row.RiskTone);
    if (t === 'danger' || t === 'warning') return chip(String(row.RiskLabel), t as Tone, String(row.RiskTitle));
    if (!row.Mounted) return chip('Not mounted', 'neutral');
    if (row.ReadOnly) return cell.dim('Read-only');
    return '';
  }

  const toRow = (d: Db): DataGridRow => {
    const v = volOf(d);
    const r = roomOf(d, v);
    const own = dbRisk(d, v);
    const vr = v ? volumeRisk(v) : null;
    const risk = own ?? (vr && d.mounted && !d.readOnly ? vr : null);
    const label = !risk ? '' : own
      ? (own.title.includes('at its size limit') ? 'At its size limit' : own.title.includes('near its') ? 'Near its size limit' : 'Can’t grow')
      : `${v?.label ?? 'Disk'} nearly full`;
    return {
      Name: d.name, Volume: v?.label ?? '—', VolRole: v ? roleOf(v) : '', Size: d.size,
      FreeInside: Number.isFinite(d.freeInside) ? d.freeInside : -1,
      Max: d.max, LimitPct: d.max > 0 ? d.size / d.max : -1,
      Growth: nextGrowth(d.size, d.expansion), Grows: d.mounted && !d.readOnly,
      Room: Number.isFinite(r.room) ? r.room : -1, RoomBy: r.by,
      Sharers: v ? v.dbs.length - 1 : 0, VolJournal: !!v?.journal,
      Mounted: d.mounted, ReadOnly: d.readOnly,
      Health: risk ? (risk.tone === 'danger' ? 0 : 1) : d.mounted && !d.readOnly ? 2 : 3,
      RiskTone: risk?.tone ?? '', RiskLabel: label, RiskTitle: risk?.text ?? '',
      Dir: d.dir,
    };
  };

  const matches = (d: Db): boolean => {
    if (volFilter && d.volKey !== volFilter) return false;
    if (filter === 'risk' && !atRisk(d)) return false;
    if (filter === 'limited' && !(d.max > 0)) return false;
    if (!query) return true;
    const ql = query.toLowerCase();
    return d.name.toLowerCase().includes(ql) || d.dir.toLowerCase().includes(ql);
  };

  let uniform = new Set<string>();
  const applyColumns = (): void => {
    if (!grid) return;
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && SECONDARY.includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => { selected = null; shownHtml = ''; grid?.select([]); setPanel(false); };

  const renderGrid = (): void => {
    if (!dbs.length) {
      grid = null; rowSig = '';
      $('#cap-toolbar').hidden = true;
      wrap.innerHTML = emptyState({ icon: 'archive', title: 'No local databases', what: 'This instance reports no database files of its own.', docs: { href: diskDocs.configure, label: 'About local databases' } });
      return;
    }
    $('#cap-toolbar').hidden = false;
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Database space');
      const vol = COLUMNS.find((c) => c.key === 'Volume');
      if (vol) vol.label = dirs.some((d) => driveOf(d.Directory)) ? 'Drive' : 'Volume';
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        selected = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        renderDetail();
      });
      wrap.appendChild(grid);
    }
    const all = dbs.map(toRow);
    uniform = all.length < 3 ? new Set<string>() : (uniformKeys(all, ['Volume', 'Health']) as Set<string>);
    // Headroom only says something when a database has its own size limit; otherwise every row is "Shared" or "—".
    if (!all.some((r) => r.RoomBy === 'limit')) uniform.add('Room');
    // No database has a size limit: the column would say "No limit" on every row; the footer says it once.
    if (!dbs.some((d) => d.max > 0)) uniform.add('LimitPct');
    const rows = dbs.filter(matches).map(toRow);
    // Only hand the grid new rows when something changed: the live refresh shouldn't redraw an unchanged table.
    const sig = JSON.stringify(rows);
    if (sig !== rowSig) { rowSig = sig; grid.rows = rows; }
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.disk-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      const what = filter === 'risk' ? 'No database is at risk' : filter === 'limited' ? 'No database has a size limit' : 'No database matches';
      wrap.insertAdjacentHTML('beforeend', `<div class="disk-empty">${emptyState({
        icon: filter === 'risk' ? 'check-circle' : 'search',
        title: `${what}${query ? ` “${query}”` : ''}${volFilter ? ` on ${vols.find((v) => v.key === volFilter)?.label ?? 'this volume'}` : ''}`,
        what: filter === 'risk' ? 'Every database has room to grow, and no volume is more than 85% full.'
          : filter === 'limited' ? 'They grow until their disk is full. A size limit keeps one database from taking all the space.' : 'Change the filters above to see more.',
        action: '<button type="button" class="btn btn--sm" data-cap-clear>Show all databases</button>',
      })}</div>`);
      wrap.querySelector('[data-cap-clear]')?.addEventListener('click', () => {
        filter = 'all'; filterEl.value = 'all'; volFilter = null; query = ''; searchEl.value = '';
        renderAll();
      });
    }
  };

  const renderToolbar = (): void => {
    const n = (f: Filter): number => dbs.filter((d) => (f === 'all' ? true : f === 'risk' ? atRisk(d) : d.max > 0)).length;
    // Zero-count chips are hidden, not dimmed (the footer says "None at risk"); with only "All" left, so is the group.
    const opts = [
      { value: 'all', label: `All ${num(n('all'))}` },
      ...(n('risk') > 0 || filter === 'risk' ? [{ value: 'risk', label: `At risk ${num(n('risk'))}` }] : []),
      ...(n('limited') > 0 || filter === 'limited' ? [{ value: 'limited', label: `With a size limit ${num(n('limited'))}` }] : []),
    ];
    filterEl.options = opts;
    // No search box on a short list, unless a query or filter is active (so it can be cleared).
    setSearch(searchEl, dbs.length, { query, filtered: filter !== 'all' || volFilter !== null });
    filterEl.style.display = opts.length <= 1 ? 'none' : '';
    const v = vols.find((x) => x.key === volFilter);
    const scope = $('#cap-vol-scope');
    scope.innerHTML = v ? `Only ${mono(v.label)} <button type="button" class="link" data-cap-allvols>Show every volume</button>` : '';
    scope.querySelector('[data-cap-allvols]')?.addEventListener('click', () => { volFilter = null; renderAll(); });
  };

  const renderFoot = (): void => {
    const total = dbs.reduce((a, d) => a + d.size, 0);
    const risky = dbs.filter(atRisk).length;
    const sep = '<span class="meta-sep">·</span>';
    // Sample data (src/showcase) marks the rows it placed on sample drives.
    const sample = dirs.some((d) => (d as LocalDbDir & { __sample?: boolean }).__sample);
    const note = sample ? `${sep}<span class="dim" title="With sample data on, databases are placed on sample drives to show a multi-drive layout. Their real directories are on the Databases screen.">Drives are sample data</span>` : '';
    $('#cap-foot').innerHTML = `<b>${num(dbs.length)}</b> database${dbs.length === 1 ? '' : 's'}${sep}${dataSize(total)}${dbs.some((d) => d.max > 0) ? '' : `${sep}No size limits`}${sep}${risky ? `<b>${num(risky)}</b> at risk` : 'None at risk'}${note}`;
  };

  // ── Detail ──
  const renderDetail = (): void => {
    const d = dbs.find((x) => x.name === selected);
    if (!d) { closeDetail(); return; }
    const v = volOf(d);
    const r = roomOf(d, v);
    const risk = dbRisk(d, v) ?? (v && d.mounted && !d.readOnly ? volumeRisk(v) : null);
    // The panel only reads the shared cache (filled on first load and by the refresh button): it never starts a read.
    infoFor = { name: d.name, info: cachedDbInfo(d.dir) ?? null, error: infoErrors.get(d.dir) ?? '' };
    const info = infoFor?.name === d.name ? infoFor.info : null;
    const pending = infoLoading && d.mounted && !info && !infoFor?.error;
    // Same figure as the grid and the Databases screen: free space inside from IRIS's database read.
    const freeInside = info ? info.AvailableSpace : d.freeInside;
    const step = nextGrowth(d.size, d.expansion);
    const state = [
      risk ? chip(risk.tone === 'danger' ? 'At risk' : 'Watch', risk.tone) : '',
      !d.mounted ? chip('Not mounted', 'neutral') : d.readOnly ? chip('Read-only', 'neutral') : '',
      info?.Full ? chip('Marked full', 'danger', 'IRIS has marked the database full') : '',
    ].join('');
    const others = v ? v.dbs.filter((x) => x.name !== d.name) : [];
    const roomText = !d.mounted ? 'It isn’t mounted, so it doesn’t grow until it is.'
      : d.readOnly ? `It’s read-only${info?.ReadOnlyReason ? ` (${esc(info.ReadOnlyReason.replace(/^DB has /, 'the database has a '))})` : ''}, so it doesn’t grow.`
        : r.by === 'limit'
          ? `It can grow by <b>${esc(dataSize(r.room))}</b> more before it reaches its size limit of ${esc(dataSize(d.max))}.`
          : `It can grow until ${esc(v?.label ?? 'its volume')} is full: <b>${esc(dataSize(r.room))}</b> from now${others.length || v?.journal ? `, shared with ${esc([others.length ? plural(others.length, 'other database') : '', v?.journal ? 'journal files' : ''].filter(Boolean).join(' and '))}` : ''}.${d.max > 0 ? ` Its size limit (${esc(dataSize(d.max))}) is further away than that.` : ''}`;
    const lastGrew = info?.LastExpansionTime ? when(irisDate(info.LastExpansionTime)) : pending ? '—' : 'Not recorded';
    const html = `
      <header class="detail-head">
        <div class="detail-title"><h2 class="mono">${esc(d.name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="cap-close"></ev-icon-button>
      </header>
      ${state ? `<div class="detail-state">${state}</div>` : ''}
      <div class="detail-actions">
        <button type="button" class="btn btn--sm" id="cap-open-db">Open in Databases</button>
        ${portalButton(diskPortal.database(d.name), 'Management Portal')}
      </div>
      ${risk ? `<div class="sec-callout sec-callout--${risk.tone}" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>${esc(risk.title)}</strong><span>${esc(risk.text)}</span></div></div>` : ''}
      <h3 class="detail-section">Space</h3>
      <dl class="kv-list">
        ${kv('Size on disk', esc(dataSize(d.size)))}
        ${kv('Free inside', Number.isFinite(freeInside) ? `${esc(dataSize(freeInside))}${d.size ? ` <span class="dim">· ${esc(dataPct((freeInside / d.size) * 100))}</span>` : ''}` : pending ? '<span class="dim">—</span>' : '<span class="dim">Not reported</span>')}
        ${kv('Size limit', d.max > 0 ? `${esc(dataSize(d.max))} <span class="dim">· ${esc(dataPct((d.size / d.max) * 100))} used</span>` : '<span class="dim">No limit</span>')}
        ${d.mounted && !d.readOnly ? kv('Grows by', d.expansion > 0 ? esc(dataSize(d.expansion)) : `${esc(dataSize(step))} <span class="dim">· 12% default</span>`) : ''}
        ${kv('Last grew', esc(lastGrew))}
      </dl>
      ${para(roomText)}
      <h3 class="detail-section">Where it lives</h3>
      <dl class="kv-list">
        ${kv('Directory', mono(d.dir), d.dir)}
        ${kv('Volume', v ? `${mono(v.label)} <span class="dim">· ${esc(dataSize(v.free))} free${Number.isFinite(v.total) ? ` of ${esc(dataSize(v.total))}` : ''}</span>` : '—')}
      </dl>
      ${d.files.length > 1 ? `<ul class="disk-list">${d.files.map((f) => `<li><span class="mono" title="${esc(f.VolumeDirectory + f.File)}">${esc(f.File)}</span><span>${esc(dataSize(f.Size))}</span></li>`).join('')}</ul>
        ${para(`Split across ${plural(d.files.length, 'volume file')}. ${portalButton(diskPortal.volumes(d.name), 'Volume files')}`)}` : ''}
      ${v ? `<h3 class="detail-section">Shares ${esc(v.label)} with</h3>
        ${others.length || v.journal || v.wij ? `<ul class="disk-list">
          ${others.sort((a, b) => b.size - a.size).map((o) => `<li><button type="button" class="link mono" data-db="${esc(o.name)}">${esc(o.name)}</button><span>${esc(dataSize(o.size))}</span></li>`).join('')}
          ${v.journal ? `<li><button type="button" class="link" data-go="operations/journals">Journal files</button><span>${esc(dataSize(v.journal))}</span></li>` : ''}
          ${v.wij ? `<li><span>Write image journal</span><span>${esc(dataSize(v.wij))}</span></li>` : ''}
        </ul>` : '<p class="disk-none">No other IRIS data.</p>'}` : ''}
      ${infoFor?.name === d.name && infoFor.error ? `<p class="detail-note">Some figures couldn’t be read: ${esc(infoFor.error)}</p>` : ''}`;
    setPanel(true);
    // Redraw only when something changed, so focus and hover survive the live refresh.
    if (html === shownHtml) return;
    shownHtml = html;
    detail.innerHTML = html;
    detail.querySelector('#cap-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#cap-open-db')?.addEventListener('click', () => openSelected(ctx.navigate, 'databases/databases', d.name));
    detail.querySelectorAll<HTMLElement>('[data-db]').forEach((b) => b.addEventListener('click', () => {
      selected = b.dataset.db ?? null;
      if (selected && !dbs.filter(matches).some((x) => x.name === selected)) { filter = 'all'; filterEl.value = 'all'; volFilter = null; query = ''; searchEl.value = ''; renderToolbar(); }
      renderGrid();
      renderDetail();
    }));
    detail.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go ?? '')));
  };

  const renderAll = (): void => {
    if (!loaded) return;
    build();
    renderBanner();
    renderVolumes();
    renderToolbar();
    renderGrid();
    renderFoot();
    if (selected !== null) renderDetail();
  };

  // ── Loading ──
  const updated = liveIndicator(ctx, () => { void metrics.refresh(); void load('refresh'); });
  /**
   * Free space inside each mounted local database, IRIS's own figure. Each read is a background job in
   * IRIS, so reads start only on first load (from the shared cache when it is fresh) and from the refresh
   * button (forced). The 60-second refresh never reads; it shows the cached figures.
   */
  const infoErrors = new Map<string, string>();
  const loadInfos = async (force: boolean): Promise<void> => {
    infoLoading = true;
    await Promise.all(dirs.filter((d) => /^Mounted/i.test(d.Status)).map((d) => readDbInfo(d.Directory, force).then(
      () => { infoErrors.delete(d.Directory); },
      (err: unknown) => { infoErrors.set(d.Directory, err instanceof Error ? err.message : String(err)); })));
    infoLoading = false;
    if (!alive) return;
    shownHtml = '';
    renderAll();
  };
  type LoadMode = 'first' | 'refresh' | 'auto';
  const load = async (mode: LoadMode = 'auto'): Promise<void> => {
    try {
      const [d, c, js, jf, fr] = await Promise.allSettled([getDbDirs(), getDbConfigs(), getJournalSettings(), getJournalFiles(),
        // Drive sizes: optional (the OSCA API may not be installed, or the user may not browse server files).
        apiAvailable().then((ok) => (ok ? fsRoots() : null))]);
      if (d.status === 'rejected') throw d.reason;
      const list = d.value;
      const vf = await Promise.all(list.map((x) => getDbVolumes(x.Directory).then((f) => [x.Directory, f] as const, () => [x.Directory, [] as VolumeFile[]] as const)));
      if (!alive) return;
      dirs = list;
      configs = c.status === 'fulfilled' ? c.value : configs;
      jset = js.status === 'fulfilled' ? js.value : jset;
      jfiles = jf.status === 'fulfilled' ? jf.value : jfiles;
      if (fr.status === 'fulfilled' && fr.value) roots = fr.value.restricted ? [] : fr.value.roots;
      volFiles = new Map(vf);
      loaded = true;
      updated(new Date());
      renderAll();
      if (mode !== 'auto') void loadInfos(mode === 'refresh');
    } catch (err) {
      if (!alive) return;
      if (loaded) return; // keep the last good picture; the next refresh tries again
      grid = null; rowSig = '';
      wrap.innerHTML = errorPanel(err, 'cap-retry');
      $('#cap-vols').innerHTML = '';
      wrap.querySelector('#cap-retry')?.addEventListener('click', () => void load('first'));
    }
  };
  ctx.onLeave(metrics.subscribe((s, at) => { snap = s; if (loaded) { updated(at); renderAll(); } }, () => { /* the admin figures still show; volume totals wait for metrics */ }));

  searchEl.addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });
  filterEl.addEventListener('ev-segmented-button-change', (e) => { filter = (e as CustomEvent<{ value: Filter }>).detail.value; renderAll(); });

  void load('first');
  const timer = setInterval(() => void load('auto'), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
