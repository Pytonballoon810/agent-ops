# agent-routing

Routing rules for workflow agents, and a dashboard that shows what they cost. Not tied to any
project: the rules apply everywhere, and the dashboard reads every project's transcripts.

| Path | What |
|---|---|
| `rules/model-routing.md` | Which model each agent role gets, path escalation, labelling. Loaded in every project through `~/.claude/rules/model-routing.md`, which points here |
| `templates/route.js` | The `ROUTES` table and `route()` function to paste into a workflow script |
| `dashboard/` | The model-routing and jev-meter cards inside JFrog Boost's dashboard |
| `install.ps1`, `uninstall.ps1` | Register / remove the `agent-routing` logon task that serves it |
| `docs/spec-jev-card.md` | Spec the jev card, the period following and the autostart were built from |

## Dashboard

**Open `http://127.0.0.1:56300/`**, not the port `boost ui` prints: that is Boost's own page without
the cards. It opens by itself whenever `boost ui` starts.

Two cards sit under Boost's *Tokens Saved*:

- **Model routing** — which model every subagent ran on, what it cost, and how its reviews held up.
- **Skill router** — jev-meter's numbers for the jev-skill-suggestion mod. jev-meter owns this card
  (`jev-meter/public/boost-panel.js`) and its data; this server only injects it and forwards
  `/__jev/*` to jev-meter on port 7431. When jev-meter is down the card says so and the rest of the
  page is unaffected.

Both follow Boost's period selector through `dashboard/period.js`, which reads Boost's own
`boost.report.days` and watches the period Boost's page asks its API for, then announces it as a
`boost-period` event. Both show a pulsing skeleton while they load, as Boost's panes do, including
after a period change.

**Starts with Boost.** `install.ps1` registers a logon task that runs `dashboard/server.mjs` hidden
(through `run.vbs`) and restarts it on failure. The server polls every 5 s for a `boost ui`; when one
appears on a port it has not seen, it opens this page in the default browser. If `boost ui` also
opens its own page (it has no flag to stop that), you get two tabs; this is the one with the cards.
Its comings and goings are logged to `dashboard/server.log`. Set `ROUTING_NO_OPEN=1` to stop the
auto-open.

```powershell
Get-ScheduledTask -TaskName agent-routing | Select-Object TaskName, State   # Running is healthy
Get-Content .\dashboard\server.log -Tail 20
```

- `dashboard/ingest.mjs` reads `~/.claude/projects/*/*/subagents/**` (agent transcripts, their
  `meta.json` labels, each workflow's `journal.jsonl`) into `dashboard/routing.db` (SQLite,
  `node:sqlite`). Incremental by mtime; `--rebuild` starts over. Prices come from Boost's
  `litellm-prices.json`. The database is not in git: it rebuilds from the transcripts.
- `dashboard/server.mjs` proxies the running `boost ui` (port found from `boost.exe`'s listeners, or
  `BOOST_URL`) on `http://127.0.0.1:56300/` and injects `panel.js` into the page. Boost's binary is
  never modified, so a Boost update cannot erase the panel.
- By hand: `node dashboard/server.mjs` (stop the task first, or the port is taken).

**Figures are derived, not billed.** Spend is recorded tokens × API list price. "Saved" prices each
non-Opus agent's tokens at Opus 5.5; an Opus agent is its own baseline. A model missing from Boost's
table (Sonnet 5.5, as of 2026-09-29) is priced at its family's previous release and flagged in the card.

**Routing itself** lives in each workflow script (see `templates/route.js`), not here. Review-quality
stats need the fixer to copy each finding's `lens` into its fixed/rejected entries.

## History

Moved here on 2026-09-29 from `~/.claude/tools/model-routing` (the dashboard) and from Nobble (the
`boost-routing` launch config, the routing table in its spec 029 workflow, and a Nobble-only memory
note), so the rules apply to every project.
