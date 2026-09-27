<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# Showcase and Self-test (optional)

Everything here is optional and self-contained. It adds three things to OSCA Admin:

1. **Sample data (beta)**: a display-only overlay that never writes to IRIS.
2. **Settings > Showcase**: the page for the optional `osca-portal-showcase` IRIS module (`iris-showcase/`), which can create sample objects on a *fresh* install only.
3. **Settings > Self-test**: create / read / update / delete checks on `osca_test_st_` objects, plus a pass that opens every page. The same checks run from the command line with `npm run selftest -- http://host:port`.

## How it connects to the app

There are only two links:

| Where | What |
|---|---|
| `src/main.ts` | one line: `import './showcase';` |
| `src/auth.ts` | `registerResponseOverlay()`, a hook in `authFetch`. It sees GET requests, plus two read-only POSTs (IRIS's on-demand database figures, and a journal file's integrity check), for which it may change only the query string. With nothing registered, every response is returned unchanged. |

The Showcase and Self-test pages are added to the Settings menu at start-up (`registerScreens()` in `index.ts`); `modules.ts` is not edited. The account-menu switch and the status-bar chip are added to the shell after it renders (`shell.ts`).

## Removing it

- **Everything in the browser:** delete this folder and the `import './showcase';` line in `src/main.ts`. The hook in `src/auth.ts` can stay (it does nothing), or remove `ResponseOverlay`, `registerResponseOverlay` and the two-line `overlay` branch at the top of `authFetch`.
- **The command-line self-test:** delete `scripts/selftest.mjs` and the `selftest` script in `package.json`.
- **The IRIS module:** remove the sample objects from Settings > Showcase first, then uninstall `osca-portal-showcase` (IPM) or delete the `OscaShowcase` package and the `/api/osca-showcase` web application. Then delete `iris-showcase/` and `module-showcase.xml`. The main `module.xml` never references them.
- **A browser's remembered choice:** the flag is `localStorage['osca-portal:showcase:display']`.

## Layer 1: sample data (display only)

- Flag: `localStorage['osca-portal:showcase:display']` = `on` or `off`. Unset means never asked.
- On a server with a single drive, the first visit asks once: *Show sample data* or *Not now*. The answer is recorded.
- When the flag is on, a **Sample data** chip appears in the status bar (its popover has *Turn off*), and the account menu has a **Sample data (beta)** switch. Toggling reloads the page.
- The sample layout, as a real server is often laid out (letters the server really has are skipped; Unix gets `/irisdb/`, `/iristemp/`, `/irisjrn/`, `/backup/`):
  - **C:** the OS and IRIS install, with IRISSYS, IRISLIB, ENSLIB, IRISAUDIT, IRISSECURITY and the other library databases. These are real and untouched.
  - **D:** application data: USER, IRISLOCALDATA and any other database.
  - **T:** a fast temp drive: IRISTEMP.
  - **E:** journals.
  - **F:** backups.

  Every sample drive has a size and free space. Real database names and sizes are kept.
- Where it shows:
  - **Server file picker:** the four sample drives, each with a muted Sample tag. The picker shows a calm "D:\ is a sample drive" state with a Go to C:\ button (the first real drive), without asking IRIS, and Select stays disabled; `picker-guard.ts` also disables Select for a typed sample path.
  - **Paths are rewritten only where no form submits them:** Databases > Capacity and Operations > Journals. Journals' actions send no path, and its integrity check goes to IRIS with the real path. Capacity's "free inside" reads also go with the real path, and IRIS's own answer is shown.
  - **The metrics feed's disk figures follow the layout on every screen** (Home's Disk tile, issues, Journals, Capacity). A "percent full" line is added for the journal drive, because IRIS reports one only for database directories.
  - **The Databases screen stays real.** Its full view shows the directory (Where it lives) that its actions and forms send back, so its paths and Disk free stay real. Its disk use is read by the real drive letter, and the install drive's metrics are never rewritten, so the shared metrics feed doesn't change it.
- The drive list carries each sample drive's role (`role`: System · IRIS, Application data, Temp (fast disk), Journals, Backups) and `sample: true`. Capacity's tiles and Drive column, Home's Disk tile tooltip and Journals' Directory cell show the role. A real server has no roles, so only the letter shows.
- Changed rows carry `__sample: true` (`isSample()` in `overlay.ts`), so a screen could mark them.
- Never overlaid: request bodies, and any request other than GET and the two read-only POSTs. A request that names a sample path is sent to IRIS with the real path.
- Capacity takes a drive's size from the OSCA API's drive list when the database figures don't give it (a journal-only drive), and lists drives that hold no IRIS files ("No IRIS files"), so E: and F: show there. This is part of `capacity.ts` and works the same on a real server.

## Layer 3: Self-test

- `selftest-steps.ts` defines the groups and runner, with no imports so Node can load it as is. `selftest-app.ts` binds them to the portal's own api functions. `scripts/selftest.mjs` binds them to the same Admin API calls over HTTP.
- Groups: resource, role, user (disabled), web application (disabled), task (on demand, suspended), superserver on port 61773 (disabled), TLS configuration (client, disabled, no files), secrets wallet collection (empty), work queue category, database with a namespace (no interoperability).
- Each group snapshots its list, checks the name is free, then creates, reads, updates, reads back and deletes. It checks the object is gone and the list matches the snapshot. The whole run also compares the web applications and their on/off state before and after.
- Never tested, because they change existing configuration: OAuth, managed file transfer, services, license, journal settings, ECP and processes.
- Known leftover: deleting the test database leaves its empty folder (`mgr/osca_test_st_db/`), because no API deletes folders.
