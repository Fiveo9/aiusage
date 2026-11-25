import { sql } from '../db/pool.js'
import { nanoid } from 'nanoid'
import { ensureCuratedPricingAliases } from '../pricing/curated-aliases.js'
import { planLitellmPricing, type LitellmEntry } from '@aiusage/core'
import { error } from '@sveltejs/kit'
import type postgres from 'postgres'

async function lockAdminOperation(tx: postgres.TransactionSql, adminUserId: string, targetUserId: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtext('active-administrators'))`
  const users = await tx`SELECT id, role, status FROM users WHERE id IN (${adminUserId}, ${targetUserId}) ORDER BY id FOR UPDATE`
  const actor = users.find(row => row.id === adminUserId)
  if (!actor || actor.role !== 'admin' || actor.status !== 'active') throw error(403, 'Admin session is no longer active')
  const target = users.find(row => row.id === targetUserId)
  if (!target) throw error(404, 'User not found')
  return target
}

async function requireAnotherAdmin(tx: postgres.TransactionSql, targetUserId: string): Promise<void> {
  const rows = await tx`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND status = 'active' AND id != ${targetUserId}`
  if (Number(rows[0].count) < 1) throw error(403, 'Cannot remove the last active administrator')
}

export async function banUser(adminUserId: string, targetUserId: string, reason: string): Promise<void> {
  if (adminUserId === targetUserId) throw error(403, 'Cannot ban yourself')
  if (typeof reason !== 'string' || reason.length > 1000) throw error(400, 'Invalid ban reason')
  await sql.begin(async tx => {
    const target = await lockAdminOperation(tx, adminUserId, targetUserId)
    if (target.role === 'admin' && target.status === 'active') await requireAnotherAdmin(tx, targetUserId)
    await tx`UPDATE users SET status = 'banned', banned_at = NOW(), ban_reason = ${reason}, updated_at = NOW() WHERE id = ${targetUserId}`
    await tx`DELETE FROM sessions WHERE user_id = ${targetUserId}`
    await logAdminAction(adminUserId, 'ban_user', 'users', targetUserId, reason, undefined, tx)
  })
}

export async function unbanUser(adminUserId: string, targetUserId: string): Promise<void> {
  await sql`UPDATE users SET status = 'active', banned_at = NULL, ban_reason = NULL, updated_at = NOW() WHERE id = ${targetUserId}`
  await logAdminAction(adminUserId, 'unban_user', 'users', targetUserId, 'User unbanned')
}

export async function setCloudSync(adminUserId: string, targetUserId: string, banned: boolean): Promise<void> {
  await sql`UPDATE users SET cloud_sync_banned = ${banned}, updated_at = NOW() WHERE id = ${targetUserId}`
  await logAdminAction(adminUserId, 'set_cloud_sync', 'users', targetUserId, banned ? 'Cloud sync disabled for user' : 'Cloud sync re-enabled for user')
}

export async function setUserRole(adminUserId: string, targetUserId: string, role: string): Promise<void> {
  if (!['admin', 'user'].includes(role)) throw error(400, 'Invalid role')
  if (adminUserId === targetUserId) throw error(403, 'Cannot change your own role')
  await sql.begin(async tx => {
    const target = await lockAdminOperation(tx, adminUserId, targetUserId)
    if (target.role === 'admin' && target.status === 'active' && role !== 'admin') await requireAnotherAdmin(tx, targetUserId)
    await tx`UPDATE users SET role = ${role}::user_role, updated_at = NOW() WHERE id = ${targetUserId}`
    await logAdminAction(adminUserId, 'set_role', 'users', targetUserId, `Role set to ${role}`, undefined, tx)
  })
}

export async function getAdminAuditLogs(limit = 50, offset = 0) {
  return sql`
    SELECT al.*, u.display_name as admin_display_name
    FROM admin_audit_logs al
    JOIN users u ON u.id = al.admin_user_id
    ORDER BY al.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `
}

export async function clearAdminAuditLogs(adminUserId: string): Promise<number> {
  const result = await sql`DELETE FROM admin_audit_logs RETURNING id`
  await logAdminAction(adminUserId, 'clear_audit_logs', 'admin_audit_logs', '-', `Cleared ${result.length} logs`)
  return result.length
}

async function logAdminAction(adminUserId: string, action: string, targetType: string, targetId: string, reason: string, metadata?: Record<string, unknown>, tx?: postgres.TransactionSql): Promise<void> {
  const query = tx || sql
  await query`
    INSERT INTO admin_audit_logs (id, admin_user_id, action, target_type, target_id, reason, metadata)
    VALUES (${nanoid()}, ${adminUserId}, ${action}, ${targetType}, ${targetId}, ${reason}, ${metadata ? JSON.stringify(metadata) : null}::jsonb)
  `
}

// --- Pricing Management ---

const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

/**
 * Sync builtin entries from LiteLLM. User-origin rows are preserved.
 *
 * Several LiteLLM ids reduce to one model key (`aihubmix/claude-haiku-4-5`,
 * `vertex_ai/claude-haiku-4-5` and `claude-haiku-4-5`); `planLitellmPricing`
 * (@aiusage/core, shared with the CLI's price sync) gives each key one owner,
 * so the stored price does not depend on the order of the file and is the
 * one the CLI stores. The other ids stay aliases of the key.
 */
export async function syncPricingFromLitellm(adminUserId: string): Promise<{ added: number; updated: number; skipped: number; userPreserved: number; aliasesAdded: number; aliasesUpdated: number }> {
  const response = await fetch(LITELLM_PRICING_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`LiteLLM pricing fetch failed: HTTP ${response.status}`)
  const data = await response.json() as Record<string, LitellmEntry>
  const plan = planLitellmPricing(data)
  let added = 0, updated = 0, userPreserved = 0, aliasesAdded = 0, aliasesUpdated = 0
  const skipped = plan.skipped

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('pricing-write'))`
    type ExistingPrice = { model_key: string; provider: string; origin: string; input: string; output: string;
      cache_read: string | null; cache_write: string | null; currency: string; status: string }
    const existing = await tx<ExistingPrice[]>`SELECT model_key, provider, origin, input, output, cache_read, cache_write, currency, status FROM model_prices`
    const byKey = new Map(existing.map(row => [row.model_key, row]))
    const prices = plan.prices.filter(owner => {
      const row = byKey.get(owner.modelKey)
      if (row?.origin === 'user') {
        userPreserved++
        return false
      }
      if (!row) added++
      else {
        const changed = Number(row.input) !== owner.price.input || Number(row.output) !== owner.price.output ||
          (row.cache_read == null ? null : Number(row.cache_read)) !== (owner.price.cacheRead ?? null) ||
          (row.cache_write == null ? null : Number(row.cache_write)) !== (owner.price.cacheWrite ?? null) || row.currency !== 'USD'
        if (changed) updated++
      }
      if (!row || row.origin === 'builtin') {
        byKey.set(owner.modelKey, { model_key: owner.modelKey, provider: owner.provider, origin: 'builtin',
          input: String(owner.price.input), output: String(owner.price.output), cache_read: owner.price.cacheRead == null ? null : String(owner.price.cacheRead),
          cache_write: owner.price.cacheWrite == null ? null : String(owner.price.cacheWrite), currency: 'USD', status: 'active' })
      }
      return true
    })
    if (prices.length) {
      await tx`
        INSERT INTO model_prices (model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id, source_url, origin, status, last_synced_at)
        SELECT incoming.model_key, incoming.provider, incoming.input, incoming.output, incoming.cache_read, incoming.cache_write,
          'USD', 'litellm', incoming.source_model_id, ${LITELLM_PRICING_URL}, 'builtin', 'active', NOW()
        FROM UNNEST(${tx.array(prices.map(owner => owner.modelKey))}::text[], ${tx.array(prices.map(owner => owner.provider))}::text[],
          ${tx.array(prices.map(owner => owner.price.input))}::numeric[], ${tx.array(prices.map(owner => owner.price.output))}::numeric[],
          ${tx.array(prices.map(owner => owner.price.cacheRead ?? null))}::numeric[], ${tx.array(prices.map(owner => owner.price.cacheWrite ?? null))}::numeric[],
          ${tx.array(prices.map(owner => owner.sourceModelId))}::text[])
          AS incoming(model_key, provider, input, output, cache_read, cache_write, source_model_id)
        ON CONFLICT (model_key) DO UPDATE SET
          provider = EXCLUDED.provider, input = EXCLUDED.input, output = EXCLUDED.output,
          cache_read = EXCLUDED.cache_read, cache_write = EXCLUDED.cache_write,
          currency = 'USD', source = 'litellm', source_model_id = EXCLUDED.source_model_id,
          source_url = EXCLUDED.source_url, status = 'active', last_synced_at = NOW(), updated_at = NOW()
        WHERE model_prices.origin = 'builtin'
      `
    }

    const existingAliases = await tx<{ alias: string; model_key: string; origin: string; enabled: boolean }[]>`
      SELECT alias, model_key, origin, enabled FROM model_price_aliases`
    const aliasByName = new Map(existingAliases.map(row => [row.alias, row]))
    const aliases = plan.aliases.map(planned => {
      const own = byKey.get(planned.alias)
      const target = planned.datedShortcut && own?.status === 'active'
        ? { modelKey: planned.alias, provider: own.provider } : { modelKey: planned.modelKey, provider: planned.provider }
      const before = aliasByName.get(planned.alias)
      if (!before) aliasesAdded++
      else if (before.origin !== 'user' && (before.model_key !== target.modelKey || before.enabled !== true)) aliasesUpdated++
      return { alias: planned.alias, ...target }
    })
    if (aliases.length) {
      await tx`
        INSERT INTO model_price_aliases (alias, model_key, match_type, provider, priority, source, origin, enabled)
        SELECT incoming.alias, incoming.model_key, 'exact', incoming.provider, 100, 'litellm', 'builtin', TRUE
        FROM UNNEST(${tx.array(aliases.map(alias => alias.alias))}::text[], ${tx.array(aliases.map(alias => alias.modelKey))}::text[],
          ${tx.array(aliases.map(alias => alias.provider))}::text[]) AS incoming(alias, model_key, provider)
        ON CONFLICT (alias) DO UPDATE SET
          model_key = CASE WHEN model_price_aliases.origin = 'builtin' THEN EXCLUDED.model_key ELSE model_price_aliases.model_key END,
          provider = CASE WHEN model_price_aliases.origin = 'builtin' THEN EXCLUDED.provider ELSE model_price_aliases.provider END,
          source = CASE WHEN model_price_aliases.origin = 'builtin' THEN EXCLUDED.source ELSE model_price_aliases.source END,
          enabled = CASE WHEN model_price_aliases.origin = 'builtin' THEN TRUE ELSE model_price_aliases.enabled END,
          updated_at = NOW()
      `
    }

    // Curated aliases for model names no pricing source lists verbatim; they
    // are also applied on startup (runMigrations).
    const curated = await ensureCuratedPricingAliases(tx)
    aliasesAdded += curated.added
    aliasesUpdated += curated.updated
  })

  await logAdminAction(adminUserId, 'sync_pricing', 'model_prices', 'active', `Synced from LiteLLM: ${added} added, ${updated} updated, ${skipped} skipped, ${aliasesAdded} aliases added, ${aliasesUpdated} aliases updated`)
  return { added, updated, skipped, userPreserved, aliasesAdded, aliasesUpdated }
}

