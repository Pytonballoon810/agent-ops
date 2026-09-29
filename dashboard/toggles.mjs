// The two feature switches on the page. Both change what NEW sessions and workflow runs do; a session
// that is already running keeps what it loaded.
//
//   skills   the jev-skill-suggestion mod: `enabledPlugins["jev-skill-suggestion@skills-dir"] = false`
//            in ~/.claude/settings.json turns it off (verified 2026-09-29: the hooks module is then not
//            loaded); on removes that entry again rather than writing `true`.
//   routing  the cross-project routing rule: on installs ../rules/global-pointer.md as
//            ~/.claude/rules/model-routing.md, off removes it. Workflow scripts already written keep
//            whatever models they name; the rule is what tells Claude to route new ones.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json')
const PLUGIN = 'jev-skill-suggestion@skills-dir'
const RULE = path.join(os.homedir(), '.claude', 'rules', 'model-routing.md')
const POINTER = path.join(HERE, '..', 'rules', 'global-pointer.md')

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
    if (on) { fs.mkdirSync(path.dirname(RULE), { recursive: true }); fs.copyFileSync(POINTER, RULE) }
    else fs.rmSync(RULE, { force: true })
  } else {
    throw new Error(`unknown feature ${feature}`)
  }
  return readToggles()
}
