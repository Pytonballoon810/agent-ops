// The two feature switches on the page. Both change what NEW sessions and workflow runs do; a session
// that is already running keeps what it loaded.
//
//   skills   the jev-skill-suggestion mod: `enabledPlugins["jev-skill-suggestion@skills-dir"] = false`
//            in ~/.claude/settings.json turns it off (verified 2026-09-29: the hooks module is then not
//            loaded); on removes that entry again rather than writing `true`.
//   routing  the cross-project routing rule: on installs ../rules/global-pointer.md (with its
//            {{AGENT_OPS_DIR}} filled in) as ~/.claude/rules/model-routing.md, off removes it. Workflow scripts already written keep
//            whatever models they name; the rule is what tells Claude to route new ones.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const PLUGIN = 'jev-skill-suggestion@skills-dir'
const RULE = path.join(os.homedir(), '.claude', 'rules', 'model-routing.md')
const REPO = path.resolve(HERE, '..')
const POINTER = path.join(REPO, 'rules', 'global-pointer.md')

// The pointer is a template: `{{AGENT_OPS_DIR}}` becomes wherever this repo was cloned, so the
// installed rule names a path that exists on this machine.
export function renderPointer() {
  return fs.readFileSync(POINTER, 'utf8').replaceAll('{{AGENT_OPS_DIR}}', () => REPO)
}

export function readToggles() {
  let s = {}
  try { s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) } catch {}
  return { skills: s.enabledPlugins?.[PLUGIN] !== false, routing: fs.existsSync(RULE) }
}

export function setToggle(feature, on) {
  if (feature === 'skills') {
    const raw = fs.readFileSync(SETTINGS, 'utf8')
    const s = JSON.parse(raw)   // throws on a broken file rather than overwrite it
    s.enabledPlugins ||= {}
    if (on) delete s.enabledPlugins[PLUGIN]
    else s.enabledPlugins[PLUGIN] = false
    // Written beside and renamed over, so Claude Code never reads a half-written settings file.
    const tmp = SETTINGS + '.agent-ops.tmp'
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + (raw.endsWith('\n') ? '\n' : ''))
    fs.renameSync(tmp, SETTINGS)
  } else if (feature === 'routing') {
    if (on) { fs.mkdirSync(path.dirname(RULE), { recursive: true }); fs.writeFileSync(RULE, renderPointer()) }
    else fs.rmSync(RULE, { force: true })
  } else {
    throw new Error(`unknown feature ${feature}`)
  }
  return readToggles()
}
