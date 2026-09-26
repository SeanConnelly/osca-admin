/**
 * Home — "is this instance OK, and is anything about to need me?"
 * The instance is the page title; five headline figures; then what needs
 * attention, what runs next, who is busiest and how full the disks are.
 */
import { metrics, value, samples, systemState, trendOf, type Snapshot } from '../metrics';
import { alerts } from '../alerts';
import { getUpcomingTasks, getDashboard, type UpcomingTask, type Dashboard } from '../api';
import { irisCpu, irisCaption, type IrisCpu } from '../iris-cpu';
import { esc, pct, compact, mb, relative, irisDate, chip, skeleton, errorPanel, liveIndicator, statTile, setStat, middle, type ScreenCtx, type Tone } from '../ui';

interface Attention { tone: Tone; title: string; detail: string; action?: { label: string; go?: string; copy?: string } }

const band = (v: number, warn: number, danger: number): Tone => (v >= danger ? 'danger' : v >= warn ? 'warning' : 'success');

export function homeScreen(ctx: ScreenCtx): void {
  ctx.body.innerHTML = `
    <section class="stats stats--5">
      ${statTile('cpu', 'System CPU', 'trend')}
      ${statTile('mem', 'Memory', 'bar')}
      ${statTile('disk', 'Disk', 'bar')}
      ${statTile('procs', 'Processes', 'trend')}
      ${statTile('lic', 'License units', 'bar')}
    </section>
    <div class="columns">
      <div class="column column--wide">
        <section class="card">
          <header class="card-head"><h2>Needs attention</h2><span class="card-hint" id="attention-count"></span></header>
          <div id="attention">${skeleton(3)}</div>
        </section>
        <section class="card">
          <header class="card-head"><h2>Busiest right now</h2><button type="button" class="link" data-go="operations/processes">All processes</button></header>
          <div id="busiest">${skeleton(5)}</div>
        </section>
      </div>
      <div class="column">
        <section class="card">
          <header class="card-head"><h2>Coming up</h2><button type="button" class="link" data-go="tasks/upcoming">All tasks</button></header>
          <div id="upcoming">${skeleton(5)}</div>
        </section>
        <section class="card">
          <header class="card-head"><h2>Storage</h2><button type="button" class="link" data-go="databases/capacity">Capacity</button></header>
          <div id="storage">${skeleton(3)}</div>
        </section>
      </div>
    </div>`;
  const wireLinks = (root: ParentNode): void =>
    root.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go ?? '')));
  wireLinks(ctx.body);

  let snap: Snapshot | null = null;
  let dash: Dashboard | null = null;
  let alertCount = 0;
  const updated = liveIndicator(ctx, () => { void metrics.refresh(); void loadSlow(); });
  const $ = (id: string): HTMLElement => ctx.body.querySelector(`#${id}`) as HTMLElement;

  const renderHeading = (): void => {
    if (!snap) return;
    const info = samples(snap, 'iris_system_info')[0]?.labels ?? {};
    const state = systemState(value(snap, 'iris_system_state'));
    const mirror = value(snap, 'iris_mirror_member_type');
    const mirrorText = mirror === 2 ? 'Not mirrored' : mirror === 3 ? 'Mirror failover member' : mirror === 4 ? 'Mirror async member' : '';
    const why = state.tone === 'success' ? 'IRIS reports no problems' : 'IRIS has flagged its own health — see Needs attention';
    const meta = [
      `${esc(info.product ?? 'InterSystems IRIS')} ${esc(info.version ?? '')}${info.build_number ? ` · build ${esc(info.build_number)}` : ''}`,
      esc(info.platform ?? ''),
      dash ? `Up ${esc(dash.Status.UpTime.replace(/^0d /, ''))}` : '',
      mirrorText,
    ].filter(Boolean).join('<span class="meta-sep">·</span>');
    ctx.heading(`${esc(info.id ?? 'IRIS instance')} ${chip(state.label, state.tone, why)}`, meta);
  };

  const renderStats = (): void => {
    if (!snap) return;
    const cpu = value(snap, 'iris_cpu_usage');
    const mem = value(snap, 'iris_phys_mem_percent_used');
    const disks = samples(snap, 'iris_disk_percent_full');
    const worst = disks.reduce((a, b) => (b.value > a.value ? b : a), disks[0] ?? { value: NaN, labels: {} });
    const volume = /^([a-z]:)/i.exec(worst.labels.dir ?? '')?.[1]?.toUpperCase() ?? 'Volume';
    const free = value(snap, 'iris_directory_space', { id: worst.labels.id ?? '' });
    const procs = value(snap, 'iris_process_count');
    const used = value(snap, 'iris_license_consumed');
    const total = used + value(snap, 'iris_license_available');
    const licPct = value(snap, 'iris_license_percent_used');
    // System CPU is the whole machine; IRIS is the sum of its processes, per core.
    setStat(ctx.body, 'cpu', { value: pct(cpu), caption: irisCaption(irisCore), tone: band(cpu, 70, 90), trend: trendOf(snap, 'iris_cpu_usage'),
      title: 'System CPU covers everything on this machine. The IRIS figure adds up CPU used by IRIS processes over the last few seconds, measured against one core.' });
    setStat(ctx.body, 'mem', { value: pct(mem), caption: 'of RAM', tone: band(mem, 80, 92), fill: mem });
    setStat(ctx.body, 'disk', { value: pct(worst.value), caption: `${volume} · ${mb(free)} free`, tone: band(worst.value, 85, 95), fill: worst.value });
    setStat(ctx.body, 'procs', { value: compact(procs), caption: 'active', trend: trendOf(snap, 'iris_process_count') });
    setStat(ctx.body, 'lic', { value: Number.isFinite(total) ? `${used} of ${total}` : '—', caption: 'in use', tone: band(licPct, 80, 95), fill: licPct });
  };

  const renderAttention = (): void => {
    if (!snap) return;
    const items: Attention[] = [];
    const s = systemState(value(snap, 'iris_system_state'));
    if (s.tone !== 'success' && s.tone !== 'neutral') {
      items.push({ tone: s.tone === 'warning' ? 'warning' : 'danger', title: `IRIS reports a ${s.label.toLowerCase()} state`,
        detail: alertCount > 0 ? `${alertCount} alert${alertCount === 1 ? ' is' : 's are'} recorded since startup.` : 'The instance has flagged its own overall health.',
        action: { label: 'View alerts', go: 'logs/alerts' } });
    }
    const volumes = new Set<string>();
    for (const d of samples(snap, 'iris_disk_percent_full')) {
      const vol = /^([a-z]:)/i.exec(d.labels.dir ?? '')?.[1]?.toUpperCase() ?? d.labels.dir;
      if (d.value < 85 || volumes.has(vol)) continue;
      volumes.add(vol);
      items.push({ tone: d.value >= 95 ? 'danger' : 'warning', title: `${esc(vol)} is ${pct(d.value)} full`, detail: 'Databases on this volume will stop growing when it fills.', action: { label: 'See capacity', go: 'databases/capacity' } });
    }
    for (const m of samples(snap, 'iris_db_max_size_mb')) {
      if (m.value <= 0) continue;
      const size = value(snap, 'iris_db_size_mb', { id: m.labels.id });
      if (size / m.value >= 0.9) items.push({ tone: 'warning', title: `${esc(m.labels.id)} is near its size limit`, detail: `${Math.round(size)} of ${Math.round(m.value)} MB used.`, action: { label: 'See capacity', go: 'databases/capacity' } });
    }
    const licPct = value(snap, 'iris_license_percent_used');
    if (licPct >= 80) items.push({ tone: licPct >= 95 ? 'danger' : 'warning', title: `License ${pct(licPct)} used`, detail: 'New connections are refused when license units run out.', action: { label: 'License', go: 'settings/license' } });
    const longest = value(snap, 'iris_trans_open_secs_max');
    if (longest >= 60) items.push({ tone: 'warning', title: 'A transaction has been open for a long time', detail: `The longest open transaction started ${Math.round(longest)}s ago.`, action: { label: 'Processes', go: 'operations/processes' } });
    if (dash?.Status.LastBackup === 'Never') items.push({ tone: 'warning', title: 'No backup has ever run', detail: 'There is no recorded backup of this instance.', action: { label: 'Schedule one', go: 'tasks/new' } });
    const held = alerts.count();
    if (alertCount > held && s.tone === 'success') items.push({ tone: 'info', title: `${alertCount - held} alert${alertCount - held === 1 ? '' : 's'} raised before the portal was watching`,
      detail: 'IRIS delivers each alert once, so these can only be read in alerts.log.', action: { label: 'Details', go: 'logs/alerts' } });
    if (dash && !dash.Status.SystemMonitor) items.push({ tone: 'info', title: 'System Monitor is not running', detail: 'IRIS raises no health alerts of its own until it runs. Start it from a %SYS terminal.', action: { label: 'Copy command', copy: 'do ^%SYSMONMGR' } });

    $('attention-count').textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';
    const el = $('attention');
    el.innerHTML = items.length === 0
      ? `<div class="all-clear"><ev-icon name="check-circle" size="md"></ev-icon><div><strong>All clear</strong><span>Nothing on this instance needs you right now.</span></div></div>`
      : `<ul class="attention-list">${items.map((a) => `
          <li class="attention attention--${a.tone}">
            <ev-icon name="${a.tone === 'info' ? 'info' : 'alert-triangle'}" size="sm"></ev-icon>
            <div class="attention-text"><strong>${a.title}</strong><span>${a.detail}</span></div>
            ${a.action ? `<button type="button" class="btn btn--sm" ${a.action.go ? `data-go="${a.action.go}"` : `data-copy="${esc(a.action.copy ?? '')}" title="${esc(a.action.copy ?? '')}"`}>${a.action.label}</button>` : ''}
          </li>`).join('')}</ul>`;
    wireLinks(el);
    el.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      void navigator.clipboard.writeText(b.dataset.copy ?? '').then(() => {
        b.textContent = 'Copied';
        setTimeout(() => { b.textContent = 'Copy command'; }, 1600);
      });
    }));
  };

  const renderUpcoming = (tasks: UpcomingTask[]): void => {
    const el = $('upcoming');
    if (tasks.length === 0) {
      el.innerHTML = `<div class="all-clear all-clear--neutral"><ev-icon name="calendar" size="md"></ev-icon><div><strong>Nothing scheduled</strong><span>The task manager has no upcoming runs.</span></div></div>`;
      return;
    }
    // Group runs that share a start time under one time header.
    const today = new Date().toDateString();
    const groups: Array<{ when: string; at: Date; names: string[] }> = [];
    for (const t of tasks.slice(0, 7)) {
      const at = irisDate(t.Datetime);
      const day = at.toDateString() === today ? 'Today' : at.toLocaleDateString(undefined, { weekday: 'short' });
      const when = `${day} ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
      const last = groups[groups.length - 1];
      if (last && last.when === when) last.names.push(t.Name);
      else groups.push({ when, at, names: [t.Name] });
    }
    el.innerHTML = groups.map((g) => `
      <div class="group-head"><span class="row-time">${esc(g.when)}</span><span class="row-meta">${esc(relative(g.at))}</span></div>
      <ul class="rows">${g.names.map((n) => `<li class="row row--compact"><span class="row-main">${esc(n)}</span></li>`).join('')}</ul>`).join('');
  };

  // "Busiest right now": CPU used between polls, as % of one core —
  // lifetime CPU would always crown the same long-running daemons.
  let irisCore: number | null = null; // IRIS processes together, % of one core
  const renderBusiest = (c: IrisCpu): void => {
    irisCore = c.total;
    renderStats();
    const active = c.procs
      .map((p) => ({ p, pct: c.pct.get(p.Pid) ?? 0 }))
      .filter((x) => x.pct > 0.05)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
    if (!active.some((x) => x.pct >= 1)) {
      // Near-idle: say so, instead of bars that make 0.3% look like load.
      const top = active[0];
      const sys = snap ? Math.round(value(snap, 'iris_cpu_usage')) : NaN;
      $('busiest').innerHTML = `<div class="all-clear all-clear--neutral"><ev-icon name="cpu" size="md"></ev-icon><div><strong>Idle</strong>
        <span>No IRIS process is above 1% of one core.${Number.isFinite(sys) ? ` System CPU (${sys}%) is almost all outside IRIS.` : ''}${top ? ` Most active: <span class="mono">${esc(middle(top.p.Routine || '(no routine)', 30))}</span> at ${top.pct.toFixed(1)}%.` : ''}</span></div></div>`;
      return;
    }
    // Bars are a share of one full core, never relative to the busiest process.
    $('busiest').innerHTML = `<ul class="rows">${active.map(({ p, pct: c }) => `
      <li class="row row--bar">
        <span class="row-main mono" title="${esc(p.Routine)}">${esc(middle(p.Routine || '(no routine)', 34))}</span>
        <span class="row-sub">${p.Username ? esc(p.Username === 'UnknownUser' ? 'Unauthenticated' : p.Username) : 'System'} · PID ${esc(p.Pid)}</span>
        <span class="minibar" title="Share of one CPU core"><span style="width:${Math.max(1, Math.min(100, c))}%"></span></span>
        <span class="row-meta">${c < 10 ? c.toFixed(1) : Math.round(c)}% CPU</span>
      </li>`).join('')}</ul>`;
  };

  const renderStorage = (): void => {
    if (!snap) return;
    const vols = new Map<string, { full: number; free: number }>();
    for (const s of samples(snap, 'iris_disk_percent_full')) {
      const vol = /^([a-z]:)/i.exec(s.labels.dir ?? '')?.[1]?.toUpperCase() ?? s.labels.dir;
      if (!vols.has(vol)) vols.set(vol, { full: s.value, free: value(snap, 'iris_directory_space', { id: s.labels.id }) });
    }
    const dbTotal = samples(snap, 'iris_db_size_mb').reduce((a, s) => a + s.value, 0);
    $('storage').innerHTML = `<ul class="rows">
      ${[...vols].map(([vol, v]) => `<li class="row row--stack">
        <div class="row-line"><span class="row-main">${esc(vol)}</span><span class="row-meta">${pct(v.full)} used · ${mb(v.free)} free</span></div>
        <div class="bar bar--${band(v.full, 85, 95)}"><span style="width:${Math.min(100, v.full)}%"></span></div></li>`).join('')}
      <li class="row"><span class="row-main">Databases</span><span class="row-meta">${samples(snap, 'iris_db_size_mb').length} · ${mb(dbTotal)}</span></li>
      <li class="row"><span class="row-main">Journal files</span><span class="row-meta">${mb(value(snap, 'iris_jrn_size'))}</span></li>
      <li class="row"><span class="row-main">Last backup</span>${dash?.Status.LastBackup === 'Never'
        ? `<span class="row-meta row-meta--warning"><ev-icon name="alert-triangle" size="xs"></ev-icon>Never</span>`
        : `<span class="row-meta">${dash ? esc(dash.Status.LastBackup) : '—'}</span>`}</li>
    </ul>`;
  };

  const loadSlow = async (): Promise<void> => {
    const [d, t] = await Promise.allSettled([getDashboard(), getUpcomingTasks()]);
    if (d.status === 'fulfilled') dash = d.value;
    if (t.status === 'fulfilled') renderUpcoming(t.value);
    else { $('upcoming').innerHTML = errorPanel(t.reason, 'retry-upcoming'); $('upcoming').querySelector('#retry-upcoming')?.addEventListener('click', () => void loadSlow()); }
    renderHeading(); renderAttention(); renderStorage();
  };
  void loadSlow();
  const slow = setInterval(() => void loadSlow(), 30000);
  ctx.onLeave(() => clearInterval(slow));

  $('busiest').innerHTML = '<div class="row-measuring">Measuring CPU use…</div>';
  ctx.onLeave(irisCpu.subscribe((c, err) => {
    if (c) { renderBusiest(c); return; }
    $('busiest').innerHTML = errorPanel(err);
  }));

  ctx.onLeave(metrics.subscribe((s, at) => {
    snap = s;
    alertCount = value(s, 'iris_system_alerts');
    updated(at);
    renderHeading(); renderStats(); renderAttention(); renderStorage();
  }, (err) => {
    $('attention').innerHTML = errorPanel(err, 'retry-metrics');
    $('attention').querySelector('#retry-metrics')?.addEventListener('click', () => void metrics.refresh());
  }));
  ctx.onLeave(alerts.subscribe(() => renderAttention()));
}
