// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Services (the ways into IRIS) and superservers (the network ports IRIS
 * listens on): reads, writes and the plain-English knowledge both screens
 * share.
 *
 * Verified 2026-09-26 against IRISHealth262 (2026.2 build 221):
 *
 * Services
 * - The list carries Name, Enabled, Public ("Yes" / "No" / "N/A"), sign-in
 *   methods in words and allowed addresses; one service's record carries the
 *   sign-in bitmask (AutheEnabled), ClientSystems and Enabled.
 * - Save = a partial merge of { Enabled, AutheEnabled, ClientSystems }.
 *   AutheEnabled is the WHOLE mask, so bits this portal doesn't edit (the
 *   internal "System" bit, Kerberos, Mutual TLS…) are carried over as-is.
 *   ClientSystems replaces the list; [] means any address.
 * - Services can't be created or deleted. No real service was changed while
 *   building this: the request shape was checked from the endpoint source and
 *   by saving to a name that doesn't exist (valid body → 404 "does not exist";
 *   an unexpected field → 400; an object in ClientSystems → 400).
 * - Which sign-in methods a service can take isn't in the API. SERVICES below
 *   records it, from the Management Portal's own edit page on this instance
 *   (what it offers = what the service supports ∩ what the instance allows)
 *   and the "Services with Authentication Mechanisms" table in the docs.
 *
 * Superservers (tested live with throwaway osca_test superservers on port
 * 61773, all deleted afterwards)
 * - Keyed by port + bind address. Save creates (201) or merges (200); the
 *   bind address may be left out for "all addresses" (0.0.0.0 finds the
 *   same record). Delete → 200, then 404 "does not exist".
 * - IRIS accepts any free-looking port: it created and enabled one on the web
 *   server's own port, and two listeners on one port with different bind
 *   addresses. The form guards against both.
 * - TLS "Accepted"/"Required" needs a server TLS configuration (error
 *   otherwise); a port below 100 is refused; a bad bind address is refused.
 */
import { get } from './api';
import { writeJson } from './crud';
import { invalidateSecurityGraph, hasBit, withBit, ANON_USER, type SecurityGraph, type WebAppRow } from './api-security';

const q = encodeURIComponent;

/* ══ Services ═══════════════════════════════════════════════ */

export interface ServiceSummary {
  Name: string;
  Enabled: boolean;
  /** "Yes" / "No" / "N/A" (no resource). */
  Public: string;
  AuthenticationMethods: string[];
  AllowedConnections: string[];
  Description: string;
  HttpOnlyCookies?: boolean;
  TwoFactorEnabled?: boolean;
}
export interface ServiceDetail { AutheEnabled: number; ClientSystems: string[]; Description: string; Enabled: boolean }
export type ServicePatch = Partial<Pick<ServiceDetail, 'AutheEnabled' | 'ClientSystems' | 'Enabled'>>;

export const getServices = (): Promise<ServiceSummary[]> => get('/security/services');
export const getService = (name: string): Promise<ServiceDetail> => get(`/security/service?name=${q(name)}`);
export async function saveService(name: string, patch: ServicePatch): Promise<ServiceDetail> {
  try { return await writeJson<ServiceDetail>('PUT', `/security/service?name=${q(name)}`, patch); } finally { invalidateSecurityGraph(); }
}

/** Instance-wide sign-in switches (Authentication options): only these can be offered on a service. */
export interface WebAuth {
  AutheUnauthenticated: boolean; AutheCache: boolean; AutheOS: boolean; AutheDelegated: boolean; AutheLDAP: boolean;
  AutheKB: boolean; AutheTwoFactorPW: boolean; AutheTwoFactorSMS: boolean; AutheOAuth2?: boolean; AutheLoginToken?: boolean;
}
export const getWebAuth = (): Promise<WebAuth> => get('/security/web-auth');

