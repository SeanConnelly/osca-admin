// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Logs › Alerts & errors — system alerts IRIS has raised.
 *
 * IRIS's alert feed is read-once (iris_system_alerts_new: "alerts posted since
 * the last time the Alerts API was read"), so the portal keeps every alert it
 * receives. Alerts delivered before that can't be recovered through any API;
 * when that's the case the screen says so and points at alerts.log.
 *
 * A row opens the same peek and full view as the Messages log (objectDetail):
 * IRIS's whole text, the time to the second, and how often it happened:
 * IRIS's "(repeated N times)" means N more after the first, so the list shows
 * the total as a quiet "· 5 times" and the peek and full view add "(4 folded
 * by IRIS)". One count, one wording, in Alerts and the Messages log alike.
 */
import '../styles-messages.css'; // the peek's text block, "around it" rows and the quiet suffix are the Messages log's
import { alerts, severity } from '../alerts';
import { metrics, value, samples } from '../metrics';
import type { Alert } from '../api';
import {
  esc, relative, when, cell, middle, num, status, setChips, liveIndicator, exportButton, gridExport,
  objectDetail, odMeta, odSection, odKv, type ScreenCtx, type Tone, type OdFull,
} from '../ui';
import { confirm, toast } from '../crud';
import type { DataGridColumn, DataGridRow } from '@evolution-ui/core/components/ev-data-grid/ev-data-grid.js';

/**
 * One filter chip set, as in the Messages log: by level (All / Warnings & up / Severe & up) while the alerts
 * held have more than one level; with one level for all of them, by age instead (All / Last hour / 24 hours /
 * 7 days, the Audit log's ranges).
 */
type Filter = 'all' | 'warning' | 'severe' | '1h' | '24h' | '7d';
const LEVEL_CHIPS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' }, { value: 'warning', label: 'Warnings & up' }, { value: 'severe', label: 'Severe & up' },
];
const TIME_CHIPS: Array<{ value: Filter; label: string; ms: number }> = [
  { value: 'all', label: 'All', ms: Infinity }, { value: '1h', label: 'Last hour', ms: 3600e3 },
  { value: '24h', label: '24 hours', ms: 86400e3 }, { value: '7d', label: '7 days', ms: 7 * 86400e3 },
];
const RANK: Record<'info' | 'warning' | 'danger', number> = { info: 0, warning: 1, danger: 2 };
/** Whether an alert passes the filter (a level chip or an age chip). */
function passes(f: Filter, sev: string, time: string, now: number): boolean {
  if (f === 'all') return true;
  if (f === 'warning' || f === 'severe') return RANK[severity(sev).tone] >= (f === 'warning' ? 1 : 2);
  const t = Date.parse(time);
  return Number.isFinite(t) && now - t <= (TIME_CHIPS.find((c) => c.value === f)?.ms ?? Infinity);
}
type GridEl = HTMLElement & {
  columns: DataGridColumn[]; rows: DataGridRow[];
  select(keys: string[]): void; setColumnVisible(key: string, visible: boolean): void;
};

/** Severity as a small coloured dot plus the word: colour marks it once, without a column of pills. */
const severityCell = (label: string, tone: Tone): string => status(label, tone);

const COLUMNS: DataGridColumn[] = [
  // The logs' one time format: absolute in the cell, the seconds and how long ago in the tooltip.
  // Seconds in the cell, as in the Messages log: alerts often come several a minute.
  { key: 'time', label: 'Time', width: '164px', sortable: true, renderCell: (v) => {
    const d = new Date(String(v));
    return cell.num(when(d, { seconds: true }), `${when(d, { seconds: true })} · ${relative(d)}`);
  } },
  { key: 'severity', label: 'Severity', width: '100px', sortable: true, renderCell: (v) => { const s = severity(String(v)); return severityCell(s.label, s.tone); } },
  { key: 'source', label: 'Source', width: '140px', sortable: true, renderCell: (v) => (v ? cell.mono(v) : cell.dim('—')) },
  // One line each, ellipsis in the cell itself; the full text is in the tooltip. The column takes the
  // leftover width, and the zero-width/100%-min span keeps long text from widening the table.
  // The cell shows a short summary; the tooltip has IRIS's full text. <bdi> keeps any right-to-left
  // text from reordering its neighbours.
  // How often it happened follows as a quiet "· 5 times", as the Messages log shows its repeats.
  { key: 'message', label: 'Message', width: '100%', renderCell: (v, row) =>
    `<span style="display:block;width:0;min-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(row.raw ?? v)}"><bdi>${esc(v)}</bdi>${Number(row.rep) > 0 ? `<span style="color:var(--ev-color-text-tertiary)"><span style="margin:0 6px" aria-hidden="true">·</span>${esc(timesText(Number(row.rep) + 1))}</span>` : ''}</span>` },
];

