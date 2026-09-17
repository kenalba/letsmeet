import { DateTime } from 'luxon';
import type { AwayEntry } from '../atproto/records.js';
import type { AvailabilityInput } from './availability.js';

/**
 * The friend view's week: seven days across, the hours 7am through 11pm down, one cell
 * per hour. Everything here is wall-clock arithmetic in the record's own zone — the grid
 * draws wall-clock time, so a DST shift moves no cell — and only "what date is today" and
 * "what weekday is this date" ask luxon.
 */

/** The rows: 7am through 11pm. A block past midnight fills the last row and stops. */
export const HOURS: readonly number[] = Array.from({ length: 17 }, (_, i) => 7 + i);

/** Which week the page shows: `?week=next`, `?week=later` (the poll prompt), else this one. */
export type WeekChoice = 'this' | 'next' | 'later';
export function weekChoice(q: string | undefined): WeekChoice {
  return q === 'next' || q === 'later' ? q : 'this';
}

/** `early`: free the first half hour only; `late`: the second. Away wins over free. */
export type CellState = 'none' | 'free' | 'early' | 'late' | 'away';
export interface WeekCell { state: CellState; note?: string }
export interface WeekDay {
  date: string;   // YYYY-MM-DD
  dow: string;    // 'mon' … 'sun'
  dom: number;    // day of month
  past: boolean;
  today: boolean;
  /** An all-day away entry covers this date: its note, '' with none. `null` otherwise. */
  awayAllDay: string | null;
  cells: WeekCell[]; // one per HOURS entry
}
export interface WeekView {
  monday: string;
  sunday: string;
  title: string;     // 'sep 14 – 20'
  days: WeekDay[];
  hasAway: boolean;  // any away cell in this week: the legend is shown
  /** Away entries that start after next week's Sunday, soonest first. */
  later: AwayEntry[];
}

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const iso = (date: string) => DateTime.fromISO(date, { locale: 'en-US' });
const plusDays = (date: string, n: number) => iso(date).plus({ days: n }).toISODate()!;
const monthDay = (date: string) => iso(date).toFormat('LLL d').toLowerCase();
const minutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Today's date where the record's clocks are. */
export function localToday(now: Date, tz: string): string {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}

/** The Monday of the week `date` falls in (luxon: Monday is weekday 1, Sunday 7). */
export function mondayOf(date: string): string {
  const d = iso(date);
  return d.minus({ days: d.weekday - 1 }).toISODate()!;
}

/** 'oct 3 – 5', 'oct 30 – nov 2', 'oct 20'. Lowercase, like the rest of the grid chrome. */
export function dateRangeLabel(start: string, end: string): string {
  if (start === end) return monthDay(start);
  const a = iso(start);
  const b = iso(end);
  return a.year === b.year && a.month === b.month
    ? `${monthDay(start)} – ${b.day}`
    : `${monthDay(start)} – ${monthDay(end)}`;
}
export function weekTitle(monday: string, sunday: string): string {
  return dateRangeLabel(monday, sunday);
}
export function hourLabel(h: number): string {
  return h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** Entries starting after `afterSunday`, soonest first. Ones already over never qualify. */
export function awayLater(away: AwayEntry[], afterSunday: string): AwayEntry[] {
  return away.filter((a) => a.start > afterSunday).sort((x, y) => x.start.localeCompare(y.start));
}

export function buildWeekView(rec: AvailabilityInput, now: Date, offset: 0 | 1): WeekView {
  const today = localToday(now, rec.timezone);
  const thisMonday = mondayOf(today);
  const monday = plusDays(thisMonday, 7 * offset);
  const sunday = plusDays(monday, 6);
  const days: WeekDay[] = [];
  let hasAway = false;
  for (let i = 0; i < 7; i++) {
    const date = plusDays(monday, i);
    const weekday = iso(date).weekday % 7; // 0 = Sunday, as the record counts
    // [start, end) in minutes of the day; as normalizeAvailability writes them, an end at
    // or before the start means the block runs to midnight.
    const blocks = rec.weekly
      .filter((b) => b.day === weekday)
      .map((b) => { const s = minutes(b.start); const e = minutes(b.end); return [s, e <= s ? 1440 : e] as const; });
    const covering = rec.away.filter((a) => a.start <= date && date <= a.end);
    // Half a window is not a window: a lone startTime or endTime is all day, as
    // freeIntervals reads it.
    const allDay = covering.find((a) => !(a.startTime && a.endTime));
    const timed = covering
      .filter((a) => a.startTime && a.endTime)
      .map((a) => ({ s: minutes(a.startTime!), e: minutes(a.endTime!), note: a.note }));
    const covers = (from: number, to: number) => blocks.some(([s, e]) => s <= from && e >= to);
    const away = (note: string | undefined): WeekCell => (note ? { state: 'away', note } : { state: 'away' });
    const cells: WeekCell[] = HOURS.map((h) => {
      const from = h * 60;
      if (allDay) return away(allDay.note);
      const hit = timed.find((t) => t.s < from + 60 && t.e > from);
      if (hit) return away(hit.note);
      const first = covers(from, from + 30);
      const second = covers(from + 30, from + 60);
      return { state: first && second ? 'free' : first ? 'early' : second ? 'late' : 'none' };
    });
    if (cells.some((c) => c.state === 'away')) hasAway = true;
    days.push({
      date, dow: DOW[weekday], dom: iso(date).day,
      past: date < today, today: date === today,
      awayAllDay: allDay ? (allDay.note ?? '') : null,
      cells,
    });
  }
  return {
    monday, sunday, title: weekTitle(monday, sunday), days, hasAway,
    // Relative to today's week whichever week is shown: next week's Sunday is day 13.
    later: awayLater(rec.away, plusDays(thisMonday, 13)),
  };
}
