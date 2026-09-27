// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Users, Roles and Resources: types, fetchers, writes, and the
 * security graph that explains who can do what, and why.
 * Field names follow the live IRIS 2026.2 responses, not the (untyped) spec.
 */
import { get } from './api';
import { writeJson } from './crud';

/* ── Types ─────────────────────────────────────────────── */

/** One row of the users list. */
export interface UserSummary {
  Name: string;
  FullName: string;
  /** Default namespace; "" when the user has none. */
  Namespace: string;
  /** Routine run at login; "" when none. */
  Routine: string;
  /** "Password user", "LDAP user", "Delegated user", "OS user"… */
  Type: string;
  Enabled: boolean;
}

/** One user in full (also the exact update shape). */
export interface UserDetail {
  FullName: string;
  Enabled: boolean;
  /** Exempt from the system's inactivity limit. */
  AccountNeverExpires: boolean;
  PasswordNeverExpires: boolean;
  /** Account expiry date ("YYYY-MM-DD"), "" for none. */
  ExpirationDate: string;
  /** "Change password on next login". */
  ChangePassword: boolean;
  /** Two-factor options enabled for this user (bitmask, see decodeAuthe). */
  AutheEnabled: number;
  /** Show the authenticator-app key to the user at their next login. */
  HOTPKeyDisplay: boolean;
  Roles: string[];
  EscalationRoles: string[];
  NameSpace: string;
  Routine: string;
  EmailAddress: string;
  PhoneNumber: string;
  PhoneProvider: string;
  Comment: string;
}

/** One row of the roles list. */
export interface RoleSummary {
  Name: string;
  Description: string;
  CreatedBy: string;
  EscalationOnly: boolean;
}

/** One role in full (also the exact create/update shape). */
export interface RoleDetail {
  Description: string;
  EscalationOnly: boolean;
  /** Roles whose privileges this role also confers. */
  GrantedRoles: string[];
  /** Permissions is a non-empty subset of "RWU". */
  Resources: Array<{ Name: string; Permissions: string }>;
}

/** Users and roles that hold a role (not transitive). */
export interface RoleOwner {
  Name: string;
  /** "User", "Role", or "User (escalation)". */
  Type: string;
  /** Whether the holder may grant the role on; "0"/"1" or boolean depending on the row. */
  AdminOption: string | boolean;
}

/** One row of the resources list. */
export interface ResourceSummary {
  Name: string;
  Description: string;
  /** Subset of "RWU" everyone gets; "" for none. */
  PublicPermission: string;
  /** "System", "Database", "Service", "Application", "DeepSee", "Interoperability". */
  ResourceType: string;
  AllowDelete: boolean;
}

/** One resource in full (also the exact create/update shape). */
export interface ResourceDetail {
  Description: string;
  PublicPermission: string;
}

export interface NamespaceInfo {
  Name: string;
  /** Database names. */
  Globals: string;
  Routines: string;
  Library: string;
  TempGlobals: string;
}
interface DatabaseRow { Name: string; Directory: string }
interface DatabaseDirRow { Directory: string; Resource: string }
export interface WebAppRow { Name: string; Namespace: string; Enabled: boolean; Resource: string; AuthenticationMethods: string[] }
interface WebAppDetail { MatchRoles?: Array<{ MatchRole: string; TargetRoles: string[] }> }
export interface ServiceRow { Name: string; Enabled: boolean; Public: string; AuthenticationMethods: string[]; Description: string }

/* ── Reads ─────────────────────────────────────────────── */

const q = encodeURIComponent;
export const getUserList = (): Promise<UserSummary[]> => get('/security/users');
export const getUser = (name: string): Promise<UserDetail> => get(`/security/user?name=${q(name)}`);
export const getRoleList = (): Promise<RoleSummary[]> => get('/security/roles');
export const getRole = (name: string): Promise<RoleDetail> => get(`/security/role?name=${q(name)}`);
export const getRoleOwners = (name: string): Promise<RoleOwner[]> => get(`/security/role/owners?name=${q(name)}`);
export const getResourceList = (): Promise<ResourceSummary[]> => get('/security/resources');
export const getResource = (name: string): Promise<ResourceDetail> => get(`/security/resource?name=${q(name)}`);
export const getNamespaceList = (): Promise<NamespaceInfo[]> => get('/namespaces');
export const getServiceList = (): Promise<ServiceRow[]> => get('/security/services');

