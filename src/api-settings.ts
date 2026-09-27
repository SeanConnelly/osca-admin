// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Types and calls for Tasks › Schedule, Settings › License and Settings ›
 * Work queue categories. Shapes follow live IRIS 2026.2 responses; write
 * bodies follow %Api.Admin.Endpoints.Task.CRUD / Task.Manager / License.Key /
 * License.Server / WQMCategory.
 *
 * Exercised live (on osca_test_ objects, cleaned up): task schedule changes,
 * work queue category create / change / delete, license key validation
 * (junk key only; it writes nothing). Built from source and never run here:
 * Task Manager suspend / resume / start, license key activation, license
 * server create / change / delete.
 */
import { get } from './api';
import { writeJson } from './crud';

// ── Task Manager ──────────────────────────────────────────────────────

/** "Running" | "Suspended" | "Not running". */
export type ManagerStatus = 'Running' | 'Suspended' | 'Not running' | string;
export const getManager = (): Promise<{ Status: ManagerStatus }> => get('/task/manager');
/** Stops the Task Manager starting any task until resumed; a run in progress carries on. */
export const suspendManager = (): Promise<unknown> => writeJson('POST', '/task/manager/suspend');
export const resumeManager = (): Promise<unknown> => writeJson('POST', '/task/manager/resume');
/** Starts the Task Manager process when it isn't running (409 if it already is). */
export const startManager = (): Promise<unknown> => writeJson('POST', '/task/manager/run');

/** The schedule fields of a task, in the display form the API reads and writes. */
export interface ScheduleBody {
  TimePeriod: 'Daily' | 'Weekly' | 'Monthly' | 'Monthly Special' | 'On Demand';
  TimePeriodEvery: number;
  /** Weekly: day digits (1 = Sunday … 7 = Saturday), e.g. "246"; Monthly: day of month; Monthly Special: "week^day" (week 5 = last). */
  TimePeriodDay: string | number;
  DailyFrequency: 'Once' | 'Several';
  DailyFrequencyTime: '' | 'Minutes' | 'Hourly';
  DailyIncrement: number | '';
  /** "HH:MM:SS". */
  DailyStartTime: string;
  DailyEndTime: string;
  /** "YYYY-MM-DD": first eligible date. IRIS refuses a first run that is already in the past. */
  StartDate: string;
  EndDate: string;
}
/** A partial PUT: only the fields sent change. */
export const saveSchedule = (id: number, body: ScheduleBody): Promise<unknown> => writeJson('PUT', `/task?id=${id}`, body);

// ── Work queue categories ────────────────────────────────────────────

/** List row: values are display text, e.g. "Dynamic (8)" or "2". */
export interface WqmRow { Name: string; DefaultWorkers: string; MaxWorkers: string; MaxActiveWorkers: string; MaxTotalWorkers: number; AlwaysQueue: boolean }
/** One category: 0 means automatic ("Dynamic") for the first three, and no limit for MaxTotalWorkers. */
export interface WqmCategory { DefaultWorkers: number; MaxWorkers: number; MaxActiveWorkers: number; MaxTotalWorkers: number; AlwaysQueue: boolean }

export const getWqmCategories = (): Promise<WqmRow[]> => get('/wqm-categories');
export const getWqmCategory = (name: string): Promise<WqmCategory> => get(`/wqm-category?name=${encodeURIComponent(name)}`);
/** Creates the category if the name is new (every field needed), otherwise changes only the fields sent. */
export const saveWqmCategory = (name: string, body: Partial<WqmCategory>): Promise<WqmCategory> =>
  writeJson('PUT', `/wqm-category?name=${encodeURIComponent(name)}`, body);
export const deleteWqmCategory = (name: string): Promise<unknown> => writeJson('DELETE', `/wqm-category?name=${encodeURIComponent(name)}`);
/** IRIS's own categories: always present, can't be deleted. */
export const SYSTEM_WQM = ['Default', 'SQL', 'Utility'];

// ── License ──────────────────────────────────────────────────────────

export interface LicenseKey {
  LicenseCapacity: string;
  CustomerName: string;
  OrderNumber: number | string;
  AuthorizationKey: string;
  Product: string;
  LicenseType: string;
  Server: string;
  Platform: string;
  LicenseUnits: number;
  CoresLicensed: number;
  CoresEnforced: number;
  /** "YYYY-MM-DD". */
  ExpirationDate: string;
  ExtendedFeaturesList: string[];
  AuthorizedApplications: string[];
}
export interface LicenseServer { Name: string; Address: string; Port: number; KeyDirectory: string }
export interface LicenseHolder { UserId: string; Type: string; Connects: number; MaxCon: number; CSPCon: number; LU: number; Active: number; Grace: number }
export interface LicenseUsage {
  /** Rows labelled "Current License Units Used", "Maximum License Units Used", "License Units Authorized", "Current Connections", "Maximum Connections". */
  Summary: Array<{ LicenseUnitUse: string; Local: string; Distributed: string }>;
  UsageByUser: LicenseHolder[];
}
export interface KeyCheck {
  IsValid: boolean;
  InvalidReason: string;
  RequiresRestart: boolean;
  RestartReason: string;
  HasReductions: boolean;
  Reductions: Record<string, { From: unknown; To: unknown } | string[]>;
}

export const getLicenseKey = (): Promise<LicenseKey> => get('/license/key');
export const getLicenseServers = (): Promise<LicenseServer[]> => get('/license/servers');
export const getLicenseUsage = (): Promise<LicenseUsage> => get('/monitor/license-usage');
/** Checks a key file's text without installing it (IRIS writes it to a temporary file and deletes it). */
export const checkLicenseKey = (key: string): Promise<KeyCheck> => writeJson('POST', '/license/key/validate', { Key: key });
/** Installs the key as the instance's key file and upgrades the running license. */
export const activateLicenseKey = (key: string): Promise<unknown> => writeJson('PUT', '/license/key', { Key: key });
export const saveLicenseServer = (name: string, body: Partial<Omit<LicenseServer, 'Name'>>): Promise<unknown> =>
  writeJson('PUT', `/license/server?name=${encodeURIComponent(name)}`, body);
export const deleteLicenseServer = (name: string): Promise<unknown> => writeJson('DELETE', `/license/server?name=${encodeURIComponent(name)}`);

/** Reads a Summary row by its label ("current units", "maximum units", "authorized", …); NaN when absent. */
export function usageFigure(u: LicenseUsage, match: RegExp): number {
  const row = u.Summary.find((r) => match.test(r.LicenseUnitUse.replace(/\s+/g, ' ')));
  return row ? Number(row.Local) : NaN;
}

// ── Links ────────────────────────────────────────────────────────────

/** Classic Management Portal pages (each checked to return 200). */
export const settingsPortal = {
  taskSchedule: '/csp/sys/op/%25CSP.UI.Portal.TaskSchedule.zen',
  licenseKey: '/csp/sys/mgr/%25CSP.UI.Portal.License.Key.zen',
  licenseServers: '/csp/sys/mgr/%25CSP.UI.Portal.LicenseServers.zen',
  licenseUsage: '/csp/sys/op/%25CSP.UI.Portal.LicenseUsage.zen',
};

const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
/** Documentation pages (each checked to resolve to the named page). */
export const settingsDocs = {
  taskManager: `${DOCS}GSA_manage_taskmgr`,
  license: `${DOCS}GSA_license`,
  licenseServer: `${DOCS}GSA_license_config`,
  wqm: `${DOCS}GSA_config_wqm`,
};
