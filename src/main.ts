/**
 * OSCA Portal — shell bootstrap.
 *
 * Layout: ev-shell with a top toolbar (header), ONE navigation menu in the
 * left sidebar, and the content area. The menu is a fill-mode ev-accordion:
 * one group open at a time (always the one holding the current page), later
 * groups pinned to the bottom. Architecture mirrors ../OSCA/src/web/main.ts.
 */
import '@evolution-ui/core/design/tokens.css';
import '@evolution-ui/core/design/themes/light.css';
import '@evolution-ui/core/design/themes/dark.css';
import './styles.css';
import { initTheme, applyTheme, getTheme } from '@evolution-ui/core/design/theme-manager';

import '@evolution-ui/core/components/ev-shell/ev-shell.js';
import '@evolution-ui/core/components/ev-icon-button/ev-icon-button.js';
import '@evolution-ui/core/components/ev-icon/ev-icon.js';
import '@evolution-ui/core/components/ev-command-palette/ev-command-palette.js';
import '@evolution-ui/core/components/ev-accordion/ev-accordion.js';
import { commands } from '@evolution-ui/core/base';

import { MODULES, type Module, type SubItem } from './modules';
import { getInfo } from './api';
import { auth, logout } from './auth';
import { signIn } from './login';
import { esc } from './ui';
import { metrics, value, systemState, type Snapshot } from './metrics';
import { alerts } from './alerts';
// Components the screens render.
import '@evolution-ui/core/components/ev-stat/ev-stat.js';
import '@evolution-ui/core/components/ev-sparkline/ev-sparkline.js';
import '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import '@evolution-ui/core/components/ev-detail-panel/ev-detail-panel.js';
import '@evolution-ui/core/components/ev-search/ev-search.js';
import '@evolution-ui/core/components/ev-segmented-button/ev-segmented-button.js';
import '@evolution-ui/core/components/ev-empty-state/ev-empty-state.js';
import '@evolution-ui/core/components/ev-skeleton/ev-skeleton.js';
import '@evolution-ui/core/components/ev-chip/ev-chip.js';

initTheme({ autoDetectPlatform: false });

// ── Persisted UI state ────────────────────────────────────────────────
const KEY = {
  route: 'osca-portal:route',
  sidebar: 'osca-portal:sidebar',
};
function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}
function save(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ── Routing: #/<module>/<item>, falling back to the last page visited ──
interface Route { mod: Module; item: SubItem }
const routeId = (r: Route): string => `${r.mod.key}/${r.item.key}`;

function resolve(id: string | null): Route {
  const [m, i] = (id ?? '').split('/');
  const mod = MODULES.find((x) => x.key === m) ?? MODULES[0];
  const item = mod.nav.find((x) => x.key === i) ?? mod.nav[0];
  return { mod, item };
}
const fromHash = (): string | null => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);

let current: Route = resolve(fromHash() ?? load<string | null>(KEY.route, null));

function navigate(id: string): void {
  if (location.hash !== `#/${id}`) location.hash = `/${id}`;
  else show(resolve(id));
}

// ── Shell markup ──────────────────────────────────────────────────────
const app = document.querySelector('#app') as HTMLElement | null;
if (!app) throw new Error('#app missing');

// Nothing below runs until there is a session (or an explicit anonymous choice).
await signIn(app);
// A session that can't be refreshed any more sends the user back to sign-in.
auth.onExpired(() => location.reload());
window.addEventListener('hashchange', () => show(resolve(fromHash())));

const SIDEBAR_WIDTH = '248px';
app.innerHTML = `
  <ev-shell sidebar-left-width="${load(KEY.sidebar, true) ? SIDEBAR_WIDTH : '0px'}" sidebar-left-min="200" sidebar-left-max="420"
            sidebar-right-width="0px" sidebar-right-resizable="false">
    <header slot="header" class="toolbar">
      <ev-icon-button id="btn-sidebar" icon="panel-left" label="Toggle menu"></ev-icon-button>
      <div class="brand"><span class="mark">OS</span>OSCA Portal</div>
      <div class="toolbar-center">
        <button type="button" class="jump" id="btn-jump">
          <ev-icon name="search" size="xs"></ev-icon><span>Search or jump to…</span><kbd>Ctrl K</kbd>
        </button>
      </div>
      <div id="pulse" class="pulse"></div>
      <div class="instance" id="instance" title="Connected instance">…</div>
      <ev-icon-button id="btn-theme" icon="moon" label="Toggle light / dark"></ev-icon-button>
      <div class="user-menu-wrap">
        <ev-icon-button id="btn-user" icon="user" label="Account"></ev-icon-button>
        <div class="user-menu" id="user-menu" role="menu" hidden>
          <div class="user-menu-who"><span class="dim">${auth.anonymous ? 'Not signed in' : 'Signed in as'}</span><b id="user-name">${auth.anonymous ? '' : esc(auth.user)}</b></div>
          <button type="button" role="menuitem" id="btn-signout">${auth.anonymous ? 'Sign in' : 'Sign out'}</button>
        </div>
      </div>
    </header>
    <aside slot="sidebar-left" class="navhost">
      <div id="nav-mount" class="nav-mount"></div>
    </aside>
    <main slot="main" class="portal-main" id="main"></main>
  </ev-shell>
  <ev-command-palette></ev-command-palette>
`;

