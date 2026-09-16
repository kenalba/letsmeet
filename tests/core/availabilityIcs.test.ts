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
    expect(lines).toContain('SUMMARY:usually free');
    expect(lines).toContain('TRANSP:TRANSPARENT');
  });
  it('emits an all-day away entry with an exclusive end', () => {
    expect(lines).toContain('DTSTART;VALUE=DATE:20260919');
    expect(lines).toContain('DTEND;VALUE=DATE:20260922');
    expect(lines).toContain('SUMMARY:away · out of town');
    expect(lines).toContain('TRANSP:OPAQUE');
  });
  it('emits a timed multi-day away entry as a daily repeat and escapes the note', () => {
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261012T090000');
    expect(lines).toContain('RRULE:FREQ=DAILY;UNTIL=20261014T235959');
    expect(lines).toContain('SUMMARY:away · a\\; note\\, with punctuation');
  });
  it('gives every event a stable UID and folds long lines', () => {
    const uids = lines.filter((l) => l.startsWith('UID:'));
    expect(new Set(uids).size).toBe(3);
    const long = buildAvailabilityIcs({ ...rec, away: [{ start: '2026-09-19', end: '2026-09-19', note: 'é'.repeat(80) }] }, opts);
    for (const l of long.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
});
