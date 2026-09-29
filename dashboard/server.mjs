// Serves Boost's own dashboard with the model-routing and skill-router cards added under "Tokens Saved".
// Boost's binary and its page are untouched: this proxies every request to the running
// `boost ui` server and injects scripts into the HTML, so a Boost update cannot erase them.
// It also watches for `boost ui` starting and opens this page when it does.
//
//   node server.mjs            http://127.0.0.1:56300/
//   ROUTING_PORT=... BOOST_URL=http://127.0.0.1:NNNNN JEV_INTERVAL_MS=... node server.mjs
//   ROUTING_NO_OPEN=1          do not open a browser tab when Boost starts

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, execFile } from 'node:child_process'
import { openDb, ingest, ingestUsage, tier, priceFor } from './ingest.mjs'
import os from 'node:os'
import { evaluate, windowed, lastSnapshot } from './jev.mjs'
import { readToggles, setToggle } from './toggles.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PORT = Number(process.env.ROUTING_PORT || 56300)
// The skill-router card's numbers: jev.mjs re-reads changed transcripts on a timer (incremental, cached
// in data/), and a period is a filter over its last parse, so a request never waits on a full scan.
const JEV_INTERVAL_MS = Number(process.env.JEV_INTERVAL_MS || 5 * 60_000)
let jevSnap = lastSnapshot(), jevError = null, jevRun = null
let jevAt = 0
function jevRefresh() {
  return jevRun ||= evaluate()
    .then(s => { jevSnap = s; jevError = null; jevAt = Date.now() })
    .catch(e => { jevError = String(e?.stack || e); log(`skill-router evaluation failed: ${jevError.split('\n')[0]}`) })
    .finally(() => { jevRun = null })
}
const db = openDb()
let lastIngest = 0

// `boost ui` picks a new port each launch; find it by asking which of boost.exe's listening
// ports answers Boost's own API.
let boostUrl = process.env.BOOST_URL || null
async function discoverBoost() {
  if (process.env.BOOST_URL) return process.env.BOOST_URL
  try {
    const pids = new Set(execFileSync('tasklist', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq boost.exe'], { encoding: 'utf8' })
      .split('\n').map(l => l.split('","')[1]).filter(Boolean))
    const ports = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' }).split('\n')
      .map(l => l.trim().split(/\s+/))
      .filter(c => c[3] === 'LISTENING' && pids.has(c[4]) && c[1].startsWith('127.0.0.1:'))
      .map(c => c[1].split(':')[1])
    for (const port of ports) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/feature-flags`, { signal: AbortSignal.timeout(800) })
        if (r.ok) return `http://127.0.0.1:${port}`
      } catch {}
    }
  } catch {}
  return null
}

function refresh() {
  if (Date.now() - lastIngest > 8_000) { ingest(db); lastIngest = Date.now() }
}

