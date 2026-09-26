/**
 * Operations › Overview — how hard the instance is working, right now and
 * over the last few minutes. Everything here comes from %Api.Monitor's
 * Prometheus feed via the shared metrics poller.
 */
import { metrics, value, samples, trendOf, type Snapshot } from '../metrics';
import { usage, observerCost, type RateKey, type Rates } from '../usage';
import { METRICS_POLL_MS } from '../metrics';
import { irisCpu, irisCaption } from '../iris-cpu';
import { esc, pct, compact, mb, errorPanel, liveIndicator, statTile, setStat, skeleton, type ScreenCtx, type Tone } from '../ui';

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

function setTile(root: ParentNode, key: string, v: number, series: number[]): void {
  const tile = root.querySelector(`[data-metric="${key}"]`) as HTMLElement;
  (tile.querySelector('.v') as HTMLElement).textContent = Number.isFinite(v) ? compact(v) : '—';
  // min=0 / max=10 on the element keep near-zero rates drawing near-flat.
  (tile.querySelector('ev-sparkline') as HTMLElement & { values: number[] }).values = series.length ? series : [0, 0];
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
      <div class="metric-grid">
        ${THROUGHPUT.map((t) => `
          <div class="metric" data-metric="${t.key}" title="${esc(t.hint)}">
            <span class="metric-label">${t.label}</span>
            <span class="metric-value"><span class="v">—</span><span class="unit">/s</span></span>
            <ev-sparkline type="line" width="112" height="28" min="0" max="10"></ev-sparkline>
            <span class="metric-own"></span>
          </div>`).join('')}
      </div>
    </section>
    <div class="grid-5">
      <section class="card span-3">
        <header class="card-head"><h2>Storage</h2><button type="button" class="link" data-go="databases/capacity">Database capacity</button></header>
        <div id="storage">${skeleton(4)}</div>
      </section>
      <section class="card span-2">
        <header class="card-head"><h2>Sessions &amp; engine</h2></header>
        <div id="engine">${skeleton(4)}</div>
      </section>
    </div>`;
  ctx.body.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go ?? '')));
  const $ = (id: string): HTMLElement => ctx.body.querySelector(`#${id}`) as HTMLElement;
  const updated = liveIndicator(ctx, () => void metrics.refresh());

  let irisTotal: number | null = null;
  let lastSnap: Snapshot | null = null;
  ctx.onLeave(irisCpu.subscribe((c) => { irisTotal = c ? c.total : null; if (lastSnap) render(lastSnap); }));

  const render = (snap: Snapshot): void => {
    lastSnap = snap;
    const cpu = value(snap, 'iris_cpu_usage');
    const mem = value(snap, 'iris_phys_mem_percent_used');
    const page = value(snap, 'iris_page_space_percent_used');
    const smh = value(snap, 'iris_smh_total_percent_full');
    setStat(ctx.body, 'cpu', { value: pct(cpu), caption: irisCaption(irisTotal), tone: band(cpu, 70, 90), trend: trendOf(snap, 'iris_cpu_usage'),
      title: 'System CPU covers everything on this machine. The IRIS figure adds up CPU used by IRIS processes over the last few seconds, measured against one core.' });
    setStat(ctx.body, 'mem', { value: pct(mem), caption: 'of RAM', tone: band(mem, 80, 92), fill: mem });
    setStat(ctx.body, 'page', { value: pct(page), caption: 'of allocated swap', tone: band(page, 70, 90), fill: page });
    setStat(ctx.body, 'smh', { value: pct(smh), caption: 'of instance heap', tone: band(smh, 80, 92), fill: smh });

    setTile(ctx.body, 'sql', value(snap, 'iris_sql_queries_per_second', { id: 'all' }), metrics.trend('iris_sql_queries_per_second', { id: 'all' }));

    // Volumes (databases share disks) and the databases on them, largest first.
    const vols = new Map<string, { full: number; free: number }>();
    for (const s of samples(snap, 'iris_disk_percent_full')) {
      const vol = /^([a-z]:)/i.exec(s.labels.dir ?? '')?.[1]?.toUpperCase() ?? s.labels.dir;
      if (!vols.has(vol)) vols.set(vol, { full: s.value, free: value(snap, 'iris_directory_space', { id: s.labels.id }) });
    }
    const dbs = samples(snap, 'iris_db_size_mb')
      .map((s) => ({ id: s.labels.id, size: s.value, free: value(snap, 'iris_db_free_space', { id: s.labels.id }), max: value(snap, 'iris_db_max_size_mb', { id: s.labels.id }) }))
      .sort((a, b) => b.size - a.size);
    const jrn = `Journal files ${mb(value(snap, 'iris_jrn_size'))}`;
    $('storage').innerHTML = `
      ${[...vols].map(([vol, v]) => `<div class="volume">
        <div class="row-line"><span class="row-main">${esc(vol)}</span><span class="row-meta">${pct(v.full)} used · ${mb(v.free)} free</span></div>
        <div class="bar bar--${band(v.full, 85, 95)}"><span style="width:${Math.min(100, v.full)}%"></span></div>
        <div class="volume-sub">${dbs.length} databases · ${jrn}</div></div>`).join('')}
      <table class="mini-table">
        <thead><tr><th>Database</th><th class="r" colspan="2" title="The bar shows each database's size relative to the largest one">Size</th><th class="r">Free in file</th></tr></thead>
        <tbody>${dbs.map((d) => `<tr><td class="mono">${esc(d.id)}</td>
          <td class="bar-col"><span class="sizebar" title="Size relative to the largest database, not how full it is"><span style="width:${(d.size / Math.max(1, dbs[0]?.size ?? 1)) * 100}%"></span></span></td>
          <td class="r">${mb(d.size)}${d.max > 0 ? ` <span class="limit">/ ${mb(d.max)} limit</span>` : ''}</td>
          <td class="r">${mb(d.free)}</td></tr>`).join('')}
        </tbody>
      </table>`;

    const busy = samples(snap, 'iris_csp_in_use_connections').reduce((a, s) => a + s.value, 0);
    const conns = samples(snap, 'iris_csp_actual_connections').reduce((a, s) => a + s.value, 0);
    const open = value(snap, 'iris_trans_open_count');
    const kv = (k: string, v: string, hint = ''): string => `<div class="kv-cell"${hint ? ` title="${esc(hint)}"` : ''}><dt>${k}</dt><dd>${v}</dd></div>`;
    $('engine').innerHTML = `<dl class="kv-grid">
      ${kv('Web sessions', compact(value(snap, 'iris_csp_sessions')))}
      ${kv('Gateway connections', `${compact(busy)} <span class="dim">busy of</span> ${compact(conns)}`)}
      ${kv('Gateway latency', `${(samples(snap, 'iris_csp_gateway_latency')[0]?.value ?? NaN).toFixed(1)} <span class="dim">ms</span>`)}
      ${kv('Open transactions', open > 0 ? `${compact(open)} <span class="dim">· longest ${Math.round(value(snap, 'iris_trans_open_secs_max'))}s</span>` : 'None')}
      ${kv('Cache efficiency', `${compact(value(snap, 'iris_cache_efficiency'))} <span class="dim">refs / disk I/O</span>`, 'Global references per physical read or write — higher is better')}
      ${kv('Write daemon cycle', `${compact(value(snap, 'iris_wd_cycle_time'))} <span class="dim">ms</span>`)}
      ${kv('ECP connections', compact(value(snap, 'iris_ecp_conn') + value(snap, 'iris_ecps_conn')))}
      ${kv('SQL avg runtime', `${(value(snap, 'iris_sql_queries_avg_runtime') * 1000).toFixed(1)} <span class="dim">ms</span>`)}
    </dl>`;
  };

  // The portal's own monitoring load, measured (not assumed) and shown where it matters.
  let own: Rates | null = null;
  const measure = async (): Promise<void> => { own = await observerCost(METRICS_POLL_MS / 1000); };
  void measure();
  const measureTimer = setInterval(() => void measure(), 120000);
  ctx.onLeave(() => clearInterval(measureTimer));

  ctx.onLeave(usage.subscribe((r) => {
    for (const t of THROUGHPUT) {
      if (t.key === 'sql') continue;
      setTile(ctx.body, t.key, r[t.key], usage.trend(t.key));
      const note = ctx.body.querySelector(`[data-metric="${t.key}"] .metric-own`) as HTMLElement;
      const mine = own ? own[t.key] : 0;
      // Only call it out when the portal is a meaningful share of the figure.
      // The note line is always reserved (so values align); it is just empty when not needed.
      const show = mine >= 1 && mine >= r[t.key] * 0.1;
      note.textContent = '';
      if (show) note.textContent = mine >= r[t.key] * 0.9
        ? 'Nearly all from this portal’s own monitoring'
        : `≈${compact(mine)}/s from this portal’s monitoring`;
    }
  }));
  ctx.onLeave(metrics.subscribe((snap, at) => { updated(at); render(snap); }, (err) => {
    $('storage').innerHTML = errorPanel(err, 'retry-ops');
    $('storage').querySelector('#retry-ops')?.addEventListener('click', () => void metrics.refresh());
  }));
}
