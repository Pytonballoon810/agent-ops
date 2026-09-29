// MODEL AND EFFORT ROUTING — paste into a workflow script (scripts are self-contained, so this cannot be imported).
// Rules and reasons: agent-ops/rules/model-routing.md.
//
// Lanes are the kinds of chunk a workflow runs; rename or add lanes to fit the project.
// Each role names a model and a reasoning effort (low < medium < high < xhigh < max); omit effort to
// inherit the session's (xhigh by default here).
// A chunk may override any role: c.models = { impl: 'sonnet', 'review:spec': { model: 'opus', effort: 'xhigh' }, ... }
// (a plain string overrides the model only).
const ROUTES = {
  code: {
    impl:                 { model: 'opus',   effort: 'high' },
    'review:spec':        { model: 'sonnet', effort: 'medium' },
    'review:correctness': { model: 'opus',   effort: 'xhigh' },
    'review:integration': { model: 'sonnet', effort: 'medium' },
    fix:                  { model: 'opus',   effort: 'high' },
  },
  ui: {
    impl:                 { model: 'opus',   effort: 'high' },
    'review:spec':        { model: 'sonnet', effort: 'medium' },
    'review:correctness': { model: 'opus',   effort: 'xhigh' },
    'review:fidelity':    { model: 'sonnet', effort: 'high' },
    fix:                  { model: 'opus',   effort: 'high' },
  },
  walk: {
    impl:                 { model: 'sonnet', effort: 'medium' },
    'review:evidence':    { model: 'sonnet', effort: 'medium' },
    'review:correctness': { model: 'opus',   effort: 'xhigh' },
    fix:                  { model: 'opus',   effort: 'high' },
  },
  // The docs fixer stays on Sonnet: it has to reject wrong findings, not just write prose.
  docs: {
    impl:                 { model: 'haiku',  effort: 'low' },
    'review:spec':        { model: 'haiku',  effort: 'low' },
    fix:                  { model: 'sonnet', effort: 'medium' },
  },
}

// Set per project: paths where a missed defect costs most. A review of a change touching one of them
// goes to Opus and one effort step up (at least high). The default matches nothing.
const RISKY = /(?!)/
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const up = e => EFFORTS[Math.min(EFFORTS.length - 1, Math.max(EFFORTS.indexOf('high'), EFFORTS.indexOf(e) + 1))]

function route(c, role, impl) {
  const table = (ROUTES[c.lane] && ROUTES[c.lane][role]) || { model: 'opus' }
  const o = c.models && c.models[role]
  if (o) {
    const r = typeof o === 'string' ? { ...table, model: o } : { ...table, ...o }
    return { model: r.model, effort: r.effort, why: 'chunk override' }
  }
  if (role.startsWith('review:') && impl) {
    const risky = (impl.files_touched || []).filter(f => RISKY.test(f.replace(/\\/g, '/')))
    if (risky.length && (table.model !== 'opus' || table.effort !== up(table.effort))) {
      return { model: 'opus', effort: up(table.effort), why: `escalated: touches ${risky.slice(0, 3).join(', ')}` }
    }
  }
  return { model: table.model, effort: table.effort, why: 'table' }
}

// Usage — the label format is what the dashboard parses; the effort lands in the transcript by itself:
//   const rt = route(c, 'impl', null)
//   await agent(prompt, { label: `${c.id}:impl`, model: rt.model, effort: rt.effort, ... })
//   const rv = route(c, `review:${lens}`, impl)
//   await agent(prompt, { label: `${c.id}:review:${lens}`, model: rv.model, effort: rv.effort, ... })
//   Findings carry { lens, ... }; the fixer's schema requires `lens` on every fixed/rejected entry, and
//   the implementer's requires `files_touched`, or RISKY escalation cannot see what changed.