/** A sign-in method as people know it. */
export type MethodKey = 'unauth' | 'password' | 'os' | 'delegated' | 'ldap' | 'kerberos' | 'mtls' | 'oauth' | 'totp' | 'sms';
export interface Method {
  key: MethodKey;
  label: string;
  /** What it means for someone connecting. */
  means: string;
  /** Bits in the service's mask; several for Kerberos. */
  bits: number[];
  /** The instance-wide switch that must be on for it to be offered. */
  system?: keyof WebAuth;
  /** Edited here (the others are shown and kept as they are). */
  editable: boolean;
}
export const METHODS: Method[] = [
  { key: 'password', label: 'Password', means: 'Sign in with an IRIS username and password', bits: [2 ** 5], system: 'AutheCache', editable: true },
  { key: 'unauth', label: 'No sign-in', means: 'Connect without a username, as UnknownUser, with UnknownUser’s roles', bits: [2 ** 6], system: 'AutheUnauthenticated', editable: true },
  { key: 'os', label: 'Operating system', means: 'Trust the operating-system account of the local process', bits: [2 ** 4], system: 'AutheOS', editable: true },
  { key: 'delegated', label: 'Delegated', means: 'Checked by your own sign-in code (ZAUTHENTICATE)', bits: [2 ** 13], system: 'AutheDelegated', editable: true },
  { key: 'ldap', label: 'LDAP', means: 'Checked against your LDAP or Active Directory server', bits: [2 ** 11], system: 'AutheLDAP', editable: true },
  { key: 'kerberos', label: 'Kerberos', means: 'Kerberos tickets', bits: [2 ** 0, 2 ** 1, 2 ** 2, 2 ** 3, 2 ** 7, 2 ** 8, 2 ** 9], system: 'AutheKB', editable: false },
  { key: 'mtls', label: 'Mutual TLS', means: 'A client certificate over TLS', bits: [2 ** 25], editable: false },
  { key: 'oauth', label: 'OAuth 2.0', means: 'An OAuth 2.0 access token', bits: [2 ** 26], system: 'AutheOAuth2', editable: false },
  { key: 'totp', label: 'Two-factor: authenticator app', means: 'Password plus a one-time code from an authenticator app', bits: [2 ** 21], system: 'AutheTwoFactorPW', editable: true },
  { key: 'sms', label: 'Two-factor: text message', means: 'Password plus a code sent by text message', bits: [2 ** 20], system: 'AutheTwoFactorSMS', editable: true },
];
export const methodOf = (key: MethodKey): Method => METHODS.find((m) => m.key === key) as Method;
export const methodOn = (mask: number, m: Method): boolean => m.bits.some((b) => hasBit(mask, b));
/** Set or clear a method in a mask; clearing Kerberos clears every Kerberos bit. */
export function withMethod(mask: number, m: Method, on: boolean): number {
  if (on) return withBit(mask, m.bits[0], true);
  return m.bits.reduce((acc, b) => withBit(acc, b, false), mask);
}
/** The methods on in a mask, in display order. */
export const methodsIn = (mask: number): Method[] => METHODS.filter((m) => methodOn(mask, m));

export type ServiceKind = 'people' | 'system';
export interface ServiceInfo {
  /** Short name: "SQL, objects & Native API". */
  label: string;
  /** One or two sentences: what this way in is. */
  what: string;
  kind: ServiceKind;
  /** Resources whose Use is checked (none for services that are simply on or off). */
  resources: string[];
  /** Sign-in methods this service supports. */
  methods: MethodKey[];
  /** Can be limited to certain client addresses. */
  ips: boolean;
  /** Addresses may carry roles ("10.0.0.5|RoleA,RoleB"). */
  ipRoles?: boolean;
  /** Carried by superservers that have this switch on. */
  flag?: SuperserverFlag;
  /** The Terminal-style services: the most sensitive ways in. */
  sensitive?: boolean;
  legacy?: boolean;
  /** Only on one platform. */
  platform?: string;
}

/**
 * What each service is, in words, and what it supports. Methods: the
 * Management Portal's edit page on this instance plus the docs table
 * (GSA_manage_services, "Services with Authentication Mechanisms").
 */
