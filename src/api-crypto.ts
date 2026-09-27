// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Encryption and Security › Managed file transfer: types,
 * fetchers and writes.
 *
 * Request shapes were read from the endpoint classes' source (Atelier GETs,
 * 2026-09-26). The encryption writes were NOT performed on the dev instance;
 * only requests IRIS rejects before acting were sent, to confirm routing and
 * body shape:
 * - Activate from a key file: body {Action: "ActivateDB" | "ActivateMK", AdminName, AdminPassword}
 *   with ?file=; a missing file → 404 before anything happens.
 * - Create a key file: body {File, AdminName, AdminPassword, KeyLen: 128|192|256, Description};
 *   KeyLen 100 → 400 "must equal 128, 192 or 256" before anything happens. IRIS won't overwrite
 *   an existing file. 201 on success.
 * - Deactivate: ?id= and body {Action: "DeactivateDB" | "DeactivateMK", AdminName, AdminPassword};
 *   the name and password are required by the body check but not used, so they go as "".
 *   A bad Action → 400; missing AdminName/AdminPassword → 400.
 * - Keys / administrators in a key file: ?file=; a missing file → 400 "does not exist".
 *
 * Managed file transfer was tested end to end with `osca_test_mft` (created, read,
 * updated, token revoked, deleted; nothing left behind):
 * - PUT creates (201) or updates (200). On create every field is required; on update any subset.
 *   Sending URL "" stores an empty URL (no default), so the form fills the service's default.
 * - An unknown Service fails with an internal error (500), so the form only offers the three.
 * - DELETE also deletes the OAuth 2.0 client the connection names, when no other connection
 *   uses it, and that client's server definition when it has no other clients. If the named
 *   client doesn't exist, IRIS deletes the connection anyway but answers 500 "Object to Load
 *   not found"; deleteMftConnection() checks and treats that as success.
 * - DELETE …/token on a connection that isn't authorized → 200 (nothing to revoke).
 */
import { get } from './api';
import { writeJson, AdminError } from './crud';
import { redact } from './api-secrets';

const q = encodeURIComponent;

// ── Encryption ──────────────────────────────────────────────────────────

export type StartMode = 'None' | 'Interactive' | 'Unattended' | 'KMIP' | 'Unknown';

export interface EncryptionSettings {
  DBEncStartMode: StartMode;
  DBEncJournal: boolean;
  DBEncIRISSecurity: boolean;
  DBEncIRISTemp: boolean;
  AuditEncrypt: boolean;
  DBEncStartKMIPServer: string;
  DBEncStartKeyFile: string;
  DBEncDefaultKeyID: string;
  DBEncJournalKeyID: string;
}
export const getEncryptionSettings = (): Promise<EncryptionSettings> => get('/security/encryption/settings');

/** A database-encryption key that is activated (in memory) right now. */
export interface ActivatedKey { Id: string; KeyLen: number; IsDefault: boolean }
export const getActivatedKeys = (): Promise<ActivatedKey[]> => get('/security/encryption/keys');
/** A data-element (application) encryption key that is activated right now. */
export const getDataElementKeys = (): Promise<Array<{ Id: string }>> => get('/security/encryption/data-element-keys');

interface DatabaseRow { Name: string; Directory: string; Status: string; MountRequired: boolean; MountAtStartup: boolean; Server?: string }
interface DatabaseDirRow { Directory: string; Status: string; Resource: string; Encrypted: boolean; EncryptionKeyID: string; Mirrored: boolean; Size?: number }

/** One local database with its encryption state. */
export interface DbEncryption {
  Name: string;
  Directory: string;
  Status: string;
  Resource: string;
  Encrypted: boolean;
  KeyId: string;
  MountRequired: boolean;
  MountAtStartup: boolean;
  Mirrored: boolean;
  /** Size on disk in MB; 0 when not reported. */
  SizeMB: number;
  /** Global journaling on (null when its settings couldn't be read). */
  Journaled: boolean | null;
  /** Namespaces whose default globals or routines live in it. */
  MappedBy: string[];
}

