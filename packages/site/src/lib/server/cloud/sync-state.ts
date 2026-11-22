import { error } from '@sveltejs/kit'
import type postgres from 'postgres'
import { sql } from '../db/pool.js'

/** All generation-changing/writing operations lock the stable user row first. */
export async function lockCloudUser(tx: postgres.TransactionSql, userId: string): Promise<void> {
  const users = await tx`SELECT status FROM users WHERE id = ${userId} FOR UPDATE`
  if (!users.length || users[0].status !== 'active') throw error(403, 'user_banned')
}

export async function lockCloudGeneration(tx: postgres.TransactionSql, userId: string): Promise<number> {
  await lockCloudUser(tx, userId)
  const resets = await tx`SELECT sync_generation FROM cloud_sync_resets WHERE user_id = ${userId}`
  const generation = Number(resets[0]?.sync_generation ?? 1)
  if (!Number.isSafeInteger(generation) || generation < 1) throw error(500, 'sync_generation_out_of_range')
  return generation
}

export async function clearCloudData(userId: string, deviceId: string | null = null) {
  return sql.begin(async tx => {
    const generation = await lockCloudGeneration(tx, userId)
    const nextGeneration = generation + 1
    if (!Number.isSafeInteger(nextGeneration)) throw error(500, 'sync_generation_out_of_range')
    const cursor = await tx`SELECT MAX(change_seq) AS max_seq FROM cloud_usage_records
      WHERE user_id = ${userId} AND sync_generation = ${generation}`
    const before = cursor[0]?.max_seq ?? '0'
    await tx`UPDATE cloud_usage_records SET deleted_at = NOW(), server_updated_at = NOW(),
      change_seq = nextval(pg_get_serial_sequence('cloud_usage_records', 'change_seq'))
      WHERE user_id = ${userId} AND deleted_at IS NULL`
    await tx`INSERT INTO cloud_sync_resets (user_id, sync_generation, clear_before_change_seq, reset_at, reset_by_device_id)
      VALUES (${userId}, ${nextGeneration}, ${before}, NOW(), ${deviceId})
      ON CONFLICT (user_id) DO UPDATE SET sync_generation = EXCLUDED.sync_generation,
        clear_before_change_seq = EXCLUDED.clear_before_change_seq, reset_at = NOW(), reset_by_device_id = EXCLUDED.reset_by_device_id`
    await tx`UPDATE cloud_device_instances SET sync_generation = ${nextGeneration}, updated_at = NOW() WHERE user_id = ${userId}`
    return { status: 'cleared', sync_generation: nextGeneration, clear_before_change_seq: before }
  })
}
