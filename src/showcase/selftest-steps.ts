// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-test: the create / read / update / delete groups, shared by the
 * in-app Self-test page (selftest-app.ts binds them to the portal's own api
 * functions) and the command-line runner (scripts/selftest.mjs binds them to
 * the same Admin API calls over HTTP). No imports: Node runs this file as is.
 *
 * Rules every group follows:
 *  - It works only on its own osca_test_st_ objects, and checks each name is
 *    free first. A name that already exists is left alone and the group fails.
 *  - It snapshots the relevant list first and checks the list matches again
 *    at the end.
 *  - Everything it creates is off: users and web applications disabled, the
 *    task on demand and suspended, the superserver disabled, the TLS
 *    configuration disabled, the namespace without interoperability.
 *  - If a step fails, whatever the group made is deleted before moving on.
 * Never tested (side effects on existing configuration): OAuth, managed file
 * transfer, services, license, journal settings, ECP, processes, and any
 * change to an existing object.
 */

export interface Grant { Name: string; Permissions: string }

/** One kind of object, reduced to what the tests need. Keys are names (task: its ID as text). */
export interface Crud<C, U = Partial<C>> {
  /** Names in the list (sorted by the runner). */
  list(): Promise<string[]>;
  exists(key: string): Promise<boolean>;
  read(key: string): Promise<Record<string, unknown>>;
  /** Resolves to the new object's key (a name, or a task ID). */
  create(name: string, body: C): Promise<string>;
  update(key: string, body: U): Promise<unknown>;
  remove(key: string): Promise<unknown>;
}

export interface TaskBody { Name: string; Description: string; TaskClass: string; NameSpace: string }
export interface DbBody { directory: string }

export interface SelfTestApi {
  role: Crud<{ Description: string; Resources: Grant[] }>;
  resource: Crud<{ Description: string; PublicPermission: string }, { Description: string }>;
  user: Crud<{ password: string; FullName: string; Enabled: boolean; Roles: string[] }, { FullName: string }>;
  webApp: Crud<{ Description: string; NameSpace: string }, { Description: string }>;
  /** create makes the task on demand, then suspends it; update changes its (unused) start time. */
  task: Crud<TaskBody, { DailyStartTime: string }>;
  /** Keys are "port@bind". */
  superserver: Crud<{ Description: string }, { Description: string }>;
  tls: Crud<{ Description: string }, { Description: string }>;
  wallet: Crud<{ UseResource: string; EditResource: string }, { UseResource: string }>;
  wqm: Crud<{ MaxTotalWorkers: number }, { MaxTotalWorkers: number }>;
  /** Database: create makes the file and names it; update sets the size limit (MB); remove deletes both. */
  database: Crud<DbBody, { MaxSize: number }>;
  /** Namespace on existing databases: remove deletes it (never enables interoperability). */
  namespace: Crud<{ Globals: string; Routines: string }, never>;
  /** The manager directory (where the test database goes), with its trailing separator. */
  mgrDir(): Promise<string>;
  /** Web applications with their on/off state, for the before-and-after check. */
  webAppStates(): Promise<string[]>;
  /** Ports already used by the instance (web server, superserver) that the test must not take. */
  reservedPorts(): Promise<number[]>;
}

export interface StepResult { group: string; step: string; ok: boolean; ms: number; detail: string }
export type Report = StepResult[];

export const PREFIX = 'osca_test_st_';
const SUPERSERVER_PORT = 61773;

/** A password that meets IRIS's default pattern; generated per run and never shown or kept. */
export function randomPassword(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return `Aa9!${[...bytes].map((b) => chars[b % chars.length]).join('')}`;
}

export interface GroupDef {
  id: string;
  title: string;
  /** Plain-language list of what the group creates and deletes, for the confirmation. */
  creates: string[];
  run(api: SelfTestApi, step: StepFn): Promise<void>;
}
/** Run one step: time it, record pass or fail. Throws on failure so the group stops. */
export type StepFn = <T>(label: string, fn: () => Promise<T>, detail?: (v: T) => string) => Promise<T>;

const same = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const diff = (before: string[], after: string[]): string => {
  const added = after.filter((x) => !before.includes(x));
  const gone = before.filter((x) => !after.includes(x));
  return [added.length ? `new: ${added.join(', ')}` : '', gone.length ? `missing: ${gone.join(', ')}` : ''].filter(Boolean).join('; ');
};
function expect(cond: boolean, msg: string): void { if (!cond) throw new Error(msg); }