export async function getPriceEntries(adminUserId: string) {
  const entries = await sql`
    SELECT p.model_key AS id, p.model_key, p.input, p.output, p.cache_read, p.cache_write, p.currency,
           p.source, p.source_model_id, p.origin, p.last_synced_at, COALESCE(u.usage_count, 0)::INTEGER AS usage_count
    FROM model_prices p
    LEFT JOIN (
      SELECT model, COUNT(*)::INTEGER AS usage_count
      FROM cloud_usage_records
      WHERE deleted_at IS NULL
      GROUP BY model
    ) u ON u.model = p.model_key
    ORDER BY COALESCE(u.usage_count, 0) DESC, p.model_key ASC
  `
  return { entries }
}

export async function updatePriceEntries(
  adminUserId: string,
  updates: Array<{ id: string; input: number; output: number; cache_read: number | null; cache_write: number | null }>
): Promise<void> {
  if (!Array.isArray(updates) || !updates.length || updates.length > 1000) throw error(400, 'Invalid price updates')
  for (const entry of updates) validatePrice(entry, entry?.id)
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('pricing-write'))`
    for (const u of updates) {
      await tx`
        UPDATE model_prices
        SET input = ${u.input}, output = ${u.output}, cache_read = ${u.cache_read}, cache_write = ${u.cache_write}, origin = 'user', source = 'manual', updated_at = NOW()
        WHERE model_key = ${u.id}
      `
    }
    await logAdminAction(adminUserId, 'update_price_entries', 'model_prices', 'current', `Updated ${updates.length} entries`, undefined, tx)
  })
}

function validatePrice(entry: { input: unknown; output: unknown; cache_read: unknown; cache_write: unknown } | null, key: unknown): void {
  if (!entry || typeof key !== 'string' || !key.trim() || key.length > 256 || /[\x00-\x1f]/.test(key)) throw error(400, 'Invalid model key')
  for (const value of [entry.input, entry.output]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw error(400, 'Invalid price')
  }
  for (const value of [entry.cache_read, entry.cache_write]) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000)) throw error(400, 'Invalid cache price')
  }
}

export async function addPriceEntry(
  adminUserId: string,
  entry: { model_key: string; input: number; output: number; cache_read: number | null; cache_write: number | null; currency: string }
): Promise<string> {
  validatePrice(entry, entry?.model_key)
  if (!['USD', 'CNY'].includes(entry.currency)) throw error(400, 'Invalid currency')
  const id = entry.model_key
  await sql.begin(async tx => {
  await tx`SELECT pg_advisory_xact_lock(hashtext('pricing-write'))`
  await tx`
    INSERT INTO model_prices (model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id, origin, status)
    VALUES (${entry.model_key}, '', ${entry.input}, ${entry.output}, ${entry.cache_read}, ${entry.cache_write}, ${entry.currency}, 'manual', ${entry.model_key}, 'user', 'active')
    ON CONFLICT (model_key) DO UPDATE SET
      input = EXCLUDED.input, output = EXCLUDED.output, cache_read = EXCLUDED.cache_read, cache_write = EXCLUDED.cache_write,
      currency = EXCLUDED.currency, source = 'manual', source_model_id = EXCLUDED.source_model_id, origin = 'user', status = 'active', updated_at = NOW()
  `
  await tx`
    INSERT INTO model_price_aliases (alias, model_key, match_type, provider, priority, source, origin, enabled)
    VALUES (${entry.model_key}, ${entry.model_key}, 'exact', '', 200, 'manual', 'user', TRUE)
    ON CONFLICT (alias) DO UPDATE SET model_key = EXCLUDED.model_key, priority = 200, source = 'manual', origin = 'user', enabled = TRUE, updated_at = NOW()
  `
  await logAdminAction(adminUserId, 'add_price_entry', 'model_prices', id, `Added model ${entry.model_key}`, undefined, tx)
  })
  return id
}

export async function deletePriceEntry(adminUserId: string, entryId: string, modelKey: string): Promise<void> {
  if (typeof entryId !== 'string' || !entryId || entryId.length > 256) throw error(400, 'Invalid entry ID')
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('pricing-write'))`
    await tx`DELETE FROM model_price_aliases WHERE model_key = ${entryId}`
    await tx`DELETE FROM model_prices WHERE model_key = ${entryId}`
    await logAdminAction(adminUserId, 'delete_price_entry', 'model_prices', entryId, `Deleted model ${entryId}`, undefined, tx)
  })
}

export async function getPublicPriceEntries() {
  const entries = await sql`
    SELECT model_key, input, output, cache_read, cache_write, currency, source, source_model_id, origin, last_synced_at
    FROM model_prices
    WHERE status = 'active'
    ORDER BY model_key ASC
  `
  if (entries.length > 0) return { entries }
  return { entries: [] }
}
