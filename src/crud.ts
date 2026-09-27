// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared CRUD building blocks for the Users, Roles and Resources screens.
 * What each export is for:
 *
 *   writeJson / AdminError   write calls that always surface IRIS's message
 *   confirm / toast          modal question, transient notice
 *   newButton / moreMenu     page-header primary action, overflow menu
 *   blockedAttrs             "disabled with a reason" for any button
 *   editorShell / panelWidth the edit/create form in the detail panel
 *   textField … readForm     field markup, read back by name
 *   rolePicker / resourcePermissionEditor
 *
 * Nothing here may put implementation detail (paths, verbs, class names) on screen.
 */
import './styles-crud.css';
import '@evolution-ui/core/components/ev-dialog/ev-dialog.js';
import '@evolution-ui/core/components/ev-toast/ev-toast.js';
import '@evolution-ui/core/components/ev-spinner/ev-spinner.js';
import '@evolution-ui/core/components/ev-form-field/ev-form-field.js';
import '@evolution-ui/core/components/ev-input/ev-input.js';
import '@evolution-ui/core/components/ev-checkbox/ev-checkbox.js';
import '@evolution-ui/core/components/ev-toggle/ev-toggle.js';
import '@evolution-ui/core/components/ev-select/ev-select.js';
import '@evolution-ui/core/components/ev-date-picker/ev-date-picker.js';
import '@evolution-ui/core/components/ev-textarea/ev-textarea.js';
import '@evolution-ui/core/components/ev-segmented-button/ev-segmented-button.js';
import { createOverlayEntry } from '@evolution-ui/core/base/overlay-stack.js';
import { positionOverlay } from '@evolution-ui/core/base/overlay-position.js';
import { authFetch } from './auth';
import { esc, permWords, type ScreenCtx } from './ui';
import { POWERFUL_ROLES, type RoleSummary } from './api-security';
import { pickServerPath, serverFilesAvailable, statServerPath } from './file-picker';