/* ── Writes (each one drops the cached graph) ──────────── */

/**
 * Verified live (2026-09-26, with throwaway osca_test_ items):
 * - Create user: 201; a name used by a role, or an existing user (any case),
 *   fails with a plain message. Unknown roles are accepted silently, so the
 *   form only offers roles that exist.
 * - Only one kind of two-factor can be on; text-message two-factor needs a
 *   phone number and provider.
 * - Past expiry dates and unknown namespaces are accepted as-is.
 * - Role save creates or overwrites (no conflict check), so create forms check
 *   the name is free first. Write-only on a database is stored as Read+Write.
 *   A role may include itself; the form prevents it.
 */
export const invalidating = <T>(p: Promise<T>): Promise<T> => p.finally(() => invalidateSecurityGraph());

export const createUser = (name: string, password: string, user: Partial<UserDetail>): Promise<UserDetail> =>
  invalidating(writeJson('POST', `/security/user?name=${q(name)}`, { Password: password, User: user }));
export const updateUser = (name: string, patch: Partial<UserDetail>): Promise<UserDetail> =>
  invalidating(writeJson('PUT', `/security/user?name=${q(name)}`, patch));
export const setUserPassword = (name: string, password: string): Promise<unknown> =>
  invalidating(writeJson('POST', `/security/user/password?name=${q(name)}`, { NewPassword: password }));
export const deleteUser = (name: string): Promise<unknown> =>
  invalidating(writeJson('DELETE', `/security/user?name=${q(name)}`));
/** Creates the role when it doesn't exist, otherwise updates it. */
export const saveRole = (name: string, role: Partial<RoleDetail>): Promise<RoleDetail> =>
  invalidating(writeJson('PUT', `/security/role?name=${q(name)}`, role));
export const deleteRole = (name: string): Promise<unknown> =>
  invalidating(writeJson('DELETE', `/security/role?name=${q(name)}`));

/* ── Decoding and wording ──────────────────────────────── */

/**
 * Authentication bits ($$$Authe* in %sySecurityMacros.inc). For a user,
 * AutheEnabled only ever carries the two-factor bits; the rest are decoded so
 * an unexpected value still reads as words rather than a number.
 */
export const TWO_FACTOR_SMS = 2 ** 20;
export const TWO_FACTOR_TOTP = 2 ** 21;
const AUTHE_BITS: Array<[number, string]> = [
  [TWO_FACTOR_SMS, 'Two-factor by text message'],
  [TWO_FACTOR_TOTP, 'Two-factor by authenticator app'],
  [2 ** 0, 'Kerberos (credentials cache)'],
  [2 ** 1, 'Kerberos (prompt)'],
  [2 ** 2, 'Kerberos (API)'],
  [2 ** 3, 'Kerberos (key table)'],
  [2 ** 4, 'Operating system'],
  [2 ** 5, 'Password'],
  [2 ** 6, 'Unauthenticated'],
  [2 ** 7, 'Kerberos'],
  [2 ** 8, 'Kerberos with encryption'],
  [2 ** 9, 'Kerberos with integrity'],
  [2 ** 10, 'System'],
  [2 ** 11, 'LDAP'],
  [2 ** 12, 'LDAP (cached credentials)'],
  [2 ** 13, 'Delegated'],
  [2 ** 14, 'Login token'],
  [2 ** 15, 'Kerberos delegated'],
  [2 ** 16, 'Operating system, delegated'],
  [2 ** 17, 'Operating system with LDAP'],
  [2 ** 18, 'X.509 certificate'],
  [2 ** 19, 'TLS'],
  [2 ** 24, 'Always try delegated'],
  [2 ** 25, 'Mutual TLS'],
  [2 ** 26, 'OAuth 2.0'],
];
export const hasBit = (mask: number, bit: number): boolean => Math.floor(mask / bit) % 2 === 1;
/** Set or clear one bit (values past 2^31 need arithmetic, not `|`). */
export const withBit = (mask: number, bit: number, on: boolean): number =>
  hasBit(mask, bit) === on ? mask : on ? mask + bit : mask - bit;

/** AutheEnabled → the methods it switches on, in words. [] when none. */
export function decodeAuthe(mask: number): string[] {
  if (!Number.isFinite(mask) || mask <= 0) return [];
  return AUTHE_BITS.filter(([bit]) => hasBit(mask, bit)).map(([, label]) => label);
}

