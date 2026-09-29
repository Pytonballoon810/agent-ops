// Builds the model-routing log: one row per subagent (label, role, model, tokens, cost) and one per
// review outcome (findings raised, and how many the fixer accepted or rejected), read from the
// transcripts Claude Code already writes. Nothing here calls a model or leaves this machine.
//
//   node ingest.mjs            ingest everything new, print a one-line summary
//   node ingest.mjs --rebuild  drop the database and ingest from scratch

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const HOME = os.homedir()
export const PROJECTS = path.join(HOME, '.claude', 'projects')
export const DB_PATH = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'routing.db')
const PRICES_PATH = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'boost', 'litellm-prices.json')

// What every row is priced against to say what routing saved: the same tokens at Opus rates.
// That is a derived figure — a smaller model spends a different number of tokens on the same job.
export const BASELINE_MODEL = 'claude-opus-5-5'

export function tier(model) {
  const m = String(model || '').toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('fable')) return 'fable'
  return 'other'
}

// "C22:review:correctness" -> chunk C22, role review, lens correctness. Anything else keeps its label as the role.
// Other workflows spell it "implement:S3a", "review:S7:security", "critic:feasibility": the role is
// the part that names a job, a chunk is a short capitalised id, and what is left is the lens.
const ROLE_WORDS = { impl: 'impl', implement: 'impl', fix: 'fix', review: 'review', verify: 'verify', gate: 'gate',
  critic: 'critic', judge: 'judge', find: 'find', plan: 'plan', writer: 'write', write: 'write' }
// An ordinary (non-workflow) subagent's "label" is a free-text task description, so it groups by its
// agent type instead. A workflow agent started without a label says so rather than guessing.
export function parseLabel(label, agentType) {
  if (agentType && agentType !== 'workflow-subagent') return { chunk: null, role: agentType, lens: null }
  const m = /^([A-Za-z]+\d+[a-z]?):(impl|fix|review:([\w-]+))$/.exec(label || '')
  if (m) return { chunk: m[1], role: m[3] ? 'review' : m[2], lens: m[3] || null }
  if (!label) return { chunk: null, role: '(no label)', lens: null }
  const parts = String(label).split(':').map(s => s.trim())
  const ri = parts.findIndex(p => ROLE_WORDS[p.toLowerCase()])
  if (ri < 0) return { chunk: null, role: parts[0].replace(/[-_ ]?\d.*$/, '').toLowerCase() || 'agent', lens: parts.slice(1).join(':') || null }
  const rest = parts.filter((_, i) => i !== ri)
  const ci = rest.findIndex(p => /^[A-Z]+\d*[a-z]?$/.test(p))
  const chunk = ci >= 0 ? rest[ci] : null
  const lens = rest.filter((_, i) => i !== ci).join(':') || null
  return { chunk, role: ROLE_WORDS[parts[ri].toLowerCase()], lens }
}

