import Database from 'better-sqlite3'
import { existsSync, writeFileSync } from 'node:fs'
import { applyPragmas } from '../../src/db/schema.ts'
import { runMigrations } from '../../src/db/migrations/index.ts'

const [databasePath, mode, readyPath, goPath] = process.argv.slice(2)
const db = new Database(databasePath)
try {
  applyPragmas(db)
  const prepare = db.prepare.bind(db)
  let paused = false
  db.prepare = (sql) => {
    const statement = prepare(sql)
    if (mode !== 'pause' || !sql.includes('SELECT version FROM schema_version')) return statement
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target)
        if (property !== 'get') return typeof value === 'function' ? value.bind(target) : value
        return (...args) => {
          const result = target.get(...args)
          if (!paused) {
            paused = true
            writeFileSync(readyPath, 'ready')
            const deadline = Date.now() + 10_000
            while (!existsSync(goPath)) {
              if (Date.now() >= deadline) throw new Error('Synthetic migration barrier timed out')
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
            }
          }
          return result
        }
      },
    })
  }
  runMigrations(db)
  process.stdout.write('migration-ok\n')
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : 'migration failed')
  process.exitCode = 1
} finally {
  db.close()
}
