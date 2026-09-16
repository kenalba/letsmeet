import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { getAvailabilityCache, upsertAvailabilityCache } from '../../src/db/availabilityCache.js';
import type { AvailabilityRecord } from '../../src/atproto/records.js';

const DID = 'did:plc:ken';
const rec: AvailabilityRecord = {
  $type: 'lol.letsmeet.availability', timezone: 'UTC',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [], updatedAt: '2026-09-16T12:00:00.000Z',
};

describe('availability cache', () => {
  it('is empty until written, then round-trips a record', () => {
    const db = openDb(':memory:');
    expect(getAvailabilityCache(db, DID)).toBeNull();
    upsertAvailabilityCache(db, DID, { uri: `at://${DID}/lol.letsmeet.availability/self`, cid: 'bafy', record: rec });
    const row = getAvailabilityCache(db, DID)!;
    expect(row.record).toEqual(rec);
    expect(row.cid).toBe('bafy');
  });
  it('remembers a known absence as a row with a null record', () => {
    const db = openDb(':memory:');
    upsertAvailabilityCache(db, DID, null);
    const row = getAvailabilityCache(db, DID)!;
    expect(row.record).toBeNull();
    expect(row.uri).toBeNull();
  });
  it('replaces on a second write', () => {
    const db = openDb(':memory:');
    upsertAvailabilityCache(db, DID, { uri: 'u', cid: 'a', record: rec });
    upsertAvailabilityCache(db, DID, { uri: 'u', cid: 'b', record: { ...rec, weekly: [] } });
    expect(getAvailabilityCache(db, DID)!.record!.weekly).toEqual([]);
    expect(getAvailabilityCache(db, DID)!.cid).toBe('b');
  });
});
