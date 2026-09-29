// The model-routing card, injected into Boost's dashboard under "Tokens Saved".
// It follows Boost's own period selector through period.js (window.__boostPeriod, `boost-period`).

const ID = 'model-routing'
const TIERS = [
  { key: 'opus', name: 'Opus', color: '#f0883e' },
  { key: 'sonnet', name: 'Sonnet', color: '#58a6ff' },
  { key: 'haiku', name: 'Haiku', color: '#56d4dd' },
  { key: 'fable', name: 'Fable', color: '#d2a8ff' },
]
let days = window.__boostPeriod?.days ?? 30
let data = null, boostTotals = null, loading = true, failure = null, lastSig = ''
const ops = window.__agentOps

const css = `
#${ID} { --mr-dim: rgba(255,255,255,.55); --mr-faint: rgba(255,255,255,.08); --mr-accent: #f0883e; color: #fff; }
#${ID} .mr-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; flex-wrap:wrap; }
#${ID} .mr-big { font-size:44px; font-weight:500; color:var(--mr-accent); line-height:1; letter-spacing:-.02em; }
#${ID} .mr-big small { font-size:17px; color:#fff; font-weight:400; letter-spacing:0; margin-left:8px; }
#${ID} .mr-sub { color:var(--mr-dim); font-size:12px; }
#${ID} .mr-grid { display:grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr); gap:24px; margin-top:20px; }
@media (max-width: 760px) { #${ID} .mr-grid { grid-template-columns: minmax(0,1fr); } }
#${ID} h3 { font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mr-dim); margin:0 0 10px; font-weight:600; }
#${ID} .mr-split { display:flex; height:10px; border-radius:5px; overflow:hidden; background:var(--mr-faint); }
#${ID} .mr-legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:var(--mr-dim); }
#${ID} .mr-legend i { display:inline-block; width:8px; height:8px; border-radius:2px; margin-right:6px; vertical-align:middle; }
#${ID} .mr-legend b { color:#fff; font-weight:500; margin-left:4px; }
#${ID} table { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric: tabular-nums; }
#${ID} th { text-align:left; color:var(--mr-dim); font-weight:500; padding:4px 6px; border-bottom:1px solid var(--mr-faint); }
#${ID} td { padding:4px 6px; border-bottom:1px solid rgba(255,255,255,.04); }
#${ID} td.n, #${ID} th.n { text-align:right; }
#${ID} .mr-pill { display:inline-block; padding:0 6px; border-radius:4px; font-size:11px; }
#${ID} .mr-note { margin-top:16px; font-size:11px; color:var(--mr-dim); line-height:1.5; }
#${ID} .mr-scroll { max-height: 260px; overflow:auto; }
#${ID} .mr-col { transition: opacity .12s ease-out; }
#${ID} .mr-chart:hover .mr-col:not(.mr-on) { opacity:.4; }
#${ID} .mr-split:hover .mr-seg:not(.mr-on) { opacity:.45; }
#${ID} .mr-seg { transition: opacity .12s ease-out; }
/* Loading skeleton, as Boost's own panes do it: the pane pulses (Tailwind's animate-pulse) with bars where content goes. */
@keyframes ${ID}-pulse { 50% { opacity:.5 } }
#${ID}[aria-busy="true"] { animation: ${ID}-pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
@media (prefers-reduced-motion: reduce) { #${ID}[aria-busy="true"] { animation:none; } }
#${ID} code { font-size:11px; background:var(--mr-faint); padding:1px 5px; border-radius:4px; }
#${ID} .mr-sk { background: rgba(255,255,255,.1); border-radius:4px; max-width:100%; }
`

