// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › LDAP configurations — the directories IRIS signs users in
 * against (LDAP and Active Directory): which servers, where users and groups
 * live, which search account IRIS binds with, and which directory attributes
 * give a user their roles, namespace and routine.
 *
 * List + peek + full view (objectDetail). Create, edit, set the search
 * password (write-only), test a sign-in (nothing stored), delete.
 */
import '../styles-security.css';
import '../styles-sec.css';
import '../styles-services.css';
import {
  getLdapConfigs, getLdapConfig, ldapExists, saveLdapConfig, setLdapSearchPassword, deleteLdapConfig, testLdapSignIn,
  LDAP_FLAG, hasFlag, type LdapSummary, type LdapConfig,
} from '../api-ldap';
import { getInfo } from '../api';
import { getServices, getWebAuth } from '../api-services';
import { getUserList } from '../api-security';
import {
  esc, cell, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, objectDetail, odMeta, odSection, odKv, status,
  setSearch, type ScreenCtx, type GridColumn, type OdFull,
} from '../ui';
import {
  newButton, confirm, toast, errorText, editorShell, panelWidth, section, textField, passwordField, checkField, pathField,
  readForm, fieldError, AdminError, type FieldProblem, type EditorHandle, type FormValues,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

const NO_PRIV = noPermissionText('%Admin_Secure', 'security administration');
const DOCS = 'https://docs.intersystems.com/irislatest/csp/docbook/DocBook.UI.Page.cls?KEY=ROARS_iam_ldap';
const CERTS = [{ label: 'Certificates', patterns: ['*.pem', '*.cer', '*.crt'] }];
/** Configuration names are the directory's domain (user@domain picks it at sign-in). */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

const COLUMNS: GridColumn[] = [
  { key: 'Name', label: 'Domain', width: '240px', sortable: true, renderCell: (v) => cell.id(v) },
  { key: 'Enabled', label: 'Status', width: '120px', sortable: true,
    renderCell: (v) => (v ? status('Enabled', 'success') : status('Disabled', 'neutral', 'Users of this domain can’t sign in with it', { dim: true })) },
  { key: 'Servers', label: 'Servers', width: '260px', sortable: true, renderCell: (v) => (v ? cell.ref(v, undefined, String(v)) : `<span title="${NO_SERVER}">${cell.dim('Not set')}</span>`) },
  { key: 'Description', label: 'Description', sortable: true, renderCell: (v) => (v ? cell.text(v, String(v)) : '') },
];
const SECONDARY = ['Description', 'Servers'];

/** IRIS fills an unset server list with the placeholder "UNKNOWN": no server has been entered yet. */
const realHosts = (c: LdapConfig | undefined): string[] => (c?.LDAPHostNames ?? []).filter((h) => h && h.toUpperCase() !== 'UNKNOWN');
const NO_SERVER = 'No server entered yet, so nobody can sign in with it';
const hostList = (v: unknown): string[] => String(v ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:]+\](:\d{1,5})?$/;
/* "What changes" in the editor: one line per edited field, saved → new. */
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
const previewNote = (title: string, text: string): string =>
  `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>${esc(title)}.</strong> ${esc(text)}</div></div>`;
const kindOf = (c: LdapConfig): string => (hasFlag(c.LDAPFlags, LDAP_FLAG.activeDirectory) ? 'Active Directory' : 'LDAP');

