// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The showcase's few touches on the shell, added from outside once it has
 * rendered: the "Sample data" status-bar chip (with its popover), the switch
 * in the account menu, the one-time question on a single-drive server, and
 * hiding Settings > Showcase where the showcase module isn't installed.
 */
import { commands } from '@evolution-ui/core/base';
import { confirm } from '../crud';
import { metrics, samples } from '../metrics';
import { apiAvailable, fsRoots } from '../api-osca';
import { getDbDirs, getJournalSettings, driveOf } from '../api-disk';
import { readFlag, writeFlag, sampleOn } from './flag';
import { showcaseAvailable } from './showcase-api';

/** Resolves once the shell (status bar and account menu) exists, i.e. after sign-in. */
function whenShell(): Promise<void> {
  const ready = (): boolean => !!document.querySelector('#statusbar .sb-end') && !!document.querySelector('#user-menu');
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const mo = new MutationObserver(() => { if (ready()) { mo.disconnect(); resolve(); } });
    mo.observe(document.body, { childList: true, subtree: true });
  });
}

function setSample(on: boolean): void {
  writeFlag(on ? 'on' : 'off');
  location.reload(); // every screen re-reads with (or without) the sample figures
}

function mountChip(): void {
  const end = document.querySelector('#statusbar .sb-end') as HTMLElement;
  const wrap = document.createElement('div');
  wrap.className = 'sc-chip-wrap';
  wrap.innerHTML = `
    <button type="button" class="sb-item" data-tone="warning" id="sc-chip" aria-haspopup="dialog" aria-expanded="false" title="Some figures are sample data">
      <span class="dot" aria-hidden="true"></span><b>Sample data</b></button>
    <div class="sc-pop" id="sc-pop" role="dialog" aria-label="Sample data" hidden>
      <p>Some figures are sample data to demonstrate multi-drive layouts.</p>
      <button type="button" class="btn btn--sm" id="sc-off">Turn off</button>
    </div>`;
  end.prepend(wrap);
  const btn = wrap.querySelector('#sc-chip') as HTMLElement;
  const pop = wrap.querySelector('#sc-pop') as HTMLElement;
  const show = (open: boolean): void => { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); show(pop.hidden); });
  wrap.querySelector('#sc-off')?.addEventListener('click', () => setSample(false));
  document.addEventListener('click', (e) => { if (!pop.hidden && !wrap.contains(e.target as Node)) show(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { show(false); btn.focus(); } });
}

function mountMenuSwitch(): void {
  const menu = document.querySelector('#user-menu') as HTMLElement;
  const signout = menu.querySelector('#btn-signout');
  const on = sampleOn();
  const b = document.createElement('button');
  b.type = 'button';
  b.id = 'sc-menu-sample';
  b.className = 'sc-menu-item';
  b.setAttribute('role', 'menuitemcheckbox');
  b.setAttribute('aria-checked', String(on));
  b.title = 'Show sample drives and figures, to demonstrate multi-drive layouts. Nothing is written to IRIS.';
  b.innerHTML = '<span>Sample data <span class="sc-beta">(beta)</span></span><span class="sc-switch" aria-hidden="true"></span>';
  b.addEventListener('click', () => setSample(!on));
  menu.insertBefore(b, signout);
  commands.register({ id: 'view:sample-data', label: on ? 'Turn sample data off' : 'Show sample data (beta)', group: 'View', run: () => setSample(!on) });
}

/** One drive for every database and journal? Unanswerable → false (never ask). */
async function singleDrive(): Promise<boolean> {
  try {
    if (await apiAvailable()) {
      const r = await fsRoots();
      if (!r.restricted && r.separator === '\\') return r.roots.filter((x) => x.type === 'drive').length === 1;
    }
  } catch { /* fall back to the paths */ }
  try {
    const [dirs, js] = await Promise.all([getDbDirs(), getJournalSettings()]);
    const paths = [...dirs.map((d) => d.Directory), js.CurrentDirectory, js.AlternateDirectory].filter(Boolean);
    if (paths.length && paths.every((p) => driveOf(p))) return new Set(paths.map((p) => driveOf(p))).size === 1;
    // Unix: one volume when every directory reports the same free space (to within 64 MB).
    const free = await new Promise<number[]>((resolve) => {
      let off = (): void => undefined;
      off = metrics.subscribe((snap) => {
        setTimeout(() => off(), 0);
        resolve([...samples(snap, 'iris_directory_space'), ...samples(snap, 'iris_jrn_free_space').filter((s) => s.labels.id !== 'WIJ')].map((s) => s.value));
      }, () => resolve([]));
    });
    return free.length > 0 && Math.max(...free) - Math.min(...free) < 64;
  } catch {
    return false;
  }
}

async function firstRun(): Promise<void> {
  if (readFlag() !== null) return;
  await new Promise((r) => setTimeout(r, 1500)); // let the first page settle
  if (readFlag() !== null || !(await singleDrive())) return;
  const yes = await confirm({
    title: 'Show sample data?',
    body: '<p>This server has a single drive. Show sample data so you can see how OSCA Admin presents multi-drive servers? You can turn it off at any time.</p>',
    confirmLabel: 'Show sample data',
    cancelLabel: 'Not now',
  });
  if (yes) setSample(true); else writeFlag('off');
}

/** Hide Settings > Showcase unless the showcase module answers. */
async function hideShowcaseIfAbsent(): Promise<void> {
  if (await showcaseAvailable()) return;
  document.querySelectorAll<HTMLElement>('.acc-item').forEach((b) => { if (b.textContent?.trim() === 'Showcase') b.style.display = 'none'; });
  commands.unregister('nav:settings:showcase');
}

export async function mountShell(): Promise<void> {
  await whenShell();
  if (sampleOn()) {
    mountChip();
  }
  mountMenuSwitch();
  void hideShowcaseIfAbsent();
  void firstRun();
}
