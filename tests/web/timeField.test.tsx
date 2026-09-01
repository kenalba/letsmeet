import { describe, it, expect } from 'vitest';
import { parseTime, formatTime, EMPTY_TIME } from '../../src/web/ui/time-field.js';

/**
 * The 24h <-> 12h conversion the segmented field is built on. It is the only part of
 * `ui/time-field.tsx` that can be exercised without a DOM — and the only part where a
 * mistake would silently post the wrong hour (the noon/midnight pair especially), so it
 * lives in exported functions kept free of React on purpose.
 */
describe('time-field conversions', () => {
  it('parses a 24h time into 12h segments', () => {
    expect(parseTime('17:00')).toEqual({ hour: 5, minute: 0, period: 'PM' });
    expect(parseTime('09:05')).toEqual({ hour: 9, minute: 5, period: 'AM' });
    // The two that a naive `h % 12` gets wrong: midnight and noon are both hour 12.
    expect(parseTime('00:30')).toEqual({ hour: 12, minute: 30, period: 'AM' });
    expect(parseTime('12:00')).toEqual({ hour: 12, minute: 0, period: 'PM' });
    expect(parseTime('23:59')).toEqual({ hour: 11, minute: 59, period: 'PM' });
  });

  it('treats anything that is not a time of day as empty', () => {
    for (const junk of ['', '  ', '2pm', '24:00', '12:60', 'noon', '7']) {
      expect(parseTime(junk)).toEqual(EMPTY_TIME);
    }
  });

  it('formats 12h segments back to 24h', () => {
    expect(formatTime({ hour: 12, minute: 30, period: 'AM' })).toBe('00:30');
    expect(formatTime({ hour: 12, minute: 0, period: 'PM' })).toBe('12:00');
    expect(formatTime({ hour: 5, minute: 0, period: 'PM' })).toBe('17:00');
    expect(formatTime({ hour: 9, minute: 5, period: 'AM' })).toBe('09:05');
  });

  it('formats an incomplete time as the empty string', () => {
    // "" is what the hidden input must carry while a segment is unset: it is what the
    // submit guard reads, and half a time has no 24h spelling to post.
    expect(formatTime(EMPTY_TIME)).toBe('');
    expect(formatTime({ hour: 5, minute: null, period: 'PM' })).toBe('');
    expect(formatTime({ hour: null, minute: 30, period: 'PM' })).toBe('');
    expect(formatTime({ hour: 5, minute: 30, period: null })).toBe('');
  });

  it('round-trips every minute of the clock, and the empty value', () => {
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 1, 30, 59]) {
        const hhmm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        expect(formatTime(parseTime(hhmm))).toBe(hhmm);
      }
    }
    expect(formatTime(parseTime(''))).toBe('');
  });
});
