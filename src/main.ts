// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OSCA Admin — shell bootstrap.
 *
 * Layout: ev-shell with a top toolbar (header), ONE navigation menu in the
 * left sidebar, and the content area. The menu is an ev-accordion with one
 * group open at a time (always the one holding the current page); the nav
 * mount is its only scroller.
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
import type { CommandItem } from '@evolution-ui/core/components/ev-command-palette/ev-command-palette.js';
import { icons } from '@evolution-ui/core/components/ev-icon/icons.js';

import { MODULES, type Module, type SubItem } from './modules';
import './showcase'; // Sample data, Showcase and Self-test: remove this line and src/showcase/ to remove them.
import { getInfo, getDashboard, getProcesses, getNamespaces } from './api';
import { getUserList, getRoleList, getResourceList, getSecurityGraph } from './api-security';
import { getDbNames } from './api-ops';
import { getWebAppList, getTasks } from './api-apps';
import { getServices } from './api-services';
import { auth, logout } from './auth';
import { signIn } from './login';
import { learnServerClock } from './server-clock';
import { HELP } from './help';
import { overallHealth } from './health';
import { esc, serverName, BRAND_MARK, PEEK_MIN, peekWidth, peekWidthKey, rememberPeekWidth } from './ui';
import { metrics, value, type Snapshot } from './metrics';
import { alerts } from './alerts';
import { riskBanner } from './security-view';
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

// Icons the portal needs beyond the library's built-in set (Lucide paths, same
// 24×24 stroke conventions). Registered before anything renders.
Object.assign(icons, {
  'pause': '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  'house': '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'activity': '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  'calendar-clock': '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>',
  'scroll-text': '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  'shield': '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  'database': '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  'arrow-up-right': '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  'server': '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  'box': '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  'history': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
});

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
/** A screen, plus an optional item within it ("#/operations/processes/6168"). */
interface Route { mod: Module; item: SubItem; param?: string }
const routeId = (r: Route): string => `${r.mod.key}/${r.item.key}`;

function resolve(id: string | null): Route {
  const [m, i, ...rest] = (id ?? '').split('/');
  const mod = MODULES.find((x) => x.key === m) ?? MODULES[0];
  const item = mod.nav.find((x) => x.key === i) ?? mod.nav[0];
  const param = rest.length && item.key === i ? decodeURIComponent(rest.join('/')) : undefined;
  return { mod, item, param };
}
/** A route parameter in the address: each segment encoded, slashes kept (resolve() joins them back). */
const encParam = (p: string): string => p.split('/').map(encodeURIComponent).join('/');
const fromHash = (): string | null => (location.hash.startsWith('#/') ? location.hash.slice(2) : null);

let current: Route = resolve(fromHash() ?? load<string | null>(KEY.route, null));

/** A screen's "may I leave?" check (unsaved edits); set via ScreenCtx.beforeLeave. */
let leaveGuard: (() => Promise<boolean>) | null = null;
let shownHash = location.hash;

async function navigate(id: string): Promise<void> {
  if (leaveGuard && !(await leaveGuard())) return;
  leaveGuard = null;
  if (location.hash !== `#/${id}`) location.hash = `/${id}`;
  else show(resolve(id));
}

// ── Shell markup ──────────────────────────────────────────────────────
const app = document.querySelector('#app') as HTMLElement | null;
if (!app) throw new Error('#app missing');

// Nothing below runs until there is a session (or an explicit anonymous choice).
await signIn(app);
// Server times arrive in the server's local time: learn its offset before the first screen renders.
await learnServerClock();
// A session that can't be refreshed any more sends the user back to sign-in.
auth.onExpired(() => location.reload());
window.addEventListener('hashchange', () => {
  if (location.hash === shownHash) return;
  const target = location.hash;
  if (!leaveGuard) { show(resolve(fromHash())); return; }
  // Back/forward or a typed URL while a form has unsaved changes: put the URL back, ask, then go.
  history.replaceState(null, '', shownHash);
  void leaveGuard().then((ok) => { if (!ok) return; leaveGuard = null; history.replaceState(null, '', target); show(resolve(fromHash())); });
});