/** Canonical order, no duplicates: "WR" → "RW". */
export const normPerms = (p: string): string => ['R', 'W', 'U'].filter((c) => p.toUpperCase().includes(c)).join('');

/**
 * Accounts IRIS creates at installation. The API carries no "system" flag,
 * so this is the documented install set (HS_Services comes with HealthShare).
 */
const BUILT_IN_USERS: Record<string, string> = {
  _SYSTEM: 'SQL system manager, created at installation',
  Admin: 'Default administrator account, created at installation',
  SuperUser: 'Default super-user account, created at installation',
  CSPSystem: 'Account the Web Gateway uses to connect to IRIS',
  UnknownUser: 'Identity given to unauthenticated connections',
  IAM: 'Account for the InterSystems API Manager web application',
  _Ensemble: 'Internal account for interoperability productions; not for sign-in',
  _PUBLIC: 'Its roles are given to every user; never signs in',
  HS_Services: 'Internal account for HealthShare services',
};
export const builtInUser = (name: string): string | undefined => BUILT_IN_USERS[name];
/** Accounts IRIS refuses to delete. */
export const UNDELETABLE_USERS = ['_SYSTEM', '_PUBLIC', 'UnknownUser', '_Ensemble'];
export const PUBLIC_USER = '_PUBLIC';
export const ANON_USER = 'UnknownUser';

/** Roles IRIS ships all begin with %; custom role names cannot. */
export const isBuiltInRole = (name: string): boolean => name.startsWith('%');
/** Database roles (%DB_*) are fixed read-write roles IRIS maintains itself. */
export const isDatabaseRole = (name: string): boolean => /^%DB_/i.test(name);

/** Roles that give administrator-level power over the instance. */
export const PRIVILEGED_ROLES = ['%All', '%Manager'];
/** Roles worth a warning whenever someone is given them. */
export const POWERFUL_ROLES: Record<string, string> = {
  '%All': 'Gives full access to everything',
  '%Manager': 'Gives control of the whole instance, including security',
  '%SecurityAdministrator': 'Gives control of users, roles and security settings',
  '%Developer': 'Gives developer access: direct mode, the debugger and code in USER',
};
/** Privileges worth a warning when granted or made public. */
export function powerfulPrivilege(resource: string, perm: string): string | null {
  const r = resource.toLowerCase();
  if (r === '%admin_secure' && perm.includes('U')) return 'Gives control of users, roles and security settings';
  if (r === '%db_irissys' && perm.includes('W')) return 'Writing to the system database is effectively full access';
  if (r === '%development' && perm.includes('U')) return 'Gives developer access: direct mode and the debugger';
  return null;
}

const SERVICE_TEXT: Record<string, string> = {
  '%Service_SQL': 'Can connect with SQL (ODBC and JDBC)',
  '%Service_Terminal': 'Can sign in to the Terminal',
  '%Service_Console': 'Can use the Windows console',
  '%Service_Telnet': 'Can connect by Telnet',
  '%Service_WebGateway': 'Can use web applications',
  '%Service_Object': 'Can connect with object bindings (Java, .NET, Python)',
  '%Service_Bindings': 'Can connect with SQL or object bindings',
  '%Service_CallIn': 'Can call in from C and other languages',
  '%Service_CacheDirect': 'Can connect with the legacy Direct protocol',
  '%Service_ComPort': 'Can connect through a COM port',
  '%Service_DocDB': 'Can use the document database',
  '%Service_DirectLoad': 'Can bulk-load data with SQL LOAD DATA',
  '%Service_EscalateLogin': 'Can switch to an escalation role',
  '%Service_Login': 'Can sign in with a login from code',
  '%Service_Mirror': 'Can connect as a mirror member',
  '%Service_ECP': 'Can connect as an ECP application server',
  '%Service_Shadow': 'Can connect as a shadow',
  '%Service_Monitor': 'Can read monitoring data (SNMP, WMI)',
};
const ADMIN_TEXT: Record<string, string> = {
  '%Admin_Secure': 'Can manage security',
  '%Admin_Manage': 'Can change the configuration',
  '%Admin_Operate': 'Can run operations (backups, databases, processes)',
  '%Admin_Task': 'Can manage scheduled tasks',
  '%Admin_Journal': 'Can switch journaling off for a process',
  '%Admin_Wallet': 'Can manage secrets in the wallet',
  '%Admin_OAuth2_Client': 'Can manage OAuth 2.0 clients',
  '%Admin_OAuth2_Server': 'Can manage the OAuth 2.0 server',
  '%Admin_OAuth2_Registration': 'Can register OAuth 2.0 clients',
  '%Admin_ExternalLanguageServerEdit': 'Can edit external language servers',
  '%Admin_FileSystemAccess': 'Can manage filesystem access rules',
  '%Development': 'Can develop code (IDE, debugger, direct mode)',
  '%System_CallOut': 'Can call out to the operating system',
  '%Secure_Break': 'Can’t break into running code (this restricts the user)',
  '%DocDB_Admin': 'Can administer document databases',
  '%IAM': 'Can use the API Manager',
};