/**
 * The standard group: snapshot, check the name is free, create, read,
 * update, read back, delete, check it's gone, compare the list.
 */
function crudGroup<C, U>(o: {
  id: string; title: string; creates: string[];
  kind: (api: SelfTestApi) => Crud<C, U>;
  name: string;
  body: (api: SelfTestApi) => Promise<C> | C;
  check: (row: Record<string, unknown>) => string | null;
  update: U;
  checkUpdate: (row: Record<string, unknown>) => string | null;
  before?: (api: SelfTestApi) => Promise<void>;
}): GroupDef {
  return {
    id: o.id, title: o.title, creates: o.creates,
    async run(api, step) {
      const kind = o.kind(api);
      const before = await step('Snapshot the list', () => kind.list(), (l) => `${l.length} item${l.length === 1 ? '' : 's'}`);
      if (o.before) await step('Check it is safe to go ahead', () => o.before!(api));
      await step(`Check ${o.name} is free`, async () => expect(!(await kind.exists(o.name)), `${o.name} already exists; it was left alone`));
      let key: string | null = null;
      let failed: unknown = null;
      try {
        const body = await o.body(api);
        key = await step(`Create ${o.name}`, () => kind.create(o.name, body), (k) => (k !== o.name ? `key ${k}` : ''));
        await step('Read it back', async () => { const r = await kind.read(key!); const bad = o.check(r); expect(!bad, bad ?? ''); });
        await step('Update it', () => kind.update(key!, o.update));
        await step('Read the change back', async () => { const r = await kind.read(key!); const bad = o.checkUpdate(r); expect(!bad, bad ?? ''); });
        await step('Delete it', () => kind.remove(key!));
        const k = key;
        key = null;
        await step('Check it is gone', async () => expect(!(await kind.exists(k)), 'It still exists after delete'));
      } catch (err) {
        failed = err;
        if (key) await step('Clean up after the failure', () => kind.remove(key!)).catch(() => undefined);
      }
      // Always compared, so a failed create that left something behind shows up.
      await step('List matches the snapshot', async () => { const after = await kind.list(); expect(same(before, after), `The list changed (${diff(before, after)})`); });
      if (failed) throw failed;
    },
  };
}

const TAG = 'OSCA Admin self-test: safe to delete';
const field = (row: Record<string, unknown>, k: string): unknown => row[k];
const wantEq = (row: Record<string, unknown>, k: string, v: unknown): string | null =>
  field(row, k) === v ? null : `${k} is ${JSON.stringify(field(row, k))}, expected ${JSON.stringify(v)}`;

