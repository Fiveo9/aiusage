import { error } from '@sveltejs/kit'

export function parsePagination(url: URL, defaultLimit: number, maxLimit: number): { limit: number; offset: number } {
  const limitText = url.searchParams.get('limit') ?? String(defaultLimit)
  const offsetText = url.searchParams.get('offset') ?? '0'
  const limit = Number(limitText), offset = Number(offsetText)
  if (!/^\d+$/.test(limitText) || !Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit
    || !/^\d+$/.test(offsetText) || !Number.isSafeInteger(offset) || offset < 0) throw error(400, 'Invalid pagination')
  return { limit, offset }
}
