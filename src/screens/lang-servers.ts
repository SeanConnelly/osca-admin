// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Language servers — the external language servers IRIS starts
 * for Java, .NET, Python, R, the SQL Gateway, IntegratedML and XSLT: which
 * are running, what each one last did, and how each is set up.
 *
 * Actions (Use on %Admin_ExternalLanguageServerEdit): start, stop, create,
 * edit, delete. Tried live on osca_test_… servers only (see api-sys.ts); the
 * built-in servers were never started or stopped while building this.
 */
import '../styles-security.css';
import '../styles-sys.css';
import {
  getLangServers, getLangServer, getLangActivity, saveLangServer, deleteLangServer, startLangServer, stopLangServer,
  customFor, langType, LANG_TYPES, DOTNET_VERSIONS, sysDocs, sysPortal, 
  type LangServerRow, type LangServer, type LangActivity,
} from '../api-sys';
import { linkTo } from '../api-security';
import { kv, mono, setSearch, cellId,
  esc, chip, cell, num, when, irisDate, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText,
  type ScreenCtx, type Tone, type GridColumn,
} from '../ui';
import { pathField,
  AdminError, blockedAttrs, confirm, editorShell, errorText, fieldError, moreButton, moreMenu, newButton, panelWidth, readForm,
  section, selectField, textField, checkField, toast, scrollPanelTop, type EditorHandle, type FieldProblem, type MenuHandle,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };
type Scope = 'all' | 'running' | 'stopped';

const REFRESH_MS = 10_000;
const NO_EDIT = noPermissionText('%Admin_ExternalLanguageServerEdit', 'external language server administration');
const LOCAL = /^(127\.\d+\.\d+\.\d+|localhost|::1)$/i;

const dimText = (s: string): string => `<span class="dim">${esc(s)}</span>`;
const isBuiltIn = (name: string): boolean => name.startsWith('%');

