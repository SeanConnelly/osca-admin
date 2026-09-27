// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security & secrets: the Secrets wallet, X.509 credentials, TLS configurations
 * and OAuth 2.0 — types, fetchers and the few writes the screens make.
 *
 * Secret material never leaves this module. The wallet listing only carries
 * names and types, but every response passes through redact() anyway, so a
 * field such as ClientSecret or PrivateKeyPassword that a future IRIS version
 * starts returning is replaced by MASKED before any screen sees it.
 */
import { get } from './api';
import { writeJson, AdminError } from './crud';

/** Stand-in for any secret-shaped value. Screens render it as "Hidden", never as text. */
export const MASKED = '\u0000masked';
/** Field names that hold secret material. "token" only at the end, so token_endpoint and friends survive. */
const SECRET_KEY = /(secret|password|passphrase|passwd|token$|private(?!.?key.?(file|type)))/i;

/** Deep copy with every secret-shaped field replaced by MASKED. */
export function redact<T>(data: T): T {
  if (Array.isArray(data)) return data.map((v) => redact(v)) as T;
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && v !== '' && v !== null && v !== undefined && typeof v !== 'boolean' ? MASKED : redact(v);
    }
    return out as T;
  }
  return data;
}
export const isMasked = (v: unknown): boolean => v === MASKED;

const safe = async <T>(path: string): Promise<T> => redact(await get<T>(path));
const q = encodeURIComponent;

/** Resolves to null when IRIS answers 404 (the thing isn't configured). */
async function optional<T>(path: string): Promise<T | null> {
  try { return await safe<T>(path); } catch (err) {
    if (err instanceof AdminError && err.status === 404) return null;
    throw err;
  }
}

// ── Secure wallet ────────────────────────────────────────────────────────

/** GET /v2/wallet/collections (%SYS.Wallet.Collection:List). */
export interface WalletCollection {
  Name: string;
  /** Resource a user needs to change the collection's secrets. */
  EditResource: string;
  /** Resource a user needs to use (read) the collection's secrets. */
  UseResource: string;
}
/** GET /v2/wallet/secrets?collection= (%SYS.Wallet.Secret:List). Names and types only; IRIS has no read endpoint for values. */
export interface WalletSecret {
  /** "collection.secret". */
  Name: string;
  /** Implementing class: %Wallet.KeyValue, %Wallet.RSA or %Wallet.SymmetricKey. */
  Type: string;
}
export const getWalletCollections = (): Promise<WalletCollection[]> => safe('/wallet/collections');
/** Only Name and Type are kept, whatever else the response carries. */
export const getWalletSecrets = async (collection: string): Promise<WalletSecret[]> =>
  (await safe<WalletSecret[]>(`/wallet/secrets?collection=${q(collection)}`)).map((s) => ({ Name: String(s.Name ?? ''), Type: String(s.Type ?? '') }));

/** "%Development:READ" → { resource: "%Development", perm: "READ" }. */
export function splitResource(v: string): { resource: string; perm: 'READ' | 'WRITE' | 'USE' } {
  const [resource, p = ''] = v.split(':');
  const perm = p.toUpperCase();
  return { resource, perm: perm === 'WRITE' || perm === 'USE' ? perm : 'READ' };
}
/** IRIS's permission word → the letter a role grants. */
export const PERM_LETTER = { READ: 'R', WRITE: 'W', USE: 'U' } as const;

