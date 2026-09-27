// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Secrets wallet — collections in the Secrets wallet and the
 * secrets in each, with create, change and delete.
 *
 * Secret values are write-only: forms send them to IRIS and clear themselves;
 * nothing ever asks IRIS for a value (it has no way to return one), and the
 * listing carries names and types only.
 *
 * A collection names two resources: one whose permission lets people use its
 * secrets, one that lets them add or change secrets. The detail panel draws
 * who that is today, through which roles, from the security graph.
 */
import '../styles-secrets.css';
import '../styles-security.css';
import {
  getWalletCollections, getWalletSecrets, saveWalletCollection, deleteWalletCollection, saveWalletSecret, deleteWalletSecret,
  splitResource, PERM_LETTER, COLLECTION_NAME, SECRET_NAME, docsHref,
  type WalletCollection, type WalletSecret, type SecretKind,
} from '../api-secrets';
import { getSecurityGraph, getResourceList, linkTo, normPerms, type SecurityGraph, type ResourceSummary } from '../api-security';
import { chainView, mountSecurityBanner, type ChainStep, type LocalRisk } from '../security-view';
import { plural, kv, roleLink, esc, chip, num, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, type ScreenCtx } from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, passwordField,
  selectField, checkField, readForm, fieldError, blockedAttrs, AdminError, isDatabaseResource, scrollPanelTop, type FieldProblem, type EditorHandle,
} from '../crud';
import { sessionInfo, can } from '../session-info';

// ── Vocabulary ─────────────────────────────────────────────────────────

const TYPES: Record<SecretKind, { label: string; hint: string; replace: string }> = {
  '%Wallet.KeyValue': { label: 'Key-value', hint: 'Named values such as a user and password, an API key or a connection string', replace: 'Replace values' },
  '%Wallet.SymmetricKey': { label: 'Symmetric key', hint: 'A random key IRIS generates for encrypting data', replace: 'Replace key' },
  '%Wallet.RSA': { label: 'RSA key pair', hint: 'A public/private key pair IRIS generates for signing and encryption', replace: 'Replace key pair' },
};
const typeOf = (t: string): { label: string; hint: string; replace: string } =>
  TYPES[t as SecretKind] ?? { label: t.replace(/^%Wallet\./, '') || 'Unknown', hint: 'A secret stored in the wallet', replace: 'Replace value' };

/** The section's permission words. IRIS treats Write as read-and-change. */
// Not api-resources' PERM_WORD: keyed by the wallet's READ / WRITE / USE words, not R / W / U.
const PERM_WORD = { READ: 'Read', WRITE: 'Read & change', USE: 'Use' } as const;
const PERM_OPTIONS = [{ value: 'READ', label: 'Read' }, { value: 'WRITE', label: 'Read & change' }, { value: 'USE', label: 'Use' }];
const NO_PRIV = noPermissionText('%Admin_Wallet', 'Secrets wallet administration');
const KV_ROWS = 3;

/** "billing.stripe-key" in collection "billing" → "stripe-key". */
const shortName = (full: string, collection: string): string =>
  full.startsWith(`${collection}.`) ? full.slice(collection.length + 1) : full;
const userLink = (name: string): string =>
  `<button type="button" class="chip-link" data-user="${esc(name)}" aria-label="Open user ${esc(name)}">${chip(name, 'neutral', 'Open this user')}</button>`;
const resourceWords = (spec: string): string => {
  const { resource, perm } = splitResource(spec);
  return `${PERM_WORD[perm]} on ${resource}`;
};

type Selection = { kind: 'collection'; name: string } | { kind: 'secret'; name: string; collection: string } | null;

