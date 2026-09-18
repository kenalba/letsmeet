import type { AwayEntry } from '../atproto/records.js';

/**
 * The dated page of the editor edits a day map, not the record's ranges: one entry per date
 * in the week on screen, either the whole day or a set of half-hour starts. `compactAway`
 * folds it back into the record's shape — consecutive dates that say exactly the same thing
 * become one range again — and leaves every date outside the edited week exactly as it was,
 * which is what lets a week's worth of painting split a range that straddles its edge.
 *
 * Half hours are wall-clock `HH:MM` starts, like the record's `startTime`/`endTime`. A
 * window ending at `00:00` is the end of the day: the grid's last row is the 11pm hour, so a
 * stroke there has no other end to name, and `localWindow` already reads it that way.
 *
 * Nothing here knows about timezones. These are calendar dates and wall-clock strings; the
 * island turns its slot keys into them before calling in.
 */
export type DayAway = 'all' | Set<string>;
export interface AwayDay { away: DayAway; note: string }
export type AwayDays = Map<string, AwayDay>;

/** ISO date + n days. Noon-anchored UTC arithmetic, so no zone can shift the day. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every date from `from` to `to` inclusive. Bounded to a year, as `freeIntervals` is. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 366; d = addDays(d, 1)) out.push(d);
  return out;
}

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
/** Minutes of the day back to `HH:MM`; 1440 — midnight, the end of the day — prints `00:00`. */
const toHm = (min: number): string =>
  `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * The half-hour starts one window covers. An end at or before the start runs to midnight:
 * an overnight window never reaches here, because sanitizeForeignRecord splits one into an
 * evening and a morning on read, so the cap is a defensive bound rather than a policy.
 */
function windowHalfHours(startTime: string, endTime: string): string[] {
  const s = toMin(startTime);
  const e0 = toMin(endTime);
  const e = e0 <= s ? 1440 : e0;
  const out: string[] = [];
  for (let m = s - (s % 30); m < e; m += 30) out.push(toHm(m));
  return out;
}

/** Runs of consecutive half hours as `[startTime, endTime]` pairs, in order. */
function runs(halfHours: Iterable<string>): Array<[string, string]> {
  const mins = [...new Set(halfHours)].map(toMin).sort((a, b) => a - b);
  const out: Array<[string, string]> = [];
  for (const m of mins) {
    const last = out[out.length - 1];
    if (last && toMin(last[1]) === m) last[1] = toHm(m + 30);
    else out.push([toHm(m), toHm(m + 30)]);
  }
  return out;
}

/** The record's away entries as a day map, for the dates in `[from, to]`. */
export function expandAway(entries: AwayEntry[], from: string, to: string): AwayDays {
  const days: AwayDays = new Map();
  for (const a of entries) {
    if (a.end < from || a.start > to) continue;
    // Half a window is not a window: a lone startTime or endTime is all day, as
    // freeIntervals and buildWeekView read it.
    const timed = !!(a.startTime && a.endTime);
    for (const date of dateRange(a.start > from ? a.start : from, a.end < to ? a.end : to)) {
      const cur = days.get(date);
      const note = cur?.note || a.note || '';
      if (!timed || cur?.away === 'all') { days.set(date, { away: 'all', note }); continue; }
      // The guard above leaves `cur.away` a set of half hours, if the date has anything.
      const set = new Set(cur?.away ?? []);
      for (const hm of windowHalfHours(a.startTime!, a.endTime!)) set.add(hm);
      days.set(date, { away: set, note });
    }
  }
  return days;
}

/** `a` clipped to `start`..`end`, keeping its window and its note. */
function clipped(a: AwayEntry, start: string, end: string): AwayEntry {
  const e: AwayEntry = { start, end };
  if (a.startTime && a.endTime) { e.startTime = a.startTime; e.endTime = a.endTime; }
  if (a.note) e.note = a.note;
  return e;
}

/** What survives of `a` outside `[from, to]`: itself, nothing, or one or two pieces. */
function outside(a: AwayEntry, from: string, to: string): AwayEntry[] {
  if (a.end < from || a.start > to) return [a];
  const out: AwayEntry[] = [];
  if (a.start < from) out.push(clipped(a, a.start, addDays(from, -1)));
  if (a.end > to) out.push(clipped(a, addDays(to, 1), a.end));
  return out;
}

/**
 * `entries` with their coverage of `[from, to]` replaced by `days`. Dates outside the window
 * are untouched, including the parts of a range that straddle its edge. Consecutive dates
 * with identical windows and note merge back into a range, each run of half hours becomes one
 * entry's window, and the result is sorted the way `normalizeAvailability` writes it — by
 * date, then by the window's start — so an edit that changes nothing produces an identical
 * record and the save path's no-op skip still holds.
 *
 * The result may contain the caller's own `AwayEntry` objects, for entries that lie wholly
 * outside `[from, to]` — treat it as read-only.
 */
export function compactAway(
  entries: AwayEntry[], from: string, to: string, days: AwayDays,
): AwayEntry[] {
  const out: AwayEntry[] = [];
  for (const a of entries) out.push(...outside(a, from, to));
  const dates = [...days.keys()].filter((d) => d >= from && d <= to).sort();
  const sig = (d: string): string => {
    const v = days.get(d)!;
    return `${v.away === 'all' ? 'all' : [...v.away].sort().join(',')} ${v.note}`;
  };
  for (let i = 0; i < dates.length;) {
    let j = i;
    while (j + 1 < dates.length
      && dates[j + 1] === addDays(dates[j], 1)
      && sig(dates[j + 1]) === sig(dates[i])) j++;
    const v = days.get(dates[i])!;
    const entry = (window?: [string, string]): AwayEntry => {
      const e: AwayEntry = { start: dates[i], end: dates[j] };
      if (window) { e.startTime = window[0]; e.endTime = window[1]; }
      if (v.note) e.note = v.note;
      return e;
    };
    if (v.away === 'all') out.push(entry());
    else for (const window of runs(v.away)) out.push(entry(window));
    i = j + 1;
  }
  return out.sort((x, y) =>
    x.start.localeCompare(y.start) || (x.startTime ?? '').localeCompare(y.startTime ?? ''));
}

/** A day header tap: all day off — or, for a day that has any away at all, clear it. */
export function toggleAllDay(days: AwayDays, date: string, note = ''): AwayDays {
  const next = new Map(days);
  if (next.has(date)) next.delete(date);
  else next.set(date, { away: 'all', note });
  return next;
}

/** Paint (or clear) `halfHours` on each of `dates`. An all-day date is locked and skipped. */
export function paintAway(
  days: AwayDays, dates: string[], halfHours: string[], on: boolean,
): AwayDays {
  const next = new Map(days);
  for (const date of dates) {
    const cur = next.get(date);
    if (cur?.away === 'all') continue;
    const set = new Set(cur?.away ?? []);
    for (const hm of halfHours) {
      if (on) set.add(hm);
      else set.delete(hm);
    }
    if (set.size) next.set(date, { away: set, note: cur?.note ?? '' });
    else next.delete(date);
  }
  return next;
}

/**
 * `entries` without the ones already over. The editor's away list starts at today, so an
 * entry in the past can never be removed by hand — a post drops it instead, which is what
 * keeps a long-lived record under the lexicon's cap on how many away entries it may hold.
 * Pruning belongs to a post: nothing here runs on its own, so an editor left open never
 * quietly rewrites the record under the viewer. `today` is an ISO date in the record's zone.
 */
export function pruneAway(entries: AwayEntry[], today: string): AwayEntry[] {
  return entries.filter((a) => a.end >= today);
}
