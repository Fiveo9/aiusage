/** Wire paths use forward slashes and must remain relative on every host OS. */
export function isSafeSyncPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0
    && !path.includes('\\') && !path.includes('\u0000') && !path.includes(':')
    && !path.includes('..') && !path.startsWith('/')
    && path.split('/').every(part => part.length > 0 && part !== '.')
}

/** A namespace owner is exactly one safe path component, not a relative path. */
export function isSafeDeviceInstanceId(owner: unknown): owner is string {
  return isSafeSyncPath(owner) && !owner.includes('/')
}
