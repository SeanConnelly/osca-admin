// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared presentation helpers for portal screens. Every value that came from
 * IRIS goes through esc() before it is placed in markup.
 */

import { serverUtcOffset } from './server-clock';
import { moreButton, moreMenu, blockedAttrs, toast, type MenuItem, type MenuHandle } from './crud';
import { getServerInfo } from './api-osca';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 1234567 → "1.2M", 12345 → "12.3K", 42 → "42". */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** Megabytes → human size. */
export function mb(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} TB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} GB`;
  if (n >= 1) return `${n.toFixed(n >= 100 ? 0 : 1)} MB`;
  return `${Math.round(n * 1024)} KB`;
}

/**
 * Data sizes on the disk screens (Databases, Capacity, Journals): megabytes in,
 * always one decimal — "0.4 MB", "153.0 MB", "62.1 GB" — so the same value
 * reads the same everywhere.
 */
export function dataSize(mbValue: number): string {
  if (!Number.isFinite(mbValue)) return '—';
  if (mbValue >= 1024 * 1024) return `${(mbValue / 1024 / 1024).toFixed(1)} TB`;
  if (mbValue >= 1024) return `${(mbValue / 1024).toFixed(1)} GB`;
  if (mbValue > 0 && mbValue < 0.1) return '< 0.1 MB';
  return `${mbValue.toFixed(1)} MB`;
}
/** Percentages on the disk screens: whole numbers ("74%"), "< 1%" for tiny non-zero values. */
export function dataPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n > 0 && n < 1 ? '< 1%' : `${Math.round(n)}%`;
}

export function pct(n: number, digits = 0): string {
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : '—';
}

/** IRIS "hh:mm:ss" (hours may exceed 24) → "3d 4h", "20h 12m", "4m 10s". */
export function elapsed(hms: string): string {
  const parts = hms.split(':').map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) return hms;
  const secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return duration(secs);
}

export function duration(secs: number): string {
  if (!Number.isFinite(secs)) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  // Two units at most, and never a trailing zero unit ("14h", not "14h 0m").
  const two = (a: number, ua: string, b: number, ub: string): string => (b ? `${a}${ua} ${b}${ub}` : `${a}${ua}`);
  if (d > 0) return two(d, 'd', h, 'h');
  if (h > 0) return two(h, 'h', m, 'm');
  if (m > 0) return two(m, 'm', s, 's');
  return `${s}s`;
}

/**
 * Time until / since a date in ONE rounded unit: "now", "in 24m", "5m ago",
 * "in 22h", "3d ago". Under a minute is "now"; under an hour, minutes; under
 * 48 hours, hours; then days. Put the exact time in a title (see when()).
 */
export function relative(date: Date, now = new Date()): string {
  const diff = (date.getTime() - now.getTime()) / 1000;
  if (!Number.isFinite(diff)) return '—';
  const abs = Math.abs(diff);
  if (abs < 60) return 'now';
  const m = Math.round(abs / 60);
  const text = m < 60 ? `${m}m`
    : abs < 48 * 3600 ? `${Math.max(1, Math.round(abs / 3600))}h`
      : `${Math.round(abs / 86400)}d`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/**
 * A future run: "Tomorrow 00:00" in primary text plus " · in 22h" in tertiary,
 * with the exact date-time in the title. Past events use when() alone (never
 * both an absolute and a relative time for something that already happened).
 * Returns HTML; `plain` gives the same as text ("Tomorrow 00:00 · in 22h").
 */
export function future(date: Date, now = new Date()): string {
  if (Number.isNaN(date.getTime())) return '—';
  const abs = when(date, {}, now);
  const rel = relative(date, now);
  return `<span class="future" title="${esc(date.toLocaleString())}" style="white-space:nowrap"><span style="color:var(--ev-color-text-primary)">${esc(abs)}</span><span style="color:var(--ev-color-text-tertiary)"> · ${esc(rel)}</span></span>`;
}

/**
 * The one absolute date-time format for grids and panels, always 24-hour:
 * "Today 01:30", "Yesterday 23:10", "Tomorrow 00:00", "Sep 24, 01:30",
 * and the year only when it isn't this year ("Sep 24 2025, 01:30").
 * Pass `seconds` where seconds matter (audit records).
 */
export function when(date: Date, opts: { seconds?: boolean } = {}, now = new Date()): string {
  if (Number.isNaN(date.getTime())) return '—';
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: opts.seconds ? '2-digit' : undefined, hour12: false });
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const delta = Math.round((day(date) - day(now)) / 86_400_000);
  if (delta === 0) return `Today ${time}`;
  if (delta === -1) return `Yesterday ${time}`;
  if (delta === 1) return `Tomorrow ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const d = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
  return `${d}, ${time}`;
}

/** Full number with thousands separators: the format for grid cells (abbreviate only in stat tiles). */
export function num(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : '—';
}

/** "1 database", "1,204 databases": the count as num() writes it, then the word. */
export const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;

/** Plain text in the monospace face (escaped). */
export const mono = (s: unknown): string => `<span class="mono">${esc(s)}</span>`;

/** One row of a `<dl class="kv-list">`. The key is plain text (escaped here); the value is HTML the caller escaped; `title` is its tooltip. */
export const kv = (k: string, v: string, title = ''): string =>
  `<div class="kv"><dt>${esc(k)}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${v}</dd></div>`;

/** True for an IRIS timestamp ("2026-09-27 14:05:00"), false for "", "Never" and other words in a date field. */
export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s);

