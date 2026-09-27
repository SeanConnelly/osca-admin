# SysAdmin API gaps: feedback to InterSystems

OSCA Admin is a management portal built only on the SysAdmin REST API (`/api/admin/v2`, `%Api.Admin`) and `/api/monitor` (`%Api.Monitor`), on IRIS 2026.2 (verified on build 221). This document lists what those APIs couldn't do for us. Where we could fill a gap without writing to the system, we added a small read-only API, `/api/osca` (`OscaPortal.API.Dispatch`, installed by the module). It runs with the caller's own privileges and grants no roles.

Each gap lists what the portal needed, what the API lacks, our workaround, and a suggested addition.

## Summary

| # | Gap | Workaround |
|---|-----|------------|
| 1 | Object introspection for process variables | `GET /api/osca/v1/class` |
| 2 | Creating a resource with no public access | None; public access must be set on create |
| 3 | User login history | `GET /api/osca/v1/users/{name}/logins` |
| 4 | Task class catalogue and settings | `GET /api/osca/v1/tasks/classes` |
| 5 | Journal purge | None; link to the Management Portal |
| 6 | Terminating a process with RESJOB semantics | Plain terminate only |
| 7 | SQL info for a process | Inferred from the routine name |
| 8 | Converting a database to encrypted | Instructions for `^EncryptionKey` |
| 9 | Enabling interoperability has hidden side effects | Tell the user what IRIS adds |
| 10 | Saving an OAuth client enables `/csp/sys/oauth2` | Snapshot and restore web-app state |
| 11 | `/api/monitor/alerts` is read-once | Keep alerts in the browser |
| 12 | Per-second sensors break with a second reader | Compute rates from cumulative counters |
| 13 | A metrics scrape costs about 55K global references | Scrape sparingly and show the cost |
| 14 | Database info reads create background jobs; async results pile up | Throttle and cache in the browser |
| 15 | Web-app `PUT` is create-or-modify | Check existence first |
| 16 | **No server file-system browsing (file pickers)** | `GET /api/osca/v1/fs/roots`, `/fs/list`, `/fs/stat` |
| 17 | **No server host name or node identity** | `GET /api/osca/v1/server` |
| 18 | Expired passwords can't be told apart or changed through the API | Guess from the default password and link to the Management Portal |
| 19 | No console log (messages.log) read | `GET /api/osca/v1/log/messages` |
| 20 | Reading the journal writes to the journal | Say so in the help |

Gaps 16 and 17 affect almost every screen: 16 affects any form that takes a server path, and 17 affects the header on every page. A complete management portal can't be built on the API without them.

## 1. Object introspection for process variables

- **Needed:** When a user expands a process's variables, show what an object variable is.
- **API lacks:** The process variables read returns an object as a string such as `1@%CSP.Request`. An object in another process can't be read, so its property values will never be available. The API also has no way to describe the class itself.
- **Workaround:** `GET /api/osca/v1/class?name=&namespace=` returns the class's shape from `%Dictionary.CompiledClass`: its properties (inherited ones included), their types, collection and relationship kind, and flags. It never returns values.
- **Suggested addition:** `GET /v2/class?name=&namespace=`, returning the compiled class's members, read-only and subject to the caller's access to that namespace.

## 2. Creating a resource with no public access

- **Needed:** Create a resource that only the roles granted to it can use. This is the secure default.
- **API lacks:** On create, `PublicPermission` is required, and every spelling of "none" is refused, including an empty string. On update, omitting it leaves public access unchanged, so there is no way to clear it afterwards either.
- **Workaround:** None through the API. The portal explains the limitation.
- **Suggested addition:** Accept `""` (or `"none"`) for `PublicPermission` on create and update, and default to no public access when it is omitted on create.

## 3. User login history

- **Needed:** On a user's page, show when and from where they last signed in, and any recent failed attempts.
- **API lacks:** There is no per-user login history. The audit search (`POST /security/audit/records`) is asynchronous and generic, and it doesn't say whether login events are being recorded at all.
- **Workaround:** `GET /api/osca/v1/users/{name}/logins?limit=50&days=90` reads `%SYS.Audit` for `%System/%Login/Login` and `LoginFailure`. It returns, newest first:
  - the time, IP address, client, authentication method, service, application, and a failure reason;
  - `auditing`, `loginEventsEnabled` and `loginFailureEventsEnabled`, so the UI can explain an empty history.
- **Suggested addition:** `GET /v2/security/user/logins?name=&limit=` with the same fields. Also add the user's last login time and last failed login to `GET /security/user`.