/**
 * How often something happened, in the one wording the logs share: "5 times" (the total, the first
 * one included). Below 2 there's nothing to say. `folded`: how many of them IRIS wrote as
 * "(repeated N times)" rather than as lines of their own, added where it matters: "5 times (4 folded by IRIS)".
 */
export function timesText(total: number, folded = 0): string {
  if (!(total >= 2)) return '';
  return `${num(total)} times${folded > 0 ? ` (${num(folded)} folded by IRIS)` : ''}`;
}

/**
 * Alert text can arrive as UTF-8 bytes read as Latin-1, sometimes twice over
 * ("Ã\u0098Â®…" for "خطأ", IRIS's localized "ERROR"). While every character
 * fits in a byte and the text holds a lead byte followed by a continuation
 * byte, decode it as UTF-8 (up to twice); anything that doesn't decode cleanly
 * is kept as it was. Then stray C1 controls and U+FFFD are dropped, and
 * right-to-left runs are isolated so they don't pull the neighbouring
 * "#8750" into their direction and scramble the line.
 */
// Code points (the source holds them as literal characters): lead bytes U+00C2–U+00F4, continuation
// bytes U+0080–U+00BF; Hebrew/Arabic blocks U+0590–U+08FF, U+FB1D–U+FDFF, U+FE70–U+FEFE; the
// isolates are U+2068 (first strong isolate) and U+2069 (pop directional isolate).
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
/** "Today 09:12" mid-sentence: "back to today 09:12". */
const midSentence = (s: string): string => s.replace(/^(Today|Yesterday)\b/, (m) => m.toLowerCase());
const MOJIBAKE = /[Â-ô][\u0080-¿]/;
const RTL_RUN = /[֐-ࣿיִ-﷿ﹰ-﻾]+(?:[\s‌‍]+[֐-ࣿיִ-﷿ﹰ-﻾]+)*/g;
function cleanText(raw: string): string {
  let s = raw;
  for (let i = 0; i < 2 && MOJIBAKE.test(s) && ![...s].some((c) => c.charCodeAt(0) > 255); i++) {
    try {
      s = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
    } catch {
      break;
    }
  }
  return s.replace(/[\u0080-\u009f�]/g, '').replace(RTL_RUN, (m) => `${FSI}${m}${PDI}`);
}

/**
 * A short, human summary of an alert. IRIS's diagnostic lines carry $lb(...)
 * dumps, stacks and "ns=… rtn=…" context; keep the sentence after the last
 * "ERROR #nnnn:" (or the leading sentence), prefixed by what raised it.
 *   "ISCLOG: WorkMgr Detach Returning error ns=%SYS … ERROR #7846: WQM attach passed invalid token '…'. *\/"
 *   → "WorkMgr Detach: WQM attach passed invalid token"
 */