const BASE = '/api/admin/v2';
let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${++uid}`;

// ═════════════════════════════════════════════════════════════════════
// 1. Requests and errors
// ═════════════════════════════════════════════════════════════════════

/**
 * Throw from an editor's onSubmit when the user backs out at a confirm dialog:
 * the form stays open and dirty, with no error banner.
 */
export class SubmitCancelled extends Error {
  constructor() { super('Not saved. Your changes are still here.'); }
}

/** A failed Admin API call. `message` is plain English, safe to show as-is. */
export class AdminError extends Error {
  /** HTTP status; 0 when the server couldn't be reached. */
  status: number;
  /** IRIS error number (e.g. 838), when IRIS gave one. */
  code?: number;
  /** IRIS error id (e.g. "UserDoesNotExist"), when IRIS gave one. */
  id?: string;
  constructor(message: string, status: number, code?: number, id?: string) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
    this.code = code;
    this.id = id;
  }
}

const FALLBACK: Record<number, string> = {
  0: 'Can’t reach the IRIS server. Check that the instance is running.',
  400: 'IRIS rejected the request.',
  401: 'Your session has ended. Sign in again.',
  403: 'You don’t have permission to do that.',
  404: 'It no longer exists.',
  409: 'IRIS won’t allow that.',
};
const fallbackMessage = (status: number): string => FALLBACK[status] ?? 'Something went wrong.';

/** "ERROR #838: User X does not exist" → "User X does not exist". */
export function cleanMessage(raw: string): string {
  // The "ERROR" word is localised by IRIS (e.g. "خطأ #845:"), so strip any short word before #nnn:.
  return String(raw ?? '').replace(/^(\s*[^\s#]{0,16}\s*#\s*-?\d+\s*:\s*)+/u, '').trim();
}

interface EnvelopeError { error?: string; code?: number | string; id?: string }

/** fetch through authFetch; a network failure becomes AdminError(status 0). */
export async function sendAdmin(url: string, init: RequestInit): Promise<Response> {
  try {
    return await authFetch(url, init);
  } catch (err) {
    if (err instanceof TypeError) throw new AdminError(fallbackMessage(0), 0);
    throw err;
  }
}

/**
 * Parse an Admin API envelope, whatever the status. Returns `result`, or
 * throws AdminError with `status.errors[0].error` (prefix stripped) or a
 * plain fallback for the status.
 */
export async function readEnvelope<T>(res: Response): Promise<T> {
  let json: { status?: { errors?: EnvelopeError[] }; result?: T } | null = null;
  try {
    const text = await res.text();
    json = text ? JSON.parse(text) : null;
  } catch { json = null; }
  const first = json?.status?.errors?.[0];
  if (!res.ok || first) {
    const status = res.ok ? 500 : res.status;
    const code = first?.code === undefined || first.code === '' ? undefined : Number(first.code);
    throw new AdminError(cleanMessage(first?.error ?? '') || fallbackMessage(status), res.status, Number.isFinite(code) ? code : undefined, first?.id);
  }
  return json?.result as T;
}

/** Wait `ms` milliseconds (between polls of a background job). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * PUT / POST / DELETE against the Admin API. `path` is relative to
 * /api/admin/v2 and carries its own query string (encode names with
 * encodeURIComponent). Throws AdminError on any failure.
 */
export async function writeJson<T>(method: 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return readEnvelope<T>(await sendAdmin(`${BASE}${path}`, init));
}

/** The message to show for any caught error. */
export const errorText = (err: unknown): string =>
  err instanceof Error ? err.message || fallbackMessage(500) : fallbackMessage(500);

// ═════════════════════════════════════════════════════════════════════
// Disabled-with-a-reason (buttons, menu items)
// ═════════════════════════════════════════════════════════════════════

/**
 * Attributes for an action that IRIS (or your privileges) won't allow:
 * `<button class="btn" ${blockedAttrs('Built-in roles can’t be deleted.')}>Delete</button>`.
 * The button stays focusable so the reason is reachable by keyboard; the
 * reason shows as a tooltip on hover and focus; clicks are swallowed.
 * Pass an empty reason to get '' (not blocked).
 */
export function blockedAttrs(reason: string | undefined | null): string {
  if (!reason) return '';
  return ` aria-disabled="true" data-crud-blocked data-reason="${esc(reason)}" aria-description="${esc(reason)}"`;
}

/** Toggle the blocked state of an existing element. */
export function setBlocked(el: HTMLElement, reason: string | null | undefined): void {
  if (reason) {
    el.setAttribute('aria-disabled', 'true');
    el.setAttribute('data-crud-blocked', '');
    el.dataset.reason = reason;
    el.setAttribute('aria-description', reason);
    if (tipFor === el && tipEl) tipEl.textContent = reason;
  } else {
    el.removeAttribute('aria-disabled');
    el.removeAttribute('data-crud-blocked');
    delete el.dataset.reason;
    el.removeAttribute('aria-description');
    if (tipFor === el) hideTip();
  }
}

// One tooltip for every [data-reason] element, floated on the body so panel
// overflow never clips it. Installed once.
let tipEl: HTMLElement | null = null;
let tipFor: Element | null = null;
function showTip(target: HTMLElement): void {
  const reason = target.dataset.reason;
  if (!reason) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'crud-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
  }
  if (!tipEl.isConnected) document.body.appendChild(tipEl);
  tipFor = target;
  tipEl.textContent = reason;
  tipEl.hidden = false;
  // Above by default; below for controls near the top (page-header buttons), so it never covers the app bar.
  positionOverlay(target, tipEl, { placement: target.getBoundingClientRect().top < 140 ? 'bottom-start' : 'top-start', offset: 6 });
}
function hideTip(): void {
  tipFor = null;
  if (tipEl) tipEl.hidden = true;
}
if (typeof document !== 'undefined') {
  const reasonOf = (e: Event): HTMLElement | null =>
    ((e.target as Element | null)?.closest?.('[data-reason]') as HTMLElement | null) ?? null;
  document.addEventListener('mouseover', (e) => {
    const t = reasonOf(e);
    if (t && t !== tipFor) showTip(t);
    else if (!t && tipFor && !(document.activeElement as Element | null)?.closest?.('[data-reason]')) hideTip();
  });
  document.addEventListener('focusin', (e) => { const t = reasonOf(e); if (t) showTip(t); else hideTip(); });
  document.addEventListener('focusout', () => hideTip());
  document.addEventListener('scroll', () => hideTip(), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tipFor) hideTip(); }, true);
  // Blocked actions never act, whatever the screen wired to them.
  document.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest?.('[data-crud-blocked]')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
}

// ═════════════════════════════════════════════════════════════════════
// 2. confirm()
// ═════════════════════════════════════════════════════════════════════

export interface ConfirmOptions {
  /** Plain text. */
  title: string;
  /** HTML, caller-escaped. */
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button; initial focus stays on Cancel. */
  danger?: boolean;
  /** The confirm button stays disabled until exactly this text is typed. */
  typeToConfirm?: string;
  /**
   * A safer way out, as a third button left of Cancel (e.g. "Disable
   * instead"). Choosing it closes the dialog, resolves false, then calls
   * onSelect. Not gated by typeToConfirm.
   */
  alternative?: { label: string; onSelect: () => void };
}

type DialogEl = HTMLElement & { open: boolean; close(): void };

/**
 * Modal question on ev-dialog: focus trapped, page behind inert, Esc /
 * backdrop / ✕ cancel. Resolves true only when the confirm button is pressed.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('ev-dialog') as DialogEl;
    const inputId = nextId('crud-type');
    dlg.setAttribute('heading', opts.title);
    dlg.setAttribute('size', 'sm');
    dlg.className = 'crud-dialog';
    dlg.innerHTML = `
      <div slot="body" class="crud-dialog-body">
        <div class="crud-dialog-text">${opts.body}</div>
        ${opts.typeToConfirm ? `<label class="crud-type-label" for="${inputId}">Type <strong class="mono">${esc(opts.typeToConfirm)}</strong> to confirm</label>
          <input id="${inputId}" class="crud-native-input mono" type="text" autocomplete="off" spellcheck="false" autocapitalize="off">` : ''}
      </div>
      <div slot="footer" class="crud-dialog-foot">
        ${opts.alternative ? `<button type="button" class="btn crud-dialog-alt" data-crud-alt>${esc(opts.alternative.label)}</button>` : ''}
        <button type="button" class="btn" data-dismiss>${esc(opts.cancelLabel ?? 'Cancel')}</button>
        <button type="button" class="btn ${opts.danger ? 'btn--danger-solid' : 'btn--primary'}" data-crud-ok${opts.typeToConfirm ? ' disabled' : ''}>${esc(opts.confirmLabel)}</button>
      </div>`;
    let ok = false;
    const okBtn = dlg.querySelector('[data-crud-ok]') as HTMLButtonElement;
    const input = dlg.querySelector('input') as HTMLInputElement | null;
    const matches = (): boolean => !opts.typeToConfirm || input?.value === opts.typeToConfirm;
    input?.addEventListener('input', () => { okBtn.disabled = !matches(); });
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && matches()) { e.preventDefault(); okBtn.click(); } });
    okBtn.addEventListener('click', () => { if (!matches()) return; ok = true; dlg.close(); });
    let alt = false;
    dlg.querySelector('[data-crud-alt]')?.addEventListener('click', () => { alt = true; dlg.close(); });
    dlg.addEventListener('ev-dialog-close', () => {
      resolve(ok);
      // After the dialog has let go of focus and modality.
      if (alt) setTimeout(() => opts.alternative?.onSelect(), 0);
      setTimeout(() => dlg.remove(), 0);
    }, { once: true });
    document.body.appendChild(dlg);
    dlg.open = true;
    // ev-dialog focuses its surface on the next frame; land after it.
    const target = (): HTMLElement => input ?? (opts.danger ? dlg.querySelector('[data-dismiss]') as HTMLElement : okBtn);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (dlg.open) target().focus(); }));
  });
}

// ═════════════════════════════════════════════════════════════════════
// 3. toast()
// ═════════════════════════════════════════════════════════════════════

export type ToastTone = 'success' | 'warning' | 'danger' | 'info';
type ToastHost = HTMLElement & { show(o: { message: string; tone?: string; duration?: number }): number };
let toastHost: ToastHost | null = null;

/** One toast at a time, bottom-right above the status bar, gone after ~5s (paused on hover/focus). Plain text. */
export function toast(message: string, tone: ToastTone = 'success'): void {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = document.createElement('ev-toast-container') as ToastHost;
    toastHost.setAttribute('position', 'bottom-right');
    toastHost.setAttribute('max', '1');
    toastHost.className = 'crud-toasts';
    document.body.appendChild(toastHost);
  }
  toastHost.show({ message, tone, duration: tone === 'danger' || tone === 'warning' ? 8000 : 5000 });
}

// ═════════════════════════════════════════════════════════════════════
// 4. newButton()
// ═════════════════════════════════════════════════════════════════════

export interface NewButtonHandle {
  el: HTMLButtonElement;
  /** Block with a reason (shown on hover/focus), or pass null to enable. */
  setBlocked(reason: string | null): void;
  /** Hide entirely (e.g. no privilege to change security). */
  setHidden(hidden: boolean): void;
  remove(): void;
}

/**
 * Primary "New …" button at the left of the page header's actions. Order
 * doesn't matter: call it before or after liveIndicator() — it re-inserts
 * itself whenever the header actions are rewritten, until the screen is left.
 */
/** A header verb that creates something: the only kind that gets the blue primary style. */
export function isCreateLabel(label: string): boolean {
  return /^(new|create|add|grant)(?:[ ]|$)/i.test(label.trim());
}

export function newButton(ctx: ScreenCtx, label: string, onClick: () => void, opts: { disabled?: boolean; reason?: string } = {}): NewButtonHandle {
  const el = document.createElement('button');
  el.type = 'button';
  // Blue primary is reserved for create ("New user", "Grant privilege", "Add …"); any other
  // header verb (Switch journal file, Activate new key) is a secondary button with no plus.
  const create = isCreateLabel(label);
  el.className = `btn${create ? ' btn--primary' : ''} crud-new`;
  el.innerHTML = `${create ? '<ev-icon name="plus" size="xs"></ev-icon>' : ''}<span>${esc(label)}</span>`;
  el.addEventListener('click', () => { if (!el.hasAttribute('data-crud-blocked')) onClick(); });
  const handle: NewButtonHandle = {
    el,
    setBlocked: (reason) => setBlocked(el, reason),
    setHidden: (hidden) => { el.hidden = hidden; },
    remove: () => { observer.disconnect(); el.remove(); },
  };
  if (opts.disabled) handle.setBlocked(opts.reason || 'Not available');
  // Keep "New …" ahead of other header actions. When another New button already
  // leads (a screen with two), leave the order alone: moving would re-trigger
  // the other button's observer, and the two would swap forever.
  const place = (): void => {
    const first = ctx.actions.firstElementChild;
    if (first === el || (first?.classList.contains('crud-new') && el.parentElement === ctx.actions)) return;
    ctx.actions.prepend(el);
  };
  place();
  const observer = new MutationObserver(place);
  observer.observe(ctx.actions, { childList: true });
  ctx.onLeave(() => observer.disconnect());
  return handle;
}

// ═════════════════════════════════════════════════════════════════════
// 5. moreMenu()
// ═════════════════════════════════════════════════════════════════════

export interface MenuItem {
  label: string;
  icon?: string;
  /** Red, and always placed last (after a separator). */
  danger?: boolean;
  disabled?: boolean;
  /** Why it's disabled; shown under the label, in plain text. */
  reason?: string;
  onSelect: () => void;
}

/** Markup for the "More" trigger, for the detail panel's action row. */
export function moreButton(id: string, label = 'More actions'): string {
  return `<button type="button" class="btn btn--sm crud-more" id="${esc(id)}" aria-label="${esc(label)}" title="${esc(label)}"><ev-icon name="more-horizontal" size="sm"></ev-icon></button>`;
}

export interface MenuHandle { open(): void; close(): void; destroy(): void }

/**
 * Overflow menu bound to `anchor` (use moreButton()). Click, Enter, Space or
 * ArrowDown opens it; ArrowUp/Down, Home/End move; Enter/Space select; Esc
 * or Tab close and return focus to the anchor. Disabled items stay
 * focusable so their reason is read out.
 */
export function moreMenu(anchor: HTMLElement, items: MenuItem[]): MenuHandle {
  const menuId = nextId('crud-menu');
  const ordered = [...items.filter((i) => !i.danger), ...items.filter((i) => i.danger)];
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.setAttribute('aria-controls', menuId);

  let menu: HTMLElement | null = null;
  const overlay = { handle: null as ReturnType<typeof createOverlayEntry> | null };

  const buttons = (): HTMLElement[] => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const focusAt = (i: number): void => { const b = buttons(); if (b.length) b[(i + b.length) % b.length].focus(); };

  const close = (returnFocus = true): void => {
    if (!menu) return;
    overlay.handle?.closed();
    menu.remove();
    menu = null;
    anchor.setAttribute('aria-expanded', 'false');
    if (returnFocus) anchor.focus();
  };

  const open = (focusLast = false): void => {
    if (menu) return;
    menu = document.createElement('div');
    menu.className = 'crud-menu';
    menu.id = menuId;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', anchor.getAttribute('aria-label') ?? 'More actions');
    const firstDanger = ordered.findIndex((i) => i.danger);
    menu.innerHTML = ordered.map((it, i) => {
      const off = it.disabled;
      const reasonId = off && it.reason ? `${menuId}-r${i}` : '';
      return `${i === firstDanger && i > 0 ? '<div class="crud-menu-sep" role="separator"></div>' : ''}
        <button type="button" role="menuitem" tabindex="-1" data-i="${i}" class="crud-menu-item${it.danger ? ' crud-menu-item--danger' : ''}"${off ? ' aria-disabled="true"' : ''}${reasonId ? ` aria-describedby="${reasonId}"` : ''}>
          <span class="crud-menu-icon">${it.icon ? `<ev-icon name="${esc(it.icon)}" size="sm"></ev-icon>` : ''}</span>
          <span class="crud-menu-text"><span class="crud-menu-label">${esc(it.label)}</span>${reasonId ? `<span class="crud-menu-reason" id="${reasonId}">${esc(it.reason)}</span>` : ''}</span>
        </button>`;
    }).join('');
    document.body.appendChild(menu);
    positionOverlay(anchor, menu, { placement: 'bottom-end', offset: 4 });
    anchor.setAttribute('aria-expanded', 'true');
    const m = menu;
    overlay.handle = createOverlayEntry(m, {
      close: (reason) => close(reason === 'escape'),
      contains: (path) => path.includes(m) || path.includes(anchor),
    });
    overlay.handle.opened();

    m.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[role="menuitem"]');
      if (!b) return;
      const it = ordered[Number(b.dataset.i)];
      if (!it || it.disabled) return;
      close(true);
      it.onSelect();
    });
    m.addEventListener('keydown', (e) => {
      const b = buttons();
      const i = b.indexOf(document.activeElement as HTMLElement);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); focusAt(i + 1); break;
        case 'ArrowUp': e.preventDefault(); focusAt(i - 1); break;
        case 'Home': e.preventDefault(); focusAt(0); break;
        case 'End': e.preventDefault(); focusAt(b.length - 1); break;
        case 'Tab': e.preventDefault(); close(true); break;
        case 'Enter': case ' ': e.preventDefault(); (document.activeElement as HTMLElement | null)?.click(); break;
        default:
          if (e.key.length === 1 && /\S/.test(e.key)) {
            const k = e.key.toLowerCase();
            const j = [...b.keys()].map((n) => (i + 1 + n) % b.length).find((n) => b[n].textContent?.trim().toLowerCase().startsWith(k));
            if (j !== undefined) focusAt(j);
          }
      }
    });
    requestAnimationFrame(() => focusAt(focusLast ? buttons().length - 1 : 0));
  };

  const onClick = (): void => { if (menu) close(true); else open(); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); open(true); }
  };
  anchor.addEventListener('click', onClick);
  anchor.addEventListener('keydown', onKey);
  return {
    open: () => open(),
    close: () => close(false),
    destroy: () => { close(false); anchor.removeEventListener('click', onClick); anchor.removeEventListener('keydown', onKey); },
  };
}

// ═════════════════════════════════════════════════════════════════════
// 6. editorShell() / panelWidth()
// ═════════════════════════════════════════════════════════════════════

export type FormValue = string | boolean | string[] | Array<{ Name: string; Permissions: string }>;
export type FormValues = Record<string, FormValue>;

export interface EditorOptions {
  /** Header, HTML (caller-escaped): "New user", "Edit <span class=mono>sean</span>". */
  title: string;
  /** A fact about what is being edited, shown under the title (e.g. "Copy of sean"). Not a category label. */
  subtitle?: string;
  /** The form body, HTML: use section() and the field helpers. */
  sections: string;
  /** "Create user" / "Save changes". */
  submitLabel: string;
  /** Do the save. Throw (AdminError or Error) to show the message in the banner and stay in the form. */
  onSubmit: (values: FormValues, form: HTMLFormElement) => Promise<void>;
  /** Leave the form (after the discard guard has passed). Render view mode here. */
  onCancel: () => void;
  /**
   * Whether the form differs from what's saved, when the screen can tell
   * better than a snapshot of the fields (e.g. it diffs against the object).
   * Keeps Save and the screen's own "what changes" preview in agreement.
   */
  changed?: () => boolean;
  /**
   * Return a short reason while the form can't be saved (e.g. "Enter a
   * username"), or null when it can. Runs on every change: keep it cheap.
   * Older, single-reason form of check(): after Save is pressed the reason
   * shows in the footer as a link to the first field with an error.
   */
  validate?: () => string | null;
  /**
   * Preferred over validate(): every problem, per field. Runs when Save is
   * pressed (Save stays enabled once there are changes), then live after
   * each change until fixed. Each problem shows inline on its field
   * (fieldError), the footer lists "2 to fix: Username, Confirm password"
   * as links, and focus moves to the first one. Give the message that fits
   * the state ("Re-enter the password", not "Passwords don't match", when
   * the confirm box is empty).
   */
  check?: () => FieldProblem[];
  /** Name for the guard: "Discard changes to sean?". */
  name?: string;
  /** Treat the form as changed from the start (e.g. a pre-filled copy). */
  startDirty?: boolean;
  /** Let Save be pressed before anything changes (e.g. a create form whose defaults are valid) without counting as unsaved changes. */
  submitAlways?: boolean;
}

export interface EditorHandle {
  isDirty(): boolean;
  /** True when it's fine to leave: nothing changed, or the user chose Discard. */
  guard(): Promise<boolean>;
  /** Server-error banner at the top; null/'' clears it. */
  setError(msg: string | null): void;
  /** Detach listeners (call when you replace the form, e.g. after save). Doesn't call onCancel. */
  close(): void;
  /** Re-run validate() and the dirty check (after changing values from code). */
  refresh(): void;
  /** Take the current values as the new baseline (no longer dirty). */
  markClean(): void;
  /** The form element. */
  form: HTMLFormElement;
}

/** One thing to fix before saving. `field` is the name given to the field helper (or picker). */
export interface FieldProblem {
  field: string;
  /** Short field name for the footer list: "Confirm password". */
  label: string;
  /** Inline message under the field: "Re-enter the password". */
  message: string;
}

/** Focus a field by name (field helper, checkbox, or picker) and bring it into view. */
export function focusField(host: ParentNode, name: string): boolean {
  const esc2 = CSS.escape(name);
  const wrap = host.querySelector<HTMLElement>(`[data-field="${esc2}"], [data-crud-name="${esc2}"]`);
  if (!wrap) return false;
  const ctl = (wrap.localName === 'ev-form-field'
    ? wrap.firstElementChild
    : wrap.querySelector('input:not([disabled]), ev-checkbox, ev-toggle, button:not([disabled]), [tabindex="0"]')) as HTMLElement | null;
  wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
  (ctl ?? wrap).focus({ preventScroll: true });
  return true;
}

/** Events that mean "a value changed" inside the editor. */
const CHANGE_EVENTS = [
  'input', 'change',
  'ev-input-input', 'ev-input-change', 'ev-textarea-input', 'ev-textarea-change',
  'ev-checkbox-change', 'ev-toggle-change', 'ev-select-change',
  'ev-date-picker-change', 'ev-date-picker-input', 'ev-segmented-button-change', 'ev-radio-group-change',
];

/**
 * Render an edit/create form into `host` (the detail panel's <aside>):
 * header, error banner, sections, sticky footer (Cancel + primary submit).
 * Submit is blocked only until the form has changes; problems (check() /
 * validate()) are reported inline and in the footer when it's pressed. It
 * shows a spinner and locks the form while onSubmit runs. Cancel, the ✕ and
 * Esc go through guard(). Password fields are cleared after every submit.
 */
/** Scroll the detail panel that holds `host` back to its top (a new view or form must start at the top). */
export function scrollPanelTop(host: HTMLElement): void {
  const panel = host.closest('ev-detail-panel');
  const scroller = panel?.shadowRoot?.querySelector('.detail') as HTMLElement | null | undefined;
  if (scroller) scroller.scrollTop = 0;
  host.scrollTop = 0;
}

export function editorShell(host: HTMLElement, opts: EditorOptions): EditorHandle {
  const bannerId = nextId('crud-banner');
  host.classList.add('crud-editing');
  host.innerHTML = `
    <form class="crud-editor" novalidate aria-describedby="${bannerId}">
      <header class="detail-head crud-editor-head">
        <div class="detail-title">${opts.subtitle ? `<span class="detail-kicker">${opts.subtitle}</span>` : ''}<h2>${opts.title}</h2></div>
        <ev-icon-button icon="x" label="Cancel editing" data-crud-x></ev-icon-button>
      </header>
      <div class="crud-banner" id="${bannerId}" role="alert" tabindex="-1" hidden>
        <ev-icon name="alert-triangle" size="sm"></ev-icon><div><strong>Couldn’t save</strong><span class="crud-banner-text"></span></div>
      </div>
      <div class="crud-editor-body">${opts.sections}</div>
      <footer class="crud-editor-foot">
        <span class="crud-foot-hint" aria-live="polite"></span>
        <button type="button" class="btn" data-crud-cancel>Cancel</button>
        <button type="submit" class="btn btn--primary crud-submit"><ev-spinner size="sm" label="Saving" hidden></ev-spinner><span>${esc(opts.submitLabel)}</span></button>
      </footer>
    </form>`;
  const form = host.querySelector('form') as HTMLFormElement;
  const body = form.querySelector('.crud-editor-body') as HTMLElement;
  const banner = form.querySelector('.crud-banner') as HTMLElement;
  const submit = form.querySelector('.crud-submit') as HTMLButtonElement;
  const spinner = submit.querySelector('ev-spinner') as HTMLElement;
  const cancelBtn = form.querySelector('[data-crud-cancel]') as HTMLButtonElement;
  const hint = form.querySelector('.crud-foot-hint') as HTMLElement;
  scrollPanelTop(host);
  // Focus the first field at once, so typing straight after "New…" lands in it;
  // retry a frame later only if the field wasn't ready and focus hasn't moved on.
  // The first field in document order of any kind (a picker counts), focused without
  // scrolling: a form always opens at its top.
  const firstField = (): HTMLElement | null =>
    form.querySelector<HTMLElement>('.crud-editor-body :is(ev-input, ev-textarea, ev-select, ev-combo-box, input:not([type="hidden"]), textarea, select):not([disabled])');
  const focusFirst = (): void => { firstField()?.focus({ preventScroll: true }); scrollPanelTop(host); };
  focusFirst();
  requestAnimationFrame(() => { if (!form.contains(document.activeElement)) focusFirst(); else scrollPanelTop(host); });

  let baseline: string | null = null;
  let forcedDirty = !!opts.startDirty;
  let busy = false;
  let closed = false;
  const snapshot = (): string => JSON.stringify(readForm(body));
  const isDirty = (): boolean => forcedDirty || (opts.changed ? opts.changed() : baseline !== null && snapshot() !== baseline);

  // After the first Save attempt, problems are re-checked live so they clear as they're fixed.
  let attempted = false;
  let flagged = new Set<string>();
  interface Problems { list: FieldProblem[]; reason: string | null }
  const problems = (): Problems => ({ list: opts.check?.() ?? [], reason: opts.validate?.() ?? null });
  const hasProblems = (p: Problems): boolean => p.list.length > 0 || p.reason !== null;

  /** Inline errors on each problem field, and the footer's "N to fix" links. */
  const showProblems = (p: Problems): void => {
    const now = new Set(p.list.map((x) => x.field));
    for (const f of flagged) if (!now.has(f)) fieldError(body, f, null);
    for (const x of p.list) fieldError(body, x.field, x.message);
    flagged = now;
    if (p.list.length) {
      hint.innerHTML = `${p.list.length} to fix: ${p.list.map((x, i) =>
        `<button type="button" class="crud-foot-link" data-crud-goto="${esc(x.field)}">${esc(x.label)}</button>${i < p.list.length - 1 ? ', ' : ''}`).join('')}`;
    } else if (p.reason) {
      hint.innerHTML = `To fix: <button type="button" class="crud-foot-link" data-crud-goto="">${esc(p.reason)}</button>`;
    } else hint.textContent = '';
  };

  const refresh = (): void => {
    if (closed) return;
    const dirty = isDirty() || !!opts.submitAlways;
    // Only "nothing changed" blocks Save; problems are reported when it's pressed.
    submit.disabled = busy;
    setBlocked(submit, busy || dirty ? null : 'No changes yet');
    if (busy || !dirty) { if (!busy) hint.textContent = ''; return; }
    if (attempted) showProblems(problems());
    else hint.textContent = '';
  };
  hint.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-crud-goto]');
    if (!b) return;
    const f = b.dataset.crudGoto ?? '';
    if (!(f && focusField(body, f)) && !focusFirstError(body)) submit.focus();
  });
  // Baseline after the screen has mounted pickers into the sections.
  // Taken again a frame later (components settle their values on a microtask)
  // unless the user has already started typing.
  let touched = false;
  queueMicrotask(() => { baseline = snapshot(); refresh(); });
  requestAnimationFrame(() => { if (!touched || baseline === null) baseline = snapshot(); refresh(); });

  const setError = (msg: string | null): void => {
    banner.hidden = !msg;
    (banner.querySelector('.crud-banner-text') as HTMLElement).textContent = msg ?? '';
    if (msg) { banner.focus(); banner.scrollIntoView({ block: 'nearest' }); }
  };

  const setBusy = (on: boolean): void => {
    busy = on;
    body.inert = on;
    cancelBtn.disabled = on;
    form.setAttribute('aria-busy', String(on));
    spinner.hidden = !on;
    refresh();
  };

  const guard = async (): Promise<boolean> => {
    if (closed || !isDirty()) return true;
    const ok = await confirm({
      title: opts.name ? `Discard changes to ${opts.name}?` : 'Discard changes?',
      body: '<p>Your changes haven’t been saved.</p>',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (ok) { forcedDirty = false; baseline = snapshot(); }
    return ok;
  };

  const cancel = async (): Promise<void> => {
    if (busy) return;
    if (await guard()) { close(); opts.onCancel(); }
  };

  const onChange = (e: Event): void => { if (e.isTrusted) touched = true; if (!busy) queueMicrotask(refresh); };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.defaultPrevented || busy) return;
    e.preventDefault();
    void cancel();
  };
  const onUnload = (e: BeforeUnloadEvent): void => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } };

  for (const t of CHANGE_EVENTS) host.addEventListener(t, onChange);
  host.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', onUnload);
  cancelBtn.addEventListener('click', () => void cancel());
  form.querySelector('[data-crud-x]')?.addEventListener('click', () => void cancel());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (busy || (!isDirty() && !opts.submitAlways)) return;
    attempted = true;
    const p = problems();
    showProblems(p);
    if (hasProblems(p)) {
      const first = p.list[0]?.field;
      if (!(first && focusField(body, first)) && !focusFirstError(body)) submit.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const values = readForm(body);
    let cancelled = false;
    opts.onSubmit(values, form).then(() => {
      forcedDirty = false;
      baseline = closed ? baseline : snapshot();
    }, (err: unknown) => {
      if (err instanceof SubmitCancelled) { cancelled = true; return; }
      setError(errorText(err));
    }).finally(() => {
      clearPasswords(body);
      if (!closed) { setBusy(false); if (!banner.hidden) banner.focus(); else if (cancelled) submit.focus(); }
    });
  });

  function close(): void {
    if (closed) return;
    closed = true;
    for (const t of CHANGE_EVENTS) host.removeEventListener(t, onChange);
    host.removeEventListener('keydown', onKey);
    window.removeEventListener('beforeunload', onUnload);
    host.classList.remove('crud-editing');
  }

  return {
    isDirty, guard, setError, close, refresh, form,
    markClean: () => { forcedDirty = false; baseline = snapshot(); refresh(); },
  };
}

/**
 * Set the detail panel's width (e.g. 520 while editing). Returns a function
 * that restores the previous width.
 */
export function panelWidth(panelEl: HTMLElement, px: number): () => void {
  const p = panelEl as HTMLElement & { detailWidth: number };
  const prev = p.detailWidth || Number(panelEl.getAttribute('detail-width')) || 300;
  const max = Math.max(320, Math.floor(window.innerWidth * 0.6));
  p.detailWidth = Math.min(px, max);
  // An editor's width wins over the shared peek width (main.ts) until it closes.
  panelEl.setAttribute('data-width-override', '');
  return () => { panelEl.removeAttribute('data-width-override'); p.detailWidth = prev; };
}

// ═════════════════════════════════════════════════════════════════════
// 7. Fields — markup read back by name
// ═════════════════════════════════════════════════════════════════════

interface FieldOpts {
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Monospace value (names, routines). */
  mono?: boolean;
  maxlength?: number;
  autocomplete?: string;
  /** ev-form-field width: 'sm' | 'md' | 'lg' … */
  width?: string;
}

const fieldAttrs = (o: FieldOpts): string =>
  `${o.required ? ' required' : ''}${o.disabled ? ' disabled' : ''}${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.maxlength ? ` maxlength="${o.maxlength}"` : ''}`;

const wrapField = (name: string, label: string, o: FieldOpts, control: string): string =>
  `<ev-form-field class="crud-field" data-field="${esc(name)}" label="${esc(label)}"${o.hint ? ` hint="${esc(o.hint)}"` : ''}${o.required ? ' required' : ''}${o.width ? ` width="${esc(o.width)}"` : ''}>${control}</ev-form-field>`;

/** A titled group of fields. `bodyHtml` is caller-escaped. */
export function section(title: string, bodyHtml: string, opts: { hint?: string; id?: string } = {}): string {
  return `<section class="crud-section"${opts.id ? ` id="${esc(opts.id)}"` : ''}>
    <h3 class="crud-section-title">${esc(title)}</h3>
    ${opts.hint ? `<p class="crud-section-hint">${esc(opts.hint)}</p>` : ''}
    <div class="crud-section-body">${bodyHtml}</div>
  </section>`;
}

export function textField(name: string, label: string, value = '', opts: FieldOpts = {}): string {
  return wrapField(name, label, opts, `<ev-input name="${esc(name)}" value="${esc(value)}" full-width size="sm"${fieldAttrs(opts)}${opts.autocomplete ? ` autocomplete="${esc(opts.autocomplete)}"` : ' autocomplete="off"'}${opts.mono ? ' class="crud-mono"' : ''}></ev-input>`);
}

/**
 * A path on the IRIS server: a text input plus "Browse…", which opens the
 * server file picker (file-picker.ts). The typed path is checked on the server
 * when the field loses focus, with a quiet hint ("Not found on the server").
 * Without the OSCA file API the Browse button stays hidden and the field is a
 * plain text input. Reads back by `name` like any text field.
 *
 *   pathField('CertificateFile', 'Certificate file', cfg.CertificateFile, {
 *     mode: 'file', filters: [{ label: 'Certificates', patterns: ['*.cer', '*.crt', '*.pem'] }] })
 */
export function pathField(name: string, label: string, value = '', opts: FieldOpts & {
  mode?: 'file' | 'dir';
  filters?: Array<{ label: string; patterns: string[] }>;
  /** Picker title, e.g. "Choose the certificate file". */
  title?: string;
  /** Remembers this field's last folder under this id (default: the field name). Make it unique per form, e.g. "tls.certFile". */
  pickerId?: string;
} = {}): string {
  installPathFields();
  const mode = opts.mode ?? 'file';
  return wrapField(name, label, opts, `<div class="crud-path" data-path-field data-mode="${mode}"${opts.filters ? ` data-filters="${esc(JSON.stringify(opts.filters))}"` : ''}${opts.title ? ` data-title="${esc(opts.title)}"` : ''} data-picker-id="${esc(opts.pickerId ?? name)}">
    <ev-input name="${esc(name)}" value="${esc(value)}" full-width size="sm" class="crud-mono" spellcheck="false"${fieldAttrs(opts)} autocomplete="off"></ev-input>
    <button type="button" class="btn btn--sm crud-path-browse" data-path-browse${opts.disabled ? ' disabled' : ''}>Browse…</button>
  </div><p class="crud-path-hint" aria-live="polite" hidden></p>`);
}

let pathFieldsInstalled = false;
/** One set of document listeners for every pathField: Browse, and the check on blur. */
function installPathFields(): void {
  if (pathFieldsInstalled) return;
  pathFieldsInstalled = true;
  // Form panels never scroll sideways: full-bleed section rules reach under the scrollbar, and
  // focusing a control (Browse…) would otherwise shift the whole form left and clip its labels.
  document.addEventListener('scroll', (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLElement && t.classList.contains('crud-editing') && t.scrollLeft) t.scrollLeft = 0;
  }, true);
  void serverFilesAvailable().then((ok) => {
    document.documentElement.classList.toggle('osca-fs', ok);
  }, () => { /* no file API: Browse stays hidden */ });

  const inputOf = (box: Element): HTMLElement & { value: string } => box.querySelector('ev-input') as HTMLElement & { value: string };
  const hintOf = (box: Element): HTMLElement | null => box.nextElementSibling?.classList.contains('crud-path-hint') ? box.nextElementSibling as HTMLElement : null;
  const setHint = (box: Element, text: string, tone = ''): void => {
    const h = hintOf(box);
    if (!h) return;
    h.textContent = text;
    h.hidden = !text;
    if (tone) h.dataset.tone = tone; else delete h.dataset.tone;
  };

  document.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-path-browse]');
    const box = btn?.closest<HTMLElement>('[data-path-field]');
    if (!btn || !box || btn.hasAttribute('disabled')) return;
    const input = inputOf(box);
    const mode = box.dataset.mode === 'dir' ? 'dir' : 'file';
    let filters: Array<{ label: string; patterns: string[] }> | undefined;
    try { filters = box.dataset.filters ? JSON.parse(box.dataset.filters) as typeof filters : undefined; } catch { filters = undefined; }
    void (async () => {
      const path = await pickServerPath({ mode, filters, start: input.value, title: box.dataset.title, id: box.dataset.pickerId });
      if (path === null) { btn.focus(); return; }
      input.value = path;
      input.setAttribute('value', path);
      for (const type of ['input', 'change']) input.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
      setHint(box, '');
      input.focus();
    })();
  });

  document.addEventListener('focusout', (e) => {
    const box = (e.target as Element | null)?.closest?.('[data-path-field]');
    if (!box || !document.documentElement.classList.contains('osca-fs')) return;
    const input = inputOf(box);
    if (e.target !== input) return;
    const path = String(input.value ?? '').trim();
    if (!path) { setHint(box, ''); return; }
    const mode = (box as HTMLElement).dataset.mode;
    void statServerPath(path).then((st) => {
      if (String(input.value ?? '').trim() !== path) return; // changed meanwhile
      if (!st) setHint(box, '');
      else if (!st.exists) setHint(box, 'Not found on the server', 'warning');
      else if (mode === 'dir' && st.type === 'file') setHint(box, 'That’s a file, not a folder', 'warning');
      else if (mode === 'file' && st.type === 'dir') setHint(box, 'That’s a folder, not a file', 'warning');
      else setHint(box, '');
    });
  });
}

/** Never pre-filled; autocomplete="new-password"; cleared after every submit. */
export function passwordField(name: string, label: string, opts: FieldOpts = {}): string {
  return wrapField(name, label, opts, `<ev-input name="${esc(name)}" type="password" autocomplete="new-password" data-crud-password full-width size="sm"${fieldAttrs(opts)}></ev-input>`);
}

export function textareaField(name: string, label: string, value = '', opts: FieldOpts & { rows?: number } = {}): string {
  return wrapField(name, label, opts, `<ev-textarea name="${esc(name)}" value="${esc(value)}" rows="${opts.rows ?? 2}" full-width size="sm"${fieldAttrs(opts)}></ev-textarea>`);
}

/** Checkbox (or a switch with `toggle: true`) with its label beside it and an optional hint below. Reads back as boolean. */
export function checkField(name: string, label: string, checked = false, opts: { hint?: string; disabled?: boolean; toggle?: boolean } = {}): string {
  const tag = opts.toggle ? 'ev-toggle' : 'ev-checkbox';
  return `<div class="crud-check" data-field="${esc(name)}">
    <${tag} name="${esc(name)}"${checked ? ' checked' : ''}${opts.disabled ? ' disabled' : ''}${tag === 'ev-checkbox' ? ' size="sm"' : ''}>${esc(label)}</${tag}>
    ${opts.hint ? `<p class="crud-check-hint">${esc(opts.hint)}</p>` : ''}
  </div>`;
}

/** Single select. Reads back as the chosen value string. */
export function selectField(name: string, label: string, options: Array<{ value: string; label: string }>, value = '', opts: FieldOpts & { searchable?: boolean } = {}): string {
  return wrapField(name, label, opts, `<ev-select name="${esc(name)}" value="${esc(value)}" size="sm" full-width${opts.searchable ? ' searchable' : ''}${fieldAttrs(opts)}>${
    options.map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</ev-select>`);
}

/** Namespace select; '' reads back as "use the instance default". */
export function namespaceField(name: string, label: string, namespaces: string[], value = '', opts: FieldOpts & { emptyLabel?: string } = {}): string {
  const list = [...new Set([...namespaces, ...(value ? [value] : [])])].sort();
  return selectField(name, label, [{ value: '', label: opts.emptyLabel ?? 'Instance default' }, ...list.map((n) => ({ value: n, label: n }))], value, { searchable: list.length > 8, ...opts });
}

/** Date as "YYYY-MM-DD"; '' when empty. */
export function dateField(name: string, label: string, value = '', opts: FieldOpts & { min?: string; max?: string } = {}): string {
  return wrapField(name, label, opts, `<ev-date-picker name="${esc(name)}" value="${esc(value)}" size="sm" full-width editable${opts.min ? ` min="${esc(opts.min)}"` : ''}${opts.max ? ` max="${esc(opts.max)}"` : ''}${fieldAttrs(opts)}></ev-date-picker>`);
}

type ValueEl = HTMLElement & { value?: unknown; checked?: boolean; crudValue?: () => FormValue };

/**
 * Every named value inside `host`: ev-input / ev-textarea / ev-select /
 * ev-date-picker / native inputs by `name` (strings; multi-select → string[]),
 * ev-checkbox / ev-toggle / checkbox inputs (booleans), and pickers mounted
 * with a `name` (rolePicker → string[], resourcePermissionEditor → rows).
 */
export function readForm(host: ParentNode): FormValues {
  const out: FormValues = {};
  for (const el of host.querySelectorAll<ValueEl>('[name], [data-crud-name]')) {
    // Controls inside a picker belong to the picker, which reports for them.
    if (el.parentElement?.closest('[data-crud-name]')) continue;
    if (el.dataset.crudName !== undefined) { if (el.crudValue) out[el.dataset.crudName] = el.crudValue(); continue; }
    const name = el.getAttribute('name');
    if (!name) continue;
    const tag = el.localName;
    if (tag === 'ev-checkbox' || tag === 'ev-toggle') out[name] = !!el.checked;
    else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) { if (el.type === 'checkbox') out[name] = el.checked; else if (el.checked) out[name] = el.value; }
    else if (tag === 'ev-select' || tag === 'ev-input' || tag === 'ev-textarea' || tag === 'ev-date-picker' || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      const v = el.value ?? el.getAttribute('value') ?? '';
      out[name] = Array.isArray(v) ? v.map(String) : String(v);
    }
  }
  return out;
}

/** Show (or clear, with null) the inline error under a field. */
export function fieldError(host: ParentNode, name: string, msg: string | null): void {
  const n = CSS.escape(name);
  const field = host.querySelector<HTMLElement>(`[data-field="${n}"], [data-crud-name="${n}"]`);
  if (!field) return;
  if (field.localName === 'ev-form-field') {
    if (msg) field.setAttribute('error', msg); else field.removeAttribute('error');
    let ctl = field.firstElementChild as HTMLElement | null;
    if (ctl?.classList.contains('crud-path')) ctl = ctl.querySelector('ev-input'); // pathField: the input inside
    if (ctl && 'state' in ctl) { if (msg) ctl.setAttribute('state', 'error'); else ctl.removeAttribute('state'); }
  } else {
    let p = field.querySelector<HTMLElement>('.crud-inline-error');
    if (!msg) { p?.remove(); return; }
    if (!p) {
      p = document.createElement('p');
      p.className = `crud-inline-error${field.dataset.crudName !== undefined ? ' crud-inline-error--block' : ''}`;
      p.setAttribute('role', 'alert');
      field.appendChild(p);
    }
    p.textContent = msg;
  }
}

/** Focus the first field showing an error; returns whether there was one. */
export function focusFirstError(host: ParentNode): boolean {
  const f = host.querySelector<HTMLElement>('ev-form-field[error], [data-field]:has(.crud-inline-error), [data-crud-name]:has(> .crud-inline-error)');
  if (!f) return false;
  const ctl = (f.localName === 'ev-form-field' ? f.firstElementChild : f.querySelector('input, button, [tabindex], ev-checkbox, ev-toggle')) as HTMLElement | null;
  ctl?.focus();
  f.scrollIntoView({ block: 'nearest' });
  return true;
}

/** Empty every password field inside host. */
export function clearPasswords(host: ParentNode): void {
  for (const el of host.querySelectorAll<HTMLElement & { value: string }>('[data-crud-password], input[type="password"]')) el.value = '';
}

// ═════════════════════════════════════════════════════════════════════
// 8. Pickers
// ═════════════════════════════════════════════════════════════════════

interface ComboOption {
  value: string; name: string;
  /** Portal's plain-English summary (first line under the name). */
  sub?: string;
  /** IRIS's own description (second, fainter line). */
  desc?: string;
  /** Warning line (e.g. "Gives full access to everything"). */
  warn?: string;
  group?: string;
}

/**
 * Searchable listbox behind a text input (ARIA combobox, list inline under
 * the input so panel overflow never clips it). Opens on focus/typing;
 * ArrowUp/Down move, Enter picks, Esc closes (then clears), Tab leaves.
 */
function mountCombo(input: HTMLInputElement, list: HTMLElement, source: (q: string) => ComboOption[], pick: (value: string) => void, emptyText: string): { close(): void; refresh(): void } {
  let active = -1;
  let shown: ComboOption[] = [];
  const optId = (i: number): string => `${list.id}-o${i}`;
  const setActive = (i: number): void => {
    active = shown.length ? (i + shown.length) % shown.length : -1;
    list.querySelectorAll('[role="option"]').forEach((o, n) => o.setAttribute('aria-selected', String(n === active)));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', optId(active));
      list.querySelector(`#${CSS.escape(optId(active))}`)?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const render = (): void => {
    shown = source(input.value.trim().toLowerCase()).slice(0, 200);
    let group: string | undefined;
    list.innerHTML = shown.length ? shown.map((o, i) => {
      const head = o.group && o.group !== group ? `<li class="crud-option-group" role="presentation">${esc(o.group)}</li>` : '';
      group = o.group;
      return `${head}<li class="crud-option" role="option" id="${optId(i)}" data-i="${i}" aria-selected="false">
        <span class="crud-option-name">${esc(o.name)}</span>${
          o.warn ? `<span class="crud-option-warn">${esc(o.warn)}</span>` : ''}${
          o.sub ? `<span class="crud-option-sub">${esc(o.sub)}</span>` : ''}${
          o.desc && o.desc !== o.sub ? `<span class="crud-option-desc">${esc(o.desc)}</span>` : ''}</li>`;
    }).join('') : `<li class="crud-options-empty" role="presentation">${esc(emptyText)}</li>`;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    setActive(input.value.trim() && shown.length ? 0 : -1);
  };
  const close = (): void => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const choose = (i: number): void => {
    const o = shown[i];
    if (!o) return;
    input.value = '';
    pick(o.value);
    if (document.activeElement === input) render(); else close();
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
  // Keep focus in the input while clicking an option.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = (e.target as Element).closest<HTMLElement>('[role="option"]');
    if (li) choose(Number(li.dataset.i));
  });
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (!open) render(); setActive(active + 1); break;
      case 'ArrowUp': e.preventDefault(); if (!open) render(); setActive(active - 1); break;
      case 'Enter':
        e.preventDefault(); // never submit the form from here
        if (open && active >= 0) choose(active);
        break;
      case 'Escape':
        if (open) { e.preventDefault(); e.stopPropagation(); close(); }
        else if (input.value) { e.preventDefault(); e.stopPropagation(); input.value = ''; }
        break;
      case 'Tab': close(); break;
    }
  });
  return { close, refresh: () => { if (!list.hidden) render(); } };
}

