/**
 * Sign-in against the SysAdmin API's JWT endpoints (IRIS 2026.2+):
 *   POST /api/admin/login   { user, password, role? } → { result: { access_token, refresh_token, sub, exp } }
 *   POST /api/admin/refresh { refresh_token }          → same shape
 *   POST /api/admin/logout / /api/admin/revoke         (Bearer)
 * Every API call goes through authFetch(), which attaches the access token,
 * refreshes it once when it expires, and sends the user back to sign-in if
 * the session can't be recovered.
 *
 * Tokens live in sessionStorage: they survive a reload of this tab but not
 * closing it, and are never shared with other tabs.
 */

const KEY = 'osca-portal:session';
const LOGIN = '/api/admin/login';

interface Session { access: string; refresh: string; exp: number; user: string }
interface LoginResult { access_token: string; refresh_token: string; sub?: string; exp?: number }

function load(): Session | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Session | null; } catch { return null; }
}
function store(s: Session | null): void {
  try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

let session: Session | null = load();
/** True when the user chose to continue on an instance that allows unauthenticated access. */
let anonymous = false;
const expiredListeners = new Set<() => void>();

function fromResult(r: LoginResult, user: string): Session {
  // exp is seconds since the epoch; fall back to 5 minutes if IRIS omits it.
  const exp = typeof r.exp === 'number' ? r.exp * 1000 : Date.now() + 5 * 60_000;
  return { access: r.access_token, refresh: r.refresh_token, exp, user: r.sub ?? user };
}

export class SignInError extends Error {}

export async function login(user: string, password: string, role = ''): Promise<void> {
  let res: Response;
  try {
    res = await fetch(LOGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(role ? { user, password, role } : { user, password }),
    });
  } catch {
    throw new SignInError('Can’t reach the IRIS server. Check that the instance is running.');
  }
  if (res.status === 401) throw new SignInError('That username and password didn’t work.');
  if (res.status === 404) throw new SignInError('This IRIS instance has no sign-in endpoint. OSCA Portal needs IRIS 2026.2 or later.');
  if (!res.ok) throw new SignInError(`Sign-in failed: HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { result?: LoginResult };
  if (!json.result?.access_token) throw new SignInError('Sign-in succeeded but IRIS returned no token.');
  anonymous = false;
  session = fromResult(json.result, user);
  store(session);
}

let refreshing: Promise<boolean> | null = null;
function refresh(): Promise<boolean> {
  if (!session) return Promise.resolve(false);
  refreshing ??= (async () => {
    try {
      const res = await fetch('/api/admin/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: session?.refresh }),
      });
      if (!res.ok) return false;
      const json = (await res.json()) as { result?: LoginResult };
      if (!json.result?.access_token || !session) return false;
      session = fromResult({ ...json.result, refresh_token: json.result.refresh_token ?? session.refresh }, session.user);
      store(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function withAuth(init: RequestInit = {}): RequestInit {
  if (!session) return init;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${session.access}`);
  return { ...init, headers };
}

/** fetch() for IRIS APIs: Bearer token, proactive and on-401 refresh. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (session && session.exp - Date.now() < 30_000) await refresh();
  let res = await fetch(input, withAuth(init));
  // /api/monitor ships without JWT enabled (Unauthenticated only) until the
  // installer turns it on, so a Bearer token there can itself cause the 401:
  // retry once without it, and never treat a monitor 401 as a lost session.
  if (input.startsWith('/api/monitor')) {
    if (res.status === 401 && session) res = await fetch(input, init);
    return res;
  }
  if (res.status === 401 && session && (await refresh())) res = await fetch(input, withAuth(init));
  if (res.status === 401 && !anonymous) {
    session = null;
    store(null);
    for (const fn of expiredListeners) fn();
  }
  return res;
}

export async function logout(): Promise<void> {
  const s = session;
  session = null;
  anonymous = false;
  store(null);
  if (!s) return;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access}` };
  // Best effort: invalidate the refresh token, then the access token.
  await Promise.allSettled([
    fetch('/api/admin/logout', { method: 'POST', headers, body: JSON.stringify({ refresh_token: s.refresh }) }),
    fetch('/api/admin/revoke', { method: 'POST', headers }),
  ]);
}

/** Does this instance answer the Admin API without signing in? (Dev instances often do.) */
export async function allowsAnonymous(): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/info', { headers: { Accept: 'application/json' } });
    return res.ok;
  } catch {
    return false;
  }
}

export const auth = {
  get signedIn(): boolean { return session !== null || anonymous; },
  get user(): string { return session?.user ?? (anonymous ? 'Not signed in' : ''); },
  get anonymous(): boolean { return anonymous; },
  continueAnonymously(): void { anonymous = true; },
  onExpired(fn: () => void): () => void { expiredListeners.add(fn); return () => expiredListeners.delete(fn); },
};
