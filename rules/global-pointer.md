# Model routing for workflow agents

When writing or editing a workflow script (the Workflow tool), route each agent to the model its
role needs and label it so the dashboard can score it. The rules, and why, are in
`C:\Users\Pytonballoon810\Documents\Claude\agent-ops\rules\model-routing.md` — read that file
before writing a workflow. The table and `route()` to paste in are in `templates\route.js` there.

In short: Opus implements, reviews adversarially and fixes; Sonnet checks against written criteria;
Haiku writes docs. Label agents `CHUNK:role` or `CHUNK:review:<lens>`, and have fixers copy each
finding's `lens` into their fixed/rejected entries.