// The Agent usage pane: every assistant message of every transcript, bucketed like Boost's own chart —
// one bar per local day from `days` days ago to today (Boost's /api/savings-timeline does the same: 7 days
// is 8 bars, and 24 hours is yesterday and today) — and split by model tier and kind.
let lastUsageIngest = 0
const KINDS = ['chat', 'subagent', 'workflow']
const pad2 = n => String(n).padStart(2, '0')
const localDay = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
function usage(days) {
  if (Date.now() - lastUsageIngest > 8_000) { ingestUsage(db); lastUsageIngest = Date.now() }
  const hourly = false
  const now = new Date()
  let start
  if (days > 0) { start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days) }
  const since = start ? start.toISOString().slice(0, 13) : '0000'
  const rows = db.prepare(`SELECT hour, model, kind, effort, SUM(messages) messages, SUM(input) input, SUM(output) output,
      SUM(cache_read) cache_read, SUM(cache_write_5m + cache_write_1h) cache_write, SUM(cost_usd) cost, SUM(unpriced) unpriced
    FROM usage WHERE hour >= ? GROUP BY hour, model, kind, effort`).all(since)
  if (!start) start = rows.length ? new Date(rows.reduce((m, r) => r.hour < m ? r.hour : m, '9999') + ':00:00Z') : new Date(now)
  if (!hourly) start.setHours(0, 0, 0, 0)

  // Every bucket from start to now, empty ones included, as Boost's chart does.
  const keyOf = d => hourly ? `${localDay(d)}T${pad2(d.getHours())}` : localDay(d)
  const buckets = new Map()
  for (const d = new Date(start); d <= now; hourly ? d.setHours(d.getHours() + 1) : d.setDate(d.getDate() + 1)) {
    buckets.set(keyOf(d), { key: keyOf(d), cells: {} })
  }
  const blank = () => ({ tokens: 0, cost: 0, messages: 0 })
  const totals = { tokens: 0, cost: 0, messages: 0, unpriced: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, byTier: {}, byKind: {} }
  for (const k of KINDS) totals.byKind[k] = blank()
  for (const r of rows) {
    const b = buckets.get(keyOf(new Date(r.hour + ':00:00Z')))
    if (!b) continue
    const t = tier(r.model), tokens = r.input + r.output + r.cache_read + r.cache_write
    const cell = (b.cells[t] ||= {})[r.kind] ||= blank()
    cell.tokens += tokens; cell.cost += r.cost; cell.messages += r.messages
    totals.tokens += tokens; totals.cost += r.cost; totals.messages += r.messages; totals.unpriced += r.unpriced
    for (const f of ['input', 'output', 'cache_read', 'cache_write']) totals[f] += r[f]
    const bt = totals.byTier[t] ||= blank(); bt.tokens += tokens; bt.cost += r.cost; bt.messages += r.messages
    const bk = totals.byKind[r.kind]; bk.tokens += tokens; bk.cost += r.cost; bk.messages += r.messages
    const ek = r.effort || '(unknown)'
    const be = (totals.byEffort ||= {})[ek] ||= blank(); be.tokens += tokens; be.cost += r.cost; be.messages += r.messages
    const bb = (b.effort ||= {})[ek] ||= blank(); bb.tokens += tokens; bb.cost += r.cost; bb.messages += r.messages
  }
  return { days, hourly, generated: now.toISOString(), totals, buckets: [...buckets.values()] }
}

// The effort sessions run at unless told otherwise: what "saved by lowering effort" is measured against.
const BASE_EFFORT = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).effortLevel || 'xhigh' } catch { return 'xhigh' }
})()
// Average output tokens per agent at the baseline effort, over all history: by role, lens and model tier,
// and by role and lens alone as a fallback. Only groups of 3+ agents count as a reference.
function effortReference() {
  const rows = db.prepare(`SELECT role, lens, tier, COUNT(*) n, AVG(output) out FROM agents WHERE effort = ? GROUP BY role, lens, tier`).all(BASE_EFFORT)
  const byTier = new Map(), byRole = new Map()
  for (const r of rows) {
    if (r.n >= 3) byTier.set(`${r.role}|${r.lens || ''}|${r.tier}`, r.out)
    const k = `${r.role}|${r.lens || ''}`, x = byRole.get(k) || { n: 0, sum: 0 }
    x.n += r.n; x.sum += r.out * r.n; byRole.set(k, x)
  }
  return { byTier, byRole: new Map([...byRole].filter(([, x]) => x.n >= 3).map(([k, x]) => [k, x.sum / x.n])) }
}
function effortSaving(a, ref) {
  if (!a.effort || a.effort === BASE_EFFORT) return null
  const out = ref.byTier.get(`${a.role}|${a.lens || ''}|${a.tier}`) ?? ref.byRole.get(`${a.role}|${a.lens || ''}`)
  const rate = priceFor(a.model)?.price?.output_cost_per_token
  if (out == null || !rate) return null
  return (out - a.output) * rate
}

