// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings > Self-test: runs the shared create / read / update / delete
 * groups through the portal's own api functions, then opens every page and
 * looks for errors. It asks first, listing exactly what it will create and
 * delete. The report (pass or fail per step, with times) can be copied as text.
 */
import { confirm, toast } from '../crud';
import { esc, status, type ScreenCtx } from '../ui';
import { GROUPS, planText, runGroups, reportText, type Report, type StepResult } from './selftest-steps';
import { appApi, smokePass, smokeRoutes } from './selftest-app';

const HOME = 'settings/selftest';

/** Kept for the page's lifetime in this tab: the smoke pass leaves and comes back. */
let last: { report: Report; started: number; finished: number; running: boolean } | null = null;
let options = { objects: true, screens: true };

function progressPill(): { set(text: string): void; done(): void } {
  const el = document.createElement('div');
  el.className = 'sc-progress';
  el.setAttribute('role', 'status');
  document.body.appendChild(el);
  return { set: (t) => { el.textContent = `Self-test: ${t}`; }, done: () => el.remove() };
}

export function selfTestScreen(ctx: ScreenCtx): void {
  let alive = true;
  ctx.onLeave(() => { alive = false; });

  const renderActions = (): void => {
    const running = !!last?.running;
    ctx.actions.innerHTML = `
      ${last && !running ? '<button type="button" class="btn" id="st-copy">Copy report</button>' : ''}
      <button type="button" class="btn btn--primary" id="st-run"${running ? ' disabled' : ''}>${running ? 'Running…' : 'Run self-test'}</button>`;
    ctx.actions.querySelector('#st-run')?.addEventListener('click', () => void run());
    ctx.actions.querySelector('#st-copy')?.addEventListener('click', () => {
      if (!last) return;
      void navigator.clipboard?.writeText(reportText(last.report)).then(() => toast('Report copied'), () => toast('The browser blocked the clipboard', 'warning'));
    });
  };

  const reportHtml = (): string => {
    if (!last) return '';
    const r = last.report;
    const passed = r.filter((x) => x.ok).length;
    const secs = ((last.finished || Date.now()) - last.started) / 1000;
    const summary = last.running
      ? status(`Running: ${passed} of ${r.length} steps passed so far`, 'info')
      : status(`${passed} of ${r.length} steps passed in ${secs.toFixed(1)} s`, passed === r.length ? 'success' : 'danger');
    let group = '';
    const rows = r.map((s) => {
      const head = s.group !== group ? `<div class="st-group">${esc((group = s.group))}</div>` : '';
      return `${head}<div class="st-row${s.ok ? '' : ' st-row--fail'}">
        <span>${s.ok ? status('Pass', 'success') : status('Fail', 'danger')}</span>
        <span class="st-step">${esc(s.step)}</span>
        <span class="st-ms">${s.ms} ms</span>
        <span class="st-detail">${esc(s.detail)}</span>
      </div>`;
    }).join('');
    return `<section class="sc-section"><h2 class="sc-h">Report</h2><p class="sc-verdict">${summary}</p><div class="st-report">${rows}</div></section>`;
  };

  const render = (): void => {
    if (!alive) return;
    const running = !!last?.running;
    ctx.body.innerHTML = `<div class="sc-page">
      <section class="sc-section">
        <h2 class="sc-h">What it runs</h2>
        <label class="sc-opt"><input type="checkbox" id="st-objects"${options.objects ? ' checked' : ''}${running ? ' disabled' : ''}>
          <span><b>Objects</b>: creates each test object below, reads it, changes it, deletes it, and checks the list is as it was</span></label>
        <label class="sc-opt"><input type="checkbox" id="st-screens"${options.screens ? ' checked' : ''}${running ? ' disabled' : ''}>
          <span><b>Screens</b>: opens all ${smokeRoutes().length} pages in turn and looks for error panels and console errors, then comes back here</span></label>
      </section>
      <section class="sc-section">
        <h2 class="sc-h">Objects it creates and then deletes</h2>
        <ul class="sc-objs">${planText().map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <p class="sc-note">A name that already exists is left alone and that step fails. Never tested, because they change existing configuration: OAuth, managed file transfer, services, license, journal settings, ECP and processes.</p>
      </section>
      ${reportHtml()}
    </div>`;
    ctx.body.querySelector('#st-objects')?.addEventListener('change', (e) => { options = { ...options, objects: (e.target as HTMLInputElement).checked }; });
    ctx.body.querySelector('#st-screens')?.addEventListener('change', (e) => { options = { ...options, screens: (e.target as HTMLInputElement).checked }; });
    renderActions();
  };

  async function run(): Promise<void> {
    if (last?.running) return;
    if (!options.objects && !options.screens) { toast('Choose objects, screens or both', 'warning'); return; }
    const body = [
      options.objects ? `<p>It will create, check and then delete:</p><ul class="sc-objs">${planText().map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '',
      options.screens ? `<p>It will open all ${smokeRoutes().length} pages in turn, then come back here.</p>` : '',
    ].join('');
    const ok = await confirm({ title: 'Run the self-test?', body, confirmLabel: 'Run self-test' });
    if (!ok) return;
    last = { report: [], started: Date.now(), finished: 0, running: true };
    const run = last;
    const onStep = (s: StepResult): void => { run.report.push(s); if (alive && location.hash === `#/${HOME}`) render(); };
    render();
    try {
      if (options.objects) await runGroups(appApi, GROUPS, onStep);
      if (options.screens) {
        const pill = progressPill();
        try { await smokePass(onStep, (t) => pill.set(t)); } finally { pill.done(); }
        location.hash = `/${HOME}`; // back to this page, which renders the report
      }
    } finally {
      run.running = false;
      run.finished = Date.now();
      if (location.hash === `#/${HOME}`) document.dispatchEvent(new CustomEvent('osca-selftest-done'));
    }
  }

  const onDone = (): void => render();
  document.addEventListener('osca-selftest-done', onDone);
  ctx.onLeave(() => document.removeEventListener('osca-selftest-done', onDone));
  render();
}
