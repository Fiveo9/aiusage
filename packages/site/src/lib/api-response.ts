/** Keeps proxy/CSRF text responses from being mistaken for network failures. */
export async function readApiResponse(response: Response): Promise<Record<string, any>> {
  let data: unknown
  try { data = await response.json() } catch {
    if (response.ok) throw new Error('Invalid server response')
    return { error: `HTTP ${response.status}` }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    if (response.ok) throw new Error('Invalid server response')
    return { error: `HTTP ${response.status}` }
  }
  const result = data as Record<string, any>
  if (!response.ok && typeof result.error !== 'string') {
    return { ...result, error: result.error?.message || result.error?.code || result.message || `HTTP ${response.status}` }
  }
  return result
}
