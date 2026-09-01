import type { Interval } from './intervals.js';

export interface ResponseSummary {
  who: string;
  pending?: boolean;
  available: Interval[];
  ifNeedBe: Interval[];
}

export interface RankedSlot {
  slot: Interval;
  available: string[];
  ifNeedBe: string[];
  missing: string[];
  score: number;
}

const covers = (ivs: Interval[], s: Interval) =>
  ivs.some((iv) => iv.start <= s.start && iv.end >= s.end);

export function rankSlots(slots: Interval[], responses: ResponseSummary[]): RankedSlot[] {
  const ranked = slots.map((slot) => {
    const available = responses.filter((r) => covers(r.available, slot)).map((r) => r.who);
    const ifNeedBe = responses
      .filter((r) => !covers(r.available, slot) && covers(r.ifNeedBe, slot))
      .map((r) => r.who);
    const missing = responses
      .map((r) => r.who)
      .filter((w) => !available.includes(w) && !ifNeedBe.includes(w));
    return { slot, available, ifNeedBe, missing, score: available.length + 0.5 * ifNeedBe.length };
  });
  return ranked.sort((a, b) => b.score - a.score || a.slot.start.localeCompare(b.slot.start));
}
