import { describe, expect, it } from 'vitest'
import { createRequestTracker, resolvePage } from '../src/lib/sessions-paging.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('resolvePage', () => {
  it('keeps the page when the response has sessions', () => {
    expect(resolvePage({ sessions: [{}], total: 120 }, 3, 50)).toBe(3)
  })

  it('goes to the last existing page when a later page comes back empty', () => {
    expect(resolvePage({ sessions: [], total: 120 }, 5, 50)).toBe(3)
    expect(resolvePage({ sessions: [], total: 50 }, 4, 50)).toBe(1)
  })

  it('keeps the page when there is nothing at all, or on page 1', () => {
    expect(resolvePage({ sessions: [], total: 0 }, 4, 50)).toBe(4)
    expect(resolvePage({ sessions: [], total: 10 }, 1, 50)).toBe(1)
    expect(resolvePage(null, 2, 50)).toBe(2)
  })
})

describe('createRequestTracker', () => {
  it('reports only the most recent request as the latest', () => {
    const begin = createRequestTracker()
    const first = begin()
    expect(first()).toBe(true)
    const second = begin()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  it('keeps separate trackers independent', () => {
    const a = createRequestTracker()()
    createRequestTracker()()
    expect(a()).toBe(true)
  })

  // The sequence from the Sessions page: page 4 of the old filter is still in flight
  // when the filter changes and page 2 of the new filter loads. The old answer
  // (empty, total 50) arrives last and must change neither the list nor the page.
  it('lets a late response for an old filter change neither the data nor the page', async () => {
    const begin = createRequestTracker()
    const pageSize = 50
    const state: { data: any; page: number; loading: boolean } = { data: null, page: 4, loading: false }

    async function load(fetching: Promise<any>) {
      const isLatest = begin()
      const requestedPage = state.page
      state.loading = true
      try {
        const response = await fetching
        if (!isLatest()) return
        state.data = response
        state.page = resolvePage(response, requestedPage, pageSize)
      } finally {
        if (isLatest()) state.loading = false
      }
    }

    const oldFilter = deferred<any>()
    const newFilter = deferred<any>()
    const oldLoad = load(oldFilter.promise)
    state.page = 2
    const newLoad = load(newFilter.promise)

    const fresh = { sessions: [{ sessionId: 'new' }], total: 200 }
    newFilter.resolve(fresh)
    await newLoad
    expect(state).toEqual({ data: fresh, page: 2, loading: false })

    oldFilter.resolve({ sessions: [], total: 50 })
    await oldLoad
    expect(state).toEqual({ data: fresh, page: 2, loading: false })
  })

  it('keeps the loading state until the latest request settles', async () => {
    const begin = createRequestTracker()
    let loading = false
    async function load(fetching: Promise<unknown>) {
      const isLatest = begin()
      loading = true
      try { await fetching } finally { if (isLatest()) loading = false }
    }

    const slowOld = deferred<unknown>()
    const newer = deferred<unknown>()
    const oldLoad = load(slowOld.promise)
    const newLoad = load(newer.promise)

    slowOld.resolve(null)
    await oldLoad
    expect(loading).toBe(true)

    newer.resolve(null)
    await newLoad
    expect(loading).toBe(false)
  })
})
