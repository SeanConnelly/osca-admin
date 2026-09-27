// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared explanations of the security model, built from live data:
 *
 *   chainView            the help diagram's boxes (user → role → resource → asset) with real names
 *   userAccessSection    "What this user can do": headline, risky first, folded families
 *   runAccessCheck /     "Can X do Y?" as a checklist with the path, the missing
 *   mountAccessCheck     link and a fix (also used from Resource detail)
 *   roleGrantsSection /  what a role gives, including through included roles
 *   roleChain
 *   riskBanner /         instance-wide risk, and the "Who has power" summary
 *   openPowerDialog
 *
 * Everything is plain English first; raw privilege codes are small secondary text.
 */
import './styles-security.css';
import '@evolution-ui/core/components/ev-select/ev-select.js';
import '@evolution-ui/core/components/ev-dialog/ev-dialog.js';
import {
  getSecurityGraph, privilegeText, sourceText, groupOf, normPerms, isDatabaseRole, databaseWords, typeLabel, PUBLIC_USER, ANON_USER,
  type SecurityGraph, type GrantMap, type Source, type AccessGroup, type AccessCheck,
} from './api-security';
import { esc, permChips, permWords } from './ui';
import { permControl } from './perm-control';
import { PERM_WORD as RESOURCE_PERM_WORD } from './api-resources';
export { permControl } from './perm-control';

/* ══ Chain view ═══════════════════════════════════════════ */

export interface ChainStep {
  kind: 'user' | 'role' | 'resource' | 'asset';
  label: string;
  sub?: string;
  /** The link that isn't there (a No answer). */
  missing?: boolean;
  /** "You are here". */
  here?: boolean;
  /** Makes the box a button (e.g. open that role). */
  link?: () => void;
}

// Link handlers live here, keyed by an id on the button, so chainView can
// return plain markup that works wherever it's inserted.
const links = new Map<string, () => void>();
let linkSeq = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('[data-chain-link]') as HTMLElement | null;
    const fn = b ? links.get(b.dataset.chainLink ?? '') : undefined;
    if (fn) { e.preventDefault(); fn(); }
  });
}
const register = (fn: () => void): string => {
  const id = `c${++linkSeq}`;
  links.set(id, fn);
  if (links.size > 2000) links.delete(links.keys().next().value as string);
  return id;
};

const VERB: Record<string, string> = {
  'user>role': 'holds', 'role>role': 'includes', 'role>resource': 'grants', 'resource>asset': 'protects',
  'user>resource': 'has', 'role>asset': 'reaches', 'user>asset': 'reaches',
};

/**
 * One path as one line of text, with links:
 *   "sean holds %Manager, which grants %DB_USER (Read & change), protecting the USER database"
 *   "CSPSystem: no role grants %DB_USER (Read)"
 * Linked steps are inline buttons; a missing link is marked in words.
 */
export function chainView(steps: ChainStep[], ariaLabel?: string): string {
  if (!steps.length) return '';
  const name = (s: ChainStep): string => {
    const text = `${esc(s.label)}${s.kind === 'resource' && s.sub ? ` <span class="chain-sub">(${esc(s.sub)})</span>` : ''}`;
    const tip = s.kind !== 'resource' && s.sub ? ` title="${esc(s.sub)}"` : '';
    if (s.missing) return `<span class="chain-missing"${tip}>${esc(s.label.charAt(0).toLowerCase() + s.label.slice(1))}${s.sub ? ` (${esc(s.sub)})` : ''}</span>`;
    return s.link
      ? `<button type="button" class="chain-link" data-chain-link="${register(s.link)}"${tip || ` title="Open ${esc(s.label)}"`}>${text}</button>`
      : `<span class="chain-name${s.here ? ' chain-here' : ''}"${tip}>${text}</span>`;
  };
  // "2 users hold", "Everyone has": plural or collective subjects take the plural verb.
  const plural = /^(\d+\s+(?!user\b)\w+|[2-9]\d*\s|\d{2,}\s)/i.test(steps[0].label) || /^(everyone|every user)$/i.test(steps[0].label);
  const verbFor = (a: ChainStep, b: ChainStep, first: boolean): string => {
    const v = VERB[`${a.kind}>${b.kind}`] ?? '';
    if (first && plural) return v.replace(/^holds$/, 'hold').replace(/^has$/, 'have').replace(/^reaches$/, 'reach').replace(/^grants$/, 'grant');
    return v;
  };
  // "USER database" reads as "the USER database" mid-sentence.
  const assetName = (s: ChainStep): string => (/ databases?$/.test(s.label) && !/^(the|\d)/i.test(s.label) ? `the ${name(s)}` : name(s));
  let out = name(steps[0]);
  // Set by a pseudo-role ("Everyone", "Every user", a web app): the next step is what they get.
  let gets = false;
  for (let i = 1; i < steps.length; i++) {
    const a = steps[i - 1];
    const b = steps[i];
    if (b.kind === 'asset') { out += `, protecting ${assetName(b)}`; continue; }
    if (b.missing) {
      // "CSPSystem: no role grants %DB_USER (Read) (for example %DB_USER would)"
      const res = steps[i + 1]?.kind === 'resource' ? steps[++i] : null;
      out += `: <span class="chain-missing">no role grants</span>${res ? ` ${name(res)}` : ''}${b.sub ? ` <span class="chain-sub">(${esc(b.sub)}${/^for example/.test(b.sub) ? ' would' : ''})</span>` : ''}`;
      continue;
    }
    if (i === 1 && a.kind === 'user' && b.kind === 'role' && (/^(Everyone|Every user)$/.test(b.label) || b.sub === 'web app adds')) {
      out += b.sub === 'web app adds' ? `, while using ${name(b)},` : `, like ${esc(b.label.toLowerCase())}${b.sub ? ` <span class="chain-sub">(${esc(b.sub)})</span>` : ''},`;
      gets = true;
      continue;
    }
    if (gets) { out += b.kind === 'role' ? ` gets ${name(b)}` : ` has ${name(b)}`; gets = false; continue; }
    const v = verbFor(a, b, i === 1);
    out += i === 1 ? ` ${v} ${name(b)}` : `, which ${v} ${name(b)}`;
  }
  const label = ariaLabel ?? steps.map((s) => s.label).join(', ');
  return `<p class="chain-line" aria-label="${esc(label)}">${out}</p>`;
}

/** Links a chain can use; screens pass what navigation they support. */
export interface ChainLinks { user?: (name: string) => void; role?: (name: string) => void; resource?: (name: string) => void }

