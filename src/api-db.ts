// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Databases and namespaces: /v2/databases, /v2/database, /v2/database-dirs,
 * /v2/database-dir*, /v2/namespaces, /v2/namespace*.
 *
 * Verified live against IRISHealth262 (2026.2 build 221, 2026-09-26) with a
 * throwaway database `OSCA_TEST_DB` (directory mgr\osca_test_db\), created,
 * exercised and deleted (the leftover empty folder was removed too):
 * - Create is two calls. POST /database-dir {Directory, Size, GlobalJournalState…}
 *   makes the IRIS.DAT (201); PUT /database?name=X {Directory} adds it to the
 *   configuration under a name (201). Without GlobalJournalState the new
 *   database is NOT journaled, so the form always sends it. With Size > 1 the
 *   POST answers 500 "JOB command failed" although a 1 MB file IS made, so the
 *   file is created at 1 MB and grown with modify-size (verified: 3 MB).
 * - GET /database-dir?dir= gives the settings (MaxSize, ExpansionSize,
 *   ResourceName, GlobalJournalState, ReadOnly…); PUT the same shape changes
 *   them (MaxSize 50, ExpansionSize 2, journaling on: 200).
 * - POST /database-dir/info?dir= answers 202 + Location; the async result has
 *   Size, MaxSize, AvailableSpace (MB free inside), EndFree (MB free at the end
 *   of the file, "" when not mounted or read-only), DiskFree ("62.08GB"),
 *   ReadOnlyReason, LastExpansionTime, BlockSize, Mounted, Full…
 * - modify-size {Size} (3 MB: grew), truncate {TargetSize: 0} (3 → 1 MB),
 *   compact {TargetFreeSpace}, defragment (no body), integrity-check
 *   {Databases:[{Directory}]}, expand-volume {InitialSize} (added IRIS-0001.VOL):
 *   all 202 + an async result. The integrity report is in the result's Console.
 * - dismount / mount {ReadOnly} are synchronous (200). Mounted read-only,
 *   compact fails with "Read-only file system".
 * - DELETE /database?name= removes it from the configuration (the file stays);
 *   DELETE /database-dir?dir= then deletes IRIS.DAT and its volumes.
 * - Status reads "Mounted/RW", "Mounted/R" or "Dismounted"; MaxSize in the
 *   list is "Unlimited" or a number as a string (MB).
 * Free space inside a file comes from /database-dir/info (AvailableSpace), not
 * the metrics feed: its iris_db_free_space sensor is sampled only now and then
 * (IRISSYS read 5.0 MB there vs 3.1 MB on demand) and has no row for IRISLIB;
 * iris_directory_space has none for IRISLIB or IRISLOCALDATA. Disk free comes
 * from /database-dir/volumes (DiskFree, MB), which every local database answers.
 * Nothing existing was mounted, dismounted, compacted, truncated or resized.
 */
import { get } from './api';
import { sleep, sendAdmin, readEnvelope, AdminError } from './crud';
import { SELECT_KEY } from './api-security';

const q = encodeURIComponent;
const BASE = '/api/admin/v2';

/* ───────────── Shapes ───────────── */

/** One row of the configuration list (every database with a name, local or remote). */
export interface DbConfigRow {
  Name: string;
  Directory: string;
  Server: string;
  ClusterMountMode: boolean;
  MountRequired: boolean;
  MountAtStartup: boolean;
  StreamLocation: string;
  Status: string;
}
/** One row of the local database files list. */
export interface DbDirRow {
  Directory: string;
  MaxSize: string | number;
  Size: number;
  Status: string;
  Resource: string;
  Encrypted: boolean;
  Mirrored: boolean;
  SFN: number;
  EncryptionKeyID: string;
}
/** A local database's settings. */
export interface DbSettings {
  MaxSize: number;
  ExpansionSize: number;
  NewVolumeThreshold: number;
  NewVolumeDirectory: string;
  ResourceName: string;
  NewGlobalIsKeep: boolean;
  NewGlobalCollation: number;
  ClusterMountMode: boolean;
  ReadOnly: boolean;
  GlobalJournalState: boolean;
}
/** Figures IRIS works out on request (it takes a moment on a big database). */
export interface DbInfo {
  Size: number;
  ExpansionSize: number;
  MaxSize: number;
  ReadOnlyReason: string;
  EncryptionKeyID: string;
  BlockSize: number;
  Blocks: number;
  AvailableSpace: number;
  DiskFree: string;
  EndFree: number | '';
  LastExpansionTime: string;
  MirrorSetName: string;
  MirrorDBName: string;
  SFN: number;
  Mirrored: boolean;
  Encrypted: boolean;
  Full: boolean;
  Mounted: boolean;
  MirrorFailoverDB: boolean;
}
export interface DbVolume { VolumeNumber: number; VolumeDirectory: string; File: string; Size: number; VolumeDirectoryTotalSize: number; DiskFree: number }

