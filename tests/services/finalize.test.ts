import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import {
  createPoll, finalizePoll, closePoll, reopenPoll, getPollWithRevalidate, EVENT_NSID,
} from '../../src/services/polls.js';
import { SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 60 as const, timezone: 'UTC',
};
const SLOT = { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' };
const SLOT2 = { start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T19:00:00.000Z' };

type Rec = { status: string; finalized?: unknown; events?: Array<{ uri: string; cid: string }> };
const readPoll = async (repo: FakeRepo, rkey: string) =>
  (await repo.getRecord(HOST, SCHEDULE_NSID, rkey))!.value as unknown as Rec;

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
  it('rejects picking the slot that is already picked', async () => {
    const { deps, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    await expect(finalizePoll(deps, HOST, poll.rkey, SLOT)).rejects.toThrow(/already/);
  });
  it('keeps a reference to the calendar event on the schedule record', async () => {
    const { deps, repo, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    const [event] = await repo.listRecords(HOST, EVENT_NSID);
    expect((await readPoll(repo, poll.rkey)).events).toEqual([{ uri: event.uri, cid: event.cid }]);
  });
  it('repicks: swaps the slot, drops the old calendar event, files a new one', async () => {
    const { deps, repo, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    const [first] = await repo.listRecords(HOST, EVENT_NSID);
    await finalizePoll(deps, HOST, poll.rkey, SLOT2);
    const rec = await readPoll(repo, poll.rkey);
    expect(rec.status).toBe('finalized');
    expect(rec.finalized).toEqual(SLOT2);
    const events = await repo.listRecords(HOST, EVENT_NSID);
    expect(events).toHaveLength(1);
    expect(events[0].uri).not.toBe(first.uri);
    expect((events[0].value as { startsAt: string }).startsAt).toBe(SLOT2.start);
    expect(rec.events).toEqual([{ uri: events[0].uri, cid: events[0].cid }]);
  });
  it('finalizes a closed poll', async () => {
    const { deps, repo, poll } = await setup();
    await closePoll(deps, HOST, poll.rkey);
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    expect((await readPoll(repo, poll.rkey)).status).toBe('finalized');
  });
});

describe('closePoll', () => {
  it('flips an active poll to closed', async () => {
    const { deps, repo, poll } = await setup();
    await closePoll(deps, HOST, poll.rkey);
    expect((await readPoll(repo, poll.rkey)).status).toBe('closed');
    expect((await getPollWithRevalidate(deps, poll.rkey))?.record.status).toBe('closed');
  });
  it('refuses a poll that is not active, and a non-host', async () => {
    const { deps, poll } = await setup();
    await expect(closePoll(deps, 'did:plc:mallory', poll.rkey)).rejects.toThrow(/host/);
    await closePoll(deps, HOST, poll.rkey);
    await expect(closePoll(deps, HOST, poll.rkey)).rejects.toThrow(/not open/);
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    await expect(closePoll(deps, HOST, poll.rkey)).rejects.toThrow(/not open/);
  });
});

describe('reopenPoll', () => {
  it('reopens a closed poll', async () => {
    const { deps, repo, poll } = await setup();
    await closePoll(deps, HOST, poll.rkey);
    await reopenPoll(deps, HOST, poll.rkey);
    expect((await readPoll(repo, poll.rkey)).status).toBe('active');
  });
  it('reopens a decided poll: forgets the slot and deletes the calendar event', async () => {
    const { deps, repo, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    await reopenPoll(deps, HOST, poll.rkey);
    const rec = await readPoll(repo, poll.rkey);
    expect(rec.status).toBe('active');
    expect(rec.finalized).toBeUndefined();
    expect(rec.events).toBeUndefined();
    expect(await repo.listRecords(HOST, EVENT_NSID)).toHaveLength(0);
    // ...and it can be decided again afterwards.
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    expect(await repo.listRecords(HOST, EVENT_NSID)).toHaveLength(1);
  });
  it('still reopens when the calendar-event delete fails', async () => {
    const { deps, repo, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    deps.writerFor = async () => ({
      createRecord: (r, c, rec) => repo.createRecord(r, c, rec),
      putRecord: (r, c, k, rec) => repo.putRecord(r, c, k, rec),
      deleteRecord: async (r, c, k) => {
        if (c === EVENT_NSID) throw new Error('event collection rejected');
        return repo.deleteRecord(r, c, k);
      },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(reopenPoll(deps, HOST, poll.rkey)).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
    expect((await readPoll(repo, poll.rkey)).status).toBe('active');
  });
  it('refuses an open poll and a non-host', async () => {
    const { deps, poll } = await setup();
    await expect(reopenPoll(deps, HOST, poll.rkey)).rejects.toThrow(/already open/);
    await closePoll(deps, HOST, poll.rkey);
    await expect(reopenPoll(deps, 'did:plc:mallory', poll.rkey)).rejects.toThrow(/host/);
  });
});
