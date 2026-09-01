import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_state (
  key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_session (
  did TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS edit_secret (
  poll_uri TEXT NOT NULL, token_hash TEXT NOT NULL, rkey TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (poll_uri, token_hash));
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_did TEXT NOT NULL, poll_uri TEXT NOT NULL, rkey TEXT NOT NULL,
  record_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS poll_cache (
  rkey TEXT PRIMARY KEY, uri TEXT NOT NULL, host_did TEXT NOT NULL,
  cid TEXT, record_json TEXT NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS response_cache (
  poll_rkey TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
  record_json TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (poll_rkey, source, key));
CREATE TABLE IF NOT EXISTS participant (
  poll_rkey TEXT NOT NULL, did TEXT NOT NULL, handle TEXT, PRIMARY KEY (poll_rkey, did));
CREATE TABLE IF NOT EXISTS web_session (
  sid TEXT PRIMARY KEY, did TEXT NOT NULL, handle TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS web_session_did ON web_session (did);
`;

/**
 * Columns added after a table first shipped. `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table alone, so a deployed database only gains these here — each is applied
 * once, when `table_info` shows the column missing.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'participant', column: 'handle', ddl: 'ALTER TABLE participant ADD COLUMN handle TEXT' },
];

export type { Database };

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(ddl);
  }
  return db;
}
