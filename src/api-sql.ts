// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQL privileges and filesystem access purposes: types, fetchers, writes and
 * the plain-English vocabulary both screens use.
 *
 * SQL privileges are read per grantee and namespace (IRIS has no "who holds
 * this table" query), so the namespace-wide index is built by asking each
 * user and role in turn, a few at a time. Accounts that hold %All are not
 * asked: IRIS answers "everything" for them, which is summarised instead.
 */
import { get } from './api';
import { writeJson, AdminError } from './crud';

const q = encodeURIComponent;
const qs = (o: Record<string, string | number | boolean | undefined>): string =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${q(String(v))}`).join('&');

/* ══ Types ═══════════════════════════════════════════════ */

export type SqlObjectType = 'TABLE' | 'VIEW' | 'STORED PROCEDURE' | 'SCHEMA' | 'ML CONFIGURATION';

/** One object privilege as IRIS reports it for a grantee. */
export interface SqlObjPriv {
  Type: SqlObjectType | string;
  Object: string;
  /** SELECT, INSERT, UPDATE, DELETE, REFERENCES, %ALTER, EXECUTE, USE; '' on a column-only row. */
  Action: string;
  GrantedBy: string;
  GrantOption: boolean;
  /** "Direct", "Role:<name>", "Schema Privilege", "SuperUser", "Owner Privilege", or '' (column-only row). */
  GrantedVia: string;
  HasColumnPriv: boolean;
}
export interface SqlAdminPriv { Privilege: string; GrantOption: boolean; GrantedVia: string }
export interface SqlColumnPriv { Column: string; Action: string; GrantedBy: string; GrantOption: boolean; GrantedVia: string }

/* ══ Reads ═══════════════════════════════════════════════ */

export const getObjectPrivs = (grantee: string, ns: string, includeSystem = false, maxRows = 5000): Promise<SqlObjPriv[]> =>
  get<SqlObjPriv[]>(`/security/sql-privileges?${qs({ grantee, namespace: ns, includeSystem: includeSystem ? 1 : 0, maxRows })}`).then((r) => r ?? []);
export const getAdminPrivs = (grantee: string, ns: string): Promise<SqlAdminPriv[]> =>
  get<SqlAdminPriv[]>(`/security/sql-admin-privileges?${qs({ grantee, namespace: ns })}`).then((r) => r ?? []);
export const getColumnPrivs = (grantee: string, ns: string, object: string): Promise<SqlColumnPriv[]> =>
  get<SqlColumnPriv[]>(`/security/sql-column-privileges?${qs({ grantee, namespace: ns, object, includeSystem: 1 })}`).then((r) => r ?? []);

/** Run `fn` over items, `size` at a time. */
export async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

/** An object that exists in the namespace, from the catalog. */
export interface SqlObject { Type: string; Object: string; Schema: string }
export const schemaOf = (object: string): string => object.split('.')[0] ?? object;

/**
 * Every table, view, procedure and ML configuration in a namespace. IRIS has
 * no catalog call here, but an account holding %All is reported as holding
 * every privilege on every object, so its list is the catalog.
 */
export async function getCatalog(ns: string, superUser: string | null, includeSystem: boolean): Promise<SqlObject[]> {
  if (!superUser) return [];
  const rows = await getObjectPrivs(superUser, ns, includeSystem, 100000);
  const seen = new Map<string, SqlObject>();
  for (const r of rows) {
    const k = `${r.Type}\u0000${r.Object}`;
    if (!seen.has(k)) seen.set(k, { Type: r.Type, Object: r.Object, Schema: schemaOf(r.Object) });
  }
  return [...seen.values()].sort((a, b) => a.Object.localeCompare(b.Object));
}

/* ══ Writes ══════════════════════════════════════════════ */

/**
 * IRIS wraps SQL errors as "SQLCODE: -30 Message: Table or view not found";
 * keep the sentence, and say the common ones in the portal's words.
 */
function sqlMessage(err: unknown): never {
  if (err instanceof AdminError) {
    const m = /SQLCODE:\s*(-?\d+)\s*Message:\s*(.*)$/i.exec(err.message);
    if (m) {
      const code = Number(m[1]);
      const friendly: Record<number, string> = {
        [-30]: 'That table or view doesn’t exist in this namespace.',
        [-118]: 'That user or role doesn’t exist.',
        [-99]: 'You don’t have the privilege to grant or revoke that.',
        [-29]: 'That column doesn’t exist in this table.',
        [-428]: 'That stored procedure doesn’t exist in this namespace.',
      };
      throw new AdminError(friendly[code] ?? (m[2].trim() ? `${m[2].trim().replace(/\.?$/, '.')}` : err.message), err.status, err.code, err.id);
    }
  }
  throw err;
}
const write = (path: string): Promise<unknown> => writeJson('POST', path).catch(sqlMessage);

export interface ObjectGrant {
  ns: string;
  grantee: string;
  type: SqlObjectType;
  /** Table, view, procedure or ML configuration name; the schema name for a SCHEMA grant. */
  object: string;
  actions: string[];
  withGrant?: boolean;
}
/** GRANT actions ON object TO grantee [WITH GRANT OPTION]. One call for all actions. */
export const grantObject = (g: ObjectGrant): Promise<unknown> =>
  write(`/security/sql-privilege/grant?${qs({ namespace: g.ns, grantee: g.grantee, object: g.object, type: g.type, action: g.actions.join(','), withGrant: g.withGrant ? 1 : undefined })}`);
/** REVOKE actions; with `grantOptionOnly`, only the right to pass them on is taken away. */
export const revokeObject = (g: ObjectGrant & { grantOptionOnly?: boolean }): Promise<unknown> =>
  write(`/security/sql-privilege/revoke?${qs({ namespace: g.ns, grantee: g.grantee, object: g.object, type: g.type, action: g.actions.join(','), withGrant: g.grantOptionOnly ? 1 : undefined })}`);

/** Column grants take one action and one column per call. */
export const grantColumn = (g: { ns: string; grantee: string; type: 'TABLE' | 'VIEW'; object: string; column: string; action: string; withGrant?: boolean }): Promise<unknown> =>
  write(`/security/sql-column-privilege/grant?${qs({ namespace: g.ns, grantee: g.grantee, object: g.object, type: g.type, column: g.column, action: g.action, withGrant: g.withGrant ? 1 : undefined })}`);
export const revokeColumn = (g: { ns: string; grantee: string; type: 'TABLE' | 'VIEW'; object: string; column: string; action: string }): Promise<unknown> =>
  write(`/security/sql-column-privilege/revoke?${qs({ namespace: g.ns, grantee: g.grantee, object: g.object, type: g.type, column: g.column, action: g.action })}`);

export const grantAdmin = (ns: string, grantee: string, privilege: string, withGrant = false): Promise<unknown> =>
  write(`/security/sql-admin-privilege/grant?${qs({ namespace: ns, grantee, privilege, withGrant: withGrant ? 1 : undefined })}`);
export const revokeAdmin = (ns: string, grantee: string, privilege: string): Promise<unknown> =>
  write(`/security/sql-admin-privilege/revoke?${qs({ namespace: ns, grantee, privilege })}`);

/* ══ Vocabulary ══════════════════════════════════════════ */

/** What each object action lets someone do, in the portal's words. */
export const ACTION_WORDS: Record<string, { short: string; long: string }> = {
  SELECT: { short: 'Read', long: 'Read rows (SELECT)' },
  INSERT: { short: 'Add', long: 'Add rows (INSERT)' },
  UPDATE: { short: 'Change', long: 'Change rows (UPDATE)' },
  DELETE: { short: 'Delete', long: 'Delete rows (DELETE)' },
  REFERENCES: { short: 'Reference', long: 'Point foreign keys at it (REFERENCES)' },
  '%ALTER': { short: 'Alter', long: 'Change its definition (ALTER)' },
  EXECUTE: { short: 'Run', long: 'Run it (EXECUTE)' },
  USE: { short: 'Use', long: 'Use it (USE)' },
};
export const actionShort = (a: string): string => ACTION_WORDS[a]?.short ?? a;
export const actionLong = (a: string): string => ACTION_WORDS[a]?.long ?? a;
/** Canonical order for chips and forms. */
export const ACTION_ORDER = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', '%ALTER', 'EXECUTE', 'USE'];
export const sortActions = (a: string[]): string[] => [...new Set(a)].sort((x, y) => ACTION_ORDER.indexOf(x) - ACTION_ORDER.indexOf(y));
export const CHANGE_ACTIONS = ['INSERT', 'UPDATE', 'DELETE', '%ALTER'];
/** Actions that can be limited to some columns. */
export const COLUMN_ACTIONS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

/** Actions each object type takes. */
export const TYPE_ACTIONS: Record<SqlObjectType, string[]> = {
  TABLE: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', '%ALTER'],
  VIEW: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', '%ALTER'],
  SCHEMA: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', '%ALTER', 'EXECUTE'],
  'STORED PROCEDURE': ['EXECUTE'],
  'ML CONFIGURATION': ['USE'],
};
export const TYPE_WORDS: Record<string, string> = {
  TABLE: 'Table', VIEW: 'View', 'STORED PROCEDURE': 'Procedure', SCHEMA: 'Whole schema', 'ML CONFIGURATION': 'ML configuration',
};
export const typeWord = (t: string): string => TYPE_WORDS[t] ?? t;

/** Where a privilege comes from, in words; `kind` says whether it can be revoked here (direct, schema) or elsewhere. */
export function viaWords(via: string, object = ''): { text: string; kind: 'direct' | 'role' | 'schema' | 'all' | 'everyone' | 'column'; role?: string } {
  if (via === 'Direct') return { text: 'granted directly', kind: 'direct' };
  // Object privileges say "Role:X"; admin privileges say "Role - X".
  const rm = /^Role(?::|\s+-\s+)\s*(.+)$/.exec(via);
  if (rm) { const role = rm[1].trim(); return { text: `through role ${role}`, kind: 'role', role }; }
  if (via === 'Schema Privilege') return { text: `through a grant on the whole ${schemaOf(object)} schema`, kind: 'schema' };
  if (via === 'SuperUser') return { text: 'through %All (full access)', kind: 'all' };
  if (via === 'Owner Privilege') return { text: 'available to everyone (built in)', kind: 'everyone' };
  if (!via) return { text: 'on some columns only', kind: 'column' };
  return { text: via, kind: 'direct' };
}

/** Admin-level (system) SQL privileges: what each one allows. */
export const ADMIN_PRIVS: Array<{ name: string; group: string; text: string }> = [
  { name: '%CREATE_TABLE', group: 'Tables and views', text: 'Create tables' },
  { name: '%ALTER_TABLE', group: 'Tables and views', text: 'Change table definitions' },
  { name: '%DROP_TABLE', group: 'Tables and views', text: 'Drop tables' },
  { name: '%CREATE_VIEW', group: 'Tables and views', text: 'Create views' },
  { name: '%ALTER_VIEW', group: 'Tables and views', text: 'Change view definitions' },
  { name: '%DROP_VIEW', group: 'Tables and views', text: 'Drop views' },
  { name: '%CREATE_TRIGGER', group: 'Tables and views', text: 'Create triggers' },
  { name: '%DROP_TRIGGER', group: 'Tables and views', text: 'Drop triggers' },
  { name: '%BUILD_INDEX', group: 'Tables and views', text: 'Build indexes' },
  { name: '%DROP_UNOWNED', group: 'Tables and views', text: 'Drop tables and views owned by someone else' },
  { name: '%CREATE_FUNCTION', group: 'Code', text: 'Create functions' },
  { name: '%DROP_FUNCTION', group: 'Code', text: 'Drop functions' },
  { name: '%CREATE_METHOD', group: 'Code', text: 'Create methods' },
  { name: '%DROP_METHOD', group: 'Code', text: 'Drop methods' },
  { name: '%CREATE_PROCEDURE', group: 'Code', text: 'Create stored procedures' },
  { name: '%DROP_PROCEDURE', group: 'Code', text: 'Drop stored procedures' },
  { name: '%CREATE_QUERY', group: 'Code', text: 'Create queries' },
  { name: '%DROP_QUERY', group: 'Code', text: 'Drop queries' },
  { name: '%NOCHECK', group: 'Bulk loading (skips safety checks)', text: 'Skip foreign-key and uniqueness checks' },
  { name: '%NOTRIGGER', group: 'Bulk loading (skips safety checks)', text: 'Skip triggers' },
  { name: '%NOINDEX', group: 'Bulk loading (skips safety checks)', text: 'Skip index updates' },
  { name: '%NOLOCK', group: 'Bulk loading (skips safety checks)', text: 'Skip locking' },
  { name: '%NOJOURN', group: 'Bulk loading (skips safety checks)', text: 'Skip journaling' },
  { name: '%DEFER', group: 'Bulk loading (skips safety checks)', text: 'Defer index building' },
  { name: '%CREATE_ML_CONFIGURATION', group: 'Machine learning and other', text: 'Create ML configurations' },
  { name: '%ALTER_ML_CONFIGURATION', group: 'Machine learning and other', text: 'Change ML configurations' },
  { name: '%DROP_ML_CONFIGURATION', group: 'Machine learning and other', text: 'Drop ML configurations' },
  { name: '%MANAGE_MODEL', group: 'Machine learning and other', text: 'Create, train and drop ML models' },
  { name: '%USE_MODEL', group: 'Machine learning and other', text: 'Use ML models for predictions' },
  { name: '%USE_EMBEDDING', group: 'Machine learning and other', text: 'Use embedding (vector) configurations' },
  { name: '%MANAGE_FOREIGN_SERVER', group: 'Machine learning and other', text: 'Manage foreign servers and foreign tables' },
  { name: '%CANCEL_QUERY', group: 'Machine learning and other', text: 'Cancel other users’ running queries' },
];
export const adminText = (p: string): string => ADMIN_PRIVS.find((x) => x.name === p)?.text ?? p;

/* ══ Filesystem access purposes ══════════════════════════ */

export interface FsPurpose { Purpose: string; Restricted: boolean }
export interface FsPath { Purpose: string; RootPath: string }

export const getPurposes = (): Promise<FsPurpose[]> => get<FsPurpose[]>('/fs-access-purposes').then((r) => r ?? []);
export const getPaths = (purpose: string): Promise<FsPath[]> => get<FsPath[]>(`/fs-access-purpose/paths?purpose=${q(purpose)}`).then((r) => r ?? []);
/** Creates the purpose when it doesn't exist (201), otherwise switches the limit on or off. */
export const setPurpose = (purpose: string, restricted: boolean): Promise<unknown> =>
  writeJson('PUT', `/fs-access-purpose?purpose=${q(purpose)}`, { Restricted: restricted });
/** Removes the purpose and all of its folders. */
export const deletePurpose = (purpose: string): Promise<unknown> => writeJson('DELETE', `/fs-access-purpose?purpose=${q(purpose)}`);
/** Allow a folder (and everything under it). The folder must exist on the server. */
export const addPath = (purpose: string, rootPath: string): Promise<unknown> =>
  writeJson('PUT', `/fs-access-purpose/path?purpose=${q(purpose)}&rootPath=${q(rootPath)}`);
export const removePath = (purpose: string, rootPath: string): Promise<unknown> =>
  writeJson('DELETE', `/fs-access-purpose/path?purpose=${q(purpose)}&rootPath=${q(rootPath)}`);

/** Purposes IRIS itself defines, and what they control. */
export const KNOWN_PURPOSES: Record<string, { label: string; text: string }> = {
  '%GUIFileSelector': {
    label: 'Management Portal file picker',
    text: 'The file and folder picker in the Management Portal, used when importing, exporting, backing up and choosing directories.',
  },
};
export const GUI_FILE_SELECTOR = '%GUIFileSelector';

/** Compare folders the way IRIS stores them: trailing separator, case-insensitive on Windows-style paths. */
// Not api-disk's samePath: this one also trims spaces and treats / and \ as the same separator on Windows paths.
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let s = p.trim().replace(/[\\/]+$/, '');
    if (/^[a-z]:|\\/i.test(p)) s = s.replace(/\//g, '\\').toLowerCase();
    return s;
  };
  return norm(a) === norm(b);
}
