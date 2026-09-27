// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security › Audit log — whether IRIS is auditing, the records it has written
 * (searchable by time, event and user, with the full record in a side panel),
 * and every audit event with how often it happened, was recorded or was lost.
 *
 * Events view: each event's Enabled switch (turning off a security-relevant
 * one asks for its name to be typed), a peek with its counts, "Show its
 * records" as the visible action, its latest records, and Turn on/off, Clear counts and Delete (for
 * user-defined events; IRIS’s own can’t be deleted) under ⋯; Clear all counts in its toolbar; New user
 * event…. Exercised live only on OSCA_TEST/SelfTest/Probe.
 */
import '../styles-audit.css';
import '@evolution-ui/core/components/ev-select/ev-select.js';
import '../styles-web.css';
import {
  getAuditEnabled, getAuditEvents, getAuditRecord, searchAuditRecords, splitEventName, eventMeaning, typeMeaning,
  type AuditEvent, type AuditRecord, type AuditRecordDetail,
} from '../api-audit';
import { plural, esc, odMeta, odSection, odKv, num, when, relative, chip, status, cell, cellRef, setChips, exportButton, gridExport, skeleton, errorPanel, liveIndicator, viewTabs, bindViewTabs, setViewTabCount, peekWidth, type ScreenCtx, type Tone, type GridColumn } from '../ui';
import {
  confirm, toast, writeJson, errorText, newButton, moreButton, moreMenu, setBlocked, editorShell, panelWidth, section, textField, checkField, readForm, fieldError, focusField, AdminError,
  type EditorHandle, type FieldProblem, type MenuHandle, type MenuItem,
} from '../crud';
import { getInfo } from '../api';
import { getAuditEventSetting, saveAuditEvent, deleteAuditEvent, clearAuditEventCount, isSystemEvent, type AuditEventKey } from '../api-web';
import { mountSecurityBanner } from '../security-view';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

type View = 'records' | 'events';
type Range = '1h' | '24h' | '7d';
type Scope = 'all' | 'enabled' | 'unaudited';
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

const RANGES: Record<Range, { ms: number; label: string; phrase: string }> = {
  '1h': { ms: 3600e3, label: 'Last hour', phrase: 'in the last hour' },
  '24h': { ms: 86400e3, label: '24 hours', phrase: 'in the last 24 hours' },
  '7d': { ms: 7 * 86400e3, label: '7 days', phrase: 'in the last 7 days' },
};
const MAX_ROWS = 1000;
/**
 * The search takes server-local times, and the server's time zone isn't known
 * up front. Ask for 14 hours more than the range, then trim exactly on UTC.
 */
const TZ_SLACK_MS = 14 * 3600e3;

const NOWRAP = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;';
/**
 * Truncating text that asks the (auto-layout) grid for no width of its own: the column keeps its set width,
 * or takes what's left, and long text ends in "…" instead of pushing the grid into a sideways scroll.
 */
const FIT = `${NOWRAP}width:0;min-width:100%;`;
const fitText = (v: unknown, title = ''): string => `<span style="${FIT}"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`;
const pad = (n: number): string => String(n).padStart(2, '0');
const localStamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
/** "2026-09-25 23:00:00.966" (UTC) → Date. */
const utcDate = (s: string): Date => new Date(`${s.replace(' ', 'T')}Z`);
const recordKey = (r: { UTCTimeStamp: string; SystemID: string; AuditIndex: number | string }): string =>
  `${r.UTCTimeStamp}||${r.SystemID}||${r.AuditIndex}`;
/** The nightly Purge Audit Database task logs itself as AuditChange "Delete audit data". */
const isPurge = (r: { Event: string; Description: string }): boolean => r.Event === 'AuditChange' && r.Description === 'Delete audit data';
const userText = (u: string): string => (u === 'UnknownUser' ? 'Unauthenticated' : u);

/**
 * Event name in full text, its source/type after it in secondary text. `natural`: the cell asks for its
 * text's width (the Events table, where the name must never be cut); otherwise it truncates to the column.
 */
function eventCell(event: string, source: string, type: string, title: string, natural = false): string {
  return `<span style="${natural ? NOWRAP : FIT}"${title ? ` title="${esc(title)}"` : ''}><span style="font-weight:500">${esc(event)}</span>`
    // The event class is a code reference: cellRef's look (mono 12.5/400, secondary), inline after the name.
    + `<span style="margin-left:8px;font:400 12.5px/1 var(--ev-font-family-mono);color:var(--ev-color-text-secondary)">${esc(source)}/${esc(type)}</span></span>`;
}

/**
 * Fixed columns: the grid's table-layout is auto, so a width is only a hint the last (100%) column can squeeze.
 * Each cell's content box is set to the column's width less its 8px + 8px padding, as in the Messages log.
 */
const fixed = (px: number, html: string, right = false): string =>
  `<span style="display:block;width:${px - 16}px;overflow:hidden${right ? ';text-align:right' : ''}">${html}</span>`;
const RECORD_COLUMNS: DataGridColumn[] = [
  { key: 'When', label: 'Time', width: '150px', sortable: true, renderCell: (v) => { const d = new Date(Number(v)); return fixed(150, cell.num(when(d), `${when(d, { seconds: true })} · ${relative(d)}`)); } },
  { key: 'Event', label: 'Event', width: '280px', sortable: true,
    renderCell: (v, row) => fixed(280, eventCell(String(v), String(row.EventSource), String(row.EventType), eventMeaning(`${row.EventSource}/${row.EventType}/${v}`))) },
  { key: 'Username', label: 'User', width: '140px', sortable: true,
    renderCell: (v) => fixed(140, !v ? cell.dim('—') : v === 'UnknownUser' ? cell.dim('Unauthenticated') : cell.text(v)) },
  // Secondary references, not identifiers: regular weight, secondary text. A PID is a number, so sans tabular.
  { key: 'Namespace', label: 'Namespace', width: '110px', sortable: true, renderCell: (v) => fixed(110, v ? cellRef(v) : cell.dim('—')) },
  { key: 'Pid', label: 'PID', width: '80px', sortable: true, align: 'right', renderCell: (v) => fixed(80, cellRef(v), true) },
  // Last, taking what's left: a short description ("Delete audit data") no longer pushes Namespace and PID
  // hundreds of pixels away from the rest of the row; a long one truncates at the grid's edge.
  { key: 'Description', label: 'Description', width: '100%', sortable: true, renderCell: (v) => (v ? fitText(v, String(v)) : cell.dim('—')) },
];
/**
 * One column rule for both tabs: every column always shows (none comes and goes with the data), except
 * that while the side panel (peek or editor) is open, the two trailing columns step aside so the grid
 * never scrolls sideways. The panel shows both: a record's Namespace and PID, an event's Recorded and Lost.
 */
const SECONDARY: Record<View, string[]> = { records: ['Namespace', 'Pid'], events: ['Written'] };

/** Events whose absence from the log matters for security reviews. */
const SECURITY_CRITICAL = new Set([
  '%System/%Login/Login', '%System/%Login/LoginFailure', '%System/%Login/Logout', '%System/%Login/Terminate',
  '%System/%DirectMode/DirectMode', '%System/%Security/AccessDenied',
]);

/**
 * Turning one of these off stops IRIS recording who signs in, who is refused,
 * and who changes security: the whole %Login and %Security groups, direct mode
 * and Protect errors. Turning one off asks for its name to be typed.
 */
const securityRelevant = (name: string): boolean =>
  SECURITY_CRITICAL.has(name) || /^%System\/(%Login|%Security)\//.test(name) || /\/Protect$/.test(name);
const keyOf = (name: string): AuditEventKey => { const p = splitEventName(name); return { source: p.source, type: p.type, name: p.event }; };

/**
 * A small switch inside a grid cell (shadow DOM, so inline styles); the grid host catches its click.
 * `blocked` is why it can't be used right now (no privilege, or a change is being saved); '' when it can.
 */
/**
 * `paused`: on, but auditing is off for the instance, so nothing is recorded. The switch stays on (it's the
 * event's own setting) but is drawn muted, as the Records card's "On · paused" says.
 */
