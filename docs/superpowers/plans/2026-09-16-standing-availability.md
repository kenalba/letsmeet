# Standing Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `lol.letsmeet.availability`: one record per account that marks a usual week plus dated away entries, edited on a grid at `/availability`, read publicly at `/u/<handle>` and `/u/<handle>/availability.ics`, and used to pre-mark a signed-in viewer's answer when they open a poll.

**Architecture:** Same shape as the poll feature. Pure logic in `src/core/availability.ts` (normalize, materialize, prefill, sentence) and `src/core/ics.ts`; record build/validate in `src/atproto/records.ts`; a `src/services/availability.ts` layer over `RepoReader`/`RepoWriter` with a disposable `availability_cache` table; Hono routes in `src/web/routes/availability.ts`; a React island `src/web/islands/availability.tsx` that reuses `gridModel` over a synthetic template week. The record in the user's PDS is the truth.

**Tech Stack:** Node ≥22, TypeScript strict ESM, Hono, better-sqlite3, luxon, `@atproto/lexicon`, React 19 islands bundled with esbuild, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-standing-availability-design.md`

## Global Constraints

- NSID is the constant `lol.letsmeet.availability`, rkey `self`. Never a second record per DID.
- `HH:MM` strings, `maxLength: 5`; IANA timezone `maxLength: 64`; text fields carry both `maxGraphemes` and `maxLength` (note ≤300/1200, away note ≤80/320). `weekly` ≤112 items, `away` ≤100.
- Half-hour alignment, merging and sorting are app rules enforced in `normalizeAvailability`; an unchanged record is never re-written (compare ignoring `updatedAt`).
- Away entries subtract only. There is no "free" kind and no `ifNeedBe` anywhere in this feature.
- User-facing copy is lowercase and says **mark**, never paint. The touch hint is verbatim: `tap a slot to mark it. hold, then drag, for a block. swipe to scroll.`
- An expired record (`validUntil` in the past) reads as *unknown*: the friend view says so, prefill returns `null` and does nothing.
- All datetimes in records are UTC ISO via `normalizeIso`; every wall-clock → UTC conversion goes through luxon per date, as `materializeSlots` does.
- TDD per task: failing test, run, implement, run, commit. `npx vitest run <path>` for one file, `npm test` for all. `npm run typecheck` before each commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

```
lexicons/lol.letsmeet.availability.json        — Task 1: the schema
scripts/publishLexicons.ts                      — Task 1: add to the publish list
src/atproto/records.ts                          — Task 1: AVAILABILITY_NSID, AvailabilityRecord, build/validate
src/core/availability.ts                        — Task 2 (normalize, sentence, template week), Task 3 (freeIntervals, prefill)
src/core/ics.ts                                 — Task 4: buildAvailabilityIcs
src/db/db.ts                                    — Task 5: availability_cache table
src/db/availabilityCache.ts                     — Task 5: get/upsert
src/services/availability.ts                    — Task 6: save, own read, cached read, poll prefill
src/atproto/pds.ts                              — Task 7: resolveDid(handle)
src/atproto/types.ts                            — Task 7: Deps.resolveDid
src/index.ts                                    — Task 7: wire resolveDid (real and fake)
src/atproto/oauthClient.ts                      — Task 8: scope
src/web/routes/availability.ts                  — Task 9 (editor + save), Task 10 (public view + feed)
src/web/pages/Availability.tsx                  — Task 9: editor page shell
src/web/islands/availability.tsx                — Task 9: editor island
package.json                                    — Task 9: build:availability script
src/web/styles/app.css                          — Task 9: #availability-root shares the grid rules
src/web/pages/PublicAvailability.tsx            — Task 10: friend view
src/web/server.ts                               — Task 9/10: mount routes
src/web/routes/polls.ts, src/web/pages/Poll.tsx, src/web/islands/grid.tsx — Task 11: prefill
src/web/pages/Landing.tsx, src/web/routes/polls.ts — Task 12: landing block
e2e/availability.spec.ts                        — Task 13
docs/deploy.md, src/services/polls.ts           — Task 14: smoke step, stale comment
deploy/Caddyfile (new), docs/deploy.md          — Task 15 (optional): host alias
```

---

### Task 1: Lexicon and record builders

**Files:**
- Create: `lexicons/lol.letsmeet.availability.json`
- Modify: `src/atproto/records.ts` (imports at top, `lexicons` array, new exports at the end)
- Modify: `scripts/publishLexicons.ts:2-15`
- Test: `tests/atproto/availabilityRecord.test.ts`

**Interfaces:**
- Produces: `AVAILABILITY_NSID = 'lol.letsmeet.availability'`, `AVAILABILITY_RKEY = 'self'`, `interface WeeklyBlock { day: number; start: string; end: string }`, `interface AwayEntry { start: string; end: string; startTime?: string; endTime?: string; note?: string }`, `interface AvailabilityRecord { $type; timezone; weekly: WeeklyBlock[]; away: AwayEntry[]; note?; validUntil?; updatedAt }`, `validateAvailabilityRecord(v: unknown): AvailabilityRecord`, `buildAvailabilityRecord(input: Omit<AvailabilityRecord, '$type' | 'updatedAt'>, now: Date): AvailabilityRecord`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/atproto/availabilityRecord.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildAvailabilityRecord, validateAvailabilityRecord, AVAILABILITY_NSID,
} from '../../src/atproto/records.js';

const NOW = new Date('2026-09-16T12:00:00Z');
const base = {
  timezone: 'America/New_York',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }],
  away: [{ start: '2026-09-19', end: '2026-09-21', note: 'out of town' }],
};

describe('availability records', () => {
  it('builds a valid record with updatedAt', () => {
    const rec = buildAvailabilityRecord(base, NOW);
    expect(rec.$type).toBe(AVAILABILITY_NSID);
    expect(rec.updatedAt).toBe('2026-09-16T12:00:00.000Z');
    expect(() => validateAvailabilityRecord(rec)).not.toThrow();
  });
  it('accepts empty weekly and away arrays', () => {
    expect(() => buildAvailabilityRecord({ ...base, weekly: [], away: [] }, NOW)).not.toThrow();
  });
  it('rejects a weekday of 7', () => {
    expect(() => buildAvailabilityRecord({
      ...base, weekly: [{ day: 7, start: '19:00', end: '22:00' }],
    }, NOW)).toThrow();
  });
  it('rejects a timed away entry with a note over 80 graphemes', () => {
    expect(() => buildAvailabilityRecord({
      ...base, away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '19:00', endTime: '20:30', note: 'x'.repeat(81) }],
    }, NOW)).toThrow();
  });
  it('rejects a note over 300 graphemes', () => {
    expect(() => buildAvailabilityRecord({ ...base, note: 'x'.repeat(301) }, NOW)).toThrow();
  });
  it('rejects a malformed validUntil', () => {
    expect(() => buildAvailabilityRecord({ ...base, validUntil: 'soon' }, NOW)).toThrow();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/atproto/availabilityRecord.test.ts`
Expected: FAIL — `buildAvailabilityRecord` is not exported.

- [ ] **Step 3: Write the lexicon**

```json
{
  "lexicon": 1,
  "id": "lol.letsmeet.availability",
  "defs": {
    "main": {
      "type": "record",
      "description": "When this account is generally free: a usual week of half-hour blocks in a home timezone, plus dated ranges when they are away. One record per account, rkey `self`.",
      "key": "literal:self",
      "record": {
        "type": "object",
        "required": ["timezone", "weekly", "away", "updatedAt"],
        "properties": {
          "timezone": { "type": "string", "maxLength": 64, "description": "IANA zone every HH:MM below is read in." },
          "weekly": { "type": "array", "maxLength": 112, "items": { "type": "ref", "ref": "#block" } },
          "away": { "type": "array", "maxLength": 100, "items": { "type": "ref", "ref": "#away" } },
          "note": { "type": "string", "maxGraphemes": 300, "maxLength": 1200, "description": "Shown to anyone reading the record." },
          "validUntil": { "type": "string", "format": "datetime", "description": "After this the record is stale and should be read as unknown, not empty." },
          "updatedAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "block": {
      "type": "object",
      "description": "A usually-free stretch on one weekday. `end` at or before `start` means the block runs past midnight.",
      "required": ["day", "start", "end"],
      "properties": {
        "day": { "type": "integer", "minimum": 0, "maximum": 6, "description": "0 = Sunday." },
        "start": { "type": "string", "maxLength": 5, "description": "HH:MM, half-hour aligned." },
        "end": { "type": "string", "maxLength": 5, "description": "HH:MM, half-hour aligned." }
      }
    },
    "away": {
      "type": "object",
      "description": "An inclusive date range the account is not free, all day unless startTime/endTime narrow it to a window on each day.",
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "maxLength": 10, "description": "YYYY-MM-DD in `timezone`." },
        "end": { "type": "string", "maxLength": 10, "description": "YYYY-MM-DD in `timezone`, on or after start." },
        "startTime": { "type": "string", "maxLength": 5 },
        "endTime": { "type": "string", "maxLength": 5 },
        "note": { "type": "string", "maxGraphemes": 80, "maxLength": 320 }
      }
    }
  }
}
```

- [ ] **Step 4: Add the builders to `src/atproto/records.ts`**

At the top, next to the other lexicon imports:

```ts
import availabilityLex from '../../lexicons/lol.letsmeet.availability.json' with { type: 'json' };
```

Add `availabilityLex` to the `new Lexicons([...])` array. Then append:

```ts
export const AVAILABILITY_NSID = 'lol.letsmeet.availability';
export const AVAILABILITY_RKEY = 'self';

export interface WeeklyBlock { day: number; start: string; end: string }
export interface AwayEntry {
  start: string; end: string; startTime?: string; endTime?: string; note?: string;
}
export interface AvailabilityRecord {
  $type: typeof AVAILABILITY_NSID;
  timezone: string;
  weekly: WeeklyBlock[];
  away: AwayEntry[];
  note?: string;
  validUntil?: string;
  updatedAt: string;
}

export function validateAvailabilityRecord(v: unknown): AvailabilityRecord {
  lexicons.assertValidRecord(AVAILABILITY_NSID, v);
  return v as AvailabilityRecord;
}

/** Stamp and validate. Snapping, merging and ordering happen in core/availability.ts first. */
export function buildAvailabilityRecord(
  input: Omit<AvailabilityRecord, '$type' | 'updatedAt'>, now: Date,
): AvailabilityRecord {
  const rec: AvailabilityRecord = {
    $type: AVAILABILITY_NSID,
    timezone: input.timezone,
    weekly: input.weekly,
    away: input.away,
    ...(input.note ? { note: input.note } : {}),
    ...(input.validUntil ? { validUntil: normalizeIso(input.validUntil) } : {}),
    updatedAt: now.toISOString(),
  };
  return validateAvailabilityRecord(rec);
}
```

In `scripts/publishLexicons.ts`, import `availabilityLex` the same way and add it to the `for (const lex of [...])` list.

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run tests/atproto/availabilityRecord.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lexicons/lol.letsmeet.availability.json src/atproto/records.ts scripts/publishLexicons.ts tests/atproto/availabilityRecord.test.ts
git commit -m "feat(availability): lexicon and record builders for lol.letsmeet.availability

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Normalize, describe, template week

**Files:**
- Create: `src/core/availability.ts`
- Test: `tests/core/availability.test.ts`

