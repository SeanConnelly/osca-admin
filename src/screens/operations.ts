// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Operations › Overview — how hard the instance is working, right now and
 * over the last few minutes. Everything here comes from %Api.Monitor's
 * Prometheus feed via the shared metrics poller.
 */
import '../styles-ops.css';
import '@evolution-ui/core/components/ev-toggle/ev-toggle.js';
import { metrics, value, samples, type Snapshot } from '../metrics';
import { usage, type RateKey, type Rates } from '../usage';
import { measureReadCosts, minCosts, portalRate, getSharedMemory, type PortalRead, type ReadCosts, type ShmRow } from '../api-ops';
import { irisCpu, irisCaption } from '../iris-cpu';
import { esc, pct, compact, duration, errorPanel, liveIndicator, statTile, setStat, sparkline, skeleton, type ScreenCtx, type Tone } from '../ui';

const band = (v: number, warn: number, danger: number): Tone => (v >= danger ? 'danger' : v >= warn ? 'warning' : 'success');

/** Rates the portal computes from Admin API counters, plus SQL from the monitor feed. */
const THROUGHPUT: Array<{ label: string; key: RateKey | 'sql'; hint: string }> = [
  { label: 'Global references', key: 'AllGlobalReferences', hint: 'Reads and writes of globals' },
  { label: 'Global updates', key: 'GlobalUpdateReferences', hint: 'SET and KILL operations on globals' },
  { label: 'Logical reads', key: 'LogicalBlockRequests', hint: 'Database blocks requested, from cache or disk' },
  { label: 'Physical reads', key: 'BlockReads', hint: 'Database blocks read from disk' },
  { label: 'Physical writes', key: 'BlockWrites', hint: 'Database blocks written to disk' },
  { label: 'Routine calls', key: 'RoutineCalls', hint: 'Routine calls' },
  { label: 'SQL statements', key: 'sql', hint: 'SQL statements per second, averaged by IRIS' },
  { label: 'Journal entries', key: 'JournalEntries', hint: 'Journal records created' },
];

/** Range control: the in-memory history only (no extra reads). */
type Range = '15m' | '1h';
const RANGE_MS: Record<Range, number> = { '15m': 15 * 60_000, '1h': 60 * 60_000 };
let range: Range = '15m';

/**
 * Readings with the portal's own share taken out, per figure, with their times.
 * Module-level so they outlive a visit, like the history they are drawn beside.
 */
const adjusted = new Map<RateKey, Array<{ v: number; t: number }>>();
const ADJ_MAX = 720;

/** Values from a timed series that fall inside the current range. */
function inRange(values: number[], times: number[], now = Date.now()): number[] {
  const from = now - RANGE_MS[range];
  const off = times.length - values.length;
  return values.filter((_, i) => (times[i + off] ?? now) >= from);
}

/** The one number format for Activity's cells: grouped below 10K ("1,500"), compact from 10K ("13.6K"). */
function fig(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) < 10_000 ? Math.round(n).toLocaleString() : compact(n);
}
const ms = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : '—');

/** Sessions & engine: the same cell as Throughput (label, value, unit, one note line), without a trend. */
const ENGINE: Array<{ key: string; label: string; unit?: string; hint?: string }> = [
  { key: 'sessions', label: 'Web sessions' },
  { key: 'gateway', label: 'Gateway connections', hint: 'Connections from the web gateway that are busy with a request now' },
  { key: 'latency', label: 'Gateway latency', unit: 'ms' },
  { key: 'txn', label: 'Open transactions' },
  { key: 'cache', label: 'Cache efficiency', hint: 'Global references per physical read or write; higher is better' },
  { key: 'wd', label: 'Write daemon cycle', unit: 'ms' },
  { key: 'ecp', label: 'ECP connections' },
  { key: 'sqlrt', label: 'SQL average runtime', unit: 'ms' },
];