/** One database as the screens see it: the configuration row joined to its file. */
export interface Db {
  name: string;
  directory: string;
  /** Remote (ECP) databases have a server and no local file. */
  server: string;
  state: 'mounted' | 'readonly' | 'dismounted' | 'remote' | 'unknown';
  statusRaw: string;
  sizeMb: number;
  /** 0 = unlimited. */
  maxMb: number;
  resource: string;
  encrypted: boolean;
  mirrored: boolean;
  mountAtStartup: boolean;
  mountRequired: boolean;
  system: boolean;
}

export interface Namespace {
  Name: string;
  Globals: string;
  Routines: string;
  SysGlobals: string;
  SysRoutines: string;
  Library: string;
  TempGlobals: string;
}
export interface GlobalMapping { Name: string; Subscript: string; Database: string; Collation: number; LockDatabase: string }
export interface RoutineMapping { Name: string; Type: string; Database: string }
export interface PackageMapping { Name: string; Database: string }
export interface NamespaceFull extends Namespace {
  globals: GlobalMapping[];
  routines: RoutineMapping[];
  packages: PackageMapping[];
  /** Mappings couldn't be read (no permission, or IRIS refused). */
  mappingsUnknown: boolean;
  /** Interoperability (productions) is switched on: its packages come from ENSLIB. */
  interop: boolean;
}

/* ───────────── Reads ───────────── */

export const dirKey = (d: string): string => d.toLowerCase().replace(/[\\/]+$/, '');

/** Databases IRIS installs and needs; availability and destructive actions are blocked on them. */
export const SYSTEM_DBS: Record<string, string> = {
  IRISSYS: 'IRIS’s own system database: its configuration and the %SYS namespace.',
  IRISLIB: 'IRIS’s system code library. It is mounted read-only.',
  IRISTEMP: 'Temporary data. It is emptied at every restart and never journaled.',
  IRISLOCALDATA: 'Data that belongs to this instance only and is never mirrored.',
  IRISAUDIT: 'The audit log.',
  IRISSECURITY: 'Users, roles, resources and the other security settings.',
  IRISMETRICS: 'Monitoring data IRIS keeps about itself.',
  ENSLIB: 'The interoperability (productions) code library. It is mounted read-only.',
  HSLIB: 'The HealthShare code library.',
  HSSYS: 'HealthShare’s system database.',
  HSAUDIT: 'HealthShare’s audit data.',
  HSSYSLOCALTEMP: 'HealthShare’s local temporary data.',
};
export const isSystemDb = (name: string): boolean => Object.prototype.hasOwnProperty.call(SYSTEM_DBS, name.toUpperCase());

function stateOf(status: string, server: string): Db['state'] {
  if (server) return 'remote';
  const s = status.toLowerCase();
  if (s.startsWith('mounted/rw')) return 'mounted';
  if (s.startsWith('mounted/r')) return 'readonly';
  if (s.startsWith('dismounted') || s.startsWith('unmounted')) return 'dismounted';
  return 'unknown';
}

