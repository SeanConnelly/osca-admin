// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security auditing: /v2/security/audit/*.
 *
 * The records search is asynchronous. POST /security/audit/records takes its
 * filters as QUERY parameters (the body is ignored), queues a task, and answers
 * 202 with `Location: /api/admin/v1/async-result?id=<guid>`. The rows arrive by
 * polling GET /async-result?id=<guid> until State is Finished or Failed.
 * The search changes nothing on the instance (it runs the %SYS.Audit:List
 * query), but IRIS counts every search as a %System/%Security/AuditReport
 * event, and writes a record of it while auditing is on.
 */
import { get } from './api';
import { authFetch } from './auth';
import { sleep } from './crud';

/** GET /security/audit/enabled */
export interface AuditEnabled { Enabled: boolean }

/** One row of GET /security/audit/events. Counters run since they were last cleared. */
export interface AuditEvent {
  /** "Source/Type/Name", e.g. "%System/%Login/Login". */
  EventName: string;
  Enabled: boolean;
  /** Times the event happened. */
  Total: number;
  /** Times a record was written to the audit database. */
  Written: number;
  /** Times a record should have been written but couldn't be. */
  Lost: number;
}

/** One row of the records search. TimeStamp is server local time; UTCTimeStamp is UTC. */
export interface AuditRecord {
  SystemID: string;
  AuditIndex: number;
  TimeStamp: string;
  UTCTimeStamp: string;
  EventSource: string;
  EventType: string;
  Event: string;
  Pid: number;
  SessionID: string;
  Username: string;
  Description: string;
  JobNumber: number;
  Authentication: string;
  ClientExecutableName: string;
  ClientIPAddress: string;
  EventData: string;
  Namespace: string;
  Roles: string;
  RoutineSpec: string;
  UserInfo: string;
  JobId: number;
  Status: string;
  OSUsername: string;
  StartupClientIPAddress: string;
}

/** GET /security/audit/record: the same fields; Pid and AuditIndex come back as strings, and there's no TimeStamp or SessionID. */
export type AuditRecordDetail = Omit<AuditRecord, 'Pid' | 'AuditIndex' | 'TimeStamp' | 'SessionID'> & {
  Pid: string | number;
  AuditIndex: string | number;
};

/** Filters for the records search. Lists are comma-separated and accept * wildcards; omitted means "*". */
export interface AuditSearch {
  /** Server-local "YYYY-MM-DD HH:MM:SS". */
  beginDateTime?: string;
  endDateTime?: string;
  eventSources?: string;
  eventTypes?: string;
  events?: string;
  usernames?: string;
  namespaces?: string;
  pids?: string;
  systemIDs?: string;
  authentication?: string;
  /** Oldest first when true; newest first by default. */
  ascending?: boolean;
  jsonSearch?: string;
  /** Defaults to 1000 on the server. */
  maxRows?: number;
}

interface AsyncResult<T> {
  State: 'Queued' | 'Running' | 'Finished' | 'Failed' | 'Canceled' | 'Paused';
  TaskName: string;
  FailureReason: string;
  Result: T;
}

export const getAuditEnabled = (): Promise<AuditEnabled> => get('/security/audit/enabled');
export const getAuditEvents = (): Promise<AuditEvent[]> => get('/security/audit/events');

export const getAuditRecord = (r: { UTCTimeStamp: string; SystemID: string; AuditIndex: number | string }): Promise<AuditRecordDetail> =>
  get(`/security/audit/record?${new URLSearchParams({ utcTimestamp: r.UTCTimeStamp, systemID: r.SystemID, auditIndex: String(r.AuditIndex) })}`);


