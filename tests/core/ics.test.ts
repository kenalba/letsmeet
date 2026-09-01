import { describe, it, expect } from 'vitest';
import { buildIcs, foldLine } from '../../src/core/ics.js';

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
  it('cannot be broken out of by a title carrying CR, LF or CRLF', () => {
    // A bare \r used to survive escaping and start a new content line: a title could
    // then inject its own properties (an ATTENDEE, a second DTSTART) into the file.
    const evil = buildIcs({
      uid: 'u', title: 'Dinner\rATTENDEE:mailto:x@example.com\nDESCRIPTION:y\r\nX:z',
      start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T23:00:00.000Z', now: new Date(0),
    });
    const lines = evil.split('\r\n');
    expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(0);
    expect(lines.filter((l) => l.startsWith('DESCRIPTION'))).toHaveLength(0);
    expect(lines.find((l) => l.startsWith('SUMMARY'))).toBe(
      'SUMMARY:Dinner\\nATTENDEE:mailto:x@example.com\\nDESCRIPTION:y\\nX:z',
    );
  });
  it('folds content lines longer than 75 octets on a UTF-8 boundary', () => {
    const long = buildIcs({
      uid: 'u', title: 'é'.repeat(60) + ' and then some more words to push it well past the limit',
      start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T23:00:00.000Z', now: new Date(0),
    });
    const enc = new TextEncoder();
    for (const line of long.split('\r\n')) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    // Continuation lines start with a single space and unfold back to the original.
    const unfolded = long.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:' + 'é'.repeat(60));
    expect(foldLine('short')).toBe('short');
  });
});
