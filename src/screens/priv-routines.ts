// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web & APIs › Privileged routine applications — named grants of extra roles
 * to listed routines and classes. Code in a listed routine or class asks IRIS
 * to add the application's roles for the rest of the process's work; IRIS
 * agrees only if the caller holds Use on the application's resource (or the
 * application has none). Full create, edit, enable/disable and delete.
 *
 * Every save sends the whole definition: IRIS replaces the routine list on
 * each save, so a partial save would empty it.
 */
import '../styles-apps.css';
import '../styles-security.css';
import '../styles-web.css';
import {
  getPrivRoutineList, getPrivRoutine, savePrivRoutine, deletePrivRoutine, appNameFree, splitRoles, joinRoles,
  docsWeb, type PrivRoutineRow, type PrivRoutineApp, type PrivRoutine, type MatchRole,
} from '../api-web';
import { getDatabases } from '../api-db';
import {
  getSecurityGraph, getRoleList, getResourceList, linkTo, normPerms, PRIVILEGED_ROLES, ANON_USER,
  type SecurityGraph, type RoleSummary, type ResourceSummary,
} from '../api-security';
import { mountSecurityBanner, type LocalRisk } from '../security-view';
import { plural, noPermissionText, esc, cell, chip, num, skeleton, errorPanel, liveIndicator, emptyState, uniformKeys, type ScreenCtx } from '../ui';
import {
  confirm, toast, errorText, newButton, moreButton, moreMenu, editorShell, panelWidth, section, textField, selectField, checkField,
  readForm, fieldError, focusField, rolePicker, blockedAttrs, scrollPanelTop, AdminError, isDatabaseResource,
  type FieldProblem, type EditorHandle,
} from '../crud';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const NO_SECURE = noPermissionText('%Admin_Secure', 'security administration');
// Not ui.ts kv: the third argument wraps the value (kv-wrap) instead of setting a tooltip.
const kv = (k: string, v: string, wrap = false): string => `<div class="kv"><dt>${k}</dt><dd${wrap ? ' class="kv-wrap"' : ''}>${v}</dd></div>`;
const powerful = (roles: string[]): string[] => roles.filter((r) => PRIVILEGED_ROLES.includes(r));

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

interface AppInfo extends PrivRoutineRow { detail: PrivRoutineApp | null; error?: unknown }

