import { DateTime } from 'luxon';
import type { AwayEntry, WeeklyBlock } from '../atproto/records.js';
import { UserError } from './errors.js';
import { mergeIntervals, normalizeIso, snapToSlots, type Interval } from './intervals.js';
import { localWindow, materializeSlots } from './slots.js';

export interface AvailabilityInput {
  timezone: string;
  weekly: WeeklyBlock[];
  away: AwayEntry[];
  note?: string;
  validUntil?: string;
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

function checkZone(tz: unknown): string {
  if (typeof tz !== 'string' || !DateTime.now().setZone(tz).isValid) {
    throw new UserError('that timezone is not one this app knows');
  }
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
      const e = toMinutes(a.endTime, 'an away window end', false);
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
  return out;
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

/** A Sunday. The editor grid is these seven dates; only the weekday of each matters. */
export const TEMPLATE_SUNDAY = '2026-01-04';
export const TEMPLATE_START = '07:00';
export const TEMPLATE_END = '24:00';

function templateDates(): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    DateTime.fromISO(TEMPLATE_SUNDAY).plus({ days: i }).toISODate()!);
}

/** 7 × 34 half-hour UTC slots in `timezone`, in the poll grid's Interval shape. */
export function templateSlots(timezone: string): Interval[] {
  return materializeSlots({
    dates: templateDates(), window: { start: TEMPLATE_START, end: '00:00' },
    slotMinutes: 30, timezone,
  });
}

export function weeklyToTemplateIntervals(weekly: WeeklyBlock[], timezone: string): Interval[] {
  const dates = templateDates();
  const ivs = weekly.map((b) => {
    const start = DateTime.fromISO(`${dates[b.day]}T${b.start}`, { zone: timezone });
    let end = DateTime.fromISO(`${dates[b.day]}T${b.end}`, { zone: timezone });
    if (end <= start) end = end.plus({ days: 1 });
    return { start: start.toUTC().toISO()!, end: end.toUTC().toISO()! };
  });
  return ivs.length ? mergeIntervals(ivs) : [];
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
      cuts.push(a.startTime
        // endTime is always present when startTime is: normalizeAvailability enforces the pairing.
        ? localRange(date, a.startTime, a.endTime!, tz)
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
  if (isStale(rec, now)) return null;
  if (slots.length === 0 || rec.weekly.length === 0) return [];
  // A day of slack either side: a poll slot near midnight in the poll's zone can fall on
  // the neighbouring local date in the record's zone.
  const first = DateTime.fromISO(slots[0].start, { zone: 'utc' }).setZone(rec.timezone).minus({ days: 1 });
  const last = DateTime.fromISO(slots[slots.length - 1].end, { zone: 'utc' }).setZone(rec.timezone).plus({ days: 1 });
  const free = freeIntervals(rec, first.toISODate()!, last.toISODate()!);
  return free.length ? snapToSlots(free, slots) : [];
}
