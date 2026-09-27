// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign-in screen, shown before the portal shell whenever there is no session.
 * Resolves once the user has signed in. There is deliberately no way past it
 * in a production build; for local development against an instance without
 * password authentication, set VITE_SKIP_SIGNIN=1 (dev server only).
 *
 * Before sign-in the page reads the instance's identity from %Api.Monitor's
 * metrics feed (unauthenticated by default), so the user can see exactly
 * which server they are about to sign in to — and whether it is reachable.
 */
import '@evolution-ui/core/components/ev-form-field/ev-form-field.js';
import '@evolution-ui/core/components/ev-input/ev-input.js';
import '@evolution-ui/core/components/ev-button/ev-button.js';
import '@evolution-ui/core/components/ev-icon-button/ev-icon-button.js';
import '@evolution-ui/core/components/ev-icon/ev-icon.js';
import { applyTheme, initTheme, THEME_STORAGE_KEY } from '@evolution-ui/core/design/theme-manager';
import { login, allowsAnonymous, auth, SignInError } from './auth';
import { parsePrometheus } from './metrics';
import { esc, BRAND_MARK, serverName } from './ui';

type InputEl = HTMLElement & { value: string; type: string; focus(): void };
type FieldEl = HTMLElement & { error: string };

type ThemeChoice = 'system' | 'light' | 'dark';

const MONITOR_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
const THEME_OPTIONS: { value: ThemeChoice; label: string; icon: string }[] = [
  { value: 'system', label: 'Match system', icon: MONITOR_ICON },
  { value: 'light', label: 'Light', icon: '<ev-icon name="sun" size="xs"></ev-icon>' },
  { value: 'dark', label: 'Dark', icon: '<ev-icon name="moon" size="xs"></ev-icon>' },
];

/** The persisted mode, or 'system' when the OS scheme is being followed. */
function themeChoice(): ThemeChoice {
  try {
    const mode = (JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? '{}') as { mode?: string }).mode;
    return mode === 'light' || mode === 'dark' ? mode : 'system';
  } catch { return 'system'; }
}

function setThemeChoice(choice: ThemeChoice): void {
  if (choice !== 'system') { applyTheme({ mode: choice }); return; }
  // Forget the manual mode so initTheme() goes back to following the OS.
  try {
    const stored = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    delete stored.mode;
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(stored));
  } catch { /* storage unavailable */ }
  initTheme();
}

interface Identity { reachable: boolean; name?: string; product?: string; version?: string }

async function identity(): Promise<Identity> {
  try {
    // credentials: 'omit' — a locked-down feed answers 401, and the browser must not pop its own sign-in box.
    const res = await fetch('/api/monitor/metrics', { headers: { Accept: 'text/plain' }, credentials: 'omit' });
    if (!res.ok) return { reachable: true }; // up, but the feed is locked down
    const info = parsePrometheus(await res.text()).get('iris_system_info')?.[0]?.labels ?? {};
    return { reachable: true, name: info.id, product: info.product, version: info.version };
  } catch {
    return { reachable: false };
  }
}

