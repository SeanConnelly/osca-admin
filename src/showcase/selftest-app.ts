// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The in-app Self-test: the shared groups (selftest-steps.ts) bound to the
 * portal's own api functions, the same ones the screens call, plus a screen
 * smoke pass that opens every page in the menu.
 */
import { AdminError, writeJson } from '../crud';
import {
  getRoleList, getRole, saveRole, deleteRole, getUserList, getUser, createUser, updateUser, deleteUser, getNamespaceList, getResourceList, getResource,
} from '../api-security';
import { saveResource, deleteResource } from '../api-resources';
import { getWebAppList, getWebApp, deleteWebApp, getTasks, getTask, getTaskInfo, suspendTask, deleteTask } from '../api-apps';
import { createWebApp, updateWebApp, createTask, type NewWebAppBody, type NewTaskBody } from '../api-web';
import { getSuperserverList, getSuperserver, saveSuperserver, deleteSuperserver, ssKey } from '../api-services';
import { getTlsConfigs, getTlsConfig, tlsConfigExists, saveTlsConfig, deleteTlsConfig, getWalletCollections, saveWalletCollection, deleteWalletCollection } from '../api-secrets';
import { saveSchedule, getWqmCategories, getWqmCategory, saveWqmCategory, deleteWqmCategory } from '../api-settings';
import { getDbConfigs } from '../api-disk';
import { getDbSettings, saveDbSettings, createDb, deleteDb, namespaceExists, createNamespace } from '../api-db';
import { MODULES } from '../modules';
import type { SelfTestApi, StepResult } from './selftest-steps';

const notFound = (err: unknown): boolean =>
  err instanceof AdminError && (err.status === 404 || /does not exist|not found/i.test(err.message));
async function existsBy(read: () => Promise<unknown>): Promise<boolean> {
  try { await read(); return true; } catch (err) { if (notFound(err)) return false; throw err; }
}
const names = async (list: Promise<Array<{ Name: string }>>): Promise<string[]> => (await list).map((x) => x.Name);
const asRow = (x: unknown): Record<string, unknown> => (x ?? {}) as Record<string, unknown>;

function webAppBody(name: string, description: string, ns: string): NewWebAppBody {
  return {
    NameSpace: ns, Description: description, Enabled: false, DispatchClass: '', Path: '',
    AutheEnabled: 32, JWTAuthEnabled: false, Resource: '', MatchRoles: [], Timeout: 900, CookiePath: `${name}/`, IsNameSpaceDefault: false,
  };
}
function taskBody(b: { Name: string; Description: string; TaskClass: string; NameSpace: string }): NewTaskBody {
  return {
    ...b, RunAsUser: '', Priority: 'Normal', TimePeriod: 'On Demand', TimePeriodEvery: 1, TimePeriodDay: '',
    DailyFrequency: 'Once', DailyFrequencyTime: '', DailyIncrement: '', DailyStartTime: '03:00:00', DailyEndTime: '',
    StartDate: '', EndDate: '', RunAfterGUID: '', MirrorStatus: 'Any', EmailOnCompletion: [], EmailOnError: [], EmailOnExpiration: [],
    EmailOutput: false, Expires: false, ExpiresDays: '', ExpiresHours: '', ExpiresMinutes: '', OpenOutputFile: false, OutputDirectory: '',
    OutputFilename: '', OutputFileIsBinary: false, SuspendOnError: false, SuspendTerminated: false, IsBatch: false, RescheduleOnStart: false,
  };
}
const dirOf = async (db: string): Promise<string> => {
  const d = (await getDbConfigs()).find((x) => x.Name === db)?.Directory;
  if (!d) throw new AdminError(`${db} does not exist`, 404);
  return d;
};

const webBodies = new Map<string, NewWebAppBody>();