/** Local databases (by name) joined to their directory's encryption state. Remote databases are left out. */
export async function getDatabaseEncryption(): Promise<DbEncryption[]> {
  const [dbs, dirs, nss] = await Promise.all([
    get<DatabaseRow[]>('/databases'), get<DatabaseDirRow[]>('/database-dirs'),
    get<Array<{ Name: string; Globals: string; Routines: string }>>('/namespaces').catch(() => []),
  ]);
  const key = (d: string): string => d.toLowerCase().replace(/[\\/]+$/, '');
  const byDir = new Map(dirs.map((d) => [key(d.Directory), d]));
  const out: DbEncryption[] = [];
  for (const db of dbs) {
    if (db.Server) continue;
    const dir = byDir.get(key(db.Directory));
    if (!dir) continue;
    out.push({
      Name: db.Name, Directory: db.Directory, Status: db.Status || dir.Status, Resource: dir.Resource,
      Encrypted: !!dir.Encrypted, KeyId: dir.EncryptionKeyID ?? '',
      MountRequired: !!db.MountRequired, MountAtStartup: !!db.MountAtStartup, Mirrored: !!dir.Mirrored,
      SizeMB: Number(dir.Size) || 0,
      Journaled: null,
      MappedBy: nss.filter((n) => n.Globals === db.Name || n.Routines === db.Name).map((n) => n.Name),
    });
  }
  // Journaling is a per-directory setting: one read each, cached for 10 minutes, at most 2 at a time.
  // A failure leaves it unknown (and isn't cached).
  const now = Date.now();
  const stale = out.filter((d) => (journalCache.get(d.Directory)?.at ?? 0) < now - JOURNAL_TTL_MS);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < stale.length) {
      const d = stale[next++];
      try {
        const s = await get<{ GlobalJournalState?: boolean }>(`/database-dir?dir=${q(d.Directory)}`);
        journalCache.set(d.Directory, { at: Date.now(), on: !!s.GlobalJournalState });
      } catch { /* unknown: shown blank */ }
    }
  };
  await Promise.all([worker(), worker()]);
  for (const d of out) { const c = journalCache.get(d.Directory); if (c) d.Journaled = c.on; }
  return out;
}
const JOURNAL_TTL_MS = 10 * 60_000;
const journalCache = new Map<string, { at: number; on: boolean }>();

export type KeyKind = 'database' | 'data-element';

/** Activate a key held in a key file. The key file itself isn't changed. */
export const activateKey = (file: string, kind: KeyKind, adminName: string, adminPassword: string): Promise<unknown> =>
  writeJson('POST', `/security/encryption/file/activate?file=${q(file)}`,
    { Action: kind === 'database' ? 'ActivateDB' : 'ActivateMK', AdminName: adminName, AdminPassword: adminPassword });

/** Deactivate an activated key. IRIS refuses while a database encrypted with it is mounted. */
export const deactivateKey = (id: string, kind: KeyKind): Promise<unknown> =>
  writeJson('POST', `/security/encryption/key/deactivate?id=${q(id)}`,
    { Action: kind === 'database' ? 'DeactivateDB' : 'DeactivateMK', AdminName: '', AdminPassword: '' });

/** Create a new key file holding one new key, with one administrator. IRIS won't overwrite an existing file. */
export const createKeyFile = (file: string, adminName: string, adminPassword: string, keyLen: 128 | 192 | 256, description: string): Promise<unknown> =>
  writeJson('POST', '/security/encryption/file', { File: file, AdminName: adminName, AdminPassword: adminPassword, KeyLen: keyLen, Description: description });

export interface KeyInFile { Id: string; KeyLen: number; Description: string }
/** KeyLen here is in bytes (as IRIS stores it); convert with keyBits(). */
export const getKeysInFile = (file: string): Promise<KeyInFile[]> => get(`/security/encryption/file/keys?file=${q(file)}`);
export const getFileAdmins = (file: string): Promise<Array<{ Name: string }>> => get(`/security/encryption/file/admins?file=${q(file)}`);

