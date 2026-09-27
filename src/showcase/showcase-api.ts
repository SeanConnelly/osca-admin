// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Client for the optional showcase module's REST API (OscaShowcase.Dispatch,
 * iris-showcase/). It exists only where that module is installed.
 */
import { authFetch } from '../auth';
import { AdminError } from '../crud';

const BASE = '/api/osca-showcase/v1';
/** The phrase the server insists on, exactly. */
export const CONFIRM_PHRASE = 'CREATE SAMPLE DATA';

export interface ShowcaseCheck { id: string; label: string; pass: boolean; detail: string }
export interface ShowcaseObject { kind: string; name: string }
export interface ShowcaseState {
  eligible: boolean;
  checks: ShowcaseCheck[];
  /** What Create would make. */
  plan: ShowcaseObject[];
  /** Sample objects this module made and still records. */
  created: ShowcaseObject[];
}
export interface ShowcaseResult { ok: boolean; message: string; created?: ShowcaseObject[]; removed?: ShowcaseObject[]; remaining?: ShowcaseObject[] }

async function send<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AdminError('Can’t reach the IRIS server. Check that the instance is running.', 0);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok || !json) throw new AdminError(json?.error ?? json?.message ?? `The showcase module answered ${res.status}.`, res.status);
  return json;
}

export const getShowcaseState = (): Promise<ShowcaseState> => send('GET', '/check');
export const applyShowcase = (phrase: string): Promise<ShowcaseResult> => send('POST', '/apply', { confirm: phrase });
export const removeShowcase = (): Promise<ShowcaseResult> => send('POST', '/remove', {});

/** Is the showcase module installed and answering? (Asked once per page load.) */
let available: Promise<boolean> | null = null;
export function showcaseAvailable(): Promise<boolean> {
  available ??= Promise.race([
    getShowcaseState().then(() => true, () => false),
    new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
  ]);
  return available;
}
