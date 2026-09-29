// The Agent usage pane, injected above Boost's "Tokens Saved": every assistant message of every session,
// as tokens or API-equivalent cost, per day (per hour for the past 24 hours). Bars are split by model
// (colour) and by kind (fill): your chats solid, Agent-tool subagents started from a chat faded,
// Workflow agents hatched like Boost's own "unused" series. Built from Boost's own markup and classes,
// follows Boost's period through period.js, and its legend hides and shows series as Boost's does.

const ID = 'agent-usage'
const ACCENT = '#e3b341'
const TIERS = [
  { key: 'opus', name: 'Opus', color: '#f0883e' },
  { key: 'sonnet', name: 'Sonnet', color: '#58a6ff' },
  { key: 'haiku', name: 'Haiku', color: '#56d4dd' },
  { key: 'fable', name: 'Fable', color: '#d2a8ff' },
  { key: 'other', name: 'Other', color: '#8b949e' },
]
const KINDS = [
  { key: 'chat', name: 'Chats', title: 'Sessions you typed in' },
  { key: 'subagent', name: 'Chat subagents', title: 'Agent-tool subagents started from a chat' },
  { key: 'workflow', name: 'Workflows', title: 'Agents of Workflow runs' },
]
const HATCH = 'repeating-linear-gradient(45deg, rgba(0,0,0,.28) 0px, rgba(0,0,0,.28) 2px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 5px)'
const PLOT = 216

let days = window.__boostPeriod?.days ?? 30
let data = null, loading = true, failure = null, lastSig = ''
let metric = 'cost'
try { metric = localStorage.getItem('agent-usage.metric') === 'tokens' ? 'tokens' : 'cost' } catch {}
const hidden = new Set()

const css = `
@keyframes ${ID}-pulse { 50% { opacity:.5 } }
#${ID}[aria-busy="true"] { animation: ${ID}-pulse 2s cubic-bezier(.4,0,.6,1) infinite; }
@media (prefers-reduced-motion: reduce) { #${ID}[aria-busy="true"] { animation:none; } }
#${ID} .au-sk { background: rgba(255,255,255,.1); border-radius:4px; max-width:100%; }
#${ID} .au-seg { transition: opacity .12s ease-out; }
#${ID} .au-plot:hover .au-bar:not(.au-on) .au-seg { opacity:.4; }
`

const usd = v => v >= 100 ? `$${Math.round(v).toLocaleString('en-US')}` : `$${(v || 0).toFixed(2)}`
const kfmt = v => v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v || 0))
const fmt = v => metric === 'cost' ? usd(v) : kfmt(v)
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function label(key, year = true) {   // "2026-09-04" -> "Sep 4, 2026"; "2026-09-04T13" -> "Sep 4, 13:00"
  const [d, h] = key.split('T'), [y, m, dd] = d.split('-')
  const day = `${MONTHS[Number(m) - 1]} ${Number(dd)}`
  return h != null ? `${day}, ${h}:00` : year ? `${day}, ${y}` : day
}

// Segment look, shared by bars and legend swatches.
function swatch(color, kind) {
  if (kind === 'workflow') return `background-color:${color}55;background-image:${HATCH};border:1.5px solid ${color};box-sizing:border-box;`
  // A translucent colour rather than opacity, so the hover dimming (an opacity rule) still applies.
  if (kind === 'subagent') return `background-color:${color}80;`
  return `background-color:${color};`
}
const val = cell => cell ? cell[metric] : 0
const shown = (t, k) => !hidden.has(t) && !hidden.has(k)

