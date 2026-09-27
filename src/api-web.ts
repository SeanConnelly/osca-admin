// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Types and fetchers for the Web & APIs screens: the REST API explorer
 * (%Api.Mgmnt's discovery list and the OpenAPI specs IRIS generates),
 * Doc DB applications (/v2/doc-db[s]) and privileged routine applications
 * (/v2/security/privileged-routine[s]).
 *
 * Shapes follow live IRIS 2026.2 responses and the endpoint sources
 * (%Api.Admin.Endpoints.DocDB, %Api.Admin.Endpoints.Security.PrivilegedRoutine).
 * Writes were exercised on test objects (OscaTest.Docs, osca_test_priv) and
 * cleaned up.
 */
import { get } from './api';
import { authFetch } from './auth';
import { writeJson, sendAdmin, readEnvelope, AdminError } from './crud';

const q = encodeURIComponent;

// ── REST API explorer ────────────────────────────────────────────────────

/** One REST application from the discovery list (not the Admin API envelope). */
export interface RestApi { name: string; namespace: string; dispatchClass: string; swaggerSpec: string; enabled: boolean; resource?: string }

/** /api/mgmnt refused the portal's sign-in (a secured instance where it doesn't accept the portal's token). */
export const MGMNT_REFUSED = 'The REST API list refuses your sign-in. The OSCA Admin installer enables it; on this instance it may have been changed.';

/** Every REST application IRIS can describe, with the URL of its generated spec. */
export async function getRestApis(): Promise<RestApi[]> {
  const res = await authFetch('/api/mgmnt/', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new AdminError(res.status === 403 || res.status === 401 ? MGMNT_REFUSED : 'IRIS couldn’t list its REST APIs.', res.status);
  return (await res.json()) as RestApi[];
}

/** Minimal Swagger 2.0 / OpenAPI 3 shapes: only what the explorer reads. */
interface RawParam { name?: string; in?: string; required?: boolean; type?: string; description?: string; schema?: { type?: string; $ref?: string }; $ref?: string; enum?: unknown[]; default?: unknown }
interface RawOp { summary?: string; description?: string; operationId?: string; parameters?: RawParam[]; responses?: Record<string, { description?: string }>; deprecated?: boolean; requestBody?: { description?: string; required?: boolean }; tags?: string[] }
export interface RawSpec {
  swagger?: string; openapi?: string; basePath?: string; servers?: Array<{ url?: string }>;
  info?: { title?: string; description?: string; version?: string };
  paths?: Record<string, Record<string, RawOp | RawParam[]>>;
  parameters?: Record<string, RawParam>;
}

export async function getSpec(url: string): Promise<RawSpec> {
  const res = await authFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new AdminError(res.status === 404 ? 'IRIS has no description for this API.' : (res.status === 401 || res.status === 403) && url.startsWith('/api/mgmnt') ? MGMNT_REFUSED : 'IRIS couldn’t describe this API.', res.status);
  return (await res.json()) as RawSpec;
}

export type ParamIn = 'path' | 'query' | 'header' | 'body' | 'formData' | 'cookie';
export interface Param { name: string; in: ParamIn; required: boolean; type: string; description: string; values?: string[]; fallback?: string }
export interface Endpoint {
  /** Unique key: "GET /v1/{namespace}/docnames". */
  key: string;
  method: string;
  /** Path as the spec gives it, relative to the API's base path. */
  path: string;
  /** Version group ("v1", "v2") when the first path segment is one, else "". */
  version: string;
  summary: string;
  description: string;
  params: Param[];
  responses: Array<{ code: string; description: string }>;
  deprecated: boolean;
  hasBody: boolean;
}
export interface ApiDoc { title: string; description: string; version: string; basePath: string; endpoints: Endpoint[] }

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** IRIS's generated descriptions keep the source comment's line breaks as runs of spaces. */
export function tidyText(s: string | undefined): string {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[a-z][^>]*>/gi, '') // the source comments are HTML
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\r\n?/g, '\n').replace(/[ \t]{3,}/g, '\n').split('\n').map((l) => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
/** Generated specs say "(Expected Result)" for every response; say it plainly. */
const responseText = (s: string | undefined): string => {
  const t = tidyText(s);
  return t === '(Expected Result)' ? 'Success' : t === '(Unexpected Error)' ? 'An error, described in the response' : t;
};
/** Legacy APIs have no summary: use the description's first sentence. */
const firstSentence = (d: string): string => {
  const line = d.split('\n')[0] ?? '';
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(line);
  const out = (m ? m[1] : line).trim();
  return out.length > 140 ? `${out.slice(0, 139)}…` : out;
};

function resolveParam(p: RawParam, spec: RawSpec): RawParam {
  if (p.$ref) {
    const key = p.$ref.replace(/^#\/(parameters|components\/parameters)\//, '');
    return spec.parameters?.[key] ?? { name: key, in: 'query' };
  }
  return p;
}

export function parseSpec(spec: RawSpec, fallbackBase: string): ApiDoc {
  let base = spec.basePath ?? '';
  if (!base && spec.servers?.[0]?.url) { try { base = new URL(spec.servers[0].url, location.origin).pathname; } catch { base = ''; } }
  if (!base) base = fallbackBase;
  base = base.replace(/\/+$/, '');
  const endpoints: Endpoint[] = [];
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const shared = (Array.isArray(item.parameters) ? item.parameters : []) as RawParam[];
    for (const m of METHODS) {
      const op = item[m] as RawOp | undefined;
      if (!op || Array.isArray(op)) continue;
      const byKey = new Map<string, Param>();
      for (const raw of [...shared, ...(op.parameters ?? [])]) {
        const p = resolveParam(raw, spec);
        const where = (p.in ?? 'query') as ParamIn;
        const name = p.name ?? '';
        // IRIS's legacy specs describe every request body as a string called payloadBody.
        const param: Param = {
          name: where === 'body' && name === 'payloadBody' ? 'Request body' : name,
          in: where, required: !!p.required || where === 'path',
          type: p.type ?? p.schema?.type ?? (p.schema?.$ref ? p.schema.$ref.split('/').pop() ?? '' : ''),
          description: tidyText(p.description === 'Request body contents' ? '' : p.description),
          values: p.enum?.map(String), fallback: p.default === undefined ? undefined : String(p.default),
        };
        byKey.set(`${where}:${name}`, param);
      }
      // Path parameters the template names but the spec forgot to list.
      for (const [, n] of path.matchAll(/\{([^}]+)\}/g)) if (!byKey.has(`path:${n}`)) byKey.set(`path:${n}`, { name: n, in: 'path', required: true, type: 'string', description: '' });
      const params = [...byKey.values()];
      const method = m.toUpperCase();
      endpoints.push({
        key: `${method} ${path}`, method, path,
        version: /^\/(v\d+)(\/|$)/.exec(path)?.[1] ?? '',
        summary: tidyText(op.summary) || firstSentence(tidyText(op.description)), description: tidyText(op.description),
        params, deprecated: !!op.deprecated,
        hasBody: params.some((p) => p.in === 'body' || p.in === 'formData') || !!op.requestBody,
        responses: Object.entries(op.responses ?? {}).map(([code, r]) => ({ code, description: responseText(r?.description) })),
      });
    }
  }
  return { title: tidyText(spec.info?.title), description: tidyText(spec.info?.description), version: String(spec.info?.version ?? ''), basePath: base, endpoints };
}

/**
 * Admin API areas whose reads can carry secret material (wallet values, OAuth
 * client secrets, private keys, key files, LDAP and SMTP passwords): the
 * explorer never sends a request there, whatever the parameters.
 */
const SECRET_READ = /^\/api\/admin\/v\d+\/(wallet|security\/(oauth2|x509-credential|ssl-configuration|encryption|ldap|web-auth|user\/password))(\/|\?|$)/i;

/**
 * GET requests that aren't harmless reads, with the reason shown instead of
 * the Send button: they change what other readers see.
 */
export function unsafeRead(url: string): string | null {
  // Only this server: a relative address that resolves to the portal's own origin.
  let path = '';
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin || /^\s*[a-z][a-z0-9+.-]*:|^\s*\/\//i.test(url)) return 'Only this IRIS server can be asked from here.';
    // Judge the path as the server will see it: encoded slashes and dot segments resolved.
    path = new URL(decodeURIComponent(u.pathname), location.origin).pathname;
  } catch { return 'That isn’t a valid address.'; }
  if (SECRET_READ.test(path) || SECRET_READ.test(url)) return 'This endpoint holds secrets, keys or credentials, so the explorer doesn’t read it.';
  if (/^\/api\/monitor\/alerts(\/|\?|$)/.test(url)) return 'Each alert is handed to one reader only, so reading them here would take them away from Logs › Alerts & errors.';
  if (/^\/api\/monitor\/metrics(\/|\?|$)/.test(url)) return 'IRIS works out its per-second rates between reads, so an extra read here skews them for Activity and any other monitor.';
  if (/^\/api\/atelier\/v\d+\/[^/]+\/debug(\/|\?|$)/.test(url)) return 'This opens a live debugger connection rather than returning a response.';
  return null;
}

