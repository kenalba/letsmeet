import { DateTime } from 'luxon';
import type { Interval } from './intervals.js';
import { UserError } from './errors.js';

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

/**
 * `start`..`end` on a local `date` in `timezone`, as DateTimes (UTC conversion is left to
 * the caller). A past-midnight `end` (`end <= start`) rolls to the next day. Shared by
 * `materializeSlots` and `freeIntervals` (`./availability.ts`) so the wall-clock → DateTime
 * arithmetic — and its error message — lives in exactly one place.
 */
export function localWindow(
  date: string, start: string, end: string, timezone: string,
): { start: DateTime; end: DateTime } {
  const cur = DateTime.fromISO(`${date}T${start}`, { zone: timezone });
  let e = DateTime.fromISO(`${date}T${end}`, { zone: timezone });
  if (!cur.isValid || !e.isValid) {
    throw new UserError(`invalid date/window/timezone: ${date} ${JSON.stringify({ start, end })} ${timezone}`);
  }
  if (e <= cur) e = e.plus({ days: 1 }); // window crosses midnight
  return { start: cur, end: e };
}

/** Each date × window materializes to UTC individually, so DST is per-date arithmetic. */
export function materializeSlots(t: SpecificDates): Interval[] {
  const out: Interval[] = [];
  for (const date of t.dates) {
    let { start: cur, end } = localWindow(date, t.window.start, t.window.end, t.timezone);
    while (cur < end) {
      const nxt = cur.plus({ minutes: t.slotMinutes });
      if (nxt > end) break; // drop a trailing slot the window can't fully contain
      out.push({ start: cur.toUTC().toISO()!, end: nxt.toUTC().toISO()! });
      cur = nxt;
    }
  }
  return out;
}
