// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Certificates & TLS — the TLS configurations IRIS uses for
 * encrypted connections, and the X.509 credentials (certificate plus optional
 * private key) stored in the instance. View tabs pick the dataset; the detail
 * panel decodes protocol versions, ciphers and peer verification, and flags
 * certificates that have expired or expire within 30 days.
 */
import '../styles-secrets.css';
import '../styles-sec.css';
import '../styles-services.css';
import {
  getTlsConfigs, getTlsConfig, getX509Credentials, getX509CertInfo, docsHref,
  isSystemTlsConfig, deleteTlsConfig, testTlsConfig, saveTlsConfig, tlsConfigExists,
  createX509Credential, updateX509Credential, deleteX509Credential,
  type TlsConfigSummary, type TlsConfig, type TlsConfigBody, type X509Credential, type X509CertInfo,
} from '../api-secrets';
import {
  mono,
  esc, chip, cell, when, skeleton, errorPanel, liveIndicator, pruneColumns, viewTabs, bindViewTabs, setViewTabCount, emptyState, setSearch, objectDetail, odMeta, odSection, odKv,
  type ScreenCtx, type Tone, type OdFull,
} from '../ui';
import {
  confirm, toast, errorText, newButton, editorShell, panelWidth, section, textField, passwordField,
  selectField, checkField, readForm, fieldError, AdminError, type FieldProblem, type FormValues, pathField,
} from '../crud';
import { getSecurityGraph, type SecurityGraph } from '../api-security';
import { getSuperservers, type Superserver } from '../api-services';
import { mountSecurityBanner } from '../security-view';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

const SOON_DAYS = 30;
const DAY = 86_400_000;

// ── Decoding ───────────────────────────────────────────────────────────

const PROTOCOLS: Array<[number, string]> = [[2, 'SSLv3'], [4, 'TLS 1.0'], [8, 'TLS 1.1'], [16, 'TLS 1.2'], [32, 'TLS 1.3']];
const protoLabel = (bit: number): string => PROTOCOLS.find(([b]) => b === bit)?.[1] ?? `Unknown (${bit})`;
const protoRange = (c: TlsConfig): string =>
  c.TLSMinVersion === c.TLSMaxVersion ? protoLabel(c.TLSMinVersion) : `${protoLabel(c.TLSMinVersion)} – ${protoLabel(c.TLSMaxVersion)}`;
/** TLS 1.2 is the oldest version still considered safe. */
const weakProtocols = (c: TlsConfig): boolean => c.TLSMinVersion > 0 && c.TLSMinVersion < 16;

function verifyPeer(c: TlsConfig): { short: string; long: string; tone: Tone } {
  if (c.Type === 1) {
    return c.VerifyPeer === 3 ? { short: 'Client certificate required', long: 'Clients must present a certificate that verifies.', tone: 'success' }
      : c.VerifyPeer === 1 ? { short: 'Client certificate requested', long: 'Clients may present a certificate; the connection ends if one is presented and fails verification.', tone: 'neutral' }
        : { short: 'No client certificate', long: 'Clients aren’t asked for a certificate.', tone: 'neutral' };
  }
  return c.VerifyPeer === 1
    ? { short: 'Server verified', long: 'The connection continues only if the server’s certificate verifies.', tone: 'success' }
    : { short: 'Server not verified', long: 'The connection is encrypted, but continues even if the server’s certificate fails verification.', tone: 'warning' };
}

/** Cipher-string terms that let weak or unauthenticated ciphers in when they aren't excluded. */
const WEAK_CIPHERS = new Set(['LOW', 'EXP', 'EXPORT', 'NULL', 'eNULL', 'aNULL', 'RC4', 'MD5', 'DES', '3DES', 'SSLv2']);
/** What a careful admin would look at again, in plain words; [] when nothing. */
function reviewOf(c: TlsConfig): string[] {
  const weakIn = c.CipherList.filter((t) => !/^[!-]/.test(t) && WEAK_CIPHERS.has(t.replace(/^\+/, '')));
  return [
    weakProtocols(c) ? 'Allows protocol versions older than TLS 1.2' : '',
    c.Type !== 1 && c.VerifyPeer !== 1 ? 'Doesn’t verify the server’s certificate' : '',
    c.Type === 1 && !c.CertificateFile ? 'A server configuration without a certificate of its own' : '',
    weakIn.length ? `Lets weak ciphers in (${weakIn.join(', ')})` : '',
  ].filter(Boolean);
}

/** OpenSSL cipher-string terms → plain words. */
const CIPHER_TERMS: Record<string, string> = {
  ALL: 'all cipher suites', DEFAULT: 'OpenSSL’s default set', HIGH: 'high-strength', MEDIUM: 'medium-strength', LOW: 'low-strength',
  aNULL: 'anonymous (no authentication)', eNULL: 'unencrypted', NULL: 'unencrypted', EXP: 'export-grade', EXPORT: 'export-grade',
  SSLv2: 'SSLv2', SSLv3: 'SSLv3', MD5: 'MD5', RC4: 'RC4', DES: 'DES', '3DES': 'triple DES', PSK: 'pre-shared key', SRP: 'SRP', DSS: 'DSS',
};
function cipherSentence(list: string[]): string {
  const incl: string[] = []; const excl: string[] = [];
  for (const raw of list) {
    const off = raw.startsWith('!') || raw.startsWith('-');
    const term = raw.replace(/^[!+-]/, '');
    (off ? excl : incl).push(CIPHER_TERMS[term] ?? term);
  }
  const join = (a: string[]): string => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  if (!incl.length && !excl.length) return 'OpenSSL defaults';
  const base = incl.length ? join(incl) : 'the default set';
  return `${base[0].toUpperCase()}${base.slice(1)}${excl.length ? `, except ${join(excl)} ones` : ''}`;
}

const KEY_TYPES: Record<number, string> = { 1: 'DSA', 2: 'RSA', 3: 'ECDSA' };
/** Short value for beside-the-label display; the full wording goes in the tooltip. */
const caFile = (f: string): { short: string; full: string } =>
  f === '%OSCertificateStore' ? { short: 'OS certificate store', full: 'The operating system’s trusted certificate store' } : { short: f, full: f };
// Not api-disk's baseName: a path ending in a separator gives the whole path here, not the last folder.
const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

/** "C=US, O=Example, CN=api.example.com" → "api.example.com". */
function commonName(dn: string): string {
  const m = /(?:^|[,/]\s*)CN\s*=\s*([^,/]+)/i.exec(dn);
  return (m ? m[1] : dn).trim();
}

