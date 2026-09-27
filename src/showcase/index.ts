// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sample data, Showcase and Self-test (see README.md in this folder).
 *
 * The app's only links to this folder:
 *  - `import './showcase'` in src/main.ts;
 *  - the response hook registerResponseOverlay() in src/auth.ts (GETs and two read-only POSTs),
 *    which does nothing while no overlay is registered.
 * Delete this folder and that import line to remove all of it.
 */
import './showcase.css';
import { registerResponseOverlay } from '../auth';
import { MODULES } from '../modules';
import { sampleOn } from './flag';
import { sampleOverlay } from './overlay';
import { guardPicker } from './picker-guard';
import { showcaseScreen } from './showcase-screen';
import { selfTestScreen } from './selftest-screen';
import { mountShell } from './shell';

/** Adds Settings > Showcase and Settings > Self-test (the menu is built after this runs). */
function registerScreens(): void {
  const settings = MODULES.find((m) => m.key === 'settings');
  if (!settings || settings.nav.some((i) => i.key === 'selftest')) return;
  settings.nav.push(
    { key: 'showcase', label: 'Showcase', group: 'Try it out', screen: showcaseScreen },
    { key: 'selftest', label: 'Self-test', screen: selfTestScreen },
  );
}

if (sampleOn()) {
  registerResponseOverlay(sampleOverlay);
  guardPicker();
}
registerScreens();
void mountShell();
