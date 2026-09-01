import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import {
  createPoll, getPollWithRevalidate, updatePollMeta, updatePollTime, parseRkey,
} from '../../src/services/polls.js';
import { upsertResponseCache } from '../../src/db/cache.js';
import { buildResponseRecord, SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};

function makeDeps() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  return { deps, repo };
}

describe('createPoll', () => {
  it('writes the record to the host repo and caches it', async () => {
    const { deps, repo } = makeDeps();
    const { rkey, uri } = await createPoll(deps, HOST, { title: 'Movie night', time });
    expect(parseRkey(uri)).toBe(rkey);
    const inRepo = await repo.getRecord(HOST, SCHEDULE_NSID, rkey);
    expect((inRepo?.value as { title: string }).title).toBe('Movie night');
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('Movie night');
  });
});

describe('getPollWithRevalidate', () => {
  it('picks up an edit made directly in the repo', async () => {
    const { deps, repo } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'Old', time });
    const cur = await repo.getRecord(HOST, SCHEDULE_NSID, rkey);
    await repo.putRecord(HOST, SCHEDULE_NSID, rkey, { ...cur!.value, title: 'New' });
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('New');
  });
  it('tombstones when the record is gone from the repo', async () => {
    const { deps, repo } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'Doomed', time });
    repo.delete(HOST, SCHEDULE_NSID, rkey);
    expect((await getPollWithRevalidate(deps, rkey))?.tombstoned).toBe(true);
  });
  it('serves stale cache when the reader throws', async () => {
    const { deps } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'Sturdy', time });
    deps.reader = {
      getRecord: async () => { throw new Error('net down'); },
      listRecords: async () => [],
    };
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('Sturdy');
  });
  it('returns null for an unknown rkey', async () => {
    const { deps } = makeDeps();
    expect(await getPollWithRevalidate(deps, 'nope')).toBeNull();
  });
});

describe('frozen geometry', () => {
  it('meta edits are always allowed; time edits blocked once a response exists', async () => {
    const { deps } = makeDeps();
    const { rkey, uri, cid } = await createPoll(deps, HOST, { title: 'T', time });
    await updatePollMeta(deps, HOST, rkey, { title: 'T2' });
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('T2');

    const resp = buildResponseRecord({
      subject: { uri, cid },
      available: [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' }],
      guestName: 'Sam',
    });
    upsertResponseCache(deps.db, rkey, 'guest', '3kresp', resp, false);

    await expect(updatePollTime(deps, HOST, rkey, { ...time, slotMinutes: 60 }))
      .rejects.toThrow(/frozen/);
    await updatePollMeta(deps, HOST, rkey, { description: 'still fine' });
  });
  it('rejects edits by a non-host', async () => {
    const { deps } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'T', time });
    await expect(updatePollMeta(deps, 'did:plc:mallory', rkey, { title: 'hax' }))
      .rejects.toThrow(/host/);
  });
});
