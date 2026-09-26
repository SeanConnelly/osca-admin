/**
 * Sign-in screen, shown before the portal shell whenever there is no session.
 * Resolves once the user has signed in (or chosen to continue anonymously on
 * an instance that allows it).
 */
import '@evolution-ui/core/components/ev-form-field/ev-form-field.js';
import '@evolution-ui/core/components/ev-input/ev-input.js';
import '@evolution-ui/core/components/ev-button/ev-button.js';
import { login, allowsAnonymous, auth, SignInError } from './auth';
import { esc } from './ui';

type InputEl = HTMLElement & { value: string; state: string; focus(): void };

export async function signIn(root: HTMLElement): Promise<void> {
  if (auth.signedIn) return;
  const open = await allowsAnonymous();

  root.innerHTML = `
    <div class="signin">
      <form class="signin-card" novalidate>
        <div class="signin-brand"><span class="mark">OS</span>OSCA Portal</div>
        <h1>Sign in</h1>
        <p class="signin-sub">to the InterSystems IRIS instance at <b>${esc(location.host)}</b></p>
        <ev-form-field label="Username" id="f-user">
          <ev-input id="in-user" name="user" autocomplete="username" full-width></ev-input>
        </ev-form-field>
        <ev-form-field label="Password" id="f-pass">
          <ev-input id="in-pass" name="password" type="password" autocomplete="current-password" full-width></ev-input>
        </ev-form-field>
        <details class="signin-more">
          <summary>More options</summary>
          <ev-form-field label="Escalation role" hint="Optional. Sign in with a role that grants elevated privileges, if your account has one.">
            <ev-input id="in-role" name="role" full-width></ev-input>
          </ev-form-field>
        </details>
        <ev-button id="btn-signin" type="submit" variant="brand" full>Sign in</ev-button>
        ${open ? `<div class="signin-alt">
          <button type="button" class="link" id="btn-anon">Continue without signing in</button>
          <span>This instance lets the Admin API answer without a sign-in.</span>
        </div>` : ''}
      </form>
    </div>`;

  const form = root.querySelector('form') as HTMLFormElement;
  const user = root.querySelector('#in-user') as InputEl;
  const pass = root.querySelector('#in-pass') as InputEl;
  const role = root.querySelector('#in-role') as InputEl;
  const btn = root.querySelector('#btn-signin') as HTMLElement & { loading: boolean };
  const passField = root.querySelector('#f-pass') as HTMLElement & { error: string };
  const userField = root.querySelector('#f-user') as HTMLElement & { error: string };
  requestAnimationFrame(() => user.focus());

  return new Promise<void>((resolve) => {
    const submit = async (): Promise<void> => {
      userField.error = user.value.trim() ? '' : 'Enter your IRIS username.';
      passField.error = pass.value ? '' : 'Enter your password.';
      if (userField.error || passField.error) return;
      btn.loading = true;
      try {
        await login(user.value.trim(), pass.value, role.value.trim());
        resolve();
      } catch (err) {
        passField.error = err instanceof SignInError ? err.message : 'Sign-in failed. Try again.';
        pass.state = 'error';
        pass.value = '';
        pass.focus();
      } finally {
        btn.loading = false;
      }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
    btn.addEventListener('ev-button-click', () => void submit());
    // Enter inside a shadow-DOM input doesn't always submit the light-DOM form.
    form.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void submit(); } });
    root.querySelector('#btn-anon')?.addEventListener('click', () => { auth.continueAnonymously(); resolve(); });
  });
}