export type AccessGroup = 'Databases' | 'Services' | 'Admin powers' | 'Apps';
export function groupOf(type: string | undefined, name: string): AccessGroup {
  if (type === 'Database' || /^%DB_/i.test(name)) return 'Databases';
  if (type === 'Service' || /^%Service_/i.test(name)) return 'Services';
  if (type === 'System' || /^%(Admin_|Development|System_|Secure_)/i.test(name)) return 'Admin powers';
  return 'Apps';
}
/** Human name of a resource type. */
export function typeLabel(type: string): string {
  return ({ Database: 'Database', Service: 'Service', System: 'Admin', Application: 'Application', DeepSee: 'Analytics', Interoperability: 'Interoperability' } as Record<string, string>)[type] ?? (type || 'Other');
}

/** "the USER database", "the A and B databases", or the %DEFAULT wording. */
export function databaseWords(resource: string, g?: SecurityGraph | null): string {
  if (/^%DB_%DEFAULT$/i.test(resource)) return 'databases that have no resource of their own';
  const found = g?.databasesFor(resource) ?? [];
  const dbs = found.length ? found : [resource.replace(/^%DB_/i, '')];
  if (dbs.length === 1) return `the ${dbs[0]} database`;
  return `the ${dbs.slice(0, -1).join(', ')} and ${dbs[dbs.length - 1]} databases`;
}

/** Plain English for one privilege: "Can read and change data in the USER database". */
export function privilegeText(resource: string, perms: string, g?: SecurityGraph | null): string {
  const p = normPerms(perms);
  if (/^%DB_/i.test(resource)) {
    const where = databaseWords(resource, g);
    if (p.includes('W')) return `Can read and change data in ${where}`;
    if (p.includes('R')) return `Can read data and run code in ${where}`;
    return `Can use ${where}`;
  }
  const svc = SERVICE_TEXT[resource];
  if (svc) return svc;
  const adm = ADMIN_TEXT[resource];
  if (adm) return adm;
  if (/^%Service_/i.test(resource)) return `Can connect through ${resource.replace(/^%Service_/i, '')}`;
  const desc = g?.resource(resource)?.Description?.replace(/\.$/, '').replace(/\s+via USE$/i, '')
    .replace(/^Grants Native API access to /i, 'Can use the Native API on ')
    .replace(/^Grants ReadOnly access to /i, 'Can view ').replace(/^Grants full access to /i, 'Full use of ')
    .replace(/^Grants access to (the )?/i, 'Can access ').replace(/^Grants /i, 'Can ').replace(/^Controls /i, 'Can control ').replace(/^Can access (view|edit|run|use|manage|create|configure) /i, 'Can $1 ');
  const verb = p === 'U' || !p ? 'Can use' : p.includes('W') ? 'Can read and write' : 'Can read';
  // The resource's own description reads better than its name; the name stays in the mono detail.
  if (desc) return `${desc.charAt(0).toUpperCase()}${desc.slice(1)}${p && p !== 'U' ? ` (${p.includes('W') ? 'read and write' : 'read'})` : ''}`;
  return `${verb} ${resource}`;
}

/* ── Provenance ────────────────────────────────────────── */

/** Where a privilege comes from. Role paths run from the role held to the role that grants. */
export type Source =
  | { kind: 'role'; path: string[] }
  | { kind: 'everyone-user'; path: string[] }
  | { kind: 'public' }
  | { kind: 'app'; app: string; path: string[] };

export function sourceText(s: Source): string {
  switch (s.kind) {
    case 'role': return `via ${s.path.join(' → ')}`;
    case 'everyone-user': return `every user (${PUBLIC_USER}${s.path.length ? ` → ${s.path.join(' → ')}` : ''})`;
    case 'public': return 'everyone (public)';
    case 'app': return `while using ${s.app}${s.path.length ? ` (via ${s.path.join(' → ')})` : ''}`;
  }
}
/** Lower is more direct; used to pick the one source worth showing. */
const rank = (s: Source): number => ({ role: 0, 'everyone-user': 1, public: 2, app: 3 }[s.kind] * 100 + ('path' in s ? s.path.length : 0));