/** A small button that opens a classic Management Portal page in a new tab. */
export const portalButton = (href: string, label: string): string =>
  `<a class="btn btn--sm" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;

/**
 * Drop columns that carry nothing: every visible row has the same value, or
 * the column is empty ("", null, "—") or 0 on every row (even a single row). A column is kept when it is
 * in `keep` (the active sort, an active filter, the identifier…). Returns the
 * columns to show plus the keys that were dropped, so the screen can say the
 * fact once in its footer ("CPU not sampled", "all in IRISLOCALDATA").
 * Needs at least 2 rows to judge "the same"; an all-empty column goes with 1.
 */
export function pruneColumns<C extends { key: string }>(
  rows: Array<Record<string, unknown>>, cols: C[], opts: { keep?: string[] } = {},
): { columns: C[]; dropped: string[] } {
  const keep = new Set(opts.keep ?? []);
  const empty = (v: unknown): boolean => v === null || v === undefined || String(v).trim() === '' || String(v).trim() === '—';
  const dropped: string[] = [];
  const columns = cols.filter((c) => {
    if (keep.has(c.key) || !rows.length) return true;
    const vals = rows.map((r) => r[c.key]);
    // Empty everywhere, or a count that is 0 on every row (Roles "Includes roles").
    const allEmpty = vals.every(empty) || vals.every((v) => v === 0 || (typeof v === 'string' && /^\s*0\s*$/.test(v)));
    const same = rows.length >= 2 && vals.every((v) => String(v ?? '') === String(vals[0] ?? ''));
    if (allEmpty || same) { dropped.push(c.key); return false; }
    return true;
  });
  return { columns, dropped };
}

/**
 * One status mark per row. A row's normal state gets no mark; an off row
 * (disabled, stopped) renders all its text tertiary (wrap each cell with
 * rowText(off, html)); only an exception carries a dot or pill (chip()).
 */
export function rowText(off: boolean, html: string): string {
  return off ? `<span style="display:block;color:var(--ev-color-text-tertiary)">${html}</span>` : html;
}

/**
 * Filter chips: hide the whole group on a list of 5 rows or fewer (chips can't
 * help there), and hide a zero-count chip for a risk state (At risk, Failed,
 * Needs attention) instead of dimming it. `risk` names those option values.
 * Returns the options to show (the active one is always kept) and whether the
 * group should be hidden: `el.hidden = r.hide`.
 */
export function chipOptions<O extends { value: string; label: string; disabled?: boolean }>(
  total: number, options: O[], opts: { active?: string; risk?: string[]; count?: (value: string) => number } = {},
): { options: O[]; hide: boolean } {
  const risk = new Set(opts.risk ?? []);
  const countOf = (o: O): number => {
    if (opts.count) return opts.count(o.value);
    const m = /(\d[\d,]*)\s*$/.exec(o.label);
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  };
  const shown = options.filter((o) => o.value === opts.active || !risk.has(o.value) || countOf(o) !== 0);
  return { options: shown, hide: total <= 5 && !(opts.active && opts.active !== options[0]?.value) };
}

/**
 * Apply chipOptions() to an ev-segmented-button in one call:
 *   setChips(scopeEl, all.length, [{ value: 'all', label: `All ${n}` }, …], { active: scope, risk: ['failed'] });
 * Sets the options and value, and hides the group on tiny lists.
 */
export function setChips<O extends { value: string; label: string; disabled?: boolean }>(
  el: HTMLElement, total: number, options: O[],
  opts: { active?: string; risk?: string[]; count?: (value: string) => number; search?: HTMLElement | null; query?: string } = {},
): void {
  const r = chipOptions(total, options, opts);
  const seg = el as HTMLElement & { options: O[]; value: string };
  seg.options = r.options;
  if (opts.active !== undefined) seg.value = opts.active;
  el.hidden = r.hide;
  if (opts.search) {
    const filtered = opts.active !== undefined && opts.active !== options[0]?.value;
    setSearch(opts.search, total, { query: opts.query, filtered });
  }
}

/** Below this many rows a list gets no search box (unless something is being filtered). */
export const SEARCH_MIN_ROWS = 12;

/**
 * Short-list rule: no search box on a list of fewer than 12 rows, unless the
 * user has typed a query or another filter is active (so they can always
 * clear it). Pass the ev-search or its .search-box wrapper; the wrapper hides.
 *   setSearch(searchEl, all.length, { query, filtered: scope !== 'all' });
 */
export function setSearch(el: HTMLElement, total: number, opts: { query?: string; filtered?: boolean } = {}): void {
  const box = (el.closest('.search-box') as HTMLElement | null) ?? el;
  box.hidden = total < SEARCH_MIN_ROWS && !(opts.query ?? '').trim() && !opts.filtered;
  // A toolbar row left with nothing visible must not keep its height (an empty band above the list).
  const row = box.parentElement;
  if (row && row !== document.body) {
    // Spacers and empty placeholders don't count: only something with content or a control keeps the row.
    const anyShown = [...row.children].some((c) => {
      const h = c as HTMLElement;
      if (h.hidden || getComputedStyle(h).display === 'none' || h.classList.contains('toolbar-spacer')) return false;
      return !!h.textContent?.trim() || !!h.querySelector('input, select, button, ev-segmented-button, ev-toggle') || /^(INPUT|SELECT|BUTTON|EV-)/.test(h.tagName);
    });
    row.style.display = anyShown ? '' : 'none';
  }
}

/** Keys whose value is identical on every row: candidates to hide, so grid width goes to columns that differ. */
export function uniformKeys<T extends object>(rows: T[], keys: (keyof T)[]): Set<keyof T> {
  const out = new Set<keyof T>();
  if (rows.length < 2) return out;
  for (const k of keys) if (rows.every((r) => String(r[k] ?? '') === String(rows[0][k] ?? ''))) out.add(k);
  return out;
}

/**
 * View tabs: switch between different datasets on one screen (e.g. "TLS
 * configurations" / "X.509 credentials", "Records" / "Events"). They sit on
 * their own row above the toolbar, so they never look like the segmented
 * filters, which only narrow the rows. Returns the markup; wire it with
 * bindViewTabs().
 */
export function viewTabs(id: string, tabs: { value: string; label: string; count?: number }[], active: string): string {
  return `<div class="view-tabs" id="${id}" role="tablist">${tabs.map((t) => `<button type="button" role="tab" data-value="${esc(t.value)}" aria-selected="${t.value === active}">${esc(t.label)}<span class="view-tab-count"${t.count === undefined ? ' hidden' : ''}>${t.count === undefined ? '' : num(t.count)}</span></button>`).join('')}</div>`;
}

export function bindViewTabs(root: ParentNode, id: string, onChange: (value: string) => void): void {
  const bar = root.querySelector(`#${id}`);
  const buttons = [...(bar?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
  for (const b of buttons) {
    b.addEventListener('click', () => {
      for (const o of buttons) o.setAttribute('aria-selected', String(o === b));
      onChange(b.dataset.value ?? '');
    });
  }
  bar?.addEventListener('keydown', (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== 'ArrowRight' && k !== 'ArrowLeft') return;
    const i = buttons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    const next = buttons[(i + (k === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });
}

/** Update a tab's count after data loads. */
export function setViewTabCount(root: ParentNode, id: string, value: string, count: number): void {
  const el = root.querySelector(`#${id} button[data-value="${value}"] .view-tab-count`);
  if (el) { el.textContent = num(count); (el as HTMLElement).hidden = false; }
}

/** IRIS "YYYY-MM-DD HH:MM:SS" (server local time) → Date. */
export function irisDate(s: string): Date {
  // A time with its own zone ("…Z", "…+01:00") is read as it is.
  if (/(?:Z|[+-]\d\d:?\d\d)$/.test(s.trim())) return new Date(s.trim().replace(' ', 'T'));
  // Otherwise it is the server's local time: place it with the server's offset (see server-clock.ts).
  const off = serverUtcOffset();
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?)?$/.exec(s.trim());
  if (off === null || !m || m[4] === undefined) return new Date(s.replace(' ', 'T'));
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms) - off * 60_000);
}

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

/* Dot colours come from the --st-dot-* tokens (styles.css), so the light theme can give dots a
   brighter amber than its warning TEXT colour. Info is not a state colour: it reads as success. */
const DOT: Record<Tone, string> = {
  success: 'var(--st-dot-success, var(--ev-color-success))',
  info: 'var(--st-dot-success, var(--ev-color-success))',
  neutral: 'var(--st-dot-neutral, var(--ev-color-text-tertiary))',
  warning: 'var(--st-dot-warning, var(--ev-color-warning))',
  danger: 'var(--st-dot-danger, var(--ev-color-danger))',
};

/**
 * Expected state as a 6px dot plus a plain word ("● Enabled"): the way normal
 * state reads everywhere. Pills are kept for exceptions (see chip()).
 * `dim` sets the word in tertiary text, for switched-off states.
 * Styles are inline because grid cells render in ev-data-grid's shadow DOM.
 */
export function status(text: string, tone: Tone = 'neutral', title = '', opts: { dim?: boolean } = {}): string {
  const color = opts.dim ? 'var(--ev-color-text-tertiary)' : 'var(--ev-color-text-secondary)';
  return `<span class="st" data-tone="${tone}" style="display:inline-flex;align-items:center;gap:6px;max-width:100%;white-space:nowrap;vertical-align:middle;color:${color}"${title ? ` title="${esc(title)}"` : ''}>`
    + `<i aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:${DOT[tone]};flex:none"></i>`
    + `<span style="overflow:hidden;text-overflow:ellipsis">${esc(text)}</span></span>`;
}

/** Switched-off states that read as a quiet grey dot rather than a tag pill. */
const OFF_WORDS = new Set([
  'disabled', 'stopped', 'off', 'service off', 'not running', 'not mounted', 'not encrypted',
  'not configured', 'interoperability disabled', 'inactive',
]);

/**
 * The one status/tag helper. Success and info are normal state, so they render
 * as status() (dot + word). Warning and danger stay tinted pills: they are the
 * exceptions a scan should find. Neutral stays a tag pill (Chained, %All,
 * private…), except switched-off words (Disabled, Stopped, Off…), which become
 * a grey dot with tertiary text.
 */
export function chip(text: string, tone: Tone = 'neutral', title = ''): string {
  if (tone === 'success' || tone === 'info') return status(text, tone, title);
  if (tone === 'neutral' && OFF_WORDS.has(String(text).trim().toLowerCase())) return status(text, 'neutral', title, { dim: true });
  return `<ev-chip size="sm" tone="${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</ev-chip>`;
}

/** A role as a neutral chip that opens it; the screen handles clicks on `[data-role]`. */
export const roleLink = (name: string, title = 'Open this role'): string =>
  `<button type="button" class="chip-link" data-role="${esc(name)}" aria-label="Open role ${esc(name)}">${chip(name, 'neutral', title)}</button>`;

/** Always a pill, whatever the tone: for the rare place a tag must look like a tag (e.g. a count badge). */
export function pill(text: string, tone: Tone = 'neutral', title = ''): string {
  return `<ev-chip size="sm" tone="${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</ev-chip>`;
}

/** 12px external-link mark for links that leave the portal (docs, the Management Portal). */
export const EXT_ICON = '<ev-icon class="ext-icon" name="arrow-up-right" size="xs" aria-hidden="true" style="width:12px;height:12px;margin-left:2px;vertical-align:-1px"></ev-icon>';

/** A link out of the portal (documentation): accent text, a small arrow-up-right mark, new tab. */
export function extLink(href: string, label: string, cls = 'help-more', title = ''): string {
  return `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}${EXT_ICON}</a>`;
}

/**
 * Grid cells render inside ev-data-grid's shadow DOM, out of reach of the page
 * stylesheet, so cell formatting is carried inline on design tokens.
 */
const NOWRAP = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;';
// On Windows, Consolas sits ~2px above the UI font's baseline in a centred cell (--mono-nudge, set in main.ts);
// the nudge moves the whole box (its clip too), so the text lines up and nothing (an underscore) is cut off.
const MONO = 'font-family:var(--ev-font-family-mono);font-size:12.5px;line-height:1.4;position:relative;top:var(--mono-nudge, 0px);';
/** Pure numbers (PIDs, ports, device numbers) are never mono: sans, tabular. */
const isNumber = (v: unknown): boolean => /^\s*-?\d[\d,.]*\s*$/.test(String(v ?? ''));
/** "0", "0.0", "0 KB"… : a zero that should read quietly. */
const isZero = (v: unknown): boolean => /^\s*0+(?:[.,]0+)?(?:\s*[%a-zA-Z/]+)?\s*$/.test(String(v ?? ''));
const numCell = (v: unknown, title: string): string =>
  `<span style="${NOWRAP}font-variant-numeric:tabular-nums;color:var(--ev-color-text-secondary)"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`;