**Interfaces:**
- Consumes: `WeeklyBlock`, `AwayEntry` from Task 1; `UserError` from `src/core/errors.ts`; `materializeSlots` from `src/core/slots.ts`; `Interval` from `src/core/intervals.ts`.
- Produces:
  - `interface AvailabilityInput { timezone: string; weekly: WeeklyBlock[]; away: AwayEntry[]; note?: string; validUntil?: string }`
  - `normalizeAvailability(input: unknown): AvailabilityInput` — snaps, merges, sorts, validates; throws `UserError`.
  - `describeWeekly(weekly: WeeklyBlock[]): string` — the read-back sentence.
  - `isStale(rec: { validUntil?: string }, now: Date): boolean`.
  - `TEMPLATE_SUNDAY = '2026-01-04'`, `TEMPLATE_START = '07:00'`, `TEMPLATE_END = '24:00'` (grid extent; a block ending at midnight is stored as `end: '00:00'`).
  - `templateSlots(timezone: string): Interval[]` — the editor grid's 7×34 half-hour slots.
  - `weeklyToTemplateIntervals(weekly, timezone): Interval[]` and `templateIntervalsToWeekly(ivs, timezone): WeeklyBlock[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/availability.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeAvailability, describeWeekly, isStale, templateSlots,
  weeklyToTemplateIntervals, templateIntervalsToWeekly,
} from '../../src/core/availability.js';

const TZ = 'America/New_York';

describe('normalizeAvailability', () => {
  it('snaps edges to the half hour, merges touching blocks, sorts by day then start', () => {
    const out = normalizeAvailability({
      timezone: TZ,
      weekly: [
        { day: 4, start: '19:10', end: '20:00' },
        { day: 2, start: '20:00', end: '22:00' },
        { day: 2, start: '19:00', end: '20:00' },
      ],
      away: [],
    });
    expect(out.weekly).toEqual([
      { day: 2, start: '19:00', end: '22:00' },
      { day: 4, start: '19:00', end: '20:00' },
    ]);
  });
  it('keeps a past-midnight block and merges nothing into it', () => {
    const out = normalizeAvailability({
      timezone: TZ, away: [],
      weekly: [{ day: 5, start: '22:00', end: '00:00' }, { day: 5, start: '20:00', end: '21:00' }],
    });
    expect(out.weekly).toEqual([
      { day: 5, start: '20:00', end: '21:00' },
      { day: 5, start: '22:00', end: '00:00' },
    ]);
  });
  it('rejects a zero-length block', () => {
    expect(() => normalizeAvailability({
      timezone: TZ, away: [], weekly: [{ day: 1, start: '19:00', end: '19:00' }],
    })).toThrow(/block/);
  });
  it('sorts away entries and drops empty notes', () => {
    const out = normalizeAvailability({
      timezone: TZ, weekly: [],
      away: [
        { start: '2026-10-02', end: '2026-10-02', note: '   ' },
        { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
      ],
    });
    expect(out.away).toEqual([
      { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
      { start: '2026-10-02', end: '2026-10-02' },
    ]);
  });
  it('rejects an away range that ends before it starts', () => {
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-09-21', end: '2026-09-19' }],
    })).toThrow(/ends before/);
  });
  it('rejects startTime without endTime, and a window that is not half-hour aligned', () => {
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '19:00' }],
    })).toThrow(/both/);
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '19:10', endTime: '20:00' }],
    })).toThrow(/half hour/);
  });
  it('rejects an unknown timezone and a bad date', () => {
    expect(() => normalizeAvailability({ timezone: 'Mars/Olympus', weekly: [], away: [] })).toThrow(/timezone/);
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [], away: [{ start: '2026-13-40', end: '2026-13-40' }],
    })).toThrow(/date/);
  });
  it('is idempotent', () => {
    const a = normalizeAvailability({
      timezone: TZ, weekly: [{ day: 2, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-09-19', end: '2026-09-21' }], note: 'hi', validUntil: '2026-12-31T23:59:59Z',
    });
    expect(normalizeAvailability(a)).toEqual(a);
  });
});

describe('describeWeekly', () => {
  it('groups days sharing a range, collapses weekdays and weekends', () => {
    expect(describeWeekly([
      { day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' },
      { day: 6, start: '13:00', end: '17:00' }, { day: 0, start: '13:00', end: '17:00' },
    ])).toBe('usually free tuesdays and thursdays 7pm to 10pm, and weekends 1pm to 5pm.');
    expect(describeWeekly([1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '12:00' }))))
      .toBe('usually free weekdays 9am to 12pm.');
  });
  it('says so when nothing is marked', () => {
    expect(describeWeekly([])).toBe('nothing marked yet.');
  });
  it('prints half hours and midnight', () => {
    expect(describeWeekly([{ day: 5, start: '20:30', end: '00:00' }]))
      .toBe('usually free fridays 8:30pm to midnight.');
  });
});

describe('isStale', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  it('is false without validUntil, false before it, true after it', () => {
    expect(isStale({}, now)).toBe(false);
    expect(isStale({ validUntil: '2026-12-31T23:59:59Z' }, now)).toBe(false);
    expect(isStale({ validUntil: '2026-09-01T00:00:00Z' }, now)).toBe(true);
  });
});

describe('template week', () => {
  it('has 7 days of 34 half-hour slots from 7am to midnight', () => {
    const slots = templateSlots(TZ);
    expect(slots).toHaveLength(7 * 34);
    expect(slots[0].start).toBe('2026-01-04T12:00:00.000Z'); // 07:00 EST, Sunday
  });
  it('round-trips weekly blocks through template intervals', () => {
    const weekly = [{ day: 2, start: '19:00', end: '22:00' }, { day: 5, start: '22:00', end: '00:00' }];
    const ivs = weeklyToTemplateIntervals(weekly, TZ);
    expect(templateIntervalsToWeekly(ivs, TZ)).toEqual(weekly);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/core/availability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/core/availability.ts`**

```ts
import { DateTime } from 'luxon';
import type { AwayEntry, WeeklyBlock } from '../atproto/records.js';
import { UserError } from './errors.js';
import { mergeIntervals, type Interval } from './intervals.js';
import { materializeSlots } from './slots.js';

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
    if (e <= s) e = 1440; // past midnight: the block runs to the end of the day
    if (e === s) throw new UserError('a block cannot start and end at the same time');
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
    const d = new Date(String(raw.validUntil));
    if (Number.isNaN(d.getTime())) throw new UserError('"good through" must be a date');
    out.validUntil = d.toISOString();
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

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
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
  const parts = [...byRange.entries()]
    .sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]) || a[0].localeCompare(b[0]))
    .map(([k, days]) => {
      const [s, e] = k.split('|');
      return `${nameDays(days)} ${fmtClock(s)} to ${fmtClock(e)}`;
    });
  return `usually free ${joinList(parts)}.`;
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
```

Note on `materializeSlots` and a `'00:00'` window end: `slots.ts` already treats `end <= start` as "crosses midnight", so `07:00`→`00:00` yields 34 slots per date. `TEMPLATE_END` is exported for labels only.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/core/availability.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/availability.ts tests/core/availability.test.ts
git commit -m "feat(availability): normalize, describe, and template-week conversions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Free intervals and poll prefill

**Files:**
- Modify: `src/core/availability.ts` (append)
- Test: `tests/core/availabilityPrefill.test.ts`

**Interfaces:**
- Consumes: `AvailabilityInput`, `isStale` (Task 2); `Interval`, `mergeIntervals`, `snapToSlots` from `src/core/intervals.ts`.
- Produces:
  - `freeIntervals(rec: AvailabilityInput, from: string, to: string): Interval[]` — UTC intervals the record calls free over inclusive local dates `[from, to]`.
  - `prefillFromAvailability(rec: AvailabilityInput, slots: Interval[], now: Date): Interval[] | null` — `null` when stale; otherwise the slots fully covered, merged.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/availabilityPrefill.test.ts
import { describe, it, expect } from 'vitest';
import { freeIntervals, prefillFromAvailability } from '../../src/core/availability.js';
import { materializeSlots } from '../../src/core/slots.js';

const NY = 'America/New_York';
const NOW = new Date('2026-09-16T12:00:00Z');