const SIDEBAR_WIDTH = '248px';
app.innerHTML = `
  <ev-shell sidebar-left-width="${load(KEY.sidebar, true) ? SIDEBAR_WIDTH : '0px'}" sidebar-left-min="200" sidebar-left-max="420"
            sidebar-right-width="0px" sidebar-right-resizable="false">
    <header slot="header" class="toolbar">
      <button type="button" class="skip-link" id="skip-link">Skip to content</button>
      <div class="brand"><span class="mark">${BRAND_MARK}</span>OSCA Admin</div>
      <div class="instance-wrap">
        <button type="button" class="instance" id="instance" aria-haspopup="dialog" aria-expanded="false" title="Connected instance: click for details">…</button>
        <div class="instance-pop" id="instance-pop" role="dialog" aria-label="Connected instance" hidden></div>
      </div>
      <div class="toolbar-end">
        <ev-icon-button id="btn-jump" icon="search" label="Search (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'})" title="Search (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'})"></ev-icon-button>
        <ev-icon-button id="btn-theme" icon="moon" label="Toggle light / dark"></ev-icon-button>
        <div class="user-menu-wrap">
          <ev-icon-button id="btn-user" icon="user" label="Account"></ev-icon-button>
          <div class="user-menu" id="user-menu" role="menu" hidden>
            <div class="user-menu-who"><span class="dim">${auth.anonymous ? 'Not signed in' : 'Signed in as'}</span><b id="user-name">${auth.anonymous ? '' : esc(auth.user)}</b></div>
            <button type="button" role="menuitem" id="btn-signout">${auth.anonymous ? 'Sign in' : 'Sign out'}</button>
          </div>
        </div>
      </div>
    </header>
    <aside slot="sidebar-left" class="navhost">
      <div id="nav-mount" class="nav-mount"></div>
    </aside>
    <main slot="main" class="portal-main" id="main" tabindex="-1"></main>
    <footer slot="footer" class="statusbar" id="statusbar">
      <div class="sb-group">
        <button type="button" class="sb-item sb-icon" id="btn-sidebar" title="Show or hide the menu · Ctrl B"><ev-icon name="panel-left" size="xs"></ev-icon><span class="sr-only">Toggle menu</span></button>
        <div class="sb-group" id="sb-health"></div>
      </div>
      <div class="sb-group sb-end">
        <div class="sb-page" id="sb-page" title="This page’s data"></div>
        <div class="sb-group" id="sb-right"></div>
      </div>
    </footer>
  </ev-shell>
  <ev-command-palette></ev-command-palette>
`;

const shell = document.querySelector('ev-shell') as HTMLElement & { sidebarLeftWidth: string };
const main = document.querySelector('#main') as HTMLElement;
// Windows' mono (Consolas) sits ~2px above the UI font's baseline in a grid cell; cellId/cellRef nudge it down.
if (/Win/.test(navigator.platform)) document.documentElement.style.setProperty('--mono-nudge', '2px');
document.querySelector('#skip-link')?.addEventListener('click', () => main.focus());
const navMount = document.querySelector('#nav-mount') as HTMLElement;

/**
 * Page help: the ? beside the title opens an inline panel under it.
 * It opens by itself the first time you visit a page; once closed it stays
 * closed there, and if you open it on purpose it stays open until you close
 * it (remembered per page). Esc closes it only while focus is in the panel
 * or on the ?, so it never steals Esc from dialogs or the palette.
 */
// v2: help starts closed; the old key recorded every first-visit auto-open as "open".
const HELP_KEY = 'osca-portal:help2';
function wireHelp(root: HTMLElement, page: string): void {
  const btn = root.querySelector('#help-btn') as HTMLElement;
  const panel = root.querySelector('#page-help') as HTMLElement;
  const state = load<Record<string, boolean>>(HELP_KEY, {});
  const set = (open: boolean, remember = true): void => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
    if (remember) save(HELP_KEY, { ...load<Record<string, boolean>>(HELP_KEY, {}), [page]: open });
  };
  set(state[page] ?? false, false); // closed until the user opens it; then remembered per page
  btn.addEventListener('click', () => set(panel.hidden));
  root.querySelector('#help-close')?.addEventListener('click', () => { set(false); btn.focus(); });
  for (const el of [panel, btn]) el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape' && !panel.hidden) { e.stopPropagation(); set(false); btn.focus(); } });
}
/** Toggle the current page's help from the command palette. */
function toggleHelp(): void { (document.querySelector('#help-btn') as HTMLElement | null)?.click(); }

// ── Content area ──────────────────────────────────────────────────────
let leave: Array<() => void> = [];

