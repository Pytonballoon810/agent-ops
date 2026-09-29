// Serves Boost's own dashboard with a model-routing panel added under "Tokens Saved".
// Boost's binary and its page are untouched: this proxies every request to the running
// `boost ui` server and injects one <script> into the HTML, so a Boost update cannot erase it.
//
//   node server.mjs            http://127.0.0.1:56300/
//   ROUTING_PORT=... BOOST_URL=http://127.0.0.1:NNNNN node server.mjs

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { openDb, ingest } from './ingest.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PORT = Number(process.env.ROUTING_PORT || 56300)
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
  if (Date.now() - lastIngest > 20_000) { ingest(db); lastIngest = Date.now() }
}

function summary(days) {
  refresh()
  const since = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString() : '0000'
  const rows = db.prepare(`SELECT * FROM agents WHERE started >= ? ORDER BY started`).all(since)
  const tiers = ['opus', 'sonnet', 'haiku', 'fable', 'other']
  const blank = () => Object.fromEntries(tiers.map(t => [t, 0]))
  const tot = { cost: 0, baseline: 0, agents: rows.length, unpriced: 0, byTier: {} }
  for (const t of tiers) tot.byTier[t] = { agents: 0, cost: 0, tokens: 0 }
  const days_ = new Map(), roles = new Map(), pricedAs = new Map()
  for (const a of rows) {
    const cost = a.cost_usd ?? 0
    if (a.cost_usd == null) tot.unpriced++
    tot.cost += cost; tot.baseline += a.baseline_usd ?? 0
    const b = tot.byTier[a.tier]
    b.agents++; b.cost += cost
    b.tokens += a.input + a.output + a.cache_read + a.cache_write_5m + a.cache_write_1h
    const d = (a.started || '').slice(0, 10)
    if (!days_.has(d)) days_.set(d, { date: d, cost: blank(), agents: blank(), baseline: 0 })
    const dd = days_.get(d); dd.cost[a.tier] += cost; dd.agents[a.tier]++; dd.baseline += a.baseline_usd ?? 0
    const rk = `${a.role}\u0000${a.lens || ''}\u0000${a.tier}`
    if (!roles.has(rk)) roles.set(rk, { role: a.role, lens: a.lens, tier: a.tier, agents: 0, cost: 0, output: 0 })
    const r = roles.get(rk); r.agents++; r.cost += cost; r.output += a.output
    const bare = a.model.replace(/-\d{8}$/, '')
    if (a.priced_as && a.priced_as !== bare && a.priced_as !== a.model) pricedAs.set(a.model, a.priced_as)
  }

  // Review quality per lens and reviewer model: findings raised, and what the fixer made of them.
  const reviews = db.prepare(`SELECT r.*, a.tier, a.started FROM reviews r JOIN agents a USING (agent_id) WHERE a.started >= ?`).all(since)
  const reviewer = new Map()   // latest reviewer of (run, chunk, lens) — a resumed run can hold two
  for (const r of reviews) {
    const k = `${r.run_id}|${r.chunk}|${r.lens}`
    if (!reviewer.has(k) || reviewer.get(k).started < r.started) reviewer.set(k, r)
  }
  const q = new Map()
  const qk = (lens, tier) => {
    const k = `${lens}|${tier}`
    if (!q.has(k)) q.set(k, { lens, tier, reviews: 0, findings: 0, blockers: 0, majors: 0, fixed: 0, rejected: 0 })
    return q.get(k)
  }
  for (const r of reviewer.values()) {
    const x = qk(r.lens, r.tier)
    x.reviews++; x.findings += r.findings; x.blockers += r.blockers; x.majors += r.majors
  }
  const outcomes = db.prepare(`SELECT f.* FROM fix_outcomes f JOIN agents a USING (agent_id) WHERE a.started >= ? AND f.lens IS NOT NULL`).all(since)
  for (const f of outcomes) {
    const r = reviewer.get(`${f.run_id}|${f.chunk}|${f.lens}`)
    if (r) qk(f.lens, r.tier)[f.outcome] += f.n
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
    runs, pricedAs: Object.fromEntries(pricedAs),
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
    const html = buf.toString('utf8')
    const tag = '<script type="module" src="/__routing/panel.js"></script>'
    buf = Buffer.from(html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag)
  }
  res.writeHead(up.status, out)
  res.end(buf)
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/__routing/panel.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(path.join(HERE, 'panel.js')))
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
}).listen(PORT, '127.0.0.1', async () => {
  boostUrl ||= await discoverBoost()
  console.log(`model-routing dashboard on http://127.0.0.1:${PORT}/  (Boost at ${boostUrl || 'not found yet'})`)
})
