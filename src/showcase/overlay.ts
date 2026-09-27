// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sample data shown in the UI only. Registered on authFetch's hook
 * (registerResponseOverlay in src/auth.ts) while the display flag is on.
 *
 * The sample layout, the way a real server is often laid out:
 *   C:  the OS and IRIS install: IRISSYS, IRISLIB, ENSLIB, IRISAUDIT,
 *       IRISSECURITY and the other library databases (real, untouched)
 *   D:  application data: USER, IRISLOCALDATA and any other database
 *   T:  a fast temp drive: IRISTEMP
 *   E:  journals
 *   F:  backups (seen in the server file picker)
 * (Letters the server really has are skipped; Unix gets /irisdb/ and so on.)
 * Real database names and sizes are kept; only where they live changes.
 *
 * Where it shows, and where it never does:
 *  - Server file picker: the four sample drives. Listing or checking a path
 *    on one answers "Sample drive, not on the server" without asking IRIS,
 *    and picker-guard.ts disables Select there.
 *  - Paths are rewritten only on screens where no form submits them:
 *    Databases > Capacity and Operations > Journals (whose actions send no
 *    path). The metrics feed's disk figures follow the same layout on every
 *    screen (Home's Disk tile, the status bar, Journals, Capacity).
 *  - The Databases screen shows directories that its forms and actions send
 *    back, so its paths and disk figures stay real: it reads disk use by the
 *    real drive letter, and the install drive's metrics are never rewritten.
 *  - The hook sees GETs, plus two read-only POSTs whose only change can be a
 *    sample path in the address swapped for the real one (IRIS's on-demand
 *    database figures and a journal file's integrity check). Nothing else,
 *    and never a request body.
 */
import type { ResponseOverlay } from '../auth';

/** The install drive's role in the sample layout. */
const SYSTEM_ROLE = 'System · IRIS';

/** Marks an object this overlay made or changed. */
export const SAMPLE_MARK = '__sample';
export const isSample = (x: unknown): boolean => !!(x && typeof x === 'object' && (x as Record<string, unknown>)[SAMPLE_MARK]);

export const SAMPLE_MESSAGE = 'This is a sample drive, part of the sample multi-drive layout, so there are no folders to show. Turn off sample data in the status bar to hide it.';

type Role = 'data' | 'temp' | 'journal' | 'backup';
interface SampleDrive { role: Role; root: string; label: string; totalMb: number; freeMb: number }

const MB = 1024 * 1024;
const LAYOUT: Record<Role, { letter: string; unix: string; folder: string; label: string; totalMb: number; freeMb: number }> = {
  data: { letter: 'D', unix: '/irisdb/', folder: 'IRISDB', label: 'Application data', totalMb: 1_048_576, freeMb: 611_300 },
  temp: { letter: 'T', unix: '/iristemp/', folder: 'IRISTEMP', label: 'Temp (fast disk)', totalMb: 262_144, freeMb: 229_400 },
  journal: { letter: 'E', unix: '/irisjrn/', folder: 'IRISJournal', label: 'Journals', totalMb: 524_288, freeMb: 402_600 },
  backup: { letter: 'F', unix: '/backup/', folder: 'IRISBackup', label: 'Backups', totalMb: 2_097_152, freeMb: 1_358_000 },
};
const ROLES: Role[] = ['data', 'temp', 'journal', 'backup'];

let windows: boolean | null = null;
let drives: SampleDrive[] | null = null;
/** Drive letters the server really has (from fs/roots, or from paths seen). */
const usedLetters = new Set<string>();

const isWinPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');
const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
const sep = (): string => (windows === false ? '/' : '\\');

function notePaths(paths: string[]): void {
  for (const p of paths) {
    if (!p) continue;
    if (windows === null && (isWinPath(p) || p.startsWith('/'))) windows = isWinPath(p);
    const m = /^([a-z]):/i.exec(p);
    if (m) usedLetters.add(m[1].toUpperCase());
  }
}

/** Chosen once: the layout's letters, or the next free ones if the server has them. */
function sampleDrives(): SampleDrive[] {
  if (drives) return drives;
  if (windows === false) {
    drives = ROLES.map((role) => ({ role, root: LAYOUT[role].unix, ...LAYOUT[role] }));
    return drives;
  }
  const taken = new Set(usedLetters);
  drives = ROLES.map((role) => {
    let letter = LAYOUT[role].letter;
    if (taken.has(letter)) letter = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((l) => !taken.has(l)) ?? 'Z';
    taken.add(letter);
    return { role, root: `${letter}:\\`, ...LAYOUT[role] };
  });
  return drives;
}
const driveFor = (role: Role): SampleDrive => sampleDrives().find((d) => d.role === role) as SampleDrive;
const driveOfSample = (p: string): SampleDrive | undefined => sampleDrives().find((d) => p.toLowerCase().startsWith(d.root.toLowerCase()));

/** Is this path on a sample drive? */
export function isSamplePath(p: string): boolean {
  if (!p || !drives) return false;
  const s = p.trim().toLowerCase().replace(/\//g, windows === false ? '/' : '\\');
  return drives.some((d) => {
    const r = d.root.toLowerCase();
    return s === r || s === r.replace(/[\\/]$/, '') || s.startsWith(r);
  });
}

/* ── Real <-> sample paths ────────────────────────────────────────── */

/** sample dir (normalised) -> real dir, and back. */
const toRealDir = new Map<string, string>();
const toSampleDir = new Map<string, string>();

function pair(real: string, sample: string): string {
  toRealDir.set(norm(sample), real);
  toSampleDir.set(norm(real), sample);
  return sample;
}

/** Library and system databases stay with the install, on the real drive. */
const STAYS = new Set(['', 'irislib', 'irissecurity', 'enslib', 'irisaudit', 'irismetrics', 'hslib', 'hssys', 'hscustom']);

/** The part of a database directory after "mgr" ("user\" for ...\mgr\user\); null if none. */
function tailAfterMgr(dir: string): string | null {
  const m = /[\\/]mgr(?:[\\/](.*))?$/i.exec(dir);
  return m ? m[1] ?? '' : null;
}

function sampleDbDir(dir: string): string {
  if (!dir) return dir;
  notePaths([dir]);
  const known = toSampleDir.get(norm(dir));
  if (known) return known;
  const tail = tailAfterMgr(dir);
  const first = (tail ?? '').split(/[\\/]/)[0].toLowerCase();
  if (tail === null || STAYS.has(first) || first === 'journal') return dir;
  const d = driveFor(first === 'iristemp' ? 'temp' : 'data');
  const s = sep();
  const rest = tail.replace(/[\\/]+/g, s);
  return pair(dir, `${d.root}${windows === false ? '' : `${LAYOUT[d.role].folder}${s}`}${rest}${rest.endsWith(s) ? '' : s}`);
}

let journalDirs = 0;
function sampleJournalDir(dir: string): string {
  if (!dir) return dir;
  notePaths([dir]);
  const known = toSampleDir.get(norm(dir));
  if (known) return known;
  const d = driveFor('journal');
  journalDirs += 1;
  return pair(dir, `${d.root}${windows === false ? 'journal' : 'IRISJournal'}${journalDirs > 1 ? journalDirs : ''}${sep()}`);
}

/** A file inside a mapped directory keeps its name. */
function sampleFile(path: string, mapDir: (dir: string) => string): string {
  const m = /^(.*[\\/])([^\\/]+)$/.exec(path);
  return m ? mapDir(m[1]) + m[2] : path;
}

/** Longest known sample directory that starts this path, swapped for the real one. */
function realPath(p: string): string | null {
  const low = p.toLowerCase();
  let best: [string, string] | null = null;
  for (const [s, real] of toRealDir) {
    if ((low === s || low.startsWith(`${s}\\`) || low.startsWith(`${s}/`)) && (!best || s.length > best[0].length)) best = [s, real];
  }
  if (!best) return null;
  const rest = p.slice(best[0].length).replace(/^[\\/]/, '');
  const realSep = best[1].includes('/') && !best[1].includes('\\') ? '/' : '\\';
  return best[1].replace(/[\\/]?$/, realSep) + rest;
}

const pctOf = (d: SampleDrive): number => Math.round((1 - d.freeMb / d.totalMb) * 10000) / 100;

/* ── Where the overlay applies ───────────────────────────────────── */

/** Screens whose paths are display-only: sample paths may be shown there. */
const pathsShown = (): boolean => location.hash.startsWith('#/databases/capacity') || location.hash.startsWith('#/operations/journals');

/* ── Responses ────────────────────────────────────────────────────── */

function remake(res: Response, body: string): Response {
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

async function rewriteJson(res: Response, fn: (json: Record<string, unknown>) => void): Promise<Response> {
  if (!res.ok) return res;
  const text = await res.clone().text();
  let json: Record<string, unknown>;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { return res; }
  try { fn(json); } catch { return res; }
  return remake(res, JSON.stringify(json));
}

type Row = Record<string, unknown>;
const rows = (json: Record<string, unknown>): Row[] => (Array.isArray(json.result) ? json.result as Row[] : []);

function sampleAnswer(): Response {
  return new Response(JSON.stringify({ error: SAMPLE_MESSAGE }), { status: 404, statusText: 'Not Found', headers: { 'Content-Type': 'application/json' } });
}

const escLabel = (p: string): string => p.replace(/\\/g, '\\\\');

/**
 * Prometheus text: disk figures follow the sample layout. Moved database and
 * journal directories take their sample drive's path and figures, and the
 * journal drive gets its own "percent full" line (IRIS reports one only for
 * database directories), so every screen can say how full it is.
 */
function rewriteMetrics(text: string): string {
  let journalLine = '';
  const out = text.split('\n').map((line) => {
    const m = /^(iris_directory_space|iris_disk_percent_full|iris_jrn_free_space)\{(.*)\} (\S+)$/.exec(line);
    if (!m) return line;
    const dm = /dir="((?:[^"\\]|\\.)*)"/.exec(m[2]);
    if (!dm) return line;
    const real = dm[1].replace(/\\\\/g, '\\');
    const id = /id="([^"]*)"/.exec(m[2])?.[1] ?? '';
    if (!isWinPath(real) && !real.startsWith('/')) return line;
    const sample = m[1] === 'iris_jrn_free_space' ? (id === 'WIJ' ? real : sampleJournalDir(real)) : sampleDbDir(real);
    if (sample === real) return line;
    const d = driveOfSample(sample);
    if (!d) return line;
    if (m[1] === 'iris_jrn_free_space') journalLine = sample;
    const val = m[1] === 'iris_disk_percent_full' ? pctOf(d) : d.freeMb;
    return `${m[1]}{${m[2].replace(dm[0], `dir="${escLabel(sample)}"`)}} ${val}`;
  });
  if (journalLine) {
    const d = driveFor('journal');
    out.push(`iris_disk_percent_full{id="JOURNAL",dir="${escLabel(journalLine)}"} ${pctOf(d)}`);
    out.push(`iris_directory_space{id="JOURNAL",dir="${escLabel(journalLine)}"} ${d.freeMb}`);
  }
  return out.join('\n');
}