function show(route: Route): void {
  for (const fn of leave) { try { fn(); } catch { /* a screen's cleanup must not block navigation */ } }
  leave = [];
  leaveGuard = null;
  current = route;
  shownHash = `#/${routeId(route)}${route.param ? `/${encParam(route.param)}` : ''}`;
  if (location.hash !== shownHash) history.replaceState(null, '', shownHash);
  save(KEY.route, routeId(route));
  const isHome = route.mod.key === 'home';
  const title = isHome ? 'Overview' : route.item.label;
  const help = HELP[routeId(route)];
  main.classList.remove('portal-main--fill');
  main.innerHTML = `
    <header class="page-head">
      <div class="page-title-row">
        <div class="page-title-group">
          <h1 id="page-title">${title}</h1>
          ${help ? `<button type="button" class="help-btn" id="help-btn" aria-expanded="false" aria-controls="page-help" title="About this page (F1)">
            <ev-icon name="help-circle" size="sm"></ev-icon><span class="sr-only">About this page</span></button>` : ''}
        </div>
        <div class="page-actions" id="page-actions"></div>
      </div>
      <p class="page-subtitle" id="page-subtitle" hidden></p>
      <div class="page-banners" id="page-banners"></div>
      ${help ? `<section class="page-help" id="page-help" hidden aria-label="About this page">
        <div class="page-help-body">${help}</div>
        <button type="button" class="page-help-close" id="help-close" title="Close"><ev-icon name="x" size="xs"></ev-icon><span class="sr-only">Close</span></button>
      </section>` : ''}
    </header>
    <div class="page-body" id="view-body"></div>`;
  const fresh = document.querySelector('#sb-page') as HTMLElement;
  fresh.innerHTML = ''; // each page brings its own freshness
  if (help) wireHelp(main, routeId(route));
  document.title = isHome ? 'Overview · OSCA Admin' : `${title} · ${route.mod.label} · OSCA Admin`;
  const body = main.querySelector('#view-body') as HTMLElement;
  const actions = main.querySelector('#page-actions') as HTMLElement;
  if (route.item.screen) {
    route.item.screen({
      body, actions, navigate,
      fresh,
      banners: main.querySelector('#page-banners') as HTMLElement,
      onLeave: (fn) => leave.push(fn),
      beforeLeave: (fn) => { leaveGuard = fn; },
      heading: (html, subtitle) => {
        (main.querySelector('#page-title') as HTMLElement).innerHTML = html;
        const sub = main.querySelector('#page-subtitle') as HTMLElement;
        if (subtitle !== undefined) { sub.innerHTML = subtitle; sub.hidden = !subtitle; }
      },
      fill: (on = true) => { main.classList.toggle('portal-main--fill', on); },
      param: route.param,
      // Change the item in the address without re-rendering the screen; Back returns to the previous item.
      setParam: (p) => {
        const hash = `#/${routeId(route)}${p ? `/${encParam(p)}` : ''}`;
        if (hash === location.hash) return;
        history.pushState(null, '', hash);
        shownHash = hash;
      },
    });
  } else {
    void route.item.render?.(body);
  }
  main.scrollTop = 0;
  menu.sync(route);
}

// ── Menu ──────────────────────────────────────────────────────────────
interface Menu { sync(route: Route): void }

/** Accordion: one group open at a time, always the group you're in. Groups
 *  flow naturally (no fill mode): the open group's items sit directly under
 *  its header and the next header follows, and the nav mount is the one
 *  scroller. Headers carry a 16px icon with the chevron at the right edge. */
function mountAccordion(host: HTMLElement): Menu {
  const wrap = document.createElement('div');
  wrap.className = 'menu-accordion';
  const acc = document.createElement('ev-accordion');
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
      acc.appendChild(link(`${m.key}/${m.nav[0].key}`, m.label, 'acc-single', m.icon));
      continue;
    }
    const item = document.createElement('ev-accordion-item') as HTMLElement & { expanded: boolean };
    item.setAttribute('heading', m.label);
    item.setAttribute('icon', m.icon);
    const list = document.createElement('div');
    list.className = 'acc-items';
    for (const i of m.nav) {
      if (i.group) { const g = document.createElement('div'); g.className = 'nav-group'; g.textContent = i.group; list.appendChild(g); }
      list.appendChild(link(`${m.key}/${i.key}`, i.label, 'acc-item'));
    }
    item.appendChild(list);
    sections.set(m.key, item);
    acc.appendChild(item);
  }
  wrap.appendChild(acc);
  host.appendChild(wrap);

  /** Every row the menu draws (Home, section headers inside ev-accordion-item, items, group labels). */
  const rows = (): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>('.acc-single, .acc-item, .nav-group'),
    ...[...sections.values()].map((s) => s.shadowRoot?.querySelector<HTMLElement>('.header')).filter((h): h is HTMLElement => !!h),
  ].filter((el) => el.getClientRects().length > 0);
  /**
   * Bring the current page into view in the one nav scroller (like block:'nearest' with 8px of
   * padding), then snap so no row is left cut in half at the top edge: a half-clipped row
   * (e.g. Home) is scrolled fully out of view, or fully in if that keeps the current row visible.
   */
  const reveal = (active: HTMLElement): void => {
    const pad = 8;
    const box = host.getBoundingClientRect();
    let a = active.getBoundingClientRect();
    if (a.bottom > box.bottom - pad) host.scrollTop += a.bottom - (box.bottom - pad);
    else if (a.top < box.top + pad) host.scrollTop -= (box.top + pad) - a.top;
    if (host.scrollTop <= 0) return;
    const top = host.getBoundingClientRect().top;
    const cut = rows().find((r) => { const b = r.getBoundingClientRect(); return b.top < top - 0.5 && b.bottom > top + 0.5; });
    if (!cut) return;
    const c = cut.getBoundingClientRect();
    a = active.getBoundingClientRect();
    const hide = c.bottom - top; // scroll down this much to hide the cut row
    const show = top - c.top;    // or up this much to show it whole
    if (a.top - hide >= top) host.scrollTop += hide;
    else if (a.bottom + show <= box.bottom) host.scrollTop -= show;
  };
  return {
    sync(route) {
      for (const [key, el] of links) {
        const on = key === routeId(route);
        el.classList.toggle('active', on);
        if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
      }
      const open = sections.get(route.mod.key);
      if (open && !open.expanded) open.expanded = true; // single-expand closes the others
      // A single-page group (Home) owns no section: close whatever was open.
      if (!open) for (const s of sections.values()) if (s.expanded) s.expanded = false;
      // Once the group has opened, keep the current page in view in the one nav scroller.
      const active = links.get(routeId(route));
      if (active) { reveal(active); setTimeout(() => reveal(active), 260); }
    },
  };
}

