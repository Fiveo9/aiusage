import type Database from 'better-sqlite3'

export function migrateV19(db: Database.Database): void {
  db.exec(`
    ALTER TABLE records ADD COLUMN session_title TEXT NOT NULL DEFAULT '';
    ALTER TABLE synced_records ADD COLUMN session_title TEXT NOT NULL DEFAULT '';
    CREATE INDEX idx_records_session_title ON records(session_id, device_instance_id, updated_at DESC) WHERE session_title != '';
    CREATE INDEX idx_synced_session_title ON synced_records(session_key, device_instance_id, updated_at DESC) WHERE session_title != '';

    CREATE VIEW activity_session_titles AS
      SELECT id, device_instance_id, session_id, tool, session_title, updated_at
      FROM records WHERE session_title != ''
      UNION ALL
      SELECT id, device_instance_id, session_key, tool, session_title, updated_at
      FROM synced_records sr WHERE session_title != ''
        AND NOT EXISTS (SELECT 1 FROM records r WHERE r.id = sr.id);

    CREATE TABLE session_title_sources (
      source_file TEXT PRIMARY KEY,
      signature TEXT NOT NULL,
      titles_json TEXT NOT NULL
    );
    INSERT INTO schema_version (version) VALUES (19);
  `)
}