export const SERVICES: Record<string, ServiceInfo> = {
  '%Service_Bindings': {
    label: 'SQL, objects & Native API', kind: 'people', resources: ['%Service_SQL', '%Service_Object'], flag: 'EnableClients', ips: true,
    methods: ['unauth', 'password', 'delegated', 'ldap', 'kerberos', 'oauth', 'totp', 'sms'],
    what: 'Client connections over the network: SQL tools and applications through ODBC and JDBC, Java, .NET and Python object connections, and the Native API. Most applications and SQL tools connect through this service.',
  },
  '%Service_WebGateway': {
    label: 'Web Gateway', kind: 'people', resources: ['%Service_WebGateway'], flag: 'EnableCSP', ips: true,
    methods: ['unauth', 'password', 'delegated', 'ldap', 'kerberos', 'mtls', 'oauth'],
    what: 'Connections from the Web Gateway, which carries every web page and REST call, including the Management Portal and this portal. How people sign in to a web app is set on each web application; this service controls how the gateway itself connects.',
  },
  '%Service_Console': {
    label: 'Windows console Terminal', kind: 'people', resources: ['%Service_Console'], ips: false, sensitive: true, platform: 'Windows',
    methods: ['unauth', 'os', 'password', 'delegated', 'ldap', 'kerberos', 'totp', 'sms'],
    what: 'The Terminal opened on this Windows server itself. One of the most sensitive services: a Terminal session can read or change anything its user’s roles allow.',
  },
  '%Service_Terminal': {
    label: 'Terminal', kind: 'people', resources: ['%Service_Terminal'], ips: false, sensitive: true, platform: 'UNIX, Linux and macOS',
    methods: ['unauth', 'os', 'password', 'delegated', 'ldap', 'kerberos', 'totp', 'sms'],
    what: 'The Terminal opened on this server itself (UNIX, Linux and macOS). One of the most sensitive services: a Terminal session can read or change anything its user’s roles allow.',
  },
  '%Service_Telnet': {
    label: 'Telnet Terminal', kind: 'people', resources: ['%Service_Telnet'], ips: false, sensitive: true, platform: 'Windows',
    methods: ['unauth', 'password', 'delegated', 'ldap', 'kerberos'],
    what: 'Terminal sessions over the network with Telnet on a Windows server, including the remote Terminal. Telnet traffic isn’t encrypted.',
  },
  '%Service_CallIn': {
    label: 'Call-in', kind: 'people', resources: ['%Service_CallIn'], ips: false,
    methods: ['unauth', 'os', 'delegated', 'ldap'],
    what: 'Programs on this server that start an IRIS process through the Call-in interface, such as C programs and the irispython command.',
  },
  '%Service_ComPort': {
    label: 'COM ports', kind: 'people', resources: ['%Service_ComPort'], ips: false, platform: 'Windows',
    methods: ['unauth', 'password', 'delegated', 'ldap'],
    what: 'Sessions over serial (COM) ports attached to this Windows server.',
  },
  '%Service_CacheDirect': {
    label: 'Caché Direct', kind: 'people', resources: ['%Service_CacheDirect'], flag: 'EnableCacheDirect', ips: true, legacy: true,
    methods: ['unauth', 'password'],
    what: 'An old protocol for Caché Direct clients. Keep it off unless something still depends on it.',
  },
  '%Service_DocDB': {
    label: 'Document database', kind: 'people', resources: ['%Service_DocDB'], ips: false, methods: [],
    what: 'Document database (DocDB) applications. How people sign in is set on each DocDB application.',
  },
  '%Service_EscalateLogin': {
    label: 'Escalation sign-in', kind: 'people', resources: ['%Service_EscalateLogin'], ips: false,
    methods: ['os', 'password', 'delegated', 'ldap', 'kerberos'],
    what: 'Switching to an escalation role for a while. The methods here are the ones accepted to confirm who is switching.',
  },
  '%Service_Login': {
    label: 'Sign-in from code', kind: 'people', resources: ['%Service_Login'], ips: false,
    methods: ['password', 'delegated', 'ldap'],
    what: 'Code that signs a running process in as a different user.',
  },
  '%Service_DataCheck': {
    label: 'DataCheck', kind: 'system', resources: [], flag: 'EnableDataCheck', ips: true, methods: [],
    what: 'Lets another IRIS system compare its data with this one (DataCheck).',
  },
  '%Service_ECP': {
    label: 'ECP (distributed cache)', kind: 'system', resources: [], flag: 'EnableECP', ips: true, ipRoles: true, methods: [],
    what: 'Lets application servers use this instance’s databases over ECP. There’s no sign-in: every allowed machine is trusted, so list the machines.',
  },
  '%Service_Mirror': {
    label: 'Mirroring', kind: 'system', resources: [], flag: 'EnableMirror', ips: false, methods: [],
    what: 'Lets the other members of a mirror connect to this instance.',
  },
  '%Service_Monitor': {
    label: 'Monitoring (SNMP)', kind: 'system', resources: [], flag: 'EnableSNMP', ips: true, methods: [],
    what: 'SNMP and remote monitoring commands.',
  },
  '%Service_Shadow': {
    label: 'Shadowing', kind: 'system', resources: [], flag: 'EnableShadows', ips: true, legacy: true, methods: [],
    what: 'Lets shadow destinations copy from this instance. Kept only for older setups.',
  },
  '%Service_Sharding': {
    label: 'Sharding', kind: 'system', resources: [], flag: 'EnableSharding', ips: true, methods: [],
    what: 'Lets this instance act as a data server in a sharded cluster.',
  },
  '%Service_Weblink': {
    label: 'WebLink', kind: 'system', resources: [], flag: 'EnableWebLink', ips: true, legacy: true, methods: [],
    what: 'An old way of serving web pages (WebLink). Keep it off unless something still depends on it.',
  },
};
/** Info for a service, with a fallback for ones this portal doesn't know. */
export function serviceInfo(s: { Name: string; Description: string; Public?: string }): ServiceInfo {
  const known = SERVICES[s.Name];
  if (known) return known;
  const res = s.Public && s.Public !== 'N/A' ? [s.Name] : [];
  return { label: s.Name.replace(/^%Service_/, ''), what: s.Description, kind: res.length ? 'people' : 'system', resources: res, methods: [], ips: false };
}
/** The service the Management Portal and this portal are reached through. */
export const PORTAL_SERVICE = '%Service_WebGateway';

