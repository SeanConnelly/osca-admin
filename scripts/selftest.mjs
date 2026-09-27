#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OSCA Admin self-test from the command line: the same create / read /
 * update / delete groups as Settings > Self-test (src/showcase/selftest-steps.ts),
 * sent straight to the SysAdmin API.
 *
 *   npm run selftest -- http://localhost:52774
 *   npm run selftest -- http://localhost:52774 --groups=role,user
 *   npm run selftest -- http://localhost:52774 --yes        (skip the question)
 *
 * Credentials, if the instance needs them: OSCA_USER and OSCA_PASSWORD
 * (sent as Basic authentication). Every object is an osca_test_st_ one; each
 * group checks its name is free first, and deletes what it made.
 * Needs Node 22.18 or later (it loads the TypeScript step file directly).
 */
import { createInterface } from 'node:readline/promises';
import { GROUPS, planText, runGroups, reportText } from '../src/showcase/selftest-steps.ts';

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//i.test(a)) ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Usage: npm run selftest -- http://host:port [--groups=role,user] [--yes]');
  process.exit(2);
}
const only = (args.find((a) => a.startsWith('--groups='))?.slice(9) ?? '').split(',').filter(Boolean);
const groups = only.length ? GROUPS.filter((g) => only.includes(g.id)) : GROUPS;
const headers = { Accept: 'application/json' };
if (process.env.OSCA_USER) headers.Authorization = `Basic ${Buffer.from(`${process.env.OSCA_USER}:${process.env.OSCA_PASSWORD ?? ''}`).toString('base64')}`;

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const q = encodeURIComponent;