export interface TryResult { status: number; statusText: string; ms: number; contentType: string; bytes: number; body: string; truncated: boolean; error?: string }
const MAX_SHOW = 200_000;

/**
 * Send one GET. The portal's sign-in goes only to APIs that accept it
 * (`bearer`); anything else is sent without it, so a refusal there never
 * signs the user out of the portal.
 */
export async function tryGet(url: string, bearer: boolean): Promise<TryResult> {
  const t0 = performance.now();
  // The screen checks first; this is the backstop, so nothing else can send a refused read.
  const refused = unsafeRead(url);
  if (refused) return { status: 0, statusText: '', ms: 0, contentType: '', bytes: 0, body: '', truncated: false, error: refused };
  let res: Response;
  try {
    res = bearer ? await authFetch(url, { headers: { Accept: 'application/json' } }) : await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
  } catch {
    return { status: 0, statusText: '', ms: Math.round(performance.now() - t0), contentType: '', bytes: 0, body: '', truncated: false, error: 'Can’t reach the IRIS server.' };
  }
  const text = await res.text().catch(() => '');
  const ms = Math.round(performance.now() - t0);
  const contentType = res.headers.get('content-type') ?? '';
  let body = text;
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) { try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON after all */ } }
  const bytes = new TextEncoder().encode(text).length;
  return { status: res.status, statusText: res.statusText, ms, contentType, bytes, body: body.length > MAX_SHOW ? body.slice(0, MAX_SHOW) : body, truncated: body.length > MAX_SHOW };
}