const usd = v => v >= 100 ? `$${Math.round(v).toLocaleString()}` : `$${(v || 0).toFixed(2)}`
const kfmt = v => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v)
const tierOf = k => TIERS.find(t => t.key === k) || { key: k, name: k, color: '#888' }
const pill = k => { const t = tierOf(k); return `<span class="mr-pill" style="background:${t.color}22;color:${t.color}">${t.name}</span>` }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function chart(timeline) {
  const W = 640, H = 150, pad = 18
  if (!timeline.length) return `<div class="mr-sub">No subagent runs in this period.</div>`
  const max = Math.max(...timeline.map(d => Math.max(d.baseline, TIERS.reduce((s, t) => s + (d.cost[t.key] || 0), 0))), 0.01)
  const bw = (W - 8) / timeline.length
  const bars = timeline.map((d, i) => {
    let y = H - pad, out = ''
    const x = 4 + i * bw + bw * 0.15, w = bw * 0.7
    for (const t of TIERS) {
      const h = ((d.cost[t.key] || 0) / max) * (H - pad - 8)
      if (h > 0) { y -= h; out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${t.color}" opacity=".85"/>` }
    }
    const by = H - pad - (d.baseline / max) * (H - pad - 8)
    out += `<line x1="${x - 2}" x2="${x + w + 2}" y1="${by}" y2="${by}" stroke="#fff" stroke-opacity=".6" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/>`
    // The whole column is the hover target, as in Boost's chart, so a thin bar is still easy to hit.
    out += `<rect class="mr-hit" x="${4 + i * bw}" y="0" width="${bw}" height="${H - pad}" fill="transparent"/>`
    return `<g class="mr-col" data-i="${i}" data-top="${Math.min(y, by)}">${out}</g>`
  }).join('')
  const first = timeline[0].date, last = timeline[timeline.length - 1].date
  // Labels are HTML beside the SVG: text inside a stretched viewBox stretches with it.
  return `<div class="mr-sub" style="margin-bottom:4px">${usd(max)}</div>
    <svg class="mr-chart" viewBox="0 0 ${W} ${H - pad}" width="100%" height="140" preserveAspectRatio="none" role="img" aria-label="Daily subagent spend by model">${bars}</svg>
    <div class="mr-sub" style="display:flex;justify-content:space-between;margin-top:4px"><span>${first}</span><span>${last}</span></div>`
}

// Tooltips reuse Boost's own classes (report-meter-tooltip, report-savings-tooltip) and the layout of
// its day tooltip: a date heading, one swatch row per series largest first, a ruled total, a running total.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dayName(iso) {   // Boost's own: "Sep 4", with the year only when it is not this one
  const [y, m, d] = iso.split('-'), mn = MONTHS[Number(m) - 1]
  if (!mn || !d) return iso
  return y === String(new Date().getFullYear()) ? `${mn} ${Number(d)}` : `${mn} ${Number(d)}, ${y}`
}
const RULE = 'mt-1 border-t border-white/10 pt-1 '
const row = (label, value, { color, cls = 'text-white', dd = cls } = {}) =>
  `<dt class="flex items-center gap-1.5 ${cls}">${color ? `<span class="inline-block h-2 w-2 shrink-0 rounded-[2px]" style="background-color:${color}" aria-hidden="true"></span>` : ''}${label}</dt><dd class="text-right ${dd}">${value}</dd>`
const dl = rows => `<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] tabular-nums">${rows}</dl>`

function dayTip(i) {
  const d = data.timeline[i]
  const tiers = TIERS.filter(t => d.cost[t.key] > 0 || d.agents?.[t.key] > 0).sort((a, b) => d.cost[b.key] - d.cost[a.key])
  const total = tiers.reduce((s, t) => s + d.cost[t.key], 0)
  const running = data.timeline.slice(0, i + 1).reduce((s, x) => s + x.baseline - TIERS.reduce((a, t) => a + (x.cost[t.key] || 0), 0), 0)
  const saved = d.baseline - total
  let rows = tiers.map(t => row(`${t.name} <span class="text-white/50">· ${d.agents?.[t.key] ?? 0}</span>`, usd(d.cost[t.key]), { color: t.color })).join('')
  if (tiers.length > 1) rows += row('day total', usd(total), { cls: RULE + 'text-white' })
  rows += row('at Opus 5.5', usd(d.baseline), { cls: (tiers.length > 1 ? '' : RULE) + 'text-white/70' })
  rows += row('saved', (saved < 0 ? '−' : '') + usd(Math.abs(saved)), { cls: 'text-white', dd: saved < 0 ? 'text-red-300' : 'text-emerald-300' })
  rows += row('running saved', (running < 0 ? '−' : '') + usd(Math.abs(running)), { cls: 'text-white', dd: running < 0 ? 'text-red-300/90' : 'text-emerald-300/90' })
  return `<div><p class="mb-1.5 font-semibold text-white">${dayName(d.date)}</p>${dl(rows)}</div>`
}

function tierTip(key) {
  const T = data.totals, b = T.byTier[key], t = tierOf(key)
  const share = T.cost ? (b.cost / T.cost) * 100 : 0
  const rows = row('agents', String(b.agents)) + row('spend', usd(b.cost)) + row('share of spend', `${share >= 10 ? Math.round(share) : share.toFixed(1)}%`)
    + row('tokens processed', kfmt(b.tokens), { cls: RULE + 'text-white/70' }) + row('avg per agent', usd(b.agents ? b.cost / b.agents : 0), { cls: 'text-white/70' })
  return `<div><p class="mb-1.5 flex items-center gap-1.5 font-semibold text-white"><span class="inline-block h-2 w-2 shrink-0 rounded-[2px]" style="background-color:${t.color}"></span>${t.name}</p>${dl(rows)}</div>`
}