/** What a resource protects, for the last box. */
export function assetOf(g: SecurityGraph, resource: string): { label: string; sub?: string } {
  if (/^%DB_/i.test(resource)) {
    const w = databaseWords(resource, g);
    return { label: w.replace(/^the /, ''), sub: 'data and code' };
  }
  const meta = g.resource(resource);
  if (/^%Service_/i.test(resource) || meta?.ResourceType === 'Service') {
    return { label: privilegeText(resource, 'U', g).replace(/^Can (connect with|connect through|use|sign in to( the)?|call in from|connect by|bulk-load data with|switch to|read) /i, '').replace(/^\w/, (c) => c.toUpperCase()), sub: 'service' };
  }
  const apps = g.webApps.filter((a) => a.Resource && a.Resource.toLowerCase() === resource.toLowerCase()).map((a) => a.Name);
  if (apps.length) return { label: apps.length === 1 ? apps[0] : `${apps.length} web apps`, sub: apps.length === 1 ? 'web app' : apps.slice(0, 3).join(', ') };
  if (meta?.ResourceType === 'System' || /^%(Admin_|Development|System_)/i.test(resource)) return { label: privilegeText(resource, 'U', g).replace(/^Can /, '').replace(/^\w/, (c) => c.toUpperCase()), sub: 'admin power' };
  return { label: typeLabel(meta?.ResourceType ?? ''), sub: meta?.Description ? meta.Description.slice(0, 60) : undefined };
}

const resourceStep = (resource: string, perms: string, l?: ChainLinks): ChainStep =>
  ({ kind: 'resource', label: resource, sub: permWords(perms).join(' · '), link: l?.resource ? () => l.resource?.(resource) : undefined });
const roleSteps = (path: string[], l?: ChainLinks): ChainStep[] =>
  path.map((r) => ({ kind: 'role', label: r, link: l?.role ? () => l.role?.(r) : undefined }));

/** The path from a user to one privilege. */
export function grantChain(g: SecurityGraph, user: string, resource: string, perms: string, src: Source | 'all', allSrc?: Source, l?: ChainLinks): ChainStep[] {
  const who: ChainStep = { kind: 'user', label: user, link: l?.user ? () => l.user?.(user) : undefined };
  const asset = { kind: 'asset' as const, ...assetOf(g, resource) };
  if (src === 'all') {
    const path = allSrc && 'path' in allSrc ? allSrc.path : ['%All'];
    return [who, ...roleSteps(path, l), { kind: 'resource', label: 'Every resource', sub: 'full access' }, asset];
  }
  switch (src.kind) {
    case 'role': return [who, ...roleSteps(src.path, l), resourceStep(resource, perms, l), asset];
    case 'everyone-user': return [who, { kind: 'role', label: 'Every user', sub: `${PUBLIC_USER} account` }, ...roleSteps(src.path, l), resourceStep(resource, perms, l), asset];
    case 'public': return [who, { kind: 'role', label: 'Everyone', sub: 'public permission' }, resourceStep(resource, perms, l), asset];
    case 'app': return [who, { kind: 'role', label: src.app, sub: 'web app adds' }, ...roleSteps(src.path, l), resourceStep(resource, perms, l), asset];
  }
}

/* ══ Lines: one privilege, in words ═══════════════════════ */

interface Line {
  group: AccessGroup;
  resource: string;
  perms: string;
  text: string;
  why: string;
  /** Representative source (the most direct one). */
  source: Source;
  /** Everyone has it: public permission or _PUBLIC's roles. */
  common: boolean;
  risk: number;
  family?: string;
}

/** Higher = shown first. */
function riskOf(resource: string, perms: string): number {
  const r = resource.toLowerCase();
  if (r === '%admin_secure') return 100;
  if (r === '%db_irissys' && perms.includes('W')) return 95;
  if (r === '%development') return 90;
  if (r === '%system_callout') return 85;
  if (r === '%admin_manage') return 80;
  if (r.startsWith('%admin_')) return 60;
  if (r.startsWith('%db_')) return perms.includes('W') ? 40 : 30;
  if (r.startsWith('%service_')) return 20;
  return 10;
}
const RISKY_REASON: Record<string, string> = {
  '%admin_secure': 'security admin', '%db_irissys': 'system database', '%development': 'developer access', '%system_callout': 'operating system access', '%admin_manage': 'configuration',
};

function familyOf(g: SecurityGraph, resource: string): string | undefined {
  const t = g.resource(resource)?.ResourceType;
  if (t === 'Interoperability' || /^%Ens_/i.test(resource)) return 'Interoperability permissions';
  if (t === 'DeepSee' || /^%DeepSee_/i.test(resource)) return 'Analytics permissions';
  if (/^%Native_/i.test(resource)) return 'Native API permissions';
  if (/^%HS_/i.test(resource)) return 'HealthShare permissions';
  return undefined;
}

function linesFor(g: SecurityGraph, grants: GrantMap, why: (s: Source) => string): Line[] {
  const out: Line[] = [];
  for (const [res, perms] of grants) {
    if (!perms.size) continue;
    const letters = normPerms([...perms.keys()].join(''));
    const srcs = [...perms.values()];
    const bySrc = new Map<string, string[]>();
    for (const c of letters) {
      const w = why(perms.get(c) as Source);
      bySrc.set(w, [...(bySrc.get(w) ?? []), c]);
    }
    const word = (c: string): string => ({ R: 'read', W: 'change', U: 'use' }[c] ?? c);
    const whyText = bySrc.size === 1 ? [...bySrc.keys()][0]
      : [...bySrc].map(([w, cs]) => `${cs.map(word).join(' and ')} ${w}`).join('; ');
    const svc = /^%Service_/i.test(res) ? g.services.find((s) => s.Name.toLowerCase() === res.toLowerCase()) : undefined;
    out.push({
      group: groupOf(g.resource(res)?.ResourceType, res), resource: res, perms: letters,
      text: privilegeText(res, letters, g) + (svc && !svc.Enabled ? ' (switched off)' : ''),
      why: whyText, source: srcs.sort((a, b) => kindRank(a) - kindRank(b))[0],
      common: srcs.every((s) => s.kind === 'public' || s.kind === 'everyone-user'),
      risk: riskOf(res, letters), family: familyOf(g, res),
    });
  }
  return out.sort((a, b) => b.risk - a.risk || a.text.localeCompare(b.text));
}
const kindRank = (s: Source): number => ({ role: 0, 'everyone-user': 1, public: 2, app: 3 }[s.kind]);

const GROUPS: Array<{ key: AccessGroup; label: string }> = [
  { key: 'Admin powers', label: 'Admin powers' },
  { key: 'Databases', label: 'Databases' },
  { key: 'Services', label: 'Services' },
  { key: 'Apps', label: 'Apps' },
];

// Chains inside collapsed lines are built when the line is first opened.
const lazy = new Map<string, () => string>();
let lazySeq = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement | null;
    if (!d?.open || !d.classList?.contains('acc-details')) return;
    const body = d.querySelector(':scope > .acc-body[data-lazy]') as HTMLElement | null;
    const fn = body ? lazy.get(body.dataset.lazy ?? '') : undefined;
    if (!body || !fn) return;
    body.removeAttribute('data-lazy');
    body.insertAdjacentHTML('afterbegin', fn());
  }, true);
}
const later = (fn: () => string): string => {
  const id = 'z' + String(++lazySeq);
  lazy.set(id, fn);
  if (lazy.size > 3000) lazy.delete(lazy.keys().next().value as string);
  return id;
};

