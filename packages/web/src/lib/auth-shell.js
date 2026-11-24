export function getAuthShellState({ pathname, authEnabled, authenticated, authLoading, authFailed = false }) {
  const isHome = pathname === '/'
  if (authLoading) return isHome ? 'public-home' : 'loading'
  if (authFailed) return isHome ? 'public-home' : 'auth-error'
  if (!authEnabled || authenticated) return 'shell'
  return isHome ? 'public-home' : 'login-page'
}
