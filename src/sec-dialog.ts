// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Security screens: a read-only list dialog, e.g. "Everyone with this
 * access…" on Roles and Services. One Close button; nothing is changed.
 */
import { esc } from './ui';

export interface ListDialogItem { name: string; how: string }

/** Open a small dialog listing names, each with a short "how" note. */
export function listDialog(title: string, items: ListDialogItem[], empty = 'Nobody.'): void {
  const dlg = document.createElement('ev-dialog') as HTMLElement & { open: boolean };
  dlg.setAttribute('heading', title);
  dlg.setAttribute('size', 'sm');
  dlg.className = 'crud-dialog';
  dlg.innerHTML = `
    <div slot="body" class="crud-dialog-body"><div class="crud-dialog-text">
      ${items.length
        ? `<ul class="holder-list sec-everyone">${items.map((i) => `<li><span class="mono">${esc(i.name)}</span><span class="holder-how">${esc(i.how)}</span></li>`).join('')}</ul>`
        : `<p>${esc(empty)}</p>`}
    </div></div>
    <div slot="footer" class="crud-dialog-foot"><button type="button" class="btn btn--primary" data-dismiss>Close</button></div>`;
  dlg.addEventListener('ev-dialog-close', () => setTimeout(() => dlg.remove(), 0), { once: true });
  document.body.appendChild(dlg);
  dlg.open = true;
}
