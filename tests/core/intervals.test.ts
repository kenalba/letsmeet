import { describe, it, expect } from 'vitest';
import { mergeIntervals, snapToSlots, normalizeIso } from '../../src/core/intervals.js';

const iv = (start: string, end: string) => ({ start, end });

describe('normalizeIso', () => {
  it('normalizes to UTC ISO with milliseconds', () => {
    expect(normalizeIso('2026-09-02T17:00:00Z')).toBe('2026-09-02T17:00:00.000Z');
  });
  it('throws on garbage', () => {
    expect(() => normalizeIso('not a date')).toThrow();
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and touching intervals', () => {
    expect(mergeIntervals([
      iv('2026-09-02T18:00:00.000Z', '2026-09-02T19:00:00.000Z'),
      iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:00:00.000Z'),
      iv('2026-09-02T18:30:00.000Z', '2026-09-02T20:00:00.000Z'),
    ])).toEqual([iv('2026-09-02T17:00:00.000Z', '2026-09-02T20:00:00.000Z')]);
  });
  it('keeps disjoint intervals separate', () => {
    expect(mergeIntervals([
      iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:00:00.000Z'),
      iv('2026-09-02T19:00:00.000Z', '2026-09-02T20:00:00.000Z'),
    ])).toHaveLength(2);
  });
  it('returns [] for []', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
  it('throws when start >= end', () => {
    expect(() => mergeIntervals([iv('2026-09-02T18:00:00.000Z', '2026-09-02T18:00:00.000Z')])).toThrow();
  });
});

describe('snapToSlots', () => {
  const slots = [
    iv('2026-09-02T17:00:00.000Z', '2026-09-02T17:30:00.000Z'),
    iv('2026-09-02T17:30:00.000Z', '2026-09-02T18:00:00.000Z'),
    iv('2026-09-02T18:00:00.000Z', '2026-09-02T18:30:00.000Z'),
  ];
  it('keeps only fully covered slots, merged', () => {
    expect(snapToSlots([iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:10:00.000Z')], slots))
      .toEqual([iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:00:00.000Z')]);
  });
  it('drops paint entirely outside the slots', () => {
    expect(snapToSlots([iv('2026-09-02T21:00:00.000Z', '2026-09-02T22:00:00.000Z')], slots)).toEqual([]);
  });
});
