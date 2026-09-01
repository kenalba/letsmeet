import type { Database } from './db.js';

export interface OutboxItem {
  id: number;
  hostDid: string;
  pollUri: string;
  rkey: string;
  record: Record<string, unknown>;
  attempts: number;
}

export function enqueueOutbox(
  db: Database.Database,
  item: { hostDid: string; pollUri: string; rkey: string; record: object },
  now: number,
): number {
  db.prepare(
    "UPDATE outbox SET done = 1, last_error = 'superseded' WHERE done = 0 AND host_did = ? AND rkey = ?",
  ).run(item.hostDid, item.rkey);
  const res = db.prepare(
    `INSERT INTO outbox (host_did, poll_uri, rkey, record_json, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(item.hostDid, item.pollUri, item.rkey, JSON.stringify(item.record), now, now);
  return Number(res.lastInsertRowid);
}

export function dueOutbox(db: Database.Database, now: number): OutboxItem[] {
  const rows = db.prepare(
    'SELECT * FROM outbox WHERE done = 0 AND next_attempt_at <= ? ORDER BY id',
  ).all(now) as Array<{
    id: number; host_did: string; poll_uri: string; rkey: string;
    record_json: string; attempts: number;
  }>;
  return rows.map((r) => ({
    id: r.id, hostDid: r.host_did, pollUri: r.poll_uri, rkey: r.rkey,
    record: JSON.parse(r.record_json) as Record<string, unknown>, attempts: r.attempts,
  }));
}

export function markOutboxDone(db: Database.Database, id: number): void {
  db.prepare('UPDATE outbox SET done = 1 WHERE id = ?').run(id);
}

export function markOutboxFailed(db: Database.Database, id: number, error: string, now: number): void {
  const row = db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number };
  const attempts = row.attempts + 1;
  const backoff = Math.min(30_000 * 2 ** attempts, 6 * 3600_000);
  db.prepare(
    'UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
  ).run(attempts, error, now + backoff, id);
}

export function pendingOutboxCount(db: Database.Database, hostDid: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE done = 0 AND host_did = ?',
  ).get(hostDid) as { n: number };
  return row.n;
}

/**
 * Delivered (or superseded) rows are audit trail, not state: every guest repaint enqueues
 * a fresh row and marks the old one done, so without this the table grows with every
 * edit forever. Rows still pending are never touched — they are the work queue.
 */
export function pruneOutbox(db: Database.Database, olderThanMs: number): number {
  const res = db.prepare('DELETE FROM outbox WHERE done = 1 AND created_at < ?').run(olderThanMs);
  return res.changes;
}
