<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# osca-portal-showcase (optional IRIS module)

Sample objects for demonstrating OSCA Admin, **on a fresh IRIS install only**. It is a separate IPM module (`module-showcase.xml`, name `osca-portal-showcase`, depends on `osca-portal`). The main `module.xml` doesn't reference it. Its classes live here, never under `iris/`, in their own package `OscaShowcase`, outside `OscaPortal`, so the main module's `OscaPortal.PKG` can never claim or remove them.

Installing it creates the `/api/osca-showcase` REST application (`OscaShowcase.Dispatch`) and nothing else. Sample objects are created only from the portal's Settings > Showcase page, and only when:

1. every fresh-install check passes. The server re-runs them on every create request, whatever the page showed;
2. the user types `CREATE SAMPLE DATA` exactly;
3. the request is a POST with a JSON body, from a user holding `%Admin_Secure:USE`.

If any check fails, nothing is written and the server answers 409.

## Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/v1/check` | Runs every check. Returns `{ eligible, checks: [{ id, label, pass, detail }], plan, created }`. |
| POST | `/v1/apply` | Body `{ "confirm": "CREATE SAMPLE DATA" }`. Creates the objects, or answers 409. |
| POST | `/v1/remove` | Deletes only the recorded objects, checks each is gone, and returns `{ removed, remaining }`. |

## Fresh-install checks (`OscaShowcase.Checks`)

A check that can't be read, because of an error or a missing permission, fails.

| Check | Passes when |
|---|---|
| Namespaces | only `%SYS`, `USER`, `HSCUSTOM`, `HSLIB`, `HSSYS` |
| Users | only built-in users (`Admin`, `CSPSystem`, `IAM`, `SuperUser`, `UnknownUser`, `_Ensemble`, `_PUBLIC`, `_SYSTEM`, `HS_Services`, `irisowner`), plus at most one other created within an hour of `_SYSTEM` (the account the installer asks for) |
| Roles, resources | no names without a leading `%` |
| Web applications | only the standard list below, `/csp/<ns>` and `/csp/healthshare/<ns>` for a default namespace, and OSCA Admin's `/portal`, `/api/osca`, `/api/osca-showcase` |
| Tasks | only the Task Manager's own tasks, by name, each a `%SYS.Task.*` class running in `%SYS` |
| Secrets wallet | no collections (other than `%` ones) |
| Sample objects | no `osca_demo_` users, roles, resources, applications, tasks, namespaces or databases, and nothing recorded from an earlier run |
| Databases | only `IRISSYS`, `IRISSECURITY`, `IRISLIB`, `IRISTEMP`, `IRISLOCALDATA`, `IRISAUDIT`, `IRISMETRICS`, `ENSLIB`, `USER`, `HSCUSTOM`, `HSLIB`, `HSSYS` |
| Mirror | not a mirror member |
| ECP | no ECP data servers configured |

### Where the default lists come from

They were read from IRISHealth262, an IRIS for Health 2026.2 (build 221) instance installed for this project on 2026-09-21 (`$H` day 67834). Anything created at install time has a `CreateDateTime` on that day, within seconds of `_SYSTEM`. On that instance:

- The namespaces are only `%SYS` and `USER`. Earlier IRIS for Health versions also create `HSCUSTOM`, `HSLIB` and `HSSYS`, so those are allowed too, with their databases and `/csp/healthshare/<ns>` applications.
- The users are the eight listed above, all created at install. One more user, `sean`, was created five days later by `UnknownUser`, so this instance correctly fails. `irisowner` (container images) and `HS_Services` (older IRIS for Health versions) are added as built-ins.
- The web applications are `/api/admin`, `/api/atelier`, `/api/deepsee`, `/api/docdb`, `/api/iam`, `/api/iknow`, `/api/interop-editors`, `/api/mgmnt`, `/api/monitor`, `/csp/broker`, `/csp/documatic`, `/csp/sys`, `/csp/sys/exp`, `/csp/sys/mgr`, `/csp/sys/oauth2`, `/csp/sys/op`, `/csp/sys/sec`, `/csp/user`, `/isc/studio/rules`, `/isc/studio/templates`, `/isc/studio/usertemplates` and `/ui/interop`. `/api/osca` is OSCA Admin's own.
- The tasks are the 16 in `Checks.TASKS`, all `%SYS.Task.*` in `%SYS`.
- All roles and resources start with `%`. `%EnsRole_ProdPrivs_USER` is among them because USER is interoperability-enabled at install.
- There are no wallet collections, no mirror and no ECP servers.

A version that ships something new fails the check. That is the safe direction: add the new name to the list after checking it on a fresh install.

## What Create makes (`OscaShowcase.Objects`)

Every name starts with `osca_demo_`, and every description reads "OSCA Admin showcase: safe to delete".

- resource `osca_demo_reports`;
- database `OSCA_DEMO_DATA` in `mgr/osca_demo_data/`, 1 MB, using the default database resource;
- namespace `OSCA_DEMO_APP` on it, without interoperability;
- roles `osca_demo_analyst` (`osca_demo_reports:RU`) and `osca_demo_operator` (`osca_demo_reports:RWU`);
- users `osca_demo_alice`, `osca_demo_bob` and `osca_demo_carol`, **disabled**, each with a random password that is never shown or stored;
- REST application `/api/osca_demo_orders`, **disabled**;
- tasks `osca_demo_nightly_check` and `osca_demo_weekly_check` (Check Logging Activity, a harmless class), **suspended**.

No wallet or OAuth objects are made, because saving an OAuth client switches on `/csp/sys/oauth2`. Each object is recorded in `^OscaShowcase("created",n)` in the REST application's namespace. If creating any object fails, everything made so far is removed again.

Remove deletes exactly the recorded objects, newest first. It never deletes a name without the prefix. It checks each object is gone and forgets only those. The database's file and its `osca_demo_data` folder are deleted too.

## Removing the module

1. In the portal, open Settings > Showcase and choose **Remove sample data**, if any exist.
2. Uninstall `osca-portal-showcase` with IPM. Its unconfigure step deletes `/api/osca-showcase`, but only when that application is this module's. Without IPM, delete the application and the `OscaShowcase` package by hand.
3. Delete `iris-showcase/` and `module-showcase.xml` from the repository.

Status: the checks, the refusal paths (409 with the phrase on a non-fresh instance, 415 for a non-JSON body, 405 for GET) and Remove with nothing recorded were run on IRISHealth262. Create has never been run: that instance isn't fresh, and running it there is not allowed.