/** resource → permission letter → the most direct source. */
export type GrantMap = Map<string, Map<string, Source>>;
function addGrant(m: GrantMap, resource: string, perms: string, src: Source): void {
  let e = m.get(resource);
  if (!e) { e = new Map(); m.set(resource, e); }
  for (const c of normPerms(perms)) {
    const cur = e.get(c);
    if (!cur || rank(src) < rank(cur)) e.set(c, src);
  }
}

export interface EffectiveAccess {
  /** Set when %All is reachable: everything, from this source. */
  full: Source | null;
  grants: GrantMap;
}
export interface UserAccess extends EffectiveAccess {
  /** Web apps that add roles while the user is in them (only those that add something). */
  apps: Array<{ app: string; roles: string[]; full: boolean; grants: GrantMap }>;
  /** Escalation roles: what the user has instead of their roles while switched. */
  escalation: Array<{ role: string; access: EffectiveAccess }>;
}

export interface AccessCheck {
  ok: boolean;
  resource: string;
  perm: string;
  source?: Source | 'all';
  allSource?: Source;
  /** When it's not granted: roles that would grant it (least powerful first). */
  suggestions: string[];
}

/* ── The graph ─────────────────────────────────────────── */

/**
 * Everything needed to explain effective access, fetched once in the
 * background (one call per role, user and web app, a few at a time) and
 * cached briefly. Call invalidateSecurityGraph() after any write.
 */
export interface SecurityGraph {
  roleList: RoleSummary[];
  userList: UserSummary[];
  resources: ResourceSummary[];
  namespaces: NamespaceInfo[];
  services: ServiceRow[];
  /** Web applications (all, enabled or not). */
  webApps: WebAppRow[];
  roles: Map<string, RoleDetail>;
  users: Map<string, UserDetail>;
  /** User → roles held directly (escalation roles excluded). */
  userRoles: Map<string, string[]>;
  /** Roles every user gets through _PUBLIC. */
  publicRoles: string[];
  resource(name: string): ResourceSummary | undefined;
  /** Database names protected by a %DB_ resource. */
  databasesFor(resource: string): string[];
  /** Database name → its resource. */
  databaseResource(db: string): string | undefined;
  /** Role → every role it confers, itself included, following GrantedRoles. */
  effective(role: string): Set<string>;
  /** Role → reachable role → shortest path from `role` to it (inclusive). */
  rolePaths(role: string): Map<string, string[]>;
  /** User → every role they end up with (login roles, following GrantedRoles). */
  userEffective(user: string): Set<string>;
  /** Role → users holding it directly, and users holding it through another role (with that role). */
  holders(role: string): { direct: string[]; inherited: Array<{ user: string; via: string }> };
  /** What a role grants, including through included roles; paths start at the role. */
  roleAccess(role: string): EffectiveAccess;
  /** What a user can do, with provenance for each privilege. */
  userAccess(user: string): UserAccess;
  /** Can this user use `perm` on `resource`? Web-app roles are not counted. */
  check(user: string, resource: string, perm: string): AccessCheck;
  /** Who can use a resource: public, roles (with perms and path), users (with source), %All holders. */
  whoCan(resource: string): {
    public: string;
    roles: Array<{ role: string; perms: string; path: string[] }>;
    users: Array<{ user: string; perms: string; source: Source | 'all' }>;
    allHolders: string[];
  };
  /** Enabled users holding %All (through any role). */
  allHolders(): string[];
  /** Enabled web applications that grant this role to people using them (application roles). */
  appsGranting?(role: string): string[];
}

const GRAPH_TTL_MS = 120000;
let graphCache: { at: number; promise: Promise<SecurityGraph> } | null = null;

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}
const soft = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

