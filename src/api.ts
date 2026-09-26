/**
 * Thin client for IRIS's SysAdmin REST API (%Api.Admin, /api/admin/v2/...).
 * Requests go same-origin (the Vite proxy in dev, IRIS itself in production)
 * and carry the signed-in user's JWT via authFetch (src/auth.ts).
 */
import { authFetch } from './auth';

const BASE = '/api/admin/v2';

interface Envelope<T> {
  status: { errors: Array<{ error: string }>; summary: string };
  result: T;
}

async function get<T>(path: string): Promise<T> {
  const res = await authFetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Admin API ${path} → HTTP ${res.status} ${res.statusText}`);
  const json = (await res.json()) as Envelope<T>;
  if (json.status?.errors?.length) throw new Error(json.status.errors[0]?.error || json.status.summary || 'Admin API error');
  return json.result;
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

export interface User {
  Name: string;
  FullName: string;
  Type: string;
  Enabled: boolean;
}

export interface WebApp {
  Name: string;
  DispatchClass: string;
  Namespace: string;
  Enabled: boolean;
}

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
export const getUsers = (): Promise<User[]> => get('/security/users');
export const getWebApps = (): Promise<WebApp[]> => get('/web-apps');
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