export const appApi: SelfTestApi = {
  resource: {
    list: () => names(getResourceList()),
    exists: (n) => existsBy(() => getResource(n)),
    read: async (n) => asRow(await getResource(n)),
    create: async (n, b) => { await saveResource(n, b); return n; },
    update: (n, b) => saveResource(n, b),
    remove: (n) => deleteResource(n),
  },
  role: {
    list: () => names(getRoleList()),
    exists: (n) => existsBy(() => getRole(n)),
    read: async (n) => asRow(await getRole(n)),
    create: async (n, b) => { await saveRole(n, b); return n; },
    update: (n, b) => saveRole(n, b),
    remove: (n) => deleteRole(n),
  },
  user: {
    list: () => names(getUserList()),
    exists: (n) => existsBy(() => getUser(n)),
    read: async (n) => asRow(await getUser(n)),
    create: async (n, b) => { const { password, ...user } = b; await createUser(n, password, user); return n; },
    update: (n, b) => updateUser(n, b),
    remove: (n) => deleteUser(n),
  },
  webApp: {
    list: () => names(getWebAppList()),
    exists: (n) => existsBy(() => getWebApp(n)),
    read: async (n) => asRow(await getWebApp(n)),
    create: async (n, b) => { const body = webAppBody(n, b.Description, b.NameSpace); webBodies.set(n, body); await createWebApp(n, body); return n; },
    update: async (n, b) => { const base = webBodies.get(n); if (!base) throw new AdminError('Not made by this run', 409); await updateWebApp(n, { ...base, ...b }); },
    remove: (n) => deleteWebApp(n),
  },
  task: {
    list: () => names(getTasks()),
    exists: async (k) => (await getTasks()).some((t) => (/^\d+$/.test(k) ? String(t.Id) === k : t.Name === k)),
    // The list's Suspended flag lags; the task's own info has it.
    read: async (k) => { const [d, i] = await Promise.all([getTask(Number(k)), getTaskInfo(Number(k))]); return { ...asRow(d), Suspended: asRow(i).Suspended }; },
    create: async (_n, b) => {
      const id = await createTask(taskBody(b));
      try { await suspendTask(id); } catch (err) { await deleteTask(id).catch(() => undefined); throw err; }
      return String(id);
    },
    update: (k, b) => saveSchedule(Number(k), {
      TimePeriod: 'On Demand', TimePeriodEvery: 1, TimePeriodDay: '', DailyFrequency: 'Once', DailyFrequencyTime: '', DailyIncrement: '',
      DailyEndTime: '', StartDate: '', EndDate: '', ...b,
    }),
    remove: (k) => deleteTask(Number(k)),
  },
  superserver: {
    list: async () => (await getSuperserverList()).map(ssKey),
    exists: async (k) => (await getSuperserverList()).some((s) => s.Port === Number(k.split('@')[0])),
    read: async (k) => asRow(await getSuperserver(Number(k.split('@')[0]), '')),
    create: async (k, b) => { await saveSuperserver(Number(k.split('@')[0]), '', { Enabled: false, ...b }); return k; },
    update: (k, b) => saveSuperserver(Number(k.split('@')[0]), '', b),
    remove: (k) => deleteSuperserver(Number(k.split('@')[0]), ''),
  },
  tls: {
    list: () => names(getTlsConfigs()),
    exists: (n) => tlsConfigExists(n),
    read: async (n) => asRow(await getTlsConfig(n)),
    create: async (n, b) => { await saveTlsConfig(n, { Type: 0, VerifyPeer: 0, Enabled: false, ...b }); return n; },
    update: (n, b) => saveTlsConfig(n, b),
    remove: (n) => deleteTlsConfig(n),
  },
  wallet: {
    list: () => names(getWalletCollections()),
    exists: async (n) => (await names(getWalletCollections())).includes(n),
    read: async (n) => asRow((await getWalletCollections()).find((c) => c.Name === n)),
    create: async (n, b) => { await saveWalletCollection(n, b); return n; },
    update: (n, b) => saveWalletCollection(n, b),
    remove: (n) => deleteWalletCollection(n),
  },
  wqm: {
    list: () => names(getWqmCategories()),
    exists: async (n) => (await names(getWqmCategories())).includes(n),
    read: async (n) => asRow(await getWqmCategory(n)),
    create: async (n, b) => { await saveWqmCategory(n, { DefaultWorkers: 0, MaxWorkers: 0, MaxActiveWorkers: 0, AlwaysQueue: false, ...b }); return n; },
    update: (n, b) => saveWqmCategory(n, b),
    remove: (n) => deleteWqmCategory(n),
  },
  database: {
    list: () => names(getDbConfigs()),
    exists: async (n) => (await names(getDbConfigs())).includes(n),
    read: async (n) => asRow(await getDbSettings(await dirOf(n))),
    create: async (n, b) => { await createDb({ name: n, directory: b.directory, sizeMb: 1, maxMb: 0, expansionMb: 0, journal: true, resource: '%DB_%DEFAULT' }); return n; },
    update: async (n, b) => saveDbSettings(await dirOf(n), b),
    remove: async (n) => deleteDb(n, await dirOf(n), true),
  },
  namespace: {
    list: () => names(getNamespaceList()),
    exists: (n) => namespaceExists(n),
    read: async (n) => asRow((await getNamespaceList()).find((x) => x.Name === n)),
    create: async (n, b) => { await createNamespace(n, b.Globals, b.Routines); return n; },
    update: async () => { throw new AdminError('Namespaces are not changed by the self-test', 400); },
    // The portal has no delete-namespace call; this is the Admin API's own.
    remove: (n) => writeJson('DELETE', `/namespace?name=${encodeURIComponent(n)}`),
  },
  mgrDir: async () => {
    const d = await dirOf('IRISSYS');
    return /[\\/]$/.test(d) ? d : `${d}${d.includes('\\') ? '\\' : '/'}`;
  },
  webAppStates: async () => (await getWebAppList()).map((a) => `${a.Name} ${a.Enabled ? 'on' : 'off'}`),
  reservedPorts: async () => [...(await getSuperserverList()).map((s) => s.Port), Number(location.port) || 0],
};