/**
 * The row's identifier (first column), when it is a code name (routine, global,
 * path, class): mono 400, primary text. Identity comes from colour, not weight
 * (500 renders bold with Cascadia / Consolas on Windows). No grid cell is bold.
 * Plain-word names (users, roles) use cell.text instead.
 */
export function cellId(text: unknown, title = ''): string {
  if (isNumber(text)) return numCell(text, title);
  return `<span style="${NOWRAP}${MONO}font-weight:var(--mono-weight, 400);color:var(--ev-color-text-primary)"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

/**
 * Any other code value in a grid (a routine, database, session id, path):
 * mono 400 in secondary text; accent when it links to something (`href`).
 * Numbers render sans tabular instead.
 */
export function cellRef(text: unknown, href?: string, title = ''): string {
  if (!href && isNumber(text)) return numCell(text, title);
  const t = title ? ` title="${esc(title)}"` : '';
  return href
    ? `<a href="${esc(href)}" style="${NOWRAP}${MONO}font-weight:var(--mono-weight, 400);color:var(--ev-accent-11, var(--ev-color-primary));text-decoration:none"${t}>${esc(text)}</a>`
    : `<span style="${NOWRAP}${MONO}font-weight:var(--mono-weight, 400);color:var(--ev-color-text-secondary)"${t}>${esc(text)}</span>`;
}

export const cell = {
  /**
   * Monospace reference (same as cellRef): 12.5px/400, secondary text; numbers
   * are sans tabular. `muted` is kept for compatibility (it no longer changes
   * anything). The row's identifier uses cell.id / cellId.
   */
  mono: (v: unknown, _muted = false, title = ''): string => cellRef(v, undefined, title),
  /** The row's primary identifier in mono (first column): 400 weight, primary text. */
  id: (v: unknown, title = ''): string => cellId(v, title),
  ref: (v: unknown, href?: string, title = ''): string => cellRef(v, href, title),
  text: (v: unknown, title = ''): string => `<span style="${NOWRAP}"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`,
  /** A number cell (tabular). A zero count reads quietly: "0" renders in tertiary text. */
  num: (text: string, title = ''): string => `<span style="${NOWRAP}font-variant-numeric:tabular-nums${isZero(text) ? ';color:var(--ev-color-text-tertiary)' : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`,
  /** A count: grouped digits, tertiary when 0. */
  count: (n: number, title = ''): string => cell.num(num(n), title),
  dim: (text: string): string => `<span style="${NOWRAP}color:var(--ev-color-text-tertiary)">${esc(text)}</span>`,
  wrap: (text: string): string => `<span style="white-space:normal;line-height:1.45">${esc(text)}</span>`,
};

/**
 * Compact headline figure: label, value (+ unit / caption on the same line),
 * and either a capacity bar (percentages) or a trend line (counts/rates).
 * The trend only draws once there is movement to show; a flat line reads as
 * broken, so a steady series shows nothing rather than a line on the floor.
 */
export function statTile(key: string, label: string, kind: 'bar' | 'trend' | 'plain'): string {
  return `<div class="stat" data-stat="${key}" data-kind="${kind}">
    <div class="stat-label"><span class="stat-dot"></span>${esc(label)}</div>
    <div class="stat-line"><span class="stat-value">—</span><span class="stat-caption"></span></div>
    ${kind === 'bar' ? '<div class="bar stat-bar"><span></span></div>' : ''}
    ${kind === 'trend' ? `<span class="stat-trend spark-slot">${sparkline([], { height: 20 })}</span>` : ''}
  </div>`;
}

export interface StatUpdate {
  value: string;
  caption?: string;
  tone?: Tone;
  /** 0–100 for bar tiles. */
  fill?: number;
  trend?: number[];
  title?: string;
}

export function setStat(root: ParentNode, key: string, u: StatUpdate): void {
  const el = root.querySelector<HTMLElement>(`[data-stat="${key}"]`);
  if (!el) return;
  el.dataset.tone = u.tone ?? 'neutral';
  (el.querySelector('.stat-value') as HTMLElement).textContent = u.value;
  (el.querySelector('.stat-caption') as HTMLElement).textContent = u.caption ?? '';
  if (u.title) el.title = u.title;
  const bar = el.querySelector<HTMLElement>('.stat-bar span');
  if (bar && u.fill !== undefined) bar.style.width = `${Math.max(0, Math.min(100, u.fill))}%`;
  const trend = el.querySelector<HTMLElement>('.stat-trend');
  if (trend && u.trend) {
    const tone = u.tone === 'danger' ? 'danger' : u.tone === 'warning' ? 'warning' : 'primary';
    const html = sparkline(u.trend, { height: 20, tone });
    if (trend.tagName === 'EV-SPARKLINE') trend.outerHTML = `<span class="stat-trend spark-slot">${html}</span>`;
    else trend.innerHTML = html;
  }
}

/**
 * The one sparkline: an inline SVG that fills its slot's width.
 * - Fewer than 6 samples: only the 1px baseline (the slot keeps its height).
 * - Y from 0 to max × 1.15; an all-zero series lies on the baseline.
 * - 1.5px line, round joins, no fill, and a 4px dot on the latest point.
 * Colour: `tone`, or the slot's `--spark-color`. Heights: 20 (KPI tiles,
 * peeks) or 28 (Activity). Put it in a `.spark-slot` (or any sized box).
 */
export function sparkline(values: number[], opts: { height?: 20 | 28; tone?: 'primary' | 'warning' | 'danger' } = {}): string {
  const H = opts.height ?? 20;
  const W = 100;
  const vals = values.filter((v) => Number.isFinite(v));
  const tone = opts.tone && opts.tone !== 'primary' ? ` data-tone="${opts.tone}"` : '';
  const base = `<path class="spark-base" d="M0,${H - 0.5}L${W},${H - 0.5}" vector-effect="non-scaling-stroke"/>`;
  const open = `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px"${tone} aria-hidden="true">`;
  if (vals.length < 6) return `${open}${base}</svg>`;
  const top = Math.max(...vals) * 1.15;
  const y = (v: number): number => (top > 0 ? (H - 1) - (Math.max(0, v) / top) * (H - 3) : H - 1);
  const x = (i: number): number => (vals.length === 1 ? W : (i / (vals.length - 1)) * W);
  const pts = vals.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const last = pts[pts.length - 1];
  return `${open}${base}<path class="spark-line" d="M${pts.join('L')}" vector-effect="non-scaling-stroke"/><path class="spark-dot" d="M${last}L${last}" vector-effect="non-scaling-stroke"/></svg>`;
}

