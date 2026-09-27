// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Resources: what each resource protects, the rules for naming and
 * public access, and the writes. Resource types and fetchers live in
 * api-security.ts (shared with Users and Roles); this file adds what only the
 * Resources screen needs.
 *
 * Verified live against IRISHealth262 (2026-09-26) with a throwaway
 * `osca_test_res1`, created and deleted:
 * - The resource endpoint refuses every spelling of "no public access"
 *   ("", " ", ",", "N", "0", "None", "false", null, 0), each with HTTP 400 and
 *   an empty error list, and nothing is created.
 * - PublicPermission is required when creating (400, "is required").
 * - So a resource can't be created here without public access, and public
 *   access can't be removed once set; it can only be changed to another
 *   non-empty set ("U" → "RW" → "RU" → "R" all worked).
 * - Updating an existing resource without PublicPermission is fine: the
 *   description changes and public access stays as it was.
 * - Names containing ":" or ",", or longer than 64 characters, fail with a
 *   misleading "does not exist" error (HTTP 500), so the form checks names first.
 * - Delete of a custom resource → 200; a missing one → 404.
 */
import { get } from './api';
import { writeJson } from './crud';
import { normPerms, type ResourceDetail } from './api-security';
import { permWords } from './ui';

/* ---------- What a resource protects ---------- */

interface DatabaseRow { Name: string; Directory: string; Status: string }
interface DatabaseDirRow { Directory: string; Resource: string; Status: string }
export interface WebAppRow { Name: string; Namespace: string; Enabled: boolean; Resource: string }

export interface ProtectedAssets {
  /** Resource name (lower-cased) → databases carrying it. */
  databases: Map<string, Array<{ name: string; status: string }>>;
  webApps: WebAppRow[];
}

/**
 * Databases (joined to their resource on directory) and web apps. Each part
 * degrades to empty on its own, so one refused call doesn't blank the panel.
 */
export async function getProtectedAssets(): Promise<ProtectedAssets> {
  const soft = <T>(p: Promise<T[]>): Promise<T[]> => p.catch(() => []);
  const [dbs, dirs, webApps] = await Promise.all([
    soft(get<DatabaseRow[]>('/databases')),
    soft(get<DatabaseDirRow[]>('/database-dirs')),
    soft(get<WebAppRow[]>('/web-apps')),
  ]);
  const key = (d: string): string => d.toLowerCase().replace(/[\\/]+$/, '');
  const byDir = new Map(dirs.map((d) => [key(d.Directory), d]));
  const databases = new Map<string, Array<{ name: string; status: string }>>();
  for (const db of dbs) {
    const dir = byDir.get(key(db.Directory));
    if (!dir?.Resource) continue;
    const k = dir.Resource.toLowerCase();
    const list = databases.get(k) ?? [];
    list.push({ name: db.Name, status: db.Status || dir.Status });
    databases.set(k, list);
  }
  for (const list of databases.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return { databases, webApps };
}

/* ---------- Writes ---------- */

const q = encodeURIComponent;

/**
 * Create or update. IRIS creates the resource when the name is new and
 * silently overwrites it when it isn't, so callers check the name first.
 * Omit `PublicPermission` on an update to leave it as it is.
 */
export const saveResource = (name: string, body: Partial<ResourceDetail>): Promise<ResourceDetail> =>
  writeJson<ResourceDetail>('PUT', `/security/resource?name=${q(name)}`, body);

export const deleteResource = (name: string): Promise<unknown> =>
  writeJson('DELETE', `/security/resource?name=${q(name)}`);

/* ---------- Types, permissions and rules, in plain terms ---------- */

export type Kind = 'Database' | 'Service' | 'Application' | 'System' | 'DeepSee' | 'Interoperability' | 'Other';

export const KINDS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: 'Database', label: 'Database', hint: 'Protects one or more databases. Read lets you see the data and run the code; Write lets you change them.' },
  { kind: 'Service', label: 'Service', hint: 'A service IRIS accepts connections through, such as SQL, the Terminal or the web gateway. Use lets you connect through it.' },
  { kind: 'Application', label: 'Application', hint: 'Made for an application. A web app or routine can require Use on it before anyone can run it.' },
  { kind: 'System', label: 'Administrative', hint: 'An administrative power, such as managing security or operating the system. It gives no access to data by itself.' },
  { kind: 'DeepSee', label: 'Analytics', hint: 'Controls who can use the analytics (DeepSee) tools.' },
  { kind: 'Interoperability', label: 'Interoperability', hint: 'Controls parts of interoperability productions and their pages.' },
  { kind: 'Other', label: 'Other', hint: 'A resource of a type this portal doesn’t recognise.' },
];

