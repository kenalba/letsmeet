import { DateTime } from 'luxon';
import type { AwayEntry, WeeklyBlock } from '../atproto/records.js';
import { UserError } from './errors.js';
import { mergeIntervals, normalizeIso, snapToSlots, type Interval } from './intervals.js';
import { isValidSezName, normalizeSezName } from './sezName.js';
import { localWindow, materializeSlots } from './slots.js';

export interface AvailabilityInput {
  timezone: string;
  weekly: WeeklyBlock[];
  away: AwayEntry[];
  note?: string;
  validUntil?: string;
  alias?: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** "19:10" -> 1150 minutes, snapped down to the half hour when `snap`; throws otherwise. */
function toMinutes(t: unknown, what: string, snap: boolean): number {
  if (typeof t !== 'string' || !HHMM.test(t)) throw new UserError(`${what} must be a time like 19:30`);
  const [h, m] = t.split(':').map(Number);
  const total = h * 60 + m;
  if (total % 30 === 0) return total;
  if (!snap) throw new UserError(`${what} must land on the half hour`);
  return total - (total % 30);
}
const fromMinutes = (n: number): string => {
  const m = ((n % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/** A zone luxon can do wall-clock arithmetic in. The lexicon only checks it is ≤64 chars. */
export function isKnownZone(tz: unknown): tz is string {
  return typeof tz === 'string' && DateTime.now().setZone(tz).isValid;
}

function checkZone(tz: unknown): string {
  if (!isKnownZone(tz)) throw new UserError('that timezone is not one this app knows');
  return tz;
}

function checkDate(d: unknown, tz: string, what: string): string {
  if (typeof d !== 'string' || !YMD.test(d) || !DateTime.fromISO(d, { zone: tz }).isValid) {
    throw new UserError(`${what} must be a date like 2026-09-19`);
  }
  return d;
}

function cleanText(v: unknown, what: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new UserError(`${what} must be text`);
  const t = v.trim();
  if (!t) return undefined;
  if ([...t].length > max) throw new UserError(`${what} is too long (max ${max} characters)`);
  return t;
}

/**
 * Turn what the editor posted into the canonical shape: half-hour edges, blocks on the same
 * day merged where they touch, everything sorted. Identical availability yields an identical
 * object, which is what lets the save path skip a no-op write.
 */
export function normalizeAvailability(input: unknown): AvailabilityInput {
  if (typeof input !== 'object' || input === null) throw new UserError('malformed availability');
  const raw = input as Record<string, unknown>;
  const timezone = checkZone(raw.timezone);
  if (!Array.isArray(raw.weekly) || !Array.isArray(raw.away)) {
    throw new UserError('weekly and away must be lists');
  }

  // Blocks become [start, end) minute ranges on a 0..1440 axis; a past-midnight block
  // (end <= start) runs to 1440 and is never merged with anything after it.
  const byDay = new Map<number, Array<[number, number]>>();
  for (const b of raw.weekly as Array<Record<string, unknown>>) {
    const day = Number(b?.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new UserError('a block has a weekday outside 0..6');
    const s = toMinutes(b.start, 'a block start', true);
    let e = toMinutes(b.end, 'a block end', true);
    if (e === s) throw new UserError('a block cannot start and end at the same time');
    if (e <= s) e = 1440; // past midnight: the block runs to the end of the day
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push([s, e]);
  }
  const weekly: WeeklyBlock[] = [];
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const ranges = byDay.get(day)!.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    for (const [s, e] of merged) weekly.push({ day, start: fromMinutes(s), end: fromMinutes(e) });
  }
  if (weekly.length > 112) throw new UserError('too many blocks');

  const away: AwayEntry[] = [];
  for (const a of raw.away as Array<Record<string, unknown>>) {
    const start = checkDate(a?.start, timezone, 'an away start');
    const end = checkDate(a?.end, timezone, 'an away end');
    if (end < start) throw new UserError(`an away range ends before it starts (${start} to ${end})`);
    const entry: AwayEntry = { start, end };
    const hasStart = a.startTime !== undefined && a.startTime !== null && a.startTime !== '';
    const hasEnd = a.endTime !== undefined && a.endTime !== null && a.endTime !== '';
    if (hasStart !== hasEnd) throw new UserError('an away window needs both a start and an end time');
    if (hasStart) {
      const s = toMinutes(a.startTime, 'an away window start', false);
      let e = toMinutes(a.endTime, 'an away window end', false);
      // Midnight is the one end that may sort before its start: it means the end of the day,
      // which is how localWindow, freeIntervals and buildWeekView already read it. The
      // editor's last row is the 11pm hour, so a stroke there has no other end to name.
      if (e === 0) e = 1440;
      if (e <= s) throw new UserError('an away window must end after it starts');
      entry.startTime = fromMinutes(s);
      entry.endTime = fromMinutes(e);
    }
    const note = cleanText(a.note, 'an away note', 80);
    if (note) entry.note = note;
    away.push(entry);
  }
  away.sort((x, y) => x.start.localeCompare(y.start) || (x.startTime ?? '').localeCompare(y.startTime ?? ''));
  if (away.length > 100) throw new UserError('too many away entries');

  const out: AvailabilityInput = { timezone, weekly, away };
  const note = cleanText(raw.note, 'the note', 300);
  if (note) out.note = note;
  if (raw.validUntil) {
    try {
      out.validUntil = normalizeIso(String(raw.validUntil));
    } catch {
      throw new UserError('"good through" must be a date');
    }
  }
  const alias = normalizeSezName(raw.alias);
  if (alias) out.alias = alias;
  return out;
}

/**
 * A record read back from a repo, cut down to what this app can actually read.
 *
 * Only the lexicon has vetted it, and the lexicon checks lengths, not shapes: `"7am"`,
 * `"25:00"` and `"next week"` are all valid values, and each of them either throws
 * (`localWindow`, `toLocaleDateString`) or prints as `NaNam` further down. Any client can
 * write the record — including to your own repo — so every read goes through here once, at
 * the boundary, and the page, the sentence, the feed and the prefill all inherit one clean
 * record. The unreadable blocks and away entries are dropped; a lone `startTime` or
 * `endTime` degrades to all day, which is how the rest of the app reads it anyway. An
 * unusable `timezone` is the one thing that cannot be dropped — callers check
 * `isKnownZone` and say they cannot read the record.
 */
/** ISO date + one day, for splitting an away window that rolls past midnight. */
const nextDate = (d: string): string =>
  DateTime.fromISO(d, { zone: 'utc' }).plus({ days: 1 }).toISODate()!;

export function sanitizeForeignRecord<T extends AvailabilityInput>(rec: T): T {
  const weekly = rec.weekly.filter((b) =>
    Number.isInteger(b.day) && b.day >= 0 && b.day <= 6 && HHMM.test(b.start) && HHMM.test(b.end));
  const away: AwayEntry[] = [];
  for (const a of rec.away) {
    if (!YMD.test(a.start) || !YMD.test(a.end) || a.end < a.start) continue;
    const timed = a.startTime !== undefined && a.endTime !== undefined
      && HHMM.test(a.startTime) && HHMM.test(a.endTime);
    if (timed) {
      // An end that sorts before its start rolls past midnight. Midnight itself is the end
      // of the day, which every reader here already handles; anything earlier is a window
      // this app's own writer cannot produce, and the day map would drop its small-hours
      // half on write-back. Split it at the boundary instead: the evening, then the morning
      // after.
      if (a.endTime! < a.startTime! && a.endTime !== '00:00') {
        const note = a.note !== undefined ? { note: a.note } : {};
        away.push({ start: a.start, end: a.end, startTime: a.startTime!, endTime: '00:00', ...note });
        away.push({
          start: nextDate(a.start), end: nextDate(a.end),
          startTime: '00:00', endTime: a.endTime!, ...note,
        });
        continue;
      }
      away.push(a);
      continue;
    }
    const { startTime: _s, endTime: _e, ...allDay } = a;
    away.push(allDay);
  }
  // Sorted the way normalizeAvailability writes it, so a split entry lands in its place.
  away.sort((x, y) => x.start.localeCompare(y.start) || (x.startTime ?? '').localeCompare(y.startTime ?? ''));
  const out = { ...rec, weekly, away };
  // The lexicon caps its length and nothing else; a name this app cannot route is no name.
  if (out.alias !== undefined && !isValidSezName(out.alias)) delete out.alias;
  return out;
}

/**
 * The instant a "good through <date>" runs out: the last millisecond of that local date in
 * `tz`, as a UTC ISO. The date is what the editor asks for and what a reader is shown; the
 * record stores the instant, and midnight UTC would expire an American record at seven the
 * evening before.
 */
export function endOfLocalDay(date: string, tz: string): string {
  return DateTime.fromISO(date, { zone: isKnownZone(tz) ? tz : 'utc' })
    .endOf('day').toUTC().toISO()!;
}

/** The inverse: the local date `iso` falls on in `tz`, for the editor field and the page. */
export function localDateOf(iso: string, tz: string): string {
  const d = DateTime.fromISO(iso, { zone: isKnownZone(tz) ? tz : 'utc' });
  return d.isValid ? d.toISODate()! : iso.slice(0, 10);
}

export function isStale(rec: { validUntil?: string }, now: Date): boolean {
  return !!rec.validUntil && new Date(rec.validUntil).getTime() < now.getTime();
}

// ---- The sentence -----------------------------------------------------------------

const DAY_NAMES = ['sundays', 'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays'];

function fmtClock(t: string): string {
  const [h, m] = t.split(':').map(Number);
  if (h === 0 && m === 0) return 'midnight';
  const period = h >= 12 ? 'pm' : 'am';
  const hour = ((h + 11) % 12) + 1;
  return m ? `${hour}:${String(m).padStart(2, '0')}${period}` : `${hour}${period}`;
}

/** Day names within one clause: "tuesdays and thursdays" — no comma at exactly two. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** Top-level clauses in the sentence: always a serial comma, even at exactly two. */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function nameDays(days: number[]): string {
  const key = [...days].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'weekdays';
  if (key === '0,6') return 'weekends';
  if (key === '0,1,2,3,4,5,6') return 'every day';
  const names = [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
  return names.length === 2 ? `${names[0]} and ${names[1]}` : joinList(names);
}

/** "usually free tuesdays and thursdays 7pm to 10pm, and weekends 1pm to 5pm." */
export function describeWeekly(weekly: WeeklyBlock[]): string {
  if (weekly.length === 0) return 'nothing marked yet.';
  const byRange = new Map<string, number[]>();
  for (const b of weekly) {
    const k = `${b.start}|${b.end}`;
    if (!byRange.has(k)) byRange.set(k, []);
    byRange.get(k)!.push(b.day);
  }
  // Clauses read Monday-first regardless of input order: day 0 (Sunday) sorts as if it
  // were 7, so a Sunday-inclusive group (e.g. "weekends") lands after a Monday..Saturday
  // group it shares no days with, matching how people say their week out loud.
  const mondayFirst = (days: number[]) => Math.min(...days.map((d) => (d === 0 ? 7 : d)));
  const parts = [...byRange.entries()]
    .sort((a, b) => mondayFirst(a[1]) - mondayFirst(b[1]))
    .map(([k, days]) => {
      const [s, e] = k.split('|');
      return `${nameDays(days)} ${fmtClock(s)} to ${fmtClock(e)}`;
    });
  return `usually free ${joinClauses(parts)}.`;
}

// ---- Template week: lets the editor reuse the poll grid model ---------------------

/** A Monday. The editor grid is these seven dates; only the weekday of each matters. */
export const TEMPLATE_MONDAY = '2026-01-05';
export const TEMPLATE_START = '07:00';

/**
 * The template week, Monday first — the order every grid in this app runs its columns in
 * (`mondayOf`, `buildWeekView`), so a column keeps its identity when the editor pages from
 * the usual week into a real one.
 */
export function templateDates(): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    DateTime.fromISO(TEMPLATE_MONDAY).plus({ days: i }).toISODate()!);
}

/** The template date whose weekday is `day` (0 = Sunday, as the record counts weekdays). */
export function templateDateFor(day: number): string {
  return templateDates()[(day + 6) % 7];
}

/** 7 × 34 half-hour UTC slots in `timezone`, in the poll grid's Interval shape. */
export function templateSlots(timezone: string): Interval[] {
  return materializeSlots({
    dates: templateDates(), window: { start: TEMPLATE_START, end: '00:00' },
    slotMinutes: 30, timezone,
  });
}

/**
 * Every weekly block on each of `dates`, as UTC intervals: a block lands on a date when the
 * date's own weekday is the block's. The template week is seven dates like any other, so the
 * editor's usual page and its dated pages both come from here — and reading the weekday off
 * the date, rather than indexing the list by it, is what makes the two one function. Local
 * wall clock in, UTC out, DST and past-midnight ends handled per date by `localRange`.
 */
export function weeklyOverDates(
  weekly: WeeklyBlock[], dates: string[], timezone: string,
): Interval[] {
  const ivs: Interval[] = [];
  for (const date of dates) {
    const weekday = DateTime.fromISO(date, { zone: timezone }).weekday % 7; // luxon: 7 = Sunday
    for (const b of weekly) {
      if (b.day !== weekday) continue;
      ivs.push(localRange(date, b.start, b.end, timezone)); // rolls a past-midnight end itself
    }
  }
  return ivs.length ? mergeIntervals(ivs) : [];
}

export function weeklyToTemplateIntervals(weekly: WeeklyBlock[], timezone: string): Interval[] {
  return weeklyOverDates(weekly, templateDates(), timezone);
}

/**
 * `weekly` cut at the grid's first row. The editor can only show what falls in the template
 * window, and it rebuilds the marked half from the grid on every stroke — so the early part,
 * which no cell stands for, has to be carried through untouched or a record written by another
 * client would lose its small-hours blocks the moment anyone marked anything. A block that
 * straddles `TEMPLATE_START` is split, so unmarking its visible half still works and the
 * sliver survives; `normalizeAvailability` merges the two back together on the way out.
 */
export function splitAtTemplateStart(
  weekly: WeeklyBlock[],
): { onGrid: WeeklyBlock[]; offGrid: WeeklyBlock[] } {
  const first = toMinutes(TEMPLATE_START, 'the template start', false);
  const onGrid: WeeklyBlock[] = [];
  const offGrid: WeeklyBlock[] = [];
  for (const b of weekly) {
    const s = toMinutes(b.start, 'a block start', false);
    const e0 = toMinutes(b.end, 'a block end', false);
    // As normalizeAvailability writes them, an end at or before the start means end of day.
    const e = e0 <= s ? 1440 : e0;
    if (s >= first) onGrid.push(b);
    else if (e <= first) offGrid.push(b);
    else {
      offGrid.push({ day: b.day, start: b.start, end: TEMPLATE_START });
      onGrid.push({ day: b.day, start: TEMPLATE_START, end: b.end });
    }
  }
  return { onGrid, offGrid };
}

export function templateIntervalsToWeekly(ivs: Interval[], timezone: string): WeeklyBlock[] {
  const out: WeeklyBlock[] = [];
  for (const iv of ivs) {
    const s = DateTime.fromISO(iv.start, { zone: 'utc' }).setZone(timezone);
    const e = DateTime.fromISO(iv.end, { zone: 'utc' }).setZone(timezone);
    out.push({ day: s.weekday % 7, start: s.toFormat('HH:mm'), end: e.toFormat('HH:mm') });
  }
  return normalizeAvailability({ timezone, weekly: out, away: [] }).weekly;
}

// ---- Materializing the record over real dates ---------------------------------------

/** Every local date from `from` to `to` inclusive, as ISO dates. Bounded to a year. */
function eachDate(from: string, to: string, tz: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(from, { zone: tz });
  const end = DateTime.fromISO(to, { zone: tz });
  while (d <= end && out.length < 366) { out.push(d.toISODate()!); d = d.plus({ days: 1 }); }
  return out;
}

/**
 * [start, end) on local `date` in `tz`, in UTC. A past-midnight end rolls to the next day.
 * Thin wrapper around `localWindow` (`./slots.js`), which does the same wall-clock
 * arithmetic for `materializeSlots`.
 */
function localRange(date: string, start: string, end: string, tz: string): Interval {
  const w = localWindow(date, start, end, tz);
  return { start: w.start.toUTC().toISO()!, end: w.end.toUTC().toISO()! };
}

/** `ivs` minus `cut`, both merged and sorted. Pure interval arithmetic on ISO strings. */
function subtract(ivs: Interval[], cut: Interval[]): Interval[] {
  let out = ivs;
  for (const c of cut) {
    const next: Interval[] = [];
    for (const iv of out) {
      if (c.end <= iv.start || c.start >= iv.end) { next.push(iv); continue; }
      if (c.start > iv.start) next.push({ start: iv.start, end: c.start });
      if (c.end < iv.end) next.push({ start: c.end, end: iv.end });
    }
    out = next;
  }
  return out;
}

/**
 * The record, read over real dates: each weekly block on each matching date, minus every
 * away entry that touches those dates. Local wall-clock in, UTC intervals out, DST handled
 * per date by luxon exactly as `materializeSlots` does for polls.
 */
export function freeIntervals(rec: AvailabilityInput, from: string, to: string): Interval[] {
  const tz = rec.timezone;
  const dates = eachDate(from, to, tz);
  const free: Interval[] = [];
  for (const date of dates) {
    const weekday = DateTime.fromISO(date, { zone: tz }).weekday % 7; // luxon: 7 = Sunday
    for (const b of rec.weekly) if (b.day === weekday) free.push(localRange(date, b.start, b.end, tz));
  }
  if (free.length === 0) return [];
  const cuts: Interval[] = [];
  for (const a of rec.away) {
    for (const date of dates) {
      if (date < a.start || date > a.end) continue;
      // normalizeAvailability enforces the pairing, but a record can arrive from another
      // client that only validated against the lexicon, which allows either alone — treat
      // a lone start or end as all-day rather than throwing on the read path.
      cuts.push(a.startTime && a.endTime
        ? localRange(date, a.startTime, a.endTime, tz)
        : localRange(date, '00:00', '00:00', tz)); // whole local day
    }
  }
  const merged = mergeIntervals(free);
  return cuts.length ? subtract(merged, mergeIntervals(cuts)) : merged;
}

/**
 * The poll slots this record says the viewer can make. `null` means "don't know" (the
 * record has expired), which the caller must treat differently from "none".
 */
export function prefillFromAvailability(
  rec: AvailabilityInput, slots: Interval[], now: Date,
): Interval[] | null {
  // Nothing in the record can be placed on a clock this app cannot read: that is "don't
  // know", not "free nowhere".
  if (!isKnownZone(rec.timezone) || isStale(rec, now)) return null;
  if (slots.length === 0 || rec.weekly.length === 0) return [];
  // A day of slack either side: a poll slot near midnight in the poll's zone can fall on
  // the neighbouring local date in the record's zone.
  const first = DateTime.fromISO(slots[0].start, { zone: 'utc' }).setZone(rec.timezone).minus({ days: 1 });
  const last = DateTime.fromISO(slots[slots.length - 1].end, { zone: 'utc' }).setZone(rec.timezone).plus({ days: 1 });
  const free = freeIntervals(rec, first.toISODate()!, last.toISODate()!);
  return free.length ? snapToSlots(free, slots) : [];
}