/**
 * List footers sit --list-gap under the last row. With a peek open the workspace must be
 * full height (for the peek), which would leave the footer at the page bottom; lift it
 * (transform only, no layout change) to just under the list's rows, within the list column.
 */
{
  let queued = false;
  const sized = new WeakSet<Element>();
  const rs = new ResizeObserver(() => schedule());
  const update = (): void => {
    queued = false;
    for (const foot of main.querySelectorAll<HTMLElement>('.table-foot')) {
      const ws = foot.previousElementSibling as HTMLElement | null;
      let dy = 0;
      let maxW = '';
      if (ws?.matches('.workspace[open]:not([data-overlay])')) {
        const wrap = ws.querySelector<HTMLElement>(':scope > .grid-wrap');
        const aside = ws.querySelector<HTMLElement>(':scope > [slot="detail"]');
        if (wrap) {
          if (!sized.has(wrap)) { sized.add(wrap); rs.observe(wrap); }
          const wb = ws.getBoundingClientRect();
          dy = Math.min(0, Math.round(wrap.getBoundingClientRect().bottom - wb.bottom));
          if (aside) maxW = `${Math.max(0, Math.round(aside.getBoundingClientRect().left - wb.left - 12))}px`;
        }
      }
      const t = dy ? `translateY(${dy}px)` : '';
      if (foot.style.transform !== t) foot.style.transform = t;
      if (foot.style.maxWidth !== maxW) foot.style.maxWidth = maxW;
    }
  };
  function schedule(): void { if (!queued) { queued = true; requestAnimationFrame(update); } }
  new MutationObserver(schedule).observe(main, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'data-overlay', 'hidden', 'detail-width'] });
  rs.observe(main);
}

/**
 * One peek width on every screen: whenever a list's detail panel opens, it opens at the shared
 * width (clamp(480px, 36%, 560px), or the width this screen's user last dragged to). Panels run
 * by objectDetail() (data-od) size themselves the same way; an open editor (data-width-override,
 * crud.ts panelWidth) keeps its own width until it closes.
 */
{
  const apply = (p: HTMLElement & { detailWidth: number; minWidth: number }): void => {
    if (p.hasAttribute('data-od') || p.hasAttribute('data-width-override') || !p.hasAttribute('open')) return;
    p.minWidth = PEEK_MIN;
    const w = peekWidth(p);
    if (p.detailWidth !== w) p.detailWidth = w;
  };
  new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (el.tagName === 'EV-DETAIL-PANEL' && el.classList.contains('workspace')) apply(el as HTMLElement & { detailWidth: number; minWidth: number });
    }
  }).observe(main, { subtree: true, attributes: true, attributeFilter: ['open'] });
  main.addEventListener('ev-detail-panel-resize', (e) => {
    const p = e.target as HTMLElement;
    if (!p.classList?.contains('workspace') || p.hasAttribute('data-od') || p.hasAttribute('data-width-override')) return;
    rememberPeekWidth(peekWidthKey(), (e as CustomEvent<{ detailWidth: number }>).detail.detailWidth);
  });
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

// ── Command palette: pages, actions, and the instance's objects ─────
type PaletteEl = HTMLElement & {
  open(): void;
  registerCommand(c: CommandItem): void;
  unregisterCommand(id: string): void;
};
const palette = document.querySelector('ev-command-palette') as PaletteEl;
palette.setAttribute('placeholder', 'Search pages, objects and actions…');
document.querySelector('#btn-jump')?.addEventListener('click', () => palette.open());

/** One indexed object: what it is, how it's named, and where Enter takes you. */
interface PaletteObject { kind: string; key: string; label: string; open(): void }
const OBJ_KIND: Record<string, { type: string; group: string; icon: string }> = {
  user: { type: 'User', group: 'Users', icon: 'user' },
  role: { type: 'Role', group: 'Roles', icon: 'users' },
  resource: { type: 'Resource', group: 'Resources', icon: 'key-round' },
  database: { type: 'Database', group: 'Databases', icon: 'database' },
  namespace: { type: 'Namespace', group: 'Namespaces', icon: 'box' },
  webapp: { type: 'Web application', group: 'Web applications', icon: 'globe' },
  task: { type: 'Task', group: 'Tasks', icon: 'calendar-clock' },
  service: { type: 'Service', group: 'Services', icon: 'server' },
  process: { type: 'Process', group: 'Processes', icon: 'cpu' },
};
/** Open a screen with one item selected: the target screen takes the name once on load. */
const openWith = (route: string, key: string): void => {
  try { sessionStorage.setItem('osca-portal:select', key); } catch { /* storage blocked: land unselected */ }
  void navigate(route);
};
const OBJ_ROUTE: Record<string, (key: string) => void> = {
  user: (k) => openWith('security/users', k),
  role: (k) => openWith('security/roles', k),
  resource: (k) => openWith('security/resources', k),
  database: (k) => openWith('databases/databases', k),
  namespace: (k) => openWith('databases/namespaces', k),
  webapp: (k) => openWith('web/apps', k),
  task: (k) => openWith('tasks/schedule', k),
  service: (k) => openWith('security/services', k),
  process: (k) => void navigate(`operations/processes/${encodeURIComponent(k)}`),
};