/* ── Who can get in (shared by Services and Superservers) ── */

/** What callers who don't sign in get on this instance. */
export interface Anon { enabled: boolean; roles: string[]; full: boolean }
export function anonOf(g: SecurityGraph | null): Anon | null {
  if (!g) return null;
  const u = g.userList.find((x) => x.Name === ANON_USER);
  return { enabled: !!u?.Enabled, roles: g.userRoles.get(ANON_USER) ?? [], full: !!u?.Enabled && !!g.userAccess(ANON_USER).full };
}
export function anonGets(a: Anon | null): string {
  if (!a) return 'UnknownUser’s roles';
  if (a.full) return 'full access to everything (UnknownUser holds %All)';
  return a.roles.length ? `UnknownUser’s roles (${a.roles.join(', ')})` : 'only what’s open to everyone (UnknownUser holds no roles)';
}
/** Is Use on one of the service's resources given to everyone? */
export function everyoneUse(s: ServiceSummary, info: ServiceInfo, g: SecurityGraph | null): boolean {
  if (!info.resources.length) return false;
  if (g) return info.resources.some((r) => (g.resource(r)?.PublicPermission ?? '').toUpperCase().includes('U'));
  return s.Public === 'Yes';
}
/** Does a caller who doesn't sign in pass the Use check? */
export function anonCanUse(s: ServiceSummary, info: ServiceInfo, g: SecurityGraph | null): boolean {
  if (info.kind !== 'people') return false;
  if (everyoneUse(s, info, g)) return true;
  return !!g && info.resources.some((r) => g.check(ANON_USER, r, 'U').ok);
}
export const noSignInOn = (s: ServiceSummary): boolean => s.AuthenticationMethods.some((m) => /^unauthenticated$/i.test(m));
/**
 * "Anyone can connect": on, allows No sign-in, and the caller passes the Use
 * check. Not for the Web Gateway: its No sign-in is how the gateway itself
 * connects; what a browser can do is set on each web application.
 */
export const anyoneCanConnect = (s: ServiceSummary, info: ServiceInfo, g: SecurityGraph | null): boolean =>
  s.Name !== PORTAL_SERVICE && s.Enabled && noSignInOn(s) && anonCanUse(s, info, g);
/** Enabled web applications that allow No sign-in: where "anyone can connect" over the web. */
export const noSignInApps = (g: SecurityGraph | null): WebAppRow[] =>
  (g?.webApps ?? []).filter((a) => a.Enabled && a.AuthenticationMethods.some((m) => /^unauthenticated$/i.test(m)));
