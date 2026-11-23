import type Database from 'better-sqlite3'

/** NULL-parent local orphans and their mirrored copies are the same call. */
export function migrateV20(db: Database.Database): void {
  db.exec(`
    DROP VIEW activity_tool_calls;
    CREATE VIEW activity_tool_calls AS
      SELECT tc.id, tc.record_id, tc.tool, tc.name, tc.ts, tc.call_index,
             parent.device_instance_id AS owner, COALESCE(parent.origin, 'local') AS origin
      FROM tool_calls tc LEFT JOIN records parent ON parent.id = tc.record_id
      UNION ALL
      SELECT sc.id, sc.record_id, sc.tool, sc.name, sc.ts, sc.call_index, sc.owner, 'synced'
      FROM synced_tool_calls sc
      WHERE (sc.record_id IS NULL OR EXISTS (
        SELECT 1 FROM records parent WHERE parent.id = sc.record_id
        AND parent.origin = 'synced' AND parent.device_instance_id = sc.owner
      )) AND NOT EXISTS (
        SELECT 1 FROM synced_tool_calls other WHERE other.owner = sc.owner
        AND other.id = sc.id AND other.target < sc.target
      ) AND NOT EXISTS (
        SELECT 1 FROM tool_calls existing WHERE existing.id = sc.id AND existing.record_id IS sc.record_id
      );
    INSERT INTO schema_version (version) VALUES (20);
  `)
}