async function buildGraph(): Promise<SecurityGraph> {
  const [roleList, userList, resources, namespaces, services, dbs, dirs, apps] = await Promise.all([
    getRoleList(), getUserList(),
    soft(getResourceList(), []), soft(getNamespaceList(), []), soft(getServiceList(), []),
    soft(get<DatabaseRow[]>('/databases'), []), soft(get<DatabaseDirRow[]>('/database-dirs'), []),
    soft(get<WebAppRow[]>('/web-apps'), []),
  ]);
  const [roleDefs, userDefs, appDefs] = await Promise.all([
    pool(roleList, 6, (r) => getRole(r.Name).catch(() => null)),
    pool(userList, 4, (u) => getUser(u.Name).catch(() => null)),
    pool(apps.filter((a) => a.Enabled), 4, (a) => get<WebAppDetail>(`/web-app?name=${q(a.Name)}`).catch(() => null)),
  ]);
  const roles = new Map<string, RoleDetail>();
  roleList.forEach((r, i) => { const d = roleDefs[i]; if (d) roles.set(r.Name, d); });
  const users = new Map<string, UserDetail>();
  const userRoles = new Map<string, string[]>();
  userList.forEach((u, i) => { const d = userDefs[i]; if (d) users.set(u.Name, d); userRoles.set(u.Name, d?.Roles ?? []); });
  const publicRoles = users.get(PUBLIC_USER)?.Roles ?? [];
  const resByName = new Map(resources.map((r) => [r.Name.toLowerCase(), r]));
  const enabledApps = apps.filter((a) => a.Enabled).map((a, i) => ({ app: a.Name, match: appDefs[i]?.MatchRoles ?? [] }));

  // Database name ↔ resource, joined on directory.
  const dirRes = new Map(dirs.map((d) => [d.Directory.toLowerCase(), d.Resource]));
  const dbRes = new Map<string, string>();
  for (const d of dbs) { const r = dirRes.get(d.Directory.toLowerCase()); if (r) dbRes.set(d.Name.toUpperCase(), r); }
  const databasesFor = (resource: string): string[] =>
    [...dbRes].filter(([, r]) => r.toLowerCase() === resource.toLowerCase()).map(([n]) => n).sort();

  const pathMemo = new Map<string, Map<string, string[]>>();
  const rolePaths = (role: string): Map<string, string[]> => {
    const hit = pathMemo.get(role);
    if (hit) return hit;
    const out = new Map<string, string[]>([[role, [role]]]);
    const queue = [role];
    while (queue.length) {
      const r = queue.shift() as string;
      for (const g of roles.get(r)?.GrantedRoles ?? []) {
        if (out.has(g)) continue;
        out.set(g, [...(out.get(r) as string[]), g]);
        queue.push(g);
      }
    }
    pathMemo.set(role, out);
    return out;
  };
  const effective = (role: string): Set<string> => new Set(rolePaths(role).keys());
  const userEffective = (user: string): Set<string> => {
    const out = new Set<string>();
    for (const r of userRoles.get(user) ?? []) for (const e of effective(r)) out.add(e);
    return out;
  };
  const holders = (role: string): { direct: string[]; inherited: Array<{ user: string; via: string }> } => {
    const direct: string[] = [];
    const inherited: Array<{ user: string; via: string }> = [];
    for (const [user, held] of userRoles) {
      if (held.includes(role)) { direct.push(user); continue; }
      const via = held.find((r) => effective(r).has(role));
      if (via) inherited.push({ user, via });
    }
    return { direct: direct.sort(), inherited: inherited.sort((a, b) => a.user.localeCompare(b.user)) };
  };

  /** Fold a set of starting roles into grants; `wrap` turns a role path into a source. */
  const fold = (start: string[], wrap: (path: string[]) => Source, into: EffectiveAccess): void => {
    for (const r of start) {
      for (const [reached, path] of rolePaths(r)) {
        const src = wrap(path);
        if (reached === '%All' && (!into.full || rank(src) < rank(into.full))) into.full = src;
        for (const res of roles.get(reached)?.Resources ?? []) addGrant(into.grants, res.Name, res.Permissions, src);
      }
    }
  };
  const addPublic = (into: EffectiveAccess): void => {
    for (const r of resources) if (r.PublicPermission) addGrant(into.grants, r.Name, r.PublicPermission, { kind: 'public' });
  };

  const roleAccess = (role: string): EffectiveAccess => {
    const a: EffectiveAccess = { full: null, grants: new Map() };
    fold([role], (path) => ({ kind: 'role', path }), a);
    return a;
  };

  const baseAccess = (user: string): EffectiveAccess => {
    const a: EffectiveAccess = { full: null, grants: new Map() };
    fold(userRoles.get(user) ?? [], (path) => ({ kind: 'role', path }), a);
    if (user !== PUBLIC_USER) fold(publicRoles, (path) => ({ kind: 'everyone-user', path }), a);
    addPublic(a);
    return a;
  };

  const has = (a: EffectiveAccess, resource: string, perm: string): boolean =>
    !!a.full || [...normPerms(perm)].every((c) => a.grants.get(resource)?.has(c));

  const userAccess = (user: string): UserAccess => {
    const base = baseAccess(user);
    const held = new Set([...userEffective(user), ...publicRoles.flatMap((r) => [...effective(r)])]);
    const appList: UserAccess['apps'] = [];
    if (!base.full) {
      for (const { app, match } of enabledApps) {
        const added = new Set<string>();
        for (const m of match) if (!m.MatchRole || held.has(m.MatchRole)) m.TargetRoles.forEach((t) => added.add(t));
        const extra: EffectiveAccess = { full: null, grants: new Map() };
        fold([...added], (path) => ({ kind: 'app', app, path }), extra);
        // Keep only what the app adds beyond the user's own access.
        for (const [res, perms] of [...extra.grants]) for (const c of [...perms.keys()]) if (has(base, res, c)) perms.delete(c);
        for (const [res, perms] of [...extra.grants]) if (!perms.size) extra.grants.delete(res);
        if (extra.full || extra.grants.size) appList.push({ app, roles: [...added].sort(), full: !!extra.full, grants: extra.grants });
      }
    }
    const escalation = (users.get(user)?.EscalationRoles ?? []).map((role) => {
      const a: EffectiveAccess = { full: null, grants: new Map() };
      fold([role], (path) => ({ kind: 'role', path }), a);
      fold(publicRoles, (path) => ({ kind: 'everyone-user', path }), a);
      addPublic(a);
      return { role, access: a };
    });
    return { ...base, apps: appList, escalation };
  };

  /** Roles that grant (resource, perm), least powerful first. */
  const grantingRoles = (resource: string, perm: string): string[] => {
    const need = normPerms(perm);
    const out: Array<{ role: string; size: number }> = [];
    for (const r of roleList) {
      if (r.EscalationOnly || r.Name === '%All') continue;
      const a = roleAccess(r.Name);
      if (a.full) continue;
      if ([...need].every((c) => a.grants.get(resource)?.has(c))) out.push({ role: r.Name, size: [...a.grants.values()].reduce((n, m) => n + m.size, 0) });
    }
    // Prefer custom roles, then the one granting the fewest other things.
    return out.sort((a, b) => Number(isBuiltInRole(a.role)) - Number(isBuiltInRole(b.role)) || a.size - b.size).map((x) => x.role);
  };

  const check = (user: string, resource: string, perm: string): AccessCheck => {
    const a = baseAccess(user);
    const p = normPerms(perm);
    if (a.full) return { ok: true, resource, perm: p, source: 'all', allSource: a.full, suggestions: [] };
    const got = a.grants.get(resource);
    if ([...p].every((c) => got?.has(c))) return { ok: true, resource, perm: p, source: got?.get(p[p.length - 1]), suggestions: [] };
    return { ok: false, resource, perm: p, suggestions: grantingRoles(resource, p).slice(0, 3) };
  };

  const allHolders = (): string[] => userList
    .filter((u) => u.Enabled && u.Name !== PUBLIC_USER && baseAccess(u.Name).full)
    .map((u) => u.Name).sort();

  const whoCan = (resource: string): ReturnType<SecurityGraph['whoCan']> => {
    const rolesOut: Array<{ role: string; perms: string; path: string[] }> = [];
    for (const r of roleList) {
      const a = roleAccess(r.Name);
      const m = a.grants.get(resource);
      if (!m?.size) continue;
      const first = [...m.values()][0];
      rolesOut.push({ role: r.Name, perms: normPerms([...m.keys()].join('')), path: first.kind === 'role' ? first.path : [r.Name] });
    }
    const usersOut: Array<{ user: string; perms: string; source: Source | 'all' }> = [];
    const everyone = new Set<string>();
    for (const u of userList) {
      if (u.Name === PUBLIC_USER) continue;
      const a = baseAccess(u.Name);
      if (a.full) { usersOut.push({ user: u.Name, perms: 'RWU', source: 'all' }); continue; }
      const m = a.grants.get(resource);
      if (!m?.size) continue;
      const src = [...m.values()].sort((x, y) => rank(x) - rank(y))[0];
      if (src.kind === 'public') { everyone.add(u.Name); continue; }
      usersOut.push({ user: u.Name, perms: normPerms([...m.keys()].join('')), source: src });
    }
    return {
      public: resByName.get(resource.toLowerCase())?.PublicPermission ?? '',
      roles: rolesOut.sort((a, b) => a.role.localeCompare(b.role)),
      users: usersOut.sort((a, b) => a.user.localeCompare(b.user)),
      allHolders: usersOut.filter((x) => x.source === 'all').map((x) => x.user),
    };
  };

  const appsGranting = (role: string): string[] =>
    enabledApps.filter((x) => x.match.some((m) => m.TargetRoles.some((t) => t.toLowerCase() === role.toLowerCase()))).map((x) => x.app).sort();
  return {
    appsGranting,
    roleList, userList, resources, namespaces, services, webApps: apps, roles, users, userRoles, publicRoles,
    resource: (name) => resByName.get(name.toLowerCase()),
    databasesFor,
    databaseResource: (db) => dbRes.get(db.toUpperCase()),
    effective, rolePaths, userEffective, holders, roleAccess, userAccess, check, whoCan, allHolders,
  };
}

