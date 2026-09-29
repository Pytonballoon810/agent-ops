# Spec: jev-meter card in the Boost dashboard, following Boost's period, starting with Boost

Status: built 2026-09-29. Decisions taken that day: the card follows Boost's period selector, and
the combined page starts with Boost. Deviations from the text below: the jev card's script is read
from jev-meter's folder on disk rather than fetched from its server (otherwise the "not running"
state could never show); and both cards gained Boost-style loading skeletons. Part 3, point 3 is
still open: the auto-open was verified from the server's log, but whether `boost ui` also opens a tab
of its own could not be seen from here (`boost ui` has no flag to stop it if it does).

## Goal

Show the headline jev-skill-suggestion numbers as a card inside JFrog Boost's own dashboard, beside
the model-routing card, so one page answers "what are my agents costing and what is the skill router
doing" for the period picked in Boost. The combined page is there whenever Boost is, without starting
anything by hand. The full jev-meter page on `127.0.0.1:7431` stays as the detailed view.

## The pattern to copy

`dashboard/server.mjs` (this repo) listens on `127.0.0.1:56300`, finds the running `boost ui` (its
port changes every launch), proxies every request to it, and injects
`<script type="module" src="/__routing/panel.js">` before `</body>`. `panel.js` mounts a `<section>`
after Boost's *Tokens Saved* section, reuses that section's class so it looks native, re-mounts it
when React drops it, and follows Boost's period by watching the `days=` Boost's page sends to
`/api/savings-timeline`. Boost's binary is never touched.

## Part 1 — the card

**One proxy, two cards.** Extend `dashboard/server.mjs` rather than start a second proxy.

1. **`dashboard/server.mjs`** gains:
   - A second injected tag, `<script type="module" src="/__jev/panel.js"></script>`.
   - Routing of `/__jev/*` to jev-meter at `http://127.0.0.1:${JEV_METER_PORT || 7431}`:
     `/__jev/panel.js` → jev-meter's `public/boost-panel.js`, `/__jev/api/snapshot?days=N` →
     `/api/snapshot?days=N`, `/__jev/healthz` → `/healthz`. Same-origin, so no CORS work.
   - If jev-meter does not answer: 502 with JSON `{error}`. Never affects Boost's page or the
     routing card.
2. **jev-meter `public/boost-panel.js`** (new; jev-meter owns it because it owns the snapshot's
   shape). Built like `panel.js`: element id `jev-meter`, styles scoped under `#jev-meter`, Boost's
   dark palette (not the Lyra theme), mounted after `#model-routing` if present, else after
   *Tokens Saved*. Refreshes every 60 s and whenever the period changes.
3. **Following the period.** Both cards need the same `days` value, and `panel.js` already detects
   it by wrapping `window.fetch`. Do not wrap fetch a second time: move the detection into a tiny
   shared script (`/__routing/period.js`, injected first) that keeps the current `days` and fires a
   `boost-period` event on `window`. Both cards listen to it. Default 30 until Boost's page asks.

## Part 2 — jev-meter gains `?days=N`

`aggregate(sessions, config)` in `meter.mjs` is already a pure function over a list of sessions, so
a windowed view is a filter plus a second call, not new parsing.

- `evaluate()` keeps the full parsed session list in memory (`lastSessions`) next to the snapshot.
- `/api/snapshot?days=N` (N > 0): take sessions whose `end` is within the last N days (a session
  active in the window counts), run `aggregate()` on them, and return the usual snapshot with that
  aggregate and `window: { days: N, sessions: <count> }`. `checks` and `config` are not windowed —
  they describe the present, and the card shows them as such. No `days` or `days=0` = today's
  all-time snapshot, unchanged, so the jev-meter page itself is unaffected.
- A session that started before the window is counted whole (its full prefix cost), and the card
  says so in its footer. Splitting a session's cost at the boundary is not worth the complexity.
- Nothing is written to `snapshot.json` for windowed requests.

## Part 3 — starting with Boost

`boost ui` is started by hand from PowerShell and picks a new port each time; nothing starts Boost at
logon. So the dashboard server is made always-ready and reacts to Boost:

1. **Scheduled task `agent-routing`**, at logon, running `dashboard/server.mjs` hidden and
   supervised, the same way jev-meter's `run.vbs` does (blocks until node exits so the task reads
   `Running` and restart-on-failure applies). `install.ps1` / `uninstall.ps1` in this repo, copied in
   style from jev-meter's.
2. **The server watches for Boost.** Every 5 s it checks for a `boost.exe` process with `ui` on its
   command line. When a new one appears (a PID it has not seen), it re-discovers Boost's port and
   opens `http://127.0.0.1:56300/` in the default browser once. When Boost exits, it forgets the port.
3. **Boost's own tab.** `boost ui` very likely opens its own tab on its own port, which would then sit
   beside the combined one. The implementer must check this. If Boost opens a tab and there is no
   flag or environment variable to stop it, keep both tabs and say so in the README rather than
   hacking around Boost.
4. The Nobble launch config `boost-routing` is already removed; this task replaces it.

## What the card shows

| Area | Source | Notes |
|---|---|---|
| Headline: net prefix tokens | `totals.net` | Green if positive, red if negative, labelled *estimated* |
| Subline | `totals.sessions`, `suggestions`, `promptsWithoutSuggestion`, `skillToolCalls`, `refusals` | *measured*, for the period |
| Health | `checks[]` (`level`, `label`, `detail`) | Status dot per check, warnings first, labelled "now" (not windowed) |
| Config line | `config.model`, `provider`, `hideListing`, `inject` | Never render `apiKeyRedacted` or anything key-related |
| Top skills | `skills[]` by `suggested`, top 8 | skill · suggested · injected · called · state |
| Recent picks | `picks[]`, newest 5 | time · skill · project; prompt truncated to ~80 chars, only in a `title` tooltip |
| Footer | `generatedAt`, `provenance`, `window` | "past N days · M sessions", the whole-session note, measured/reported/estimated, link "Open jev-meter →" |

**States:** loading; jev-meter down (says so, shows `Start-ScheduledTask -TaskName jev-meter`);
snapshot error (shows jev-meter's `error`); no sessions in this period.

## Out of scope

- Changing what jev-meter measures, or its own page.
- Any change to Boost itself.

## Acceptance

1. After logon, with nothing started by hand, running `boost ui` opens `http://127.0.0.1:56300/`
   within ~10 s, showing Boost's page, the model-routing card and the jev-meter card.
2. The jev card's figures match `http://127.0.0.1:7431/api/snapshot?days=N` for the period Boost
   shows; switching Boost's period updates both cards to the same N.
3. `http://127.0.0.1:7431/` and `/api/snapshot` without `days` are unchanged.
4. Stopping jev-meter turns the jev card into the "not running" state within 60 s; the routing card
   and Boost's own sections are unaffected, and the console shows no uncaught errors.
5. Closing and re-running `boost ui` (new port) works again without restarting anything.
6. No prompt text is visible without hovering; nothing key-related is in the page source.
7. READMEs: this repo's gains the autostart and the jev card; jev-meter's gains a "Boost card" entry
   and the `days` parameter.

## Open questions

None blocking. The Boost-tab question (Part 3, point 3) is answered by trying it.