/** Collection names: a letter or "%", then letters, digits, "-" or "_"; up to 64. */
export const COLLECTION_NAME = /^[%A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** The part after "collection.": letters, digits, "-", "_" or "."; whole name up to 128. */
export const SECRET_NAME = /^[A-Za-z0-9_.-]+$/;

export type SecretKind = '%Wallet.KeyValue' | '%Wallet.SymmetricKey' | '%Wallet.RSA';

/** Create or change a collection. Use and edit resources are "resource:PERM". */
export const saveWalletCollection = (name: string, body: { UseResource?: string; EditResource?: string }): Promise<WalletCollection> =>
  writeJson('PUT', `/wallet/collection?name=${q(name)}`, body);
/** Deletes the collection and every secret in it. */
export const deleteWalletCollection = (name: string): Promise<unknown> => writeJson('DELETE', `/wallet/collection?name=${q(name)}`);

/**
 * Create a secret, or change one (IRIS merges: for key-value secrets, keys sent
 * replace their stored values and other keys stay). The value goes in and is
 * never read back: IRIS has no way to fetch it, and the portal doesn't try.
 */
export const saveWalletSecret = (fullName: string, type: SecretKind, config: Record<string, unknown>): Promise<unknown> =>
  writeJson('PUT', `/wallet/secret?name=${q(fullName)}`, { Type: type, WalletSecretConfig: config });
export const deleteWalletSecret = (fullName: string): Promise<unknown> => writeJson('DELETE', `/wallet/secret?name=${q(fullName)}`);

// ── TLS configurations ──────────────────────────────────────────────────

/** GET /v2/security/ssl-configurations. */
export interface TlsConfigSummary {
  Name: string;
  Description: string;
  Enabled: boolean;
  /** "Client" or "Server". */
  Type: string;
}
/** GET /v2/security/ssl-configuration?name= (Security.SSLConfigs). */
export interface TlsConfig {
  AuthorizeCN: boolean;
  CAFile: string;
  CAPath: string;
  CertificateFile: string;
  /** TLS 1.2 and earlier, OpenSSL cipher-string terms. */
  CipherList: string[];
  /** TLS 1.3 ciphersuites. */
  Ciphersuites: string[];
  Description: string;
  /** 0 = automatic. Servers only. */
  DiffieHellmanBits: number;
  Enabled: boolean;
  /** 0 = none, 1 = require (clients) / support (servers) OCSP stapling. */
  OCSP: number;
  OCSPIssuerCert: string;
  OCSPResponseFile: string;
  OCSPTimeout: number;
  OCSPURL: string;
  PrivateKeyFile: string;
  /** 1 = DSA, 2 = RSA, 3 = ECDSA. */
  PrivateKeyType: number;
  /** Bit values: 2 SSLv3, 4 TLS 1.0, 8 TLS 1.1, 16 TLS 1.2, 32 TLS 1.3. */
  TLSMaxVersion: number;
  TLSMinVersion: number;
  /** 0 = client, 1 = server. */
  Type: number;
  VerifyDepth: number;
  /** Clients: 0 none, 1 require. Servers: 0 none, 1 request, 3 require. */
  VerifyPeer: number;
}
export const getTlsConfigs = (): Promise<TlsConfigSummary[]> => safe('/security/ssl-configurations');
export const getTlsConfig = (name: string): Promise<TlsConfig> => safe(`/security/ssl-configuration?name=${q(name)}`);
/** Configurations IRIS ships or manages itself (ISC.*, %*): never deleted from here. */
export const isSystemTlsConfig = (name: string): boolean => /^(ISC\.|%)/i.test(name);
export const deleteTlsConfig = (name: string): Promise<unknown> => writeJson('DELETE', `/security/ssl-configuration?name=${q(name)}`);
/** Body for creating or changing a TLS configuration. On create IRIS requires Type, VerifyPeer and Enabled. */
export interface TlsConfigBody {
  Type?: number; Enabled?: boolean; Description?: string; VerifyPeer?: number; VerifyDepth?: number;
  CAFile?: string; CertificateFile?: string; PrivateKeyFile?: string; PrivateKeyType?: number;
  /** Write-only; IRIS refuses it unless PrivateKeyFile is set. Never read back. */
  PrivateKeyPassword?: string;
  TLSMinVersion?: number; TLSMaxVersion?: number; CipherList?: string[]; Ciphersuites?: string[];
}
export const tlsConfigExists = async (name: string): Promise<boolean> => {
  try { await get(`/security/ssl-configuration?name=${q(name)}`); return true; } catch (err) {
    if (err instanceof AdminError && (err.status === 404 || /does not exist/i.test(err.message))) return false;
    throw err;
  }
};
/** Create (201) or change (200) a TLS configuration; resolves to the saved settings, secrets removed. */
export const saveTlsConfig = async (name: string, body: TlsConfigBody): Promise<TlsConfig> =>
  redact(await writeJson<TlsConfig>('PUT', `/security/ssl-configuration?name=${q(name)}`, body));

/**
 * Opens a TLS connection to host:port with this (client) configuration and
 * sends a bare HTTP request; changes nothing. Resolves to IRIS's report lines,
 * e.g. "SSL connection succeeded", "Protocol: TLSv1.3". A failed handshake throws.
 */
export const testTlsConfig = async (name: string, host: string, port: number): Promise<string[]> =>
  (await writeJson<{ Info?: string[] }>('POST', `/security/ssl-configuration/test?name=${q(name)}`, { Host: host, Port: port })).Info ?? [];

// ── X.509 credentials ───────────────────────────────────────────────────

/** GET /v2/security/x509-credentials (%SYS.X509Credentials:ListDetails). */
export interface X509Credential {
  Alias: string;
  /** Usernames allowed to use the credential; empty means any user. */
  OwnerList: string[];
  PeerNames: string[];
  HasPrivateKey: boolean;
  CAFile: string;
}
/** GET /v2/security/x509-credential/certificate?alias=. Timestamps are "YYYY-MM-DD HH:MM:SS". */
export interface X509CertInfo {
  HasPrivateKey: boolean;
  SerialNumber: string;
  IssuerDN: string;
  SubjectDN: string;
  ValidityNotBefore: string;
  ValidityNotAfter: string;
}
export const getX509Credentials = (): Promise<X509Credential[]> => safe('/security/x509-credentials');
/**
 * Store a certificate (and optionally its private key) under an alias. The
 * files are paths on the IRIS server, read once at save. The key password is
 * write-only. 409 when the alias is taken.
 */
export const createX509Credential = (body: {
  Alias: string; CertificateFile: string; PrivateKeyFile?: string; PrivateKeyPassword?: string;
  OwnerList?: string[]; PeerNames?: string[]; CAFile?: string;
}): Promise<unknown> => writeJson('POST', '/security/x509-credential', body);
/** Only who may use it, its peer names and its trusted-authorities file can change. */
export const updateX509Credential = (alias: string, body: { OwnerList?: string[]; PeerNames?: string[]; CAFile?: string }): Promise<unknown> =>
  writeJson('PUT', `/security/x509-credential?alias=${q(alias)}`, body);
export const deleteX509Credential = (alias: string): Promise<unknown> => writeJson('DELETE', `/security/x509-credential?alias=${q(alias)}`);
export const getX509CertInfo = (alias: string): Promise<X509CertInfo> => safe(`/security/x509-credential/certificate?alias=${q(alias)}`);

// ── OAuth 2.0 ───────────────────────────────────────────────────────────

/** GET /v2/security/oauth2/client/server-definitions (OAuth2.ServerDefinition:List). */
export interface OAuthServerDefinition {
  ID: number;
  IssuerEndpoint: string;
  ClientCount: number;
  ResourceCount: number;
}
/** GET /v2/security/oauth2/client/client-configurations?serverId= (OAuth2.Client:ListForServer). */
export interface OAuthClientConfig {
  ApplicationName: string;
  /** "public", "confidential" or "resource". */
  ClientType: string;
  DefaultScope: string;
}
/** GET /v2/security/oauth2/server/clients (OAuth2.Server.Client:List). */
export interface OAuthRegisteredClient {
  Name: string;
  ClientId: string;
  ClientType: string;
  RedirectURL: string[];
  Description: string;
}
/** GET /v2/security/oauth2/resource-servers (OAuth2.ResourceServer:List). */
export interface OAuthResourceServer {
  Name: string;
  /** Issuer endpoint of the authorization server it trusts. */
  ServerDefinition: string;
}
/** GET /v2/security/oauth2/server — only a few fields are relied on; the rest is shown generically. */
export interface OAuthAuthServer {
  IssuerEndpoint: string;
  Description?: string;
  SupportedScopes?: Array<{ Scope: string; Description: string }>;
  [key: string]: unknown;
}

/** GET …/server-definition?serverId= : the issuer, its TLS configuration and what IRIS knows about its endpoints. */
export interface OAuthServerDefinitionDetail {
  IssuerEndpoint: string;
  SSLConfiguration: string;
  ServerCredentials: string;
  Metadata: Record<string, unknown>;
}
/** GET …/client-configuration?applicationName= (no secret: IRIS never returns it). */
export interface OAuthClientConfigDetail {
  ServerDefinition: string;
  Enabled: boolean;
  Description: string;
  ClientType: string;
  SSLConfiguration: string;
  RedirectionEndpoint: string;
  ClientId: string;
  ClientCredentials: string;
  DefaultScope: string;
}
/** GET …/resource-server?name= */
export interface OAuthResourceServerDetail {
  Enabled: boolean;
  Description: string;
  IssuerEndpoint: string;
  ScopeRequiredToConnect: string;
  Audiences: string[];
  AccessTokenIsJWT: boolean;
  AlwaysCallIntrospection: boolean;
  ClientId: string;
  IntrospectionAuthMethod: string;
  UseOIDC: boolean;
}

export const getOAuthServerDefinition = (id: number | string): Promise<OAuthServerDefinitionDetail> =>
  safe(`/security/oauth2/client/server-definition?serverId=${q(String(id))}`);
export const getOAuthClientConfig = (app: string): Promise<OAuthClientConfigDetail> =>
  safe(`/security/oauth2/client/client-configuration?applicationName=${q(app)}`);
export const getOAuthResourceServer = (name: string): Promise<OAuthResourceServerDetail> =>
  safe(`/security/oauth2/resource-server?name=${q(name)}`);

/**
 * Add an authorization server. IRIS needs its authorization and token
 * endpoints to save it; call discoverOAuthServer() afterwards to fill in the
 * rest from the issuer's published settings. (Discovery during the create
 * itself fails inside IRIS, so it's done as a second step.)
 */
export const createOAuthServerDefinition = (issuer: string, tls: string, endpoints: { authorization_endpoint: string; token_endpoint: string }): Promise<unknown> =>
  writeJson('POST', '/security/oauth2/client/server-definition', { IssuerEndpoint: issuer, SSLConfiguration: tls, Metadata: { issuer, ...endpoints } });
export const updateOAuthServerDefinition = (id: number | string, body: { SSLConfiguration?: string; Metadata?: Record<string, string> }): Promise<unknown> =>
  writeJson('PUT', `/security/oauth2/client/server-definition?serverId=${q(String(id))}`, body);
/** Re-reads the issuer's published settings (its .well-known document) over TLS. */
export const discoverOAuthServer = (id: number | string): Promise<unknown> =>
  writeJson('PUT', `/security/oauth2/client/server-definition?serverId=${q(String(id))}&discover=1`, {});
/** IRIS refuses while clients or resource servers still use it. */
export const deleteOAuthServerDefinition = (id: number | string): Promise<unknown> =>
  writeJson('DELETE', `/security/oauth2/client/server-definition?serverId=${q(String(id))}`);

export interface OAuthClientConfigBody {
  ServerDefinition?: string; Enabled?: boolean; Description?: string; ClientType?: string;
  SSLConfiguration?: string; RedirectionEndpoint?: string; ClientId?: string; DefaultScope?: string;
}
/**
 * Create or change a client configuration. IRIS also turns on the
 * /csp/sys/oauth2 web application when one is saved: it receives the
 * sign-in responses.
 */
export const saveOAuthClientConfig = (app: string, body: OAuthClientConfigBody): Promise<unknown> =>
  writeJson('PUT', `/security/oauth2/client/client-configuration?applicationName=${q(app)}`, body);
/** Write-only: sets the client secret; nothing reads it back. */
export const setOAuthClientSecret = (app: string, secret: string): Promise<unknown> =>
  writeJson('POST', `/security/oauth2/client/client-configuration/secrets?applicationName=${q(app)}`, { ClientSecret: secret });
export const deleteOAuthClientConfig = (app: string): Promise<unknown> =>
  writeJson('DELETE', `/security/oauth2/client/client-configuration?applicationName=${q(app)}`);

export interface OAuthResourceServerBody {
  Enabled?: boolean; Description?: string; IssuerEndpoint?: string; ScopeRequiredToConnect?: string;
  Audiences?: string[]; AccessTokenIsJWT?: boolean; AlwaysCallIntrospection?: boolean; ClientId?: string;
}
export const saveOAuthResourceServer = (name: string, body: OAuthResourceServerBody): Promise<unknown> =>
  writeJson('PUT', `/security/oauth2/resource-server?name=${q(name)}`, body);
/** Write-only: the secret it uses to call the introspection endpoint. */
export const setOAuthResourceServerSecret = (name: string, secret: string): Promise<unknown> =>
  writeJson('POST', `/security/oauth2/resource-server/secret?name=${q(name)}`, { ClientSecret: secret });
export const deleteOAuthResourceServer = (name: string): Promise<unknown> =>
  writeJson('DELETE', `/security/oauth2/resource-server?name=${q(name)}`);

export const getOAuthServerDefinitions =(): Promise<OAuthServerDefinition[]> => safe('/security/oauth2/client/server-definitions');
export const getOAuthClientConfigs = (serverId: number | string): Promise<OAuthClientConfig[]> =>
  safe(`/security/oauth2/client/client-configurations?serverId=${q(String(serverId))}`);
export const getOAuthRegisteredClients = (): Promise<OAuthRegisteredClient[]> => safe('/security/oauth2/server/clients');
export const getOAuthResourceServers = (): Promise<OAuthResourceServer[]> => safe('/security/oauth2/resource-servers');
/** null when this instance isn't set up as an authorization server. */
export const getOAuthAuthServer = (): Promise<OAuthAuthServer | null> => optional('/security/oauth2/server');

/**
 * Body for setting this instance up as the authorization server (one per
 * instance). On create IRIS requires every field; on change any subset.
 * IssuerEndpoint is the base address: IRIS appends /oauth2 to form the issuer.
 * Verified on 2026.2 with a request IRIS rejects at save (a non-numeric
 * interval): every field name below passes its request check.
 */
export interface OAuthAuthServerBody {
  IssuerEndpoint: string; Description: string;
  AccessTokenInterval: number; AuthorizationCodeInterval: number; RefreshTokenInterval: number; SessionInterval: number; ClientSecretInterval: number;
  SupportedScopes: Array<{ Scope: string; Description: string }>; DefaultScope: string; AllowUnsupportedScope: boolean;
  /** "" = only as OpenID Connect requires; letters OR'ed: a always, c confidential clients, f when offline_access is asked for. */
  ReturnRefreshToken: string;
  SupportSession: boolean; AudRequired: boolean; AllowPublicClientRefresh: boolean;
  ForcePKCEForPublicClients: boolean; ForcePKCEForConfidentialClients: boolean;
  CustomizationRoles: string[]; CustomizationNamespace: string;
  AuthenticateClass: string; SessionClass: string; ValidateUserClass: string; GenerateTokenClass: string; RevokeTokenClass: string;
  ServerCredentials: string; SigningAlgorithm: string; EncryptionAlgorithm: string; KeyAlgorithm: string; SSLConfiguration: string;
  Metadata: { grant_types_supported?: string[] } & Record<string, unknown>;
}
export const saveOAuthAuthServer = async (body: Partial<OAuthAuthServerBody>): Promise<OAuthAuthServer> =>
  redact(await writeJson<OAuthAuthServer>('PUT', '/security/oauth2/server', body));
/** Removes the instance's authorization-server configuration. */
export const deleteOAuthAuthServer = (): Promise<unknown> => writeJson('DELETE', '/security/oauth2/server');

// ── Documentation links (InterSystems IRIS docs, latest release) ─────────

const DOCS_BASE = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=';
export const DOCS = {
  wallet: 'ROARS_secrets_mgmt',
  tls: 'GSA_config_tls',
  tlsAbout: 'ATLS',
  x509: 'GSOAPSEC_common',
  oauthClient: 'ROARS_iam_oauth#ROARS_iam_oauth_client',
  oauthServer: 'ROARS_iam_oauth#ROARS_iam_oauth_authz',
  oauthResource: 'ROARS_iam_oauth#ROARS_iam_oauth_resource',
} as const;
export const docsHref = (key: keyof typeof DOCS): string => `${DOCS_BASE}${DOCS[key]}`;
