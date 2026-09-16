import type { Database } from './db.js';
import type { AvailabilityRecord } from '../atproto/records.js';

/**
 * One row per DID whose standing availability this server has looked up. The record in
 * the PDS is the truth; this is the same disposable index `poll_cache` is. A row whose
 * `record` is null says "we asked and there was none" — the friend view and prefill read
 * that as absent without another round trip until the freshness window lapses.
 */
export interface CachedAvailability {
  did: string;
  uri: string | null;
  cid: string | null;
  record: AvailabilityRecord | null;
  updatedAt: number;
}

export function upsertAvailabilityCache(
  db: Database.Database, did: string,
  found: { uri: string; cid: string | null; record: AvailabilityRecord } | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO availability_cache (did, uri, cid, record_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(did, found?.uri ?? null, found?.cid ?? null, found ? JSON.stringify(found.record) : null, Date.now());
}

export function getAvailabilityCache(db: Database.Database, did: string): CachedAvailability | null {
  const r = db.prepare('SELECT * FROM availability_cache WHERE did = ?').get(did) as
    | { did: string; uri: string | null; cid: string | null; record_json: string | null; updated_at: number }
    | undefined;
  if (!r) return null;
  return {
    did: r.did, uri: r.uri, cid: r.cid, updatedAt: r.updated_at,
    record: r.record_json ? (JSON.parse(r.record_json) as AvailabilityRecord) : null,
  };
}