const PAUSED_TIP = 'On · paused while auditing is off';
const evSwitch = (on: boolean, name: string, blocked: string, paused = false): string => {
  const muted = on && paused;
  const title = [muted ? PAUSED_TIP : '', blocked].filter(Boolean).join('. ');
  const fill = !on ? 'var(--ev-border-2, var(--ev-color-border))'
    : muted ? 'color-mix(in srgb, var(--ev-color-primary) 38%, var(--ev-border-2, #555))' : 'var(--ev-color-primary)';
  return `<button type="button" role="switch" aria-checked="${on}" data-evt-toggle="${esc(name)}" aria-label="${on ? 'Turn off' : 'Turn on'} ${esc(name)}${muted ? ' (paused while auditing is off)' : ''}"${blocked ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}`
    + ` style="position:relative;display:block;flex:none;width:28px;height:16px;margin:0;padding:0;border:0;border-radius:8px;cursor:${blocked ? 'default' : 'pointer'};background:${fill};opacity:${blocked ? 0.5 : 1}">`
    + `<i aria-hidden="true" style="position:absolute;top:2px;left:${on ? 14 : 2}px;width:12px;height:12px;border-radius:50%;background:${muted ? 'var(--ev-color-text-secondary, #bbb)' : '#fff'}"></i></button>`;
};

function lostTone(e: { Lost: number; Total: number }): Tone {
  return e.Lost >= 100 || (e.Total > 0 && e.Lost / e.Total >= 0.01) ? 'danger' : 'warning';
}

/** Security-critical, turned off, and happening: the one state the Enabled column calls out. */
const exposedOff = (e: { EventName: string; Enabled: boolean; Total: number }): boolean =>
  !e.Enabled && e.Total > 0 && SECURITY_CRITICAL.has(e.EventName);

/**
 * A security-critical event that's off but happening: one warning, the dot-and-word the peek and the
 * Records card use ("Off · recommended on"), rather than an off switch plus a separate neutral tag.
 */
const RECOMMENDED = 'Off · recommended on';
const recommendedTip = (total: number): string =>
  `Security reviews rely on this event. It happened ${num(total)} times without being recorded, because it’s turned off.`;

/**
 * The Events table. The Event column takes its names' width (never cut); "What it records" takes what's
 * left and truncates. Recorded and Lost share one column, "Recorded / lost", shown only while auditing
 * is on: while it's off nothing is recorded, and the footer carries the totals.
 */
/** The Events table's meaning column without a peek: its longest text (about 350px), less on a narrow window. */
const MEANING_W = 'min(364px, max(160px, 100vw - 1180px))';
function eventColumns(blocked: string, recording: boolean, peekOpen = false): GridColumn[] {
  return [
    { key: 'Event', label: 'Event', width: '300px', sortable: true,
      renderCell: (v, row) => eventCell(String(v), String(row.Source), String(row.Type), String(row.EventName), true) },
    // Without a peek: wide enough for the longest meaning, not wider, so the state and counts sit right after
    // the text and the spare width is a blank last column. With a peek, the spare column goes and this one takes
    // what's left (truncating), so the peek's width comes out of the gap first.
    peekOpen
      ? { key: 'Meaning', label: 'What it records', width: '100%', sortable: true, renderCell: (v) => (v ? fitText(v, String(v)) : cell.dim('User-defined event')) }
      : { key: 'Meaning', label: 'What it records', width: '380px', sortable: true,
        renderCell: (v) => (v ? `<span style="${NOWRAP}width:${MEANING_W}" title="${esc(v)}">${esc(v)}</span>` : cell.dim('User-defined event')) },
    { key: 'Enabled', label: 'Enabled', width: '200px', sortable: true, renderCell: (v, row) => {
      const on = Boolean(v);
      // The switch says on/off; while auditing is off an on switch is drawn muted ("On · paused"). Beside an
      // off switch, one warning for the exception: a security-critical event that keeps happening unrecorded,
      // in the words the peek and the Records card use. A 16px line, not a pill, so every row keeps its height.
      const word = exposedOff({ EventName: String(row.EventName), Enabled: on, Total: Number(row.Total) })
        ? status(RECOMMENDED, 'warning', recommendedTip(Number(row.Total))) : '';
      return `<span style="display:flex;align-items:center;gap:8px;height:16px">${evSwitch(on, String(row.EventName), blocked, !recording)}${word}</span>`;
    } },
    // Counters, not totals: all three run since the counts were last cleared (headers, cells and footer say so),
    // so Recorded never reads as the number of records in the log.
    { key: 'Total', label: 'Happened', width: '100px', sortable: true, align: 'right',
      description: 'Times it happened since the counts were last cleared',
      renderCell: (v) => (Number(v) ? cell.num(num(Number(v)), 'Times it happened since the counts were last cleared') : cell.dim('—')) },
    ...(recording ? [{ key: 'Written', label: 'Recorded / lost', width: '150px', sortable: true, align: 'right' as const,
      description: 'Records written, and records IRIS couldn’t write, since the counts were last cleared (not the number of records in the log)',
      renderCell: (v: unknown, row: DataGridRow) => {
        const lost = Number(row.Lost);
        const rec = Number(v) ? cell.num(num(Number(v)), 'Records written since the counts were last cleared') : cell.dim('—');
        return lost > 0
          ? `<span style="display:inline-flex;align-items:center;gap:6px">${rec}${chip(`${num(lost)} lost`, lostTone({ Lost: lost, Total: Number(row.Total) }), 'Records IRIS should have written but couldn’t, since the counts were last cleared')}</span>`
          : rec;
      } }] : []),
    // The spare width, so it isn't a gap inside every row between the meaning and its switch.
    ...(peekOpen ? [] : [{ key: 'Spare', label: '', width: '100%', renderCell: () => '' }]),
  ];
}

