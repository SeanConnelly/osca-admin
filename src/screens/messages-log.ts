// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Logs › Messages log — the instance's console log (messages.log): what IRIS
 * wrote about starting, stopping, journaling, errors and warnings, newest
 * first, a page at a time.
 *
 * The SysAdmin API has no way to read it (docs/api-gaps.md #19), so it comes
 * from OSCA Admin's own read-only API; without that module the page says so.
 * Search and the level filter run on the server (it reads the file from the
 * end), "Load older" follows the server's cursor, and the newest lines are
 * fetched again on every refresh and merged in above what is shown.
 *
 * Repeats fold (see fold()): consecutive identical lines become one row,
 * "· 5 times", as the Alerts list does; and a burst of lines from one
 * process and source that cycle through a few texts within seconds of each
 * other ("Activating … namespace map" / "Namespace … changes have been
 * activated", 40 times over) becomes one row too. The peek and full view list
 * every line; the CSV has the raw lines. A folded row is keyed on its OLDEST
 * line, so new repeats arriving on top keep the row (and an open peek) where
 * it is. IRIS's own "...(repeated N times)" suffix counts in the same total
 * ("5 times (4 folded by IRIS)" in the peek and full view).
 *
 * Back from the full view (or from anywhere else) to this list restores the
 * filter, the search, the selected row and the scroll position: they are kept
 * in the list's history entry (history.state), not in the address.
 */
import '../styles-messages.css';
import { apiAvailable, getMessagesLog, type LogEntry, type MessagesLog, type LogLevel } from '../api-osca';
import {
  esc, num, when, relative, cell, cellRef, status, exportButton, gridExport, skeleton, errorPanel, liveIndicator, emptyState,
  objectDetail, odMeta, odSection, odKv, type ScreenCtx, type GridColumn, type Tone, type OdFull,
} from '../ui';
import { toast, errorText } from '../crud';
import { plainWords, timesText } from './alerts';
import type { DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

type Filter = 'all' | 'warning' | 'severe';
type GridEl = HTMLElement & {
  columns: GridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};
/** A distinct text in a folded row: how often, and its newest line. */
interface Kind { text: string; count: number; e: LogEntry }
/**
 * One row: a line, or a folded run (newest first). `e` is the newest line (time, sort, process);
 * `head` is the line the row is titled by (the most frequent text; for a single line, `e`).
 * `kinds` lists the distinct texts in the order they first appeared (more than one: a burst).
 */
interface Group { key: string; e: LogEntry; head: LogEntry; entries: LogEntry[]; kinds: Kind[] }
/** What the list's history entry keeps, so Back returns to the same place. */
interface BackState { sel: string | null; scroll: number; filter: Filter; query: string }

const PAGE = 200;
const REFRESH_S = 15;
const NEAR = 3;
/** Folding: lines in a burst are at most this far apart, and cycle through at most this many texts. */
const BURST_GAP_MS = 60_000;
const BURST_KINDS = 4;
const MIN_LEVEL: Record<Filter, LogLevel> = { all: 0, warning: 1, severe: 2 };
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'warning', label: 'Warnings & up' },
  { value: 'severe', label: 'Severe & up' },
];
// The app's status() tones: Warning amber, Severe and Fatal danger red.
const LEVELS: Array<{ word: string; tone: Tone }> = [
  { word: 'Info', tone: 'neutral' },
  { word: 'Warning', tone: 'warning' },
  { word: 'Severe', tone: 'danger' },
  { word: 'Fatal', tone: 'danger' },
];
const levelOf = (n: number): { word: string; tone: Tone } => LEVELS[n] ?? LEVELS[0];

const firstLine = (text: string): string => text.split('\n', 1)[0];
/** IRIS folds repeats itself: "Alert state cleared....(repeated 1 times)". Split that suffix off the first line. */
const IRIS_REPEAT = /\.{3}\s*\(repeated (\d+) times?\)\s*$/;
const irisRepeat = (text: string): { line: string; rep: number } => {
  const line = firstLine(text);
  const m = IRIS_REPEAT.exec(line);
  return m ? { line: line.slice(0, m.index).replace(/\s+$/, ''), rep: Number(m[1]) } : { line, rep: 0 };
};
/** The first line without IRIS's repeat suffix: what the list, titles and neighbours show. */
const shown = (text: string): string => irisRepeat(text).line;
/**
 * What a row says: its first line, or for a severe diagnostic line ("ISCLOG: WorkMgr Detach Returning
 * error … ERROR #7846: …") the Alerts list's plain words for the same text, so one event reads the same
 * on both pages. The tooltip, peek and full view keep IRIS's own text.
 */
const words = (e: LogEntry): string => (e.level >= 2 && plainWords(shown(e.text))) || shown(e.text);
/**
 * How often a single-text row happened, in the Alerts list's wording: every line in the run, each
 * counting IRIS's own "(repeated N times)" (N more after it). `folded`: how many IRIS folded.
 */
const timesOf = (g: Group): { total: number; folded: number } => {
  const rep = irisRepeat(g.head.text).rep;
  return { total: g.entries.length * (1 + rep), folded: g.entries.length * rep };
};
const lineCount = (text: string): number => text.split('\n').length;
const dateOf = (e: { time: string | null }): Date | null => (e.time ? new Date(e.time) : null);
/**
 * The title: short, since the Message card under it has the whole text. The line's first clause when
 * that ends by 64 characters ("Journal file has reached its maximum size…"), else a cut at a word near 64.
 */
const summary = (s0: string): string => {
  const s = s0.trim();
  if (s.length <= 64) return s;
  const clause = /^(.{16,64}?)[.;:,](?=\s)/.exec(s);
  if (clause) return `${clause[1]}…`;
  const cut = s.slice(0, 64);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, '')}…`;
};
/** "2026-09-27T13:16:11.060+01:00" → "2026-09-27 13:16:11.060 (UTC+01:00)": the time as the file has it. */
const serverTime = (iso: string): string => {
  const m = /^(\d{4}-\d{2}-\d{2})T([\d:.]+)([+-]\d{2}:\d{2})?$/.exec(iso);
  return m ? `${m[1]} ${m[2]}${m[3] ? ` (UTC${m[3]})` : ''}` : iso;
};
/** "Today 09:12" mid-sentence: "back to today 09:12". */
const midSentence = (s: string): string => s.replace(/^(Today|Yesterday)\b/, (m) => m.toLowerCase());
/** The one time format of the logs: absolute in the cell, the seconds and how long ago in the tooltip. */
const timeTitle = (d: Date): string => `${when(d, { seconds: true })} · ${relative(d)}`;

/** Same process, source and level: lines that can fold together. */
const sameStream = (a: LogEntry, b: LogEntry): boolean => a.source === b.source && a.level === b.level && a.pid === b.pid;
const msOf = (e: LogEntry): number => (e.time ? Date.parse(e.time) : NaN);

function group(entries: LogEntry[]): Group {
  const byText = new Map<string, Kind>();
  // Oldest first, so the kinds come in the order they first appeared.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const k = byText.get(e.text);
    if (k) { k.count++; k.e = e; } else byText.set(e.text, { text: e.text, count: 1, e });
  }
  const kinds = [...byText.values()];
  // Titled by the most frequent text; on a tie, the one that came first (the start of the cycle).
  const top = kinds.reduce((m, k) => (k.count > m.count ? k : m), kinds[0]);
  return { key: String(entries[entries.length - 1].offset), e: entries[0], head: top.e, entries, kinds };
}

/**
 * Fold the list (newest first) into rows. From each line, take the longest run that
 *  - stays in one process, source and level,
 *  - uses at most BURST_KINDS different texts,
 *  - has each line within BURST_GAP_MS of the one before it (identical neighbours: any gap),
 * then keep its longest start in which every text occurs at least twice (so a burst is real
 * repetition, and a one-off line next to it stays a row of its own). A run of one text is the
 * plain "repeated N×"; several texts are a burst.
 */
function fold(list: LogEntry[]): Group[] {
  const out: Group[] = [];
  let i = 0;
  while (i < list.length) {
    const a = list[i];
    const texts = new Set([a.text]);
    let j = i + 1;
    for (; j < list.length; j++) {
      const b = list[j];
      const prev = list[j - 1];
      if (!sameStream(a, b)) break;
      if (!texts.has(b.text) && texts.size >= BURST_KINDS) break;
      if (b.text !== prev.text && !(Math.abs(msOf(prev) - msOf(b)) <= BURST_GAP_MS)) break;
      texts.add(b.text);
    }
    const counts = new Map<string, number>();
    let singles = 0;
    let best = 1;
    for (let k = i; k < j; k++) {
      const c = (counts.get(list[k].text) ?? 0) + 1;
      counts.set(list[k].text, c);
      if (c === 1) singles++; else if (c === 2) singles--;
      if (singles === 0) best = k - i + 1;
    }
    out.push(group(list.slice(i, i + best)));
    i += best;
  }
  return out;
}

/**
 * The quiet suffix after a row's text, in the Alerts list's wording: "· 12 times" for a run of one
 * line (its lines plus IRIS's own "(repeated N times)"; nothing below 2), "· and 1 related line,
 * 13 times" for a burst that cycles evenly, "· and 3 related lines, 34 lines in all" for one that
 * doesn't, "· +4 lines" for a stack.
 */
function tailOf(g: Group): string[] {
  const n = g.entries.length;
  if (g.kinds.length > 1) {
    const others = g.kinds.length - 1;
    const counts = g.kinds.map((k) => k.count);
    const even = Math.max(...counts) - Math.min(...counts) <= 1;
    const head = g.kinds.find((k) => k.e === g.head)?.count ?? n;
    return [`and ${others} related line${others === 1 ? '' : 's'}, ${even ? timesText(head) || `${num(head)} time` : `${num(n)} lines in all`}`];
  }
  const lines = lineCount(g.head.text);
  return [
    timesText(timesOf(g).total),
    lines > 1 ? `+${lines - 1} lines` : '',
  ].filter(Boolean);
}
/** The suffix as quiet inline markup ("· 12 times"). */
const tailHtml = (parts: string[]): string =>
  parts.map((t) => `<span class="msg-tail"><span class="msg-tail-sep" aria-hidden="true">·</span>${esc(t)}</span>`).join('');

/**
 * Fixed columns: the grid's table-layout is auto, so a column's width is only
 * a hint that content can push. Each cell's content box is set to exactly the
 * column's width less the cell's 8px + 8px padding, so the columns sit at the
 * same x whatever the rows hold (the filter or search never moves them).
 */
const W = { time: 164, level: 104, source: 160, pid: 84 };
const fit = (px: number, html: string): string => `<span style="display:block;width:${px - 16}px;overflow:hidden">${html}</span>`;

/**
 * Level: a dot and a word for Warning, Severe and Fatal; Info as a plain word, lined up with them.
 * At 6px the dark theme's warning and danger dots are two close oranges, so Severe and Fatal also
 * set their word in the danger colour: amber dot + grey word vs red dot + red word.
 */
function levelCell(n: number): string {
  if (n <= 0) return '<span style="display:block;padding-left:12px;color:var(--ev-color-text-tertiary)">Info</span>';
  const l = levelOf(n);
  const html = status(l.word, l.tone);
  return l.tone === 'danger' ? html.replace('color:var(--ev-color-text-secondary)', 'color:var(--ev-color-danger)') : html;
}

const COLUMNS: GridColumn[] = [
  // Keyed on the position in the file: file order is time order, and it breaks ties within a millisecond.
  { key: 'Pos', label: 'Time', width: `${W.time}px`, sortable: true, renderCell: (_v, row) => {
    if (!row.Time) return fit(W.time, cell.dim('—'));
    const d = new Date(String(row.Time));
    // Seconds in the cell: forty lines in one minute have to be told apart by eye.
    return fit(W.time, cell.num(when(d, { seconds: true }), timeTitle(d)));
  } },
  { key: 'Level', label: 'Level', width: `${W.level}px`, sortable: true, renderCell: (v) => fit(W.level, levelCell(Number(v))) },
  { key: 'Source', label: 'Source', width: `${W.source}px`, sortable: true, renderCell: (v) => fit(W.source, v ? cellRef(v) : cell.dim('—')) },
  { key: 'Message', label: 'Message', width: '100%', renderCell: (v, row) => {
    const tail = String(row.Tail || '').split('\n').filter(Boolean).map((t) => `<span style="color:var(--ev-color-text-tertiary)"><span style="margin:0 6px" aria-hidden="true">·</span>${esc(t)}</span>`).join('');
    return `<span style="display:block;width:0;min-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(String(row.Text).slice(0, 600))}"><bdi>${esc(v)}</bdi>${tail}</span>`;
  } },
  { key: 'Pid', label: 'Process', width: `${W.pid}px`, sortable: true, align: 'right', renderCell: (v) => fit(W.pid, v === null || v === '' ? cell.dim('—') : cellRef(v)) },
];

const toRow = (g: Group): DataGridRow => ({
  id: g.key, Pos: g.e.offset, Time: g.e.time ?? '', Level: g.e.level, Source: g.e.source,
  Message: words(g.head), Text: g.kinds.length > 1 ? g.kinds.map((k) => shown(k.text)).join('\n') : g.head.text,
  Pid: g.e.pid ?? '', Count: g.entries.length, Tail: tailOf(g).join('\n'),
});

export function messagesLogScreen(ctx: ScreenCtx): void {
  ctx.fill();
  ctx.body.innerHTML = `
    <div id="msg-list" class="od-list">
      <div class="toolbar-row" id="msg-toolbar">
        <div class="search-box"><ev-search id="msg-search" size="sm" full-width placeholder="Search messages and sources" aria-label="Search the messages log"></ev-search></div>
        <ev-segmented-button id="msg-level" size="sm" aria-label="Show lines by level"></ev-segmented-button>
      </div>
      <ev-detail-panel id="msg-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="msg-wrap">${skeleton(12)}</div>
        <aside slot="detail" class="detail" id="msg-detail" aria-label="Log line"></aside>
      </ev-detail-panel>
      <div class="msg-foot">
        <p class="table-foot" id="msg-foot"></p>
        <button type="button" class="btn btn--sm" id="msg-older" hidden>Load older</button>
      </div>
    </div>
    <div id="msg-full" hidden></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const wrap = $('#msg-wrap');
  const toolbar = $('#msg-toolbar');
  const foot = $('#msg-foot');
  const olderBtn = $<HTMLButtonElement>('#msg-older');
  const searchEl = $<HTMLElement & { value: string }>('#msg-search');
  const panel = $<HTMLElement & { open: boolean }>('#msg-panel');
  const levelEl = $<HTMLElement & { options: unknown; value: string }>('#msg-level');
  levelEl.options = FILTERS;
  levelEl.value = 'all';
  // Export: the raw lines behind the rows shown (visible columns, current sort), a folded row unfolded
  // into every line it holds, each with its full time and whole message.
  const exportBtn = exportButton(() => {
    const d = gridExport(grid, 'messages-log');
    if (!d) return null;
    const st = (grid as unknown as { getState?(): { sortColumn?: string; sortDirection?: string } } | null)?.getState?.() ?? {};
    const desc = !(st.sortColumn === 'Pos' && st.sortDirection === 'asc');
    const rows = d.rows.flatMap((r) => {
      const g = byKey.get(String(r.id));
      if (!g) return [];
      const lines = desc ? g.entries : [...g.entries].reverse();
      return lines.map((e) => ({ Pos: e.time ?? '', Level: levelOf(e.level).word, Source: e.source, Message: e.text, Pid: e.pid ?? '' }));
    });
    return { ...d, columns: d.columns.map((c) => ({ key: c.key, label: c.label })), rows };
  });
  toolbar.append(exportBtn);

  let alive = true;
  ctx.onLeave(() => { alive = false; });
  let filter: Filter = 'all';
  let query = '';
  let entries: LogEntry[] = [];
  let groups: Group[] = [];
  /** Every line's offset → its group (a folded row answers to any of its lines). */
  let byKey = new Map<string, Group>();
  let next: number | null = null;
  let truncated = false;
  let size = 0;
  let file = '';
  let loaded = false;
  let loadError: unknown = null;
  let loadingOlder = false;
  let seq = 0;
  let grid: GridEl | null = null;
  let rowSig = '';
  /**
   * Lines of each level (info, warning, severe, fatal) in the part of the log read, matching the search
   * whatever the level filter: the server counts them as it reads, so the chips can say what each
   * filter holds before it's chosen. null: an older server module that doesn't count.
   */
  let levels: number[] | null = null;
  /**
   * The search the chip counts were made for. The counts are taken from the unfiltered read ("All") and
   * then kept while you switch chips: a Severe & up read goes further back to find 200 severe lines, and
   * counting that would make every chip change meaning under you. They follow new lines and Load older.
   */
  let levelsQuery: string | null = null;
  /** Lines the chip counts cover (what the footer and the chips' tooltip say). */
  const covered = (): number => (levels ? levels.reduce((a, b) => a + b, 0) : 0);
  const countLevels = (list: LogEntry[]): number[] => list.reduce((c, e) => { c[Math.min(3, Math.max(0, e.level))]++; return c; }, [0, 0, 0, 0]);
  const levelsOf = (r: MessagesLog): number[] | null => {
    const l = r.levels;
    return Array.isArray(l) && l.length === 4 ? l.map(Number) : filter === 'all' ? countLevels(r.entries) : null;
  };
  const renderChips = (): void => {
    const at = (min: number): number => (levels ? levels.slice(min).reduce((a, b) => a + b, 0) : NaN);
    const opts = FILTERS.map((f) => {
      const n = at(MIN_LEVEL[f.value]);
      return { value: f.value, label: Number.isFinite(n) ? `${f.label} ${num(n)}` : f.label };
    });
    const sig = JSON.stringify(opts);
    if (sig === chipSig) return;
    chipSig = sig;
    levelEl.options = opts;
    levelEl.value = filter;
  };
  /** The chips' tooltip: which lines the counts cover. Kept current apart from the labels (it changes as lines arrive). */
  const chipTitle = (): void => {
    const n = covered();
    levelEl.title = levels
      ? `Counts cover the ${num(n)} ${n === 1 ? 'line' : 'lines'}${query ? ' matching the search' : ''} read so far${next === null && filter === 'all' ? ' (the whole log)' : ''}, and stay the same while you switch between them`
      : '';
  };
  let chipSig = '';

  const setEntries = (list: LogEntry[]): void => {
    entries = list;
    groups = fold(list);
    byKey = new Map(groups.flatMap((g) => g.entries.map((e) => [String(e.offset), g] as [string, Group])));
  };
  const params = (): { limit: number; minLevel: LogLevel; q?: string } => ({ limit: PAGE, minLevel: MIN_LEVEL[filter], ...(query ? { q: query } : {}) });
  const filtered = (): boolean => filter !== 'all' || !!query;
  const clearFilters = (): void => {
    filter = 'all';
    levelEl.value = 'all';
    query = '';
    searchEl.value = '';
    void reload();
  };

  /* ───── Grid ───── */
  const ensureGrid = (): GridEl => {
    if (grid) return grid;
    wrap.innerHTML = '';
    const g = document.createElement('ev-data-grid') as GridEl;
    g.setAttribute('compact', '');
    g.setAttribute('row-select', '');
    g.setAttribute('row-key', 'id');
    g.setAttribute('sort-column', 'Pos');
    g.setAttribute('sort-direction', 'desc');
    g.setAttribute('aria-label', 'Messages log');
    g.columns = COLUMNS;
    g.addEventListener('ev-data-grid-row-click', (e) => void od.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.id)));
    // While the peek is open it follows the keyboard: the arrow keys move the grid's focused row, and the peek
    // with it. (Focus moves inside the grid's shadow root don't reach the host as focusin, so this reads the
    // focused row after the grid has handled the key, and again shortly after for rows it had to window in first.)
    const follow = (): void => {
      if (!panel.open || od.mode() !== 'list') return;
      const tr = (g.shadowRoot?.activeElement as HTMLElement | null)?.closest<HTMLElement>('tr[data-row-key]');
      const key = tr?.dataset.rowKey;
      if (key && key !== od.selected() && byKey.has(key)) void od.select(key);
    };
    g.addEventListener('keydown', (e) => {
      if (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End)$/.test(e.key)) return;
      setTimeout(follow, 0);
      setTimeout(follow, 80);
    });
    wrap.appendChild(g);
    grid = g;
    rowSig = '';
    return g;
  };
  const dropGrid = (html: string): void => { grid = null; rowSig = ''; wrap.innerHTML = html; };
  /** Row keys in the grid's current sort (what J / K and the full view's n of N step through). */
  const order = (): string[] => {
    const d = grid ? gridExport(grid, '') : null;
    return d ? d.rows.map((r) => String(r.id)) : groups.map((g) => g.key);
  };

  const render = (): void => {
    if (loadError) {
      toolbar.hidden = true;
      dropGrid(errorPanel(loadError, 'msg-retry'));
      wrap.querySelector('#msg-retry')?.addEventListener('click', () => void reload());
      foot.textContent = '';
      olderBtn.hidden = true;
      return;
    }
    if (!loaded) return;
    toolbar.hidden = false;
    wrap.querySelector('.msg-empty')?.remove();
    if (!entries.length && !filtered() && next === null) {
      dropGrid(emptyState({ icon: 'scroll-text', title: 'The log is empty', what: 'IRIS hasn’t written anything to its messages log yet.' }));
    } else {
      const g = ensureGrid();
      // With nothing to show, one blank row (hidden under the empty state) holds the column widths,
      // so the header doesn't close up when a filter matches nothing.
      const rows = groups.length ? groups.map(toRow)
        : [{ id: '', Pos: 0, Time: '', Level: 0, Source: '', Message: '', Text: '', Pid: '', Count: 1, Tail: '' }];
      const sig = JSON.stringify(rows.map((r) => [r.id, r.Pos, r.Message, r.Count, r.Tail]));
      if (sig !== rowSig) { rowSig = sig; g.rows = rows; }
      const sel = od.selected();
      // A folded row whose older end just grew (Load older) has a new key: keep its peek open under it.
      const moved = sel ? byKey.get(sel) : undefined;
      if (sel && moved && moved.key !== sel) void od.select(moved.key);
      else if (sel) g.select([sel]);
      if (!entries.length) {
        // Inside the grid's frame, under its header: the columns stay where they are.
        const what = next !== null
          ? 'Nothing matches in the part of the log read so far. Load older keeps looking further back.'
          : query ? `No line in the log matches “${esc(query)}”${filter !== 'all' ? ' at this level' : ''}.` : 'No line in the log is at this level.';
        wrap.insertAdjacentHTML('beforeend', `<div class="msg-empty">${emptyState({
          icon: 'search', title: 'No matching lines', what,
          button: { id: 'msg-clear', label: 'Clear filters' },
        })}</div>`);
        wrap.querySelector('#msg-clear')?.addEventListener('click', clearFilters);
      }
    }
    exportBtn.disabled = !entries.length;
    renderChips();
    chipTitle();
    renderFoot();
  };

  /**
   * "200 lines in 135 rows · back to today 09:12", the grammar the three logs share. The rows are what the
   * full view's "n of N" counts (repeats fold into one row), so the footer names both figures.
   */
  const renderFoot = (): void => {
    const sep = '<span class="meta-sep">·</span>';
    const noun = filter === 'all' ? 'line' : filter === 'warning' ? 'warning or worse' : 'severe or fatal line';
    const nounMany = filter === 'all' ? 'lines' : filter === 'warning' ? 'warnings or worse' : 'severe or fatal lines';
    const rowsN = groups.length;
    const parts = [`<b>${num(entries.length)}</b> ${entries.length === 1 ? noun : nounMany}${query ? ' matching' : ''}${rowsN && rowsN !== entries.length
      ? ` <span title="Repeated lines fold into one row">in ${num(rowsN)} ${rowsN === 1 ? 'row' : 'rows'}</span>` : ''}`];
    const oldest = entries.length ? dateOf(entries[entries.length - 1]) : null;
    if (oldest) parts.push(`<span title="${esc(timeTitle(oldest))}">back to ${esc(midSentence(when(oldest)))}</span>`);
    if (next === null) parts.push('whole log read');
    else if (truncated) parts.push('<span title="Each read looks through at most 4 MB of the log. Load older carries on from there.">read limit reached</span>');
    // Whenever the chips count a different set of lines than the list holds, say which.
    const cover = covered();
    if (levels && cover !== entries.length) {
      parts.push(`<span title="The counts on the level chips come from the lines read without a level filter, so they don’t change as you switch">counts cover ${num(cover)} ${cover === 1 ? 'line' : 'lines'} read</span>`);
    }
    if (file) parts.push(`<span title="${esc(`${file} in the instance’s mgr directory`)}">${esc(file)} ${esc(fileSize(size))}</span>`);
    foot.innerHTML = parts.join(sep);
    olderBtn.hidden = next === null;
    olderBtn.disabled = loadingOlder;
  };

  /* ───── Peek and full view ───── */
  const copyButton = '<button type="button" class="btn btn--sm btn--quiet" data-msg-copy><ev-icon name="copy" size="xs"></ev-icon>Copy</button>';
  const messageBlock = (text: string, label = 'Message'): string => `<pre class="msg-text" tabindex="0" aria-label="${esc(label)}">${esc(text)}</pre>`;
  /** The time as the file has it, only when the browser's zone differs from the server's (otherwise it's the same time twice). */
  const serverTimeRow = (e: LogEntry): Array<[string, string]> => {
    const d = dateOf(e);
    if (!e.time || !d) return [];
    const m = /([+-])(\d{2}):(\d{2})$/.exec(e.time);
    const serverOffset = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : NaN;
    return serverOffset === -d.getTimezoneOffset() ? [] : [['Server time', `<span class="mono">${esc(serverTime(e.time))}</span>`]];
  };
  const timeText = (e: LogEntry): string => { const d = dateOf(e); return d ? when(d, { seconds: true }) : '—'; };
  const burst = (g: Group): boolean => g.kinds.length > 1;
  /** "Today 13:12:45 to 13:13:14": a folded row's first and last line (the day once when it's the same). */
  const span = (g: Group): string => {
    const a = timeText(g.entries[g.entries.length - 1]);
    const b = timeText(g.e);
    const day = (s: string): string => s.slice(0, s.lastIndexOf(' '));
    return a === b ? a : `${a} to ${day(a) === day(b) ? b.slice(b.lastIndexOf(' ') + 1) : b}`;
  };
  /** A burst's lines as the file has them, oldest first: "13:16:10.412  Activating … namespace map". */
  const rawLines = (g: Group): string => [...g.entries].reverse()
    .map((e) => `${e.time ? e.time.slice(11, 23) : ''}  ${e.text}`).join('\n');
  const copyText = (g: Group): string => (burst(g) ? rawLines(g) : g.head.text);
  /** Every time a folded line was written, newest first (the first 50). */
  const repeats = (g: Group): string => {
    const list = g.entries.slice(0, 50);
    const more = g.entries.length - list.length;
    return `<ol class="msg-times">${list.map((e) => `<li>${esc(timeText(e))}</li>`).join('')}</ol>${more > 0 ? `<p class="msg-times-more">and ${num(more)} earlier</p>` : ''}`;
  };
  /** A burst's distinct texts, in the order they first appeared, each with how often. */
  const kindsList = (g: Group): string => `<ol class="msg-kinds">${g.kinds.map((k) =>
    `<li><span class="msg-kind-n">${num(k.count)}×</span><bdi class="msg-kind-text">${esc(k.text)}</bdi></li>`).join('')}</ol>`;
  /** A burst's every line, newest first (the first 50): its time and its text. */
  const everyLine = (g: Group): string => {
    const list = g.entries.slice(0, 50);
    const more = g.entries.length - list.length;
    return `<ol class="msg-every">${list.map((e) =>
      `<li><span class="msg-every-time">${esc(timeText(e))}</span><bdi class="msg-every-text" title="${esc(shown(e.text))}">${esc(shown(e.text))}</bdi></li>`).join('')}</ol>${more > 0 ? `<p class="msg-times-more">and ${num(more)} earlier</p>` : ''}`;
  };
  /**
   * The header line, the same in the peek and the full view: "● Warning · Journal · Today 13:12:45 ·
   * Process 8123 · 5 times (4 folded by IRIS)" (a burst: its first and last time, and how many lines).
   * Time, process and count are said here once, not in a strip or in Details.
   */
  const metaOf = (g: Group): string => {
    const l = levelOf(g.e.level);
    const d = dateOf(g.e);
    const html: string[] = [];
    html.push(`<span title="${esc(d ? relative(d) : '')}">${esc(burst(g) ? span(g) : timeText(g.e))}</span>`);
    if (g.e.pid !== null) html.push(`<a class="link" href="#/operations/processes/${g.e.pid}" title="Open this process, if it’s still running">Process ${g.e.pid}</a>`);
    if (burst(g)) html.push(`<span>${esc(`${num(g.entries.length)} lines`)}</span>`);
    else { const t = timesOf(g); if (t.total >= 2) html.push(`<span>${esc(timesText(t.total, t.folded))}</span>`); }
    return odMeta({ label: l.word, tone: l.tone }, [g.e.source], html);
  };
  /** The lines around this one in the file, newest first as the list is; only while nothing is filtered (otherwise they aren't neighbours). */
  const around = (g: Group): string => {
    const i = groups.indexOf(g);
    if (i < 0) return '';
    const near = groups.slice(Math.max(0, i - NEAR), i + NEAR + 1);
    return `<ol class="msg-near">${near.map((n) => {
      const cur = n === g;
      // This line is marked, not written out again: its text is the page's title and the card above.
      return `<li><button type="button" class="msg-near-row${cur ? ' is-current' : ''}" data-msg-go="${esc(n.key)}"${cur ? ' aria-current="true" disabled' : ''}>
        <span class="msg-near-time">${esc(timeText(n.e))}</span>
        <span class="msg-near-level">${levelCell(n.e.level)}</span>
        ${cur ? `<span class="msg-near-text msg-near-self">${burst(n) ? 'These lines' : 'This line'}</span>`
          : `<span class="msg-near-text"><bdi>${esc(words(n.head))}</bdi>${tailHtml(tailOf(n))}</span>`}
      </button></li>`;
    }).join('')}</ol>`;
  };

  const od = objectDetail<Group>(ctx, {
    collection: 'Messages log', noun: 'line',
    panel, detail: $('#msg-detail'), list: $('#msg-list'), full: $('#msg-full'),
    key: (g) => g.key,
    find: (k) => byKey.get(k),
    order,
    name: (g) => summary(words(g.head)) || '(no text)',
    meta: metaOf,
    // The time, process and count are in the header line; the body has the text, then what the line doesn't say.
    peek: (g) => (burst(g)
      ? `<section class="od-section">
          <div class="msg-section-head"><h3 class="od-section-head">${esc(`${g.kinds.length} different lines`)}</h3>${copyButton}</div>
          ${kindsList(g)}
        </section>
        ${serverTimeRow(g.e).length ? odSection('Details', odKv(serverTimeRow(g.e))) : ''}
        ${odSection('Every line', everyLine(g))}`
      : `<section class="od-section">
          <div class="msg-section-head"><h3 class="od-section-head">Message</h3>${copyButton}</div>
          ${messageBlock(g.head.text)}
        </section>
        ${serverTimeRow(g.e).length ? odSection('Details', odKv(serverTimeRow(g.e))) : ''}
        ${g.entries.length > 1 ? odSection('Every time', repeats(g)) : ''}`),
    loadFull: (g): OdFull => {
      const details = serverTimeRow(g.e);
      const side = [
        ...(details.length ? [{ title: 'Details', body: odKv(details) }] : []),
        ...(!burst(g) && g.entries.length > 1 ? [{ title: 'Every time', body: repeats(g) }] : []),
      ];
      const nearby = !filtered() && groups.length > 1 ? [{ title: 'Around it in the log', body: around(g) }] : [];
      return {
        // No strip: the time, process and count are in the header line, as in the peek.
        strip: [],
        main: burst(g)
          ? [
            { title: `The ${g.kinds.length} different lines`, head: copyButton, body: kindsList(g) },
            { title: 'As written, oldest first', body: messageBlock(rawLines(g), 'Every line as written') },
            ...nearby,
          ]
          : [{ title: 'Message', head: copyButton, body: messageBlock(g.head.text) }, ...nearby],
        side,
      };
    },
    wire: (root, g, where) => {
      root.querySelectorAll<HTMLButtonElement>('[data-msg-copy]').forEach((b) => b.addEventListener('click', () => {
        void navigator.clipboard.writeText(copyText(g)).then(() => {
          b.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
          setTimeout(() => { b.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy'; }, 1600);
        });
      }));
      root.querySelectorAll<HTMLButtonElement>('[data-msg-go]').forEach((b) => b.addEventListener('click', () => void od.openFull(b.dataset.msgGo ?? '')));
      if (where === 'full') wasFull = true;
    },
    onSelect: (k) => {
      grid?.select(k ? [k] : []);
      // Back in the list from the full view (Esc, the breadcrumb): the list scrolls to where it was.
      // Focus lands on its row, not on the page (the breadcrumb that had it is gone).
      if (wasFull && od.mode() === 'list') { wasFull = false; restoreScroll(listScroll, k); if (k) focusRow(k); }
      remember();
    },
    // The process steps aside while the peek is open, so the message keeps its width.
    onPeek: (open) => { grid?.setColumnVisible('Pid', !open); if (!open) remember(); },
  });

  /* ───── Back: the list's place, kept in its history entry ───── */
  const listEl = $('#msg-list');
  const base = `#/${location.hash.replace(/^#\/?/, '').split('/').slice(0, 2).join('/')}`;
  let wasFull = false;
  let listScroll = 0;
  /** Save where the list is (selection, scroll, filters) into this history entry, while it's the list's own. */
  const remember = (): void => {
    if (!alive || listEl.hidden || od.mode() !== 'list' || location.hash !== base) return;
    if (grid && !restoring) listScroll = grid.scrollTop;
    const back: BackState = { sel: od.selected(), scroll: listScroll, filter, query };
    const state = (history.state && typeof history.state === 'object' ? history.state : {}) as Record<string, unknown>;
    try { history.replaceState({ ...state, oscaMessagesLog: back }, '', location.href); } catch { /* state too large or blocked: Back just starts fresh */ }
  };
  /** Scroll the grid back to `top` once its rows are laid out, then make sure the selected row is in view. */
  const restoreScroll = (top: number, key: string | null): void => {
    // Twice: once the rows are in, and again after the grid has windowed in the rows at that offset.
    const go = (): void => {
      if (!grid || listEl.hidden) return;
      grid.scrollTop = top;
      if (key) grid.shadowRoot?.querySelector(`tr[data-row-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    restoring++;
    setTimeout(go, 0);
    setTimeout(() => { go(); restoring--; if (grid) listScroll = grid.scrollTop; remember(); }, 120);
  };
  /** While a restore is in flight the grid's scroll is not the user's: don't save it. */
  let restoring = 0;
  let scrollSave: ReturnType<typeof setTimeout> | undefined;
  // The grid scrolls itself (its host is the scroller); a hidden list reports 0, so only a visible one counts.
  wrap.addEventListener('scroll', (e) => {
    if (!grid || e.target !== grid || listEl.hidden || restoring) return;
    listScroll = grid.scrollTop;
    clearTimeout(scrollSave);
    scrollSave = setTimeout(remember, 200);
  }, true);
  ctx.onLeave(() => clearTimeout(scrollSave));
  // Whatever is about to happen (F, Expand, a link), the list's place is saved first: scroll events
  // arrive a frame late, and a list about to be hidden reads 0.
  const saveFirst = (): void => { if (!listEl.hidden) remember(); };
  document.addEventListener('pointerdown', saveFirst, true);
  document.addEventListener('keydown', saveFirst, true);
  ctx.onLeave(() => { document.removeEventListener('pointerdown', saveFirst, true); document.removeEventListener('keydown', saveFirst, true); });
  /** Arriving by Back (or Forward) at the list: what its history entry kept, applied after the first load. */
  let restore: BackState | null = (() => {
    if (ctx.param) return null;
    const s = (history.state as { oscaMessagesLog?: BackState } | null)?.oscaMessagesLog;
    return s && typeof s === 'object' ? s : null;
  })();
  if (restore) {
    filter = FILTERS.some((f) => f.value === restore?.filter) ? restore.filter : 'all';
    query = typeof restore.query === 'string' ? restore.query : '';
    levelEl.value = filter;
    searchEl.value = query;
  }
  const applyRestore = async (): Promise<void> => {
    const r = restore;
    if (!r || !grid) return;
    restore = null;
    const top = Number(r.scroll) || 0;
    const g = r.sel ? byKey.get(r.sel) : undefined;
    // The peek first (selecting scrolls the row into view), then the list's own offset over it.
    restoring++;
    try { if (g) await od.select(g.key); } finally { restoring--; }
    restoreScroll(top, g?.key ?? null);
    if (g) focusRow(g.key);
  };
  /** Keyboard focus on a row's first cell, after restoreScroll() has put the list back where it was. */
  const focusRow = (key: string): void => {
    setTimeout(() => {
      if (!alive || listEl.hidden) return;
      grid?.shadowRoot?.querySelector<HTMLElement>(`td[data-row-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
    }, 160);
  };

  // J / K step the open peek through the rows, as they step the full view (objectDetail handles that one).
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || od.mode() !== 'list' || !panel.open) return;
    const k = e.key.toLowerCase();
    if (k !== 'j' && k !== 'k') return;
    if (document.querySelector('ev-dialog, .crud-menu')) return;
    const path = e.composedPath() as Element[];
    if (path.some((el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|EV-SEARCH|EV-INPUT|EV-TEXTAREA|EV-SELECT)$/.test(el.tagName)))) return;
    const keys = order();
    const i = keys.indexOf(od.selected() ?? '');
    const to = keys[i < 0 ? 0 : i + (k === 'j' ? 1 : -1)];
    if (to === undefined) return;
    e.preventDefault();
    void od.select(to).then(() => {
      grid?.shadowRoot?.querySelector(`tr[data-row-key="${CSS.escape(to)}"]`)?.scrollIntoView({ block: 'nearest' });
    });
  };
  document.addEventListener('keydown', onKey);
  ctx.onLeave(() => document.removeEventListener('keydown', onKey));

  /* ───── Loading ───── */
  const apply = (r: MessagesLog): void => {
    setEntries(r.entries);
    next = r.next;
    truncated = r.truncated;
    size = r.size;
    file = r.file;
    // New counts from an unfiltered read, or when there are none for this search yet; otherwise keep them.
    if (filter === 'all' || levels === null || levelsQuery !== query) {
      levels = levelsOf(r);
      levelsQuery = query;
    }
  };

  /** Load the newest page for the current filters, replacing what's shown. */
  const reload = async (): Promise<void> => {
    const s = ++seq;
    if (!loaded || loadError) { loadError = null; dropGrid(skeleton(12)); }
    try {
      const r = await getMessagesLog(params());
      if (s !== seq || !alive) return;
      apply(r);
      loadError = null;
      updated(new Date());
    } catch (err) {
      if (s !== seq || !alive) return;
      loadError = err;
    }
    loaded = true;
    render();
    od.refresh();
    void applyRestore();
  };

  /** Refresh: fetch the newest page and merge it in above the lines already shown (older pages stay). */
  const poll = async (): Promise<void> => {
    if (!loaded || loadError || !entries.length) { await reload(); return; }
    const s = seq;
    try {
      const r = await getMessagesLog({ ...params(), countFrom: size });
      if (s !== seq || !alive) return;
      const top = entries[0].offset;
      const overlaps = r.next === null || r.entries.some((e) => e.offset <= top);
      if (r.size < size || !overlaps) {
        // The log was replaced, or more new lines arrived than one page holds: start again from the newest.
        apply(r);
      } else {
        // The newest line shown is fetched again too: lines may have been added under it since.
        // The server counted every line written since the last read (countFrom), whatever the level filter.
        const added = levelsOf(r) ?? countLevels(r.entries.filter((e) => e.offset > top));
        if (levels) levels = levels.map((n, i) => n + (added[i] ?? 0));
        setEntries([...r.entries.filter((e) => e.offset >= top), ...entries.filter((e) => e.offset < top)]);
        size = r.size;
      }
      updated(new Date());
      render();
      od.refresh();
    } catch { /* keep what's shown; the next refresh tries again */ }
  };

  const older = async (): Promise<void> => {
    if (next === null || loadingOlder) return;
    loadingOlder = true;
    renderFoot();
    const s = seq;
    try {
      const r = await getMessagesLog({ ...params(), before: next });
      if (s !== seq || !alive) return;
      const have = new Set(entries.map((e) => e.offset));
      setEntries([...entries, ...r.entries.filter((e) => !have.has(e.offset))]);
      // Older lines extend what the counts cover only on an unfiltered read (a filtered one skips lines).
      if (filter === 'all') {
        const more = levelsOf(r);
        levels = levels && more ? levels.map((n, i) => n + more[i]) : null;
      }
      next = r.next;
      truncated = r.truncated;
    } catch (err) {
      if (s === seq && alive) toast(errorText(err), 'danger');
    } finally {
      loadingOlder = false;
      if (s === seq && alive) render();
    }
  };
  olderBtn.addEventListener('click', () => void older());

  levelEl.addEventListener('ev-segmented-button-change', (e) => {
    filter = (e as CustomEvent<{ value: Filter }>).detail.value;
    remember();
    void reload();
  });
  let typing: ReturnType<typeof setTimeout> | undefined;
  searchEl.addEventListener('ev-search-input', (e) => {
    const v = (e as CustomEvent<{ value: string }>).detail.value.trim();
    clearTimeout(typing);
    typing = setTimeout(() => { if (v !== query) { query = v; remember(); void reload(); } }, 350);
  });
  ctx.onLeave(() => clearTimeout(typing));

  const updated = liveIndicator(ctx, () => void poll(), { every: REFRESH_S });
  let timer: ReturnType<typeof setInterval> | undefined;
  ctx.onLeave(() => clearInterval(timer));

  void apiAvailable().catch(() => false).then((up) => {
    if (!alive) return;
    if (!up) {
      toolbar.hidden = true;
      ctx.fresh.innerHTML = '';
      dropGrid(emptyState({
        icon: 'scroll-text', title: 'The messages log can’t be read here',
        what: 'Reading it needs OSCA Admin’s server module, which isn’t installed on this instance.',
      }));
      return;
    }
    void reload();
    timer = setInterval(() => { if (!document.hidden) void poll(); }, REFRESH_S * 1000);
  });
}

/** Bytes as "66 KB" / "4.2 MB". */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mbv = bytes / (1024 * 1024);
  return `${mbv < 10 ? mbv.toFixed(1) : Math.round(mbv)} MB`;
}
