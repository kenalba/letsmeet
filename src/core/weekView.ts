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
  /** Today's date in the record's zone — what `past`/`today` on each day are measured from. */
  today: string;
  title: string;     // 'sep 14 – 20'
  days: WeekDay[];
  hasAway: boolean;  // any away cell in this week: the legend is shown
  /** Away entries that start after next week's Sunday, soonest first. */
  later: AwayEntry[];
}

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const iso = (date: string) => DateTime.fromISO(date, { locale: 'en-US' });
/** ISO date + n days. Exported: the editor's pager and picker do the same arithmetic. */
export function plusDays(date: string, n: number): string {
  return iso(date).plus({ days: n }).toISODate()!;
}

/** How many whole weeks `date`'s Monday is from `thisMonday`; negative for a week already over. */
export function weekOffsetOf(date: string, thisMonday: string): number {
  return Math.round(iso(mondayOf(date)).diff(iso(thisMonday), 'days').days / 7);
}

/**
 * The shortest zone that carries a note label: under three rows there is no room for one,
 * and a clipped single character reads as a smudge. Both grids use it.
 */
export const MIN_LABEL_ROWS = 3;

/** 'sep 17'. Lowercase, like the rest of the grid chrome. */
export function monthDayLabel(date: string): string {
  return iso(date).toFormat('LLL d').toLowerCase();
}

/** 'september 2026', for the week picker's month header. Lowercase, like every other label. */
export function monthTitle(first: string): string {
  return iso(first).toFormat('LLLL yyyy').toLowerCase();
}

/** The day of the month: what a dated column's header and the picker's cells print. */
export function domOf(date: string): number {
  return iso(date).day;
}

/**
 * A first-of-month ISO date, n months along — the week picker's month arrows. It lands on
 * the first rather than keeping the day, so no caller can fall through a short month (jan
 * 31 plus a month is february, not march).
 */
export function addMonths(first: string, n: number): string {
  return iso(first).set({ day: 1 }).plus({ months: n }).toISODate()!;
}
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
  if (start === end) return monthDayLabel(start);
  const a = iso(start);
  const b = iso(end);
  return a.year === b.year && a.month === b.month
    ? `${monthDayLabel(start)} – ${b.day}`
    : `${monthDayLabel(start)} – ${monthDayLabel(end)}`;
}
export function weekTitle(monday: string, sunday: string): string {
  return dateRangeLabel(monday, sunday);
}
/** `12am`, `7am`, `12pm`, `11pm`. The one hour label in the app: the editor's rows use it too. */
export function hourLabel(h: number): string {
  return h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`;
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
      .map((a) => {
        const s = minutes(a.startTime!);
        const e = minutes(a.endTime!);
        // As localWindow reads it: an end at or before the start rolls past midnight, so the
        // window covers the rest of the day here. Equal times cut the whole rest of the day.
        return { s, e: e <= s ? 1440 : e, note: a.note };
      });
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
      date, dow: DOW[weekday], dom: domOf(date),
      past: date < today, today: date === today,
      awayAllDay: allDay ? (allDay.note ?? '') : null,
      cells,
    });
  }
  return {
    monday, sunday, today, title: weekTitle(monday, sunday), days, hasAway,
    // Relative to today's week whichever week is shown: next week's Sunday is day 13.
    later: awayLater(rec.away, plusDays(thisMonday, 13)),
  };
}

export interface NoteZone {
  /** Column indexes into the week's days, inclusive. */
  c0: number; c1: number;
  /** Wall-clock hours, inclusive, clipped to HOURS. */
  h0: number; h1: number;
  note: string;
  /** The whole rectangle is behind today: the label dims with the cells. */
  past: boolean;
}

/**
 * One rectangle per noted away entry in the shown week — the block the entry's own note is
 * drawn inside, on the friend view and in the editor both. Entries with nothing to say are
 * skipped, an all-day entry fills every row, and a range is clipped to the week's columns,
 * so a range that straddles an edge labels the part on screen. Hours only; no pixels, and
 * no zones: this is the same wall-clock arithmetic `buildWeekView` does.
 */
export function weekNoteZones(
  rec: AvailabilityInput, week: { monday: string; today: string },
): NoteZone[] {
  const dates = Array.from({ length: 7 }, (_, i) => plusDays(week.monday, i));
  const first = HOURS[0];
  const last = HOURS[HOURS.length - 1];
  const out: NoteZone[] = [];
  for (const a of rec.away) {
    if (!a.note || a.end < dates[0] || a.start > dates[6]) continue;
    let c0 = 0;
    while (dates[c0] < a.start) c0++;
    let c1 = 6;
    while (dates[c1] > a.end) c1--;
    // Half a window is not a window: a lone startTime or endTime is all day, as
    // freeIntervals reads it. An end at or before the start runs to midnight.
    const timed = !!(a.startTime && a.endTime);
    const s = timed ? minutes(a.startTime!) : first * 60;
    const e0 = timed ? minutes(a.endTime!) : (last + 1) * 60;
    const e = timed && e0 <= s ? 1440 : e0;
    const h0 = Math.max(first, Math.floor(s / 60));
    const h1 = Math.min(last, Math.ceil(e / 60) - 1);
    if (h1 < h0) continue; // wholly before 7am or after 11pm: no cell stands for it
    out.push({ c0, c1, h0, h1, note: a.note, past: dates[c1] < week.today });
  }
  return out;
}

/** A zone tall enough to carry its note: under `MIN_LABEL_ROWS` rows there is no room. */
export const isLabelable = (z: NoteZone) => z.h1 - z.h0 + 1 >= MIN_LABEL_ROWS;

/**
 * The zones a page actually draws a label in: labelable, biggest first. Away entries may
 * overlap — an all-day "vacation" across the weekend with a "wedding" at 2pm on the Saturday
 * — and both grids paint in order, so the smaller one has to come last to end up on top of
 * the one it sits inside. Area, then the top row, then the left column: ties are broken so
 * the order is the same on every render.
 */
export function labelZones(
  rec: AvailabilityInput, week: { monday: string; today: string },
): NoteZone[] {
  const area = (z: NoteZone) => (z.h1 - z.h0 + 1) * (z.c1 - z.c0 + 1);
  return weekNoteZones(rec, week).filter(isLabelable)
    .sort((a, b) => area(b) - area(a) || a.h0 - b.h0 || a.c0 - b.c0);
}
