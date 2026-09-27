// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeps sample drives out of forms. While sample data is on, every server
 * file picker (src/file-picker.ts) is watched: when its selection, or a typed
 * path, is on a sample drive, Select is disabled and the footer says
 * "Sample drive, not on the server". A click that somehow reaches a disabled
 * Select is stopped too. Nothing in the picker itself changes.
 */
import { isSamplePath } from './overlay';

const watched = new WeakSet<Element>();

function check(dlg: Element): void {
  const ok = dlg.querySelector<HTMLButtonElement>('[data-fp="ok"]');
  const sel = dlg.querySelector<HTMLElement>('.fp-selected');
  if (!ok || !sel) return;
  const chosen = sel.querySelector('.fp-mono')?.textContent ?? '';
  const typedEl = dlg.querySelector<HTMLInputElement>('.fp-path-input');
  const typed = typedEl && !typedEl.hidden ? typedEl.value : '';
  const crumb = dlg.querySelector('.fp-crumb[aria-current="location"]')?.getAttribute('data-path') ?? '';
  const bad = isSamplePath(chosen) || isSamplePath(typed) || (!chosen && isSamplePath(crumb));
  if (bad) {
    if (!ok.disabled) ok.disabled = true;
    if (ok.dataset.scSample !== '1') { ok.dataset.scSample = '1'; ok.title = 'Sample drive, not on the server'; }
    if (!sel.hasAttribute('data-sc-sample')) sel.setAttribute('data-sc-sample', '');
  } else if (ok.dataset.scSample === '1') {
    delete ok.dataset.scSample;
    ok.title = '';
    sel.removeAttribute('data-sc-sample');
  }
}

function watch(dlg: Element): void {
  if (watched.has(dlg)) return;
  watched.add(dlg);
  const mo = new MutationObserver(() => check(dlg));
  mo.observe(dlg, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'aria-current'] });
  dlg.addEventListener('input', () => check(dlg));
  check(dlg);
}

export function guardPicker(): void {
  new MutationObserver(() => document.querySelectorAll('.fp-dialog').forEach(watch))
    .observe(document.body, { childList: true });
  document.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest?.('.fp-dialog [data-fp="ok"]') as HTMLElement | null;
    if (b?.dataset.scSample === '1') { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  document.addEventListener('keydown', (e) => {
    // Enter on a sample path must not pick it either.
    if (e.key !== 'Enter') return;
    const dlg = (e.target as Element | null)?.closest?.('.fp-dialog');
    const ok = dlg?.querySelector<HTMLElement>('[data-fp="ok"]');
    if (ok?.dataset.scSample === '1' && (e.target as Element) === ok) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}