// Recents: the last five objects opened from the palette.
const RECENT_KEY = 'osca-portal:palette-recent';
type Recent = { kind: string; key: string; label: string };
const recents = (): Recent[] => load<Recent[]>(RECENT_KEY, []).filter((r) => OBJ_KIND[r.kind] && OBJ_ROUTE[r.kind]).slice(0, 5);
const remember = (r: Recent): void => {
  save(RECENT_KEY, [r, ...recents().filter((x) => !(x.kind === r.kind && x.key === r.key))].slice(0, 5));
};
const objId = (o: { kind: string; key: string }): string => `obj:${o.kind}:${o.key}`;
const objItem = (o: Recent, idPrefix = ''): CommandItem => ({
  id: `${idPrefix}${objId(o)}`,
  label: o.label,
  group: idPrefix ? 'Recent' : OBJ_KIND[o.kind].group,
  icon: OBJ_KIND[o.kind].icon,
  shortcut: OBJ_KIND[o.kind].type, // right-aligned type label
  action: () => { remember(o); OBJ_ROUTE[o.kind](o.key); },
});

// The object index: fetched when the palette opens, kept for five minutes. No polling.
const INDEX_TTL = 5 * 60_000;
let index: PaletteObject[] = [];
let indexAt = 0;
let indexing: Promise<void> | null = null;
let shownObjects: string[] = [];
let shownRecents: string[] = [];
let paletteQuery = '';
const toObjects = (kind: string, rows: Array<{ key: string; label: string }>): PaletteObject[] =>
  rows.filter((r) => r.key).map((r) => ({ kind, key: r.key, label: r.label, open: () => OBJ_ROUTE[kind](r.key) }));
function loadIndex(): Promise<void> {
  if (indexing) return indexing;
  if (index.length && Date.now() - indexAt < INDEX_TTL) return Promise.resolve();
  const sources: Array<Promise<PaletteObject[]>> = [
    getUserList().then((l) => toObjects('user', l.map((u) => ({ key: u.Name, label: u.FullName && u.FullName !== u.Name ? `${u.Name} · ${u.FullName}` : u.Name })))),
    getRoleList().then((l) => toObjects('role', l.map((r) => ({ key: r.Name, label: r.Name })))),
    getResourceList().then((l) => toObjects('resource', l.map((r) => ({ key: r.Name, label: r.Name })))),
    getDbNames().then((l) => toObjects('database', l.map((d) => ({ key: d.Name, label: d.Name })))),
    getNamespaces().then((l) => toObjects('namespace', l.map((n) => ({ key: n.Name, label: n.Name })))),
    getWebAppList().then((l) => toObjects('webapp', l.map((w) => ({ key: w.Name, label: w.Name })))),
    getTasks().then((l) => toObjects('task', l.map((t) => ({ key: String(t.Id), label: t.Name })))),
    getServices().then((l) => toObjects('service', l.map((v) => ({ key: v.Name, label: v.Name })))),
    getProcesses().then((l) => toObjects('process', l.map((p) => ({ key: String(p.Pid), label: `${p.Pid} · ${p.Routine || 'no routine'}${p.Username ? ` · ${p.Username}` : ''}` })))),
  ];
  indexing = Promise.allSettled(sources).then((results) => {
    const next: PaletteObject[] = [];
    for (const r of results) if (r.status === 'fulfilled') next.push(...r.value);
    // A source you may not read just stays out of the index.
    index = next;
    indexAt = Date.now();
    indexing = null;
    showObjects();
  });
  return indexing;
}

/** Objects are listed only once something is typed, so an empty palette opens on recents, actions and pages. */
/** Recents show while the query is empty (the same objects are then found under their own type). */
function setItems(query: string): void {
  for (const id of [...shownObjects, ...shownRecents]) palette.unregisterCommand(id);
  shownObjects = [];
  shownRecents = [];
  if (query.trim()) {
    for (const o of index) {
      const item = objItem(o);
      palette.registerCommand(item);
      shownObjects.push(item.id);
    }
  } else {
    for (const r of recents()) {
      const item = objItem(r, 'recent:');
      palette.registerCommand(item);
      shownRecents.push(item.id);
    }
    // Recents lead the empty palette (the component's own recent list would put a page first).
    (palette as unknown as { _recentIds: string[] })._recentIds = [...shownRecents];
  }
}
function showObjects(): void {
  setItems(paletteQuery);
  commands.refresh(); // the open palette re-filters with its current query
}