/** Middle-truncate long generated names: "%SYS.sqlcq.uEoUGE…ZuFAR.1". */
export function middle(text: string, max = 30): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep * 0.6))}…${text.slice(-Math.floor(keep * 0.4))}`;
}

/** Skeleton rows standing in for a table or list while data loads. */
export function skeleton(rows = 6): string {
  return `<div class="skeleton-list" role="status" aria-label="Loading">${
    Array.from({ length: rows }, () => '<ev-skeleton shape="text" lines="1"></ev-skeleton>').join('')
  }</div>`;
}

/** Inline error with a retry action. */
/** Inline error; pass retryId to offer a "Try again" button the caller wires up. */
export function errorPanel(err: unknown, retryId?: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `<div class="panel-error" role="alert">
    <ev-icon name="alert-triangle" size="sm"></ev-icon>
    <div><strong>Couldn't load this data.</strong><span>${esc(message)}</span></div>
    ${retryId ? `<button type="button" class="btn" id="${retryId}">Try again</button>` : '<span class="dim">Retrying automatically…</span>'}
  </div>`;
}

/**
 * Everything a screen needs from the shell: its body, a slot for header
 * actions, and a way to register cleanup (timers, subscriptions) that runs
 * when the user navigates away.
 */
export interface ScreenCtx {
  body: HTMLElement;
  actions: HTMLElement;
  /** Fixed-width freshness slot in the status bar, cleared on every navigation (see liveIndicator). */
  fresh: HTMLElement;
  /** Page-level warning banners: directly under the title, above the page help. */
  banners: HTMLElement;
  onLeave(fn: () => void): void;
  /** Register a check that runs before navigating away; resolve false to stay (e.g. unsaved edits). */
  beforeLeave(fn: (() => Promise<boolean>) | null): void;
  navigate(id: string): void;
  /** Replace the page title / subtitle (HTML, caller-escaped). */
  heading(title: string, subtitle?: string): void;
  /** Mark the screen as a full-height workspace (grid + panel) with one scroll owner; fill(false) returns to a normal scrolling page (e.g. a full-page detail view). */
  fill(on?: boolean): void;
  /** The item named in the address after the screen ("#/operations/processes/6168" → "6168"), if any. */
  param?: string;
  /** Put an item in the address (or clear it with null) without re-rendering; Back/Forward re-open the screen on it. */
  setParam?(p: string | null): void;
}

/**
 * Freshness indicator plus a refresh button, shown in the status bar's
 * fixed-width page slot (ctx.fresh), so the page header stays free for the
 * page's own actions ("New user") and nothing moves as the text ticks.
 * One shape everywhere: "[dot] Updated 4s ago [refresh]". Polling screens get
 * a softly pulsing green dot; screens that only refresh on demand pass
 * `{ live: false }` and get a grey dot. Pass `every` (seconds) to name the
 * polling interval in the tooltip. R refreshes the page (outside text fields).
 * A system-wide status chip (e.g. "Task Manager running") passed as `status`
 * goes in the header.
 */
export function liveIndicator(ctx: ScreenCtx, refresh: () => void, opts: { live?: boolean; status?: string; every?: number } = {}): (at: Date) => void {
  const live = opts.live ?? true;
  if (opts.status) {
    ctx.actions.querySelector('#header-status')?.remove();
    ctx.actions.insertAdjacentHTML('afterbegin', `<span class="header-status" id="header-status">${opts.status}</span>`);
  }
  const tip = live
    ? (opts.every ? `Refreshes every ${opts.every} s` : 'Refreshes automatically') + ' · press R to refresh now'
    : 'Snapshot · press R to refresh';
  ctx.fresh.innerHTML = `
    <span class="live${live ? '' : ' live--manual'}" title="${tip}"><span class="live-dot${live ? ' live-dot--pulse' : ' live-dot--off'}" aria-hidden="true"></span><span class="live-text"></span></span>
    <ev-icon-button icon="refresh-cw" label="Refresh now (R)" size="sm"></ev-icon-button>`;
  const text = ctx.fresh.querySelector('.live-text') as HTMLElement;
  ctx.fresh.querySelector('ev-icon-button')?.addEventListener('click', refresh);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    // Only when nothing that takes typing (or a dialog) has focus.
    const path = e.composedPath() as HTMLElement[];
    if (path.some((el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || /^(EV-SEARCH|EV-INPUT|EV-TEXTAREA|EV-SELECT|EV-COMBO-BOX|EV-DIALOG|EV-COMMAND-PALETTE|EV-DRAWER)$/.test(el.tagName) || el.tagName === 'FORM' || el.getAttribute?.('role') === 'dialog'))) return;
    e.preventDefault();
    refresh();
  };
  document.addEventListener('keydown', onKey);
  let last: Date | null = null;
  const tick = (): void => {
    if (!last) return;
    const s = Math.max(0, Math.round((Date.now() - last.getTime()) / 1000));
    // Always "Updated Ns ago": the number sits in a fixed box ("0s" is as wide as "100s"),
    // so the text never changes width while it ticks. Past a minute it counts whole minutes, then hours.
    const n = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
    text.innerHTML = `Updated <span class="ago-n">${n} ago</span>`;
  };
  const timer = setInterval(tick, 1000);
  ctx.onLeave(() => { clearInterval(timer); document.removeEventListener('keydown', onKey); });
  return (at: Date) => { last = at; tick(); };
}

/** OSCA Admin mark: the OSCA suite tile (rounded square, suite blue) with a status ring — an O for OSCA
 *  with one amber segment for "something needs you". Drawn on a 16-pixel grid so it stays crisp at
 *  favicon size. Brand colours are fixed, not themed. */
export const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 16 16" aria-hidden="true">
  <rect width="16" height="16" rx="3.5" fill="#2f6bf0"/>
  <circle cx="8" cy="8" r="4.4" fill="none" stroke="#ffffff" stroke-width="2.6"/>
  <path d="M8 3.6a4.4 4.4 0 0 1 4.2 3.1" fill="none" stroke="#f5a524" stroke-width="2.6"/>
</svg>`;

/**
 * A grid column with a header tooltip. `description` is supported by the
 * Evolution UI source (rendered as the header's title); this type carries it
 * until the library's published typings catch up.
 */
export type GridColumn = import('@evolution-ui/core/components/ev-data-grid/ev-data-grid.js').DataGridColumn & { description?: string };

/**
 * The one permission vocabulary used everywhere (grids, Grants, editors,
 * previews): Read, Read & change (Write always includes Read), Use.
 * The raw code (e.g. %DB_USER:RW) is secondary detail, never the main line.
 */
export function permWords(perms: string): string[] {
  const p = String(perms ?? '').toUpperCase();
  const out: string[] = [];
  if (p.includes('W')) out.push('Read & change');
  else if (p.includes('R')) out.push('Read');
  if (p.includes('U')) out.push('Use');
  return out;
}
export function permChips(perms: string): string {
  return permWords(perms).map((w) => `<span class="perm-chip" data-perm="${w === 'Use' ? 'use' : w === 'Read' ? 'read' : 'write'}">${w}</span>`).join('');
}

/* ── Shared page pieces for the Security section (one look everywhere) ── */

export interface ModelStep { label: string; sub?: string; route?: string; here?: boolean; /** Tooltip, e.g. the exact resource name behind a plain label. */ title?: string }
/**
 * The on-page model line: "Way in → sign-in → User → Roles → Resources → …",
 * with "you are here" highlighted and steps that have their own screen as links.
 * Place it directly under the page banners, above the toolbar.
 */
export function modelLine(steps: ModelStep[], verbs: string[] = [], docs?: { href: string; label: string }): string {
  const step = (s: ModelStep): string => {
    const inner = `<b>${esc(s.label)}</b>${s.sub ? `<span>${esc(s.sub)}</span>` : ''}`;
    const cls = `model-step${s.here ? ' here' : ''}`;
    const tip = s.title ? ` title="${esc(s.title)}"` : '';
    return s.route && !s.here ? `<a class="${cls} model-link" href="#/${esc(s.route)}"${tip}>${inner}</a>` : `<div class="${cls}"${tip}${s.here ? ' aria-current="page"' : ''}>${inner}</div>`;
  };
  const parts: string[] = [];
  steps.forEach((s, i) => {
    parts.push(step(s));
    if (i < steps.length - 1) parts.push(`<div class="model-arrow" aria-hidden="true"><span>${esc(verbs[i] ?? '')}</span></div>`);
  });
  return `<div class="model-line"><div class="model" role="img" aria-label="${esc(steps.map((s) => s.label).join(' → '))}">${parts.join('')}</div>${docs ? extLink(docs.href, docs.label, 'help-more model-docs') : ''}</div>`;
}

/**
 * The one empty state, optically centred in its list box: a 40px icon tile,
 * a short title ("No locks right now", "OAuth isn't set up"), one sentence,
 * then at most one in-app secondary action (never a second primary: the header
 * owns that) and a "Learn more" docs link. Hide filters while a list is empty.
 *
 * `action` is caller-built markup (kept for existing screens); `button` is the
 * simpler form: a secondary button the caller wires up by id. `why` is kept
 * for compatibility; prefer one sentence in `what`.
 */
export function emptyState(o: {
  icon: string; title: string; what: string; why?: string; action?: string;
  button?: { id: string; label: string; icon?: string };
  docs?: { href: string; label: string };
}): string {
  const button = o.button
    ? `<button type="button" class="btn" id="${esc(o.button.id)}">${o.button.icon ? `<ev-icon name="${esc(o.button.icon)}" size="xs"></ev-icon>` : ''}${esc(o.button.label)}</button>`
    : '';
  // Generic "About …" labels read as "Learn more" (the full label stays as the tooltip); specific ones are kept.
  const docLabel = o.docs && /^about /i.test(o.docs.label) ? 'Learn more' : o.docs?.label ?? '';
  const docs = o.docs ? extLink(o.docs.href, docLabel, 'help-more empty-std-docs', docLabel === o.docs.label ? '' : o.docs.label) : '';
  const actions = `${o.action ?? ''}${button}${docs}`;
  return `<div class="empty-std">
    <ev-icon name="${esc(o.icon)}" size="md"></ev-icon>
    <div class="empty-std-body">
      <strong>${esc(o.title)}</strong>
      <p>${o.what}</p>${o.why ? `<p class="empty-std-why">${o.why}</p>` : ''}
      ${actions ? `<div class="empty-std-actions">${actions}</div>` : ''}
    </div>
  </div>`;
}

/* ── Summary strip ─────────────────────────────────────────────────── */

export interface StripCell {
  label: string;
  /** Plain text value (escaped). */
  value: string;
  /**
   * Only for a state that can go bad (Task Manager running, units near the
   * limit, expiry close): a dot in that tone appears before the value.
   * Leave it out for plain facts ("Community", "20 licensed").
   */
  tone?: Tone;
  /** One short phrase under the value (caller-escaped HTML), or nothing. */
  caption?: string;
  title?: string;
}

/**
 * The one summary strip above a list: 2–4 cells split by hairlines, at most
 * 64px tall. Dots only where the cell is a state (see StripCell.tone).
 */
export function strip(cells: StripCell[], cls = ''): string {
  return `<div class="strip${cls ? ` ${cls}` : ''}" style="--strip-cols:${cells.length}">${cells.map((c) => `
    <div class="strip-cell"${c.tone ? ` data-tone="${c.tone}"` : ''}${c.title ? ` title="${esc(c.title)}"` : ''}>
      <span class="strip-label">${esc(c.label)}</span>
      <span class="strip-value">${c.tone ? '<i class="strip-dot" aria-hidden="true"></i>' : ''}<span>${esc(c.value)}</span></span>
      ${c.caption ? `<span class="strip-cap">${c.caption}</span>` : ''}
    </div>`).join('')}
  </div>`;
}

