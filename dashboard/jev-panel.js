// The skill-router card: what the jev-skill-suggestion mod does to sessions, from jev.mjs via
// /__routing/api/jev. Injected by server.mjs below the model-routing card; follows Boost's period
// through period.js (window.__boostPeriod and the `boost-period` event).

const ID = 'jev-meter'
const API = '/__routing/api/jev'
let days = window.__boostPeriod?.days ?? 30
let data = null, failure = null, loading = true

const css = `
#${ID} { --jm-dim: rgba(255,255,255,.55); --jm-faint: rgba(255,255,255,.08); --jm-accent: #d2a8ff; --jm-good: #3fb950; --jm-bad: #f85149; --jm-warn: #d29922; color: #fff; }
#${ID} .jm-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
#${ID} .jm-big { font-size:44px; font-weight:500; line-height:1; letter-spacing:-.02em; }
#${ID} .jm-big small { font-size:17px; color:#fff; font-weight:400; letter-spacing:0; margin-left:8px; }
#${ID} .jm-sub { color:var(--jm-dim); font-size:12px; }
#${ID} .jm-grid { display:grid; grid-template-columns: minmax(0,1.2fr) minmax(0,1fr); gap:24px; margin-top:20px; }
@media (max-width: 760px) { #${ID} .jm-grid { grid-template-columns: minmax(0,1fr); } }
#${ID} h3 { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--jm-dim); margin:0 0 10px; font-weight:600; }
#${ID} table { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric: tabular-nums; }
#${ID} th { text-align:left; color:var(--jm-dim); font-weight:500; padding:4px 6px; border-bottom:1px solid var(--jm-faint); }
#${ID} td { padding:4px 6px; border-bottom:1px solid rgba(255,255,255,.04); }
#${ID} td.n, #${ID} th.n { text-align:right; }
#${ID} .jm-checks { list-style:none; margin:0; padding:0; font-size:12px; }
#${ID} .jm-checks li { display:flex; gap:8px; align-items:baseline; padding:3px 0; }
#${ID} .jm-dot { flex:none; width:8px; height:8px; border-radius:50%; transform:translateY(1px); }
#${ID} .jm-stats { display:flex; gap:18px; flex-wrap:wrap; margin-top:14px; font-size:12px; color:var(--jm-dim); }
#${ID} .jm-stats b { color:#fff; font-weight:500; margin-right:4px; font-variant-numeric: tabular-nums; }
#${ID} .jm-note { margin-top:16px; font-size:11px; color:var(--jm-dim); line-height:1.5; }
#${ID} a { color:var(--jm-accent); text-decoration:none; }
#${ID} a:hover { text-decoration:underline; }
#${ID} code { font-size:11px; background:var(--jm-faint); padding:1px 5px; border-radius:4px; }
/* Loading skeleton, as Boost's own panes do it: the pane pulses (Tailwind's animate-pulse) with bars where content goes. */
@keyframes ${ID}-pulse { 50% { opacity:.5 } }
#${ID}[aria-busy="true"] { animation: ${ID}-pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
@media (prefers-reduced-motion: reduce) { #${ID}[aria-busy="true"] { animation:none; } }
#${ID} .jm-sk { background: rgba(255,255,255,.1); border-radius:4px; max-width:100%; }
`

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const kfmt = v => { const a = Math.abs(v || 0), s = v < 0 ? '−' : ''; return s + (a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}K` : String(a)) }
const period = d => d ? (d === 1 ? 'past 24 hours' : `past ${d} days`) : 'all time'
const LEVEL = { fail: ['var(--jm-bad)', 0], warn: ['var(--jm-warn)', 1], pass: ['var(--jm-good)', 2] }
const when = ts => { const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }

function heading() {
  return `<h2 class="report-section-heading" style="color:var(--jm-accent)">Skill router</h2>`
}

function body() {
  if (failure) return `${heading()}<p class="jm-sub" style="margin-top:12px">The skill-router numbers did not load: ${esc(failure.error)}</p>`

  const T = data.totals
  if (!T.sessions) return `${heading()}<p class="jm-sub" style="margin-top:12px">No sessions with the mod in the ${period(days)}.</p>`

  const good = T.net >= 0
  const checks = [...(data.checks || [])].sort((a, b) => (LEVEL[a.level]?.[1] ?? 1) - (LEVEL[b.level]?.[1] ?? 1))
    .map(c => `<li title="${esc(c.detail)}"><span class="jm-dot" style="background:${(LEVEL[c.level] || LEVEL.warn)[0]}"></span><span>${esc(c.label)}</span></li>`).join('')

  const skills = [...(data.skills || [])].filter(s => s.suggested || s.called)
    .sort((a, b) => b.suggested - a.suggested || b.called - a.called).slice(0, 8)
    .map(s => `<tr><td>${esc(s.skill)}</td><td class="n">${s.suggested}</td><td class="n">${s.injected}</td><td class="n">${s.called}</td><td class="jm-sub">${esc(s.state)}</td></tr>`).join('')

  const picks = (data.picks || []).slice(0, 5)
    .map(p => `<tr title="${esc(String(p.prompt || '').slice(0, 80))}"><td class="jm-sub">${esc(when(p.ts))}</td><td>${esc(p.skill)}</td><td class="jm-sub">${esc(p.project)}</td></tr>`).join('')

  const c = data.config || {}
  const cfg = `${esc(c.model || '?')} via ${esc(c.provider || '?')} · listing ${c.hideListing ? 'withheld' : 'shown'} · inject ${esc(c.inject || '?')}`
  const worst = T.worstSession && T.worstSession.net < 0 ? ` · worst ${kfmt(T.worstSession.net)} in ${esc(T.worstSession.project)} (${T.worstSession.turns} turns)` : ''

  return `
    <div class="jm-head">
      <div>
        ${heading()}
        <div class="jm-big" style="margin-top:12px;color:${good ? 'var(--jm-good)' : 'var(--jm-bad)'}">${kfmt(T.net)}<small>prefix tokens ${good ? 'saved' : 'lost'} by the skill router</small></div>
      </div>
      <div class="jm-sub" style="text-align:right">withheld listings ${kfmt(T.listingValue)} − injected skills ${kfmt(T.injectionCost)} · estimated<br>${period(days)} · ${T.sessions} sessions (${T.sessionsPositive} ahead, ${T.sessionsNegative} behind)${worst}</div>
    </div>
    <div class="jm-stats">
      <span><b>${T.prompts}</b>prompts</span><span><b>${T.suggestions}</b>suggestions</span>
      <span><b>${T.promptsWithoutSuggestion}</b>without one</span><span><b>${T.skillToolCalls}</b>Skill-tool calls</span>
      <span><b>${T.refusals}</b>refusals</span>
    </div>
    <div class="jm-grid">
      <div>
        <h3>Top skills</h3>
        <table><thead><tr><th>Skill</th><th class="n">Offered</th><th class="n">Injected</th><th class="n">Called</th><th>State</th></tr></thead>
        <tbody>${skills || '<tr><td colspan="5" class="jm-sub">No skill offered or called in this period.</td></tr>'}</tbody></table>
        <h3 style="margin-top:20px">Recent picks</h3>
        <table><thead><tr><th>When</th><th>Skill</th><th>Project</th></tr></thead>
        <tbody>${picks || '<tr><td colspan="3" class="jm-sub">None in this period.</td></tr>'}</tbody></table>
      </div>
      <div>
        <h3>Health (now)</h3>
        <ul class="jm-checks">${checks}</ul>
        <h3 style="margin-top:20px">Configuration (now)</h3>
        <div class="jm-sub">${cfg}</div>
      </div>
    </div>
    <div class="jm-note">
      Token figures are estimated from characters (${esc(data.provenance?.estimated || '4 chars/token')}); counts are measured.
      A session active in this period is counted whole, including turns before it began. Health and configuration describe the present, not the period.
      Hover a pick for the start of its prompt. As of ${esc(when(data.generatedAt))}; re-read every 5 minutes.
    </div>`
}

const bar = (w, h, extra = '') => `<div class="jm-sk" style="width:${w};height:${h}px;${extra}"></div>`
const rows = n => Array.from({ length: n }, () => bar('100%', 14, 'margin-top:9px')).join('')
function skeleton() {
  return `
    <div class="jm-head">
      <div>${bar('112px', 12)}${bar('240px', 40, 'margin-top:16px')}</div>
      <div>${bar('260px', 12)}${bar('200px', 12, 'margin:6px 0 0 auto')}</div>
    </div>
    <div class="jm-stats">${[60, 80, 70, 90, 60].map(w => bar(`${w}px`, 12)).join('')}</div>
    <div class="jm-grid">
      <div>${bar('90px', 11)}${rows(8)}${bar('100px', 11, 'margin-top:30px')}${rows(5)}</div>
      <div>${bar('100px', 11)}${Array.from({ length: 6 }, () => bar('75%', 12, 'margin-top:10px')).join('')}${bar('150px', 11, 'margin-top:30px')}${bar('90%', 12, 'margin-top:12px')}</div>
    </div>`
}

function render() {
  const el = ensureMounted()
  if (!el) return
  if (loading && !failure) {
    el.setAttribute('aria-busy', 'true')
    el.setAttribute('aria-label', 'Loading skill router')
    el.innerHTML = skeleton()
    return
  }
  el.removeAttribute('aria-busy')
  el.removeAttribute('aria-label')
  el.innerHTML = body()
}

// Boost's Tokens Saved pane, loaded or still its own skeleton (which has no text, only an aria-label).
function tokensPane(main) {
  return [...main.querySelectorAll(':scope > section')].find(s => /Tokens Saved/i.test(s.textContent || '') || /tokens saved/i.test(s.getAttribute('aria-label') || ''))
}
// Look like Boost's pane, but never inherit its skeleton's pulse: the card pulses on its own aria-busy.
const paneClass = anchor => anchor.className.split(/\s+/).filter(c => c && c !== 'animate-pulse').join(' ')

function ensureMounted() {
  const main = document.querySelector('main')
  if (!main) return null
  const tokens = tokensPane(main)
  let el = document.getElementById(ID)
  if (el && el.isConnected) {
    if (tokens) el.className = paneClass(tokens)
    return el
  }
  const routing = document.getElementById('model-routing')
  const anchor = routing && routing.isConnected ? routing : tokens
  if (!anchor) return null
  if (!document.getElementById(ID + '-css')) {
    const st = document.createElement('style'); st.id = ID + '-css'; st.textContent = css; document.head.appendChild(st)
  }
  el = document.createElement('section')
  el.id = ID
  el.className = paneClass(tokens || anchor)
  anchor.after(el)
  return el
}

// `skeleton` is for a first load and a period change, as Boost does; the minute refresh swaps in quietly.
async function load(skeleton = false) {
  const asked = days
  if (skeleton) { loading = true; failure = null; render() }
  try {
    const r = await fetch(days ? `${API}?days=${days}` : API)
    const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }))
    if (asked !== days) return   // the period changed while this was in flight
    if (r.ok) { data = j; failure = null } else { failure = j; data = null }
  } catch (e) {
    failure = { error: String(e) }
  }
  loading = false
  render()
}

window.addEventListener('boost-period', e => { days = e.detail.days; load(true) })

// Mount as soon as Boost's Tokens Saved pane exists (showing the skeleton until data arrives), and put the
// card back when React re-renders the page and drops a node it does not own.
new MutationObserver(() => { if (!document.getElementById(ID)) render() })
  .observe(document.body, { childList: true, subtree: true })

load(true)
setInterval(() => load(false), 60_000)
