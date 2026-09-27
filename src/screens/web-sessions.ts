// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Web sessions — who is connected through the web right now, one
 * row per application: how many sessions, whose, and when the next one
 * expires if it goes idle. The peek (objectDetail) lists the application's
 * sessions; with the operator privilege a session, or every session of the
 * application, can be ended. IRIS doesn't let Management Portal or
 * state-aware sessions be ended this way, and the screen honours that even
 * though the call itself wouldn't check.
 */
import '../styles-security.css';
import '../styles-ops.css';
import { linkTo } from '../api-security';
import { getWebSessions, endWebSession, sessionExpiry, opsDocs, type WebSession } from '../api-ops';
import { noPermissionText, setSearch,
  cellId, cellRef, esc, cell, num, skeleton, errorPanel, liveIndicator, emptyState, when, relative, future,
  objectDetail, odMeta, odSection, type OdFull, type GridColumn, type ScreenCtx,
} from '../ui';
import { AdminError, confirm, errorText, toast, type MenuItem } from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

const REFRESH_MS = 10000;
const NO_OPERATE = noPermissionText('%Admin_Operate', 'system operation');
const ANON = 'UnknownUser';

type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};
type Scope = 'all' | 'apps' | 'portal';

const isPortalPath = (path: string): boolean => /\/csp\/sys\//i.test(path);
/** A plain name for the well-known apps; '' for the rest (the path says it). */
function appName(path: string): string {
  const p = path.toLowerCase();
  if (/^\/csp\/sys\/sec\//.test(p)) return 'Management Portal · Security';
  if (/^\/csp\/sys\/mgr\//.test(p)) return 'Management Portal · Configuration';
  if (/^\/csp\/sys\/op\//.test(p)) return 'Management Portal · Operations';
  if (/^\/csp\/sys\/exp\//.test(p)) return 'Management Portal · Explorer';
  if (/\/csp\/sys\//.test(p)) return 'Management Portal';
  if (/^\/api\/atelier\//.test(p)) return 'IDE connections (VS Code, Studio)';
  if (/^\/api\/mgmnt\//.test(p)) return 'REST API management';
  if (/^\/api\/docdb\//.test(p)) return 'Document database';
  if (/^\/api\/iam\//.test(p)) return 'API manager';
  return '';
}
/** Why this session can't be ended from here; '' when it can. */
function endBlock(s: WebSession): string {
  if (s.Preserve === 1) return `This session keeps its own process (state-aware mode), so IRIS doesn’t end it this way. Terminate ${s.SesProcessId ? `process ${s.SesProcessId}` : 'its process'} instead.`;
  if (!s.AllowEndSession) return 'IRIS doesn’t let Management Portal sessions be ended from outside. They end when the user signs out or the session times out.';
  return '';
}
const userOf = (s: WebSession): string => s.Username || ANON;

/** One row per application. */
interface App { path: string; name: string; sessions: WebSession[]; users: string[]; next: Date }
function groupApps(list: WebSession[]): App[] {
  const by = new Map<string, WebSession[]>();
  for (const s of list) by.set(s.Application, [...(by.get(s.Application) ?? []), s]);
  return [...by.entries()].map(([path, sessions]) => {
    const sorted = [...sessions].sort((a, b) => sessionExpiry(a).getTime() - sessionExpiry(b).getTime());
    return { path, name: appName(path), sessions: sorted, users: [...new Set(sessions.map(userOf))].sort(), next: sessionExpiry(sorted[0]) };
  });
}
const appLabel = (a: App): string => a.name || a.path;
/** "3" users, or "no sign-in" when every session is UnknownUser. */
const usersText = (a: App): string => (a.users.length === 1 && a.users[0] === ANON ? 'no sign-in' : String(a.users.length));

export function webSessionsScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div id="ws-list" class="od-list">
      <div class="toolbar-row" id="ws-toolbar">
        <div class="search-box"><ev-search id="ws-search" size="sm" full-width placeholder="Filter by application, user or session" aria-label="Filter sessions"></ev-search></div>
        <ev-segmented-button id="ws-scope" size="sm" aria-label="Show"></ev-segmented-button>
      </div>
      <ev-detail-panel id="ws-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap ops-wrap" id="ws-wrap">${skeleton(8)}</div>
        <aside slot="detail" class="detail" id="ws-detail" aria-label="Application sessions"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="ws-foot"></p>
    </div>
    <div id="ws-full" hidden></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#ws-panel');
  const wrap = $('#ws-wrap');
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#ws-scope');
  scopeEl.addEventListener('ev-segmented-button-change', (e) => { scope = (e as CustomEvent<{ value: Scope }>).detail.value; renderGrid(); });

  let all: WebSession[] = [];
  let apps: App[] = [];
  let loaded = false;
  let query = '';
  let scope: Scope = 'all';
  let grid: GridEl | null = null;
  let canOperate = true;
  let busy = false;

  const inScope = (a: App, sc: Scope): boolean => sc === 'all' || (sc === 'portal' ? isPortalPath(a.path) : !isPortalPath(a.path));
  const matches = (a: App): boolean => {
    if (!query) return true;
    const ql = query.toLowerCase();
    return [a.path, a.name, ...a.users, ...a.sessions.map((s) => s.ID), ...a.sessions.map((s) => s.SesProcessId)].some((f) => String(f ?? '').toLowerCase().includes(ql));
  };
  const visible = (): App[] => apps.filter((a) => inScope(a, scope) && matches(a)).sort((x, y) => y.sessions.length - x.sessions.length || appLabel(x).localeCompare(appLabel(y)));
  const endable = (a: App): WebSession[] => a.sessions.filter((s) => !endBlock(s));

  /* ───── Grid: Application · Sessions · Users · Next expiry ───── */
  const COLUMNS: GridColumn[] = [
    { key: 'App', label: 'Application', sortable: true, renderCell: (v, row) => (row.Named ? cell.text(v, String(row.Path)) : cellId(v, String(row.Path))) },
    { key: 'Sessions', label: 'Sessions', width: '110px', sortable: true, align: 'right', renderCell: (v) => `<span style="display:block;padding-right:24px">${cell.num(num(Number(v)))}</span>` },
    { key: 'Users', label: 'Users', width: '140px', sortable: true, description: 'Distinct users signed in; "no sign-in" when every session is anonymous',
      renderCell: (_v, row) => (row.UsersText === 'no sign-in' ? cell.dim('no sign-in') : cell.num(String(row.UsersText), String(row.UserList))) },
    { key: 'Next', label: 'Next expiry', width: '220px', sortable: true, description: 'The first of its sessions to end if its user makes no further request', renderCell: (v) => future(new Date(Number(v))) },
  ];
  const toRow = (a: App): DataGridRow => ({
    Path: a.path, App: appLabel(a), Named: a.name ? 1 : 0, Sessions: a.sessions.length,
    Users: a.users.length, UsersText: usersText(a), UserList: a.users.join(', '), Next: a.next.getTime(),
  });

  const renderToolbar = (): void => {
    const n = (s: Scope): number => apps.filter((x) => inScope(x, s)).reduce((t, a) => t + a.sessions.length, 0);
    scopeEl.options = [
      { value: 'all', label: `All ${n('all')}` },
      { value: 'apps', label: `Apps ${n('apps')}`, disabled: n('apps') === 0 && scope !== 'apps' },
      { value: 'portal', label: `Management Portal ${n('portal')}`, disabled: n('portal') === 0 && scope !== 'portal' },
    ];
    scopeEl.value = scope;
  };

  let rowSig = '';
  const renderGrid = (): void => {
    if (loaded && !all.length) {
      grid = null; rowSig = '';
      $('#ws-toolbar').hidden = true;
      void od.select(null);
      wrap.innerHTML = emptyState({ icon: 'globe', title: 'No web sessions', what: 'No active web sessions.', docs: { href: opsDocs.sessions, label: 'About sessions' } });
      return;
    }
    $('#ws-toolbar').hidden = false;
    setSearch($('#ws-search'), apps.length, { query, filtered: scope !== 'all' });
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Path');
      grid.setAttribute('sort-column', 'Sessions');
      grid.setAttribute('sort-direction', 'desc');
      grid.setAttribute('aria-label', 'Web sessions by application');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => void od.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Path)));
      wrap.appendChild(grid);
    }
    const rows = visible().map(toRow);
    const sig = JSON.stringify(rows);
    if (sig !== rowSig) { rowSig = sig; grid.rows = rows; }
    const sel = od.selected();
    if (sel) grid.select([sel]);
    wrap.querySelector('.ops-empty')?.remove();
    grid.hidden = !rows.length;
    if (!rows.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="ops-empty">${emptyState({
        icon: 'search', title: 'Nothing matches',
        what: query ? `No session matches “${esc(query)}”${scope !== 'all' ? ' in this view' : ''}.` : 'No sessions in this view.',
        button: { id: 'ws-clear', label: 'Show all sessions' },
      })}</div>`);
      wrap.querySelector('#ws-clear')?.addEventListener('click', () => {
        query = ''; scope = 'all'; renderToolbar();
        ($('#ws-search') as HTMLElement & { value: string }).value = '';
        renderGrid();
      });
    }
  };

  const renderFoot = (): void => {
    if (!loaded) return;
    const users = new Set(all.map(userOf));
    const anon = all.filter((s) => userOf(s) === ANON).length;
    const sep = '<span class="meta-sep">·</span>';
    const figs = [`<b>${num(all.length)}</b> session${all.length === 1 ? '' : 's'}`, `<b>${num(apps.length)}</b> application${apps.length === 1 ? '' : 's'}`,
      users.size === 1 && anon ? 'all with no sign-in' : `<b>${num(users.size)}</b> user${users.size === 1 ? '' : 's'}`];
    $('#ws-foot').innerHTML = all.length ? figs.join(sep) : '';
  };

  /* ───── Peek and full view: objectDetail() ───── */
  const sessionRow = (s: WebSession): string => {
    const block = !canOperate ? NO_OPERATE : endBlock(s);
    const exp = sessionExpiry(s);
    return `<li class="ws-session">
      <span class="ws-session-id">${cellRef(s.ID, undefined, `Session ${s.ID}${s.Preserve === 1 && s.SesProcessId ? ` · process ${s.SesProcessId}` : ''}`)}</span>
      <span class="ws-session-user">${userOf(s) === ANON ? '<span class="dim">no sign-in</span>' : `<a class="link" href="#/security/users" data-user="${esc(userOf(s))}">${esc(userOf(s))}</a>`}</span>
      <span class="ws-session-exp" title="${esc(when(exp))}">${esc(relative(exp))}</span>
      ${block ? `<span class="ws-session-end" title="${esc(block)}"></span>` : `<button type="button" class="btn btn--sm ws-session-end" data-end="${esc(s.ID)}"${busy ? ' disabled' : ''}>End…</button>`}
    </li>`;
  };
  const sessionList = (a: App): string => `<ul class="ws-sessions">${a.sessions.map(sessionRow).join('')}</ul>`;
  const menuFor = (a: App): MenuItem[] => {
    const n = endable(a).length;
    const why = !canOperate ? NO_OPERATE : busy ? 'Working…' : n ? undefined : 'None of these sessions can be ended from here.';
    return [{ label: n > 1 ? `End all ${n} sessions…` : 'End its session…', icon: 'x', danger: true, disabled: !!why, reason: why, onSelect: () => void endApp(a.path) }];
  };
  const fullView = (a: App): OdFull => {
    const anon = a.sessions.filter((s) => userOf(s) === ANON).length;
    const own = a.sessions.filter((s) => s.Preserve === 1).length;
    return {
      strip: [
        { label: 'Sessions', value: num(a.sessions.length) },
        { label: 'Users', value: usersText(a) },
        { label: 'No sign-in', value: num(anon), caption: anon ? 'as UnknownUser' : '' },
        { label: 'Next expiry', value: relative(a.next), title: when(a.next) },
      ],
      main: [{ title: 'Sessions', body: sessionList(a) }],
      side: [{ title: 'Application', body: `<dl class="od-kv">
        <div class="od-kv-row"><dt>Path</dt><dd>${cellRef(a.path, undefined, a.path)}</dd></div>
        <div class="od-kv-row"><dt>Own process</dt><dd>${own ? `${num(own)} state-aware` : '<span class="dim">—</span>'}</dd></div>
      </dl><p class="ws-note">Each request from a user pushes their session’s expiry back. When a session ends, whatever the app kept in it is gone and IRIS can give its license to someone else.</p>` }],
    };
  };
  const od = objectDetail<App>(ctx, {
    collection: 'Web sessions', noun: 'application',
    panel, detail: $('#ws-detail'), list: $('#ws-list'), full: $('#ws-full'),
    key: (a) => a.path,
    find: (k) => apps.find((a) => a.path === k),
    order: () => visible().map((a) => a.path),
    name: (a) => appLabel(a),
    mono: (a) => !a.name,
    meta: (a) => odMeta({ label: `${num(a.sessions.length)} session${a.sessions.length === 1 ? '' : 's'}`, tone: 'neutral' }, [a.name ? a.path : '', `next ends ${relative(a.next)}`]),
    menu: menuFor,
    peek: (a) => odSection(`Sessions · ${num(a.sessions.length)}`, sessionList(a)),
    loadFull: fullView,
    wire: (root, a) => {
      root.querySelectorAll<HTMLElement>('[data-end]').forEach((b) => b.addEventListener('click', () => {
        const s = a.sessions.find((x) => x.ID === b.dataset.end);
        if (s) void endOne(s);
      }));
      root.querySelectorAll<HTMLElement>('a[data-user]').forEach((l) => l.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        linkTo(ctx.navigate, 'security/users', l.dataset.user ?? '');
      }));
    },
    onSelect: (k) => grid?.select(k ? [k] : []),
  });

  /* ───── Actions ───── */
  const consequence = (anonymous: boolean, many: boolean): string => anonymous
    ? `<p>${many ? 'Their' : 'The'} next request starts a new session. Nobody has to sign in again (${many ? 'these sessions have' : 'this session has'} no sign-in), but anything the app kept in ${many ? 'them' : 'it'}, such as a half-finished form, is lost.</p>`
    : `<p>${many ? 'Each user' : 'They'} must sign in again at ${many ? 'their' : 'the'} next request, and anything the app kept in the session, such as a half-finished form, is lost.</p>`;

  const after = async (): Promise<void> => { busy = false; await load(true); };

  async function endOne(s: WebSession): Promise<void> {
    const user = userOf(s);
    const name = appName(s.Application) || s.Application;
    const ok = await confirm({
      title: `End ${user}’s session in ${name}?`,
      body: `<p>Session <span class="mono">${esc(s.ID)}</span> ends straight away.</p>${consequence(user === ANON, false)}`,
      confirmLabel: 'End session', danger: true,
    });
    if (!ok) return;
    busy = true;
    try {
      await endWebSession(s.ID);
      toast(`Session ended. ${user === ANON ? 'Its next request starts a new one.' : `${user} signs in again at their next request.`}`);
    } catch (err) {
      if (err instanceof AdminError && err.status === 404) toast('That session has already ended.', 'info');
      else toast(errorText(err), 'danger');
    } finally { await after(); }
  }

  async function endApp(path: string): Promise<void> {
    const a = apps.find((x) => x.path === path);
    const list = a ? endable(a) : [];
    if (!a || !list.length) return;
    const name = appLabel(a);
    const anonymous = list.every((s) => userOf(s) === ANON);
    const users = new Set(list.map(userOf));
    const ok = await confirm({
      title: list.length === 1 ? `End the session in ${name}?` : `End all ${list.length} sessions in ${name}?`,
      body: `<p>${num(list.length)} session${list.length === 1 ? '' : 's'} for ${num(users.size)} user${users.size === 1 ? '' : 's'} (${esc([...users].slice(0, 4).join(', '))}${users.size > 4 ? '…' : ''}) end straight away.</p>${consequence(anonymous, list.length > 1)}`,
      confirmLabel: list.length === 1 ? 'End session' : `End ${list.length} sessions`, danger: true, typeToConfirm: list.length > 1 ? String(list.length) : undefined,
    });
    if (!ok) return;
    busy = true;
    let done = 0;
    try {
      for (const s of list) {
        try { await endWebSession(s.ID); done++; } catch (err) {
          if (err instanceof AdminError && err.status === 404) continue;
          throw err;
        }
      }
      toast(`${done} session${done === 1 ? '' : 's'} in ${name} ended.`);
    } catch (err) {
      toast(done ? `${done} ended, then IRIS stopped: ${errorText(err)}` : errorText(err), 'danger');
    } finally { await after(); }
  }

  void sessionInfo().then((info) => {
    canOperate = can(info, 'Operate') !== false;
    od.refresh();
  }).catch(() => { /* keep defaults */ });

  /* ───── Live refresh that never moves rows under the pointer ───── */
  let hovering = false;
  let held: { rows: WebSession[]; at: Date } | null = null;
  const frozen = (): boolean => hovering || !!document.querySelector('.crud-menu, ev-dialog') || busy;
  wrap.addEventListener('pointerenter', () => { hovering = true; });
  wrap.addEventListener('pointerleave', () => { hovering = false; flush(); });
  let detailSig = '';
  const paint = (rows: WebSession[], at: Date): void => {
    all = rows;
    apps = groupApps(rows);
    loaded = true;
    updated(at);
    renderToolbar();
    renderGrid();
    renderFoot();
    // Redraw the peek or full view only when its application's sessions changed (the first call opens a deep link).
    const sel = od.selected();
    const a = sel ? apps.find((x) => x.path === sel) : undefined;
    const sig = JSON.stringify([sel, a?.sessions.map((s) => [s.ID, s.Timeout, s.Username]), canOperate, busy]);
    if (sig !== detailSig || !sel) { detailSig = sig; od.refresh(); }
  };
  function flush(): void {
    if (!held || frozen()) return;
    const h = held; held = null;
    paint(h.rows, h.at);
  }
  const flushTimer = setInterval(flush, 400);
  ctx.onLeave(() => clearInterval(flushTimer));

  const updated = liveIndicator(ctx, () => void load(true));
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  const load = async (force = false): Promise<void> => {
    try {
      const rows = await getWebSessions();
      if (!alive) return;
      if (grid && !force && frozen()) { held = { rows, at: new Date() }; return; }
      held = null;
      paint(rows, new Date());
    } catch (err) {
      if (!alive) return;
      grid = null; rowSig = '';
      wrap.innerHTML = errorPanel(err, 'ws-retry');
      wrap.querySelector('#ws-retry')?.addEventListener('click', () => void load(true));
    }
  };

  $('#ws-search').addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); renderGrid(); });

  void load();
  const timer = setInterval(() => void load(), REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