/** Hand-off from another screen (Web applications' "View API"): select this API on arrival. */
const EXPLORER_KEY = 'osca-portal:explorer-api';
export function openInExplorer(navigate: (id: string) => void, apiName: string): void {
  try { sessionStorage.setItem(EXPLORER_KEY, apiName); } catch { /* storage blocked: the explorer opens on its default */ }
  navigate('web/explorer');
}
export function takeExplorerApi(): string | null {
  try {
    const v = sessionStorage.getItem(EXPLORER_KEY);
    if (v !== null) sessionStorage.removeItem(EXPLORER_KEY);
    return v;
  } catch { return null; }
}

// ── Doc DB applications ──────────────────────────────────────────────────

/** GET /v2/doc-dbs row. Name is the document database's class name. */
export interface DocDbApp { Name: string; Namespace: string; Enabled: boolean; Resource: string; Description: string }
export interface DocDbBody { Description?: string; Enabled?: boolean; Resource?: string }

export const getDocDbs = (): Promise<DocDbApp[]> => get('/doc-dbs');
/** Creates the record when it doesn't exist, otherwise changes only the fields sent. */
export const saveDocDb = (name: string, ns: string, body: DocDbBody): Promise<DocDbBody> =>
  writeJson('PUT', `/doc-db?name=${q(name)}&namespace=${q(ns)}`, body);
