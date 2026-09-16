import { describe, it, expect } from 'vitest';
import {
  buildAvailabilityRecord, validateAvailabilityRecord, AVAILABILITY_NSID,
} from '../../src/atproto/records.js';

const NOW = new Date('2026-09-16T12:00:00Z');
const base = {
  timezone: 'America/New_York',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }],
  away: [{ start: '2026-09-19', end: '2026-09-21', note: 'out of town' }],
};

describe('availability records', () => {
  it('builds a valid record with updatedAt', () => {
    const rec = buildAvailabilityRecord(base, NOW);
    expect(rec.$type).toBe(AVAILABILITY_NSID);
    expect(rec.updatedAt).toBe('2026-09-16T12:00:00.000Z');
    expect(() => validateAvailabilityRecord(rec)).not.toThrow();
  });
  it('accepts empty weekly and away arrays', () => {
    expect(() => buildAvailabilityRecord({ ...base, weekly: [], away: [] }, NOW)).not.toThrow();
  });
  it('rejects a weekday of 7', () => {
    expect(() => buildAvailabilityRecord({
      ...base, weekly: [{ day: 7, start: '19:00', end: '22:00' }],
    }, NOW)).toThrow();
  });
  it('rejects a timed away entry with a note over 80 graphemes', () => {
    expect(() => buildAvailabilityRecord({
      ...base, away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '19:00', endTime: '20:30', note: 'x'.repeat(81) }],
    }, NOW)).toThrow();
  });
  it('rejects a note over 300 graphemes', () => {
    expect(() => buildAvailabilityRecord({ ...base, note: 'x'.repeat(301) }, NOW)).toThrow();
  });
  it('rejects a malformed validUntil', () => {
    expect(() => buildAvailabilityRecord({ ...base, validUntil: 'soon' }, NOW)).toThrow();
  });
});