/** The one no-permission message, naming the resource in plain words and in code. */
export function noPermissionText(resource: string, plain: string): string {
  return `You need Use on ${resource} (${plain}) to change this.`;
}

/* ══ objectDetail(): the one peek + full view (anatomy from Processes) ══════ */

/** A visible action in a peek or full-view header (the commonest non-destructive verb: Edit). */
export interface OdAction {
  label: string;
  icon?: string;
  run: () => void;
  /** Why it can't be used right now (the button stays, blocked, with this as its reason). */
  blocked?: string | null;
}

/** A card in the full view. `body` is caller-escaped HTML; `head` is extra header markup (right side). */
export interface OdCard { title: string; body: string; head?: string; id?: string }

/** What the full view shows under the title. */
export interface OdFull {
  /** Exactly 4 cells, never repeating the subtitle (the state is already there). */
  strip: StripCell[];
  /** A notice only when the risk is THIS object's (caller-built HTML, e.g. a .page-notice). */
  notice?: string;
  /** Left column (2fr) and right column (1fr). The description is the first line of the first main card. */
  main: OdCard[];
  side: OdCard[];
}

export interface ObjectDetailOptions<T> {
  /** Breadcrumb parent and peek aria text, e.g. "Web applications". */
  collection: string;
  /** The list's <ev-detail-panel class="workspace"> and its <aside slot="detail" class="detail">. */
  panel: HTMLElement;
  detail: HTMLElement;
  /** The list region (toolbar, panel, footer): hidden while the full view is open. */
  list: HTMLElement;
  /** An empty container after the list: the full view renders here. */
  full: HTMLElement;
  /** Stable id of a row (goes in the address: #/web/apps/<key>). */
  key(row: T): string;
  find(key: string): T | undefined;
  /** Keys in the list's current filter and sort: what ‹ › and J/K step through. */
  order(): string[];
  name(row: T): string;
  /** Mono only for code identifiers (paths, classes, routines). */
  mono?: boolean | ((row: T) => boolean);
  /** Row 2 of the peek and the full-view subtitle: build it with odMeta() so it starts with the state dot. */
  meta(row: T): string;
  /** Plain text, shown at the top of the peek body (2 lines max). */
  description?(row: T): string;
  /** The one visible action (Edit). Disable / Delete / Suspend go in `menu`. */
  primary?(row: T): OdAction | null;
  menu?(row: T): MenuItem[];
  /** Peek body under the description: odSection() / odKv() markup. */
  peek(row: T): string | Promise<string>;
  loadFull(row: T): OdFull | Promise<OdFull>;
  /** Bind events inside what was just rendered (links, buttons in cards). */
  wire?(root: HTMLElement, row: T, where: 'peek' | 'full'): void;
  /** Keep the grid in step: select(key) / select([]) on your grid. */
  onSelect?(key: string | null): void;
  /** Peek opened / closed (e.g. hide secondary columns while it's open). */
  onPeek?(open: boolean): void;
  /** May we leave what's shown? (e.g. an editor with unsaved changes). */
  canLeave?(): Promise<boolean>;
  /** Singular noun for step labels, e.g. "web application". Default "item". */
  noun?: string;
  /** localStorage key for the peek width; default per route. */
  widthKey?: string;
}

export interface ObjectDetailHandle {
  /** Open the peek on a row (null closes it). */
  select(key: string | null): Promise<void>;
  openFull(key: string): Promise<void>;
  closeFull(): Promise<void>;
  /** Data changed: re-render what's shown (and open a deep-linked row once it exists). */
  refresh(): void;
  /** Re-render only the header (state, actions, n of N), keeping the body as it is. */
  refreshHeader(): void;
  selected(): string | null;
  mode(): 'list' | 'full';
}

/**
 * Row 2 of a peek / the full-view subtitle: "● State · fact · fact". Always
 * starts with the state dot. `facts` are plain text (escaped); pass `html`
 * for extra caller-built items (a pill for an exception).
 */
export function odMeta(state: { label: string; tone: Tone; title?: string }, facts: string[] = [], html: string[] = []): string {
  const dot = `<span class="od-state"${state.title ? ` title="${esc(state.title)}"` : ''}><i class="od-dot" data-tone="${state.tone}" aria-hidden="true"></i>${esc(state.label)}</span>`;
  const items = [dot, ...facts.filter(Boolean).map((f) => `<span>${esc(f)}</span>`), ...html.filter(Boolean)];
  return items.map((x, i) => `<span class="od-meta-item">${i ? '<span class="od-sep" aria-hidden="true">·</span>' : ''}${x}</span>`).join('');
}

/** A peek section: 12.5/600 head with 16px above, then its rows. `body` is caller-escaped HTML. */
export function odSection(title: string, body: string): string {
  return `<section class="od-section">${title ? `<h3 class="od-section-head">${esc(title)}</h3>` : ''}${body}</section>`;
}

/** Key/value rows, 28px each: label (text-secondary) left, value right. Values are caller-escaped HTML. */
export function odKv(rows: Array<[string, string] | [string, string, string]>): string {
  return `<dl class="od-kv">${rows.map(([k, v, title]) => `<div class="od-kv-row"><dt>${esc(k)}</dt><dd${title ? ` title="${esc(title)}"` : ''}>${v}</dd></div>`).join('')}</dl>`;
}

/* ── Server name ───────────────────────────────────────────────────── */

export interface ServerName {
  /** What to show: the server's FQDN (or host name) from the OSCA API, else the address the browser used. */
  name: string;
  /** "Server <fqdn> · reached at <location.host>" (or just the address). */
  title: string;
  /** True when the name came from the server itself. */
  fromServer: boolean;
}
let serverNameCache: ServerName | null = null;
/**
 * The server's own name for headers and the sign-in chip. Uses getServerInfo()
 * from the OSCA API when it is installed and answers; otherwise falls back to
 * location.hostname. A success is cached for the session; a failure is not
 * (before sign-in the API may refuse, and it should be asked again after).
 */
export async function serverName(): Promise<ServerName> {
  if (serverNameCache) return serverNameCache;
  const fallback: ServerName = { name: location.hostname, title: `Reached at ${location.host}`, fromServer: false };
  try {
    const i = await getServerInfo();
    const name = (i.fqdn || i.hostName || '').trim();
    if (!name) return fallback;
    serverNameCache = { name, title: `Server ${name} · reached at ${location.host}`, fromServer: true };
    return serverNameCache;
  } catch {
    return fallback;
  }
}

/* ── Peek width: one standard for every detail panel ─────────────────── */

/** Default peek width is clamp(PEEK_MIN, 36% of the workspace, PEEK_MAX); drags are remembered per screen. */
export const PEEK_MIN = 480;
export const PEEK_MAX = 560;
/** A remembered (dragged) width is honoured only inside this range; anything else is reset. */
const PEEK_STORED_MAX = 720;

/** localStorage key for a screen's peek width: "#/web/apps/x" → "osca-portal:peek-width:web/apps". */
export function peekWidthKey(hash = location.hash): string {
  return `osca-portal:peek-width:${hash.replace(/^#\/?/, '').split('/').slice(0, 2).join('/')}`;
}
/** The width to open a peek at: the remembered one if it's in range (a stale one is cleared), else the default. */
export function peekWidth(panel: HTMLElement, key = peekWidthKey()): number {
  const total = panel.getBoundingClientRect().width || window.innerWidth;
  const def = Math.min(PEEK_MAX, Math.max(PEEK_MIN, total * 0.36));
  let stored = 0;
  try {
    stored = Number(localStorage.getItem(key)) || 0;
    if (stored && (stored < PEEK_MIN || stored > PEEK_STORED_MAX)) { localStorage.removeItem(key); stored = 0; }
  } catch { /* storage blocked: default width */ }
  return Math.round(Math.min(stored || def, Math.max(PEEK_MIN, total * 0.6)));
}
export function rememberPeekWidth(key: string, w: number): void {
  try { if (w >= PEEK_MIN && w <= PEEK_STORED_MAX) localStorage.setItem(key, String(Math.round(w))); } catch { /* storage blocked: width lasts this visit */ }
}

/** Dev only: a strip cell that repeats a subtitle fact (value or label) says the fact twice. */
function warnRepeats(collection: string, metaHtml: string, cells: StripCell[]): void {
  if (!import.meta.env.DEV) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = metaHtml;
  const norm = (t: string): string => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const facts = (tmp.textContent ?? '').split('·').map(norm).filter((t) => t.length > 1);
  for (const c of cells) {
    const v = norm(c.value);
    const l = norm(c.label);
    const hit = facts.find((f) => (v.length > 1 && (f === v || f.includes(v))) || f === l || f.startsWith(`${l} `));
    if (hit) console.warn(`[objectDetail] ${collection}: strip cell "${c.label}: ${c.value}" repeats the subtitle ("${hit}"). Say each fact once.`);
  }
}

