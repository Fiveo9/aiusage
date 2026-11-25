/**
* @param {string} base
* @param {{ [s: string]: any; } | ArrayLike<any>} params
*/
function buildUrl(base, params) {
  const searchParams = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) searchParams.set(key, value)
  }
  const query = searchParams.toString()
  return query ? `${base}?${query}` : base
}

/**
* @param {string} action
*/
export async function githubConnection(action, body = {}) {
  const response = await fetch(`/api/github/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result || typeof result !== 'object' || Array.isArray(result)) throw new Error(result?.error?.message || 'GitHub connection failed')
  return result
}

// Responses are not cached: every call that is not joining a request already
// in flight asks the local server again, so a reload after a refresh or a
// poll shows the current data (issue #108).
const inflightRequests = new Map()

/** @param {string} url
 * @param {{ signal?: AbortSignal, method?: string }} [options]
 */
async function apiFetch(url, { signal, method } = {}) {
  const request = () => method
    ? fetch(url, signal ? { method, signal } : { method })
    : signal ? fetch(url, { signal }) : fetch(url)

  const load = () => request().then(async (response) => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
      throw new Error(error?.error?.message || `HTTP ${response.status}`)
    }
    return response.json()
  })

  // A caller's cancellation never owns another caller's request; mutations
  // also keep their own request/response instead of joining a GET by URL.
  if (signal || (method && method.toUpperCase() !== 'GET')) return load()
  if (inflightRequests.has(url)) {
    return inflightRequests.get(url)
  }

  const promise = load().finally(() => {
    if (inflightRequests.get(url) === promise) inflightRequests.delete(url)
  })

  inflightRequests.set(url, promise)
  return promise
}

/** @param {any} params
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function fetchSummary(params, { signal } = {}) {
  return apiFetch(buildUrl('/api/summary', params), { signal })
}

// Public aggregate totals for the home page; stays reachable without the
// dashboard password and only accepts `range`.
/** @param {any} params
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function fetchHomeSummary(params, { signal } = {}) {
  return apiFetch(buildUrl('/api/home-summary', { range: params?.range }), { signal })
}

/**
* @param {{ [s: string]: any; } | ArrayLike<any>} params
*/
export async function fetchTokens(params) {
  return apiFetch(buildUrl('/api/tokens', params))
}

/**
* @param {{ [s: string]: any; } | ArrayLike<any>} params
*/
export async function fetchCost(params) {
  return apiFetch(buildUrl('/api/cost', params))
}

/**
* @param {{ [s: string]: any; } | ArrayLike<any>} params
*/
export async function fetchModels(params) {
  return apiFetch(buildUrl('/api/models', params))
}

/**
* @param {Record<string, any>} params
*/
export async function fetchToolCalls(params) {
  return apiFetch(buildUrl('/api/tool-calls', {
    ...params,
    toolType: params.toolType || undefined,
  }))
}

/**
* @param {Record<string, any>} params
*/
export async function fetchSessions(params) {
  return apiFetch(buildUrl('/api/sessions', {
    ...params,
    page: params.page?.toString(),
    pageSize: params.pageSize?.toString(),
  }))
}

/**
* @param {string | number | boolean} sessionId
*/
export async function fetchSessionDetail(sessionId, params = {}) {
  return apiFetch(buildUrl(`/api/sessions/${encodeURIComponent(sessionId)}`, params))
}

/**
* @param {ArrayLike<any> | { [s: string]: any; }} params
*/
export async function fetchProjects(params) {
  return apiFetch(buildUrl('/api/projects', params))
}

/**
* @param {string} path
* @param {ArrayLike<any> | { [s: string]: any; }} params
*/
export function activityDetailUrl(path, params) {
  return buildUrl(path, params)
}

/**
* @param {string | number | boolean} sessionId
* @param {any} device
* @param {any} tool
* @param {any} back
*/
export function sessionDetailUrl(sessionId, device, tool, back) {
  return buildUrl(`/sessions/${encodeURIComponent(sessionId)}`, { device, tool, back })
}

/**
* @param {string} kind
* @param {ArrayLike<any> | { [s: string]: any; }} params
*/
export function fetchActivityDetail(kind, params) {
  return apiFetch(buildUrl(kind === 'project' ? '/api/projects/sessions' : '/api/tool-calls/events', params))
}

export async function refreshData() {
  return apiFetch('/api/refresh', { method: 'POST' })
}

export async function fetchPricing() {
  return apiFetch('/api/pricing')
}

/**
* @param {any} model
* @param {any} entry
*/
export async function updatePricing(model, entry) {
  const response = await fetch('/api/pricing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, ...entry }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

/**
* @param {string | number | boolean} model
*/
export async function deletePricing(model) {
  const response = await fetch(`/api/pricing?model=${encodeURIComponent(model)}`, { method: 'DELETE' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

/**
* @param {any} alias
* @param {any} modelKey
*/
export async function bindPricingAlias(alias, modelKey) {
  const response = await fetch('/api/pricing/alias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ alias, modelKey }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

/**
* @param {string | number | boolean} alias
*/
export async function unbindPricingAlias(alias) {
  const response = await fetch(`/api/pricing/alias?alias=${encodeURIComponent(alias)}`, { method: 'DELETE' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function recalcPricing() {
  const response = await fetch('/api/pricing/recalc', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchPricingRecalcStatus() {
  const response = await fetch('/api/pricing/recalc', { cache: 'no-store' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function syncPricing() {
  const response = await fetch('/api/pricing/sync', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function triggerSync() {
  const response = await fetch('/api/sync', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function fetchSyncStatus() {
  return apiFetch('/api/sync')
}

/**
* @param {string} siteUrl
*/
export async function fetchCloudSyncStatus(siteUrl) {
  try {
    const response = await fetch('/api/cli/sync/status')
    if (!response.ok) return { enabled: false }
    return await response.json()
  } catch {
    try {
      const response = await fetch(`${siteUrl}/api/cli/sync/status`)
      if (!response.ok) return { enabled: false }
      return await response.json()
    } catch {
      return { enabled: false }
    }
  }
}

export async function fetchConfig() {
  return apiFetch('/api/config')
}

/**
* @param {any} data
*/
export async function saveConfig(data) {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

/**
* @param {ArrayLike<any> | { [s: string]: any; }} params
*/
export async function fetchTools(params) {
  return apiFetch(buildUrl('/api/tools', params))
}

export async function fetchDetectedTools() {
  return apiFetch('/api/detected-tools')
}

/**
* @param {string | Blob} file
*/
export async function importKelivoBackup(file) {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch('/api/import/kelivo', { method: 'POST', body: form })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(data?.error?.message || `HTTP ${response.status}`)
  }
  return data
}

export async function fetchQuotas() {
  return apiFetch('/api/quotas')
}

export async function fetchAuthStatus() {
  return apiFetch('/api/auth/status')
}

/**
* @param {any} password
*/
export async function login(password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

export async function refreshExchangeRate() {
  const response = await fetch('/api/exchange-rate/refresh', { method: 'POST' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'API error' } }))
    throw new Error(error.error?.message || `HTTP ${response.status}`)
  }
  return response.json()
}

/** @param {{ backend: string, repo?: string, bucket?: string }} selection */
export async function fetchCredentialStatus({ backend, repo, bucket }) {
  return apiFetch(buildUrl('/api/config/credentials/status', { backend, repo, bucket }))
}

export const SETTINGS_UPDATED_EVENT = 'aiusage:settings-updated'

/**
* @param {any} patch
*/
export function notifySettingsUpdated(patch) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, { detail: patch }))
}