/** IRIS's activity text without error prefixes, trailing line breaks or its own asterisks. */
function cleanActivity(t: string): string {
  return String(t ?? '')
    .replace(/^Return from RunStartCmd:\s*/i, '')
    .replace(/(^|\s)(ERROR|خطأ)\s*#\s*\d+\s*:\s*/gu, '$1')
    .replace(/ObjectScript error:\s*/i, '')
    .replace(/<\d+>\s*\*?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** One short phrase for the latest event, for the grid. */
function eventWords(a: LangActivity | undefined): { text: string; tone: Tone } | null {
  if (!a) return null;
  const t = a.Text;
  if (/error occurred while trying to start/i.test(t)) return { text: 'Couldn’t start', tone: 'danger' };
  if (a.RecordType === 'Error') return { text: 'Error', tone: 'danger' };
  if (/server stopped|has been stopped/i.test(t)) return { text: 'Stopped', tone: 'neutral' };
  if (/^(stopping|shutting down)/i.test(t)) return { text: 'Stopping', tone: 'neutral' };
  if (/started|is running|ready/i.test(t)) return { text: 'Started', tone: 'success' };
  if (/^starting/i.test(t)) return { text: 'Starting', tone: 'neutral' };
  return { text: cleanActivity(t), tone: a.RecordType === 'Warning' ? 'warning' : 'neutral' };
}
const recordTone = (r: string): Tone => (r === 'Error' ? 'danger' : r === 'Warning' ? 'warning' : 'neutral');

/**
 * A failed start, in the admin's terms: most often IRIS can't find the
 * program (java, python, dotnet…) it runs.
 */
function startProblem(msg: string, type: string): string {
  const clean = cleanActivity(msg);
  const cmd = /executing the command \(([^)]+)\)/i.exec(msg)?.[1];
  if (cmd && /cannot find|no such file|not found/i.test(msg)) {
    const where = type === 'Python' ? 'the Python executable' : type === '.NET' ? 'the gateway directory' : 'the Java home directory';
    return `IRIS couldn’t find ${cmd} on this machine. Install it, or set ${where} with Edit.`;
  }
  return clean || 'IRIS couldn’t start the server.';
}

export function langServersScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div class="toolbar-row" id="ls-toolbar">
      <div class="search-box"><ev-search id="ls-search" size="sm" full-width placeholder="Filter by name, type or port" aria-label="Filter language servers"></ev-search></div>
      <ev-segmented-button id="ls-scope" size="sm" aria-label="Show"></ev-segmented-button>
    </div>
    <ev-detail-panel id="ls-panel" detail-width="380" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="ls-wrap">${skeleton(8)}</div>
      <aside slot="detail" class="detail" id="ls-detail" aria-label="Language server"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="ls-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#ls-panel');
  const wrap = $('#ls-wrap');
  const detail = $('#ls-detail');
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#ls-scope');
  scopeEl.value = 'all';

  let alive = true;
  let rows: LangServerRow[] = [];
  const running = new Map<string, boolean>();
  const activity = new Map<string, LangActivity[]>();
  const configs = new Map<string, LangServer | { error: string }>();
  /** The last failed start per server, this session: shown until it starts or is dismissed by a new try. */
  const startErrors = new Map<string, string>();
  let loaded = false;
  let query = '';
  let scope: Scope = 'all';
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let rowSig = '';
  let shownHtml = '';
  let canEdit: boolean | null = null;
  let busy: string | null = null;
  let menu: MenuHandle | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  let formEvents: AbortController | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; formEvents?.abort(); formEvents = null; shownHtml = ''; };
  const mayLeave = async (): Promise<boolean> => { if (editor && !(await editor.guard())) return false; leaveEdit(); return true; };
  ctx.onLeave(() => { alive = false; leaveEdit(); menu?.destroy(); });

  const cfg = (name: string): LangServer | null => { const c = configs.get(name); return c && !('error' in c) ? c : null; };
  const isRunning = (name: string): boolean | undefined => running.get(name);
  const blocked = (): string | null => (canEdit === false ? NO_EDIT : null);

  // ── Risks: shared ports, servers reachable from other machines ──
  interface Risk { name: string; tone: 'warning'; title: string; text: string }
  const clashes = (r: LangServerRow): string[] => rows.filter((o) => o.Name !== r.Name && o.Port === r.Port && o.Type !== 'Remote' && r.Type !== 'Remote').map((o) => o.Name);
  const risksOf = (name: string): Risk[] => {
    const r = rows.find((x) => x.Name === name);
    const c = cfg(name);
    if (!r) return [];
    const out: Risk[] = [];
    const other = clashes(r);
    if (other.length) out.push({ name, tone: 'warning', title: `${name} shares port ${r.Port} with ${other.join(', ')}`, text: 'Only one of them can run at a time; whichever starts second fails. Give each server its own port.' });
    if (c && r.Type !== 'Remote' && !LOCAL.test(c.BindToIPAddress.trim())) {
      out.push({ name, tone: 'warning', title: `${name} accepts connections from other machines`,
        text: `It listens on ${c.BindToIPAddress.trim() ? c.BindToIPAddress : 'every network address'}, so its port can be reached from the network. Unless something elsewhere needs it, bind it to 127.0.0.1.` });
    }
    if (c && !c.Resource) out.push({ name, tone: 'warning', title: `${name} needs no permission to use`, text: 'No resource is required, so anyone who can run code in IRIS can start and use it.' });
    return out;
  };
  const renderBanner = (): void => {
    const all = rows.flatMap((r) => risksOf(r.Name));
    // One banner per page: the first risk, the rest counted.
    const top = all[0];
    if (!top) { ctx.banners.innerHTML = ''; return; }
    const rest = all.length - 1;
    ctx.banners.innerHTML = `<div class="sec-callout sec-callout--warning sec-banner" role="status">
      <ev-icon name="alert-triangle" size="sm"></ev-icon>
      <div><strong>${esc(top.title)}</strong><span>${esc(top.text)}${rest ? ` ${rest === 1 ? 'One more server needs' : `${rest} more servers need`} a look.` : ''}</span></div>
      <div class="sec-banner-actions"><button type="button" class="btn btn--sm" id="ls-show-risk">Show it</button></div>
    </div>`;
    ctx.banners.querySelector('#ls-show-risk')?.addEventListener('click', () => void select(top.name));
  };

  // ── Grid ──
  const COLUMNS: GridColumn[] = [
    { key: 'Name', label: 'Name', width: '200px', sortable: true, renderCell: (v) => cellId(v) },
    // State sits right after Name, always shown: the Running / Stopped chips filter on it.
    { key: 'State', label: 'State', width: '110px', sortable: true, description: 'Whether its process is running now. IRIS starts a stopped server when code first calls it',
      renderCell: (v) => (v === 'Running'
        ? '<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;color:var(--ev-color-text-primary)"><i style="width:6px;height:6px;border-radius:50%;background:var(--ev-color-success);flex:none"></i>Running</span>'
        : v === 'Stopped' ? cell.dim('Stopped') : cell.dim('—')) },
    { key: 'TypeLabel', label: 'Type', width: '120px', sortable: true },
    { key: 'Port', label: 'Port', width: '88px', sortable: true, align: 'right', renderCell: (v) => `<span style="display:block;padding-right:24px">${cell.num(String(v))}</span>` },
    { key: 'Last', label: 'Last activity', width: '220px', sortable: true, description: 'The most recent entry in its activity log. — means nothing since IRIS started',
      renderCell: (_v, row) => (row.LastText ? `${chip(String(row.LastText), row.LastTone as Tone)} <span style="color:var(--ev-color-text-secondary);font-size:var(--ev-font-size-xs)">${esc(row.LastWhen)}</span>` : cell.dim('—')) },
    { key: 'Runs', label: 'Used for', description: 'What IRIS uses this server for', renderCell: (v) => cell.text(v, String(v)) },
  ];
  const SECONDARY = ['Last', 'Runs'];
  const toRow = (r: LangServerRow): DataGridRow => {
    const a = activity.get(r.Name)?.[0];
    const ev = eventWords(a);
    const st = isRunning(r.Name);
    return {
      Name: r.Name, TypeLabel: langType(r.Type).label, Port: r.Port, State: st === undefined ? '' : st ? 'Running' : 'Stopped',
      Last: a ? irisDate(a.DateTime).getTime() : 0, LastText: ev?.text ?? '', LastTone: ev?.tone ?? 'neutral', LastWhen: a ? when(irisDate(a.DateTime)) : '',
      Runs: langType(r.Type).runs,
    };
  };
  const anyActivity = (): boolean => rows.some((r) => (activity.get(r.Name)?.length ?? 0) > 0);
  const applyColumns = (): void => {
    if (!grid) return;
    for (const k of SECONDARY) grid.setColumnVisible(k, !panel.open && (k !== 'Last' || anyActivity()));
  };
  const inScope = (r: LangServerRow, s: Scope): boolean => s === 'all' || (s === 'running' ? isRunning(r.Name) === true : isRunning(r.Name) !== true);
  const matches = (r: LangServerRow): boolean => {
    if (!inScope(r, scope)) return false;
    if (!query) return true;
    const ql = query.toLowerCase();
    return [r.Name, r.Type, langType(r.Type).label, String(r.Port)].some((x) => x.toLowerCase().includes(ql));
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
  };
  const closeDetail = (): void => { leaveEdit(); selected = null; shownHtml = ''; grid?.select([]); setPanel(false); };

  const renderToolbar = (): void => {
    const n = (s: Scope): number => rows.filter((r) => inScope(r, s)).length;
    scopeEl.options = [
      { value: 'all', label: `All ${n('all')}` },
      { value: 'running', label: `Running ${n('running')}`, disabled: n('running') === 0 && scope !== 'running' },
      { value: 'stopped', label: `Stopped ${n('stopped')}`, disabled: n('stopped') === 0 && scope !== 'stopped' },
    ];
  };

  const renderGrid = (): void => {
    if (!rows.length) {
      grid = null; rowSig = '';
      $('#ls-toolbar').hidden = true;
      wrap.innerHTML = emptyState({
        icon: 'cpu', title: 'No language servers',
        what: 'IRIS has no external language server definitions, so code can’t call Java, .NET or Python, and the SQL Gateway and IntegratedML can’t run.',
        why: 'IRIS installs a definition for each language; use New language server to add one back.',
        docs: { href: sysDocs.langServers, label: 'About language servers' },
      });
      return;
    }
    $('#ls-toolbar').hidden = false;
    setSearch($('#ls-search'), rows.length, { query, filtered: scope !== 'all' });
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('sort-column', 'Name');
      grid.setAttribute('sort-direction', 'asc');
      grid.setAttribute('aria-label', 'Language servers');
      grid.columns = COLUMNS;
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        void select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name));
      });
      wrap.appendChild(grid);
    }
    const list = rows.filter(matches).map(toRow);
    const sig = JSON.stringify(list);
    if (sig !== rowSig) { rowSig = sig; grid.rows = list; }
    applyColumns();
    if (selected) grid.select([selected]);
    wrap.querySelector('.sys-empty')?.remove();
    grid.hidden = !list.length;
    if (!list.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="sys-empty">${emptyState({
        icon: 'search', title: query ? `No language server matches “${query}”` : `No ${scope} language servers`,
        what: scope === 'running' && !query ? 'None is running right now. IRIS starts a server when code first calls it, or you can start one here.' : 'Try another name, type or port.',
        action: '<button type="button" class="btn btn--sm" data-ls-clear>Show all servers</button>',
      })}</div>`);
      wrap.querySelector('[data-ls-clear]')?.addEventListener('click', () => {
        query = ''; scope = 'all'; scopeEl.value = 'all';
        ($('#ls-search') as HTMLElement & { value: string }).value = '';
        renderGrid();
      });
    }
  };

  const renderFoot = (): void => {
    const up = rows.filter((r) => isRunning(r.Name)).length;
    const sep = '<span class="meta-sep">·</span>';
    $('#ls-foot').innerHTML = rows.length ? `<b>${num(rows.length)}</b> language server${rows.length === 1 ? '' : 's'}${sep}<b>${num(up)}</b> running` : '';
  };

  // ── Detail ──
  const select = async (name: string): Promise<void> => {
    if (!(await mayLeave())) { if (selected) grid?.select([selected]); return; }
    selected = name;
    shownHtml = '';
    if (!configs.has(name)) void fetchConfig(name);
    renderGrid();
    renderDetail();
  };
  const fetchConfig = async (name: string): Promise<void> => {
    try { configs.set(name, await getLangServer(name)); } catch (err) { configs.set(name, { error: errorText(err) }); }
    if (!alive) return;
    renderBanner();
    if (selected === name && !editor) renderDetail();
  };

  const renderDetail = (): void => {
    if (editor) return;
    const r = rows.find((x) => x.Name === selected);
    if (!r) { closeDetail(); return; }
    const c = configs.get(r.Name);
    const conf = cfg(r.Name);
    const st = isRunning(r.Name);
    const t = langType(r.Type);
    const remote = r.Type === 'Remote';
    const acts = activity.get(r.Name) ?? [];
    const working = busy === r.Name;
    const why = blocked() ?? (working ? 'Working…' : null);
    const editWhy = why ?? (st && !remote ? 'Stop it first: IRIS reads these settings when it starts the server.' : null);
    const primary = st
      ? `<button type="button" class="btn btn--sm" id="ls-stop"${blockedAttrs(why)}>${working ? '<ev-spinner size="sm"></ev-spinner>' : ''}Stop…</button>`
      : `<button type="button" class="btn btn--sm" id="ls-start"${blockedAttrs(why)}>${working ? '<ev-spinner size="sm"></ev-spinner>' : '<ev-icon name="play" size="xs"></ev-icon>'}Start</button>`;
    const note = canEdit === false ? `${NO_EDIT}` : st && !remote ? 'Stop it to change its settings: IRIS reads them when it starts the server.' : '';
    const custom = customFor(r.Type);
    const customVal = (k: string): string => {
      const v = conf?.Custom?.[k];
      if (k === 'DotNetVersion') return DOTNET_VERSIONS.find((d) => d.value === v)?.label ?? String(v ?? '');
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      return String(v ?? '');
    };
    const risks = risksOf(r.Name);
    const startErr = startErrors.get(r.Name);
    const html = `
      <header class="detail-head">
        <div class="detail-title"><span class="detail-kicker">${esc(t.label)} language server</span><h2 class="mono">${esc(r.Name)}</h2></div>
        <ev-icon-button icon="x" label="Close details" id="ls-close"></ev-icon-button>
      </header>
      <div class="detail-state">${st === undefined ? chip('—', 'neutral') : st ? chip('Running', 'success') : chip('Stopped', 'neutral')}<span class="dim">Port ${esc(r.Port)}</span></div>
      <div class="detail-actions">
        ${primary}
        <button type="button" class="btn btn--sm" id="ls-edit"${blockedAttrs(editWhy)}>Edit</button>
        ${moreButton('ls-more', `More actions for ${r.Name}`)}
      </div>
      ${note ? `<p class="detail-note">${esc(note)}</p>` : ''}
      ${startErr ? `<div class="sec-callout sec-callout--danger sys-callout" role="alert"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>It didn’t start</strong><span>${esc(startErr)}</span></div></div>` : ''}
      ${risks.map((k) => `<div class="sec-callout sec-callout--warning sys-callout"><ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>${esc(k.title.replace(`${r.Name} `, 'It '))}</strong><span>${esc(k.text)}</span></div></div>`).join('')}
      <p class="sys-text">Runs ${esc(t.runs.replace(/^(An?|Machine-learning)\b/, (w) => w.toLowerCase()))}.${st ? '' : ' IRIS starts it when code first calls it, so a stopped server is normal.'}</p>
      ${c && 'error' in c ? `<p class="sys-none">${esc(c.error)}</p>` : ''}
      <h3 class="detail-section">Connection</h3>
      <dl class="kv-list">
        ${remote ? kv('Remote address', conf ? mono(conf.Custom?.Address || '—') : dimText('—')) : ''}
        ${kv('Port', mono(r.Port))}
        ${remote ? '' : kv('Listens on', conf ? (conf.BindToIPAddress.trim() ? `${mono(conf.BindToIPAddress)}${LOCAL.test(conf.BindToIPAddress.trim()) ? ' <span class="dim">· this machine only</span>' : ''}` : 'Every network address') : dimText('—'))}
        ${conf ? kv('Shared memory', conf.UseSharedMemory ? 'Used when possible' : 'Not used') : ''}
        ${conf ? kv('Start timeout', `${esc(conf.InitializationTimeout)} s`) : ''}
        ${conf ? kv('Connect timeout', `${esc(conf.ConnectionTimeout)} s`) : ''}
      </dl>
      <h3 class="detail-section">Access</h3>
      <dl class="kv-list">
        ${kv('Required resource', conf ? (conf.Resource ? `Use on <button type="button" class="link mono" data-res="${esc(conf.Resource)}">${esc(conf.Resource)}</button>` : '<span class="sys-warn">Not required</span>') : dimText('—'))}
        ${conf ? kv('TLS', conf.SSLConfigurationServer || conf.SSLConfigurationClient
          ? `${conf.SSLConfigurationServer ? `server ${mono(conf.SSLConfigurationServer)}` : ''}${conf.SSLConfigurationServer && conf.SSLConfigurationClient ? ' · ' : ''}${conf.SSLConfigurationClient ? `client ${mono(conf.SSLConfigurationClient)}` : ''}`
          : 'Not used') : ''}
      </dl>
      ${custom.length && !remote ? `<h3 class="detail-section">Runtime</h3>
      <dl class="kv-list">
        ${custom.map((f) => kv(f.label, conf ? (customVal(f.key) ? mono(customVal(f.key)) : dimText(f.key === 'DotNetVersion' ? 'Not set' : 'Default')) : dimText('—'), customVal(f.key))).join('')}
        ${conf ? kv('Log file', conf.LogFile ? mono(conf.LogFile) : dimText('—'), conf.LogFile) : ''}
      </dl>` : ''}
      <h3 class="detail-section">Recent activity</h3>
      ${acts.length ? `<ul class="sys-log">${acts.slice(0, 8).map((a) => `<li data-tone="${recordTone(a.RecordType)}">
          <span class="sys-log-when">${esc(when(irisDate(a.DateTime), { seconds: true }))}</span>
          <span class="sys-log-text" title="${esc(cleanActivity(a.Text))}">${esc(cleanActivity(a.Text))}</span></li>`).join('')}</ul>`
        : '<p class="sys-none">Nothing since IRIS started.</p>'}
      <p class="sys-text"><a class="help-more" href="${esc(sysPortal.langActivity(r.Name))}" target="_blank" rel="noopener">Full activity log in the Management Portal ↗</a></p>`;
    setPanel(true);
    if (html === shownHtml) return;
    shownHtml = html;
    detail.innerHTML = html;
    detail.querySelector('#ls-close')?.addEventListener('click', closeDetail);
    detail.querySelector('#ls-start')?.addEventListener('click', () => void doStart(r));
    detail.querySelector('#ls-stop')?.addEventListener('click', () => void doStop(r));
    detail.querySelector('#ls-edit')?.addEventListener('click', () => void openEditor(r.Name));
    detail.querySelectorAll<HTMLElement>('[data-res]').forEach((b) => b.addEventListener('click', () => linkTo(ctx.navigate, 'security/resources', b.dataset.res ?? '')));
    menu?.destroy();
    const more = detail.querySelector<HTMLElement>('#ls-more');
    if (more) {
      const delWhy = blocked() ?? (isBuiltIn(r.Name) ? 'IRIS installs this server and looks for it by name, so it can’t be deleted here.' : st && !remote ? 'Stop it before deleting it.' : undefined);
      menu = moreMenu(more, [
        { label: 'Copy…', icon: 'copy', disabled: !!blocked(), reason: blocked() ?? undefined, onSelect: () => void openEditor(null, r.Name) },
        { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!delWhy, reason: delWhy, onSelect: () => void doDelete(r) },
      ]);
    }
  };

  // ── Actions ──
  const refreshOne = async (name: string): Promise<void> => {
    try {
      const a = await getLangActivity(name);
      running.set(name, a.CurrentlyRunning);
      activity.set(name, a.Activity);
    } catch { /* the next poll catches up */ }
  };
  const run = async (r: LangServerRow, work: () => Promise<unknown>, done: string, onError?: (msg: string) => void): Promise<void> => {
    busy = r.Name;
    renderDetail();
    try {
      await work();
      startErrors.delete(r.Name);
      toast(done);
    } catch (err) {
      const msg = errorText(err);
      if (err instanceof AdminError && err.status === 404) toast(`${r.Name} no longer exists.`, 'info');
      else if (onError) onError(msg);
      else toast(msg, 'danger');
    } finally {
      busy = null;
      await refreshOne(r.Name);
      if (!alive) return;
      paint();
    }
  };
  const doStart = (r: LangServerRow): Promise<void> => {
    startErrors.delete(r.Name);
    return run(r, () => startLangServer(r.Name), `${r.Name} started.`, (msg) => {
      const text = startProblem(msg, r.Type);
      startErrors.set(r.Name, text);
      toast(`${r.Name} didn’t start. ${text}`, 'danger');
    });
  };
  const doStop = async (r: LangServerRow): Promise<void> => {
    const ok = await confirm({
      title: `Stop ${r.Name}?`,
      body: `<p>IRIS stops its ${esc(langType(r.Type).label)} process. Calls in progress fail, and connections to it are closed.</p>
        <p>It isn’t switched off: IRIS starts it again the next time code calls it.</p>`,
      confirmLabel: 'Stop server',
    });
    if (ok) await run(r, () => stopLangServer(r.Name), `${r.Name} stopped.`);
  };
  const doDelete = async (r: LangServerRow): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${r.Name}?`,
      body: `<p>Its definition is removed. Code that asks for <b class="mono">${esc(r.Name)}</b> by name fails until you create it again. This can’t be undone.</p>`,
      confirmLabel: 'Delete server',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLangServer(r.Name);
      configs.delete(r.Name);
      startErrors.delete(r.Name);
      closeDetail();
      await load(true);
      toast(`Language server ${r.Name} deleted.`);
    } catch (err) { toast(errorText(err), 'danger'); }
  };

  // ── Create / edit ──
  const openEditor = async (name: string | null, copyOf?: string): Promise<void> => {
    if (!(await mayLeave())) return;
    const srcName = name ?? copyOf ?? null;
    let src: LangServer | null = srcName ? cfg(srcName) : null;
    if (srcName && !src) {
      try { src = await getLangServer(srcName); configs.set(srcName, src); } catch (err) { toast(errorText(err), 'danger'); return; }
    }
    if (!alive) return;
    const type0 = src?.Type ?? 'Java';
    const usedPorts = new Set(rows.filter((x) => x.Name !== name).map((x) => x.Port));
    const freePort = (): number => { let p = 53500; while (usedPorts.has(p)) p++; return p; };
    const customHtml = (type: string): string => {
      const fields = customFor(type);
      return fields.map((f) => {
        const v = src && src.Type === type ? src.Custom?.[f.key] : undefined;
        if (f.key === 'DotNetVersion') return selectField('c_DotNetVersion', f.label, DOTNET_VERSIONS, String(v ?? 'N8.0'));
        if (f.key === 'Exec32') return checkField('c_Exec32', f.label, v === true || v === 1 || v === '1');
        // Paths on the server get Browse… (the class path is a list, so it stays a text field).
        if (f.key === 'JavaHome') return pathField('c_JavaHome', f.label, String(v ?? ''), { hint: f.hint, mode: 'dir', title: 'Choose the Java home directory' });
        if (f.key === 'FilePath') return pathField('c_FilePath', f.label, String(v ?? ''), { hint: f.hint, mode: 'dir', title: 'Choose the gateway directory' });
        if (f.key === 'PythonPath') return pathField('c_PythonPath', f.label, String(v ?? ''), { hint: f.hint, mode: 'file', filters: [{ label: 'Programs', patterns: ['*.exe', 'python*'] }], title: 'Choose the Python executable' });
        return textField(`c_${f.key}`, f.label, String(v ?? ''), { hint: f.hint, mono: true, required: f.key === 'Address' });
      }).join('');
    };
    const groups = [...new Set(LANG_TYPES.map((x) => (customFor(x.value) === customFor('Java') ? 'java' : x.value)))];
    const groupOf = (type: string): string => (customFor(type) === customFor('Java') ? 'java' : type);
    const groupRep = (g: string): string => (g === 'java' ? 'Java' : g);
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    const creating = !name;
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : copyOf ? `Copy of <span class="mono">${esc(copyOf)}</span>` : 'New language server',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Create server',
      startDirty: !!copyOf,
      sections:
        section('Server',
          (creating ? textField('Name', 'Name', copyOf ? `${copyOf.replace(/^%/, '')} copy` : '', { required: true, mono: true, maxlength: 64, hint: 'Code asks for the server by this name.' }) : '') +
          `<div class="crud-row">${creating
            ? selectField('Type', 'Type', LANG_TYPES.map((x) => ({ value: x.value, label: x.label })), type0)
            : `<div class="sys-fixed"><span>Type</span><b>${esc(langType(type0).label)}</b></div>`}${
            textField('Port', 'Port', String(src && name ? src.Port : freePort()), { required: true, mono: true, width: '140px', hint: 'Unused by any other server.' })}</div>`) +
        section('Runtime', groups.map((g) => `<div data-kind="${esc(g)}"${groupOf(type0) === g ? '' : ' hidden'}>${customHtml(groupRep(g)) || '<p class="crud-section-hint">Nothing to set for this type.</p>'}</div>`).join(''),
          { hint: 'Where IRIS finds the program it runs. Empty fields use the default.' }) +
        section('Access',
          textField('Resource', 'Permission needed (resource)', src?.Resource ?? '%Gateway_Object', { mono: true, hint: 'People need Use on this resource to start or use the server. Leave empty to let anyone who can run code use it.' }) +
          textField('BindToIPAddress', 'Listen on address', src?.BindToIPAddress ?? '127.0.0.1', { mono: true, hint: '127.0.0.1 keeps it on this machine. Empty listens on every address.' }) +
          `<div class="crud-row">${textField('SSLConfigurationServer', 'TLS configuration (server)', src?.SSLConfigurationServer ?? '', { mono: true })}${textField('SSLConfigurationClient', 'TLS configuration (client)', src?.SSLConfigurationClient ?? '', { mono: true })}</div>` +
          checkField('VerifySSLHostName', 'Check the server’s host name against its certificate', src?.VerifySSLHostName ?? false)) +
        section('Advanced',
          `<div class="crud-row">${textField('InitializationTimeout', 'Start timeout (seconds)', String(src?.InitializationTimeout ?? 5), { mono: true })}${textField('ConnectionTimeout', 'Connect timeout (seconds)', String(src?.ConnectionTimeout ?? 5), { mono: true })}</div>` +
          checkField('UseSharedMemory', 'Use shared memory when both sides are on this machine', src?.UseSharedMemory ?? true) +
          pathField('LogFile', 'Log file', src?.LogFile ?? '', { mode: 'file', filters: [{ label: 'Log files', patterns: ['*.log', '*.txt'] }], title: 'Choose or name the log file', hint: 'Leave empty for no log. A new file name is fine. The log records every message, so use it only while diagnosing.' })),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        const type = creating ? String(v.Type ?? type0) : type0;
        if (creating) {
          const n = String(v.Name ?? '').trim();
          if (!n) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
          else if (/[,:]/.test(n)) out.push({ field: 'Name', label: 'Name', message: 'Leave out commas and colons' });
          else if (rows.some((x) => x.Name.toLowerCase() === n.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A language server with this name already exists' });
        }
        const port = Number(String(v.Port ?? '').trim());
        if (!String(v.Port ?? '').trim()) out.push({ field: 'Port', label: 'Port', message: 'Enter a port' });
        else if (!Number.isInteger(port) || port < 1 || port > 65535) out.push({ field: 'Port', label: 'Port', message: 'Enter a whole number from 1 to 65535' });
        else if (type !== 'Remote') {
          const other = rows.find((x) => x.Name !== name && x.Port === port && x.Type !== 'Remote');
          if (other) out.push({ field: 'Port', label: 'Port', message: `${other.Name} already uses port ${port}` });
        }
        if (type === 'Remote' && !String(v.c_Address ?? '').trim()) out.push({ field: 'c_Address', label: 'Remote server address', message: 'Enter the address of the machine it runs on' });
        for (const [k, label] of [['InitializationTimeout', 'Start timeout'], ['ConnectionTimeout', 'Connect timeout']] as const) {
          const n = Number(String(v[k] ?? '').trim());
          if (!Number.isInteger(n) || n < 1) out.push({ field: k, label, message: 'Enter a whole number of seconds, 1 or more' });
        }
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        const type = creating ? String(v.Type ?? type0) : type0;
        const custom: Record<string, string | boolean> = {};
        for (const f of customFor(type)) {
          const val = v[`c_${f.key}`];
          custom[f.key] = typeof val === 'boolean' ? val : String(val ?? '').trim();
        }
        try {
          await saveLangServer(target, {
            Type: type,
            Port: Number(String(v.Port).trim()),
            Resource: String(v.Resource ?? '').trim(),
            BindToIPAddress: String(v.BindToIPAddress ?? '').trim(),
            SSLConfigurationServer: String(v.SSLConfigurationServer ?? '').trim(),
            SSLConfigurationClient: String(v.SSLConfigurationClient ?? '').trim(),
            VerifySSLHostName: !!v.VerifySSLHostName,
            InitializationTimeout: Number(String(v.InitializationTimeout).trim()),
            ConnectionTimeout: Number(String(v.ConnectionTimeout).trim()),
            UseSharedMemory: !!v.UseSharedMemory,
            LogFile: String(v.LogFile ?? '').trim(),
            Custom: custom,
          });
        } catch (err) {
          if (err instanceof AdminError && /port/i.test(err.message)) fieldError(detail, 'Port', err.message);
          throw err;
        }
        leaveEdit();
        configs.delete(target);
        selected = target;
        await load(true);
        await fetchConfig(target);
        scrollPanelTop(detail);
        toast(name ? `Language server ${target} saved.` : `Language server ${target} created. IRIS starts it when code first calls it.`);
      },
      onCancel: () => { leaveEdit(); if (selected && rows.some((x) => x.Name === selected)) renderDetail(); else closeDetail(); },
    });
    if (creating) {
      formEvents = new AbortController();
      detail.addEventListener('ev-select-change', () => {
        const type = String(readForm(detail).Type ?? type0);
        detail.querySelectorAll<HTMLElement>('[data-kind]').forEach((el) => { el.hidden = el.dataset.kind !== groupOf(type); });
        editor?.refresh();
      }, { signal: formEvents.signal });
    }
  };

  // ── Loading ──
  const paint = (): void => {
    if (!loaded) return;
    renderBanner();
    renderToolbar();
    renderGrid();
    renderFoot();
    if (selected && !editor) renderDetail();
  };
  const updated = liveIndicator(ctx, () => void load(true));
  /** full: also re-read every server's settings (first load, refresh, after a save). */
  const load = async (full = false): Promise<void> => {
    try {
      const list = await getLangServers();
      await Promise.all(list.map((r) => refreshOne(r.Name)));
      if (full || !loaded) {
        await Promise.all(list.map(async (r) => {
          try { configs.set(r.Name, await getLangServer(r.Name)); } catch (err) { configs.set(r.Name, { error: errorText(err) }); }
        }));
      }
      if (!alive) return;
      rows = list;
      for (const k of [...running.keys()]) if (!list.some((r) => r.Name === k)) { running.delete(k); activity.delete(k); configs.delete(k); }
      loaded = true;
      if (selected && !rows.some((r) => r.Name === selected)) { selected = null; if (!editor) closeDetail(); }
      updated(new Date());
      paint();
    } catch (err) {
      if (!alive || loaded) return;
      grid = null;
      wrap.innerHTML = errorPanel(err, 'ls-retry');
      wrap.querySelector('#ls-retry')?.addEventListener('click', () => void load(true));
    }
  };

  const newBtn = newButton(ctx, 'New language server', () => void openEditor(null));
  void sessionInfo().then((info) => can(info, 'ExternalLanguageServerEdit'), () => null).then((ok) => {
    canEdit = ok;
    newBtn.setHidden(canEdit === false);
    if (alive && selected && !editor) { shownHtml = ''; renderDetail(); }
  });

  $('#ls-search').addEventListener('ev-search-input', (e) => {
    query = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderGrid();
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => {
    scope = (e as CustomEvent<{ value: Scope }>).detail.value;
    renderGrid();
  });

  void load(true);
  const timer = setInterval(() => { if (!busy) void load(); }, REFRESH_MS);
  ctx.onLeave(() => clearInterval(timer));
}