export const GROUPS: GroupDef[] = [
  crudGroup({
    id: 'resource', title: 'Resource', creates: [`resource ${PREFIX}res (public read, protects nothing)`],
    kind: (a) => a.resource, name: `${PREFIX}res`,
    body: () => ({ Description: TAG, PublicPermission: 'R' }),
    check: (r) => wantEq(r, 'Description', TAG),
    update: { Description: `${TAG} (updated)` },
    checkUpdate: (r) => wantEq(r, 'Description', `${TAG} (updated)`),
  }),
  crudGroup({
    id: 'role', title: 'Role', creates: [`role ${PREFIX}role (read access to the USER database)`],
    kind: (a) => a.role, name: `${PREFIX}role`,
    body: () => ({ Description: TAG, Resources: [{ Name: '%DB_USER', Permissions: 'R' }] }),
    check: (r) => wantEq(r, 'Description', TAG),
    update: { Description: `${TAG} (updated)`, Resources: [{ Name: '%DB_USER', Permissions: 'R' }] },
    checkUpdate: (r) => wantEq(r, 'Description', `${TAG} (updated)`),
  }),
  crudGroup({
    id: 'user', title: 'User', creates: [`user ${PREFIX}user (disabled, random password never shown)`],
    kind: (a) => a.user, name: `${PREFIX}user`,
    body: () => ({ password: randomPassword(), FullName: TAG, Enabled: false, Roles: [] }),
    check: (r) => wantEq(r, 'Enabled', false) ?? wantEq(r, 'FullName', TAG),
    update: { FullName: `${TAG} (updated)` },
    checkUpdate: (r) => wantEq(r, 'FullName', `${TAG} (updated)`) ?? wantEq(r, 'Enabled', false),
  }),
  crudGroup({
    id: 'webapp', title: 'Web application', creates: [`web application /csp/${PREFIX}app (disabled)`],
    kind: (a) => a.webApp, name: `/csp/${PREFIX}app`,
    body: () => ({ Description: TAG, NameSpace: 'USER' }),
    check: (r) => wantEq(r, 'Enabled', false) ?? wantEq(r, 'Description', TAG),
    update: { Description: `${TAG} (updated)` },
    checkUpdate: (r) => wantEq(r, 'Description', `${TAG} (updated)`) ?? wantEq(r, 'Enabled', false),
  }),
  crudGroup({
    id: 'task', title: 'Task', creates: [`task ${PREFIX}task (Check Logging Activity, on demand only, suspended)`],
    kind: (a) => a.task, name: `${PREFIX}task`,
    body: () => ({ Name: `${PREFIX}task`, Description: TAG, TaskClass: '%SYS.Task.CheckLogging', NameSpace: '%SYS' }),
    check: (r) => wantEq(r, 'Description', TAG) ?? wantEq(r, 'TimePeriod', 'On Demand') ?? wantEq(r, 'Suspended', true),
    update: { DailyStartTime: '04:00:00' },
    checkUpdate: (r) => wantEq(r, 'DailyStartTime', '04:00:00') ?? wantEq(r, 'Suspended', true),
  }),
  crudGroup({
    id: 'superserver', title: 'Superserver', creates: [`superserver on port ${SUPERSERVER_PORT} (disabled)`],
    kind: (a) => a.superserver, name: `${SUPERSERVER_PORT}@0.0.0.0`,
    before: async (a) => { const used = await a.reservedPorts(); expect(!used.includes(SUPERSERVER_PORT), `Port ${SUPERSERVER_PORT} is in use by this instance`); },
    body: () => ({ Description: TAG }),
    check: (r) => wantEq(r, 'Enabled', false) ?? wantEq(r, 'Description', TAG),
    update: { Description: `${TAG} (updated)` },
    checkUpdate: (r) => wantEq(r, 'Description', `${TAG} (updated)`) ?? wantEq(r, 'Enabled', false),
  }),
  crudGroup({
    id: 'tls', title: 'TLS configuration', creates: [`TLS configuration ${PREFIX}tls (client, disabled, no files)`],
    kind: (a) => a.tls, name: `${PREFIX}tls`,
    body: () => ({ Description: TAG }),
    check: (r) => wantEq(r, 'Enabled', false) ?? wantEq(r, 'Description', TAG),
    update: { Description: `${TAG} (updated)` },
    checkUpdate: (r) => wantEq(r, 'Description', `${TAG} (updated)`),
  }),
  crudGroup({
    id: 'wallet', title: 'Wallet collection', creates: [`secrets wallet collection ${PREFIX}wc (empty)`],
    kind: (a) => a.wallet, name: `${PREFIX}wc`,
    body: () => ({ UseResource: '%Admin_Wallet:USE', EditResource: '%Admin_Wallet:USE' }),
    check: () => null,
    update: { UseResource: '%Admin_Secure:USE' },
    checkUpdate: (r) => (String(field(r, 'UseResource') ?? '').startsWith('%Admin_Secure') ? null : `UseResource is ${JSON.stringify(field(r, 'UseResource'))}`),
  }),
  crudGroup({
    id: 'wqm', title: 'Work queue category', creates: [`work queue category ${PREFIX}wqm`],
    kind: (a) => a.wqm, name: `${PREFIX}wqm`,
    body: () => ({ MaxTotalWorkers: 1 }),
    check: (r) => wantEq(r, 'MaxTotalWorkers', 1),
    update: { MaxTotalWorkers: 2 },
    checkUpdate: (r) => wantEq(r, 'MaxTotalWorkers', 2),
  }),
  {
    id: 'database', title: 'Database and namespace',
    creates: [`database ${PREFIX.toUpperCase()}DB (1 MB, in the manager folder)`, `namespace ${PREFIX.toUpperCase()}NS on it (no interoperability)`],
    async run(api, step) {
      const db = `${PREFIX.toUpperCase()}DB`;
      const ns = `${PREFIX.toUpperCase()}NS`;
      const dbs = await step('Snapshot databases', () => api.database.list(), (l) => `${l.length} databases`);
      const spaces = await step('Snapshot namespaces', () => api.namespace.list(), (l) => `${l.length} namespaces`);
      await step(`Check ${db} and ${ns} are free`, async () => {
        expect(!(await api.database.exists(db)), `${db} already exists; it was left alone`);
        expect(!(await api.namespace.exists(ns)), `${ns} already exists; it was left alone`);
      });
      const dir = `${await api.mgrDir()}${PREFIX}db${(await api.mgrDir()).includes('\\') ? '\\' : '/'}`;
      let madeDb = false;
      let madeNs = false;
      let failed: unknown = null;
      try {
        await step(`Create ${db}`, () => api.database.create(db, { directory: dir }), () => dir);
        madeDb = true;
        await step(`Create ${ns} on it`, () => api.namespace.create(ns, { Globals: db, Routines: db }));
        madeNs = true;
        await step('Read them back', async () => {
          const r = await api.namespace.read(ns);
          expect(r.Globals === db, `The namespace's data database is ${JSON.stringify(r.Globals)}`);
          await api.database.read(db);
        });
        await step('Set a 50 MB size limit', () => api.database.update(db, { MaxSize: 50 }));
        await step('Read the change back', async () => { const r = await api.database.read(db); expect(Number(r.MaxSize) === 50, `MaxSize is ${JSON.stringify(r.MaxSize)}`); });
        await step(`Delete ${ns}`, () => api.namespace.remove(ns));
        madeNs = false;
        await step(`Delete ${db} and its file`, () => api.database.remove(db));
        madeDb = false;
        await step('Check both are gone', async () => {
          expect(!(await api.namespace.exists(ns)), `${ns} still exists`);
          expect(!(await api.database.exists(db)), `${db} still exists`);
        });
      } catch (err) {
        failed = err;
        if (madeNs) await step(`Clean up ${ns}`, () => api.namespace.remove(ns)).catch(() => undefined);
        if (madeDb) await step(`Clean up ${db}`, () => api.database.remove(db)).catch(() => undefined);
      }
      await step('Lists match the snapshots', async () => {
        const d2 = await api.database.list();
        const n2 = await api.namespace.list();
        expect(same(dbs, d2), `Databases changed (${diff(dbs, d2)})`);
        expect(same(spaces, n2), `Namespaces changed (${diff(spaces, n2)})`);
      });
      if (failed) throw failed;
    },
  },
];

