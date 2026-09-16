import { describe, it, expect } from 'vitest';
import { freeIntervals, prefillFromAvailability } from '../../src/core/availability.js';
import { materializeSlots } from '../../src/core/slots.js';

const NY = 'America/New_York';
const NOW = new Date('2026-09-16T12:00:00Z');

describe('freeIntervals', () => {
  it('materializes a weekly block per matching date in the zone', () => {
    // 2026-10-13 is a Tuesday; 19:00–22:00 EDT = 23:00Z–02:00Z next day
    const out = freeIntervals({ timezone: NY, weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] },
      '2026-10-12', '2026-10-14');
    expect(out).toEqual([{ start: '2026-10-13T23:00:00.000Z', end: '2026-10-14T02:00:00.000Z' }]);
  });
  it('shifts with DST: the same wall-clock block lands an hour later in UTC after fall-back', () => {
    // 2026-11-01 clocks fall back in New York; Tuesday 2026-11-03 is EST
    const out = freeIntervals({ timezone: NY, weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] },
      '2026-11-03', '2026-11-03');
    expect(out).toEqual([{ start: '2026-11-04T00:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }]);
  });
  it('runs a past-midnight block to the end of the local day', () => {
    const out = freeIntervals({ timezone: 'UTC', weekly: [{ day: 5, start: '22:00', end: '00:00' }], away: [] },
      '2026-10-16', '2026-10-16'); // a Friday
    expect(out).toEqual([{ start: '2026-10-16T22:00:00.000Z', end: '2026-10-17T00:00:00.000Z' }]);
  });
  it('subtracts an all-day away entry', () => {
    const out = freeIntervals({
      timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-10-13', end: '2026-10-13' }],
    }, '2026-10-12', '2026-10-18');
    expect(out).toEqual([{ start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T22:00:00.000Z' }]);
  });
  it('subtracts a timed away window and keeps the rest of the block', () => {
    const out = freeIntervals({
      timezone: 'UTC', weekly: [{ day: 4, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-10-15', end: '2026-10-15', startTime: '19:00', endTime: '20:30' }],
    }, '2026-10-15', '2026-10-15');
    expect(out).toEqual([{ start: '2026-10-15T20:30:00.000Z', end: '2026-10-15T22:00:00.000Z' }]);
  });
  it('treats an away entry with only startTime (no endTime) as all-day, not a crash', () => {
    // The lexicon allows startTime or endTime alone; a record written by another client
    // could arrive this way, and the read path only validates against the lexicon.
    const out = freeIntervals({
      timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-10-13', end: '2026-10-13', startTime: '19:00' }],
    }, '2026-10-12', '2026-10-14');
    expect(out).toEqual([]);
  });
  it('applies a multi-day timed window to each day in the range', () => {
    const out = freeIntervals({
      timezone: 'UTC', weekly: [1, 2, 3].map((day) => ({ day, start: '09:00', end: '12:00' })),
      away: [{ start: '2026-10-12', end: '2026-10-14', startTime: '09:00', endTime: '10:00' }],
    }, '2026-10-12', '2026-10-14');
    expect(out).toEqual([
      { start: '2026-10-12T10:00:00.000Z', end: '2026-10-12T12:00:00.000Z' },
      { start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T12:00:00.000Z' },
      { start: '2026-10-14T10:00:00.000Z', end: '2026-10-14T12:00:00.000Z' },
    ]);
  });
});

describe('prefillFromAvailability', () => {
  // The real "Catch-22 Take 2" geometry.
  const poll = {
    dates: ['2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-15'],
    window: { start: '19:30', end: '21:00' }, slotMinutes: 30 as const, timezone: NY,
  };
  const slots = materializeSlots(poll);
  const rec = {
    timezone: NY,
    weekly: [{ day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' }],
    away: [{ start: '2026-10-15', end: '2026-10-15', startTime: '19:00', endTime: '20:30' }],
  };
  it('marks the slots the record covers, merged, minus away windows', () => {
    const out = prefillFromAvailability(rec, slots, NOW);
    expect(out).toEqual([
      // Thu Oct 8, 19:30–21:00 EDT — also a Thursday, so the standing block covers it too
      { start: '2026-10-08T23:30:00.000Z', end: '2026-10-09T01:00:00.000Z' },
      // Tue Oct 13, 19:30–21:00 EDT
      { start: '2026-10-13T23:30:00.000Z', end: '2026-10-14T01:00:00.000Z' },
      // Thu Oct 15: only 20:30–21:00 survives the dentist
      { start: '2026-10-16T00:30:00.000Z', end: '2026-10-16T01:00:00.000Z' },
    ]);
  });
  it('is null for a stale record', () => {
    expect(prefillFromAvailability({ ...rec, validUntil: '2026-09-01T00:00:00Z' }, slots, NOW)).toBeNull();
  });
  it('is an empty list when nothing lines up', () => {
    expect(prefillFromAvailability({ timezone: NY, weekly: [], away: [] }, slots, NOW)).toEqual([]);
  });
  it('does not mark a slot the record only half covers', () => {
    const narrow = { timezone: NY, weekly: [{ day: 2, start: '19:45', end: '22:00' }], away: [] };
    // 19:45 snaps to 19:30 in normalize, but freeIntervals takes the record as given: a
    // 19:45 start covers no 19:30–20:00 slot.
    const out = prefillFromAvailability(narrow, slots, NOW)!;
    expect(out[0].start).toBe('2026-10-14T00:00:00.000Z');
  });
});
