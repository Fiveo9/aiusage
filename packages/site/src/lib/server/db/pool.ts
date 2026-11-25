import postgres from 'postgres'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerSiteResource } from '../resource-lifecycle.js'

let _sql: ReturnType<typeof postgres> | null = null
let envLoaded = false
let unregister: (() => void) | undefined

export async function closeSql(options?: { timeout?: number }): Promise<void> {
  const client = _sql
  _sql = null
  unregister?.()
  unregister = undefined
  if (client) await client.end(options ?? { timeout: 10 })
}

function loadLocalEnv(): void {
  if (envLoaded) return
  envLoaded = true

  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), 'packages/site/.env'),
  ]

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue

    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue

      const key = trimmed.slice(0, eq).trim()
      const rawValue = trimmed.slice(eq + 1).trim()
      if (!key || process.env[key] != null) continue
      process.env[key] = rawValue.replace(/^['"]|['"]$/g, '')
    }
    return
  }
}

function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    loadLocalEnv()
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required')
    }
    _sql = postgres(databaseUrl, {
      max: poolMax(process.env.DATABASE_POOL_MAX),
      idle_timeout: 20,
      connect_timeout: 10
    })
    unregister = registerSiteResource(closeSql)
  }
  return _sql
}

export function poolMax(value: string | undefined): number {
  const max = Number(value)
  return Number.isSafeInteger(max) && max >= 1 && max <= 1000 ? max : 10
}

// sql is callable (for tagged template literals) and has properties (like .begin)
// Use a function with forwarded properties
function sql(strings: TemplateStringsArray, ...values: postgres.ParameterOrFragment<never>[]) {
  return getSql()(strings, ...values)
}

// Forward property access to the underlying client. The proxy stands in for
// the client, so it is typed as one (`sql.begin`, `sql.end`, ...).
const sqlProxy = new Proxy(sql, {
  get(_target, prop) {
    if (prop === 'end') return closeSql
    const db = getSql()
    return (db as unknown as Record<string | symbol, unknown>)[prop]
  },
  apply(_target, _thisArg, args) {
    return (getSql() as unknown as Function)(...args)
  }
}) as unknown as postgres.Sql

export { sqlProxy as sql }
