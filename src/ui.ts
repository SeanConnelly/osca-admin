/**
 * Shared presentation helpers for portal screens. Every value that came from
 * IRIS goes through esc() before it is placed in markup.
 */

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
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Time until / since a date, e.g. "in 3h 12m", "5m ago". */
export function relative(date: Date, now = new Date()): string {
  const diff = Math.round((date.getTime() - now.getTime()) / 1000);
  if (Math.abs(diff) < 45) return diff >= 0 ? 'in a moment' : 'just now';
  const text = duration(Math.abs(diff));
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

/** IRIS "YYYY-MM-DD HH:MM:SS" (server local time) → Date. */
export function irisDate(s: string): Date {
  return new Date(s.replace(' ', 'T'));
}

export type Tone = 'neutral' | 'success' | 'info' | 'warning' | 'danger';

export function chip(text: string, tone: Tone = 'neutral', title = ''): string {
  return `<ev-chip size="sm" tone="${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</ev-chip>`;
}

/**
 * Grid cells render inside ev-data-grid's shadow DOM, out of reach of the page
 * stylesheet, so cell formatting is carried inline on design tokens.
 */
const NOWRAP = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;';
export const cell = {
  /** Monospace; `muted` for secondary identifiers such as PIDs. */
  mono: (v: unknown, muted = false, title = ''): string =>
    `<span style="${NOWRAP}font-family:var(--ev-font-family-mono);font-size:var(--ev-font-size-xs);color:var(--ev-color-text-${muted ? 'secondary' : 'primary'})"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`,
  text: (v: unknown, title = ''): string => `<span style="${NOWRAP}"${title ? ` title="${esc(title)}"` : ''}>${esc(v)}</span>`,
  num: (text: string, title = ''): string => `<span style="${NOWRAP}font-variant-numeric:tabular-nums"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`,
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
    ${kind === 'trend' ? '<ev-sparkline class="stat-trend" type="line" height="18" min="0"></ev-sparkline>' : ''}
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
  const trend = el.querySelector('.stat-trend') as (HTMLElement & { values: number[] }) | null;
  if (trend && u.trend) {
    const moving = u.trend.length >= 3 && Math.max(...u.trend) !== Math.min(...u.trend);
    trend.hidden = !moving;
    if (moving) trend.values = u.trend;
  }
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
  onLeave(fn: () => void): void;
  navigate(id: string): void;
  /** Replace the page title / subtitle (HTML, caller-escaped). */
  heading(title: string, subtitle?: string): void;
  /** Mark the screen as a full-height workspace (grid + panel) with one scroll owner. */
  fill(): void;
}

/** "Live · updated 4s ago" indicator plus a refresh button, for the header. */
export function liveIndicator(ctx: ScreenCtx, refresh: () => void): (at: Date) => void {
  ctx.actions.innerHTML = `
    <span class="live" title="This page refreshes automatically"><span class="live-dot"></span><span class="live-text">Live</span></span>
    <ev-icon-button icon="refresh-cw" label="Refresh now"></ev-icon-button>`;
  const text = ctx.actions.querySelector('.live-text') as HTMLElement;
  ctx.actions.querySelector('ev-icon-button')?.addEventListener('click', refresh);
  let last: Date | null = null;
  const tick = (): void => {
    if (!last) return;
    const s = Math.round((Date.now() - last.getTime()) / 1000);
    text.textContent = s < 3 ? 'Live · just updated' : `Live · updated ${duration(s)} ago`;
  };
  const timer = setInterval(tick, 1000);
  ctx.onLeave(() => clearInterval(timer));
  return (at: Date) => { last = at; tick(); };
}
