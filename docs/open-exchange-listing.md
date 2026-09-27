# Open Exchange listing

## Name

OSCA Admin

## One-line description

A complete, desktop-grade IRIS management portal on the 2026.2 SysAdmin API, with triage-first Home, security you can read, and an 18-gap report back to InterSystems.

## Full description

**OSCA Admin is a complete replacement for the IRIS Management Portal, built only on the new 2026.2 SysAdmin and Monitoring REST APIs.** It opens on one question, *is this instance OK, and does anything need me?*, and answers it with a triage list where every item has an action. Behind that are 39 screens covering operations, tasks, logs, web apps and REST APIs, security, secrets and databases, with real create, edit and delete, a review of every change before it's saved, and plain-language answers to "who can actually do this?".

Building it pushed the new API harder than anything else we know of. We documented **20 gaps** for InterSystems, and filled six of them with a small read-only extension API that respects the caller's privileges: server file pickers, server identity, login history, the task catalogue, class shapes and the console log (messages.log).

### Install

```
git clone https://github.com/SeanConnelly/osca-admin.git
cd osca-admin
docker compose up -d --build
```

Ready in about 2 minutes. Open **http://localhost:52780/portal/index.html** and sign in as `_SYSTEM` / `SYS`. The container uses ports 52780 and 51780, so it doesn't clash with an IRIS you already run.

Or with IPM on IRIS or IRIS for Health 2026.2 or later: `zpm "install osca-portal"`, then open `http://<host>:<web port>/portal/index.html`.

### What it does

- **Triage-first Home.** Health, five headline figures, *Needs attention* with a one-click action per item, and what's coming up next.
- **Live operations.** Activity (CPU, memory and throughput computed correctly for multiple readers), Processes with a variable tree, Locks grouped, Journals, Web sessions, Background jobs.
- **Security you can read.** Users, Roles, Resources, SQL privileges, Services, Certificates & TLS, OAuth 2.0, Encryption, Secrets wallet and Filesystem access, all on one model: ways in → users → roles → resources → data. The portal answers "who can actually do this?".
- **Safe changes.** Every form previews what will change. Risky changes that could lock you out or open access to anyone explain the impact and ask you to type the name to confirm.
- **Tasks.** A 7-day schedule, history, run now, suspend or resume, and a New Task wizard that lists every task type IRIS offers.
- **Web apps & REST APIs.** Web applications with full create and edit, and an API explorer for every REST application on the instance.
- **Databases.** Namespaces, databases and capacity, with a server file picker for paths.
- **Everywhere.** A health status bar on every page, Ctrl K to jump to any screen or object, light and dark themes, and help behind every page's info button.
- **Built to be honest about the API.** It handles the read-once alerts feed, computes rates itself because the per-second sensors break with a second reader, and shows its own monitoring cost.

### What the installer changes

It adds JWT and password sign-in to `/api/admin`, `/api/monitor` and `/api/mgmnt` (it never removes a method you allow, and prints the before and after values), creates the read-only `/api/osca` extension API, and creates the `/portal` web application. The README explains how to undo each one.

### The API gap report

`docs/api-gaps.md` lists 20 things the new APIs couldn't do, each with our workaround and a suggested addition. The two that matter most: there is no way to browse the server's file system for file pickers, and no way to learn the server's host name. OSCA Admin fills both with `/api/osca`, following the same privilege and Filesystem access rules as the Management Portal's own picker.

### Tested on

IRIS for Health 2026.2 (build 221) on Windows, and the Docker image (IRIS for Health Community 2026.2 on Linux) with password sign-in, token refresh and privilege checks. An IPM install on plain IRIS Community (not for Health) is not yet verified.

### Optional: Showcase data and self-test

An optional, guarded Showcase module is being finalised: labelled demo data for the Docker container only, and a "Check this install" self-test that reports whether each API accepts your sign-in.

### Building from source

The built app (`dist-web/`) is prebuilt and committed, so installing needs no Node.js. Rebuilding needs the Evolution UI component library, which isn't public yet.

## Tags

- Management Portal
- System Administration
- Monitoring
- Security
- REST API
- TypeScript
- Docker
- IPM

## IRIS version

InterSystems IRIS 2026.2+, InterSystems IRIS for Health 2026.2+ (Community Edition supported).

## Links

- Repository: https://github.com/SeanConnelly/osca-admin
- Demo video: TODO(owner)-video-url
- Developer Community article: TODO(owner)-article-url (or remove this line)
- Author profile: TODO(owner)-author-profile-url

## Licence

AGPL-3.0

## TODO(owner) before publishing

1. **Repository URL**: the Install `git clone` line and Links.
2. **Demo video URL**: Links.
3. **Developer Community article URL**: Links, or remove the line.
4. **Author profile URL**: Links.
5. **Tested on**: update once a clean Docker, IPM and Normal-security install have been checked.
6. **Showcase paragraph**: update once the module is finished, or remove it.
7. **"Ready in about 2 minutes"**: confirm on a clean Docker build.
