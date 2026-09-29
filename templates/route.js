// MODEL ROUTING — paste into a workflow script (scripts are self-contained, so this cannot be imported).
// Rules and reasons: agent-routing/rules/model-routing.md.
//
// Lanes are the kinds of chunk a workflow runs; rename or add lanes to fit the project.
// A chunk may override any role with c.models = { impl: 'sonnet', 'review:spec': 'opus', fix: 'sonnet', ... }.
const ROUTES = {
  code: { impl: 'opus', 'review:spec': 'sonnet', 'review:correctness': 'opus', 'review:integration': 'sonnet', fix: 'opus' },
  ui:   { impl: 'opus', 'review:spec': 'sonnet', 'review:correctness': 'opus', 'review:fidelity': 'sonnet', fix: 'opus' },
  walk: { impl: 'sonnet', 'review:evidence': 'sonnet', 'review:correctness': 'opus', fix: 'opus' },
  // The docs fixer stays on Sonnet: it has to reject wrong findings, not just write prose.
  docs: { impl: 'haiku', 'review:spec': 'haiku', fix: 'sonnet' },
}

// Set per project: paths where a missed defect costs most. A non-Opus review of a change touching
// one of them goes to Opus. The default matches nothing.
const RISKY = /(?!)/

function route(c, role, impl) {
  const override = c.models && c.models[role]
  if (override) return { model: override, why: 'chunk override' }
  const model = (ROUTES[c.lane] && ROUTES[c.lane][role]) || 'opus'
  if (role.startsWith('review:') && model !== 'opus' && impl) {
    const risky = (impl.files_touched || []).filter(f => RISKY.test(f.replace(/\\/g, '/')))
    if (risky.length) return { model: 'opus', why: `escalated: touches ${risky.slice(0, 3).join(', ')}` }
  }
  return { model, why: 'table' }
}

// Usage — the label format is what the dashboard parses:
//   const rt = route(c, 'impl', null)
//   await agent(prompt, { label: `${c.id}:impl`, model: rt.model, ... })
//   const rv = route(c, `review:${lens}`, impl)
//   await agent(prompt, { label: `${c.id}:review:${lens}`, model: rv.model, ... })
//   Findings carry { lens, ... }; the fixer's schema requires `lens` on every fixed/rejected entry.
