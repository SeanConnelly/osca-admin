// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin client for IRIS's SysAdmin REST API (%Api.Admin, /api/admin/v2/...).
 * Requests go same-origin (the Vite proxy in dev, IRIS itself in production)
 * and carry the signed-in user's JWT via authFetch (src/auth.ts).
 */
import { authFetch } from './auth';
import { readEnvelope, sendAdmin } from './crud';

const BASE = '/api/admin/v2';

interface Envelope<T> {
  status: { errors: Array<{ error: string }>; summary: string };
  result: T;
}

/**
 * Errors: the envelope is read even when the status isn't 2xx (IRIS puts the
 * real reason there, often under a plain HTTP 500), and failures throw an
 * AdminError (src/crud.ts) carrying a clean, user-facing message and the status.
 */
export async function get<T>(path: string): Promise<T> {
  const res = await sendAdmin(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  return readEnvelope<T>(res);
}

/** POST for read-only searches that take a JSON body (e.g. /security/audit/records). */
export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await sendAdmin(`${BASE}${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readEnvelope<T>(res);
}

export interface AdminInfo {
  apiVersion: number;
  username: string;
  serverVersion: string;
  namespaces: Array<{ name: string }>;
}

export interface Process {
  Job: number;
  Pid: number;
  Username: string;
  Device: string;
  Nspace: string;
  Routine: string;
  Commands: number;
  Globals: number;
  State: string;
  ClientName: string;
  EXEname: string;
  IPAddress: string;
  CanBeExamined: boolean;
  CanBeSuspended: boolean;
  CanBeTerminated: boolean;
  CanReceiveBroadcast: boolean;
  PrvGblBlkCnt: number;
  OSUserName: string;
  CPUTime: number;
  ParentPid: number;
  ElapsedTime: string;
}

/** GET /v2/monitor/dashboard/main — the legacy System Dashboard, as data. */
export interface Dashboard {
  Status: { UpTime: string; LastBackup: string; SystemMonitor: boolean };
  Alerts: { SeriousAlerts: number; ApplicationErrors: number };
  Licensing: { LicenseLimit: number; LicenseUse: number; LicenseUseHigh: number };
  SystemUsage: { Processes: number; CSPSessions: number; DatabaseSpace: string; JournalSpace: string; LockTable: string; WriteDaemon: string };
}
export const getDashboard = (): Promise<Dashboard> => get('/monitor/dashboard/main');

export interface UpcomingTask {
  Id: number;
  Name: string;
  Namespace: string;
  Datetime: string;
}

export interface Namespace {
  Name: string;
}

export function getInfo(): Promise<AdminInfo> {
  return authFetch('/api/admin/info', { headers: { Accept: 'application/json' } })
    .then((res) => res.json() as Promise<Envelope<AdminInfo>>)
    .then((json) => json.result);
}
export const getProcesses = (): Promise<Process[]> => get('/processes');
export const getUpcomingTasks = (): Promise<UpcomingTask[]> => get('/task/upcoming');
export const getNamespaces = (): Promise<Namespace[]> => get('/namespaces');

/** %Api.Monitor alert feed — a bare JSON array, not the Admin API envelope. */
export interface Alert {
  time: string;
  severity: string;
  message: string;
}
export async function getAlerts(): Promise<Alert[]> {
  const res = await authFetch('/api/monitor/alerts', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Monitor API /alerts → HTTP ${res.status} ${res.statusText}`);
  return (await res.json()) as Alert[];
}