const openPalette = palette.open.bind(palette);
palette.open = (): void => {
  paletteQuery = '';
  setItems('');
  openPalette();
  void loadIndex();
};
// The query lives in the palette's shadow input; its input events are composed, so they reach the host.
palette.addEventListener('input', (e) => {
  const q = (e.composedPath()[0] as HTMLInputElement | undefined)?.value ?? '';
  const had = paletteQuery.trim() !== '';
  paletteQuery = q;
  if (had !== (q.trim() !== '')) showObjects();
});

/**
 * Actions: each goes to the screen that owns it and presses its button there
 * (which asks first where the action changes anything). If the button isn't
 * offered right now (no privilege, nothing to clear) you just land on the screen.
 */
function pressWhenReady(label: string): void {
  const norm = (t: string): string => t.replace(/…/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const want = norm(label);
  const find = (): HTMLElement | null => {
    const scope = [...document.querySelectorAll<HTMLElement>('#page-actions button, #page-banners button')];
    return scope.find((b) => !b.hidden && !(b as HTMLButtonElement).disabled && !b.hasAttribute('data-crud-blocked') && norm(b.textContent ?? '') === want) ?? null;
  };
  const started = Date.now();
  const attempt = (): void => {
    const b = find();
    if (b) { b.click(); return; }
    if (Date.now() - started < 4000) setTimeout(attempt, 150);
  };
  setTimeout(attempt, 0);
}
const ACTIONS: Array<{ id: string; label: string; route: string; press?: string; icon: string }> = [
  { id: 'act:new-user', label: 'New user…', route: 'security/users', press: 'New user', icon: 'user' },
  { id: 'act:new-role', label: 'New role…', route: 'security/roles', press: 'New role', icon: 'users' },
  { id: 'act:switch-journal', label: 'Switch journal file…', route: 'operations/journals', press: 'Switch journal file', icon: 'refresh-cw' },
  { id: 'act:suspend-tm', label: 'Suspend Task Manager…', route: 'tasks/schedule', press: 'Suspend Task Manager', icon: 'calendar-clock' },
  { id: 'act:run-task', label: 'Run a task…', route: 'tasks/upcoming', icon: 'play' },
  { id: 'act:clear-alerts', label: 'Clear alerts…', route: 'logs/alerts', press: 'Clear list', icon: 'bell' },
  { id: 'act:audit-on', label: 'Turn on auditing…', route: 'logs/audit', press: 'Turn on auditing', icon: 'shield' },
];
for (const a of ACTIONS) {
  commands.register({
    id: a.id, label: a.label, group: 'Actions', icon: a.icon,
    run: () => { void navigate(a.route).then(() => { if (a.press) pressWhenReady(a.press); }); },
  });
}
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
commands.register({ id: 'help:page', label: 'Help: About this page', group: 'Help', run: toggleHelp });
document.addEventListener('keydown', (e) => {
  if (e.key === 'F1') { e.preventDefault(); toggleHelp(); }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); (document.querySelector('#btn-sidebar') as HTMLElement).click(); }
});
commands.register({ id: 'view:theme', label: 'Toggle light / dark', group: 'View', run: () => themeBtn.click() });
commands.register({ id: 'view:menu', label: 'Toggle menu', group: 'View', run: () => (document.querySelector('#btn-sidebar') as HTMLElement).click() });

// Instance identity, centred in the top bar: host · instance · major version.
let instanceName = '';
let version = '';
let fullVersion = '';
let platform = '';
let built = '';
let systemMode = '';
/** The server's own name (OSCA API), else the address the browser used. */
let host = { name: location.hostname, title: `Reached at ${location.host}`, fromServer: false };
/** IRIS System Mode (Live / Test / Development / Failover), shown as a tone pill so production is unmistakable. */
const MODE_TONE: Record<string, string> = { LIVE: 'danger', TEST: 'warning', DEVELOPMENT: 'neutral', FAILOVER: 'info' };
const renderInstance = (): void => {
  (document.querySelector('#instance') as HTMLElement).innerHTML =
    `<span class="instance-host" title="${esc(host.title)}">${esc(host.name)}</span><span class="instance-sep" aria-hidden="true">·</span>` +
    `<b>${esc(instanceName || 'IRIS')}</b>${version ? `<span class="instance-sep" aria-hidden="true">·</span><span class="instance-version">${esc(version)}</span>` : ''}` +
    (systemMode ? `<span class="mode-pill" data-tone="${MODE_TONE[systemMode.toUpperCase()] ?? 'neutral'}" title="System mode set on this instance">${esc(systemMode)}</span>` : '');
};
renderInstance();
void serverName().then((s) => { host = s; renderInstance(); });
getInfo()
  .then((info) => {
    const m = /(\d{4}\.\d+)/.exec(info.serverVersion);
    if (m) version = m[1];
    // "IRIS for Windows (x86-64) 2026.2 (Build 221U) Fri Jun 26 2026 …" → "2026.2 (Build 221U)"
    const b = /(\d{4}\.\d+(?:\.\d+)*)\s*\(Build ([^)]+)\)/.exec(info.serverVersion);
    fullVersion = b ? `${b[1]} · build ${b[2]}` : info.serverVersion;
    // "IRIS for Windows (x86-64) … Fri Jun 26 2026 09:53:59 EDT" → platform "Windows x86-64", built "26 Jun 2026".
    const p = /for (\S+) \(([^)]+)\)/.exec(info.serverVersion);
    if (p) platform = `${p[1]} ${p[2]}`;
    const d = /\w{3} (\w{3}) (\d{1,2}) (\d{4})/.exec(info.serverVersion);
    if (d) built = `${d[2]} ${d[1]} ${d[3]}`;
    systemMode = String((info as { systemMode?: string }).systemMode ?? '').trim();
    renderInstance();
  })
  .catch(() => { (document.querySelector('#instance') as HTMLElement).textContent = 'Not connected'; });