/** Everything a run creates and deletes, for the confirmation. */
export const planText = (groups: GroupDef[] = GROUPS): string[] => groups.flatMap((g) => g.creates);

/**
 * Run the groups in order. Each group's steps go to `onStep` as they finish.
 * Web applications (and their on/off state) are compared before and after the
 * whole run, since some saves elsewhere in IRIS switch apps on as a side effect.
 */
export async function runGroups(api: SelfTestApi, groups: GroupDef[], onStep: (r: StepResult) => void): Promise<Report> {
  const report: Report = [];
  const now = (): number => (globalThis.performance ? globalThis.performance.now() : Date.now());
  const record = (group: string, stepLabel: string, ok: boolean, ms: number, detail: string): void => {
    const r = { group, step: stepLabel, ok, ms: Math.round(ms), detail };
    report.push(r);
    onStep(r);
  };
  const stepFor = (group: string): StepFn => async (label, fn, detail) => {
    const t0 = now();
    try {
      const v = await fn();
      record(group, label, true, now() - t0, detail ? detail(v) : '');
      return v;
    } catch (err) {
      record(group, label, false, now() - t0, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
  const top = stepFor('Before and after');
  const apps = await top('Snapshot web applications', () => api.webAppStates(), (l) => `${l.length} applications`).catch(() => null);
  for (const g of groups) {
    try { await g.run(api, stepFor(g.title)); } catch { /* recorded; next group */ }
  }
  if (apps) {
    await top('Web applications unchanged', async () => {
      const after = await api.webAppStates();
      expect(same(apps, after), `Web applications changed (${diff(apps, after)})`);
    }).catch(() => undefined);
  }
  return report;
}

/** The report as plain text, for copying. */
export function reportText(report: Report, title = 'OSCA Admin self-test'): string {
  const passed = report.filter((r) => r.ok).length;
  const lines = [`${title}: ${passed} of ${report.length} steps passed`, ''];
  let group = '';
  for (const r of report) {
    if (r.group !== group) { group = r.group; lines.push(group); }
    lines.push(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.step}  (${r.ms} ms)${r.detail ? `  ${r.detail}` : ''}`);
  }
  return lines.join('\n');
}
