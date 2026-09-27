// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Language servers, Devices and ECP: reads and writes for the
 * three screens (src/screens/lang-servers.ts, devices.ts, ecp.ts).
 *
 * What ran against the dev instance (on osca_test_… objects only, all
 * removed afterwards) and what is built from the endpoint source
 * (%Api.Admin.Endpoints.LanguageServer, Device.*, ECP.*):
 *  - Language servers: create, edit, start (fails cleanly without Java/Python
 *    on the machine), stop, activity, delete: run live.
 *  - Devices: create, edit, delete: run live. Subtypes and device settings:
 *    read only here (edited in the Management Portal).
 *  - ECP data servers: create, connection actions (Not connected / Disabled),
 *    delete: run live on OSCA_TEST_ECP. "Connect" (Normal) is built from the
 *    source: it's the same call with action 3.
 *  - ECP TLS approvals (authorize / reject / remove): built from the source;
 *    there's no way to create a pending connection on a lone instance.
 *  - ECP settings: read only here (edited in the Management Portal).
 */
import { get } from './api';
import { writeJson } from './crud';

const q = encodeURIComponent;

// ── Language servers ───────────────────────────────────────────────────

export interface LangServerRow { Name: string; Port: number; Type: string }
export interface LangServer {
  BindToIPAddress: string;
  ConnectionTimeout: number;
  InitializationTimeout: number;
  LogFile: string;
  Port: number;
  Resource: string;
  Type: string;
  UseSharedMemory: boolean;
  SSLConfigurationServer: string;
  SSLConfigurationClient: string;
  VerifySSLHostName: boolean;
  Custom: Record<string, string | number | boolean>;
}
export interface LangActivity { ID: number; DateTime: string; RecordType: string; Job: number; Text: string }
export interface LangActivityResult { Activity: LangActivity[]; CurrentlyRunning: boolean }

export const getLangServers = (): Promise<LangServerRow[]> => get('/ext-lang-servers');
export const getLangServer = (name: string): Promise<LangServer> => get(`/ext-lang-server?name=${q(name)}`);
export const getLangActivity = (name: string): Promise<LangActivityResult> => get(`/ext-lang-server/activity?name=${q(name)}`);
/** Create or change (IRIS creates when the name is new). Type is always required. */
export const saveLangServer = (name: string, body: Partial<LangServer> & { Type: string }): Promise<LangServer> =>
  writeJson('PUT', `/ext-lang-server?name=${q(name)}`, body);
export const deleteLangServer = (name: string): Promise<unknown> => writeJson('DELETE', `/ext-lang-server?name=${q(name)}`);
export const startLangServer = (name: string): Promise<unknown> => writeJson('POST', `/ext-lang-server/start?name=${q(name)}`);
export const stopLangServer = (name: string): Promise<unknown> => writeJson('POST', `/ext-lang-server/stop?name=${q(name)}`);

/** The runtime settings each server type carries (IRIS clears the others). */
export const LANG_CUSTOM: Record<string, Array<{ key: string; label: string; hint?: string }>> = {
  java: [
    { key: 'JavaHome', label: 'Java home directory', hint: 'Leave empty to use the Java on the system path.' },
    { key: 'ClassPath', label: 'Class path', hint: 'Extra jar files or directories, separated as the operating system expects.' },
    { key: 'JVMArgs', label: 'JVM arguments', hint: 'For example -Xmx1g.' },
  ],
  '.NET': [
    { key: 'DotNetVersion', label: '.NET version' },
    { key: 'FilePath', label: 'Gateway directory', hint: 'Where the .NET gateway executable is. Leave empty for the one IRIS installs.' },
    { key: 'Exec32', label: 'Run as a 32-bit process' },
  ],
  Python: [
    { key: 'PythonPath', label: 'Python executable', hint: 'Leave empty to use the python on the system path.' },
    { key: 'PythonOptions', label: 'Python options', hint: 'Extra command-line options for the interpreter.' },
  ],
  Remote: [{ key: 'Address', label: 'Remote server address', hint: 'The machine the server already runs on. IRIS connects to it; it doesn’t start it.' }],
};
const JAVA_LIKE = new Set(['Java', 'XSLT', 'JDBC', 'ML', 'R']);
export const customFor = (type: string): Array<{ key: string; label: string; hint?: string }> =>
  JAVA_LIKE.has(type) ? LANG_CUSTOM.java : LANG_CUSTOM[type] ?? [];
