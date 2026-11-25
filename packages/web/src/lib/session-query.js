const sorts = ['newest', 'cost', 'tokens']

/**
* @param {URLSearchParams} params
* @param {{ range?: string, from?: string, to?: string, month?: string, device?: string, tool?: string }} [defaults]
*/
export function readSessionQuery(params, defaults = {}) {
  const rawPage = params.get('page') || '1'
  const page = /^\d+$/.test(rawPage) && Number.isSafeInteger(Number(rawPage)) && Number(rawPage) > 0
    ? Number(rawPage) : 1
  const hasFilters = ['range', 'from', 'to', 'device', 'tool'].some(key => params.has(key))
  const filters = hasFilters ? Object.fromEntries(['range', 'from', 'to', 'month', 'device', 'tool'].map(key => [key, params.get(key) || ''])) : defaults
  return {
    range: filters.from && filters.to ? '' : (filters.range || 'day'),
    from: filters.from || '', to: filters.to || '', month: filters.month || '',
    device: filters.device || '', tool: filters.tool || '',
    q: (params.get('q') || '').trim().slice(0, 200),
    sort: sorts.includes(/** @type {string} */ (params.get('sort'))) ? params.get('sort') : 'newest', page,
  }
}

/**
* @param {{ range: any; from: any; to: any; month: any; device: any; tool: any; q: any; sort: any; page: any; }} state
*/
export function sessionListUrl(state) {
  const params = new URLSearchParams()
  if (state.from && state.to) {
    params.set('from', state.from); params.set('to', state.to)
    if (state.month) params.set('month', state.month)
  } else params.set('range', state.range || 'day')
  // Explicit empty filters distinguish this URL from persisted preferences.
  params.set('device', state.device || '')
  params.set('tool', state.tool || '')
  if (state.q) params.set('q', state.q)
  params.set('sort', state.sort || 'newest')
  params.set('page', String(state.page || 1))
  return `/sessions?${params}`
}

/**
* @param {{ range: any; from: any; to: any; month: any; }} range
* @param {any} device
* @param {any} tool
*/
export function sessionFilterKey(range, device, tool) {
  return JSON.stringify([range.range || '', range.from || '', range.to || '', range.month || '', device || '', tool || ''])
}