## 4. Task class catalogue and settings

- **Needed:** A New Task wizard that lists the task types the Management Portal offers, then shows each type's options as a form.
- **API lacks:** No endpoint lists the subclasses of `%SYS.Task.Definition`, their `TaskName`, or their settings. Settings are the public properties whose names don't start with `%`.
- **Workaround:** `GET /api/osca/v1/tasks/classes?namespace=<ns|all>` returns every non-abstract subclass with:
  - its `TaskName` and description;
  - its `RESOURCE` requirement, and whether the caller holds it;
  - its settings: type, required, default (a literal, or the ObjectScript expression that computes it), description, and `VALUELIST`/`DISPLAYLIST`/`MAXLEN`/`MINVAL`/`MAXVAL`.
- **Suggested addition:** `GET /v2/task/classes?namespace=` with the same shape.

## 5. Journal purge

- **Needed:** "Purge journal files now", as the Management Portal and `PURGE^JOURNAL` offer.
- **API lacks:** No purge action. The purge rules can be read and changed, but not run.
- **Workaround:** The portal shows the purge rules and warns when files are never purged. Purging now is left to the Management Portal.
- **Suggested addition:** `POST /v2/journal/purge`, applying the configured rules, asynchronous like the other long-running actions.

## 6. Terminating a process with RESJOB semantics

- **Needed:** The terminate behaviour administrators know from `^RESJOB` and the Management Portal.
- **API lacks:** The terminate action takes no options. The caller can't choose how the target is stopped (for example, whether its error trap runs), and gets no result beyond success or failure.
- **Workaround:** The portal offers plain terminate. It warns when the process is in a transaction and states the impact for system processes.
- **Suggested addition:** Options on the terminate action that mirror `$SYSTEM.Process.Terminate`/`^RESJOB`, and a result saying whether the process has exited.

## 7. SQL info for a process

- **Needed:** For a process running a query, show the statement, as the Management Portal's process details do.
- **API lacks:** The process reads have no SQL fields.
- **Workaround:** The portal infers "running SQL" from a current routine of `%SYS.sqlcq.*`, but can't show the statement.
- **Suggested addition:** Add the current statement's text (or hash) and start time to the single-process read, subject to the caller's privileges.

## 8. Converting a database to encrypted

- **Needed:** Encrypt an existing database, or decrypt one.
- **API lacks:** The API can create an encrypted database, but has no conversion. Conversion needs the `^EncryptionKey` utility.
- **Workaround:** The portal explains the two routes: create an encrypted database and copy the data, or run `^EncryptionKey`.
- **Suggested addition:** An asynchronous `POST /v2/database-dir/encrypt` (and `/decrypt`), taking the key ID.

## 9. Enabling interoperability on a namespace

- **Needed:** Switch productions on for a namespace, and switch the namespace off cleanly later.
- **API lacks:** Enabling interoperability silently creates:
  - the ENSTEMP and SECONDARY databases;
  - a `%DB_…SECONDARY` resource;
  - a `%EnsRole_ProdPrivs_<NS>` role;
  - a `/csp/<ns>` web app.

  The response doesn't report any of these, and deleting the namespace leaves them all behind.
- **Workaround:** The portal tells the user which databases IRIS adds. The leftovers have to be cleaned up by hand.
- **Suggested addition:** Return the list of objects created. On namespace delete, offer an option to remove them.

## 10. Saving an OAuth client enables `/csp/sys/oauth2`

- **Needed:** Save an OAuth 2.0 client configuration without side effects.
- **API lacks:** Saving a client configuration enables the existing `/csp/sys/oauth2` web app. Deleting the client doesn't disable it again, and the response doesn't mention the change.
- **Workaround:** Snapshot web-app state before OAuth changes, and restore it afterwards.
- **Suggested addition:** Don't change other configuration implicitly. If the app must be enabled, report it in the response or require an explicit flag.

## 11. `/api/monitor/alerts` is read-once

- **Needed:** Several viewers (tabs, users, a monitoring system) each seeing the same alerts.
- **API lacks:** Each alert is delivered to one reader only, so whoever reads it first takes it.
- **Workaround:** The portal keeps what it receives in browser storage and takes totals from the `iris_system_alerts` metric.
- **Suggested addition:** A non-destructive read: `GET /alerts?since=<time>`, with a cursor.

## 12. Per-second sensors are corrupted by a second reader