/** Announce a picker's change to onChange and to the editor's dirty tracking. */
const announce = (host: HTMLElement): void => { host.dispatchEvent(new Event('change', { bubbles: true })); };

/**
 * The role picker warns about the shared POWERFUL_ROLES (api-security.ts) and
 * also about %SecureBreak, which restricts rather than empowers. They are
 * merged when a picker opens, not at load, because api-security.ts imports
 * this module.
 */
const PICKER_ONLY_WARNINGS: Record<string, string> = {
  '%SecureBreak': 'Restricts the user; don’t add it unless you mean to',
};

/** "%DB_USER" → true: database roles give read AND change. */
const isDbRole = (name: string): boolean => /^%DB_/i.test(name);

export interface RolePickerOptions {
  all: RoleSummary[];
  selected: string[];
  onChange: (names: string[]) => void;
  /** Key for readForm(); set it inside an editorShell so changes count as edits. */
  name?: string;
  /** Visible label. Default "Roles". */
  label?: string;
  /** Names that can't be picked (e.g. the role being edited, for "includes roles"). */
  exclude?: string[];
  /** Shown when nothing is selected. */
  emptyText?: string;
  /** Override the privileged-role warnings (role → sentence). */
  warnings?: Record<string, string>;
  /**
   * The portal's plain-English summary of a role ("Can read and change data
   * in USER; can use SQL"), shown as the option's first line. IRIS's own
   * description follows on a second, fainter line. Return null for none.
   */
  summary?: (roleName: string) => string | null | undefined;
  /**
   * Offered when a %DB_* role is picked (those give read and change): shows
   * a "Create a read-only role" action that calls this with the role name
   * (e.g. open New role pre-filled with Read on that database resource).
   */
  onCreateReadOnly?: (dbRole: string) => void;
}