function bars() {
  const B = data.buckets
  if (!B.length) return `<p class="text-xs text-white/60">No sessions in this period.</p>`
  const totalOf = b => TIERS.reduce((s, t) => s + KINDS.reduce((a, k) => a + (shown(t.key, k.key) ? val(b.cells[t.key]?.[k.key]) : 0), 0), 0)
  const max = Math.max(...B.map(totalOf), metric === 'cost' ? 0.01 : 1)
  const cols = B.map((b, i) => {
    const total = totalOf(b)
    let segs = ''
    // Bottom to top: Opus first, then smaller models; within a model chats, chat subagents, workflows.
    for (const t of [...TIERS].reverse()) for (const k of [...KINDS].reverse()) {
      const v = shown(t.key, k.key) ? val(b.cells[t.key]?.[k.key]) : 0
      if (v <= 0) continue
      const h = Math.max(2, (v / max) * (PLOT - 8))
      segs += `<span class="au-seg w-full shrink-0" aria-hidden="true" style="height:${h}px;border-radius:3px;${swatch(t.color, k.key)}"></span>`
    }
    return `<button type="button" data-i="${i}" aria-label="${esc(label(b.key))}: ${fmt(total)}" class="au-bar group flex h-full shrink-0 flex-col justify-end rounded-sm outline-none transition focus-visible:ring-2 focus-visible:ring-white/45 focus-visible:ring-offset-1 focus-visible:ring-offset-[#0d1117] hover:bg-white/[0.04]" style="flex:1 1 0px;min-width:3px;max-width:48px;gap:2px;">${segs}</button>`
  }).join('')
  return `<div class="relative">
      <div class="pointer-events-none absolute -left-0.5 top-0 z-10 text-[10px] tabular-nums text-white" aria-hidden="true">${fmt(max)}</div>
      <div class="au-plot flex items-end justify-between border-b border-white/[0.08] pl-8" role="img" aria-label="Agent ${metric === 'cost' ? 'spend' : 'tokens'} per ${data.hourly ? 'hour' : 'day'}" style="height:${PLOT}px;gap:4px;">${cols}</div>
      <div class="mt-2 flex items-center justify-between pl-8 text-[10px] uppercase tracking-wider text-white"><span>${esc(label(B[0].key))}</span><span>${esc(label(B[B.length - 1].key))}</span></div>
    </div>`
}

function legendItem(key, name, title, style, value) {
  const off = hidden.has(key)
  return `<li><button type="button" data-toggle="${key}" title="${esc(title)}" aria-pressed="${off}" class="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition hover:bg-white/[0.05]" style="opacity:${off ? .4 : 1};">
    <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]" aria-hidden="true" style="${style}"></span><span class="text-[11px] text-white">${esc(name)}</span><span class="font-mono text-xs tabular-nums text-white">${value}</span></button></li>`
}

function rangeText() {
  if (data.hourly) return 'Past 24 hours'
  const B = data.buckets
  if (!B.length) return days ? `Past ${days} days` : 'All time'
  return `${label(B[0].key)} – ${label(B[B.length - 1].key)} · ${B.length} days${days ? '' : ' · all time'}`
}

function skeleton() {
  const bar = (w, h, extra = '') => `<div class="au-sk" style="width:${w};height:${h}px;${extra}"></div>`
  return `<div class="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>${bar('120px', 12)}${bar('280px', 48, 'margin-top:10px')}</div>${bar('220px', 12)}
    </div>
    ${bar('100%', PLOT, 'border-radius:6px')}
    <div style="display:flex;gap:10px;margin-top:22px">${[90, 90, 90, 110, 100].map(w => bar(`${w}px`, 22)).join('')}</div>`
}