- **Needed:** Throughput figures that stay correct when Prometheus and the portal both scrape.
- **API lacks:** The `*_per_sec` metrics are computed between consecutive scrapes by any reader, so a second reader halves or skews them.
- **Workaround:** The portal computes rates from the cumulative counters in `GET /v2/monitor/system-usage`, over its own window.
- **Suggested addition:** Compute per-second rates on a fixed server-side interval, or publish only counters and let readers derive rates.

## 13. Metrics scrape cost

- **Needed:** Frequent live monitoring without loading the instance.
- **API lacks:** One `/api/monitor/metrics` scrape costs about 55K global references. On an idle instance, the portal's monitoring is most of the reported load. No lighter subset is available.
- **Workaround:** Scrape sparingly. The Activity screen measures the cost and shows it.
- **Suggested addition:** A filter (`?metrics=name,name`) or grouped endpoints, so a dashboard can ask for only what it shows.

## 14. Database info reads create background jobs; async results pile up

- **Needed:** Free space and size for every database on one screen.
- **API lacks:**
  - `POST /database-dir/info` starts a background job per database, and each answer comes back through `/async-result`.
  - The server keeps up to 1000 async results, and a client can't discard one after reading it.
  - A page listing many databases starts many jobs at once.
- **Workaround:** The portal runs at most two info jobs at a time, and caches results for 10 minutes.
- **Suggested addition:** A synchronous, cheap read of the stored figures (size, max size, free space where known). Also a `DELETE /async-result?id=`, or discard-on-read.

## 15. Web-app `PUT` is create-or-modify

- **Needed:** "Create web app" that can't overwrite an existing one by mistake.
- **API lacks:** `PUT /web-app?name=` creates the app if it's missing and changes it if it exists. No create-only mode is available.
- **Workaround:** `GET` the name before any `PUT`. The portal only `PUT`s to apps it has just read, and the installer uses `Security.Applications.Exists`. The check is racy, but it is the only guard.
- **Suggested addition:** `POST /web-app` for create-only (returning `409` if the app exists), or honour `If-None-Match: *` on `PUT`.

## 16. No server file-system browsing (file pickers)

This is a strong gap.

- **Needed:** A file picker for the many admin forms that take a path on the server:
  - TLS certificate, key and CA files;
  - database and journal directories;
  - backup and export targets;
  - the files and folders of Filesystem access rules.

  The Management Portal has had this for years (`%ZEN.Dialog.fileSelect`).
