# Demo video script

**Length:** 3 to 4 minutes (target 3:30).
**Story:** three things a judge should remember.
1. Home tells you what to *do*.
2. Security answers "who can actually do this?".
3. The API gap report, the file picker and `/api/osca`: this entry improves the API the contest is about.

**Recording:** 1440×900 or larger, browser zoom 100%, light theme, signed in. Hide bookmarks and other tabs. Record each section separately and cut them together, so a mistake costs one section, not the take.

## Before recording

- Use a real 2026.2 instance, so every number is live. The Docker container from this repo is ideal: it is what judges will see, at `http://localhost:52780/portal/index.html`.
- Leave the portal open on Home for 5 minutes first, so the sparklines are filled.
- Make sure Home has at least two or three *Needs attention* items. A fresh container usually shows "No backup has ever run" and "System Monitor is not running". A task that failed once adds a good third item.
- Check that `/api/osca` is installed (the file picker's **Browse…** button only appears when it is).
- Have `docs/api-gaps.md` open in a second tab, rendered on GitHub.
- Rehearse the Security section once: pick the service or resource whose answer is most interesting on this instance (for example a service where "anyone can connect", or a resource used by several roles plus `%All` holders).

## Shot list

| # | Time | Screen | Action | Point to land |
|---|---|---|---|---|
| 1 | 0:00–0:15 | Home | Still, then a slow pointer sweep across the page | A complete management portal on the new API only |
| 2 | 0:15–0:55 | Home | Point at the health line, the five figures, then *Needs attention*; click one item's action | Triage: every item has one action |
| 3 | 0:55–1:10 | Any page | Press Ctrl K, type a user or database name, press Enter; point at the status bar | It works like a desktop product |
| 4 | 1:10–2:10 | Security › Services, then Resources and Users | Open a service; read the "who can get in" answer; open a resource; follow the path to a user | "Who can actually do this?", answered in plain language |
| 5 | 2:10–2:30 | A user or service form | Change something risky; show the review; show type-to-confirm; cancel | Every change is reviewed before it's saved |
| 6 | 2:30–3:15 | Databases › New database (or Certificates & TLS) → **Browse…** → `docs/api-gaps.md` → API explorer | Open the file picker, browse a folder; cut to the gap report; show `/api/osca` in the API explorer | The API has no file browsing; we documented 20 gaps and filled six |
| 7 | 3:15–3:30 | Home, dark theme | Toggle the theme; hold on Home | Close and install line |

## Narration

### 1. Opening (0:00–0:15)

"This is OSCA Admin: a complete replacement for the IRIS Management Portal, built only on the new 2026.2 SysAdmin and Monitoring REST APIs. Everything you see is live."

### 2. Home as triage (0:15–0:55)

"Home answers one question: is this instance OK, and does anything need me?

Health at the top, five headline figures, and then *Needs attention*. Each item is something real on this instance, and each has exactly one action. No backup has ever run: open tasks. System Monitor isn't running: copy the command that starts it.

Most dashboards show you charts and leave the thinking to you. This one tells you what to do next."

Click one item's action button and let the target screen load. Then return to Home.

### 3. It works like a desktop product (0:55–1:10)

"Everything is a keystroke away. Ctrl K jumps to any screen, or to any object: a user, a database, a task, a process. And the status bar keeps health, alerts and licence use on every page."

Press Ctrl K, type a name, press Enter. Point at the status bar.

### 4. Security: who can actually do this? (1:10–2:10)

"Security is where most portals just show you the fields. OSCA Admin puts every security screen on one model: ways in, users, roles, resources, data.

Here's a service. Instead of a list of checkboxes, it tells me who can get in, and how: whether you have to sign in, and what someone who doesn't sign in gets on this instance.

Here's a resource. It tells me who can actually use it: everyone, through public permission; these roles; the users who hold those roles; and the accounts with `%All`. It includes access that comes in through web applications, which is the part people usually miss.

That's the question an administrator actually has: not 'what's this setting', but 'who can actually do this?'"

Open a service, pause on the "who can get in" answer. Open a resource, pause on its access list, then follow one path through to a user.

### 5. Safe changes (2:10–2:30)

"Every change shows what will change before it's saved. If a change could lock you out, or let anyone in, the portal explains the impact and asks you to type the name to confirm."

Make a risky edit, show the review and the type-to-confirm step, then cancel.

### 6. The API gap report, the file picker and `/api/osca` (2:30–3:15)

"Building a complete portal on the new API showed us exactly where it falls short. Take a simple thing: choosing a file on the server. The Management Portal has had a file picker for years. The new API has no way to see the server's file system at all.

So OSCA Admin adds a small read-only API of its own, `/api/osca`. It follows the same rules as IRIS's own picker: the same privileges, Filesystem access limits enforced on the server, and it never returns file contents."

Click **Browse…**, open a folder or two, pick a file. Cut to the gap report.

"We documented 20 gaps like this for InterSystems, each with our workaround and a suggested addition to the API. We filled six of them, including server identity, login history, the task catalogue and the console log (Logs › Messages log), and here's `/api/osca` in the portal's own API explorer, next to the system APIs."

Scroll the gap report's summary table. Then open Web & APIs › API explorer and select `/api/osca`.

### 7. Close (3:15–3:30)

"OSCA Admin. Clone it, run `docker compose up`, and it's ready in about two minutes. It needs IRIS 2026.2."

Toggle to the dark theme and hold on Home.

## After recording

- Upload, then put the video URL in the README (Author section) and in `docs/open-exchange-listing.md` (Links). Both are marked `TODO(owner)`.
