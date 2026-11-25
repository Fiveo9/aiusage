import type Database from 'better-sqlite3'
import type { SyncBackend } from './index.js'
import { contentDigest } from './manifest.js'
import { isSafeDeviceInstanceId, isSafeSyncPath } from './safe-path.js'

const fileName = 'tool-calls.v1.json'
export const isToolCallPath = (path: string) => isSafeSyncPath(path) && /^[^/]+\/tool-calls\.v1\.json$/.test(path)

interface Call {
  id: string; recordId: string | null; tool: string; name: string; ts: number; callIndex: number
}

const peerCaches = new WeakMap<Database.Database, Map<string, Map<string, { digest: string; calls: Call[] }>>>()

function parseCalls(content: string, owner: string): Call[] {
  const snapshot = JSON.parse(content)
  if (snapshot?.version !== 1 || snapshot.owner !== owner || !Array.isArray(snapshot.calls)) {
    throw new Error('Invalid tool call snapshot')
  }
  const ids = new Set<string>()
  for (const call of snapshot.calls) {
    if (!call || typeof call.id !== 'string' || !call.id || ids.has(call.id)
      || !(call.recordId === null || typeof call.recordId === 'string' && call.recordId.length > 0)
      || typeof call.tool !== 'string' || typeof call.name !== 'string'
      || !Number.isSafeInteger(call.ts) || !Number.isSafeInteger(call.callIndex)) throw new Error('Invalid tool call entry')
    ids.add(call.id)
  }
  return snapshot.calls.map((call: Call) => ({ id: call.id, recordId: call.recordId, tool: call.tool,
    name: call.name, ts: call.ts, callIndex: call.callIndex }))
}

export async function syncToolCallSnapshots(db: Database.Database, backend: SyncBackend, target: string,
  own: string, paths: string[], digests: Map<string, string> | undefined, wireIds: Map<string, string>): Promise<number> {
  if (!isSafeDeviceInstanceId(own)) throw new Error('Invalid tool call namespace owner')
  let targets = peerCaches.get(db)
  if (!targets) { targets = new Map(); peerCaches.set(db, targets) }
  let cache = targets.get(target)
  if (!cache) { cache = new Map(); targets.set(target, cache) }
  const listed = new Set(paths.filter(isToolCallPath))
  const known = db.prepare('SELECT DISTINCT owner FROM synced_tool_calls WHERE target = ?').all(target) as { owner: string }[]
  const owners = new Set([...known.map(row => row.owner), ...Array.from(listed, path => path.split('/')[0])])
  owners.delete(own)
  const clear = db.prepare('DELETE FROM synced_tool_calls WHERE target = ? AND owner = ?')
  const insert = db.prepare(`INSERT INTO synced_tool_calls (target, owner, id, record_id, tool, name, ts, call_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const owner of owners) {
    if (!isSafeDeviceInstanceId(owner)) continue
    const path = `${owner}/${fileName}`
    let calls: Call[]
    const digest = digests?.get(path)
    let cacheable = false
    try {
      const saved = cache.get(owner)
      if (digest && saved?.digest === digest && listed.has(path)) {
        calls = saved.calls
        cacheable = true
      } else {
        const remote = await backend.readFile(path)
        if (remote === null && listed.has(path)) continue
        calls = remote === null ? [] : parseCalls(remote, owner)
        // A listing can race a write. Never associate new bytes with an old ETag.
        cacheable = remote !== null && digest !== undefined && contentDigest(remote) === digest
      }
    } catch {
      // A broken peer is not an authoritative empty snapshot.
      continue
    }
    db.transaction(() => {
      clear.run(target, owner)
      for (const call of calls) insert.run(target, owner, call.id, call.recordId, call.tool, call.name, call.ts, call.callIndex)
    }).immediate()
    if (cacheable && digest) cache.set(owner, { digest, calls })
    else cache.delete(owner)
  }
  for (const owner of cache.keys()) if (!owners.has(owner)) cache.delete(owner)

  const calls: Call[] = []
  const local = db.prepare(`SELECT tc.id, tc.record_id AS recordId, COALESCE(r.tool, tc.tool, '') AS tool,
      tc.name, tc.ts, tc.call_index AS callIndex FROM tool_calls tc LEFT JOIN records r ON r.id = tc.record_id
      WHERE tc.record_id IS NULL OR (r.origin = 'local' AND r.device_instance_id = ?) ORDER BY tc.id`)
  for (const row of local.iterate(own) as Iterable<Call>) {
    if (row.recordId !== null) {
      const wireId = wireIds.get(row.recordId)
      if (!wireId) continue
      row.recordId = wireId
    }
    calls.push(row)
  }
  const path = `${own}/${fileName}`
  if (!calls.length && !listed.has(path)) return 0
  const content = JSON.stringify({ version: 1, owner: own, calls })
  if (digests?.get(path) === contentDigest(content) || (listed.has(path) && await backend.readFile(path) === content)) return 0
  await backend.writeFile(path, content)
  return 1
}