/** Run the records search and wait for its rows (newest first unless `ascending`). */
export async function searchAuditRecords(q: AuditSearch, timeoutMs = 20000): Promise<AuditRecord[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '') continue;
    params.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const path = `/security/audit/records?${params}`;
  const res = await authFetch(`/api/admin/v2${path}`, { method: 'POST', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Admin API ${path} → HTTP ${res.status} ${res.statusText}`);
  const id = /[?&]id=([^&]+)/.exec(res.headers.get('Location') ?? '')?.[1];
  if (!id) throw new Error('The audit search did not return a result location.');

  const started = Date.now();
  for (let wait = 120; ; wait = Math.min(wait * 1.6, 1000)) {
    const r = await get<AsyncResult<AuditRecord[] | Record<string, never>>>(`/async-result?id=${encodeURIComponent(id)}`);
    if (r.State === 'Finished') return Array.isArray(r.Result) ? r.Result : [];
    if (r.State === 'Failed' || r.State === 'Canceled') throw new Error(r.FailureReason || `The audit search ${r.State.toLowerCase()}.`);
    if (Date.now() - started > timeoutMs) throw new Error('The audit search is taking too long. Try a shorter time range.');
    await sleep(wait);
  }
}

/** "%System/%Login/Login" → its three parts. */
export function splitEventName(name: string): { source: string; type: string; event: string } {
  const [source = '', type = '', ...rest] = name.split('/');
  return { source, type, event: rest.join('/') };
}

/** Plain-English meaning of the built-in events; anything else (user-defined events) falls back to its name. */
const EVENT_TEXT: Record<string, string> = {
  '%System/%Login/Login': 'Someone signed in',
  '%System/%Login/LoginFailure': 'A sign-in attempt failed',
  '%System/%Login/Logout': 'Someone signed out',
  '%System/%Login/Terminate': 'A process was ended by another user',
  '%System/%Login/JobStart': 'A background job started',
  '%System/%Login/JobEnd': 'A background job ended',
  '%System/%Login/TaskStart': 'A scheduled task started',
  '%System/%Login/TaskEnd': 'A scheduled task ended',
  '%System/%DirectMode/DirectMode': 'Someone used the Terminal (direct mode)',
  '%System/%Security/AccessDenied': 'Access was refused for lack of privileges',
  '%System/%Security/ApplicationChange': 'An application definition changed',
  '%System/%Security/AuditChange': 'Audit settings changed or audit data was deleted',
  '%System/%Security/AuditReport': 'Someone viewed or searched audit records',
  '%System/%Security/DBEncChange': 'Database encryption settings changed',
  '%System/%Security/DocDBChange': 'Document database security changed',
  '%System/%Security/DomainChange': 'A security domain changed',
  '%System/%Security/KMIPServerChange': 'A KMIP key server changed',
  '%System/%Security/LDAPConfigChange': 'An LDAP configuration changed',
  '%System/%Security/OAuth2': 'An OAuth 2.0 token or authorization event',
  '%System/%Security/OAuth2ResourceServerChange': 'An OAuth 2.0 resource server changed',
  '%System/%Security/OpenAMIdentityServicesChange': 'OpenAM identity services changed',
  '%System/%Security/PhoneProvidersChange': 'A mobile phone provider (for two-factor codes) changed',
  '%System/%Security/Protect': 'A protected resource was accessed or refused',
  '%System/%Security/ResourceChange': 'A resource definition changed',
  '%System/%Security/RestrictDirectories': 'A restricted directory was accessed',
  '%System/%Security/RoleChange': 'A role changed, or was granted or revoked',
  '%System/%Security/ServerChange': 'A server connection setting changed',
  '%System/%Security/ServiceChange': 'A service was enabled, disabled or changed',
  '%System/%Security/SSLConfigChange': 'A TLS configuration changed',
  '%System/%Security/SystemChange': 'System-wide security settings changed',
  '%System/%Security/UserChange': 'A user account changed',
  '%System/%Security/WalletSecretChange': 'A wallet secret changed',
  '%System/%Security/WalletSecretUse': 'A wallet secret was used',
  '%System/%Security/X509CredentialsChange': 'X.509 credentials changed',
  '%System/%SMPExplorer/Change': 'Data was changed in the Management Portal explorer',
  '%System/%SMPExplorer/ExecuteQuery': 'A query was run from the Management Portal',
  '%System/%SMPExplorer/Export': 'Data was exported from the Management Portal',
  '%System/%SMPExplorer/Import': 'Data was imported through the Management Portal',
  '%System/%SMPExplorer/ViewContents': 'Globals or tables were viewed in the Management Portal',
  '%System/%SQL/DDL': 'SQL changed a table or other schema object',
  '%System/%SQL/DML': 'SQL inserted, updated or deleted data',
  '%System/%SQL/Query': 'A SQL query ran',
  '%System/%SQL/Utility': 'A SQL utility statement ran',
  '%System/%SQL/PrivilegeFailure': 'A SQL statement was refused for lack of privileges',
  '%System/%SQL/DynamicStatement': 'Dynamic SQL ran',
  '%System/%SQL/DynamicStatementDDL': 'Dynamic SQL changed the schema',
  '%System/%SQL/DynamicStatementDML': 'Dynamic SQL changed data',
  '%System/%SQL/DynamicStatementQuery': 'A dynamic SQL query ran',
  '%System/%SQL/DynamicStatementUtility': 'A dynamic SQL utility statement ran',
  '%System/%SQL/EmbeddedStatement': 'Embedded SQL ran',
  '%System/%SQL/EmbeddedStatementDDL': 'Embedded SQL changed the schema',
  '%System/%SQL/EmbeddedStatementDML': 'Embedded SQL changed data',
  '%System/%SQL/EmbeddedStatementQuery': 'An embedded SQL query ran',
  '%System/%SQL/EmbeddedStatementUtility': 'An embedded SQL utility statement ran',
  '%System/%SQL/XDBCStatement': 'SQL ran over JDBC or ODBC',
  '%System/%SQL/XDBCStatementDDL': 'SQL over JDBC or ODBC changed the schema',
  '%System/%SQL/XDBCStatementDML': 'SQL over JDBC or ODBC changed data',
  '%System/%SQL/XDBCStatementQuery': 'A query ran over JDBC or ODBC',
  '%System/%SQL/XDBCStatementUtility': 'A utility statement ran over JDBC or ODBC',
  '%System/%System/AuditRecordLost': 'An audit record could not be written',
  '%System/%System/ConfigurationChange': 'The instance configuration changed',
  '%System/%System/DatabaseChange': 'A database was created, changed or deleted',
  '%System/%System/JournalChange': 'Journal settings changed or the journal file switched',
  '%System/%System/OSCommand': 'An operating-system command was run',
  '%System/%System/RoutineChange': 'Routine or class code was changed',
  '%System/%System/Start': 'The instance started',
  '%System/%System/Stop': 'The instance stopped',
  '%System/%System/SuspendResume': 'A process was suspended or resumed',
  '%System/%System/UserEventOverflow': 'Too many user-defined audit events were raised',
  '%Ensemble/%Message/Resend': 'An interoperability message was resent',
  '%Ensemble/%Message/ViewContents': 'Someone viewed the contents of an interoperability message',
  '%Ensemble/%Production/ModifyConfiguration': 'A production configuration changed',
  '%Ensemble/%Production/ModifyDefaultSetting': 'A production default setting changed',
  '%Ensemble/%Production/StartStop': 'A production was started or stopped',
  '%Ensemble/%Schema/Modify': 'An interoperability schema changed',
};
export const eventMeaning = (name: string): string => EVENT_TEXT[name] ?? '';

/** Event type → the area it covers, for grouping and subtitles. */
const TYPE_TEXT: Record<string, string> = {
  '%Login': 'Sign-in and processes',
  '%Security': 'Security settings',
  '%System': 'System',
  '%SQL': 'SQL',
  '%SMPExplorer': 'Management Portal explorer',
  '%DirectMode': 'Terminal',
  '%Message': 'Interoperability messages',
  '%Production': 'Interoperability productions',
  '%Schema': 'Interoperability schemas',
};
export const typeMeaning = (type: string): string => TYPE_TEXT[type] ?? type;