export const DOTNET_VERSIONS = [
  { value: 'N8.0', label: '.NET 8.0' }, { value: 'N9.0', label: '.NET 9.0' }, { value: 'N10.0', label: '.NET 10.0' },
  { value: 'F4.6.2', label: '.NET Framework 4.6.2' }, { value: 'F3.5', label: '.NET Framework 3.5' },
];
/** Types IRIS offers, in its order, with what each one runs. */
export const LANG_TYPES: Array<{ value: string; label: string; runs: string }> = [
  { value: 'Java', label: 'Java', runs: 'Java classes, called from ObjectScript' },
  { value: 'JDBC', label: 'JDBC', runs: 'SQL Gateway connections to other databases through JDBC drivers' },
  { value: 'ODBC', label: 'ODBC', runs: 'SQL Gateway connections to other databases through ODBC drivers' },
  { value: 'ML', label: 'IntegratedML', runs: 'Machine-learning providers for IntegratedML' },
  { value: 'XSLT', label: 'XSLT', runs: 'XSLT 2.0 transformations' },
  { value: '.NET', label: '.NET', runs: '.NET assemblies, called from ObjectScript' },
  { value: 'Python', label: 'Python', runs: 'An external Python interpreter, called from ObjectScript' },
  { value: 'R', label: 'R', runs: 'R code, called from ObjectScript' },
  { value: 'Remote', label: 'Remote', runs: 'A server that already runs on another machine' },
];
export const langType = (t: string): { label: string; runs: string } =>
  LANG_TYPES.find((x) => x.value === t) ?? { label: t || 'Unknown', runs: 'An external language process' };

// ── Devices ────────────────────────────────────────────────────────────

export interface DeviceRow {
  Name: string; PhysicalDevice: string; Type: string; SubType: string; Prompt: string | number;
  OpenParameters: string; AlternateDevice: string; Description: string; Alias: string | number;
}
export type DeviceBody = Omit<DeviceRow, 'Name'>;
export interface DeviceSubtype {
  Name: string; RightMargin: number; FormFeed: string; ScreenLength: number; Backspace: string;
  CursorControl: string; EraseEOL: string; EraseEOF: string; ZU22FormFeed: string; ZU22Backspace: string;
}
export interface DeviceSettings {
  TelnetSettings: { DNSLookup: string; Port: number };
  IOSettings: { File: string; MagTape: string; Other: string; Terminal: string };
}
export const getDevices = (): Promise<DeviceRow[]> => get('/devices');
export const getDeviceSubtypes = (): Promise<DeviceSubtype[]> => get('/device/subtypes');
export const getDeviceSettings = (): Promise<DeviceSettings> => get('/device/settings');
export const saveDevice = (name: string, body: Partial<DeviceBody>): Promise<DeviceBody> => writeJson('PUT', `/device?name=${q(name)}`, body);
export const deleteDevice = (name: string): Promise<unknown> => writeJson('DELETE', `/device?name=${q(name)}`);

export const DEVICE_TYPES: Array<{ value: string; label: string; plural: string }> = [
  { value: 'TRM', label: 'Terminal', plural: 'Terminals' },
  { value: 'OTH', label: 'Printer or file', plural: 'Printers & files' },
  { value: 'SPL', label: 'Spooler', plural: 'Spoolers' },
  { value: 'MT', label: 'Magnetic tape', plural: 'Tapes' },
  { value: 'BT', label: 'Cartridge tape', plural: 'Tapes' },
  { value: 'IPC', label: 'Interprocess', plural: 'Interprocess' },
];
export const deviceType = (t: string): string => DEVICE_TYPES.find((x) => x.value === t)?.label ?? t;
/** The devices IRIS installs; changing or deleting them affects every terminal and print job. */
export const BUILTIN_DEVICES = new Set(['0', '2', '47', '48', '57', '58', 'SPOOL', 'TERM', '|LAT|', '|PRN|', '|TNT|', '|TRM|']);

// ── ECP ────────────────────────────────────────────────────────────────

