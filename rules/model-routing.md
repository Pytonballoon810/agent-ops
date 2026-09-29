# Model routing for workflow agents

Applies to every project. Route each workflow agent to the model its role needs instead of running
everything on Opus. The dashboard in `../dashboard` measures whether that paid off, but only for
agents that follow the labelling rules below.

## Which model for which role

| Role | Model | Why |
|---|---|---|
| Implementer (writes code) | Opus | Intense, open-ended work |
| Adversarial correctness review | Opus | Has to find what nobody wrote down |
| Fixer (judges and acts on findings) | Opus | Must reject wrong findings, not only apply them |
| Review against written criteria (spec conformance, integration, fidelity to a reference, evidence audit) | Sonnet | Well-specified checking |
| Walkthrough / verification against listed steps | Sonnet | Same |
| Documentation writer and doc reviewer | Haiku | Prose against format rules |
| Documentation fixer | Sonnet | Still has to reject wrong findings |

Anything not in the table defaults to Opus.

**Escalate to Opus by path.** A Sonnet or Haiku *review* of a change that touches the project's
high-cost areas (wire formats, generated protocol files, anything on a hot path, config migration)
goes to Opus. Each project defines its own pattern; there is no universal list.

**Per-chunk override.** A chunk may carry `models: { impl: 'sonnet', 'review:spec': 'opus', … }`,
which beats the table and the escalation.

The ready-made table and `route()` function are in `../templates/route.js`. Workflow scripts are
self-contained, so paste it in and set `RISKY` for the project.

## Labelling (without it the dashboard has nothing to score)

- Label every agent `CHUNK:role` or `CHUNK:review:<lens>`, for example `C12:impl`,
  `C12:review:correctness`, `C12:fix`.
- Give every review finding its `lens`, and make the fixer copy that `lens` into each entry of its
  `fixed` and `rejected` lists. That is what the "review quality by model" table counts.

## Do not

- Do not change the `model` of calls in a script whose run you may still resume: a changed call
  misses the resume cache and re-runs. Copy the script under a new name instead.
- Do not read the dashboard's "saved" figure as billing. It prices each non-Opus agent's tokens at
  Opus list price; a smaller model may spend a different number of tokens on the same job.
