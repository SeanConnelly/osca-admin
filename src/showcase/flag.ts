// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The "Sample data (beta)" display flag. It lives in this browser only
 * (localStorage) and never reaches IRIS.
 *   'on'  - show sample drives and the multi-drive Capacity layout
 *   'off' - the user said no (or turned it off)
 *   null  - never asked
 */
export const FLAG_KEY = 'osca-portal:showcase:display';

export type FlagValue = 'on' | 'off' | null;

export function readFlag(): FlagValue {
  try {
    const v = localStorage.getItem(FLAG_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function writeFlag(v: 'on' | 'off'): void {
  try { localStorage.setItem(FLAG_KEY, v); } catch { /* storage blocked: the choice lasts until reload */ }
}

export const sampleOn = (): boolean => readFlag() === 'on';
