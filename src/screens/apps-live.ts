// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live refresh that doesn't get in the way (Tasks, Task history, Web
 * applications). A poll that lands while the pointer is over the workspace,
 * or while a menu or dialog is open, is held and applied once the user moves
 * away, so rows never reorder under the cursor and an open panel never
 * re-renders mid-click. Refreshes the user asked for (after an action, the
 * refresh button) pass `force` and apply at once.
 */
export interface LiveGate {
  /** Apply `render` now, or hold it until the user stops interacting. The newest held render wins. */
  run(render: () => void, force?: boolean): void;
}

export function liveGate(zone: HTMLElement, onLeave: (fn: () => void) => void): LiveGate {
  let hovering = false;
  let pending: (() => void) | null = null;
  const interacting = (): boolean =>
    hovering
    || document.querySelector('.crud-menu') !== null
    || [...document.querySelectorAll('ev-dialog')].some((d) => (d as HTMLElement & { open?: boolean }).open === true);
  const flush = (): void => {
    if (!pending || interacting()) return;
    const render = pending;
    pending = null;
    render();
  };
  zone.addEventListener('pointerenter', () => { hovering = true; });
  zone.addEventListener('pointerleave', () => { hovering = false; flush(); });
  // Menus and dialogs close without a pointer event on the zone; check now and then.
  const timer = setInterval(flush, 1000);
  onLeave(() => clearInterval(timer));
  return {
    run(render, force = false) {
      if (force || !interacting()) { pending = null; render(); } else pending = render;
    },
  };
}
