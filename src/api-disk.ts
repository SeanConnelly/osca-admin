// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Disks: database files, the volumes they live on, and journal files.
 *
 * Read (verified against IRIS 2026.2, %Api.Admin.Endpoints.*):
 *  - GET  /database-dirs                 every local database file (Directory, Size MB, MaxSize "Unlimited" | MB, Status…)
 *  - GET  /databases                     configured names → directories (a small duplicate of the Databases screen's fetch)
 *  - GET  /database-dir/volumes?dir=     the database's volume files, with DiskFree (MB) on each file's volume
 *  (Free space inside a database comes from the shared cache in api-db.ts: readDbInfo / cachedDbInfo.)
 *  - GET  /journal/settings              Config.Journal + wijdir
 *  - GET  /journal/files                 newest first (Size and DataSize in bytes)
 *  - GET  /journal/file?file=            one file: previous/next file, databases it covers, end offset
 *
 * Write (%Admin_Operate):
 *  - POST /journal/switch-file           no body → { CurrentFile }  (%SYS.Journal.System.RollToNextFile)
 *  - POST /journal/switch-dir            no body → { CurrentFile }; 409 when there is no other directory
 *  - POST /journal/file/integrity-check?file=  { CheckDetails } → 202 + async-result; read-only
 *
 * Write (%Admin_Manage):
 *  - PUT  /journal/settings              the Config.Journal properties to change (Config.Journal.Modify)
 *
 * Neither switch has been run against the dev instance: the shapes come from
 * the endpoint source. The integrity check was run live on an old file. The
 * settings PUT has never been sent to the dev instance either: the spec gives
 * its body only as a string, so the field names and limits come from the GET
 * and Config.Journal (Modify takes any subset of its properties).
 */
import { get } from './api';
import { sleep, readEnvelope, sendAdmin, writeJson, AdminError } from './crud';
import { SELECT_KEY } from './api-security';

const BASE = '/api/admin/v2';
const q = encodeURIComponent;

// ── Databases and volumes ─────────────────────────────────────────────

export interface LocalDbDir {
  Directory: string;
  /** "Unlimited", or megabytes. */
  MaxSize: number | string;
  /** Megabytes. */
  Size: number;
  Status: string;
  Resource: string;
  Encrypted: boolean;
  Mirrored: boolean;
  SFN: number;
}
export interface DbConfigRow { Name: string; Directory: string; Server: string; Status: string }
export interface VolumeFile {
  VolumeNumber: number;
  VolumeDirectory: string;
  File: string;
  /** Megabytes. */
  Size: number;
  VolumeDirectoryTotalSize: number;
  /** Megabytes free on the file system that holds this volume file. */
  DiskFree: number;
}

export const getDbDirs = (): Promise<LocalDbDir[]> => get('/database-dirs');
export const getDbConfigs = (): Promise<DbConfigRow[]> => get('/databases');
export const getDbVolumes = (dir: string): Promise<VolumeFile[]> => get(`/database-dir/volumes?dir=${q(dir)}`);

// ── Journals ──────────────────────────────────────────────────────────

export interface JournalSettings {
  CurrentDirectory: string;
  AlternateDirectory: string;
  /** Megabytes. */
  FileSizeLimit: number;
  DaysBeforePurge: number;
  BackupsBeforePurge: number;
  CompressFiles: boolean;
  FreezeOnError: boolean;
  JournalFilePrefix: string;
  ArchiveName: string;
  PurgeArchived: boolean;
  JournalcspSession: boolean;
  wijdir: string;
  targwijsz: number;
}
export interface JournalFile {
  Name: string;
  /** Bytes on disk (compressed files are smaller than their data). */
  Size: number;
  DataSize: number;
  CreationTime: string;
  Reason: string;
}
export interface JournalFileDetail {
  Databases: Array<{ SFN: number; DatabasePathOrAlias: string }>;
  /** Bytes of journal data written. */
  End: number;
  FileCount: number;
  /** Bytes. */
  MaxSize: number;
  CreationTime: string;
  EncryptionKeyID: string;
  FileGUID: string;
  MirrorInfo: Record<string, unknown>;
  PrevFile: { File?: string; End?: number };
  NextFile: { File?: string };
}

export const getJournalSettings = (): Promise<JournalSettings> => get('/journal/settings');

/** The journal settings that can be changed: Config.Journal's properties (wijdir / targwijsz are read-only extras of the GET). */
export type JournalSettingsPatch = Partial<Pick<JournalSettings,
  'CurrentDirectory' | 'AlternateDirectory' | 'FileSizeLimit' | 'DaysBeforePurge' | 'BackupsBeforePurge'
  | 'CompressFiles' | 'FreezeOnError' | 'JournalFilePrefix' | 'PurgeArchived' | 'JournalcspSession'>>;
/** Config.Journal's limits, for the editor's checks (IRIS checks them again). */
export const JOURNAL_LIMITS = {
  /** MB. Config.Journal allows 0; a file limit of 0 MB makes no sense, so the editor asks for at least 1. */
  FileSizeLimit: { min: 1, max: 4079 },
  DaysBeforePurge: { min: 0, max: 100 },
  BackupsBeforePurge: { min: 0, max: 10 },
  JournalFilePrefix: { maxlen: 64 },
} as const;
/** Change only the settings given; the rest stay as they are. */
export const saveJournalSettings = (patch: JournalSettingsPatch): Promise<unknown> => writeJson('PUT', '/journal/settings', patch);
export const getJournalFiles = (): Promise<JournalFile[]> => get('/journal/files');
export const getJournalFile = (file: string): Promise<JournalFileDetail> => get(`/journal/file?file=${q(file)}`);
export const switchJournalFile = (): Promise<{ CurrentFile: string }> => writeJson('POST', '/journal/switch-file');
export const switchJournalDir = (): Promise<{ CurrentFile: string }> => writeJson('POST', '/journal/switch-dir');
/** Resolves when IRIS finds nothing wrong; throws with IRIS's reason otherwise. */
export const checkJournalFile = (file: string, details: boolean): Promise<unknown> =>
  runAsync(`/journal/file/integrity-check?file=${q(file)}`, { CheckDetails: details });

// ── Asynchronous requests ─────────────────────────────────────────────

interface AsyncResult<T> { State: string; FailureReason: string; Result: T }

/** POST a request IRIS runs in the background (202 + Location), then wait for its result. */
async function runAsync<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  const res = await sendAdmin(`${BASE}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const location = res.headers.get('Location') ?? '';
  const direct = await readEnvelope<T>(res); // throws IRIS's reason for 4xx/5xx
  if (res.status !== 202) return direct;
  const id = /[?&]id=([^&]+)/.exec(location)?.[1];
  if (!id) throw new AdminError('IRIS accepted the request but didn’t say where to find the result.', 500);
  const started = Date.now();
  for (let wait = 150; ; wait = Math.min(wait * 1.5, 1500)) {
    const r = await get<AsyncResult<T>>(`/async-result?id=${q(decodeURIComponent(id))}`);
    if (r.State === 'Finished') return r.Result;
    if (r.State === 'Failed' || r.State === 'Canceled') throw new AdminError(r.FailureReason || `IRIS ${r.State.toLowerCase()} the request.`, 500);
    if (Date.now() - started > timeoutMs) throw new AdminError('IRIS is still working on this. Try again in a minute.', 504);
    await sleep(wait);
  }
}

// ── Paths, volumes and sizes ──────────────────────────────────────────

/** Windows paths compare case-insensitively; IRIS reports the same directory in both cases. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+$/, '');
    return /^[a-z]:|\\/i.test(p) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}
export const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() || p;
export const dirName = (p: string): string => p.replace(/[\\/][^\\/]*$/, '') + (p.includes('\\') ? '\\' : '/');
/** Windows drive ("C:") or UNC share; null on Unix, where a mount point can't be read from the path. */
export function driveOf(path: string): string | null {
  const m = /^([a-z]:)/i.exec(path);
  if (m) return m[1].toUpperCase();
  const u = /^(\\\\[^\\]+\\[^\\]+)/.exec(path);
  return u ? u[1] : null;
}
/** Longest shared leading directory of a set of paths (a readable name for a Unix volume). */
export function commonDir(paths: string[]): string {
  if (!paths.length) return '';
  const split = paths.map((p) => p.split(/[\\/]/));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const seg = split[0][i];
    if (split.every((s) => s[i] === seg)) out.push(seg); else break;
  }
  const sep = paths[0].includes('\\') ? '\\' : '/';
  return out.join(sep) || sep;
}

export const bytesToMb = (b: number): number => b / 1024 / 1024;

/**
 * How much a database grows by next time: its expansion size, or IRIS's
 * default (12% of its size, at least 10 MB and at most 1 GB).
 */
export function nextGrowth(sizeMb: number, expansionMb: number): number {
  return expansionMb > 0 ? expansionMb : Math.min(1024, Math.max(10, sizeMb * 0.12));
}

// ── Links ─────────────────────────────────────────────────────────────

/** Open another portal screen with one item selected (the target takes it once, see takeSelection). */
export function openSelected(navigate: (id: string) => void, route: string, name: string): void {
  try { sessionStorage.setItem(SELECT_KEY, name); } catch { /* storage blocked: land unselected */ }
  navigate(route);
}

const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
export const diskDocs = {
  databases: `${DOCS}GSA_manage_databases`,
  configure: `${DOCS}GSA_config_databases`,
  journaling: `${DOCS}GCDI_journal`,
};
/** Management Portal pages (each checked to answer 200 on IRIS 2026.2). */
export const diskPortal = {
  databases: '/csp/sys/op/%25CSP.UI.Portal.OpDatabases.zen',
  database: (name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.Database.zen?DBName=${q(name)}`,
  volumes: (name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.DatabaseVolumes.zen?DBName=${q(name)}`,
};

/* ───────────── Journal records (read-only) ───────────── */

/** One row of a journal file's record list. Values are not in the list; only the record read has them. */
export interface JournalRecordRow {
  Address: number;
  TypeName: string;
  ExtTypeName: string;
  /** "YYYY-MM-DD HH:MM:SS", server local time. */
  TimeStamp: string;
  InTransaction: boolean;
  ProcessID: number;
  GlobalNode: string;
  /** The database directory. */
  DatabaseName: string;
}
/**
 * One record in full. OldValue / NewValue can hold anything the application stored: show them masked.
 * IRIS sends "" for a value the journal doesn't hold, so only SetKill.NumberOfValues tells "not stored"
 * from an empty string (verified on 2026.2): a SET holds its new value (1), plus its old value (2) only
 * inside a transaction when the node had one; a KILL holds the killed value (1) only inside a
 * transaction, else 0. Transaction markers have an empty SetKill.
 */
export interface JournalRecordDetail {
  TypeName: string;
  ExtTypeName: string;
  PrevAddress: number;
  NextAddress: number;
  TimeStamp: string;
  InTransaction: boolean;
  ProcessID: string;
  JobID: number;
  RemoteSystemID: number;
  ECPSystemID: number;
  SetKill: Partial<{
    ClusterSequence: number; Collation: number; DatabaseName: string; GlobalNode: string; GlobalReference: string;
    MirrorDatabaseName: string; NewValue: unknown; NumberOfValues: number; OldValue: unknown;
  }>;
  VectorSetKill: Partial<{ VecIndex: number; VecType: string }>;
}
export interface JournalRecordQuery {
  file: string;
  /** One server-side filter (IRIS takes one): a column, an operator ("[" contains, "=" equals) and a value. */
  match?: { column: 'GlobalNode' | 'ProcessID' | 'TypeName'; op: '[' | '='; value: string };
  /** Start at this record (included). */
  offset?: number;
  /** Newest first. */
  reverse?: boolean;
  /** Records wanted (IRIS returns about this many; at most 200). */
  rows?: number;
}

/**
 * A page of a journal file's records. IRIS runs the listing as a background job; this queues it and waits
 * (up to 30 s). IRIS's job steps its row counter twice per record, so it's asked for twice the rows wanted.
 */
export async function listJournalRecords(qy: JournalRecordQuery, alive: () => boolean = () => true): Promise<JournalRecordRow[]> {
  const params = new URLSearchParams({ file: qy.file, reverse: qy.reverse === false ? '0' : '1', maxRows: String(Math.min(200, qy.rows ?? 100) * 2) });
  if (qy.offset !== undefined) params.set('initialOffset', String(qy.offset));
  if (qy.match && qy.match.value) {
    params.set('matchColumnName', qy.match.column);
    params.set('matchOperator', qy.match.op);
    params.set('matchValue', qy.match.value);
  }
  const res = await sendAdmin(`/api/admin/v2/journal/file/records?${params}`, { method: 'POST', headers: { Accept: 'application/json' } });
  const loc = res.headers.get('Location') ?? '';
  await readEnvelope(res);
  const id = /[?&]id=([^&]+)/.exec(loc)?.[1];
  if (!id) throw new Error('IRIS didn’t start the record listing.');
  const started = Date.now();
  for (let wait = 150; ; wait = Math.min(wait * 1.5, 1500)) {
    if (!alive()) return [];
    const r = await get<{ State: string; FailureReason: string; Result: JournalRecordRow[] | Record<string, never> }>(`/async-result?id=${q(id)}`);
    if (r.State === 'Finished') return Array.isArray(r.Result) ? r.Result : [];
    if (r.State === 'Failed' || r.State === 'Canceled') throw new AdminError(String(r.FailureReason ?? '').replace(/^(\s*[^\s#]{0,16}\s*#\s*-?\d+\s*:\s*)+/u, '').trim() || 'IRIS couldn’t list the records.', 500);
    if (Date.now() - started > 30000) throw new Error('Reading the journal is taking too long. Narrow the filter and try again.');
    await sleep(wait);
  }
}
export const getJournalRecord = (file: string, address: number): Promise<JournalRecordDetail> =>
  get(`/journal/file/record?file=${q(file)}&address=${address}`);