/** The API's method words in the portal's vocabulary. */
export const methodWord = (m: string): string => (/^unauthenticated$/i.test(m) ? 'No sign-in' : m);

/** ECP connections to this instance (sharding and ECP in use). Empty when none or unknown. */
export const getEcpAppServers = (): Promise<unknown[]> => get<unknown[]>('/ecp/application-servers').catch(() => []);

/** "Any address", "127.0.0.1", "3 addresses". */
export function addressWords(list: string[]): string {
  if (!list.length) return 'Any address';
  if (list.length === 1) return list[0].split('|')[0];
  return `${list.length} addresses`;
}
/** One allowed address in words: "10.0.0.5 (roles: A, B)". */
export function addressEntry(e: string): { address: string; roles: string[] } {
  const bar = e.indexOf('|');
  return bar < 0 ? { address: e, roles: [] } : { address: e.slice(0, bar), roles: e.slice(bar + 1).split(',').filter(Boolean) };
}
/** Loose check of one allowed-address line; IRIS checks it again on save. */
export function addressProblem(line: string): string | null {
  const a = addressEntry(line.trim()).address;
  if (!a) return 'Empty entry';
  if (/\s/.test(a)) return `“${a}” has a space in it`;
  if (/[;,]/.test(a)) return `Put “${a}” on separate lines`;
  if (!/^[A-Za-z0-9.:*\-_[\]/]+$/.test(a)) return `“${a}” isn’t an address, range or host name`;
  return null;
}
/** Addresses that mean "this machine". */
export const isLocalAddress = (a: string): boolean => /^(127\.|localhost$|::1$|\[::1\]$)/i.test(addressEntry(a).address.trim());

/* ══ Superservers ═══════════════════════════════════════════ */

export type SuperserverFlag = 'EnableClients' | 'EnableCSP' | 'EnableDataCheck' | 'EnableECP' | 'EnableMirror' | 'EnableSharding'
  | 'EnableSNMP' | 'EnableCacheDirect' | 'EnableShadows' | 'EnableWebLink' | 'EnableNodeJS';

export interface SuperserverSummary { Port: number; BindAddress: string; Enabled: boolean; SystemDefault: boolean }
export interface SuperserverDetail extends Record<SuperserverFlag, boolean> {
  Description: string; Enabled: boolean; SSLConfig: string; SSLSupportLevel: number; SystemDefault: boolean;
}
export type Superserver = SuperserverSummary & SuperserverDetail;
export type SuperserverPatch = Partial<Omit<SuperserverDetail, 'SystemDefault'>>;

/** Blank and 0.0.0.0 both mean every address; the API finds the record without the parameter. */
export const allAddresses = (bind: string): boolean => !bind || bind === '0.0.0.0';
const ssQuery = (port: number, bind: string): string => `port=${port}${allAddresses(bind) ? '' : `&bindAddress=${q(bind)}`}`;
/** Row key (port + bind address). */
export const ssKey = (s: { Port: number; BindAddress: string }): string => `${s.Port}@${allAddresses(s.BindAddress) ? '0.0.0.0' : s.BindAddress}`;

export const getSuperserverList = (): Promise<SuperserverSummary[]> => get('/security/superservers');
export const getSuperserver = (port: number, bind: string): Promise<SuperserverDetail> => get(`/security/superserver?${ssQuery(port, bind)}`);
/** Every superserver with its settings (there are only ever a few). */
export async function getSuperservers(): Promise<Superserver[]> {
  const list = await getSuperserverList();
  return Promise.all(list.map(async (s) => ({ ...(await getSuperserver(s.Port, s.BindAddress)), ...s })));
}
/** Create (when the port + address is new) or change. */
export const saveSuperserver = (port: number, bind: string, patch: SuperserverPatch): Promise<SuperserverDetail> =>
  writeJson('PUT', `/security/superserver?${ssQuery(port, bind)}`, patch);
export const deleteSuperserver = (port: number, bind: string): Promise<unknown> =>
  writeJson('DELETE', `/security/superserver?${ssQuery(port, bind)}`);

