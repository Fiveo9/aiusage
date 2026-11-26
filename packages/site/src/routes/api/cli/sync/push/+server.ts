import { isHttpError, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import type postgres from 'postgres'
import { sql } from '$lib/server/db/pool.js'
import { verifyDeviceRequest } from '$lib/server/auth/device-request.js'
import { getConfigValue, CFG } from '$lib/server/config.js'
import { checkCloudSyncAccess } from '$lib/server/cloud/star-check.js'
import { nanoid } from 'nanoid'
import { readLimitedText, parseJsonObject } from '$lib/server/request-body.js'
import { lockCloudGeneration } from '$lib/server/cloud/sync-state.js'

/** A record of a push that was not stored, and why. */
export interface RejectedRecord {
  id: string | null
  reason: 'missing_field' | 'invalid_value'
}

/** A tombstone of a push that was not applied, and why. */
export interface RejectedTombstone {
  record_id: string | null
  reason: 'missing_field' | 'invalid_value'
}

/** Why a pushed tombstone cannot be applied, or null when it can (see `recordProblem`). */
function tombstoneProblem(tombstone: Record<string, unknown>): RejectedTombstone['reason'] | null {
  if (!tombstone.record_id) return 'missing_field'
  if (typeof tombstone.record_id !== 'string' || tombstone.record_id.includes('\u0000')) return 'invalid_value'
  const updatedAt = tombstone.updatedAt
  if (updatedAt != null && (typeof updatedAt !== 'number' || !Number.isSafeInteger(updatedAt) || updatedAt < 0)) return 'invalid_value'
  return null
}

const BIGINT_FIELDS = ['ts', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'thinkingTokens', 'updatedAt'] as const
const TEXT_FIELDS = ['id', 'tool', 'model', 'provider', 'costSource', 'sessionKey', 'sessionTitle', 'sourceFile', 'cwd', 'deviceName', 'platform'] as const
// cost is NUMERIC(20, 8): at most 12 digits before the decimal point.
const MAX_COST = 1e12

/**
 * Why a pushed record cannot be stored, or null when it can. Checked before
 * the record reaches the database: a statement that fails aborts the whole
 * PostgreSQL transaction, so one bad record would fail the batch it came in
 * and every retry of it.
 */
function recordProblem(record: Record<string, unknown>): RejectedRecord['reason'] | null {
  if (!record.id || !record.tool || !record.model) return 'missing_field'
  for (const field of TEXT_FIELDS) {
    const value = record[field]
    if (value == null) continue
    // PostgreSQL text cannot hold NUL.
    if (typeof value !== 'string' || value.includes('\u0000')) return 'invalid_value'
  }
  for (const field of BIGINT_FIELDS) {
    const value = record[field]
    if (value == null) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return 'invalid_value'
  }
  if (record.cost != null && (typeof record.cost !== 'number' || !Number.isFinite(record.cost) || Math.abs(record.cost) >= MAX_COST)) {
    return 'invalid_value'
  }
  return null
}

async function registerInstance(tx: postgres.TransactionSql, userId: string, deviceId: string, instanceId: string, generation: number): Promise<string> {
  const existing = await tx`SELECT id FROM cloud_device_instances WHERE device_id = ${deviceId}`
  const rows = existing.length ? await tx`
    INSERT INTO cloud_device_instances (id, user_id, device_id, device_instance_id, sync_generation)
    VALUES (${nanoid()}, ${userId}, ${deviceId}, ${instanceId}, ${generation})
    ON CONFLICT (device_id) DO UPDATE SET device_instance_id = EXCLUDED.device_instance_id,
      sync_generation = EXCLUDED.sync_generation, updated_at = NOW()
    WHERE cloud_device_instances.user_id = EXCLUDED.user_id RETURNING id
  ` : await tx`
    INSERT INTO cloud_device_instances (id, user_id, device_id, device_instance_id, sync_generation)
    VALUES (${nanoid()}, ${userId}, ${deviceId}, ${instanceId}, ${generation})
    ON CONFLICT (user_id, device_instance_id) DO UPDATE SET device_id = EXCLUDED.device_id,
      sync_generation = EXCLUDED.sync_generation, updated_at = NOW() RETURNING id
  `
  if (!rows.length) throw new Error('Device instance registration failed')
  return rows[0].id as string
}

export const POST: RequestHandler = async ({ request }) => {
  const maxRecords = await getConfigValue(CFG.SYNC_MAX_RECORDS)
  const maxTombstones = await getConfigValue(CFG.SYNC_MAX_TOMBSTONES)
  const bodyMaxSize = await getConfigValue(CFG.SYNC_BODY_MAX_SIZE)

  const contentType = request.headers.get('Content-Type')
  if (!contentType || !contentType.includes('application/json')) {
    return json({ error: 'Content-Type must be application/json', error_code: 'invalid_content_type' }, { status: 415 })
  }

  let bodyText: string
  try {
    bodyText = await readLimitedText(request, bodyMaxSize)
  } catch (error) {
    if (isHttpError(error) && error.status === 413) return json({ error: 'Payload too large', error_code: 'payload_too_large' }, { status: 413 })
    throw error
  }

  let body: Record<string, unknown>
  try {
    body = parseJsonObject(bodyText)
  } catch {
    return json({ error: 'Invalid JSON', error_code: 'invalid_json' }, { status: 400 })
  }

  // Verify HMAC signature (reuse existing upload verification)
  const verification = await verifyDeviceRequest(request, bodyText)
  if (!verification.valid) {
    const status = verification.error_code === 'rate_limited' ? 429 : 401
    return json({ error: verification.error, error_code: verification.error_code }, { status })
  }

  const userId = verification.userId!
  const deviceId = verification.deviceId!
  const idempotencyKey = verification.idempotencyKey!

  // Star gate check
  const starCheck = await checkCloudSyncAccess(userId)
  if (!starCheck.allowed) {
    return json({
      error: { code: starCheck.error_code, message: starCheck.message, repo: starCheck.repo, url: starCheck.url }
    }, { status: starCheck.status || 403 })
  }

  // Validate body
  const schemaVersion = body.schema_version
  if (schemaVersion !== 1) {
    return json({ error: 'Unsupported schema version', error_code: 'unsupported_schema_version' }, { status: 400 })
  }

  const deviceInstanceId = body.device_instance_id
  if (typeof deviceInstanceId !== 'string' || !deviceInstanceId) {
    return json({ error: 'Missing device_instance_id', error_code: 'invalid_payload' }, { status: 400 })
  }

  const clientSyncGeneration = body.sync_generation
  if (typeof clientSyncGeneration !== 'number' || !Number.isSafeInteger(clientSyncGeneration) || clientSyncGeneration < 0) {
    return json({ error: 'Missing sync_generation', error_code: 'invalid_payload' }, { status: 400 })
  }

  const records = Array.isArray(body.records) ? body.records : []
  const tombstones = Array.isArray(body.tombstones) ? body.tombstones : []

  if (records.length > maxRecords) {
    return json({ error: `Too many records (max ${maxRecords})`, error_code: 'payload_too_large' }, { status: 400 })
  }
  if (tombstones.length > maxTombstones) {
    return json({ error: `Too many tombstones (max ${maxTombstones})`, error_code: 'payload_too_large' }, { status: 400 })
  }

  // Process records and tombstones in a transaction
  let batchId = nanoid()
  let inserted = 0
  let updated = 0
  // Records not written: older than or equal to the stored version (the
  // server already has it), or rejected below.
  let skipped = 0
  // Records that were not stored at all. The client must not count them as
  // synced; older clients ignore the field.
  const rejected: RejectedRecord[] = []
  // Tombstones that were not applied, likewise: the client keeps them to send
  // again instead of forgetting them as retracted.
  const rejectedTombstones: RejectedTombstone[] = []

  try {
    return await sql.begin(async (tx) => {
      const serverGeneration = await lockCloudGeneration(tx, userId)
      if (clientSyncGeneration < serverGeneration) return json({ error: 'Sync generation stale. Please pull first.',
        error_code: 'sync_generation_stale', server_generation: serverGeneration }, { status: 409 })
      const devices = await tx`SELECT status FROM user_devices WHERE user_id = ${userId} AND id = ${deviceId} FOR UPDATE`
      if (!devices.length || devices[0].status !== 'active') return json({ error: 'Device revoked', error_code: 'device_revoked' }, { status: 401 })
      const batches = await tx`SELECT id, status, response_summary FROM cloud_sync_batches
        WHERE device_id = ${deviceId} AND idempotency_key = ${idempotencyKey} FOR UPDATE`
      const previous = batches[0]
      if (previous?.status === 'accepted') {
        let summary: Record<string, unknown> | null = null
        try {
          const value = typeof previous.response_summary === 'string' ? JSON.parse(previous.response_summary) : previous.response_summary
          if (value && typeof value === 'object' && !Array.isArray(value)) summary = value as Record<string, unknown>
        } catch { /* incomplete legacy receipts are never acknowledged */ }
        if (!summary) return json({ error: 'Legacy receipt unavailable; retry with a new idempotency key.', error_code: 'receipt_unavailable' }, { status: 500 })
        if (summary.sync_generation !== serverGeneration) return json({ error: 'Idempotency key belongs to an older generation.', error_code: 'idempotency_generation_stale', server_generation: serverGeneration }, { status: 409 })
        return json(summary)
      }
      if (previous) batchId = previous.id as string
      const instanceRowId = await registerInstance(tx, userId, deviceId, deviceInstanceId, serverGeneration)
      const valid: Record<string, any>[] = []
      for (const record of records) {
        const problem = record !== null && typeof record === 'object' ? recordProblem(record) : 'invalid_value'
        if (problem) {
          rejected.push({ id: typeof record?.id === 'string' ? record.id : null, reason: problem })
          skipped++
          continue
        }
        valid.push(record)
      }
      // The generation lock serializes writers; row locks also exclude maintenance
      // while input-order versions/counters and inherited titles are consolidated.
      const existing = valid.length ? await tx<{ record_id: string; updated_at: string; session_title: string }[]>`
        SELECT record_id, updated_at::text, session_title FROM cloud_usage_records
        WHERE user_id = ${userId} AND sync_generation = ${serverGeneration}
          AND device_instance_id = ${deviceInstanceId}
          AND record_id = ANY(${tx.array([...new Set(valid.map(record => record.id))])}::text[])
        FOR UPDATE
      ` : []
      const before = new Map(existing.map(row => [row.record_id, row]))
      type Entry = { id: string; record: Record<string, any>; updatedAt: number; title: string }
      const changed = new Map<string, Entry>()
      for (const record of valid) {
        const prior = changed.get(record.id)
        const stored = before.get(record.id)
        const version = prior?.updatedAt ?? stored?.updated_at
        const updatedAt = record.updatedAt ?? Date.now()
        if (version !== undefined && BigInt(updatedAt) <= BigInt(version)) { skipped++; continue }
        if (version === undefined) inserted++
        else updated++
        changed.set(record.id, { id: prior?.id ?? nanoid(), record, updatedAt,
          title: record.sessionTitle || prior?.title || stored?.session_title || '' })
      }
      const entries = [...changed.values()]
      if (entries.length) {
        const column = (value: (entry: Entry) => any) => tx.array(entries.map(value))
        await tx`
          INSERT INTO cloud_usage_records (
            id, user_id, device_id, device_instance_id, sync_generation,
            record_id, ts, tool, model, provider,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens,
            cost, cost_source, session_key, session_title, source_file, cwd,
            device_name, platform, updated_at, server_updated_at
          ) SELECT incoming.id, ${userId}, ${deviceId}, ${deviceInstanceId}, ${serverGeneration},
            incoming.record_id, incoming.ts, incoming.tool, incoming.model, incoming.provider,
            incoming.input_tokens, incoming.output_tokens, incoming.cache_read_tokens, incoming.cache_write_tokens, incoming.thinking_tokens,
            incoming.cost, incoming.cost_source, incoming.session_key, incoming.session_title, incoming.source_file, incoming.cwd,
            incoming.device_name, incoming.platform, incoming.updated_at, NOW()
          FROM UNNEST(
            ${column(entry => entry.id)}::text[], ${column(entry => entry.record.id)}::text[],
            ${column(entry => entry.record.ts || 0)}::bigint[], ${column(entry => entry.record.tool)}::text[],
            ${column(entry => entry.record.model)}::text[], ${column(entry => entry.record.provider || '')}::text[],
            ${column(entry => entry.record.inputTokens || 0)}::bigint[], ${column(entry => entry.record.outputTokens || 0)}::bigint[],
            ${column(entry => entry.record.cacheReadTokens || 0)}::bigint[], ${column(entry => entry.record.cacheWriteTokens || 0)}::bigint[],
            ${column(entry => entry.record.thinkingTokens || 0)}::bigint[], ${column(entry => entry.record.cost ?? null)}::numeric[],
            ${column(entry => entry.record.costSource || null)}::text[], ${column(entry => entry.record.sessionKey || '')}::text[],
            ${column(entry => entry.title)}::text[], ${column(entry => entry.record.sourceFile || '')}::text[],
            ${column(entry => entry.record.cwd || '')}::text[], ${column(entry => entry.record.deviceName || null)}::text[],
            ${column(entry => entry.record.platform || null)}::text[], ${column(entry => entry.updatedAt)}::bigint[]
          ) AS incoming(id, record_id, ts, tool, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            thinking_tokens, cost, cost_source, session_key, session_title, source_file, cwd, device_name, platform, updated_at)
          ON CONFLICT (user_id, sync_generation, device_instance_id, record_id) DO UPDATE SET
            ts = EXCLUDED.ts, tool = EXCLUDED.tool, model = EXCLUDED.model, provider = EXCLUDED.provider,
            input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
            cache_read_tokens = EXCLUDED.cache_read_tokens, cache_write_tokens = EXCLUDED.cache_write_tokens,
            thinking_tokens = EXCLUDED.thinking_tokens, cost = EXCLUDED.cost, cost_source = EXCLUDED.cost_source,
            session_key = EXCLUDED.session_key,
            session_title = COALESCE(NULLIF(EXCLUDED.session_title, ''), cloud_usage_records.session_title),
            source_file = EXCLUDED.source_file, cwd = EXCLUDED.cwd, device_name = EXCLUDED.device_name, platform = EXCLUDED.platform,
            updated_at = EXCLUDED.updated_at,
            server_updated_at = NOW(),
            deleted_at = NULL,
            change_seq = nextval(pg_get_serial_sequence('cloud_usage_records', 'change_seq'))
          WHERE cloud_usage_records.updated_at < EXCLUDED.updated_at
        `
      }

      // Process tombstones
      const tombstoneVersions = new Map<string, number>()
      for (const tombstone of tombstones) {
        const problem = tombstone !== null && typeof tombstone === 'object' ? tombstoneProblem(tombstone) : 'invalid_value'
        if (problem) {
          rejectedTombstones.push({ record_id: typeof tombstone?.record_id === 'string' ? tombstone.record_id : null, reason: problem })
          skipped++
          continue
        }
        const tombstoneUpdatedAt = tombstone.updatedAt ?? Date.now()
        const previousVersion = tombstoneVersions.get(tombstone.record_id)
        if (previousVersion === undefined || tombstoneUpdatedAt > previousVersion) tombstoneVersions.set(tombstone.record_id, tombstoneUpdatedAt)
      }
      if (tombstoneVersions.size) {
        await tx`
          UPDATE cloud_usage_records AS stored
          SET deleted_at = NOW(), server_updated_at = NOW(), updated_at = incoming.updated_at,
            change_seq = nextval(pg_get_serial_sequence('cloud_usage_records', 'change_seq'))
          FROM UNNEST(${tx.array([...tombstoneVersions.keys()])}::text[], ${tx.array([...tombstoneVersions.values()])}::bigint[])
            AS incoming(record_id, updated_at)
          WHERE stored.user_id = ${userId} AND stored.sync_generation = ${serverGeneration}
            AND stored.device_instance_id = ${deviceInstanceId} AND stored.record_id = incoming.record_id
            AND stored.updated_at <= incoming.updated_at
            AND (stored.deleted_at IS NULL OR stored.updated_at < incoming.updated_at)
        `
      }

      // Update device instance cursor
      await tx`
        UPDATE cloud_device_instances
        SET last_push_cursor = ${(body.server_cursor as string | undefined) || null}, updated_at = NOW()
        WHERE id = ${instanceRowId}
      `

      // Update sync state
      await tx`
        INSERT INTO cloud_sync_state (user_id, device_id, last_push_at, updated_at)
        VALUES (${userId}, ${deviceId}, NOW(), NOW())
        ON CONFLICT (user_id, device_id)
        DO UPDATE SET last_push_at = NOW(), updated_at = NOW()
      `
      const cursorRow = await tx`SELECT MAX(change_seq) AS max_seq FROM cloud_usage_records
        WHERE user_id = ${userId} AND sync_generation = ${serverGeneration}`
      const summary = { status: 'accepted', batch_id: batchId, inserted, updated, skipped, rejected,
        rejected_tombstones: rejectedTombstones, sync_generation: serverGeneration, server_cursor: String(cursorRow[0]?.max_seq ?? '0') }
      await tx`INSERT INTO cloud_sync_batches (id, user_id, device_id, idempotency_key, direction, record_count, status, response_summary)
        VALUES (${batchId}, ${userId}, ${deviceId}, ${idempotencyKey}, 'push', ${records.length}, 'accepted', ${JSON.stringify(summary)})
        ON CONFLICT (device_id, idempotency_key) DO UPDATE SET status = 'accepted', error_code = NULL, response_summary = EXCLUDED.response_summary,
          record_count = EXCLUDED.record_count
        WHERE cloud_sync_batches.status != 'accepted'`
      return json(summary)
    })
  } catch (err) {
    if (isHttpError(err)) return json({ error: err.body.message, error_code: err.body.message }, { status: err.status })
    const databaseError = err as { code?: string; constraint_name?: string; constraint?: string }
    const constraint = databaseError.constraint_name ?? databaseError.constraint
    if (databaseError.code === '23505' && constraint?.startsWith('cloud_device_instances_')) {
      return json({ error: 'Device instance is already bound.', error_code: 'device_instance_conflict' }, { status: 409 })
    }
    // Record failed batch
    try {
      await sql`
        INSERT INTO cloud_sync_batches (id, user_id, device_id, idempotency_key, direction, record_count, status, error_code)
        VALUES (${batchId}, ${userId}, ${deviceId}, ${idempotencyKey}, 'push', ${records.length}, 'failed', 'server_error')
        ON CONFLICT (device_id, idempotency_key) DO UPDATE SET status = 'failed', error_code = 'server_error'
        WHERE cloud_sync_batches.status != 'accepted'
      `
    } catch {}

    return json({ error: 'Internal server error', error_code: 'server_error' }, { status: 500 })
  }
}
