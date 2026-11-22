import { sql } from './pool.js'
import cron from 'node-cron'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { nanoid } from 'nanoid'

export async function runCleanup(adminUserId?: string, reason: string | null = null): Promise<Record<string, number>> {
  const now = new Date()
  const [nonceHours, deviceAuthHours, batchDays, tombstoneDays, emailDays] = await Promise.all([
    getConfigValue(CFG.RETENTION_NONCE_HOURS), getConfigValue(CFG.RETENTION_DEVICE_AUTH_HOURS),
    getConfigValue(CFG.RETENTION_SYNC_BATCH_DAYS), getConfigValue(CFG.RETENTION_TOMBSTONE_DAYS),
    getConfigValue(CFG.EMAIL_SEND_ATTEMPT_RETENTION_DAYS),
  ])
  const cutoff = (hours: number) => new Date(now.getTime() - hours * 3_600_000)
  return sql.begin(async tx => {
    const results: Record<string, number> = {}
    results.sessions_cleaned = (await tx`DELETE FROM sessions WHERE expires_at < ${now}`).count
    results.nonces_cleaned = (await tx`DELETE FROM upload_nonces WHERE created_at < ${cutoff(nonceHours)}`).count
    results.batches_cleaned = (await tx`DELETE FROM cloud_sync_batches WHERE created_at < ${cutoff(batchDays * 24)}`).count
    results.tombstoned_records_cleaned = (await tx`DELETE FROM cloud_usage_records WHERE deleted_at IS NOT NULL AND deleted_at < ${cutoff(tombstoneDays * 24)}`).count
    results.old_generation_cleaned = (await tx`DELETE FROM cloud_usage_records r USING cloud_sync_resets s WHERE r.user_id = s.user_id AND r.sync_generation < s.sync_generation`).count
    results.expired_auth_requests_cleaned = (await tx`DELETE FROM device_auth_requests WHERE expires_at < ${cutoff(deviceAuthHours)}`).count
    results.expired_reserved_usernames_cleaned = (await tx`DELETE FROM reserved_usernames WHERE reserved_until < ${now}`).count
    results.email_verification_tokens_cleaned = (await tx`DELETE FROM email_verification_tokens WHERE expires_at < ${now}`).count
    results.password_reset_tokens_cleaned = (await tx`DELETE FROM password_reset_tokens WHERE expires_at < ${now}`).count
    results.email_attempts_cleaned = (await tx`DELETE FROM email_send_attempts WHERE created_at < ${cutoff(emailDays * 24)}`).count
    results.oauth_states_cleaned = (await tx`DELETE FROM oauth_states WHERE expires_at < ${now}`).count
    results.auth_rate_limits_cleaned = (await tx`DELETE FROM auth_rate_limits WHERE window_start < ${cutoff(24)}`).count
    if (adminUserId) await tx`INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, reason, metadata)
      VALUES (${nanoid()}, ${adminUserId}, 'maintenance_cleanup', 'system', 'cleanup', ${reason}, ${JSON.stringify(results)}::jsonb)`
    return results
  })
}

let cleanupScheduled = false

export function startCleanupCron(): void {
  if (cleanupScheduled) return
  // Run daily at 03:00 UTC
  cron.schedule('0 3 * * *', async () => {
    console.log('[cleanup] Starting daily cleanup...')
    try {
      const results = await runCleanup()
      console.log('[cleanup] Daily cleanup complete.', results)
    } catch (err) {
      console.error('[cleanup] Error during cleanup:', err)
    }
  }, { timezone: 'UTC' })
  cleanupScheduled = true

  console.log('[cleanup] Cron job registered (daily at 03:00 UTC)')
}
