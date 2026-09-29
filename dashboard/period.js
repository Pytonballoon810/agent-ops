// The period Boost's page is showing, shared by every injected card.
// Injected as a classic script at the top of <head>, so it runs before Boost's own modules and sees
// their first request. Cards read window.__boostPeriod.days and listen for the `boost-period` event.
//
// Boost keeps its selection in localStorage `boost.report.days` (1, 7, 30, 90, or 0 for all time;
// 30 when unset) and asks `/api/savings-timeline?days=N`, leaving `days` out for all time.
(() => {
  if (window.__boostPeriod) return
  let days = 30
  try {
    const v = window.localStorage.getItem('boost.report.days')
    if (v != null && Number.isFinite(Number(v))) days = Number(v)
  } catch {}
  const period = window.__boostPeriod = { days }

  const set = d => {
    if (!Number.isFinite(d) || d === period.days) return
    period.days = d
    window.dispatchEvent(new CustomEvent('boost-period', { detail: { days: d } }))
  }

  const origFetch = window.fetch
  window.fetch = function (input) {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href)
      if (url.pathname === '/api/savings-timeline') set(Number(url.searchParams.get('days') ?? 0))
    } catch {}
    return origFetch.apply(this, arguments)
  }
})()

// Shared by the cards: feature switches in Boost's own switch markup, and live refresh that never
// redraws under the pointer.
window.__agentOps ||= {
  toggles: null,
  POLL_MS: 10_000,
  async refreshToggles() {
    try { const r = await fetch('/__routing/api/toggles'); if (r.ok) this.toggles = await r.json() } catch {}
    return this.toggles
  },
  // The server checks x-agent-ops, and a cross-origin page cannot send it without a preflight it refuses.
  async setToggle(feature, on) {
    const r = await fetch('/__routing/api/toggles', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-ops': '1' }, body: JSON.stringify({ feature, on }),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    this.toggles = j
    window.dispatchEvent(new Event('agent-ops-toggles'))
    return j
  },
  switchHtml(feature, on, label, title) {
    return `<div class="flex items-center gap-2" title="${title}"><span class="text-xs text-white">${on ? 'On' : 'Off'}</span>`
      + `<button type="button" role="switch" aria-checked="${on}" aria-label="${on ? 'Disable' : 'Enable'} ${label}" data-agent-ops-toggle="${feature}" data-cuelume-toggle=""`
      + ` class="relative h-6 w-11 shrink-0 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50 ${on ? 'bg-emerald-500/80' : 'bg-white/15'}">`
      + `<span class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition ${on ? 'translate-x-5' : 'translate-x-0'}"></span></button></div>`
  },
  bindSwitches(el, onDone) {
    for (const b of el.querySelectorAll('[data-agent-ops-toggle]')) b.addEventListener('click', async () => {
      const on = b.getAttribute('aria-checked') !== 'true'
      b.disabled = true
      try { await this.setToggle(b.dataset.agentOpsToggle, on) } catch (e) { b.title = `Could not switch: ${e.message}`; console.warn('agent-ops toggle:', e) }
      onDone()
    })
  },
  // Run `fn` now, or once the pointer leaves `el` if it is over it (a redraw would drop the hover and tooltip).
  whenIdle(el, fn) {
    if (!el || !el.matches(':hover')) return fn()
    if (el.__pending) { el.__pending = fn; return }
    el.__pending = fn
    el.addEventListener('pointerleave', () => { const f = el.__pending; el.__pending = null; f && f() }, { once: true })
  },
}
