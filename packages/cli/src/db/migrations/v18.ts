import type Database from 'better-sqlite3'

export function migrateV18(db: Database.Database): void {
  db.exec(`
    CREATE VIEW activity_records AS
      SELECT id, rowid AS sort_key, ts, tool, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, thinking_tokens, cost,
             session_id, source_file, cwd, device_instance_id, origin FROM records
      UNION ALL
      SELECT id, rowid, ts, tool, model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, thinking_tokens, cost,
             session_key, source_file, cwd, device_instance_id, 'synced' FROM synced_records sr
      WHERE NOT EXISTS (SELECT 1 FROM records WHERE id = sr.id);

    CREATE TABLE synced_tool_calls (
      target TEXT NOT NULL, owner TEXT NOT NULL, id TEXT NOT NULL, record_id TEXT,
      tool TEXT NOT NULL, name TEXT NOT NULL, ts INTEGER NOT NULL, call_index INTEGER NOT NULL,
      PRIMARY KEY (owner, id, target)
    ) WITHOUT ROWID;
    CREATE INDEX idx_synced_calls_record ON synced_tool_calls(record_id);
    CREATE INDEX idx_synced_calls_target ON synced_tool_calls(target, owner);

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
        SELECT 1 FROM tool_calls existing WHERE existing.id = sc.id AND existing.record_id = sc.record_id
      );
    INSERT INTO schema_version (version) VALUES (18);
  `)
}