export interface RolePickerHandle { value(): string[]; set(names: string[]): void }

/**
 * Multi-select of roles: removable chips, then a search box whose options
 * show the name, any warning, the portal's summary and IRIS's description.
 * Picking a privileged role (or a %DB_* role, which gives read and change)
 * shows an inline warning.
 */
export function rolePicker(host: HTMLElement, opts: RolePickerOptions): RolePickerHandle {
  const id = nextId('crud-roles');
  const warnings = opts.warnings ?? { ...POWERFUL_ROLES, ...PICKER_ONLY_WARNINGS };
  let selected = [...new Set(opts.selected)];
  const byName = new Map(opts.all.map((r) => [r.Name, r]));
  host.classList.add('crud-picker');
  if (opts.name) host.dataset.crudName = opts.name;
  (host as HTMLElement & { crudValue?: () => FormValue }).crudValue = () => [...selected];
  host.innerHTML = `
    <span class="crud-picker-label" id="${id}-label">${esc(opts.label ?? 'Roles')}</span>
    <div class="crud-chips" role="list" aria-labelledby="${id}-label"></div>
    <div class="crud-search"><ev-icon name="search" size="sm"></ev-icon>
      <input class="crud-native-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list"
        aria-label="Add a role to ${esc(opts.label ?? 'Roles')}" placeholder="Add a role…" autocomplete="off" spellcheck="false"></div>
    <ul class="crud-options" role="listbox" id="${id}-list" aria-label="Roles" hidden></ul>
    <div class="crud-note crud-note--warning" role="status" hidden></div>`;
  const chips = host.querySelector('.crud-chips') as HTMLElement;
  const input = host.querySelector('input') as HTMLInputElement;
  const note = host.querySelector('.crud-note') as HTMLElement;
  const exclude = new Set(opts.exclude ?? []);

  const renderChips = (): void => {
    chips.innerHTML = selected.length ? selected.map((n) => `<span class="crud-chip${warnings[n] ? ' crud-chip--warn' : ''}" role="listitem" title="${esc(byName.get(n)?.Description ?? '')}">
        <span>${esc(n)}</span><button type="button" data-remove="${esc(n)}" aria-label="Remove ${esc(n)}"><ev-icon name="x" size="xs"></ev-icon></button></span>`).join('')
      : `<span class="crud-chips-empty">${esc(opts.emptyText ?? 'None')}</span>`;
    const lines: string[] = selected.filter((n) => warnings[n])
      .map((n) => `<span class="mono">${esc(n)}</span>: ${esc(warnings[n])}.`);
    for (const n of selected.filter(isDbRole)) {
      lines.push(`<span class="mono">${esc(n)}</span> gives read <strong>and change</strong>. For read-only, use a role with Read on <span class="mono">${esc(n)}</span>.${
        opts.onCreateReadOnly ? ` <button type="button" class="crud-link" data-readonly="${esc(n)}">Create a read-only role</button>` : ''}`);
    }
    note.hidden = !lines.length;
    note.innerHTML = lines.length ? `<ev-icon name="alert-triangle" size="sm"></ev-icon><div>${
      lines.length === 1 ? `<span>${lines[0]}</span>` : `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`}</div>` : '';
  };
  note.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-readonly]');
    if (b) opts.onCreateReadOnly?.(b.dataset.readonly ?? '');
  });
  const dbWarn = (n: string): string | undefined => (isDbRole(n) ? 'Gives read and change on this database' : undefined);
  const changed = (): void => { renderChips(); combo.refresh(); opts.onChange([...selected]); announce(host); };

  const combo = mountCombo(input, host.querySelector('.crud-options') as HTMLElement, (q) =>
    opts.all
      .filter((r) => !selected.includes(r.Name) && !exclude.has(r.Name))
      .map((r) => ({ r, sub: opts.summary?.(r.Name) ?? '' }))
      .filter(({ r, sub }) => !q || [r.Name, r.Description ?? '', sub].some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => a.r.Name.localeCompare(b.r.Name))
      .map(({ r, sub }) => ({ value: r.Name, name: r.Name, warn: warnings[r.Name] ?? dbWarn(r.Name), sub: sub || undefined, desc: r.Description || undefined })),
  (name) => { if (!selected.includes(name)) { selected = [...selected, name]; changed(); } }, 'No matching roles');

  chips.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-remove]');
    if (!b) return;
    const i = selected.indexOf(b.dataset.remove ?? '');
    if (i < 0) return;
    selected = selected.filter((n) => n !== b.dataset.remove);
    changed();
    const next = chips.querySelectorAll<HTMLElement>('[data-remove]')[Math.min(i, selected.length - 1)];
    (next ?? input).focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && selected.length) {
      e.preventDefault();
      selected = selected.slice(0, -1);
      changed();
    }
  });
  renderChips();
  return {
    value: () => [...selected],
    set: (names) => { selected = [...new Set(names)]; renderChips(); combo.refresh(); },
  };
}