describe('freeIntervals', () => {
  it('materializes a weekly block per matching date in the zone', () => {
    // 2026-10-13 is a Tuesday; 19:00–22:00 EDT = 23:00Z–02:00Z next day
    const out = freeIntervals({ timezone: NY, weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] },
      '2026-10-12', '2026-10-14');
    expect(out).toEqual([{ start: '2026-10-13T23:00:00.000Z', end: '2026-10-14T02:00:00.000Z' }]);
  });
  it('shifts with DST: the same wall-clock block lands an hour later in UTC after fall-back', () => {
    // 2026-11-01 clocks fall back in New York; Tuesday 2026-11-03 is EST
    const out = freeIntervals({ timezone: NY, weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] },
      '2026-11-03', '2026-11-03');
    expect(out).toEqual([{ start: '2026-11-04T00:00:00.000Z', end: '2026-11-04T03:00:00.000Z' }]);
  });
  it('runs a past-midnight block to the end of the local day', () => {
    const out = freeIntervals({ timezone: 'UTC', weekly: [{ day: 5, start: '22:00', end: '00:00' }], away: [] },
      '2026-10-16', '2026-10-16'); // a Friday
    expect(out).toEqual([{ start: '2026-10-16T22:00:00.000Z', end: '2026-10-17T00:00:00.000Z' }]);
  });
  it('subtracts an all-day away entry', () => {
    const out = freeIntervals({
      timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-10-13', end: '2026-10-13' }],
    }, '2026-10-12', '2026-10-18');
    expect(out).toEqual([{ start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T22:00:00.000Z' }]);
  });
  it('subtracts a timed away window and keeps the rest of the block', () => {
    const out = freeIntervals({
      timezone: 'UTC', weekly: [{ day: 4, start: '19:00', end: '22:00' }],
      away: [{ start: '2026-10-15', end: '2026-10-15', startTime: '19:00', endTime: '20:30' }],
    }, '2026-10-15', '2026-10-15');
    expect(out).toEqual([{ start: '2026-10-15T20:30:00.000Z', end: '2026-10-15T22:00:00.000Z' }]);
  });
  it('applies a multi-day timed window to each day in the range', () => {
    const out = freeIntervals({
      timezone: 'UTC', weekly: [1, 2, 3].map((day) => ({ day, start: '09:00', end: '12:00' })),
      away: [{ start: '2026-10-12', end: '2026-10-14', startTime: '09:00', endTime: '10:00' }],
    }, '2026-10-12', '2026-10-14');
    expect(out).toEqual([
      { start: '2026-10-12T10:00:00.000Z', end: '2026-10-12T12:00:00.000Z' },
      { start: '2026-10-13T10:00:00.000Z', end: '2026-10-13T12:00:00.000Z' },
      { start: '2026-10-14T10:00:00.000Z', end: '2026-10-14T12:00:00.000Z' },
    ]);
  });
});

describe('prefillFromAvailability', () => {
  // The real "Catch-22 Take 2" geometry.
  const poll = {
    dates: ['2026-10-08', '2026-10-09', '2026-10-11', '2026-10-12', '2026-10-13', '2026-10-15'],
    window: { start: '19:30', end: '21:00' }, slotMinutes: 30 as const, timezone: NY,
  };
  const slots = materializeSlots(poll);
  const rec = {
    timezone: NY,
    weekly: [{ day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' }],
    away: [{ start: '2026-10-15', end: '2026-10-15', startTime: '19:00', endTime: '20:30' }],
  };
  it('marks the slots the record covers, merged, minus away windows', () => {
    const out = prefillFromAvailability(rec, slots, NOW);
    expect(out).toEqual([
      // Tue Oct 13, 19:30–21:00 EDT
      { start: '2026-10-13T23:30:00.000Z', end: '2026-10-14T01:00:00.000Z' },
      // Thu Oct 15: only 20:30–21:00 survives the dentist
      { start: '2026-10-16T00:30:00.000Z', end: '2026-10-16T01:00:00.000Z' },
    ]);
  });
  it('is null for a stale record', () => {
    expect(prefillFromAvailability({ ...rec, validUntil: '2026-09-01T00:00:00Z' }, slots, NOW)).toBeNull();
  });
  it('is an empty list when nothing lines up', () => {
    expect(prefillFromAvailability({ timezone: NY, weekly: [], away: [] }, slots, NOW)).toEqual([]);
  });
  it('does not mark a slot the record only half covers', () => {
    const narrow = { timezone: NY, weekly: [{ day: 2, start: '19:45', end: '22:00' }], away: [] };
    // 19:45 snaps to 19:30 in normalize, but freeIntervals takes the record as given: a
    // 19:45 start covers no 19:30–20:00 slot.
    const out = prefillFromAvailability(narrow, slots, NOW)!;
    expect(out[0].start).toBe('2026-10-14T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/core/availabilityPrefill.test.ts`
Expected: FAIL — `freeIntervals` is not exported.

- [ ] **Step 3: Append to `src/core/availability.ts`**

```ts
// ---- Materializing the record over real dates ---------------------------------------

/** Every local date from `from` to `to` inclusive, as ISO dates. Bounded to a year. */
function eachDate(from: string, to: string, tz: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(from, { zone: tz });
  const end = DateTime.fromISO(to, { zone: tz });
  while (d <= end && out.length <= 366) { out.push(d.toISODate()!); d = d.plus({ days: 1 }); }
  return out;
}

/** [start, end) on local `date` in `tz`, in UTC. A past-midnight end rolls to the next day. */
function localRange(date: string, start: string, end: string, tz: string): Interval {
  const s = DateTime.fromISO(`${date}T${start}`, { zone: tz });
  let e = DateTime.fromISO(`${date}T${end}`, { zone: tz });
  if (e <= s) e = e.plus({ days: 1 });
  return { start: s.toUTC().toISO()!, end: e.toUTC().toISO()! };
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
```

Add `snapToSlots` to the existing import from `./intervals.js`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/core/availabilityPrefill.test.ts tests/core/availability.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/availability.ts tests/core/availabilityPrefill.test.ts
git commit -m "feat(availability): materialize free intervals and prefill a poll from them

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: The ICS feed

**Files:**
- Modify: `src/core/ics.ts` (append; `esc`, `toBasic`, `foldLine` already exist there)
- Test: `tests/core/availabilityIcs.test.ts`

**Interfaces:**
- Consumes: `AvailabilityInput` (Task 2).
- Produces: `buildAvailabilityIcs(rec: AvailabilityInput & { updatedAt: string }, opts: { uidHost: string; name: string; now: Date }): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/availabilityIcs.test.ts
import { describe, it, expect } from 'vitest';
import { buildAvailabilityIcs } from '../../src/core/ics.js';

const rec = {
  timezone: 'America/New_York',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }],
  away: [
    { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
    { start: '2026-10-12', end: '2026-10-14', startTime: '09:00', endTime: '10:00', note: 'a; note, with punctuation' },
  ],
  validUntil: '2026-12-31T23:59:59.000Z',
  updatedAt: '2026-09-16T12:00:00.000Z',
};
const opts = { uidHost: 'letsmeet.lol', name: 'ken.wzrdz.cool', now: new Date('2026-09-16T12:00:00Z') };

describe('buildAvailabilityIcs', () => {
  const ics = buildAvailabilityIcs(rec, opts);
  const lines = ics.split('\r\n');
  it('is a calendar named for the account with the record zone', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('X-WR-CALNAME:ken.wzrdz.cool · availability');
    expect(lines).toContain('X-WR-TIMEZONE:America/New_York');
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(ics.endsWith('\r\n')).toBe(true);
  });
  it('repeats each weekly block with TZID and UNTIL from validUntil', () => {
    expect(lines).toContain('DTSTART;TZID=America/New_York:20260106T190000'); // the template Tuesday
    expect(lines).toContain('DTEND;TZID=America/New_York:20260106T220000');
    expect(lines).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261231T235959Z');
    expect(lines).toContain('SUMMARY:usually free');
    expect(lines).toContain('TRANSP:TRANSPARENT');
  });
  it('emits an all-day away entry with an exclusive end', () => {
    expect(lines).toContain('DTSTART;VALUE=DATE:20260919');
    expect(lines).toContain('DTEND;VALUE=DATE:20260922');
    expect(lines).toContain('SUMMARY:away · out of town');
    expect(lines).toContain('TRANSP:OPAQUE');
  });
  it('emits a timed multi-day away entry as a daily repeat and escapes the note', () => {
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261012T090000');
    expect(lines).toContain('RRULE:FREQ=DAILY;UNTIL=20261014T235959');
    expect(lines).toContain('SUMMARY:away · a\; note\\, with punctuation');
  });
  it('gives every event a stable UID and folds long lines', () => {
    const uids = lines.filter((l) => l.startsWith('UID:'));
    expect(new Set(uids).size).toBe(3);
    const long = buildAvailabilityIcs({ ...rec, away: [{ start: '2026-09-19', end: '2026-09-19', note: 'é'.repeat(80) }] }, opts);
    for (const l of long.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/core/availabilityIcs.test.ts`
Expected: FAIL — `buildAvailabilityIcs` is not exported.

- [ ] **Step 3: Append to `src/core/ics.ts`**

```ts
import type { AvailabilityInput } from './availability.js';
import { TEMPLATE_SUNDAY } from './availability.js';

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const ymd = (d: string) => d.replace(/-/g, '');
const hm = (t: string) => `${t.replace(':', '')}00`;
/** ISO date + n days, as YYYYMMDD; noon anchoring keeps the arithmetic away from DST. */
function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The standing record as a subscribable calendar: each weekly block is a repeating
 * transparent event anchored on the editor's template week (so BYDAY and DTSTART agree),
 * each away entry a busy event, all-day or timed. TZID names the record's IANA zone
 * without a VTIMEZONE block — Apple and Google resolve IANA names; revisit if a client
 * refuses the feed.
 */
export function buildAvailabilityIcs(
  rec: AvailabilityInput & { updatedAt: string },
  opts: { uidHost: string; name: string; now: Date },
): string {
  const stamp = toBasic(opts.now.toISOString());
  const tz = rec.timezone;
  const until = rec.validUntil ? `;UNTIL=${toBasic(rec.validUntil)}` : '';
  const L: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//letsmeet//availability//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${opts.name} · availability`)}`,
    `X-WR-TIMEZONE:${esc(tz)}`,
  ];
  for (const b of rec.weekly) {
    const date = plusDays(TEMPLATE_SUNDAY, b.day);
    // A past-midnight block ends on the next calendar day.
    const endDate = b.end <= b.start ? plusDays(TEMPLATE_SUNDAY, b.day + 1) : date;
    L.push(
      'BEGIN:VEVENT',
      `UID:weekly-${BYDAY[b.day]}-${b.start.replace(':', '')}@${opts.uidHost}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${tz}:${date}T${hm(b.start)}`,
      `DTEND;TZID=${tz}:${endDate}T${hm(b.end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[b.day]}${until}`,
      'SUMMARY:usually free', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    );
  }
  for (const a of rec.away) {
    const summary = `SUMMARY:${esc(a.note ? `away · ${a.note}` : 'away')}`;
    L.push('BEGIN:VEVENT',
      `UID:away-${ymd(a.start)}-${a.startTime ? a.startTime.replace(':', '') : 'allday'}@${opts.uidHost}`,
      `DTSTAMP:${stamp}`);
    if (a.startTime && a.endTime) {
      L.push(`DTSTART;TZID=${tz}:${ymd(a.start)}T${hm(a.startTime)}`,
        `DTEND;TZID=${tz}:${ymd(a.start)}T${hm(a.endTime)}`);
      if (a.end !== a.start) L.push(`RRULE:FREQ=DAILY;UNTIL=${ymd(a.end)}T235959`);
    } else {
      L.push(`DTSTART;VALUE=DATE:${ymd(a.start)}`, `DTEND;VALUE=DATE:${plusDays(a.end, 1)}`);
    }
    L.push(summary, 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(foldLine).join('\r\n') + '\r\n';
}
```

Note: `RRULE ... UNTIL` for a `TZID` event is written as floating local time, which RFC 5545 permits when `DTSTART` is local; `validUntil` is already UTC so it keeps its `Z`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/core/availabilityIcs.test.ts tests/core/ics.test.ts && npm run typecheck`
Expected: PASS (the existing `buildIcs` tests must still pass).

- [ ] **Step 5: Commit**

```bash
git add src/core/ics.ts tests/core/availabilityIcs.test.ts
git commit -m "feat(availability): ics feed for the standing record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The availability cache table

**Files:**
- Modify: `src/db/db.ts` (add a table to `SCHEMA`)
- Create: `src/db/availabilityCache.ts`
- Test: `tests/db/availabilityCache.test.ts`

**Interfaces:**
- Produces: `interface CachedAvailability { did: string; uri: string | null; cid: string | null; record: AvailabilityRecord | null; updatedAt: number }`, `upsertAvailabilityCache(db, did, found: { uri: string; cid: string | null; record: AvailabilityRecord } | null): void`, `getAvailabilityCache(db, did): CachedAvailability | null`. A row with `record: null` means "we looked and there was no record", distinct from no row.

- [ ] **Step 1: Write the failing test**

```ts
// tests/db/availabilityCache.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { getAvailabilityCache, upsertAvailabilityCache } from '../../src/db/availabilityCache.js';
import type { AvailabilityRecord } from '../../src/atproto/records.js';

const DID = 'did:plc:ken';
const rec: AvailabilityRecord = {
  $type: 'lol.letsmeet.availability', timezone: 'UTC',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [], updatedAt: '2026-09-16T12:00:00.000Z',
};

describe('availability cache', () => {
  it('is empty until written, then round-trips a record', () => {
    const db = openDb(':memory:');
    expect(getAvailabilityCache(db, DID)).toBeNull();
    upsertAvailabilityCache(db, DID, { uri: `at://${DID}/lol.letsmeet.availability/self`, cid: 'bafy', record: rec });
    const row = getAvailabilityCache(db, DID)!;
    expect(row.record).toEqual(rec);
    expect(row.cid).toBe('bafy');
  });
  it('remembers a known absence as a row with a null record', () => {
    const db = openDb(':memory:');
    upsertAvailabilityCache(db, DID, null);
    const row = getAvailabilityCache(db, DID)!;
    expect(row.record).toBeNull();
    expect(row.uri).toBeNull();
  });
  it('replaces on a second write', () => {
    const db = openDb(':memory:');
    upsertAvailabilityCache(db, DID, { uri: 'u', cid: 'a', record: rec });
    upsertAvailabilityCache(db, DID, { uri: 'u', cid: 'b', record: { ...rec, weekly: [] } });
    expect(getAvailabilityCache(db, DID)!.record!.weekly).toEqual([]);
    expect(getAvailabilityCache(db, DID)!.cid).toBe('b');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/db/availabilityCache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add the table and the module**

In `src/db/db.ts`, inside the `SCHEMA` template string, after the `web_session_did` index:

```sql
CREATE TABLE IF NOT EXISTS availability_cache (
  did TEXT PRIMARY KEY, uri TEXT, cid TEXT, record_json TEXT,
  updated_at INTEGER NOT NULL);
```

Create `src/db/availabilityCache.ts`:

```ts
import type { Database } from './db.js';
import type { AvailabilityRecord } from '../atproto/records.js';

/**
 * One row per DID whose standing availability this server has looked up. The record in
 * the PDS is the truth; this is the same disposable index `poll_cache` is. A row whose
 * `record` is null says "we asked and there was none" — the friend view and prefill read
 * that as absent without another round trip until the freshness window lapses.
 */
export interface CachedAvailability {
  did: string;
  uri: string | null;
  cid: string | null;
  record: AvailabilityRecord | null;
  updatedAt: number;
}

export function upsertAvailabilityCache(
  db: Database.Database, did: string,
  found: { uri: string; cid: string | null; record: AvailabilityRecord } | null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO availability_cache (did, uri, cid, record_json, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(did, found?.uri ?? null, found?.cid ?? null, found ? JSON.stringify(found.record) : null, Date.now());
}

export function getAvailabilityCache(db: Database.Database, did: string): CachedAvailability | null {
  const r = db.prepare('SELECT * FROM availability_cache WHERE did = ?').get(did) as
    | { did: string; uri: string | null; cid: string | null; record_json: string | null; updated_at: number }
    | undefined;
  if (!r) return null;
  return {
    did: r.did, uri: r.uri, cid: r.cid, updatedAt: r.updated_at,
    record: r.record_json ? (JSON.parse(r.record_json) as AvailabilityRecord) : null,
  };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/db && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db/db.ts src/db/availabilityCache.ts tests/db/availabilityCache.test.ts
git commit -m "feat(availability): disposable availability_cache table

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Availability service

**Files:**
- Create: `src/services/availability.ts`
- Test: `tests/services/availability.test.ts`

**Interfaces:**
- Consumes: `Deps` (`src/atproto/types.ts`), `FakeRepo`, `freshnessFor` (`src/services/freshness.ts`), Task 1 builders, Task 2/3 core, Task 5 cache.
- Produces:
  - `getOwnAvailability(deps, did): Promise<AvailabilityRecord | null>` — live read, validated, cache updated.
  - `saveAvailability(deps, did, input: unknown): Promise<{ record: AvailabilityRecord; written: boolean }>`.
  - `getAvailabilityCached(deps, did): Promise<AvailabilityRecord | null>` — cache-first with the 30-second revalidate window; throws only when there is no cache row and the live read fails.
  - `prefillForPoll(deps, did, slots: Interval[]): Promise<Interval[] | null>` — never throws; `null` on stale, absent, or error.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/services/availability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import {
  getOwnAvailability, saveAvailability, getAvailabilityCached, prefillForPoll,
} from '../../src/services/availability.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY } from '../../src/atproto/records.js';
import { materializeSlots } from '../../src/core/slots.js';
import type { Deps } from '../../src/atproto/types.js';

const DID = 'did:plc:ken';
const input = {
  timezone: 'UTC',
  weekly: [{ day: 2, start: '19:10', end: '20:00' }, { day: 2, start: '20:00', end: '22:00' }],
  away: [{ start: '2026-10-13', end: '2026-10-13' }],
  note: '  text first  ',
};

function setup(revalidateTtlMs?: number) {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'), revalidateTtlMs,
  };
  return { deps, repo };
}

describe('saveAvailability', () => {
  it('normalizes and writes rkey self, then reads it back', async () => {
    const { deps, repo } = setup();
    const { record, written } = await saveAvailability(deps, DID, input);
    expect(written).toBe(true);
    expect(record.weekly).toEqual([{ day: 2, start: '19:00', end: '22:00' }]);
    expect(record.note).toBe('text first');
    const stored = await repo.getRecord(DID, AVAILABILITY_NSID, AVAILABILITY_RKEY);
    expect(stored?.value).toEqual(record);
    expect(await getOwnAvailability(deps, DID)).toEqual(record);
  });
  it('does not rewrite an unchanged record', async () => {
    const { deps, repo } = setup();
    await saveAvailability(deps, DID, input);
    const put = vi.spyOn(repo, 'putRecord');
    const { written } = await saveAvailability(deps, DID, { ...input, note: 'text first' });
    expect(written).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });
  it('surfaces a person-readable error for bad input', async () => {
    const { deps } = setup();
    await expect(saveAvailability(deps, DID, { ...input, timezone: 'Nowhere/Here' }))
      .rejects.toThrow(/timezone/);
  });
});

describe('getAvailabilityCached', () => {
  it('reads live once, then serves the cache inside the window', async () => {
    const { deps, repo } = setup(30_000);
    await saveAvailability(deps, DID, input);
    const get = vi.spyOn(repo, 'getRecord');
    expect((await getAvailabilityCached(deps, DID))?.timezone).toBe('UTC');
    expect((await getAvailabilityCached(deps, DID))?.timezone).toBe('UTC');
    expect(get).toHaveBeenCalledTimes(0); // the save primed the cache and the window
  });
  it('remembers an absence and does not re-ask inside the window', async () => {
    const { deps, repo } = setup(30_000);
    const get = vi.spyOn(repo, 'getRecord');
    expect(await getAvailabilityCached(deps, 'did:plc:nobody')).toBeNull();
    expect(await getAvailabilityCached(deps, 'did:plc:nobody')).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('serves the cache when the live read fails, and throws only with no cache', async () => {
    const { deps, repo } = setup(0);
    await saveAvailability(deps, DID, input);
    vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('pds down'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await getAvailabilityCached(deps, DID))?.timezone).toBe('UTC');
      await expect(getAvailabilityCached(deps, 'did:plc:other')).rejects.toThrow(/pds down/);
    } finally { warned.mockRestore(); }
  });
});

describe('prefillForPoll', () => {
  const slots = materializeSlots({
    dates: ['2026-10-13', '2026-10-15'], window: { start: '19:00', end: '21:00' },
    slotMinutes: 30, timezone: 'UTC',
  });
  it('returns the covered slots, skipping the away day', async () => {
    const { deps } = setup();
    await saveAvailability(deps, DID, { ...input, weekly: [...input.weekly, { day: 4, start: '19:00', end: '22:00' }] });
    expect(await prefillForPoll(deps, DID, slots)).toEqual([
      { start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T21:00:00.000Z' },
    ]);
  });
  it('is null with no record, a stale record, or a failing read', async () => {
    const { deps, repo } = setup(0);
    expect(await prefillForPoll(deps, DID, slots)).toBeNull();
    await saveAvailability(deps, DID, { ...input, validUntil: '2026-01-01T00:00:00Z' });
    expect(await prefillForPoll(deps, DID, slots)).toBeNull();
    vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('pds down'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // cache exists, so the read degrades to the cached (stale) record → still null
      expect(await prefillForPoll(deps, DID, slots)).toBeNull();
    } finally { warned.mockRestore(); }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/services/availability.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/services/availability.ts`**

```ts
import type { Deps } from '../atproto/types.js';
import {
  AVAILABILITY_NSID, AVAILABILITY_RKEY, buildAvailabilityRecord, validateAvailabilityRecord,
  type AvailabilityRecord,
} from '../atproto/records.js';
import { normalizeAvailability, prefillFromAvailability } from '../core/availability.js';
import type { Interval } from '../core/intervals.js';
import { getAvailabilityCache, upsertAvailabilityCache } from '../db/availabilityCache.js';
import { freshnessFor } from './freshness.js';

/** Live read of a DID's own record; the cache is refreshed as a side effect. */
async function readLive(deps: Deps, did: string): Promise<AvailabilityRecord | null> {
  const found = await deps.reader.getRecord(did, AVAILABILITY_NSID, AVAILABILITY_RKEY);
  if (!found) { upsertAvailabilityCache(deps.db, did, null); return null; }
  const record = validateAvailabilityRecord(found.value);
  upsertAvailabilityCache(deps.db, did, { uri: found.uri, cid: found.cid, record });
  freshnessFor(deps).mark(`avail:${did}`, deps.now().getTime());
  return record;
}

/** The editor's read: always live. It is one small read of the viewer's own repo. */
export function getOwnAvailability(deps: Deps, did: string): Promise<AvailabilityRecord | null> {
  return readLive(deps, did);
}

const sameButForStamp = (a: AvailabilityRecord, b: AvailabilityRecord): boolean => {
  const { updatedAt: _a, ...ra } = a;
  const { updatedAt: _b, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
};

/**
 * Normalize what the editor posted, then put it at rkey `self` — unless the live record
 * already says exactly this, in which case nothing is written (no churn, no new CID).
 */
export async function saveAvailability(
  deps: Deps, did: string, input: unknown,
): Promise<{ record: AvailabilityRecord; written: boolean }> {
  const normalized = normalizeAvailability(input);
  const record = buildAvailabilityRecord(normalized, deps.now());
  const live = await readLive(deps, did);
  if (live && sameButForStamp(live, record)) return { record: live, written: false };
  const writer = await deps.writerFor(did);
  const ref = await writer.putRecord(did, AVAILABILITY_NSID, AVAILABILITY_RKEY, record);
  upsertAvailabilityCache(deps.db, did, { uri: ref.uri, cid: ref.cid, record });
  freshnessFor(deps).mark(`avail:${did}`, deps.now().getTime());
  return { record, written: true };
}

/**
 * Anyone else's record: cache first, revalidated in the background window `poll_cache`
 * uses. A cached row (even one that says "none") is served when the PDS will not answer;
 * only a cold miss propagates the failure.
 */
export async function getAvailabilityCached(deps: Deps, did: string): Promise<AvailabilityRecord | null> {
  const cached = getAvailabilityCache(deps.db, did);
  const fresh = freshnessFor(deps);
  const nowMs = deps.now().getTime();
  if (cached && fresh.isFresh(`avail:${did}`, nowMs)) return cached.record;
  fresh.mark(`avail:${did}`, nowMs);
  try {
    return await readLive(deps, did);
  } catch (err) {
    if (!cached) throw err;
    console.warn(`availability revalidate failed for ${did}; serving cache:`, err);
    return cached.record;
  }
}

/** Slots the viewer's standing record says they can make, or null for "don't know". Never throws. */
export async function prefillForPoll(deps: Deps, did: string, slots: Interval[]): Promise<Interval[] | null> {
  try {
    const rec = await getAvailabilityCached(deps, did);
    if (!rec) return null;
    return prefillFromAvailability(rec, slots, deps.now());
  } catch (err) {
    console.warn(`availability prefill skipped for ${did}:`, err);
    return null;
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/services/availability.test.ts && npm run typecheck`
Expected: PASS. If the "reads live once" test counts one `getRecord`, that is the save's own live compare being spied too early: move the `vi.spyOn` after the save as written.

- [ ] **Step 5: Commit**

```bash
git add src/services/availability.ts tests/services/availability.test.ts
git commit -m "feat(availability): service — save, own read, cached read, poll prefill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Handle → DID resolution

**Files:**
- Modify: `src/atproto/pds.ts` (append)
- Modify: `src/atproto/types.ts` (`Deps`)
- Modify: `src/index.ts:68-90` (both `deps` constructions)
- Test: `tests/atproto/resolveDid.test.ts`

**Interfaces:**
- Produces: `resolveDid(handle: string, opts?: NetOpts): Promise<string | null>` in `pds.ts`; `cachedResolveDid(inner, ttlMs = 3_600_000, max = 5_000)`; `Deps.resolveDid?(handle: string): Promise<string | null>`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/atproto/resolveDid.test.ts
import { describe, it, expect, vi } from 'vitest';
import { resolveDid, cachedResolveDid } from '../../src/atproto/pds.js';

const okLookup = async () => ['1.2.3.4'];
const fetchWith = (status: number, body: unknown) => vi.fn(async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('resolveDid', () => {
  it('asks the public api and returns the did', async () => {
    const f = fetchWith(200, { did: 'did:plc:abc' });
    expect(await resolveDid('ken.wzrdz.cool', { fetch: f as unknown as typeof fetch, lookup: okLookup })).toBe('did:plc:abc');
    expect(String(f.mock.calls[0][0])).toContain('resolveHandle?handle=ken.wzrdz.cool');
  });
  it('is null for an unknown handle or a malformed one, without a request', async () => {
    const f = fetchWith(400, { error: 'InvalidRequest' });
    expect(await resolveDid('nobody.example', { fetch: f as unknown as typeof fetch, lookup: okLookup })).toBeNull();
    expect(await resolveDid('not a handle!', { fetch: f as unknown as typeof fetch, lookup: okLookup })).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('caches hits and misses', async () => {
    const inner = vi.fn(async (h: string) => (h === 'a.b' ? 'did:plc:a' : null));
    const r = cachedResolveDid(inner);
    expect(await r('a.b')).toBe('did:plc:a');
    expect(await r('a.b')).toBe('did:plc:a');
    expect(await r('x.y')).toBeNull();
    expect(await r('x.y')).toBeNull();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/atproto/resolveDid.test.ts`
Expected: FAIL — `resolveDid` is not exported.

- [ ] **Step 3: Append to `src/atproto/pds.ts`**

```ts
const RESOLVE_HANDLE_URL = 'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle';
const HANDLE_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/** The DID a handle currently points at, or null when it points nowhere. Public read. */
export async function resolveDid(handle: string, opts: NetOpts = {}): Promise<string | null> {
  if (!HANDLE_RE.test(handle) || handle.length > 253) return null;
  const u = new URL(RESOLVE_HANDLE_URL);
  u.searchParams.set('handle', handle.toLowerCase());
  try {
    const res = await safeFetch(u, opts);
    if (!res.ok) return null;
    const body = (await res.json()) as { did?: unknown };
    return typeof body.did === 'string' && body.did.startsWith('did:') ? body.did : null;
  } catch {
    return null;
  }
}

/** Handles are attacker-influenced keys, so the memo is capped and evicts oldest-first. */
export function cachedResolveDid(
  inner: (handle: string) => Promise<string | null>, ttlMs = 60 * 60_000, max = 5_000,
): (handle: string) => Promise<string | null> {
  const memo = new Map<string, { did: string | null; at: number }>();
  return async (handle) => {
    const key = handle.toLowerCase();
    const hit = memo.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.did;
    const did = await inner(key);
    if (memo.size >= max && !memo.has(key)) {
      const oldest = memo.keys().next().value;
      if (oldest !== undefined) memo.delete(oldest);
    }
    memo.set(key, { did, at: now });
    return did;
  };
}
```

In `src/atproto/types.ts`, add to `Deps` after `resolveHandle`:

```ts
  /**
   * The DID a handle points at, for the public `/u/<handle>` pages. Absent in fake mode,
   * where the routes accept a `did:` literal in the handle's place.
   */
  resolveDid?(handle: string): Promise<string | null>;
```

In `src/index.ts`, in the real-PDS `deps` object (the one with `resolveHandle`), add `resolveDid: cachedResolveDid(resolveDid),` and extend the import from `./atproto/pds.js` with `resolveDid, cachedResolveDid`. Leave the fake `deps` without it.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/atproto/resolveDid.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/atproto/pds.ts src/atproto/types.ts src/index.ts tests/atproto/resolveDid.test.ts
git commit -m "feat(atproto): resolve a handle to its did for public pages

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: OAuth scope

**Files:**
- Modify: `src/atproto/oauthClient.ts:39-41`
- Modify: `tests/atproto/oauthScope.test.ts`

- [ ] **Step 1: Update the test**

In `tests/atproto/oauthScope.test.ts`, add `AVAILABILITY_NSID` to the list of NSIDs the loop checks (import it from `../../src/atproto/records.js`), and change the final assertion to `toHaveLength(4)`.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/atproto/oauthScope.test.ts`
Expected: FAIL — only three `repo:` scopes.

- [ ] **Step 3: Add the scope**

In `src/atproto/oauthClient.ts`, import `AVAILABILITY_NSID` from `./records.js` and add to the `SCOPE` list after the event line:

```ts
  `repo:${AVAILABILITY_NSID}?action=create&action=update`,
```

Extend the comment above the list: a put on rkey `self` creates the record the first time and updates it after, and sessions granted before this change keep their old scope until the next sign-in (Task 9's save route turns that into "sign in again").

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/atproto/oauthScope.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/atproto/oauthClient.ts tests/atproto/oauthScope.test.ts
git commit -m "feat(oauth): ask for the availability record type

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The editor — routes, page shell, island

**Files:**
- Create: `src/web/routes/availability.ts`
- Create: `src/web/pages/Availability.tsx`
- Create: `src/web/islands/availability.tsx`
- Modify: `src/web/server.ts:154-156` (mount), `package.json` (`build:availability`, `build:client`), `src/web/styles/app.css:350` (scope), `playwright.config.ts` is untouched (its `build:client` already runs everything).
- Test: `tests/web/availabilityRoutes.test.ts`

**Interfaces:**
- Consumes: `saveAvailability`, `getOwnAvailability` (Task 6); `describeWeekly`, `templateSlots`, `weeklyToTemplateIntervals`, `templateIntervalsToWeekly`, `TEMPLATE_SUNDAY` (Task 2); `gridModel` exports; `readSession`, `page`, `scriptJson`, `Layout`, `TokenBucket`, `UserError`, `ValidationError`.
- Produces: `availabilityRoutes(deps, env): Hono` mounting `GET /availability`, `POST /availability`. The island posts `{ timezone, weekly, away, note, validUntil }` as JSON and expects `{ ok: true, sentence: string, written: boolean } | { error: string }`. Page data element `#availability-data`, mount `#availability-root`, bundle `/assets/availability.js`.

- [ ] **Step 1: Write the failing route tests**

```ts
// tests/web/availabilityRoutes.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const ME = 'did:plc:me';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: ME }),
  restore: async () => { throw new Error('not used'); },
};

function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'),
  };
  const app = createServer(deps, stubAuth, {
    COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
  });
  return { app, deps, repo };
}

/** Sign in through the dev route and hand back the cookie header. */
async function signIn(app: ReturnType<typeof setup>['app'], did: string): Promise<string> {
  const res = await app.request(`/dev/login?did=${did}&handle=me.test`);
  return res.headers.get('set-cookie')!.split(';')[0];
}

const body = {
  timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }],
  away: [{ start: '2026-09-19', end: '2026-09-21', note: 'out of town' }], note: 'text first',
};

describe('/availability', () => {
  it('redirects a signed-out visitor to sign in and come back', async () => {
    const { app } = setup();
    const res = await app.request('/availability');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?returnTo=%2Favailability');
  });
  it('renders the editor with the current record as island data', async () => {
    const { app, repo } = setup();
    const cookie = await signIn(app, ME);
    await repo.putRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY, {
      $type: AVAILABILITY_NSID, ...body, updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const res = await app.request('/availability', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="availability-data"');
    expect(html).toContain('id="availability-root"');
    expect(html).toContain('/assets/availability.js');
    expect(html).toContain('out of town');
    expect(html).toContain('usually free tuesdays 7pm to 10pm.');
  });
  it('saves a record for the signed-in viewer and reports the sentence', async () => {
    const { app, repo } = setup();
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, written: true, sentence: 'usually free tuesdays 7pm to 10pm.' });
    const stored = await repo.getRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY);
    expect((stored?.value as { note: string }).note).toBe('text first');
  });
  it('rejects a save with no session, and explains a bad body', async () => {
    const { app } = setup();
    expect((await app.request('/availability', { method: 'POST', body: '{}' })).status).toBe(401);
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, timezone: 'Nowhere/Here' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/timezone/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/web/availabilityRoutes.test.ts`
Expected: FAIL — 404s (route not mounted).

- [ ] **Step 3: The routes — `src/web/routes/availability.ts`**

```ts
import { createElement } from 'react';
import { Hono } from 'hono';
import { ValidationError } from '@atproto/lexicon';
import type { Deps } from '../../atproto/types.js';
import { GENERIC_ERROR, UserError } from '../../core/errors.js';
import { describeWeekly } from '../../core/availability.js';
import { readSession, type SessionEnv } from '../session.js';
import { page } from '../respond.js';
import { TokenBucket } from '../rateLimit.js';
import { getOwnAvailability, saveAvailability } from '../../services/availability.js';
import { AvailabilityPage } from '../pages/Availability.js';

function explain(err: unknown, where: string): string {
  if (err instanceof UserError || err instanceof ValidationError) return err.message;
  console.error(`${where} failed:`, err);
  return GENERIC_ERROR;
}

/** A PDS refusing the write for want of scope: the session predates the availability scope. */
function needsReauth(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /scope|insufficient|forbidden|403/i.test(msg);
}

export function availabilityRoutes(deps: Deps, env: { COOKIE_SECRET: string; PUBLIC_URL: string }): Hono {
  const app = new Hono();
  const session: SessionEnv = {
    db: deps.db, cookieSecret: env.COOKIE_SECRET, secure: env.PUBLIC_URL.startsWith('https'),
  };
  // 20 saves per ten minutes per account: a save is two PDS round trips.
  const saveLimiter = new TokenBucket(20, 20 / 600);

  app.get('/availability', async (c) => {
    const who = await readSession(c, session, deps.now().getTime());
    if (!who) return c.redirect('/login?returnTo=%2Favailability');
    let record = null;
    let readFailed = false;
    try {
      record = await getOwnAvailability(deps, who.did);
    } catch (err) {
      console.warn(`own availability read failed for ${who.did}:`, err);
      readFailed = true;
    }
    return page(c, createElement(AvailabilityPage, {
      did: who.did, handle: who.handle ?? undefined, record, readFailed, publicUrl: env.PUBLIC_URL,
    }));
  });

  app.post('/availability', async (c) => {
    const who = await readSession(c, session, deps.now().getTime());
    if (!who) return c.json({ error: 'sign in first' }, 401);
    if (!saveLimiter.allow(who.did, deps.now().getTime())) {
      return c.json({ error: 'easy there. try again in a minute.' }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'malformed request body.' }, 400);
    try {
      const { record, written } = await saveAvailability(deps, who.did, body);
      return c.json({ ok: true, written, sentence: describeWeekly(record.weekly) });
    } catch (err) {
      if (needsReauth(err) && !(err instanceof UserError)) {
        console.error('availability save refused by PDS:', err);
        return c.json({ error: 'sign in again to post your availability (this app needs a new permission).' }, 403);
      }
      return c.json({ error: explain(err, 'saveAvailability') }, 400);
    }
  });

  return app;
}
```

Mount it in `src/web/server.ts` after the poll routes:

```ts
import { availabilityRoutes } from './routes/availability.js';
// ...
app.route('/', availabilityRoutes(deps, env));
```

- [ ] **Step 4: The page shell — `src/web/pages/Availability.tsx`**

```tsx
import type { AvailabilityRecord } from '../../atproto/records.js';
import { describeWeekly } from '../../core/availability.js';
import { useNonce } from '../nonce.js';
import { scriptJson } from '../scriptJson.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Layout, pageTitle } from './Layout.js';

export const AVAILABILITY_SCRIPTS = ['/assets/availability.js'];

export interface AvailabilityPageData {
  did: string;
  handle?: string;
  record: AvailabilityRecord | null;
  /** The live read failed: the editor opens empty and says a save will overwrite. */
  readFailed: boolean;
  publicUrl: string;
}

/** What the island mounts with. The record (or an empty one) plus who the viewer is. */
export function AvailabilityPage(data: AvailabilityPageData) {
  const rec = data.record;
  const islandData = {
    handle: data.handle ?? null,
    timezone: rec?.timezone ?? null,
    weekly: rec?.weekly ?? [],
    away: rec?.away ?? [],
    note: rec?.note ?? '',
    validUntil: rec?.validUntil ? rec.validUntil.slice(0, 10) : '',
  };
  const base = data.publicUrl.replace(/\/$/, '');
  const publicPath = data.handle ? `/u/${data.handle}` : null;
  const webcal = publicPath
    ? `webcal://${base.replace(/^https?:\/\//, '')}${publicPath}/availability.ics` : null;
  return (
    <Layout title={pageTitle('your availability')} scripts={AVAILABILITY_SCRIPTS}>
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="pixel-heading">your availability</h1>
          <p className="text-sm text-muted-foreground">
            {rec ? describeWeekly(rec.weekly) : 'nothing marked yet.'}
          </p>
        </div>
        {data.readFailed && (
          <p className="banner rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            couldn't read your current availability from your pds. saving will overwrite whatever is there.
          </p>
        )}
        <Card>
          <CardHeader>
            <CardTitle>usual week</CardTitle>
            <CardDescription>
              mark when you're generally free. this is a public record in your own repo, like your polls.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <script id="availability-data" type="application/json" nonce={useNonce()}
              dangerouslySetInnerHTML={{ __html: scriptJson(islandData) }} />
            <div id="availability-root" />
          </CardContent>
        </Card>
        {publicPath && (
          <p className="hint text-sm text-muted-foreground">
            friends can see this at{' '}
            <a href={publicPath} className="text-primary underline underline-offset-4">{base.replace(/^https?:\/\//, '')}{publicPath}</a>
            {' '}· <a href={webcal!} className="text-primary underline underline-offset-4">subscribe in your calendar (webcal)</a>
          </p>
        )}
      </div>
    </Layout>
  );
}
```

- [ ] **Step 5: The island — `src/web/islands/availability.tsx`**

The grid mechanics are lifted from `grid.tsx` (its `onDown`/`onUp`/`onMove`/`paintTo`/`startStroke` and the hold-to-mark timer, lines 240–310 there) over a template week. Single mode. The parts that are new are the away list and the details form.

```tsx
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { Interval } from '../../core/intervals.js';
import type { AwayEntry, WeeklyBlock } from '../../atproto/records.js';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint, type PaintMap,
} from '../../core/gridModel.js';
import {
  describeWeekly, templateSlots, weeklyToTemplateIntervals, templateIntervalsToWeekly,
} from '../../core/availability.js';
import { buttonVariants } from '../ui/button.js';
import { cn } from '../lib/cn.js';

interface AvailabilityData {
  handle: string | null;
  timezone: string | null;
  weekly: WeeklyBlock[];
  away: AwayEntry[];
  note: string;
  validUntil: string; // YYYY-MM-DD or ''
}

const HOLD_MS = 350;
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function minutesInZone(iso: string, zone: string): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone,
  }).format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
}
function fmtAxisTime(iso: string, zone: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: zone });
}
function fmtDate(d: string): string {
  return new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function fmtClock(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const hour = ((h + 11) % 12) + 1;
  return `${hour}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
}

function Editor({ data }: { data: AvailabilityData }) {
  const [zone, setZone] = useState(data.timezone
    ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
  const slots = useMemo(() => templateSlots(zone), [zone]);
  const geom = useMemo(() => buildGeom(slots, zone), [slots, zone]);
  const rows = useMemo(() => {
    const byMin = new Map<number, string>();
    for (const keys of geom.columns.values()) for (const k of keys) {
      const min = minutesInZone(k, zone);
      if (!byMin.has(min)) byMin.set(min, k);
    }
    return [...byMin.entries()].sort((a, b) => a[0] - b[0]);
  }, [geom, zone]);
  const colMaps = useMemo(
    () => geom.dates.map((d) => new Map(geom.columns.get(d)!.map((k) => [minutesInZone(k, zone), k]))),
    [geom, zone],
  );

  // Marks live as weekly blocks; the grid is a view of them in the current zone. Changing
  // the zone keeps the wall-clock blocks (a Tuesday 7pm stays a Tuesday 7pm).
  const [weekly, setWeekly] = useState<WeeklyBlock[]>(data.weekly);
  const painted = useMemo<PaintMap>(
    () => intervalsToPaint(weeklyToTemplateIntervals(weekly, zone), [], slots), [weekly, zone, slots]);
  const setPainted = (p: PaintMap) =>
    setWeekly(templateIntervalsToWeekly(paintToIntervals(p, slots, 'available'), zone));

  const [away, setAway] = useState<AwayEntry[]>(data.away);
  const [note, setNote] = useState(data.note);
  const [validUntil, setValidUntil] = useState(data.validUntil);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(JSON.stringify({ weekly: data.weekly, away: data.away, note: data.note, validUntil: data.validUntil, zone: data.timezone }));
  const dirty = savedAt !== JSON.stringify({ weekly, away, note, validUntil, zone });

  // ---- the stroke, as in grid.tsx
  const drag = useRef<{ anchor: string; op: 'add' | 'remove'; base: PaintMap; touch: boolean } | null>(null);
  const press = useRef<{ key: string; timer: number } | null>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  const cancelPress = () => { if (press.current) window.clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => {
    const end = () => { cancelPress(); drag.current = null; };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => { window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
  }, []);
  useEffect(() => {
    const el = gridEl.current;
    if (!el) return;
    const block = (e: TouchEvent) => { if (drag.current?.touch) e.preventDefault(); };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);
  const paintTo = (key: string) => {
    const d = drag.current;
    if (!d) return;
    setPainted(applyPaint(d.base, rectKeys(geom, d.anchor, key), d.op, 'available'));
  };
  const startStroke = (key: string, touch: boolean) => {
    drag.current = { anchor: key, op: strokeOp(painted, key, 'available'), base: painted, touch };
    paintTo(key);
  };
  const onDown = (key: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      cancelPress();
      press.current = { key, timer: window.setTimeout(() => {
        press.current = null; startStroke(key, true);
        try { navigator.vibrate?.(8); } catch { /* not this device */ }
      }, HOLD_MS) };
      return;
    }
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported id */ }
    startStroke(key, false);
  };
  const onUp = (key: string) => () => {
    if (press.current?.key !== key) return;
    cancelPress(); startStroke(key, true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cell = el instanceof Element ? el.closest<HTMLElement>('.cell[data-slot]') : null;
    if (cell?.dataset.slot) paintTo(cell.dataset.slot);
  };

  // ---- away entries
  const [form, setForm] = useState({ start: '', end: '', startTime: '', endTime: '', note: '' });
  const addAway = () => {
    if (!form.start) return;
    const entry: AwayEntry = { start: form.start, end: form.end || form.start };
    if (form.startTime && form.endTime) { entry.startTime = form.startTime; entry.endTime = form.endTime; }
    if (form.note.trim()) entry.note = form.note.trim();
    setAway([...away, entry].sort((a, b) => a.start.localeCompare(b.start)));
    setForm({ start: '', end: '', startTime: '', endTime: '', note: '' });
  };

  const submit = async () => {
    setSaving(true); setStatus(null);
    try {
      const res = await fetch('/availability', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timezone: zone, weekly, away, note, validUntil: validUntil ? `${validUntil}T23:59:59Z` : undefined }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; written?: boolean; error?: string };
      if (!res.ok) { setStatus(out.error ?? 'could not save.'); return; }
      setSavedAt(JSON.stringify({ weekly, away, note, validUntil, zone }));
      setStatus(out.written ? 'availability posted.' : 'nothing changed.');
    } catch {
      setStatus('could not reach the server.');
    } finally { setSaving(false); }
  };

  const cell = (key: string) => (
    <div key={key} className={cn('cell', painted.has(key) && 'available')} data-slot={key}
      title={fmtAxisTime(key, zone)}
      onPointerDown={onDown(key)} onPointerUp={onUp(key)} />
  );

  return (
    <div>
      <p className="hint touch-hint">tap a slot to mark it. hold, then drag, for a block. swipe to scroll.</p>
      <div ref={gridEl} className="grid canvas" onPointerMove={onMove}>
        <div className="col axis">
          <div className="col-head" />
          {rows.map(([min, sample]) => <div key={min} className="axis-label">{fmtAxisTime(sample, zone)}</div>)}
        </div>
        {geom.dates.map((d, ci) => (
          <div className="col" key={d}>
            <div className="col-head"><span className="dow">{DOW[new Date(d + 'T12:00:00Z').getUTCDay()]}</span></div>
            {rows.map(([min]) => {
              const key = colMaps[ci].get(min);
              return key ? cell(key) : <div key={`gap-${min}`} className="cell gap" aria-hidden="true" />;
            })}
          </div>
        ))}
      </div>
      <p className="sentence pixel-label" aria-live="polite">{describeWeekly(weekly)}</p>

      <h3 className="pixel-heading">away</h3>
      <p className="hint">dates that beat the usual week. leave the times empty for all day.</p>
      <ul className="away">
        {away.map((a, i) => (
          <li key={`${a.start}-${a.startTime ?? ''}-${i}`}>
            <span className="when">{a.start === a.end ? fmtDate(a.start) : `${fmtDate(a.start)} – ${fmtDate(a.end)}`}
              {a.startTime && ` · ${fmtClock(a.startTime)}–${fmtClock(a.endTime!)}`}</span>
            {a.note && <span className="note"> {a.note}</span>}
            <button type="button" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
              onClick={() => setAway(away.filter((_, j) => j !== i))}>remove</button>
          </li>
        ))}
        {away.length === 0 && <li className="hint">nothing yet. your usual week stands as-is.</li>}
      </ul>
      <div className="away-form">
        <label>from <input type="date" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
        <label>to <input type="date" value={form.end} min={form.start} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
        <label>between <input type="time" step={1800} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} /></label>
        <label>and <input type="time" step={1800} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} /></label>
        <label>note <input type="text" maxLength={80} placeholder="out of town" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
        <button type="button" className={cn(buttonVariants({ variant: 'secondary' }), 'add-away')} disabled={!form.start} onClick={addAway}>i'm away</button>
      </div>

      <h3 className="pixel-heading">details</h3>
      <label>timezone
        <input type="text" value={zone} list="tz-list" onChange={(e) => setZone(e.target.value)} />
        <datalist id="tz-list">{Intl.supportedValuesOf('timeZone').map((z) => <option key={z} value={z} />)}</datalist>
      </label>
      <label>good through <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></label>
      <label>note for friends <input type="text" maxLength={300} placeholder="text me first, weeknights are flexible" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="note">this record is public, like your polls. anyone with your handle can read it.</p>
      <button type="button" className={cn(buttonVariants({ variant: 'default' }), 'save')} disabled={saving || !dirty} onClick={submit}>post availability</button>
      {status && <p className="status" role="status">{status}</p>}
    </div>
  );
}

const dataEl = document.getElementById('availability-data');
const mount = document.getElementById('availability-root');
if (dataEl?.textContent && mount) {
  createRoot(mount).render(<Editor data={JSON.parse(dataEl.textContent) as AvailabilityData} />);
}
```

`Intl.supportedValuesOf` needs `lib: ["es2022"]` or later in `tsconfig.json`; if typecheck complains, cast: `(Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone')`.

- [ ] **Step 6: Build script and CSS scope**

`package.json`:

```json
"build:availability": "esbuild src/web/islands/availability.tsx --bundle --minify --format=esm --jsx=automatic --jsx-import-source=react --outfile=public/assets/availability.js",
"build:client": "npm run build:grid && npm run build:createform && npm run build:login && npm run build:availability && npm run build:css"
```

`src/web/styles/app.css`: change the two scope selectors so the editor shares the grid rules:

- line ~350: `#grid-root, #reply-root {` → `#grid-root, #reply-root, #availability-root {`
- the `.status` block: `:is(#grid-root, #reply-root) .status` → `:is(#grid-root, #reply-root, #availability-root) .status`

Then add, inside the same `@layer island` block at the end:

```css
  #availability-root {
    .sentence { margin: 12px 0 18px; font-size: 12px; color: var(--primary); }
    .away { list-style: none; padding: 0; margin: 8px 0; display: grid; gap: 6px; }
    .away li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
    .away .when { font-weight: 600; font-variant-numeric: tabular-nums; }
    .away .note { color: var(--muted-foreground); }
    .away-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; align-items: end; margin-bottom: 18px; }
    .away-form label, .away-form input { margin: 0; }
    .save { margin-top: 12px; }
  }
```

Run `npm run build:client` once to confirm the bundle builds.

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run tests/web && npm run typecheck && npm run build:client`
Expected: PASS; `public/assets/availability.js` exists.

- [ ] **Step 8: Commit**

```bash
git add src/web/routes/availability.ts src/web/pages/Availability.tsx src/web/islands/availability.tsx src/web/server.ts src/web/styles/app.css package.json tests/web/availabilityRoutes.test.ts
git commit -m "feat(availability): editor page, save route, and grid island over a template week

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The friend view and the feed

**Files:**
- Modify: `src/web/routes/availability.ts` (add two public routes)
- Create: `src/web/pages/PublicAvailability.tsx`
- Test: `tests/web/publicAvailability.test.ts`

**Interfaces:**
- Consumes: `getAvailabilityCached` (Task 6), `buildAvailabilityIcs` (Task 4), `describeWeekly`, `isStale`, `freeIntervals` (Tasks 2–3), `Deps.resolveDid` (Task 7), `clientIp`, `TokenBucket`.
- Produces: `GET /u/:handle` (HTML), `GET /u/:handle/availability.ics` (`text/calendar`). In fake mode (no `deps.resolveDid`), a `did:` literal in the handle position is accepted.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/publicAvailability.test.ts
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const KEN = 'did:plc:ken';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: KEN }),
  restore: async () => { throw new Error('not used'); },
};
const rec = {
  $type: AVAILABILITY_NSID, timezone: 'America/New_York',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' }],
  away: [{ start: '2026-09-19', end: '2026-09-21', note: 'out of town' }],
  note: 'text first', validUntil: '2026-12-31T23:59:59.000Z', updatedAt: '2026-09-10T12:00:00.000Z',
};

function setup(resolveDid?: Deps['resolveDid']) {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'), revalidateTtlMs: 0, resolveDid,
  };
  const app = createServer(deps, stubAuth, { COOKIE_SECRET: 's', PUBLIC_URL: 'http://localhost:8787' });
  return { app, deps, repo };
}

