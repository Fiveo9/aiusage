import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queries, resetFakeSql, respondWith, type RecordedQuery } from '../mocks/sql.js'

vi.mock('../../src/lib/server/db/pool.js', async () => ({ sql: (await import('../mocks/sql.js')).fakeSql }))

import { approveSnapshot, hideSnapshot, rejectSnapshot } from '../../src/lib/server/admin/operations.js'

const isReview = (q: RecordedQuery) => q.text.startsWith('UPDATE upload_snapshots')
const isMetricUpdate = (q: RecordedQuery) => q.text.startsWith('UPDATE leaderboard_metrics')
const isNewerLookup = (q: RecordedQuery) => q.text.startsWith('SELECT 1 FROM upload_snapshots')
const isAudit = (q: RecordedQuery) => q.text.startsWith('INSERT INTO admin_audit_logs')

function database(options: { snapshotExists?: boolean; metricRows?: number; newerUnapproved?: boolean } = {}) {
  const { snapshotExists = true, metricRows = 4, newerUnapproved = false } = options
  respondWith((q) => {
    if (isReview(q)) return snapshotExists ? [{ id: 'snap_1' }] : []
    if (isMetricUpdate(q)) return Array.from({ length: metricRows }, (_, i) => ({ id: `metric_${i}` }))
    if (isNewerLookup(q)) return newerUnapproved ? [{}] : []
    return undefined
  })
}

function auditMetadata(): unknown {
  const audit = queries.find(isAudit)
  expect(audit).toBeDefined()
  return JSON.parse(audit!.values[audit!.values.length - 1] as string)
}

beforeEach(() => {
  resetFakeSql()
})

describe.each([
  ['rejectSnapshot', rejectSnapshot, 'rejected'],
  ['hideSnapshot', hideSnapshot, 'hidden'],
] as const)('%s', (_name, action, reviewStatus) => {
  it('hides the metric rows of the snapshot\'s user and period, not of its upload request', async () => {
    database()

    await action('admin_1', 'snap_1')

    const update = queries.find(isMetricUpdate)!
    expect(update.text).toContain("SET visibility = 'hidden'")
    expect(update.text).toContain('FROM upload_snapshots s WHERE s.id = ?')
    expect(update.text).toContain('lm.user_id = s.user_id AND lm.period_type = s.period_type AND lm.period_start = s.period_start')
    // Later uploads of the period re-point the rows at their own request, so a
    // match on the snapshot's request id would hit nothing.
    expect(update.text).not.toContain('upload_request_id')
    expect(update.values).toEqual(['snap_1'])
    expect(queries.find(isReview)!.values[0]).toBe(reviewStatus)
  })

  it('reports how many metric rows it changed, to the caller and in the audit log', async () => {
    database({ metricRows: 4 })

    await expect(action('admin_1', 'snap_1')).resolves.toEqual({ metricsUpdated: 4 })
    expect(auditMetadata()).toEqual({ metrics_updated: 4 })
  })

  it('reports when no metric row matched', async () => {
    database({ metricRows: 0 })

    await expect(action('admin_1', 'snap_1')).resolves.toEqual({ metricsUpdated: 0 })
    expect(auditMetadata()).toEqual({ metrics_updated: 0 })
  })

  it('fails for a snapshot that does not exist, without touching metrics or the audit log', async () => {
    database({ snapshotExists: false })

    await expect(action('admin_1', 'missing')).rejects.toThrow('Snapshot not found')
    expect(queries.some(isMetricUpdate)).toBe(false)
    expect(queries.some(isAudit)).toBe(false)
  })
})

describe('approveSnapshot', () => {
  it('publishes the metric rows of the snapshot\'s user and period', async () => {
    database({ metricRows: 4 })

    await expect(approveSnapshot('admin_1', 'snap_1')).resolves.toEqual({ metricsUpdated: 4 })

    const update = queries.find(isMetricUpdate)!
    expect(update.text).toContain("SET visibility = 'public'")
    expect(update.text).toContain('lm.user_id = s.user_id AND lm.period_type = s.period_type AND lm.period_start = s.period_start')
    expect(update.text).not.toContain('upload_request_id')
    expect(auditMetadata()).toEqual({ metrics_updated: 4 })
  })

  it('does not publish while a newer flagged upload of the period is not approved', async () => {
    database({ metricRows: 0, newerUnapproved: true })

    await expect(approveSnapshot('admin_1', 'snap_1')).resolves.toEqual({ metricsUpdated: 0, superseded: true })

    // The guard is part of the update itself, so there is no gap between the
    // check and the write.
    const update = queries.find(isMetricUpdate)!
    expect(update.text).toContain('AND NOT EXISTS ( SELECT 1 FROM upload_snapshots newer')
    expect(update.text).toContain("newer.created_at > s.created_at AND newer.status = 'flagged' AND newer.review_status IS DISTINCT FROM 'approved'")
    expect(auditMetadata()).toEqual({ metrics_updated: 0, superseded: true })
  })

  it('reports when no metric row matched and nothing newer is in the way', async () => {
    database({ metricRows: 0, newerUnapproved: false })

    await expect(approveSnapshot('admin_1', 'snap_1')).resolves.toEqual({ metricsUpdated: 0, superseded: false })
    expect(auditMetadata()).toEqual({ metrics_updated: 0 })
  })

  it('fails for a snapshot that does not exist', async () => {
    database({ snapshotExists: false })

    await expect(approveSnapshot('admin_1', 'missing')).rejects.toThrow('Snapshot not found')
    expect(queries.some(isMetricUpdate)).toBe(false)
    expect(queries.some(isAudit)).toBe(false)
  })
})