/** Every database: configuration joined to the local file on its directory. */
export async function getDatabases(): Promise<Db[]> {
  const [cfg, dirs] = await Promise.all([
    get<DbConfigRow[]>('/databases'),
    get<DbDirRow[]>('/database-dirs').catch(() => [] as DbDirRow[]),
  ]);
  const byDir = new Map(dirs.map((d) => [dirKey(d.Directory), d]));
  return cfg.map((c) => {
    const d = c.Server ? undefined : byDir.get(dirKey(c.Directory));
    const max = d ? (typeof d.MaxSize === 'number' ? d.MaxSize : /^\d+(\.\d+)?$/.test(String(d.MaxSize)) ? Number(d.MaxSize) : 0) : 0;
    return {
      name: c.Name,
      directory: c.Directory,
      server: c.Server,
      state: stateOf(c.Status || d?.Status || '', c.Server),
      statusRaw: c.Status || d?.Status || '',
      sizeMb: d ? Number(d.Size) : NaN,
      maxMb: max,
      resource: d?.Resource ?? '',
      encrypted: !!d?.Encrypted,
      mirrored: !!d?.Mirrored,
      mountAtStartup: c.MountAtStartup,
      mountRequired: c.MountRequired,
      system: isSystemDb(c.Name),
    };
  });
}

export const getDbSettings = (dir: string): Promise<DbSettings> => get(`/database-dir?dir=${q(dir)}`);
export const getDbVolumes = (dir: string): Promise<DbVolume[]> => get(`/database-dir/volumes?dir=${q(dir)}`);

/* ───────────── Background work ───────────── */

export interface AsyncResult<T = unknown> {
  State: 'Queued' | 'Running' | 'Finished' | 'Failed' | 'Canceled' | 'Paused';
  TaskName: string;
  FailureReason: string;
  Console?: string[];
  Result: T;
  TimeQueued?: string;
  TimeStarted?: string;
  TimeFinished?: string;
}

/** Send a request that IRIS queues as background work; resolves with the job id (or null when it ran at once). */
async function queue(path: string, body?: unknown): Promise<string | null> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await sendAdmin(`${BASE}${path}`, init);
  const loc = res.headers.get('Location') ?? '';
  await readEnvelope(res);
  return /[?&]id=([^&]+)/.exec(loc)?.[1] ?? null;
}