/** The cached graph; `fresh` forces a rebuild (the refresh button). */
export function getSecurityGraph(fresh = false): Promise<SecurityGraph> {
  if (!fresh && graphCache && Date.now() - graphCache.at < GRAPH_TTL_MS) return graphCache.promise;
  const promise = buildGraph();
  graphCache = { at: Date.now(), promise };
  promise.catch(() => { if (graphCache?.promise === promise) graphCache = null; });
  return promise;
}
/** Drop the cached graph; call after every security write. */
export function invalidateSecurityGraph(): void { graphCache = null; }

/**
 * Namespace access, as IRIS checks it: Read on the default globals database
 * to enter, Read on the routines database to run code.
 */
export function namespaceChecks(g: SecurityGraph, user: string, ns: string): Array<{ label: string; db: string; check: AccessCheck | null }> {
  const n = g.namespaces.find((x) => x.Name.toUpperCase() === ns.toUpperCase());
  if (!n) return [];
  const out: Array<{ label: string; db: string; check: AccessCheck | null }> = [];
  const add = (label: string, db: string): void => {
    const res = g.databaseResource(db);
    out.push({ label, db, check: res ? g.check(user, res, 'R') : null });
  };
  add('Enter the namespace (read its data)', n.Globals);
  if (n.Routines.toUpperCase() !== n.Globals.toUpperCase()) add('Run its code', n.Routines);
  else out[0].label = 'Enter the namespace and run its code';
  return out;
}