function tipEl() {
  let tip = document.getElementById(ID + '-tip')
  if (!tip) {
    tip = document.createElement('div')
    tip.id = ID + '-tip'
    tip.setAttribute('role', 'tooltip')
    tip.className = 'report-meter-tooltip report-savings-tooltip report-meter-tooltip--fixed report-meter-tooltip--above'
    tip.style.display = 'none'
    document.body.appendChild(tip)
  }
  return tip
}
function showTip(html, x, y) {
  const tip = tipEl()
  tip.innerHTML = html
  tip.style.display = ''
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
  // Boost keeps a tooltip 8px inside the viewport; the transform centres it on x.
  const r = tip.getBoundingClientRect(), m = 8
  if (r.left < m) tip.style.left = `${x + (m - r.left)}px`
  else if (r.right > innerWidth - m) tip.style.left = `${x - (r.right - (innerWidth - m))}px`
}
function hideTip() {
  const tip = document.getElementById(ID + '-tip')
  if (tip) tip.style.display = 'none'
  document.querySelectorAll(`#${ID} .mr-on`).forEach(e => e.classList.remove('mr-on'))
}

function bindHover(el) {
  const svg = el.querySelector('.mr-chart')
  if (svg) {
    const at = e => {
      const col = e.target.closest?.('.mr-col')
      if (!col) return hideTip()
      el.querySelectorAll('.mr-col.mr-on').forEach(c => c !== col && c.classList.remove('mr-on'))
      col.classList.add('mr-on')
      const hit = col.querySelector('.mr-hit').getBoundingClientRect()
      const box = svg.getBoundingClientRect()
      const top = box.top + (Number(col.dataset.top) / svg.viewBox.baseVal.height) * box.height
      showTip(dayTip(Number(col.dataset.i)), hit.left + hit.width / 2, top - 4)
    }
    svg.addEventListener('pointermove', at)
    svg.addEventListener('pointerleave', hideTip)
  }
  for (const seg of el.querySelectorAll('.mr-seg')) {
    seg.addEventListener('pointerenter', () => {
      seg.classList.add('mr-on')
      const r = seg.getBoundingClientRect()
      showTip(tierTip(seg.dataset.tier), r.left + r.width / 2, r.top - 4)
    })
    seg.addEventListener('pointerleave', hideTip)
  }
}

const bar = (w, h, extra = '') => `<div class="mr-sk" style="width:${w};height:${h}px;${extra}"></div>`
const rows = n => Array.from({ length: n }, () => bar('100%', 14, 'margin-top:9px')).join('')
function skeleton() {
  return `
    <div class="mr-head">
      <div>${bar('112px', 12)}${bar('256px', 40, 'margin-top:16px')}</div>
      <div>${bar('240px', 12)}${bar('90px', 12, 'margin:6px 0 0 auto')}</div>
    </div>
    ${bar('100%', 140, 'margin-top:36px;border-radius:6px')}
    ${bar('280px', 10, 'margin-top:14px')}
    <div class="mr-grid">
      <div>${bar('112px', 11)}${bar('100%', 10, 'margin-top:14px;border-radius:5px')}${bar('160px', 11, 'margin-top:30px')}${rows(7)}</div>
      <div>${bar('170px', 11)}${rows(5)}${bar('150px', 11, 'margin-top:30px')}${rows(4)}</div>
    </div>`
}

