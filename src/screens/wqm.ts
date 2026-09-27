// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings › Work queue categories — the named pools IRIS runs parallel work
 * in (parallel SQL, utilities, and code that uses the Work Queue Manager),
 * with the limits each one sets on its workers.
 *
 * Create, change and delete work here (%Admin_Manage); IRIS's own three
 * categories (Default, SQL, Utility) can be changed but not deleted.
 * Exercised live on an osca_test_ category, which was then deleted.
 */
import '../styles-settings.css';
import '../styles-db.css';
import {
  getWqmCategories, getWqmCategory, saveWqmCategory, deleteWqmCategory, SYSTEM_WQM, settingsDocs,
  type WqmRow, type WqmCategory,
} from '../api-settings';
import {
  esc, cell, cellId, num, skeleton, errorPanel, liveIndicator, emptyState, noPermissionText, pruneColumns, objectDetail, odMeta, odSection, odKv,
  type ScreenCtx, type GridColumn, type OdFull,
} from '../ui';
import {
  confirm, toast, errorText, newButton, editorShell, panelWidth, section, textField, selectField, checkField,
  readForm, fieldError, focusField, scrollPanelTop, AdminError, type FieldProblem, type EditorHandle, type MenuItem,
} from '../crud';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';
import { sessionInfo, can } from '../session-info';

type GridEl = HTMLElement & { columns: GridColumn[]; rows: DataGridRow[]; select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void };

const NO_MANAGE = noPermissionText('%Admin_Manage', 'system configuration');
const NAME_RULE = /^[A-Za-z0-9._]+$/;

/** "Dynamic (8)" → "Automatic (8)"; "2" → "2". */
const shown = (v: string): string => String(v ?? '').replace(/^Dynamic/i, 'Automatic');
const isAuto = (v: string): boolean => /^Dynamic/i.test(String(v ?? ''));
const isSystem = (name: string): boolean => SYSTEM_WQM.some((s) => s.toLowerCase() === name.toLowerCase());

/** What each limit means, in the words used everywhere on this page. */
const SETTINGS = {
  DefaultWorkers: { label: 'Workers', what: 'How many workers a job gets when its code doesn’t ask for a number.' },
  MaxWorkers: { label: 'Max workers', what: 'A job that asks for more workers than this gets this many.' },
  MaxActiveWorkers: { label: 'Kept workers', what: 'IRIS keeps about this many workers busy across the category, starting another when one is idle or blocked.' },
  MaxTotalWorkers: { label: 'Worker ceiling', what: 'Never more workers than this in the category, even when every one is blocked waiting on disk or a lock.' },
  AlwaysQueue: { label: 'Queue when busy', what: 'On: a new job waits its turn for a free worker. Off: every new job gets one worker straight away, and waits only for the rest.' },
} as const;

