import { DateTime } from 'luxon';
import type { Interval } from './intervals.js';

export interface SpecificDates {
  dates: string[];                     // ISO dates, explicit list, non-contiguous OK
  window: { start: string; end: string }; // "HH:MM" in `timezone`
  slotMinutes: 15 | 30 | 60;
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
      out.push({ start: cur.toUTC().toISO()!, end: nxt.toUTC().toISO()! });
      cur = nxt;
    }
  }
  return out;
}