function render() {
  hideTip()
  const el = ensureMounted()
  if (!el) return
  if (failure && !data) {
    el.removeAttribute('aria-busy')
    el.innerHTML = `<h2 class="report-section-heading" style="color:var(--mr-accent)">Model routing</h2>
      <p class="mr-sub" style="margin-top:12px">The routing summary did not load: ${esc(failure)}</p>`
    return
  }
  if (loading || !data) {
    el.setAttribute('aria-busy', 'true')
    el.setAttribute('aria-label', 'Loading model routing')
    el.innerHTML = skeleton()
    return
  }
  el.removeAttribute('aria-busy')
  el.removeAttribute('aria-label')
  const T = data.totals
  const saved = T.baseline - T.cost
  const spend = TIERS.filter(t => T.byTier[t.key]?.agents)
  const split = spend.map(t => `<div class="mr-seg" data-tier="${t.key}" style="width:${(T.byTier[t.key].cost / (T.cost || 1)) * 100}%;background:${t.color}"></div>`).join('')
  const legend = spend.map(t => `<span><i style="background:${t.color}"></i>${t.name}<b>${T.byTier[t.key].agents}</b> agents · <b>${usd(T.byTier[t.key].cost)}</b></span>`).join('')

  const roles = data.roles.slice(0, 14).map(r => `<tr><td>${esc(r.role)}${r.lens ? `<span class="mr-sub">:${esc(r.lens)}</span>` : ''}</td><td>${pill(r.tier)}</td>
    <td class="n">${r.agents}</td><td class="n">${usd(r.cost)}</td><td class="n">${usd(r.cost / r.agents)}</td></tr>`).join('')

  // Every labelled agent on Opus means no routed script ran in this period — say so, or the table reads as a bug.
  const routed = data.roles.some(r => r.tier !== 'opus' && r.role !== '(no label)')
  const onlyOpus = data.roles.length && !routed
    ? `<p class="mr-sub" style="margin:-4px 0 8px">Every labelled agent in this period ran on Opus: no workflow using the routing table has run yet. Scripts pick models only if they use <code>route()</code> from agent-routing/templates/route.js.</p>`
    : ''

  const quality = data.quality.map(q => {
    const judged = q.fixed + q.rejected
    return `<tr><td>${esc(q.lens)}</td><td>${pill(q.tier)}</td><td class="n">${q.reviews}</td><td class="n">${q.findings}</td>
      <td class="n">${q.blockers + q.majors}</td><td class="n">${judged ? `${q.fixed}/${judged}` : '<span class="mr-sub">—</span>'}</td>
      <td class="n">${judged ? Math.round((q.fixed / judged) * 100) + '%' : ''}</td></tr>`
  }).join('')

  const runs = data.runs.map(r => `<tr><td title="${esc(r.run_id)}">${esc(r.run_id.replace(/^wf_/, ''))}</td><td class="mr-sub">${esc((r.started || '').slice(0, 16).replace('T', ' '))}</td>
    <td class="n">${r.agents}</td><td class="n">${[['opus', r.opus], ['sonnet', r.sonnet], ['haiku', r.haiku]].filter(x => x[1]).map(([k, n]) => `<span style="color:${tierOf(k).color}">${n}</span>`).join(' · ')}</td>
    <td class="n">${usd(r.cost || 0)}</td><td class="n">${usd((r.baseline || 0) - (r.cost || 0))}</td></tr>`).join('')

  const priced = Object.entries(data.pricedAs).map(([m, as]) => `${esc(m)} is priced at ${esc(as)} rates (Boost's price table has no entry for it yet — estimated)`).join('; ')
  const boost = boostTotals ? ` · Boost saved <b style="color:#3fb950">${kfmt(boostTotals.context_saved_tokens || 0)}</b> context tokens` : ''

  el.innerHTML = `
    <div class="mr-head">
      <div>
        <h2 class="report-section-heading" style="color:var(--mr-accent)">Model routing</h2>
        <div class="mr-big" style="margin-top:12px">${saved >= 0 ? usd(saved) : '−' + usd(-saved)}<small>${saved >= 0 ? 'saved by routing off Opus' : 'more than keeping it on Opus'}</small></div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
      ${ops.toggles ? ops.switchHtml('routing', ops.toggles.routing, 'model routing', 'Tells new sessions to route workflow agents by role (~/.claude/rules/model-routing.md). Scripts already written keep the models they name.') : ''}
      <div class="mr-sub" style="text-align:right">${ops.toggles && !ops.toggles.routing ? '<b style="color:#fff">Off</b>: new sessions are not told to route · ' : ''}${T.agents} subagents · ${usd(T.cost)} API-equivalent spend${boost}<br>${data.days === 1 ? 'past 24 hours' : data.days ? `past ${data.days} days` : 'all time'}${T.unpriced ? ` · ${T.unpriced} unpriced` : ''}</div></div>
    </div>
    <div style="margin-top:18px">${chart(data.timeline)}</div>
    <div class="mr-legend">${TIERS.map(t => `<span><i style="background:${t.color}"></i>${t.name}</span>`).join('')}<span><i style="background:none;border-top:1px dashed #fff;height:0;border-radius:0"></i>same tokens at Opus 5.5</span></div>
    <div class="mr-grid">
      <div>
        <h3>Spend by model</h3>
        <div class="mr-split">${split}</div>
        <div class="mr-legend">${legend}</div>
        <h3 style="margin-top:20px">Role → model</h3>${onlyOpus}
        <div class="mr-scroll"><table><thead><tr><th>Role</th><th>Model</th><th class="n">Agents</th><th class="n">Spend</th><th class="n">Avg</th></tr></thead><tbody>${roles}</tbody></table></div>
      </div>
      <div>
        <h3>Review quality by model</h3>
        <div class="mr-scroll"><table><thead><tr><th>Lens</th><th>Model</th><th class="n">Reviews</th><th class="n">Findings</th><th class="n">Blk+Maj</th><th class="n">Accepted</th><th class="n">%</th></tr></thead><tbody>${quality || '<tr><td colspan="7" class="mr-sub">No reviews yet.</td></tr>'}</tbody></table></div>
        <h3 style="margin-top:20px">Recent workflow runs</h3>
        <div class="mr-scroll"><table><thead><tr><th>Run</th><th>Started</th><th class="n">Agents</th><th class="n">O · S · H</th><th class="n">Spend</th><th class="n">Saved</th></tr></thead><tbody>${runs}</tbody></table></div>
      </div>
    </div>
    <div class="mr-note">
      Spend is derived: every subagent's recorded tokens priced from Boost's LiteLLM table at API list prices, whatever plan actually paid.
      “Saved” prices each non-Opus agent's tokens at Opus 5.5 (an Opus agent is its own baseline) — an estimate, since a smaller model spends a different number of tokens on the same job.
      “Accepted” is findings the fixer verified and fixed out of those it judged; runs before the routed lane carry no per-lens verdicts.
      ${priced ? `<br>${priced}.` : ''}
    </div>`
  bindHover(el)
  ops.bindSwitches(el, render)
}