/** Read-only POSTs the hook may hand over: only the path in the address may change. */
const READ_ONLY_POST = new Set(['/api/admin/v2/database-dir/info', '/api/admin/v2/journal/file/integrity-check', '/api/admin/v2/journal/file/records']);

export const sampleOverlay: ResponseOverlay = async (url, send) => {
  let u: URL;
  try { u = new URL(url, location.origin); } catch { return send(url); }
  const path = u.pathname;

  // Server file picker.
  if (path === '/api/osca/v1/fs/roots') {
    const res = await send(url);
    return rewriteJson(res, (json) => {
      const roots = Array.isArray(json.roots) ? json.roots as Row[] : [];
      notePaths(roots.map((r) => String(r.path ?? '')));
      if (windows === null) windows = json.separator !== '/';
      // The real drive holding the install is the layout's system drive.
      const install = String((Array.isArray(json.places) ? json.places as Row[] : []).find((p) => p.id === 'install')?.path ?? '').toLowerCase();
      for (const r of roots) if (install && r.path && r.path !== '/' && install.startsWith(String(r.path).toLowerCase())) r.role = SYSTEM_ROLE;
      // `role` and `sample` are what screens read (Capacity's tile labels, the picker's Sample tag).
      for (const d of sampleDrives()) {
        roots.push({ name: d.root, path: d.root, type: windows ? 'drive' : 'root', totalBytes: d.totalMb * MB, freeBytes: d.freeMb * MB, role: d.label, sample: true, [SAMPLE_MARK]: true });
      }
      json.roots = roots;
    });
  }
  if (path === '/api/osca/v1/fs/list' || path === '/api/osca/v1/fs/stat') {
    const p = u.searchParams.get('dir') ?? u.searchParams.get('path') ?? '';
    if (isSamplePath(p)) return sampleAnswer();
    return send(url);
  }

  // A request naming a sample path goes to IRIS with the real one.
  let changed = false;
  for (const [k, v] of [...u.searchParams]) {
    const real = isSamplePath(v) ? realPath(v) : null;
    if (real) { u.searchParams.set(k, real); changed = true; }
  }
  const target = changed ? u.pathname + u.search : url;
  if (READ_ONLY_POST.has(path)) return send(target); // the answer is IRIS's own, unchanged

  if (path === '/api/monitor/metrics') {
    // Every screen, the Databases screen included: it keys disk use by the real drive letter of its
    // real directories, and lines on the install drive are never rewritten, so it stays real. One
    // feed for all also means no stale snapshot when moving between screens.
    const res = await send(target);
    if (!res.ok) return res;
    return remake(res, rewriteMetrics(await res.clone().text()));
  }
  if (!pathsShown()) return send(target);

  const res = await send(target);
  switch (path) {
    case '/api/admin/v2/database-dirs':
      return rewriteJson(res, (json) => {
        for (const r of rows(json)) {
          const s = sampleDbDir(String(r.Directory ?? ''));
          if (s !== r.Directory) { r.Directory = s; r[SAMPLE_MARK] = true; }
        }
      });
    case '/api/admin/v2/databases':
      return rewriteJson(res, (json) => {
        for (const r of rows(json)) {
          if (r.Server) continue;
          const s = sampleDbDir(String(r.Directory ?? ''));
          if (s !== r.Directory) { r.Directory = s; r[SAMPLE_MARK] = true; }
        }
      });
    case '/api/admin/v2/database-dir/volumes':
      return rewriteJson(res, (json) => {
        for (const r of rows(json)) {
          const s = sampleDbDir(String(r.VolumeDirectory ?? ''));
          if (s === r.VolumeDirectory) continue;
          r.VolumeDirectory = s;
          const d = driveOfSample(s);
          if (d) r.DiskFree = d.freeMb;
          r[SAMPLE_MARK] = true;
        }
      });
    case '/api/admin/v2/journal/settings':
      return rewriteJson(res, (json) => {
        const r = json.result as Row | undefined;
        if (!r) return;
        for (const k of ['CurrentDirectory', 'AlternateDirectory']) if (r[k]) r[k] = sampleJournalDir(String(r[k]));
        r[SAMPLE_MARK] = true;
      });
    case '/api/admin/v2/journal/files':
      return rewriteJson(res, (json) => {
        for (const r of rows(json)) { r.Name = sampleFile(String(r.Name ?? ''), sampleJournalDir); r[SAMPLE_MARK] = true; }
      });
    case '/api/admin/v2/journal/file':
      return rewriteJson(res, (json) => {
        const r = json.result as Row | undefined;
        if (!r) return;
        for (const x of (Array.isArray(r.Databases) ? r.Databases as Row[] : [])) x.DatabasePathOrAlias = sampleDbDir(String(x.DatabasePathOrAlias ?? ''));
        for (const k of ['PrevFile', 'NextFile']) {
          const f = r[k] as Row | undefined;
          if (f?.File) f.File = sampleFile(String(f.File), sampleJournalDir);
        }
        r[SAMPLE_MARK] = true;
      });
    default:
      return res;
  }
};