// The configured rules, for the Role → model table: templates/route.js's ROUTES, read from the file each
// time so an edit shows at once. Per role key ("impl", "fix", "review:spec") every distinct
// { model, effort } across lanes, with the lanes that set it. A running script keeps its own copy.
function routeRules() {
  try {
    const src = fs.readFileSync(path.join(HERE, '..', 'templates', 'route.js'), 'utf8')
    const m = /const ROUTES = (\{[\s\S]*?\n\})\n/.exec(src)
    const ROUTES = new Function(`return ${m[1]}`)()   // our own file, an object literal
    const rules = {}
    for (const [lane, roles] of Object.entries(ROUTES)) for (const [key, r] of Object.entries(roles)) {
      const k = `${r.model}|${r.effort || ''}`
      const list = rules[key] ||= []
      const hit = list.find(x => x.k === k)
      if (hit) hit.lanes.push(lane); else list.push({ k, model: r.model, effort: r.effort || null, lanes: [lane] })
    }
    return rules
  } catch { return {} }
}

function summary(days) {
  refresh()
  const since = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : '0000'
  const rows = db.prepare(`SELECT * FROM agents WHERE started >= ? ORDER BY started`).all(since)
  const tiers = ['opus', 'sonnet', 'haiku', 'fable', 'other']
  const blank = () => Object.fromEntries(tiers.map(t => [t, 0]))
  const tot = { cost: 0, baseline: 0, agents: rows.length, unpriced: 0, byTier: {}, byEffort: {},
    effortSaved: 0, effortEstimated: 0, effortUnestimated: 0, baselineEffort: BASE_EFFORT }
  for (const t of tiers) tot.byTier[t] = { agents: 0, cost: 0, tokens: 0 }
  const days_ = new Map(), roles = new Map(), pricedAs = new Map()
  const ref = effortReference()
  for (const a of rows) {
    const cost = a.cost_usd ?? 0
    if (a.cost_usd == null) tot.unpriced++
    tot.cost += cost; tot.baseline += a.baseline_usd ?? 0
    const b = tot.byTier[a.tier]
    b.agents++; b.cost += cost
    b.tokens += a.input + a.output + a.cache_read + a.cache_write_5m + a.cache_write_1h
    const d = (a.started || '').slice(0, 10)
    if (!days_.has(d)) days_.set(d, { date: d, cost: blank(), base: blank(), agents: blank(), baseline: 0 })
    // base[tier]: that tier's tokens at Opus prices, so base - cost is what routing to it saved (or lost) that day.
    const dd = days_.get(d); dd.cost[a.tier] += cost; dd.base[a.tier] += a.baseline_usd ?? 0; dd.agents[a.tier]++; dd.baseline += a.baseline_usd ?? 0
    const eff = a.effort || '(unknown)'
    const be = tot.byEffort[eff] ||= { agents: 0, cost: 0, saved: 0 }
    be.agents++; be.cost += cost
    // Effort saving, estimated: this agent's output tokens (thinking included) against the average of the
    // same role at the baseline effort, priced at its model's output rate. Needs 3+ reference agents.
    const est = effortSaving(a, ref)
    if (est != null) { tot.effortSaved += est; tot.effortEstimated++; be.saved += est; dd.effort = (dd.effort || 0) + est }
    else if (a.effort && a.effort !== BASE_EFFORT) tot.effortUnestimated++
    const rk = `${a.role}\u0000${a.lens || ''}\u0000${a.tier}\u0000${eff}`
    if (!roles.has(rk)) roles.set(rk, { role: a.role, lens: a.lens, tier: a.tier, effort: a.effort, agents: 0, cost: 0, output: 0, effortSaved: 0 })
    const r = roles.get(rk); r.agents++; r.cost += cost; r.output += a.output; if (est != null) r.effortSaved += est
    if (!r.last || a.started > r.last) r.last = a.started
    const bare = a.model.replace(/-\d{8}$/, '')
    if (a.priced_as && a.priced_as !== bare && a.priced_as !== a.model) pricedAs.set(a.model, a.priced_as)
  }

  // Review quality per lens and reviewer model: findings raised, and what the fixer made of them.
  const reviews = db.prepare(`SELECT r.*, a.tier, a.effort, a.started FROM reviews r JOIN agents a USING (agent_id) WHERE a.started >= ?`).all(since)
  const reviewer = new Map()   // latest reviewer of (run, chunk, lens) — a resumed run can hold two
  for (const r of reviews) {
    const k = `${r.run_id}|${r.chunk}|${r.lens}`
    if (!reviewer.has(k) || reviewer.get(k).started < r.started) reviewer.set(k, r)
  }
  const q = new Map()
  const qk = (lens, tier, effort) => {
    const k = `${lens}|${tier}|${effort || ''}`
    if (!q.has(k)) q.set(k, { lens, tier, effort, reviews: 0, findings: 0, blockers: 0, majors: 0, fixed: 0, rejected: 0 })
    return q.get(k)
  }
  for (const r of reviewer.values()) {
    const x = qk(r.lens, r.tier, r.effort)
    x.reviews++; x.findings += r.findings; x.blockers += r.blockers; x.majors += r.majors
  }
  const outcomes = db.prepare(`SELECT f.* FROM fix_outcomes f JOIN agents a USING (agent_id) WHERE a.started >= ? AND f.lens IS NOT NULL`).all(since)
  for (const f of outcomes) {
    const r = reviewer.get(`${f.run_id}|${f.chunk}|${f.lens}`)
    if (r) qk(f.lens, r.tier, r.effort)[f.outcome] += f.n
  }

  const runs = db.prepare(`
    SELECT run_id, MIN(started) started, MAX(ended) ended, COUNT(*) agents, SUM(cost_usd) cost, SUM(baseline_usd) baseline,
      SUM(tier = 'opus') opus, SUM(tier = 'sonnet') sonnet, SUM(tier = 'haiku') haiku
    FROM agents WHERE run_id IS NOT NULL AND started >= ? GROUP BY run_id ORDER BY started DESC LIMIT 8`).all(since)

  return {
    days, generated: new Date().toISOString(), totals: tot,
    timeline: [...days_.values()].sort((a, b) => a.date.localeCompare(b.date)),
    roles: [...roles.values()].sort((a, b) => b.cost - a.cost),
    quality: [...q.values()].sort((a, b) => a.lens.localeCompare(b.lens) || a.tier.localeCompare(b.tier)),
    runs, pricedAs: Object.fromEntries(pricedAs), rules: routeRules(),
  }
}