/** Wait for a background job; throws with IRIS's reason if it failed. `timeoutMs` 0 = no limit. */
export async function waitJob<T>(id: string, timeoutMs = 0, alive: () => boolean = () => true): Promise<AsyncResult<T>> {
  const started = Date.now();
  for (let wait = 150; ; wait = Math.min(wait * 1.5, 2000)) {
    if (!alive()) throw new Error('Stopped waiting.');
    const r = await get<AsyncResult<T>>(`/async-result?id=${q(id)}`);
    if (r.State === 'Finished') return r;
    if (r.State === 'Failed' || r.State === 'Canceled') {
      const err = new AdminError(String(r.FailureReason ?? '').replace(/^(\s*[^\s#]{0,16}\s*#\s*-?\d+\s*:\s*)+/u, '').trim() || `It ${r.State.toLowerCase()}.`, 500);
      (err as AdminError & { job?: AsyncResult<T> }).job = r;
      throw err;
    }
    if (timeoutMs && Date.now() - started > timeoutMs) throw new Error('IRIS is taking too long to answer. Try again in a moment.');
    await sleep(wait);
  }
}

/** Queue work and wait for it. */
async function run<T>(path: string, body?: unknown, timeoutMs = 0): Promise<AsyncResult<T> | null> {
  const id = await queue(path, body);
  return id ? waitJob<T>(id, timeoutMs) : null;
}

/*
 * Every figures read is a background job in IRIS (and a work-queue worker
 * while it runs), so the whole app runs at most MAX_INFO_JOBS of them at once;
 * the rest wait their turn here, in the browser. A slot is held until IRIS's
 * job has really ended (up to INFO_JOB_HOLD_MS), even when the caller stopped
 * waiting after INFO_WAIT_MS: giving up on a slow job must not let another
 * start beside it.
 */
const MAX_INFO_JOBS = 2;
const INFO_WAIT_MS = 30000;
const INFO_JOB_HOLD_MS = 5 * 60 * 1000;
let infoJobs = 0;
const infoWaiting: Array<() => void> = [];
const acquireInfoSlot = (): Promise<void> => {
  if (infoJobs < MAX_INFO_JOBS) { infoJobs++; return Promise.resolve(); }
  return new Promise((resolve) => { infoWaiting.push(resolve); });
};
/** Hand the slot to the next read waiting, or free it. */
const releaseInfoSlot = (): void => {
  const next = infoWaiting.shift();
  if (next) next(); else infoJobs = Math.max(0, infoJobs - 1);
};

/**
 * The figures IRIS works out on request (free space inside, at the end, disk
 * free…). Screens call readDbInfo() (cached); this is the throttled read under it.
 */
export async function getDbInfo(dir: string): Promise<DbInfo> {
  await acquireInfoSlot();
  let id: string | null;
  try {
    id = await queue(`/database-dir/info?dir=${q(dir)}`, {});
  } catch (err) {
    releaseInfoSlot();
    throw err;
  }
  if (!id) { releaseInfoSlot(); throw new Error('IRIS didn’t return the database’s figures.'); }
  const job = waitJob<DbInfo>(id, INFO_JOB_HOLD_MS).finally(releaseInfoSlot);
  job.catch(() => { /* reported to the caller below, or after it stopped waiting: nothing to do */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('IRIS is taking too long to answer. Try again in a moment.')), INFO_WAIT_MS);
  });
  try {
    const r = await Promise.race([job, late]);
    return r.Result;
  } finally {
    clearTimeout(timer);
  }
}

/*
 * One shared cache of those figures for every screen (Databases, Capacity).
 * At most one read in flight per database, at most MAX_INFO_JOBS across the
 * app, and a read (or a failed one) is reused for 10 minutes. Only `force`
 * reads inside that window, and only the screens' refresh buttons pass it.
 * Screens should read only mounted local databases.
 */
export const DB_INFO_TTL = 10 * 60 * 1000;
const infoCache = new Map<string, { info: DbInfo; at: number }>();
const infoFailed = new Map<string, { err: unknown; at: number }>();
const infoInflight = new Map<string, Promise<DbInfo>>();

/** The last figures read for a database directory, however old; undefined if never read. */
export function cachedDbInfo(dir: string): DbInfo | undefined {
  return infoCache.get(dirKey(dir))?.info;
}
/**
 * The figures for a database: from the cache while younger than 10 minutes,
 * else one (throttled) read. A read that failed isn't retried for 10 minutes
 * either. `force` (the refresh button only) reads again, but still joins a
 * read already in flight.
 */
export function readDbInfo(dir: string, force = false): Promise<DbInfo> {
  const key = dirKey(dir);
  const hit = infoCache.get(key);
  if (!force && hit && Date.now() - hit.at < DB_INFO_TTL) return Promise.resolve(hit.info);
  const failed = infoFailed.get(key);
  if (!force && !hit && failed && Date.now() - failed.at < DB_INFO_TTL) return Promise.reject(failed.err);
  const running = infoInflight.get(key);
  if (running) return running;
  const p = getDbInfo(dir)
    .then((info) => { infoCache.set(key, { info, at: Date.now() }); infoFailed.delete(key); return info; },
      (err: unknown) => { infoFailed.set(key, { err, at: Date.now() }); throw err; })
    .finally(() => { infoInflight.delete(key); });
  infoInflight.set(key, p);
  return p;
}
/** Drop a database's cached figures (after it was resized, compacted, mounted…): the next readDbInfo reads once. */
export function forgetDbInfo(dir: string): void {
  infoCache.delete(dirKey(dir));
  infoFailed.delete(dirKey(dir));
}

/* ───────────── Actions ───────────── */

export const mountDb = (dir: string, readOnly = false): Promise<unknown> =>
  queue(`/database-dir/mount?dir=${q(dir)}`, { ReadOnly: readOnly });
export const dismountDb = (dir: string): Promise<unknown> => queue(`/database-dir/dismount?dir=${q(dir)}`);
/** Grow the file to `sizeMb`. */
export const expandDb = (dir: string, sizeMb: number): Promise<unknown> => run(`/database-dir/modify-size?dir=${q(dir)}`, { Size: sizeMb });
/** Move `mb` of free space to the end of the file, where Truncate can hand it back. */
export const compactDb = (dir: string, mb: number): Promise<unknown> => run(`/database-dir/compact?dir=${q(dir)}`, { TargetFreeSpace: mb });
/** Return free space at the end of the file to the disk; 0 = as much as possible. */
export const truncateDb = (dir: string, targetMb: number): Promise<unknown> => run(`/database-dir/truncate?dir=${q(dir)}`, { TargetSize: targetMb });
export const defragmentDb = (dir: string): Promise<unknown> => run(`/database-dir/defragment?dir=${q(dir)}`);
/** Integrity check: the report is the job's console output. */
export async function checkDb(dir: string): Promise<{ ok: boolean; lines: string[]; reason?: string }> {
  try {
    const r = await run<unknown>('/database-dir/integrity-check', { Databases: [{ Directory: dir }] });
    const lines = r?.Console ?? [];
    // The report's summary line: "No Errors were found." or "Errors found in N globals…".
    return { ok: lines.some((l) => /^\s*No Errors were found/i.test(l)) && !lines.some((l) => /^\s*Errors found in/i.test(l)), lines };
  } catch (err) {
    const job = (err as { job?: AsyncResult }).job;
    if (job) return { ok: false, lines: job.Console ?? [], reason: (err as Error).message };
    throw err;
  }
}

export type DbSettingsPatch = Partial<Pick<DbSettings, 'MaxSize' | 'ExpansionSize' | 'ResourceName' | 'GlobalJournalState' | 'ReadOnly'>>;
export async function saveDbSettings(dir: string, patch: DbSettingsPatch): Promise<DbSettings> {
  const res = await sendAdmin(`${BASE}/database-dir?dir=${q(dir)}`, {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  return readEnvelope<DbSettings>(res);
}
export async function saveDbStartup(name: string, patch: { MountAtStartup?: boolean; MountRequired?: boolean }): Promise<unknown> {
  const res = await sendAdmin(`${BASE}/database?name=${q(name)}`, {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  return readEnvelope(res);
}

export interface NewDb { name: string; directory: string; sizeMb: number; maxMb: number; expansionMb: number; journal: boolean; resource: string }
/**
 * Create the file, then name it in the configuration. If naming fails, the
 * new file is deleted again so nothing half-made is left behind.
 */
export async function createDb(n: NewDb): Promise<void> {
  const send = async (method: string, path: string, body?: unknown): Promise<unknown> => readEnvelope(await sendAdmin(`${BASE}${path}`, {
    method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  // Always 1 MB here: a larger Size makes IRIS start a background job that fails from a REST call
  // ("JOB command failed", HTTP 500) although the file is made. Growing it afterwards works.
  await send('POST', '/database-dir', { Directory: n.directory, Size: 1, GlobalJournalState: n.journal, ResourceName: n.resource });
  try {
    if (n.sizeMb > 1) await expandDb(n.directory, n.sizeMb);
    if (n.maxMb || n.expansionMb) await send('PUT', `/database-dir?dir=${q(n.directory)}`, { MaxSize: n.maxMb, ExpansionSize: n.expansionMb });
    await send('PUT', `/database?name=${q(n.name)}`, { Directory: n.directory });
  } catch (err) {
    await send('DELETE', `/database-dir?dir=${q(n.directory)}`).catch(() => { /* best effort */ });
    throw err;
  }
}

/** Remove a database from the configuration; with `deleteFile`, delete its IRIS.DAT too. */
export async function deleteDb(name: string, dir: string, deleteFile: boolean): Promise<void> {
  const send = async (path: string): Promise<unknown> => readEnvelope(await sendAdmin(`${BASE}${path}`, { method: 'DELETE', headers: { Accept: 'application/json' } }));
  await send(`/database?name=${q(name)}`);
  if (deleteFile) await send(`/database-dir?dir=${q(dir)}`);
}

/* ───────────── Namespaces ───────────── */

export const getNamespaces = (): Promise<Namespace[]> => get('/namespaces');

/** Namespaces with their mappings (one read of each mapping list per namespace). */
export async function getNamespacesFull(): Promise<NamespaceFull[]> {
  const list = await getNamespaces();
  return Promise.all(list.map(async (ns) => {
    const n = q(ns.Name);
    try {
      const [globals, routines, packages] = await Promise.all([
        get<GlobalMapping[]>(`/namespace/global-mappings?namespace=${n}`),
        get<RoutineMapping[]>(`/namespace/routine-mappings?namespace=${n}`),
        get<PackageMapping[]>(`/namespace/package-mappings?namespace=${n}`),
      ]);
      return { ...ns, globals, routines, packages, mappingsUnknown: false, interop: packages.some((p) => p.Name === 'Ens' && p.Database === 'ENSLIB') };
    } catch {
      return { ...ns, globals: [], routines: [], packages: [], mappingsUnknown: true, interop: false };
    }
  }));
}

/*
 * Creating a namespace (verified live 2026-09-27 with OSCA_TEST_NS_E on a new
 * OSCA_TEST_DB_E, both deleted afterwards and confirmed gone by a read):
 * - GET /namespace?name=X answers #420 "does not exist" for a free name.
 * - PUT /namespace?name=X {Globals, Routines[, TempGlobals]} creates it (201);
 *   on an existing name the same PUT CHANGES it, so callers check first.
 * - POST /namespace/enable-interop?name=X answers 202 + a job (about 3 s). It
 *   maps Ens* from ENSLIB and, besides, creates two databases next to the data
 *   database (<DATA>ENSTEMP and <DATA>SECONDARY, with a %DB_<DATA>SECONDARY
 *   resource), the web application /csp/<ns> and the role
 *   %EnsRole_ProdPrivs_<NS>.
 * - DELETE /namespace?name=X removes the namespace and its /csp/<ns> web
 *   application; the databases, that resource and that role stay.
 */

/** Whether a namespace of this name exists (IRIS answers "does not exist" for a free name). */
export async function namespaceExists(name: string): Promise<boolean> {
  try {
    await get(`/namespace?name=${q(name)}`);
    return true;
  } catch (err) {
    const e = err as AdminError;
    if (e?.code === 420 || e?.id === 'CPFNameDoesNotExist' || /does not exist/i.test(String(e?.message ?? ''))) return false;
    throw err;
  }
}

/** Create a namespace on existing databases. Refuses a name that already exists (the same call would change it). */
export async function createNamespace(name: string, globals: string, routines: string): Promise<void> {
  if (await namespaceExists(name)) throw new AdminError(`A namespace named ${name} already exists.`, 409);
  await readEnvelope(await sendAdmin(`${BASE}/namespace?name=${q(name)}`, {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ Globals: globals, Routines: routines }),
  }));
}

/**
 * Change the databases an existing namespace uses. The same PUT that creates a
 * namespace changes one that exists (seen while verifying create; GET answers
 * {Globals, Routines, TempGlobals}), so this refuses a name that doesn't exist
 * rather than create it. All three are sent.
 */
export async function updateNamespace(name: string, dbs: { Globals: string; Routines: string; TempGlobals: string }): Promise<void> {
  if (!(await namespaceExists(name))) throw new AdminError(`There is no namespace called ${name}. It may have been deleted.`, 404);
  await readEnvelope(await sendAdmin(`${BASE}/namespace?name=${q(name)}`, {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(dbs),
  }));
}

/** Switch on interoperability (productions) in a namespace; resolves when IRIS has finished (a few seconds). */
export async function enableInterop(name: string): Promise<void> {
  await run(`/namespace/enable-interop?name=${q(name)}`, {}, 120000);
}

/*
 * Deleting a namespace and editing its mappings (verified live 2026-09-27 on
 * OSCA_TEST_NS_M over a new OSCA_TEST_DB_M, both deleted afterwards; the
 * namespace, database and web-app lists were identical before and after):
 * - GET/PUT/DELETE /namespace/{global,routine,package}-mapping?namespace=N&name=X.
 *   A global mapping's name carries its subscript range: X("A"):("M").
 * - PUT on a new name creates it (201); on an existing name it changes it
 *   (200), so an add checks first. Body {Database}; globals also take
 *   LockDatabase (IRIS keeps the old one unless it is sent).
 * - A subscript-range mapping makes IRIS add a whole-global mapping of the
 *   same global too; removing the range leaves that one in place.
 * - DELETE of a missing mapping answers 404, #421 "does not exist".
 * - DELETE /namespace?name=N removes the namespace and its /csp/<n> web
 *   application; its databases stay (and, if interoperability was enabled,
 *   the <DATA>ENSTEMP and <DATA>SECONDARY databases, the %DB_<DATA>SECONDARY
 *   resource and the %EnsRole_ProdPrivs_<N> role).
 */
export type MappingKind = 'global' | 'routine' | 'package';

const mappingPath = (kind: MappingKind, ns: string, name: string): string =>
  `${BASE}/namespace/${kind}-mapping?namespace=${q(ns)}&name=${q(name)}`;

/** Whether a namespace already has a mapping of this kind and name. */
export async function mappingExists(kind: MappingKind, ns: string, name: string): Promise<boolean> {
  try {
    await readEnvelope(await sendAdmin(mappingPath(kind, ns, name), { headers: { Accept: 'application/json' } }));
    return true;
  } catch (err) {
    const e = err as AdminError;
    if (e?.code === 421 || e?.status === 404 || /does not exist/i.test(String(e?.message ?? ''))) return false;
    throw err;
  }
}

/** Create or change a mapping. For a global, the lock database follows the database. */
export async function saveMapping(kind: MappingKind, ns: string, name: string, database: string): Promise<void> {
  const body = kind === 'global' ? { Database: database, LockDatabase: database } : { Database: database };
  await readEnvelope(await sendAdmin(mappingPath(kind, ns, name), {
    method: 'PUT', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

export async function deleteMapping(kind: MappingKind, ns: string, name: string): Promise<void> {
  await readEnvelope(await sendAdmin(mappingPath(kind, ns, name), { method: 'DELETE', headers: { Accept: 'application/json' } }));
}

/** Delete a namespace (and its /csp/<ns> web application). Its databases stay. */
export async function deleteNamespace(name: string): Promise<void> {
  await readEnvelope(await sendAdmin(`${BASE}/namespace?name=${q(name)}`, { method: 'DELETE', headers: { Accept: 'application/json' } }));
}

/** How a namespace uses a database: "globals", "routines", "temporary globals", plus mapped items. */
export interface DbUse { namespace: string; roles: string[]; mapped: number }
export function usesOf(db: string, spaces: NamespaceFull[]): DbUse[] {
  const out: DbUse[] = [];
  for (const ns of spaces) {
    const roles: string[] = [];
    if (ns.Globals === db) roles.push('data (globals)');
    if (ns.Routines === db) roles.push('code (routines)');
    if (ns.TempGlobals === db) roles.push('temporary data');
    if (ns.Library === db && ns.Routines !== db) roles.push('system code');
    if (ns.SysGlobals === db && ns.Globals !== db) roles.push('system data');
    const mapped = ns.globals.filter((m) => m.Database === db).length + ns.routines.filter((m) => m.Database === db).length + ns.packages.filter((m) => m.Database === db).length;
    if (roles.length || mapped) out.push({ namespace: ns.Name, roles, mapped });
  }
  return out;
}

/* ───────────── Presentation helpers ───────────── */

/** "62.08GB" (IRIS's text) → megabytes. */
export function parseSize(text: string): number {
  const m = /^\s*([\d.]+)\s*(KB|MB|GB|TB)?\s*$/i.exec(String(text ?? ''));
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = (m[2] ?? 'MB').toUpperCase();
  return u === 'KB' ? n / 1024 : u === 'GB' ? n * 1024 : u === 'TB' ? n * 1024 * 1024 : n;
}

/** Open another screen with an item selected (Databases ↔ Namespaces). */
export function linkToScreen(navigate: (id: string) => void, screen: string, key: string): void {
  try { sessionStorage.setItem(SELECT_KEY, key); } catch { /* storage blocked: land unselected */ }
  navigate(screen);
}

/** Classic Management Portal pages. */
export const portalDb = {
  properties: (dir: string, name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.Database.zen?Dir=${q(dir)}&DBName=${q(name)}`,
};

export const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
