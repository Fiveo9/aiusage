// Launched only by remote-check-postgres.mjs against its disposable database.
import { runMigrations } from '../../src/lib/server/db/schema.js'
import { sql } from '../../src/lib/server/db/pool.js'

try {
  await runMigrations()
  process.send?.({ status: 'passed' })
} catch (error) {
  // No connection string or database diagnostics leave the isolated test.
  process.send?.({ status: 'failed', code: (error as { code?: string }).code ?? 'unknown' })
  process.exitCode = 1
} finally {
  await sql.end()
}