function render() {
  hideTip()
  const el = ensureMounted()
  if (!el) return
  if (failure && !data) {
    el.removeAttribute('aria-busy')
    el.innerHTML = `<h2 class="report-section-heading" style="color:${ACCENT}">Agent usage</h2><p class="mt-3 text-xs text-white/60">Usage did not load: ${esc(failure)}</p>`
    return
  }
  if (loading || !data) {
    el.setAttribute('aria-busy', 'true')
    el.setAttribute('aria-label', 'Loading agent usage')
    el.innerHTML = skeleton()
    return
  }
  el.removeAttribute('aria-busy')
  el.setAttribute('aria-label', 'Agent usage over time')
  const T = data.totals
  const pct = k => T[metric === 'cost' ? 'cost' : 'tokens'] ? Math.round((T.byKind[k][metric] / T[metric]) * 100) : 0
  const tab = (m, name) => `<button type="button" data-metric="${m}" aria-pressed="${metric === m}" class="rounded-md px-2.5 py-1 text-[11px] transition ${metric === m ? 'bg-white/[0.08] text-white' : 'text-white/60 hover:bg-white/[0.05]'}">${name}</button>`
  el.innerHTML = `
    <div class="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div class="flex min-w-0 flex-wrap items-end gap-8">
        <div class="min-w-0">
          <h2 class="report-section-heading" style="color:${ACCENT}">Agent usage</h2>
          <div class="mt-1"><p class="flex items-baseline gap-2.5 tracking-tight">
            <span class="font-sans text-5xl font-semibold tabular-nums" style="color:${ACCENT}">${metric === 'cost' ? usd(T.cost) : kfmt(T.tokens)}</span>
            <span class="font-sans text-xl font-normal text-white">${metric === 'cost' ? 'API-equivalent spend' : 'tokens processed'}</span></p></div>
        </div>
        <div class="pb-1 text-xs tabular-nums text-white/70">${metric === 'cost' ? `${kfmt(T.tokens)} tokens` : usd(T.cost)} · ${T.messages.toLocaleString('en-US')} model calls<br>
          chats ${pct('chat')}% · chat subagents ${pct('subagent')}% · workflows ${pct('workflow')}%</div>
      </div>
      <div class="flex flex-col items-end gap-1.5">
        <div class="flex gap-1" role="group" aria-label="Show">${tab('cost', 'Cost')}${tab('tokens', 'Tokens')}</div>
        <p class="pb-1 text-xs tabular-nums text-white">${esc(rangeText())}</p>
      </div>
    </div>
    ${bars()}
    <ul class="mt-4 flex flex-wrap gap-x-1 gap-y-1.5 border-t border-white/[0.06] pt-3">
      ${TIERS.filter(t => T.byTier[t.key]).map(t => legendItem(t.key, t.name, `Every ${t.name} model`, `background-color:${t.color};`, fmt(T.byTier[t.key][metric]))).join('')}
      <li class="mx-1 self-stretch border-l border-white/[0.08]" aria-hidden="true"></li>
      ${KINDS.map(k => legendItem(k.key, k.name, k.title, swatch('#c9d1d9', k.key), fmt(T.byKind[k.key][metric]))).join('')}
    </ul>
    <p class="mt-3 text-[11px] leading-relaxed text-white/60">Every assistant message in ~/.claude/projects, from the transcripts. Cost is tokens × API list price from Boost's LiteLLM table,
      whatever plan actually paid; tokens count input, output, cache reads and cache writes. Workflow and chat-subagent agents are counted apart from the chat that started them.${T.unpriced ? ` ${T.unpriced} calls on a model with no price are left out of the cost.` : ''}</p>`
  bind(el)
}

// Tooltips reuse Boost's own classes and the layout of its day tooltip.
const RULE = 'mt-1 border-t border-white/10 pt-1 '
const row = (lbl, value, { color, style, cls = 'text-white' } = {}) =>
  `<dt class="flex items-center gap-1.5 ${cls}">${color || style ? `<span class="inline-block h-2 w-2 shrink-0 rounded-[2px]" style="${style || `background-color:${color}`}" aria-hidden="true"></span>` : ''}${lbl}</dt><dd class="text-right ${cls}">${value}</dd>`