// Boost's Tokens Saved pane, loaded or still its own skeleton (which has no text, only an aria-label).
function tokensPane() {
  const main = document.querySelector('main')
  return main && [...main.querySelectorAll(':scope > section')].find(s => /Tokens Saved/i.test(s.textContent || '') || /tokens saved/i.test(s.getAttribute('aria-label') || ''))
}
// Look like Boost's pane, but never inherit its skeleton's pulse: the card pulses on its own aria-busy.
const paneClass = anchor => anchor.className.split(/\s+/).filter(c => c && c !== 'animate-pulse').join(' ')

function ensureMounted() {
  let el = document.getElementById(ID)
  const anchor = tokensPane()
  if (el && el.isConnected) {
    if (anchor) el.className = paneClass(anchor)
    return el
  }
  if (!anchor) return null
  if (!document.getElementById(ID + '-css')) {
    const st = document.createElement('style'); st.id = ID + '-css'; st.textContent = css; document.head.appendChild(st)
  }
  el = document.createElement('section')
  el.id = ID
  el.className = paneClass(anchor)
  anchor.after(el)
  return el
}

// `skeleton` is for a first load and a period change, as Boost does; the minute refresh swaps in quietly.
async function load(skeleton = false) {
  const asked = days
  if (skeleton) { loading = true; render() }
  try {
    const [s, b, tg] = await Promise.all([
      fetch(`/__routing/api/summary?days=${days}`).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }),
      fetch(`/api/totals${days ? `?days=${days}` : ''}`).then(r => r.json()).catch(() => null),
      ops.refreshToggles(),
    ])
    if (asked !== days) return   // the period changed while this was in flight
    // Live polling redraws only when something shown changed (`generated` always does).
    const sig = JSON.stringify([{ ...s, generated: 0 }, b?.totals, tg])
    if (!skeleton && !failure && sig === lastSig) return
    lastSig = sig
    data = s; boostTotals = b?.totals || null; failure = null
  } catch (e) {
    if (asked !== days) return
    console.warn('model-routing:', e)
    failure = String(e.message || e)
    if (skeleton) data = null
  }
  loading = false
  if (skeleton) render(); else ops.whenIdle(document.getElementById(ID), render)
}

window.addEventListener('boost-period', e => { days = e.detail.days; load(true) })
window.addEventListener('agent-ops-toggles', () => ops.whenIdle(document.getElementById(ID), render))

// Mount as soon as Boost's Tokens Saved pane exists (showing the skeleton until data arrives), and put the
// card back when React re-renders the page and drops a node it does not own.
new MutationObserver(() => { if (!document.getElementById(ID)) render() })
  .observe(document.body, { childList: true, subtree: true })

load(true)
setInterval(() => load(false), ops.POLL_MS)
