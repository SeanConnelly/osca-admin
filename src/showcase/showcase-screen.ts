// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings > Showcase: the optional server-side sample objects. Shows every
 * virgin-instance check; Create appears only when all pass and needs the
 * phrase typed; Remove appears whenever sample objects exist. The server
 * re-runs every check and refuses on its own, whatever this page shows.
 */
import { confirm, toast, errorText, AdminError } from '../crud';
import { esc, status, skeleton, errorPanel, emptyState, liveIndicator, type ScreenCtx } from '../ui';
import { getShowcaseState, applyShowcase, removeShowcase, CONFIRM_PHRASE, type ShowcaseState, type ShowcaseObject } from './showcase-api';

const KIND: Record<string, string> = {
  resource: 'Resource', role: 'Role', user: 'User', webapp: 'Web application', database: 'Database', namespace: 'Namespace', task: 'Task',
};
const objList = (items: ShowcaseObject[]): string =>
  `<ul class="sc-objs">${items.map((o) => `<li><span class="sc-kind">${esc(KIND[o.kind] ?? o.kind)}</span><span class="mono">${esc(o.name)}</span></li>`).join('')}</ul>`;

export function showcaseScreen(ctx: ScreenCtx): void {
  let alive = true;
  ctx.onLeave(() => { alive = false; });
  let state: ShowcaseState | null = null;
  let busy = false;
  ctx.body.innerHTML = `<div class="sc-page">${skeleton(6)}</div>`;
  const page = ctx.body.querySelector('.sc-page') as HTMLElement;
  const updated = liveIndicator(ctx, () => void load(), { live: false });

  const renderActions = (): void => {
    const s = state;
    ctx.actions.innerHTML = [
      s?.created.length ? `<button type="button" class="btn" id="sc-remove"${busy ? ' disabled' : ''}>Remove sample data</button>` : '',
      s?.eligible ? `<button type="button" class="btn btn--primary" id="sc-apply"${busy ? ' disabled' : ''}>Create sample data</button>` : '',
    ].join('');
    ctx.actions.querySelector('#sc-apply')?.addEventListener('click', () => void create());
    ctx.actions.querySelector('#sc-remove')?.addEventListener('click', () => void remove());
  };

  const render = (): void => {
    const s = state;
    if (!s) return;
    const failed = s.checks.filter((c) => !c.pass);
    const verdict = s.eligible
      ? status('This server looks like a fresh install: sample data can be created', 'success')
      : status(`Not available on this server: ${failed.length} of ${s.checks.length} checks failed`, 'warning');
    page.innerHTML = `
      <p class="sc-verdict">${verdict}</p>
      <section class="sc-section" aria-label="Checks">
        <h2 class="sc-h">Fresh-install checks</h2>
        <div class="sc-checks" role="list">
          ${s.checks.map((c) => `<div class="sc-check" role="listitem">
            <span class="sc-check-state">${c.pass ? status('Pass', 'success') : status('Fail', 'danger')}</span>
            <span class="sc-check-label">${esc(c.label)}</span>
            <span class="sc-check-detail">${esc(c.detail)}</span>
          </div>`).join('')}
        </div>
      </section>
      ${s.created.length ? `<section class="sc-section">
        <h2 class="sc-h">Sample objects on this server (${s.created.length})</h2>
        ${objList(s.created)}
      </section>` : ''}
      <section class="sc-section">
        <h2 class="sc-h">What Create makes</h2>
        ${objList(s.plan)}
        <p class="sc-note">Every name starts with osca_demo_ and every description says it is safe to delete. Users and the web application are disabled, tasks are suspended, the namespace has no interoperability, and the users' passwords are random and never shown. Remove deletes exactly these objects.</p>
      </section>`;
  };

  async function load(): Promise<void> {
    try {
      const s = await getShowcaseState();
      if (!alive) return;
      state = s;
      updated(new Date());
      render();
      renderActions();
    } catch (err) {
      if (!alive) return;
      if (err instanceof AdminError && err.status === 404) {
        ctx.actions.innerHTML = '';
        page.innerHTML = emptyState({
          icon: 'box', title: 'The showcase module isn’t installed',
          what: 'Sample objects can only be created by the optional OSCA Admin showcase module, on a fresh IRIS install. This server doesn’t have it, which is right for a real server.',
        });
        return;
      }
      page.innerHTML = errorPanel(err, 'sc-retry');
      page.querySelector('#sc-retry')?.addEventListener('click', () => void load());
    }
  }

  async function create(): Promise<void> {
    if (!state?.eligible || busy) return;
    const ok = await confirm({
      title: 'Create sample data on this server?',
      body: `<p>These objects will be created in IRIS:</p>${objList(state.plan)}<p>The server checks again that it is a fresh install before it writes anything.</p>`,
      confirmLabel: 'Create sample data',
      typeToConfirm: CONFIRM_PHRASE,
    });
    if (!ok) return;
    busy = true; renderActions();
    try {
      const r = await applyShowcase(CONFIRM_PHRASE);
      toast(r.message || 'Sample data created');
    } catch (err) {
      toast(errorText(err), 'danger');
    } finally {
      busy = false;
      if (alive) await load();
    }
  }

  async function remove(): Promise<void> {
    if (!state?.created.length || busy) return;
    const ok = await confirm({
      title: 'Remove the sample data?',
      body: `<p>These objects, and only these, will be deleted:</p>${objList(state.created)}`,
      confirmLabel: 'Remove sample data',
      danger: true,
    });
    if (!ok) return;
    busy = true; renderActions();
    try {
      const r = await removeShowcase();
      toast(r.message || 'Sample data removed', r.ok ? 'success' : 'warning');
    } catch (err) {
      toast(errorText(err), 'danger');
    } finally {
      busy = false;
      if (alive) await load();
    }
  }

  void load();
}