const dl = rows => `<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] tabular-nums">${rows}</dl>`
function barTip(i) {
  const b = data.buckets[i]
  const lines = []
  for (const t of TIERS) for (const k of KINDS) {
    const c = b.cells[t.key]?.[k.key]
    if (c && shown(t.key, k.key) && (c.tokens || c.cost)) lines.push({ t, k, c })
  }
  lines.sort((a, z) => val(z.c) - val(a.c))
  const other = metric === 'cost' ? 'tokens' : 'cost'
  const f2 = v => other === 'cost' ? usd(v) : kfmt(v)
  let rows = lines.map(({ t, k, c }) => row(`${t.name} <span class="text-white/50">· ${k.name.toLowerCase()}</span>`, `${fmt(val(c))} <span class="text-white/50">${f2(c[other])}</span>`, { style: swatch(t.color, k.key) })).join('')
  const tot = lines.reduce((s, x) => s + x.c.cost, 0), tok = lines.reduce((s, x) => s + x.c.tokens, 0), calls = lines.reduce((s, x) => s + x.c.messages, 0)
  rows += row('total', `${metric === 'cost' ? usd(tot) : kfmt(tok)} <span class="text-white/50">${metric === 'cost' ? kfmt(tok) : usd(tot)}</span>`, { cls: RULE + 'text-white' })
  rows += row('model calls', calls.toLocaleString('en-US'), { cls: 'text-white/70' })
  return `<div><p class="mb-1.5 font-semibold text-white">${esc(label(b.key))}</p>${lines.length ? dl(rows) : '<p class="text-[11px] text-white/60">Nothing this ' + (data.hourly ? 'hour' : 'day') + '.</p>'}</div>`
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
  const r = tip.getBoundingClientRect(), m = 8
  if (r.left < m) tip.style.left = `${x + (m - r.left)}px`
  else if (r.right > innerWidth - m) tip.style.left = `${x - (r.right - (innerWidth - m))}px`
}
function hideTip() {
  const tip = document.getElementById(ID + '-tip')
  if (tip) tip.style.display = 'none'
  document.querySelectorAll(`#${ID} .au-on`).forEach(e => e.classList.remove('au-on'))
}

function bind(el) {
  for (const b of el.querySelectorAll('.au-bar')) {
    const show = () => {
      el.querySelectorAll('.au-bar.au-on').forEach(x => x !== b && x.classList.remove('au-on'))
      b.classList.add('au-on')
      const r = b.getBoundingClientRect(), top = b.querySelector('.au-seg')?.getBoundingClientRect().top ?? r.bottom
      showTip(barTip(Number(b.dataset.i)), r.left + r.width / 2, top - 4)
    }
    b.addEventListener('pointerenter', show)
    b.addEventListener('focus', show)
    b.addEventListener('pointerleave', hideTip)
    b.addEventListener('blur', hideTip)
  }
  for (const b of el.querySelectorAll('[data-toggle]')) b.addEventListener('click', () => {
    const k = b.dataset.toggle
    hidden.has(k) ? hidden.delete(k) : hidden.add(k)
    render()
  })
  for (const b of el.querySelectorAll('[data-metric]')) b.addEventListener('click', () => {
    metric = b.dataset.metric
    try { localStorage.setItem('agent-usage.metric', metric) } catch {}
    render()
  })
}

// Boost's Tokens Saved pane, loaded or still its own skeleton (which has no text, only an aria-label).
function tokensPane() {
  const main = document.querySelector('main')
  return main && [...main.querySelectorAll(':scope > section')].find(s => /Tokens Saved/i.test(s.textContent || '') || /tokens saved/i.test(s.getAttribute('aria-label') || ''))
}
const paneClass = a => a.className.split(/\s+/).filter(c => c && c !== 'animate-pulse').join(' ')

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
  anchor.before(el)
  return el
}

// `skeleton` is for a first load and a period change, as Boost does; the minute refresh swaps in quietly.
async function load(skeleton = false) {
  const asked = days
  if (skeleton) { loading = true; render() }
  try {
    const r = await fetch(`/__routing/api/usage?days=${days}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    if (asked !== days) return
    // Live polling redraws only when a figure changed (`generated` always does).
    const sig = JSON.stringify({ ...j, generated: 0 })
    if (!skeleton && !failure && sig === lastSig) return
    lastSig = sig
    data = j; failure = null
  } catch (e) {
    if (asked !== days) return
    failure = String(e.message || e)
    if (skeleton) data = null
  }
  loading = false
  if (skeleton) render(); else window.__agentOps.whenIdle(document.getElementById(ID), render)
}

window.addEventListener('boost-period', e => { days = e.detail.days; load(true) })
new MutationObserver(() => { if (!document.getElementById(ID)) render() })
  .observe(document.body, { childList: true, subtree: true })

load(true)
setInterval(() => load(false), window.__agentOps.POLL_MS)