async function proxy(req, res) {
  boostUrl ||= await discoverBoost()
  if (!boostUrl) {
    res.writeHead(502, { 'content-type': 'text/plain' })
    return res.end('Boost dashboard not found. Run `boost ui` once, then reload.')
  }
  const target = new URL(req.url, boostUrl)
  const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' }
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c))) })
  let up
  try {
    up = await fetch(target, { method: req.method, headers, body, redirect: 'manual' })
  } catch {
    boostUrl = null   // `boost ui` restarted on another port; find it on the next request
    res.writeHead(502, { 'content-type': 'text/plain' })
    return res.end('Boost dashboard stopped answering. Reload to reconnect.')
  }
  const out = {}
  up.headers.forEach((v, k) => { if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(k)) out[k] = v })
  const type = up.headers.get('content-type') || ''
  let buf = Buffer.from(await up.arrayBuffer())
  if (type.includes('text/html')) {
    let html = buf.toString('utf8')
    // period.js first and classic, so it wraps fetch before Boost's own modules make their first request.
    const head = '<script src="/__routing/period.js"></script>'
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + head) : head + html
    const tags = '<script type="module" src="/__routing/usage-panel.js"></script><script type="module" src="/__routing/panel.js"></script><script type="module" src="/__routing/jev-panel.js"></script>'
    buf = Buffer.from(html.includes('</body>') ? html.replace('</body>', tags + '</body>') : html + tags)
  }
  res.writeHead(up.status, out)
  res.end(buf)
}

