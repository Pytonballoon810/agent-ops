# agent-ops

What Claude Code's agents cost and how they are steered, inside JFrog Boost's dashboard, plus the
rules for routing workflow agents to models. Not tied to any project: the rules apply everywhere and
the dashboard reads every project's transcripts.

| Path | What |
|---|---|
| `rules/model-routing.md` | Which model each agent role gets, path escalation, labelling. Loaded in every project through `~/.claude/rules/model-routing.md`, which points here |
| `templates/route.js` | The `ROUTES` table and `route()` function to paste into a workflow script |
| `dashboard/` | The server and the two cards it adds to Boost's page |
| `install.ps1`, `uninstall.ps1` | Register / remove the `agent-ops` logon task that serves it |
| `docs/spec-jev-card.md` | The spec the skill-router card, period following and autostart were built from |

## Dashboard

**Open `http://127.0.0.1:56300/`**, not the port `boost ui` prints: that is Boost's page without the
cards. It opens by itself whenever `boost ui` starts.

`dashboard/server.mjs` proxies the running `boost ui` (port found from `boost.exe`'s listeners, or
`BOOST_URL`) and injects scripts into the page; Boost's binary is never modified, so a Boost update
cannot erase the cards. Two cards sit under Boost's *Tokens Saved*:

- **Model routing** (`panel.js`, data from `ingest.mjs`) — which model every subagent ran on, what it
  cost, and how its reviews held up. `ingest.mjs` reads `~/.claude/projects/*/*/subagents/**` into
  `dashboard/routing.db` (SQLite), incrementally; `--rebuild` starts over. Prices come from Boost's
  `litellm-prices.json`.
- **Skill router** (`jev-panel.js`, data from `jev.mjs`) — what the jev-skill-suggestion mod does:
  listings withheld against skill bodies injected, in prefix tokens; health checks on its
  configuration; which skills are offered and called. `jev.mjs` re-reads changed transcripts every 5
  minutes (`JEV_INTERVAL_MS`), caching per file in `dashboard/data/`. It also runs alone:
  `node dashboard/jev.mjs` prints the headline.

Both follow Boost's period selector through `period.js`, which reads Boost's `boost.report.days` and
watches the period Boost's page asks its API for, then announces it as a `boost-period` event. Both
show a pulsing skeleton while loading, as Boost's panes do, including after a period change.

**Starts with Boost.** `install.ps1` registers a logon task that runs the server hidden (through
`run.vbs`, which blocks so the task reads Running and restarts on failure). The server polls every
5 s for a `boost ui`; when one appears on a port it has not seen, it opens this page. If `boost ui`
also opens its own page you get two tabs; this is the one with the cards. `ROUTING_NO_OPEN=1` stops
the auto-open. Log: `dashboard/server.log`.

```powershell
Get-ScheduledTask -TaskName agent-ops | Select-Object TaskName, State   # Running is healthy
Get-Content .\dashboard\server.log -Tail 20
```

## What the figures are

- **Model routing** figures are derived, not billed: recorded tokens × API list price. "Saved" prices
  each non-Opus agent's tokens at Opus 5.5 (an Opus agent is its own baseline). A model missing from
  Boost's price table is priced at its family's previous release and flagged in the card.
- **Skill router** counts (turns, calls, timestamps) are measured; every token figure is estimated
  from characters at 4 chars/token. A block added to the conversation costs its size times the turns
  it then rides in the prefix, until the next compaction; a withheld listing is valued the same way.
  With a period selected, a session active in it is counted whole. Health and configuration always
  describe the present. Whether a suggestion was *good* is not judged.

**Routing itself** lives in each workflow script (`templates/route.js`), not here. If every labelled
agent shows Opus, no script using `route()` has run in that period.

## History

2026-09-29: the dashboard moved from `~/.claude/tools/model-routing` and the rules out of Nobble; the
same day the separate jev-meter project (its own server on port 7431, page and task) was folded in as
the skill-router card, and the repo was renamed from agent-routing to agent-ops.