function lineHtml(_g: SecurityGraph, l: Line, chain: (() => ChainStep[]) | null): string {
  return `<li class="acc-line"${l.common ? ' data-common' : ''}>
    <details class="acc-details">
      <summary class="acc-summary" title="${esc(`${l.resource}:${l.perms}`)}">
        <span class="acc-text">${esc(l.text)}</span>
        <span class="acc-perms">${permChips(l.perms)}</span>
        ${l.why ? `<span class="acc-why">${esc(l.why)}</span>` : ''}
      </summary>
      <div class="acc-body"${chain ? ` data-lazy="${later(() => chainView(chain()))}"` : ''}><code class="acc-raw">${esc(`${l.resource}:${l.perms}`)}</code></div>
    </details>
  </li>`;
}

/** Fold ≥5 lines of one family with the same provenance into one expandable line. */
function foldFamilies(lines: Line[]): Array<Line | { family: string; why: string; items: Line[]; common: boolean }> {
  const groups = new Map<string, Line[]>();
  for (const l of lines) if (l.family) { const k = `${l.family}|${l.why}`; groups.set(k, [...(groups.get(k) ?? []), l]); }
  const folded = new Set<string>([...groups].filter(([, v]) => v.length >= 5).map(([k]) => k));
  const out: Array<Line | { family: string; why: string; items: Line[]; common: boolean }> = [];
  const done = new Set<string>();
  for (const l of lines) {
    const k = l.family ? `${l.family}|${l.why}` : '';
    if (k && folded.has(k)) {
      if (done.has(k)) continue;
      done.add(k);
      const items = groups.get(k) as Line[];
      out.push({ family: l.family as string, why: l.why, items, common: items.every((x) => x.common) });
    } else out.push(l);
  }
  return out;
}

function groupsHtml(g: SecurityGraph, lines: Line[], chainFor: ((l: Line) => ChainStep[]) | null, opts: { open?: boolean } = {}): string {
  return GROUPS.map(({ key, label }) => {
    const ls = lines.filter((l) => l.group === key);
    if (!ls.length) return '';
    const items = foldFamilies(ls).map((x) => ('items' in x
      ? `<li class="acc-line"${x.common ? ' data-common' : ''}><details class="acc-details">
          <summary class="acc-summary"><span class="acc-text">${x.items.length} ${esc(x.family)}</span>${x.why ? `<span class="acc-why">${esc(x.why)}</span>` : ''}</summary>
          <ul class="acc-list acc-list--nested">${x.items.map((l) => lineHtml(g, l, chainFor ? () => chainFor(l) : null)).join('')}</ul>
        </details></li>`
      : lineHtml(g, x, chainFor ? () => chainFor(x) : null))).join('');
    const risky = ls.filter((l) => l.risk >= 80).map((l) => RISKY_REASON[l.resource.toLowerCase()]).filter(Boolean);
    const onlyCommon = ls.every((l) => l.common);
    return `<details class="acc-group"${opts.open ? ' open' : ''}${onlyCommon ? ' data-common' : ''}>
      <summary class="acc-group-head"><span>${esc(label)}</span><span class="acc-count">${ls.length}</span>${risky.length ? `<span class="acc-risk">${esc(risky.join(', '))}</span>` : ''}</summary>
      <ul class="acc-list">${items}</ul>
    </details>`;
  }).join('');
}

/** What %All doesn't cover. */
export const ALL_CAVEAT = 'Everything except SQL row-level security, and not the Secure_Break restriction.';

const fullHtml = (why: string): string => `
  <div class="sec-callout sec-callout--warning" role="note"><ev-icon name="key-round" size="sm"></ev-icon><div>
    <strong>Full access to everything (%All)</strong><span>${esc(why)}</span>
  </div></div>`;

/* ══ What this user can do ════════════════════════════════ */

const ROLE_TITLES: Array<[string, string]> = [
  ['%Manager', 'System manager'], ['%SecurityAdministrator', 'Security administrator'], ['%Developer', 'Developer'],
  ['%Operator', 'Operator'], ['%EnsRole_Administrator', 'Interoperability administrator'], ['%EnsRole_Developer', 'Interoperability developer'],
];

/** "System manager: manages security, changes configuration, develops code · reads and changes 3 databases · 11 ways in". */
export function userHeadline(g: SecurityGraph, user: string): string {
  const a = g.userAccess(user);
  if (a.full) return 'Full access to everything';
  const held = g.userEffective(user);
  const title = ROLE_TITLES.find(([r]) => held.has(r))?.[1];
  const has = (r: string, c = 'U'): boolean => !!a.grants.get(r)?.has(c);
  const powers = [
    has('%Admin_Secure') && 'manages security', has('%Admin_Manage') && 'changes configuration', has('%Admin_Operate') && 'runs operations',
    has('%Development') && 'develops code', has('%DB_IRISSYS', 'W') && 'writes the system database', has('%System_CallOut') && 'runs operating system commands',
  ].filter(Boolean) as string[];
  let rw = 0; let ro = 0; let ways = 0; let waysOff = 0;
  for (const [res, m] of a.grants) {
    if (/^%DB_/i.test(res)) { if (m.has('W')) rw++; else if (m.has('R')) ro++; }
    else if (m.size && groupOf(g.resource(res)?.ResourceType, res) === 'Services') { ways++; if (!g.services.find((x) => x.Name.toLowerCase() === res.toLowerCase())?.Enabled) waysOff++; }
  }
  const bits = [
    powers.join(', '),
    [rw && `reads and changes ${rw} database${rw === 1 ? '' : 's'}`, ro && `reads ${ro} more`].filter(Boolean).join(', '),
    ways && `${ways} service${ways === 1 ? '' : 's'}${waysOff ? ` (${ways - waysOff} switched on)` : ''}`,
  ].filter(Boolean);
  const body = bits.join(' · ') || 'only what every user gets';
  return title ? `${title}: ${body}` : body.charAt(0).toUpperCase() + body.slice(1);
}