export const deleteDocDb = (name: string, ns: string): Promise<unknown> => writeJson('DELETE', `/doc-db?name=${q(name)}&namespace=${q(ns)}`);

/** IRIS names a document database by a class name: Package.Name, letters and digits only. */
export const DOCDB_NAME = /^%?[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;

// ── Privileged routine applications ─────────────────────────────────────

export interface PrivRoutineRow { Name: string; Resource: string; IsSystemApp: boolean }
export interface PrivRoutine { RoutineOrClass: string; /** Database name. */ Db: string; Type: 'Routine' | 'Class' }
export interface MatchRole { /** "" = every user of the application (application roles). */ MatchRole: string; TargetRoles: string[] }
export interface PrivRoutineApp { Description: string; Enabled: boolean; Resource: string; Routines: PrivRoutine[]; MatchRoles: MatchRole[] }

/** The list reports Enabled as false for every application, so the screen reads each one's own record. */
export const getPrivRoutineList = (): Promise<PrivRoutineRow[]> => get('/security/privileged-routines');
export const getPrivRoutine = (name: string): Promise<PrivRoutineApp> => get(`/security/privileged-routine?name=${q(name)}`);
/**
 * Always send the whole definition: IRIS replaces the routine list on every
 * save, so a save without Routines would empty it.
 */
export const savePrivRoutine = (name: string, app: PrivRoutineApp): Promise<PrivRoutineApp> =>
  writeJson('PUT', `/security/privileged-routine?name=${q(name)}`, app);
export const deletePrivRoutine = (name: string): Promise<unknown> => writeJson('DELETE', `/security/privileged-routine?name=${q(name)}`);

/**
 * Is an application name free? Web, client and privileged routine
 * applications share one list, and a save to a taken name would change that
 * other application, so create checks first. Only "doesn't exist" means free.
 */
export async function appNameFree(name: string): Promise<boolean> {
  try { await getPrivRoutine(name); return false; } catch (err) {
    if (err instanceof AdminError && err.status === 404) return true;
    return false;
  }
}

/** Application roles (MatchRole "") and matching roles, split. */
export function splitRoles(m: MatchRole[]): { appRoles: string[]; matches: MatchRole[] } {
  const appRoles = [...new Set(m.filter((x) => !x.MatchRole).flatMap((x) => x.TargetRoles))];
  return { appRoles, matches: m.filter((x) => x.MatchRole) };
}
export function joinRoles(appRoles: string[], matches: MatchRole[]): MatchRole[] {
  const out: MatchRole[] = [];
  if (appRoles.length) out.push({ MatchRole: '', TargetRoles: appRoles });
  for (const m of matches) if (m.MatchRole && m.TargetRoles.length) out.push(m);
  return out;
}

// ── Creating tasks and web applications ─────────────────────────────────
// Bodies follow %Api.Admin.Endpoints.Task.CRUD (POST /v2/task: every field
// is required, Settings optional) and %Api.Admin.Endpoints.WebApp.App
// (PUT /v2/web-app creates when the name is new, else CHANGES that app).
// Exercised live on osca_test_task_c… and /csp/osca_test_c…, then deleted.

/** Everything POST /v2/task requires, in the display form it reads. */
export interface NewTaskBody {
  Name: string; Description: string; TaskClass: string; NameSpace: string; RunAsUser: string; Priority: 'Normal' | 'Low' | 'High';
  TimePeriod: 'Daily' | 'Weekly' | 'Monthly' | 'Monthly Special' | 'On Demand';
  TimePeriodEvery: number; TimePeriodDay: string | number;
  DailyFrequency: 'Once' | 'Several'; DailyFrequencyTime: '' | 'Minutes' | 'Hourly'; DailyIncrement: number | '';
  DailyStartTime: string; DailyEndTime: string; StartDate: string; EndDate: string;
  RunAfterGUID: string; MirrorStatus: 'Any' | 'Primary' | 'Not Primary';
  EmailOnCompletion: string[]; EmailOnError: string[]; EmailOnExpiration: string[]; EmailOutput: boolean;
  Expires: boolean; ExpiresDays: string; ExpiresHours: string; ExpiresMinutes: string;
  OpenOutputFile: boolean; OutputDirectory: string; OutputFilename: string; OutputFileIsBinary: boolean;
  SuspendOnError: boolean; SuspendTerminated: boolean; IsBatch: boolean; RescheduleOnStart: boolean;
  /** The task type's own settings (optional in the POST); secrets are sent once and never read back here. */
  Settings?: Record<string, string | number>;
}

/**
 * Create a task; resolves to its ID. IRIS answers 201 with the new task's
 * address in Location (the body carries no ID); if that header is missing,
 * the newest task with this name is taken.
 */
export async function createTask(body: NewTaskBody): Promise<number> {
  const res = await sendAdmin('/api/admin/v2/task', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const where = res.headers.get('location') ?? '';
  await readEnvelope<unknown>(res);
  const id = Number(/[?&]id=(\d+)/.exec(where)?.[1]);
  if (Number.isInteger(id) && id > 0) return id;
  const list = await get<Array<{ Id: number; Name: string }>>('/tasks');
  const mine = list.filter((t) => t.Name === body.Name).sort((a, b) => b.Id - a.Id)[0];
  if (!mine) throw new AdminError('IRIS saved the task but didn’t say where it is. Refresh the list to find it.', 500);
  return mine.Id;
}

/** The fields the New web application form sets. Anything left out takes IRIS's default. */
export interface NewWebAppBody {
  NameSpace: string; Description: string; Enabled: boolean;
  DispatchClass: string; Path: string;
  AutheEnabled: number; JWTAuthEnabled: boolean; Resource: string;
  MatchRoles: MatchRole[];
  Timeout: number; CookiePath: string;
  /** Sent as false: IRIS makes the first app in a namespace its default unless told otherwise. */
  IsNameSpaceDefault: boolean;
  // The rest of the settings the web-app PUT accepts (%Api.Admin.Endpoints.WebApp RequestBodySchema).
  // Optional: left out, IRIS keeps the current value (edit) or its default (create).
  TwoFactorEnabled?: boolean;
  /** Seconds (minimum 1). */
  JWTAccessTokenTimeout?: number;
  JWTRefreshTokenTimeout?: number;
  CSRFToken?: boolean;
  GroupById?: string;
  LoginPage?: string;
  /** Display values; IRIS converts them (ServeFilesDisplayToLogical). */
  ServeFiles?: 'No' | 'Always' | 'Always and cached' | 'Use CSP security';
  /** Seconds a browser may cache static files, with "Always and cached". */
  ServeFilesTimeout?: number;
  Recurse?: boolean;
  CSPZENEnabled?: boolean;
  UseCookies?: 'Never' | 'AutoDetect' | 'Always';
  SessionScope?: 'None' | 'Lax' | 'Strict';
  /** Origins allowed to call it from a browser on another site. */
  CorsAllowlist?: string[];
  CorsCredentialsAllowed?: boolean;
}

/** Is a web application path free? Web, client and privileged routine applications share one list. */
export async function webAppNameFree(name: string): Promise<boolean> {
  try { await get(`/web-app?name=${q(name)}`); return false; } catch (err) {
    if (!(err instanceof AdminError && err.status === 404)) return false;
  }
  return appNameFree(name);
}

/**
 * Create a web application. The PUT would change an existing application of
 * the same name, so the name is checked again right before it's sent.
 */
export async function createWebApp(name: string, body: NewWebAppBody): Promise<void> {
  if (!(await webAppNameFree(name))) throw new AdminError(`${name} is already taken by another application.`, 409);
  await writeJson('PUT', `/web-app?name=${q(name)}`, body);
}

// ── Audit event settings (%Api.Admin.Endpoints.Security.Audit.Event) ──────
// source/type/name are required query parameters. PUT creates a user event
// when it doesn't exist (Description, Enabled), else changes only the fields
// sent. DELETE answers 409 for a system event. clear-count zeroes one event's
// Total / Written / Lost and needs a (empty) JSON body.

export interface AuditEventKey { source: string; type: string; name: string }
const eventQs = (k: AuditEventKey): string => `source=${q(k.source)}&type=${q(k.type)}&name=${q(k.name)}`;
/** IRIS's own events have a %-prefixed source; user-defined events can't. */
export const isSystemEvent = (k: Pick<AuditEventKey, 'source'>): boolean => k.source.startsWith('%');
export const getAuditEventSetting = (k: AuditEventKey): Promise<{ Description: string; Enabled: boolean }> => get(`/security/audit/event?${eventQs(k)}`);
export const saveAuditEvent = (k: AuditEventKey, body: { Enabled?: boolean; Description?: string }): Promise<unknown> =>
  writeJson('PUT', `/security/audit/event?${eventQs(k)}`, body);
export const deleteAuditEvent = (k: AuditEventKey): Promise<unknown> => writeJson('DELETE', `/security/audit/event?${eventQs(k)}`);
export const clearAuditEventCount = (k: AuditEventKey): Promise<unknown> => writeJson('POST', `/security/audit/event/clear-count?${eventQs(k)}`, {});

// ── Web application class allow-list (%Api.Admin.Endpoints.WebApp.PctClassAccess) ──
// Which classes a web application may call through CSP (%CSP.Page, Zen…):
// AllowClass names one class, AllowPrefix a class-name prefix (a package).
// Entries marked System come with IRIS and go only with the application.

export interface PctAccess { Name: string; AllowType: 'AllowClass' | 'AllowPrefix' | string; Class: string; AllowAccess: boolean; System: boolean }
const pctQs = (app: string, type: string, cls: string): string => `name=${q(app)}&allowType=${q(type)}&class=${q(cls)}`;
/** The application's own entries (the list filter is by application name). */
export const getPctAccesses = async (app: string): Promise<PctAccess[]> =>
  (await get<PctAccess[]>(`/web-app/pct-accesses?names=${q(app)}`)).filter((x) => x.Name.toLowerCase() === app.toLowerCase());
/** Add an entry, or change whether it allows or denies. */
export const savePctAccess = (app: string, type: string, cls: string, allow: boolean): Promise<unknown> =>
  writeJson('PUT', `/web-app/pct-access?${pctQs(app, type, cls)}`, { AllowAccess: allow });
export const deletePctAccess = (app: string, type: string, cls: string): Promise<unknown> =>
  writeJson('DELETE', `/web-app/pct-access?${pctQs(app, type, cls)}`);

/** Hand-off from Schedule's "New task": Upcoming opens the New task wizard on arrival. */
const NEW_TASK_KEY = 'osca-portal:new-task';
export function requestNewTask(): void { try { sessionStorage.setItem(NEW_TASK_KEY, '1'); } catch { /* storage blocked: Upcoming opens without the wizard */ } }
export function takeNewTaskRequest(): boolean {
  try { const v = sessionStorage.getItem(NEW_TASK_KEY); sessionStorage.removeItem(NEW_TASK_KEY); return v === '1'; } catch { return false; }
}

/**
 * Save an existing web application with the full body the Edit form builds
 * (the same fields as create). The PUT would CREATE an application that has
 * gone in the meantime, so it must still exist right before it's sent.
 */
export async function updateWebApp(name: string, body: NewWebAppBody): Promise<void> {
  try { await get(`/web-app?name=${q(name)}`); } catch (err) {
    if (err instanceof AdminError && err.status === 404) throw new AdminError(`${name} no longer exists, so there’s nothing to save.`, 404);
    throw err;
  }
  await writeJson('PUT', `/web-app?name=${q(name)}`, body);
}

export const DOCS_APPS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=GSA_manage_applications';
export const docsWeb = {
  privRoutine: `${DOCS_APPS}#GSA_manage_applications_typeprivrtn`,
  docDb: `${DOCS_APPS}#GSA_manage_applications_typedocdb`,
  docDbRest: 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=GDOCDB_rest',
  rest: 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=GREST',
};
