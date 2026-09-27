// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The New / Edit web application form as data, with no DOM: the values the
 * form starts from (formFromApp) and the body its Save sends (webAppBody).
 * Kept free of imports that touch the page, so the exact same code can be
 * exercised outside the browser (the controlled create → edit → delete test).
 */
import type { NewWebAppBody } from './api-web';

export type WebAppFormValues = Record<string, string | boolean | string[]>;

/** Sign-in methods the form offers ($$$Authe* bits in %sySecurity.inc). */
export const SIGN_IN: Array<{ key: string; label: string; bit: number; system: string; hint?: string }> = [
  { key: 'AuthPassword', label: 'Password', bit: 2 ** 5, system: 'AutheCache' },
  { key: 'AuthNone', label: 'No sign-in', bit: 2 ** 6, system: 'AutheUnauthenticated', hint: 'Requests run as UnknownUser, with UnknownUser’s roles.' },
  { key: 'AuthDelegated', label: 'Delegated', bit: 2 ** 13, system: 'AutheDelegated', hint: 'Checked by your own sign-in code (ZAUTHENTICATE).' },
  { key: 'AuthLdap', label: 'LDAP', bit: 2 ** 11, system: 'AutheLDAP' },
];
const hasBit = (mask: number, bit: number): boolean => Math.floor(mask / bit) % 2 === 1;

/** What an existing application contributes beyond the form's fields, so a save keeps it as it was. */
export interface WebAppBase {
  AutheEnabled: number;
  MatchRoles: Array<{ MatchRole: string; TargetRoles: string[] }>;
  /** Seconds. */
  Timeout: number;
  IsNameSpaceDefault: boolean;
}

/** The application's current settings as form values (Edit); a new application's defaults when `d` is null. */
export function formFromApp(name: string, d: (WebAppBase & {
  NameSpace: string; Description: string; Enabled: boolean; DispatchClass: string; Path: string; JWTAuthEnabled: boolean; Resource: string; CookiePath: string;
}) | null, defaults: { namespace?: string } = {}): WebAppFormValues {
  const v: WebAppFormValues = {
    Path: name,
    NameSpace: d?.NameSpace ?? defaults.namespace ?? '',
    Description: d?.Description ?? '',
    Enabled: d?.Enabled ?? true,
    Kind: !d || d.DispatchClass ? 'rest' : 'csp',
    DispatchClass: d?.DispatchClass ?? '',
    FilePath: d && !d.DispatchClass ? d.Path : '',
    Jwt: d?.JWTAuthEnabled ?? false,
    Resource: d?.Resource ?? '',
    Roles: d ? [...new Set(d.MatchRoles.filter((m) => !m.MatchRole).flatMap((m) => m.TargetRoles))] : [],
    // Whole minutes when the stored timeout is; otherwise the exact seconds are kept unless the field changes.
    Timeout: d ? String(d.Timeout % 60 === 0 ? d.Timeout / 60 : Math.round((d.Timeout / 60) * 100) / 100) : '15',
    CookiePath: d?.CookiePath ?? '',
  };
  for (const m of SIGN_IN) v[m.key] = d ? hasBit(d.AutheEnabled, m.bit) : m.key === 'AuthPassword';
  return v;
}

/**
 * The body Save sends: the same fields for Create and Edit. For an edit, what
 * the form doesn't show is carried over from `base`: sign-in bits it doesn't
 * offer (Kerberos, OS, two-factor…), role rules for holders of a role, the
 * exact timeout when the minutes weren't changed, and whether it is the
 * namespace's default application.
 */
export function webAppBody(v: WebAppFormValues, base: WebAppBase | null): NewWebAppBody {
  const path = String(v.Path ?? '').trim();
  const rest = String(v.Kind) === 'rest';
  const roleNames = Array.isArray(v.Roles) ? v.Roles.map(String) : [];
  const kept = base ? SIGN_IN.reduce((mask, m) => (hasBit(mask, m.bit) ? mask - m.bit : mask), base.AutheEnabled) : 0;
  const chosen = SIGN_IN.reduce((mask, m) => (v[m.key] ? mask + m.bit : mask), 0);
  const minutesText = String(v.Timeout ?? '15').trim();
  const unchanged = base && minutesText === formFromApp('', { ...base, NameSpace: '', Description: '', Enabled: true, DispatchClass: '', Path: '', JWTAuthEnabled: false, Resource: '', CookiePath: '' }).Timeout;
  const rules = base ? base.MatchRoles.filter((m) => m.MatchRole && m.TargetRoles.length) : [];
  return {
    NameSpace: String(v.NameSpace ?? ''),
    Description: String(v.Description ?? '').trim(),
    Enabled: !!v.Enabled,
    DispatchClass: rest ? String(v.DispatchClass ?? '').trim() : '',
    Path: rest ? '' : String(v.FilePath ?? '').trim(),
    AutheEnabled: kept + chosen,
    JWTAuthEnabled: rest && !!v.Jwt,
    Resource: String(v.Resource ?? ''),
    MatchRoles: [...(roleNames.length ? [{ MatchRole: '', TargetRoles: roleNames }] : []), ...rules],
    Timeout: unchanged && base ? base.Timeout : Math.round(Number(minutesText) * 60),
    CookiePath: String(v.CookiePath ?? '').trim() || `${path}/`,
    // A new application is never made its namespace's default; an existing one keeps what it had.
    IsNameSpaceDefault: base ? base.IsNameSpaceDefault : false,
  };
}