/** Key length → bits. Activated keys report bytes (16/24/32); anything ≥ 64 is already bits. */
export const keyBits = (n: number): number => (n > 0 && n <= 32 ? n * 8 : n);

// ── Managed file transfer ───────────────────────────────────────────────

export type MftService = 'Box' | 'Dropbox' | 'Kiteworks';
export const MFT_SERVICES: MftService[] = ['Box', 'Dropbox', 'Kiteworks'];
/** The service's own default base URL (Kiteworks is self-hosted, so it has none). */
export const MFT_DEFAULT_URL: Record<MftService, string> = {
  Box: 'https://api.box.com/2.0/',
  Dropbox: 'https://api.dropboxapi.com/2/',
  Kiteworks: '',
};

export interface MftSummary { Name: string; Service: string; IsAuthorized: string }
export interface MftConnection { Service: string; URL: string; SSLConfiguration: string; Username: string; ApplicationName: string }

export const getMftConnections = (): Promise<MftSummary[]> => get('/security/mft/connections');
export const getMftConnection = async (name: string): Promise<MftConnection> =>
  redact(await get<MftConnection>(`/security/mft/connection?connection=${q(name)}`));

/** Create (all fields) or update (any subset). */
export const saveMftConnection = (name: string, body: Partial<MftConnection>): Promise<MftConnection> =>
  writeJson('PUT', `/security/mft/connection?connection=${q(name)}`, body);