/**
 * objectDetail(): the one peek + full view, with the Processes anatomy.
 *
 * Peek (in the list's ev-detail-panel): row 1 = name (16/600, or 15/600 mono)
 * with, on the right, one visible action, ⋯, a divider, maximize and close;
 * row 2 = the meta line (odMeta: "● State · fact · fact"). Body = description
 * (2 lines max), then your sections (odSection / odKv, 28px rows). Width
 * clamp(480px, 36%, 560px) until the user drags it; then remembered per screen.
 *
 * The visible action (`primary`) rule: Edit when the object can be edited,
 * otherwise NONE (return null; never a disabled Edit). Lifecycle verbs —
 * Suspend, Resume, Disable, Enable, Delete, Copy / Duplicate, Terminate —
 * always go in ⋯ (`menu`). The one exception is a task's "Change schedule",
 * which is that object's edit.
 *
 * Say each fact once: the subtitle (`meta`) is the state plus identity facts,
 * the strip is quantities, cards hold details that are in neither. In dev, a
 * console warning names any strip cell whose value or label repeats a
 * subtitle fact.
 *
 * Full view (#/<route>/<key>): the page title becomes "Collection / Name"
 * (20/600; a mono name 19/600), the subtitle is the same meta line, the header
 * holds ‹ n of N ›, the action (secondary, 32px) and ⋯ — the list's own header
 * actions (New …, status) are hidden until you come back. Then a 4-cell strip,
 * an optional notice about this object, and cards in 2fr / 1fr columns.
 *
 * Keys: F opens the full view from the peek; in the full view J / K step and
 * Esc goes back; Esc closes the peek. Keys are ignored while typing, while a
 * dialog or menu is open, or while an editor (.crud-editor) is in the peek.
 *
 * Deep links: when the screen opens on #/<route>/<key>, the full view opens on
 * the first refresh() — call it after the first load, when find() can answer. The address is only changed while
 * this screen is still the one showing.
 *
 * Minimal example:
 *
 *   ctx.body.innerHTML = `
 *     <div id="x-list" class="od-list">
 *       <div class="toolbar-row">…</div>
 *       <ev-detail-panel id="x-panel" class="workspace" overlay-below="960">
 *         <div class="grid-wrap" id="x-wrap"></div>
 *         <aside slot="detail" class="detail" id="x-detail"></aside>
 *       </ev-detail-panel>
 *     </div>
 *     <div id="x-full" hidden></div>`;
 *   const od = objectDetail<App>(ctx, {
 *     collection: 'Web applications', noun: 'web application',
 *     panel: $('#x-panel'), detail: $('#x-detail'), list: $('#x-list'), full: $('#x-full'),
 *     key: (a) => a.Name, find: (k) => all.find((a) => a.Name === k), order: () => visible().map((a) => a.Name),
 *     name: (a) => a.Name, mono: true,
 *     meta: (a) => odMeta(a.Enabled ? { label: 'Enabled', tone: 'success' } : { label: 'Disabled', tone: 'neutral' }, [a.Namespace]),
 *     description: (a) => a.Description,
 *     primary: (a) => ({ label: 'Edit', icon: 'edit-2', run: () => edit(a) }),
 *     menu: (a) => [{ label: 'Disable…', onSelect: () => disable(a) }, { label: 'Delete…', danger: true, onSelect: () => del(a) }],
 *     peek: (a) => odSection('Sign-in', odKv([['Methods', esc(a.Auth)]])),
 *     loadFull: async (a) => ({ strip: [...4 cells], main: [{ title: 'About', body: '…' }], side: [] }),
 *     onSelect: (k) => grid?.select(k ? [k] : []),
 *   });
 *   grid.addEventListener('ev-data-grid-row-click', (e) => void od.select(keyOf(e)));
 *   // after every load: od.refresh();
 */
