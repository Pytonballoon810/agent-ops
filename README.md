# agent-routing

Routing rules for workflow agents, and a dashboard that shows what they cost. Not tied to any
project: the rules apply everywhere, and the dashboard reads every project's transcripts.

| Path | What |
|---|---|
| `rules/model-routing.md` | Which model each agent role gets, path escalation, labelling. Loaded in every project through `~/.claude/rules/model-routing.md`, which points here |
| `templates/route.js` | The `ROUTES` table and `route()` function to paste into a workflow script |
| `dashboard/` | The model-routing card inside JFrog Boost's dashboard |
| `docs/spec-jev-card.md` | Spec for adding a jev-meter card next to it (not built yet) |

## Dashboard

A log of which model every subagent ran on, what it cost, and how its reviews held up, shown as a
card inside JFrog Boost's own dashboard under *Tokens Saved*.

- `dashboard/ingest.mjs` reads `~/.claude/projects/*/*/subagents/**` (agent transcripts, their
  `meta.json` labels, each workflow's `journal.jsonl`) into `dashboard/routing.db` (SQLite,
  `node:sqlite`). Incremental by mtime; `--rebuild` starts over. Prices come from Boost's
  `litellm-prices.json`. The database is not in git: it rebuilds from the transcripts.
- `dashboard/server.mjs` proxies the running `boost ui` (port found from `boost.exe`'s listeners, or
  `BOOST_URL`) on `http://127.0.0.1:56300/` and injects `panel.js` into the page. Boost's binary is
  never modified, so a Boost update cannot erase the panel.
- Start it with `node dashboard/server.mjs`. Starting it together with Boost is specified in
  `docs/spec-jev-card.md` and not built yet.

**Figures are derived, not billed.** Spend is recorded tokens × API list price. "Saved" prices each
non-Opus agent's tokens at Opus 5.5; an Opus agent is its own baseline. A model missing from Boost's
table (Sonnet 5.5, as of 2026-09-29) is priced at its family's previous release and flagged in the card.

**Routing itself** lives in each workflow script (see `templates/route.js`), not here. Review-quality
stats need the fixer to copy each finding's `lens` into its fixed/rejected entries.

## History

Moved here on 2026-09-29 from `~/.claude/tools/model-routing` (the dashboard) and from Nobble (the
`boost-routing` launch config, the routing table in its spec 029 workflow, and a Nobble-only memory
note), so the rules apply to every project.
