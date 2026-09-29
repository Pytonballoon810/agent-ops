# Model and effort routing for workflow agents

When writing or editing a workflow script (the Workflow tool), route each agent to the model and the
reasoning effort its role needs, and label it so the dashboard can score it. The rules, and why, are in
`C:\Users\Pytonballoon810\Documents\Claude\agent-ops\rules\model-routing.md` — read that file
before writing a workflow. The table and `route()` to paste in are in `templates\route.js` there;
pass both `model` and `effort` from it to `agent()`.

In short: Opus implements and fixes at high effort and reviews adversarially at xhigh; Sonnet checks
against written criteria at medium; Haiku writes docs at low. Label agents `CHUNK:role` or
`CHUNK:review:<lens>`, and have fixers copy each finding's `lens` into their fixed/rejected entries.