/** X.509 validity times are UTC; IRIS returns them as "YYYY-MM-DD HH:MM:SS". */
const certDate = (s: string): Date | null => {
  if (!s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
function span(ms: number): string {
  const days = Math.round(Math.abs(ms) / DAY);
  if (days < 1) return 'less than a day';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  const months = Math.round(days / 30.44);
  if (months < 24) return `${months} months`;
  return `${Math.round(days / 365.25)} years`;
}

interface Expiry { tone: Tone; label: string; long: string; rank: number }
function expiry(info: X509CertInfo | undefined, now = Date.now()): Expiry {
  const after = certDate(info?.ValidityNotAfter ?? '');
  const before = certDate(info?.ValidityNotBefore ?? '');
  if (!after) return { tone: 'neutral', label: 'Unknown', long: 'Validity dates aren’t available', rank: Number.MAX_SAFE_INTEGER };
  const left = after.getTime() - now;
  if (left <= 0) return { tone: 'danger', label: 'Expired', long: `Expired ${span(left)} ago`, rank: left };
  if (before && before.getTime() > now) return { tone: 'warning', label: 'Not yet valid', long: `Valid from ${when(before)}`, rank: left };
  if (left < SOON_DAYS * DAY) return { tone: 'warning', label: `Expires in ${span(left)}`, long: `Expires in ${span(left)}`, rank: left };
  return { tone: 'success', label: 'Valid', long: `Expires in ${span(left)}`, rank: left };
}

// ── Grids ──────────────────────────────────────────────────────────────

const enabledChip = (v: unknown): string => (v ? chip('Enabled', 'success') : chip('Disabled', 'neutral'));

const TLS_COLUMNS: DataGridColumn[] = [
  { key: 'Name', label: 'Name', width: '260px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
  { key: 'Type', label: 'Used as', width: '90px', sortable: true, renderCell: (v) => cell.text(v, v === 'Server' ? 'Accepts incoming TLS connections' : 'Makes outgoing TLS connections') },
  { key: 'Enabled', label: 'Status', width: '100px', sortable: true, renderCell: enabledChip },
  { key: 'Protocols', label: 'Protocols', width: '150px', sortable: true,
    renderCell: (v, row) => (v ? (row.Weak ? chip(String(v), 'warning', 'Allows protocol versions older than TLS 1.2') : cell.text(v)) : cell.dim('—')) },
  { key: 'Verify', label: 'Peer verification', width: '190px', sortable: true,
    renderCell: (v, row) => (v ? (row.VerifyTone === 'warning' ? chip(String(v), 'warning', String(row.VerifyLong)) : cell.text(v, String(row.VerifyLong))) : cell.dim('—')) },
  { key: 'Cert', label: 'Certificate', width: '180px', sortable: true,
    renderCell: (v, row) => (v ? cell.mono(baseName(String(v)), false, `${row.Cert} (expiry isn’t available for certificate files)`) : cell.dim('—')) },
  { key: 'Description', label: 'Description', renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('—')) },
];
/** Hidden first when the detail panel opens: least informative first. */
const TLS_SECONDARY = ['Description', 'Protocols', 'Cert'];
/** Never hidden: Verify (peer verification) is a security signal. */
const TLS_UNIFORM = ['Type', 'Enabled', 'Protocols', 'Cert', 'Description'];

const X509_COLUMNS: DataGridColumn[] = [
  { key: 'Alias', label: 'Alias', width: '200px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
  { key: 'Subject', label: 'Issued to', width: '200px', sortable: true, renderCell: (v, row) => (v ? cell.text(v, String(row.SubjectDN)) : cell.dim('—')) },
  { key: 'Issuer', label: 'Issued by', width: '180px', sortable: true, renderCell: (v, row) => (v ? cell.text(v, String(row.IssuerDN)) : cell.dim('—')) },
  { key: 'Rank', label: 'Expiry', width: '170px', sortable: true,
    renderCell: (_v, row) => (row.ExpTone === 'success' ? cell.text(String(row.Until), String(row.ExpLong)) : chip(String(row.ExpLabel), row.ExpTone as Tone, `${row.ExpLong} · ${row.Until}`)) },
  { key: 'HasPrivateKey', label: 'Private key', width: '100px', sortable: true, renderCell: (v) => (v ? cell.text('Stored') : cell.dim('—')) },
  { key: 'Owners', label: 'Who can use it', renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('Any user')) },
];
const X509_SECONDARY = ['Owners', 'Issuer'];
/** Never hidden: Rank (expiry) is a security signal. */
const X509_UNIFORM = ['Issuer', 'HasPrivateKey', 'Owners'];
/** Below this many rows, "the same on every row" says nothing, so no column is hidden. */
const MIN_ROWS_TO_HIDE = 3;

type Tab = 'tls' | 'x509';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

/** Value beside its label; the full text is a hover away when it truncates. */
/** Label above a sentence or list, in body text. */
const kvBlock = (k: string, v: string): string => `<div class="kv kv--block"><dt>${k}</dt><dd>${v}</dd></div>`;
const muted = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const PROTOCOL_OPTIONS = PROTOCOLS.filter(([b]) => b >= 4).map(([b, l]) => ({ value: String(b), label: l }));
const KEY_TYPE_OPTIONS = [{ value: '2', label: 'RSA' }, { value: '3', label: 'ECDSA' }, { value: '1', label: 'DSA' }];
/** Names for a TLS configuration or credential alias: letters, digits and . _ - */
const TLS_NAME = /^[A-Za-z0-9%][A-Za-z0-9._-]{0,63}$/;
const ALIAS = /^[A-Za-z0-9%][A-Za-z0-9._-]{0,127}$/;
const listOf = (v: unknown, sep: RegExp): string[] => String(v ?? '').split(sep).map((x) => x.trim()).filter(Boolean);
const OS_STORE = '%OSCertificateStore';
/** File-picker filters for the certificate, key and trusted-authority fields. */
const CERTS = [{ label: 'Certificates', patterns: ['*.cer', '*.crt', '*.pem', '*.der'] }];
const KEYS = [{ label: 'Private keys', patterns: ['*.key', '*.pem'] }];
const CA = [{ label: 'Certificate bundles', patterns: ['*.cer', '*.crt', '*.pem'] }];

/* "What changes" in the editors: one line per edited field, saved → new. */
interface PreviewField { key: string; label: string; show?: (v: unknown) => string; secret?: boolean }
const PREVIEW_EVENTS = ['input', 'change', 'ev-input-input', 'ev-select-change', 'ev-checkbox-change', 'ev-toggle-change'];
const shown = (v: unknown): string => (typeof v === 'boolean' ? (v ? 'On' : 'Off') : String(v ?? '').trim() || 'none');
const diffLines = (before: FormValues, now: FormValues, fields: PreviewField[]): string[] => fields.flatMap((f) => {
  if (!(f.key in now)) return [];
  if (f.secret) return now[f.key] ? [`${f.label}: replaced.`] : [];
  const s = f.show ?? shown;
  const a = s(before[f.key]); const b = s(now[f.key]);
  return a === b ? [] : [`${f.label}: ${a} → ${b}.`];
});
const previewHtml = (lines: string[]): string =>
  `<ul>${(lines.length ? lines : ['No changes yet.']).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;

/** The last connection test run from this screen, per configuration. */
interface TestResult { host: string; port: number; info: string[]; at: Date }

export function certificatesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="od-list sec-list" id="cert-list-view">
      ${viewTabs('cert-tabs', [{ value: 'tls', label: 'TLS configurations', count: 0 }, { value: 'x509', label: 'X.509 credentials', count: 0 }], 'tls')}
      <div class="toolbar-row">
        <div class="search-box"><ev-search id="cert-search" size="sm" full-width placeholder="Filter by name" aria-label="Filter"></ev-search></div>
        <div class="toolbar-spacer"></div>
        <span id="cert-flags"></span>
      </div>
      <ev-detail-panel id="cert-panel" detail-width="500" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="cert-grid-wrap">${skeleton(6)}</div>
        <aside slot="detail" class="detail" id="cert-detail"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="cert-foot"></p>
    </div>
    <div id="cert-full" hidden></div>`;
  const listView = ctx.body.querySelector('#cert-list-view') as HTMLElement;
  const fullEl = ctx.body.querySelector('#cert-full') as HTMLElement;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#cert-panel');
  const wrap = $('#cert-grid-wrap');
  const detail = $('#cert-detail');

  let tab: Tab = 'tls';
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let gridTab: Tab | null = null;
  let uniform = new Set<string>();
  let loaded = false;
  let tls: TlsConfigSummary[] = [];
  const tlsDetail = new Map<string, TlsConfig>();
  let creds: X509Credential[] = [];
  const certInfo = new Map<string, X509CertInfo>();
  const lastTest = new Map<string, TestResult>();
  let editor: ReturnType<typeof editorShell> | null = null;
  let restoreWidth: (() => void) | null = null;
  let formEvents: AbortController | null = null;
  // Where the open form lives: the list's panel, or (from the full view) the full view's body.
  let formFull = false;
  let formEl: HTMLElement = detail;
  const leaveEdit = (): void => {
    editor?.close(); editor = null;
    restoreWidth?.(); restoreWidth = null;
    formEvents?.abort(); formEvents = null;
    formFull = false; formEl = detail;
  };
  ctx.onLeave(() => leaveEdit());
  /** true when it's fine to move away from an open test form. */
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };

  // Header: the one primary, for whichever list is showing.
  const newBtn = newButton(ctx, 'New TLS configuration', () => void (tab === 'tls' ? openTlsEditor(null) : openX509Editor(null)));
  const setNewLabel = (): void => {
    const span = newBtn.el.querySelector('span');
    if (span) span.textContent = tab === 'tls' ? 'New TLS configuration' : 'New X.509 credential';
  };

  /**
   * Editing happens in the detail panel, widened; from the full view (#/security/certs/<key>) the form
   * takes the body's place instead, so the address, title and ‹ › pager stay. Cancel goes back to what was showing.
   */
  const openEditor = (opts: Parameters<typeof editorShell>[1], full = false): void => {
    leaveEdit();
    formFull = full;
    formEl = full ? fullEl : detail;
    if (!full) {
      restoreWidth = panelWidth(panel, 520);
      setPanel(true);
    }
    editor = editorShell(formEl, opts);
  };
  /** Put the full view's cards back after a form that took their place (skeleton until the fresh read lands). */
  const backToFull = (): void => { fullEl.innerHTML = ''; od.refresh(); };
  const backFromEditor = (): void => {
    const full = formFull;
    leaveEdit();
    if (full) backToFull();
    else if (selected !== null) renderDetail(); else setPanel(false);
  };
  /** After a save: back to the full view it was opened from, or select the row and show it. */
  const savedThen = async (key: string): Promise<void> => {
    const full = formFull;
    leaveEdit();
    if (full) fullEl.innerHTML = ''; // load() re-reads and redraws the full view
    await load();
    if (!full) showCreated(key);
  };
  /** The user paged or went back to the list while a full-view form's read was out. */
  const movedOn = (key: string, full: boolean): boolean => full && (od.mode() !== 'full' || od.selected() !== key);
  /** After a create: select the new row and show it. */
  const showCreated = (key: string): void => {
    selected = key;
    grid?.select([key]);
    renderDetail();
  };

  // ── TLS configuration: create and change ──
  const openTlsEditor = async (name: string | null, full = false): Promise<void> => {
    if (!(await mayLeave())) return;
    const inFull = full && !!name;
    const host = inFull ? fullEl : detail;
    const d = name ? tlsDetail.get(name) ?? await getTlsConfig(name).catch(() => undefined) : undefined;
    if (name && movedOn(`tls:${name}`, inFull)) return;
    if (name && !d) { toast('Its settings couldn’t be read, so it can’t be edited here.', 'danger'); return; }
    const server = d?.Type === 1;
    const verifyServer = d && !server ? String(d.VerifyPeer) : '1';
    const verifyClient = d && server ? String(d.VerifyPeer) : '0';
    const typeField = name
      ? `<p class="sec-fixed"><span>Used as</span><b>${server ? 'Server: accepts incoming TLS connections' : 'Client: makes outgoing TLS connections'}</b></p>`
      : selectField('Type', 'Used as', [
        { value: '0', label: 'Client: makes outgoing TLS connections' },
        { value: '1', label: 'Server: accepts incoming TLS connections' },
      ], '0');
    openEditor({
      // The full view's title already names the configuration.
      title: inFull ? 'Edit settings' : name ? `Edit <span class="mono">${esc(name)}</span>` : 'New TLS configuration',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Create configuration',
      submitAlways: !name,
      sections:
        section('General',
          (name ? '' : textField('Name', 'Name', '', { required: true, mono: true, maxlength: 64, hint: 'Web servers, mirrors, ECP and outgoing requests refer to it by this name.' })) +
          textField('Description', 'Description', d?.Description ?? '') +
          typeField +
          checkField('Enabled', 'Enabled', d?.Enabled ?? true, { toggle: true, hint: 'While it’s off, anything that names it can’t make or accept TLS connections with it.' })) +
        section('Protocols',
          `<div class="crud-row">${selectField('Min', 'Oldest allowed', PROTOCOL_OPTIONS, String(d?.TLSMinVersion ?? 16))}${selectField('Max', 'Newest allowed', PROTOCOL_OPTIONS, String(d?.TLSMaxVersion ?? 32))}</div>`,
          { hint: 'TLS 1.2 is the oldest version still considered safe.' }) +
        section('Verifying the other side',
          `<div data-tls-for="0">${selectField('VerifyServer', 'Server certificate', [
            { value: '1', label: 'Verify it: stop if it fails' },
            { value: '0', label: 'Don’t verify (not recommended)' },
          ], verifyServer)}</div>` +
          `<div data-tls-for="1">${selectField('VerifyClient', 'Client certificates', [
            { value: '0', label: 'Don’t ask for one' },
            { value: '1', label: 'Ask; check it if one is sent' },
            { value: '3', label: 'Require one that verifies' },
          ], verifyClient)}</div>` +
          pathField('CAFile', 'Trusted authorities file', d ? d.CAFile : OS_STORE, { mode: 'file', filters: CA, title: 'Choose the trusted authorities file', hint: `Path on the IRIS server, or ${OS_STORE} for the operating system’s trusted store.` })) +
        section('Its own certificate',
          pathField('CertFile', 'Certificate file', d?.CertificateFile ?? '', { mode: 'file', filters: CERTS, title: 'Choose the certificate file', placeholder: 'e.g. C:\\certs\\server.cer', hint: 'Path on the IRIS server. A server needs one; a client only when the other side asks.' }) +
          pathField('KeyFile', 'Private key file', d?.PrivateKeyFile ?? '', { mode: 'file', filters: KEYS, title: 'Choose the private key file' }) +
          `<div class="crud-row">${selectField('KeyType', 'Key type', KEY_TYPE_OPTIONS, String(d?.PrivateKeyType ?? 2))}${passwordField('KeyPassword', name ? 'New key password' : 'Key password', { hint: name ? 'Leave empty to keep the current one. It’s never shown.' : 'Only if the key file is encrypted. Never shown again.' })}</div>`) +
        `<details class="sec-adv sec-adv--gutter"><summary>Ciphers and chain length</summary>
          ${textField('Ciphersuites', 'TLS 1.3 cipher suites', (d?.Ciphersuites ?? []).join(':'), { mono: true, hint: 'Colon-separated. Empty uses the OpenSSL defaults.' })}
          ${textField('CipherList', 'TLS 1.2 and earlier', (d?.CipherList ?? []).join(':'), { mono: true, hint: 'OpenSSL cipher string, e.g. ALL:!aNULL:!eNULL. Empty uses the IRIS default.' })}
          ${textField('Depth', 'Maximum chain length', String(d?.VerifyDepth ?? 9), { mono: true, width: '96px' })}
        </details>` +
        section('What changes', '<div id="tls-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => {
        const v = readForm(host);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (!TLS_NAME.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Use letters, digits, dots, dashes or underscores' });
          else if (tls.some((t) => t.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A configuration with this name already exists' });
        }
        if (Number(v.Min) > Number(v.Max)) out.push({ field: 'Min', label: 'Oldest allowed', message: 'Pick a version no newer than the newest allowed' });
        const isServer = name ? server : v.Type === '1';
        const cert = String(v.CertFile ?? '').trim();
        const key = String(v.KeyFile ?? '').trim();
        if (isServer && !cert) out.push({ field: 'CertFile', label: 'Certificate file', message: 'A server needs a certificate' });
        const verifies = Number(isServer ? v.VerifyClient : v.VerifyServer) > 0;
        if (verifies && !String(v.CAFile ?? '').trim()) out.push({ field: 'CAFile', label: 'Trusted authorities file', message: `Needed to verify certificates: a file, or ${OS_STORE}` });
        if (cert && !key) out.push({ field: 'KeyFile', label: 'Private key file', message: 'Enter the key that goes with the certificate' });
        if (v.KeyPassword && !key) out.push({ field: 'KeyPassword', label: 'Key password', message: 'Only needed with a private key file' });
        const depth = Number(String(v.Depth ?? '').trim());
        if (!Number.isInteger(depth) || depth < 0 || depth > 100) out.push({ field: 'Depth', label: 'Maximum chain length', message: 'Enter a number from 0 to 100' });
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        const isServer = name ? server : v.Type === '1';
        const body: TlsConfigBody = {
          Description: String(v.Description ?? '').trim(),
          Enabled: !!v.Enabled,
          VerifyPeer: Number(isServer ? v.VerifyClient : v.VerifyServer),
          CAFile: String(v.CAFile ?? '').trim(),
          CertificateFile: String(v.CertFile ?? '').trim(),
          PrivateKeyFile: String(v.KeyFile ?? '').trim(),
          PrivateKeyType: Number(v.KeyType),
          TLSMinVersion: Number(v.Min),
          TLSMaxVersion: Number(v.Max),
          VerifyDepth: Number(String(v.Depth).trim()),
        };
        if (!name) body.Type = isServer ? 1 : 0;
        const suites = listOf(v.Ciphersuites, /:/);
        const ciphers = listOf(v.CipherList, /:/);
        if (suites.length || name) body.Ciphersuites = suites;
        if (ciphers.length || name) body.CipherList = ciphers;
        if (v.KeyPassword && body.PrivateKeyFile) body.PrivateKeyPassword = String(v.KeyPassword);
        if (!name && await tlsConfigExists(target)) {
          fieldError(host, 'Name', 'A configuration with this name already exists');
          throw new AdminError('A TLS configuration with this name already exists.', 409);
        }
        const saved = await saveTlsConfig(target, body);
        tlsDetail.set(target, saved);
        await savedThen(target);
        toast(name ? `${target} saved.` : `TLS configuration ${target} created.`);
      },
      onCancel: backFromEditor,
    }, inFull);
    const sync = (): void => {
      const v = readForm(host);
      const t = name ? (server ? '1' : '0') : String(v.Type ?? '0');
      host.querySelectorAll<HTMLElement>('[data-tls-for]').forEach((el) => { el.hidden = el.dataset.tlsFor !== t; });
    };
    formEvents = new AbortController();
    for (const ev of ['ev-select-change', 'change']) host.addEventListener(ev, sync, { signal: formEvents.signal });
    sync();
    // What changes: each edited setting, saved → new; a new configuration says what it will do.
    const optLabel = (opts: Array<{ value: string; label: string }>) => (x: unknown): string => opts.find((o) => o.value === String(x))?.label ?? shown(x);
    const FIELDS: PreviewField[] = [
      { key: 'Description', label: 'Description' }, { key: 'Enabled', label: 'Enabled' },
      { key: 'Min', label: 'Oldest allowed', show: optLabel(PROTOCOL_OPTIONS) }, { key: 'Max', label: 'Newest allowed', show: optLabel(PROTOCOL_OPTIONS) },
      ...(server ? [] : [{ key: 'VerifyServer', label: 'Server certificate', show: (x: unknown) => (String(x) === '1' ? 'verified' : 'not verified') }]),
      ...(server ? [{ key: 'VerifyClient', label: 'Client certificates', show: (x: unknown) => ({ 0: 'not asked for', 1: 'asked for', 3: 'required' } as Record<string, string>)[String(x)] ?? shown(x) }] : []),
      { key: 'CAFile', label: 'Trusted authorities file' }, { key: 'CertFile', label: 'Certificate file' }, { key: 'KeyFile', label: 'Private key file' },
      { key: 'KeyType', label: 'Key type', show: optLabel(KEY_TYPE_OPTIONS) }, { key: 'KeyPassword', label: 'Key password', secret: true },
      { key: 'Ciphersuites', label: 'TLS 1.3 cipher suites' }, { key: 'CipherList', label: 'TLS 1.2 and earlier ciphers' }, { key: 'Depth', label: 'Maximum chain length' },
    ];
    let before: FormValues | null = null;
    const ed = editor;
    const update = (): void => {
      if (!ed || editor !== ed) return;
      const v = readForm(host);
      const lines = name
        ? (before ? diffLines(before, v, FIELDS) : [])
        : [`${String(v.Name ?? '').trim() || 'The configuration'} is created as a ${v.Type === '1' ? 'server: it accepts' : 'client: it makes'} TLS connections${v.Enabled ? '' : ', switched off'}.`];
      const box = host.querySelector('#tls-preview');
      if (box) box.innerHTML = previewHtml(lines);
    };
    for (const ev of PREVIEW_EVENTS) host.addEventListener(ev, update, { signal: formEvents.signal });
    update();
    requestAnimationFrame(() => { if (ed && editor === ed) { before = readForm(host); update(); } });
  };

  // ── X.509 credential: store one, or change who can use it ──
  const openX509Editor = async (alias: string | null, full = false): Promise<void> => {
    if (!(await mayLeave())) return;
    const inFull = full && !!alias;
    const host = inFull ? fullEl : detail;
    const c = alias ? creds.find((x) => x.Alias === alias) : undefined;
    if (alias && !c) return;
    openEditor({
      // The full view's title already names the credential.
      title: inFull ? 'Edit settings' : alias ? `Edit <span class="mono">${esc(alias)}</span>` : 'New X.509 credential',
      name: alias ?? undefined,
      submitLabel: alias ? 'Save changes' : 'Store credential',
      sections:
        (alias ? '' : section('General',
          textField('Alias', 'Alias', '', { required: true, mono: true, maxlength: 128, hint: 'Web-service security settings refer to it by this name.' }) +
          pathField('CertFile', 'Certificate file', '', { required: true, mode: 'file', filters: CERTS, title: 'Choose the certificate file', placeholder: 'e.g. C:\\certs\\signing.cer', hint: 'Path on the IRIS server, PEM or DER. IRIS copies it in when you save.' }) +
          pathField('KeyFile', 'Private key file', '', { mode: 'file', filters: KEYS, title: 'Choose the private key file', hint: 'Optional. Needed to sign or decrypt with it.' }) +
          passwordField('KeyPassword', 'Key password', { hint: 'Only if the key file is encrypted. Never shown again.' }))) +
        section('Use',
          textField('Owners', 'Who can use it', (c?.OwnerList ?? []).filter(Boolean).join(', '), { hint: 'Comma-separated usernames. Empty means any user.' }) +
          textField('Peers', 'Peer names', (c?.PeerNames ?? []).filter(Boolean).join(', '), { mono: true, hint: 'Comma-separated host names it identifies.' }) +
          pathField('CAFile', 'Trusted authorities file', c?.CAFile ?? '', { mode: 'file', filters: CA, title: 'Choose the trusted authorities file', hint: 'Empty uses iris.cer in the manager’s directory.' })) +
        section('What changes', '<div id="x509-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => {
        if (alias) return [];
        const v = readForm(host);
        const out: FieldProblem[] = [];
        const a = String(v.Alias ?? '').trim();
        if (!a) out.push({ field: 'Alias', label: 'Alias', message: 'Enter an alias' });
        else if (!ALIAS.test(a)) out.push({ field: 'Alias', label: 'Alias', message: 'Use letters, digits, dots, dashes or underscores' });
        else if (creds.some((x) => x.Alias.toLowerCase() === a.toLowerCase())) out.push({ field: 'Alias', label: 'Alias', message: 'A credential with this alias already exists' });
        if (!String(v.CertFile ?? '').trim()) out.push({ field: 'CertFile', label: 'Certificate file', message: 'Enter the certificate’s path on the server' });
        if (v.KeyPassword && !String(v.KeyFile ?? '').trim()) out.push({ field: 'KeyPassword', label: 'Key password', message: 'Only needed with a private key file' });
        return out;
      },
      onSubmit: async (v) => {
        const use = { OwnerList: listOf(v.Owners, /,/), PeerNames: listOf(v.Peers, /,/), CAFile: String(v.CAFile ?? '').trim() };
        if (alias) {
          await updateX509Credential(alias, use);
          await savedThen(alias);
          toast(`${alias} saved.`);
          return;
        }
        const a = String(v.Alias).trim();
        const key = String(v.KeyFile ?? '').trim();
        try {
          await createX509Credential({
            Alias: a, CertificateFile: String(v.CertFile).trim(), ...use,
            ...(key ? { PrivateKeyFile: key, PrivateKeyPassword: String(v.KeyPassword ?? '') } : {}),
          });
        } catch (err) {
          if (err instanceof AdminError && err.status === 409) { fieldError(host, 'Alias', 'This alias is taken'); throw new AdminError('A credential with this alias already exists.', 409); }
          throw err;
        }
        leaveEdit();
        await load();
        showCreated(a);
        toast(`Credential ${a} stored.`);
      },
      onCancel: backFromEditor,
    }, inFull);
    // What changes: who can use it and how it's checked, saved → new; a new credential says what's stored.
    const FIELDS: PreviewField[] = [
      { key: 'Owners', label: 'Who can use it', show: (x) => listOf(x, /,/).join(', ') || 'any user' },
      { key: 'Peers', label: 'Peer names', show: (x) => listOf(x, /,/).join(', ') || 'none' },
      { key: 'CAFile', label: 'Trusted authorities file', show: (x) => String(x ?? '').trim() || 'iris.cer (default)' },
    ];
    let before: FormValues | null = null;
    const ed = editor;
    const update = (): void => {
      if (!ed || editor !== ed) return;
      const v = readForm(host);
      const lines = alias
        ? (before ? diffLines(before, v, FIELDS) : [])
        : [`IRIS copies in the certificate${String(v.KeyFile ?? '').trim() ? ' and its private key' : ''} under the alias ${String(v.Alias ?? '').trim() || '…'}. The files on disk stay.`];
      const box = host.querySelector('#x509-preview');
      if (box) box.innerHTML = previewHtml(lines);
    };
    formEvents = new AbortController();
    for (const ev of PREVIEW_EVENTS) host.addEventListener(ev, update, { signal: formEvents.signal });
    update();
    requestAnimationFrame(() => { if (ed && editor === ed) { before = readForm(host); update(); } });
  };

  const deleteCredential = async (alias: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${alias}?`,
      body: `<p>Web-service security settings that sign, encrypt or verify with <b class="mono">${esc(alias)}</b> stop working until they’re pointed at another credential.</p><p>The certificate and key stored in IRIS are removed; files on disk stay. This can’t be undone.</p>`,
      confirmLabel: 'Delete credential', danger: true, typeToConfirm: alias,
    });
    if (!ok) return;
    try {
      await deleteX509Credential(alias);
      closeDetail();
      toast(`Credential ${alias} deleted.`);
      await load();
    } catch (err) { toast(errorText(err), 'danger'); }
  };

  /** Connection test: host and port in the panel, then IRIS's report under the configuration. */
  const openTest = async (name: string, full = false): Promise<void> => {
    if (!(await mayLeave())) return;
    const box = full ? fullEl : detail;
    openEditor({
      title: full ? 'Test connection' : `Test <span class="mono">${esc(name)}</span>`,
      name,
      submitLabel: 'Run test',
      sections: section('Server to connect to',
        `<div class="crud-row">${textField('Host', 'Host', '', { required: true, mono: true, placeholder: 'e.g. example.com', autocomplete: 'off' })}${textField('Port', 'Port', '443', { required: true, mono: true, width: '96px' })}</div>`,
        { hint: 'IRIS opens a TLS connection with this configuration and reports what was agreed. Nothing is changed.' }),
      check: () => {
        const v = readForm(box);
        const out: FieldProblem[] = [];
        const host = String(v.Host ?? '').trim();
        const port = Number(String(v.Port ?? '').trim());
        if (!host) out.push({ field: 'Host', label: 'Host', message: 'Enter a host name or IP address' });
        else if (/[\s/:]/.test(host)) out.push({ field: 'Host', label: 'Host', message: 'Enter just the host, without a scheme, path or port' });
        if (!Number.isInteger(port) || port < 1 || port > 65535) out.push({ field: 'Port', label: 'Port', message: 'Enter a port from 1 to 65535' });
        return out;
      },
      onSubmit: async (v) => {
        const host = String(v.Host).trim();
        const port = Number(String(v.Port).trim());
        const info = await testTlsConfig(name, host, port); // a failed handshake throws; the shell shows why
        lastTest.set(name, { host, port, info, at: new Date() });
        const wasFull = formFull;
        leaveEdit();
        if (wasFull) backToFull(); else if (od.mode() === 'full') od.refresh(); else renderDetail();
        const proto = info.find((l) => l.startsWith('Protocol:'))?.split(':')[1]?.trim();
        toast(`Connected to ${host}:${port}${proto ? ` over ${proto.replace('TLSv', 'TLS ')}` : ''}.`);
      },
      onCancel: backFromEditor,
    }, full);
  };

  const deleteConfig = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: `<p>Anything that refers to <b class="mono">${esc(name)}</b> by name, such as a web server, mirror, ECP connection, email or outgoing HTTP request, stops connecting until it’s pointed at another configuration.</p><p>The certificate and key files it points to stay on disk. This can’t be undone.</p>`,
      confirmLabel: 'Delete configuration',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteTlsConfig(name);
      lastTest.delete(name);
      closeDetail();
      toast(`TLS configuration ${name} deleted.`);
      await load();
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  };

  const applyColumns = (): void => {
    if (!grid) return;
    const cols = tab === 'tls' ? TLS_COLUMNS : X509_COLUMNS;
    const secondary = tab === 'tls' ? TLS_SECONDARY : X509_SECONDARY;
    for (const c of cols) grid.setColumnVisible(c.key, !uniform.has(c.key) && !(panel.open && secondary.includes(c.key)));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  /** Close the peek from code (tab change, delete): not a user's "don't show me this". */
  let closingFromCode = false;
  const closeDetail = (): void => {
    if (od.selected() !== null) { selected = null; closingFromCode = true; void od.select(null).finally(() => { closingFromCode = false; }); return; }
    selected = null; grid?.select([]); setPanel(false);
  };
  const AUTO_KEY = 'osca-portal:auto-peek-closed:security/certs';
  const wasClosed = (): boolean => { try { return sessionStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } };
  const closedByUser = (): void => { try { sessionStorage.setItem(AUTO_KEY, '1'); } catch { /* storage blocked: it opens again next visit */ } };

  // ── Rows ──
  const allTlsRows = (): DataGridRow[] => tls.map((t) => {
    const d = tlsDetail.get(t.Name);
    const v = d ? verifyPeer(d) : null;
    return {
      Name: t.Name, Type: t.Type, Enabled: t.Enabled, Description: t.Description,
      Protocols: d ? protoRange(d) : '', Weak: d ? weakProtocols(d) : false,
      Verify: v?.short ?? '', VerifyLong: v?.long ?? '', VerifyTone: v?.tone ?? 'neutral', Cert: d?.CertificateFile ?? '',
    };
  });
  const allX509Rows = (): DataGridRow[] => creds.map((c) => {
    const i = certInfo.get(c.Alias);
    const e = expiry(i);
    const after = certDate(i?.ValidityNotAfter ?? '');
    return {
      Alias: c.Alias, Subject: i ? commonName(i.SubjectDN) : '', SubjectDN: i?.SubjectDN ?? '',
      Issuer: i ? (i.SubjectDN === i.IssuerDN ? 'Self-signed' : commonName(i.IssuerDN)) : '', IssuerDN: i?.IssuerDN ?? '',
      Rank: e.rank, ExpTone: e.tone, ExpLabel: e.label, ExpLong: e.long, Until: after ? when(after) : '—',
      HasPrivateKey: c.HasPrivateKey, Owners: c.OwnerList.filter(Boolean).join(', '), Peers: c.PeerNames.join(' '),
    };
  });
  const matches = (r: DataGridRow): boolean => !query || (tab === 'tls'
    ? [r.Name, r.Description, r.Cert]
    : [r.Alias, r.SubjectDN, r.IssuerDN, r.Peers]).some((f) => String(f ?? '').toLowerCase().includes(query.toLowerCase()));

  // ── Empty states (the header's New button is the action) ──
  const emptyTls = emptyState({
    icon: 'globe', title: 'No TLS configurations yet',
    what: 'Web servers, mirrors, ECP and outgoing requests use a named TLS configuration for their protocol, cipher and certificate settings.',
    docs: { href: docsHref('tls'), label: 'Learn more' },
  });
  const emptyX509 = emptyState({
    icon: 'file-text', title: 'No X.509 credentials yet',
    what: 'A stored certificate, with its private key if needed, signs and encrypts web-service messages.',
    docs: { href: docsHref('x509'), label: 'Learn more' },
  });

  // ── Peek and full view: objectDetail() ──
  interface Obj { kind: Tab; name: string }
  const keyOf = (o: Obj): string => `${o.kind}:${o.name}`;
  const parse = (k: string): Obj => (k.startsWith('x509:') ? { kind: 'x509', name: k.slice(5) } : { kind: 'tls', name: k.replace(/^tls:/, '') });
  const na = muted('Not available');

  const testRows = (name: string): Array<[string, string, string?]> => {
    const t = lastTest.get(name);
    if (!t) return [];
    // IRIS reports "Key: value" lines; the raw request/reply echo isn't useful here.
    const facts = t.info.filter((l) => /^[^:]+:\s*\S/.test(l) && !/^(Request|Reply|Peer):/.test(l));
    return [
      ['Server', mono(`${t.host}:${t.port}`)],
      ['Result', 'Connected'],
      ...facts.map((l): [string, string] => { const [k, ...rest] = l.split(':'); return [k.trim(), mono(rest.join(':').trim())]; }),
      ['Tested', esc(when(t.at))],
    ];
  };
  // The allowed range is the pills themselves (and the strip): no "Allowed" row repeating it.
  const protoBlock = (d: TlsConfig): string => `
    <ul class="proto-list" aria-label="Protocol versions">${PROTOCOLS.map(([b, l]) => {
      const on = b >= d.TLSMinVersion && b <= d.TLSMaxVersion;
      return `<li class="proto${on ? '' : ' proto--off'}" title="${on ? 'Allowed' : 'Not allowed'}">${esc(l)}<span class="sr-only">${on ? ' allowed' : ' not allowed'}</span></li>`;
    }).join('')}</ul>`;
  const cipherBlock = (d: TlsConfig): string => `<dl class="kv-list">
      ${kvBlock('TLS 1.3 cipher suites', d.Ciphersuites.length ? `<span class="mono-lines">${d.Ciphersuites.map((c) => `<span>${esc(c)}</span>`).join('')}</span>` : muted('OpenSSL defaults'))}
      ${kvBlock('TLS 1.2 and earlier', `<span class="mono-lines"><span>${esc(d.CipherList.join(':'))}</span></span>${esc(cipherSentence(d.CipherList))}`)}
    </dl>${d.Type === 1 ? odKv([['Diffie-Hellman key size', d.DiffieHellmanBits ? `${d.DiffieHellmanBits} bits` : 'Automatic']]) : ''}`;
  const verifyRows = (d: TlsConfig): Array<[string, string, string?]> => {
    const v = verifyPeer(d);
    const ca = caFile(d.CAFile);
    return [
      ['Verification', v.tone === 'warning' ? chip(v.short, 'warning') : esc(v.short), v.long],
      ['Trusted authorities', d.CAFile ? esc(ca.short) : muted('—'), ca.full],
      ...(d.CAPath ? [['Trusted authorities folder', mono(d.CAPath), d.CAPath] as [string, string, string]] : []),
      ['Maximum chain length', String(d.VerifyDepth)],
      ['OCSP stapling', d.OCSP ? (d.Type === 1 ? 'Supported' : 'Required') : 'Off'],
    ];
  };
  const certRows = (d: TlsConfig): Array<[string, string, string?]> => [
    ['Certificate file', d.CertificateFile ? mono(baseName(d.CertificateFile)) : muted('—'), d.CertificateFile],
    ...(d.CertificateFile ? [
      ['Private key file', d.PrivateKeyFile ? mono(baseName(d.PrivateKeyFile)) : muted('—'), d.PrivateKeyFile] as [string, string, string],
      ['Key type', KEY_TYPES[d.PrivateKeyType] ?? String(d.PrivateKeyType)] as [string, string],
      ['Key password', '<span class="masked"><ev-icon name="eye-off" size="xs"></ev-icon>Never shown</span>'] as [string, string],
    ] : []),
  ];

  const certBody = (d: TlsConfig): string =>
    (!d.CertificateFile && d.Type !== 1 ? '<p class="kv-text">This client doesn’t present a certificate of its own.</p>' : kvRows(certRows(d)));

  const x509Rows = (c: X509Credential): { cert: Array<[string, string, string?]>; use: Array<[string, string, string?]> } => {
    const i = certInfo.get(c.Alias);
    const from = certDate(i?.ValidityNotBefore ?? '');
    const until = certDate(i?.ValidityNotAfter ?? '');
    const owners = c.OwnerList.filter(Boolean);
    const peers = c.PeerNames.filter(Boolean);
    return {
      cert: [
        ['Issued to', i ? esc(commonName(i.SubjectDN)) : na, i?.SubjectDN],
        ['Issued by', i ? esc(i.SubjectDN === i.IssuerDN ? 'Self-signed' : commonName(i.IssuerDN)) : na, i?.IssuerDN],
        ['Valid from', from ? esc(when(from)) : na],
        ['Valid until', until ? esc(when(until)) : na],
        ['Serial number', i?.SerialNumber ? mono(i.SerialNumber) : na, i?.SerialNumber],
      ],
      use: [
        ['Private key', c.HasPrivateKey ? '<span class="masked"><ev-icon name="eye-off" size="xs"></ev-icon>Stored, never shown</span>' : muted('—')],
        ['Who can use it', owners.length ? esc(owners.join(', ')) : 'Any user', owners.join(', ')],
        ['Peer names', peers.length ? esc(peers.join(', ')) : muted('—'), peers.join(', ')],
        ['Trusted authorities', c.CAFile ? mono(baseName(c.CAFile)) : 'iris.cer (default)', c.CAFile || 'iris.cer in the manager’s directory'],
      ],
    };
  };
  const kvRows = (rows: Array<[string, string, string?]>): string => odKv(rows.map(([k, v, t]) => (t ? [k, v, t] : [k, v]) as [string, string] | [string, string, string]));

  const peekOf = (o: Obj): string => {
    if (o.kind === 'x509') {
      const c = creds.find((x) => x.Alias === o.name);
      if (!c) return '';
      const x = x509Rows(c);
      return odSection('Certificate', kvRows(x.cert)) + odSection('Use', kvRows(x.use));
    }
    const d = tlsDetail.get(o.name);
    const test = testRows(o.name);
    if (!d) return `<p class="detail-note">Settings aren’t available for this configuration.</p>${test.length ? odSection('Connection test', kvRows(test)) : ''}`;
    const server = d.Type === 1;
    return `
      ${odSection('Protocols', protoBlock(d))}
      ${odSection(`Verifying the ${server ? 'client' : 'server'}`, kvRows(verifyRows(d).slice(1)))}
      ${odSection(`${server ? 'Server' : 'Client'} certificate`, certBody(d))}
      ${odSection('Ciphers', cipherBlock(d))}
      ${test.length ? odSection('Connection test', kvRows(test)) : ''}`;
  };
  /** Ports whose superserver encrypts with this server configuration; read once per load, null when it can't be read. */
  let ssRead: Promise<Superserver[] | null> | null = null;
  const portsUsing = async (name: string): Promise<string[] | null> => {
    ssRead ??= getSuperservers().catch(() => null);
    const ss = await ssRead;
    return ss ? ss.filter((x) => x.SSLConfig === name && x.SSLSupportLevel > 0).map((x) => String(x.Port)) : null;
  };
  const fullOf = async (o: Obj): Promise<OdFull> => {
    selected = o.name; // a deep link opens here directly: later loads refresh what's shown
    if (o.kind === 'x509') {
      const c = creds.find((x) => x.Alias === o.name) as X509Credential;
      const i = certInfo.get(c.Alias);
      const e = expiry(i);
      const until = certDate(i?.ValidityNotAfter ?? '');
      const x = x509Rows(c);
      // The strip: derived facts only (time left, lifetime, counts); the cards hold the certificate's own fields.
      const from = certDate(i?.ValidityNotBefore ?? '');
      const left = until ? until.getTime() - Date.now() : NaN;
      const owners = c.OwnerList.filter(Boolean);
      const peers = c.PeerNames.filter(Boolean);
      return {
        strip: [
          { label: 'Time left', value: !until ? '—' : left <= 0 ? 'Expired' : span(left), tone: e.tone === 'success' ? undefined : e.tone, caption: left <= 0 ? esc(`${span(left)} ago`) : '' },
          { label: 'Lifetime', value: from && until ? span(until.getTime() - from.getTime()) : '—', title: 'From the date it became valid to the date it expires' },
          { label: 'Named users', value: owners.length ? String(owners.length) : 'None', title: owners.length ? '' : 'No list of users, so any user may use it' },
          { label: 'Peer names', value: peers.length ? String(peers.length) : 'None' },
        ],
        main: [{ title: 'Certificate', body: kvRows(x.cert) }],
        side: [{ title: 'Use', body: kvRows(x.use) }],
      };
    }
    const s = tls.find((t) => t.Name === o.name) as TlsConfigSummary;
    const d = tlsDetail.get(o.name);
    const test = testRows(o.name);
    if (!d) return { strip: [{ label: 'Versions allowed', value: '—' }, { label: 'TLS 1.3 suites', value: '—' }, { label: 'To review', value: '—' }, { label: s.Type === 'Server' ? 'Ports using it' : 'Last test', value: '—' }], main: [{ title: 'Settings', body: '<p class="detail-note">Settings aren’t available for this configuration.</p>' }], side: [] };
    // The strip: derived facts only (counts and a health check); every setting itself is in a card once.
    const allowed = PROTOCOLS.filter(([b]) => b >= d.TLSMinVersion && b <= d.TLSMaxVersion).length;
    const issues = reviewOf(d);
    const t = lastTest.get(o.name);
    const server = d.Type === 1;
    const ports = server ? await portsUsing(o.name) : null;
    const fourth = server
      ? { label: 'Ports using it', value: ports === null ? '—' : ports.length ? String(ports.length) : 'None', caption: ports?.length ? `<span class="mono">${esc(ports.slice(0, 3).join(', '))}</span>` : '', title: 'Superservers that encrypt their connections with it' }
      : { label: 'Last test', value: t ? 'Connected' : 'Not run', caption: t ? esc(when(t.at)) : '' };
    return {
      strip: [
        { label: 'Versions allowed', value: String(allowed), tone: weakProtocols(d) ? 'warning' : undefined, caption: esc(weakProtocols(d) ? 'some older than TLS 1.2' : 'all TLS 1.2 or newer') },
        { label: 'TLS 1.3 suites', value: d.Ciphersuites.length ? String(d.Ciphersuites.length) : 'Defaults', title: d.Ciphersuites.length ? '' : 'OpenSSL’s default TLS 1.3 cipher suites' },
        { label: 'To review', value: issues.length ? String(issues.length) : 'None', tone: issues.length ? 'warning' : 'success', title: issues.join('\n') },
        fourth,
      ],
      main: [
        { title: `Verifying the ${d.Type === 1 ? 'client' : 'server'}`, body: kvRows(verifyRows(d).slice(1)) },
        { title: 'Ciphers', body: cipherBlock(d) },
      ],
      // Everything the peek shows is here too: the protocol pills lead the side column.
      side: [
        { title: 'Protocols', body: protoBlock(d) },
        { title: `${d.Type === 1 ? 'Server' : 'Client'} certificate`, body: certBody(d) },
        // The strip's Last test says whether and when it connected; the card keeps what was agreed.
        ...(test.length ? [{ title: 'Connection test', body: kvRows(test.filter(([k]) => k !== 'Result' && k !== 'Tested')) }] : []),
      ],
    };
  };

  const od = objectDetail<Obj>(ctx, {
    collection: 'Certificates & TLS', noun: 'configuration',
    panel, detail, list: listView, full: fullEl,
    key: keyOf,
    find: (k) => {
      const o = parse(k);
      return (o.kind === 'tls' ? tls.some((t) => t.Name === o.name) : creds.some((c) => c.Alias === o.name)) ? o : undefined;
    },
    order: () => (tab === 'tls' ? allTlsRows().filter(matches).map((r) => String(r.Name)).sort((a, b) => a.localeCompare(b))
      : allX509Rows().filter(matches).sort((a, b) => Number(a.Rank) - Number(b.Rank)).map((r) => String(r.Alias))).map((n) => `${tab}:${n}`),
    name: (o) => o.name, mono: true,
    meta: (o) => {
      if (o.kind === 'x509') {
        const e = expiry(certInfo.get(o.name));
        return odMeta({ label: e.tone === 'success' ? 'Valid' : e.label, tone: e.tone, title: e.long }, ['X.509 credential', e.tone === 'success' ? e.long : '']);
      }
      const s = tls.find((t) => t.Name === o.name);
      const d = tlsDetail.get(o.name);
      const v = d ? verifyPeer(d) : null;
      // "Server not verified" is said here, once; the protocol range is in the pills and the strip.
      return odMeta(s?.Enabled ? { label: 'Enabled', tone: 'success' } : { label: 'Disabled', tone: 'neutral' },
        [s?.Type ?? ''], [v?.tone === 'warning' ? `<span style="color:var(--ev-color-warning)" title="${esc(v.long)}">${esc(v.short)}</span>` : '']);
    },
    description: (o) => (o.kind === 'tls' ? tls.find((t) => t.Name === o.name)?.Description ?? '' : ''),
    primary: (o) => ({ label: 'Edit', icon: 'edit-2', run: () => { void formHere((full) => void (o.kind === 'tls' ? openTlsEditor(o.name, full) : openX509Editor(o.name, full))); } }),
    menu: (o) => {
      if (o.kind === 'x509') return [{ label: 'Delete…', icon: 'trash-2', danger: true, onSelect: () => void deleteCredential(o.name) }];
      const s = tls.find((t) => t.Name === o.name);
      return [
        ...(s?.Type === 'Client' ? [{ label: 'Test connection…', icon: 'zap', onSelect: () => void formHere((full) => void openTest(o.name, full)) }] : []),
        { label: 'Delete…', icon: 'trash-2', danger: true, disabled: isSystemTlsConfig(o.name), reason: 'Built into IRIS, so it can’t be deleted.', onSelect: () => void deleteConfig(o.name) },
      ];
    },
    peek: peekOf,
    loadFull: fullOf,
    onSelect: (k) => {
      if (k === null && selected !== null && !closingFromCode && od.mode() === 'list') closedByUser(); // the user closed it: don't auto-open again this session
      selected = k ? parse(k).name : null;
      grid?.select(selected !== null ? [selected] : []);
    },
    onPeek: () => applyColumns(),
    // Paging, the breadcrumb or Esc: ask about unsaved changes, then drop a form that took the full view's body.
    canLeave: async () => {
      if (editor && !(await editor.guard())) return false;
      if (formFull) leaveEdit();
      return true;
    },
    widthKey: 'osca-portal:peek-width:security/certs',
  });
  /**
   * Forms open where the user is looking: in the panel from the list; from the full view in the body's
   * place, so the address, title and ‹ › pager stay, and Cancel or Save bring the full view back.
   */
  const formHere = (fn: (full: boolean) => void): void => fn(od.mode() === 'full');

  /** Show the selected row in the peek (or refresh what's shown), unless a form is open. */
  const renderDetail = (): void => {
    if (editor) return;
    if (selected === null) { if (od.selected() !== null) closeDetail(); else setPanel(false); return; }
    const key = `${tab}:${selected}`;
    if (od.selected() === key) od.refresh(); else void od.select(key);
  };

  // ── Toolbar, grid, footer ──
  const renderToolbar = (): void => {
    setViewTabCount(ctx.body, 'cert-tabs', 'tls', tls.length);
    setViewTabCount(ctx.body, 'cert-tabs', 'x509', creds.length);
    // Expiry is said once: in the Expiry column (and the notice line for expired ones), not again as toolbar pills.
    setSearch($('#cert-search'), tab === 'tls' ? tls.length : creds.length, { query });
  };

  const renderGrid = (): void => {
    const all = tab === 'tls' ? allTlsRows() : allX509Rows();
    if (all.length === 0) {
      grid = null; gridTab = null;
      closeDetail();
      wrap.innerHTML = tab === 'tls' ? emptyTls : emptyX509;
      return;
    }
    if (!grid || gridTab !== tab) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', tab === 'tls' ? 'Name' : 'Alias');
      grid.setAttribute('sort-column', tab === 'tls' ? 'Name' : 'Rank');
      grid.setAttribute('sort-direction', 'asc');
      grid.columns = tab === 'tls' ? TLS_COLUMNS : X509_COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', async (e) => {
        const row = (e as CustomEvent<{ row: DataGridRow }>).detail.row;
        if (!(await mayLeave())) { if (selected !== null) grid?.select([selected]); return; }
        selected = String(tab === 'tls' ? row.Name : row.Alias);
        wrap.querySelector('.grid-hint')?.remove();
        void od.select(`${tab}:${selected}`);
      });
      wrap.appendChild(grid);
      gridTab = tab;
    }
    // Hide columns that don't tell rows apart (identical or blank on every row), once there are enough rows for that to mean something.
    const keys = tab === 'tls' ? TLS_UNIFORM : X509_UNIFORM;
    // pruneColumns: a column empty on every row goes however few rows there are (the footer says so);
    // one identical on every row goes only once there are enough rows for that to mean something.
    const cols = (tab === 'tls' ? TLS_COLUMNS : X509_COLUMNS).filter((c) => keys.includes(c.key));
    const { dropped } = pruneColumns(all, cols);
    const empty = (k: string): boolean => all.every((r) => r[k] === '' || r[k] === undefined || r[k] === null);
    uniform = new Set(dropped.filter((k) => empty(k) || all.length >= MIN_ROWS_TO_HIDE));
    const rows = all.filter(matches);
    grid.rows = rows;
    applyColumns();
    if (selected !== null) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    wrap.querySelector('.grid-hint')?.remove();
    if (rows.length === 0) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">Nothing matches “${esc(query)}”.</div>`);
  };

  const renderFoot = (): void => {
    const clients = tls.filter((t) => t.Type === 'Client').length;
    const servers = tls.length - clients;
    const disabled = tls.filter((t) => !t.Enabled).length;
    const keys = creds.filter((c) => c.HasPrivateKey).length;
    const sep = '<span class="meta-sep">·</span>';
    const foot = $('#cert-foot');
    foot.hidden = (tab === 'tls' ? tls.length : creds.length) === 0;
    foot.innerHTML = tab === 'tls'
      ? `<b>${tls.length}</b> TLS configuration${tls.length === 1 ? '' : 's'}${sep}<b>${clients}</b> client${sep}<b>${servers}</b> server${disabled ? `${sep}<b>${disabled}</b> disabled` : ''}${tls.length && ![...tlsDetail.values()].some((d) => d.CertificateFile) ? `${sep}No certificates attached` : ''}`
      : `<b>${creds.length}</b> X.509 credential${creds.length === 1 ? '' : 's'}${sep}<b>${keys}</b> with a private key`;
  };

  const render = (): void => {
    if (!loaded) return;
    renderToolbar();
    setNewLabel();
    if (!editor) renderDetail(); // never clobber an open test form on refresh
    renderGrid();
    renderFoot();
  };

  const selectTab = (next: Tab): void => {
    ctx.body.querySelectorAll<HTMLButtonElement>('#cert-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.value === next)));
    tab = next;
  };

  // The one Security banner: expired credentials here, otherwise the shared instance-wide risk.
  let graph: SecurityGraph | null = null;
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  const banner = (): void => {
    if (!alive) return;
    const expired = creds.filter((c) => expiry(certInfo.get(c.Alias)).tone === 'danger').length;
    mountSecurityBanner(ctx.banners, graph, expired ? {
      tone: 'danger',
      headline: `${expired} stored X.509 credential${expired === 1 ? ' has' : 's have'} expired, so anything that signs, encrypts or connects with ${expired === 1 ? 'it' : 'them'} fails.`,
      detail: `Anything that signs, encrypts or connects with ${expired === 1 ? 'it' : 'them'} fails until the certificate is replaced.`,
      showThem: { label: 'Show them', run: () => ctx.body.querySelector<HTMLButtonElement>('#cert-tabs button[data-value="x509"]')?.click() },
    } : null);
  };
  getSecurityGraph().then((g) => { graph = g; banner(); }).catch(() => { /* Review loads it on demand */ });

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  const load = async (): Promise<void> => {
    ssRead = null; // the strip's "Ports using it" is read again with everything else
    try {
      [tls, creds] = await Promise.all([getTlsConfigs(), getX509Credentials()]);
      // Details fill the protocol, verification and expiry columns; one failure blanks only its row.
      const [tlsD, certD] = await Promise.all([
        Promise.allSettled(tls.map((t) => getTlsConfig(t.Name))),
        Promise.allSettled(creds.map((c) => getX509CertInfo(c.Alias))),
      ]);
      tlsDetail.clear(); certInfo.clear();
      tlsD.forEach((r, i) => { if (r.status === 'fulfilled') tlsDetail.set(tls[i].Name, r.value); });
      certD.forEach((r, i) => { if (r.status === 'fulfilled') certInfo.set(creds[i].Alias, r.value); });
      // Open on whichever list has something in it.
      const first = !loaded;
      if (first && ((tls.length === 0 && creds.length > 0) || ctx.param?.startsWith('x509:'))) selectTab('x509');
      loaded = true;
      updated(new Date());
      // A short list opens its first row, so the page shows the object instead of empty space (the address is left alone).
      if (first && selected === null && !wasClosed() && !ctx.param) {
        const keys = tab === 'tls' ? tls.map((t) => t.Name).sort((a, b) => a.localeCompare(b)) : creds.map((x) => x.Alias);
        if (keys.length && keys.length <= 3) selected = keys[0];
      }
      render();
      if (first) od.refresh(); // a deep link (#/security/certs/tls:<name>) opens its full view now
      else if (od.mode() === 'full' && !editor) od.refresh();
      banner();
    } catch (err) {
      grid = null; gridTab = null;
      wrap.innerHTML = errorPanel(err, 'retry-cert');
      wrap.querySelector('#retry-cert')?.addEventListener('click', () => void load());
    }
  };

  bindViewTabs(ctx.body, 'cert-tabs', async (value) => {
    const next = value as Tab;
    if (next === tab) return;
    if (!(await mayLeave())) { selectTab(tab); return; }
    closeDetail();
    tab = next;
    render();
  });
  $('#cert-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });

  void load();
}
