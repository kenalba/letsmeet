import { DateTime } from 'luxon';
import type { Interval } from './intervals.js';

/**
 * Slot granularities the app offers, mirroring the `slotMinutes` enum in
 * `lexicons/lol.letsmeet.poll.schedule.json` — the two must stay in sync, since a value
 * this type allows but the lexicon rejects only fails at record-build time.
 */
export type SlotMinutes = 10 | 15 | 20 | 30 | 45 | 60 | 90 | 120;

export interface SpecificDates {
  dates: string[];                     // ISO dates, explicit list, non-contiguous OK
  window: { start: string; end: string }; // "HH:MM" in `timezone`
  slotMinutes: SlotMinutes;
  timezone: string;                    // IANA
}

/** Each date × window materializes to UTC individually, so DST is per-date arithmetic. */
export function materializeSlots(t: SpecificDates): Interval[] {
  const out: Interval[] = [];
  for (const date of t.dates) {
    let cur = DateTime.fromISO(`${date}T${t.window.start}`, { zone: t.timezone });
    let end = DateTime.fromISO(`${date}T${t.window.end}`, { zone: t.timezone });
    if (!cur.isValid || !end.isValid) {
      throw new Error(`invalid date/window/timezone: ${date} ${JSON.stringify(t.window)} ${t.timezone}`);
    }
    if (end <= cur) end = end.plus({ days: 1 }); // window crosses midnight
    while (cur < end) {
      const nxt = cur.plus({ minutes: t.slotMinutes });
      if (nxt > end) break; // drop a trailing slot the window can't fully contain
      out.push({ start: cur.toUTC().toISO()!, end: nxt.toUTC().toISO()! });
      cur = nxt;
    }
  }
  return out;
}