function summarize(text: string, hasSource: boolean): { message: string; rep: number } {
  const repeated = /\.\.\.\(repeated (\d+) times?\)\s*$/.exec(text);
  const body = repeated ? text.slice(0, repeated.index) : text;
  const errors = [...body.matchAll(/#\d{3,5}:\s*(.+?)(?=\s*\*\/|\s+ns=|$)/g)]; // after "ERROR #n:", or IRIS's localized word for ERROR
  const context = body.replace(/^ISCLOG:\s*/, '').split(/\s(?:ns|rtn|data)=/)[0].trim();
  let out: string;
  if (errors.length) {
    const reason = errors[errors.length - 1][1]
      .replace(/'[^']{20,}'/g, '')      // long tokens and ids
      .replace(/[\s.:]+$/, '').trim();
    const who = hasSource ? '' : context.replace(/\s+(?:Returning error|Error)(?:\s.*)?$/i, '').replace(/[\s:]+$/, '');
    out = who && !/^error(?:\s|$)/i.test(who) ? `${who}: ${reason}` : reason;
  } else {
    out = context.replace(/[\s:]+$/, '');
  }
  out = shortenPaths(out);
  if (out.length > 160) out = `${out.slice(0, 157)}…`;
  return { message: out, rep: repeated ? Number(repeated[1]) : 0 };
}

/**
 * Long file paths in a summary keep their start and their file name
 * ("c:\intersystems\…\mgr\alerts.log"); the tooltip has the full text.
 */
const PATH = /(?:[a-z]:[\\/]|\/)[^\s'"*]{40,}/gi;
const shortenPaths = (s: string): string => s.replace(PATH, (p) => middle(p, 40));

/**
 * What raised an alert, and its text without that prefix:
 *   "ISCLOG: apimgmnt [Class:Error] …"      → "apimgmnt" (the ISCLOG category)
 *   "ISCLOG: WorkMgr Detach Returning error" → "WorkMgr" (the component that logged it)
 *   "Mount: Found existing DB …"             → "Mount"
 *   "License limit exceeded …"               → "License"
 *   "Process 6168 generated 3 alerts …"      → "Alert limit" (IRIS throttling a process's alerts)
 */
function split(a: Alert): { source: string; message: string; rep: number; raw: string } {
  const text = cleanText(a.message);
  const tagged = /^(?:ISCLOG:\s*)?([\w.%-]+)\s+\[[^\]]*\]\s*(.*)$/.exec(text);
  if (tagged) return { source: tagged[1], ...summarize(tagged[2], true), raw: text };
  const isclog = /^ISCLOG:\s*([A-Za-z][\w.%-]*)\s/.exec(text);
  if (isclog && /#\d{3,5}:/.test(text)) return { source: isclog[1], ...summarize(text, true), raw: text };
  const prefix = /^([A-Z][\w%-]*):\s+([\s\S]*)$/.exec(text);
  if (prefix && prefix[1] !== 'ISCLOG') return { source: prefix[1], ...summarize(prefix[2], true), raw: text };
  const source = /^License limit\b/i.test(text) ? 'License' : /^Process \d+ generated \d+ alerts?\b/i.test(text) ? 'Alert limit' : '';
  return { source, ...summarize(text, false), raw: text };
}

/** The facts IRIS writes into an alert's text: "ns=%SYS rtn=%SYS.WorkQueueMgr", "ERROR #7846:", "Process 6168". */
interface Facts { ns: string; rtn: string; err: string; pid: string }
function factsOf(raw: string): Facts {
  const errs = [...raw.matchAll(/#(\d{3,5}):/g)];
  return {
    ns: /\bns=([^\s"]+)/.exec(raw)?.[1] ?? '',
    rtn: /\brtn=([^\s"]+)/.exec(raw)?.[1] ?? '',
    err: errs.length ? errs[errs.length - 1][1] : '',
    pid: /\bProcess (\d+)\b/.exec(raw)?.[1] ?? /\b(?:pid|job)[=:\s]+(\d+)\b/i.exec(raw)?.[1] ?? '',
  };
}

/** One row of the list: an alert, split for display, keyed for the address. */
interface Row { id: string; time: string; severity: string; source: string; message: string; raw: string; rep: number; facts: Facts }

/** A short, stable key for an alert (its time and text), for the row and the address: "mfk3x2a8-1k9d0z". */
function keyOf(a: Alert): string {
  let h = 5381;
  for (let i = 0; i < a.message.length; i++) h = ((h * 33) ^ a.message.charCodeAt(i)) >>> 0;
  const t = Date.parse(a.time);
  return `${Number.isFinite(t) ? t.toString(36) : 'x'}-${h.toString(36)}`;
}
/**
 * The Alerts list's plain-words summary of a diagnostic line ("WorkMgr: WQM attach passed invalid token"),
 * for the Messages log's severe lines, so one event reads the same on both pages. '' when the text isn't a
 * diagnostic (no "ISCLOG:", "ERROR #n:" or $lb dump): ordinary lines keep their own words.
 */
export function plainWords(text: string): string {
  if (!/^ISCLOG:|#\d{3,5}:|\$lb\(/.test(text)) return '';
  const s = split({ message: text } as Alert);
  if (!s.message || s.message === s.raw) return '';
  return s.source && !s.message.startsWith(s.source) ? `${s.source}: ${s.message}` : s.message;
}
const toRow = (a: Alert): Row => { const s = split(a); return { id: keyOf(a), time: a.time, severity: a.severity, ...s, facts: factsOf(s.raw) }; };

export function alertsScreen(ctx: ScreenCtx): void {
  // One layout with the Messages log: the list fills the page, so the peek does too (see styles-messages.css).
  ctx.fill();
  ctx.body.innerHTML = `
    <div id="alert-list" class="od-list">
      <div class="toolbar-row" id="alert-toolbar">
        <div class="search-box"><ev-search id="alert-search" size="sm" full-width placeholder="Search alerts and sources" aria-label="Search alerts"></ev-search></div>
        <ev-segmented-button id="alert-filter" size="sm" aria-label="Filter alerts"></ev-segmented-button>
      </div>
      <ev-detail-panel id="alert-panel" overlay-below="960" class="workspace">
        <div class="grid-wrap" id="alert-wrap"></div>
        <aside slot="detail" class="detail" id="alert-detail" aria-label="Alert"></aside>
      </ev-detail-panel>
      <p class="table-foot" id="alert-foot"></p>
    </div>
    <div id="alert-full" hidden></div>`;

  const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => ctx.body.querySelector(sel) as T;
  const filterEl = $<HTMLElement & { options: unknown; value: string }>('#alert-filter');
  filterEl.value = 'all';
  const toolbar = $('#alert-toolbar');
  const panel = $<HTMLElement & { open: boolean }>('#alert-panel');
  // "Clear list…" is a labelled header button, away from the counter, shown only while alerts are held.
  ctx.actions.insertAdjacentHTML('beforeend', `<button type="button" class="btn" id="alert-clear" hidden>Clear list…</button>`);
  const moreSlot = ctx.actions.querySelector('#alert-clear') as HTMLButtonElement;
  moreSlot.addEventListener('click', () => void clearList());
  ctx.onLeave(() => moreSlot.remove());
  async function clearList(): Promise<void> {
    const ok = await confirm({
      title: 'Clear the alert list?',
      body: `<p>This removes the ${list.length} alert${list.length === 1 ? '' : 's'} this browser has kept. IRIS hands each alert out only once, so they can’t be shown here again; they stay in alerts.log.</p>`,
      confirmLabel: 'Clear list', danger: true,
    });
    if (!ok) return;
    alerts.clear();
    toast('Alert list cleared.');
  }
  const wrap = $('#alert-wrap');
  let grid: GridEl | null = null;
  // Export: the alerts shown (visible columns, current sort), with IRIS's full text.
  toolbar.append(exportButton(() => gridExport(grid, 'alerts', { values: { message: (r) => r.raw } })));
  let filter: Filter = 'all';
  let query = '';
  let list: Alert[] = [];
  /** Every alert held, by key (the peek and the address answer to any, whatever the filter). */
  let rows: Row[] = [];
  let byKey = new Map<string, Row>();
  let sinceStartup = NaN;
  let logDir = '';

  const dropGrid = (): void => { grid = null; };
  const ensureGrid = (): GridEl => {
    if (grid && grid.isConnected) return grid;
    wrap.innerHTML = '';
    const g = document.createElement('ev-data-grid') as GridEl;
    g.setAttribute('compact', '');
    g.setAttribute('row-select', '');
    g.setAttribute('row-key', 'id');
    g.setAttribute('sort-column', 'time');
    g.setAttribute('sort-direction', 'desc');
    g.setAttribute('aria-label', 'Alerts');
    g.addEventListener('ev-data-grid-row-click', (e) => void od.select(String((e as CustomEvent<{ row: DataGridRow }>).detail.row.id)));
    // While the peek is open it follows the arrow keys, as in the Messages log.
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
    return g;
  };
  const order = (): string[] => {
    const d = grid ? gridExport(grid, '') : null;
    return d ? d.rows.map((r) => String(r.id)) : rows.map((r) => r.id);
  };

  const render = (): void => {
    // One level for every alert: the Severity column says nothing, so the footer says it once, and the
    // chips filter by age instead of by level.
    const levels = new Set(list.map((a) => severity(a.severity).label));
    const oneLevel = levels.size === 1 ? [...levels][0] : '';
    const chips = oneLevel ? TIME_CHIPS : LEVEL_CHIPS;
    if (!chips.some((c) => c.value === filter)) { filter = 'all'; filterEl.value = 'all'; }
    const now = Date.now();
    const count = (f: Filter): number => list.filter((a) => passes(f, a.severity, a.time, now)).length;
    setChips(filterEl, list.length, chips.map((c) => ({
      value: c.value, label: c.label,
      disabled: c.value !== 'all' && c.value !== filter && count(c.value) === 0,
    })), { active: filter, count: (v) => count(v as Filter), search: ctx.body.querySelector<HTMLElement>('#alert-search'), query });
    // Nothing to filter or clear until the portal holds alerts; with none, the
    // explanation below carries the count instead of a row of zeros.
    const held = list.length > 0;
    toolbar.hidden = !held;
    moreSlot.hidden = !held;
    renderFoot(oneLevel);

    const q = query.toLowerCase();
    const shown = rows.filter((r) => passes(filter, r.severity, r.time, now)
      && (!q || [r.source, r.message, r.raw].some((f) => f.toLowerCase().includes(q))));
    if (held && shown.length === 0 && q) {
      dropGrid();
      wrap.innerHTML = `<div class="grid-empty">No alerts match “${esc(query)}”.</div>`;
      return;
    }
    if (shown.length > 0) {
      const g = ensureGrid();
      // Source shows whenever any alert has one; Severity only when levels differ.
      // Both are judged on every alert held, so typing in the filter never makes columns jump.
      const withSource = rows.some((r) => r.source);
      const cols = COLUMNS.filter((c) => (c.key !== 'source' || withSource) && (c.key !== 'severity' || !oneLevel));
      if (g.columns?.map((c) => c.key).join() !== cols.map((c) => c.key).join()) g.columns = cols;
      g.rows = shown as unknown as DataGridRow[];
      const sel = od.selected();
      if (sel) g.select([sel]);
      return;
    }

    dropGrid();
    const missed = Number.isFinite(sinceStartup) ? sinceStartup - list.length : 0;
    const where = logDir ? `<code class="path">${esc(logDir)}alerts.log</code>` : 'alerts.log in the instance’s mgr directory';
    wrap.innerHTML = missed > 0 && list.length === 0
      ? `<div class="empty">
          <div class="empty-main">
            <ev-icon name="info" size="md"></ev-icon>
            <div class="empty-text">
              <strong>IRIS has raised ${missed} alert${missed === 1 ? '' : 's'} since it started — ${missed === 1 ? 'it' : 'they'} can’t be shown here</strong>
              <span class="lead">${missed === 1 ? 'It is' : 'They are'} recorded in ${where}.</span>
              <span>IRIS delivers each alert once, and ${missed === 1 ? 'this one was' : 'these were'} delivered before the portal started keeping them. New alerts appear here within 30 seconds.</span>
            </div>
          </div>
          ${logDir ? `<button type="button" class="btn btn--sm" id="copy-path"><ev-icon name="copy" size="xs"></ev-icon>Copy path</button>` : ''}
        </div>`
      : `<div class="empty">
          <ev-icon name="check-circle" size="md"></ev-icon>
          <div class="empty-text">
            <strong>${list.length === 0 ? 'No alerts' : oneLevel ? 'No alerts in this period' : 'No alerts at this level'}</strong>
            <span>${list.length === 0 ? 'IRIS hasn’t raised an alert since it started. New alerts appear here within 30 seconds.' : 'Choose All to see the rest.'}</span>
          </div>
        </div>`;
    const copy = wrap.querySelector<HTMLButtonElement>('#copy-path');
    copy?.addEventListener('click', () => {
      void navigator.clipboard.writeText(`${logDir}alerts.log`).then(() => {
        copy.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
        setTimeout(() => { copy.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy path'; }, 1600);
      });
    });
  };

  /**
   * "15 alerts · 11 in the last 24 hours · back to yesterday 09:12". The status bar counts the
   * alerts of the last 24 hours (or, with none, those raised since IRIS started), so the footer
   * names both figures and the two never read as a contradiction.
   */
  const renderFoot = (oneLevel: string): void => {
    const foot = $('#alert-foot');
    if (!list.length) { foot.innerHTML = ''; return; }
    const sep = '<span class="meta-sep">·</span>';
    const dayAgo = Date.now() - 86_400_000;
    const recent = list.filter((a) => Date.parse(a.time) >= dayAgo).length;
    const oldest = list.reduce<Date | null>((m, a) => { const d = new Date(a.time); return !m || d < m ? d : m; }, null);
    const parts = [`<span title="Kept by this browser since you last cleared the list"><b>${num(list.length)}</b> ${list.length === 1 ? 'alert' : 'alerts'}</span>`];
    if (recent < list.length) parts.push(recent ? `${num(recent)} in the last 24 hours` : 'none in the last 24 hours');
    if (!recent && Number.isFinite(sinceStartup) && sinceStartup !== list.length) parts.push(`${num(sinceStartup)} raised since IRIS started`);
    if (oneLevel) parts.push(`all ${esc(oneLevel.toLowerCase())}`);
    if (oldest) parts.push(`<span title="${esc(`${when(oldest, { seconds: true })} · ${relative(oldest)}`)}">back to ${esc(midSentence(when(oldest)))}</span>`);
    foot.innerHTML = parts.join(sep);
  };

  /* ───── Peek and full view ───── */
  const copyButton = '<button type="button" class="btn btn--sm btn--quiet" data-alert-copy><ev-icon name="copy" size="xs"></ev-icon>Copy</button>';
  /**
   * IRIS's whole text. In the peek a long diagnostic ($lb dumps, stacks) folds behind "Show raw text": what
   * it says is already in the title and Details. In the full view it's the main content, so it shows open.
   */
  const textBlock = (r: Row, open = false): string => {
    const pre = `<pre class="msg-text" tabindex="0" aria-label="Alert text">${esc(r.raw)}</pre>`;
    return !open && (r.raw.length > 200 || r.raw.includes('\n') || r.raw.includes('$lb('))
      ? `<details class="msg-raw"><summary>Show raw text</summary>${pre}</details>`
      : pre;
  };
  const logRow = (): [string, string] => ['Written to', logDir ? `<code class="path" title="${esc(`${logDir}alerts.log`)}">alerts.log</code>` : 'alerts.log'];
  /** What IRIS wrote into the text, pulled out: error number, namespace, routine (the process is in the header line). */
  const factRows = (r: Row): Array<[string, string]> => {
    const f = r.facts;
    const out: Array<[string, string]> = [];
    if (f.err) out.push(['Error', `<span class="mono">#${esc(f.err)}</span>`]);
    if (f.ns) out.push(['Namespace', `<span class="mono">${esc(f.ns)}</span>`]);
    if (f.rtn) out.push(['Routine', `<span class="mono">${esc(f.rtn)}</span>`]);
    return out;
  };
  /**
   * The header line, the same in the peek and the full view: "● Severe · WorkMgr · Today 09:12:33 ·
   * Process 6168 · 5 times (4 folded by IRIS)". Time, process and count are said here once, not in a strip.
   */
  const metaOf = (r: Row): string => {
    const s = severity(r.severity);
    const d = new Date(r.time);
    const html: string[] = [];
    if (!Number.isNaN(d.getTime())) html.push(`<span title="${esc(relative(d))}">${esc(when(d, { seconds: true }))}</span>`);
    if (r.facts.pid) html.push(`<a class="link" href="#/operations/processes/${esc(r.facts.pid)}" title="Open this process, if it’s still running">Process ${esc(r.facts.pid)}</a>`);
    if (r.rep) html.push(`<span>${esc(timesText(r.rep + 1, r.rep))}</span>`);
    // The source is the title (see name below), so the line doesn't say it again.
    return odMeta({ label: s.label, tone: s.tone }, [], html);
  };
  /** The peek's and full view's title: what raised it ("WorkMgr", "License"), or its level when IRIS doesn't say. */
  const titleOf = (r: Row): string => r.source || `${severity(r.severity).label} alert`;
  /**
   * Whether IRIS's own text says more than the summary: not when it's the summary with only its "Source:" or
   * "ISCLOG:" prefix, spacing or final full stop added. Then the peek shows the message once, as its lead.
   */
  const norm = (t: string): string => t.replace(/^(?:ISCLOG:\s*)?/, '').replace(/[\s.:;]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const rawAddsMore = (r: Row): boolean => {
    const raw = norm(r.raw);
    const msg = norm(r.message);
    return !(raw === msg || (r.source && (raw === norm(`${r.source}: ${r.message}`) || raw === norm(`${r.source} ${r.message}`))));
  };
  const copyText = (r: Row): void => { void navigator.clipboard.writeText(r.raw).then(() => toast('Alert text copied.')); };
  /** In the peek, IRIS's text only when it says more than the lead; always folded, so the message reads once. */
  const rawSection = (r: Row): string => (rawAddsMore(r) ? `<section class="od-section">
          <details class="msg-raw"><summary>Show IRIS’s full text</summary><pre class="msg-text" tabindex="0" aria-label="Alert text">${esc(r.raw)}</pre></details>
        </section>` : '');
  let wasFull = false;
  /** Put keyboard focus on a row's first cell (once the list is showing again), scrolled into view. */
  const focusRow = (key: string): void => {
    const go = (): void => {
      const td = grid?.shadowRoot?.querySelector<HTMLElement>(`td[data-row-key="${CSS.escape(key)}"]`);
      if (!td) return;
      td.scrollIntoView({ block: 'nearest' });
      td.focus({ preventScroll: true });
    };
    setTimeout(go, 0);
    setTimeout(go, 120);
  };
  /** Whether the list shows a Severity column (it doesn't while every alert has the same level). */
  const listHasLevel = (): boolean => !!grid?.columns?.some((c) => c.key === 'severity');
  /** The alerts either side of this one, in the list's own order (newest first unless re-sorted). */
  const around = (r: Row): string => {
    const keys = order();
    const i = keys.indexOf(r.id);
    if (i < 0 || keys.length < 2) return '';
    const near = keys.slice(Math.max(0, i - 3), i + 4).map((k) => byKey.get(k)).filter((x): x is Row => !!x);
    const level = listHasLevel();
    return `<ol class="msg-near${level ? '' : ' msg-near--nolevel'}">${near.map((n) => {
      const cur = n === r;
      const s = severity(n.severity);
      // This alert is marked, not written out again: its text is the page's title and its first card.
      return `<li><button type="button" class="msg-near-row${cur ? ' is-current' : ''}" data-alert-go="${esc(n.id)}"${cur ? ' aria-current="true" disabled' : ''}>
        <span class="msg-near-time">${esc(when(new Date(n.time), { seconds: true }))}</span>
        ${level ? `<span class="msg-near-level">${severityCell(s.label, s.tone)}</span>` : ''}
        ${cur ? '<span class="msg-near-text msg-near-self">This alert</span>'
          : `<span class="msg-near-text"><bdi>${esc(n.message)}</bdi>${n.rep ? `<span class="msg-tail"><span class="msg-tail-sep" aria-hidden="true">·</span>${esc(timesText(n.rep + 1))}</span>` : ''}</span>`}
      </button></li>`;
    }).join('')}</ol>`;
  };

  const od = objectDetail<Row>(ctx, {
    collection: 'Alerts & errors', noun: 'alert',
    panel, detail: $('#alert-detail'), list: $('#alert-list'), full: $('#alert-full'),
    key: (r) => r.id,
    find: (k) => byKey.get(k),
    order,
    // The message is said once: the title names what raised it, the lead says what happened, and IRIS's
    // own text (when it says more) is folded under it. Copy is under ⋯, the same header as every peek.
    name: titleOf,
    meta: metaOf,
    menu: (r) => [{ label: 'Copy IRIS’s text', icon: 'copy', onSelect: () => copyText(r) }],
    peek: (r) => `<p class="msg-lead"><bdi>${esc(r.message || '(no text)')}</bdi></p>
        ${rawSection(r)}
        ${odSection('Details', odKv([...factRows(r), logRow()]))}`,
    loadFull: (r): OdFull => {
      const near = around(r);
      return {
        // No strip: the time, process and count are in the header line, as in the peek.
        strip: [],
        main: [
          { title: 'What IRIS wrote', head: copyButton, body: textBlock(r, true) },
          ...(near ? [{ title: 'Around it in the log', body: near }] : []),
        ],
        side: [{ title: 'Details', body: odKv([...factRows(r), logRow()]) }],
      };
    },
    wire: (root, r, where) => {
      root.querySelectorAll<HTMLButtonElement>('[data-alert-copy]').forEach((b) => b.addEventListener('click', () => {
        void navigator.clipboard.writeText(r.raw).then(() => {
          b.innerHTML = '<ev-icon name="check" size="xs"></ev-icon>Copied';
          setTimeout(() => { b.innerHTML = '<ev-icon name="copy" size="xs"></ev-icon>Copy'; }, 1600);
        });
      }));
      root.querySelectorAll<HTMLDetailsElement>('details.msg-raw').forEach((d) => d.addEventListener('toggle', () => {
        const sum = d.querySelector('summary');
        const what = where === 'peek' ? 'IRIS’s full text' : 'raw text';
        if (sum) sum.textContent = d.open ? `Hide ${what}` : `Show ${what}`;
      }));
      root.querySelectorAll<HTMLButtonElement>('[data-alert-go]').forEach((b) => b.addEventListener('click', () => void od.openFull(b.dataset.alertGo ?? '')));
      if (where === 'full') wasFull = true;
    },
    onSelect: (k) => {
      grid?.select(k ? [k] : []);
      // Back from the full view: focus lands on the alert's row (the breadcrumb that had it is gone).
      if (wasFull && od.mode() === 'list') { wasFull = false; if (k) focusRow(k); }
    },
    // The source steps aside while the peek is open, so the message keeps its width.
    onPeek: (open) => grid?.setColumnVisible('source', !open),
  });

  // J / K step the open peek through the rows (objectDetail steps the full view).
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

  filterEl.addEventListener('ev-segmented-button-change', (e) => { filter = (e as CustomEvent<{ value: Filter }>).detail.value; render(); });
  ctx.body.querySelector('#alert-search')?.addEventListener('ev-search-input', (e) => { query = (e as CustomEvent<{ value: string }>).detail.value.trim(); render(); });

  const updated = liveIndicator(ctx, () => { void alerts.refresh(); void metrics.refresh(); });
  ctx.onLeave(alerts.subscribe((l) => {
    list = l;
    rows = l.map(toRow);
    byKey = new Map(rows.map((r) => [r.id, r]));
    render();
    od.refresh();
  }));
  ctx.onLeave(metrics.subscribe((snap, at) => {
    updated(at);
    sinceStartup = value(snap, 'iris_system_alerts');
    // The IRISSYS database lives in the mgr directory, which is where alerts.log is.
    logDir = samples(snap, 'iris_db_size_mb').find((s) => s.labels.id === 'IRISSYS')?.labels.dir ?? '';
    render();
  }));
}
