# Open Exchange listing

## Name

OSCA Portal

## One-line description

A desktop-grade management portal for InterSystems IRIS 2026.2, built on the new SysAdmin and monitoring REST APIs.

## Full description

OSCA Portal is a web management portal for InterSystems IRIS and IRIS for Health 2026.2. It is built entirely on the new SysAdmin REST API (`%Api.Admin`) and the monitoring API (`%Api.Monitor`), using the Evolution UI component library it shares with the OSCA web IDE.

It is designed around how administrators actually work: one menu ordered by how often you use each area, a health readout on every page, a Ctrl K command palette, and live screens that say when they last refreshed.

Complete today:

- Home: instance health, headline figures, what needs attention, upcoming tasks, the busiest processes and storage.
- Operations › Activity: CPU, memory, page file and shared memory; eight throughput rates; storage by database; sessions and engine health.
- Operations › Processes: every process, filterable and sortable, with CPU now, and a detail panel.
- Logs › Alerts & errors: system alerts, handled correctly for the API's read-once behaviour.

Being built during the voting period: Security (users, roles, resources, SQL privileges, secrets wallet, certificates, OAuth 2.0), Web & APIs, Tasks, Databases and Settings.

Along the way the project documents how the new APIs behave in practice: the read-once alerts feed, per-second sensors that break with more than one reader, the measurable cost of a metrics scrape, and the difference between System CPU and IRIS CPU. See the README.

Install with Docker (`docker compose up -d --build`) or IPM (`zpm "install osca-portal"`). Requires IRIS 2026.2 or later.

## Tags

- Management Portal
- System Administration
- Monitoring
- REST API
- Web Components
- TypeScript
- Docker
- IPM

## IRIS version

InterSystems IRIS 2026.2+, InterSystems IRIS for Health 2026.2+ (Community Edition supported).

## Links

- Repository: _GitHub URL to be added_
- Demo video: _YouTube URL to be added_
- Developer Community article: _to be added_
- Author profile: _Developer Community profile link to be added_

## Licence

AGPL-3.0
