# Demo video script

Target length: 2 minutes 30 seconds. Screen recording at 1280×800 or larger, browser zoom 100%. Use a real 2026.2 instance so every number is live.

Before recording: open the portal on Home in the light theme, signed in, with a few minutes of history so the trend lines are filled.

## 1. Opening (0:00–0:15)

Show: Home.

Narration: "This is OSCA Portal, a management portal for InterSystems IRIS 2026.2. Everything you see is live, and it's built only on the new SysAdmin and monitoring REST APIs."

## 2. Home: is the instance OK? (0:15–0:45)

Show: point at the instance name and health pill, then the five figures, then Needs attention.

Narration: "Home answers one question: is this instance healthy, and does anything need me? Here's System CPU for the whole machine, and next to it IRIS's own share, per core. Needs attention lists real issues. This instance has never been backed up, and each item has an action."

Click: nothing. Hover the System CPU tile to show its tooltip.

## 3. The menu and the health readout (0:45–1:05)

Show: open a few menu groups, then use the toolbar readout.

Narration: "The menu is ordered by how often you use each area. The group you're in stays open, and the rest stay put. The toolbar shows health on every page. Click any part of it to go to the screen behind it."

Click: the "processes" part of the toolbar readout.

## 4. Processes (1:05–1:35)

Show: Processes.

Narration: "Every process, filterable and sortable. CPU now is measured over the last five seconds, not over the process's lifetime."

Click: sort by CPU %. Type a routine name in the filter. Click a row to open the detail panel.

Narration: "The panel shows who the process belongs to, what it's doing, and what you'll be able to do with it once you're signed in."

## 5. Activity, and the cost of watching (1:35–2:05)

Show: Operations › Activity.

Narration: "Activity shows how hard the instance is working over the last five minutes. One thing we found: collecting these metrics costs IRIS about 55,000 global references per scrape. On a quiet instance, that's most of what you'd see, so the portal measures its own share and shows it right under the figure."

Point at: a "from this portal's monitoring" note.

## 6. Command palette and themes (2:05–2:20)

Click: press Ctrl K, type "alerts", press Enter. Then toggle the theme.

Narration: "Ctrl K jumps anywhere by name. Light and dark themes are both fully designed."

## 7. Close (2:20–2:30)

Show: Home in dark theme.

Narration: "OSCA Portal. Install it with Docker or IPM. It needs IRIS 2026.2. More screens are landing through the voting period."