let prices = null
function loadPrices() {
  if (prices) return prices
  try { prices = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8')) } catch { prices = {} }
  return prices
}
// Returns the price entry and the id it was found under. Boost's table is LiteLLM's and lags new
// releases (it has no claude-sonnet-5-5 as of 2026-09-29), so a missing point release is priced at
// its family's previous one — an estimate, reported as such through `as`.
export function priceFor(model) {
  const p = loadPrices()
  const find = m => {
    if (p[m]) return m
    const bare = m.replace(/-\d{8}$/, '')
    if (p[bare]) return bare
    return Object.keys(p).find(k => k.endsWith('/' + bare) || k.endsWith('.' + bare)) || null
  }
  let m = String(model || '')
  for (let i = 0; m && i < 2; i++) {
    const k = find(m)
    if (k) return { price: p[k], as: k.replace(/^.*[/.]/, '') }
    m = m.replace(/-\d+$/, '')   // claude-sonnet-5-5 -> claude-sonnet-5
  }
  return null
}
export function costOf(u, model) {
  const p = priceFor(model)?.price
  if (!p) return null
  const w1h = p.cache_creation_input_token_cost_above_1hr ?? p.cache_creation_input_token_cost ?? 0
  return (u.input || 0) * (p.input_cost_per_token || 0)
    + (u.output || 0) * (p.output_cost_per_token || 0)
    + (u.cache_read || 0) * (p.cache_read_input_token_cost || 0)
    + (u.cache_write_5m || 0) * (p.cache_creation_input_token_cost || 0)
    + (u.cache_write_1h || 0) * w1h
}

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL, size INTEGER);
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY, project TEXT, session TEXT, run_id TEXT, label TEXT,
      chunk TEXT, role TEXT, lens TEXT, agent_type TEXT, model TEXT, tier TEXT,
      started TEXT, ended TEXT, messages INTEGER,
      input INTEGER, output INTEGER, cache_read INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
      cost_usd REAL, baseline_usd REAL, priced_as TEXT
    );
    CREATE TABLE IF NOT EXISTS reviews (
      agent_id TEXT PRIMARY KEY, run_id TEXT, chunk TEXT, lens TEXT,
      findings INTEGER, blockers INTEGER, majors INTEGER, minors INTEGER
    );
    CREATE TABLE IF NOT EXISTS fix_outcomes (
      agent_id TEXT, run_id TEXT, chunk TEXT, lens TEXT, outcome TEXT, n INTEGER,
      PRIMARY KEY (agent_id, lens, outcome)
    );
    CREATE INDEX IF NOT EXISTS agents_started ON agents(started);
    -- Overall usage, for the Agent usage pane: every assistant message in every transcript, summed per
    -- UTC hour, model and kind (chat = a session you typed in, subagent = an Agent-tool agent started
    -- from a chat, workflow = an agent of a Workflow run). Read by byte offset: transcripts only grow.
    CREATE TABLE IF NOT EXISTS usage_files (path TEXT PRIMARY KEY, offset INTEGER, last_msg TEXT);
    CREATE TABLE IF NOT EXISTS usage (
      path TEXT, hour TEXT, model TEXT, kind TEXT, messages INTEGER,
      input INTEGER, output INTEGER, cache_read INTEGER, cache_write_5m INTEGER, cache_write_1h INTEGER,
      cost_usd REAL, unpriced INTEGER,
      PRIMARY KEY (path, hour, model, kind)
    );
    CREATE INDEX IF NOT EXISTS usage_hour ON usage(hour);
  `)
  return db
}

// Every transcript with its kind: <project>/<session>.jsonl is a chat; under <session>/subagents/,
// workflows/wf_*/ holds workflow agents and anything else is an Agent-tool subagent.
function* usageCandidates() {
  let projects
  try { projects = fs.readdirSync(PROJECTS, { withFileTypes: true }) } catch { return }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const pdir = path.join(PROJECTS, proj.name)
    let ents
    try { ents = fs.readdirSync(pdir, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      if (e.isFile() && e.name.endsWith('.jsonl')) yield { file: path.join(pdir, e.name), kind: 'chat' }
      else if (e.isDirectory()) {
        const sub = path.join(pdir, e.name, 'subagents')
        if (!fs.existsSync(sub)) continue
        for (const f of walk(sub)) {
          const b = path.basename(f)
          if (b.startsWith('agent-') && b.endsWith('.jsonl')) {
            yield { file: f, kind: /[\\/]workflows[\\/]wf_[^\\/]+[\\/]agent-[^\\/]+$/.test(f) ? 'workflow' : 'subagent' }
          }
        }
      }
    }
  }
}

// Reads what was appended to one transcript since the stored offset, in 16 MB slices, whole lines only.
// A file that shrank was rewritten, so its rows are dropped and it is read again from the start.
//
// A message streams in as several consecutive lines with the same id, and only the last carries its final
// output count, so each message is held until a different id follows. The last message read is not
// counted yet — the offset is left at its first line so the next pass reads it whole — unless the file
// has been quiet for two minutes, when it is finished and counted.
function ingestUsageFile(db, file, kind, size, mtimeMs, st) {
  let row = st.get.get(file)
  if (row && size < row.offset) { st.del.run(file); row = null }
  let offset = row?.offset ?? 0, last = row?.last_msg ?? null
  if (offset === size) return false
  const acc = new Map()
  let pending = null
  const commit = p => {
    let a = acc.get(p.key)
    if (!a) acc.set(p.key, a = { messages: 0, input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cost: 0, unpriced: 0 })
    a.messages++
    for (const f in p.x) a[f] += p.x[f]
    const c = costOf(p.x, p.model)
    if (c == null) a.unpriced++; else a.cost += c
    last = p.id
  }
  const fd = fs.openSync(file, 'r')
  try {
    // Split on the newline byte, not on decoded text, so a slice ending inside a multi-byte character
    // cannot shift the stored offset.
    let carry = Buffer.alloc(0)
    const buf = Buffer.alloc(16 * 1024 * 1024)
    let pos = offset
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos)
      if (!n) break
      pos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      const cut = chunk.lastIndexOf(10)
      if (cut < 0) { carry = Buffer.from(chunk); continue }
      carry = Buffer.from(chunk.subarray(cut + 1))
      const base = pos - chunk.length   // file offset of chunk[0]
      offset = pos - carry.length
      for (let s = 0; s < cut;) {
        const e = chunk.indexOf(10, s)
        const lineStart = base + s
        const line = chunk.toString('utf8', s, e)
        s = e + 1
        if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        const m = o.message
        if (!m?.usage || !m.model || m.model === '<synthetic>' || !o.timestamp) continue
        const id = m.id || o.uuid
        if (id === last) continue
        const u = m.usage, w = u.cache_creation || {}
        const w1h = w.ephemeral_1h_input_tokens ?? 0
        const x = { input: u.input_tokens || 0, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0,
          cache_write_5m: w.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1h), cache_write_1h: w1h }
        if (pending?.id === id) { pending.x = x; continue }   // a later line of the same message: final counts win
        if (pending) commit(pending)
        // Older versions kept Agent-tool subagents inside the chat's own file, marked as a sidechain.
        const k = kind === 'chat' && o.isSidechain ? 'subagent' : kind
        pending = { id, x, model: m.model, key: `${o.timestamp.slice(0, 13)}\u0000${m.model}\u0000${k}`, start: lineStart }
      }
    }
  } finally { fs.closeSync(fd) }
  if (pending) {
    if (Date.now() - mtimeMs > 120_000) commit(pending)
    else offset = pending.start
  }
  for (const [key, a] of acc) {
    const [hour, model, k] = key.split('\u0000')
    st.add.run(file, hour, model, k, a.messages, a.input, a.output, a.cache_read, a.cache_write_5m, a.cache_write_1h, a.cost, a.unpriced)
  }
  st.mark.run(file, offset, last)
  return true
}

export function ingestUsage(db = openDb(), { rebuild = false } = {}) {
  if (rebuild) db.exec(`DELETE FROM usage_files; DELETE FROM usage;`)
  const st = {
    get: db.prepare(`SELECT offset, last_msg FROM usage_files WHERE path = ?`),
    del: db.prepare(`DELETE FROM usage WHERE path = ?`),
    mark: db.prepare(`INSERT OR REPLACE INTO usage_files VALUES (?,?,?)`),
    add: db.prepare(`INSERT INTO usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (path, hour, model, kind) DO UPDATE SET messages = messages + excluded.messages,
        input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
        cache_write_5m = cache_write_5m + excluded.cache_write_5m, cache_write_1h = cache_write_1h + excluded.cache_write_1h,
        cost_usd = cost_usd + excluded.cost_usd, unpriced = unpriced + excluded.unpriced`),
  }
  let files = 0
  db.exec('BEGIN')
  try {
    for (const { file, kind } of usageCandidates()) {
      let s
      try { s = fs.statSync(file) } catch { continue }
      if (ingestUsageFile(db, file, kind, s.size, s.mtimeMs, st)) files++
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return { files }
}

function* walk(dir, depth = 0) {
  let ents
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (depth < 6) yield* walk(p, depth + 1) }
    else yield p
  }
}

// Only subagent transcripts: <project>/<session>/subagents/[workflows/<run>/]agent-*.jsonl and each run's journal.
function* candidates() {
  let projects
  try { projects = fs.readdirSync(PROJECTS, { withFileTypes: true }) } catch { return }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const pdir = path.join(PROJECTS, proj.name)
    let sessions
    try { sessions = fs.readdirSync(pdir, { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sub = path.join(pdir, s.name, 'subagents')
      if (!fs.existsSync(sub)) continue
      for (const f of walk(sub)) {
        const b = path.basename(f)
        if ((b.startsWith('agent-') && b.endsWith('.jsonl')) || b === 'journal.jsonl') {
          yield { file: f, project: proj.name, session: s.name }
        }
      }
    }
  }
}

function readAgent(file) {
  const byMsg = new Map()
  let first = null, last = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) {
      if (line.includes('"timestamp"')) {
        const t = /"timestamp":"([^"]+)"/.exec(line)
        if (t) { first ??= t[1]; last = t[1] }
      }
      continue
    }
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.timestamp) { first ??= o.timestamp; last = o.timestamp }
    const m = o.message
    if (!m || m.role !== 'assistant' || !m.usage) continue
    // One API message is written as several lines (one per content block) carrying the same usage.
    byMsg.set(m.id || o.uuid, { model: m.model, u: m.usage })
  }
  const tot = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 }
  const models = new Map()
  let cost = 0, baseline = 0, priced = true
  for (const { model, u } of byMsg.values()) {
    if (!model || model === '<synthetic>') continue
    const w = u.cache_creation || {}
    const w1h = w.ephemeral_1h_input_tokens ?? 0
    const w5m = w.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - w1h)
    const x = { input: u.input_tokens || 0, output: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write_5m: w5m, cache_write_1h: w1h }
    for (const k in tot) tot[k] += x[k]
    models.set(model, (models.get(model) || 0) + x.output + x.input + x.cache_read)
    const c = costOf(x, model)
    if (c == null) priced = false; else cost += c
    // An agent that ran on some Opus is its own baseline: an older, dearer Opus is a version
    // difference, not a routing decision, and must not count as routing losing money.
    baseline += tier(model) === 'opus' ? (c ?? 0) : (costOf(x, BASELINE_MODEL) ?? 0)
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null
  return { ...tot, model, messages: byMsg.size, started: first, ended: last, cost: priced ? cost : null, baseline }
}

function readJournal(db, file, runId, labels) {
  const upR = db.prepare(`INSERT OR REPLACE INTO reviews VALUES (?,?,?,?,?,?,?,?)`)
  const delF = db.prepare(`DELETE FROM fix_outcomes WHERE agent_id = ?`)
  const upF = db.prepare(`INSERT OR REPLACE INTO fix_outcomes VALUES (?,?,?,?,?,?)`)
  const backfill = db.prepare(`UPDATE agents SET label = ?, chunk = ?, role = ?, lens = ? WHERE agent_id = ? AND label IS NULL`)
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    // Older runs wrote no label into an agent's meta.json; the journal's "started" line has it.
    if (line.startsWith('{"type":"started"')) {
      try {
        const o = JSON.parse(line)
        if (o.agentId && o.label) {
          labels.set(o.agentId, labels.get(o.agentId) || o.label)
          const p = parseLabel(o.label)
          backfill.run(o.label, p.chunk, p.role, p.lens, o.agentId)
        }
      } catch {}
      continue
    }
    if (!line.startsWith('{"type":"result"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    const r = o.result
    if (!r || typeof r !== 'object') continue
    const label = labels.get(o.agentId) || o.label || ''
    const { chunk, role, lens } = parseLabel(label)
    if (role === 'review' && Array.isArray(r.findings)) {
      const sev = s => r.findings.filter(f => f.severity === s).length
      upR.run(o.agentId, runId, chunk, lens, r.findings.length, sev('blocker'), sev('major'), sev('minor'))
    } else if (role === 'fix' && (Array.isArray(r.fixed) || Array.isArray(r.rejected))) {
      delF.run(o.agentId)
      const count = new Map()
      for (const [outcome, list] of [['fixed', r.fixed || []], ['rejected', r.rejected || []]]) {
        for (const it of list) {
          // Runs before the routed lane carry no lens on a finding; they count against the chunk only.
          const key = `${outcome}\u0000${it.lens || ''}`
          count.set(key, (count.get(key) || 0) + 1)
        }
      }
      for (const [key, n] of count) {
        const [outcome, l] = key.split('\u0000')
        upF.run(o.agentId, runId, chunk, l || null, outcome, n)
      }
    }
  }
}

export function ingest(db = openDb(), { rebuild = false } = {}) {
  if (rebuild) db.exec(`DELETE FROM files; DELETE FROM agents; DELETE FROM reviews; DELETE FROM fix_outcomes;`)
  const seen = db.prepare(`SELECT mtime, size FROM files WHERE path = ?`)
  const mark = db.prepare(`INSERT OR REPLACE INTO files VALUES (?,?,?)`)
  const upA = db.prepare(`INSERT OR REPLACE INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const labelOf = db.prepare(`SELECT agent_id, label FROM agents WHERE run_id = ?`)
  let agents = 0, journals = 0
  const pendingJournals = []
  db.exec('BEGIN')
  try {
    for (const { file, project, session } of candidates()) {
      let st
      try { st = fs.statSync(file) } catch { continue }
      const prev = seen.get(file)
      if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) continue
      const dir = path.basename(path.dirname(file))
      const runId = /^wf_/.test(dir) ? dir : null
      if (path.basename(file) === 'journal.jsonl') { pendingJournals.push({ file, runId, st }); continue }
      const agentId = path.basename(file, '.jsonl').replace(/^agent-/, '')
      let meta = {}
      try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch {}
      const label = meta.description || null
      const { chunk, role, lens } = parseLabel(label, meta.agentType)
      const a = readAgent(file)
      // An agent that died before its first model reply has no model and costs nothing worth logging.
      if (!a.messages || !a.model) { mark.run(file, st.mtimeMs, st.size); continue }
      upA.run(agentId, project, session, runId, label, chunk, role, lens, meta.agentType || null, a.model, tier(a.model),
        a.started, a.ended, a.messages, a.input, a.output, a.cache_read, a.cache_write_5m, a.cache_write_1h, a.cost, a.baseline,
        priceFor(a.model)?.as ?? null)
      mark.run(file, st.mtimeMs, st.size)
      agents++
    }
    // Journals after agents, so a result can be matched to the label its agent's meta carries.
    for (const { file, runId, st } of pendingJournals) {
      const labels = new Map(labelOf.all(runId).map(r => [r.agent_id, r.label]))
      readJournal(db, file, runId, labels)
      mark.run(file, st.mtimeMs, st.size)
      journals++
    }
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return { agents, journals }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const db = openDb()
  const t0 = performance.now()
  const r = ingest(db, { rebuild: process.argv.includes('--rebuild') })
  const u = ingestUsage(db, { rebuild: process.argv.includes('--rebuild') })
  console.log(`usage: read new lines from ${u.files} transcripts`)
  const s = db.prepare(`SELECT tier, COUNT(*) n, SUM(cost_usd) cost, SUM(baseline_usd) base FROM agents GROUP BY tier`).all()
  console.log(`ingested ${r.agents} agent transcripts and ${r.journals} journals in ${Math.round(performance.now() - t0)} ms`)
  for (const x of s) console.log(`  ${x.tier.padEnd(7)} ${String(x.n).padStart(5)} agents  $${(x.cost ?? 0).toFixed(2)}  (at Opus prices $${(x.base ?? 0).toFixed(2)})`)
}