export interface ResourceInfo { Name: string; ResourceType: string; Description: string }
export interface ResourceGrant { Name: string; Permissions: string }

/** Database resources take Read / Write; everything else takes Use. */
export const isDatabaseResource = (r: { Name: string; ResourceType?: string }): boolean =>
  r.ResourceType === 'Database' || /^%DB_/i.test(r.Name);

/** The portal's resource groups (the same on every screen). */
export type ResourceGroup = 'Databases' | 'Services' | 'Admin powers' | 'Apps' | 'Other';
const GROUP_ORDER: ResourceGroup[] = ['Databases', 'Services', 'Admin powers', 'Apps', 'Other'];
/** Databases / Services / Admin powers / Apps / Other. */
export function resourceGroup(r: { Name: string; ResourceType?: string }): ResourceGroup {
  if (isDatabaseResource(r)) return 'Databases';
  if (r.ResourceType === 'Service' || /^%Service_/i.test(r.Name)) return 'Services';
  if (r.ResourceType === 'System' || /^%(Admin_|Development|System_|Secure_)/i.test(r.Name)) return 'Admin powers';
  if (r.ResourceType === 'Application' || r.ResourceType === 'DeepSee' || r.ResourceType === 'Interoperability') return 'Apps';
  return 'Other';
}
const groupLabel = resourceGroup;