export function kindOf(type: string): Kind {
  return (KINDS.find((x) => x.kind === type)?.kind) ?? 'Other';
}
export const kindLabel = (k: Kind): string => KINDS.find((x) => x.kind === k)?.label ?? k;
export const kindHint = (k: Kind): string => KINDS.find((x) => x.kind === k)?.hint ?? '';

/** A database resource, or a %DB_ name about to become one. */
export const isDatabaseResource = (name: string, type = ''): boolean => type === 'Database' || /^%DB_/i.test(name);

/** Permissions that mean something: Read/Write on databases, Use on everything else. Anything already set is kept. */
export function meaningfulPerms(name: string, type: string, current = ''): string[] {
  const base = new Set(isDatabaseResource(name, type) ? ['R', 'W'] : ['U']);
  for (const c of normPerms(current)) base.add(c);
  return ['R', 'W', 'U'].filter((c) => base.has(c));
}

/** Form labels, in the shared vocabulary: Write always includes Read, so it reads as Read & change. */
export const PERM_WORD: Record<string, string> = { R: 'Read', W: 'Read & change', U: 'Use' };

/** "RW" → "Read & change", "RU" → "Read, Use" (the shared vocabulary from ui.ts, as text). */
export const permText = (p: string): string => permWords(p).join(', ');

/** What one permission lets someone do, for this kind of resource. */
export function permMeaning(perm: string, name: string, type: string): string {
  if (isDatabaseResource(name, type)) return perm === 'R' ? 'read the data and run the code' : perm === 'W' ? 'read and change the data and code' : 'use it';
  if (perm === 'R') return 'read it';
  if (perm === 'W') return 'write to it';
  switch (kindOf(type)) {
    case 'Service': return 'connect through this service';
    case 'System': return 'use this admin power';
    case 'DeepSee': return 'use these analytics tools';
    case 'Interoperability': return 'use this interoperability feature';
    default: return 'use it';
  }
}

/** "Read the data and run the code, and change the data and code". */
export function permSentence(perms: string, name: string, type: string): string {
  let letters = normPerms(perms);
  // Read & change on a database is one idea, not two.
  if (isDatabaseResource(name, type) && letters.includes('W')) {
    letters = letters.replace(/[RW]/g, '');
    const rest = [...letters].map((c) => permMeaning(c, name, type));
    const text = ['read and change the data and code', ...rest].join(' and ');
    return text[0].toUpperCase() + text.slice(1);
  }
  const parts = [...letters].map((c) => permMeaning(c, name, type));
  if (!parts.length) return '';
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return text[0].toUpperCase() + text.slice(1);
}

/** Resources whose Use hands out administrator or developer power. */
export const isPowerResource = (name: string): boolean =>
  /^%Admin_/i.test(name) || /^%System_/i.test(name) || ['%development', '%docdb_admin', '%sqlschemaadmin'].includes(name.toLowerCase());

/** Why this public grant is risky, or null. Public access applies to every connection, signed in or not. */
export function publicRisk(name: string, type: string, perms: string): string | null {
  const p = normPerms(perms);
  if (isDatabaseResource(name, type) && p.includes('W') && name.toUpperCase() !== '%DB_IRISTEMP') {
    return 'Everyone, including connections that don’t sign in, can change the data and code in these databases.';
  }
  if (p.includes('U') && isPowerResource(name)) {
    return name.toLowerCase() === '%development'
      ? 'Everyone, including connections that don’t sign in, gets developer tools: direct mode, the debugger and IDE connections.'
      : 'Everyone, including connections that don’t sign in, gets this administrator power.';
  }
  return null;
}

/** Name rules for a new resource; null when fine. `taken` is a case-insensitive existence check, as IRIS applies. */
export function nameProblem(name: string, taken: (n: string) => boolean): string | null {
  if (!name) return 'Enter a name';
  if (name !== name.trim()) return 'Remove the spaces at the start or end';
  if (name.length > 64) return `Use 64 characters or fewer (this is ${name.length})`;
  if (/[,:]/.test(name)) return 'Names can’t contain a comma or a colon';
  if (name.startsWith('%')) {
    if (!/^%DB_./i.test(name)) return 'Names starting with % are reserved for IRIS. Only database resources may, and they start with %DB_';
    if (name[4] === '%') return 'A database resource name can’t have % straight after %DB_';
  }
  if (taken(name)) return 'A resource with this name already exists';
  return null;
}

/** The Management Portal's list of resources (it has "Create New Resource"). */
export const PORTAL_RESOURCES = '/csp/sys/sec/%25CSP.UI.Portal.Resources.zen';
