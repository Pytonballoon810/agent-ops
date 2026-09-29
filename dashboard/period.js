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