export function auditScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    ${viewTabs('audit-view', [{ value: 'records', label: 'Records' }, { value: 'events', label: 'Events' }], 'records')}
    <p class="audit-status" id="audit-summary" aria-label="What’s being recorded" hidden></p>
    <div class="toolbar-row">
      <div class="toolbar-group" id="rec-tools">
        <div class="search-box"><ev-search id="rec-user" size="sm" full-width placeholder="Search users" aria-label="Search records by user"></ev-search></div>
        <ev-segmented-button id="rec-range" size="sm" aria-label="Time range"></ev-segmented-button>
        <div class="audit-event-pick" id="rec-event-slot"></div>
      </div>
      <div class="toolbar-group" id="evt-tools" hidden>
        <div class="search-box"><ev-search id="evt-search" size="sm" full-width placeholder="Filter by event name or meaning" aria-label="Filter events"></ev-search></div>
        <ev-segmented-button id="evt-scope" size="sm" aria-label="Which events"></ev-segmented-button>
        <button type="button" class="btn btn--sm btn--quiet" id="evt-clear-all" title="Happened, Recorded and Lost go back to 0 for every event. Records stay in the log."><ev-icon name="undo" size="xs"></ev-icon>Clear all counts…</button>
      </div>
      <div class="toolbar-spacer"></div>
      <span id="evt-lost"></span>
    </div>
    <ev-detail-panel id="audit-panel" detail-width="360" overlay-below="960" class="workspace">
      <div class="grid-wrap" id="audit-wrap">${skeleton(10)}</div>
      <aside slot="detail" class="detail" id="audit-detail" aria-label="Audit record details"></aside>
    </ev-detail-panel>
    <p class="table-foot" id="audit-foot"></p>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => (ctx.body.querySelector(sel) ?? ctx.banners.querySelector(sel)) as T;
  // Export: the Records view's rows as shown (visible columns, current sort).
  const exportBtn = exportButton(() => (view === 'records' ? gridExport(ctx.body.querySelector('#audit-wrap ev-data-grid'), 'audit-records') : null));
  (ctx.body.querySelector('.toolbar-row') as HTMLElement).append(exportBtn);
  const rangeEl = $<HTMLElement & { options: unknown; value: string }>('#rec-range');
  const scopeEl = $<HTMLElement & { options: unknown; value: string }>('#evt-scope');
  const panel = $<HTMLElement & { open: boolean; detailWidth: number }>('#audit-panel');
  const wrap = $('#audit-wrap');
  const detail = $('#audit-detail');
  const foot = $('#audit-foot');
  const summary = $('#audit-summary');

  let view: View = 'records';
  let range: Range = '24h';
  let eventFilter = '';
  let userQuery = '';
  let eventQuery = '';
  let scope: Scope = 'all';
  let auditOn: boolean | null = null;
  let events: AuditEvent[] = [];
  let eventsError: unknown = null;
  let eventsLoaded = false;
  let records: AuditRecord[] = [];
  let recordsError: unknown = null;
  let capped = false;
  let searching = false;
  let searchSeq = 0;
  let selected: string | null = null;
  let grid: GridEl | null = null;
  let gridView: View | null = null;

  rangeEl.value = range;
  rangeEl.options = (Object.keys(RANGES) as Range[]).map((r) => ({ value: r, label: RANGES[r].label }));
  scopeEl.value = scope;

  // Header: freshness and refresh, with the instance-wide auditing state beside it.
  // No polling: every search is itself an audited event.
  const updated = liveIndicator(ctx, () => void refresh(), { live: false });

  // ── Panel ───────────────────────────────────────────────
  const applyColumns = (): void => {
    if (!grid || !gridView) return;
    const g = grid;
    // The Events table trades its spare column for a stretching meaning while a peek is open.
    if (gridView === 'events') {
      const cols = eventColumns(switchBlocked(), auditOn !== false, panel.open);
      if (g.columns?.map((c) => `${c.key}:${c.width}`).join() !== cols.map((c) => `${c.key}:${c.width}`).join()) g.columns = cols;
    }
    for (const key of SECONDARY[gridView]) if (g.columns?.some((c) => c.key === key)) g.setColumnVisible(key, !panel.open);
  };
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    panel.open = open;
    applyColumns();
    renderSummary();
  };
  /** The event peek's ⋯ menu, rebuilt with the peek. */
  let evtMenu: MenuHandle | null = null;
  const dropEvtMenu = (): void => { evtMenu?.destroy(); evtMenu = null; };
  const closePanel = (): void => { selected = null; grid?.select([]); dropEvtMenu(); dropRecMenu(); setPanel(false); };

  // ── Grid plumbing ───────────────────────────────────────
  const clearEmpty = (): void => { wrap.querySelectorAll('.grid-empty, .empty, .audit-rows-note').forEach((n) => n.remove()); };
  const ensureGrid = (v: View): GridEl => {
    if (grid && gridView === v) return grid;
    wrap.innerHTML = '';
    const g = document.createElement('ev-data-grid') as GridEl;
    g.setAttribute('compact', '');
    g.setAttribute('row-select', '');
    if (v === 'records') {
      g.setAttribute('row-key', 'id');
      g.setAttribute('sort-column', 'When');
      g.setAttribute('sort-direction', 'desc');
      g.setAttribute('aria-label', 'Audit records');
      g.columns = RECORD_COLUMNS;
      g.addEventListener('ev-data-grid-row-click', (e) => {
        selected = String((e as CustomEvent<{ row: DataGridRow }>).detail.row.id);
        void showRecord();
      });
    } else {
      g.setAttribute('row-key', 'EventName');
      g.setAttribute('sort-column', 'Total');
      g.setAttribute('sort-direction', 'desc');
      g.setAttribute('aria-label', 'Audit events');
      g.columns = eventColumns(switchBlocked(), auditOn !== false, panel.open);
      // The Enabled switch lives in the grid's shadow DOM: catch its click on the host, before the row sees it.
      g.addEventListener('click', (e) => {
        const sw = (e.composedPath() as Element[]).find((el) => el instanceof HTMLElement && el.dataset?.evtToggle !== undefined) as HTMLElement | undefined;
        if (!sw) return;
        e.stopPropagation();
        e.preventDefault();
        if (!(sw as HTMLButtonElement).disabled) void toggleEvent(sw.dataset.evtToggle ?? '');
      }, { capture: true });
      // Selecting an event opens its peek: counts, Show its records, Clear count, Delete for user events.
      g.addEventListener('ev-data-grid-row-click', (e) => {
        void showEvent(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.EventName));
      });
    }
    // While a peek is open it follows the arrow keys, as in the Messages log and Alerts: the grid moves its
    // focused row, then the peek opens on it. (Focus moves inside the grid's shadow root don't reach the host,
    // so this reads the focused row after the grid has handled the key, and again for rows it windowed in.)
    const follow = (): void => {
      if (!panel.open || editor || grid !== g) return;
      const tr = (g.shadowRoot?.activeElement as HTMLElement | null)?.closest<HTMLElement>('tr[data-row-key]');
      const key = tr?.dataset.rowKey;
      if (!key || key === selected) return;
      if (v === 'records') {
        if (!records.some((r) => recordKey(r) === key)) return;
        selected = key;
        g.select([key]);
        void showRecord();
      } else if (events.some((e) => e.EventName === key)) {
        void showEvent(key);
      }
    };
    g.addEventListener('keydown', (e) => {
      if (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End)$/.test(e.key)) return;
      setTimeout(follow, 0);
      setTimeout(follow, 80);
    });
    wrap.appendChild(g);
    grid = g;
    gridView = v;
    return g;
  };
  /** Replace the grid with an explanation; `action` adds one button wired to `onAction`. */
  const showEmpty = (icon: string, title: string, lines: string[], action?: { label: string; run: () => void }): void => {
    grid = null;
    gridView = null;
    wrap.innerHTML = `<div class="empty">
      <div class="empty-main">
        <ev-icon name="${icon}" size="md"></ev-icon>
        <div class="empty-text"><strong>${title}</strong>${lines.map((l, i) => `<span${i === 0 ? ' class="lead"' : ''}>${l}</span>`).join('')}</div>
      </div>
      ${action ? `<button type="button" class="btn btn--sm" id="audit-empty-action">${esc(action.label)}</button>` : ''}
    </div>`;
    if (action) wrap.querySelector('#audit-empty-action')?.addEventListener('click', action.run);
  };

  // ── Records ─────────────────────────────────────────────
  const visibleRecords = (): AuditRecord[] => {
    const q = userQuery.toLowerCase();
    return q ? records.filter((r) => [r.Username, userText(r.Username), r.OSUsername].some((f) => f?.toLowerCase().includes(q))) : records;
  };

  const renderRecords = (): void => {
    if (view !== 'records') return;
    if (recordsError) {
      grid = null; gridView = null;
      wrap.innerHTML = errorPanel(recordsError, 'retry-audit');
      wrap.querySelector('#retry-audit')?.addEventListener('click', () => void loadRecords());
      foot.textContent = '';
      return;
    }
    const shown = visibleRecords();
    const phrase = RANGES[range].phrase;
    const eventName = eventFilter ? splitEventName(eventFilter).event : '';
    if (shown.length === 0 && !searching) {
      closePanel();
      if (records.length > 0 && userQuery) {
        showEmpty('search', `No records for users matching “${esc(userQuery)}”`, [`${plural(records.length, 'record')} ${phrase} belong to other users.`]);
      } else if (eventFilter || userQuery) {
        showEmpty('search', `No ${esc(eventName || 'matching')} records ${phrase}`, [
          eventFilter && eventMeaning(eventFilter) ? `This event records: ${esc(eventMeaning(eventFilter).toLowerCase())}.` : 'Nothing matches these filters.',
          ...(auditOn === false ? ['Auditing is turned off, so new events of this kind aren’t being recorded.']
            : events.find((e) => e.EventName === eventFilter)?.Enabled === false ? ['This event is turned off, so it isn’t recorded even though auditing is on.'] : []),
        ], { label: 'Clear filters', run: clearFilters });
      } else if (auditOn === false) {
        showEmpty('eye-off', `No audit records ${phrase}`, [
          'Auditing is turned off, so IRIS isn’t writing new records.',
          'Only records written while auditing was on, and the nightly audit purge’s own entry, appear here.',
        ], range !== '7d' ? { label: 'Show the last 7 days', run: () => setRange('7d') } : undefined);
      } else {
        showEmpty('info', `No audit records ${phrase}`, [
          'Auditing is on, but none of the enabled events happened in this period.',
          'The Events view shows which events are recorded and how often each has happened.',
        ], range !== '7d' ? { label: 'Show the last 7 days', run: () => setRange('7d') } : { label: 'View events', run: () => switchView('events') });
      }
    } else if (shown.length > 0) {
      const g = ensureGrid('records');
      clearEmpty();
      const rows = shown.map((r) => ({
        id: recordKey(r), When: utcDate(r.UTCTimeStamp).getTime(), Event: r.Event, EventSource: r.EventSource, EventType: r.EventType,
        Username: r.Username, Description: r.Description, Namespace: r.Namespace, Pid: r.Pid,
      }));
      g.rows = rows;
      applyColumns();
      if (selected) g.select([selected]);
    }
    wrap.setAttribute('aria-busy', String(searching));

    const parts = [searching ? 'Searching…' : `<b>${num(shown.length)}</b> ${shown.length === 1 ? 'record' : 'records'} ${phrase}${userQuery && shown.length !== records.length ? ` (of ${num(records.length)})` : ''}`];
    if (!searching && widenedFrom !== null && range === '7d') {
      // Why the range is 7 days: said as a second figure, the reason in its tooltip.
      parts.push(`<span title="The page opens on 24 hours; with fewer than ${WIDEN_BELOW} records there, it shows 7 days instead">${widenedFrom ? num(widenedFrom) : 'none'} in the last 24 hours</span>`);
    }
    // Footers are figures; the reasons behind them are tooltips.
    // The logs' footer grammar ("… · back to Today 09:12"): when the newest MAX_ROWS are all that's shown, say how far back they go.
    const oldestShown = capped && shown.length ? new Date(Math.min(...shown.map((r) => utcDate(r.UTCTimeStamp).getTime()))) : null;
    if (oldestShown) parts.push(`<span title="${esc(`The newest ${num(MAX_ROWS)} are shown. Narrow the range or filter by event to see older ones.`)}">back to ${esc(when(oldestShown).replace(/^(Today|Yesterday)\b/, (m) => m.toLowerCase()))}</span>`);
    else if (capped) parts.push(`<span title="Narrow the range or filter by event to see older ones">Newest <b>${num(MAX_ROWS)}</b> shown</span>`);
    if (auditOn === true) parts.push('<span title="Viewing the log is itself an audited event (AuditReport)">Your view is audited</span>');
    foot.innerHTML = parts.join('<span class="meta-sep">·</span>');
    renderSummary();
  };

  /**
   * On the Records tab, one status line above the toolbar: what IRIS is set to record, so a handful of rows
   * reads as the consequence of the settings. "Auditing is off · 36 of 75 events enabled · View events ›".
   * The banner carries the risk and the Events tab the frequencies, so this stays one short line.
   */
  function renderSummary(): void {
    const show = view === 'records' && eventsLoaded && !eventsError && events.length > 0;
    summary.hidden = !show;
    if (!show) { summary.innerHTML = ''; return; }
    const enabled = events.filter((e) => e.Enabled).length;
    const offHappening = events.filter((e) => !e.Enabled && e.Total > 0).length;
    const sep = '<span class="meta-sep">·</span>';
    const parts = [
      ...(auditOn === false ? ['<span class="audit-status-off">Auditing is off</span>'] : []),
      `<span title="${auditOn === false ? 'Enabled events are recorded once auditing is on' : 'Events IRIS writes a record for'}"><b>${num(enabled)}</b> of ${num(events.length)} events enabled</span>`,
      ...(auditOn !== false && offHappening
        ? [`<span title="Turned off, so they aren’t recorded; counted since the counts were cleared">${plural(offHappening, 'event')} happening, not audited</span>`] : []),
    ];
    summary.innerHTML = `${parts.join(sep)}${sep}<button type="button" class="link" id="audit-sum-events">View events ›</button>`;
    summary.querySelector('#audit-sum-events')?.addEventListener('click', () => switchView('events'));
  }

  /**
   * The first, default search (24 hours, no filters) widens itself to 7 days when it finds fewer than
   * WIDEN_BELOW records, so the page doesn't open on one row over empty space; the footer says so
   * ("Showing 7 days: only 1 record in 24 hours"). Any search after that is the user's range.
   */
  const WIDEN_BELOW = 5;
  let autoWiden = true;
  /** Records the default 24 hours held when the range widened itself; null once the user picks a search. */
  let widenedFrom: number | null = null;
  const loadRecords = async (widening = false): Promise<void> => {
    // `widening`: the default search widening itself (or a refresh of that), which keeps the footer's note.
    if (!widening) widenedFrom = null;
    const seq = ++searchSeq;
    searching = true;
    if (!grid || gridView !== 'records') wrap.innerHTML = skeleton(10);
    renderRecords();
    const now = Date.now();
    const from = now - RANGES[range].ms;
    const ev = eventFilter ? splitEventName(eventFilter) : null;
    try {
      const rows = await searchAuditRecords({
        beginDateTime: localStamp(new Date(from - TZ_SLACK_MS)),
        ...(ev ? { eventSources: ev.source, eventTypes: ev.type, events: ev.event } : {}),
        maxRows: MAX_ROWS,
      });
      if (seq !== searchSeq) return;
      records = rows.filter((r) => utcDate(r.UTCTimeStamp).getTime() >= from);
      capped = rows.length >= MAX_ROWS;
      recordsError = null;
      updated(new Date());
      const widen = autoWiden && range === '24h' && !eventFilter && !capped && records.length < WIDEN_BELOW;
      autoWiden = false;
      if (widen) {
        widenedFrom = records.length;
        range = '7d';
        rangeEl.value = range;
        void loadRecords(true);
        return;
      }
    } catch (err) {
      if (seq !== searchSeq) return;
      recordsError = err;
    }
    searching = false;
    if (selected && !records.some((r) => recordKey(r) === selected)) closePanel();
    renderRecords();
    if (selected) void showRecord();
  };

  const setRange = (r: Range): void => { range = r; rangeEl.value = r; void loadRecords(); };
  const clearFilters = (): void => {
    eventFilter = '';
    userQuery = '';
    const pick = ctx.body.querySelector('#rec-event') as (HTMLElement & { value: string }) | null;
    if (pick) pick.value = '';
    const user = ctx.body.querySelector('#rec-user') as (HTMLElement & { value: string }) | null;
    if (user) user.value = '';
    void loadRecords();
  };

  // ── Record detail ───────────────────────────────────────
  const orDash = (v: unknown, mono = false): string => (v === '' || v === null || v === undefined ? '<span class="dim">—</span>' : mono ? `<span class="mono">${esc(v)}</span>` : esc(v));
  const roles = (s: string): string => {
    const list = s.split(',').map((x) => x.trim()).filter(Boolean);
    if (!list.length) return '<span class="dim">—</span>';
    return `<span class="audit-roles">${list.map((r) => chip(r, r === '%All' ? 'warning' : 'neutral', r === '%All' ? '%All grants every privilege on the instance' : '')).join('')}</span>`;
  };

  let detailSeq = 0;
  /** The record peek's ⋯ menu, rebuilt with the peek. */
  let recMenu: MenuHandle | null = null;
  const dropRecMenu = (): void => { recMenu?.destroy(); recMenu = null; };
  /**
   * The record's peek, in the same anatomy as the event peek (objectDetail()'s): a sticky two-row head (title,
   * ⋯, close; then "● kind · when · record n"), and a body that scrolls under it. A record is read-only, so
   * there's no visible action; narrowing the list to its event or user, opening its event and copying it are under ⋯.
   */
  const renderDetail = (r: AuditRecord, full: AuditRecordDetail | null, fullError: unknown): void => {
    const d = utcDate(r.UTCTimeStamp);
    const name = `${r.EventSource}/${r.EventType}/${r.Event}`;
    const meaning = eventMeaning(name);
    const src = full ?? r;
    const eventData = (src.EventData ?? '').replace(/\r\n/g, '\n').trimEnd();
    dropEvtMenu();
    dropRecMenu();
    detail.classList.add('od-detail');
    detail.innerHTML = `
      <div class="od-shell">
        <header class="od-head">
          <h2 class="od-title" title="${esc(meaning ? `${r.Event}: ${meaning}` : r.Event)}">${esc(r.Event)}</h2>
          <div class="od-head-actions">
            ${moreButton('rec-more', `More actions for this ${r.Event} record`)}
            <span class="od-vsep" aria-hidden="true"></span>
            <ev-icon-button icon="x" label="Close" title="Close" id="audit-close"></ev-icon-button>
          </div>
          <div class="od-meta">${odMeta({ label: typeMeaning(r.EventType), tone: 'neutral', title: `${r.EventSource}/${r.EventType}` }, [relative(d), `Record ${r.AuditIndex}`])}</div>
        </header>
      </div>
      <div class="od-body">
        ${src.Description ? `<p class="audit-desc">${esc(src.Description)}</p>` : ''}
        ${isPurge(r) ? `<p class="detail-note">Written each night by the <b>Purge Audit Database</b> task, which deletes audit records older than the retention period. <button type="button" class="link" id="audit-task-link">Scheduled tasks</button></p>` : ''}
        ${fullError ? `<p class="detail-note">Couldn’t load the full record (${esc(fullError instanceof Error ? fullError.message : String(fullError))}); showing the search result.</p>` : ''}
        ${odSection('When', odKv([
          ['Your time', esc(when(d, { seconds: true }))],
          ['UTC', `<span class="mono">${esc(r.UTCTimeStamp)}</span>`],
          ['Server time', `<span class="mono">${esc(r.TimeStamp)}</span>`],
        ]))}
        ${odSection('Who', odKv([
          ['User', src.Username ? esc(userText(src.Username)) : orDash('')],
          ['OS user', orDash(src.OSUsername)],
          ['Roles held', roles(src.Roles)],
          ['Signed in with', orDash(src.Authentication)],
          ['Client IP', orDash(src.ClientIPAddress, true)],
          ['First client IP', orDash(src.StartupClientIPAddress, true)],
          ['Client application', orDash(src.ClientExecutableName)],
          ...(src.UserInfo ? [['User info', esc(src.UserInfo)] as [string, string]] : []),
        ]))}
        ${odSection('Where', odKv([
          ['Namespace', orDash(src.Namespace, true)],
          ['Routine', orDash(src.RoutineSpec, true)],
          ['Process ID', orDash(src.Pid, true)],
          ['Job number', orDash(src.JobNumber, true)],
          ['System', orDash(src.SystemID, true)],
          ...(src.Status ? [['Status', esc(src.Status)] as [string, string]] : []),
        ]))}
        <section class="od-section">
          <div class="audit-section-head">
            <h3 class="od-section-head">Event data</h3>
            ${eventData ? '<button type="button" class="btn btn--sm btn--quiet" id="audit-copy"><ev-icon name="copy" size="xs"></ev-icon>Copy</button>' : ''}
          </div>
          ${eventData
            ? `<pre class="audit-data" tabindex="0" aria-label="Event data">${esc(eventData)}</pre>`
            : '<p class="detail-note">This event has no additional data.</p>'}
        </section>
      </div>`;
    detail.querySelectorAll<HTMLElement>('.od-kv-row dd').forEach((dd) => { if (!dd.title) dd.title = dd.textContent?.trim() ?? ''; });
    detail.querySelector('#audit-close')?.addEventListener('click', closePanel);
    detail.querySelector('#audit-task-link')?.addEventListener('click', () => ctx.navigate('tasks/upcoming'));
    const copy = detail.querySelector<HTMLButtonElement>('#audit-copy');
    copy?.addEventListener('click', () => {
      void navigator.clipboard.writeText(eventData).then(() => {
        copy.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
        setTimeout(() => { copy.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy'; }, 1600);
      });
    });
    const known = events.some((e) => e.EventName === name);
    const user = src.Username ? userText(src.Username) : '';
    const recordText = (): string => [
      `${name} — record ${r.AuditIndex}`, `UTC: ${r.UTCTimeStamp}`, `User: ${user || '—'}`,
      src.Description ? `Description: ${src.Description}` : '', src.Namespace ? `Namespace: ${src.Namespace}` : '',
      src.Pid ? `Process ID: ${src.Pid}` : '', eventData ? `Event data:\n${eventData}` : '',
    ].filter(Boolean).join('\n');
    recMenu = moreMenu(detail.querySelector('#rec-more') as HTMLElement, [
      { label: `Only ${r.Event} records`, icon: 'search', disabled: eventFilter === name,
        reason: eventFilter === name ? 'The list is already narrowed to this event' : '', onSelect: () => filterRecords({ event: name }) },
      { label: user ? `Only records for ${user}` : 'Only records for this user', icon: 'user', disabled: !user,
        reason: user ? '' : 'This record has no user', onSelect: () => filterRecords({ user }) },
      { label: 'Open its event', icon: 'zap', disabled: !known, reason: known ? '' : 'This event isn’t in the event list',
        onSelect: () => { switchView('events'); void showEvent(name); } },
      { label: 'Copy record', icon: 'copy', onSelect: () => { void navigator.clipboard.writeText(recordText()).then(() => toast('Record copied.')); } },
    ]);
  };
  /** Narrow the Records list from a record's ⋯: to its event (a new search) or to its user (a filter). */
  const filterRecords = (f: { event?: string; user?: string }): void => {
    if (f.user !== undefined) {
      userQuery = f.user;
      const box = ctx.body.querySelector('#rec-user') as (HTMLElement & { value: string }) | null;
      if (box) box.value = f.user;
      renderRecords();
    }
    if (f.event !== undefined) {
      eventFilter = f.event;
      const pick = ctx.body.querySelector('#rec-event') as (HTMLElement & { value: string }) | null;
      if (pick) pick.value = f.event;
      void loadRecords();
    }
  };

  /** Show the selected record from the search at once, then swap in the full record. */
  const showRecord = async (): Promise<void> => {
    const r = records.find((x) => recordKey(x) === selected);
    if (!r) { closePanel(); return; }
    const seq = ++detailSeq;
    renderDetail(r, null, null);
    setPanel(true);
    try {
      const full = await getAuditRecord(r);
      if (seq === detailSeq && selected === recordKey(r)) renderDetail(r, full, null);
    } catch (err) {
      if (seq === detailSeq && selected === recordKey(r)) renderDetail(r, null, err);
    }
  };

  // ── Events ──────────────────────────────────────────────
  /** An event's state in words, one set for the Records card, the event peek and the Events table's switch. */
  const eventState = (e: AuditEvent): { label: string; tone: Tone; title?: string } => (e.Enabled
    ? auditOn === false
      ? { label: 'On · paused', tone: 'warning', title: 'Auditing is off for the whole instance, so nothing is recorded until it’s turned on' }
      : { label: 'On', tone: 'success' }
    : exposedOff(e)
      ? { label: RECOMMENDED, tone: 'warning', title: recommendedTip(e.Total) }
      : { label: 'Off', tone: 'neutral' });
  /** Not audited: it happens, but nothing is written, because the event is off or auditing is off. */
  const unaudited = (e: AuditEvent): boolean => e.Total > 0 && (!e.Enabled || auditOn === false);
  const inScope = (e: AuditEvent, s: Scope): boolean => s === 'all' || (s === 'enabled' ? e.Enabled : unaudited(e));
  const visibleEvents = (): AuditEvent[] => {
    const q = eventQuery.toLowerCase();
    return events.filter((e) => inScope(e, scope) && (!q || e.EventName.toLowerCase().includes(q) || eventMeaning(e.EventName).toLowerCase().includes(q)));
  };

  const renderEvents = (): void => {
    if (view !== 'events') return;
    const n = (s: Scope): number => events.filter((e) => inScope(e, s)).length;
    setChips(scopeEl, events.length, (['all', 'enabled', 'unaudited'] as Scope[]).map((s) => ({
      value: s,
      label: `${{ all: 'All', enabled: 'Enabled', unaudited: 'Happening, not audited' }[s]} ${num(n(s))}`,
      disabled: s !== 'all' && s !== scope && n(s) === 0,
    })), { active: scope, risk: ['unaudited'], search: $('#evt-search'), query: eventQuery });
    setViewTabCount(ctx.body, 'audit-view', 'events', events.length);
    const losing = events.filter((e) => e.Lost > 0);
    $('#evt-lost').innerHTML = losing.length
      ? chip(`${losing.length} losing records`, losing.some((e) => lostTone(e) === 'danger') ? 'danger' : 'warning', 'Events whose records IRIS couldn’t write, usually because the audit database is full or unavailable')
      : '';

    if (eventsError) {
      grid = null; gridView = null;
      wrap.innerHTML = errorPanel(eventsError, 'retry-events');
      wrap.querySelector('#retry-events')?.addEventListener('click', () => void loadEvents());
      foot.textContent = '';
      return;
    }
    if (!eventsLoaded) { grid = null; gridView = null; wrap.innerHTML = skeleton(10); foot.textContent = ''; return; }
    const shown = visibleEvents();
    const g = ensureGrid('events');
    g.columns = eventColumns(switchBlocked(), auditOn !== false, panel.open);
    applyColumns();
    g.rows = shown.map((e) => {
      const p = splitEventName(e.EventName);
      return { EventName: e.EventName, Event: p.event, Source: p.source, Type: p.type, Meaning: eventMeaning(e.EventName), Enabled: e.Enabled, Total: e.Total, Written: e.Written, Lost: e.Lost };
    });
    clearEmpty();
    if (shown.length === 0 && events.length > 0) {
      wrap.insertAdjacentHTML('beforeend', `<div class="grid-empty">${eventQuery ? `No events match “${esc(eventQuery)}”.` : scope === 'enabled' ? 'No events are enabled.' : 'Every event that has happened is being audited.'}</div>`);
    }

    const sum = (k: 'Total' | 'Written' | 'Lost'): number => events.reduce((a, e) => a + e[k], 0);
    const happened = sum('Total');
    const written = sum('Written');
    const parts = [
      `<b>${n('enabled')}</b> of ${events.length} events enabled`,
      // Counters, not the log: IRIS doesn't keep when they were cleared, so the qualifier is said in words, once,
      // after the figures. The Records tab counts the log itself ("6 records in the last 7 days").
      `<span title="Happened, Recorded and Lost are counters that run from the last Clear counts, not the number of records in the log"><b>${num(happened)}</b> happened, <b>${num(written)}</b> recorded, <b>${num(sum('Lost'))}</b> lost since the counts were cleared</span>`,
    ];
    foot.innerHTML = parts.join('<span class="meta-sep">·</span>');
  };

  // ── Event settings: switch, peek, clear, new, delete ──
  let canSecure: boolean | null = null;
  let editor: EditorHandle | null = null;
  let restoreWidth: (() => void) | null = null;
  const leaveEdit = (): void => { editor?.close(); editor = null; restoreWidth?.(); restoreWidth = null; ctx.beforeLeave(null); };
  let busy = false;
  const NO_SECURE = 'You need the security administrator privilege (%Admin_Secure) to change audit events';
  /** Why the Enabled switches can't be used right now: no privilege, or a change is still being saved. */
  const switchBlocked = (): string => (canSecure === false ? NO_SECURE : busy ? 'Saving a change…' : '');
  /** One change at a time; the switches stay disabled until it's done, so a double click can't toggle twice. */
  const act = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    renderEvents();
    try { await fn(); } catch (err) {
      toast(err instanceof AdminError && err.status === 409 ? 'IRIS’s own events can’t be deleted. Turn it off instead.' : errorText(err), 'danger');
      await loadEvents();
    } finally {
      busy = false;
      renderEvents();
    }
  };

  const toggleEvent = async (name: string): Promise<void> => {
    const e = events.find((x) => x.EventName === name);
    if (!e || editor) return;
    await act(async () => {
      if (e.Enabled) {
        const p = splitEventName(name);
        const meaning = eventMeaning(name);
        if (securityRelevant(name)) {
          const ok = await confirm({
            title: `Stop recording ${p.event}?`,
            body: `<p>IRIS stops writing a record each time ${meaning ? esc(meaning.charAt(0).toLowerCase() + meaning.slice(1)) : `<span class="mono">${esc(name)}</span> happens`}. Nothing about it will be in the audit log until it’s turned on again, so a review can’t see ${/Login/.test(name) ? 'who signed in or was refused' : 'who did it or when'}.</p>
              <p>${e.Total ? `It has happened ${num(e.Total)} times since the counts were last cleared.` : 'It hasn’t happened since the counts were last cleared.'}</p><p>Type the event’s name to confirm.</p>`,
            confirmLabel: 'Stop recording',
            danger: true,
            typeToConfirm: p.event,
          });
          if (!ok) return;
        }
      }
      await saveAuditEvent(keyOf(name), { Enabled: !e.Enabled });
      toast(e.Enabled ? `${splitEventName(name).event} is no longer recorded.` : `${splitEventName(name).event} is recorded again.`);
      await loadEvents();
      if (selected === name) void showEvent(name);
    });
  };
  const clearOne = async (name: string): Promise<void> => {
    await act(async () => {
      const ok = await confirm({ title: `Clear the counts for ${splitEventName(name).event}?`, body: '<p>Happened, Recorded and Lost go back to 0 for this event. Records already written stay in the audit log.</p>', confirmLabel: 'Clear counts' });
      if (!ok) return;
      await clearAuditEventCount(keyOf(name));
      toast('Counts cleared.');
      await loadEvents();
      if (selected === name) void showEvent(name);
    });
  };
  const clearAll = async (): Promise<void> => {
    await act(async () => {
      const ok = await confirm({
        title: `Clear the counts for all ${num(events.length)} events?`,
        body: '<p>Happened, Recorded and Lost go back to 0 for every event, so “Happening, not audited” starts again from now. Records already written stay in the audit log.</p>',
        // Not red: like the peek's Clear counts, it resets counters; no audit record is touched.
        confirmLabel: 'Clear all counts',
      });
      if (!ok) return;
      for (const e of events) await clearAuditEventCount(keyOf(e.EventName));
      toast('All counts cleared.');
      await loadEvents();
    });
  };
  const removeEvent = async (name: string): Promise<void> => {
    await act(async () => {
      const p = splitEventName(name);
      const ok = await confirm({
        title: `Delete the event ${p.event}?`,
        body: `<p>The user-defined event <span class="mono">${esc(name)}</span> is removed. Code that still raises it gets an error, and nothing more is recorded for it. Records already written stay in the audit log.</p>`,
        confirmLabel: 'Delete event', danger: true,
      });
      if (!ok) return;
      await deleteAuditEvent(keyOf(name));
      closePanel();
      toast(`${p.event} deleted.`);
      await loadEvents();
    });
  };

  /**
   * An event's latest records, for its peek: one small search per event, kept until the page is refreshed
   * (each search is itself an audited event, so reopening a peek doesn't search again).
   */
  const RECENT_N = 5;
  const RECENT_RANGE: Range = '7d';
  const recentCache = new Map<string, Promise<AuditRecord[]>>();
  const recentRecords = (name: string): Promise<AuditRecord[]> => {
    let p = recentCache.get(name);
    if (!p) {
      const ev = splitEventName(name);
      const from = Date.now() - RANGES[RECENT_RANGE].ms;
      p = searchAuditRecords({
        beginDateTime: localStamp(new Date(from - TZ_SLACK_MS)), eventSources: ev.source, eventTypes: ev.type, events: ev.event, maxRows: 50,
      }).then((rows) => rows
        .filter((r) => utcDate(r.UTCTimeStamp).getTime() >= from)
        .sort((x, y) => utcDate(y.UTCTimeStamp).getTime() - utcDate(x.UTCTimeStamp).getTime())
        .slice(0, RECENT_N));
      p.catch(() => recentCache.delete(name));
      recentCache.set(name, p);
    }
    return p;
  };
  /** Open one record in the Records view, with the list narrowed to its event over a range that includes it. */
  const openRecord = (name: string, r: AuditRecord): void => {
    switchView('records');
    eventFilter = name;
    const pick = ctx.body.querySelector('#rec-event') as (HTMLElement & { value: string }) | null;
    if (pick) pick.value = name;
    const age = Date.now() - utcDate(r.UTCTimeStamp).getTime();
    if (age > RANGES[range].ms) { range = age > RANGES['24h'].ms ? '7d' : '24h'; rangeEl.value = range; }
    selected = recordKey(r);
    void loadRecords();
  };

  /**
   * The event's peek, in objectDetail()'s anatomy (the panel is shared with the
   * record peek and the editor, so it's drawn here rather than by objectDetail):
   * title, then "● On/Off · kind" ("On · paused" while auditing is off for the
   * instance, since then nothing is recorded); the Source/Type/Name identity as
   * one mono line; the counts with "—" for 0, as in the grid; then its latest
   * records. The row's "What it records" isn't repeated; a user-defined event
   * (whose row says only that) shows its own description instead.
   * "Show its records" is the one visible action; Turn on/off, Clear counts and
   * Delete go under ⋯.
   */
  const showEvent = async (name: string): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEdit();
    const e = events.find((x) => x.EventName === name);
    if (!e) { closePanel(); return; }
    selected = name;
    grid?.select([name]);
    const p = splitEventName(name);
    const user = !isSystemEvent({ source: p.source });
    const meaning = eventMeaning(name);
    const noPriv = canSecure === false ? NO_SECURE : '';
    const state = eventState(e);
    /** Zero reads as "—", the grid's convention. */
    const count = (n: number): string => (n ? num(n) : '<span class="dim">—</span>');
    const items: MenuItem[] = [
      e.Enabled
        ? { label: securityRelevant(name) ? 'Turn off…' : 'Turn off', icon: 'eye-off', danger: securityRelevant(name), disabled: !!noPriv, reason: noPriv, onSelect: () => void toggleEvent(name) }
        : { label: 'Turn on', icon: 'eye', disabled: !!noPriv, reason: noPriv, onSelect: () => void toggleEvent(name) },
      { label: 'Clear counts…', icon: 'undo', disabled: !!noPriv, reason: noPriv, onSelect: () => void clearOne(name) },
      user
        ? { label: 'Delete…', icon: 'trash-2', danger: true, disabled: !!noPriv, reason: noPriv, onSelect: () => void removeEvent(name) }
        : { label: 'Delete…', icon: 'trash-2', danger: true, disabled: true, reason: 'IRIS’s own events can be turned off, but not deleted', onSelect: () => undefined },
    ];
    let description = '';
    let recent: AuditRecord[] | null = null;
    let recentError = '';
    /** The latest records: fixed 28px rows (placeholders while loading), so the peek doesn't jump when they arrive. */
    const recentHtml = (): string => {
      const phrase = RANGES[RECENT_RANGE].phrase;
      if (recentError) return `<p class="detail-note">Couldn’t load its records (${esc(recentError)}).</p>`;
      if (!recent) return `<ul class="audit-recent" aria-busy="true" aria-label="Loading">${'<li><span class="audit-recent-row audit-recent-wait"><i></i></span></li>'.repeat(RECENT_N)}</ul>`;
      if (!recent.length) {
        return `<p class="detail-note">None ${phrase}.${!e.Enabled ? ' It’s turned off, so it isn’t recorded.' : auditOn === false ? ' Auditing is off, so nothing is recorded.' : ''}</p>`;
      }
      return `<ul class="audit-recent">${recent.map((r, i) => {
        const d = utcDate(r.UTCTimeStamp);
        const who = r.Username ? userText(r.Username) : '—';
        return `<li><button type="button" class="audit-recent-row" data-recent="${i}" title="${esc(`${when(d, { seconds: true })} · ${who}${r.Description ? ` · ${r.Description}` : ''} — open this record`)}">`
          + `<span class="audit-recent-when">${esc(when(d))}</span>`
          + `<span class="audit-recent-who">${esc(who)}</span>`
          + `<span class="audit-recent-what">${r.Description ? esc(r.Description) : ''}</span></button></li>`;
      }).join('')}</ul>`;
    };
    const render = (): void => {
      // The row already says what an IRIS event records; a user-defined event's row says only "User-defined event",
      // so its own description is the one line worth adding here.
      const desc = meaning ? '' : description;
      dropEvtMenu();
      dropRecMenu();
      const scroll = detail.scrollTop;
      detail.classList.add('od-detail');
      detail.innerHTML = `
        <div class="od-shell">
          <header class="od-head">
            <h2 class="od-title" title="${esc(meaning ? `${p.event}: ${meaning}` : p.event)}">${esc(p.event)}</h2>
            <div class="od-head-actions">
              <button type="button" class="btn btn--sm od-primary" id="evt-records"><ev-icon name="file-text" size="xs"></ev-icon>Show its records</button>
              ${moreButton('evt-more', `More actions for ${p.event}`)}
              <span class="od-vsep" aria-hidden="true"></span>
              <ev-icon-button icon="x" label="Close" title="Close" id="evt-close"></ev-icon-button>
            </div>
            <div class="od-meta">${odMeta(state, [user ? 'User-defined event' : 'IRIS event'])}</div>
          </header>
        </div>
        <div class="od-body">
          <div class="audit-ident"><span class="mono" title="Source/Type/Name, as code raises it">${esc(name)}</span><button type="button" class="btn btn--sm btn--quiet audit-ident-copy" id="evt-copy" aria-label="Copy the event name" title="Copy"><ev-icon name="copy" size="xs"></ev-icon></button></div>
          ${desc ? `<p class="od-desc" title="${esc(desc)}">${esc(desc)}</p>` : ''}
          ${odSection('Since the counts were last cleared', odKv([
            ['Happened', count(e.Total)],
            ['Recorded', count(e.Written)],
            ['Lost', e.Lost ? `<span style="color:var(--ev-color-danger)">${num(e.Lost)}</span>` : count(0)],
          ]))}
          ${odSection(`Latest records ${RANGES[RECENT_RANGE].phrase}`, recentHtml())}
        </div>`;
      detail.scrollTop = scroll;
      detail.querySelector('#evt-close')?.addEventListener('click', closePanel);
      const copy = detail.querySelector<HTMLElement>('#evt-copy');
      copy?.addEventListener('click', () => {
        void navigator.clipboard.writeText(name).then(() => {
          copy.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>';
          setTimeout(() => { copy.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>'; }, 1600);
        });
      });
      detail.querySelector('#evt-records')?.addEventListener('click', () => {
        eventFilter = name;
        const pick = ctx.body.querySelector('#rec-event') as (HTMLElement & { value: string }) | null;
        if (pick) pick.value = eventFilter;
        switchView('records');
        void loadRecords();
      });
      detail.querySelectorAll<HTMLElement>('[data-recent]').forEach((b) => b.addEventListener('click', () => {
        const r = recent?.[Number(b.dataset.recent)];
        if (r) openRecord(name, r);
      }));
      evtMenu = moreMenu(detail.querySelector('#evt-more') as HTMLElement, items);
      setPanel(true);
    };
    const current = (): boolean => selected === name && !editor && view === 'events';
    render();
    detail.scrollTop = 0;
    void recentRecords(name).then((rows) => { recent = rows; }, (err: unknown) => { recentError = err instanceof Error ? err.message : String(err); })
      .then(() => { if (current()) render(); });
    if (user) {
      try { const d = await getAuditEventSetting(keyOf(name)); description = d.Description ?? ''; if (current()) render(); } catch { /* the counts are enough */ }
    }
  };

  /** New user event: Source / Type / Name (no % source: those are IRIS's), description, enabled. */
  const EVT_PART = /^[A-Za-z0-9_][A-Za-z0-9_ .-]*$/;
  const openNewEvent = async (): Promise<void> => {
    if (editor && !(await editor.guard())) return;
    leaveEdit();
    if (view !== 'events') switchView('events');
    selected = null;
    grid?.select([]);
    dropEvtMenu();
    detail.classList.remove('od-detail');
    // The same width as the event peek, so the grid's right edge doesn't move between the two.
    restoreWidth = panelWidth(panel as HTMLElement, panel.open ? panel.detailWidth : peekWidth(panel));
    setPanel(true);
    editor = editorShell(detail, {
      title: 'New user event',
      name: 'the new event',
      submitLabel: 'Create event',
      sections: section('Event',
        `<div class="crud-row">${textField('Source', 'Source', '', { required: true, maxlength: 64, placeholder: 'e.g. MyApp' })}${textField('Type', 'Type', '', { required: true, maxlength: 64, placeholder: 'e.g. Orders' })}</div>`
        + textField('Name', 'Name', '', { required: true, maxlength: 64, placeholder: 'e.g. Approved', hint: 'Your code raises it as Source/Type/Name with $SYSTEM.Security.Audit().' })
        + textField('Description', 'Description', '', { maxlength: 128 })
        + checkField('Enabled', 'Record it', true, { toggle: true, hint: 'While it’s off, raising it writes nothing.' })),
      check: () => {
        const v = readForm(detail);
        const out: FieldProblem[] = [];
        for (const f of ['Source', 'Type', 'Name'] as const) {
          const x = String(v[f] ?? '').trim();
          if (!x) out.push({ field: f, label: f, message: `Enter a ${f.toLowerCase()}` });
          else if (f === 'Source' && x.startsWith('%')) out.push({ field: f, label: f, message: 'Sources starting with % are IRIS’s own' });
          else if (!EVT_PART.test(x)) out.push({ field: f, label: f, message: 'Letters, digits, spaces, . _ and - only; no /' });
        }
        const full = `${String(v.Source ?? '').trim()}/${String(v.Type ?? '').trim()}/${String(v.Name ?? '').trim()}`;
        if (events.some((e) => e.EventName.toLowerCase() === full.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'This event already exists' });
        return out;
      },
      onSubmit: async (v) => {
        const k: AuditEventKey = { source: String(v.Source).trim(), type: String(v.Type).trim(), name: String(v.Name).trim() };
        // The same PUT would change an existing event, so make sure it's new right before it's sent.
        try { await getAuditEventSetting(k); fieldError(detail, 'Name', 'This event already exists'); focusField(detail, 'Name'); throw new Error('Choose another name: this event already exists.'); } catch (err) {
          if (!(err instanceof AdminError && err.status === 404)) throw err;
        }
        await saveAuditEvent(k, { Description: String(v.Description ?? '').trim(), Enabled: !!v.Enabled });
        leaveEdit();
        await loadEvents();
        const name = `${k.source}/${k.type}/${k.name}`;
        toast(`${name} created.`);
        void showEvent(name);
      },
      onCancel: () => { leaveEdit(); closePanel(); },
    });
    // Source/Type/Name are code identifiers, so what's typed is mono; the "e.g." placeholders stay in the
    // plain face so they can't be mistaken for values already filled in.
    for (const f of ['Source', 'Type', 'Name']) {
      const input = detail.querySelector<HTMLElement & { value: string }>(`ev-input[name="${f}"]`);
      if (!input) continue;
      const sync = (): void => { input.classList.toggle('crud-mono', !!input.value); };
      input.addEventListener('ev-input-input', sync);
      input.addEventListener('ev-input-change', sync);
      sync();
    }
    ctx.beforeLeave(() => (editor ? editor.guard() : Promise.resolve(true)));
  };
  const newEvtBtn = newButton(ctx, 'New user event', () => void openNewEvent());
  /**
   * While auditing is off, turning it on is what the page asks for: it's the header's primary button, and
   * New user event (a rare developer task) steps down to secondary. Once auditing is on, the button goes.
   */
  const turnOnBtn = document.createElement('button');
  turnOnBtn.type = 'button';
  turnOnBtn.className = 'btn btn--primary';
  turnOnBtn.id = 'audit-turn-on';
  turnOnBtn.textContent = 'Turn on auditing';
  turnOnBtn.hidden = true;
  turnOnBtn.addEventListener('click', () => { if (!turnOnBtn.hasAttribute('data-crud-blocked')) void enableAuditing(); });
  ctx.actions.append(turnOnBtn);
  ctx.onLeave(() => turnOnBtn.remove());
  const setActionRank = (): void => {
    const off = auditOn === false;
    turnOnBtn.hidden = !off;
    newEvtBtn.el.classList.toggle('btn--primary', !off);
  };
  // The header is the same on both tabs: New user event (which opens the Events tab if needed), freshness.
  // Clear all counts only concerns the Events table, so it's a quiet button in that tab's toolbar, not a header ⋯.
  const clearAllBtn = $<HTMLButtonElement>('#evt-clear-all');
  clearAllBtn.addEventListener('click', () => { if (!clearAllBtn.hasAttribute('data-crud-blocked')) void clearAll(); });
  getInfo().then((info) => {
    const priv = (info as unknown as { privileges?: Record<string, { use?: boolean }> }).privileges;
    canSecure = priv ? !!priv.Secure?.use : null;
    newEvtBtn.setBlocked(canSecure === false ? NO_SECURE : null);
    setBlocked(clearAllBtn, canSecure === false ? NO_SECURE : null);
    setBlocked(turnOnBtn, canSecure === false ? 'You need the security administrator privilege (%Admin_Secure) to turn on auditing' : null);
    if (view === 'events') renderEvents();
  }).catch(() => { /* unknown: leave actions on; IRIS refuses what isn't allowed */ });

  const loadEvents = async (): Promise<void> => {
    try {
      events = (await getAuditEvents()).sort((a, b) => a.EventName.localeCompare(b.EventName));
      eventsError = null;
    } catch (err) {
      eventsError = err;
    }
    eventsLoaded = true;
    // The Events tab carries its count from the start, not only once it's opened.
    if (!eventsError) setViewTabCount(ctx.body, 'audit-view', 'events', events.length);
    buildEventPicker();
    renderEvents();
    renderSummary();
  };

  /** ev-select reads its options when it connects, so it's (re)built once the event list is known. */
  const buildEventPicker = (): void => {
    const slot = $('#rec-event-slot');
    const pick = document.createElement('ev-select') as HTMLElement & { value: string };
    pick.id = 'rec-event';
    pick.setAttribute('size', 'sm');
    pick.setAttribute('searchable', '');
    pick.setAttribute('full-width', '');
    pick.setAttribute('placeholder', 'All events');
    pick.setAttribute('aria-label', 'Filter records by event');
    const opts = [`<option value="">All events</option>`];
    for (const e of events) {
      const p = splitEventName(e.EventName);
      const m = eventMeaning(e.EventName);
      opts.push(`<option value="${esc(e.EventName)}">${esc(p.event)}${m ? ` — ${esc(m)}` : ` — ${esc(p.source)}/${esc(p.type)}`}</option>`);
    }
    pick.innerHTML = opts.join('');
    pick.setAttribute('value', eventFilter);
    pick.addEventListener('ev-select-change', (e) => {
      const v = (e as CustomEvent<{ value: string | string[] }>).detail.value;
      eventFilter = Array.isArray(v) ? v[0] ?? '' : v;
      closePanel();
      void loadRecords();
    });
    slot.replaceChildren(pick);
  };

  // ── Auditing on/off ─────────────────────────────────────
  const loadEnabled = async (): Promise<void> => {
    try {
      auditOn = (await getAuditEnabled()).Enabled;
    } catch {
      auditOn = null; // unknown: say nothing rather than guess
    }
    // Off: the one-line page notice says so; the fix is the header's primary button (Turn on auditing).
    mountSecurityBanner(ctx.banners, null, auditOn === false
      ? { tone: 'warning', headline: 'Auditing is off — sign-ins and security changes aren’t recorded' }
      : null);
    setActionRank();
    if (view === 'events') renderEvents();

    renderSummary();
  };

  // ── View switching ──────────────────────────────────────
  const switchView = (v: View): void => {
    if (view === v) return;
    view = v;
    ctx.body.querySelectorAll('#audit-view button').forEach((b) => b.setAttribute('aria-selected', String((b as HTMLElement).dataset.value === v)));
    $('#rec-tools').hidden = v !== 'records';
    $('#evt-tools').hidden = v !== 'events';
    exportBtn.hidden = v !== 'records';
    leaveEdit();
    closePanel();
    grid = null;
    gridView = null;
    wrap.innerHTML = '';
    if (v === 'records') renderRecords(); else renderEvents();
    renderSummary();
  };

  bindViewTabs(ctx.body, 'audit-view', (v) => switchView(v as View));
  rangeEl.addEventListener('ev-segmented-button-change', (e) => { range = (e as CustomEvent<{ value: Range }>).detail.value; void loadRecords(); });
  $('#rec-user').addEventListener('ev-search-input', (e) => {
    userQuery = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderRecords();
  });
  $('#evt-search').addEventListener('ev-search-input', (e) => {
    eventQuery = (e as CustomEvent<{ value: string }>).detail.value.trim();
    renderEvents();
  });
  scopeEl.addEventListener('ev-segmented-button-change', (e) => { scope = (e as CustomEvent<{ value: Scope }>).detail.value; renderEvents(); });
  ctx.onLeave(() => { leaveEdit(); dropEvtMenu(); dropRecMenu(); });

  const refresh = async (): Promise<void> => {
    recentCache.clear();
    await loadEnabled();
    await Promise.all([loadEvents(), loadRecords(widenedFrom !== null && range === '7d')]);
  };

  // Turn auditing on from the notice, after saying what it means.
  async function enableAuditing(): Promise<void> {
    const ok = await confirm({
      title: 'Turn on auditing?',
      body: '<p>IRIS will start recording the events that are enabled, such as sign-ins, failed sign-ins and changes to users, roles and privileges.</p><p>Records are kept in the audit database and purged by the nightly Purge Audit Database task.</p>',
      confirmLabel: 'Turn on auditing',
    });
    if (!ok) return;
    try {
      await writeJson('PUT', '/security/audit/enabled', { Enabled: true });
      toast('Auditing is on. New events will appear here as they happen.', 'success');
      await refresh();
    } catch (err) {
      toast(errorText(err), 'danger');
    }
  }

  buildEventPicker();
  void refresh();
}