export interface EcpSettings {
  AppServerSettings: { MaxServers: number; ClientReconnectDuration: number; ClientReconnectInterval: number };
  DataServerSettings: { MaxServerConn: number; ServerTroubleDuration: number; SSLECPServer: number };
}
export interface EcpDataServer {
  Name: string; RemoteAddress: string; RemotePort: number; Status: string;
  MirrorConnection: boolean; SSLConfig: boolean; BatchMode: boolean;
}
export interface EcpDataServerBody { Address: string; Port: number; MirrorConnection: number; SSLConfig: number; BatchMode: boolean }
export interface EcpAppServer { ClientName: string; Status: string; IPAddress: string; IPPort: number }
export interface EcpTlsConnection { SSLComputerName: string; ClientIP: string; Status: 'Authorized' | 'Pending' }
export interface EcpRemoteDb { [k: string]: unknown }
export interface EcpDashboard {
  AppServer: { MaxConn: number; ActConn: number; GloRef: number; ByteSent: number; ByteRcvd: number; GloRefLocal: number; GloRefRemote: number };
  DataServer: { MaxConn: number; ActConn: number; GloRef: number; ByteSent: number; ByteRcvd: number; ReqRcvd: number; LockGrant: number; LockFail: number };
}

export const getEcpSettings = (): Promise<EcpSettings> => get('/ecp/settings');
export const getEcpDataServers = (): Promise<EcpDataServer[]> => get('/ecp/data-servers');
export const getEcpDataServerDbs = (name: string): Promise<EcpRemoteDb[]> => get(`/ecp/data-server/databases?name=${q(name)}`);
export const getEcpAppServers = (): Promise<EcpAppServer[]> => get('/ecp/application-servers');
export const getEcpTls = (): Promise<EcpTlsConnection[]> => get('/ecp/application-server-ssl-connections');
export const getEcpDashboard = (): Promise<EcpDashboard> => get('/monitor/dashboard/ecp');
/** Whether this instance accepts ECP connections at all (the ECP service). */
export const getEcpService = (): Promise<{ Enabled: boolean }> => get('/security/service?name=%25Service_ECP');

export const saveEcpDataServer = (name: string, body: Partial<EcpDataServerBody>): Promise<unknown> =>
  writeJson('PUT', `/ecp/data-server?name=${q(name)}`, body);
export const deleteEcpDataServer = (name: string): Promise<unknown> => writeJson('DELETE', `/ecp/data-server?name=${q(name)}`);
/** 1 = not connected, 2 = disabled, 3 = normal (connect). IRIS runs it in the background. */
export const ecpDataServerAction = (name: string, action: 1 | 2 | 3): Promise<unknown> =>
  writeJson('POST', `/ecp/data-server/action?name=${q(name)}`, { Action: action });
export const authorizeEcpTls = (cn: string): Promise<unknown> => writeJson('POST', `/ecp/application-server-ssl-connection/authorize?name=${q(cn)}`);
export const rejectEcpTls = (cn: string): Promise<unknown> => writeJson('POST', `/ecp/application-server-ssl-connection/reject?name=${q(cn)}`);
export const removeEcpTls = (cn: string): Promise<unknown> => writeJson('DELETE', `/ecp/application-server-ssl-connection?name=${q(cn)}`);

// ── Links ──────────────────────────────────────────────────────────────

const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
/** Documentation pages (each checked to exist). */
export const sysDocs = {
  langServers: `${DOCS}BEXTSERV_intro`,
  langManaging: `${DOCS}BEXTSERV_managing`,
  devices: `${DOCS}GIOD_intro`,
  ecp: `${DOCS}GDDM_ecp`,
};
/** Management Portal pages (each checked to answer 200 on IRIS 2026.2). */
export const sysPortal = {
  langActivity: (name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.ExternalLanguageServerActivities.zen?PID=${q(name)}`,
  devices: '/csp/sys/mgr/%25CSP.UI.Portal.Config.Devices.zen',
  device: (name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.Config.Device.zen?PID=${q(name)}`,
  subtypes: '/csp/sys/mgr/%25CSP.UI.Portal.Config.SubTypes.zen',
  subtype: (name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.Config.SubType.zen?PID=${q(name)}`,
  io: '/csp/sys/mgr/%25CSP.UI.Portal.Config.IO.zen',
  telnet: '/csp/sys/mgr/%25CSP.UI.Portal.Config.Telnet.zen',
  ecp: '/csp/sys/mgr/%25CSP.UI.Portal.ECP.zen',
  ecpDataServers: '/csp/sys/mgr/%25CSP.UI.Portal.ECPDataServers.zen',
  ecpAppServers: '/csp/sys/mgr/%25CSP.UI.Portal.ECPAppServers.zen',
};

