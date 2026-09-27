// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client for OSCA Admin's own read-only REST API (OscaPortal.API.Dispatch),
 * served as the /api/osca web application when the module is installed. It
 * fills gaps in the SysAdmin API (docs/api-gaps.md). Requests carry the same
 * JWT as the Admin API (authFetch, src/auth.ts). Screens call apiAvailable()
 * first and hide what needs this API when it isn't installed.
 *
 * Errors come back as { error: "message" } with an HTTP status and are thrown
 * as AdminError (src/crud.ts), like the Admin API's.
 */
import { authFetch } from './auth';
import { AdminError } from './crud';

const BASE = '/api/osca/v1';

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new AdminError('Can’t reach the IRIS server. Check that the instance is running.', 0);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !body) {
    const message = body?.error ?? (res.status === 403 ? 'You don’t have permission to do that.' : 'Something went wrong.');
    throw new AdminError(message, res.status);
  }
  return body;
}

const q = encodeURIComponent;

/* ───────────── Availability ───────────── */

export interface OscaInfo {
  api: 'osca';
  version: string;
  endpoints: Array<{ method: string; path: string; params?: string[]; summary: string }>;
}

let available: Promise<boolean> | null = null;
/** Is the OSCA API installed and answering? Asked once per session unless `recheck`. */
export function apiAvailable(recheck = false): Promise<boolean> {
  if (recheck) available = null;
  available ??= get<OscaInfo>('/info').then((i) => i.api === 'osca', () => false);
  return available;
}

/* ───────────── Class shape ───────────── */

export interface ClassProp {
  name: string;
  /** Full class name of the type, e.g. "%Library.String". */
  type: string;
  collection: 'list' | 'array' | '';
  relationship: boolean;
  /** "one" | "many" | "parent" | "children", only on relationships. */
  cardinality?: string;
  private: boolean;
  calculated: boolean;
  multiDimensional: boolean;
  /** The class that declares it (inherited properties name their superclass). */
  origin: string;
  /** First sentence, plain text. */
  description: string;
}

export interface ClassShape {
  name: string;
  namespace: string;
  super: string;
  abstract: boolean;
  /** "persistent", "serial", "datatype", "view", "index" or "" (registered object). */
  classType: string;
  persistent: boolean;
  description: string;
  /** Sorted by name, inherited ones included; at most 500. */
  properties: ClassProp[];
  propertyCount: number;
  truncated: boolean;
}

/** A compiled class's structure (never any values). 404 when it doesn't exist in `ns`. */
export const getClassShape = (name: string, ns: string): Promise<ClassShape> =>
  get(`/class?name=${q(name)}&namespace=${q(ns)}`);

/* ───────────── Task classes ───────────── */

export interface TaskSetting {
  name: string;
  type: string;
  collection: string;
  required: boolean;
  /** The literal default; "" when there is none or it is computed (see defaultExpression). */
  default: string | number;
  /** ObjectScript that computes the default, when it isn't a literal. */
  defaultExpression?: string;
  description: string;
  maxlen?: string;
  minval?: string;
  maxval?: string;
  valueList?: string[];
  displayList?: string[];
}

export interface TaskClass {
  class: string;
  /** The TaskName parameter (the class name when it has none). */
  taskName: string;
  description: string;
  /** A % class: the same in every namespace. */
  system: boolean;
  hidden: boolean;
  /** "resource[:permission]" needed to create or run it; "" for none. */
  resource: string;
  /** Does the signed-in user hold that resource? */
  permitted: boolean;
  settings: TaskSetting[];
  /** Where a non-system class was found; [] for system classes (everywhere). */
  namespaces: string[];
}

export interface TaskClassList {
  namespace: string;
  items: TaskClass[];
  count: number;
  truncated: boolean;
  /** Namespaces that couldn't be read (no permission, database not mounted…). */
  skipped: Array<{ namespace: string; error: string }>;
}

