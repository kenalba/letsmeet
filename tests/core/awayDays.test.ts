import { describe, it, expect } from 'vitest';
import type { AwayEntry } from '../../src/atproto/records.js';
import { compactAway, expandAway, paintAway, toggleAllDay } from '../../src/core/awayDays.js';
import { normalizeAvailability } from '../../src/core/availability.js';

// The mock's fixture in the record's half-hour shape: a timed saturday, an all-day
// conference over two days, and a wedding three weeks out.
const FIXTURE: AwayEntry[] = [
  { start: '2026-09-19', end: '2026-09-19', startTime: '11:00', endTime: '15:00' },
  { start: '2026-09-23', end: '2026-09-24', note: 'conference' },
  { start: '2026-10-03', end: '2026-10-05', note: 'wedding' },
];
// Monday-first weeks: sep 14 – 20, sep 21 – 27, oct 5 – 11.
const WEEK1 = ['2026-09-14', '2026-09-20'] as const;
const WEEK2 = ['2026-09-21', '2026-09-27'] as const;

/** A date's half hours, sorted — or 'all', or undefined where the map has no entry. */
const hours = (days: ReturnType<typeof expandAway>, date: string) => {
  const v = days.get(date);
  return v && v.away !== 'all' ? [...v.away].sort() : v?.away;
};

describe('expandAway', () => {
  it('expands a timed entry into its half-hour starts, and nothing outside the window', () => {
    const days = expandAway(FIXTURE, ...WEEK1);
    expect([...days.keys()]).toEqual(['2026-09-19']);
    expect(hours(days, '2026-09-19'))
      .toEqual(['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30']);
    expect(days.get('2026-09-19')!.note).toBe('');
  });
  it('expands an all-day entry to every date it covers, carrying its note', () => {
    const days = expandAway(FIXTURE, ...WEEK2);
    expect([...days.keys()].sort()).toEqual(['2026-09-23', '2026-09-24']);
    expect(days.get('2026-09-23')).toEqual({ away: 'all', note: 'conference' });
  });
  it('clips a range to the window, so the week of oct 5 sees only oct 5', () => {
    const days = expandAway(FIXTURE, '2026-10-05', '2026-10-11');
    expect([...days.keys()]).toEqual(['2026-10-05']);
    expect(days.get('2026-10-05')).toEqual({ away: 'all', note: 'wedding' });
  });
  it('reads a window that ends at midnight as the rest of the day', () => {
    const days = expandAway(
      [{ start: '2026-09-19', end: '2026-09-19', startTime: '23:00', endTime: '00:00' }], ...WEEK1);
    expect(hours(days, '2026-09-19')).toEqual(['23:00', '23:30']);
  });
  it('lets an all-day entry win over a timed one on the same date', () => {
    const days = expandAway([
      { start: '2026-09-19', end: '2026-09-19', startTime: '11:00', endTime: '12:00' },
      { start: '2026-09-19', end: '2026-09-19', note: 'gone' },
    ], ...WEEK1);
    expect(days.get('2026-09-19')).toEqual({ away: 'all', note: 'gone' });
  });
});