let accSeq = 0;
/** "What this user can do": a headline, groups collapsed to counts, risky first, families folded, with a filter for what's special to this user. */
export function userAccessSection(g: SecurityGraph, user: string, l?: ChainLinks): string {
  const a = g.userAccess(user);
  const id = `acc${++accSeq}`;
  const head = `<h3 class="detail-section">What this user can do</h3>
    <p class="acc-headline">${esc(userHeadline(g, user))}</p>`;
  let body: string;
  if (a.full) {
    body = fullHtml(`Every privilege on every resource, ${sourceText(a.full)}. ${ALL_CAVEAT}`) + chainView(grantChain(g, user, '', '', 'all', a.full, l).slice(0, -1).concat([{ kind: 'asset', label: 'Everything', sub: 'databases, services, apps, admin tools' }]));
  } else {
    const lines = linesFor(g, a.grants, sourceText);
    const special = lines.filter((x) => !x.common).length;
    const apps = a.apps.map((x) => `<li class="acc-line"><div class="acc-summary acc-summary--static">
        <span class="acc-text">${x.full ? 'Full access to everything' : esc(linesFor(g, x.grants, () => '').map((k) => k.text).join('; '))}</span>
        <span class="acc-why">only while using ${esc(x.app)}, which adds ${esc(x.roles.join(', '))}</span></div></li>`).join('');
    body = `
      ${lines.length - special ? `<label class="acc-filter"><input type="checkbox" data-acc-only="${id}"> Hide ${lines.length - special} thing${lines.length - special === 1 ? '' : 's'} every user gets</label>` : ''}
      <div class="acc-groups" id="${id}">
        ${groupsHtml(g, lines, (ln) => grantChain(g, user, ln.resource, ln.perms, ln.source, undefined, l))}
        ${apps ? `<details class="acc-group"><summary class="acc-group-head"><span>Added inside web apps</span><span class="acc-count">${a.apps.length}</span></summary><ul class="acc-list">${apps}</ul></details>` : ''}
      </div>`;
  }
  const escRows = a.escalation.map((e) => `<li class="acc-line"><div class="acc-summary acc-summary--static">
      <span class="acc-text">${esc(e.role)}</span>
      <span class="acc-why">${e.access.full ? 'full access to everything' : `${[...e.access.grants.values()].filter((m) => m.size).length} privileges`}, instead of their usual roles while switched</span></div></li>`).join('');
  return `${head}${body}
    ${escRows ? `<div class="acc-group acc-group--flat"><p class="chip-sub">Can switch to</p><ul class="acc-list">${escRows}</ul></div>` : ''}
    <p class="detail-para">Includes what every user gets. Role changes apply from their next sign-in.</p>`;
}

// "Only what's different" filter, delegated so it works after any re-render.
if (typeof document !== 'undefined') {
  document.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | null;
    const id = t?.dataset?.accOnly;
    if (!id) return;
    document.getElementById(id)?.classList.toggle('acc-only-special', t.checked);
  });
}

/* ══ Check access ═════════════════════════════════════════ */

export type CheckTarget = { kind: 'namespace'; name: string } | { kind: 'resource'; name: string; perm: string };
export interface CheckRow { state: 'yes' | 'no' | 'info'; title: string; detail?: string; chain?: ChainStep[] }
export type CheckFix =
  | { kind: 'add-role'; label: string; user: string; role: string }
  | { kind: 'new-role'; label: string; user: string; resource: string; perm: string }
  | { kind: 'enable'; label: string; user: string };
export interface CheckResult { ok: boolean; headline: string; rows: CheckRow[]; fixes: CheckFix[]; /** Why the fixes deserve a second thought. */ fixRisk?: string }

/** The shared permission words, plus the combined "RW" a check can report. */
const PERM_WORD: Record<string, string> = { ...RESOURCE_PERM_WORD, RW: 'Read & change' };
/** System databases: IRISSYS, IRISSECURITY, IRISAUDIT, IRISLIB, IRISLOCALDATA, IRISMETRICS, ENSLIB… */
const SYSTEM_DB = /^%DB_(IRIS(?!TEMP)\w*|ENSLIB|HSLIB|HSSYS)$/i;
const ACCOUNT_NOTES: Record<string, string> = {
  CSPSystem: 'CSPSystem is the Web Gateway’s own account and rarely needs extra access.',
  UnknownUser: 'UnknownUser is anyone who connects without signing in: what you give it, you give to everyone.',
  _PUBLIC: 'The _PUBLIC account’s roles go to every user.',
  _SYSTEM: '_SYSTEM is a built-in account; consider a named account instead.',
  _Ensemble: '_Ensemble is an internal account; changing it can affect interoperability.',
};
const today = (): string => new Date().toISOString().slice(0, 10);
const signInMethod = (g: SecurityGraph, user: string): string | null => {
  if (user === ANON_USER) return 'Unauthenticated';
  const t = g.userList.find((u) => u.Name === user)?.Type ?? '';
  if (/^password/i.test(t)) return 'Password';
  if (/ldap/i.test(t)) return 'LDAP';
  if (/delegated/i.test(t)) return 'Delegated';
  if (/kerberos/i.test(t)) return 'Kerberos';
  return null;
};

/** One privilege as a checklist row, with its chain (or the missing link). */
function privilegeRow(g: SecurityGraph, user: string, c: AccessCheck, what: string, l?: ChainLinks): CheckRow {
  const perm = PERM_WORD[c.perm] ?? c.perm;
  if (c.ok) {
    const chain = grantChain(g, user, c.resource, c.perm, c.source ?? 'all', c.allSource, l);
    const why = c.source === 'all' ? `full access, ${c.allSource ? sourceText(c.allSource) : ''}` : c.source ? sourceText(c.source) : '';
    return { state: 'yes', title: what, detail: `${perm} on ${c.resource}, ${why}`, chain };
  }
  const chain: ChainStep[] = [
    { kind: 'user', label: user, link: l?.user ? () => l.user?.(user) : undefined },
    { kind: 'role', label: 'No role grants it', sub: c.suggestions[0] ? `for example ${c.suggestions[0]}` : 'none exists yet', missing: true },
    resourceStep(c.resource, c.perm, l),
    { kind: 'asset', ...assetOf(g, c.resource) },
  ];
  return { state: 'no', title: what, detail: `None of their roles grants ${perm} on ${c.resource}, and it isn’t public.`, chain };
}

