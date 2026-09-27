// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Who the signed-in user is and which admin privileges they hold, from
 * /api/admin/info. Read once per session and shared by every screen: each
 * screen asks `can(info, 'Operate')` instead of fetching and casting the
 * reply itself. The cache is keyed by the signed-in user, so signing out and
 * back in as someone else reads it again; a failed read is not cached.
 */
import type { AdminInfo } from './api';
import { auth, authFetch } from './auth';
import { readEnvelope } from './crud';

/** A privilege key in /api/admin/info; each names the %Admin_<key> resource (Use). */
export type Privilege =
  | 'Operate' | 'Manage' | 'Secure' | 'Task' | 'Journal' | 'Wallet' | 'FileSystemAccess'
  | 'ExternalLanguageServerEdit' | 'OAuth2_Client' | 'OAuth2_Server' | 'OAuth2_Registration';

/** AdminInfo plus the fields IRIS 2026.2 also returns. */
export interface SessionInfo extends AdminInfo {
  systemMode?: string;
  product?: string;
  /** Absent on IRIS versions that don't report privileges. */
  privileges?: Partial<Record<Privilege, { use?: boolean }>>;
}

let cached: { user: string; info: Promise<SessionInfo> } | null = null;

/** /api/admin/info for the signed-in user, read once per session. Rejects with an AdminError when IRIS refuses. */
export function sessionInfo(): Promise<SessionInfo> {
  const user = auth.user;
  if (cached && cached.user === user) return cached.info;
  const info = authFetch('/api/admin/info', { headers: { Accept: 'application/json' } }).then((res) => readEnvelope<SessionInfo>(res));
  const entry = { user, info };
  cached = entry;
  info.catch(() => { if (cached === entry) cached = null; });
  return info;
}

/**
 * Whether the user holds Use on %Admin_<level>: true or false, or null when
 * this IRIS doesn't report privileges (callers then leave actions on and let
 * IRIS refuse what isn't allowed).
 */
export function can(info: SessionInfo, level: Privilege): boolean | null {
  const p = info.privileges;
  return p ? !!p[level]?.use : null;
}