/** The task classes a new task can use, in one namespace or "all". */
export const getTaskClasses = (ns: string): Promise<TaskClassList> =>
  get(`/tasks/classes?namespace=${q(ns)}`);

/* ───────────── Login history ───────────── */

export interface LoginEvent {
  /** ISO 8601, UTC. */
  time: string;
  event: 'Login' | 'LoginFailure';
  success: boolean;
  ip: string;
  client: string;
  authentication: string;
  service: string;
  application: string;
  /** Why it failed (LoginFailure only). */
  reason?: string;
}

export interface LoginHistory {
  user: string;
  limit: number;
  days: number;
  /** null when the signed-in user may not read the audit settings. */
  auditing: boolean | null;
  loginEventsEnabled: boolean | null;
  loginFailureEventsEnabled: boolean | null;
  /** Newest first. Empty when auditing or the login events are off. */
  items: LoginEvent[];
}

/** A user's recent logins and failed logins, from the audit log. */
export const getLoginHistory = (user: string, limit = 50, days = 90): Promise<LoginHistory> =>
  get(`/users/${q(user)}/logins?limit=${limit}&days=${days}`);

/* ───────────── Server identity ───────────── */

export interface ServerInfo {
  /** The OS host name, e.g. "EVO". */
  hostName: string;
  /** Fully qualified name, lower case (the host name when there is no domain). */
  fqdn: string;
  /** Configured interfaces, loopback excluded; IPv4 first. */
  ipAddresses: string[];
  /** e.g. "IRISHEALTH262". */
  instanceName: string;
  /** e.g. "Windows", "UNIX". */
  os: string;
  /** e.g. "x86-64". */
  platform: string;
  /** "" when the OS doesn't report a real version. */
  osVersion: string;
  cpuCount: number;
  /** Physical memory; Windows only. */
  memoryMB?: number;
}

/** The server's own identity (the browser only knows the name it used to reach it). */
export const getServerInfo = (): Promise<ServerInfo> => get('/server');

/* ───────────── Server file browsing (administrators only) ─────────────
 * Needs %Admin_Manage, %Admin_Secure or %Development (403 otherwise). Obeys
 * Filesystem access for %GUIFileSelector, the limit on IRIS's own file
 * picker: when it's on, only its folders (and nothing through a link) can be
 * browsed. Never returns file contents. */

export interface FsRoot {
  name: string;
  /** Normalised, with a trailing separator. */
  path: string;
  /** "drive" (Windows), "root" (Unix /), or "allowed" (a folder a Filesystem access limit allows). */
  type: 'drive' | 'root' | 'allowed';
  totalBytes?: number;
  freeBytes?: number;
}

export interface FsPlace {
  id: 'install' | 'mgr' | 'home';
  name: string;
  path: string;
}

export interface FsRoots {
  separator: '\\' | '/';
  roots: FsRoot[];
  places: FsPlace[];
  /** A Filesystem access limit is on: only `roots` (and what's inside them) can be browsed. */
  restricted: boolean;
}

export interface FsEntry {
  name: string;
  /** Full path; folders end with the separator. */
  path: string;
  type: 'dir' | 'file';
  /** Bytes; null for folders or when unknown. */
  size: number | null;
  /** ISO 8601, UTC; null when unknown. */
  modified: string | null;
  hidden: boolean;
  /** A symbolic link or junction (never listed while a limit is on). */
  link?: boolean;
}

export interface FsListing {
  /** Normalised, with a trailing separator. */
  dir: string;
  /** "" at a drive root, at /, or at the top of an allowed folder. */
  parent: string;
  separator: '\\' | '/';
  /** Folders first, then by name. */
  entries: FsEntry[];
  truncated: boolean;
  restricted: boolean;
}

export interface FsListOptions {
  /** File patterns separated by ";", e.g. "*.cer;*.pem". Folders are always listed. */
  filter?: string;
  dirsOnly?: boolean;
  /** Include hidden and system files. */
  hidden?: boolean;
  /** 1–2000; the server's default is 500. */
  limit?: number;
}

