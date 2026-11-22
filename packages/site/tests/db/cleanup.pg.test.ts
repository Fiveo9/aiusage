import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../helpers/pglite-sql.js')).sql }))
vi.mock('node-cron', () => ({ default: { schedule: vi.fn(() => ({ stop: vi.fn() })) } }))
import cron from 'node-cron'
import { runCleanup, startCleanupCron } from '../../src/lib/server/db/cleanup.js'
import { migrateTestDatabase, query, truncate } from '../helpers/pglite-sql.js'

beforeAll(() => migrateTestDatabase(), 15_000)
beforeEach(async () => {
  await truncate('users', 'email_send_attempts')
  await query("INSERT INTO users (id,username,email,display_name) VALUES ('owner','owner','owner@example.test','Owner')")
})
describe('shared maintenance cleanup', () => {
  it('schedules the daily cron explicitly in UTC', () => {
    startCleanupCron()
    expect(cron.schedule).toHaveBeenCalledWith('0 3 * * *', expect.any(Function), { timezone: 'UTC' })
  })
  it('cleans all expired authentication tables and retains live reservations', async () => {
    await query("INSERT INTO sessions (sid,user_id,expires_at) VALUES ('expired','owner',NOW()-INTERVAL '1 day')")
    await query("INSERT INTO email_verification_tokens (id,user_id,email,token_hash,expires_at) VALUES ('expired','owner','owner@example.test','synthetic',NOW()-INTERVAL '1 day')")
    await query("INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at) VALUES ('expired','owner','synthetic',NOW()-INTERVAL '1 day')")
    await query("INSERT INTO reserved_usernames (username,user_id,reserved_until) VALUES ('expired','owner',NOW()-INTERVAL '1 day'),('live','owner',NOW()+INTERVAL '1 day')")
    await query("INSERT INTO email_send_attempts (id,purpose,ip_hash,email_hash,created_at) VALUES ('expired','email_verification','synthetic','synthetic',NOW()-INTERVAL '100 days')")
    await runCleanup()
    for (const table of ['sessions', 'email_verification_tokens', 'password_reset_tokens', 'email_send_attempts']) expect(await query(`SELECT * FROM ${table}`)).toHaveLength(0)
    expect(await query('SELECT username FROM reserved_usernames')).toEqual([{ username: 'live' }])
  })
})
