// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign-in against the SysAdmin API's JWT endpoints (IRIS 2026.2+):
 *   POST /api/admin/login   { user, password, role? } → { access_token, refresh_token, sub, iat, exp }  (2026.2: top level)
 *   POST /api/admin/refresh { refresh_token }          → same shape (a { result } envelope is accepted too)
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
/** True only under the dev server's VITE_SKIP_SIGNIN bypass. */
let anonymous = false;
const expiredListeners = new Set<() => void>();

/** IRIS 2026.2 answers /login and /refresh with the tokens at the top level; accept a { result } envelope too. */
function tokensOf(json: unknown): LoginResult | null {
  const o = json as ({ result?: LoginResult } & Partial<LoginResult>) | null;
  const r = o?.result?.access_token ? o.result : o;
  return r && typeof r.access_token === 'string' && r.access_token ? (r as LoginResult) : null;
}

function fromResult(r: LoginResult, user: string): Session {
  // exp is seconds since the epoch; fall back to 5 minutes if IRIS omits it.
  const exp = typeof r.exp === 'number' ? r.exp * 1000 : Date.now() + 5 * 60_000;
  return { access: r.access_token, refresh: r.refresh_token, exp, user: r.sub ?? user };
}

export class SignInError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

export async function login(user: string, password: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(LOGIN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ user, password }),
    });
  } catch {
    throw new SignInError('Can’t reach the IRIS server. Check that the instance is running.');
  }
  if (res.status === 401) throw new SignInError('Incorrect username or password.', 401);
  if (res.status === 404) throw new SignInError('This IRIS instance has no sign-in endpoint. OSCA Admin needs IRIS 2026.2 or later.');
  if (!res.ok) throw new SignInError(`Sign-in failed: HTTP ${res.status} ${res.statusText}`);
  const tokens = tokensOf(await res.json().catch(() => null));
  if (!tokens) throw new SignInError('Sign-in succeeded but IRIS returned no token.');
  anonymous = false;
  session = fromResult(tokens, user);
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
      const tokens = tokensOf(await res.json().catch(() => null));
      if (!tokens || !session) return false;
      session = fromResult({ ...tokens, refresh_token: tokens.refresh_token ?? session.refresh }, session.user);
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

/**
 * Optional hook (the showcase's sample-data display, src/showcase). It gets
 * the URL and a `send` that performs the real request, and returns the
 * response the caller sees. It sees GETs, plus the two read-only POSTs in
 * READ_ONLY_POST (IRIS works out figures; nothing is changed), for which it
 * may only change the query string: the method, path and body always go as
 * sent. No other request reaches it. With nothing registered, every response
 * is returned unchanged.
 */
export type ResponseOverlay = (url: string, send: (url: string) => Promise<Response>) => Promise<Response>;
let overlay: ResponseOverlay | null = null;
export function registerResponseOverlay(fn: ResponseOverlay | null): void { overlay = fn; }
const READ_ONLY_POST = /^\/api\/admin\/v2\/(database-dir\/info|journal\/file\/integrity-check|journal\/file\/records)\?/;
const pathOf = (url: string): string => url.split('?')[0];

/** fetch() for IRIS APIs: Bearer token, proactive and on-401 refresh. */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (overlay && method === 'GET') return overlay(input, (url) => send(url, init));
  if (overlay && method === 'POST' && READ_ONLY_POST.test(input)) {
    return overlay(input, (url) => send(pathOf(url) === pathOf(input) ? url : input, init));
  }
  return send(input, init);
}

async function send(input: string, init: RequestInit): Promise<Response> {
  if (session && session.exp - Date.now() < 30_000) await refresh();
  // Without a token, a non-Admin API may answer with a Basic challenge: omit credentials so the
  // browser never shows its native sign-in box.
  let res = await fetch(input, session || input.startsWith('/api/admin') ? withAuth(init) : { ...init, credentials: 'omit' });
  // Only the Admin API is sure to accept the portal's JWT. Other APIs
  // (/api/monitor until the installer enables JWT there, /api/mgmnt, …) may
  // refuse a Bearer token: retry once without it, and never treat their 401
  // as a lost session.
  if (!input.startsWith('/api/admin')) {
    // Retry without the token, but never let that retry raise the browser's own Basic sign-in
    // box: with credentials omitted the browser doesn't prompt on a 401 (Fetch spec), whatever
    // WWW-Authenticate says. /api/mgmnt is not retried: it either takes the portal's token
    // (the installer enables that) or refuses, and the screen says so.
    if (res.status === 401 && session && !input.startsWith('/api/mgmnt')) res = await fetch(input, { ...init, credentials: 'omit' });
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
