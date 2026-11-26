import postgres from 'postgres'
import { afterAll } from 'vitest'

const target = new URL(process.env.AIUSAGE_PG_TEST_URL || 'http://invalid')
if (!/^\/data\/home\/[^/]+\/\d{8}T\d{6}Z-[a-f0-9]{8}$/.test(process.env.AIUSAGE_CHECK_ROOT || '')
    || target.protocol !== 'postgres:' || target.hostname !== '127.0.0.1'
    || target.username !== 'postgres' || target.password || !target.port
    || !/^\/check_business_\d+$/.test(target.pathname) || target.search || target.hash) {
  throw Error('Independent PostgreSQL tests require the isolated loopback test database.')
}

/** Query text only: never record parameter values or connection credentials. */
export const executedStatements: string[] = []
export const sql = postgres(target.href, {
  max: 4,
  connect_timeout: 5,
  onnotice: () => {},
  debug: (_connection, text) => { executedStatements.push(text) },
})

// Fixture setup/assertion queries are deliberately excluded from business
// statement counts, matching the PGlite helper's separate query() path.
const fixtureSql = postgres(target.href, { max: 1, connect_timeout: 5, onnotice: () => {} })
afterAll(async () => { await Promise.all([sql.end({ timeout: 5 }), fixtureSql.end({ timeout: 5 })]) })

export async function migrateTestDatabase(): Promise<void> {
  const { runMigrations } = await import('../../src/lib/server/db/schema.js')
  await runMigrations()
}

export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const rows = await fixtureSql.unsafe(text, params as Parameters<typeof sql.unsafe>[1])
  return Array.from(rows) as T[]
}

export async function truncate(...tables: string[]): Promise<void> {
  if (!tables.length || tables.some(table => !/^[a-z_]+$/.test(table))) throw Error('Invalid test table name')
  await fixtureSql.unsafe(`TRUNCATE ${tables.join(', ')} CASCADE`)
}
