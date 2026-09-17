import { describe, it, expect } from 'vitest';
import { buildAvailabilityIcs } from '../../src/core/ics.js';

const rec = {
  timezone: 'America/New_York',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }],
  away: [
    { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
    { start: '2026-10-12', end: '2026-10-14', startTime: '09:00', endTime: '10:00', note: 'a; note, with punctuation' },
  ],
  validUntil: '2026-12-31T23:59:59.000Z',
  updatedAt: '2026-09-16T12:00:00.000Z',
};
const opts = { uidHost: 'letsmeet.lol', name: 'ken.wzrdz.cool', now: new Date('2026-09-16T12:00:00Z') };

describe('buildAvailabilityIcs', () => {
  const ics = buildAvailabilityIcs(rec, opts);
  const lines = ics.split('\r\n');
  it('is a calendar named for the account with the record zone', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('X-WR-CALNAME:ken.wzrdz.cool · availability');
    expect(lines).toContain('X-WR-TIMEZONE:America/New_York');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(ics.endsWith('\r\n')).toBe(true);
  });
  it('repeats each weekly block with TZID and UNTIL from validUntil', () => {
    expect(lines).toContain('DTSTART;TZID=America/New_York:20260106T190000'); // the template Tuesday
    expect(lines).toContain('DTEND;TZID=America/New_York:20260106T220000');
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z');
    expect(lines).toContain('SUMMARY:@ken.wzrdz.cool usually free');
    expect(lines).toContain('TRANSP:TRANSPARENT');
  });
  it('emits an all-day away entry with an exclusive end', () => {
    expect(lines).toContain('DTSTART;VALUE=DATE:20260919');
    expect(lines).toContain('DTEND;VALUE=DATE:20260922');
    expect(lines).toContain('SUMMARY:@ken.wzrdz.cool away · out of town');
    expect(lines).toContain('TRANSP:OPAQUE');
  });
  it('emits a timed multi-day away entry as a daily repeat and escapes the note', () => {
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261012T090000');
    // RFC 5545 §3.3.10: DTSTART carries a TZID, so UNTIL must be UTC — and it bounds the
    // series by the last occurrence's start, 09:00 New York on the 14th = 13:00Z. The old
    // local `T235959` let a strict client drop the last day of an evening window.
    expect(lines).toContain('RRULE:FREQ=DAILY;UNTIL=20261014T130000Z');
    expect(lines).toContain('SUMMARY:@ken.wzrdz.cool away · a\\; note\\, with punctuation');
  });
  it('keeps the last day of a late window, where UNTIL lands on the next UTC day', () => {
    const late = buildAvailabilityIcs({
      ...rec, timezone: 'America/Los_Angeles',
      away: [{ start: '2026-10-12', end: '2026-10-14', startTime: '22:00', endTime: '23:00' }],
    }, opts);
    // 22:00 PDT on the 14th is 05:00Z on the 15th; an UNTIL of 20261014T235959Z would end
    // the series before that last occurrence ever started.
    expect(late.split('\r\n')).toContain('RRULE:FREQ=DAILY;UNTIL=20261015T050000Z');
  });
  it('gives every event a stable UID and folds long lines', () => {
    const uids = lines.filter((l) => l.startsWith('UID:'));
    expect(new Set(uids).size).toBe(3);
    expect(lines).toContain('UID:away-20260919-20260921-allday@letsmeet.lol');
    expect(lines).toContain('UID:away-20261012-20261014-0900-1000@letsmeet.lol');
    const long = buildAvailabilityIcs({ ...rec, away: [{ start: '2026-09-19', end: '2026-09-19', note: 'é'.repeat(80) }] }, opts);
    for (const l of long.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
  it('treats an away entry with only startTime (no endTime) as all-day, not a crash', () => {
    // The lexicon allows startTime or endTime alone; a record written by another client
    // could arrive this way, and the read path only validates against the lexicon.
    const half = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-10-20', end: '2026-10-20', startTime: '09:00' }],
    }, opts);
    const halfLines = half.split('\r\n');
    expect(halfLines).toContain('UID:away-20261020-20261020-allday@letsmeet.lol');
    expect(halfLines).toContain('DTSTART;VALUE=DATE:20261020');
    expect(halfLines).toContain('DTEND;VALUE=DATE:20261021');
  });
  it('gives away entries that share a start date distinct UIDs', () => {
    const ics2 = buildAvailabilityIcs({
      ...rec,
      away: [
        { start: '2026-10-15', end: '2026-10-15' },
        { start: '2026-10-15', end: '2026-10-20' },
        { start: '2026-10-15', end: '2026-10-15', startTime: '09:00', endTime: '10:00' },
        { start: '2026-10-15', end: '2026-10-15', startTime: '09:00', endTime: '11:00' },
      ],
    }, opts);
    const uids = ics2.split('\r\n').filter((l) => l.startsWith('UID:away-'));
    expect(uids).toHaveLength(4);
    expect(new Set(uids).size).toBe(4);
  });
  it('names a plain away entry after the account too', () => {
    const plain = buildAvailabilityIcs({ ...rec, away: [{ start: '2026-10-20', end: '2026-10-20' }] }, opts);
    expect(plain.split('\r\n')).toContain('SUMMARY:@ken.wzrdz.cool away');
  });
  it('excludes a weekly block on every date an all-day away entry covers on that weekday', () => {
    // Tue 22 Sep through Tue 29 Sep 2026: two Tuesdays inside one all-day entry.
    const ics = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-09-22', end: '2026-09-29', note: 'trip' }],
    }, opts);
    expect(ics.split('\r\n')).toContain('EXDATE;TZID=America/New_York:20260922T190000,20260929T190000');
  });
  it('emits no EXDATE when no all-day entry lands on the block\'s weekday, nor for timed windows', () => {
    // The fixture: sat 19 – mon 21 all day (no Tuesday), and a timed window mon 12 – wed 14 oct.
    expect(lines.some((l) => l.startsWith('EXDATE'))).toBe(false);
    const timed = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-09-22', end: '2026-09-22', startTime: '18:00', endTime: '23:00' }],
    }, opts);
    expect(timed.split('\r\n').some((l) => l.startsWith('EXDATE'))).toBe(false);
  });
  it('merges and sorts the dates of overlapping all-day entries', () => {
    const ics = buildAvailabilityIcs({
      ...rec, away: [
        { start: '2026-09-29', end: '2026-09-29' },
        { start: '2026-09-21', end: '2026-09-29' },
      ],
    }, opts);
    expect(ics.split('\r\n')).toContain('EXDATE;TZID=America/New_York:20260922T190000,20260929T190000');
  });
  it('excludes at most a year of a very long away entry', () => {
    const ics = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-09-22', end: '2099-12-31' }],
    }, opts);
    // Unfold first (RFC 5545 continuation lines), then read the one EXDATE property.
    const unfolded = ics.replace(/\r\n /g, '').split('\r\n');
    const ex = unfolded.find((l) => l.startsWith('EXDATE;TZID=America/New_York:'))!;
    expect(ex.slice('EXDATE;TZID=America/New_York:'.length).split(',').length).toBe(53);
  });
});
