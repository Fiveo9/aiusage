export const DEFAULT_S3_PREFIX = 'aiusage/'

/** Root is empty; strip only edge slashes, since inner slashes name distinct S3 keys. */
export function normalizeS3Prefix(prefix: string | undefined): string {
  const value = (prefix ?? DEFAULT_S3_PREFIX).replace(/^\/+|\/+$/g, '')
  return value ? `${value}/` : ''
}

/** Empty means the default AWS endpoint; URL spelling must not split one store. */
export function normalizeS3Endpoint(endpoint: string | undefined): string {
  let value = (endpoint ?? '').trim().replace(/\/+$/, '')
  if (!value) return ''
  try { value = new URL(value).href.replace(/\/+$/, '') } catch { /* config validation reports invalid endpoints */ }
  return value === 'https://s3.amazonaws.com' ? '' : value
}