/** Does a connection with this name exist? (Save would silently overwrite it.) */
export async function mftExists(name: string): Promise<boolean> {
  try { await get(`/security/mft/connection?connection=${q(name)}`); return true; } catch (err) {
    if (err instanceof AdminError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Delete a connection. IRIS reports an error when the OAuth 2.0 client it names
 * doesn't exist, even though the connection itself was deleted; that case
 * resolves normally. Any other failure throws.
 */
export async function deleteMftConnection(name: string): Promise<void> {
  try {
    await writeJson('DELETE', `/security/mft/connection?connection=${q(name)}`);
  } catch (err) {
    if (err instanceof AdminError && err.status === 404) throw err;
    if (await mftExists(name).catch(() => true)) throw err;
  }
}

/** Forget the connection's access token: it has to be authorized again before it can transfer files. */
export const revokeMftToken = (name: string): Promise<unknown> =>
  writeJson('DELETE', `/security/mft/connection/token?connection=${q(name)}`);

/**
 * The address to send an administrator to so they sign in to the service and
 * grant access. After the service redirects back to IRIS, IRIS keeps the token
 * and sends the browser on to `redirect`.
 */
export const getMftAuthUrl = async (name: string, redirect: string, scope: string): Promise<string> =>
  (await get<{ Url?: string }>(`/security/mft/connection/auth-code-url?connection=${q(name)}&redirect=${q(redirect)}&scope=${q(scope)}`)).Url ?? '';

/** Scope IRIS asks each service for (%SYS.MFT.Connection.<Service>:DefaultScope). */
export const MFT_SCOPE: Record<MftService, string> = {
  Box: '',
  Dropbox: '',
  Kiteworks: '*/files/* */folders/* */search/* */users/* */devices/* */roles/*',
};

/**
 * The authorization server each service signs in with, as IRIS's own
 * %SYS.MFT.Connection.<Service>:CreateClient() sets it up. Kiteworks is
 * self-hosted, so its issuer is the organization's server.
 */
export function mftIssuer(service: MftService, kiteworksServer = ''): { issuer: string; metadata: Record<string, string> } {
  if (service === 'Box') {
    return { issuer: 'https://account.box.com', metadata: {
      authorization_endpoint: 'https://account.box.com/api/oauth2/authorize',
      token_endpoint: 'https://api.box.com/oauth2/token',
      revocation_endpoint: 'https://api.box.com/oauth2/revoke',
    } };
  }
  if (service === 'Dropbox') {
    return { issuer: 'https://api.dropboxapi.com', metadata: {
      authorization_endpoint: 'https://www.dropbox.com/oauth2/authorize',
      token_endpoint: 'https://api.dropboxapi.com/oauth2/token',
    } };
  }
  const issuer = kiteworksServer.replace(/\/+$/, '');
  return { issuer, metadata: { authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token` } };
}

/**
 * Create the OAuth 2.0 client a connection signs in with, the way
 * CreateClient() does: reuse the service's server definition (or add it),
 * then a confidential client that sends its secret in the request body.
 * The secret is write-only. Resolves to the client's name.
 */
export async function createMftClient(o: {
  service: MftService; name: string; tls: string; clientId: string; clientSecret: string; redirectBase: string; kiteworksServer?: string;
}): Promise<string> {
  const { issuer, metadata } = mftIssuer(o.service, o.kiteworksServer);
  const find = async (): Promise<number | undefined> =>
    (await get<Array<{ ID: number; IssuerEndpoint: string }>>('/security/oauth2/client/server-definitions'))
      .find((d) => d.IssuerEndpoint.replace(/\/+$/, '') === issuer)?.ID;
  let id = await find();
  if (id === undefined) {
    await writeJson('POST', '/security/oauth2/client/server-definition', { IssuerEndpoint: issuer, SSLConfiguration: o.tls, Metadata: { issuer, ...metadata } });
    id = await find();
    if (id === undefined) throw new AdminError('IRIS didn’t report the new authorization server back. Refresh and try again.', 500);
  }
  await writeJson('PUT', `/security/oauth2/client/client-configuration?applicationName=${q(o.name)}`, {
    ServerDefinition: String(id), Enabled: true, ClientType: 'confidential', SSLConfiguration: o.tls,
    RedirectionEndpoint: o.redirectBase.replace(/\/+$/, ''), ClientId: o.clientId,
    Metadata: { token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code'], client_name: `${o.name} client` },
  });
  await writeJson('POST', `/security/oauth2/client/client-configuration/secrets?applicationName=${q(o.name)}`, { ClientSecret: o.clientSecret });
  return o.name;
}

// ── Management Portal pages and docs ────────────────────────────────────

const SEC = '/csp/sys/sec/%25CSP.UI.Portal.';
export const cryptoPortal = {
  createKeyFile: `${SEC}EncryptionCreate.zen`,
  manageKeyFile: `${SEC}EncryptionManage.zen`,
  databaseEncryption: `${SEC}EncryptionDatabase.zen`,
  dataElement: `${SEC}EncryptionManaged.zen`,
  localDatabases: '/csp/sys/mgr/%25CSP.UI.Portal.Databases.zen',
  database: (name: string): string => `/csp/sys/mgr/%25CSP.UI.Portal.Database.zen?DBName=${q(name)}`,
  mftList: `${SEC}MFT.ConnectionList.zen`,
  mftNew: `${SEC}MFT.Connection.zen?isNew=1`,
  mftEdit: (name: string): string => `${SEC}MFT.Connection.zen?PID=${q(name)}`,
  mftAuthorize: (name: string): string => `${SEC}MFT.Authorize.zen?ConnectionName=${q(name)}`,
};

const DOCS_BASE = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
export const cryptoDocs = {
  overview: `${DOCS_BASE}ROARS_encrypt`,
  databases: `${DOCS_BASE}ROARS_encrypt_dbmgmt`,
  keys: `${DOCS_BASE}ROARS_encrypt_mgmt`,
  dataElement: `${DOCS_BASE}ROARS_encrypt_dee`,
  protect: `${DOCS_BASE}ROARS_encrypt_protect`,
  mft: `${DOCS_BASE}GMFT_intro`,
  mftSetup: `${DOCS_BASE}GMFT_parts`,
};
