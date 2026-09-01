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
    const recs = await repo.listRecords('did:plc:ana', 'cool.wzrdz.poll.response');
    const rkey = recs[0].uri.split('/').pop()!;
    await repo.putRecord('did:plc:ana', 'cool.wzrdz.poll.response', rkey, {
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
    await repo.createRecord('did:plc:ana', 'cool.wzrdz.poll.response', {
      subject: { uri: 'at://did:plc:other/cool.wzrdz.poll.schedule/xyz', cid: 'bafyfake' },
      available: PAINT, createdAt: '2026-08-31T12:00:00.000Z',
    });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses).toHaveLength(1);
  });

  it('returns null for an unknown poll', async () => {
    const { deps } = await setup();
    expect(await getResults(deps, 'nope')).toBeNull();
  });
});