const shell = document.querySelector('ev-shell') as HTMLElement & { sidebarLeftWidth: string };
const main = document.querySelector('#main') as HTMLElement;
const navMount = document.querySelector('#nav-mount') as HTMLElement;

// ── Content area ──────────────────────────────────────────────────────
let leave: Array<() => void> = [];

function show(route: Route): void {
  for (const fn of leave) { try { fn(); } catch { /* a screen's cleanup must not block navigation */ } }
  leave = [];
  current = route;
  save(KEY.route, routeId(route));
  const isHome = route.mod.key === 'home';
  const title = isHome ? 'Overview' : route.item.label;
  const description = route.item.description ?? '';
  main.classList.remove('portal-main--fill');
  main.innerHTML = `
    <header class="page-head">
      ${isHome ? '' : `<div class="crumbs">${route.mod.label}</div>`}
      <div class="page-title-row">
        <h1 id="page-title">${title}</h1>
        <div class="page-actions" id="page-actions"></div>
      </div>
      <p class="page-subtitle" id="page-subtitle"${description ? '' : ' hidden'}>${description}</p>
    </header>
    <div class="page-body" id="view-body"></div>`;
  document.title = `${title} · OSCA Portal`;
  const body = main.querySelector('#view-body') as HTMLElement;
  const actions = main.querySelector('#page-actions') as HTMLElement;
  if (route.item.screen) {
    route.item.screen({
      body, actions, navigate,
      onLeave: (fn) => leave.push(fn),
      heading: (html, subtitle) => {
        (main.querySelector('#page-title') as HTMLElement).innerHTML = html;
        const sub = main.querySelector('#page-subtitle') as HTMLElement;
        if (subtitle !== undefined) { sub.innerHTML = subtitle; sub.hidden = !subtitle; }
      },
      fill: () => main.classList.add('portal-main--fill'),
    });
  } else {
    void route.item.render?.(body);
  }
  main.scrollTop = 0;
  menu.sync(route);
}

// ── Menu ──────────────────────────────────────────────────────────────
interface Menu { sync(route: Route): void }

/** Accordion: one group open at a time — always the group you're in. Fill mode
 *  keeps the menu's shape fixed: the open group scrolls, later groups stay at
 *  the bottom, and headers slide rather than jump when the group changes. */
function mountAccordion(host: HTMLElement): Menu {
  const wrap = document.createElement('div');
  wrap.className = 'menu-accordion';
  const acc = document.createElement('ev-accordion');
  acc.setAttribute('fill', '');
  const links = new Map<string, HTMLElement>();
  const sections = new Map<string, HTMLElement & { expanded: boolean }>();

  const link = (id: string, label: string, cls: string, icon?: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.innerHTML = `${icon ? `<ev-icon name="${icon}" size="sm"></ev-icon>` : ''}<span>${label}</span>`;
    b.addEventListener('click', () => navigate(id));
    links.set(id, b);
    return b;
  };

  for (const m of MODULES) {
    if (m.nav.length === 1) {
      acc.appendChild(link(`${m.key}/${m.nav[0].key}`, m.label, 'acc-single'));
      continue;
    }
    const item = document.createElement('ev-accordion-item') as HTMLElement & { expanded: boolean };
    item.setAttribute('heading', m.label);
    const list = document.createElement('div');
    list.className = 'acc-items';
    for (const i of m.nav) list.appendChild(link(`${m.key}/${i.key}`, i.label, 'acc-item'));
    item.appendChild(list);
    sections.set(m.key, item);
    acc.appendChild(item);
  }
  wrap.appendChild(acc);
  host.appendChild(wrap);
  return {
    sync(route) {
      for (const [key, el] of links) el.classList.toggle('active', key === routeId(route));
      const open = sections.get(route.mod.key);
      if (open && !open.expanded) open.expanded = true; // single-expand closes the others
      // A single-page group (Home) owns no section: close whatever was open.
      if (!open) for (const s of sections.values()) if (s.expanded) s.expanded = false;
      links.get(routeId(route))?.scrollIntoView({ block: 'nearest' });
    },
  };
}

const menu: Menu = mountAccordion(navMount);
show(current);

// ── Toolbar ───────────────────────────────────────────────────────────
document.querySelector('#btn-sidebar')?.addEventListener('click', () => {
  const open = shell.sidebarLeftWidth === '0px';
  shell.sidebarLeftWidth = open ? SIDEBAR_WIDTH : '0px';
  save(KEY.sidebar, open);
});