export function walletScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="w-toolbar" hidden>
      <div class="search-box"><ev-search id="w-search" size="sm" full-width placeholder="Filter by collection or secret name" aria-label="Filter secrets"></ev-search></div>
    </div>
    <ev-detail-panel id="w-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="w-main" id="w-main">${skeleton(6)}</div>
      <aside slot="detail" class="detail" id="w-detail" aria-label="Wallet details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="w-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#w-panel');
  const main = $('#w-main');
  const detail = $('#w-detail');
  const toolbar = $('#w-toolbar');

  let collections: WalletCollection[] = [];
  const secrets = new Map<string, WalletSecret[] | Error>();
  let loaded = false;
  let selected: Selection = null;
  let query = '';
  let graph: SecurityGraph | null = null;
  let resources: ResourceSummary[] | null = null;
  let canEdit: boolean | null = null;
  let alive = true;

  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  /** Listeners a form adds to the panel; dropped with the form. */
  let formEvents: AbortController | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; formEvents?.abort(); formEvents = null; };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });

  const secretsOf = (c: string): WalletSecret[] => { const s = secrets.get(c); return Array.isArray(s) ? s : []; };
  const blocked = (): string => (canEdit === false ? NO_PRIV : '');

  // ── Who can: the live chain from a "resource:PERM" setting ──
  /*
   * What IRIS checks (%SYS.Wallet.Secret CheckPermission): the caller passes if
   * they hold exactly the permission the collection names on its resource
   * (Read, Write or Use), OR Use on %Admin_Wallet. %All passes both.
   */
  interface Who {
    resource: string; perm: 'READ' | 'WRITE' | 'USE'; exists: boolean; pub: boolean;
    roles: string[]; users: string[]; all: string[];
    /** Wallet administrators: Use on %Admin_Wallet, not already counted above. */
    adminRoles: string[]; adminUsers: string[];
    /**
     * Web apps whose added roles give the permission while code runs inside
     * them: the wallet checks the process's roles, and those include the app's.
     */
    apps: AppGrant[];
  }
  interface AppGrant { app: string; roles: string[]; users: string[]; everyone: boolean; anon: boolean }
  const WALLET_ADMIN = '%Admin_Wallet';
  /** resource:letter → app grants; walks every user, so kept per graph. */
  const appMemo = new Map<string, AppGrant[]>();
  const appsFor = (g: SecurityGraph, resource: string, letter: string): AppGrant[] => {
    const key = `${resource}:${letter}`;
    const hit = appMemo.get(key);
    if (hit) return hit;
    const byApp = new Map<string, { roles: Set<string>; users: Set<string> }>();
    const enabled = g.userList.filter((u) => u.Enabled).map((u) => u.Name);
    for (const user of enabled) {
      for (const a of g.userAccess(user).apps) {
        if (!a.full && !a.grants.get(resource)?.has(letter)) continue;
        const e = byApp.get(a.app) ?? { roles: new Set<string>(), users: new Set<string>() };
        for (const r of a.roles) {
          const ra = g.roleAccess(r);
          if (ra.full || ra.grants.get(resource)?.has(letter)) e.roles.add(r);
        }
        e.users.add(user);
        byApp.set(a.app, e);
      }
    }
    // "Everyone": the app adds it for every enabled user who doesn't already have it.
    const already = new Set(enabled.filter((u) => g.check(u, resource, letter).ok));
    const out = [...byApp].map(([app, e]) => ({
      app, roles: [...e.roles].sort(), users: [...e.users].sort(),
      everyone: enabled.every((u) => already.has(u) || e.users.has(u)),
      anon: e.users.has('UnknownUser'),
    })).sort((a, b) => a.app.localeCompare(b.app));
    appMemo.set(key, out);
    return out;
  };
  /** Why someone who doesn't sign in (UnknownUser) can use a collection's secrets, if they can. */
  type AnonReason = 'public' | 'role' | 'admin' | 'app' | 'all';
  const anonReason = (c: WalletCollection): AnonReason | null => {
    const w = whoFor(c.UseResource);
    if (!w) return null;
    const anon = 'UnknownUser';
    if (w.pub) return 'public';
    if (w.users.includes(anon)) return 'role';
    if (w.adminUsers.includes(anon)) return 'admin';
    if (w.apps.some((x) => x.anon)) return 'app';
    if (w.all.includes(anon)) return 'all';
    return null;
  };
  const ANON_WHY: Record<AnonReason, string> = {
    public: 'its resource permission is public',
    role: 'UnknownUser, the account they connect as, holds a role that gives it',
    admin: 'UnknownUser holds wallet administration',
    app: 'a web app that lets people in without signing in adds a role that gives it',
    all: 'UnknownUser, the account they connect as, holds %All',
  };
  const appWho = (a: AppGrant): string =>
    a.everyone ? `everyone who signs in there${a.anon ? ', and anyone who connects without signing in' : ''}` : `${plural(a.users.length, 'user')} who sign in there`;
  const whoFor = (spec: string): Who | null => {
    if (!graph) return null;
    const { resource, perm } = splitResource(spec);
    const letter = PERM_LETTER[perm];
    const who = graph.whoCan(resource);
    const roles = who.roles.filter((r) => normPerms(r.perms).includes(letter)).map((r) => r.role);
    const users = [...new Set(who.users.filter((u) => u.source !== 'all' && normPerms(u.perms).includes(letter)).map((u) => u.user))];
    const admin = graph.whoCan(WALLET_ADMIN);
    const adminRoles = admin.roles.filter((r) => normPerms(r.perms).includes('U') && !roles.includes(r.role)).map((r) => r.role);
    const adminUsers = [...new Set(admin.users.filter((u) => u.source !== 'all' && normPerms(u.perms).includes('U')).map((u) => u.user))].filter((u) => !users.includes(u));
    const r = graph.resource(resource);
    return { resource, perm, exists: !!r, pub: normPerms(r?.PublicPermission ?? '').includes(letter), roles, users, all: who.allHolders, adminRoles, adminUsers, apps: appsFor(graph, resource, letter) };
  };
  /** One-line answer, used in forms as a live preview. */
  const whoLine = (w: Who | null): string => {
    if (!w) return 'Working out who that is…';
    if (!w.exists) return `There’s no resource called ${w.resource}.`;
    const parts: string[] = [];
    if (w.pub) parts.push('everyone (it’s public)');
    if (w.roles.length) parts.push(`${plural(w.users.length, 'user')} through ${w.roles.length <= 3 ? w.roles.join(', ') : plural(w.roles.length, 'role')}`);
    if (w.apps.length) parts.push(`code inside ${w.apps.length === 1 ? w.apps[0].app : plural(w.apps.length, 'web app')} (${w.apps.length === 1 ? appWho(w.apps[0]) : 'roles the apps add'})`);
    if (w.adminUsers.length) parts.push(`${plural(w.adminUsers.length, 'wallet administrator')}`);
    if (w.all.length) parts.push(`${plural(w.all.length, 'user')} with %All`);
    return parts.length ? `Today that’s ${parts.join(', plus ')}.` : `No role gives ${PERM_WORD[w.perm]} on ${w.resource}, so only wallet administrators and %All holders could.`;
  };
  const accessBlock = (spec: string, target: string, verb: string): string => {
    const w = whoFor(spec);
    if (!w) return '<p class="chip-sub">Working out who that is…</p>';
    // Each way in is its own labelled group ending at the resource; the shared
    // ending (resource protects the collection) is drawn once, underneath.
    const res: ChainStep = { kind: 'resource', label: w.resource, sub: PERM_WORD[w.perm], link: w.exists ? () => linkTo(ctx.navigate, 'security/resources', w.resource) : undefined };
    const groups: Array<{ label: string; paths: ChainStep[][] }> = [];
    if (w.pub) groups.push({ label: 'Everyone', paths: [[{ kind: 'user', label: 'Everyone', sub: 'public, no role needed' }, res]] });
    if (w.roles.length || (!w.pub && !w.apps.length)) {
      const one = w.roles.length === 1 ? w.roles[0] : null;
      groups.push({
        label: 'Through roles',
        paths: [[
          { kind: 'user', label: plural(w.users.length, 'user') },
          {
            kind: 'role', label: one ?? (w.roles.length ? plural(w.roles.length, 'role') : 'No role'),
            sub: one ? undefined : w.roles.length ? w.roles.slice(0, 2).join(', ') + (w.roles.length > 2 ? '…' : '') : `gives ${PERM_WORD[w.perm]}`,
            missing: !w.roles.length,
            link: one ? () => linkTo(ctx.navigate, 'security/roles', one) : undefined,
          },
          res,
        ]],
      });
    }
    if (w.apps.length) {
      groups.push({
        label: 'Inside web apps',
        paths: w.apps.slice(0, 3).map((a) => [
          { kind: 'user', label: a.app, sub: a.everyone ? 'everyone who signs in there' : plural(a.users.length, 'user') },
          { kind: 'role', label: a.roles.length === 1 ? a.roles[0] : plural(a.roles.length, 'role'), sub: 'added by the web app', link: a.roles.length === 1 ? () => linkTo(ctx.navigate, 'security/roles', a.roles[0]) : undefined },
          res,
        ] as ChainStep[]),
      });
    }
    const chain = `${groups.map((g) => `
      <div class="w-group" role="group" aria-label="${esc(g.label)}">
        <p class="w-group-label">${esc(g.label)}</p>
        ${g.paths.map((steps) => chainView(steps)).join('')}
      </div>`).join('')}
      <div class="w-group w-group--end" role="group" aria-label="Then">
        <p class="w-group-label">Then</p>
        ${chainView([res, { kind: 'asset', label: target, sub: verb, here: true }], `${w.resource} protects ${target}`)}
      </div>`;
    const lists: string[] = [];
    if (w.roles.length) lists.push(`<p class="chip-sub">Roles that give ${PERM_WORD[w.perm]} on ${esc(w.resource)}</p><div class="chip-list">${w.roles.map((r) => roleLink(r)).join('')}</div>`);
    if (w.users.length) lists.push(`<p class="chip-sub">Users, through those roles</p><div class="chip-list">${w.users.map(userLink).join('')}</div>`);
    if (w.apps.length) {
      lists.push(`<p class="chip-sub">Also inside web apps: code running there gets the roles the app adds</p><ul class="w-app-list">${w.apps.map((a) =>
        `<li><a class="mono" href="#/web/apps" title="Open Web applications">${esc(a.app)}</a> adds ${a.roles.map((r) => roleLink(r)).join(' ') || 'roles'} for ${esc(appWho(a))}</li>`).join('')}</ul>`);
    }
    if (w.adminRoles.length || w.adminUsers.length) {
      lists.push(`<p class="chip-sub">Also wallet administrators (Use on ${WALLET_ADMIN}), whatever the collection says</p><div class="chip-list">${
        w.adminRoles.map((r) => roleLink(r)).join('')}${w.adminUsers.map(userLink).join('')}</div>`);
    }
    if (w.all.length) lists.push(`<p class="chip-sub">Also anyone with %All</p><div class="chip-list">${w.all.map(userLink).join('')}</div>`);
    if (!w.exists) lists.push(`<p class="detail-para check-warn">There’s no resource called ${esc(w.resource)} on this instance, so only wallet administrators and %All holders can ${esc(verb)}.</p>`);
    return `<div class="w-chain">${chain}</div>${lists.join('')}`;
  };

  // ── Main list ──
  const matches = (text: string): boolean => text.toLowerCase().includes(query.toLowerCase());
  const renderEmpty = (): void => {
    main.innerHTML = emptyState({
      icon: 'key-round',
      title: 'No collections yet',
      what: 'Store passwords and API keys for your code, encrypted inside IRIS.',
      docs: { href: docsHref('wallet'), label: 'Learn more' },
    });
  };
  const renderList = (): void => {
    if (!collections.length) {
      toolbar.hidden = true;
      renderEmpty();
      return;
    }
    toolbar.hidden = false;
    const isSel = (k: 'collection' | 'secret', n: string): boolean => !!selected && selected.kind === k && selected.name === n;
    const groups = collections.map((c) => {
      const list = secrets.get(c.Name);
      const all = Array.isArray(list) ? list : [];
      const nameHit = !query || matches(c.Name);
      const shown = nameHit ? all : all.filter((s) => matches(shortName(s.Name, c.Name)));
      if (query && !nameHit && !shown.length) return '';
      const head = `<li><button type="button" class="row row--group row-button" data-coll="${esc(c.Name)}" aria-current="${isSel('collection', c.Name)}">
          <span class="row-stack"><span class="row-main mono">${esc(c.Name)}</span><span class="row-sub">Used with ${esc(resourceWords(c.UseResource))} · changed with ${esc(resourceWords(c.EditResource))}</span></span>
          <span class="row-chips">${(() => { const r = anonReason(c); return r ? chip('Anyone', 'danger', `Anyone who connects without signing in can use these secrets: ${ANON_WHY[r]}`) : ''; })()}${list instanceof Error ? chip('Couldn’t list secrets', 'danger', errorText(list)) : chip(plural(all.length, 'secret'))}</span>
        </button></li>`;
      const rows = shown.map((s) => {
        const t = typeOf(s.Type);
        return `<li><button type="button" class="row row--nested row-button" data-secret="${esc(s.Name)}" data-in="${esc(c.Name)}" aria-current="${isSel('secret', s.Name)}">
          <span class="row-main mono">${esc(shortName(s.Name, c.Name))}</span>
          <span class="row-chips">${chip(t.label, 'neutral', t.hint)}<span class="masked" title="Secret values are never shown"><ev-icon name="eye-off" size="xs"></ev-icon>Hidden</span></span>
        </button></li>`;
      }).join('');
      return head + (Array.isArray(list) && !all.length ? '<li class="row row--nested"><span class="row-sub">No secrets yet.</span></li>' : rows);
    }).join('');
    main.innerHTML = groups ? `<ul class="rows w-rows">${groups}</ul>` : `<p class="w-nomatch">Nothing matches “${esc(query)}”. Try a collection or secret name.</p>`;
    main.querySelectorAll<HTMLElement>('[data-coll]').forEach((b) => b.addEventListener('click', () => void select({ kind: 'collection', name: b.dataset.coll ?? '' })));
    main.querySelectorAll<HTMLElement>('[data-secret]').forEach((b) => b.addEventListener('click', () => void select({ kind: 'secret', name: b.dataset.secret ?? '', collection: b.dataset.in ?? '' })));
  };
  const renderFoot = (): void => {
    const n = collections.reduce((a, c) => a + secretsOf(c.Name).length, 0);
    const foot = $('#w-foot');
    foot.hidden = !collections.length;
    foot.innerHTML = `<b>${num(collections.length)}</b> collection${collections.length === 1 ? '' : 's'}<span class="meta-sep">·</span><b>${num(n)}</b> secret${n === 1 ? '' : 's'}`;
  };

  // ── Detail (view) ──
  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => { selected = null; setPanel(false); renderList(); };
  const pairArrows = (): void => {
    detail.querySelectorAll('.w-chain .model').forEach((m) => {
      for (const a of [...m.querySelectorAll(':scope > .model-arrow')]) {
        const next = a.nextElementSibling;
        if (!next || next.classList.contains('model-arrow')) continue;
        const g = document.createElement('span');
        g.className = 'w-pair';
        a.before(g);
        g.append(a, next);
      }
    });
  };
  const wireLinks = (): void => {
    pairArrows();
    detail.querySelectorAll<HTMLElement>('[data-role]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/roles', b.dataset.role ?? '')));
    detail.querySelectorAll<HTMLElement>('[data-user]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/users', b.dataset.user ?? '')));
    detail.querySelector('#w-close')?.addEventListener('click', closeDetail);
  };
  const head = (kicker: string, title: string, state: string): string => `
    <header class="detail-head">
      <div class="detail-title"><span class="detail-kicker">${kicker}</span><h2 class="mono">${esc(title)}</h2></div>
      <ev-icon-button icon="x" label="Close details" id="w-close"></ev-icon-button>
    </header>
    <div class="detail-state">${state}</div>`;

  const renderCollection = (name: string): void => {
    const c = collections.find((x) => x.Name === name);
    if (!c) { closeDetail(); return; }
    const list = secretsOf(name);
    detail.innerHTML = `
      ${head('Wallet collection', c.Name, chip(plural(list.length, 'secret')))}
      <div class="detail-actions">
        <button type="button" class="btn btn--sm" id="w-edit"${blockedAttrs(blocked())}>Edit</button>
        <button type="button" class="btn btn--sm" id="w-add"${blockedAttrs(blocked())}>New secret</button>
        ${moreButton('w-more')}
      </div>
      <h3 class="detail-section">Who can use its secrets</h3>
      <p class="detail-para">Code running as these people can use the secrets, for example to sign in to another system.</p>
      ${(() => { const r = anonReason(c); return r ? `<p class="detail-para check-warn w-anon"><ev-icon name="alert-triangle" size="xs"></ev-icon> Anyone who connects without signing in can use these secrets: ${esc(ANON_WHY[r])}.</p>` : ''; })()}
      ${accessBlock(c.UseResource, `${c.Name} secrets`, 'use')}
      <h3 class="detail-section">Who can add or change secrets</h3>
      ${accessBlock(c.EditResource, `${c.Name} secrets`, 'add or change')}
      <h3 class="detail-section">Secrets · ${num(list.length)}</h3>
      ${list.length ? `<ul class="rows">${list.map((s) => `<li><button type="button" class="row row-button" data-open-secret="${esc(s.Name)}">
          <span class="row-main mono">${esc(shortName(s.Name, name))}</span><span class="row-chips">${chip(typeOf(s.Type).label)}</span></button></li>`).join('')}</ul>`
        : '<p class="chip-list-empty">No secrets yet.</p>'}`;
    wireLinks();
    detail.querySelector('#w-edit')?.addEventListener('click', () => void openCollectionEditor(name));
    detail.querySelector('#w-add')?.addEventListener('click', () => void openSecretEditor(null, name));
    detail.querySelectorAll<HTMLElement>('[data-open-secret]').forEach((b) =>
      b.addEventListener('click', () => void select({ kind: 'secret', name: b.dataset.openSecret ?? '', collection: name })));
    moreMenu(detail.querySelector('#w-more') as HTMLElement, [
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void removeCollection(name) },
    ]);
  };

  const renderSecret = (full: string, coll: string): void => {
    const s = secretsOf(coll).find((x) => x.Name === full);
    const c = collections.find((x) => x.Name === coll);
    if (!s || !c) { closeDetail(); return; }
    const t = typeOf(s.Type);
    detail.innerHTML = `
      ${head(`Secret in ${esc(coll)}`, shortName(full, coll), chip(t.label, 'neutral', t.hint))}
      <div class="detail-actions">
        <button type="button" class="btn btn--sm" id="w-edit"${blockedAttrs(blocked())}>${esc(t.replace)}</button>
        ${moreButton('w-more')}
      </div>
      <dl class="kv-list">
        <div class="kv kv--block"><dt>Code refers to it as</dt><dd class="w-fullname"><span class="mono">${esc(full)}</span><button type="button" class="btn btn--sm btn--quiet" id="w-copy" aria-label="Copy ${esc(full)}"><ev-icon name="copy" size="xs"></ev-icon>Copy</button></dd></div>
        ${kv('Kind', esc(t.label), t.hint)}
        ${kv('Value', '<span class="masked"><ev-icon name="eye-off" size="xs"></ev-icon>Stored encrypted, never shown</span>')}
        ${kv('Collection', `<button type="button" class="link mono" id="w-to-coll">${esc(coll)}</button>`)}
      </dl>
      <h3 class="detail-section">Who can use it</h3>
      <p class="detail-para">The same people who can use everything in ${esc(coll)}.</p>
      ${accessBlock(c.UseResource, full, 'use')}`;
    wireLinks();
    const copy = detail.querySelector<HTMLButtonElement>('#w-copy');
    copy?.addEventListener('click', () => {
      void navigator.clipboard.writeText(full).then(() => {
        copy.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
        setTimeout(() => { copy.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy'; }, 1600);
      }, () => toast('Couldn’t copy. Select the name and copy it instead.', 'warning'));
    });
    detail.querySelector('#w-to-coll')?.addEventListener('click', () => void select({ kind: 'collection', name: coll }));
    detail.querySelector('#w-edit')?.addEventListener('click', () => void openSecretEditor(full, coll));
    moreMenu(detail.querySelector('#w-more') as HTMLElement, [
      { label: 'Delete', icon: 'trash-2', danger: true, disabled: canEdit === false, reason: NO_PRIV, onSelect: () => void removeSecret(full, coll) },
    ]);
  };

  const renderDetail = (): void => {
    if (!selected) { setPanel(false); return; }
    if (selected.kind === 'collection') renderCollection(selected.name); else renderSecret(selected.name, selected.collection);
    if (selected) setPanel(true);
  };
  const select = async (s: Selection): Promise<void> => {
    if (!(await mayLeave())) return;
    selected = s;
    renderList();
    renderDetail();
    scrollPanelTop(detail);
  };

  // ── Forms ──
  const resourceOptions = (current: string): Array<{ value: string; label: string }> => {
    const names = (resources ?? []).map((r) => r.Name);
    if (current && !names.includes(current)) names.push(current);
    return [{ value: '', label: 'Choose a resource' }, ...names.sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }))];
  };
  /**
   * The permissions that can actually pass the wallet's check on a resource:
   * roles grant Read or Read & change on a database resource and only Use on
   * any other, and IRIS checks exactly the level the collection names.
   */
  const validPerms = (res: string): Array<'READ' | 'WRITE' | 'USE'> => {
    const r = (resources ?? []).find((x) => x.Name === res);
    if (!r) return ['READ', 'WRITE', 'USE'];
    return isDatabaseResource(r) ? ['READ', 'WRITE'] : ['USE'];
  };
  const permProblem = (res: string, perm: string): string | null => {
    if (!res || validPerms(res).includes(perm as 'READ')) return null;
    return validPerms(res).includes('USE') ? 'Roles can only grant Use on this resource, so choose Use' : 'Database resources are granted Read or Read & change, so choose one of those';
  };
  /** Resource + level; the level stays disabled until a resource is picked, because it follows the resource. */
  const pairFields = (prefix: string, pick: string, perm: string, how: string): string =>
    `<div class="crud-row">${selectField(`${prefix}Res`, 'Resource', resourceOptions(pick), pick, { required: true, searchable: true })}${selectField(`${prefix}Perm`, 'Permission', PERM_OPTIONS, perm, { width: 'sm', disabled: !pick, hint: pick ? undefined : 'Pick a resource first' })}</div>
     ${prefix === 'Use' ? '<p class="w-field-link"><a href="#/security/resources" target="_blank" rel="noopener">New resource… ↗</a> (opens in a new tab)</p>' : ''}
     <p class="w-preview" id="w-prev-${prefix}" aria-live="polite"></p>
     <div class="crud-note crud-note--warning" id="w-dbwarn-${prefix}" hidden><ev-icon name="alert-triangle" size="sm"></ev-icon><div>Database resources are widely held, and some web apps add them for everyone who signs in there. Use a dedicated resource for secrets.</div></div>
     <details class="w-how"><summary>How the check works</summary><p>${how}</p></details>`;

  const openCollectionEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    try { resources ??= await getResourceList(); } catch { resources = []; }
    const c = name ? collections.find((x) => x.Name === name) : undefined;
    const use = splitResource(c?.UseResource ?? ':READ');
    const edit = splitResource(c?.EditResource ?? ':WRITE');
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    const preview = (auto = false): void => {
      let v = readForm(detail);
      // Picking a resource moves the level to one its roles can grant, if it isn't already.
      let moved = false;
      for (const p of ['Use', 'Edit']) {
        const res = String(v[`${p}Res`] ?? '');
        if (auto && res && permProblem(res, String(v[`${p}Perm`] ?? ''))) {
          const ok = validPerms(res);
          const next = ok.includes('USE') ? 'USE' : p === 'Use' ? 'READ' : 'WRITE';
          const sel = detail.querySelector(`ev-select[name="${p}Perm"]`) as (HTMLElement & { value: string }) | null;
          if (sel) { sel.value = next; moved = true; }
        }
      }
      // The level follows the resource: off until one is picked.
      for (const p of ['Use', 'Edit']) {
        const sel = detail.querySelector(`ev-select[name="${p}Perm"]`) as (HTMLElement & { disabled: boolean }) | null;
        const has = !!String(v[`${p}Res`] ?? '');
        if (sel && sel.disabled === has) {
          sel.disabled = !has;
          sel.toggleAttribute('disabled', !has);
          sel.closest('ev-form-field')?.setAttribute('hint', has ? '' : 'Pick a resource first');
        }
      }
      if (moved) { v = readForm(detail); editor?.refresh(); }
      for (const p of ['Use', 'Edit']) {
        const res = String(v[`${p}Res`] ?? '');
        const r = (resources ?? []).find((x) => x.Name === res);
        const warn = detail.querySelector<HTMLElement>(`#w-dbwarn-${p}`);
        if (warn) warn.hidden = !(r && isDatabaseResource(r));
      }
      for (const p of ['Use', 'Edit']) {
        const res = String(v[`${p}Res`] ?? '');
        const el = detail.querySelector(`#w-prev-${p}`);
        const perm = String(v[`${p}Perm`] ?? 'READ');
        const problem = res ? permProblem(res, perm) : null;
        if (el) el.textContent = res ? `${problem ? `${problem}. ` : ''}${whoLine(whoFor(`${res}:${perm}`))}` : '';
      }
    };
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : 'New collection',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Create collection',
      sections:
        (name ? '' : section('Name', textField('Name', 'Collection name', '', { required: true, mono: true, maxlength: 64, hint: 'Letters, digits, - and _. Code refers to its secrets as name.secret.' }))) +
        section('Who can use its secrets', pairFields('Use', use.resource, use.perm,
          'Each time code uses a secret, the wallet checks this resource directly, at exactly the level you pick. On a database resource, Read lets code use the secrets (Read &amp; change is stricter). On any other resource the level is Use, the only one roles can grant there. Wallet administrators (Use on %Admin_Wallet) always pass.'),
          { hint: 'The wallet checks this resource directly, at the level you pick.' }) +
        section('Who can add or change secrets', pairFields('Edit', edit.resource, edit.perm,
          'Checked the same way whenever someone adds, replaces or deletes a secret: Read &amp; change on a database resource, Use on any other. Wallet administrators always pass. It’s usually a more restricted resource than the one for using secrets.'),
          { hint: 'Checked the same way when secrets are added, replaced or deleted.' }),

      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Collection name', message: 'Enter a name' });
          else if (!COLLECTION_NAME.test(n)) out.push({ field: 'Name', label: 'Collection name', message: 'Start with a letter; then letters, digits, - or _' });
          else if (collections.some((x) => x.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Collection name', message: 'A collection with this name already exists' });
        }
        if (!v.UseRes) out.push({ field: 'UseRes', label: 'Use resource', message: 'Choose a resource' });
        if (!v.EditRes) out.push({ field: 'EditRes', label: 'Change resource', message: 'Choose a resource' });
        const pu = permProblem(String(v.UseRes ?? ''), String(v.UsePerm ?? ''));
        if (pu) out.push({ field: 'UsePerm', label: 'Use permission', message: pu });
        const pe = permProblem(String(v.EditRes ?? ''), String(v.EditPerm ?? ''));
        if (pe) out.push({ field: 'EditPerm', label: 'Change permission', message: pe });
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        try {
          await saveWalletCollection(target, { UseResource: `${v.UseRes}:${v.UsePerm}`, EditResource: `${v.EditRes}:${v.EditPerm}` });
        } catch (err) {
          if (err instanceof AdminError && err.id === 'ResourceDoesNotExist') fieldError(detail, 'UseRes', 'This resource doesn’t exist');
          throw err;
        }
        leaveEdit();
        selected = { kind: 'collection', name: target };
        await load();
        scrollPanelTop(detail);
        toast(name ? `Collection ${target} saved.` : `Collection ${target} created.`);
      },
      onCancel: () => { leaveEdit(); if (name || selected) renderDetail(); else setPanel(false); },
    });
    formEvents = new AbortController();
    for (const ev of ['ev-select-change', 'change']) detail.addEventListener(ev, () => preview(true), { signal: formEvents.signal });
    preview();
  };

  const kindSections = (kind: SecretKind, replacing: boolean): string => {
    const kv = Array.from({ length: KV_ROWS }, (_, i) => `<div class="crud-row">${
      textField(`Key${i}`, i === 0 ? 'Key' : `Key ${i + 1}`, replacing ? '' : ['user', 'password', ''][i], { mono: true, placeholder: i ? 'optional' : 'e.g. password' })}${
      passwordField(`Value${i}`, i === 0 ? 'Value' : `Value ${i + 1}`)}</div>`).join('');
    const kvOptions = replacing ? '' : `
      ${checkField('RequireTLS', 'Only send it over TLS', true, { hint: 'For HTTP and SOAP requests.' })}
      ${textField('AllowedHosts', 'Only send it to these hosts', '', { hint: 'Comma-separated. Leave empty for any host.' })}
      <p class="crud-section-hint">Can be used for</p>
      <div class="crud-row">${checkField('UseHTTP', 'HTTP requests', true)}${checkField('UseSOAP', 'SOAP web services', true)}${checkField('UseSQL', 'SQL Gateway', true)}</div>`;
    const symLen = selectField('SymLength', 'Key length', [{ value: '16', label: '128-bit (AES-128)' }, { value: '24', label: '192-bit (AES-192)' }, { value: '32', label: '256-bit (AES-256)' }], '32');
    const rsaLen = selectField('RsaLength', 'Key length', [{ value: '2048', label: '2048-bit' }, { value: '3072', label: '3072-bit' }, { value: '4096', label: '4096-bit' }], '3072');
    return `
      <div data-kind="%Wallet.KeyValue"${kind === '%Wallet.KeyValue' ? '' : ' hidden'}>
        ${section(replacing ? 'New values' : 'Values', kv, { hint: replacing ? 'Keys you enter replace their stored values; stored keys you leave out keep theirs.' : 'Each key names one value, e.g. user and password. Values are never shown again.' })}
        ${kvOptions ? section('Where it can be used', kvOptions) : ''}
      </div>
      <div data-kind="%Wallet.SymmetricKey"${kind === '%Wallet.SymmetricKey' ? '' : ' hidden'}>
        ${section(replacing ? 'New key' : 'Key', symLen, { hint: 'IRIS generates a random key. Nobody sees it, including you.' })}
        ${replacing ? '<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>Anything encrypted with the current key can’t be decrypted after it’s replaced.</div></div>' : ''}
      </div>
      <div data-kind="%Wallet.RSA"${kind === '%Wallet.RSA' ? '' : ' hidden'}>
        ${section(replacing ? 'New key pair' : 'Key pair', rsaLen, { hint: 'IRIS generates the pair. The private key never leaves IRIS.' })}
        ${replacing ? '<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>Signatures made with the current key no longer verify, and data encrypted for it can’t be decrypted.</div></div>' : ''}
      </div>`;
  };

  const openSecretEditor = async (full: string | null, coll: string): Promise<void> => {
    if (!(await mayLeave())) return;
    const existing = full ? secretsOf(coll).find((s) => s.Name === full) : undefined;
    if (full && !existing) return;
    const fixedKind = existing ? (existing.Type as SecretKind) : null;
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    const kindOf = (): SecretKind => fixedKind ?? (String(readForm(detail).Kind || '%Wallet.KeyValue') as SecretKind);
    const replaceLabel = fixedKind ? typeOf(fixedKind).replace : 'Create secret';
    editor = editorShell(detail, {
      subtitle: full ? `Secret in ${esc(coll)}` : undefined,
      title: full ? `${esc(typeOf(fixedKind ?? '').replace)}: <span class="mono">${esc(shortName(full, coll))}</span>` : 'New secret',
      name: full ? shortName(full, coll) : undefined,
      submitLabel: replaceLabel,
      // A generated key has nothing to type: allow Save straight away.
      startDirty: !!fixedKind && fixedKind !== '%Wallet.KeyValue',
      sections:
        (full ? '' : section('Secret',
          selectField('Coll', 'Collection', collections.map((c) => ({ value: c.Name, label: c.Name })), coll, { required: true }) +
          textField('Name', 'Name', '', { required: true, mono: true, maxlength: 120, hint: 'Letters, digits, -, _ and dots.' }) +
          `<p class="w-preview" id="w-fullname" aria-live="polite"></p>` +
          selectField('Kind', 'Kind', Object.entries(TYPES).map(([value, t]) => ({ value, label: t.label })), '%Wallet.KeyValue'))) +
        kindSections(fixedKind ?? '%Wallet.KeyValue', !!full),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        const kind = kindOf();
        if (!full) {
          const c = String(v.Coll ?? '');
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (!SECRET_NAME.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Use letters, digits, -, _ or dots' });
          else if (`${c}.${n}`.length > 128) out.push({ field: 'Name', label: 'Name', message: 'Too long with the collection name' });
          else if (secretsOf(c).some((s) => s.Name.toLowerCase() === `${c}.${n}`.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: `${c} already has a secret with this name` });
        }
        if (kind === '%Wallet.KeyValue') {
          const keys: string[] = [];
          for (let i = 0; i < KV_ROWS; i++) {
            const k = String(v[`Key${i}`] ?? '').trim();
            const val = String(v[`Value${i}`] ?? '');
            if (k && !val) out.push({ field: `Value${i}`, label: `Value for ${k}`, message: 'Enter the value' });
            else if (!k && val) out.push({ field: `Key${i}`, label: 'Key', message: 'Name this value' });
            else if (k && keys.includes(k)) out.push({ field: `Key${i}`, label: 'Key', message: 'This key is already used above' });
            if (k) keys.push(k);
          }
          const any = Array.from({ length: KV_ROWS }, (_, i) => String(v[`Key${i}`] ?? '').trim() && String(v[`Value${i}`] ?? '')).some(Boolean);
          if (!any && !out.length) out.push({ field: 'Value0', label: 'Value', message: 'Enter at least one key and value' });
          if (!full && !v.UseHTTP && !v.UseSOAP && !v.UseSQL) out.push({ field: 'UseHTTP', label: 'Can be used for', message: 'Choose at least one use' });
        }
        return out;
      },
      onSubmit: async (v) => {
        const kind = kindOf();
        const c = full ? coll : String(v.Coll);
        const target = full ?? `${c}.${String(v.Name).trim()}`;
        let config: Record<string, unknown>;
        if (kind === '%Wallet.KeyValue') {
          const secret: Record<string, string> = {};
          for (let i = 0; i < KV_ROWS; i++) {
            const k = String(v[`Key${i}`] ?? '').trim();
            if (k) secret[k] = String(v[`Value${i}`] ?? '');
          }
          config = { Secret: secret };
          if (!full) {
            config.RequireTLS = !!v.RequireTLS;
            config.Usage = [v.UseHTTP && 'HTTP', v.UseSOAP && 'SOAP', v.UseSQL && 'SQL'].filter(Boolean);
            const hosts = String(v.AllowedHosts ?? '').split(',').map((h) => h.trim()).filter(Boolean);
            if (hosts.length) config.AllowedHosts = hosts.join(',');
          }
        } else {
          config = { Length: Number(kind === '%Wallet.SymmetricKey' ? v.SymLength : v.RsaLength) };
          if (full) {
            const ok = await confirm({
              title: `${typeOf(kind).replace} for ${shortName(full, coll)}?`,
              body: kind === '%Wallet.SymmetricKey'
                ? `<p>IRIS generates a new key. <b>Anything encrypted with the current key can’t be decrypted afterwards.</b></p>`
                : `<p>IRIS generates a new key pair. <b>Signatures made with the current key stop verifying</b>, and data encrypted for it can’t be decrypted.</p>`,
              confirmLabel: typeOf(kind).replace,
              danger: true,
            });
            if (!ok) return;
          }
        }
        await saveWalletSecret(target, kind, config);
        leaveEdit();
        selected = { kind: 'secret', name: target, collection: c };
        await load();
        scrollPanelTop(detail);
        toast(full ? `${shortName(target, c)}: ${kind === '%Wallet.KeyValue' ? 'values replaced' : 'new key generated'}.` : `Secret ${target} created.`);
      },
      onCancel: () => { leaveEdit(); if (selected) renderDetail(); else setPanel(false); },
    });
    const sync = (): void => {
      const kind = kindOf();
      detail.querySelectorAll<HTMLElement>('[data-kind]').forEach((el) => { el.hidden = el.dataset.kind !== kind; });
      const v = readForm(detail);
      const fn = detail.querySelector('#w-fullname');
      if (fn) fn.textContent = String(v.Name ?? '').trim() ? `Code will refer to it as ${String(v.Coll)}.${String(v.Name).trim()}` : '';
      editor?.refresh();
    };
    formEvents = new AbortController();
    if (!full) for (const ev of ['ev-select-change', 'ev-input-input', 'change']) detail.addEventListener(ev, sync, { signal: formEvents.signal });
  };

  // ── Delete ──
  const removeCollection = async (name: string): Promise<void> => {
    const list = secretsOf(name);
    const names = list.slice(0, 5).map((s) => `<li class="mono">${esc(shortName(s.Name, name))}</li>`).join('');
    const ok = await confirm({
      title: `Delete collection ${name}?`,
      body: list.length
        ? `<p><b>Deletes its ${plural(list.length, 'secret')} with it</b>:</p><ul>${names}${list.length > 5 ? `<li>and ${num(list.length - 5)} more</li>` : ''}</ul><p>Code that uses them stops working, and anything encrypted with its keys can’t be decrypted. This can’t be undone.</p>`
        : '<p>It has no secrets. This can’t be undone.</p>',
      confirmLabel: 'Delete collection',
      danger: true,
      typeToConfirm: list.length ? name : undefined,
    });
    if (!ok) return;
    try {
      await deleteWalletCollection(name);
      selected = null;
      setPanel(false);
      await load();
      toast(`Collection ${name} deleted${list.length ? `, with ${plural(list.length, 'secret')}` : ''}.`);
    } catch (err) { toast(errorText(err), 'danger'); }
  };
  const removeSecret = async (full: string, coll: string): Promise<void> => {
    const s = secretsOf(coll).find((x) => x.Name === full);
    const sym = s?.Type === '%Wallet.SymmetricKey';
    const rsa = s?.Type === '%Wallet.RSA';
    const ok = await confirm({
      title: `Delete ${shortName(full, coll)}?`,
      body: `<p>Code that refers to <b class="mono">${esc(full)}</b> stops working.${sym ? ' <b>Anything encrypted with this key becomes unreadable for good.</b>' : ''}${rsa ? ' <b>Anything encrypted for this key pair becomes unreadable for good, and signatures made with it can no longer be verified.</b>' : ''} This can’t be undone.</p>`,
      confirmLabel: 'Delete secret',
      danger: true,
      typeToConfirm: sym || rsa ? shortName(full, coll) : undefined,
    });
    if (!ok) return;
    try {
      await deleteWalletSecret(full);
      selected = { kind: 'collection', name: coll };
      await load();
      scrollPanelTop(detail);
      toast(`Secret ${full} deleted.`);
    } catch (err) { toast(errorText(err), 'danger'); }
  };

  // ── Header, loading ──
  const newBtn = newButton(ctx, 'New collection', () => void openCollectionEditor(null));
  const updated = liveIndicator(ctx, () => void load(), { live: false });

  const load = async (): Promise<void> => {
    try {
      const list = await getWalletCollections();
      const results = await Promise.all(list.map(async (c) => {
        try { return [c.Name, await getWalletSecrets(c.Name)] as const; } catch (e) { return [c.Name, e instanceof Error ? e : new Error(String(e))] as const; }
      }));
      if (!alive) return;
      collections = list.sort((a, b) => a.Name.localeCompare(b.Name));
      secrets.clear();
      for (const [n, s] of results) secrets.set(n, s);
      loaded = true;
      updated(new Date());
      renderList();
      renderFoot();
      banner();
      if (!editor) renderDetail();
    } catch (err) {
      if (!alive) return;
      toolbar.hidden = true;
      main.innerHTML = errorPanel(err, 'retry-wallet');
      main.querySelector('#retry-wallet')?.addEventListener('click', () => void load());
    }
  };

  $('#w-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    if (loaded) renderList();
  });

  sessionInfo().then((info) => {
    canEdit = can(info, 'Wallet');
    if (!alive) return;
    newBtn.setHidden(canEdit === false);
    if (!editor) renderDetail();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  /**
   * The one notice line, only for a risk specific to these collections: a use
   * permission that's public, held by UnknownUser directly, or added by a web
   * app that lets people in without signing in. The instance-wide "UnknownUser
   * holds %All" posture isn't repeated here; it's flagged on each row instead.
   */
  const banner = (): void => {
    if (!alive) return;
    const open = graph ? collections.filter((c) => { const r = anonReason(c); return !!r && r !== 'all'; }) : [];
    const local: LocalRisk | null = open.length ? {
      tone: 'danger',
      headline: `Anyone who connects without signing in can use the secrets in ${open.length === 1 ? open[0].Name : plural(open.length, 'collection')}.`,
      showThem: { label: 'Show them', run: () => void select({ kind: 'collection', name: open[0].Name }) },
    } : null;
    mountSecurityBanner(ctx.banners, graph, local);
  };

  // The graph (who holds which roles) is only needed for the "who can" chains.
  getSecurityGraph().then((g) => { graph = g; appMemo.clear(); if (!alive) return; banner(); if (loaded) renderList(); if (!editor) renderDetail(); }).catch(() => { /* chains say they're working it out */ });

  void load();
}
