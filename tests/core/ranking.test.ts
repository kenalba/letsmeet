import { describe, it, expect } from 'vitest';
import { rankSlots } from '../../src/core/ranking.js';

const iv = (start: string, end: string) => ({ start, end });
const S1 = iv('2026-09-02T17:00:00.000Z', '2026-09-02T17:30:00.000Z');
const S2 = iv('2026-09-02T17:30:00.000Z', '2026-09-02T18:00:00.000Z');

describe('rankSlots', () => {
  it('ranks everyone-free slots first and lists the missing', () => {
    const ranked = rankSlots([S1, S2], [
      { who: 'ken', available: [iv(S1.start, S2.end)], ifNeedBe: [] },
      { who: 'sam', available: [S1], ifNeedBe: [] },
    ]);
    expect(ranked[0].slot).toEqual(S1);
    expect(ranked[0].available).toEqual(['ken', 'sam']);
    expect(ranked[0].missing).toEqual([]);
    expect(ranked[1].missing).toEqual(['sam']);
  });

  it('weights ifNeedBe at half and reports it separately', () => {
    const ranked = rankSlots([S1, S2], [
      { who: 'ken', available: [S1], ifNeedBe: [] },
      { who: 'sam', available: [], ifNeedBe: [S1] },
      { who: 'ana', available: [S2], ifNeedBe: [] },
    ]);
    // S1: 1 + 0.5 = 1.5; S2: 1
    expect(ranked[0].slot).toEqual(S1);
    expect(ranked[0].score).toBe(1.5);
    expect(ranked[0].ifNeedBe).toEqual(['sam']);
  });

  it('breaks score ties by earlier start', () => {
    const ranked = rankSlots([S2, S1], [{ who: 'ken', available: [iv(S1.start, S2.end)], ifNeedBe: [] }]);
    expect(ranked[0].slot).toEqual(S1);
  });

  it('available wins over ifNeedBe for the same person', () => {
    const ranked = rankSlots([S1], [{ who: 'ken', available: [S1], ifNeedBe: [S1] }]);
    expect(ranked[0].available).toEqual(['ken']);
    expect(ranked[0].ifNeedBe).toEqual([]);
  });
});
