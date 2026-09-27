// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › LDAP configurations: /v2/security/ldap/*.
 *
 * Read from %Api.Admin.Endpoints.Security.LDAP (2026.2) and tried on a
 * throwaway osca_test_ldap (created 201, description changed 200, search
 * password set 200, deleted 200; the list and workgroup.com unchanged):
 * - PUT creates (201) or changes (200) any subset of the fields below.
 *   LDAPHostNames is an array; IRIS stores it space-separated.
 * - The search password is write-only: POST …/search-password. Nothing reads it back.
 * - POST /security/ldap/test takes only {Username, Password}: it signs in through
 *   the instance's LDAP authentication, which picks the configuration by the
 *   domain after "@" in the username. It runs as an async task (202 + Location).
 *   Only its request check was tried here ({} → 400), never a real sign-in.
 */
import { get } from './api';
import { authFetch } from './auth';
import { writeJson, AdminError, sleep } from './crud';

const q = encodeURIComponent;

/** GET /security/ldap/configurations */
export interface LdapSummary { Name: string; Enabled: boolean; Description: string; LDAPCACertFile: string }

/** GET /security/ldap/configuration?name= (no password: IRIS never returns it). */
export interface LdapConfig {
  Description: string;
  LDAPAttributes: string[];
  LDAPAttributeComment: string;
  LDAPAttributeFullName: string;
  LDAPAttributeMail: string;
  LDAPAttributeMobile: string;
  LDAPAttributeMobileProvider: string;
  LDAPAttributeNameSpace: string;
  LDAPAttributeRoutine: string;
  LDAPAttributeRoles: string;
  LDAPAttributeEscalationRoles: string;
  LDAPBaseDN: string;
  LDAPBaseDNForGroups: string;
  LDAPCACertFile: string;
  LDAPClientTimeout: number;
  /** Bits: see LDAP_FLAG. */
  LDAPFlags: number;
  LDAPGroupId: string;
  LDAPHostNames: string[];
  LDAPInstanceId: string;
  OrganizationId: string;
  GroupId: string;
  InstanceId: string;
  RoleId: string;
  EscalationRoleId: string;
  RoutineId: string;
  NamespaceId: string;
  DelimiterId: string;
  LDAPSearchUsername: string;
  LDAPServerTimeout: number;
  LDAPUniqueDNIdentifier: string;
}

/** Security.LDAPConfigs LDAPFlags bits. */
export const LDAP_FLAG = {
  activeDirectory: 1,
  tls: 2,
  groups: 8,
  nestedGroups: 16,
  universalGroups: 32,
  enabled: 64,
  kerberosOnly: 128,
} as const;
export const hasFlag = (flags: number, bit: number): boolean => (Number(flags) & bit) === bit;

export const getLdapConfigs = (): Promise<LdapSummary[]> => get('/security/ldap/configurations');
export const getLdapConfig = (name: string): Promise<LdapConfig> => get(`/security/ldap/configuration?name=${q(name)}`);
export async function ldapExists(name: string): Promise<boolean> {
  try { await getLdapConfig(name); return true; } catch (err) {
    if (err instanceof AdminError && err.status === 404) return false;
    throw err;
  }
}
/** Create (201) or change (200). */
export const saveLdapConfig = (name: string, body: Partial<LdapConfig>): Promise<LdapConfig> =>
  writeJson('PUT', `/security/ldap/configuration?name=${q(name)}`, body);
/** Write-only: the password of the search user. */
export const setLdapSearchPassword = (name: string, password: string): Promise<unknown> =>
  writeJson('POST', `/security/ldap/configuration/search-password?name=${q(name)}`, { LDAPSearchPassword: password });
export const deleteLdapConfig = (name: string): Promise<unknown> =>
  writeJson('DELETE', `/security/ldap/configuration?name=${q(name)}`);

interface AsyncResult { State: string; FailureReason?: string; Result?: unknown; Console?: string[] }

/**
 * Try a sign-in through the instance's LDAP authentication. Nothing is stored.
 * Resolves to the lines IRIS reports (possibly none); a failure to run throws.
 */
export async function testLdapSignIn(username: string, password: string, timeoutMs = 30000): Promise<string[]> {
  const res = await authFetch('/api/admin/v2/security/ldap/test', {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ Username: username, Password: password }),
  });
  const text = await res.text();
  const env = (() => { try { return text ? JSON.parse(text) as { status?: { errors?: Array<{ error?: string }> }; result?: unknown; console?: string[] } : null; } catch { return null; } })();
  if (!res.ok && res.status !== 202) {
    throw new AdminError(String(env?.status?.errors?.[0]?.error ?? `HTTP ${res.status}`).replace(/^ERROR #\d+:\s*/, ''), res.status);
  }
  const id = /[?&]id=([^&]+)/.exec(res.headers.get('Location') ?? '')?.[1];
  if (!id) return lines(env?.result, env?.console);
  const started = Date.now();
  for (let wait = 250; ; wait = Math.min(wait * 1.5, 1500)) {
    const r = await get<AsyncResult>(`/async-result?id=${q(decodeURIComponent(id))}`);
    if (r.State === 'Finished') return lines(r.Result, r.Console);
    if (r.State === 'Failed' || r.State === 'Canceled') throw new Error(r.FailureReason || `The test ${r.State.toLowerCase()}.`);
    if (Date.now() - started > timeoutMs) throw new Error('The test is taking too long. The LDAP server may not be answering.');
    await sleep(wait);
  }
}
function lines(result: unknown, consoleLines?: string[]): string[] {
  const out: string[] = [...(consoleLines ?? [])];
  if (typeof result === 'string') out.push(...result.split(/\r?\n/));
  else if (Array.isArray(result)) out.push(...result.map(String));
  else if (result && typeof result === 'object') for (const v of Object.values(result as Record<string, unknown>)) if (typeof v === 'string') out.push(...v.split(/\r?\n/));
  return out.map((l) => l.trim()).filter(Boolean);
}
