import { describe, it, expect } from 'vitest';
import {
  normalizeAvailability, describeWeekly, isStale, splitAtTemplateStart, templateSlots,
  weeklyToTemplateIntervals, templateIntervalsToWeekly, sanitizeForeignRecord, isKnownZone,
  endOfLocalDay, localDateOf, templateDates, templateDateFor, weeklyOverDates, TEMPLATE_MONDAY,
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
  it('keeps an away window that ends at midnight, and still rejects an inverted one', () => {
    const midnight = { start: '2026-09-19', end: '2026-09-19', startTime: '23:00', endTime: '00:00' };
    expect(normalizeAvailability({ timezone: TZ, weekly: [], away: [midnight] }).away)
      .toEqual([midnight]);
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [],
      away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '18:00', endTime: '09:00' }],
    })).toThrow(/end after it starts/);
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
  it('has 7 days of 34 half-hour slots from 7am to midnight, monday first', () => {
    const slots = templateSlots(TZ);
    expect(slots).toHaveLength(7 * 34);
    expect(slots[0].start).toBe('2026-01-05T12:00:00.000Z'); // 07:00 EST, Monday
  });
  it('runs monday to sunday, so a column keeps its identity across pages', () => {
    expect(TEMPLATE_MONDAY).toBe('2026-01-05');
    expect(templateDates()).toEqual([
      '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08',
      '2026-01-09', '2026-01-10', '2026-01-11',
    ]);
    // The record counts weekdays from Sunday; the grid draws them from Monday.
    expect(templateDateFor(1)).toBe('2026-01-05');
    expect(templateDateFor(0)).toBe('2026-01-11');
  });
  it('round-trips a sunday block, which is the last column now', () => {
    const weekly = [{ day: 0, start: '11:00', end: '13:00' }];
    const ivs = weeklyToTemplateIntervals(weekly, 'UTC');
    expect(ivs).toEqual([{ start: '2026-01-11T11:00:00.000Z', end: '2026-01-11T13:00:00.000Z' }]);
    expect(templateIntervalsToWeekly(ivs, 'UTC')).toEqual(weekly);
  });
  it('puts each weekly block on every real date with that weekday', () => {
    // 2026-09-14 and 2026-09-21 are Mondays; the 15th is a Tuesday and gets nothing.
    expect(weeklyOverDates(
      [{ day: 1, start: '19:00', end: '22:00' }],
      ['2026-09-14', '2026-09-15', '2026-09-21'], 'UTC',
    )).toEqual([
      { start: '2026-09-14T19:00:00.000Z', end: '2026-09-14T22:00:00.000Z' },
      { start: '2026-09-21T19:00:00.000Z', end: '2026-09-21T22:00:00.000Z' },
    ]);
  });
  it('rolls a past-midnight block onto the next real date', () => {
    expect(weeklyOverDates(
      [{ day: 6, start: '22:00', end: '00:00' }], ['2026-09-19'], 'UTC',
    )).toEqual([{ start: '2026-09-19T22:00:00.000Z', end: '2026-09-20T00:00:00.000Z' }]);
  });
  it('shifts with DST: the same wall clock lands an hour earlier in UTC after spring forward', () => {
    // New York clocks jump forward on Sunday 2026-03-08, so Saturday the 7th is still EST
    // (UTC-5) and the Sunday evening block is EDT (UTC-4) — one hour apart in offset.
    expect(weeklyOverDates(
      [{ day: 6, start: '19:00', end: '22:00' }, { day: 0, start: '19:00', end: '22:00' }],
      ['2026-03-07', '2026-03-08'], TZ,
    )).toEqual([
      { start: '2026-03-08T00:00:00.000Z', end: '2026-03-08T03:00:00.000Z' },
      { start: '2026-03-08T23:00:00.000Z', end: '2026-03-09T02:00:00.000Z' },
    ]);
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

describe('sanitizeForeignRecord', () => {
  // Everything below passes the lexicon — it checks lengths, not shapes — and every one of
  // these values throws or prints as NaN somewhere in the read path.
  const foreign = {
    timezone: TZ,
    weekly: [
      { day: 2, start: '19:00', end: '22:00' },
      { day: 3, start: '7am', end: '10pm' },
      { day: 4, start: '19:00', end: '25:00' },
      { day: 9, start: '19:00', end: '22:00' },
    ],
    away: [
      { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
      { start: 'next week', end: 'next week' },
      { start: '2026-10-12', end: '2026-10-14', startTime: '09:00' },
      { start: '2026-10-20', end: '2026-10-20', startTime: '9am', endTime: '10am' },
    ],
  } as unknown as Parameters<typeof sanitizeForeignRecord>[0];

  it('keeps only the blocks and away entries this app can read', () => {
    const out = sanitizeForeignRecord(foreign);
    expect(out.weekly).toEqual([{ day: 2, start: '19:00', end: '22:00' }]);
    expect(out.away).toEqual([
      { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
      // A window needs both ends to be a window; a lone one reads as all day.
      { start: '2026-10-12', end: '2026-10-14' },
      { start: '2026-10-20', end: '2026-10-20' },
    ]);
    expect(out.timezone).toBe(TZ);
  });
  it('leaves a record this app wrote exactly as it is', () => {
    const ours = normalizeAvailability({
      timezone: TZ, weekly: [{ day: 2, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-09-19', end: '2026-09-21', startTime: '09:00', endTime: '10:00' }],
      note: 'text first',
    });
    expect(sanitizeForeignRecord(ours)).toEqual(ours);
  });
});

describe('isKnownZone', () => {
  it('is true for an IANA zone and false for anything luxon cannot use', () => {
    expect(isKnownZone(TZ)).toBe(true);
    expect(isKnownZone('UTC')).toBe(true);
    expect(isKnownZone('Mars/Olympus')).toBe(false);
    expect(isKnownZone('')).toBe(false);
    expect(isKnownZone(undefined)).toBe(false);
  });
});

describe('"good through" dates', () => {
  it('ends the day in the record\'s zone, not in UTC', () => {
    // 23:59:59.999 on the 31st in New York is already January in UTC — and midnight UTC
    // would have expired the record at 7pm on the 30th, local.
    expect(endOfLocalDay('2026-12-31', TZ)).toBe('2027-01-01T04:59:59.999Z');
    expect(endOfLocalDay('2026-12-31', 'Asia/Tokyo')).toBe('2026-12-31T14:59:59.999Z');
    expect(endOfLocalDay('2026-12-31', 'UTC')).toBe('2026-12-31T23:59:59.999Z');
  });
  it('reads that instant back as the same date the visitor picked', () => {
    for (const zone of [TZ, 'Asia/Tokyo', 'UTC']) {
      expect(localDateOf(endOfLocalDay('2026-12-31', zone), zone)).toBe('2026-12-31');
    }
  });
  it('falls back to UTC when the zone is one it cannot use', () => {
    expect(localDateOf('2027-01-01T04:59:59.999Z', 'Mars/Olympus')).toBe('2027-01-01');
    expect(endOfLocalDay('2026-12-31', 'Mars/Olympus')).toBe('2026-12-31T23:59:59.999Z');
  });
});

describe('the alias on an availability input', () => {
  const base = { timezone: TZ, weekly: [], away: [] };
  it('is normalized like a sez name: trimmed, lowercased, absent when empty', () => {
    expect(normalizeAvailability({ ...base, alias: ' Ken ' }).alias).toBe('ken');
    expect(normalizeAvailability({ ...base, alias: '' })).not.toHaveProperty('alias');
    expect(normalizeAvailability(base)).not.toHaveProperty('alias');
    expect(() => normalizeAvailability({ ...base, alias: '-ken' })).toThrow(/hyphen/);
  });
  it('is dropped by sanitizeForeignRecord when another client wrote something that is not a name', () => {
    const rec = { ...base, alias: 'Ken!' };
    expect(sanitizeForeignRecord(rec)).not.toHaveProperty('alias');
    expect(sanitizeForeignRecord({ ...base, alias: 'ken' }).alias).toBe('ken');
  });
});