- **API lacks:** Any way to see the server's file system. There are no drives, no folder listing, and no "does this path exist". A client can only take a typed path and let the save fail. The API manages Filesystem access limits (`/fs-access-purpose`) but offers nothing those limits could apply to.
- **Workaround:** `/api/osca` adds three read-only endpoints. None of them ever returns file contents.
  - `GET /v1/fs/roots`: drives (Windows) or `/`, with their size, plus the installation, mgr and home folders.
  - `GET /v1/fs/list?dir=&filter=*.cer;*.pem&dirsOnly=&hidden=&limit=`: folders first, then files, with size, modified time and hidden flag.
  - `GET /v1/fs/stat?path=`: exists, type, size, modified, readable.

  These endpoints follow the same rules as IRIS's own picker:
  - **Rights:** the caller needs `%Admin_Manage`, `%Admin_Secure` or `%Development` (USE), otherwise `403`. These are the resources `%ZEN.Dialog.fileSelect` checks.
  - **Filesystem access limits:** they obey the `%GUIFileSelector` purpose (`%SYS.FileSystemAccess`), read the way `%CSP.Portal.Utils:GetAllowedDirectories` reads it for the Management Portal picker. With the limit on, only the allowed folders and their contents can be browsed. If the allowed list can't be read, nothing can be browsed.
  - **Paths:** they are normalised (`..` resolved, `/` and `\` accepted) before the check, and compared case-insensitively on Windows.
  - **Links:** with the limit on, links are left out of listings, and any path through a link is refused (`403`). This covers symbolic links and junctions (Windows reparse points), so a link can't lead outside the allowed folders.
  - **Network paths:** UNC paths (`\\server\share`) are refused, because browsing one would make the server connect and authenticate to another machine.
  - **Hidden files:** hidden and system files, and Unix dot files, are left out unless `hidden=1`.
  - **Unreadable folders:** a folder the IRIS server account can't read returns `403` with a clear message.
- **Suggested addition:** `GET /v2/fs/roots`, `/v2/fs/list` and `/v2/fs/stat` with these semantics: the same privileges as the Management Portal picker, `%GUIFileSelector` enforced on the server, and never file contents.

## 17. No server host name or node identity

This is a strong gap.

- **Needed:** Show which server the user is managing, in the header of every page. A browser only knows the name it used to reach the server, which is often `localhost`, a load balancer or a tunnel. Operators with several instances need the real identity to avoid acting on the wrong one.
- **API lacks:** `GET /api/admin/info` returns the IRIS version and namespaces. It doesn't return the host name, fully qualified name, IP addresses, instance name, OS, CPU count or memory. The monitor metrics carry an instance label but no host identity.
- **Workaround:** `GET /api/osca/v1/server` returns:
  - `hostName` (`$SYSTEM.INetInfo.LocalHostName()`);
  - `fqdn` (`%SYS.System:GetNodeName`);
  - `ipAddresses` (configured interfaces, loopback excluded);
  - `instanceName` (`%SYS.System:GetInstanceName`);
  - `os`, `platform` and `osVersion`;
  - `cpuCount`, and `memoryMB` (Windows only; IRIS has no portable call for it).

  On Windows, IRIS reports the OS version as `6.2.9200`, which Windows returns to programs that lack a compatibility manifest. The endpoint returns `""` rather than that value.
- **Suggested addition:** Add the same fields to `GET /api/admin/info`. Report the true OS version and physical memory on all platforms.

## 18. Expired passwords can't be told apart or changed through the API

- **Needed:** When a user signs in with an expired password, tell them so and let them change it, as the Management Portal's sign-in page does.
- **API lacks:**
  - `POST /api/admin/login` returns a bare `401` for an expired password, the same response as a wrong password. The reason is only written to the log.
  - `POST /security/user/password` needs a signed-in session, which a user with an expired password can't get.

  On a fresh instance the predefined accounts, such as `_SYSTEM` with the default password `SYS`, are expired, so a new user's first sign-in fails with "incorrect password".
- **Workaround:** If the password entered is the default `SYS`, the portal says the password has probably expired and links to the Management Portal to change it. Otherwise it mentions expiry as a possible cause.
- **Suggested addition:** Return a distinct error for an expired password (for example `401` with an error code such as `PasswordExpired`). Allow a change-password call that authenticates with the old password, as the Management Portal's change-password page does.

## 19. No console log (messages.log) read

- **Needed:** A Logs page that shows what IRIS wrote to its console log (`messages.log` in the mgr directory): startup and shutdown, journal switches, database mounts, system monitor warnings, errors and their stacks. It is the first place an administrator looks when something goes wrong, and the Management Portal shows it (System Operation › System Logs › Messages Log).
- **API lacks:** Any way to read it. `/api/monitor/alerts` returns only alerts (severe lines), once each (gap 11), without the information and warning lines around them or the stack lines that follow an error. Neither API can page through the log or search it.
- **Workaround:** `GET /api/osca/v1/log/messages?limit=&before=&minLevel=&q=&since=` reads the file backwards from the end, so a large log costs only the part that is shown:
  - **File:** the `ConsoleFile` the configuration names, else `messages.log`, in the mgr directory. The caller can't give a path, and the reply names the file but not its folder.
  - **Entries:** each line such as `09/27/26-13:16:11:060 (6168) 0 [Utility.Event] text` becomes `{ offset, time, pid, level, source, text }`, newest first. `level` is 0 (information), 1 (warning), 2 (severe) or 3 (fatal). Lines that don't start an entry (stacks, startup banners) are kept in the text of the entry above them. `time` is server-local ISO with the server's current UTC offset.
  - **Paging:** `limit` (1–1000, default 200) entries per reply. `next` is a byte offset to pass as `before` for older entries, or null at the start of the file.
  - **Filters (on the server):** `minLevel`, `q` (case-insensitive, in the source or text), and `since` (server-local ISO time; older entries end the read).
  - **Cost:** at most 4 MB is read per request; the reply says `truncated: true` when it stopped there, and `next` carries on.
  - **Rights:** `%Admin_Operate` or `%Admin_Manage` (USE), otherwise `403`.
- **Suggested addition:** `GET /v2/log/messages` with these semantics, and the same for `alerts.log` and `SystemMonitor.log`, so a client can show the lines around an alert and doesn't depend on the read-once alert feed.

## 20. Reading the journal writes to the journal

- **Needed:** Browse a journal file's records without adding to it.
- **API lacks:** `POST /journal/file/records` runs as a background job whose bookkeeping (`^Api.Admin.Util.AsyncTaskD`) is journaled: about 7 SETs per page read. On a quiet instance most of the newest records are the browser's own traffic.
- **Workaround:** The help on the Journals screen says so.
- **Suggested addition:** Keep async-task bookkeeping in a non-journaled global (IRISTEMP), or offer a synchronous read for small pages.
