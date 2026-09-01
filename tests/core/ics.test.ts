import { describe, it, expect } from 'vitest';
import { buildIcs } from '../../src/core/ics.js';

describe('buildIcs', () => {
  const ics = buildIcs({
    uid: '3kpoll@letsmeet.lol', title: 'Movie night; bring snacks',
    start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T23:00:00.000Z',
    url: 'https://letsmeet.lol/p/3kpoll', now: new Date('2026-08-31T12:00:00.000Z'),
  });
  it('produces a VCALENDAR with UTC times in basic format', () => {
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20260902T210000Z');
    expect(ics).toContain('DTEND:20260902T230000Z');
    expect(ics).toContain('DTSTAMP:20260831T120000Z');
    expect(ics).toContain('UID:3kpoll@letsmeet.lol');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
  it('escapes ICS special characters in the summary', () => {
    expect(ics).toContain('SUMMARY:Movie night\\; bring snacks');
  });
  it('uses CRLF line endings throughout', () => {
    expect(ics.includes('\n')).toBe(true);
    expect(ics.split('\r\n').some((line) => line.includes('\n'))).toBe(false);
  });
});
