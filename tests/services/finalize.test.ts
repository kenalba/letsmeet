import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createPoll, finalizePoll, getPollWithRevalidate, EVENT_NSID } from '../../src/services/polls.js';
import { SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 60 as const, timezone: 'UTC',
};
const SLOT = { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' };

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const poll = await createPoll(deps, HOST, { title: 'T', time });
  return { deps, repo, poll };
}

describe('finalizePoll', () => {
  it('flips status, records the slot, and emits a community calendar event', async () => {
    const { deps, repo, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    const updated = await repo.getRecord(HOST, SCHEDULE_NSID, poll.rkey);
    expect((updated?.value as { status: string }).status).toBe('finalized');
    expect((updated?.value as { finalized: unknown }).finalized).toEqual(SLOT);
    const events = await repo.listRecords(HOST, EVENT_NSID);
    expect(events).toHaveLength(1);
    expect((events[0].value as { name: string }).name).toBe('T');
    expect((await getPollWithRevalidate(deps, poll.rkey))?.record.status).toBe('finalized');
  });
  it('still finalizes when the calendar-event write fails', async () => {
    const { deps, repo, poll } = await setup();
    // Everything but the event write passes through to the repo.
    deps.writerFor = async () => ({
      createRecord: async (r, collection, record) => {
        if (collection === EVENT_NSID) throw new Error('event collection rejected');
        return repo.createRecord(r, collection, record);
      },
      putRecord: (r, collection, rkey, record) => repo.putRecord(r, collection, rkey, record),
      deleteRecord: (r, collection, rkey) => repo.deleteRecord(r, collection, rkey),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(finalizePoll(deps, HOST, poll.rkey, SLOT)).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    const updated = await repo.getRecord(HOST, SCHEDULE_NSID, poll.rkey);
    expect((updated?.value as { status: string }).status).toBe('finalized');
    expect(await repo.listRecords(HOST, EVENT_NSID)).toHaveLength(0);
  });

  it('rejects a slot that is not one of the poll slots', async () => {
    const { deps, poll } = await setup();
    await expect(finalizePoll(deps, HOST, poll.rkey, {
      start: '2026-09-02T05:00:00.000Z', end: '2026-09-02T06:00:00.000Z',
    })).rejects.toThrow(/not a slot/);
  });
  it('rejects a non-host', async () => {
    const { deps, poll } = await setup();
    await expect(finalizePoll(deps, 'did:plc:mallory', poll.rkey, SLOT)).rejects.toThrow(/host/);
  });
  it('rejects double finalization', async () => {
    const { deps, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    await expect(finalizePoll(deps, HOST, poll.rkey, SLOT)).rejects.toThrow(/already/);
  });
});