/** The shared vocabulary (ui.ts permWords): "Read", "Read & change", "Use", joined with " · "; "No access" when empty. */
export function permissionLabel(_r: { Name: string; ResourceType?: string }, perms: string): string {
  const words = permWords(perms);
  return words.length ? words.join(' · ') : 'No access';
}

/** Canonical "RWU" order; Write always brings Read (IRIS stores it that way too). */
const canon = (p: string): string => {
  const up = p.toUpperCase();
  return ['R', 'W', 'U'].filter((c) => up.includes(c) || (c === 'R' && up.includes('W'))).join('');
};

export interface ResourceEditorOptions {
  resources: ResourceInfo[];
  value: ResourceGrant[];
  onChange: (value: ResourceGrant[]) => void;
  /** Key for readForm(); set it inside an editorShell so changes count as edits. */
  name?: string;
  /** Visible label. Default "Resources". */
  label?: string;
  /**
   * Plain-English main line for a row, matching the view screens: pass
   * api-security's privilegeText, e.g. `(name, perms) => privilegeText(name, perms, graph)`.
   * Called with the row's current permissions on every change. Without it
   * the row shows the resource's description.
   */
  describe?: (resourceName: string, perms: string) => string;
}

export interface ResourceEditorHandle { value(): ResourceGrant[]; set(value: ResourceGrant[]): void }