metrics.subscribe((s) => {
  const info = s.get('iris_system_info')?.[0]?.labels;
  const id = info?.id ?? '';
  if (!version && info?.version) version = info.version;
  if (id && id !== instanceName) { instanceName = id; renderInstance(); }
});

// Instance details popover: everything you'd paste into a support ticket.
{
  const btn = document.querySelector('#instance') as HTMLElement;
  const pop = document.querySelector('#instance-pop') as HTMLElement;
  const close = (): void => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const rows = (): [string, string][] => ([
    ['Instance', instanceName || '—'],
    ['Product', 'InterSystems IRIS'],
    ['Version', fullVersion || version || '—'],
    ['Built', built],
    ['Platform', platform],
    ['System mode', systemMode],
    ['Server', host.fromServer ? host.name : ''],
    ['Web address', location.host],
  ] as [string, string][]).filter(([, v]) => v);
  const text = (): string => rows().map(([k, v]) => `${k}: ${v}`).join('\n');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pop.hidden) { close(); return; }
    pop.innerHTML = `
      <dl class="instance-kv">
        ${rows().map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
      </dl>
      <div class="instance-pop-actions">
        <button type="button" class="btn btn--sm" id="instance-copy"><ev-icon name="copy" size="xs"></ev-icon>Copy details</button>
        <a class="btn btn--sm" href="/csp/sys/UtilHome.csp" target="_blank" rel="noopener"><ev-icon name="external-link" size="xs"></ev-icon>Management Portal</a>
      </div>`;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    pop.querySelector('#instance-copy')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(text()).then(() => { (pop.querySelector('#instance-copy') as HTMLElement).innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied'; });
    });
  });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target as Node)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { close(); btn.focus(); } });
}

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

