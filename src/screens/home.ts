// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Home — the triage page: "is this instance OK, and is anything about to need me?"
 * The instance is the page title; five headline figures; then, side by side at
 * equal natural height, what needs attention (the shared issues model,
 * ranked) and what runs next. Below the fold: the busiest processes and the
 * instance's own figures.
 */
import '../styles-ops.css';
import '../styles-disk.css';
import { metrics, value, samples, type Snapshot } from '../metrics';
import { alerts } from '../alerts';
import { getUpcomingTasks, type UpcomingTask, type Dashboard } from '../api';
import { linkTo } from '../api-security';
import { apiAvailable, fsRoots, type FsRoot } from '../api-osca';
import { irisCpu, irisCaption, type IrisCpu } from '../iris-cpu';
import { buildIssues, issueSources, type Issue, type IssueFacts } from '../issues';
import { esc, pct, compact, mb, irisDate, future, skeleton, errorPanel, liveIndicator, statTile, setStat, middle, type ScreenCtx, type Tone } from '../ui';

const band = (v: number, warn: number, danger: number): Tone => (v >= danger ? 'danger' : v >= warn ? 'warning' : 'success');
const MAX_ISSUES = 5;
const MAX_RUNS = 6;


export function homeScreen(ctx: ScreenCtx): void {
  ctx.body.innerHTML = `
    <section class="stats stats--5 home-stats">
      ${statTile('cpu', 'System CPU', 'trend')}
      ${statTile('mem', 'Memory', 'bar')}
      ${statTile('disk', 'Disk', 'bar')}
      ${statTile('procs', 'Processes', 'plain')}
      ${statTile('lic', 'License units', 'bar')}
    </section>
    <div class="home-triage" id="home-triage">
      <section class="card home-card" id="attention-card">
        <header class="card-head"><h2>Needs attention</h2><span class="card-hint" id="attention-count"></span></header>
        <div class="home-card-body" id="attention">${skeleton(4)}</div>
        <footer class="home-foot" id="attention-foot"></footer>
      </section>
      <section class="card home-card">
        <header class="card-head"><h2>Coming up</h2></header>
        <div class="home-card-body" id="upcoming">${skeleton(5)}</div>
        <footer class="home-foot"><button type="button" class="link" data-go="tasks/schedule">Schedule</button></footer>
      </section>
    </div>
    <div class="home-below" id="home-below">
      <section class="card" id="top-card" hidden>
        <header class="card-head"><h2>Top processes</h2><button type="button" class="link" data-go="operations/processes">All processes</button></header>
        <div id="busiest"></div>
      </section>
      <section class="card" id="inst-card">
        <header class="card-head"><h2>This instance</h2></header>
        <div id="inst">${skeleton(3)}</div>
      </section>
    </div>`;
  const wireLinks = (root: ParentNode): void =>
    root.querySelectorAll<HTMLElement>('[data-go]').forEach((b) => b.addEventListener('click', () => ctx.navigate(b.dataset.go ?? '')));
  wireLinks(ctx.body);
  const $ = (id: string): HTMLElement => ctx.body.querySelector(`#${id}`) as HTMLElement;

  const facts: IssueFacts = {};
  let expanded = false;
  const updated = liveIndicator(ctx, () => { void metrics.refresh(); void loadSlow(true); });

  const renderHeading = (): void => {
    const snap = facts.snap;
    if (!snap) return;
    const info = samples(snap, 'iris_system_info')[0]?.labels ?? {};
    const mirror = value(snap, 'iris_mirror_member_type');
    const mirrorText = mirror === 2 ? 'Not mirrored' : mirror === 3 ? 'Mirror failover member' : mirror === 4 ? 'Mirror async member' : '';
    const dash = facts.dash;
    const meta = [
      `${esc(info.product ?? 'InterSystems IRIS')} ${esc(info.version ?? '')}${info.build_number ? ` · build ${esc(info.build_number)}` : ''}`,
      esc(info.platform ?? ''),
      dash ? `Up ${esc(dash.Status.UpTime.replace(/^0d /, ''))}` : '',
      mirrorText,
    ].filter(Boolean).join('<span class="meta-sep">·</span>');
    // No health pill by the name: the status bar and Needs attention carry it.
    ctx.heading(esc(info.id ?? 'IRIS instance'), meta);
  };

  let irisCore: number | null = null; // IRIS processes together, % of one core
  let irisIdle = false;
  let busyCount: number | null = null; // IRIS processes using at least 1% of one core
  let split: { user: number; system: number } | null = null; // from the process list
  /** The server's drives with their size (OSCA API), for drives the metrics feed doesn't cover; [] without it. */
  let roots: FsRoot[] = [];
  // Disk tile: Capacity's 85%/95% marks on its bar (no labels), and it opens Capacity.
  {
    const tile = ctx.body.querySelector<HTMLElement>('[data-stat="disk"]');
    const bar = tile?.querySelector<HTMLElement>('.stat-bar');
    if (tile && bar) {
      bar.classList.add('has-ticks');
      bar.insertAdjacentHTML('beforeend', '<i class="disk-tick" style="left:85%"></i><i class="disk-tick disk-tick--crit" style="left:95%"></i>');
      tile.classList.add('stat--link');
      tile.setAttribute('role', 'link');
      tile.tabIndex = 0;
      const open = (): void => ctx.navigate('databases/capacity');
      tile.addEventListener('click', open);
      tile.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    }
  }
  const renderStats = (): void => {
    const snap = facts.snap;
    if (!snap) return;
    const cpu = value(snap, 'iris_cpu_usage');
    const mem = value(snap, 'iris_phys_mem_percent_used');
    // Every drive: the metrics feed's (databases, journals), plus the server's drive list for the rest,
    // the same sources as Capacity. The tile shows the fullest; the tooltip lists them all.
    const drives = new Map<string, { pct: number; free: number; role: string }>();
    const letter = (dir: string): string => /^([a-z]:)/i.exec(dir)?.[1]?.toUpperCase() ?? dir;
    const roleOf = (key: string): string => (roots.find((r) => letter(r.path) === key) as (FsRoot & { role?: string }) | undefined)?.role ?? '';
    for (const d of samples(snap, 'iris_disk_percent_full')) {
      const key = letter(d.labels.dir ?? '');
      const prev = drives.get(key);
      if (prev && prev.pct >= d.value) continue;
      drives.set(key, { pct: d.value, free: value(snap, 'iris_directory_space', { id: d.labels.id ?? '' }), role: roleOf(key) });
    }
    for (const r of roots) {
      const key = letter(r.path);
      if (drives.has(key) || !r.totalBytes || r.path === '/' || r.type === 'allowed') continue;
      const free = (r.freeBytes ?? NaN) / 1048576;
      drives.set(key, { pct: (1 - (r.freeBytes ?? NaN) / r.totalBytes) * 100, free, role: roleOf(key) });
    }
    const list = [...drives.entries()];
    const top = list.reduce<[string, { pct: number; free: number; role: string }] | null>((a, b) => (!a || b[1].pct > a[1].pct ? b : a), null);
    const worst = { value: top ? top[1].pct : NaN };
    const volume = top && /^[A-Z]:$/.test(top[0]) ? top[0] : 'Volume';
    const free = top ? top[1].free : NaN;
    const procs = value(snap, 'iris_process_count');
    const used = value(snap, 'iris_license_consumed');
    const total = used + value(snap, 'iris_license_available');
    const licPct = value(snap, 'iris_license_percent_used');
    setStat(ctx.body, 'cpu', { value: pct(cpu), caption: irisCaption(irisCore), tone: band(cpu, 70, 90), trend: metrics.history('iris_cpu_usage').values,
      title: 'System CPU covers everything on this machine. The IRIS figure adds up CPU used by IRIS processes over the last few seconds, measured against one core.' });
    setStat(ctx.body, 'mem', { value: pct(mem), caption: 'of RAM', tone: band(mem, 80, 92), fill: mem });
    setStat(ctx.body, 'disk', {
      value: pct(worst.value),
      caption: list.length > 1 ? `${volume} · fullest of ${list.length}` : `${volume} · ${mb(free)} free`,
      tone: band(worst.value, 85, 95), fill: worst.value,
      title: list.map(([k, d]) => `${k}${d.role ? ` ${d.role}` : ''} ${pct(d.pct)} · ${mb(d.free)} free`).join('\n'),
    });
    // A count isn't a rate: no trend line, just who the processes belong to.
    setStat(ctx.body, 'procs', { value: compact(procs), caption: split ? `${split.user} user · ${split.system} system` : '',
      title: busyCount === null ? '' : busyCount ? `${busyCount} using at least 1% of one CPU core` : 'All idle: every IRIS process is under 1% of one core' });
    setStat(ctx.body, 'lic', { value: Number.isFinite(total) ? `${used} of ${total}` : '—', caption: 'in use', tone: band(licPct, 80, 95), fill: licPct });
  };

  // ── Needs attention ──
  let issuesSig = '';
  let highlighted = false;
  const renderIssues = (): void => {
    if (!facts.snap && !facts.dash && !facts.graph) return; // nothing read yet: keep the skeleton
    const all = buildIssues(facts);
    const shown = expanded ? all : all.slice(0, MAX_ISSUES);
    const sig = JSON.stringify([shown, all.length, expanded]);
    if (sig === issuesSig) return;
    issuesSig = sig;
    $('attention-count').textContent = all.length ? String(all.length) : '';
    const el = $('attention');
    el.innerHTML = all.length === 0
      ? `<div class="home-clear"><span class="home-clear-icon"><ev-icon name="check" size="sm"></ev-icon></span><strong>All clear</strong><span>Nothing on this instance needs you right now.</span></div>`
      : `<ul class="home-issues">${shown.map((a) => issueRow(a)).join('')}</ul>`;
    // The footer row always exists, so both cards' footers share a baseline.
    const foot = $('attention-foot');
    foot.innerHTML = all.length > MAX_ISSUES ? `<button type="button" class="link" id="issues-more">${expanded ? 'Show fewer' : `Show all ${all.length}`}</button>` : '';
    foot.querySelector('#issues-more')?.addEventListener('click', () => { expanded = !expanded; renderIssues(); });
    el.querySelectorAll<HTMLButtonElement>('[data-issue]').forEach((b) => b.addEventListener('click', () => {
      const issue = all.find((x) => x.id === b.dataset.issue);
      if (!issue) return;
      const act = issue.action;
      if (act.copy) {
        void navigator.clipboard.writeText(act.copy).then(() => {
          b.textContent = 'Copied';
          setTimeout(() => { b.textContent = act.label; }, 1600);
        }, () => { /* clipboard blocked: the command is in the tooltip */ });
      } else if (act.select && act.go) linkTo(ctx.navigate, act.go as 'security/users', act.select);
      else if (act.go) ctx.navigate(act.go);
    }));
    // "#/home/overview/security": the status bar's Security item lands on its row.
    if (ctx.param && !highlighted) {
      const row = el.querySelector<HTMLElement>(`[data-issue-row="${CSS.escape(ctx.param)}"]`);
      if (row) {
        highlighted = true;
        row.classList.add('home-issue--hl');
        row.scrollIntoView({ block: 'nearest' });
        setTimeout(() => row.classList.remove('home-issue--hl'), 2400);
      }
    }
  };
  const issueRow = (a: Issue): string => `
    <li class="home-issue" data-tone="${a.tone}" data-issue-row="${esc(a.id)}">
      <span class="home-issue-dot" aria-label="${a.tone === 'danger' ? 'Critical' : a.tone === 'warning' ? 'Warning' : 'Note'}"></span>
      <div class="home-issue-text"><strong>${esc(a.title)}</strong><span title="${esc(a.detail)}">${esc(a.detail)}</span></div>
      <button type="button" class="btn btn--sm home-issue-act" data-issue="${esc(a.id)}"${a.action.copy ? ` title="${esc(a.action.copy)}"` : ''}>${esc(a.action.label)}</button>
    </li>`;

  // ── Coming up: the next runs, flat ──
  let runs: UpcomingTask[] | null = null;
  const renderUpcoming = (): void => {
    const el = $('upcoming');
    if (!runs) return;
    if (runs.length === 0) {
      el.innerHTML = `<div class="home-clear home-clear--neutral"><span class="home-clear-icon"><ev-icon name="calendar" size="sm"></ev-icon></span><strong>Nothing scheduled</strong><span>The Task Manager has no upcoming runs.</span></div>`;
      return;
    }
    el.innerHTML = `<ul class="home-runs">${runs.slice(0, MAX_RUNS).map((t) =>
      `<li class="home-run"><span class="home-run-name" title="${esc(`${t.Name} · ${t.Namespace}`)}">${esc(t.Name)}</span><span class="home-run-when">${future(irisDate(t.Datetime))}</span></li>`).join('')}</ul>`;
  };
  // Keep "in 24m" current between reads.
  const tick = setInterval(renderUpcoming, 30_000);
  ctx.onLeave(() => clearInterval(tick));

  // ── Below the fold ──
  const renderBusiest = (c: IrisCpu): void => {
    irisCore = c.total;
    const active = c.procs
      .map((p) => ({ p, pct: c.pct.get(p.Pid) ?? 0 }))
      .filter((x) => x.pct > 0.05)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);
    busyCount = c.procs.filter((p) => (c.pct.get(p.Pid) ?? 0) >= 1).length;
    const system = c.procs.filter((p) => !p.Username).length;
    split = { user: c.procs.length - system, system };
    irisIdle = busyCount === 0;
    $('top-card').hidden = irisIdle;
    $('home-below').classList.toggle('home-below--one', irisIdle);
    renderStats();
    if (irisIdle) return;
    $('busiest').innerHTML = `<ul class="rows">${active.map(({ p, pct: c }) => `
      <li class="row">
        <span class="row-main mono" title="${esc(p.Routine)} · PID ${esc(p.Pid)}">${esc(middle(p.Routine || '(no routine)', 48))}</span>
        <span class="row-meta" title="Share of one CPU core over the last few seconds">${c < 10 ? c.toFixed(1) : Math.round(c)}%</span>
      </li>`).join('')}</ul>`;
  };
  const renderInstance = (): void => {
    const d: Dashboard | null | undefined = facts.dash;
    const snap = facts.snap;
    if (!d && !snap) return;
    // Not ui.ts kv: a Home tile cell (kv-cell), with the tooltip on the whole cell.
    const kv = (k: string, v: string, hint = ''): string => `<div class="kv-cell"${hint ? ` title="${esc(hint)}"` : ''}><dt>${k}</dt><dd>${v}</dd></div>`;
    const dash = (s: string | undefined): string => (s && s.trim() ? esc(s) : '—');
    $('inst').innerHTML = `<dl class="kv-grid">
      ${kv('Last backup', dash(d?.Status.LastBackup))}
      ${kv('Web sessions', snap ? compact(value(snap, 'iris_csp_sessions')) : '—')}
      ${kv('Database space', dash(d?.SystemUsage.DatabaseSpace))}
      ${kv('Journal space', dash(d?.SystemUsage.JournalSpace))}
      ${kv('Lock table', dash(d?.SystemUsage.LockTable))}
      ${kv('Write daemon', dash(d?.SystemUsage.WriteDaemon))}
    </dl>`;
  };

  // ── Reads ──
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  void apiAvailable().then((ok) => (ok ? fsRoots() : null)).then((r) => {
    if (!alive || !r || r.restricted) return;
    roots = r.roots;
    renderStats();
  }, () => { /* optional: the metrics feed's drives still show */ });
  const loadSlow = async (fresh = false): Promise<void> => {
    const [d, t, j, h, jr, g] = await Promise.allSettled([
      issueSources.dashboard(fresh), getUpcomingTasks(), issueSources.jobs(fresh), issueSources.history(fresh), issueSources.journal(fresh), issueSources.graph(),
    ]);
    if (!alive) return;
    if (d.status === 'fulfilled' && d.value) facts.dash = d.value;
    if (j.status === 'fulfilled') facts.jobs = j.value;
    if (h.status === 'fulfilled') facts.history = h.value;
    if (jr.status === 'fulfilled') facts.journal = jr.value;
    if (g.status === 'fulfilled') facts.graph = g.value;
    if (t.status === 'fulfilled') { runs = t.value; renderUpcoming(); }
    else if (!runs) { $('upcoming').innerHTML = errorPanel(t.reason, 'retry-upcoming'); $('upcoming').querySelector('#retry-upcoming')?.addEventListener('click', () => void loadSlow(true)); }
    renderHeading(); renderIssues(); renderInstance();
  };
  void loadSlow();
  const slow = setInterval(() => void loadSlow(), 30_000);
  ctx.onLeave(() => clearInterval(slow));

  ctx.onLeave(irisCpu.subscribe((c, err) => {
    if (c) { renderBusiest(c); return; }
    if (err) { $('top-card').hidden = false; $('busiest').innerHTML = errorPanel(err); }
  }));
  ctx.onLeave(metrics.subscribe((s: Snapshot, at) => {
    facts.snap = s;
    updated(at);
    renderHeading(); renderStats(); renderIssues(); renderInstance();
  }, (err) => {
    if (facts.snap) return;
    $('attention').innerHTML = errorPanel(err, 'retry-metrics');
    $('attention').querySelector('#retry-metrics')?.addEventListener('click', () => void metrics.refresh());
  }));
  ctx.onLeave(alerts.subscribe((list) => {
    facts.alerts = list;
    renderIssues();
    renderHeading();
  }));
}
