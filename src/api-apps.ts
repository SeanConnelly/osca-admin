// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Types and fetchers for web applications and the Task Manager
 * (/api/admin/v2/web-apps, /web-app, /tasks, /task, /task/info,
 * /task/upcoming, /task/manager, /task/history). Shapes follow live
 * IRIS 2026.2 responses. Read-only: nothing here changes the instance.
 */
import { get } from './api';
import { writeJson } from './crud';

/** GET /v2/web-apps — one row per application. */
export interface WebAppSummary {
  Name: string;
  Namespace: string;
  NamespaceDefault: boolean;
  Enabled: boolean;
  /** "CSP", or "System,CSP" for applications IRIS ships and manages. */
  Type: string;
  Resource: string;
  /** Decoded AutheEnabled, e.g. ["Password", "Unauthenticated"]. */
  AuthenticationMethods: string[];
  IsSystemApp: boolean;
  DispatchClass: string;
}

export interface MatchRole { MatchRole: string; TargetRoles: string[] }

/** GET /v2/web-app?name=… — the full definition. */
export interface WebAppDetail {
  AutheEnabled: number;
  AutoCompile: boolean;
  ChangePasswordPage: string;
  CookiePath: string;
  CorsAllowlist: string[];
  CorsCredentialsAllowed: boolean;
  CorsHeadersList: string[];
  CSPZENEnabled: boolean;
  CSRFToken: boolean;
  DeepSeeEnabled: boolean;
  Description: string;
  DispatchClass: string;
  Enabled: boolean;
  ErrorPage: string;
  EventClass: string;
  GroupById: string;
  iKnowEnabled: boolean;
  InbndWebServicesEnabled: boolean;
  IsNameSpaceDefault: boolean;
  JWTAuthEnabled: boolean;
  JWTAccessTokenTimeout: number;
  JWTRefreshTokenTimeout: number;
  LockCSPName: boolean;
  LoginPage: string;
  NameSpace: string;
  Package: string;
  Path: string;
  PermittedClasses: string;
  Recurse: boolean;
  RedirectEmptyPath: boolean;
  Resource: string;
  ServeFiles: string;
  ServeFilesTimeout: number;
  SuperClass: string;
  Timeout: number;
  TraceEnabled: boolean;
  TwoFactorEnabled: boolean;
  UseCookies: string;
  SessionScope: string;
  UserCookieScope: string;
  WSGIAppLocation: string;
  WSGIAppName: string;
  WSGICallable: string;
  WSGIDebug: boolean;
  WSGIType: string;
  MatchRoles: MatchRole[];
}

export const getWebAppList = (): Promise<WebAppSummary[]> => get('/web-apps');
export const getWebApp = (name: string): Promise<WebAppDetail> => get(`/web-app?name=${encodeURIComponent(name)}`);

/** GET /v2/tasks. NextScheduled may be a date, "" or "Runs After #<id>:…". */
export interface TaskSummary {
  Id: number;
  Name: string;
  Type: string;
  Namespace: string;
  Description: string;
  Suspended: boolean;
  LastFinished: string;
  NextScheduled: string;
}

/** GET /v2/task/upcoming — the scheduled runs in the next day or so. */
export interface TaskRun { Id: number; Name: string; Namespace: string; Suspended: boolean; Datetime: string }

/** GET /v2/task?id=… — the full task definition. */
export interface TaskDetail {
  Name: string;
  Description: string;
  TaskClass: string;
  NameSpace: string;
  RunAsUser: string;
  Priority: string;
  /** "Daily" | "Weekly" | "Monthly" | "Monthly Special" | "Run After" | "On Demand". */
  TimePeriod: string;
  TimePeriodEvery: number;
  /** Weekly: day digits (1 = Sunday … 7 = Saturday); Monthly: day of month; Monthly Special: "week^day". */
  TimePeriodDay: string | number;
  /** "Once" or "Several". */
  DailyFrequency: string;
  /** With Several: "Minutes" or "Hourly". */
  DailyFrequencyTime: string;
  DailyIncrement: string | number;
  DailyStartTime: string;
  DailyEndTime: string;
  StartDate: string;
  EndDate: string;
  RunAfterGUID: string;
  MirrorStatus: string;
  EmailOnCompletion: string[];
  EmailOnError: string[];
  EmailOnExpiration: string[];
  EmailOutput: boolean;
  Expires: boolean;
  ExpiresDays: string | number;
  ExpiresHours: string | number;
  ExpiresMinutes: string | number;
  OutputDirectory: string;
  OutputFilename: string;
  OpenOutputFile: boolean;
  OutputFileIsBinary: boolean;
  SuspendOnError: boolean;
  SuspendTerminated: boolean;
  IsBatch: boolean;
  RescheduleOnStart: boolean;
  /** Task-class specific settings (can include secrets such as SMTP passwords). */
  Settings: Record<string, unknown>;
}

/** GET /v2/task/info?id=… — run state. */
export interface TaskInfo {
  Type: string;
  Status: string;
  /** Result of the last run ("Success", or the error text). */
  Error: string;
  LastSchedule: string;
  LastStarted: string;
  LastFinished: string;
  NextScheduled: string;
  Suspended: boolean;
}

/** GET /v2/task/history. Routine "TASKMGR" rows are the Task Manager's own log entries. */
export interface TaskHistoryEntry {
  TaskId: number;
  Name: string;
  Namespace: string;
  Routine: string;
  Pid: string;
  Username: string;
  LastStart: string;
  Completed: string;
  LogDatetime: string;
  /** "1" on success; otherwise an error status. */
  Status: string;
  Result: string;
  ErrDate: string;
  ErrNumber: number;
}

export const getTasks = (): Promise<TaskSummary[]> => get('/tasks');
export const getTaskRuns = (): Promise<TaskRun[]> => get('/task/upcoming');
export const getTask = (id: number): Promise<TaskDetail> => get(`/task?id=${id}`);
export const getTaskInfo = (id: number): Promise<TaskInfo> => get(`/task/info?id=${id}`);
export const getTaskManager = (): Promise<{ Status: string }> => get('/task/manager');
export const getTaskHistory = (): Promise<TaskHistoryEntry[]> => get('/task/history');

// ── Writes (Tasks and Web applications screens) ──────────────────────────
// Request shapes follow %Api.Admin.Endpoints.Task.CRUD and
// %Api.Admin.Endpoints.WebApp.App, and were exercised on osca_test_ objects.

/** Queue the task to run now; the Task Manager starts it at its next check (within about a minute). */
export const runTask = (id: number): Promise<unknown> => writeJson('POST', `/task/run?id=${id}`, { RunNow: true });
/** Suspend: the task stays scheduled but does not run until resumed. */
export const suspendTask = (id: number): Promise<unknown> => writeJson('POST', `/task/suspend?id=${id}`, {});
export const resumeTask = (id: number): Promise<unknown> => writeJson('POST', `/task/resume?id=${id}`);
export const deleteTask = (id: number): Promise<unknown> => writeJson('DELETE', `/task?id=${id}`);

/** PUT on an existing app changes only the fields sent. */
export const setWebAppEnabled = (name: string, enabled: boolean): Promise<unknown> =>
  writeJson('PUT', `/web-app?name=${encodeURIComponent(name)}`, { Enabled: enabled });
export const deleteWebApp = (name: string): Promise<unknown> => writeJson('DELETE', `/web-app?name=${encodeURIComponent(name)}`);