/** "Can this user …?" as a checklist: account, service, app, each database, and the privilege path. */
export function runAccessCheck(g: SecurityGraph, user: string, target: CheckTarget, l?: ChainLinks): CheckResult {
  const rows: CheckRow[] = [];
  const fixes: CheckFix[] = [];
  const u = g.users.get(user);
  const summary = g.userList.find((x) => x.Name === user);

  // 1. The account itself.
  if (user === PUBLIC_USER) rows.push({ state: 'info', title: 'This account never signs in', detail: 'Its roles are added to every user.' });
  else if (summary && !summary.Enabled) {
    rows.push({ state: 'no', title: 'Account is disabled', detail: 'It can’t sign in at all, whatever its roles allow.' });
    fixes.push({ kind: 'enable', label: `Review and enable ${user}…`, user });
  } else if (u?.ExpirationDate && u.ExpirationDate < today()) {
    rows.push({ state: 'no', title: `Account expired on ${u.ExpirationDate}`, detail: 'Change the expiry date to let them sign in.' });
  } else rows.push({ state: 'yes', title: user === ANON_USER ? 'Used for unauthenticated requests' : 'Account is enabled and not expired' });

  const privRows: Array<{ c: AccessCheck; row: CheckRow }> = [];
  const addPriv = (res: string, perm: string, what: string): void => {
    const c = g.check(user, res, perm);
    const row = privilegeRow(g, user, c, what, l);
    rows.push(row);
    privRows.push({ c, row });
  };

  if (target.kind === 'namespace') {
    const n = g.namespaces.find((x) => x.Name.toUpperCase() === target.name.toUpperCase());
    if (!n) return { ok: false, headline: `Namespace ${target.name} wasn’t found`, rows, fixes };
    const dbRow = (db: string, what: string): void => {
      const res = g.databaseResource(db);
      if (res) addPriv(res, 'R', `${what} (the ${db} database)`);
      else rows.push({ state: 'info', title: `${what} (the ${db} database)`, detail: 'This database isn’t protected by a resource the portal can see.' });
    };
    dbRow(n.Globals, n.Routines.toUpperCase() === n.Globals.toUpperCase() ? 'Enter the namespace and run its code' : 'Enter the namespace and read its data');
    if (n.Routines.toUpperCase() !== n.Globals.toUpperCase()) dbRow(n.Routines, 'Run its code');
    if (n.Library && ![n.Globals, n.Routines].map((x) => x.toUpperCase()).includes(n.Library.toUpperCase())) dbRow(n.Library, 'Use the system class library');
    rows.push({ state: 'info', title: 'Other mapped databases aren’t checked here', detail: `Databases mapped into ${n.Name} for particular globals or packages are checked when they’re used.` });
  } else {
    const res = target.name;
    const meta = g.resource(res);
    const isDb = /^%DB_/i.test(res);
    const perm = isDb ? normPerms(target.perm || 'R') : 'U';
    if (/^%Service_/i.test(res) || meta?.ResourceType === 'Service') {
      const svc = g.services.find((s) => s.Name.toLowerCase() === res.toLowerCase());
      if (svc) {
        if (!svc.Enabled) rows.push({ state: 'no', title: 'The service is switched off', detail: 'Nobody can connect this way until it’s switched on (Security › Services).' });
        else rows.push({ state: 'yes', title: 'The service is switched on' });
        const method = signInMethod(g, user);
        const allowed = svc.AuthenticationMethods ?? [];
        if (allowed.length) {
          if (method && !allowed.some((m) => m.toLowerCase() === method.toLowerCase())) rows.push({ state: 'no', title: `The service doesn’t allow ${method.toLowerCase()} sign-in`, detail: `It allows: ${allowed.join(', ')}.` });
          else rows.push({ state: method ? 'yes' : 'info', title: method ? `The service allows ${method.toLowerCase()} sign-in` : 'Sign-in methods allowed', detail: `It allows: ${allowed.join(', ')}.` });
        }
      }
    }
    const apps = g.webApps.filter((a) => a.Resource && a.Resource.toLowerCase() === res.toLowerCase());
    if (apps.length) rows.push({ state: 'info', title: `Needed to open ${apps.length === 1 ? 'the web app' : `${apps.length} web apps`}`, detail: apps.map((a) => a.Name + (a.Enabled ? '' : ' (switched off)')).join(', ') });
    const what = privilegeText(res, perm, g);
    addPriv(res, perm, what);
  }
  rows.push({ state: 'info', title: 'Role changes apply from their next sign-in', detail: 'Sessions already open keep the access they started with.' });

  for (const { c } of privRows) {
    if (c.ok) continue;
    if (c.suggestions[0]) {
      const s = c.suggestions[0];
      fixes.push({ kind: 'add-role', label: `Review and give ${user} the ${s} role…`, user, role: s });
    }
    fixes.push({ kind: 'new-role', label: `Review new role with ${PERM_WORD[c.perm] ?? c.perm} on ${c.resource}…`, user, resource: c.resource, perm: c.perm });
  }
  const ok = rows.every((r) => r.state !== 'no');
  // Don't nudge towards risky grants: system databases, powerful resources, built-in accounts.
  const risks: string[] = [];
  for (const { c } of privRows) {
    if (c.ok) continue;
    if (SYSTEM_DB.test(c.resource)) risks.push(`${databaseWords(c.resource, g).replace(/^the /, '').replace(/^\w/, (x) => x.toUpperCase())} holds system code and data; ordinary accounts rarely need it.`);
    else if (/^%(Admin_|Development$|System_CallOut$)/i.test(c.resource)) risks.push(`${privilegeText(c.resource, 'U', g).replace(/^Can /, 'This lets them ')}: grant it only to administrators.`);
  }
  const acct = ACCOUNT_NOTES[user];
  if (acct && fixes.some((x) => x.kind !== 'enable')) risks.push(acct);
  const fixRisk = risks.length ? risks.join(' ') : undefined;
  const label = target.kind === 'namespace' ? `open namespace ${target.name}` : privilegeText(target.name, target.kind === 'resource' ? target.perm : 'U', g).replace(/^Can /, '').replace(/^\w/, (x) => x.toLowerCase());
  return { ok, headline: `${ok ? 'Yes' : 'No'}: ${user} ${ok ? 'can' : 'can’t'} ${label}`, rows, fixes, fixRisk };
}

let fixSeq = 0;
const fixHandlers = new Map<string, () => void>();
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('[data-check-fix]') as HTMLElement | null;
    const fn = b ? fixHandlers.get(b.dataset.checkFix ?? '') : undefined;
    if (fn) { e.preventDefault(); fn(); }
  });
}

/** The checklist as markup. `onFix` makes the fix buttons act. */
export function renderAccessCheck(r: CheckResult, onFix?: (fix: CheckFix) => void): string {
  const icon = (s: CheckRow['state']): string => (s === 'yes' ? 'check-circle' : s === 'no' ? 'alert-triangle' : 'info');
  const fixes = onFix && r.fixes.length ? `${r.fixRisk ? `<p class="check-fix-risk"><ev-icon name="alert-triangle" size="xs"></ev-icon>${esc(r.fixRisk)}</p>` : ''}<div class="check-fixes">${r.fixes.map((f, i) => {
    const id = `f${++fixSeq}`;
    fixHandlers.set(id, () => onFix(f));
    if (fixHandlers.size > 500) fixHandlers.delete(fixHandlers.keys().next().value as string);
    return `<button type="button" class="btn btn--sm${i === 0 && !r.fixRisk ? ' btn--primary' : ''}" data-check-fix="${id}">${esc(f.label)}</button>`;
  }).join('')}</div>` : '';
  return `<div class="check-answer check-answer--${r.ok ? 'yes' : 'no'}" role="status"><strong>${esc(r.headline)}</strong></div>
    <ul class="check-list">${r.rows.map((row) => `
      <li class="check-line check-line--${row.state}"><ev-icon name="${icon(row.state)}" size="sm"></ev-icon><div>
        <strong>${esc(row.title)}</strong>${row.detail ? `<span>${esc(row.detail)}</span>` : ''}
        ${row.chain ? chainView(row.chain) : ''}
      </div></li>`).join('')}</ul>
    ${fixes}`;
}