export interface FsStat {
  /** The normalised path. */
  path: string;
  exists: boolean;
  type: 'dir' | 'file' | '';
  size: number | null;
  modified: string | null;
  readable: boolean;
}

/** Where a server file picker can start: drives (or /) and useful folders. */
export const fsRoots = (): Promise<FsRoots> => get('/fs/roots');

/** A server folder's entries. 404 when it doesn't exist; 403 when IRIS can't read it or a limit forbids it. */
export function fsList(dir: string, opts: FsListOptions = {}): Promise<FsListing> {
  const p = new URLSearchParams({ dir });
  if (opts.filter) p.set('filter', opts.filter);
  if (opts.dirsOnly) p.set('dirsOnly', '1');
  if (opts.hidden) p.set('hidden', '1');
  if (opts.limit) p.set('limit', String(opts.limit));
  return get(`/fs/list?${p.toString()}`);
}

/** Does a typed server path exist, and what is it? (403 when a limit forbids it.) */
export const fsStat = (path: string): Promise<FsStat> => get(`/fs/stat?path=${q(path)}`);

/* ───────────── Console log (messages.log) ─────────────
 * Needs %Admin_Operate or %Admin_Manage (403 otherwise). Read backwards from
 * the end of the file, a page at a time; the server reads at most 4 MB per
 * request and says `truncated` when it stopped there. */

/** 0 information, 1 warning, 2 severe, 3 fatal. */
export type LogLevel = 0 | 1 | 2 | 3;

export interface LogEntry {
  /** Byte offset of the entry's first line: unique within the file, and the next page's cursor. */
  offset: number;
  /** Server-local ISO time with the server's current UTC offset ("2026-09-27T13:16:11.060+01:00"); null for lines above the file's first entry. */
  time: string | null;
  pid: number | null;
  level: LogLevel;
  /** The [..] tag, e.g. "Utility.Event"; "" when there is none. */
  source: string;
  /** The message; lines that followed it in the file (stacks, banners) after a "\n". */
  text: string;
}

export interface MessagesLog {
  /** File name only, e.g. "messages.log". */
  file: string;
  /** File size in bytes. */
  size: number;
  /** Newest first. */
  entries: LogEntry[];
  /** Pass as `before` for older entries; null when there are none. */
  next: number | null;
  /** The read stopped at its byte limit before `limit` entries matched; `next` carries on. */
  truncated: boolean;
  /** Bytes read. */
  scanned: number;
  /** The server's current UTC offset, e.g. "+01:00". */
  utcOffset: string;
  /** Lines read at each level [info, warning, severe, fatal]; with `countFrom`, only lines at or after it. */
  levels?: number[];
}

export interface MessagesLogParams {
  /** 1–1000; the server's default is 200. */
  limit?: number;
  /** A previous reply's `next`: older entries than those. */
  before?: number;
  /** Only this level and above. */
  minLevel?: LogLevel;
  /** Case-insensitive text in the source or message. */
  q?: string;
  /** Server-local ISO time ("2026-09-27T13:00:00"): only entries at or after it. */
  since?: string;
  /** Byte offset (e.g. an earlier reply's `size`): `levels` counts only lines at or after it. */
  countFrom?: number;
}

/** The newest entries of the instance's console log (messages.log), newest first. */
export function getMessagesLog(params: MessagesLogParams = {}): Promise<MessagesLog> {
  const p = new URLSearchParams();
  if (params.limit) p.set('limit', String(params.limit));
  if (params.before !== undefined) p.set('before', String(params.before));
  if (params.minLevel) p.set('minLevel', String(params.minLevel));
  if (params.q) p.set('q', params.q);
  if (params.since) p.set('since', params.since);
  if (params.countFrom !== undefined) p.set('countFrom', String(params.countFrom));
  const qs = p.toString();
  return get(`/log/messages${qs ? `?${qs}` : ''}`);
}
