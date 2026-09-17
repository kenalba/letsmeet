import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import {
  getOwnAvailability, saveAvailability, getAvailabilityCached, prefillForPoll,
} from '../../src/services/availability.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY } from '../../src/atproto/records.js';
import { materializeSlots } from '../../src/core/slots.js';
import { claimSezName, claimedSezNameFor, getSezName } from '../../src/db/sezNames.js';
import type { Deps, RepoWriter } from '../../src/atproto/types.js';

const DID = 'did:plc:ken';
const input = {
  timezone: 'UTC',
  weekly: [{ day: 2, start: '19:10', end: '20:00' }, { day: 2, start: '20:00', end: '22:00' }],
  away: [{ start: '2026-10-13', end: '2026-10-13' }],
  note: '  text first  ',
};

function setup(revalidateTtlMs?: number) {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'), revalidateTtlMs,
  };
  return { deps, repo };
}

describe('saveAvailability', () => {
  it('normalizes and writes rkey self, then reads it back', async () => {
    const { deps, repo } = setup();
    const { record, written } = await saveAvailability(deps, DID, input);
    expect(written).toBe(true);
    expect(record.weekly).toEqual([{ day: 2, start: '19:00', end: '22:00' }]);
    expect(record.note).toBe('text first');
    const stored = await repo.getRecord(DID, AVAILABILITY_NSID, AVAILABILITY_RKEY);
    expect(stored?.value).toEqual(record);
    expect(await getOwnAvailability(deps, DID)).toEqual(record);
  });
  it('does not rewrite an unchanged record', async () => {
    const { deps, repo } = setup();
    await saveAvailability(deps, DID, input);
    const put = vi.spyOn(repo, 'putRecord');
    const { written } = await saveAvailability(deps, DID, { ...input, note: 'text first' });
    expect(written).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
  it('surfaces a person-readable error for bad input', async () => {
    const { deps } = setup();
    await expect(saveAvailability(deps, DID, { ...input, timezone: 'Nowhere/Here' }))
      .rejects.toThrow(/timezone/);
  });
  it('does not rewrite when the live record differs only in key order (dag-cbor round trip)', async () => {
    const { deps, repo } = setup();
    const { record } = await saveAvailability(deps, DID, input);
    // A real PDS canonicalises (sorts) map keys on a dag-cbor round trip; FakeRepo keeps
    // whatever object it is given, so reorder both top-level and nested keys by hand to
    // simulate what a live read would actually come back as.
    const reordered = {
      updatedAt: record.updatedAt,
      weekly: record.weekly.map(({ day, start, end }) => ({ end, day, start })),
      away: record.away.map(({ start, end, ...rest }) => ({ end, ...rest, start })),
      timezone: record.timezone,
      $type: record.$type,
      ...(record.note ? { note: record.note } : {}),
    };
    await repo.putRecord(DID, AVAILABILITY_NSID, AVAILABILITY_RKEY, reordered);
    const put = vi.spyOn(repo, 'putRecord');
    const { written } = await saveAvailability(deps, DID, input);
    expect(written).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
});

describe('getOwnAvailability', () => {
  it('returns null when no record exists', async () => {
    const { deps } = setup();
    expect(await getOwnAvailability(deps, DID)).toBeNull();
  });
});

describe('getAvailabilityCached', () => {
  it('reads live once, then serves the cache inside the window', async () => {
    const { deps, repo } = setup(30_000);
    await saveAvailability(deps, DID, input);
    const get = vi.spyOn(repo, 'getRecord');
    expect((await getAvailabilityCached(deps, DID))?.timezone).toBe('UTC');
    expect((await getAvailabilityCached(deps, DID))?.timezone).toBe('UTC');
    expect(get).toHaveBeenCalledTimes(0); // the save primed the cache and the window
  });
  it('remembers an absence and does not re-ask inside the window', async () => {
    const { deps, repo } = setup(30_000);
    const get = vi.spyOn(repo, 'getRecord');
    expect(await getAvailabilityCached(deps, 'did:plc:nobody')).toBeNull();
    expect(await getAvailabilityCached(deps, 'did:plc:nobody')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('does not re-ask a pds that just failed, inside the window', async () => {
    const { deps, repo } = setup(30_000);
    const get = vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('pds down'));
    // Nothing is cached, so the failure propagates — but it is still a failure we know
    // about, and every landing and poll view in the next thirty seconds must not pay the
    // five-second timeout again to learn it.
    await expect(getAvailabilityCached(deps, DID)).rejects.toThrow(/pds down/);
    await expect(getAvailabilityCached(deps, DID)).rejects.toThrow(/failed recently/);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('serves the cache when the live read fails, and throws only with no cache', async () => {
    const { deps, repo } = setup(0);
    await saveAvailability(deps, DID, input);
    vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('pds down'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await getAvailabilityCached(deps, DID))?.timezone).toBe('UTC');
      await expect(getAvailabilityCached(deps, 'did:plc:other')).rejects.toThrow(/pds down/);
    } finally { warned.mockRestore(); }
  });
});

describe('a record only the lexicon has ever seen', () => {
  // `timezone: 'Mars/Olympus'` and `start: '7am'` both pass the lexicon (it checks lengths,
  // not shapes) and both throw further down. The read boundary is where that stops.
  const foreign = {
    $type: AVAILABILITY_NSID, timezone: 'America/New_York',
    weekly: [{ day: 2, start: '7am', end: '10pm' }, { day: 4, start: '19:00', end: '22:00' }],
    away: [{ start: 'next week', end: 'next week' }],
    updatedAt: '2026-09-10T12:00:00.000Z',
  };
  const slots = materializeSlots({
    dates: ['2026-10-15'], window: { start: '19:00', end: '21:00' },
    slotMinutes: 30, timezone: 'America/New_York',
  });

  it('drops what it cannot read and prefills from the rest', async () => {
    const { deps, repo } = setup(0);
    await repo.putRecord(DID, AVAILABILITY_NSID, AVAILABILITY_RKEY, foreign);
    const rec = await getAvailabilityCached(deps, DID);
    expect(rec?.weekly).toEqual([{ day: 4, start: '19:00', end: '22:00' }]);
    expect(rec?.away).toEqual([]);
    expect(await prefillForPoll(deps, DID, slots)).toEqual([
      { start: '2026-10-15T23:00:00.000Z', end: '2026-10-16T01:00:00.000Z' },
    ]);
  });
  it('says "don\'t know" rather than "free nowhere" when the timezone is unusable', async () => {
    const { deps, repo } = setup(0);
    await repo.putRecord(DID, AVAILABILITY_NSID, AVAILABILITY_RKEY, { ...foreign, timezone: 'Mars/Olympus' });
    expect(await prefillForPoll(deps, DID, slots)).toBeNull();
  });
});

describe('prefillForPoll', () => {
  const slots = materializeSlots({
    dates: ['2026-10-13', '2026-10-15'], window: { start: '19:00', end: '21:00' },
    slotMinutes: 30, timezone: 'UTC',
  });
  it('returns the covered slots, skipping the away day', async () => {
    const { deps } = setup();
    await saveAvailability(deps, DID, { ...input, weekly: [...input.weekly, { day: 4, start: '19:00', end: '22:00' }] });
    expect(await prefillForPoll(deps, DID, slots)).toEqual([
      { start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T21:00:00.000Z' },
    ]);
  });
  it('is null with no record, a stale record, or a failing read', async () => {
    const { deps, repo } = setup(0);
    expect(await prefillForPoll(deps, DID, slots)).toBeNull();
    await saveAvailability(deps, DID, { ...input, validUntil: '2026-01-01T00:00:00Z' });
    expect(await prefillForPoll(deps, DID, slots)).toBeNull();
    vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('pds down'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // cache exists, so the read degrades to the cached (stale) record → still null
      expect(await prefillForPoll(deps, DID, slots)).toBeNull();
    } finally { warned.mockRestore(); }
  });
});

describe('saveAvailability claims a sez name', () => {
  it('writes the alias into the record and the name into the table', async () => {
    const { deps, repo } = setup();
    const { record, written } = await saveAvailability(deps, DID, { ...input, alias: ' Ken ' });
    expect(written).toBe(true);
    expect(record.alias).toBe('ken');
    expect(claimedSezNameFor(deps.db, DID)).toBe('ken');
    const stored = await repo.getRecord(DID, AVAILABILITY_NSID, AVAILABILITY_RKEY);
    expect((stored?.value as { alias?: string }).alias).toBe('ken');
  });
  it('refuses a taken or reserved name before touching the record', async () => {
    const { deps, repo } = setup();
    claimSezName(deps.db, 'ken', 'did:plc:ross', 0);
    const put = vi.spyOn(repo, 'putRecord');
    await expect(saveAvailability(deps, DID, { ...input, alias: 'ken' })).rejects.toThrow('that name is taken.');
    await expect(saveAvailability(deps, DID, { ...input, alias: 'www' })).rejects.toThrow('that name is reserved.');
    expect(put).not.toHaveBeenCalled();
    expect(claimedSezNameFor(deps.db, DID)).toBeNull();
  });
  it('releases the name when the alias comes back empty', async () => {
    const { deps } = setup();
    await saveAvailability(deps, DID, { ...input, alias: 'ken' });
    const { record } = await saveAvailability(deps, DID, { ...input, alias: '' });
    expect(record).not.toHaveProperty('alias');
    expect(claimedSezNameFor(deps.db, DID)).toBeNull();
    expect(getSezName(deps.db, 'ken')).toBeNull();
  });
  it('does not rewrite an unchanged record with an unchanged name', async () => {
    const { deps, repo } = setup();
    await saveAvailability(deps, DID, { ...input, alias: 'ken' });
    const put = vi.spyOn(repo, 'putRecord');
    const { written } = await saveAvailability(deps, DID, { ...input, alias: 'ken' });
    expect(written).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
  it('re-claims from the record when the table has lost the name, and says something was written', async () => {
    const { deps, repo } = setup();
    await saveAvailability(deps, DID, { ...input, alias: 'ken' });
    deps.db.prepare('DELETE FROM sez_name').run();
    const put = vi.spyOn(repo, 'putRecord');
    const { written } = await saveAvailability(deps, DID, { ...input, alias: 'ken' });
    expect(written).toBe(true);
    expect(put).not.toHaveBeenCalled();
    expect(claimedSezNameFor(deps.db, DID)).toBe('ken');
  });
  it('puts the table back when the pds refuses the write', async () => {
    const { deps, repo } = setup();
    await saveAvailability(deps, DID, { ...input, alias: 'ken' });
    const writer: RepoWriter = {
      createRecord: async () => { throw new Error('not used'); },
      deleteRecord: async () => { throw new Error('not used'); },
      putRecord: async () => { throw new Error('pds says no'); },
    };
    deps.writerFor = async () => writer;
    await expect(saveAvailability(deps, DID, { ...input, alias: 'kenny' })).rejects.toThrow(/pds says no/);
    expect(claimedSezNameFor(deps.db, DID)).toBe('ken');
    expect(getSezName(deps.db, 'kenny')).toBeNull();
    // ...and a first claim that fails leaves no claim at all.
    await expect(saveAvailability(deps, 'did:plc:new', { ...input, alias: 'newbie' })).rejects.toThrow(/pds says no/);
    expect(claimedSezNameFor(deps.db, 'did:plc:new')).toBeNull();
  });
});
