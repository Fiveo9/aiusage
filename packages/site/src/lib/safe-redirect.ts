export function getSafeRedirect(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || /[\\\x00-\x1f\x7f]/.test(value)) return '/settings'
  try {
    const url = new URL(value, 'https://redirect.invalid')
    return url.origin === 'https://redirect.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/settings'
  } catch {
    return '/settings'
  }
}