const themeBtn = document.querySelector('#btn-theme') as HTMLElement;
const syncThemeIcon = (): void => themeBtn.setAttribute('icon', getTheme().mode === 'dark' ? 'sun' : 'moon');
themeBtn.addEventListener('click', () => {
  applyTheme({ mode: getTheme().mode === 'dark' ? 'light' : 'dark' });
  syncThemeIcon();
});
syncThemeIcon();

const palette = document.querySelector('ev-command-palette') as HTMLElement & { open(): void };
document.querySelector('#btn-jump')?.addEventListener('click', () => palette.open());
for (const m of MODULES) {
  for (const i of m.nav) {
    commands.register({
      id: `nav:${m.key}:${i.key}`,
      label: m.nav.length === 1 ? m.label : `${m.label}: ${i.label}`,
      group: 'Go to',
      icon: m.icon,
      run: () => navigate(`${m.key}/${i.key}`),
    });
  }
}
commands.register({ id: 'view:theme', label: 'Toggle light / dark', group: 'View', run: () => themeBtn.click() });
commands.register({ id: 'view:menu', label: 'Toggle menu', group: 'View', run: () => (document.querySelector('#btn-sidebar') as HTMLElement).click() });

// Instance identity: name from the metrics feed, version/build from /api/admin/info.
let instanceName = '';
let buildLabel = '';
const renderInstance = (): void => {
  (document.querySelector('#instance') as HTMLElement).innerHTML =
    `<b>${esc(instanceName || 'IRIS')}</b>${buildLabel ? `<span class="pill">${esc(buildLabel)}</span>` : ''}`;
};
getInfo()
  .then((info) => {
    const build = /(\d{4}\.\d+)[^)]*\(Build ([^)]+)\)/.exec(info.serverVersion);
    if (build) buildLabel = `${build[1]} · ${build[2]}`;
    renderInstance();
  })
  .catch(() => { (document.querySelector('#instance') as HTMLElement).textContent = 'Not connected'; });
metrics.subscribe((s) => {
  const id = s.get('iris_system_info')?.[0]?.labels.id ?? '';
  if (id && id !== instanceName) { instanceName = id; renderInstance(); }
});

// Account menu: who is signed in, and a way out.
{
  const menu = document.querySelector('#user-menu') as HTMLElement;
  const btn = document.querySelector('#btn-user') as HTMLElement;
  const close = (): void => { menu.hidden = true; };
  btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target as Node)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.querySelector('#btn-signout')?.addEventListener('click', () => {
    void logout().then(() => location.reload());
  });
  commands.register({ id: 'account:signout', label: auth.anonymous ? 'Sign in' : 'Sign out', group: 'Account', run: () => void logout().then(() => location.reload()) });
}

// ── Pulse: ambient health from the shared metrics + alert stores ──────
{
  const el = document.querySelector('#pulse') as HTMLElement;
  let last: Snapshot | null = null;
  let recent = 0; // alerts the portal holds from the last 24h — the ones you can actually open
  const render = (snap: Snapshot): void => {
    last = snap;
    const state = systemState(value(snap, 'iris_system_state'));
    const cpu = value(snap, 'iris_cpu_usage');
    const procs = value(snap, 'iris_process_count');
    // Same source as the Alerts page, so the two always agree.
    const raised = value(snap, 'iris_system_alerts');
    const cpuTone = cpu >= 90 ? 'danger' : cpu >= 70 ? 'warning' : 'neutral';
    el.innerHTML = `
      <button type="button" class="pulse-seg" data-tone="${state.tone}" data-go="home/overview" title="Overall health, as IRIS reports it"><span class="dot"></span>${state.label}</button>
      <button type="button" class="pulse-seg" data-tone="${cpuTone}" data-go="operations/overview" title="CPU use across the whole machine, not just IRIS">System CPU <b>${Number.isFinite(cpu) ? Math.round(cpu) : '—'}%</b></button>
      <button type="button" class="pulse-seg" data-tone="neutral" data-go="operations/processes" title="Active processes"><b>${Number.isFinite(procs) ? procs : '—'}</b> processes</button>
      <button type="button" class="pulse-seg" data-tone="${recent > 0 ? 'warning' : 'neutral'}" data-go="logs/alerts"
        title="${recent > 0 ? `${recent} alert${recent === 1 ? '' : 's'} in the last 24 hours` : 'Alerts raised since IRIS started'}"><b>${recent > 0 ? recent : Number.isFinite(raised) ? raised : '—'}</b> alert${(recent || raised) === 1 ? '' : 's'}</button>`;
    el.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go ?? '')));
  };
  metrics.subscribe((s) => render(s), () => {
    el.innerHTML = `<span class="pulse-seg" data-tone="danger"><span class="dot"></span>Not connected</span>`;
  });
  // Keep collecting alerts app-wide, whichever page is open.
  alerts.subscribe((list) => {
    const dayAgo = Date.now() - 86400000;
    recent = list.filter((a) => Date.parse(a.time) >= dayAgo).length;
    if (last) render(last);
  });
}
