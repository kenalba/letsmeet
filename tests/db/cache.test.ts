import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import {
  upsertPollCache, getPollCache, tombstonePoll,
  upsertResponseCache, listResponseCache, countResponses,
  addParticipant, listParticipants,
} from '../../src/db/cache.js';
import { buildScheduleRecord, buildResponseRecord } from '../../src/atproto/records.js';

const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const CID = 'bafyreidfayvfuwqa2qskciqhtcc73ipe2f2wgib3fmyk6ssqrlkln5dcvy';
const poll = {
  rkey: '3kpoll', uri: 'at://did:plc:host/lol.letsmeet.poll.schedule/3kpoll',
  hostDid: 'did:plc:host', cid: CID, record: buildScheduleRecord({ title: 'T', time }),
};
const resp = buildResponseRecord({
  subject: { uri: poll.uri, cid: CID },
  available: [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' }],
  guestName: 'Sam',
});

describe('poll cache', () => {
  it('round-trips and tombstones', () => {
    const db = openDb(':memory:');
    upsertPollCache(db, poll);
    expect(getPollCache(db, '3kpoll')?.record.title).toBe('T');
    expect(getPollCache(db, '3kpoll')?.tombstoned).toBe(false);
    tombstonePoll(db, '3kpoll');
    expect(getPollCache(db, '3kpoll')?.tombstoned).toBe(true);
    expect(getPollCache(db, 'missing')).toBeNull();
  });
});

describe('response cache', () => {
  it('upserts by (source, key), counts, and flags pending', () => {
    const db = openDb(':memory:');
    upsertResponseCache(db, '3kpoll', 'guest', '3kresp1', resp, true);
    upsertResponseCache(db, '3kpoll', 'guest', '3kresp1', resp, false); // flushed
    upsertResponseCache(db, '3kpoll', 'account', 'did:plc:sam', resp, false);
    const rows = listResponseCache(db, '3kpoll');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === 'guest')?.pending).toBe(false);
    expect(countResponses(db, '3kpoll')).toBe(2);
  });
});

describe('participants', () => {
  it('dedupes and lists', () => {
    const db = openDb(':memory:');
    addParticipant(db, '3kpoll', 'did:plc:sam');
    addParticipant(db, '3kpoll', 'did:plc:sam');
    expect(listParticipants(db, '3kpoll')).toEqual(['did:plc:sam']);
  });
});