function setTile(root: ParentNode, key: string, v: number, series: number[], prefix = ''): void {
  const tile = root.querySelector(`[data-metric="${key}"]`) as HTMLElement;
  (tile.querySelector('.v') as HTMLElement).textContent = Number.isFinite(v) ? `${prefix}${fig(v)}` : '—';
  // Until there are 6 readings, a muted "Collecting…" instead of an empty track; then the line.
  const slot = tile.querySelector('.ops-tp-spark') as HTMLElement;
  const n = series.filter((x) => Number.isFinite(x)).length;
  slot.innerHTML = n >= 6 ? sparkline(series, { height: 28 }) : '<span class="ops-collecting">Collecting…</span>';
}

/** Bytes in the unit that reads best: "812 KB", "5.3 MB". */
function bytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024).toLocaleString()} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
const SHM_TONES = ['var(--ev-color-primary)', 'var(--ev-color-info)', 'var(--ev-accent-7, var(--ev-color-primary))', 'var(--ev-neutral-6, var(--ev-border-2))', 'var(--ev-neutral-5, var(--ev-border-2))'];

/** Shared memory card: one stacked bar of the biggest users, then a small table (used, heap allocated). */
function renderShm(root: ParentNode, rows: ShmRow[]): void {
  const el = root.querySelector('#shm') as HTMLElement | null;
  if (!el) return;
  const parts = rows.filter((r) => !/^(total|available)/i.test(r.Description) && r.AllUsed > 0).sort((a, b) => b.AllUsed - a.AllUsed);
  const used = rows.find((r) => /^total$/i.test(r.Description))?.AllUsed ?? parts.reduce((t, r) => t + r.AllUsed, 0);
  const heap = rows.find((r) => /^total smh pages allocated$/i.test(r.Description))?.SMHAllocated ?? 0;
  (root.querySelector('#shm-total') as HTMLElement).textContent = heap ? `${bytes(used)} used · ${bytes(heap)} heap` : `${bytes(used)} used`;
  const top = parts.slice(0, 5);
  const rest = parts.slice(5);
  const restUsed = rest.reduce((t, r) => t + r.AllUsed, 0);
  const segs = [...top.map((r, i) => ({ label: r.Description, v: r.AllUsed, c: SHM_TONES[i] })), ...(restUsed ? [{ label: `${rest.length} others`, v: restUsed, c: 'var(--ev-border-2)' }] : [])];
  const total = segs.reduce((t, s) => t + s.v, 0) || 1;
  const bar = `<div class="shm-bar" role="img" aria-label="${esc(segs.map((s) => `${s.label} ${bytes(s.v)}`).join(', '))}">${segs.map((s) => `<span style="flex:${s.v / total};background:${s.c}" title="${esc(`${s.label}: ${bytes(s.v)}`)}"></span>`).join('')}</div>`;
  const row = (label: string, c: string, u: number, alloc: number): string =>
    `<tr><td><span class="shm-key" style="background:${c}"></span>${esc(label)}</td><td class="r">${bytes(u)}</td><td class="r">${alloc ? bytes(alloc) : '<span class="dim">—</span>'}</td></tr>`;
  el.innerHTML = `${bar}
    <table class="mini-table shm-table"><thead><tr><th>Subsystem</th><th class="r">Used</th><th class="r" title="Shared memory heap set aside for it">Heap allocated</th></tr></thead><tbody>
      ${top.map((r, i) => row(r.Description, SHM_TONES[i], r.AllUsed, r.SMHAllocated)).join('')}
      ${rest.length ? row(`${rest.length} others`, 'var(--ev-border-2)', restUsed, rest.reduce((t, r) => t + r.SMHAllocated, 0)) : ''}
    </tbody></table>`;
}