// ── Status bar: ambient health from the shared metrics + alert stores ──
// Left, in fixed positions (exceptions first): Health, Alerts, Licences, CPU,
// Memory, Processes. Right: Uptime, Connection. Every item is "Label value",
// opens the page that explains it, and only colours up when something is off.
// Tones use hysteresis so a value hovering at a threshold doesn't flicker.
{
  const left = document.querySelector('#sb-health') as HTMLElement;
  const right = document.querySelector('#sb-right') as HTMLElement;
  let last: Snapshot | null = null;
  // Instance-wide security posture: one status-bar item instead of a banner on every screen.
  // undefined until the first check returns; null when there's nothing to report. The item is always shown.
  let security: { tone: string; text: string } | null | undefined;
  const loadSecurity = (): void => {
    getSecurityGraph(true).then((g) => { security = riskBanner(g); if (last) renderLeft(last); }, () => { /* keep the last reading */ });
  };
  loadSecurity();
  setInterval(loadSecurity, 120_000);
  let lastOk = 0;
  let failing = false;
  let recent = 0; // alerts the portal holds from the last 24h — the ones you can actually open
  let uptime = '';
  const n = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : '—');
  type Tone = 'neutral' | 'warning' | 'danger';
  const held = new Map<string, Tone>();
  /** Threshold tone with 10-point hysteresis: a tone only clears once the value is 10 below its threshold. */
  const tone = (key: string, v: number, warn: number, bad: number): Tone => {
    const prev = held.get(key) ?? 'neutral';
    let t: Tone = v >= bad ? 'danger' : v >= warn ? 'warning' : 'neutral';
    if (t === 'neutral' && prev !== 'neutral' && v > warn - 10) t = 'warning';
    if (t === 'warning' && prev === 'danger' && v > bad - 10) t = 'danger';
    held.set(key, t);
    return t;
  };
  /**
   * "Label ● value": a tertiary label and a secondary value; state shows only
   * as the 6px dot before the value (never coloured text). The dot's slot is
   * always reserved, so nothing shifts when a value goes in or out of alarm.
   */
  const item = (t: string, go: string, title: string, label: string, val: string, extra = ''): string =>
    `<button type="button" class="sb-item" data-tone="${t}" data-go="${go}"${extra} title="${esc(title)}"><span class="sb-label">${label}</span><span class="dot" aria-hidden="true"></span><b>${val}</b></button>`;

  const renderLeft = (snap: Snapshot): void => {
    last = snap;
    const health = overallHealth(snap, recent);
    const cpu = value(snap, 'iris_cpu_usage');
    const mem = value(snap, 'iris_phys_mem_percent_used');
    const procs = value(snap, 'iris_process_count');
    const raised = value(snap, 'iris_system_alerts'); // same source as the Alerts page
    const used = value(snap, 'iris_license_consumed');
    const free = value(snap, 'iris_license_available');
    const total = used + free;
    const licPct = Number.isFinite(total) && total > 0 ? (used / total) * 100 : NaN;
    const alertCount = recent > 0 ? recent : raised;
    const cpuT = tone('cpu', cpu, 80, 95);
    const memT = tone('mem', mem, 85, 95);
    const licT: Tone = !Number.isFinite(licPct) ? 'neutral' : free <= 0 || licPct >= 95 ? 'danger' : licPct >= 80 ? 'warning' : 'neutral';
    const alertT: Tone = recent > 0 ? 'warning' : 'neutral';
    left.innerHTML = [
      item(health.tone, 'home/overview', health.reasons.length ? health.reasons.map((r) => r.text).join(' · ') : 'Nothing needs attention', 'Health', esc(health.label), ' data-w="health"'),
      item(alertT, 'logs/alerts', recent > 0 ? `${recent} alert${recent === 1 ? '' : 's'} in the last 24 hours` : `${n(raised)} alerts raised since IRIS started`, 'Alerts', n(alertCount), ' data-w="alerts"'),
      Number.isFinite(total)
        ? item(licT, 'home/overview', `${n(used)} of ${n(total)} license units in use · ${n(free)} free${free <= 0 ? ' · new connections may be refused' : ''}`, 'Licenses', `${n(used)}/${n(total)} used`, ' data-w="licenses"')
        : '',
      item(cpuT, 'operations/overview', 'CPU use across the whole machine, not just IRIS', 'CPU', `${n(cpu)}%`, ' data-w="pct"'),
      item(memT, 'operations/overview', 'Physical memory in use on the machine', 'Memory', `${n(mem)}%`, ' data-w="pct"'),
      item('neutral', 'operations/processes', 'Processes running in IRIS', 'Processes', n(procs), ' data-w="procs"'),
      // Security opens Home on its issue ("home/overview/security": Home may scroll to and highlight it).
      security
        ? item(security.tone, 'home/overview/security', `${security.text} · Open the issue on Home`, 'Security', security.tone === 'danger' ? 'Critical' : 'Review', ' data-w="security"')
        : security === null
          ? item('success', 'home/overview', 'No security risks found in users, roles or public access', 'Security', 'OK', ' data-w="security"')
          : item('neutral', 'home/overview', 'Checking users, roles and public access…', 'Security', '—', ' data-w="security"'),
    ].join('');
    left.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.dataset.go ?? '')));
  };

  const renderRight = (): void => {
    const since = lastOk ? Math.round((Date.now() - lastOk) / 1000) : 0;
    const conn = !lastOk && !failing ? { t: 'neutral', label: 'Connecting…', tip: 'Waiting for the first reading' }
      : failing && since >= 30 ? { t: 'danger', label: `Offline · ${since < 60 ? `${since}s` : `${Math.round(since / 60)}m`}`, tip: 'IRIS hasn’t answered. Click to try again now.' }
        : failing ? { t: 'warning', label: 'Reconnecting…', tip: 'The last reading failed. Click to try again now.' }
          : { t: 'success', label: 'Connected', tip: `Last reading ${since}s ago · figures refresh every minute (every 20 seconds on Activity)` };
    right.innerHTML = `
      ${uptime ? `<span class="sb-item sb-static" title="Time since IRIS last started"><span class="sb-label">Up</span><b>${esc(uptime)}</b></span>` : ''}
      ${conn.t === 'success' ? '' /* the page's Live dot already says data is flowing; only speak up when it isn't */
        : `<button type="button" class="sb-item" id="sb-conn" data-tone="${conn.t}" title="${esc(conn.tip)}"><span class="dot" aria-hidden="true"></span><b>${conn.label}</b></button>`}`;
    right.querySelector('#sb-conn')?.addEventListener('click', () => void metrics.refresh());
  };

  metrics.subscribe((s) => { lastOk = Date.now(); failing = false; renderLeft(s); renderRight(); }, () => { failing = true; renderRight(); });
  setInterval(renderRight, 5000);
  // Keep collecting alerts app-wide, whichever page is open.
  alerts.subscribe((list) => {
    const dayAgo = Date.now() - 86400000;
    recent = list.filter((a) => Date.parse(a.time) >= dayAgo).length;
    if (last) renderLeft(last);
  });
  const loadUptime = (): void => {
    getDashboard().then((d) => { uptime = d.Status.UpTime.replace(/\s+/g, ' ').replace(/^0d /, '').trim(); renderRight(); }).catch(() => { /* uptime is optional */ });
  };
  loadUptime();
  setInterval(loadUptime, 60_000);
  renderRight();
}
