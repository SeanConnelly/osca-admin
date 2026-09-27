// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Web & APIs › API explorer — every REST API this instance serves, read from
 * the OpenAPI descriptions IRIS generates: pick an API, browse its endpoints,
 * see each one's parameters and responses, and try reads (GET) live. Nothing
 * that changes the server can be sent from here.
 */
import '../styles-apps.css';
import '../styles-web.css';
import '@evolution-ui/core/components/ev-select/ev-select.js';
import {
  getRestApis, getSpec, parseSpec, unsafeRead, tryGet, takeExplorerApi, docsWeb,
  type RestApi, type ApiDoc, type Endpoint, type Param, type TryResult,
} from '../api-web';
import { getWebAppList, getWebApp, type WebAppSummary } from '../api-apps';
import { esc, chip, num, skeleton, errorPanel, liveIndicator, emptyState, type ScreenCtx, type Tone } from '../ui';
import { textField, readForm, toast } from '../crud';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

const LAST_KEY = 'osca-portal:explorer-last';
const WHERE: Record<string, string> = { path: 'In the path', query: 'Query', header: 'Header', body: 'Body', formData: 'Form field', cookie: 'Cookie' };
/**
 * One neutral outline badge for every method. Reads (GET, HEAD, OPTIONS) have
 * a plain edge; anything that changes the server (POST, PUT, PATCH, DELETE)
 * gets a 2px warning left edge, because mutations are what an admin scans for.
 * Inline because grid cells are in shadow DOM.
 */
const MUTATES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const methodChip = (m: string): string => {
  const edge = MUTATES.has(m) ? '2px solid var(--ev-color-warning)' : '1px solid var(--ev-border-1)';
  return `<span class="ex-method" style="display:inline-block;box-sizing:border-box;min-width:56px;padding:1px 6px;text-align:center;font:500 11px/1.6 var(--ev-font-family-mono, monospace);color:var(--ev-color-text-secondary);background:transparent;border:1px solid var(--ev-border-1);border-left:${edge};border-radius:var(--ev-radius-sm, 4px)"${MUTATES.has(m) ? ' title="Changes the server"' : ''}>${esc(m)}</span>`;
};
const kb = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const authWords = (m: string[]): string => (m.length ? m.map((x) => (/^unauthenticated$/i.test(x) ? 'No sign-in' : x)).join(', ') : 'None enabled');

type GridEl = HTMLElement & { columns: DataGridColumn[]; rows: DataGridRow[]; select(keys: string[]): void };
type SegEl = HTMLElement & { options: Array<{ value: string; label: string }>; value: string };