export async function signIn(root: HTMLElement): Promise<void> {
  if (auth.signedIn) return;
  // Dev-only bypass: import.meta.env.DEV is false in `vite build`, so this is dropped from the bundle.
  if (import.meta.env.DEV && import.meta.env.VITE_SKIP_SIGNIN === '1') { auth.continueAnonymously(); return; }
  const [id, open] = await Promise.all([identity(), allowsAnonymous()]);
  const version = id.version ? `IRIS ${esc(id.version)}` : '';

  root.innerHTML = `
    <div class="signin">
      <div class="signin-top">
        <div class="signin-brand"><span class="mark">${BRAND_MARK}</span><span>OSCA Admin</span></div>
      </div>
      <form class="signin-card" novalidate>
        <div class="signin-head">
        <h1>Sign in</h1>
        <div class="server-chip server-chip--${id.reachable ? 'ok' : 'down'}" id="server-chip" title="${esc(location.host)}: ${id.reachable ? 'reachable' : 'not responding'}">
          <span class="server-dot" aria-hidden="true"></span><span class="sr-only">${id.reachable ? 'Reachable:' : 'Not responding:'}</span>
          ${id.name ? `<b>${esc(id.name)}</b>` : ''}
          <span class="server-host" id="server-host">${esc(location.host)}</span>
          ${version ? `<span class="server-sep" aria-hidden="true">·</span><span class="server-version">${version}</span>` : ''}
        </div>
        ${id.reachable ? '' : '<p class="server-down"><ev-icon name="alert-circle" size="xs"></ev-icon>This server isn’t responding.<button type="button" class="link" id="btn-retry">Retry</button></p>'}
        <p class="signin-sub">Use your InterSystems IRIS account.</p>

        <div role="alert">
          <div class="signin-alert" id="signin-alert" hidden>
            <ev-icon name="alert-circle" size="sm"></ev-icon><div><span id="signin-alert-text"></span><small id="signin-alert-detail" hidden></small><a class="signin-alert-link" id="signin-alert-link" href="/csp/sys/UtilHome.csp" target="_blank" rel="noopener" hidden>Open the Management Portal</a></div>
          </div>
        </div>
        </div>

        <ev-form-field label="Username" id="f-user">
          <ev-input id="in-user" name="user" size="lg" autocomplete="username" full-width></ev-input>
        </ev-form-field>
        <ev-form-field label="Password" id="f-pass">
          <ev-input id="in-pass" name="password" type="password" size="lg" autocomplete="current-password" full-width>
            <ev-icon-button slot="suffix" id="btn-reveal" icon="eye" label="Show password" aria-pressed="false"></ev-icon-button>
          </ev-input>
        </ev-form-field>
        <p class="caps" id="caps" hidden><ev-icon name="alert-triangle" size="xs"></ev-icon>Caps Lock is on.</p>

        <ev-button id="btn-signin" type="submit" variant="brand" size="lg" full>Sign in</ev-button>

      </form>
      <footer class="signin-foot">
        <span>OSCA Admin 0.1.0 · for InterSystems IRIS 2026.2+</span>
        <div class="theme-pick" id="signin-theme" role="radiogroup" aria-label="Theme">
          ${THEME_OPTIONS.map((o) => `<button type="button" role="radio" data-value="${o.value}" aria-label="${o.label}" title="${o.label}">${o.icon}</button>`).join('')}
        </div>
      </footer>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const form = $<HTMLFormElement>('form');
  const user = $<InputEl>('#in-user');
  const pass = $<InputEl>('#in-pass');
  const btn = $<HTMLElement & { loading: boolean }>('#btn-signin');
  const userField = $<FieldEl>('#f-user');
  const passField = $<FieldEl>('#f-pass');
  const alert = $<HTMLElement>('#signin-alert');
  const showAlert = (text: string, detail = '', portalLink = false): void => {
    ($<HTMLElement>('#signin-alert-text')).textContent = text;
    const d = $<HTMLElement>('#signin-alert-detail');
    d.textContent = detail;
    d.hidden = !detail;
    $<HTMLElement>('#signin-alert-link').hidden = !portalLink;
    alert.hidden = !text;
  };
  requestAnimationFrame(() => user.focus());

  // Show / hide password.
  const reveal = $<HTMLElement>('#btn-reveal');
  reveal.addEventListener('click', () => {
    const hidden = pass.type === 'password';
    pass.type = hidden ? 'text' : 'password';
    reveal.setAttribute('icon', hidden ? 'eye-off' : 'eye');
    reveal.setAttribute('label', hidden ? 'Hide password' : 'Show password');
    reveal.setAttribute('aria-pressed', String(hidden));
  });

  // The error describes the last attempt; drop it as soon as the user edits.
  for (const el of [user, pass]) el.addEventListener('ev-input-input', () => { if (!alert.hidden) showAlert(''); });

  // Caps Lock warning while typing the password.
  pass.addEventListener('keydown', (e) => {
    const k = e as KeyboardEvent;
    if (typeof k.getModifierState !== 'function') return;
    $<HTMLElement>('#caps').hidden = !k.getModifierState('CapsLock');
  });

  const themeButtons = [...root.querySelectorAll<HTMLButtonElement>('#signin-theme button')];
  const markTheme = (choice: ThemeChoice): void => {
    for (const b of themeButtons) b.setAttribute('aria-checked', String(b.dataset.value === choice));
  };
  markTheme(themeChoice());
  for (const b of themeButtons) {
    b.addEventListener('click', () => { const c = b.dataset.value as ThemeChoice; setThemeChoice(c); markTheme(c); });
  }
  root.querySelector('#btn-retry')?.addEventListener('click', () => location.reload());
  // The server's own name when the OSCA API answers (it may not before sign-in); else the address.
  if (id.reachable) {
    void serverName().then((s) => {
      if (!s.fromServer) return;
      const hostEl = root.querySelector<HTMLElement>('#server-host');
      const chip = root.querySelector<HTMLElement>('#server-chip');
      if (hostEl) hostEl.textContent = s.name;
      if (chip) chip.title = `${s.title}: reachable`;
    });
  }

  return new Promise<void>((resolve) => {
    let busy = false;
    const submit = async (): Promise<void> => {
      if (busy) return;
      // Chrome withholds an autofilled password until a user gesture, and may
      // release it just after the click that submits: give it a frame to land.
      if (!pass.value && pass.shadowRoot?.querySelector('input')?.matches(':autofill')) {
        await new Promise((r) => setTimeout(r, 50));
      }
      showAlert('');
      userField.error = user.value.trim() ? '' : 'Enter your IRIS username.';
      passField.error = pass.value ? '' : 'Enter your password.';
      if (userField.error) { user.focus(); return; }
      if (passField.error) { pass.focus(); return; }
      busy = true;

      btn.loading = true;
      btn.textContent = 'Signing in…';
      try {
        await login(user.value.trim(), pass.value);
        resolve();
      } catch (err) {
        let message = err instanceof SignInError ? err.message : 'Sign-in failed. Try again.';
        let detail = '';
        let portalLink = false;
        // IRIS answers an expired password exactly like a wrong one (a bare 401 from the login
        // endpoint), and an expired user can't call the password API either. The common case is a
        // fresh instance whose predefined accounts still have the default password "SYS", which
        // IRIS marks as expired: say so, and point to the Management Portal to change it.
        if (err instanceof SignInError && err.status === 401) {
          portalLink = true;
          if (pass.value === 'SYS') {
            message = 'The password for this user has expired. Change it in the Management Portal, then sign in here.';
          } else {
            detail = 'If the password has expired, change it in the Management Portal, then sign in here.';
          }
        }
        // An instance that answers the Admin API without credentials usually has
        // password authentication switched off, so a 401 may not mean a typo.
        if (open && err instanceof SignInError && err.status === 401) {
          detail = 'If your details are right, this server may not accept passwords. Turn on password sign-in for its SysAdmin API web application in the Management Portal.';
        }
        showAlert(message, detail, portalLink);
        pass.value = '';
        pass.focus();
      } finally {
        busy = false;
        btn.loading = false;
        btn.textContent = 'Sign in';
      }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
    btn.addEventListener('ev-button-click', () => void submit());
    // Enter inside a shadow-DOM input doesn't always submit the light-DOM form.
    form.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && !(e.target as HTMLElement).closest('button')) { e.preventDefault(); void submit(); }
    });
  });
}