export function objectDetail<T>(ctx: ScreenCtx, o: ObjectDetailOptions<T>): ObjectDetailHandle {
  const noun = o.noun ?? 'item';
  // Marks the full-view host for shared styles (an editor that takes the body's place, see styles.css).
  o.full.setAttribute('data-od-full', '');
  // While a form has the body (screens add .crud-editing), the header's actions would start a second one:
  // they're inert until it closes, and focus then returns to the primary action that opened it.
  let wasEditing = false;
  const editWatch = new MutationObserver(() => {
    const editing = o.full.classList.contains('crud-editing');
    if (editing === wasEditing) return;
    wasEditing = editing;
    const box = ctx.actions.querySelector<HTMLElement>('.od-full-actions');
    box?.querySelectorAll<HTMLButtonElement>('#od-full-primary, #od-full-more').forEach((b) => {
      b.toggleAttribute('data-od-inert', editing);
      b.setAttribute('aria-disabled', String(editing));
    });
    if (editing && sel !== null && !o.full.querySelector(':scope > .crud-editor > .od-edit-head')) {
      // Every form in a full view gets the sticky title bar (with the name and pager once stuck).
      const row = o.find(sel);
      if (row) stickyEditHead(o.full, o.name(row), isMono(row));
    }
    if (!editing && !o.full.hidden) box?.querySelector<HTMLElement>('#od-full-primary')?.focus({ preventScroll: true });
  });
  editWatch.observe(o.full, { attributes: true, attributeFilter: ['class'] });
  ctx.onLeave(() => editWatch.disconnect());
  const isMono = (row: T): boolean => (typeof o.mono === 'function' ? o.mono(row) : !!o.mono);
  // The screen's own address (#/web/apps), so the detail never writes an address after the route has left.
  const base = `#/${(location.hash.replace(/^#\/?/, '').split('/').slice(0, 2)).join('/')}`;
  let left = false;
  const here = (): boolean => !left && (location.hash === base || location.hash.startsWith(`${base}/`));
  const setParam = (p: string | null): void => { if (here()) ctx.setParam?.(p); };

  let sel: string | null = null;
  let mode: 'list' | 'full' = 'list';
  let pending: string | null = ctx.param ?? null;
  let token = 0;
  let headSig = '';
  let peekMenu: MenuHandle | null = null;
  let fullMenu: MenuHandle | null = null;
  let actionsBox: HTMLElement | null = null;
  let saved: { title: string; sub: string; subHidden: boolean; fill: boolean } | null = null;

  // ── Width: the shared peek width (clamp(480, 36%, 560) until dragged, then remembered per screen) ──
  const panel = o.panel as HTMLElement & { open: boolean; detailWidth: number; minWidth: number };
  panel.setAttribute('data-od', ''); // main.ts's shared width keeper leaves this panel to us
  const widthKey = o.widthKey ?? peekWidthKey(base);
  const width = (): number => peekWidth(panel, widthKey);
  panel.minWidth = PEEK_MIN;
  const onResize = (e: Event): void => rememberPeekWidth(widthKey, (e as CustomEvent<{ detailWidth: number }>).detail.detailWidth);
  panel.addEventListener('ev-detail-panel-resize', onResize);
  const setPanel = (open: boolean): void => {
    if (panel.open === open) return;
    if (open) panel.detailWidth = width();
    panel.open = open;
    o.onPeek?.(open);
  };

  const mayLeave = async (): Promise<boolean> => (o.canLeave ? o.canLeave() : true);

  const actionBtn = (a: OdAction | null | undefined, size: 'sm' | 'md', id: string): string => (a
    ? `<button type="button" class="btn${size === 'sm' ? ' btn--sm' : ''} od-primary" id="${id}"${blockedAttrs(a.blocked)}>${a.icon ? `<ev-icon name="${esc(a.icon)}" size="xs"></ev-icon>` : ''}${esc(a.label)}</button>`
    : '');
  const wireAction = (root: HTMLElement, id: string, a: OdAction | null | undefined): void => {
    const b = root.querySelector<HTMLElement>(`#${id}`);
    if (b && a) b.addEventListener('click', () => { if (!b.hasAttribute('data-crud-blocked') && !b.hasAttribute('data-od-inert')) a.run(); });
  };

  // ── Peek ──
  const renderPeekHead = (row: T): void => {
    const primary = o.primary?.(row) ?? null;
    const items = o.menu?.(row) ?? [];
    const name = o.name(row);
    const head = `
      <header class="od-head">
        <h2 class="od-title${isMono(row) ? ' od-title--mono' : ''}" title="${esc(name)}">${esc(name)}</h2>
        <div class="od-head-actions">
          ${actionBtn(primary, 'sm', 'od-peek-primary')}
          ${items.length ? moreButton('od-peek-more', `More actions for ${name}`) : ''}
          <span class="od-vsep" aria-hidden="true"></span>
          <ev-icon-button icon="maximize" label="Open full view (F)" title="Open full view (F)" id="od-expand"></ev-icon-button>
          <ev-icon-button icon="x" label="Close" title="Close (Esc)" id="od-close"></ev-icon-button>
        </div>
        <div class="od-meta">${o.meta(row)}</div>
      </header>`;
    const sig = head + JSON.stringify(items.map((i) => [i.label, i.disabled, i.reason]));
    let shell = o.detail.querySelector<HTMLElement>(':scope > .od-shell');
    if (!shell || !o.detail.querySelector(':scope > .od-body')) {
      o.detail.innerHTML = '<div class="od-shell"></div><div class="od-body"></div>';
      o.detail.classList.add('od-detail');
      shell = o.detail.querySelector<HTMLElement>(':scope > .od-shell') as HTMLElement;
      headSig = '';
    }
    if (sig === headSig) return;
    headSig = sig;
    shell.innerHTML = head;
    wireAction(shell, 'od-peek-primary', primary);
    peekMenu?.destroy(); peekMenu = null;
    const more = shell.querySelector<HTMLElement>('#od-peek-more');
    if (more) peekMenu = moreMenu(more, items);
    shell.querySelector('#od-close')?.addEventListener('click', () => void api.select(null));
    shell.querySelector('#od-expand')?.addEventListener('click', () => { if (sel) void api.openFull(sel); });
  };
  const renderPeek = async (row: T, body = true): Promise<void> => {
    renderPeekHead(row);
    setPanel(true);
    if (!body) return;
    const t = ++token;
    const bodyEl = o.detail.querySelector<HTMLElement>(':scope > .od-body') as HTMLElement;
    const desc = o.description?.(row);
    const res = o.peek(row);
    if (res instanceof Promise && !bodyEl.childElementCount) bodyEl.innerHTML = skeleton(5);
    const html = await res;
    if (t !== token || mode !== 'list' || sel !== o.key(row)) return;
    bodyEl.innerHTML = `${desc ? `<p class="od-desc" title="${esc(desc)}">${esc(desc)}</p>` : ''}${html}`;
    o.wire?.(bodyEl, row, 'peek');
  };
  const closePeek = (): void => {
    token++;
    peekMenu?.destroy(); peekMenu = null;
    headSig = '';
    setPanel(false);
    o.detail.innerHTML = '';
  };

  // ── Full view ──
  const titleEl = (): HTMLElement | null => document.getElementById('page-title');
  const subEl = (): HTMLElement | null => document.getElementById('page-subtitle');
  const onTitleClick = (e: MouseEvent): void => {
    const a = (e.target as Element).closest('a.od-crumb');
    if (!a || mode !== 'full' || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    void api.closeFull();
  };
  let titleBound: HTMLElement | null = null;
  const bindTitle = (): void => {
    const t = titleEl();
    if (!t || t === titleBound) return;
    titleBound?.removeEventListener('click', onTitleClick);
    t.addEventListener('click', onTitleClick);
    titleBound = t;
  };
  const crumb = (row: T): string =>
    `<a class="od-crumb" href="${esc(base)}">${esc(o.collection)}</a><span class="od-crumb-sep" aria-hidden="true">/</span><span class="od-crumb-here${isMono(row) ? ' od-crumb-here--mono' : ''}" title="${esc(o.name(row))}">${esc(o.name(row))}</span>`;

  const renderFullHead = (row: T): void => {
    ctx.heading(crumb(row), o.meta(row));
    bindTitle();
    const order = o.order();
    const i = order.indexOf(o.key(row));
    const primary = o.primary?.(row) ?? null;
    const items = o.menu?.(row) ?? [];
    if (!actionsBox || !actionsBox.isConnected) {
      actionsBox = document.createElement('div');
      actionsBox.className = 'od-full-actions';
      ctx.actions.appendChild(actionsBox);
    }
    ctx.actions.classList.add('od-full-mode');
    // The pager sits last, at the right edge: items with no Edit or ⋯ never move it under the cursor.
    actionsBox.innerHTML = `
      ${actionBtn(primary, 'md', 'od-full-primary')}
      ${items.length ? moreButton('od-full-more', `More actions for ${o.name(row)}`) : ''}
      <span class="od-step" role="group" aria-label="Step through ${esc(o.collection.toLowerCase())}">
        <button type="button" class="od-stepbtn" id="od-prev" title="Previous ${esc(noun)} (K)" aria-label="Previous ${esc(noun)} (K)"${i <= 0 ? ' disabled' : ''}><ev-icon name="chevron-left" size="sm"></ev-icon></button>
        <span class="od-count">${i < 0 ? '—' : `${(i + 1).toLocaleString()} of ${order.length.toLocaleString()}`}</span>
        <button type="button" class="od-stepbtn" id="od-next" title="Next ${esc(noun)} (J)" aria-label="Next ${esc(noun)} (J)"${i < 0 || i >= order.length - 1 ? ' disabled' : ''}><ev-icon name="chevron-right" size="sm"></ev-icon></button>
      </span>`;
    if (wasEditing) actionsBox.querySelectorAll('#od-full-primary, #od-full-more').forEach((b) => { b.setAttribute('data-od-inert', ''); b.setAttribute('aria-disabled', 'true'); });
    actionsBox.querySelector('#od-prev')?.addEventListener('click', () => void step(-1));
    actionsBox.querySelector('#od-next')?.addEventListener('click', () => void step(1));
    wireAction(actionsBox, 'od-full-primary', primary);
    fullMenu?.destroy(); fullMenu = null;
    const more = actionsBox.querySelector<HTMLElement>('#od-full-more');
    if (more) fullMenu = moreMenu(more, items);
  };
  const card = (c: OdCard): string =>
    `<section class="card od-card"${c.id ? ` id="${esc(c.id)}"` : ''}><header class="card-head"><h2>${esc(c.title)}</h2>${c.head ?? ''}</header><div class="od-card-body">${c.body}</div></section>`;
  const renderFullBody = async (row: T): Promise<void> => {
    const t = ++token;
    const res = o.loadFull(row);
    if (res instanceof Promise && !o.full.querySelector('.od-full')) o.full.innerHTML = `<div class="od-full">${skeleton(8)}</div>`;
    let f: OdFull;
    try { f = await res; } catch (err) {
      if (t === token && mode === 'full') o.full.innerHTML = `<div class="od-full">${errorPanel(err)}</div>`;
      return;
    }
    if (t !== token || mode !== 'full' || sel !== o.key(row)) return;
    if (import.meta.env.DEV) warnRepeats(o.collection, o.meta(row), f.strip);
    o.full.innerHTML = `<div class="od-full">
      ${strip(f.strip.slice(0, 4), 'od-strip')}
      ${f.notice ?? ''}
      <div class="od-cols">
        <div class="od-col">${f.main.map(card).join('')}</div>
        <div class="od-col">${f.side.map(card).join('')}</div>
      </div>
    </div>`;
    o.wire?.(o.full, row, 'full');
  };
  const showGone = (key: string): void => {
    token++;
    ctx.heading(`<a class="od-crumb" href="${esc(base)}">${esc(o.collection)}</a><span class="od-crumb-sep" aria-hidden="true">/</span><span class="od-crumb-here">${esc(key)}</span>`, '');
    bindTitle();
    if (actionsBox) actionsBox.innerHTML = '';
    o.full.innerHTML = emptyState({ icon: 'info', title: `No ${noun} called ${key}`, what: 'It may have been deleted or renamed.', button: { id: 'od-gone-back', label: `Back to ${o.collection.toLowerCase()}` } });
    o.full.querySelector('#od-gone-back')?.addEventListener('click', () => void api.closeFull());
  };
  /** Scroll every scrolling ancestor (some sit in the shell's shadow DOM) back to the top. */
  const scrollTop = (el: Element): void => {
    let n: Element | null = el.parentElement;
    while (n) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') n.scrollTop = 0;
      n = n.assignedSlot ?? n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
    }
  };
  const enterFull = (): void => {
    if (mode === 'full') return;
    const main = document.getElementById('main');
    saved = {
      title: titleEl()?.innerHTML ?? esc(o.collection),
      sub: subEl()?.innerHTML ?? '',
      subHidden: subEl()?.hidden ?? true,
      fill: !!main?.classList.contains('portal-main--fill'),
    };
    closePeek();
    mode = 'full';
    ctx.fill(false); // the full view is a document: main is its only scroller
    o.list.hidden = true;
    o.full.hidden = false;
  };
  const leaveFull = (): void => {
    if (mode !== 'full') return;
    mode = 'list';
    token++;
    fullMenu?.destroy(); fullMenu = null;
    actionsBox?.remove(); actionsBox = null;
    ctx.actions.classList.remove('od-full-mode');
    if (saved) {
      ctx.heading(saved.title, saved.subHidden ? '' : saved.sub);
      if (saved.fill) ctx.fill(true);
    }
    saved = null;
    o.full.hidden = true;
    o.full.innerHTML = '';
    o.list.hidden = false;
  };
  const step = async (delta: number): Promise<void> => {
    const order = o.order();
    const i = order.indexOf(sel ?? '');
    const next = order[i < 0 ? 0 : i + delta];
    if (next !== undefined && next !== sel) await api.openFull(next);
  };

  // ── Keys ──
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('ev-dialog, .crud-menu') || o.detail.querySelector('.crud-editor') || o.full.querySelector('.crud-editor')) return;
    const path = e.composedPath() as Element[];
    if (path.some((el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|EV-SEARCH|EV-INPUT|EV-TEXTAREA|EV-SELECT|EV-COMBO-BOX|EV-COMMAND-PALETTE)$/.test(el.tagName)))) return;
    const k = e.key.toLowerCase();
    if (mode === 'full') {
      if (e.key === 'Escape') { e.preventDefault(); void api.closeFull(); }
      else if (k === 'j') { e.preventDefault(); void step(1); }
      else if (k === 'k') { e.preventDefault(); void step(-1); }
    } else if (sel !== null && panel.open) {
      if (k === 'f') { e.preventDefault(); void api.openFull(sel); }
      else if (e.key === 'Escape') { e.preventDefault(); void api.select(null); }
    }
  };
  document.addEventListener('keydown', onKey);
  ctx.onLeave(() => {
    left = true;
    token++;
    document.removeEventListener('keydown', onKey);
    panel.removeEventListener('ev-detail-panel-resize', onResize);
    titleBound?.removeEventListener('click', onTitleClick);
    peekMenu?.destroy(); fullMenu?.destroy();
    actionsBox?.remove();
    ctx.actions.classList.remove('od-full-mode');
  });

  const api: ObjectDetailHandle = {
    async select(key) {
      if (mode === 'full') { if (key) await api.openFull(key); return; }
      if (key === sel && (key === null || panel.open)) return;
      if (!(await mayLeave())) { o.onSelect?.(sel); return; }
      const row = key === null ? undefined : o.find(key);
      if (!row) { sel = null; o.onSelect?.(null); closePeek(); return; }
      sel = key;
      o.detail.innerHTML = ''; headSig = '';
      o.onSelect?.(key);
      await renderPeek(row);
    },
    async openFull(key) {
      if (mode === 'full' && key === sel) return;
      if (!(await mayLeave())) return;
      const row = o.find(key);
      enterFull();
      sel = key;
      o.full.innerHTML = '';
      scrollTop(o.full);
      setParam(key);
      if (!row) { showGone(key); return; }
      renderFullHead(row);
      await renderFullBody(row);
    },
    async closeFull() {
      if (mode !== 'full') return;
      if (!(await mayLeave())) return;
      leaveFull();
      setParam(null);
      const row = sel === null ? undefined : o.find(sel);
      if (row) { o.onSelect?.(sel); await renderPeek(row); } else { sel = null; o.onSelect?.(null); }
    },
    refresh() {
      // Deep link: the first refresh (after the first load) opens it, or says it's gone.
      if (pending !== null) {
        const key = pending;
        pending = null;
        void api.openFull(key);
        return;
      }
      if (sel === null) return;
      const row = o.find(sel);
      if (mode === 'full') {
        if (!row) { showGone(sel); return; }
        renderFullHead(row);
        void renderFullBody(row);
      } else if (row) {
        void renderPeek(row);
      } else {
        sel = null; o.onSelect?.(null); closePeek();
      }
    },
    refreshHeader() {
      if (sel === null) return;
      const row = o.find(sel);
      if (!row) return;
      if (mode === 'full') renderFullHead(row); else if (panel.open) renderPeekHead(row);
    },
    selected: () => sel,
    mode: () => mode,
  };
  return api;
}

