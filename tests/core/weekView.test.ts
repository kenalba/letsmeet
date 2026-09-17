import { describe, it, expect } from 'vitest';
import {
  buildWeekView, mondayOf, localToday, weekTitle, dateRangeLabel, hourLabel, weekChoice, awayLater,
  HOURS, type WeekView,
} from '../../src/core/weekView.js';

const TZ = 'America/New_York';
// Wednesday 2026-09-16, noon in New York.
const NOW = new Date('2026-09-16T16:00:00Z');
const base = { timezone: TZ, weekly: [], away: [] };
const cell = (v: WeekView, dayIdx: number, hour: number) => v.days[dayIdx].cells[HOURS.indexOf(hour)];

describe('mondayOf / localToday', () => {
  it('finds the monday of the week containing a wednesday, a sunday and a monday', () => {
    expect(mondayOf('2026-09-16')).toBe('2026-09-14');
    expect(mondayOf('2026-09-20')).toBe('2026-09-14');
    expect(mondayOf('2026-09-14')).toBe('2026-09-14');
  });
  it('reads today in the record zone, not in utc', () => {
    // 02:00Z on the 17th is still the evening of the 16th in New York.
    expect(localToday(new Date('2026-09-17T02:00:00Z'), TZ)).toBe('2026-09-16');
    expect(localToday(new Date('2026-09-17T02:00:00Z'), 'UTC')).toBe('2026-09-17');
  });
});

