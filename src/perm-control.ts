// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one permission control, shared by Check access (Users, Resources) and
 * the role editor's resource rows:
 *   databases → a segmented pair  Read | Read & change
 *   others    → a single Use toggle
 * It never wraps; containers let it drop under neighbouring controls.
 * No imports beyond ui.ts, so crud.ts can use it without an import cycle.
 */
import './styles-perm.css';
import { esc } from './ui';

export interface PermControlOptions {
  /** Database resources get Read | Read & change; everything else a Use toggle. */
  database: boolean;
  /** "R" / "RW" for databases, "U" or "" otherwise. */
  value: string;
  onChange?: (value: string) => void;
  /** Accessible name, e.g. "Access to check" or "Permission on %DB_USER". */
  label?: string;
  /** Key for crud.ts readForm(), so a form counts changes. */
  name?: string;
  /** For a Use toggle: allow switching it off (resource rows). Default true. */
  allowOff?: boolean;
}

export interface PermControlHandle { value(): string; set(value: string): void; el: HTMLElement }

const norm = (p: string): string => {
  const up = String(p ?? '').toUpperCase();
  return up.includes('W') ? 'RW' : up.includes('R') ? 'R' : up.includes('U') ? 'U' : '';
};

/** Mount into `host` (its content is replaced). */
export function permControl(host: HTMLElement, opts: PermControlOptions): PermControlHandle {
  let value = norm(opts.value) || (opts.database ? 'R' : 'U');
  host.classList.add('perm-seg-host');
  if (opts.name) host.dataset.crudName = opts.name;
  (host as HTMLElement & { crudValue?: () => string }).crudValue = () => value;
  const render = (): void => {
    if (opts.database) {
      const b = (v: string, label: string): string =>
        `<button type="button" role="radio" class="perm-seg-btn" data-v="${v}" aria-checked="${value === v}" tabindex="${value === v ? 0 : -1}">${esc(label)}</button>`;
      host.innerHTML = `<div class="perm-seg" role="radiogroup" aria-label="${esc(opts.label ?? 'Permission')}">${b('R', 'Read')}${b('RW', 'Read & change')}</div>`;
    } else {
      host.innerHTML = `<div class="perm-seg"><button type="button" class="perm-seg-btn" data-v="U" aria-pressed="${value === 'U'}" aria-label="${esc(opts.label ?? 'Use')}">Use</button></div>`;
    }
  };
  const set = (v: string, fire = false): void => {
    const next = norm(v);
    if (next === value) return;
    value = next;
    render();
    if (fire) {
      opts.onChange?.(value);
      host.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  host.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('.perm-seg-btn');
    if (!btn) return;
    if (opts.database) set(btn.dataset.v ?? 'R', true);
    else if (opts.allowOff !== false) set(value === 'U' ? '' : 'U', true);
    host.querySelector<HTMLElement>(`.perm-seg-btn[data-v="${value || 'U'}"]`)?.focus();
  });
  host.addEventListener('keydown', (e) => {
    if (!opts.database || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    set(value === 'R' ? 'RW' : 'R', true);
    host.querySelector<HTMLElement>(`.perm-seg-btn[data-v="${value}"]`)?.focus();
  });
  render();
  return { value: () => value, set: (v) => set(v), el: host };
}