export interface FlagInfo {
  flag: SuperserverFlag;
  label: string;
  /** The service these connections then pass through, if any. */
  service?: string;
  /** Connections that can be encrypted with this port's TLS setting. */
  tls: boolean;
  /** Only the default superserver may carry it. */
  defaultOnly?: boolean;
  legacy?: boolean;
  what: string;
}
/** What a superserver can accept, from the docs (GSA_manage_superserver). */
export const FLAGS: FlagInfo[] = [
  { flag: 'EnableClients', label: 'SQL, objects & Native API', service: '%Service_Bindings', tls: true, what: 'ODBC and JDBC, object connections and the Native API' },
  { flag: 'EnableCSP', label: 'Web Gateway (web pages and REST)', service: '%Service_WebGateway', tls: true, what: 'The Web Gateway, which carries every web page and REST call' },
  { flag: 'EnableDataCheck', label: 'DataCheck', service: '%Service_DataCheck', tls: true, what: 'Data comparisons from another system' },
  { flag: 'EnableECP', label: 'ECP', service: '%Service_ECP', tls: false, defaultOnly: true, what: 'Application servers using this instance’s databases' },
  { flag: 'EnableMirror', label: 'Mirroring', service: '%Service_Mirror', tls: false, defaultOnly: true, what: 'Other mirror members' },
  { flag: 'EnableSharding', label: 'Sharding', service: '%Service_Sharding', tls: false, defaultOnly: true, what: 'Other members of a sharded cluster' },
  { flag: 'EnableSNMP', label: 'SNMP monitoring', service: '%Service_Monitor', tls: false, what: 'SNMP monitoring (Windows only)' },
  { flag: 'EnableCacheDirect', label: 'Caché Direct', service: '%Service_CacheDirect', tls: true, legacy: true, what: 'Old Caché Direct clients' },
  { flag: 'EnableShadows', label: 'Shadowing', service: '%Service_Shadow', tls: true, legacy: true, what: 'Shadow destinations' },
  { flag: 'EnableWebLink', label: 'WebLink', service: '%Service_Weblink', tls: false, legacy: true, what: 'Old WebLink web pages' },
  { flag: 'EnableNodeJS', label: 'Node.js (old driver)', tls: false, legacy: true, what: 'The old Caché Node.js driver' },
];

export const TLS_LEVELS: Array<{ value: number; label: string; means: string }> = [
  { value: 0, label: 'Off', means: 'Connections aren’t encrypted' },
  { value: 1, label: 'Accepted', means: 'Clients may use TLS; unencrypted connections still work' },
  { value: 2, label: 'Required', means: 'Only encrypted connections are accepted' },
];
export const tlsLabel = (level: number): string => TLS_LEVELS.find((t) => t.value === level)?.label ?? String(level);

/** TLS configurations (only server ones can be used on a superserver). */
export interface TlsConfig { Name: string; Description: string; Enabled: boolean; Type: string }
export const getTlsConfigs = (): Promise<TlsConfig[]> => get('/security/ssl-configurations');

/* ══ Management Portal pages (each checked: HTTP 200) ═══════ */

export const portalServices = {
  list: '/csp/sys/sec/%25CSP.UI.Portal.Services.zen',
  edit: (name: string): string => `/csp/sys/sec/%25CSP.UI.Portal.Dialog.Service.zen?PID=${q(name)}`,
  authentication: '/csp/sys/sec/%25CSP.UI.Portal.Authentication.zen',
  superservers: '/csp/sys/sec/%25CSP.UI.Portal.Servers.zen',
  superserver: (port: number, bind: string): string => `/csp/sys/sec/%25CSP.UI.Portal.Server.zen?PID=${q(`${port}&${allAddresses(bind) ? '' : bind}`)}`,
  newSuperserver: `/csp/sys/sec/%25CSP.UI.Portal.Server.zen?PID=${q('&')}`,
};

/* ══ Cross-screen selection (same slot the other security screens use) ══ */

const SELECT_KEY = 'osca-portal:select';
/** Open another screen with an item selected (Services ↔ Superservers). */
export function linkToScreen(navigate: (id: string) => void, screen: string, key: string): void {
  try { sessionStorage.setItem(SELECT_KEY, key); } catch { /* storage blocked: land unselected */ }
  navigate(screen);
}