export interface AccessCheckOptions {
  /** Fixed user (Users screen); otherwise a user picker is shown. */
  user?: string;
  /** Fixed resource (Resources screen); otherwise a namespace/resource picker is shown. */
  resource?: string;
  onFix?: (fix: CheckFix) => void;
  links?: ChainLinks;
}

let chkSeq = 0;
/** Order in the target picker: databases, ways in, admin powers, then the rest. */
const targetOrder = (name: string): number => (/^%DB_/i.test(name) ? 0 : /^%Service_/i.test(name) ? 1 : /^%(Admin_|Development|System_)/i.test(name) ? 2 : 3);
/** What a target is, not a sentence: "IRISSYS database", "SQL (ODBC and JDBC) · way in", "Manage security · admin power". */
export function targetLabel(g: SecurityGraph, name: string): string {
  const a = assetOf(g, name);
  if (/^%DB_/i.test(name)) return /^%DB_%DEFAULT$/i.test(name) ? 'Databases with no resource of their own' : `${a.label.replace(/ databases?$/, '')} database${/ databases$/.test(a.label) ? 's' : ''}`;
  if (a.sub === 'service') return `${a.label} · service`;
  if (a.sub === 'admin power' || g.resource(name)?.ResourceType === 'System' || /^%(Admin_|Development$|System_)/i.test(name)) return `${privilegeText(name, 'U', g).replace(/^Can /, '').replace(/^\w/, (x) => x.toUpperCase())} · admin power`;
  return `${name} · ${typeLabel(g.resource(name)?.ResourceType ?? '').toLowerCase()}`;
}

/** Mount the whole "Check access" widget into `host`: pickers, answer, checklist, fixes. */
export function mountAccessCheck(host: HTMLElement, g: SecurityGraph, opts: AccessCheckOptions): void {
  const id = `chk${++chkSeq}`;
  const users = [...g.userList].sort((a, b) => Number(b.Enabled) - Number(a.Enabled) || a.Name.localeCompare(b.Name));
  const targets = [
    ...g.namespaces.map((n) => ({ v: `ns:${n.Name}`, t: `Namespace ${n.Name}` })),
    ...[...g.resources].sort((a, b) => targetOrder(a.Name) - targetOrder(b.Name) || a.Name.localeCompare(b.Name)).map((r) => ({ v: `res:${r.Name}`, t: targetLabel(g, r.Name) })),
  ];
  host.innerHTML = `
    <div class="check-row">
      ${opts.user ? '' : `<ev-select id="${id}-user" size="sm" searchable full-width placeholder="Choose a user" aria-label="User to check">${users.map((u) => `<option value="${esc(u.Name)}">${esc(u.Name)}${u.Enabled ? '' : ' (disabled)'}</option>`).join('')}</ev-select>`}
      ${opts.resource ? '' : `<ev-select id="${id}-target" size="sm" searchable full-width placeholder="Choose a namespace or resource" aria-label="What to check">${targets.map((x) => `<option value="${esc(x.v)}">${esc(x.t)}</option>`).join('')}</ev-select>`}
      <span id="${id}-perm" class="check-perm" hidden></span>
    </div>
    <div id="${id}-out" class="check-result" aria-live="polite"></div>`;
  const out = host.querySelector(`#${id}-out`) as HTMLElement;
  const permEl = host.querySelector(`#${id}-perm`) as HTMLElement;
  let user = opts.user ?? '';
  let target = opts.resource ? `res:${opts.resource}` : '';
  let perm = 'R';
  const run = (): void => {
    const res = target.startsWith('res:') ? target.slice(4) : '';
    permEl.hidden = !/^%DB_/i.test(res);
    if (!user || !target) { out.innerHTML = ''; return; }
    const t: CheckTarget = target.startsWith('ns:') ? { kind: 'namespace', name: target.slice(3) } : { kind: 'resource', name: res, perm: /^%DB_/i.test(res) ? perm : 'U' };
    out.innerHTML = renderAccessCheck(runAccessCheck(g, user, t, opts.links), opts.onFix);
  };
  const pick = (e: Event): string => { const v = (e as CustomEvent<{ value: string | string[] }>).detail.value; return Array.isArray(v) ? v[0] ?? '' : v; };
  host.querySelector(`#${id}-user`)?.addEventListener('ev-select-change', (e) => { user = pick(e); run(); });
  host.querySelector(`#${id}-target`)?.addEventListener('ev-select-change', (e) => { target = pick(e); run(); });
  permControl(permEl, { database: true, value: 'R', label: 'Access to check', onChange: (v) => { perm = v; run(); } });
  run();
}

/* ══ Roles ════════════════════════════════════════════════ */

/** `N users → this role → K resources → assets`, for the top of Role detail. */
export function roleChain(g: SecurityGraph, role: string, l?: ChainLinks): string {
  const h = g.holders(role);
  const n = h.direct.length + h.inherited.length;
  const a = g.roleAccess(role);
  const steps: ChainStep[] = [
    { kind: 'user', label: `${n} user${n === 1 ? '' : 's'}`, sub: n ? `${h.direct.length} directly, ${h.inherited.length} through roles` : 'nobody holds it' },
    { kind: 'role', label: role, here: true, sub: g.roles.get(role)?.GrantedRoles.length ? `includes ${g.roles.get(role)?.GrantedRoles.length}` : undefined },
  ];
  if (a.full) {
    steps.push({ kind: 'resource', label: 'Every resource', sub: 'full access' }, { kind: 'asset', label: 'Everything', sub: 'databases, services, apps, admin tools' });
  } else {
    const counts = new Map<AccessGroup, number>();
    let rw = 0;
    for (const [res, m] of a.grants) {
      if (!m.size) continue;
      const grp = groupOf(g.resource(res)?.ResourceType, res);
      counts.set(grp, (counts.get(grp) ?? 0) + 1);
      if (m.has('W')) rw++;
    }
    const total = [...counts.values()].reduce((x, y) => x + y, 0);
    const assets = [
      counts.get('Databases') && `${counts.get('Databases')} database${counts.get('Databases') === 1 ? '' : 's'}`,
      counts.get('Services') && `${counts.get('Services')} service${counts.get('Services') === 1 ? '' : 's'}`,
      counts.get('Admin powers') && `${counts.get('Admin powers')} admin power${counts.get('Admin powers') === 1 ? '' : 's'}`,
      counts.get('Apps') && `${counts.get('Apps')} app permission${counts.get('Apps') === 1 ? '' : 's'}`,
    ].filter(Boolean) as string[];
    steps.push({ kind: 'resource', label: `${total} resource${total === 1 ? '' : 's'}`, sub: rw ? `${rw} with Read & change` : undefined });
    steps.push({ kind: 'asset', label: assets[0] ?? 'Nothing', sub: assets.slice(1).join(', ') || undefined });
  }
  void l;
  return chainView(steps, `${n} users hold ${role}, which grants ${steps[2].label}`);
}