/* ── Cross-screen selection ────────────────────────────── */

/**
 * A screen that links to a user, role or resource stores its name here
 * before navigating; the target screen takes it once on load.
 */
export const SELECT_KEY = 'osca-portal:select';
export function linkTo(navigate: (id: string) => void, screen: 'security/users' | 'security/roles' | 'security/resources', name: string): void {
  try { sessionStorage.setItem(SELECT_KEY, name); } catch { /* storage blocked: land on the screen unselected */ }
  navigate(screen);
}
export function takeSelection(): string | null {
  try {
    const v = sessionStorage.getItem(SELECT_KEY);
    if (v !== null) sessionStorage.removeItem(SELECT_KEY);
    return v;
  } catch { return null; }
}

/** Classic Management Portal pages, for what this portal can't do. */
export const portalLink = {
  resource: (name: string): string => `/csp/sys/sec/%25CSP.UI.Portal.Dialog.Resource.zen?RESOURCENAME=${q(name)}`,
};

/** A "New role" pre-fill handed from another screen (e.g. a Check access fix). */
export interface NewRolePrefill { resources: Array<{ Name: string; Permissions: string }>; description?: string; forUser?: string }
const NEW_ROLE_KEY = 'osca-portal:new-role';
export function stashNewRole(p: NewRolePrefill): void {
  try { sessionStorage.setItem(NEW_ROLE_KEY, JSON.stringify(p)); } catch { /* storage blocked: the form opens empty */ }
}
export function takeNewRole(): NewRolePrefill | null {
  try {
    const v = sessionStorage.getItem(NEW_ROLE_KEY);
    if (v === null) return null;
    sessionStorage.removeItem(NEW_ROLE_KEY);
    return JSON.parse(v) as NewRolePrefill;
  } catch { return null; }
}