export function privRoutinesScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="pr-toolbar" hidden>
      <div class="search-box"><ev-search id="pr-search" size="sm" full-width placeholder="Filter by name, role, routine or resource" aria-label="Filter applications"></ev-search></div>
    </div>
    <ev-detail-panel id="pr-panel" detail-width="400" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="pr-wrap">${skeleton(6)}</div>
      <aside slot="detail" class="detail" id="pr-detail" aria-label="Application details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="pr-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#pr-panel');
  const wrap = $('#pr-wrap');
  const detail = $('#pr-detail');
  const toolbar = $('#pr-toolbar');

  let apps: AppInfo[] = [];
  let loaded = false;
  let selected: string | null = null;
  let query = '';
  let grid: GridEl | null = null;
  let graph: SecurityGraph | null = null;
  let roles: RoleSummary[] | null = null;
  let resources: ResourceSummary[] | null = null;
  let databases: string[] | null = null;
  let canSecure: boolean | null = null;
  let alive = true;
  let busy = false;

  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let formEvents: AbortController | null = null;
  const leaveEdit = (): void => {
    editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; formEvents?.abort(); formEvents = null; ctx.beforeLeave(null);
  };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });
  const blocked = (): string => (canSecure === false ? NO_SECURE : '');

  // ── What an application means today ──
  /** Who can make the call succeed: nobody is checked without a resource, or when the resource is public. */
  interface Gate { open: boolean; resource: string; exists: boolean; users: string[]; roles: string[]; anon: boolean }
  const gateOf = (resource: string): Gate => {
    if (!resource) return { open: true, resource, exists: true, users: [], roles: [], anon: true };
    const r = graph?.resource(resource);
    const pub = normPerms(r?.PublicPermission ?? '').includes('U');
    const who = graph?.whoCan(resource);
    const users = [...new Set((who?.users ?? []).filter((u) => normPerms(u.perms).includes('U')).map((u) => u.user))];
    const viaRoles = (who?.roles ?? []).filter((x) => normPerms(x.perms).includes('U')).map((x) => x.role);
    return { open: pub, resource, exists: graph ? !!r : true, users, roles: viaRoles, anon: pub || users.includes(ANON_USER) };
  };
  /** Who can change the listed code: Read & change on the database that holds it. */
  interface CodeGate { db: string; resource: string; pub: boolean; users: string[]; anon: boolean }
  const codeGateOf = (db: string): CodeGate | null => {
    if (!graph) return null;
    const resource = graph.databaseResource(db) ?? '';
    if (!resource) return { db, resource, pub: false, users: [], anon: false };
    const r = graph.resource(resource);
    const pub = normPerms(r?.PublicPermission ?? '').includes('W');
    const users = [...new Set(graph.whoCan(resource).users.filter((u) => normPerms(u.perms).includes('W')).map((u) => u.user))];
    return { db, resource, pub, users, anon: pub || users.includes(ANON_USER) };
  };
  const grantsOf = (d: PrivRoutineApp | null): string[] => (d ? [...new Set(d.MatchRoles.flatMap((m) => m.TargetRoles))] : []);
  const grantText = (d: PrivRoutineApp | null): string => {
    if (!d) return '';
    const { appRoles, matches } = splitRoles(d.MatchRoles);
    const parts: string[] = [];
    if (appRoles.length) parts.push(appRoles.join(', '));
    if (matches.length) parts.push(`${plural(matches.length, 'matching rule')}`);
    return parts.join(' + ') || 'Nothing';
  };
  const codeText = (d: PrivRoutineApp | null): string => {
    if (!d) return '';
    const r = d.Routines.filter((x) => x.Type === 'Routine').length;
    const c = d.Routines.length - r;
    return [r ? plural(r, 'routine') : '', c ? plural(c, 'class', 'classes') : ''].filter(Boolean).join(', ') || 'None listed';
  };
  /** Enabled applications that hand roles to anyone who runs their code, and those whose code anyone can change. */
  const risks = (): { open: AppInfo[]; writable: AppInfo[] } => {
    const on = apps.filter((a) => a.detail?.Enabled && grantsOf(a.detail).length);
    return {
      open: on.filter((a) => gateOf(a.detail?.Resource ?? a.Resource).open),
      writable: on.filter((a) => a.detail?.Routines.some((rt) => codeGateOf(rt.Db)?.anon)),
    };
  };

  // ── Grid ──
  const COLUMNS: DataGridColumn[] = [
    { key: 'Name', label: 'Name', width: '200px', sortable: true, renderCell: (v) => cell.id(v, String(v)) },
    { key: 'Grants', label: 'Roles added', width: '220px', sortable: true, renderCell: (v) => (v ? cell.text(v, String(v)) : cell.dim('—')) },
    { key: 'Who', label: 'Required resource', width: '180px', sortable: true, description: '— means no resource: anyone who runs the listed code gets the roles',
      renderCell: (v) => (v ? cell.mono(v, false, String(v)) : cell.dim('—')) } as DataGridColumn,
    { key: 'Code', label: 'Routines & classes', width: '150px', sortable: true, renderCell: (v) => (v ? cell.text(v) : cell.dim('—')) },
    { key: 'Enabled', label: 'Status', width: '96px', sortable: true, renderCell: (v, row) => (row.Loading ? cell.dim('—') : v ? chip('Enabled', 'success') : chip('Disabled', 'neutral')) },
  ];
  const toRow = (a: AppInfo): DataGridRow => {
    const d = a.detail;
    const res = d?.Resource ?? a.Resource;
    const g = gateOf(res);
    return {
      Name: a.Name,
      Grants: d ? (grantText(d) === 'Nothing' ? '' : grantText(d)) : a.error ? 'Couldn’t read it' : '',
      Power: powerful(grantsOf(d)).join(', '),
      Who: res ? (g.open ? `${res} (public)` : res) : '',
      OpenRisk: !!d?.Enabled && grantsOf(d).length > 0 && g.open,
      Code: d && d.Routines.length ? codeText(d) : '',
      Enabled: !!d?.Enabled, Loading: !d,
    };
  };
  const matches = (a: AppInfo): boolean => {
    if (!query) return true;
    const ql = query.toLowerCase();
    const d = a.detail;
    return [a.Name, d?.Description ?? '', d?.Resource ?? a.Resource, ...grantsOf(d), ...(d?.MatchRoles.map((m) => m.MatchRole) ?? []), ...(d?.Routines.flatMap((r) => [r.RoutineOrClass, r.Db]) ?? [])]
      .some((f) => f.toLowerCase().includes(ql));
  };

  const renderEmpty = (): void => {
    grid = null;
    toolbar.hidden = true;
    wrap.innerHTML = emptyState({
      icon: 'key-round',
      title: 'No privileged routine applications',
      what: 'A privileged routine application lets chosen routines and classes add roles to whoever runs them.',
      docs: { href: docsWeb.privRoutine, label: 'About privileged routine applications' },
    });
  };
  const renderGrid = (): void => {
    if (!apps.length) { renderEmpty(); return; }
    toolbar.hidden = false;
    const rows = apps.filter(matches).map(toRow);
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        void select(name);
      });
      wrap.appendChild(grid);
    }
    grid.rows = rows;
    // A column that says the same thing on every application steps aside (judged on all of them, so filtering never moves columns).
    const same = uniformKeys(apps.map(toRow), ['Who', 'Code', 'Enabled']);
    for (const k of ['Who', 'Code', 'Enabled']) grid.setColumnVisible(k, !same.has(k));
    grid.select(selected ? [selected] : []);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">No applications match “${esc(query)}”.</div>`);
  };
  const renderFoot = (): void => {
    const on = apps.filter((a) => a.detail?.Enabled).length;
    const code = apps.reduce((n, a) => n + (a.detail?.Routines.length ?? 0), 0);
    const r = risks();
    if (!apps.length) { $('#pr-foot').innerHTML = ''; return; }
    $('#pr-foot').innerHTML = `<b>${num(apps.length)}</b> application${apps.length === 1 ? '' : 's'}<span class="meta-sep">·</span><b>${num(on)}</b> enabled<span class="meta-sep">·</span><b>${num(code)}</b> routines &amp; classes`
      + (r.open.length ? `<span class="meta-sep">·</span><b>${num(r.open.length)}</b> open to anyone` : '');
  };
  const banner = (): void => {
    if (!alive) return;
    const r = risks();
    let local: LocalRisk | null = null;
    if (r.writable.length) {
      const a = r.writable[0];
      local = {
        tone: 'danger',
        headline: `Anyone can change code that ${r.writable.length === 1 ? `${a.Name} lets add roles` : `${plural(r.writable.length, 'application')} let add roles`}`,
        showThem: { label: 'Show it', run: () => void select(a.Name) },
      };
    } else if (r.open.length) {
      const all = r.open.flatMap((a) => powerful(grantsOf(a.detail)));
      const a = r.open[0];
      local = {
        tone: all.length ? 'danger' : 'warning',
        headline: r.open.length === 1
          ? `${a.Name} adds ${grantsOf(a.detail).join(', ')} for anyone who runs its code`
          : `${plural(r.open.length, 'privileged routine application')} add roles for anyone who runs their code`,
        showThem: { label: r.open.length === 1 ? 'Show it' : 'Show the first', run: () => void select(a.Name) },
      };
    }
    mountSecurityBanner(ctx.banners, graph, local);
  };

  // ── Detail ──
  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => { selected = null; grid?.select([]); setPanel(false); };
  const roleChip = (r: string): string =>
    `<button type="button" class="chip-link" data-role="${esc(r)}" aria-label="Open role ${esc(r)}">${chip(r, PRIVILEGED_ROLES.includes(r) ? 'warning' : 'neutral', 'Open this role')}</button>`;

  const renderDetail = (): void => {
    const a = apps.find((x) => x.Name === selected);
    if (!a) { closeDetail(); return; }
    const d = a.detail;
    const head = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">Privileged routine application${a.IsSystemApp ? ' · system' : ''}</span><h2 class="mono">${esc(a.Name)}</h2>${d?.Description ? `<p class="detail-subtitle">${esc(d.Description)}</p>` : ''}</div>
        <ev-icon-button icon="x" label="Close details" id="pr-close"></ev-icon-button>
      </header>
      <div class="detail-state">${d ? (d.Enabled ? chip('Enabled', 'success') : chip('Disabled', 'neutral', 'The code can’t add the roles until it’s enabled')) : ''}</div>`;
    if (!d) {
      detail.innerHTML = `${head}${a.error ? errorPanel(a.error, 'pr-retry') : skeleton(6)}`;
      detail.querySelector('#pr-close')?.addEventListener('click', closeDetail);
      detail.querySelector('#pr-retry')?.addEventListener('click', () => void load());
      setPanel(true);
      return;
    }
    const { appRoles, matches: rules } = splitRoles(d.MatchRoles);
    const g = gateOf(d.Resource);
    const grants = grantsOf(d);
    const power = powerful(grants);

    const openWarn = d.Enabled && grants.length && g.open ? `
      <div class="callout ${power.length ? 'callout--danger' : 'callout--warning'}" role="note"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>
        <strong>Anyone who runs the listed code gets ${esc(grants.join(', '))}</strong>
        <span>${d.Resource ? `${esc(d.Resource)} is public, so everyone holds Use on it.` : 'There’s no resource, so IRIS doesn’t check who is asking.'} Choose a resource that only the right people hold.</span>
      </div></div>` : '';

    const whoBlock = d.Resource
      ? (g.open ? `<p class="detail-para">Everyone: <span class="mono">${esc(d.Resource)}</span> is public.</p>`
        : !g.exists ? `<p class="detail-para check-warn">There’s no resource called <span class="mono">${esc(d.Resource)}</span>, so only %All holders can add the roles.</p>`
        : `<p class="detail-para">People who hold Use on <button type="button" class="link link--inline mono" id="pr-res">${esc(d.Resource)}</button>${graph ? `: ${plural(g.users.length, 'user')}${g.roles.length ? ` through ${g.roles.length <= 3 ? esc(g.roles.join(', ')) : plural(g.roles.length, 'role')}` : ''}.` : '.'}</p>
           ${g.users.length ? `<div class="chip-list">${g.users.slice(0, 12).map((u) => `<button type="button" class="chip-link" data-user="${esc(u)}" aria-label="Open user ${esc(u)}">${chip(u, u === ANON_USER ? 'warning' : 'neutral', 'Open this user')}</button>`).join('')}${g.users.length > 12 ? `<span class="dim">and ${num(g.users.length - 12)} more</span>` : ''}</div>` : ''}`)
      : '<p class="detail-para">Anyone who runs the listed code. No resource is required.</p>';

    const codeRows = d.Routines.length ? `<ul class="rows pr-code">${d.Routines.map((rt) => {
      const cg = codeGateOf(rt.Db);
      const who = !cg ? '' : cg.anon ? 'Anyone can change it' : cg.resource ? `${plural(cg.users.length, 'user')} can change it` : '';
      return `<li class="row"><span class="row-stack"><span class="row-main mono">${esc(rt.RoutineOrClass)}</span><span class="row-sub">${rt.Type === 'Class' ? 'Class' : 'Routine'} in ${esc(rt.Db)}${cg?.resource ? ` · changed with Read &amp; change on ${esc(cg.resource)}` : ''}</span></span>${
        who ? `<span class="row-chips">${chip(who, cg?.anon ? 'danger' : 'neutral', cg?.resource ? `Users with Read & change on ${cg.resource} can edit this code, and so decide what it does with the roles` : '')}</span>` : ''}</li>`;
    }).join('')}</ul>` : '<p class="chip-list-empty">No routines or classes listed yet, so no code can add the roles.</p>';

    const noPriv = blocked();
    detail.innerHTML = `${head}
      <div class="detail-actions detail-actions--nowrap">
        <button type="button" class="btn btn--sm" id="pr-edit"${blockedAttrs(noPriv)}>Edit</button>
        <button type="button" class="btn btn--sm" id="pr-toggle"${blockedAttrs(noPriv)}>${d.Enabled ? 'Disable…' : 'Enable'}</button>
        ${moreButton('pr-more', `More actions for ${a.Name}`)}
      </div>
      ${openWarn}
      <h3 class="detail-section">Roles it adds</h3>
      <dl class="kv-list">
        ${kv('To everyone who calls', appRoles.length ? `<span class="chips">${appRoles.map(roleChip).join('')}</span>` : '<span class="dim">—</span>', true)}
      </dl>
      ${rules.length ? `<p class="chip-sub">And by role held</p><ul class="rows pr-rules">${rules.map((m) => `<li class="row"><span class="row-main">Holders of ${roleChip(m.MatchRole)}</span><span class="row-chips">also get ${m.TargetRoles.map(roleChip).join('')}</span></li>`).join('')}</ul>` : ''}
      <p class="detail-note">Roles are added only when listed code asks, and last until that code’s work is done.</p>
      <h3 class="detail-section">Who can use it</h3>
      ${whoBlock}
      <h3 class="detail-section">Code that can ask · ${num(d.Routines.length)}</h3>
      ${codeRows}`;

    detail.querySelector('#pr-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#pr-edit')?.addEventListener('click', () => void openEditor(a.Name));
    detail.querySelector('#pr-toggle')?.addEventListener('click', (e) => void act(e.currentTarget as HTMLButtonElement, () => toggle(a)));
    detail.querySelector('#pr-res')?.addEventListener('click', () => linkTo(ctx.navigate, 'security/resources', d.Resource));
    detail.querySelectorAll<HTMLElement>('[data-role]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/roles', b.dataset.role ?? '')));
    detail.querySelectorAll<HTMLElement>('[data-user]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/users', b.dataset.user ?? '')));
    moreMenu(detail.querySelector('#pr-more') as HTMLElement, [
      { label: 'Copy name', icon: 'copy', onSelect: () => { void navigator.clipboard.writeText(a.Name).then(() => toast(`Copied ${a.Name}.`, 'info')); } },
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!noPriv || a.IsSystemApp,
        reason: noPriv || 'IRIS’s own applications can’t be deleted. Disable it instead.', onSelect: () => void act(null, () => remove(a)) },
    ]);
    setPanel(true);
  };

  const select = async (name: string): Promise<void> => {
    if (!(await mayLeave())) { grid?.select(selected ? [selected] : []); return; }
    selected = name;
    grid?.select([name]);
    renderDetail();
    scrollPanelTop(detail);
  };

  // ── Actions ──
  const act = async (btn: HTMLButtonElement | null, fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try { await fn(); } catch (err) {
      toast(err instanceof AdminError && err.status === 404 ? 'That application no longer exists.' : errorText(err), 'danger');
      await load();
    } finally {
      busy = false;
      if (btn?.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  };
  const toggle = async (a: AppInfo): Promise<void> => {
    const d = a.detail;
    if (!d) return;
    if (d.Enabled) {
      const ok = await confirm({
        title: `Disable ${a.Name}?`,
        body: `<p>The listed code can no longer add the application’s roles; its calls fail until it’s enabled again. Code already running keeps the roles it has. The settings are kept.</p>`,
        confirmLabel: 'Disable',
      });
      if (!ok) return;
    }
    // The whole definition goes back, with only Enabled changed.
    await savePrivRoutine(a.Name, { ...d, Enabled: !d.Enabled });
    toast(d.Enabled ? `${a.Name} is disabled. Its code can’t add roles.` : `${a.Name} is enabled.`);
    await load();
  };
  const remove = async (a: AppInfo): Promise<void> => {
    const d = a.detail;
    const inUse = !!d && d.Enabled && d.Routines.length > 0;
    const ok = await confirm({
      title: `Delete ${a.Name}?`,
      body: `<p>The application definition is removed for good.${d?.Routines.length ? ` The ${plural(d.Routines.length, 'routine or class', 'routines and classes')} it lists stay as they are, but their calls to add its roles start failing.` : ''} This can’t be undone.</p>${inUse ? '<p>Type the name to confirm.</p>' : ''}`,
      confirmLabel: 'Delete application',
      danger: true,
      typeToConfirm: inUse ? a.Name : undefined,
      alternative: d?.Enabled ? { label: 'Disable instead', onSelect: () => void act(null, () => toggle(a)) } : undefined,
    });
    if (!ok) return;
    await deletePrivRoutine(a.Name);
    closeDetail();
    toast(`${a.Name} deleted.`);
    await load();
  };

  // ── Editor ──
  let rowSeq = 0;
  const resourceOptions = (current: string): Array<{ value: string; label: string }> => {
    const names = (resources ?? []).filter((r) => !isDatabaseResource(r)).map((r) => r.Name);
    if (current && !names.includes(current)) names.push(current);
    return [{ value: '', label: 'None: anyone who runs the code' }, ...names.sort((x, y) => x.localeCompare(y)).map((n) => ({ value: n, label: n }))];
  };
  const dbOptions = (current: string): Array<{ value: string; label: string }> => {
    const names = [...(databases ?? [])];
    if (current && !names.includes(current)) names.push(current);
    return [{ value: '', label: 'Choose a database' }, ...names.sort().map((n) => ({ value: n, label: n }))];
  };
  const codeRow = (rt: PrivRoutine | null): string => {
    const i = rowSeq++;
    return `<div class="pr-edit-row pr-edit-row--code" data-code-row="${i}">
      ${textField(`CodeName${i}`, 'Routine or class', rt?.RoutineOrClass ?? '', { mono: true, placeholder: 'e.g. MyApp.Escalate' })}
      ${selectField(`CodeType${i}`, 'Kind', [{ value: 'Routine', label: 'Routine' }, { value: 'Class', label: 'Class' }], rt?.Type ?? 'Routine')}
      ${selectField(`CodeDb${i}`, 'Database', dbOptions(rt?.Db ?? ''), rt?.Db ?? '', { searchable: (databases?.length ?? 0) > 8 })}
      <ev-icon-button icon="x" size="sm" label="Remove this line" data-remove-row></ev-icon-button>
    </div>`;
  };
  const ruleRow = (m: MatchRole | null): string => {
    const i = rowSeq++;
    const opts = [{ value: '', label: 'Choose a role' }, ...(roles ?? []).map((r) => ({ value: r.Name, label: r.Name }))];
    return `<div class="pr-edit-row pr-edit-row--rule" data-rule-row="${i}">
      ${selectField(`RuleRole${i}`, 'Holders of', opts, m?.MatchRole ?? '', { searchable: true })}
      <div class="pr-rule-targets" id="pr-targets-${i}" data-targets="${i}" data-initial="${esc((m?.TargetRoles ?? []).join(','))}"></div>
      <ev-icon-button icon="x" size="sm" label="Remove this rule" data-remove-row></ev-icon-button>
    </div>`;
  };
  const mountTargets = (): void => {
    detail.querySelectorAll<HTMLElement>('[data-targets]:not([data-crud-name])').forEach((host) => {
      const initial = (host.dataset.initial ?? '').split(',').filter(Boolean);
      rolePicker(host, { all: roles ?? [], selected: initial, name: `RuleTargets${host.dataset.targets}`, label: 'also get', emptyText: 'No roles yet', onChange: () => { editor?.refresh(); preview(); } });
    });
  };
  const readCode = (): PrivRoutine[] => {
    const v = readForm(detail);
    return [...detail.querySelectorAll<HTMLElement>('[data-code-row]')].map((row) => {
      const i = row.dataset.codeRow;
      return { RoutineOrClass: String(v[`CodeName${i}`] ?? '').trim(), Type: (String(v[`CodeType${i}`] ?? 'Routine') === 'Class' ? 'Class' : 'Routine') as PrivRoutine['Type'], Db: String(v[`CodeDb${i}`] ?? '') };
    });
  };
  const readRules = (): MatchRole[] => {
    const v = readForm(detail);
    return [...detail.querySelectorAll<HTMLElement>('[data-rule-row]')].map((row) => {
      const i = row.dataset.ruleRow;
      const t = v[`RuleTargets${i}`];
      return { MatchRole: String(v[`RuleRole${i}`] ?? ''), TargetRoles: Array.isArray(t) ? t.map(String) : [] };
    });
  };
  const preview = (): void => {
    const el = detail.querySelector('#pr-preview');
    const warn = detail.querySelector<HTMLElement>('#pr-open-warn');
    if (!el || !warn) return;
    const v = readForm(detail);
    const res = String(v.Resource ?? '');
    const app = Array.isArray(v.AppRoles) ? v.AppRoles.map(String) : [];
    const all = [...new Set([...app, ...readRules().flatMap((m) => m.TargetRoles)])];
    const g = gateOf(res);
    el.textContent = !res ? 'Anyone who runs the listed code can add the roles.'
      : g.open ? `${res} is public, so anyone who runs the listed code can add the roles.`
      : graph ? `Today that’s ${plural(g.users.length, 'user')}${g.roles.length ? ` through ${g.roles.length <= 3 ? g.roles.join(', ') : plural(g.roles.length, 'role')}` : ''}, plus anyone with %All.` : '';
    warn.hidden = !(g.open && all.length);
    const strong = warn.querySelector('strong');
    if (strong) strong.textContent = `Anyone who runs the listed code would get ${all.join(', ')}`;
  };

  const openEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    const a = name ? apps.find((x) => x.Name === name) : undefined;
    if (name && !a?.detail) return;
    try {
      [roles, resources, databases] = await Promise.all([
        roles ? Promise.resolve(roles) : getRoleList(),
        resources ? Promise.resolve(resources) : getResourceList(),
        databases ? Promise.resolve(databases) : getDatabases().then((l) => l.map((x) => x.name)),
      ]);
    } catch (err) { toast(errorText(err), 'danger'); return; }
    const d = a?.detail ?? null;
    const { appRoles, matches: rules } = splitRoles(d?.MatchRoles ?? []);
    restoreWidth ??= panelWidth(panel, 560);
    setPanel(true);
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : 'New privileged routine application',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Create application',
      sections:
        section('Application',
          (name ? '' : textField('Name', 'Name', '', { required: true, mono: true, maxlength: 128, hint: 'Code asks for the roles by this name.' })) +
          textField('Description', 'Description', d?.Description ?? '', { maxlength: 256 }) +
          checkField('Enabled', 'Enabled', d?.Enabled ?? true, { toggle: true, hint: 'While it’s off, the code’s calls to add roles fail.' })) +
        section('Who can use it',
          selectField('Resource', 'Resource required', resourceOptions(d?.Resource ?? ''), d?.Resource ?? '', { searchable: true, hint: 'The person running the code needs Use on it.' }) +
          `<p class="web-preview" id="pr-preview" aria-live="polite"></p>
           <div class="crud-note crud-note--warning" id="pr-open-warn" hidden><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong></strong> Choose a resource that only the right people hold.</div></div>`,
          { hint: 'Without a resource, IRIS doesn’t check who is asking.' }) +
        section('Roles it adds',
          '<div id="pr-app-roles"></div>' +
          `<p class="crud-section-hint">By role held: people who hold a role get more roles.</p>
           <div class="pr-rows" id="pr-rules">${rules.map(ruleRow).join('')}</div>
           <button type="button" class="btn btn--sm btn--quiet" id="pr-add-rule"><ev-icon name="plus" size="xs"></ev-icon>Add a rule</button>`,
          { hint: 'Added only while the listed code runs, and only after it asks.' }) +
        section('Code that can ask',
          `<div class="pr-rows" id="pr-code">${(d?.Routines ?? []).map(codeRow).join('') || codeRow(null)}</div>
           <button type="button" class="btn btn--sm btn--quiet" id="pr-add-code"><ev-icon name="plus" size="xs"></ev-icon>Add a routine or class</button>`,
          { hint: 'Only code listed here can add the roles. For a class, give the full name, e.g. MyApp.Escalate.' }),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!name) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (/[,:]/.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Leave out commas and colons' });
          else if (apps.some((x) => x.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'An application with this name already exists' });
        }
        const seen = new Set<string>();
        detail.querySelectorAll<HTMLElement>('[data-code-row]').forEach((row) => {
          const i = row.dataset.codeRow;
          const n = String(v[`CodeName${i}`] ?? '').trim();
          const kind = String(v[`CodeType${i}`] ?? 'Routine');
          const db = String(v[`CodeDb${i}`] ?? '');
          if (!n && !db) return;                                    // an empty line is ignored
          if (!n) out.push({ field: `CodeName${i}`, label: 'Routine or class', message: 'Enter a routine or class name' });
          else if (kind === 'Class' && !/^%?[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/.test(n)) out.push({ field: `CodeName${i}`, label: 'Class', message: 'Give the full class name, e.g. MyApp.Escalate' });
          else if (kind === 'Routine' && !/^%?[A-Za-z][A-Za-z0-9.]*$/.test(n)) out.push({ field: `CodeName${i}`, label: 'Routine', message: 'Letters, digits and dots only' });
          if (!db) out.push({ field: `CodeDb${i}`, label: 'Database', message: 'Choose the database that holds it' });
          const key = `${n}|${kind}|${db}`.toLowerCase();
          if (n && db && seen.has(key)) out.push({ field: `CodeName${i}`, label: 'Routine or class', message: 'Already listed above' });
          seen.add(key);
        });
        detail.querySelectorAll<HTMLElement>('[data-rule-row]').forEach((row) => {
          const i = row.dataset.ruleRow;
          const role = String(v[`RuleRole${i}`] ?? '');
          const t = v[`RuleTargets${i}`];
          const targets = Array.isArray(t) ? t : [];
          if (!role && !targets.length) return;
          if (!role) out.push({ field: `RuleRole${i}`, label: 'Holders of', message: 'Choose the role people must hold' });
          if (!targets.length) out.push({ field: `RuleTargets${i}`, label: 'also get', message: 'Add at least one role' });
        });
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        if (!name && !(await appNameFree(target))) {
          fieldError(detail, 'Name', 'That name is taken by another application (web, client or privileged routine)');
          focusField(detail, 'Name');
          throw new Error('Choose another name: an application with this name already exists.');
        }
        const app = Array.isArray(v.AppRoles) ? v.AppRoles.map(String) : [];
        const body: PrivRoutineApp = {
          Description: String(v.Description ?? ''),
          Enabled: !!v.Enabled,
          Resource: String(v.Resource ?? ''),
          Routines: readCode().filter((r) => r.RoutineOrClass && r.Db),
          MatchRoles: joinRoles(app, readRules().filter((m) => m.MatchRole && m.TargetRoles.length)),
        };
        const grants = [...new Set(body.MatchRoles.flatMap((m) => m.TargetRoles))];
        const power = powerful(grants);
        if (body.Enabled && power.length && gateOf(body.Resource).open) {
          const ok = await confirm({
            title: `Let anyone who runs this code get ${power.join(', ')}?`,
            body: `<p>${body.Resource ? `${esc(body.Resource)} is public` : 'There’s no resource'}, so IRIS won’t check who is asking. Anyone who can run the listed code gets ${esc(grants.join(', '))} while it runs.</p>`,
            confirmLabel: 'Save anyway',
            danger: true,
          });
          if (!ok) throw new Error('Not saved. Choose a resource to limit who can use it.');
        }
        await savePrivRoutine(target, body);
        leaveEdit();
        selected = target;
        await load();
        scrollPanelTop(detail);
        toast(name ? `${target} saved.` : `${target} created.${body.Routines.length ? '' : ' List the code that may use it next.'}`);
      },
      onCancel: () => { leaveEdit(); if (name && selected) renderDetail(); else closeDetail(); },
    });
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
    // Pickers mount synchronously so they are part of the unchanged baseline.
    rolePicker(detail.querySelector('#pr-app-roles') as HTMLElement, {
      all: roles ?? [], selected: appRoles, name: 'AppRoles', label: 'To everyone who calls', emptyText: 'No roles for everyone',
      onChange: () => preview(),
    });
    mountTargets();
    formEvents = new AbortController();
    const sig = { signal: formEvents.signal };
    detail.addEventListener('ev-select-change', preview, sig);
    detail.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const rm = t.closest('[data-remove-row]');
      if (rm) { rm.closest('.pr-edit-row')?.remove(); editor?.refresh(); preview(); return; }
      if (t.closest('#pr-add-code')) {
        detail.querySelector('#pr-code')?.insertAdjacentHTML('beforeend', codeRow(null));
        editor?.refresh();
        (detail.querySelector('#pr-code .pr-edit-row:last-child ev-input') as HTMLElement | null)?.focus();
      } else if (t.closest('#pr-add-rule')) {
        detail.querySelector('#pr-rules')?.insertAdjacentHTML('beforeend', ruleRow(null));
        mountTargets();
        editor?.refresh();
      }
    }, sig);
    preview();
  };

  // ── Header, loading ──
  const newBtn = newButton(ctx, 'New application', () => void openEditor(null));
  const updated = liveIndicator(ctx, () => void load(), { live: false });

  const load = async (): Promise<void> => {
    try {
      const list = await getPrivRoutineList();
      // The list's Enabled column is unreliable, so each application's own record is read.
      const full = await Promise.all(list.map(async (a): Promise<AppInfo> => {
        try { return { ...a, detail: await getPrivRoutine(a.Name) }; } catch (error) { return { ...a, detail: null, error }; }
      }));
      if (!alive) return;
      apps = full.sort((x, y) => x.Name.localeCompare(y.Name));
      loaded = true;
      updated(new Date());
      renderGrid();
      renderFoot();
      banner();
      if (!editor) { if (selected && apps.some((x) => x.Name === selected)) renderDetail(); else closeDetail(); }
    } catch (err) {
      if (!alive) return;
      grid = null;
      toolbar.hidden = true;
      wrap.innerHTML = errorPanel(err, 'pr-retry-list');
      wrap.querySelector('#pr-retry-list')?.addEventListener('click', () => void load());
    }
  };

  $('#pr-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    if (loaded) renderGrid();
  });

  sessionInfo().then((info) => {
    canSecure = can(info, 'Secure');
    if (!alive) return;
    newBtn.setHidden(canSecure === false);
    if (!editor && selected) renderDetail();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  getSecurityGraph().then((g) => {
    graph = g;
    if (!alive || !loaded) return;
    renderGrid(); renderFoot(); banner();
    if (!editor && selected) renderDetail();
  }).catch(() => { /* who-can lines say nothing rather than guess */ });

  void load();
}