export function ldapScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="od-list sec-list" id="ldap-list-view">
      <div class="toolbar-row" id="ldap-toolbar">
        <div class="search-box"><ev-search id="ldap-search" size="sm" full-width placeholder="Filter by domain or server" aria-label="Filter"></ev-search></div>
      </div>
      <ev-detail-panel id="ldap-panel" detail-width="500" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="ldap-wrap">${skeleton(4)}</div>
        <aside slot="detail" class="detail" id="ldap-detail" aria-label="LDAP configuration details"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="ldap-foot"></p>
    </div>
    <div id="ldap-full" hidden></div>`;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#ldap-panel');
  const wrap = $('#ldap-wrap');
  const detail = $('#ldap-detail');
  const listView = $('#ldap-list-view');
  const fullEl = $('#ldap-full');
  const searchEl = $<HTMLElement & { value: string }>('#ldap-search');

  let list: LdapSummary[] = [];
  const details = new Map<string, LdapConfig>();
  let grid: GridEl | null = null;
  let selected: string | null = null;
  let query = '';
  let alive = true;
  let canSecure: boolean | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let opened = false;
  // Where the open form lives: the list's panel, or (from the full view) the full view's body.
  let formFull = false;
  let formEl: HTMLElement = detail;
  const leaveEdit = (): void => {
    ctx.beforeLeave(null); editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null;
    formFull = false; formEl = detail;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });
  const AUTO_KEY = 'osca-portal:auto-peek-closed:security/ldap';
  const wasClosed = (): boolean => { try { return sessionStorage.getItem(AUTO_KEY) === '1'; } catch { return false; } };
  const closedByUser = (): void => { try { sessionStorage.setItem(AUTO_KEY, '1'); } catch { /* storage blocked: it opens again next visit */ } };
  const blocked = (): string | null => (canSecure === false ? NO_PRIV : null);

  const rowOf = (s: LdapSummary): DataGridRow => ({
    Name: s.Name, Enabled: s.Enabled, Description: s.Description, Servers: realHosts(details.get(s.Name)).join(' '),
  });
  const visible = (): LdapSummary[] => list.filter((s) => !query || [s.Name, s.Description, ...realHosts(details.get(s.Name))]
    .some((f) => String(f ?? '').toLowerCase().includes(query.toLowerCase())));

  const applyColumns = (): void => {
    if (!grid) return;
    const anyDesc = list.some((s) => s.Description);
    for (const c of COLUMNS) grid.setColumnVisible(c.key, !(panel.open && SECONDARY.includes(c.key)) && !(c.key === 'Description' && !anyDesc));
  };
  const setPanel = (open: boolean): void => { if (panel.open !== open) { panel.open = open; applyColumns(); } };

  const renderGrid = (): void => {
    setSearch(searchEl, list.length, { query });
    if (!list.length) {
      grid = null;
      wrap.innerHTML = emptyState({
        icon: 'users', title: 'No LDAP configurations',
        what: 'An LDAP configuration lets people sign in with their directory account (LDAP or Active Directory), with roles taken from the directory.',
        docs: { href: DOCS, label: 'Learn more' },
      });
      return;
    }
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'LDAP configurations');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        void (async () => {
          if (editor && !(await editor.guard())) { grid?.select(selected ? [selected] : []); return; }
          leaveEdit();
          selected = name;
          await od.select(name);
        })();
      });
      wrap.appendChild(grid);
    }
    const rows = visible().map(rowOf);
    grid.rows = rows;
    applyColumns();
    if (selected) grid.select([selected]);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">Nothing matches “${esc(query)}”.</div>`);
  };
  const renderFoot = (): void => {
    const on = list.filter((s) => s.Enabled).length;
    $('#ldap-foot').innerHTML = list.length
      ? `<b>${list.length}</b> configuration${list.length === 1 ? '' : 's'}<span class="meta-sep">·</span><b>${on}</b> enabled`
      : '';
  };

  /* ── Peek and full view ── */

  const mono = (v: string): string => (v ? `<span class="mono">${esc(v)}</span>` : '<span class="dim">—</span>');
  const secs = (n: number): string => (Number(n) ? `${n} s` : '—');
  // "TLS off" is said once, in the status line; TLS on is a row here.
  const serverRows = (c: LdapConfig): Array<[string, string, string?]> => [
    ['Servers', realHosts(c).length ? realHosts(c).map((h) => mono(h)).join(', ') : '<span class="dim">Not set</span>', realHosts(c).join(' ') || NO_SERVER],
    ...(hasFlag(c.LDAPFlags, LDAP_FLAG.tls) ? [['TLS', 'On (LDAPS)'] as [string, string]] : []),
    ...(c.LDAPCACertFile ? [['Trusted authorities file', mono(c.LDAPCACertFile), c.LDAPCACertFile] as [string, string, string]] : []),
    ['Timeouts', `${secs(c.LDAPServerTimeout)} server · ${secs(c.LDAPClientTimeout)} client`],
  ];
  const directoryRows = (c: LdapConfig): Array<[string, string, string?]> => [
    ['Users under', mono(c.LDAPBaseDN), c.LDAPBaseDN],
    ['Groups under', mono(c.LDAPBaseDNForGroups), c.LDAPBaseDNForGroups],
    ['Username attribute', mono(c.LDAPUniqueDNIdentifier)],
    ['Search account', mono(c.LDAPSearchUsername), c.LDAPSearchUsername],
    ['Search password', '<span class="masked"><ev-icon name="eye-off" size="xs"></ev-icon>Never shown</span>'],
  ];
  const attributeRows = (c: LdapConfig): Array<[string, string, string?]> => [
    ['Roles', mono(c.LDAPAttributeRoles)],
    ['Namespace', mono(c.LDAPAttributeNameSpace)],
    ['Routine', mono(c.LDAPAttributeRoutine)],
    ['Full name', mono(c.LDAPAttributeFullName)],
    ['Email', mono(c.LDAPAttributeMail)],
  ];
  const kv = (rows: Array<[string, string, string?]>): string => odKv(rows.map(([k, v, t]) => (t ? [k, v, t] : [k, v]) as [string, string] | [string, string, string]));
  const groupsText = (c: LdapConfig): string => (hasFlag(c.LDAPFlags, LDAP_FLAG.groups)
    ? `Roles from groups${hasFlag(c.LDAPFlags, LDAP_FLAG.nestedGroups) ? ', nested groups included' : ''}`
    : 'Roles from the roles attribute');

  const loadDetail = async (name: string): Promise<LdapConfig> => {
    const c = await getLdapConfig(name);
    details.set(name, c);
    return c;
  };
  const peekOf = async (s: LdapSummary): Promise<string> => {
    const c = await loadDetail(s.Name);
    return odSection('Connection', kv(serverRows(c)))
      + odSection('Directory', kv(directoryRows(c)))
      + odSection('Attributes', kv(attributeRows(c)));
  };
  /**
   * What the rest of the instance says about LDAP sign-in, for the full view's strip: whether it's
   * switched on instance-wide, which services allow it, and how many LDAP users exist. Read once.
   */
  interface Around { ldapOn: boolean | null; services: string[] | null; users: number | null }
  let around: Promise<Around> | null = null;
  const aroundOf = (): Promise<Around> => (around ??= Promise.allSettled([getWebAuth(), getServices(), getUserList()]).then(([w, sv, u]) => ({
    ldapOn: w.status === 'fulfilled' ? !!w.value.AutheLDAP : null,
    services: sv.status === 'fulfilled' ? sv.value.filter((x) => x.Enabled && x.AuthenticationMethods.some((m) => /ldap/i.test(m))).map((x) => x.Name).sort() : null,
    users: u.status === 'fulfilled' ? u.value.filter((x) => /ldap/i.test(x.Type)).length : null,
  })));
  // The strip carries only what the cards and the status line don't: counts, and how the rest of the instance treats LDAP.
  const fullOf = async (s: LdapSummary): Promise<OdFull> => {
    selected = s.Name; // a deep link opens here directly: later loads refresh what's shown
    const [c, a] = await Promise.all([loadDetail(s.Name), aroundOf()]);
    const hosts = realHosts(c);
    const svc = a.services;
    return {
      strip: [
        { label: 'Servers', value: hosts.length ? String(hosts.length) : 'None', tone: hosts.length ? undefined : 'warning',
          caption: esc(hosts.length > 1 ? 'tried in order' : hosts.length ? '' : 'nobody can sign in yet'), title: hosts.length ? '' : NO_SERVER },
        { label: 'LDAP sign-in', value: a.ldapOn === null ? '—' : a.ldapOn ? 'Allowed' : 'Off', tone: a.ldapOn === false ? 'warning' : undefined,
          caption: esc('for the whole instance'), title: a.ldapOn === false ? 'LDAP sign-in is switched off for the whole instance, so no configuration is used' : '' },
        { label: 'Services that allow it', value: svc === null ? '—' : svc.length ? String(svc.length) : 'None',
          caption: svc?.length ? `<span class="mono">${esc(svc.slice(0, 2).join(', '))}</span>${svc.length > 2 ? esc(` and ${svc.length - 2} more`) : ''}` : '', title: svc?.join(', ') ?? '' },
        { label: 'LDAP users', value: a.users === null ? '—' : a.users ? String(a.users) : 'None', caption: esc('created at their first sign-in'),
          title: 'IRIS accounts created when someone first signed in through LDAP (any domain)' },
      ],
      main: [
        { title: 'Directory', body: kv(directoryRows(c)) },
        { title: 'Attributes', body: kv(attributeRows(c)) },
      ],
      side: [
        { title: 'Connection', body: kv(serverRows(c)) },
      ],
    };
  };

  const od = objectDetail<LdapSummary>(ctx, {
    collection: 'LDAP', noun: 'configuration',
    panel, detail, list: listView, full: fullEl,
    key: (s) => s.Name,
    find: (k) => list.find((s) => s.Name === k) ?? list.find((s) => s.Name.toLowerCase() === k.toLowerCase()),
    order: () => visible().map((s) => s.Name).sort((a, b) => a.localeCompare(b)),
    name: (s) => s.Name, mono: true,
    meta: (s) => {
      const c = details.get(s.Name);
      return odMeta(s.Enabled ? { label: 'Enabled', tone: 'success' } : { label: 'Disabled', tone: 'neutral', title: 'Users of this domain can’t sign in with it' },
        c ? [kindOf(c), groupsText(c)] : [], c && !hasFlag(c.LDAPFlags, LDAP_FLAG.tls) ? ['<span style="color:var(--ev-color-warning)" title="Passwords reach the directory unencrypted">TLS off</span>'] : []);
    },
    description: (s) => s.Description,
    primary: (s) => ({ label: 'Edit', icon: 'edit-2', blocked: blocked(), run: () => { void formHere((full) => void openEditor(s.Name, full)); } }),
    menu: (s) => [
      { label: 'Test a sign-in…', icon: 'zap', disabled: !!blocked(), reason: NO_PRIV, onSelect: () => { void formHere((full) => openTest(s.Name, full)); } },
      { label: 'Set search password…', icon: 'key-round', disabled: !!blocked(), reason: NO_PRIV, onSelect: () => { void formHere((full) => openPassword(s.Name, full)); } },
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!blocked(), reason: NO_PRIV, onSelect: () => void doDelete(s.Name) },
    ],
    peek: peekOf,
    loadFull: fullOf,
    onSelect: (k) => {
      if (k === null && selected !== null && od.mode() === 'list') closedByUser(); // closed: don't auto-open again this session
      selected = k; grid?.select(k ? [k] : []);
    },
    onPeek: () => applyColumns(),
    // Paging, the breadcrumb or Esc: ask about unsaved changes, then drop a form that took the full view's body.
    canLeave: async () => {
      if (editor && !(await editor.guard())) return false;
      if (formFull) leaveEdit();
      return true;
    },
    widthKey: 'osca-portal:peek-width:security/ldap',
  });
  /**
   * Forms open where the user is looking: in the panel from the list; from the full view
   * (#/security/ldap/<domain>) in the body's place, so the address, title and ‹ › pager stay,
   * and Cancel or Save bring the full view back. An open form is asked about first.
   */
  const formHere = async (fn: (full: boolean) => void): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    fn(od.mode() === 'full');
  };
  /** Show the selected configuration (or refresh what's shown), unless a form is open. */
  const renderDetail = (): void => {
    if (editor) return;
    if (selected === null) { if (od.selected() !== null) void od.select(null); else setPanel(false); return; }
    if (od.selected() === selected) od.refresh(); else void od.select(selected);
  };
  /** Close the form; one in the full view's body gives it back (skeleton until the fresh read lands). */
  const endForm = (): void => {
    const full = formFull;
    leaveEdit();
    if (full) fullEl.innerHTML = '';
  };
  const back = (): void => { endForm(); renderDetail(); };
  const openForm = (opts: Parameters<typeof editorShell>[1], full = false): void => {
    leaveEdit();
    formFull = full;
    formEl = full ? fullEl : detail;
    if (!full) {
      setPanel(true);
      restoreWidth = panelWidth(panel, 560);
    }
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    editor = editorShell(formEl, opts);
  };

  /* ── Create and edit ── */

  const openEditor = async (name: string | null, full = false): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    const inFull = full && !!name;
    const host = inFull ? fullEl : detail;
    let c: LdapConfig | undefined;
    if (name) {
      try { c = await loadDetail(name); } catch (err) { toast(errorText(err), 'danger'); return; }
      // The user paged or went back to the list while the read was out.
      if (inFull && (od.mode() !== 'full' || od.selected() !== name)) return;
    } else { selected = null; grid?.select([]); }
    const f = c?.LDAPFlags ?? (LDAP_FLAG.enabled | LDAP_FLAG.tls);
    const flag = (bit: number): boolean => hasFlag(f, bit);
    openForm({
      // The full view's title already names the configuration.
      title: inFull ? 'Edit settings' : name ? `Edit <span class="mono">${esc(name)}</span>` : 'New LDAP configuration',
      name: name ?? 'the new configuration',
      submitLabel: name ? 'Save changes' : 'Create configuration',
      sections:
        section('General',
          (name ? '' : textField('Name', 'Domain', '', { required: true, mono: true, maxlength: 128, placeholder: 'e.g. example.com', hint: 'People sign in as user@domain; this name picks the configuration.' })) +
          textField('Description', 'Description', c?.Description ?? '') +
          checkField('Enabled', 'Enabled', flag(LDAP_FLAG.enabled), { toggle: true, hint: 'While it’s off, nobody can sign in with this directory.' }) +
          checkField('AD', 'The server is Active Directory', flag(LDAP_FLAG.activeDirectory))) +
        section('Servers',
          textField('Hosts', 'Servers', realHosts(c).join(' '), { required: true, mono: true, placeholder: 'e.g. ldap1.example.com:636 ldap2.example.com', hint: 'Host names, with :port when it isn’t the default. Separate several with spaces; they’re tried in order.' }) +
          checkField('TLS', 'Use TLS (LDAPS)', flag(LDAP_FLAG.tls), { hint: 'Without it, passwords reach the directory unencrypted.' }) +
          pathField('CAFile', 'Trusted authorities file', c?.LDAPCACertFile ?? '', { mode: 'file', filters: CERTS, title: 'Choose the trusted authorities file', hint: 'PEM file of the certificates that sign the server’s certificate (UNIX servers). Optional.' })) +
        section('Directory',
          textField('BaseDN', 'Users under (base DN)', c?.LDAPBaseDN ?? '', { required: true, mono: true, placeholder: 'e.g. DC=example,DC=com' }) +
          textField('GroupsDN', 'Groups under', c?.LDAPBaseDNForGroups ?? '', { mono: true, placeholder: 'Same as users', hint: 'Empty uses the users’ base DN.' }) +
          textField('UniqueId', 'Username attribute', c?.LDAPUniqueDNIdentifier ?? 'sAMAccountName', { required: true, mono: true, hint: 'The attribute that holds what people type as their username (sAMAccountName, uid…).' }) +
          textField('SearchUser', 'Search account', c?.LDAPSearchUsername ?? '', { required: true, mono: true, placeholder: 'e.g. CN=iris-search,OU=Service,DC=example,DC=com', hint: 'IRIS binds as this account to look people up.' }) +
          passwordField('SearchPassword', name ? 'New search password' : 'Search password', { hint: name ? 'Leave empty to keep the current one. It’s never shown.' : 'Stored by IRIS and never shown again.' })) +
        section('Roles and attributes',
          checkField('Groups', 'Take roles from directory groups', flag(LDAP_FLAG.groups)) +
          checkField('Nested', 'Include nested groups', flag(LDAP_FLAG.nestedGroups)) +
          textField('AttrRoles', 'Roles attribute', c?.LDAPAttributeRoles ?? 'intersystems-Roles', { mono: true }) +
          textField('AttrNs', 'Namespace attribute', c?.LDAPAttributeNameSpace ?? 'intersystems-Namespace', { mono: true }) +
          textField('AttrRoutine', 'Routine attribute', c?.LDAPAttributeRoutine ?? 'intersystems-Routine', { mono: true })) +
        `<details class="sec-adv sec-adv--gutter"><summary>Timeouts</summary>
          <div class="crud-row">${textField('ServerTimeout', 'Server timeout (s)', String(c?.LDAPServerTimeout ?? 60), { mono: true, width: '120px' })}${textField('ClientTimeout', 'Client timeout (s)', String(c?.LDAPClientTimeout ?? 180), { mono: true, width: '120px' })}</div>
        </details>` +
        section('What changes', '<div id="ldap-preview" class="svc-preview" aria-live="polite"></div>'),
      check: () => {
        const v = readForm(host);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Domain', message: 'Enter the domain' });
          else if (!NAME_RE.test(n)) out.push({ field: 'Name', label: 'Domain', message: 'Use letters, digits, dots, dashes or underscores' });
          else if (list.some((s) => s.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Domain', message: 'A configuration for this domain already exists' });
        }
        const hosts = hostList(v.Hosts);
        if (!hosts.length) out.push({ field: 'Hosts', label: 'Servers', message: 'Enter at least one server' });
        else if (hosts.some((h) => !HOST_RE.test(h))) out.push({ field: 'Hosts', label: 'Servers', message: 'Use host or host:port, separated by spaces' });
        if (!String(v.BaseDN ?? '').trim()) out.push({ field: 'BaseDN', label: 'Users under', message: 'Enter the base DN' });
        if (!String(v.UniqueId ?? '').trim()) out.push({ field: 'UniqueId', label: 'Username attribute', message: 'Enter the attribute' });
        if (!String(v.SearchUser ?? '').trim()) out.push({ field: 'SearchUser', label: 'Search account', message: 'Enter the account IRIS searches with' });
        for (const [k, label] of [['ServerTimeout', 'Server timeout'], ['ClientTimeout', 'Client timeout']] as const) {
          const n = Number(String(v[k] ?? '').trim());
          if (!Number.isInteger(n) || n < 1 || n > 3600) out.push({ field: k, label, message: 'Enter whole seconds from 1 to 3600' });
        }
        return out;
      },
      onSubmit: async (v: FormValues) => {
        const target = name ?? String(v.Name).trim();
        if (!name && await ldapExists(target)) {
          fieldError(host, 'Name', 'A configuration for this domain already exists');
          throw new AdminError('A configuration for this domain already exists.', 409);
        }
        // Keep the bits this form doesn't show (universal groups, Kerberos only).
        let flags = f & (LDAP_FLAG.universalGroups | LDAP_FLAG.kerberosOnly);
        if (v.Enabled) flags |= LDAP_FLAG.enabled;
        if (v.AD) flags |= LDAP_FLAG.activeDirectory;
        if (v.TLS) flags |= LDAP_FLAG.tls;
        if (v.Groups) flags |= LDAP_FLAG.groups;
        if (v.Nested) flags |= LDAP_FLAG.nestedGroups;
        const baseDN = String(v.BaseDN).trim();
        await saveLdapConfig(target, {
          Description: String(v.Description ?? '').trim(),
          LDAPHostNames: hostList(v.Hosts),
          LDAPCACertFile: String(v.CAFile ?? '').trim(),
          LDAPBaseDN: baseDN,
          LDAPBaseDNForGroups: String(v.GroupsDN ?? '').trim() || baseDN,
          LDAPUniqueDNIdentifier: String(v.UniqueId).trim(),
          LDAPSearchUsername: String(v.SearchUser).trim(),
          LDAPAttributeRoles: String(v.AttrRoles ?? '').trim(),
          LDAPAttributeNameSpace: String(v.AttrNs ?? '').trim(),
          LDAPAttributeRoutine: String(v.AttrRoutine ?? '').trim(),
          LDAPServerTimeout: Number(v.ServerTimeout),
          LDAPClientTimeout: Number(v.ClientTimeout),
          LDAPFlags: flags,
        });
        let note = '';
        if (v.SearchPassword) {
          try { await setLdapSearchPassword(target, String(v.SearchPassword)); } catch (err) { note = ` The search password wasn’t saved: ${errorText(err)}`; }
        }
        endForm();
        selected = target;
        await load();
        toast(`${name ? `${target} saved` : `LDAP configuration ${target} created`}.${note}`, note ? 'warning' : 'success');
      },
      onCancel: () => { if (formFull) { back(); return; } leaveEdit(); if (selected) renderDetail(); else setPanel(false); },
    }, inFull);
    // What changes: each edited field, saved value → new value; a new configuration says what it creates.
    const ed = editor;
    if (!ed) return;
    const FIELDS: PreviewField[] = [
      { key: 'Description', label: 'Description' }, { key: 'Enabled', label: 'Enabled' }, { key: 'AD', label: 'Active Directory' },
      { key: 'Hosts', label: 'Servers', show: (x) => hostList(x).join(', ') || 'none' }, { key: 'TLS', label: 'TLS' }, { key: 'CAFile', label: 'Trusted authorities file' },
      { key: 'BaseDN', label: 'Users under' }, { key: 'GroupsDN', label: 'Groups under' }, { key: 'UniqueId', label: 'Username attribute' },
      { key: 'SearchUser', label: 'Search account' }, { key: 'SearchPassword', label: 'Search password', secret: true },
      { key: 'Groups', label: 'Roles from groups' }, { key: 'Nested', label: 'Nested groups' },
      { key: 'AttrRoles', label: 'Roles attribute' }, { key: 'AttrNs', label: 'Namespace attribute' }, { key: 'AttrRoutine', label: 'Routine attribute' },
      { key: 'ServerTimeout', label: 'Server timeout (s)' }, { key: 'ClientTimeout', label: 'Client timeout (s)' },
    ];
    let before: FormValues | null = null;
    const update = (): void => {
      const v = readForm(host);
      const lines = name
        ? (before ? diffLines(before, v, FIELDS) : [])
        : [`People who sign in as user@${String(v.Name ?? '').trim() || '…'} are checked against ${hostList(v.Hosts).join(', ') || '…'}${v.Enabled ? '' : ' once it’s enabled'}.`];
      const warn = v.TLS || (name && before?.TLS === false) ? '' : previewNote('Passwords reach the directory unencrypted', 'TLS is off for this configuration.');
      const box = host.querySelector('#ldap-preview');
      if (box) box.innerHTML = previewHtml(lines) + warn;
    };
    for (const t of PREVIEW_EVENTS) ed.form.addEventListener(t, () => { if (editor === ed) update(); });
    update();
    requestAnimationFrame(() => { if (editor === ed) { before = readForm(host); update(); } });
  };

  /** Write-only: a new password for the search account. */
  const openPassword = (name: string, full = false): void => {
    const host = full ? fullEl : detail;
    openForm({
      title: full ? 'Set search password' : `Search password for <span class="mono">${esc(name)}</span>`,
      name,
      submitLabel: 'Set password',
      sections: section('Password', passwordField('Pw', 'Password', { required: true }) + passwordField('Pw2', 'Confirm'),
        { hint: 'Replaces the stored password of the search account. It’s never shown.' }),
      check: () => {
        const v = readForm(host);
        if (!v.Pw) return [{ field: 'Pw', label: 'Password', message: 'Enter the password' }];
        if (!v.Pw2) return [{ field: 'Pw2', label: 'Confirm', message: 'Enter it again' }];
        if (v.Pw !== v.Pw2) return [{ field: 'Pw2', label: 'Confirm', message: 'The two don’t match' }];
        return [];
      },
      onSubmit: async (v) => {
        await setLdapSearchPassword(name, String(v.Pw));
        back();
        toast(`Search password set for ${name}.`);
      },
      onCancel: back,
    }, full);
  };

  /**
   * Test a sign-in through IRIS's LDAP authentication. IRIS chooses the
   * configuration by the domain after "@", so the username must end in this
   * one's. Nothing is stored; the password goes to IRIS once.
   */
  const openTest = (name: string, full = false): void => {
    let result: string[] | null = null;
    const box = full ? fullEl : detail;
    openForm({
      title: full ? 'Test a sign-in' : `Test a sign-in with <span class="mono">${esc(name)}</span>`,
      name,
      submitLabel: 'Run test',
      submitAlways: true,
      sections: section('Directory account',
        textField('User', 'Username', '', { required: true, mono: true, placeholder: `e.g. jane@${name}`, hint: `Must end in @${name}: IRIS picks the configuration by that domain.` }) +
        passwordField('Pw', 'Password', { required: true, hint: 'Used for this test only; not stored.' }),
        { hint: 'IRIS signs in as this account the way a real sign-in would and reports each step. Nothing is changed.' }) +
        '<div id="ldap-test-out" class="svc-preview" aria-live="polite"></div>',
      check: () => {
        const v = readForm(box);
        const u = String(v.User ?? '').trim();
        const out: FieldProblem[] = [];
        if (!u) out.push({ field: 'User', label: 'Username', message: 'Enter a directory username' });
        else if (!u.toLowerCase().endsWith(`@${name.toLowerCase()}`)) out.push({ field: 'User', label: 'Username', message: `End it with @${name}` });
        if (!v.Pw) out.push({ field: 'Pw', label: 'Password', message: 'Enter the password' });
        return out;
      },
      onSubmit: async (v) => {
        const host = box.querySelector<HTMLElement>('#ldap-test-out');
        if (host) host.innerHTML = '<p class="svc-preview-head">Testing…</p>';
        try {
          result = await testLdapSignIn(String(v.User).trim(), String(v.Pw), 45000);
        } catch (err) {
          if (host) host.innerHTML = `<p class="svc-preview-head">Couldn’t test</p><p>${esc(errorText(err))}</p>`;
          throw err;
        } finally {
          const pw = box.querySelector<HTMLElement & { value: string }>('ev-input[name="Pw"]');
          if (pw) pw.value = '';
        }
        if (host) host.innerHTML = `<p class="svc-preview-head">Result</p>${result.length ? `<ul>${result.map((l) => `<li class="mono">${esc(l)}</li>`).join('')}</ul>` : '<p>IRIS reported nothing back.</p>'}`;
        editor?.markClean();
      },
      onCancel: back,
    }, full);
  };

  const doDelete = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${name}?`,
      body: `<p>People who sign in as <b class="mono">user@${esc(name)}</b> can no longer sign in with their directory account. Their IRIS accounts stay.</p><p>This can’t be undone.</p>`,
      confirmLabel: 'Delete configuration', danger: true, typeToConfirm: name,
    });
    if (!ok) return;
    try { await deleteLdapConfig(name); } catch (err) { toast(errorText(err), 'danger'); return; }
    if (od.mode() === 'full') await od.closeFull();
    selected = null;
    details.delete(name);
    await od.select(null);
    await load();
    toast(`LDAP configuration ${name} deleted.`);
  };

  /* ── Loading ── */

  const updated = liveIndicator(ctx, () => void load(), { live: false });
  const load = async (): Promise<void> => {
    around = null; // the strip's instance-wide facts are read again with everything else
    try {
      const l = await getLdapConfigs();
      // Servers come from each configuration's settings; one failure blanks only its row.
      const got = await Promise.allSettled(l.map((s) => getLdapConfig(s.Name)));
      if (!alive) return;
      list = l;
      details.clear();
      got.forEach((r, i) => { if (r.status === 'fulfilled') details.set(l[i].Name, r.value); });
      updated(new Date());
      renderGrid();
      renderFoot();
      if (!opened) {
        opened = true;
        od.refresh(); // a deep link (#/security/ldap/<domain>) opens its full view now
        // A single configuration opens in the peek, as on Certificates & TLS and Superservers (the address is left alone).
        if (l.length === 1 && selected === null && !ctx.param && !wasClosed()) { selected = l[0].Name; renderDetail(); }
      } else if (!editor) renderDetail();
    } catch (err) {
      if (!alive) return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'ldap-retry');
      wrap.querySelector('#ldap-retry')?.addEventListener('click', () => void load());
    }
  };

  const newBtn = newButton(ctx, 'New LDAP configuration', () => void openEditor(null));
  searchEl.addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });
  getInfo().then((info) => {
    const priv = (info as unknown as { privileges?: Record<string, { use?: boolean }> }).privileges;
    canSecure = priv ? !!priv.Secure?.use : null;
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    if (!editor) od.refreshHeader();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
}
