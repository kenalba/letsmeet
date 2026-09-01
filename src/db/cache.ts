import type { Database } from './db.js';
import type { ScheduleRecord, ResponseRecord } from '../atproto/records.js';

export interface CachedPoll {
  rkey: string;
  uri: string;
  hostDid: string;
  cid: string | null;
  record: ScheduleRecord;
  tombstoned: boolean;
}

export function upsertPollCache(
  db: Database.Database,
  p: { rkey: string; uri: string; hostDid: string; cid: string | null; record: ScheduleRecord },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO poll_cache (rkey, uri, host_did, cid, record_json, tombstoned, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(p.rkey, p.uri, p.hostDid, p.cid, JSON.stringify(p.record), Date.now());
}

export function getPollCache(db: Database.Database, rkey: string): CachedPoll | null {
  const r = db.prepare('SELECT * FROM poll_cache WHERE rkey = ?').get(rkey) as
    | { rkey: string; uri: string; host_did: string; cid: string | null; record_json: string; tombstoned: number }
    | undefined;
  if (!r) return null;
  return {
    rkey: r.rkey, uri: r.uri, hostDid: r.host_did, cid: r.cid,
    record: JSON.parse(r.record_json) as ScheduleRecord, tombstoned: r.tombstoned === 1,
  };
}

export function tombstonePoll(db: Database.Database, rkey: string): void {
  db.prepare('UPDATE poll_cache SET tombstoned = 1, updated_at = ? WHERE rkey = ?')
    .run(Date.now(), rkey);
}

export function upsertResponseCache(
  db: Database.Database, pollRkey: string, source: 'guest' | 'account',
  key: string, record: ResponseRecord, pending: boolean,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO response_cache (poll_rkey, source, key, record_json, pending, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(pollRkey, source, key, JSON.stringify(record), pending ? 1 : 0, Date.now());
}

export function listResponseCache(
  db: Database.Database, pollRkey: string,
): Array<{ source: 'guest' | 'account'; key: string; record: ResponseRecord; pending: boolean }> {
  const rows = db.prepare('SELECT * FROM response_cache WHERE poll_rkey = ? ORDER BY updated_at')
    .all(pollRkey) as Array<{ source: string; key: string; record_json: string; pending: number }>;
  return rows.map((r) => ({
    source: r.source as 'guest' | 'account', key: r.key,
    record: JSON.parse(r.record_json) as ResponseRecord, pending: r.pending === 1,
  }));
}

export function countResponses(db: Database.Database, pollRkey: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM response_cache WHERE poll_rkey = ?')
    .get(pollRkey) as { n: number };
  return r.n;
}

export function addParticipant(db: Database.Database, pollRkey: string, did: string): void {
  db.prepare('INSERT OR IGNORE INTO participant (poll_rkey, did) VALUES (?, ?)').run(pollRkey, did);
}

export function listParticipants(db: Database.Database, pollRkey: string): string[] {
  const rows = db.prepare('SELECT did FROM participant WHERE poll_rkey = ? ORDER BY did')
    .all(pollRkey) as Array<{ did: string }>;
  return rows.map((r) => r.did);
}