/* ── Screen smoke pass ─────────────────────────────────────────────── */

export interface SmokeRoute { id: string; label: string }

/** Every page in the menu, except the Self-test page itself. */
export function smokeRoutes(): SmokeRoute[] {
  return MODULES.flatMap((m) => m.nav.map((i) => ({ id: `${m.key}/${i.key}`, label: m.nav.length === 1 ? m.label : `${m.label} › ${i.label}` })))
    .filter((r) => r.id !== 'settings/selftest');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const LOADING = '.load-note, ev-skeleton, .skeleton, [aria-busy="true"]';
const ERRORS = '.panel-error, .error-note';

/**
 * Open each page in turn (through the address, as a user would), wait for it
 * to settle, and look for an error panel or a console error. The caller puts
 * the original page back afterwards.
 */
export async function smokePass(onStep: (r: StepResult) => void, onProgress: (text: string) => void): Promise<void> {
  const routes = smokeRoutes();
  let consoleErrors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]): void => { consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); origError.apply(console, args); };
  const onErr = (e: ErrorEvent): void => { consoleErrors.push(e.message); };
  const onRej = (e: PromiseRejectionEvent): void => { consoleErrors.push(e.reason instanceof Error ? e.reason.message : String(e.reason)); };
  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);
  try {
    for (const [i, r] of routes.entries()) {
      onProgress(`Opening ${r.label} (${i + 1} of ${routes.length})`);
      consoleErrors = [];
      const t0 = performance.now();
      location.hash = `/${r.id}`;
      await sleep(400);
      // Wait for loading placeholders to go (at most 6 seconds), then a moment more for late errors.
      for (let waited = 0; waited < 6000 && document.querySelector(`#view-body :is(${LOADING})`); waited += 200) await sleep(200);
      await sleep(300);
      const panel = document.querySelector<HTMLElement>(`#view-body :is(${ERRORS})`);
      const title = document.querySelector('#page-title')?.textContent?.trim() ?? '';
      const problems = [
        panel ? `Error on the page: ${(panel.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)}` : '',
        consoleErrors.length ? `Console: ${consoleErrors[0].slice(0, 160)}${consoleErrors.length > 1 ? ` (+${consoleErrors.length - 1} more)` : ''}` : '',
        !title ? 'The page has no title' : '',
      ].filter(Boolean);
      onStep({ group: 'Screens', step: r.label, ok: problems.length === 0, ms: Math.round(performance.now() - t0), detail: problems.join(' · ') });
    }
  } finally {
    console.error = origError;
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onRej);
  }
}
