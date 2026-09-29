# Model and effort routing for workflow agents

Applies to every project. Give each workflow agent the model **and the reasoning effort** its role
needs, instead of running everything on Opus at the session's effort (`xhigh`). The dashboard in
`../dashboard` measures whether that paid off, but only for agents that follow the labelling rules below.

## Which model and effort for which role

| Role | Model | Effort | Why |
|---|---|---|---|
| Implementer (writes code) | Opus | high | Intense, open-ended work; the spec and the reviews carry the rest |
| Adversarial correctness review | Opus | xhigh | Has to find what nobody wrote down |
| Fixer (judges and acts on findings) | Opus | high | Must reject wrong findings, not only apply them |
| Review against written criteria (spec conformance, integration, evidence audit) | Sonnet | medium | Well-specified checking |
| Fidelity to a reference (a prototype, a design) | Sonnet | high | Checking, but the reference is large |
| Walkthrough / verification against listed steps | Sonnet | medium | Same |
| Documentation writer and doc reviewer | Haiku | low | Prose against format rules |
| Documentation fixer | Sonnet | medium | Still has to reject wrong findings |

Anything not in the table defaults to Opus at the session's effort. Effort runs low < medium < high <
xhigh < max; `max` is for a judge whose single verdict decides a lot, and nothing routine.

**Escalate by path.** A *review* of a change that touches the project's high-cost areas (wire formats,
generated protocol files, anything on a hot path, config migration) goes to Opus and one effort step
up, at least `high`. Each project defines its own pattern; there is no universal list.

**Per-chunk override.** A chunk may carry `models: { impl: 'sonnet', 'review:spec': { model: 'opus', effort: 'xhigh' }, … }`,
which beats the table and the escalation (a plain string sets the model only).

The ready-made table and `route()` are in `../templates/route.js`: pass both `model` and `effort` from
it to `agent()`. Workflow scripts are self-contained, so paste it in and set `RISKY` for the project.

## Tuning from the dashboard

The table is a starting point. The routing card compares each role at each model and effort on what the
fixer accepted and on cost, and estimates what a lower effort saved against the same role at `xhigh`.
Lower a role's effort while its accepted-findings rate holds; raise it again when its reviews start
missing what the correctness review or the fixer later catches. Change model or effort for a role, not
both at once, or the comparison says nothing.

## Labelling (without it the dashboard has nothing to score)

- Label every agent `CHUNK:role` or `CHUNK:review:<lens>`, for example `C12:impl`,
  `C12:review:correctness`, `C12:fix`.
- Give every review finding its `lens`, and make the fixer copy that `lens` into each entry of its
  `fixed` and `rejected` lists. That is what the "review quality" table counts.
- Require `files_touched` in the implementer's schema, or path escalation cannot see what changed.
- Effort needs no labelling: every transcript line records the effort it ran at.

## Do not

- Do not change the `model` or `effort` of calls in a script whose run you may still resume: a changed
  call misses the resume cache and re-runs. Copy the script under a new name and start a new run with
  the unfinished chunks.
- Do not read the dashboard's "saved" figures as billing. Model savings price each non-Opus agent's
  tokens at Opus list price; effort savings compare output tokens with the same role's average at
  `xhigh`. Both are estimates.