/** "Grants": what holding this role gives. Own rows plain; inherited rows show their path. */
export function roleGrantsSection(g: SecurityGraph, role: string): string {
  const a = g.roleAccess(role);
  if (a.full) {
    const path = a.full.kind === 'role' ? a.full.path : [];
    return `<h3 class="detail-section">Grants</h3>${fullHtml(path.length > 1 ? `Through ${path.slice(1).join(' → ')}. ${ALL_CAVEAT}` : `The super-user role: every privilege on every resource. ${ALL_CAVEAT}`)}`;
  }
  const lines = linesFor(g, a.grants, (s) => (s.kind === 'role' && s.path.length > 1 ? `through ${s.path.slice(1).join(' → ')}` : ''));
  if (!lines.length) return `<h3 class="detail-section">Grants</h3><p class="chip-list-empty">Nothing of its own: holders get only what their other roles give.</p>`;
  const own = lines.filter((x) => !x.why).length;
  return `
    <h3 class="detail-section">Grants</h3>
    <p class="detail-para">${own} from this role itself${lines.length > own ? `, ${lines.length - own} through the roles it includes (the path is shown)` : ''}.</p>
    ${groupsHtml(g, lines, null, { open: lines.length <= 12 })}`;
}

/** Enabled users who don't hold the role but would gain something from it. */
export function wouldGain(g: SecurityGraph, role: string): string[] {
  const a = g.roleAccess(role);
  return g.userList.filter((u) => u.Enabled && u.Name !== PUBLIC_USER && !g.userEffective(u.Name).has(role)).filter((u) => {
    const mine = g.userAccess(u.Name);
    if (mine.full) return false;
    if (a.full) return true;
    for (const [res, perms] of a.grants) for (const c of perms.keys()) if (!mine.grants.get(res)?.has(c)) return true;
    return false;
  }).map((u) => u.Name).sort();
}

/** Warnings worth showing at the top of a role. */
export function roleWarnings(g: SecurityGraph, role: string): string[] {
  const out: string[] = [];
  const a = g.roleAccess(role);
  if (a.full && role !== '%All' && a.full.kind === 'role') {
    out.push(`This role gives full access to everything: it includes %All through ${a.full.path.slice(1).join(' → ')}.`);
  }
  if (isDatabaseRole(role) && g.resource(role)?.ResourceType === 'Database') {
    out.push(`${role} gives read and change access to ${databaseWords(role, g)}, not read-only. For read-only, use a role with just Read on ${role}.`);
  }
  if (g.publicRoles.some((r) => g.effective(r).has(role))) out.push(`Every user gets this role, because the ${PUBLIC_USER} account holds it.`);
  if (g.userEffective(ANON_USER).has(role) && g.userList.find((u) => u.Name === ANON_USER)?.Enabled) out.push('Anyone who connects without signing in gets this role, because UnknownUser holds it.');
  return out;
}

/* ══ Instance-wide risk ═══════════════════════════════════ */

export interface Risk { tone: 'danger' | 'warning'; text: string }

/** The one sentence worth a banner, or null when nothing stands out. */
export function riskBanner(g: SecurityGraph): Risk | null {
  const anon = g.userList.find((u) => u.Name === ANON_USER);
  const anonAccess = anon?.Enabled ? g.userAccess(ANON_USER) : null;
  if (anonAccess?.full) return { tone: 'danger', text: 'Anyone who connects without signing in has full access: UnknownUser holds %All.' };
  const anonRoles = g.userRoles.get(ANON_USER) ?? [];
  if (anon?.Enabled && anonRoles.length) return { tone: 'warning', text: `Anyone who connects without signing in gets ${anonRoles.join(', ')}.` };
  if (g.publicRoles.length) return { tone: 'warning', text: `Every user gets ${g.publicRoles.join(', ')}, because the ${PUBLIC_USER} account holds ${g.publicRoles.length === 1 ? 'it' : 'them'}.` };
  const pub = riskyPublic(g);
  if (pub.length) return { tone: 'warning', text: `${pub.length} resource${pub.length === 1 ? ' gives' : 's give'} risky access to everyone: ${pub.map((p) => p.name).join(', ')}.` };
  return null;
}

function riskyPublic(g: SecurityGraph): Array<{ name: string; why: string }> {
  return g.resources.filter((r) => r.PublicPermission).flatMap((r) => {
    const p = r.PublicPermission.toUpperCase();
    if (/^%DB_/i.test(r.Name) && p.includes('W') && !/^%DB_IRISTEMP$/i.test(r.Name)) return [{ name: r.Name, why: `everyone can change data in ${databaseWords(r.Name, g)}` }];
    if (/^%(Admin_|Development$|System_CallOut$)/i.test(r.Name) && p.includes('U')) return [{ name: r.Name, why: `everyone: ${privilegeText(r.Name, 'U', g).replace(/^Can /, 'can ')}` }];
    return [];
  });
}

/** "Who has power" as markup (sections of user chips with how they get it). */
export function powerSummary(g: SecurityGraph): string {
  const users = g.userList.filter((u) => u.Enabled && u.Name !== PUBLIC_USER);
  const who = (test: (name: string) => Source | 'all' | null): Array<{ name: string; how: string }> => users.flatMap((u) => {
    const s = test(u.Name);
    return s ? [{ name: u.Name, how: s === 'all' ? 'through %All' : sourceText(s) }] : [];
  });
  const fullOf = (n: string): Source | null => g.userAccess(n).full;
  const priv = (res: string, c: string) => (n: string): Source | 'all' | null => {
    const a = g.userAccess(n);
    if (a.full) return null; // already listed under full access
    return a.grants.get(res)?.get(c) ?? null;
  };
  const role = (r: string) => (n: string): Source | null => {
    for (const held of g.userRoles.get(n) ?? []) { const p = g.rolePaths(held).get(r); if (p) return { kind: 'role', path: p }; }
    return null;
  };
  const sections: Array<{ title: string; explain: string; rows: Array<{ name: string; how: string }> }> = [
    { title: 'Full access (%All)', explain: `Can do anything on the instance: ${ALL_CAVEAT}`, rows: who(fullOf) },
    { title: 'System managers (%Manager)', explain: 'Control the whole instance, including security.', rows: who((n) => (fullOf(n) ? null : role('%Manager')(n))) },
    { title: 'Can manage security', explain: 'Can change users, roles and security settings.', rows: who(priv('%Admin_Secure', 'U')) },
    { title: 'Can write the system database', explain: 'Effectively full access: code there can change its own privileges.', rows: who(priv('%DB_IRISSYS', 'W')) },
    { title: 'Developers', explain: 'Direct mode, the debugger and IDE connections.', rows: who(priv('%Development', 'U')) },
  ];
  const list = (rows: Array<{ name: string; how: string }>): string => rows.length
    ? `<ul class="power-list">${rows.map((r) => `<li><b class="mono">${esc(r.name)}</b> <span class="dim">${esc(r.how)}</span></li>`).join('')}</ul>`
    : '<p class="chip-list-empty">Nobody</p>';
  const anonRoles = g.userRoles.get(ANON_USER) ?? [];
  const anonOn = !!g.userList.find((u) => u.Name === ANON_USER)?.Enabled;
  const pub = riskyPublic(g);
  return `
    ${sections.map((s) => `<section class="power-section"><h3>${esc(s.title)} <span class="dim">${s.rows.length}</span></h3><p>${esc(s.explain)}</p>${list(s.rows)}</section>`).join('')}
    <section class="power-section"><h3>Anyone without signing in</h3><p>UnknownUser is ${anonOn ? 'enabled' : 'disabled'}${anonRoles.length ? ` and holds ${esc(anonRoles.join(', '))}` : ' and holds no roles'}.</p></section>
    <section class="power-section"><h3>Every user</h3><p>${g.publicRoles.length ? `The ${PUBLIC_USER} account gives everyone ${esc(g.publicRoles.join(', '))}.` : `The ${PUBLIC_USER} account holds no roles.`}</p></section>
    <section class="power-section"><h3>Risky public permissions</h3>${pub.length ? `<ul class="power-list">${pub.map((p) => `<li><b class="mono">${esc(p.name)}</b> <span class="dim">${esc(p.why)}</span></li>`).join('')}</ul>` : '<p class="chip-list-empty">None</p>'}</section>`;
}

