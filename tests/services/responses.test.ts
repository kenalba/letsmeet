import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createPoll, getPollWithRevalidate } from '../../src/services/polls.js';
import {
  submitGuestResponse, submitAccountResponse, flushOutbox, GUEST_CAP,
} from '../../src/services/responses.js';
import { listResponseCache, listParticipants } from '../../src/db/cache.js';
import { dueOutbox } from '../../src/db/outbox.js';
import { RESPONSE_NSID, SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const PAINT = [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' }];

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const poll = await createPoll(deps, HOST, { title: 'T', time });
  return { deps, repo, poll };
}

describe('submitGuestResponse', () => {
  it('lands a guest record in the host repo when the writer works', async () => {
    const { deps, repo, poll } = await setup();
    const { editToken, pending } = await submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', available: PAINT,
    });
    expect(editToken).toBeTruthy();
    expect(pending).toBe(false);
    const recs = await repo.listRecords(HOST, RESPONSE_NSID);
    expect(recs).toHaveLength(1);
    expect((recs[0].value as { guest: { name: string } }).guest.name).toBe('Sam');
  });

  it('queues as pending when writes fail, then flushes when they recover', async () => {
    const { deps, repo, poll } = await setup();
    repo.failWrites = true;
    const { pending } = await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    expect(pending).toBe(true);
    expect(listResponseCache(deps.db, poll.rkey)[0].pending).toBe(true);

    repo.failWrites = false;
    deps.now = () => new Date('2027-01-01T00:00:00Z'); // jump past any backoff
    const { flushed } = await flushOutbox(deps);
    expect(flushed).toBe(1);
    expect(listResponseCache(deps.db, poll.rkey)[0].pending).toBe(false);
    expect(await repo.listRecords(HOST, RESPONSE_NSID)).toHaveLength(1);
  });

  it('an edit token reuses the same rkey (upsert, not duplicate)', async () => {
    const { deps, repo, poll } = await setup();
    const { editToken } = await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    await submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', editToken,
      available: [{ start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:30:00.000Z' }],
    });
    expect(await repo.listRecords(HOST, RESPONSE_NSID)).toHaveLength(1);
    expect(listResponseCache(deps.db, poll.rkey)).toHaveLength(1);
  });

  it('a resubmit of identical paint is a no-op: no new record, no new outbox row', async () => {
    const { deps, repo, poll } = await setup();
    const { editToken } = await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    const before = (await repo.listRecords(HOST, RESPONSE_NSID))[0];

    const again = await submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', editToken, available: PAINT,
    });
    expect(again.editToken).toBe(editToken);
    expect(again.pending).toBe(false);

    const after = await repo.listRecords(HOST, RESPONSE_NSID);
    expect(after).toHaveLength(1);
    // Same cid means the record was never rewritten — createdAt would have moved otherwise.
    expect(after[0].cid).toBe(before.cid);
    expect(deps.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 1 });
    deps.now = () => new Date('2027-01-01T00:00:00Z');
    expect(dueOutbox(deps.db, deps.now().getTime())).toHaveLength(0);
  });

  it('rejects paint that snaps to nothing', async () => {
    const { deps, poll } = await setup();
    await expect(submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', available: [{ start: '2026-09-02T05:00:00.000Z', end: '2026-09-02T05:30:00.000Z' }],
    })).rejects.toThrow(/no valid availability/);
  });

  it('enforces the guest cap', async () => {
    const { deps, poll } = await setup();
    for (let i = 0; i < GUEST_CAP; i++) {
      await submitGuestResponse(deps, poll.rkey, { name: `G${i}`, available: PAINT });
    }
    await expect(submitGuestResponse(deps, poll.rkey, { name: 'Late', available: PAINT }))
      .rejects.toThrow(/full/);
  });

  it('rejects responses to a non-active poll', async () => {
    const { deps, repo, poll } = await setup();
    const cur = await repo.getRecord(HOST, SCHEDULE_NSID, poll.rkey);
    await repo.putRecord(HOST, SCHEDULE_NSID, poll.rkey, { ...cur!.value, status: 'closed' });
    await getPollWithRevalidate(deps, poll.rkey); // refresh cache
    await expect(submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT }))
      .rejects.toThrow(/not open/);
  });

  it('a later edit is not reverted by a stale queued write', async () => {
    const { deps, repo, poll } = await setup();
    repo.failWrites = true;
    const { editToken } = await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    repo.failWrites = false;
    const V2 = [{ start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:30:00.000Z' }];
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', editToken, available: V2 });
    deps.now = () => new Date('2027-01-01T00:00:00Z');
    await flushOutbox(deps);
    const recs = await repo.listRecords(HOST, RESPONSE_NSID);
    expect(recs).toHaveLength(1);
    expect((recs[0].value as { available: typeof V2 }).available).toEqual(V2);
  });

  it('rejects an invalid edit token', async () => {
    const { deps, poll } = await setup();
    await expect(submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', available: PAINT, editToken: 'not-a-real-token',
    })).rejects.toThrow(/invalid edit link/);
  });

  it('allows editing an existing response even when the poll is at cap', async () => {
    const { deps, poll } = await setup();
    let firstToken = '';
    for (let i = 0; i < GUEST_CAP; i++) {
      const { editToken } = await submitGuestResponse(deps, poll.rkey, { name: `G${i}`, available: PAINT });
      if (i === 0) firstToken = editToken;
    }
    const V2 = [{ start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:30:00.000Z' }];
    await submitGuestResponse(deps, poll.rkey, { name: 'G0', editToken: firstToken, available: V2 });
    expect(listResponseCache(deps.db, poll.rkey)).toHaveLength(GUEST_CAP);
  });

  it('keeps available empty and populates ifNeedBe when only ifNeedBe is painted', async () => {
    const { deps, repo, poll } = await setup();
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: [], ifNeedBe: PAINT });
    const recs = await repo.listRecords(HOST, RESPONSE_NSID);
    expect(recs).toHaveLength(1);
    const value = recs[0].value as { available: unknown[]; ifNeedBe: unknown[] };
    expect(value.available).toEqual([]);
    expect(value.ifNeedBe).toEqual(PAINT);
  });

  it('rejects responses to a tombstoned poll', async () => {
    const { deps, repo, poll } = await setup();
    repo.delete(HOST, SCHEDULE_NSID, poll.rkey);
    await expect(submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT }))
      .rejects.toThrow(/poll not found/);
  });
});

describe('submitAccountResponse', () => {
  it('writes to the responder repo and upserts on resubmit', async () => {
    const { deps, repo, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:sam', poll.rkey, { available: PAINT });
    await submitAccountResponse(deps, 'did:plc:sam', poll.rkey, {
      available: [{ start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:30:00.000Z' }],
    });
    const recs = await repo.listRecords('did:plc:sam', RESPONSE_NSID);
    expect(recs).toHaveLength(1);
    expect((recs[0].value as { guest?: unknown }).guest).toBeUndefined();
  });

  it('adds the participant and clears pending after a successful write', async () => {
    const { deps, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:sam', poll.rkey, { available: PAINT });
    expect(listParticipants(deps.db, poll.rkey)).toContain('did:plc:sam');
    const cache = listResponseCache(deps.db, poll.rkey).find((r) => r.key === 'did:plc:sam');
    expect(cache?.pending).toBe(false);
  });
});
