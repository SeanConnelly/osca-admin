// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev server only: skip the sign-in screen (for instances without password authentication). */
  readonly VITE_SKIP_SIGNIN?: string;
}