export function apiExplorerScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="ex-toolbar">
      <div class="ex-api-slot" id="ex-api-slot"></div>
      <div class="search-box"><ev-search id="ex-search" size="sm" full-width placeholder="Filter endpoints by path or summary" aria-label="Filter endpoints"></ev-search></div>
      <ev-segmented-button id="ex-ver" size="sm" aria-label="API version" hidden></ev-segmented-button>
    </div>
    <div class="ex-about" id="ex-about" aria-live="polite"></div>
    <ev-detail-panel id="ex-panel" detail-width="460" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="ex-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="ex-detail" aria-label="Endpoint details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="ex-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#ex-panel');
  const wrap = $('#ex-wrap');
  const detail = $('#ex-detail');
  const about = $('#ex-about');
  const verEl = $<SegEl>('#ex-ver');

  let apis: RestApi[] = [];
  let webApps: WebAppSummary[] = [];
  let current: RestApi | null = null;
  let doc: ApiDoc | null = null;
  const docs = new Map<string, ApiDoc>();
  /** Does the app accept the portal's sign-in? Read once per app. */
  const jwt = new Map<string, boolean>();
  let version = '';
  let query = '';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let alive = true;
  let loadSeq = 0;
  ctx.onLeave(() => { alive = false; });
  const lastResult = new Map<string, { url: string; r: TryResult }>();

  const appOf = (a: RestApi | null): WebAppSummary | undefined => (a ? webApps.find((w) => w.Name === a.name) : undefined);

  // ── API picker and the line about it ──
  const buildPicker = (): void => {
    const slot = $('#ex-api-slot');
    const pick = document.createElement('ev-select') as HTMLElement & { value: string };
    pick.id = 'ex-api';
    pick.setAttribute('size', 'sm');
    pick.setAttribute('full-width', '');
    pick.setAttribute('aria-label', 'Choose an API');
    if (apis.length > 8) pick.setAttribute('searchable', '');
    pick.innerHTML = apis.map((a) => `<option value="${esc(a.name)}">${esc(a.name)}${a.enabled ? '' : ' · switched off'}</option>`).join('');
    pick.setAttribute('value', current?.name ?? '');
    pick.addEventListener('ev-select-change', (e) => {
      const v = (e as CustomEvent<{ value: string | string[] }>).detail.value;
      const name = Array.isArray(v) ? v[0] ?? '' : v;
      const next = apis.find((a) => a.name === name);
      if (next && next !== current) void choose(next);
    });
    slot.replaceChildren(pick);
  };
  const renderAbout = (): void => {
    const a = current;
    if (!a) { about.innerHTML = ''; return; }
    const w = appOf(a);
    const res = a.resource || w?.Resource || '';
    // Three facts as one compact strip: label muted, value plain; the spec link sits at the right.
    const cellHtml = (label: string, value: string, title = ''): string =>
      `<span class="ex-fact"${title ? ` title="${esc(title)}"` : ''}><span class="ex-fact-label">${esc(label)}</span><span class="ex-fact-value">${value}</span></span>`;
    const base = doc?.basePath || a.name;
    about.innerHTML = `<span class="ex-about-text">
        ${cellHtml('Base path', `<span class="mono">${esc(base)}</span>${a.enabled ? '' : ' <span class="dim">· disabled</span>'}`, base)}
        ${cellHtml('Sign-in', w ? esc(authWords(w.AuthenticationMethods)) : '—')}
        ${cellHtml('Required resource', res ? `<span class="mono">${esc(res)}</span>` : '—')}
      </span>
      <span class="ex-about-links"><a class="link" href="${esc(a.swaggerSpec)}" target="_blank" rel="noopener noreferrer" title="The OpenAPI description IRIS generates; opens in a new tab">OpenAPI description<ev-icon name="arrow-up-right" size="xs" aria-hidden="true"></ev-icon></a></span>`;
  };

  // ── Endpoint grid ──
  /**
   * Path and summary share one cell: the path in 12.5px mono, a 16px gap, then
   * the summary in 13px tertiary text that ends in an ellipsis. No separate
   * Summary column, so a sparse summary never leaves a column of blanks.
   */
  const pathCell = (path: unknown, summary: unknown): string =>
    `<span style="display:flex;align-items:baseline;gap:16px;width:0;min-width:100%;max-width:100%;overflow:hidden;white-space:nowrap" title="${esc(summary ? `${path} · ${summary}` : path)}">`
    + `<span style="flex:none;font:400 12.5px/1.4 var(--ev-font-family-mono);color:var(--ev-color-text-primary)">${esc(path)}</span>`
    + (summary ? `<span style="flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--ev-color-text-tertiary)">${esc(summary)}</span>` : '')
    + '</span>';
  const COLUMNS: DataGridColumn[] = [
    { key: 'Method', label: 'Method', width: '92px', sortable: true, renderCell: (v) => methodChip(String(v)) },
    { key: 'Path', label: 'Path', width: '100%', sortable: true, renderCell: (v, row) => pathCell(v, row.Summary) },
  ];
  const columnsFor = (_d: ApiDoc): DataGridColumn[] => COLUMNS;
  /**
   * Group rows: the first fixed path segment after the version ("task",
   * "security"); a group of more than 15 splits by its second segment
   * ("security/users", "task/manager"), so a long API reads as sections.
   */
  const groupsOf = (d: ApiDoc): Map<string, string> => {
    const segs = (e: Endpoint): string[] => e.path.split('/').filter((x) => x && !/^\{.*\}$/.test(x) && !(x === e.version));
    const first = new Map<string, number>();
    for (const e of d.endpoints) { const k = segs(e)[0] ?? '/'; first.set(k, (first.get(k) ?? 0) + 1); }
    const out = new Map<string, string>();
    for (const e of d.endpoints) {
      const s = segs(e);
      const k = s[0] ?? '/';
      out.set(e.key, (first.get(k) ?? 0) > 15 && s[1] ? `${k}/${s[1]}` : k);
    }
    return out;
  };
  let groupOf = new Map<string, string>();
  const versions = (d: ApiDoc): string[] => [...new Set(d.endpoints.map((e) => e.version).filter(Boolean))].sort((x, y) => Number(y.slice(1)) - Number(x.slice(1)));
  const inVersion = (e: Endpoint): boolean => !version || !e.version || e.version === version;
  const visible = (): Endpoint[] => (doc?.endpoints ?? []).filter((e) => {
    if (!inVersion(e)) return false;
    if (!query) return true;
    const ql = query.toLowerCase();
    return [e.method, e.path, e.summary, e.description].some((f) => f.toLowerCase().includes(ql));
  });
  const renderVersions = (): void => {
    const vs = doc ? versions(doc) : [];
    verEl.hidden = vs.length < 2;
    if (vs.length < 2) { version = ''; return; }
    if (version && !vs.includes(version)) version = '';
    if (!version) version = vs[0];
    verEl.options = [...vs.map((v) => ({ value: v, label: v })), { value: 'all', label: 'All versions' }];
    verEl.value = version || 'all';
  };
  /**
   * Group rows are the grid's own; their look lives in its shadow root, so a
   * small sheet goes in there: 28px rows that stick under the column header
   * while their section scrolls, the group name in mono.
   */
  const styleGroups = (g: GridEl): void => {
    let tries = 0;
    const apply = (): void => {
      if (++tries > 120) return; // the grid never drew (replaced by an empty state or an error): stop asking
      const root = g.shadowRoot;
      if (!root) { requestAnimationFrame(apply); return; }
      if (!root.querySelector('style[data-ex-groups]')) {
        const st = document.createElement('style');
        st.dataset.exGroups = '';
        // Group heads in sans 12.5/600. Sort arrows: only the active column's shows; a hover arrow is a
        // faint 40% hint in text colour, never accent, so two arrows never look lit at once.
        st.textContent = `.group-header td { position: sticky; top: var(--ex-head, 32px); z-index: 2; height: 28px; box-sizing: border-box; padding-block: 0;
          font: 600 12.5px/28px var(--ev-font-family); color: var(--ev-color-text-primary); background: var(--ev-surface-2, var(--ev-color-surface-raised)); border-bottom: 1px solid var(--ev-border-1, var(--ev-color-border)); }
          .group-count { font-weight: 400; font-size: 12px; color: var(--ev-color-text-tertiary); }
          th.sortable:hover .sort-arrow:not(.sort-arrow--active), th.sortable:focus-visible .sort-arrow:not(.sort-arrow--active) { opacity: 0.4; color: var(--ev-color-text-tertiary); }`;
        root.appendChild(st);
      }
      const head = root.querySelector('thead') as HTMLElement | null;
      if (head?.offsetHeight) g.style.setProperty('--ex-head', `${head.offsetHeight}px`);
      else requestAnimationFrame(apply);
    };
    apply();
  };
  const renderGrid = (): void => {
    if (!doc) return;
    if (!doc.endpoints.length) {
      grid = null;
      wrap.innerHTML = emptyState({ icon: 'globe', title: 'This API describes no endpoints', what: 'IRIS generated a description for it, but it lists no paths.', docs: { href: docsWeb.rest, label: 'About REST services in IRIS' } });
      return;
    }
    const rows = visible().map((e): DataGridRow => ({ Key: e.key, Method: e.method, Path: e.path, Summary: e.summary, Group: groupOf.get(e.key) ?? '' }));
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Key');
      grid.setAttribute('sort-column', 'Path');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('group-by', 'Group');
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        selected = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Key);
        renderDetail();
      });
      wrap.appendChild(grid);
      styleGroups(grid);
    }
    const cols = columnsFor(doc);
    if (grid.columns?.map((c) => `${c.key}:${c.width ?? ''}`).join() !== cols.map((c) => `${c.key}:${c.width ?? ''}`).join()) grid.columns = cols;
    grid.rows = rows;
    grid.select(selected ? [selected] : []);
    wrap.querySelector('.grid-empty')?.remove();
    if (!rows.length) wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">No endpoints match “${esc(query)}”.</div>`);
  };
  const renderFoot = (): void => {
    const foot = $('#ex-foot');
    if (!doc) { foot.innerHTML = apis.length ? `<b>${num(apis.length)}</b> REST APIs` : ''; return; }
    const shown = doc.endpoints.filter(inVersion);
    const reads = shown.filter((e) => e.method === 'GET').length;
    foot.innerHTML = `<b>${num(shown.length)}</b> endpoint${shown.length === 1 ? '' : 's'}${version ? ` in ${esc(version)}` : ''}<span class="meta-sep">·</span><b>${num(reads)}</b> reads<span class="meta-sep">·</span><b>${num(apis.length)}</b> APIs`;
  };

  // ── Endpoint detail ──
  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => { selected = null; grid?.select([]); setPanel(false); };
  const paramRow = (p: Param): string => `<li class="ex-param">
      <div class="ex-param-head"><span class="mono">${esc(p.name)}</span><span class="ex-param-meta">${esc(WHERE[p.in] ?? p.in)}${p.type ? ` · ${esc(p.type)}` : ''}${p.required ? ' · required' : ''}</span></div>
      ${p.description ? `<p class="ex-param-desc">${esc(p.description)}</p>` : ''}
      ${p.values?.length ? `<p class="ex-param-desc">One of ${p.values.map((v) => `<span class="mono">${esc(v)}</span>`).join(', ')}</p>` : ''}
    </li>`;

  /** The URL a read would go to, with the parameters filled in. */
  const buildUrl = (e: Endpoint, host: ParentNode): { url: string; missing: string[] } => {
    const v = readForm(host);
    const missing: string[] = [];
    const path = e.path.split('/').map((seg) => seg.split(/(\{[^}]+\})/).map((part) => {
      const m = /^\{([^}]+)\}$/.exec(part);
      if (!m) return encodeURIComponent(part);
      const val = String(v[`p_${m[1]}`] ?? '').trim();
      if (!val) missing.push(m[1]);
      return val ? encodeURIComponent(val) : part;
    }).join('')).join('/');
    const qs = new URLSearchParams();
    for (const p of e.params.filter((x) => x.in === 'query')) {
      const val = String(v[`q_${p.name}`] ?? '').trim();
      if (val) qs.append(p.name, val);
      else if (p.required) missing.push(p.name);
    }
    const extra = String(v.q_extra ?? '').trim().replace(/^\?/, '');
    const qsText = [qs.toString(), extra].filter(Boolean).join('&');
    return { url: `${doc?.basePath ?? ''}${path}${qsText ? `?${qsText}` : ''}`, missing };
  };

  const resultHtml = (url: string, r: TryResult): string => {
    if (r.error) return `<div class="ex-result"><p class="detail-para check-warn">${esc(r.error)}</p></div>`;
    const tone: Tone = r.status >= 500 ? 'danger' : r.status >= 400 ? 'warning' : r.status >= 200 && r.status < 300 ? 'success' : 'neutral';
    const why = r.status === 401 ? 'This API wants a sign-in the explorer didn’t send. Open the address in a new tab to sign in there.'
      : r.status === 403 ? 'You’re signed in, but your roles don’t allow this.'
      : r.status === 404 ? 'Nothing at that address: check the parameters.' : '';
    return `<div class="ex-result">
      <div class="ex-result-line">${chip(`${r.status}${r.statusText ? ` ${r.statusText}` : ''}`, tone)}<span class="ex-result-meta">${num(r.ms)} ms<span class="meta-sep">·</span>${esc(kb(r.bytes))}${r.contentType ? `<span class="meta-sep">·</span>${esc(r.contentType.split(';')[0])}` : ''}</span>
        <a class="link ex-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open this address in a new tab">Open<ev-icon name="arrow-up-right" size="xs" aria-hidden="true"></ev-icon></a></div>
      ${why ? `<p class="detail-para">${esc(why)}</p>` : ''}
      ${r.body ? `<pre class="pre-block ex-body" tabindex="0" aria-label="Response body">${esc(r.body)}</pre>` : '<p class="detail-note">Empty response.</p>'}
      ${r.truncated ? '<p class="detail-note">Showing the first 200,000 characters. Open it in a new tab for the rest.</p>' : ''}
    </div>`;
  };

  const tryBlock = (e: Endpoint): string => {
    if (e.method !== 'GET') return `<p class="detail-para">Only reads (GET) can be tried here, so nothing on the server changes.</p>`;
    if (current && !current.enabled) return '<p class="detail-para">This API is switched off, so IRIS refuses requests to it.</p>';
    const probe = unsafeRead(`${doc?.basePath ?? ''}${e.path}`);
    if (probe) return `<p class="detail-para">Not tried here: ${esc(probe)}</p>`;
    const pathParams = e.params.filter((p) => p.in === 'path');
    const queryParams = e.params.filter((p) => p.in === 'query');
    return `<form class="ex-try" id="ex-try" novalidate>
      ${pathParams.map((p) => textField(`p_${p.name}`, p.name, p.fallback ?? '', { mono: true, required: true, placeholder: /namespace/i.test(p.name) ? 'e.g. USER' : undefined })).join('')}
      ${queryParams.map((p) => textField(`q_${p.name}`, p.name, p.fallback ?? '', { mono: true, required: p.required, hint: p.description || undefined })).join('')}
      ${textField('q_extra', 'More query parameters', '', { mono: true, placeholder: 'name=value&other=value', hint: queryParams.length ? undefined : 'This description lists no query parameters; add any the endpoint takes.' })}
      <p class="ex-url" id="ex-url" title="The address the request goes to"></p>
      <p class="ex-auth" id="ex-auth"></p>
      <div class="ex-try-actions"><button type="submit" class="btn btn--sm" id="ex-send"><ev-icon name="play" size="xs"></ev-icon>Send request</button><span class="ex-missing" id="ex-missing" aria-live="polite"></span></div>
    </form>
    <div id="ex-out"></div>`;
  };

  const renderDetail = (): void => {
    const e = doc?.endpoints.find((x) => x.key === selected);
    if (!e) { closeDetail(); return; }
    const long = e.description.length > 600;
    const descHtml = e.description && e.description !== e.summary
      ? (long ? `<details class="ex-desc-more"><summary>Description</summary><p class="ex-desc">${esc(e.description)}</p></details>` : `<p class="ex-desc">${esc(e.description)}</p>`) : '';
    const params = e.params;
    detail.innerHTML = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">${esc(current?.name ?? '')}</span><h2 class="mono ex-title">${esc(e.path)}</h2>${e.summary ? `<p class="detail-subtitle">${esc(e.summary)}</p>` : ''}</div>
        <ev-icon-button icon="x" label="Close details" id="ex-close"></ev-icon-button>
      </header>
      <div class="detail-state">${methodChip(e.method)}${e.deprecated ? chip('Deprecated', 'warning') : ''}<button type="button" class="link detail-state-link" id="ex-copy" title="Copy the full path"><ev-icon name="copy" size="xs"></ev-icon>Copy path</button></div>
      ${descHtml}
      <h3 class="detail-section">Parameters · ${num(params.length)}</h3>
      ${params.length ? `<ul class="ex-params">${params.map(paramRow).join('')}</ul>` : '<p class="chip-list-empty">None.</p>'}
      ${e.hasBody && !params.some((p) => p.in === 'body') ? '<p class="detail-note">Takes a request body.</p>' : ''}
      <h3 class="detail-section">Responses</h3>
      ${e.responses.length ? `<dl class="kv-list">${e.responses.map((r) => `<div class="kv"><dt class="mono">${esc(r.code === 'default' ? 'Other' : r.code)}</dt><dd title="${esc(r.description)}">${esc(r.description || '—')}</dd></div>`).join('')}</dl>` : '<p class="chip-list-empty">Not described.</p>'}
      <h3 class="detail-section">Try it</h3>
      ${tryBlock(e)}`;
    detail.querySelector('#ex-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#ex-copy')?.addEventListener('click', () => {
      void navigator.clipboard.writeText(`${doc?.basePath ?? ''}${e.path}`).then(() => toast('Path copied.', 'info'), () => toast('Couldn’t copy. Select the path and copy it instead.', 'warning'));
    });
    const form = detail.querySelector<HTMLFormElement>('#ex-try');
    if (form) wireTry(e, form);
    setPanel(true);
  };

  const wireTry = (e: Endpoint, form: HTMLFormElement): void => {
    const urlEl = form.querySelector('#ex-url') as HTMLElement;
    const missEl = form.querySelector('#ex-missing') as HTMLElement;
    const authEl = form.querySelector('#ex-auth') as HTMLElement;
    const out = detail.querySelector('#ex-out') as HTMLElement;
    const sync = (): void => {
      const { url, missing } = buildUrl(e, form);
      urlEl.textContent = url;
      missEl.textContent = missing.length ? `Fill in ${missing.join(', ')} first` : '';
    };
    const api = current;
    const known = api ? jwt.get(api.name) : undefined;
    const sayAuth = (b: boolean | undefined): void => {
      authEl.textContent = b === undefined ? '' : b ? 'Sent with your portal sign-in.' : 'Sent without your portal sign-in, which this API doesn’t accept.';
    };
    sayAuth(known);
    if (api && known === undefined) {
      getWebApp(api.name).then((d) => { jwt.set(api.name, d.JWTAuthEnabled); if (form.isConnected) sayAuth(d.JWTAuthEnabled); }).catch(() => { jwt.set(api.name, false); if (form.isConnected) sayAuth(false); });
    }
    const prev = lastResult.get(e.key);
    if (prev) out.innerHTML = resultHtml(prev.url, prev.r);
    for (const ev of ['ev-input-input', 'input', 'change']) form.addEventListener(ev, sync);
    sync();
    form.addEventListener('keydown', (k) => { if ((k as KeyboardEvent).key === 'Enter') { k.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', (s) => {
      s.preventDefault();
      const { url, missing } = buildUrl(e, form);
      if (missing.length) { missEl.textContent = `Fill in ${missing.join(', ')} first`; return; }
      const blocked = unsafeRead(url);
      if (blocked) { missEl.textContent = blocked; return; }
      const btn = form.querySelector('#ex-send') as HTMLButtonElement;
      if (btn.getAttribute('aria-busy') === 'true') return;
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      out.innerHTML = `<div class="ex-result">${skeleton(3)}</div>`;
      const bearer = api ? jwt.get(api.name) ?? false : false;
      void tryGet(url, bearer).then((r) => {
        lastResult.set(e.key, { url, r });
        if (out.isConnected) out.innerHTML = resultHtml(url, r);
      }).finally(() => { if (btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); } });
    });
  };

  // ── Loading ──
  const choose = async (a: RestApi): Promise<void> => {
    current = a;
    try { localStorage.setItem(LAST_KEY, a.name); } catch { /* per-viewer convenience only */ }
    closeDetail();
    query = '';
    const search = ctx.body.querySelector('#ex-search') as (HTMLElement & { value: string }) | null;
    if (search) search.value = '';
    const seq = ++loadSeq;
    doc = docs.get(a.name) ?? null;
    if (!doc) {
      grid = null;
      wrap.innerHTML = skeleton(10);
      renderAbout();
      renderFoot();
      try {
        const d = parseSpec(await getSpec(a.swaggerSpec), a.name);
        docs.set(a.name, d);
        if (seq !== loadSeq || !alive) return;
        doc = d;
      } catch (err) {
        if (seq !== loadSeq || !alive) return;
        wrap.innerHTML = errorPanel(err, 'ex-retry-spec');
        wrap.querySelector('#ex-retry-spec')?.addEventListener('click', () => { docs.delete(a.name); void choose(a); });
        return;
      }
    }
    version = '';
    groupOf = groupsOf(doc);
    renderVersions();
    renderAbout();
    if (grid) grid.rows = [];
    renderGrid();
    renderFoot();
  };

  const updated = liveIndicator(ctx, () => void load(true), { live: false });
  const load = async (fresh = false): Promise<void> => {
    try {
      const [list, wa] = await Promise.all([getRestApis(), getWebAppList().catch(() => [] as WebAppSummary[])]);
      if (!alive) return;
      apis = list.sort((x, y) => x.name.localeCompare(y.name));
      webApps = wa;
      updated(new Date());
      if (!apis.length) {
        $('#ex-toolbar').hidden = true;
        about.innerHTML = '';
        wrap.innerHTML = emptyState({ icon: 'globe', title: 'No REST APIs to describe', what: 'IRIS describes the REST APIs its web applications serve. None are defined on this instance yet.', docs: { href: docsWeb.rest, label: 'About REST services in IRIS' } });
        renderFoot();
        return;
      }
      $('#ex-toolbar').hidden = false;
      if (fresh) { docs.clear(); jwt.clear(); lastResult.clear(); }
      let pickName: string | null = takeExplorerApi();
      if (!pickName) pickName = current?.name ?? null;
      if (!pickName) { try { pickName = localStorage.getItem(LAST_KEY); } catch { pickName = null; } }
      const next = apis.find((a) => a.name === pickName) ?? apis[0];
      current = next;
      buildPicker();
      const keep = fresh ? null : selected;
      await choose(next);
      if (keep && doc?.endpoints.some((x) => x.key === keep)) { selected = keep; grid?.select([keep]); renderDetail(); }
    } catch (err) {
      if (!alive) return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'ex-retry');
      wrap.querySelector('#ex-retry')?.addEventListener('click', () => void load(true));
    }
  };

  ctx.body.querySelector('#ex-search')?.addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  verEl.addEventListener('ev-segmented-button-change', (e) => {
    const v = (e as CustomEvent<{ value: string }>).detail.value;
    version = v === 'all' ? '' : v;
    if (selected && !visible().some((x) => x.key === selected)) closeDetail();
    renderGrid();
    renderFoot();
  });

  void load();
}