// The skill-router snapshot, all time or for Boost's period (?days=N, sessions active in the window).
// An evaluation error becomes JSON the card shows; it never reaches Boost's page.
async function jevSnapshot(u) {
  // The cards poll every 10 s; a warm evaluation re-reads only changed transcripts (~0.3 s), so a
  // snapshot older than 10 s is refreshed on the request that finds it.
  if (!jevSnap || u.searchParams.has('fresh') || Date.now() - jevAt > 10_000) await jevRefresh()
  const days = Number(u.searchParams.get('days') || 0)
  let view = jevSnap
  if (days > 0) {
    view = windowed(jevSnap, days)
    // A snapshot read from disk at startup has no parsed sessions behind it until the first evaluation.
    if (!view) { await jevRefresh(); view = windowed(jevSnap, days) }
  }
  return view || { error: jevError || 'no evaluation yet' }
}

// Start with Boost: `boost ui` is started by hand and takes a new port each time. Poll for it, and
// when a Boost dashboard appears on a port not seen before, open this page once. Whatever is
// already running when this server starts (at logon, or a restart) is adopted without opening.
let watchedPort = undefined
// The task runs hidden, so stdout goes nowhere; Boost comings and goings are kept in server.log.
function log(line) {
  const stamped = `${new Date().toISOString()}  ${line}\n`
  process.stdout.write(stamped)
  try {
    const file = path.join(HERE, 'server.log')
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.renameSync(file, file + '.1')
    fs.appendFileSync(file, stamped)
  } catch {}
}
async function watchBoost() {
  const url = process.env.BOOST_URL ? null : await discoverBoost()
  const port = url ? new URL(url).port : null
  if (port !== watchedPort) {
    if (!process.env.BOOST_URL) boostUrl = url
    if (port && watchedPort !== undefined && !process.env.ROUTING_NO_OPEN) {
      execFile('rundll32', ['url.dll,FileProtocolHandler', `http://127.0.0.1:${PORT}/`], () => {})
      log(`boost ui appeared on ${port}; opened the combined page`)
    } else {
      log(port ? `adopted boost ui on ${port}` : 'boost ui is not running')
    }
    watchedPort = port
  }
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/__routing/api/toggles') {
      const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
      if (req.method === 'GET') return json(200, readToggles())
      // These change ~/.claude, so only this page may call them: the right Host (no DNS rebinding), a
      // same-origin Origin, and a custom header a cross-origin page cannot send without a preflight,
      // which this server never answers.
      const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]
      if (req.method !== 'POST' || !origins.includes(`http://${req.headers.host}`) || (req.headers.origin && !origins.includes(req.headers.origin)) || req.headers['x-agent-ops'] !== '1') {
        return json(403, { error: 'refused' })
      }
      const body = await new Promise(r => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())) })
      try {
        const { feature, on } = JSON.parse(body)
        const state = setToggle(feature, !!on)
        log(`switched ${feature} ${on ? 'on' : 'off'}`)
        return json(200, state)
      } catch (e) { return json(400, { error: String(e.message || e) }) }
    }
    if (u.pathname === '/__routing/api/usage') {
      const days = Math.max(0, Number(u.searchParams.get('days') ?? 30) || 0)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(usage(days)))
    }
    if (['/__routing/panel.js', '/__routing/period.js', '/__routing/jev-panel.js', '/__routing/usage-panel.js'].includes(u.pathname)) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(path.join(HERE, path.basename(u.pathname))))
    }
    if (u.pathname === '/__routing/api/jev') {
      const body = await jevSnapshot(u)
      res.writeHead(body.error ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(body))
    }
    if (u.pathname === '/__routing/api/summary') {
      const days = Math.max(0, Number(u.searchParams.get('days') ?? 30) || 0)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(summary(days)))
    }
    await proxy(req, res)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(e && e.stack || e))
  }
}).on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is already in use — another copy is probably running` : e.message)
  process.exit(1)
}).listen(PORT, '127.0.0.1', async () => {
  await watchBoost()
  console.log(`agent-ops dashboard on http://127.0.0.1:${PORT}/  (Boost at ${boostUrl || 'not found yet'})`)
  setInterval(() => watchBoost().catch(() => {}), 5_000)
  jevRefresh()
  setInterval(jevRefresh, JEV_INTERVAL_MS).unref?.()
})
