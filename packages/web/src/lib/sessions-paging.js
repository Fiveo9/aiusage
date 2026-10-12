// Paging helpers for the Sessions list.

/**
 * Tracks which request is the latest. `begin()` starts a request and returns a
 * function that says whether that request is still the latest one, so a slow
 * response for an earlier filter or page cannot overwrite a newer one.
 */
export function createRequestTracker() {
  let latest = 0
  return function begin() {
    const id = ++latest
    return () => id === latest
  }
}

/**
 * The page to show after a response. A page past the end comes back empty with
 * a non-zero total (the list shrank under it): go to the last page that exists.
 */
export function resolvePage(response, page, pageSize) {
  if (response && !response.sessions.length && response.total > 0 && page > 1) {
    return Math.ceil(response.total / pageSize)
  }
  return page
}