describe('compactAway', () => {
  it('round-trips the fixture through the day map, one shown range at a time', () => {
    // The wedding runs sat oct 3 to mon oct 5, so no single monday-first week holds it: the
    // third range is the fortnight that does.
    for (const [from, to] of [WEEK1, WEEK2, ['2026-09-28', '2026-10-11'] as const]) {
      expect(compactAway(FIXTURE, from, to, expandAway(FIXTURE, from, to))).toEqual(FIXTURE);
    }
  });
  it('splits a straddling range at the edge of the shown range, covering the same dates', () => {
    // An untouched week of oct 5 cannot see oct 3 – 4, so those stay their own entry rather
    // than merging back: the coverage is identical, the entries are not.
    const week = ['2026-10-05', '2026-10-11'] as const;
    expect(compactAway(FIXTURE, ...week, expandAway(FIXTURE, ...week))).toEqual([
      FIXTURE[0],
      FIXTURE[1],
      { start: '2026-10-03', end: '2026-10-04', note: 'wedding' },
      { start: '2026-10-05', end: '2026-10-05', note: 'wedding' },
    ]);
  });
  it('keeps both tails of a range that straddles the whole edited week', () => {
    const entries: AwayEntry[] = [{ start: '2026-09-12', end: '2026-09-27', note: 'trip' }];
    const days = toggleAllDay(expandAway(entries, ...WEEK1), '2026-09-16');
    const away = compactAway(entries, ...WEEK1, days);
    expect(away).toEqual([
      { start: '2026-09-12', end: '2026-09-13', note: 'trip' },
      { start: '2026-09-14', end: '2026-09-15', note: 'trip' },
      { start: '2026-09-17', end: '2026-09-20', note: 'trip' },
      { start: '2026-09-21', end: '2026-09-27', note: 'trip' },
    ]);
    expect(normalizeAvailability({ timezone: 'UTC', weekly: [], away }).away).toEqual(away);
  });
  it('writes what normalizeAvailability writes, for a mixed edit of the fixture', () => {
    const days = paintAway(
      toggleAllDay(expandAway(FIXTURE, ...WEEK1), '2026-09-14'),
      ['2026-09-19', '2026-09-20'], ['23:00', '23:30'], true);
    const away = compactAway(FIXTURE, ...WEEK1, days);
    expect(normalizeAvailability({ timezone: 'UTC', weekly: [], away }).away).toEqual(away);
  });
  it('turns a rectangle across two days into one entry with a window', () => {
    const days = paintAway(
      new Map(), ['2026-09-19', '2026-09-20'], ['11:00', '11:30', '12:00', '12:30'], true);
    expect(compactAway([], ...WEEK1, days)).toEqual([
      { start: '2026-09-19', end: '2026-09-20', startTime: '11:00', endTime: '13:00' },
    ]);
  });
  it('makes one entry per run of half hours on a day', () => {
    const days = paintAway(new Map(), ['2026-09-19'], ['09:00', '09:30', '14:00'], true);
    expect(compactAway([], ...WEEK1, days)).toEqual([
      { start: '2026-09-19', end: '2026-09-19', startTime: '09:00', endTime: '10:00' },
      { start: '2026-09-19', end: '2026-09-19', startTime: '14:00', endTime: '14:30' },
    ]);
  });
  it('ends a stroke on the last row at midnight, which normalizeAvailability keeps', () => {
    const days = paintAway(new Map(), ['2026-09-19'], ['23:00', '23:30'], true);
    const away = compactAway([], ...WEEK1, days);
    expect(away).toEqual([
      { start: '2026-09-19', end: '2026-09-19', startTime: '23:00', endTime: '00:00' },
    ]);
    expect(normalizeAvailability({ timezone: 'UTC', weekly: [], away }).away).toEqual(away);
  });
  it('leaves the part of a range outside the edited week alone, splitting it cleanly', () => {
    // oct 3 – 10 with a note, edited on the week of oct 5: clearing oct 7 leaves oct 3 – 4
    // untouched and splits the rest around the hole.
    const entries: AwayEntry[] = [{ start: '2026-10-03', end: '2026-10-10', note: 'wedding' }];
    const days = toggleAllDay(expandAway(entries, '2026-10-05', '2026-10-11'), '2026-10-07');
    expect(compactAway(entries, '2026-10-05', '2026-10-11', days)).toEqual([
      { start: '2026-10-03', end: '2026-10-04', note: 'wedding' },
      { start: '2026-10-05', end: '2026-10-06', note: 'wedding' },
      { start: '2026-10-08', end: '2026-10-10', note: 'wedding' },
    ]);
  });
  it('splits a multi-day timed range where part of it is unpainted', () => {
    const entries: AwayEntry[] = [
      { start: '2026-09-14', end: '2026-09-16', startTime: '09:00', endTime: '10:00' },
    ];
    const days = paintAway(expandAway(entries, ...WEEK1), ['2026-09-15'], ['09:00', '09:30'], false);
    expect(compactAway(entries, ...WEEK1, days)).toEqual([
      { start: '2026-09-14', end: '2026-09-14', startTime: '09:00', endTime: '10:00' },
      { start: '2026-09-16', end: '2026-09-16', startTime: '09:00', endTime: '10:00' },
    ]);
  });
  it('sorts by date and then by the window start, as the record is written', () => {
    const days = paintAway(expandAway(FIXTURE, ...WEEK1), ['2026-09-20'], ['08:00'], true);
    expect(compactAway(FIXTURE, ...WEEK1, days).map((a) => [a.start, a.startTime ?? ''])).toEqual([
      ['2026-09-19', '11:00'], ['2026-09-20', '08:00'], ['2026-09-23', ''], ['2026-10-03', ''],
    ]);
  });
});

describe('toggleAllDay and paintAway', () => {
  it('sets all day on a clear date and clears a date that has anything, note and all', () => {
    const days = expandAway(FIXTURE, ...WEEK2);
    const cleared = toggleAllDay(days, '2026-09-23');
    expect(cleared.has('2026-09-23')).toBe(false);
    expect(compactAway(FIXTURE, ...WEEK2, cleared)).toEqual([
      FIXTURE[0],
      { start: '2026-09-24', end: '2026-09-24', note: 'conference' },
      FIXTURE[2],
    ]);
    expect(toggleAllDay(new Map(), '2026-09-22').get('2026-09-22')).toEqual({ away: 'all', note: '' });
  });
  it('leaves an all-day date locked against painting', () => {
    const days = toggleAllDay(new Map(), '2026-09-22');
    expect(paintAway(days, ['2026-09-22'], ['09:00'], false).get('2026-09-22'))
      .toEqual({ away: 'all', note: '' });
  });
  it('drops a date once its last half hour is cleared', () => {
    const days = paintAway(new Map(), ['2026-09-22'], ['09:00'], true);
    expect(paintAway(days, ['2026-09-22'], ['09:00'], false).has('2026-09-22')).toBe(false);
  });
  it('keeps the note when a painted date is painted again', () => {
    const days = expandAway([{
      start: '2026-09-19', end: '2026-09-19', startTime: '11:00', endTime: '12:00', note: 'dentist',
    }], ...WEEK1);
    expect(paintAway(days, ['2026-09-19'], ['13:00'], true).get('2026-09-19')!.note).toBe('dentist');
  });
});