export function operationsScreen(ctx: ScreenCtx): void {
  ctx.body.innerHTML = `
    <section class="stats stats--4">
      ${statTile('cpu', 'System CPU', 'trend')}
      ${statTile('mem', 'Memory', 'bar')}
      ${statTile('page', 'Page file', 'bar')}
      ${statTile('smh', 'Shared memory', 'bar')}
    </section>
    <section class="card">
      <header class="card-head"><h2>Throughput</h2><span class="card-hint">Per second · 20 s average</span></header>
      <div class="metric-grid ops-tp-grid">
        ${THROUGHPUT.map((t) => `
          <div class="ops-tp" data-metric="${t.key}" title="${esc(t.hint)}">
            <span class="metric-label">${t.label}</span>
            <span class="ops-tp-value"><span class="v">—</span><span class="unit">/s</span></span>
            <span class="ops-tp-spark spark-slot"><span class="ops-collecting">Collecting…</span></span>
          </div>`).join('')}
      </div>
    </section>
    <section class="card">
      <header class="card-head"><h2>Sessions &amp; engine</h2></header>
      <div class="metric-grid" id="engine">
        ${ENGINE.map((e) => `
          <div class="metric ops-metric--plain" data-engine="${e.key}"${e.hint ? ` title="${esc(e.hint)}"` : ''}>
            <span class="metric-label">${e.label}</span>
            <span class="metric-value"><span class="v">—</span>${e.unit ? `<span class="unit">${e.unit}</span>` : ''}</span>
            <span class="ops-metric-note"></span>
          </div>`).join('')}
      </div>
    </section>
    <section class="card">
      <header class="card-head"><h2>Shared memory</h2><span class="card-hint" id="shm-total"></span></header>
      <div id="shm">${skeleton(3)}</div>
    </section>`;
  ctx.body.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go ?? '')));
  // Range: how much of the in-memory history the trends show.
  // The page's view controls, together in the header: which history, and whether the portal's own reads count.
  ctx.actions.insertAdjacentHTML('beforeend', `<div class="ops-head-opts" id="ops-head-opts">
    <span class="ops-switch" title="Leave out the load this portal adds by reading these figures"><span class="ops-switch-label" id="own-label">Exclude portal monitoring</span><ev-toggle id="own-toggle" aria-labelledby="own-label"></ev-toggle></span>
    <ev-segmented-button id="ops-range" size="sm" aria-label="Time range"></ev-segmented-button>
  </div>`);
  const rangeEl = ctx.actions.querySelector('#ops-range') as HTMLElement & { options: unknown; value: string };
  rangeEl.options = [{ value: '15m', label: '15m' }, { value: '1h', label: '1h' }];
  rangeEl.value = range;
  rangeEl.addEventListener('ev-segmented-button-change', (e) => {
    range = (e as CustomEvent<{ value: Range }>).detail.value;
    paintRates();
    if (lastSnap) render(lastSnap);
  });
  ctx.onLeave(() => ctx.actions.querySelector('#ops-head-opts')?.remove());
  const $ = (id: string): HTMLElement => ctx.body.querySelector(`#${id}`) as HTMLElement;
  const updated = liveIndicator(ctx, () => void metrics.refresh());

  let irisTotal: number | null = null;
  let lastSnap: Snapshot | null = null;
  // Activity charts these figures, so read them every 20s while it is open.
  metrics.setFast(true);
  ctx.onLeave(() => metrics.setFast(false));
  ctx.onLeave(irisCpu.subscribe((c) => { irisTotal = c ? c.total : null; if (lastSnap) render(lastSnap); }));

  const cpuTrend = (): number[] => { const h = metrics.history('iris_cpu_usage'); return inRange(h.values, h.times); };
  const render = (snap: Snapshot): void => {
    lastSnap = snap;
    const cpu = value(snap, 'iris_cpu_usage');
    const mem = value(snap, 'iris_phys_mem_percent_used');
    const page = value(snap, 'iris_page_space_percent_used');
    const smh = value(snap, 'iris_smh_total_percent_full');
    setStat(ctx.body, 'cpu', { value: pct(cpu), caption: irisCaption(irisTotal), tone: band(cpu, 70, 90), trend: cpuTrend(),
      title: 'System CPU covers everything on this machine. The IRIS figure adds up CPU used by IRIS processes over the last few seconds, measured against one core.' });
    setStat(ctx.body, 'mem', { value: pct(mem), caption: 'of RAM', tone: band(mem, 80, 92), fill: mem });
    setStat(ctx.body, 'page', { value: pct(page), caption: 'of allocated swap', tone: band(page, 70, 90), fill: page });
    setStat(ctx.body, 'smh', { value: pct(smh), caption: 'of instance heap', tone: band(smh, 80, 92), fill: smh });

    const sql = metrics.history('iris_sql_queries_per_second', { id: 'all' });
    setTile(ctx.body, 'sql', value(snap, 'iris_sql_queries_per_second', { id: 'all' }), inRange(sql.values, sql.times));

    const busy = samples(snap, 'iris_csp_in_use_connections').reduce((a, s) => a + s.value, 0);
    const conns = samples(snap, 'iris_csp_actual_connections').reduce((a, s) => a + s.value, 0);
    const open = value(snap, 'iris_trans_open_count');
    ctx.body.querySelector('.ops-engine-err')?.remove();
    const cell = (key: string, v: string, note = ''): void => {
      const el = ctx.body.querySelector(`[data-engine="${key}"]`) as HTMLElement;
      (el.querySelector('.v') as HTMLElement).textContent = v;
      (el.querySelector('.ops-metric-note') as HTMLElement).textContent = note;
    };
    cell('sessions', fig(value(snap, 'iris_csp_sessions')), 'open now');
    cell('gateway', fig(busy), Number.isFinite(conns) ? `busy of ${fig(conns)} open` : '');
    cell('latency', ms(samples(snap, 'iris_csp_gateway_latency')[0]?.value ?? NaN), 'gateway round trip');
    cell('txn', fig(open), open > 0 ? `longest ${duration(Math.max(60, Math.floor(value(snap, 'iris_trans_open_secs_max') / 60) * 60))}` : 'none open');
    cell('cache', fig(value(snap, 'iris_cache_efficiency')), 'refs per disk I/O');
    cell('wd', fig(value(snap, 'iris_wd_cycle_time')), 'last write to disk');
    cell('ecp', fig(value(snap, 'iris_ecp_conn') + value(snap, 'iris_ecps_conn')), 'as client and server');
    cell('sqlrt', ms(value(snap, 'iris_sql_queries_avg_runtime') * 1000), 'per statement');
  };

  /*
   * "Exclude portal monitoring" (off by default). Each throughput reading is a
   * counter delta over usage's 20 s window, so the portal's share is counted in
   * that same window: every read this page makes (metrics scrapes, counter
   * reads, process lists, and the cost measurement itself) is logged with its
   * time, and each read's cost is measured, not assumed. Reads the page can't
   * see (other tabs, the status bar's security and dashboard reads) stay in.
   */
  const events: Array<{ kind: PortalRead; at: number }> = [];
  const log = (kind: PortalRead, at = Date.now()): void => {
    events.push({ kind, at });
    while (events.length && events[0].at < at - 60_000) events.shift();
  };
  let costs: ReadCosts | null = null;
  const measure = async (): Promise<void> => {
    try { costs = minCosts(costs, await measureReadCosts(log)); } catch { /* keep the last measurement */ }
  };
  void measure();
  const measureTimer = setInterval(() => void measure(), 300_000);
  ctx.onLeave(() => clearInterval(measureTimer));

  let exclude = false;
  /** usage's sample times on this visit, trimmed exactly as usage trims its window. */
  const times: number[] = [];
  /** Per figure, whether the latest reading could have the portal's share taken out ("≈"). */
  const approx = new Map<RateKey, boolean>();
  let share: Partial<Record<RateKey, number>> = {};
  let lastRates: Rates | null = null;
  const paintRates = (): void => {
    const r = lastRates;
    if (!r) return;
    for (const t of THROUGHPUT) {
      if (t.key === 'sql') continue;
      const k = t.key;
      const adj = adjusted.get(k) ?? [];
      const on = exclude && !!costs && adj.length > 0;
      const h = usage.history(k);
      const series = on ? inRange(adj.map((x) => x.v), adj.map((x) => x.t)) : inRange(h.values, h.times);
      const ok = on && approx.get(k) === true;
      setTile(ctx.body, k, on ? adj[adj.length - 1].v : r[k], series, ok ? '≈ ' : '');
      const mine = share[k] ?? 0;
      (ctx.body.querySelector(`[data-metric="${k}"]`) as HTMLElement).title = !costs || mine < 1 ? t.hint
        : on && !ok ? `${t.hint}. This portal’s share couldn’t be separated from this reading, so it is shown as IRIS counts it.`
          : `${t.hint}. This portal’s own reads account for about ${compact(mine)}/s of this reading${on ? ', left out here' : ''}.`;
    }
  };
  const toggle = ctx.actions.querySelector('#own-toggle') as HTMLElement & { checked: boolean };
  toggle.addEventListener('ev-toggle-change', () => { exclude = !!toggle.checked; paintRates(); });
  // The label sits left of the switch (outside it), so clicking the words flips it too.
  ctx.actions.querySelector('#own-label')?.addEventListener('click', () => { toggle.checked = !toggle.checked; exclude = toggle.checked; paintRates(); });

  // Subscriptions deliver a cached value synchronously; only later calls are real reads.
  let syncing = true;
  times.push(Date.now());
  log('usage');
  ctx.onLeave(usage.subscribe((r) => {
    lastRates = r;
    if (!syncing) {
      const t = Date.now();
      log('usage', t);
      times.push(t);
      while (times.length > 2 && t - times[1] >= 20_000) times.shift();
      const p = costs ? portalRate(events, costs, times[0], t) : null;
      share = p ?? {};
      for (const th of THROUGHPUT) {
        if (th.key === 'sql') continue;
        const k = th.key;
        const a = p ? r[k] - p[k] : NaN;
        // A reading at or below the portal's own share means the attribution missed for this window: show it as counted.
        const good = r[k] <= 0 ? true : a >= 0.5; // never "≈ 0" while IRIS counts activity
        approx.set(k, !!p && good);
        const list = adjusted.get(k) ?? [];
        list.push({ v: p && good ? Math.max(0, a) : r[k], t });
        if (list.length > ADJ_MAX) list.shift();
        adjusted.set(k, list);
      }
    }
    paintRates();
  }));
  ctx.onLeave(irisCpu.subscribe(() => { if (!syncing) log('proc'); }));
  // Shared memory by subsystem: read with the page's own refresh (each metrics reading), never faster.
  let shmBusy = false;
  const loadShm = async (): Promise<void> => {
    if (shmBusy) return;
    shmBusy = true;
    try { renderShm(ctx.body, await getSharedMemory()); } catch (err) {
      const el = ctx.body.querySelector('#shm');
      if (el && !el.querySelector('.shm-bar')) el.innerHTML = errorPanel(err);
    } finally { shmBusy = false; }
  };
  void loadShm();
  ctx.onLeave(metrics.subscribe((snap, at) => { if (!syncing) { log('scrape', at.getTime()); void loadShm(); } updated(at); render(snap); }, (err) => {
    ctx.body.querySelector('.ops-engine-err')?.remove();
    $('engine').insertAdjacentHTML('afterend', `<div class="ops-engine-err">${errorPanel(err, 'retry-ops')}</div>`);
    ctx.body.querySelector('#retry-ops')?.addEventListener('click', () => void metrics.refresh());
  }));
  syncing = false;
}
