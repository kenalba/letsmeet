import { describe, it, expect } from 'vitest';
import {
  normalizeAvailability, describeWeekly, isStale, splitAtTemplateStart, templateSlots,
  weeklyToTemplateIntervals, templateIntervalsToWeekly,
} from '../../src/core/availability.js';

const TZ = 'America/New_York';

describe('normalizeAvailability', () => {
  it('snaps edges to the half hour, merges touching blocks, sorts by day then start', () => {
    const out = normalizeAvailability({
      timezone: TZ,
      weekly: [
        { day: 4, start: '19:10', end: '20:00' },
        { day: 2, start: '20:00', end: '22:00' },
        { day: 2, start: '19:00', end: '20:00' },
      ],
      away: [],
    });
    expect(out.weekly).toEqual([
      { day: 2, start: '19:00', end: '22:00' },
      { day: 4, start: '19:00', end: '20:00' },
    ]);
  });
  it('keeps a past-midnight block and merges nothing into it', () => {
    const out = normalizeAvailability({
      timezone: TZ, away: [],
      weekly: [{ day: 5, start: '22:00', end: '00:00' }, { day: 5, start: '20:00', end: '21:00' }],
    });
    expect(out.weekly).toEqual([
      { day: 5, start: '20:00', end: '21:00' },
      { day: 5, start: '22:00', end: '00:00' },
    ]);
  });
  it('rejects a zero-length block', () => {
    expect(() => normalizeAvailability({
      timezone: TZ, away: [], weekly: [{ day: 1, start: '19:00', end: '19:00' }],
    })).toThrow(/block/);
  });
  it('sorts away entries and drops empty notes', () => {
    const out = normalizeAvailability({
      timezone: TZ, weekly: [],
      away: [
        { start: '2026-10-02', end: '2026-10-02', note: '   ' },
        { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
      ],
    });
    expect(out.away).toEqual([
      { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
      { start: '2026-10-02', end: '2026-10-02' },
    ]);
  });
  it('rejects an away range that ends before it starts', () => {
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-09-21', end: '2026-09-19' }],
    })).toThrow(/ends before/);
  });
  it('rejects startTime without endTime, and a window that is not half-hour aligned', () => {
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '19:00' }],
    })).toThrow(/both/);
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '19:10', endTime: '20:00' }],
    })).toThrow(/half hour/);
  });
  it('rejects an unknown timezone and a bad date', () => {
    expect(() => normalizeAvailability({ timezone: 'Mars/Olympus', weekly: [], away: [] })).toThrow(/timezone/);
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-13-40', end: '2026-13-40' }],
    })).toThrow(/date/);
  });
  it('is idempotent', () => {
    const a = normalizeAvailability({
      timezone: TZ, weekly: [{ day: 2, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-09-19', end: '2026-09-21' }], note: 'hi', validUntil: '2026-12-31T23:59:59Z',
    });
    expect(normalizeAvailability(a)).toEqual(a);
  });
});

describe('describeWeekly', () => {
  it('groups days sharing a range, collapses weekdays and weekends', () => {
    expect(describeWeekly([
      { day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' },
      { day: 6, start: '13:00', end: '17:00' }, { day: 0, start: '13:00', end: '17:00' },
    ])).toBe('usually free tuesdays and thursdays 7pm to 10pm, and weekends 1pm to 5pm.');
    expect(describeWeekly([1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '12:00' }))))
      .toBe('usually free weekdays 9am to 12pm.');
  });
  it('orders clauses Monday-first regardless of input order, e.g. a day-ascending array', () => {
    // This is the shape normalizeAvailability actually hands back: sorted by day
    // ascending, so Sunday (day 0) comes first even though it reads last in the sentence.
    expect(describeWeekly([
      { day: 0, start: '13:00', end: '17:00' }, { day: 2, start: '19:00', end: '22:00' },
      { day: 4, start: '19:00', end: '22:00' }, { day: 6, start: '13:00', end: '17:00' },
    ])).toBe('usually free tuesdays and thursdays 7pm to 10pm, and weekends 1pm to 5pm.');
  });
  it('says so when nothing is marked', () => {
    expect(describeWeekly([])).toBe('nothing marked yet.');
  });
  it('prints half hours and midnight', () => {
    expect(describeWeekly([{ day: 5, start: '20:30', end: '00:00' }]))
      .toBe('usually free fridays 8:30pm to midnight.');
  });
});

describe('isStale', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  it('is false without validUntil, false before it, true after it', () => {
    expect(isStale({}, now)).toBe(false);
    expect(isStale({ validUntil: '2026-12-31T23:59:59Z' }, now)).toBe(false);
    expect(isStale({ validUntil: '2026-09-01T00:00:00Z' }, now)).toBe(true);
  });
});

describe('template week', () => {
  it('has 7 days of 34 half-hour slots from 7am to midnight', () => {
    const slots = templateSlots(TZ);
    expect(slots).toHaveLength(7 * 34);
    expect(slots[0].start).toBe('2026-01-04T12:00:00.000Z'); // 07:00 EST, Sunday
  });
  it('round-trips weekly blocks through template intervals', () => {
    const weekly = [{ day: 2, start: '19:00', end: '22:00' }, { day: 5, start: '22:00', end: '00:00' }];
    const ivs = weeklyToTemplateIntervals(weekly, TZ);
    expect(templateIntervalsToWeekly(ivs, TZ)).toEqual(weekly);
  });
  it('cuts the week at the grid\'s first row, splitting a block that straddles it', () => {
    // The editor rebuilds everything on the grid from the cells, so what is off the grid has
    // to come back out of here or a foreign record loses its small hours at the first stroke.
    const { onGrid, offGrid } = splitAtTemplateStart([
      { day: 1, start: '02:00', end: '06:00' }, // wholly before the first row
      { day: 2, start: '06:00', end: '10:00' }, // straddles it
      { day: 3, start: '19:00', end: '22:00' }, // wholly on the grid
      { day: 4, start: '23:00', end: '00:00' }, // runs to end of day
    ]);
    expect(offGrid).toEqual([
      { day: 1, start: '02:00', end: '06:00' },
      { day: 2, start: '06:00', end: '07:00' },
    ]);
    expect(onGrid).toEqual([
      { day: 2, start: '07:00', end: '10:00' },
      { day: 3, start: '19:00', end: '22:00' },
      { day: 4, start: '23:00', end: '00:00' },
    ]);
  });
  it('puts a split block back together once the grid half is marked again', () => {
    const { onGrid, offGrid } = splitAtTemplateStart([{ day: 2, start: '06:00', end: '10:00' }]);
    // What the editor does on every stroke: the cells' half, plus what it held aside.
    const rejoined = normalizeAvailability({
      timezone: TZ, weekly: [...offGrid, ...onGrid], away: [],
    }).weekly;
    expect(rejoined).toEqual([{ day: 2, start: '06:00', end: '10:00' }]);
    // And unmarking that half leaves the sliver the grid could never show.
    const unmarked = normalizeAvailability({ timezone: TZ, weekly: offGrid, away: [] }).weekly;
    expect(unmarked).toEqual([{ day: 2, start: '06:00', end: '07:00' }]);
  });
});