/** One Admin API call; resolves to { result, res }, throws HttpError with IRIS's message. */
async function call(method, path, body) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await fetch(`${base}/api/admin/v2${path}`, init);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const first = json?.status?.errors?.[0];
  if (!res.ok || first) {
    const msg = String(first?.error ?? `HTTP ${res.status}`).replace(/^(\s*[^\s#]{0,16}\s*#\s*-?\d+\s*:\s*)+/u, '').trim();
    throw new HttpError(msg, res.ok ? 500 : res.status);
  }
  return { result: json?.result, res };
}
const get = async (path) => (await call('GET', path)).result;
const missing = (e) => e instanceof HttpError && (e.status === 404 || /does not exist|not found/i.test(e.message));
const existsBy = async (path) => { try { await get(path); return true; } catch (e) { if (missing(e)) return false; throw e; } };
const names = async (path) => ((await get(path)) ?? []).map((r) => String(r.Name));

/** The SelfTestApi, as plain HTTP: the same calls the portal's api functions make. */
const api = {
  resource: {
    list: () => names('/security/resources'),
    exists: (n) => existsBy(`/security/resource?name=${q(n)}`),
    read: (n) => get(`/security/resource?name=${q(n)}`),
    create: async (n, b) => { await call('PUT', `/security/resource?name=${q(n)}`, b); return n; },
    update: (n, b) => call('PUT', `/security/resource?name=${q(n)}`, b),
    remove: (n) => call('DELETE', `/security/resource?name=${q(n)}`),
  },
  role: {
    list: () => names('/security/roles'),
    exists: (n) => existsBy(`/security/role?name=${q(n)}`),
    read: (n) => get(`/security/role?name=${q(n)}`),
    create: async (n, b) => { await call('PUT', `/security/role?name=${q(n)}`, b); return n; },
    update: (n, b) => call('PUT', `/security/role?name=${q(n)}`, b),
    remove: (n) => call('DELETE', `/security/role?name=${q(n)}`),
  },
  user: {
    list: () => names('/security/users'),
    exists: (n) => existsBy(`/security/user?name=${q(n)}`),
    read: (n) => get(`/security/user?name=${q(n)}`),
    create: async (n, b) => { const { password, ...user } = b; await call('POST', `/security/user?name=${q(n)}`, { Password: password, User: user }); return n; },
    update: (n, b) => call('PUT', `/security/user?name=${q(n)}`, b),
    remove: (n) => call('DELETE', `/security/user?name=${q(n)}`),
  },
  webApp: (() => {
    const bodies = new Map();
    const full = (n, b) => ({
      NameSpace: b.NameSpace, Description: b.Description, Enabled: false, DispatchClass: '', Path: '',
      AutheEnabled: 32, JWTAuthEnabled: false, Resource: '', MatchRoles: [], Timeout: 900, CookiePath: `${n}/`, IsNameSpaceDefault: false,
    });
    const free = async (n) => !(await existsBy(`/web-app?name=${q(n)}`)) && !(await existsBy(`/security/privileged-routine?name=${q(n)}`));
    return {
      list: () => names('/web-apps'),
      exists: async (n) => !(await free(n)),
      read: (n) => get(`/web-app?name=${q(n)}`),
      create: async (n, b) => {
        if (!(await free(n))) throw new HttpError(`${n} is already taken`, 409);
        const body = full(n, b);
        bodies.set(n, body);
        await call('PUT', `/web-app?name=${q(n)}`, body);
        return n;
      },
      update: async (n, b) => {
        if (!(await existsBy(`/web-app?name=${q(n)}`))) throw new HttpError(`${n} no longer exists`, 404);
        await call('PUT', `/web-app?name=${q(n)}`, { ...bodies.get(n), ...b });
      },
      remove: (n) => call('DELETE', `/web-app?name=${q(n)}`),
    };
  })(),
  task: {
    list: () => names('/tasks'),
    exists: async (k) => ((await get('/tasks')) ?? []).some((t) => (/^\d+$/.test(k) ? String(t.Id) === k : t.Name === k)),
    read: async (k) => {
      // The list's Suspended flag lags; the task's own info has it.
      const [detail, info] = await Promise.all([get(`/task?id=${q(k)}`), get(`/task/info?id=${q(k)}`)]);
      return { ...detail, Suspended: info?.Suspended };
    },
    create: async (_n, b) => {
      const body = {
        ...b, RunAsUser: '', Priority: 'Normal', TimePeriod: 'On Demand', TimePeriodEvery: 1, TimePeriodDay: '',
        DailyFrequency: 'Once', DailyFrequencyTime: '', DailyIncrement: '', DailyStartTime: '03:00:00', DailyEndTime: '',
        StartDate: '', EndDate: '', RunAfterGUID: '', MirrorStatus: 'Any', EmailOnCompletion: [], EmailOnError: [], EmailOnExpiration: [],
        EmailOutput: false, Expires: false, ExpiresDays: '', ExpiresHours: '', ExpiresMinutes: '', OpenOutputFile: false, OutputDirectory: '',
        OutputFilename: '', OutputFileIsBinary: false, SuspendOnError: false, SuspendTerminated: false, IsBatch: false, RescheduleOnStart: false,
      };
      const { res } = await call('POST', '/task', body);
      let id = Number(/[?&]id=(\d+)/.exec(res.headers.get('location') ?? '')?.[1]);
      if (!(id > 0)) id = ((await get('/tasks')) ?? []).filter((t) => t.Name === b.Name).sort((x, y) => y.Id - x.Id)[0]?.Id;
      if (!(id > 0)) throw new HttpError('The task was saved but its ID is unknown', 500);
      try { await call('POST', `/task/suspend?id=${id}`, {}); } catch (e) { await call('DELETE', `/task?id=${id}`).catch(() => undefined); throw e; }
      return String(id);
    },
    update: (k, b) => call('PUT', `/task?id=${q(k)}`, { TimePeriod: 'On Demand', TimePeriodEvery: 1, TimePeriodDay: '', DailyFrequency: 'Once', DailyFrequencyTime: '', DailyIncrement: '', DailyEndTime: '', StartDate: '', EndDate: '', ...b }),
    remove: (k) => call('DELETE', `/task?id=${q(k)}`),
  },
  superserver: (() => {
    const port = (k) => Number(String(k).split('@')[0]);
    return {
      list: async () => ((await get('/security/superservers')) ?? []).map((s) => `${s.Port}@${!s.BindAddress || s.BindAddress === '0.0.0.0' ? '0.0.0.0' : s.BindAddress}`),
      exists: async (k) => ((await get('/security/superservers')) ?? []).some((s) => s.Port === port(k)),
      read: (k) => get(`/security/superserver?port=${port(k)}`),
      create: async (k, b) => { await call('PUT', `/security/superserver?port=${port(k)}`, { Enabled: false, ...b }); return k; },
      update: (k, b) => call('PUT', `/security/superserver?port=${port(k)}`, b),
      remove: (k) => call('DELETE', `/security/superserver?port=${port(k)}`),
    };
  })(),
  tls: {
    list: () => names('/security/ssl-configurations'),
    exists: (n) => existsBy(`/security/ssl-configuration?name=${q(n)}`),
    read: (n) => get(`/security/ssl-configuration?name=${q(n)}`),
    create: async (n, b) => { await call('PUT', `/security/ssl-configuration?name=${q(n)}`, { Type: 0, VerifyPeer: 0, Enabled: false, ...b }); return n; },
    update: (n, b) => call('PUT', `/security/ssl-configuration?name=${q(n)}`, b),
    remove: (n) => call('DELETE', `/security/ssl-configuration?name=${q(n)}`),
  },
  wallet: {
    list: () => names('/wallet/collections'),
    exists: async (n) => (await names('/wallet/collections')).includes(n),
    read: async (n) => ((await get('/wallet/collections')) ?? []).find((c) => c.Name === n) ?? {},
    create: async (n, b) => { await call('PUT', `/wallet/collection?name=${q(n)}`, b); return n; },
    update: (n, b) => call('PUT', `/wallet/collection?name=${q(n)}`, b),
    remove: (n) => call('DELETE', `/wallet/collection?name=${q(n)}`),
  },
  wqm: {
    list: () => names('/wqm-categories'),
    exists: async (n) => (await names('/wqm-categories')).includes(n),
    read: (n) => get(`/wqm-category?name=${q(n)}`),
    create: async (n, b) => { await call('PUT', `/wqm-category?name=${q(n)}`, { DefaultWorkers: 0, MaxWorkers: 0, MaxActiveWorkers: 0, AlwaysQueue: false, ...b }); return n; },
    update: (n, b) => call('PUT', `/wqm-category?name=${q(n)}`, b),
    remove: (n) => call('DELETE', `/wqm-category?name=${q(n)}`),
  },
  database: (() => {
    const dirOf = async (n) => ((await get('/databases')) ?? []).find((d) => d.Name === n)?.Directory;
    return {
      list: () => names('/databases'),
      exists: async (n) => (await names('/databases')).includes(n),
      read: async (n) => { const dir = await dirOf(n); if (!dir) throw new HttpError(`${n} does not exist`, 404); return get(`/database-dir?dir=${q(dir)}`); },
      create: async (n, b) => {
        await call('POST', '/database-dir', { Directory: b.directory, Size: 1, GlobalJournalState: true, ResourceName: '%DB_%DEFAULT' });
        try { await call('PUT', `/database?name=${q(n)}`, { Directory: b.directory }); } catch (e) {
          await call('DELETE', `/database-dir?dir=${q(b.directory)}`).catch(() => undefined);
          throw e;
        }
        return n;
      },
      update: async (n, b) => { const dir = await dirOf(n); return call('PUT', `/database-dir?dir=${q(dir)}`, b); },
      remove: async (n) => {
        const dir = await dirOf(n);
        await call('DELETE', `/database?name=${q(n)}`);
        if (dir) await call('DELETE', `/database-dir?dir=${q(dir)}`);
      },
    };
  })(),
  namespace: {
    list: () => names('/namespaces'),
    exists: async (n) => {
      try { await get(`/namespace?name=${q(n)}`); return true; } catch (e) { if (missing(e) || /#?420/.test(e.message)) return false; throw e; }
    },
    read: async (n) => ((await get('/namespaces')) ?? []).find((x) => x.Name === n) ?? {},
    create: async (n, b) => { await call('PUT', `/namespace?name=${q(n)}`, b); return n; },
    update: async () => { throw new HttpError('Namespaces are not changed by the self-test', 400); },
    remove: (n) => call('DELETE', `/namespace?name=${q(n)}`),
  },
  mgrDir: async () => {
    const d = ((await get('/databases')) ?? []).find((x) => x.Name === 'IRISSYS')?.Directory;
    if (!d) throw new HttpError('Can’t find the manager directory', 500);
    return /[\\/]$/.test(d) ? d : `${d}${d.includes('\\') ? '\\' : '/'}`;
  },
  webAppStates: async () => ((await get('/web-apps')) ?? []).map((a) => `${a.Name} ${a.Enabled ? 'on' : 'off'}`),
  reservedPorts: async () => [...((await get('/security/superservers')) ?? []).map((s) => s.Port), Number(new URL(base).port || 80)],
};

console.log(`OSCA Admin self-test against ${base}\n\nIt will create, check and then delete:`);
for (const line of planText(groups)) console.log(`  - ${line}`);
if (!args.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('\nType "yes" to go ahead: ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') { console.log('Nothing was done.'); process.exit(0); }
}
console.log('');
const report = await runGroups(api, groups, (r) => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.group} > ${r.step} (${r.ms} ms)${r.detail ? `  ${r.detail}` : ''}`));
console.log(`\n${reportText(report)}`);
process.exit(report.every((r) => r.ok) ? 0 : 1);