/** A screen's own risk, shown in the one Security banner instead of the shared one. */
export interface LocalRisk {
  tone: 'danger' | 'warning' | 'info';
  /** One sentence stating the risk: "Port 51774 carries 3 ways in that need no sign-in, without TLS". */
  headline: string;
  /** Optional second sentence. */
  detail?: string;
  /** Optional local action, e.g. filter the list to the risky rows. */
  showThem?: { label: string; run: () => void };
}

/**
 * The one page notice: a single line about THIS screen's objects, with an
 * optional "Show them" link and the shared "Review ›" link ("Who has power").
 * Instance-wide posture (e.g. UnknownUser holds %All) is not repeated on every
 * screen: it shows only where it is the subject (`shared: true`, the Users
 * screen), and otherwise lives in Home and the status bar. Renders nothing
 * when there's nothing to say. `graph` may be null while it loads: Review then
 * fetches it. Call again to update; it replaces what it drew.
 */
export function mountSecurityBanner(host: HTMLElement, graph: SecurityGraph | null, local?: LocalRisk | null, opts: { shared?: boolean; review?: boolean } = {}): void {
  // "Review ›" (who has power) belongs to security notices; screens with no security graph (jobs, locks) leave it out.
  const review = opts.review ?? graph !== null;
  const shared = !local && opts.shared && graph ? riskBanner(graph) : null;
  if (!local && !shared) { host.innerHTML = ''; return; }
  const tone = local?.tone ?? shared?.tone ?? 'warning';
  const headline = local?.headline ?? shared?.text ?? '';
  host.innerHTML = `<div class="page-notice page-notice--${tone}" role="status"${local?.detail ? ` title="${esc(local.detail)}"` : ''}>
    <ev-icon name="${tone === 'info' ? 'info' : 'alert-triangle'}" size="sm"></ev-icon>
    <span class="page-notice-text">${esc(headline)}</span>
    ${local?.showThem ? `<button type="button" class="page-notice-link" data-banner-show>${esc(local.showThem.label)}</button>` : ''}
    ${review ? `<button type="button" class="page-notice-link" data-power-review title="Who has power on this instance">Review</button>` : ''}
  </div>`;
  host.querySelector('[data-banner-show]')?.addEventListener('click', () => local?.showThem?.run());
  host.querySelector('[data-power-review]')?.addEventListener('click', () => {
    if (graph) openPowerDialog(graph);
    else void getSecurityGraph().then(openPowerDialog, () => { /* nothing to show */ });
  });
}

/** "Who has power" in a dialog. */
export function openPowerDialog(g: SecurityGraph): void {
  const dlg = document.createElement('ev-dialog') as HTMLElement & { open: boolean; close(): void };
  dlg.setAttribute('heading', 'Who has power on this instance');
  dlg.setAttribute('size', 'lg');
  dlg.innerHTML = `<div slot="body" class="power-body">${powerSummary(g)}</div>
    <div slot="footer" class="crud-dialog-foot"><button type="button" class="btn btn--primary" data-dismiss>Close</button></div>`;
  dlg.querySelector('[data-dismiss]')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('ev-dialog-close', () => setTimeout(() => dlg.remove(), 0), { once: true });
  document.body.appendChild(dlg);
  dlg.open = true;
}

/* ══ Guard-rail dialog ════════════════════════════════════ */

export interface GuardRisk {
  /** States the risk: "UnknownUser would get %Manager". */
  title: string;
  /** One sentence explaining it. */
  text: string;
  /** "3 users hold it now". */
  impact?: string;
}

/** Title, explanation and impact for the confirm dialog of a risky save. */
export function guardDialog(risks: GuardRisk[]): { title: string; body: string } {
  if (risks.length === 1) {
    const r = risks[0];
    return { title: r.title, body: `<p>${esc(r.text)}</p>${r.impact ? `<p class="risk-impact">${esc(r.impact)}</p>` : ''}` };
  }
  return {
    title: `This change has ${risks.length} risks`,
    body: `<ul class="risk-list">${risks.map((r) => `<li><b>${esc(r.title)}.</b> ${esc(r.text)}${r.impact ? ` <span class="risk-impact">${esc(r.impact)}</span>` : ''}</li>`).join('')}</ul>`,
  };
}

/** One line for a role in pickers: "Full access to everything", "2 databases, 5 ways in, 1 admin power". */
export function roleSummary(g: SecurityGraph, role: string): string {
  const a = g.roleAccess(role);
  if (a.full) return 'Full access to everything';
  const counts = new Map<AccessGroup, number>();
  for (const [res, m] of a.grants) if (m.size) { const k = groupOf(g.resource(res)?.ResourceType, res); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const n = (k: AccessGroup, one: string, many: string): string | false => !!counts.get(k) && `${counts.get(k)} ${counts.get(k) === 1 ? one : many}`;
  const parts = [n('Admin powers', 'admin power', 'admin powers'), n('Databases', 'database', 'databases'), n('Services', 'service', 'services'), n('Apps', 'app permission', 'app permissions')].filter(Boolean);
  if (/^%DB_/i.test(role) && g.resource(role)?.ResourceType === 'Database') return `Read & change ${databaseWords(role, g)}`;
  return parts.length ? parts.join(', ') : 'Grants nothing of its own';
}
