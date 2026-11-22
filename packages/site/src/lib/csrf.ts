/** Read the current browser cookie for each mutation; preserve caller headers. */
export function csrfHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers)
  const prefix = 'csrf_token='
  const cookie = typeof document === 'undefined' ? '' : document.cookie
  const entry = cookie.split(';').map(value => value.trim()).find(value => value.startsWith(prefix))
  const token = entry?.slice(prefix.length)
  if (token && /^[a-f0-9]{64}$/.test(token)) result.set('x-csrf-token', token)
  return result
}