export function wqmScreen(ctx: ScreenCtx): void {
  ctx.fill();
  // Two levels (objectDetail): the list with a peek, and a full view of one category (#/settings/wqm/<name>).
  ctx.body.innerHTML = `
    <div class="od-list" id="wqm-list-view">
      <ev-detail-panel id="wqm-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="wqm-wrap">${skeleton(5)}</div>
        <aside slot="detail" class="detail" id="wqm-detail" aria-label="Work queue category"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="wqm-foot"></p>
    </div>
    <div id="wqm-full" hidden></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const panel = $<HTMLElement & { open: boolean }>('#wqm-panel');
  const wrap = $('#wqm-wrap');
  const detail = $('#wqm-detail');
  const listView = $('#wqm-list-view');
  const fullEl = $('#wqm-full');

  let rows: WqmRow[] = [];
  let loaded = false;
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let canManage: boolean | null = null;
  let alive = true;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; };
  const mayLeave = async (): Promise<boolean> => {
    if (editor && !(await editor.guard())) return false;
    leaveEdit();
    return true;
  };
  ctx.onLeave(() => { alive = false; leaveEdit(); });
  ctx.beforeLeave(async () => (editor ? editor.guard() : true));

  /** Workers IRIS makes available to a category ("Dynamic (8)" → 8); NaN until known. */
  const available = (): number => {
    for (const r of rows) {
      const m = /\((\d+)\)/.exec(r.MaxActiveWorkers) ?? /\((\d+)\)/.exec(r.MaxWorkers);
      if (m) return Number(m[1]);
    }
    return NaN;
  };
  const blocked = (): string => (canManage === false ? NO_MANAGE : '');

  // ── Grid ──
  /** "Automatic" alone in cells; what it means (up to N workers) is said in the column's tooltip. */
  const valueCell = (v: unknown): string => (isAuto(String(v)) ? cell.dim('Automatic') : cell.num(String(v)));
  const autoNote = (n: number): string => (Number.isFinite(n) ? ` Automatic: up to ${num(n)}, from the CPU cores IRIS may use.` : ' Automatic: IRIS sizes it from the CPU cores it may use.');
  const columns = (n: number): GridColumn[] => [
    { key: 'Name', label: 'Category', width: '170px', sortable: true, renderCell: (v) => cellId(v) },
    { key: 'Kind', label: 'Kind', width: '120px', sortable: true, renderCell: (v) => cell.text(v, v === 'Built in' ? 'One of IRIS’s own categories: it can be changed but not deleted' : 'Added on this instance') },
    { key: 'DefaultWorkers', label: SETTINGS.DefaultWorkers.label, width: '120px', description: SETTINGS.DefaultWorkers.what + autoNote(n), renderCell: valueCell },
    { key: 'MaxWorkers', label: SETTINGS.MaxWorkers.label, width: '120px', description: SETTINGS.MaxWorkers.what + autoNote(n), renderCell: valueCell },
    { key: 'MaxActiveWorkers', label: SETTINGS.MaxActiveWorkers.label, width: '120px', description: SETTINGS.MaxActiveWorkers.what + autoNote(n), renderCell: valueCell },
    { key: 'MaxTotalWorkers', label: SETTINGS.MaxTotalWorkers.label, width: '130px', description: SETTINGS.MaxTotalWorkers.what,
      renderCell: (v) => (Number(v) > 0 ? cell.num(num(Number(v))) : cell.dim('—')) },
    { key: 'AlwaysQueue', label: SETTINGS.AlwaysQueue.label, description: SETTINGS.AlwaysQueue.what, renderCell: (v) => (v ? cell.text('Yes') : cell.dim('No')) },
  ];
  /** The worker count the column tooltips were built with (they say what Automatic means here). */
  let columnsFor = '';
  const toRow = (r: WqmRow): DataGridRow => ({ ...r, Kind: isSystem(r.Name) ? 'Built in' : 'Custom' });

  const setPanel = (open: boolean): void => { if (panel.open !== open) panel.open = open; };
  const closeDetail = (): void => {
    selected = null;
    grid?.select([]);
    if (od.mode() === 'full') { void od.closeFull().then(() => od.select(null)); return; }
    void od.select(null);
    setPanel(false);
  };

  const renderGrid = (): void => {
    if (!grid) {
      wrap.innerHTML = '';
      grid = document.createElement('ev-data-grid') as GridEl;
      columnsFor = '';
      grid.setAttribute('compact', '');
      grid.setAttribute('row-select', '');
      grid.setAttribute('row-key', 'Name');
      grid.setAttribute('aria-label', 'Work queue categories');
      grid.addEventListener('ev-data-grid-row-click', (e) => {
        const name = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.Name);
        void select(name);
      });
      wrap.appendChild(grid);
    }
    const n = available();
    const data = rows.map(toRow);
    // A column that says the same on every row (Kind "Built in", Max workers "Automatic", no worker
    // ceiling) goes; the footer says it once.
    const pruned = pruneColumns(data as Array<Record<string, unknown>>, columns(n), { keep: ['Name'] });
    dropped = pruned.dropped;
    const sig = `${n}|${dropped.join(',')}`;
    if (columnsFor !== sig) { columnsFor = sig; grid.columns = pruned.columns; }
    grid.rows = data;
    if (selected) grid.select([selected]);
  };

  /** Columns pruneColumns() dropped because every row says the same: the footer states each once. */
  let dropped: string[] = [];
  const renderFoot = (): void => {
    const custom = rows.filter((r) => !isSystem(r.Name)).length;
    const sep = '<span class="meta-sep">·</span>';
    const builtIn = rows.length - custom;
    const same = (key: 'DefaultWorkers' | 'MaxWorkers' | 'MaxActiveWorkers'): string =>
      (dropped.includes(key) && rows[0] ? `${SETTINGS[key].label}: ${esc(isAuto(rows[0][key]) ? 'Automatic' : String(rows[0][key]))}` : '');
    $('#wqm-foot').innerHTML = rows.length ? [
      custom ? `<b>${num(builtIn)}</b> built in${sep}<b>${num(custom)}</b> custom` : `<b>${num(builtIn)}</b> built-in categor${builtIn === 1 ? 'y' : 'ies'}`,
      same('DefaultWorkers'), same('MaxWorkers'), same('MaxActiveWorkers'),
      dropped.includes('AlwaysQueue') && rows[0] ? (rows[0].AlwaysQueue ? 'All queue when busy' : 'None queue') : '',
      rows.some((r) => r.MaxTotalWorkers > 0) ? '' : 'No worker ceilings',
    ].filter(Boolean).slice(0, 4).join(sep) : '';
  };

  // ── Detail: peek and full view (objectDetail) ──
  const valueWords = (v: string): string => (isAuto(v) ? `${esc(shown(v))} <span class="dim">· set by IRIS</span>` : esc(v));
  const useOf = (r: WqmRow): string => (r.Name === 'SQL' ? 'Parallel SQL queries run here.' : r.Name === 'Utility' ? 'IRIS’s own utilities run their parallel work here.'
    : r.Name === 'Default' ? 'Work that doesn’t name a category runs here.' : 'Code that names this category runs its parallel work here.');
  const limitsKv = (r: WqmRow): string => odKv([
    [SETTINGS.DefaultWorkers.label,
      `${esc(figure(r.DefaultWorkers))} per job <span class="dim">· up to ${esc(figure(r.MaxWorkers))} if the job asks${isAuto(r.DefaultWorkers) || isAuto(r.MaxWorkers) ? ', set by IRIS' : ''}</span>`,
      `${SETTINGS.DefaultWorkers.what} ${SETTINGS.MaxWorkers.what}${autoNote(available())}`],
    [SETTINGS.MaxActiveWorkers.label, valueWords(r.MaxActiveWorkers), SETTINGS.MaxActiveWorkers.what],
    [SETTINGS.MaxTotalWorkers.label, r.MaxTotalWorkers > 0 ? esc(num(r.MaxTotalWorkers)) : '<span class="dim">No ceiling</span>', SETTINGS.MaxTotalWorkers.what],
    [SETTINGS.AlwaysQueue.label, r.AlwaysQueue ? 'Yes' : 'No', SETTINGS.AlwaysQueue.what],
  ]);
  const menuOf = (r: WqmRow): MenuItem[] => {
    const sys = isSystem(r.Name);
    return [
      { label: 'Delete…', icon: 'trash-2', danger: true, disabled: sys || canManage === false,
        reason: sys ? 'Built into IRIS, so it can’t be deleted. Change its limits instead.' : NO_MANAGE, onSelect: () => void remove(r.Name) },
    ];
  };
  /** On a list of 3 or fewer, the first category's peek opens on arrival (no address change), until the user closes it. */
  const AUTO_PEEK_KEY = 'osca-portal:wqm-auto-peek-off';
  let autoPeeked: string | null = null;
  const autoPeekOff = (): boolean => { try { return sessionStorage.getItem(AUTO_PEEK_KEY) === '1'; } catch { return false; } };
  const setAutoPeekOff = (): void => { autoPeeked = null; try { sessionStorage.setItem(AUTO_PEEK_KEY, '1'); } catch { /* storage blocked: lasts this visit */ } };
  /** The editor opens in the peek: from the full view, go back to the list first. */
  const inPeek = (fn: () => void) => (): void => {
    if (od.mode() === 'full') void od.closeFull().then(fn); else fn();
  };
  /** "Dynamic (8)" → "8" (Automatic is said once, in the first cell's caption); "2" → "2". */
  const figure = (v: string): string => { const m = /\((\d+)\)/.exec(String(v ?? '')); return m ? m[1] : String(v ?? '') || '—'; };
  /**
   * The full view: the four worker counts in the strip (what each means in its tooltip). How it queues
   * and its purpose go in the subtitle; a card would hold one row, so there is none.
   */
  const fullOf = (r: WqmRow): OdFull => {
    const n = available();
    const auto = [r.DefaultWorkers, r.MaxWorkers, r.MaxActiveWorkers].some(isAuto);
    return {
      strip: [
        { label: SETTINGS.DefaultWorkers.label, value: figure(r.DefaultWorkers), caption: auto ? 'Automatic limits set by IRIS' : '', title: SETTINGS.DefaultWorkers.what + autoNote(n) },
        { label: SETTINGS.MaxWorkers.label, value: figure(r.MaxWorkers), title: SETTINGS.MaxWorkers.what + autoNote(n) },
        { label: SETTINGS.MaxActiveWorkers.label, value: figure(r.MaxActiveWorkers), title: SETTINGS.MaxActiveWorkers.what + autoNote(n) },
        { label: SETTINGS.MaxTotalWorkers.label, value: r.MaxTotalWorkers > 0 ? num(r.MaxTotalWorkers) : 'None', title: SETTINGS.MaxTotalWorkers.what },
      ],
      main: [],
      side: [],
    };
  };

  /*
   * Peek only. Work queue categories are a three-row settings list: IRIS has no read of what a category
   * is doing now (only its limits), so a full view would be one strip over an empty page. The peek's ⤢
   * is hidden (styles-db.css) and F is swallowed below; objectDetail has no switch for it yet.
   */
  const noFullKey = (e: KeyboardEvent): void => {
    if (e.key.toLowerCase() !== 'f' || e.ctrlKey || e.metaKey || e.altKey || !panel.open) return;
    const path = e.composedPath() as Element[];
    if (path.some((el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|EV-SEARCH|EV-INPUT|EV-TEXTAREA|EV-SELECT|EV-COMBO-BOX)$/.test(el.tagName)))) return;
    e.preventDefault(); // objectDetail ignores keys already handled
  };
  document.addEventListener('keydown', noFullKey, true);
  // No full view, so objectDetail must not see the address's category (it would open one): the peek takes it.
  const linked = ctx.param ?? null;
  ctx.param = undefined;
  ctx.onLeave(() => document.removeEventListener('keydown', noFullKey, true));

  const od = objectDetail<WqmRow>(ctx, {
    collection: 'Work queue categories', noun: 'category',
    panel, detail, list: listView, full: fullEl,
    key: (r) => r.Name,
    find: (k) => rows.find((r) => r.Name === k),
    order: () => rows.map((r) => r.Name),
    name: (r) => r.Name,
    mono: true,
    meta: (r) => odMeta(isSystem(r.Name)
      ? { label: 'Built in', tone: 'neutral', title: 'One of IRIS’s own categories: its limits can be changed, but it can’t be deleted' }
      : { label: 'Custom', tone: 'neutral', title: 'Added on this instance' }),
    description: (r) => useOf(r),
    primary: (r) => ({ label: 'Edit', icon: 'edit-2', run: inPeek(() => void openEditor(r.Name)), blocked: blocked() || null }),
    menu: menuOf,
    peek: (r) => odSection('Limits', limitsKv(r)),
    loadFull: (r) => fullOf(r),
    onSelect: (k) => {
      // Closing the peek we opened on arrival: don't open it again this session.
      if (k === null && autoPeeked !== null && selected === autoPeeked) setAutoPeekOff();
      selected = k;
      grid?.select(k ? [k] : []);
    },
    canLeave: mayLeave,
  });

  /** Show the selected category (peek or full view); never over an open form. */
  const renderDetail = (): void => {
    if (editor) return;
    if (od.mode() === 'full') { od.refresh(); return; }
    if (selected === null) { if (od.selected() !== null) void od.select(null); return; }
    if (od.selected() !== selected || !panel.open) void od.select(selected); else od.refresh();
  };

  const select = async (name: string): Promise<void> => {
    await od.select(name);
    if (od.selected() !== name) grid?.select(selected ? [selected] : []);
  };

  // ── Editor ──
  const workerOptions = (n: number, current: number, autoLabel: string): Array<{ value: string; label: string }> => {
    const top = Number.isFinite(n) && n > 0 ? n : 8;
    const list = Array.from({ length: top }, (_, i) => i + 1);
    if (current > top) list.push(current);
    return [{ value: '0', label: autoLabel }, ...list.map((i) => ({ value: String(i), label: String(i) }))];
  };

  const openEditor = async (name: string | null): Promise<void> => {
    if (!(await mayLeave())) return;
    let cur: WqmCategory = { DefaultWorkers: 0, MaxWorkers: 0, MaxActiveWorkers: 0, MaxTotalWorkers: 0, AlwaysQueue: false };
    if (name) {
      try { cur = await getWqmCategory(name); } catch (err) {
        toast(err instanceof AdminError && err.status === 404 ? `${name} no longer exists.` : errorText(err), 'danger');
        if (err instanceof AdminError && err.status === 404) { closeDetail(); await load(); }
        return;
      }
      if (!alive) return;
    }
    const n = available();
    const autoAll = Number.isFinite(n) ? `Automatic (${num(n)})` : 'Automatic';
    const autoHalf = Number.isFinite(n) ? `Automatic (${num(Math.max(1, Math.floor(n / 2)))})` : 'Automatic';
    restoreWidth ??= panelWidth(panel, 520);
    setPanel(true);
    editor = editorShell(detail, {
      title: name ? `Edit <span class="mono">${esc(name)}</span>` : 'New category',
      name: name ?? undefined,
      submitLabel: name ? 'Save changes' : 'Create category',
      sections:
        (name ? '' : section('Name', textField('Name', 'Category name', '', { required: true, mono: true, maxlength: 45, hint: 'Letters, digits, periods and underscores; up to 45 characters. Code uses this name to ask for the category.' }))) +
        section('Workers for each job',
          `<div class="crud-row">${selectField('DefaultWorkers', SETTINGS.DefaultWorkers.label, workerOptions(n, cur.DefaultWorkers, autoHalf), String(cur.DefaultWorkers), { hint: SETTINGS.DefaultWorkers.what })}${
            selectField('MaxWorkers', SETTINGS.MaxWorkers.label, workerOptions(n, cur.MaxWorkers, autoAll), String(cur.MaxWorkers), { hint: SETTINGS.MaxWorkers.what })}</div>`,
          { hint: 'Automatic lets IRIS size it from the CPU cores it may use.' }) +
        section('Workers across the category',
          `${selectField('MaxActiveWorkers', SETTINGS.MaxActiveWorkers.label, workerOptions(n, cur.MaxActiveWorkers, autoAll), String(cur.MaxActiveWorkers), { hint: SETTINGS.MaxActiveWorkers.what })}
           ${textField('MaxTotalWorkers', SETTINGS.MaxTotalWorkers.label, String(cur.MaxTotalWorkers ?? 0), { width: 'sm', hint: `${SETTINGS.MaxTotalWorkers.what} 0 means no ceiling. Useful for disk-heavy work, where workers spend most of their time waiting.` })}
           ${checkField('AlwaysQueue', SETTINGS.AlwaysQueue.label, cur.AlwaysQueue, { toggle: true, hint: SETTINGS.AlwaysQueue.what })}`) +
        (name && isSystem(name) ? `<div class="crud-note crud-note--warning"><ev-icon name="alert-triangle" size="sm"></ev-icon><div>${esc(name)} is one of IRIS’s own categories${name === 'SQL' ? ', used by every parallel SQL query' : ''}. New jobs use the new limits straight away.</div></div>` : ''),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        if (!name) {
          const nm = String(v.Name ?? '').trim();
          if (!nm) out.push({ field: 'Name', label: 'Category name', message: 'Enter a name' });
          else if (!NAME_RULE.test(nm)) out.push({ field: 'Name', label: 'Category name', message: 'Use letters, digits, periods or underscores' });
          else if (rows.some((r) => r.Name.toLowerCase() === nm.toLowerCase())) out.push({ field: 'Name', label: 'Category name', message: 'A category with this name already exists' });
        }
        const total = String(v.MaxTotalWorkers ?? '').trim();
        if (!/^\d+$/.test(total)) out.push({ field: 'MaxTotalWorkers', label: SETTINGS.MaxTotalWorkers.label, message: 'Enter a whole number, or 0 for no ceiling' });
        return out;
      },
      onSubmit: async (v) => {
        const target = name ?? String(v.Name).trim();
        const body: WqmCategory = {
          DefaultWorkers: Number(v.DefaultWorkers), MaxWorkers: Number(v.MaxWorkers), MaxActiveWorkers: Number(v.MaxActiveWorkers),
          MaxTotalWorkers: Number(String(v.MaxTotalWorkers).trim()), AlwaysQueue: !!v.AlwaysQueue,
        };
        if (!name) {
          // A PUT on an existing name changes it: make sure it's still free.
          const fresh = await getWqmCategories().catch(() => rows);
          if (fresh.some((r) => r.Name.toLowerCase() === target.toLowerCase())) {
            fieldError(detail, 'Name', 'A category with this name already exists');
            focusField(detail, 'Name');
            throw new Error('A category with this name already exists.');
          }
        }
        await saveWqmCategory(target, body);
        leaveEdit();
        selected = target;
        await load();
        scrollPanelTop(detail);
        toast(name ? `Category ${target} saved. New jobs use the new limits.` : `Category ${target} created.`);
      },
      onCancel: () => { leaveEdit(); if (selected) renderDetail(); else setPanel(false); },
    });
  };

  const remove = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete category ${name}?`,
      body: `<p>Code that asks for <b class="mono">${esc(name)}</b> by name can no longer use it. Jobs already running finish as they are.</p><p>This can’t be undone, but you can create it again with the same name.</p>`,
      confirmLabel: 'Delete category',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteWqmCategory(name);
      closeDetail();
      await load();
      toast(`Category ${name} deleted.`);
    } catch (err) {
      toast(err instanceof AdminError && err.status === 404 ? `${name} no longer exists.` : errorText(err), 'danger');
      await load();
    }
  };

  // ── Header, loading ──
  const newBtn = newButton(ctx, 'New category', () => void openEditor(null));
  const updated = liveIndicator(ctx, () => void load(), { live: false });

  const load = async (): Promise<void> => {
    try {
      const list = await getWqmCategories();
      if (!alive) return;
      const order = (n: string): number => { const i = SYSTEM_WQM.indexOf(n); return i < 0 ? 99 : i; };
      rows = list.sort((a, b) => order(a.Name) - order(b.Name) || a.Name.localeCompare(b.Name));
      const first = !loaded;
      loaded = true;
      updated(new Date());
      if (!rows.length) {
        grid = null;
        closeDetail();
        wrap.innerHTML = emptyState({
          icon: 'cpu', title: 'No work queue categories',
          what: 'IRIS normally has three: Default, SQL and Utility. Each sets how many background workers parallel work may use.',
          docs: { href: settingsDocs.wqm, label: 'About work queue categories' },
        });
      } else {
        renderGrid();
      }
      renderFoot();
      if (first) {
        // Peek only: an address with a category (#/settings/wqm/SQL) opens its peek, and the address goes back to the list.
        if (linked && rows.some((r) => r.Name === linked)) { ctx.setParam?.(null); void od.select(linked); }
        else if (selected === null && rows.length > 0 && rows.length <= 3 && !autoPeekOff()) {
          autoPeeked = rows[0].Name;
          void od.select(rows[0].Name);
        }
      }
      else if (!editor && selected) renderDetail();
    } catch (err) {
      if (!alive) return;
      if (loaded) { toast(errorText(err), 'danger'); return; }
      grid = null;
      wrap.innerHTML = errorPanel(err, 'wqm-retry');
      wrap.querySelector('#wqm-retry')?.addEventListener('click', () => void load());
    }
  };

  sessionInfo().then((info) => {
    canManage = can(info, 'Manage');
    if (!alive) return;
    newBtn.setHidden(canManage === false);
    od.refreshHeader();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  void load();
}