describe('/u/:handle', () => {
  it('renders the sentence, away entries, note and freshness for a resolved handle', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null));
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const res = await app.request('/u/ken.wzrdz.cool');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ken.wzrdz.cool');
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain('out of town');
    expect(html).toContain('text first');
    expect(html).toContain('good through');
    expect(html).toContain('/u/ken.wzrdz.cool/availability.ics');
  });
  it('accepts a did literal when no resolver is configured (fake mode)', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    expect((await app.request(`/u/${KEN}`)).status).toBe(200);
  });
  it('says so when there is no record, and 404s an unknown handle', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null));
    const none = await app.request('/u/ken.wzrdz.cool');
    expect(none.status).toBe(200);
    expect(await none.text()).toContain('no availability posted');
    expect((await app.request('/u/nobody.example')).status).toBe(404);
  });
  it('reads an expired record as unknown', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, { ...rec, validUntil: '2026-09-01T00:00:00.000Z' });
    const html = await (await app.request(`/u/${KEN}`)).text();
    expect(html).toContain('treat as unknown and ask');
  });
  it('503s when the pds is down and nothing is cached', async () => {
    const { app, repo } = setup();
    vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('down'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await app.request(`/u/${KEN}`)).status).toBe(503);
    } finally { warned.mockRestore(); errored.mockRestore(); }
  });
  it('serves the feed as text/calendar', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const res = await app.request(`/u/${KEN}/availability.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('cache-control')).toContain('max-age=900');
    const body = await res.text();
    expect(body).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
    expect(body).toContain('SUMMARY:away · out of town');
    expect((await app.request('/u/did:plc:nobody/availability.ics')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/web/publicAvailability.test.ts`
Expected: FAIL — 404 everywhere.

- [ ] **Step 3: Add the public routes to `src/web/routes/availability.ts`**

Add imports:

```ts
import { clientIp } from '../clientIp.js';
import { buildAvailabilityIcs } from '../../core/ics.js';
import { getAvailabilityCached } from '../../services/availability.js';
import { PublicAvailabilityPage } from '../pages/PublicAvailability.js';
import { ErrorPage } from '../pages/ErrorPage.js';
```

Inside `availabilityRoutes`, after the save route:

```ts
  // 120 public reads per ten minutes per address: each cold read is a PDS round trip.
  const readLimiter = new TokenBucket(120, 120 / 600);

  /** The DID behind `/u/<handle>`, or null. Fake mode has no resolver and takes a DID literal. */
  const didFor = async (handle: string): Promise<string | null> => {
    if (handle.startsWith('did:')) return /^did:(plc|web):[a-zA-Z0-9._:%-]+$/.test(handle) ? handle : null;
    return deps.resolveDid ? deps.resolveDid(handle) : null;
  };

  /** Resolve + read, or the response that says why not. Shared by the page and the feed. */
  const lookup = async (c: import('hono').Context) => {
    if (!readLimiter.allow(clientIp(c), deps.now().getTime())) {
      return { deny: page(c, createElement(ErrorPage, { heading: 'slow down', message: 'easy there. try again in a minute.' }), 429) };
    }
    const handle = c.req.param('handle');
    const did = await didFor(handle);
    if (!did) return { deny: c.notFound() };
    try {
      return { handle, did, record: await getAvailabilityCached(deps, did) };
    } catch (err) {
      console.error(`availability read failed for ${did}:`, err);
      return { deny: page(c, createElement(ErrorPage, {
        heading: 'their pds is not answering', message: "couldn't reach their pds right now. try again in a minute.",
      }), 503) };
    }
  };

  app.get('/u/:handle', async (c) => {
    const r = await lookup(c);
    if ('deny' in r) return r.deny;
    return page(c, createElement(PublicAvailabilityPage, {
      handle: r.handle, did: r.did, record: r.record, now: deps.now(), publicUrl: env.PUBLIC_URL,
    }));
  });

  app.get('/u/:handle/availability.ics', async (c) => {
    const r = await lookup(c);
    if ('deny' in r) return r.deny;
    if (!r.record) return c.notFound();
    const ics = buildAvailabilityIcs(r.record, {
      uidHost: new URL(env.PUBLIC_URL).host, name: r.handle, now: deps.now(),
    });
    return c.body(ics, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'public, max-age=900',
    });
  });
```

- [ ] **Step 4: The page — `src/web/pages/PublicAvailability.tsx`**

```tsx
import type { AvailabilityRecord } from '../../atproto/records.js';
import { describeWeekly, freeIntervals, isStale } from '../../core/availability.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Layout, pageTitle } from './Layout.js';

export interface PublicAvailabilityData {
  handle: string;
  did: string;
  record: AvailabilityRecord | null;
  now: Date;
  publicUrl: string;
}

const fmtDate = (d: string) => new Date(d + 'T12:00:00Z')
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtClock = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
};
const daysAgo = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

/**
 * Fourteen days from today in the record's zone, each with the fraction of the 7am–midnight
 * day the record calls free, and whether an away entry covers it. Rendered as a row of bars.
 */
function strip(rec: AvailabilityRecord, now: Date) {
  const todayIso = now.toLocaleDateString('en-CA', { timeZone: rec.timezone }); // YYYY-MM-DD
  const days: Array<{ date: string; dow: string; free: number; away: boolean }> = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(`${todayIso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const ivs = freeIntervals(rec, date, date);
    const minutes = ivs.reduce((n, iv) => n + (new Date(iv.end).getTime() - new Date(iv.start).getTime()) / 60_000, 0);
    days.push({
      date, dow: d.toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' }),
      free: Math.min(1, minutes / (17 * 60)),
      away: rec.away.some((a) => !a.startTime && a.start <= date && date <= a.end),
    });
  }
  return days;
}

export function PublicAvailabilityPage(data: PublicAvailabilityData) {
  const path = `/u/${data.handle}`;
  const base = data.publicUrl.replace(/\/$/, '');
  const rec = data.record;
  const stale = rec ? isStale(rec, data.now) : false;
  const upcoming = rec ? rec.away.filter((a) => a.end >= data.now.toISOString().slice(0, 10)) : [];
  return (
    <Layout
      title={pageTitle(`${data.handle} · availability`)}
      description={rec ? describeWeekly(rec.weekly) : 'no availability posted.'}
      canonical={`${base}${path}`}
    >
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="pixel-heading">{data.handle}</h1>
          {rec && <p className="text-sm text-muted-foreground">times in {rec.timezone}</p>}
        </div>
        {!rec ? (
          <Card><CardContent><p className="hint text-sm text-muted-foreground">no availability posted. ask them.</p></CardContent></Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{stale ? 'this might be out of date' : describeWeekly(rec.weekly)}</CardTitle>
              <CardDescription>
                {stale
                  ? `expired ${fmtDate(rec.validUntil!.slice(0, 10))}. treat as unknown and ask.`
                  : `updated ${daysAgo(rec.updatedAt, data.now) === 0 ? 'today' : `${daysAgo(rec.updatedAt, data.now)} days ago`}`
                    + (rec.validUntil ? ` · good through ${fmtDate(rec.validUntil.slice(0, 10))}` : '')}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {stale && <p className="text-sm text-muted-foreground">last they said: {describeWeekly(rec.weekly)}</p>}
              {upcoming.length > 0 && (
                <div className="grid gap-1">
                  <p className="pixel-label text-muted-foreground">away</p>
                  <ul className="grid gap-1 text-sm">
                    {upcoming.map((a, i) => (
                      <li key={i} className="tabular-nums">
                        <strong>{a.start === a.end ? fmtDate(a.start) : `${fmtDate(a.start)} – ${fmtDate(a.end)}`}</strong>
                        {a.startTime && ` ${fmtClock(a.startTime)}–${fmtClock(a.endTime!)}`}
                        {a.note && <span className="text-muted-foreground"> · {a.note}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rec.note && <p className="text-sm">{rec.note}</p>}
              {!stale && (
                <div className="grid gap-1">
                  <p className="pixel-label text-muted-foreground">next two weeks</p>
                  <div className="strip grid grid-cols-14 gap-1" style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}>
                    {strip(rec, data.now).map((d) => (
                      <div key={d.date} className="grid gap-1 text-center text-[10px] text-muted-foreground" title={`${fmtDate(d.date)}${d.away ? ' · away' : ''}`}>
                        <div className="relative h-7 overflow-hidden rounded border border-border bg-muted">
                          {d.away
                            ? <div className="absolute inset-0 bg-destructive/30" />
                            : <div className="absolute inset-x-0 bottom-0 bg-primary" style={{ height: `${Math.round(d.free * 100)}%` }} />}
                        </div>
                        <span>{d.dow}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="hint text-sm text-muted-foreground">
                <a href={`${path}/availability.ics`} className="text-primary underline underline-offset-4">download .ics</a>
                {' '}·{' '}
                <a href={`webcal://${base.replace(/^https?:\/\//, '')}${path}/availability.ics`} className="text-primary underline underline-offset-4">subscribe (webcal)</a>
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/availability.ts src/web/pages/PublicAvailability.tsx tests/web/publicAvailability.test.ts
git commit -m "feat(availability): public /u/<handle> page and ics feed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Pre-mark a poll from the record

**Files:**
- Modify: `src/web/routes/polls.ts` (`renderPoll`, the `else if (viewerDid)` branch)
- Modify: `src/web/pages/Poll.tsx` (`PollPageData.prefill`, `gridData`)
- Modify: `src/web/islands/grid.tsx` (`PollData.prefill`, `saved`, `canvas`, the hint)
- Test: `tests/web/pollPrefill.test.ts`

**Interfaces:**
- Consumes: `prefillForPoll(deps, did, slots)` (Task 6).
- Produces: `prefill.source?: 'availability'` on the poll page data and the island data. When set, the island treats the marks as unsaved and shows the hint `marked from your availability. fix what's off, then save.`

- [ ] **Step 1: Write the failing test**

```ts
// tests/web/pollPrefill.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { createPoll } from '../../src/services/polls.js';
import { saveAvailability } from '../../src/services/availability.js';
import { submitAccountResponse } from '../../src/services/responses.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const HOST = 'did:plc:host';
const ME = 'did:plc:me';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: ME }),
  restore: async () => { throw new Error('not used'); },
};
// 2026-10-13 is a Tuesday, 2026-10-15 a Thursday.
const time = {
  dates: ['2026-10-13', '2026-10-15'], window: { start: '19:00', end: '21:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'),
  };
  const app = createServer(deps, stubAuth, { COOKIE_SECRET: 's', PUBLIC_URL: 'http://localhost:8787', devLogin: true });
  const poll = await createPoll(deps, HOST, { title: 'Book club', time });
  const cookie = (await app.request(`/dev/login?did=${ME}`)).headers.get('set-cookie')!.split(';')[0];
  return { app, deps, poll, cookie };
}

const islandData = (html: string) => {
  const m = html.match(/<script id="poll-data"[^>]*>([^<]*)<\/script>/);
  return JSON.parse(m![1].replace(/\\u003c/g, '<')) as { prefill?: { available: unknown[]; source?: string } };
};

describe('poll prefill from availability', () => {
  it('pre-marks a signed-in viewer with no response yet', async () => {
    const { app, deps, poll, cookie } = await setup();
    await saveAvailability(deps, ME, { timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] });
    const html = await (await app.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    const data = islandData(html);
    expect(data.prefill?.source).toBe('availability');
    expect(data.prefill?.available).toEqual([{ start: '2026-10-13T19:00:00.000Z', end: '2026-10-13T21:00:00.000Z' }]);
  });
  it('prefers a saved response over the record', async () => {
    const { app, deps, poll, cookie } = await setup();
    await saveAvailability(deps, ME, { timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] });
    await submitAccountResponse(deps, ME, poll.rkey, {
      available: [{ start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T19:30:00.000Z' }],
    });
    const data = islandData(await (await app.request(`/p/${poll.rkey}`, { headers: { cookie } })).text());
    expect(data.prefill?.source).toBeUndefined();
    expect(data.prefill?.available).toEqual([{ start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T19:30:00.000Z' }]);
  });
  it('sends no prefill when the record has nothing for this poll, or when signed out', async () => {
    const { app, deps, poll, cookie } = await setup();
    await saveAvailability(deps, ME, { timezone: 'UTC', weekly: [{ day: 6, start: '19:00', end: '22:00' }], away: [] });
    expect(islandData(await (await app.request(`/p/${poll.rkey}`, { headers: { cookie } })).text()).prefill).toBeUndefined();
    expect(islandData(await (await app.request(`/p/${poll.rkey}`)).text()).prefill).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/web/pollPrefill.test.ts`
Expected: FAIL — `prefill.source` undefined in the first test.

- [ ] **Step 3: Route — `src/web/routes/polls.ts`**

Import `prefillForPoll` from `'../../services/availability.js'`. Widen the local `prefill` variable's type and extend the signed-in branch:

```ts
    let prefill: { available: Interval[]; ifNeedBe: Interval[]; name?: string; source?: 'availability' } | undefined;
    // ...
    } else if (viewerDid) {
      const row = listResponseCache(deps.db, rkey)
        .find((r) => r.source === 'account' && r.key === viewerDid);
      if (row) {
        prefill = { available: row.record.available, ifNeedBe: row.record.ifNeedBe ?? [] };
        self = results.responses.find((r) => r.source === 'account' && r.key === viewerDid)?.who;
      } else if (results.poll.record.status === 'active' && viewerDid !== results.poll.hostDid) {
        // No answer yet: their standing availability marks the grid for them to fix and save.
        // `null` (no record, expired, or unreachable) and an empty match both mean no prefill.
        const marked = await prefillForPoll(deps, viewerDid, results.slots);
        if (marked && marked.length > 0) prefill = { available: marked, ifNeedBe: [], source: 'availability' };
      }
    }
```

- [ ] **Step 4: Page — `src/web/pages/Poll.tsx`**

Change the `prefill` field type in `PollPageData` to
`prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string; source?: 'availability' };`.
`gridData` already passes `prefill: data.prefill` through unchanged.

- [ ] **Step 5: Island — `src/web/islands/grid.tsx`**

Same type change on `PollData.prefill`. Then, where `saved` is computed:

```ts
  // What the server already has for this viewer. Marks that came from their standing
  // availability are a suggestion, not a saved answer: `saved` stays empty so the save
  // button lights up at once and the cells draw as unsaved marks.
  const fromAvailability = data.prefill?.source === 'availability';
  const saved = useMemo<PaintMap>(() =>
    data.prefill && !fromAvailability
      ? intervalsToPaint(data.prefill.available, data.prefill.ifNeedBe, data.slots)
      : new Map(), []);
  const suggested = useMemo<PaintMap>(() =>
    fromAvailability ? intervalsToPaint(data.prefill!.available, [], data.slots) : new Map(), []);
  // ...
  const [painted, setPainted] = useState<PaintMap>(draft?.paint ?? (fromAvailability ? suggested : saved));
```

The `canvas` expression `(!paintEquals(painted, saved) || !data.prefill)` already yields true for a suggestion (painted differs from the empty `saved`). Above the grid, next to the touch hint:

```tsx
      {!locked && fromAvailability && (
        <p className="hint from-availability">marked from your availability. fix what's off, then save.</p>
      )}
```

- [ ] **Step 6: Run the tests, typecheck, rebuild the island**

Run: `npx vitest run tests/web && npm run typecheck && npm run build:grid`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/polls.ts src/web/pages/Poll.tsx src/web/islands/grid.tsx tests/web/pollPrefill.test.ts
git commit -m "feat(availability): pre-mark a poll from the viewer's standing record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The landing block

**Files:**
- Modify: `src/web/pages/Landing.tsx` (props and the signed-in branch)
- Modify: `src/web/routes/polls.ts:76-91` (the `/` route)
- Test: extend `tests/web/server.test.ts`

**Interfaces:**
- Consumes: `getAvailabilityCached` (Task 6), `describeWeekly`, `isStale` (Task 2).
- Produces: `LandingPage` prop `availability?: { sentence: string; stale: boolean; handle?: string } | null` — `null` for "no record", `undefined` when signed out.

- [ ] **Step 1: Write the failing test**

Add to `tests/web/server.test.ts` (reuse its `setup`, and sign in through `devLogin: true` as `tests/web/availabilityRoutes.test.ts` does; if the existing `setup` does not pass `devLogin`, add a second helper in this file):

```ts
  it('shows the signed-in viewer their availability block', async () => {
    const { app, deps } = await setup();
    const cookie = (await app.request(`/dev/login?did=${HOST}&handle=host.test`)).headers.get('set-cookie')!.split(';')[0];
    let html = await (await app.request('/', { headers: { cookie } })).text();
    expect(html).toContain('your availability');
    expect(html).toContain('nothing marked yet');
    expect(html).toContain('href="/availability"');
    await saveAvailability(deps, HOST, { timezone: 'UTC', weekly: [{ day: 1, start: '09:00', end: '12:00' }], away: [] });
    html = await (await app.request('/', { headers: { cookie } })).text();
    expect(html).toContain('usually free mondays 9am to 12pm.');
    expect(html).toContain('href="/u/host.test"');
  });
```

(import `saveAvailability` from `../../src/services/availability.js`).

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/web/server.test.ts`
Expected: FAIL — "your availability" not in the page.

- [ ] **Step 3: Route**

In the `/` handler in `src/web/routes/polls.ts`, before `return page(...)`:

```ts
    let availability: { sentence: string; stale: boolean; handle?: string } | null | undefined;
    if (did) {
      try {
        const rec = await getAvailabilityCached(deps, did);
        availability = rec
          ? { sentence: describeWeekly(rec.weekly), stale: isStale(rec, deps.now()), handle: who?.handle ?? undefined }
          : null;
      } catch (err) {
        console.warn(`landing availability read failed for ${did}:`, err);
        availability = null;
      }
    }
```

and pass `availability` into `LandingPage`. Import `getAvailabilityCached` from `'../../services/availability.js'` and `describeWeekly, isStale` from `'../../core/availability.js'`.

- [ ] **Step 4: Page**

Add the prop to `LandingPage`'s props type and render, between the "your polls" card and the "polls you answered" block:

```tsx
        <div className="availability grid gap-3">
          <h2 className="pixel-heading">your availability</h2>
          <Card>
            <CardContent className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-sm">
                {availability ? availability.sentence : 'nothing marked yet.'}
                {availability?.stale && <span className="text-muted-foreground"> (out of date)</span>}
              </p>
              <p className="text-sm">
                <a href="/availability" className="text-primary underline underline-offset-4">
                  {availability ? 'update' : 'mark your week'}
                </a>
                {availability?.handle && (
                  <>{' '}· <a href={`/u/${availability.handle}`} className="text-primary underline underline-offset-4">your public page</a></>
                )}
              </p>
            </CardContent>
          </Card>
        </div>
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/web && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/pages/Landing.tsx src/web/routes/polls.ts tests/web/server.test.ts
git commit -m "feat(availability): the landing shows your sentence and links to edit and share

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: End-to-end

**Files:**
- Create: `e2e/availability.spec.ts`

**Interfaces:**
- Consumes: the dev sign-in route, the editor at `/availability`, the poll create helper pattern from `e2e/poll.spec.ts` (copy `pickDate`, `setTime`, `createPoll`, `FIXTURE_DATE_*` into this file rather than importing: the spec files are independent).

- [ ] **Step 1: Write the test**

```ts
// e2e/availability.spec.ts
import { test, expect, type Page } from '@playwright/test';

// ---- copied from poll.spec.ts: isoDate, isWeekday, FIXTURE_BASE, FIXTURE_DATE_1, pickDate,
// ---- setTime, createPoll. Paste them here verbatim.

async function markCells(page: Page, root: string, from: number, to: number) {
  const cells = page.locator(`${root} [data-slot]`);
  await expect(cells.first()).toBeVisible();
  const a = (await cells.nth(from).boundingBox())!;
  const b = (await cells.nth(to).boundingBox())!;
  if (test.info().project.use.hasTouch) {
    for (let i = from; i <= to; i++) {
      const box = (await cells.nth(i).boundingBox())!;
      await page.touchscreen.tap(box.x + 5, box.y + 5);
    }
  } else {
    await page.mouse.move(a.x + 5, a.y + 5);
    await page.mouse.down();
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.up();
  }
}

test('mark a week, go away, see it public, answer a poll pre-marked', async ({ page }) => {
  const did = `did:plc:e2eavail${test.info().project.name.replace(/[^a-z0-9]/gi, '')}`;
  await page.goto(`/dev/login?did=${did}&handle=avail.test`);

  // The landing offers the block.
  await expect(page.getByRole('heading', { name: 'your availability' })).toBeVisible();
  await page.click('a[href="/availability"]');

  // Mark Sunday 7:00–8:00 (the first two cells of the first column) and read it back.
  await markCells(page, '#availability-root', 0, 1);
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .sentence')).toHaveText('usually free sundays 7am to 8am.');

  // Away on the fixture date, all day, with a note.
  await page.fill('#availability-root .away-form input[type=date] >> nth=0', FIXTURE_DATE_1);
  await page.fill('#availability-root .away-form input[type=text]', 'out of town');
  await page.click('#availability-root button.add-away');
  await expect(page.locator('#availability-root .away li')).toContainText('out of town');

  // Timezone is what the grid was drawn in; the browser is pinned to UTC in the config.
  await page.fill('#availability-root input[list=tz-list]', 'UTC');
  await page.click('#availability-root button.save');
  await expect(page.locator('#availability-root .status')).toHaveText('availability posted.');

  // Reload keeps it.
  await page.reload();
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .away li')).toContainText('out of town');

  // The public page reads the same record.
  await page.goto(`/u/${did}`);
  await expect(page.getByText('usually free sundays 7am to 8am.')).toBeVisible();
  await expect(page.getByText('out of town')).toBeVisible();
  const ics = await page.request.get(`/u/${did}/availability.ics`);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  expect(await ics.text()).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU');

  // A poll on the next Sunday, 7–9am UTC, hosted by someone else (hosts never get the
  // canvas): sign in as a second account to create it, then back as `did` to answer.
  const sunday = (() => {
    const d = new Date(`${FIXTURE_DATE_1}T12:00:00Z`);
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  await page.goto(`/dev/login?did=${did}host`);
  const pollUrl = await createPoll(page, {
    title: 'Sunday coffee', dates: sunday, windowStart: '07:00', windowEnd: '09:00', slotMinutes: '30',
  });
  await page.goto(`/dev/login?did=${did}`);
  await page.goto(pollUrl);
  await expect(page.locator('#grid-root .from-availability'))
    .toHaveText("marked from your availability. fix what's off, then save.");
  await expect(page.locator('#grid-root .cell.available')).toHaveCount(2);
  await expect(page.locator('button.save')).toBeEnabled();
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test e2e/availability.spec.ts`
Expected: PASS on every project. If the touch project fails on `markCells`, the taps are landing on the same cell twice: add a 100ms `page.waitForTimeout` between taps, as the hold timer is 350ms and a second tap within it is read as a hold.

- [ ] **Step 3: Commit**

```bash
git add e2e/availability.spec.ts
git commit -m "test(e2e): mark a week, go away, read it public, answer a poll pre-marked

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Docs and the stale note

**Files:**
- Modify: `docs/deploy.md` (§5 smoke test; §1 environment table needs nothing new)
- Modify: `src/services/polls.ts:170-174`

- [ ] **Step 1: Smoke test steps**

Append to the numbered list in `docs/deploy.md` §5:

```markdown
8. Open `/availability`, mark a couple of blocks, add an away day, post. Verify the record
   landed at rkey `self`:

   ```bash
   curl -s 'https://<your-pds>/xrpc/com.atproto.repo.getRecord?repo=<your-did>&collection=lol.letsmeet.availability&rkey=self' | jq .
   ```

9. Open `https://letsmeet.lol/u/<your-handle>` in a private window and confirm the sentence,
   the away entry and the feed link. Subscribe to the `webcal:` link from a calendar app and
   confirm the weekly blocks appear on the right weekday at the right local time.
10. Open an active poll you have not answered while signed in and confirm the grid arrives
    pre-marked with the hint "marked from your availability."
11. Publish the new lexicon: `npx tsx scripts/publishLexicons.ts` with `LEX_HANDLE` and
    `LEX_APP_PASSWORD` set (see §1). `_lexicon.letsmeet.lol` already resolves to the authority
    DID, so no DNS change.
```

Also add one sentence under the `DB_PATH` paragraph: `availability_cache` is rebuilt on any read, so its loss costs nothing.

- [ ] **Step 2: Retire the implementer note in `finalizePoll`**

Replace the `// NOTE for the implementer: ...` comment block (three lines) in `src/services/polls.ts` with:

```ts
  // Field names checked against the published community.lexicon.calendar.event schema on
  // 2026-09-16: name, description, startsAt, endsAt, createdAt all match.
```

- [ ] **Step 3: Typecheck, full test run, commit**

Run: `npm run typecheck && npm test`
Expected: PASS.

```bash
git add docs/deploy.md src/services/polls.ts
git commit -m "docs: smoke-test the availability record; retire the event-schema note

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15 (optional): `<handle>.sez.letsmeet.lol`

Do this only after Tasks 1–14 are deployed and the `/u/` pages are confirmed working in production. It changes the deploy from nginx to Caddy for one host.

**Files:**
- Modify: `src/web/routes/availability.ts` (host-based dispatch, TLS ask endpoint)
- Create: `deploy/Caddyfile`
- Modify: `docs/deploy.md` §3
- Test: extend `tests/web/publicAvailability.test.ts`

- [ ] **Step 1: Tests**

```ts
  it('serves the friend view and feed on <handle>.sez.letsmeet.lol', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const html = await (await app.request('/', { headers: { host: 'ken.wzrdz.cool.sez.letsmeet.lol' } })).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain('<link rel="canonical" href="https://letsmeet.lol/u/ken.wzrdz.cool"');
    const ics = await app.request('/availability.ics', { headers: { host: 'ken.wzrdz.cool.sez.letsmeet.lol' } });
    expect(ics.headers.get('content-type')).toContain('text/calendar');
  });
  it('answers caddy\'s ask endpoint only for handles that resolve', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    expect((await app.request('/internal/tls-ask?domain=ken.wzrdz.cool.sez.letsmeet.lol')).status).toBe(200);
    expect((await app.request('/internal/tls-ask?domain=nobody.example.sez.letsmeet.lol')).status).toBe(404);
    expect((await app.request('/internal/tls-ask?domain=evil.example')).status).toBe(404);
  });
```

(`setup` gains an optional second argument for `PUBLIC_URL`.)

- [ ] **Step 2: Routes**

In `availabilityRoutes`, derive `const aliasSuffix = '.sez.' + new URL(env.PUBLIC_URL).host;` and add, before the `/u/:handle` routes, a middleware that rewrites alias requests:

```ts
  /** `<handle>.sez.<site>`: the handle is every label before the suffix, verbatim. */
  const aliasHandle = (host: string | undefined): string | null =>
    host && host.endsWith(aliasSuffix) && host.length > aliasSuffix.length
      ? host.slice(0, -aliasSuffix.length) : null;

  app.get('/', async (c, next) => {
    const handle = aliasHandle(c.req.header('host'));
    if (!handle) return next();
    return app.fetch(new Request(new URL(`/u/${handle}`, env.PUBLIC_URL), { headers: c.req.raw.headers }));
  });
  app.get('/availability.ics', async (c, next) => {
    const handle = aliasHandle(c.req.header('host'));
    if (!handle) return next();
    return app.fetch(new Request(new URL(`/u/${handle}/availability.ics`, env.PUBLIC_URL), { headers: c.req.raw.headers }));
  });

  /** Caddy's on-demand TLS `ask`: issue a certificate only for a handle that resolves. */
  app.get('/internal/tls-ask', async (c) => {
    const handle = aliasHandle(c.req.query('domain'));
    if (!handle) return c.text('no', 404);
    return (await didFor(handle)) ? c.text('ok') : c.text('no', 404);
  });
```

The friend view's `canonical` already points at `/u/<handle>` on `PUBLIC_URL`, so the alias needs no page change. Because the session cookie is scoped to the apex, the alias never sees a session, which is the intent.

- [ ] **Step 3: Caddy**

`deploy/Caddyfile`:

```
letsmeet.lol {
  reverse_proxy 127.0.0.1:8787
}
*.sez.letsmeet.lol {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:8787
}
{
  on_demand_tls {
    ask http://127.0.0.1:8787/internal/tls-ask
  }
}
```

Note the global block must come first in a real Caddyfile; reorder when writing the file. In `docs/deploy.md` §3, document: one wildcard A record `*.sez.letsmeet.lol` (DNS wildcards match multiple labels, so `ken.wzrdz.cool.sez.letsmeet.lol` is covered), Caddy replacing nginx for TLS termination, and that `/internal/tls-ask` must not be reachable from outside (bind the app to loopback; Caddy is the only client).

- [ ] **Step 4: Run, typecheck, commit**

Run: `npx vitest run tests/web && npm run typecheck`

```bash
git add src/web/routes/availability.ts deploy/Caddyfile docs/deploy.md tests/web/publicAvailability.test.ts
git commit -m "feat(availability): <handle>.sez.letsmeet.lol alias with on-demand tls

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Plan Self-Review Notes (already applied)

- **Spec coverage.** Lexicon → T1. Normalize rules, sentence, stale → T2. freeIntervals/prefill → T3. Feed → T4. Cache → T5. Save/no-op/own read/cached read/prefill service → T6. Handle resolution and fake-mode DID literal → T7. OAuth scope and "sign in again" → T8. Editor, save route, island, public-record line, webcal link → T9. Friend view, strip, staleness line, 503/404 → T10. Poll prefill with hint and unsaved marks → T11. Landing block → T12. E2E → T13. Smoke test, stale finalize note → T14. Host alias → T15 (optional, as the spec says).
- **Type consistency.** `AvailabilityInput` (core) vs `AvailabilityRecord` (records): the record is the input plus `$type` and `updatedAt`; `buildAvailabilityIcs` takes `AvailabilityInput & { updatedAt }` so both shapes fit. `prefill.source` is the literal `'availability'` in route, page and island alike. `didFor` is defined in T10 and reused by T15.
- **Known simplification in T9.** The island stores marks as `WeeklyBlock[]` and re-derives the `PaintMap` on every stroke; on a 7×34 grid that is trivial. If a drag ever stutters, memoize `weeklyToTemplateIntervals` per stroke instead of per render.