/**
 * Rows of resource + permission toggles, grouped Databases / Services / Admin
 * powers / Apps / Other. Each row's main line is plain English (describe()),
 * with the code (%DB_USER:RW) under it in small mono. Databases: a segmented
 * control, Read | Read & change (the one Check access uses); others: a fixed
 * "Use" label (× is the only way to remove access). Controls never wrap.
 * Rows can be removed; "Add resource" opens a search grouped the same way.
 * value() leaves out rows with no permission; unknown letters on a row are kept.
 */
export function resourcePermissionEditor(host: HTMLElement, opts: ResourceEditorOptions): ResourceEditorHandle {
  const id = nextId('crud-res');
  const info = new Map(opts.resources.map((r) => [r.Name, r]));
  const infoOf = (name: string): ResourceInfo => info.get(name) ?? { Name: name, ResourceType: '', Description: '' };
  let rows: ResourceGrant[] = opts.value.map((g) => ({ Name: g.Name, Permissions: canon(g.Permissions) }));
  const out = (): ResourceGrant[] => rows.filter((r) => r.Permissions).map((r) => ({ ...r }));

  host.classList.add('crud-picker');
  if (opts.name) host.dataset.crudName = opts.name;
  (host as HTMLElement & { crudValue?: () => FormValue }).crudValue = out;
  host.innerHTML = `
    <span class="crud-picker-label" id="${id}-label">${esc(opts.label ?? 'Resources')}</span>
    <div class="crud-perms" role="list" aria-labelledby="${id}-label"></div>
    <button type="button" class="btn btn--sm crud-add" aria-expanded="false" aria-controls="${id}-adder"><ev-icon name="plus" size="xs"></ev-icon>Add resource</button>
    <div class="crud-adder" id="${id}-adder" hidden>
      <div class="crud-search"><ev-icon name="search" size="sm"></ev-icon>
        <input class="crud-native-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${id}-list"
          aria-label="Find a resource to add" placeholder="Find a resource…" autocomplete="off" spellcheck="false"></div>
      <ul class="crud-options" role="listbox" id="${id}-list" aria-label="Resources" hidden></ul>
    </div>`;
  const list = host.querySelector('.crud-perms') as HTMLElement;
  const addBtn = host.querySelector('.crud-add') as HTMLButtonElement;
  const adder = host.querySelector('.crud-adder') as HTMLElement;
  const input = adder.querySelector('input') as HTMLInputElement;

  /** Main line, code and label for a row, from its current permissions. */
  const rowText = (g: ResourceGrant): { main: string; code: string; aria: string } => {
    const r = infoOf(g.Name);
    const p = g.Permissions;
    return {
      main: !p ? 'No access: removed when you save' : opts.describe?.(g.Name, p) || r.Description || g.Name,
      code: `${g.Name}${p ? `:${p}` : ''}`,
      aria: `${g.Name}: ${permissionLabel(r, p)}`,
    };
  };
  /**
   * Controls match Check access: databases get an ev-segmented-button
   * (Read | Read & change); everything else a fixed "Use" label.
   */
  const rowHtml = (g: ResourceGrant, i: number): string => {
    const r = infoOf(g.Name);
    const t = rowText(g);
    const control = isDatabaseResource(r)
      ? `<ev-segmented-button size="sm" data-seg="${i}" aria-label="Access to ${esc(g.Name)}"></ev-segmented-button>`
      // Nothing to choose: a fixed label (× removes the row). Shows the row's real letters in case it carries more than Use.
      : `<span class="crud-perm-fixed">${esc(g.Permissions ? permissionLabel(r, g.Permissions) : 'Use')}</span>`;
    return `<div class="crud-perm-row" role="listitem" data-row="${i}" aria-label="${esc(t.aria)}">
      <div class="crud-perm-name"><span class="crud-perm-main${g.Permissions ? '' : ' crud-perm-none'}">${esc(t.main)}</span>
        <span class="crud-perm-code mono" title="${esc(r.Description || g.Name)}">${esc(t.code)}</span></div>
      <div class="crud-perm-toggles">${control}</div>
      <button type="button" class="crud-icon-btn" data-remove="${i}" aria-label="Remove ${esc(g.Name)}" title="Remove"><ev-icon name="x" size="xs"></ev-icon></button>
    </div>`;
  };
  type SegEl = HTMLElement & { options: Array<{ value: string; label: string }>; value: string };
  /** Rows grouped Databases / Services / Admin powers / Apps / Other; indexes stay those of `rows`. */
  const render = (): void => {
    if (!rows.length) { list.innerHTML = '<div class="crud-perms-empty">No resources yet. Add one to grant access.</div>'; return; }
    const indexed = rows.map((g, i) => ({ g, i, group: groupLabel(infoOf(g.Name)) }));
    list.innerHTML = GROUP_ORDER.map((grp) => {
      const inGroup = indexed.filter((x) => x.group === grp).sort((a, b) => a.g.Name.localeCompare(b.g.Name));
      return inGroup.length ? `<div class="crud-perm-group" role="presentation">${esc(grp)}</div>${inGroup.map((x) => rowHtml(x.g, x.i)).join('')}` : '';
    }).join('');
    for (const seg of list.querySelectorAll<SegEl>('ev-segmented-button[data-seg]')) {
      const p = rows[Number(seg.dataset.seg)].Permissions;
      seg.options = [{ value: 'R', label: 'Read' }, { value: 'RW', label: 'Read & change' }];
      seg.value = p.includes('W') ? 'RW' : p.includes('R') ? 'R' : '';
    }
  };
  const changed = (): void => { render(); combo.refresh(); opts.onChange(out()); announce(host); };

  /** A permission changed on row i: update that row in place (focus stays on its control). */
  const setPerms = (i: number, perms: string): void => {
    rows[i] = { ...rows[i], Permissions: canon(perms) };
    const el = list.querySelector<HTMLElement>(`.crud-perm-row[data-row="${i}"]`);
    if (el) {
      const t = rowText(rows[i]);
      const main = el.querySelector('.crud-perm-main') as HTMLElement;
      main.textContent = t.main;
      main.classList.toggle('crud-perm-none', !rows[i].Permissions);
      (el.querySelector('.crud-perm-code') as HTMLElement).textContent = t.code;
      el.setAttribute('aria-label', t.aria);
    }
    opts.onChange(out());
    announce(host);
  };

  list.addEventListener('ev-segmented-button-change', (e) => {
    const seg = (e.target as Element).closest<HTMLElement>('[data-seg]');
    if (!seg) return;
    e.stopPropagation(); // announce() reports the change once, from the host
    const i = Number(seg.dataset.seg);
    const v = (e as CustomEvent<{ value: string }>).detail.value;
    // Keep any letters the control doesn't offer (e.g. U on a database).
    setPerms(i, rows[i].Permissions.replace(/[RW]/g, '') + (v === 'RW' ? 'RW' : v === 'R' ? 'R' : ''));
  });
  list.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-remove]');
    if (!b) return;
    const i = Number(b.dataset.remove);
    rows = rows.filter((_, n) => n !== i);
    changed();
    const next = list.querySelectorAll<HTMLElement>('[data-remove]')[Math.min(i, rows.length - 1)];
    (next ?? addBtn).focus();
  });

  const setAdder = (open: boolean): void => {
    adder.hidden = !open;
    addBtn.setAttribute('aria-expanded', String(open));
    if (open) input.focus(); else { combo.close(); input.value = ''; }
  };
  addBtn.addEventListener('click', () => setAdder(adder.hidden));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); setAdder(false); addBtn.focus(); }
  });

  const combo = mountCombo(input, adder.querySelector('.crud-options') as HTMLElement, (q) => {
    const taken = new Set(rows.map((r) => r.Name));
    return opts.resources
      .filter((r) => !taken.has(r.Name))
      .filter((r) => !q || r.Name.toLowerCase().includes(q) || (r.Description ?? '').toLowerCase().includes(q))
      .map((r) => ({ value: r.Name, name: r.Name, sub: opts.describe?.(r.Name, isDatabaseResource(r) ? 'R' : 'U') || undefined, desc: r.Description || undefined, group: groupLabel(r) as string }))
      .sort((a, b) => (GROUP_ORDER as string[]).indexOf(a.group ?? "") - (GROUP_ORDER as string[]).indexOf(b.group ?? "") || a.name.localeCompare(b.name));
  }, (name) => {
    rows = [...rows, { Name: name, Permissions: isDatabaseResource(infoOf(name)) ? 'R' : 'U' }];
    changed();
    setAdder(false);
    list.querySelector<HTMLElement>(`[data-seg="${rows.length - 1}"], [data-remove="${rows.length - 1}"]`)?.focus();
  }, 'No matching resources');

  render();
  return {
    value: out,
    set: (v) => { rows = v.map((g) => ({ Name: g.Name, Permissions: canon(g.Permissions) })); render(); combo.refresh(); },
  };
}

export type { RoleSummary };
