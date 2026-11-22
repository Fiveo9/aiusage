import type { PageServerLoad } from './$types'

export const load: PageServerLoad = async ({ url }) => {
  const token = url.searchParams.get('token')
  if (!token || !/^[A-Za-z0-9_-]{48}$/.test(token)) {
    return { success: false, error: 'invalid' }
  }

  // Email scanners and prefetches must never consume the token.
  return { success: false, pending: true, error: null }
}
