import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createPoll } from '../../src/services/polls.js';
import { submitGuestResponse, submitAccountResponse } from '../../src/services/responses.js';
import { getResults } from '../../src/services/results.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '18:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const PAINT = [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' }];
const PAINT2 = [{ start: '2026-09-02T17:30:00.000Z', end: '2026-09-02T18:00:00.000Z' }];

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const poll = await createPoll(deps, HOST, { title: 'T', time });
  return { deps, repo, poll };
}

describe('getResults', () => {
  it('merges guest and account responses and ranks slots', async () => {
    const { deps, poll } = await setup();
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses.map((r) => r.who).sort()).toEqual(['Sam', 'did:plc:ana']);
    expect(results?.ranked[0].slot).toEqual(PAINT[0]);
    expect(results?.ranked[0].available).toHaveLength(2);
    expect(results?.slots).toHaveLength(2);
  });

  it('marks unflushed guest responses pending', async () => {
    const { deps, repo, poll } = await setup();
    repo.failWrites = true;
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses[0].pending).toBe(true);
  });

  it('picks up an account response edited directly in the PDS', async () => {
    const { deps, repo, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    const recs = await repo.listRecords('did:plc:ana', 'lol.letsmeet.poll.response');
    const rkey = recs[0].uri.split('/').pop()!;
    await repo.putRecord('did:plc:ana', 'lol.letsmeet.poll.response', rkey, {
      ...recs[0].value,
      available: [{ start: '2026-09-02T17:30:00.000Z', end: '2026-09-02T18:00:00.000Z' }],
    });
    const results = await getResults(deps, poll.rkey);
    const ana = results?.responses.find((r) => r.who === 'did:plc:ana');
    expect(ana?.available[0].start).toBe('2026-09-02T17:30:00.000Z');
  });

  it('ignores an account record referencing a different poll', async () => {
    const { deps, repo, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    await repo.createRecord('did:plc:ana', 'lol.letsmeet.poll.response', {
      subject: { uri: 'at://did:plc:other/lol.letsmeet.poll.schedule/xyz', cid: 'bafyfake' },
      available: PAINT, createdAt: '2026-08-31T12:00:00.000Z',
    });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses).toHaveLength(1);
  });

  it('labels an account response with the handle it was submitted under', async () => {
    const { deps, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, {
      available: PAINT, handle: 'ana.example',
    });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses.map((r) => r.who)).toEqual(['ana.example']);
    expect(results?.ranked[0].available).toEqual(['ana.example']);
  });

  it('resolves a missing handle on revalidation, once, and keeps the DID when it cannot', async () => {
    const { deps, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    await submitAccountResponse(deps, 'did:plc:bob', poll.rkey, { available: PAINT });
    const asked: string[] = [];
    const live: Deps = {
      ...deps, revalidateTtlMs: 0,
      resolveHandle: async (did) => {
        asked.push(did);
        return did === 'did:plc:ana' ? 'ana.example' : null;
      },
    };
    const who = async () => (await getResults(live, poll.rkey))?.responses.map((r) => r.who).sort();
    expect(await who()).toEqual(['ana.example', 'did:plc:bob']);
    // The found handle is stored, so the next read does not ask for it again; the one that
    // failed is asked for again.
    expect(await who()).toEqual(['ana.example', 'did:plc:bob']);
    expect(asked.filter((d) => d === 'did:plc:ana')).toHaveLength(1);
    expect(asked.filter((d) => d === 'did:plc:bob')).toHaveLength(2);
  });

  it('returns null for an unknown poll', async () => {
    const { deps } = await setup();
    expect(await getResults(deps, 'nope')).toBeNull();
  });
});

/**
 * A guest's record is written into the host's repo, so when the host answers their own
 * poll that repo holds two records for the same subject. Only the one without `guest` is
 * the host's own; the other is attested on the guest's behalf and must be left alone.
 */
describe('host answering their own poll', () => {
  it('saves alongside an earlier guest record instead of overwriting it', async () => {
    const { deps, repo, poll } = await setup();
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT2 });
    await submitAccountResponse(deps, HOST, poll.rkey, { available: PAINT });
    const recs = (await repo.listRecords(HOST, 'lol.letsmeet.poll.response'))
      .map((r) => r.value as { guest?: { name: string }; available: typeof PAINT });
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.guest)?.available).toEqual(PAINT2);
    expect(recs.find((r) => !r.guest)?.available).toEqual(PAINT);
  });

  it('revalidates the host response from their own record, not the guest one beside it', async () => {
    const { deps, poll } = await setup();
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT2 });
    await submitAccountResponse(deps, HOST, poll.rkey, { available: PAINT, handle: 'host.example' });
    const live: Deps = { ...deps, revalidateTtlMs: 0 };
    for (let i = 0; i < 2; i++) {
      const results = await getResults(live, poll.rkey);
      expect(results?.responses).toHaveLength(2);
      expect(results?.responses.find((r) => r.who === 'host.example')?.available).toEqual(PAINT);
      expect(results?.responses.find((r) => r.who === 'Sam')?.available).toEqual(PAINT2);
    }
  });
});
