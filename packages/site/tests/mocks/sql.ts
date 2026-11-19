// A stand-in for the postgres.js client exported by src/lib/server/db/pool.ts.
// It records every statement and answers from a responder the test installs,
// so server code can run without a database. Use it with:
//
//   vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../mocks/sql.js')).fakeSql }))

export interface RecordedQuery {
  /** Statement text with `?` for each parameter and whitespace collapsed. */
  text: string
  values: unknown[]
}

type Responder = (query: RecordedQuery) => unknown[] | undefined

export const queries: RecordedQuery[] = []

let responder: Responder = () => undefined

export function respondWith(next: Responder): void {
  responder = next
}

export function resetFakeSql(): void {
  queries.length = 0
  responder = () => undefined
}

function run(strings: TemplateStringsArray, ...values: unknown[]) {
  const query = { text: strings.join('?').replace(/\s+/g, ' ').trim(), values }
  queries.push(query)
  const rows = responder(query) ?? []
  return Promise.resolve(Object.assign([...rows], { count: rows.length }))
}

export const fakeSql = Object.assign(run, {
  begin: async <T>(fn: (tx: typeof run) => Promise<T>): Promise<T> => fn(run),
})