describe('buildWeekView', () => {
  it('lays out monday to sunday of the week containing today, with past and today flags', () => {
    const v = buildWeekView(base, NOW, 0);
    expect([v.monday, v.sunday, v.title]).toEqual(['2026-09-14', '2026-09-20', 'sep 14 – 20']);
    expect(v.days.map((d) => d.dow)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
    expect(v.days.map((d) => d.dom)).toEqual([14, 15, 16, 17, 18, 19, 20]);
    expect(v.days.map((d) => d.past)).toEqual([true, true, false, false, false, false, false]);
    expect(v.days.map((d) => d.today)).toEqual([false, false, true, false, false, false, false]);
    expect(v.days[0].cells).toHaveLength(HOURS.length);
    expect(v.hasAway).toBe(false);
  });
  it('offset 1 is the following week, with nothing past and no today', () => {
    const v = buildWeekView(base, NOW, 1);
    expect([v.monday, v.sunday, v.title]).toEqual(['2026-09-21', '2026-09-27', 'sep 21 – 27']);
    expect(v.days.some((d) => d.past || d.today)).toBe(false);
  });
  it('draws a block by the hour: half-late, full, none, half-early', () => {
    const v = buildWeekView({
      ...base,
      weekly: [{ day: 2, start: '17:30', end: '19:00' }, { day: 2, start: '20:00', end: '20:30' }],
    }, NOW, 0);
    // Tuesday is column 1.
    expect(cell(v, 1, 17).state).toBe('late');
    expect(cell(v, 1, 18).state).toBe('free');
    expect(cell(v, 1, 19).state).toBe('none');
    expect(cell(v, 1, 20).state).toBe('early');
    expect(cell(v, 0, 18).state).toBe('none');
  });
  it('a past-midnight block fills the 11pm row; a block before 7am draws nothing', () => {
    const v = buildWeekView({
      ...base,
      weekly: [{ day: 5, start: '22:00', end: '00:00' }, { day: 5, start: '05:00', end: '06:30' }],
    }, NOW, 0);
    expect(cell(v, 4, 22).state).toBe('free');
    expect(cell(v, 4, 23).state).toBe('free');
    expect(cell(v, 4, 7).state).toBe('none');
  });
  it('an all-day away entry strikes the whole column and carries its note under the date', () => {
    const v = buildWeekView({
      ...base,
      weekly: [{ day: 6, start: '11:00', end: '23:00' }],
      away: [{ start: '2026-09-19', end: '2026-09-20', note: 'out of town' }],
    }, NOW, 0);
    expect(v.days[5].awayAllDay).toBe('out of town');
    expect(v.days[5].cells.every((c) => c.state === 'away' && c.note === 'out of town')).toBe(true);
    expect(v.days[6].awayAllDay).toBe('out of town');
    expect(v.days[4].awayAllDay).toBeNull();
    expect(v.hasAway).toBe(true);
  });
  it('a timed away entry strikes only the hours it overlaps, and wins over free', () => {
    const v = buildWeekView({
      ...base,
      weekly: [{ day: 4, start: '17:00', end: '20:00' }],
      away: [{ start: '2026-09-17', end: '2026-09-17', startTime: '17:30', endTime: '18:30', note: 'dentist' }],
    }, NOW, 0);
    expect(cell(v, 3, 17)).toEqual({ state: 'away', note: 'dentist' });
    expect(cell(v, 3, 18)).toEqual({ state: 'away', note: 'dentist' });
    expect(cell(v, 3, 19)).toEqual({ state: 'free' });
    expect(v.days[3].awayAllDay).toBeNull();
    expect(v.hasAway).toBe(true);
  });
  it('a lone startTime is all day, as freeIntervals reads it', () => {
    const v = buildWeekView({
      ...base,
      weekly: [{ day: 5, start: '09:00', end: '12:00' }],
      away: [{ start: '2026-09-18', end: '2026-09-18', startTime: '09:00' }],
    }, NOW, 0);
    expect(v.days[4].awayAllDay).toBe('');
    expect(cell(v, 4, 9).state).toBe('away');
  });
  it('a foreign timed window that ends at or before it starts cuts the rest of the day, as freeIntervals does', () => {
    const v = buildWeekView({
      ...base,
      weekly: [{ day: 4, start: '17:00', end: '23:00' }],
      away: [
        { start: '2026-09-17', end: '2026-09-17', startTime: '18:00', endTime: '09:00', note: 'overnight' },
        { start: '2026-09-18', end: '2026-09-18', startTime: '09:00', endTime: '09:00' },
      ],
    }, NOW, 0);
    expect(cell(v, 3, 17).state).toBe('free');
    expect(cell(v, 3, 18)).toEqual({ state: 'away', note: 'overnight' });
    expect(cell(v, 3, 23).state).toBe('away');
    expect(cell(v, 4, 9).state).toBe('away');
    expect(cell(v, 4, 23).state).toBe('away');
    expect(cell(v, 4, 8).state).toBe('none');
    expect(v.hasAway).toBe(true);
  });
  it('lists away entries that start after next week as later, sorted, dropping ones already over', () => {
    const away = [
      { start: '2026-09-01', end: '2026-09-02' },
      { start: '2026-09-25', end: '2026-10-03', note: 'straddles' },
      { start: '2026-10-03', end: '2026-10-05', note: 'wedding' },
      { start: '2026-09-28', end: '2026-09-28' },
    ];
    const expected = [
      { start: '2026-09-28', end: '2026-09-28' },
      { start: '2026-10-03', end: '2026-10-05', note: 'wedding' },
    ];
    expect(buildWeekView({ ...base, away }, NOW, 0).later).toEqual(expected);
    // Relative to today's week even when next week is shown.
    expect(buildWeekView({ ...base, away }, NOW, 1).later).toEqual(expected);
    expect(awayLater(away, '2026-09-27')).toEqual(expected);
  });
});

describe('labels', () => {
  it('titles a week inside and across a month', () => {
    expect(weekTitle('2026-09-14', '2026-09-20')).toBe('sep 14 – 20');
    expect(weekTitle('2026-09-28', '2026-10-04')).toBe('sep 28 – oct 4');
  });
  it('labels date ranges and hours', () => {
    expect(dateRangeLabel('2026-10-03', '2026-10-05')).toBe('oct 3 – 5');
    expect(dateRangeLabel('2026-10-20', '2026-10-20')).toBe('oct 20');
    expect(dateRangeLabel('2026-10-30', '2026-11-02')).toBe('oct 30 – nov 2');
    // Midnight reads 12am, not 0am: this week grid starts at 7am, but the availability
    // editor's rows share this label and do reach hour 0.
    expect([hourLabel(0), hourLabel(7), hourLabel(12), hourLabel(13), hourLabel(23)])
      .toEqual(['12am', '7am', '12pm', '1pm', '11pm']);
  });
  it('reads the week query', () => {
    expect(weekChoice(undefined)).toBe('this');
    expect(weekChoice('next')).toBe('next');
    expect(weekChoice('later')).toBe('later');
    expect(weekChoice('2026-09-21')).toBe('this');
  });
});