/* ══ Export: CSV of what a list shows ═════════════════════════════════════ */

/** One exported column: `value` turns a row into the raw value (default: row[key]). */
export interface ExportColumn<R = Record<string, unknown>> { key: string; label: string; value?: (row: R) => unknown }
/** What an Export button writes. Callers pass only safe columns (never masked or secret values). */
export interface ExportData<R = Record<string, unknown>> { filename: string; columns: ExportColumn<R>[]; rows: R[] }

const csvField = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? (Number.isNaN(v.getTime()) ? '' : v.toISOString())
    : Array.isArray(v) ? v.join('; ')
      : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 CSV: a header row of labels, then one line per row, CRLF line ends. */
export function toCsv<R>(columns: ExportColumn<R>[], rows: R[]): string {
  const value = (c: ExportColumn<R>, r: R): unknown => (c.value ? c.value(r) : (r as Record<string, unknown>)[c.key]);
  return [columns.map((c) => csvField(c.label)).join(','), ...rows.map((r) => columns.map((c) => csvField(value(c, r))).join(','))].join('\r\n');
}

/**
 * Download rows as CSV (UTF-8 with a BOM, so Excel reads accents and "—"
 * correctly). The file name gets the date and time: "audit-records-2026-09-27-0130.csv".
 */
export function exportRows<R>(filename: string, columns: ExportColumn<R>[], rows: R[]): void {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  const base = filename.replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '-');
  const url = URL.createObjectURL(new Blob(['\ufeff', toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type ExportableGrid = HTMLElement & {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, unknown>>;
  getState?: () => { columnOrder?: string[]; hiddenColumns?: string[]; sortColumn?: string; sortDirection?: string };
};

/**
 * Export data for an ev-data-grid: its VISIBLE columns in the user's current
 * order, its rows in the current sort, raw values (not the rendered cells).
 * `exclude` drops columns (anything masked or secret); `values` overrides how a
 * column's raw value is read; `extra` appends columns the grid doesn't show.
 */
export function gridExport(grid: HTMLElement | null, filename: string, opts: {
  exclude?: string[];
  values?: Record<string, (row: Record<string, unknown>) => unknown>;
  extra?: ExportColumn[];
} = {}): ExportData | null {
  const g = grid as ExportableGrid | null;
  if (!g || !Array.isArray(g.columns)) return null;
  const st = g.getState?.() ?? {};
  const hidden = new Set([...(st.hiddenColumns ?? []), ...(opts.exclude ?? [])]);
  const byKey = new Map(g.columns.map((c) => [c.key, c] as const));
  const order = [...(st.columnOrder ?? []).filter((k) => byKey.has(k)), ...g.columns.map((c) => c.key).filter((k) => !(st.columnOrder ?? []).includes(k))];
  const columns: ExportColumn[] = order.filter((k) => !hidden.has(k)).map((k) => ({
    key: k,
    label: String(byKey.get(k)?.label ?? k).replace(/<[^>]*>/g, '').trim() || k,
    value: opts.values?.[k],
  }));
  columns.push(...(opts.extra ?? []));
  const rows = [...(g.rows ?? [])];
  const sk = st.sortColumn;
  if (sk) {
    const dir = st.sortDirection === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      const va = a[sk]; const vb = b[sk];
      if (va === null || va === undefined || va === '') return 1;
      if (vb === null || vb === undefined || vb === '') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir;
    });
  }
  return { filename, columns, rows };
}

/**
 * "Export CSV": a secondary 28px icon-and-label button for a list's toolbar
 * row; it places itself at the right end. `getData` is asked at click time
 * (null or no rows: nothing to export, and it says so).
 *   toolbar.append(exportButton(() => gridExport(grid, 'background-jobs')));
 */
export function exportButton(getData: () => ExportData | null): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn toolbar-export';
  b.title = 'Download the rows shown as a CSV file';
  b.innerHTML = '<ev-icon name="download" size="xs"></ev-icon><span>Export CSV</span>';
  b.addEventListener('click', () => {
    const d = getData();
    if (!d || !d.rows.length) { toast('Nothing to export: the list is empty.', 'info'); return; }
    exportRows(d.filename, d.columns, d.rows);
  });
  return b;
}

/**
 * An editor that has taken a full view's body: its title bar sticks to the top of the page while
 * the form scrolls, and once stuck it also shows the object's name and a ‹ n of N › pager (the
 * page header's, which has scrolled away; paging still asks before dropping changes).
 */
export function stickyEditHead(host: HTMLElement, name: string, mono = false): void {
  const head = host.querySelector<HTMLElement>(':scope > .crud-editor > .crud-editor-head');
  if (!head) return;
  head.classList.add('od-edit-head');
  const prev = document.getElementById('od-prev') as HTMLButtonElement | null;
  const next = document.getElementById('od-next') as HTMLButtonElement | null;
  const count = document.querySelector('.od-full-actions .od-count')?.textContent ?? '';
  const mini = document.createElement('div');
  mini.className = 'od-edit-mini';
  mini.innerHTML = `<span class="od-edit-mini-name${mono ? ' mono' : ''}" title="${esc(name)}">${esc(name)}</span>${prev && next ? `
    <span class="od-step" role="group" aria-label="Step through the list">
      <button type="button" class="od-stepbtn" data-mini-step="-1" title="${esc(prev.title)}" aria-label="${esc(prev.getAttribute('aria-label') ?? '')}"${prev.disabled ? ' disabled' : ''}><ev-icon name="chevron-left" size="sm"></ev-icon></button>
      <span class="od-count">${esc(count)}</span>
      <button type="button" class="od-stepbtn" data-mini-step="1" title="${esc(next.title)}" aria-label="${esc(next.getAttribute('aria-label') ?? '')}"${next.disabled ? ' disabled' : ''}><ev-icon name="chevron-right" size="sm"></ev-icon></button>
    </span>` : ''}`;
  mini.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-mini-step]');
    if (b && !b.disabled) (b.dataset.miniStep === '-1' ? prev : next)?.click();
  });
  const x = head.querySelector('[data-crud-x]');
  if (x) x.before(mini); else head.appendChild(mini);
}
