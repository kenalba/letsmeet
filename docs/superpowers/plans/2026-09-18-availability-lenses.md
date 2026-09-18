# Availability lenses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One availability grid with two lenses — the usual week (no dates, marks mean free) and any real week (dates, marks mean away) — everything autosaved, notes drawn inside their own away block, and a mobile pass on both the editor and the friend view.

**Architecture:** The record's shape does not change. New pure core modules do the work the island used to do with a form: `awayDays.ts` expands the record's away ranges into a per-date day map, the dated page edits that map, and `compactAway` folds it back into ranges while leaving every date outside the shown week alone. `weekNoteZones` (in `weekView.ts`) turns away entries into rectangles both pages draw a note label inside, and `labelFit.ts` decides each label's orientation — the friend view runs the same function from a nonce-tagged inline script built out of `fitLabel.toString()`, so there is one rule and no drift. The editor island gains a page pager, a week picker, a note chip and a 2-second autosave; the post button and the away form go.

**Tech Stack:** TypeScript, Hono, React 19 server rendering (`renderToString`), a React island bundled by esbuild, luxon, better-sqlite3, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-18-availability-lenses-design.md`
**Mock (authoritative where the two disagree):** `docs/superpowers/specs/2026-09-18-availability-lenses-mock.html` — read its `<script>` for the exact behaviour and its `<style>` for the values copied below. The mock marks by the hour over hour-sized sets; the record is half-hour `HH:MM` strings, so everything here is translated.

---

## Global Constraints

- **Node.** `export PATH=~/.nvm/versions/node/v24.19.0/bin:$PATH` before any `npm`/`npx` command in this checkout. The default node 20 cannot load the app's undici; `better-sqlite3` is already rebuilt for node 24 here.
- **Commands.** `npm test` (vitest, whole suite, ~3s), `npx vitest run tests/core/foo.test.ts` for one file, `npm run typecheck`, `npm run build:client` (esbuild + tailwind — required before any e2e run), `npx playwright test e2e/availability.spec.ts --project=chromium`. Playwright starts its own server on 8787 with `FAKE_PDS=1`; port 8787 must be free (`lsof -ti:8787` prints nothing).
- **Baseline.** `npm test` is green at the start of this plan: 43 files, 464 tests. Keep it green at every commit.
- Copy is lowercase, in the site's voice (`posted.`, `copy link`, `+ note`, `remove`).
- Every inline script carries the response nonce via `useNonce()` (CSP is `script-src 'self' 'nonce-…'`).
- Server-rendered pages must work without JavaScript: buttons a script reveals are rendered `hidden`; links work on their own.
- The alias host `<name>.sez.<site>` answers only `/` and `/availability.ics`; links to anything else on the friend view are absolute to `PUBLIC_URL`.
- **Inside `#availability-root`, never use the `<Button>` component** — it stamps `data-slot="button"`, and `[data-slot]` is how the grid's cells (and the e2e) are found. Use `cn(buttonVariants({…}))` class strings, as the island already does.
- Deploy is automatic on push to `main` via GitHub Actions. This plan ends with the branch (`availability-lenses`) ready to merge — do not push.
- Commit messages end with a blank line and then `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

**Created**
- `src/core/awayDays.ts` — the per-date day map the dated page edits: `expandAway`, `compactAway`, `toggleAllDay`, `paintAway`.
- `src/core/labelFit.ts` — `fitLabel(text, w, h, font)`: which orientation and how many lines a note label fits in.
- `src/web/pages/zoneLabels.ts` — `ZONE_LABEL_SCRIPT`, the friend view's nonce-tagged label classifier, built from `fitLabel.toString()`.
- `tests/core/awayDays.test.ts`, `tests/core/labelFit.test.ts`.

**Modified**
- `src/core/availability.ts` — `TEMPLATE_SUNDAY` becomes `TEMPLATE_MONDAY`, `templateDates`/`templateDateFor` exported, new `weeklyOverDates`, and away windows may end at midnight.
- `src/core/ics.ts` — anchors weekly events on `templateDateFor(day)` instead of `TEMPLATE_SUNDAY + day`.
- `src/core/weekView.ts` — `today` on `WeekView`, exported `plusDays`/`weekOffsetOf`, `MIN_LABEL_ROWS`, `weekNoteZones`.
- `src/db/db.ts`, `src/db/webSessions.ts`, `src/web/session.ts` — `web_session.cookie_v` and the one-time domain-cookie re-issue.
- `src/web/routes/availability.ts` — `saveLimiter` 20 to 90.
- `src/web/pages/PublicAvailability.tsx` — solid away, zone labels as grid items, `> edit`, the three feed buttons, the new caption.
- `src/web/pages/Availability.tsx` — the island owns the card; the three feed buttons.
- `src/web/islands/availability.tsx` — the pager, the week picker, dated pages, away painting, the note chip, the away list, autosave, zone labels, the deal.
- `src/web/styles/app.css` — away tokens, solid away, sticky heads, full-bleed cards, the deal, pager/picker/chip/label/status/details.
- `docs/deploy.md` — the sez-host cookie paragraph.
- Tests: `tests/core/availability.test.ts`, `tests/core/hourCells.test.ts`, `tests/core/weekView.test.ts`, `tests/web/auth.test.ts`, `tests/web/availabilityRoutes.test.ts`, `tests/web/publicAvailability.test.ts`, `tests/web/css.test.ts`, `e2e/availability.spec.ts`.

---

### Task 1: The template week runs Monday to Sunday

The usual week's columns have to keep their identity when the grid pages into a real week, and real weeks run Monday-first everywhere else in this app (`mondayOf`, `buildWeekView`). The template dates move, and the two conversions stop indexing the date list by weekday: they read each date's own weekday instead, which is also what makes the new `weeklyOverDates` — the one every dated page uses — the same function.

**Files:**
- Modify: `src/core/availability.ts:245-312` (the template-week block) and `src/core/ics.ts:1-2,130-133`
- Test: `tests/core/availability.test.ts:117-127`, `tests/core/hourCells.test.ts`, `e2e/availability.spec.ts:1-25,41-45`

**Interfaces:**
- Removed: `TEMPLATE_SUNDAY`.
- Produces: `TEMPLATE_MONDAY = '2026-01-05'`, `templateDates(): string[]` (Mon..Sun), `templateDateFor(day: number): string` (the template date whose weekday is `day`, 0 = Sunday), `weeklyOverDates(weekly, dates, timezone): Interval[]`.
- Unchanged: `TEMPLATE_START`, `templateSlots`, `weeklyToTemplateIntervals`, `templateIntervalsToWeekly`, `splitAtTemplateStart`, `describeWeekly`.

- [ ] **Step 1: Write the failing core tests**

In `tests/core/availability.test.ts`, replace the import block with:

```ts
import {
  normalizeAvailability, describeWeekly, isStale, splitAtTemplateStart, templateSlots,
  weeklyToTemplateIntervals, templateIntervalsToWeekly, sanitizeForeignRecord, isKnownZone,
  endOfLocalDay, localDateOf, templateDates, templateDateFor, weeklyOverDates, TEMPLATE_MONDAY,
} from '../../src/core/availability.js';
```

In `describe('template week', …)` replace the first test (`has 7 days of 34 half-hour slots from 7am to midnight`) with these five:

```ts
  it('has 7 days of 34 half-hour slots from 7am to midnight, monday first', () => {
    const slots = templateSlots(TZ);
    expect(slots).toHaveLength(7 * 34);
    expect(slots[0].start).toBe('2026-01-05T12:00:00.000Z'); // 07:00 EST, Monday
  });
  it('runs monday to sunday, so a column keeps its identity across pages', () => {
    expect(TEMPLATE_MONDAY).toBe('2026-01-05');
    expect(templateDates()).toEqual([
      '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08',
      '2026-01-09', '2026-01-10', '2026-01-11',
    ]);
    // The record counts weekdays from Sunday; the grid draws them from Monday.
    expect(templateDateFor(1)).toBe('2026-01-05');
    expect(templateDateFor(0)).toBe('2026-01-11');
  });
  it('round-trips a sunday block, which is the last column now', () => {
    const weekly = [{ day: 0, start: '11:00', end: '13:00' }];
    const ivs = weeklyToTemplateIntervals(weekly, 'UTC');
    expect(ivs).toEqual([{ start: '2026-01-11T11:00:00.000Z', end: '2026-01-11T13:00:00.000Z' }]);
    expect(templateIntervalsToWeekly(ivs, 'UTC')).toEqual(weekly);
  });
  it('puts each weekly block on every real date with that weekday', () => {
    // 2026-09-14 and 2026-09-21 are Mondays; the 15th is a Tuesday and gets nothing.
    expect(weeklyOverDates(
      [{ day: 1, start: '19:00', end: '22:00' }],
      ['2026-09-14', '2026-09-15', '2026-09-21'], 'UTC',
    )).toEqual([
      { start: '2026-09-14T19:00:00.000Z', end: '2026-09-14T22:00:00.000Z' },
      { start: '2026-09-21T19:00:00.000Z', end: '2026-09-21T22:00:00.000Z' },
    ]);
  });
  it('rolls a past-midnight block onto the next real date', () => {
    expect(weeklyOverDates(
      [{ day: 6, start: '22:00', end: '00:00' }], ['2026-09-19'], 'UTC',
    )).toEqual([{ start: '2026-09-19T22:00:00.000Z', end: '2026-09-20T00:00:00.000Z' }]);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/core/availability.test.ts`
Expected: FAIL to compile — `templateDates`, `templateDateFor`, `weeklyOverDates` and `TEMPLATE_MONDAY` are not exported.

- [ ] **Step 3: Implement the Monday-first template week**

In `src/core/availability.ts`, replace everything from the comment `/** A Sunday. The editor grid is these seven dates; only the weekday of each matters. */` down to the end of `weeklyToTemplateIntervals` with:

```ts
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
 * wall clock in, UTC out, DST handled per date by luxon.
 */
export function weeklyOverDates(
  weekly: WeeklyBlock[], dates: string[], timezone: string,
): Interval[] {
  const ivs: Interval[] = [];
  for (const date of dates) {
    const weekday = DateTime.fromISO(date, { zone: timezone }).weekday % 7; // luxon: 7 = Sunday
    for (const b of weekly) {
      if (b.day !== weekday) continue;
      const start = DateTime.fromISO(`${date}T${b.start}`, { zone: timezone });
      let end = DateTime.fromISO(`${date}T${b.end}`, { zone: timezone });
      if (end <= start) end = end.plus({ days: 1 }); // past midnight
      ivs.push({ start: start.toUTC().toISO()!, end: end.toUTC().toISO()! });
    }
  }
  return ivs.length ? mergeIntervals(ivs) : [];
}

export function weeklyToTemplateIntervals(weekly: WeeklyBlock[], timezone: string): Interval[] {
  return weeklyOverDates(weekly, templateDates(), timezone);
}
```

In `src/core/ics.ts`, change the second import line to:

```ts
import { templateDateFor } from './availability.js';
```

and in the weekly loop of `buildAvailabilityIcs` replace the `const date = …` / `const endDate = …` pair with:

```ts
    const date = ymd(templateDateFor(b.day));
    // A past-midnight block ends on the next calendar day.
    const endDate = b.end <= b.start ? plusDays(templateDateFor(b.day), 1) : date;
```

(`ymd` and `plusDays` are already in that file; the emitted `DTSTART` does not change — day 2 still anchors on Tuesday 2026-01-06 — so `tests/core/availabilityIcs.test.ts` needs no edit.)

- [ ] **Step 4: Update the hour-cell tests, which name template dates**

In `tests/core/hourCells.test.ts` make these six edits.

`pairs the template week's half hours…`, last assertion:
```ts
    // The first cell of the first row is Monday 7:00 then 7:30, New York time.
    expect(rows[0].cells[0]!.keys).toEqual(['2026-01-05T12:00:00.000Z', '2026-01-05T12:30:00.000Z']);
```
`is the same shape in utc`:
```ts
    expect(rows[0].cells[0]!.keys).toEqual(['2026-01-05T07:00:00.000Z', '2026-01-05T07:30:00.000Z']);
```
`holds a null where a day has no slot at that hour` — the middle column is Tuesday now:
```ts
    // A hand-built geometry: Tuesday is missing its 8:00 and 8:30 slots.
    const zone = 'UTC';
    const slots = templateSlots(zone).filter((s) => !s.start.startsWith('2026-01-06T08:'));
```
`keeps a lone half hour as a one-key cell`:
```ts
    const slots = templateSlots(zone).filter((s) => s.start !== '2026-01-06T08:30:00.000Z');
    const rows = hourRows(buildGeom(slots, zone), zone);
    expect(rows[1].cells[1]!.keys).toEqual(['2026-01-06T08:00:00.000Z']);
```
`covers both halves of every hour in the rectangle…` — columns 0..2 are Mon, Tue, Wed:
```ts
    const mon7 = rows[0].cells[0]!; const wed9 = rows[2].cells[2]!;
    const down = hourRectKeys(rows, mon7, wed9);
    const up = hourRectKeys(rows, wed9, mon7);
    expect(down).toHaveLength(3 * 3 * 2);
    expect(new Set(up)).toEqual(new Set(down));
    expect(down).toContain('2026-01-05T07:00:00.000Z');
    expect(down).toContain('2026-01-07T09:30:00.000Z');
    expect(down).not.toContain('2026-01-07T10:00:00.000Z');
    expect(down).not.toContain('2026-01-08T07:00:00.000Z');
```
`does not leak across a middle column's fully missing hour`:
```ts
    // Tuesday's 8:00 hour (both halves) is missing entirely, so rows[1].cells[1] is null.
    const slots = templateSlots(zone).filter((s) => !s.start.startsWith('2026-01-06T08:'));
    const g = buildGeom(slots, zone);
    const r = hourRows(g, zone);
    const mon7 = r[0].cells[0]!; const wed9 = r[2].cells[2]!;
    const keys = hourRectKeys(r, mon7, wed9);
    expect(keys).toHaveLength(16);
    expect(keys).toContain('2026-01-06T07:00:00.000Z');
    expect(keys).toContain('2026-01-06T07:30:00.000Z');
    expect(keys).toContain('2026-01-06T09:00:00.000Z');
    expect(keys).toContain('2026-01-06T09:30:00.000Z');
    expect(keys).not.toContain('2026-01-06T10:00:00.000Z');
    expect(keys).not.toContain('2026-01-06T10:30:00.000Z');
```
`a lone half hour in the box contributes one key, not two`:
```ts
    // Only Tuesday's 8:30 is missing, so rows[1].cells[1] is a one-key cell.
    const slots = templateSlots(zone).filter((s) => s.start !== '2026-01-06T08:30:00.000Z');
    const g = buildGeom(slots, zone);
    const r = hourRows(g, zone);
    const mon7 = r[0].cells[0]!; const wed9 = r[2].cells[2]!;
    const keys = hourRectKeys(r, mon7, wed9);
    expect(keys).toHaveLength(17);
    expect(keys).not.toContain('2026-01-06T10:00:00.000Z');
```

- [ ] **Step 5: Run the whole suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS — the 464 existing tests plus the four new ones in `availability.test.ts`.

- [ ] **Step 6: Point the e2e at the column that is never in the past**

`e2e/availability.spec.ts` marks "the first two hour cells of the first column", which used to be Sunday and is Monday now — and the reach-out step further down clicks a free hour that is still ahead, which only Sunday (the last column of a Monday-first week) always is. Keep the marks on Sunday.

Change the import line to:
```ts
import { test, expect, type Locator, type Page } from '@playwright/test';
```
Replace the helper's first two lines (the signature and the `const cells = …` it opens with) with:
```ts
async function markCells(page: Page, cells: Locator, from: number, to: number) {
  await expect(cells.first()).toBeVisible();
```
and replace the call site with its comment:
```ts
  // Mark Sunday 7am–9am. The Sunday column is the last of seven, each seventeen rows deep,
  // so its 7am cell is number 102. Sunday is the last day of a Monday-first week, so it is
  // never in the past — which the reach-out step below needs.
  await markCells(page, page.locator('#availability-root [data-slot]'), 6 * 17, 6 * 17 + 1);
```

- [ ] **Step 7: Run the e2e**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: PASS — the sentence is still `usually free sundays 7am to 9am.` and the feed still says `BYDAY=SU`.

- [ ] **Step 8: Commit**

```bash
git add src/core/availability.ts src/core/ics.ts tests/core/availability.test.ts tests/core/hourCells.test.ts e2e/availability.spec.ts
git commit -m "feat(core): the template week runs monday to sunday

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `awayDays.ts` — the day map a dated page edits

A dated page paints hours on dates; the record stores dated ranges with one optional window. This module is the translation both ways, and the rule it must keep is that editing one week never touches a date outside it — a range that straddles the week's edge splits instead.

A stroke on the grid's last row ends at midnight, which `normalizeAvailability` currently refuses for an away window. The read path (`localWindow`, `freeIntervals`, `buildWeekView`) already reads `00:00` as the end of the day, so the write path is brought in line here.

**Files:**
- Create: `src/core/awayDays.ts`
- Modify: `src/core/availability.ts:104-117` (the away-window branch of `normalizeAvailability`)
- Test: `tests/core/awayDays.test.ts` (new), `tests/core/availability.test.ts`

**Interfaces:**
- Produces: `type DayAway = 'all' | Set<string>`, `interface AwayDay { away: DayAway; note: string }`, `type AwayDays = Map<string, AwayDay>`, `expandAway(entries, from, to): AwayDays`, `compactAway(entries, from, to, days): AwayEntry[]`, `toggleAllDay(days, date, note?): AwayDays`, `paintAway(days, dates, halfHours, on): AwayDays`.
- Consumes: `AwayEntry` from `src/atproto/records.ts`. Nothing else — no luxon, no zones: these are calendar dates and wall-clock `HH:MM` strings.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/awayDays.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { AwayEntry } from '../../src/atproto/records.js';
import { compactAway, expandAway, paintAway, toggleAllDay } from '../../src/core/awayDays.js';
import { normalizeAvailability } from '../../src/core/availability.js';

// The mock's fixture in the record's half-hour shape: a timed saturday, an all-day
// conference over two days, and a wedding three weeks out.
const FIXTURE: AwayEntry[] = [
  { start: '2026-09-19', end: '2026-09-19', startTime: '11:00', endTime: '15:00' },
  { start: '2026-09-23', end: '2026-09-24', note: 'conference' },
  { start: '2026-10-03', end: '2026-10-05', note: 'wedding' },
];
// Monday-first weeks: sep 14 – 20, sep 21 – 27, oct 5 – 11.
const WEEK1 = ['2026-09-14', '2026-09-20'] as const;
const WEEK2 = ['2026-09-21', '2026-09-27'] as const;

/** A date's half hours, sorted — or 'all', or undefined where the map has no entry. */
const hours = (days: ReturnType<typeof expandAway>, date: string) => {
  const v = days.get(date);
  return v && v.away !== 'all' ? [...v.away].sort() : v?.away;
};

describe('expandAway', () => {
  it('expands a timed entry into its half-hour starts, and nothing outside the window', () => {
    const days = expandAway(FIXTURE, ...WEEK1);
    expect([...days.keys()]).toEqual(['2026-09-19']);
    expect(hours(days, '2026-09-19'))
      .toEqual(['11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30']);
    expect(days.get('2026-09-19')!.note).toBe('');
  });
  it('expands an all-day entry to every date it covers, carrying its note', () => {
    const days = expandAway(FIXTURE, ...WEEK2);
    expect([...days.keys()].sort()).toEqual(['2026-09-23', '2026-09-24']);
    expect(days.get('2026-09-23')).toEqual({ away: 'all', note: 'conference' });
  });
  it('clips a range to the window, so the week of oct 5 sees only oct 5', () => {
    const days = expandAway(FIXTURE, '2026-10-05', '2026-10-11');
    expect([...days.keys()]).toEqual(['2026-10-05']);
    expect(days.get('2026-10-05')).toEqual({ away: 'all', note: 'wedding' });
  });
  it('reads a window that ends at midnight as the rest of the day', () => {
    const days = expandAway(
      [{ start: '2026-09-19', end: '2026-09-19', startTime: '23:00', endTime: '00:00' }], ...WEEK1);
    expect(hours(days, '2026-09-19')).toEqual(['23:00', '23:30']);
  });
  it('lets an all-day entry win over a timed one on the same date', () => {
    const days = expandAway([
      { start: '2026-09-19', end: '2026-09-19', startTime: '11:00', endTime: '12:00' },
      { start: '2026-09-19', end: '2026-09-19', note: 'gone' },
    ], ...WEEK1);
    expect(days.get('2026-09-19')).toEqual({ away: 'all', note: 'gone' });
  });
});

describe('compactAway', () => {
  it('round-trips the fixture through the day map, week by week', () => {
    for (const [from, to] of [WEEK1, WEEK2, ['2026-10-05', '2026-10-11'] as const]) {
      expect(compactAway(FIXTURE, from, to, expandAway(FIXTURE, from, to))).toEqual(FIXTURE);
    }
  });
  it('turns a rectangle across two days into one entry with a window', () => {
    const days = paintAway(
      new Map(), ['2026-09-19', '2026-09-20'], ['11:00', '11:30', '12:00', '12:30'], true);
    expect(compactAway([], ...WEEK1, days)).toEqual([
      { start: '2026-09-19', end: '2026-09-20', startTime: '11:00', endTime: '13:00' },
    ]);
  });
  it('makes one entry per run of half hours on a day', () => {
    const days = paintAway(new Map(), ['2026-09-19'], ['09:00', '09:30', '14:00'], true);
    expect(compactAway([], ...WEEK1, days)).toEqual([
      { start: '2026-09-19', end: '2026-09-19', startTime: '09:00', endTime: '10:00' },
      { start: '2026-09-19', end: '2026-09-19', startTime: '14:00', endTime: '14:30' },
    ]);
  });
  it('ends a stroke on the last row at midnight, which normalizeAvailability keeps', () => {
    const days = paintAway(new Map(), ['2026-09-19'], ['23:00', '23:30'], true);
    const away = compactAway([], ...WEEK1, days);
    expect(away).toEqual([
      { start: '2026-09-19', end: '2026-09-19', startTime: '23:00', endTime: '00:00' },
    ]);
    expect(normalizeAvailability({ timezone: 'UTC', weekly: [], away }).away).toEqual(away);
  });
  it('leaves the part of a range outside the edited week alone, splitting it cleanly', () => {
    // oct 3 – 10 with a note, edited on the week of oct 5: clearing oct 7 leaves oct 3 – 4
    // untouched and splits the rest around the hole.
    const entries: AwayEntry[] = [{ start: '2026-10-03', end: '2026-10-10', note: 'wedding' }];
    const days = toggleAllDay(expandAway(entries, '2026-10-05', '2026-10-11'), '2026-10-07');
    expect(compactAway(entries, '2026-10-05', '2026-10-11', days)).toEqual([
      { start: '2026-10-03', end: '2026-10-04', note: 'wedding' },
      { start: '2026-10-05', end: '2026-10-06', note: 'wedding' },
      { start: '2026-10-08', end: '2026-10-10', note: 'wedding' },
    ]);
  });
  it('splits a multi-day timed range where part of it is unpainted', () => {
    const entries: AwayEntry[] = [
      { start: '2026-09-14', end: '2026-09-16', startTime: '09:00', endTime: '10:00' },
    ];
    const days = paintAway(expandAway(entries, ...WEEK1), ['2026-09-15'], ['09:00', '09:30'], false);
    expect(compactAway(entries, ...WEEK1, days)).toEqual([
      { start: '2026-09-14', end: '2026-09-14', startTime: '09:00', endTime: '10:00' },
      { start: '2026-09-16', end: '2026-09-16', startTime: '09:00', endTime: '10:00' },
    ]);
  });
  it('sorts by date and then by the window start, as the record is written', () => {
    const days = paintAway(expandAway(FIXTURE, ...WEEK1), ['2026-09-20'], ['08:00'], true);
    expect(compactAway(FIXTURE, ...WEEK1, days).map((a) => [a.start, a.startTime ?? ''])).toEqual([
      ['2026-09-19', '11:00'], ['2026-09-20', '08:00'], ['2026-09-23', ''], ['2026-10-03', ''],
    ]);
  });
});

describe('toggleAllDay and paintAway', () => {
  it('sets all day on a clear date and clears a date that has anything, note and all', () => {
    const days = expandAway(FIXTURE, ...WEEK2);
    const cleared = toggleAllDay(days, '2026-09-23');
    expect(cleared.has('2026-09-23')).toBe(false);
    expect(compactAway(FIXTURE, ...WEEK2, cleared)).toEqual([
      FIXTURE[0],
      { start: '2026-09-24', end: '2026-09-24', note: 'conference' },
      FIXTURE[2],
    ]);
    expect(toggleAllDay(new Map(), '2026-09-22').get('2026-09-22')).toEqual({ away: 'all', note: '' });
  });
  it('leaves an all-day date locked against painting', () => {
    const days = toggleAllDay(new Map(), '2026-09-22');
    expect(paintAway(days, ['2026-09-22'], ['09:00'], false).get('2026-09-22'))
      .toEqual({ away: 'all', note: '' });
  });
  it('drops a date once its last half hour is cleared', () => {
    const days = paintAway(new Map(), ['2026-09-22'], ['09:00'], true);
    expect(paintAway(days, ['2026-09-22'], ['09:00'], false).has('2026-09-22')).toBe(false);
  });
  it('keeps the note when a painted date is painted again', () => {
    const days = expandAway([{
      start: '2026-09-19', end: '2026-09-19', startTime: '11:00', endTime: '12:00', note: 'dentist',
    }], ...WEEK1);
    expect(paintAway(days, ['2026-09-19'], ['13:00'], true).get('2026-09-19')!.note).toBe('dentist');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/core/awayDays.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/awayDays.js"`.

- [ ] **Step 3: Write `src/core/awayDays.ts`**

```ts
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

/** The half-hour starts one window covers. An end at or before the start runs to midnight. */
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
      const set = cur && cur.away !== 'all' ? new Set(cur.away) : new Set<string>();
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
    const set = cur && cur.away !== 'all' ? new Set(cur.away) : new Set<string>();
    for (const hm of halfHours) {
      if (on) set.add(hm);
      else set.delete(hm);
    }
    if (set.size) next.set(date, { away: set, note: cur?.note ?? '' });
    else next.delete(date);
  }
  return next;
}
```

- [ ] **Step 4: Let an away window end at midnight**

In `src/core/availability.ts`, inside `normalizeAvailability`'s `if (hasStart)` branch, replace the three lines from `const s = toMinutes(` through `if (e <= s) throw` with:

```ts
      const s = toMinutes(a.startTime, 'an away window start', false);
      let e = toMinutes(a.endTime, 'an away window end', false);
      // Midnight is the one end that may sort before its start: it means the end of the day,
      // which is how localWindow, freeIntervals and buildWeekView already read it. The
      // editor's last row is the 11pm hour, so a stroke there has no other end to name.
      if (e === 0) e = 1440;
      if (e <= s) throw new UserError('an away window must end after it starts');
```

(`fromMinutes(1440)` is `'00:00'`, so the stored value is unchanged.)

Add to `tests/core/availability.test.ts`, inside `describe('normalizeAvailability', …)`:

```ts
  it('keeps an away window that ends at midnight, and still rejects an inverted one', () => {
    const midnight = { start: '2026-09-19', end: '2026-09-19', startTime: '23:00', endTime: '00:00' };
    expect(normalizeAvailability({ timezone: TZ, weekly: [], away: [midnight] }).away)
      .toEqual([midnight]);
    expect(() => normalizeAvailability({
      timezone: TZ, weekly: [],
      away: [{ start: '2026-09-19', end: '2026-09-19', startTime: '18:00', endTime: '09:00' }],
    })).toThrow(/end after it starts/);
  });
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/core/awayDays.test.ts tests/core/availability.test.ts`
Expected: PASS. Then `npm test && npm run typecheck`: clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/awayDays.ts src/core/availability.ts tests/core/awayDays.test.ts tests/core/availability.test.ts
git commit -m "feat(core): a day map for away, compacted back into dated ranges

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
---

### Task 3: `weekNoteZones` — the rectangle a note is drawn inside

A note stops living under the day header and starts living inside the away block it belongs to. Both pages need the same rectangles, so they come from one pure function beside `buildWeekView`. `today` joins `WeekView` so a view can be handed straight to it, and the two date helpers the island needs are exported from here rather than rebuilt there.

**Files:**
- Modify: `src/core/weekView.ts`
- Test: `tests/core/weekView.test.ts`

**Interfaces:**
- Produces: `plusDays(date, n): string` (was private), `weekOffsetOf(date, thisMonday): number`, `MIN_LABEL_ROWS = 3`, `interface NoteZone { c0; c1; h0; h1; note; past }`, `weekNoteZones(rec, week: { monday: string; today: string }): NoteZone[]`.
- Changed: `WeekView` gains `today: string`.
- `h0`/`h1` are wall-clock hours (7..23), inclusive, clipped to `HOURS`; `c0`/`c1` are column indexes into `days`, inclusive.

- [ ] **Step 1: Write the failing tests**

In `tests/core/weekView.test.ts`, replace the import block with:

```ts
import {
  buildWeekView, mondayOf, localToday, weekTitle, dateRangeLabel, hourLabel, weekChoice, awayLater,
  monthDayLabel, plusDays, weekOffsetOf, weekNoteZones, HOURS, MIN_LABEL_ROWS, type WeekView,
} from '../../src/core/weekView.js';
```

Append at the end of the file:

```ts
describe('plusDays / weekOffsetOf', () => {
  it('walks dates and counts whole weeks from a monday, negative for weeks already over', () => {
    expect(plusDays('2026-09-14', 6)).toBe('2026-09-20');
    expect(plusDays('2026-09-14', -1)).toBe('2026-09-13');
    expect(weekOffsetOf('2026-09-16', '2026-09-14')).toBe(0);
    expect(weekOffsetOf('2026-09-20', '2026-09-14')).toBe(0);
    expect(weekOffsetOf('2026-09-21', '2026-09-14')).toBe(1);
    // Seven weeks out, across the date a northern-hemisphere DST change falls on.
    expect(weekOffsetOf('2026-11-08', '2026-09-14')).toBe(7);
    expect(weekOffsetOf('2026-09-13', '2026-09-14')).toBe(-1);
  });
});

describe('weekNoteZones', () => {
  const week = { monday: '2026-09-14', today: '2026-09-16' };
  it('gives an all-day noted entry one rectangle over every row it covers', () => {
    expect(weekNoteZones({ ...base, away: [
      { start: '2026-09-19', end: '2026-09-21', note: 'out of town' },
    ] }, week)).toEqual([{ c0: 5, c1: 6, h0: 7, h1: 23, note: 'out of town', past: false }]);
  });
  it('clips a timed window to the hours it overlaps', () => {
    expect(weekNoteZones({ ...base, away: [
      { start: '2026-09-17', end: '2026-09-17', startTime: '17:30', endTime: '18:30', note: 'dentist' },
    ] }, week)).toEqual([{ c0: 3, c1: 3, h0: 17, h1: 18, note: 'dentist', past: false }]);
  });
  it('clips a range that starts before the week, and calls it past when it ends before today', () => {
    expect(weekNoteZones({ ...base, away: [
      { start: '2026-09-10', end: '2026-09-15', note: 'trip' },
    ] }, week)).toEqual([{ c0: 0, c1: 1, h0: 7, h1: 23, note: 'trip', past: true }]);
  });
  it('skips an entry with no note, one outside the week, and a window off the grid', () => {
    expect(weekNoteZones({ ...base, away: [
      { start: '2026-09-19', end: '2026-09-19' },
      { start: '2026-10-03', end: '2026-10-05', note: 'wedding' },
      { start: '2026-09-18', end: '2026-09-18', startTime: '05:00', endTime: '06:00', note: 'gym' },
    ] }, week)).toEqual([]);
  });
  it('reads a window ending at midnight as running to the last row', () => {
    expect(weekNoteZones({ ...base, away: [
      { start: '2026-09-18', end: '2026-09-18', startTime: '22:00', endTime: '00:00', note: 'show' },
    ] }, week)[0]).toMatchObject({ h0: 22, h1: 23 });
  });
  it('takes a week view as its week, which is what both pages hand it', () => {
    const v = buildWeekView(base, NOW, 0);
    expect(v.today).toBe('2026-09-16');
    expect(weekNoteZones(
      { ...base, away: [{ start: '2026-09-14', end: '2026-09-14', note: 'x' }] }, v,
    )).toEqual([{ c0: 0, c1: 0, h0: 7, h1: 23, note: 'x', past: true }]);
    // Three rows is the shortest zone that carries a label at all.
    expect(MIN_LABEL_ROWS).toBe(3);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/core/weekView.test.ts`
Expected: FAIL to compile — `plusDays`, `weekOffsetOf`, `weekNoteZones` and `MIN_LABEL_ROWS` are not exported.

- [ ] **Step 3: Implement**

In `src/core/weekView.ts`:

Export the date helper and add the offset one, replacing the `const plusDays = …` line with:

```ts
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
```

Add `today` to `WeekView` (after `monday`/`sunday`):

```ts
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
```

and set it in `buildWeekView`'s return:

```ts
  return {
    monday, sunday, today, title: weekTitle(monday, sunday), days, hasAway,
    // Relative to today's week whichever week is shown: next week's Sunday is day 13.
    later: awayLater(rec.away, plusDays(thisMonday, 13)),
  };
```

Append the zones at the end of the file:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/weekView.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/weekView.ts tests/core/weekView.test.ts
git commit -m "feat(core): note zones, so a note can be drawn inside its own away block

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `labelFit.ts` — one rule for how a label sits in its box

A note in a one-day zone usually has to run vertically and a note across five days horizontally, but not always: "conference" does not fit across a 44px column either way round, and "x" fits anywhere. So the choice is made per label from the box and an estimate of the text, in one pure function that both the editor island and the friend view's inline script call.

The function is **embedded verbatim in a browser script later (Task 7)** via `fitLabel.toString()`. Two constraints follow, and the comment in the file says so: no backticks and no `</script>` in its source, and no reference to anything outside its own body (a module-level constant would not travel).

**Files:**
- Create: `src/core/labelFit.ts`
- Test: `tests/core/labelFit.test.ts` (new)

**Interfaces:**
- Produces: `interface LabelFont { charWidth: number; lineHeight: number; pad: number }`, `interface LabelFit { orient: 'h' | 'v'; lines: number; truncate?: boolean }`, `fitLabel(text, w, h, font?): LabelFit`.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/labelFit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fitLabel } from '../../src/core/labelFit.js';

/**
 * The default font is the editor label's: 11px/14px Departure-ish at about 6px a character,
 * with 5px of padding each side. Boxes below are in CSS pixels, as a cell rect is.
 */
describe('fitLabel', () => {
  it('lays a short note horizontally on one line where the width takes it', () => {
    expect(fitLabel('wedding', 200, 60)).toEqual({ orient: 'h', lines: 1 });
  });
  it('turns a note that is too wide for one horizontal line down the column', () => {
    // 'conference' is 60px of text in a 50px-wide inner box, but the 120px height takes it.
    expect(fitLabel('conference', 60, 120)).toEqual({ orient: 'v', lines: 1 });
  });
  it('wraps horizontally when no single line fits but every word does', () => {
    expect(fitLabel('family wedding weekend', 100, 60)).toEqual({ orient: 'h', lines: 2 });
  });
  it('wraps vertically when no word fits the width but the height takes two columns', () => {
    expect(fitLabel('family wedding weekend', 44, 100)).toEqual({ orient: 'v', lines: 2 });
    // One tall column is enough here, so it does not wrap at all.
    expect(fitLabel('family wedding weekend', 40, 220)).toEqual({ orient: 'v', lines: 1 });
  });
  it('truncates along the longer axis when the longest word fits neither', () => {
    expect(fitLabel('a very long note about the conference trip', 44, 48))
      .toEqual({ orient: 'v', lines: 1, truncate: true });
    expect(fitLabel('a very long note about the conference trip', 48, 44))
      .toEqual({ orient: 'h', lines: 1, truncate: true });
  });
  it('truncates in a box with no room for a single line', () => {
    expect(fitLabel('x', 30, 10)).toEqual({ orient: 'h', lines: 1, truncate: true });
  });
  it('takes the friend view\'s smaller metrics', () => {
    const font = { charWidth: 5, lineHeight: 12, pad: 3 };
    expect(fitLabel('conference', 60, 40, font)).toEqual({ orient: 'h', lines: 1 });
    expect(fitLabel('conference', 24, 90, font)).toEqual({ orient: 'v', lines: 1 });
  });
  it('is written so a browser can be handed its own source', () => {
    // Task 7 inlines fitLabel.toString() in a nonce-tagged script: a backtick would end the
    // template literal that builds it, and a module reference would not travel.
    const src = fitLabel.toString();
    expect(src).not.toContain('`');
    expect(src).not.toContain('</script');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/core/labelFit.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/core/labelFit.js"`.

- [ ] **Step 3: Write `src/core/labelFit.ts`**

```ts
/**
 * Which way a note label runs inside its away block, and on how many lines.
 *
 * Text width is estimated, not measured: characters times `charWidth`, the longest word
 * likewise. That is enough to choose a layout — the label is clipped to its block either
 * way, so the cost of being a few pixels out is one word wrapping, never an overflow.
 *
 * Preference order, first that fits: horizontal on one line (easiest to read), vertical on
 * one line, horizontal wrapped, vertical wrapped. Nothing fits: truncate with an ellipsis
 * along the longer axis, which is where the most of the note will show.
 *
 * NOTE: this function's own source is shipped to the browser by
 * `src/web/pages/zoneLabels.ts` (`fitLabel.toString()`), so the friend view and the editor
 * cannot drift apart. Keep it self-contained — no module-level references, they would not
 * travel — and keep backticks and the string `</script` out of it.
 */
export interface LabelFont {
  /** Average glyph advance, px. */
  charWidth: number;
  lineHeight: number;
  /** Padding on each side of the label, px. */
  pad: number;
}
export interface LabelFit {
  orient: 'h' | 'v';
  lines: number;
  /** Nothing fit: one line, clipped with an ellipsis. */
  truncate?: boolean;
}

export function fitLabel(
  text: string, w: number, h: number,
  font: LabelFont = { charWidth: 6, lineHeight: 14, pad: 5 },
): LabelFit {
  // How many lines this text needs along `main`, or 0 when it cannot sit there at all:
  // either the longest unbreakable word overflows, or the lines overflow `cross`.
  const lines = [0, 0];
  for (let i = 0; i < 2; i++) {
    const main = (i === 0 ? w : h) - 2 * font.pad;
    const cross = (i === 0 ? h : w) - 2 * font.pad;
    if (main <= 0 || cross < font.lineHeight) continue;
    let longest = 0;
    for (const word of text.split(/\s+/)) {
      if (word.length * font.charWidth > longest) longest = word.length * font.charWidth;
    }
    if (longest > main) continue;
    const n = Math.max(1, Math.ceil((text.length * font.charWidth) / main));
    if (n * font.lineHeight <= cross) lines[i] = n;
  }
  if (lines[0] === 1) return { orient: 'h', lines: 1 };
  if (lines[1] === 1) return { orient: 'v', lines: 1 };
  if (lines[0] > 0) return { orient: 'h', lines: lines[0] };
  if (lines[1] > 0) return { orient: 'v', lines: lines[1] };
  return { orient: h > w ? 'v' : 'h', lines: 1, truncate: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/labelFit.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/labelFit.ts tests/core/labelFit.test.ts
git commit -m "feat(core): pick a note label's orientation from its own box

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Old sessions get the domain cookie without signing in again

A session minted before 2026-09-17 holds a host-only cookie, which never reaches `<name>.sez.letsmeet.lol` — so its owner sees no edit button there and nothing says why. Mark each row with the cookie shape it was handed, and re-issue the old ones once, on the apex.

**Files:**
- Modify: `src/db/db.ts:27-29,45-47`, `src/db/webSessions.ts`, `src/web/session.ts`
- Modify: `docs/deploy.md` (the "What the host serves" bullet under `<name>.sez.letsmeet.lol`)
- Test: `tests/web/auth.test.ts`

**Interfaces:**
- Produces: `web_session.cookie_v INTEGER NOT NULL DEFAULT 0`; `WebSession` gains `cookieV: number`; `markCookieIssued(db, sid): void`; `isPublicHost(host, domain): boolean` exported from `session.ts`.
- `readSession` keeps its signature and stays the only reader; every route already goes through it.

- [ ] **Step 1: Write the failing tests**

In `tests/web/auth.test.ts`, add to the imports:

```ts
import { Hono } from 'hono';
import { isPublicHost, readSession } from '../../src/web/session.js';
```
(`cookieDomainFor, sessionEnvFor` stay on their existing import line.)

Append at the end of the file:

```ts
describe('sessions minted before the domain cookie', () => {
  /** A one-route app that does what every real route does: read the session. */
  const probe = (e: ReturnType<typeof env>) => {
    const app = new Hono();
    app.get('/probe', async (c) =>
      c.json({ did: (await readSession(c, e, Date.now()))?.did ?? null }));
    return app;
  };

  it('re-issues the cookie with Domain once, on the apex only', async () => {
    const e = env();
    const signedIn = await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz');
    const cookie = cookieOf(signedIn);
    // Pretend this row predates the Domain attribute.
    e.db.prepare('UPDATE web_session SET cookie_v = 0').run();
    const app = probe(e);

    // The alias host issues nothing: a cookie set there would be scoped to it.
    const alias = await app.request('/probe', { headers: { cookie, host: 'ken.sez.poll.example' } });
    expect(alias.headers.getSetCookie()).toEqual([]);
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 0 });

    const apex = await app.request('/probe', { headers: { cookie, host: 'poll.example' } });
    const set = apex.headers.getSetCookie();
    expect(set.some((s) => s.startsWith('sid=') && !s.startsWith('sid=;') && s.includes('Domain=poll.example'))).toBe(true);
    // The host-only cookie the browser still holds is cleared in the same response.
    expect(set.some((s) => s.startsWith('sid=;') && !s.includes('Domain='))).toBe(true);
    expect((await apex.json() as { did: string }).did).toBe('did:plc:host');
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 1 });

    // Marked: the next apex request issues nothing.
    expect((await app.request('/probe', { headers: { cookie, host: 'poll.example' } }))
      .headers.getSetCookie()).toEqual([]);
  });

  it('issues nothing where no Domain is possible (local dev)', async () => {
    const e = env('http://localhost:8787');
    const cookie = cookieOf(await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz'));
    e.db.prepare('UPDATE web_session SET cookie_v = 0').run();
    const res = await probe(e).request('/probe', { headers: { cookie, host: 'localhost:8787' } });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await res.json() as { did: string }).did).toBe('did:plc:host');
  });

  it('a fresh sign-in is already marked, whatever host it happened on', async () => {
    const e = env();
    await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz');
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 1 });
  });

  it('isPublicHost reads the apex through case, a trailing dot and a port', () => {
    expect(isPublicHost('poll.example', 'poll.example')).toBe(true);
    expect(isPublicHost('POLL.example.', 'poll.example')).toBe(true);
    expect(isPublicHost('poll.example:443', 'poll.example')).toBe(true);
    expect(isPublicHost('ken.sez.poll.example', 'poll.example')).toBe(false);
    expect(isPublicHost(undefined, 'poll.example')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL to compile — `isPublicHost` is not exported; and once that is in place, `no such column: cookie_v`.

- [ ] **Step 3: Add the column**

In `src/db/db.ts`, in `SCHEMA`, give a freshly created table the column:

```sql
CREATE TABLE IF NOT EXISTS web_session (
  sid TEXT PRIMARY KEY, did TEXT NOT NULL, handle TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  cookie_v INTEGER NOT NULL DEFAULT 0);
```

and in `ADDED_COLUMNS` (which is how a deployed database gains it):

```ts
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  { table: 'participant', column: 'handle', ddl: 'ALTER TABLE participant ADD COLUMN handle TEXT' },
  // Which cookie shape this session was handed: 0 is the host-only cookie from before
  // 2026-09-17, 1 the `Domain=` one every sez host receives. See web/session.ts.
  { table: 'web_session', column: 'cookie_v', ddl: 'ALTER TABLE web_session ADD COLUMN cookie_v INTEGER NOT NULL DEFAULT 0' },
];
```

- [ ] **Step 4: Read and write it**

In `src/db/webSessions.ts`:

```ts
export interface WebSession {
  did: string;
  handle: string | null;
  /** 0: the host-only cookie from before the Domain attribute. 1: the domain cookie. */
  cookieV: number;
}

export function createWebSession(
  db: Database.Database, did: string, handle: string | null, nowMs: number,
): string {
  const sid = randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO web_session (sid, did, handle, created_at, expires_at, cookie_v) VALUES (?, ?, ?, ?, ?, 1)',
  ).run(sid, did, handle, nowMs, nowMs + SESSION_TTL_MS);
  return sid;
}

export function getWebSession(db: Database.Database, sid: string, nowMs: number): WebSession | null {
  const row = db.prepare('SELECT did, handle, expires_at, cookie_v FROM web_session WHERE sid = ?').get(sid) as
    | { did: string; handle: string | null; expires_at: number; cookie_v: number } | undefined;
  if (!row || row.expires_at <= nowMs) return null;
  return { did: row.did, handle: row.handle, cookieV: row.cookie_v };
}

/** This session now holds the domain cookie: do not re-issue it again. */
export function markCookieIssued(db: Database.Database, sid: string): void {
  db.prepare('UPDATE web_session SET cookie_v = 1 WHERE sid = ?').run(sid);
}
```

- [ ] **Step 5: Re-issue the cookie on the apex**

In `src/web/session.ts`, add `markCookieIssued` to the `webSessions.js` import, then replace the `startSession`/`readSession` pair with:

```ts
/** The attributes every session cookie carries, whichever shape it is. */
const cookieOpts = (env: SessionEnv) => ({
  httpOnly: true, sameSite: 'Lax' as const, path: '/', secure: env.secure,
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
});

/** Mint a session row for `did` and hand the browser its id. */
export async function startSession(
  c: Context, env: SessionEnv, did: string, handle: string | null, nowMs: number,
): Promise<void> {
  const sid = createWebSession(env.db, did, handle, nowMs);
  if (env.domain) {
    // A cookie set before the Domain attribute existed is host-only, and a browser holding
    // one would send both on the apex. Clear it in the same response; the browser matches
    // the clear to the host-only cookie and the set to the domain one.
    deleteCookie(c, COOKIE, { path: '/' });
    await setNamedCookie(c, env.cookieSecret, COOKIE, sid, { ...cookieOpts(env), domain: env.domain });
  } else {
    await setNamedCookie(c, env.cookieSecret, COOKIE, sid, cookieOpts(env));
  }
}

/** The request is on the apex itself, whatever case, trailing dot or port the Host carries. */
export function isPublicHost(host: string | undefined, domain: string): boolean {
  return (host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '') === domain;
}

/**
 * A session minted before the domain cookie (2026-09-17) is host-only: it never reaches
 * `<name>.sez.<site>`, so its owner sees no edit button on their own alias page and nothing
 * tells them why. Re-issue it with `Domain` the next time they are on the apex and mark the
 * row, so nobody has to sign in again. Only on the apex — a Set-Cookie from the alias host
 * would be scoped to that host, and the alias serves nothing a session acts on. A failed
 * write is logged and dropped: the next request tries again.
 */
async function reissueCookie(c: Context, env: SessionEnv, sid: string): Promise<void> {
  if (!env.domain || !isPublicHost(c.req.header('host'), env.domain)) return;
  deleteCookie(c, COOKIE, { path: '/' });
  await setNamedCookie(c, env.cookieSecret, COOKIE, sid, { ...cookieOpts(env), domain: env.domain });
  try {
    markCookieIssued(env.db, sid);
  } catch (err) {
    console.warn('session cookie re-issue not recorded:', err);
  }
}

/** The live session behind the request's cookie, or null — expired and revoked both read as null. */
export async function readSession(c: Context, env: SessionEnv, nowMs: number): Promise<WebSession | null> {
  const sid = await getNamedCookie(c, env.cookieSecret, COOKIE);
  if (!sid) return null;
  const who = getWebSession(env.db, sid, nowMs);
  if (who && who.cookieV === 0) await reissueCookie(c, env, sid);
  return who;
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/web/auth.test.ts && npm test && npm run typecheck`
Expected: PASS. (`tests/web/*` run on `http://localhost:8787`, where `domain` is null, so nothing else sees a second `Set-Cookie`.)

- [ ] **Step 7: Say so in the deploy notes**

In `docs/deploy.md`, in the "What the host serves" bullet, replace the sentence

> The session cookie carries `Domain=letsmeet.lol`, so **every** host under the apex receives it, not only the sez hosts.

with

> The session cookie carries `Domain=letsmeet.lol`, so **every** host under the apex receives it, not only the sez hosts. Sessions minted before that (2026-09-17) are host-only; `web_session.cookie_v` records which shape a row was handed, and the first apex request on an old session re-issues the cookie with `Domain` and marks the row, so nobody signs in again. The alias host never issues cookies.

- [ ] **Step 8: Commit**

```bash
git add src/db/db.ts src/db/webSessions.ts src/web/session.ts docs/deploy.md tests/web/auth.test.ts
git commit -m "feat(session): re-issue a pre-domain cookie once, on the apex

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The save limit stops autosave tripping over itself

Twenty saves per ten minutes was sized for a post button. With a 2-second autosave, a long editing session spends them in three minutes.

**Files:**
- Modify: `src/web/routes/availability.ts:93-94`
- Test: `tests/web/availabilityRoutes.test.ts:111-123`

- [ ] **Step 1: Rewrite the budget test**

In `tests/web/availabilityRoutes.test.ts`, replace the test `turns saves away once the account has spent its budget` with:

```ts
  it('lets autosave post freely and turns saves away only past ninety', async () => {
    const { app } = setup();
    const cookie = await signIn(app, ME);
    const save = () => app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The bucket holds 90 and the clock does not move, so the 91st finds it empty. The 21st
    // is the one the old limit refused, which two minutes of autosave now reaches.
    for (let i = 0; i < 90; i++) {
      const res = await save();
      expect([i, res.status]).toEqual([i, 200]);
    }
    const res = await save();
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe('easy there. try again in a minute.');
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/web/availabilityRoutes.test.ts`
Expected: FAIL at `[20, 429]` — the bucket is empty after twenty.

- [ ] **Step 3: Raise the limit**

In `src/web/routes/availability.ts`, replace the comment and the limiter with:

```ts
  // 90 saves per ten minutes per account: a save is two PDS round trips (a claim rides on
  // one), and the editor autosaves about two seconds after each change — so the budget has
  // to hold a long editing session, not a handful of button presses.
  const saveLimiter = new TokenBucket(90, 90 / 600);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/web/availabilityRoutes.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/availability.ts tests/web/availabilityRoutes.test.ts
git commit -m "feat(availability): ninety saves per ten minutes, so autosave fits

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
---

### Task 7: The friend view — orange away, notes inside the block, `> edit`, three feed buttons

Everything server-rendered. The only script is the label classifier, and without it the page still reads: the server guesses an orientation from the zone's shape, and the script replaces the guess with a measured one.

**Files:**
- Create: `src/web/pages/zoneLabels.ts`
- Modify: `src/web/pages/PublicAvailability.tsx`
- Test: `tests/web/publicAvailability.test.ts`, `e2e/availability.spec.ts` (the alias-host assertion)

**Interfaces:**
- Produces: `ZONE_LABEL_SCRIPT` (a string, nonce-tagged by the page). Consumes `fitLabel` (Task 4), `weekNoteZones` / `MIN_LABEL_ROWS` (Task 3).
- `PublicAvailabilityData` is unchanged; `own` now renders a button instead of a line of text.

- [ ] **Step 1: Write the failing page tests**

In `tests/web/publicAvailability.test.ts`, add to the imports:

```ts
import { ZONE_LABEL_SCRIPT } from '../../src/web/pages/zoneLabels.js';
```

Edit the four assertions that name the old markup:

In `renders the sentence, away entries, note and freshness for a resolved handle`, replace the `copy feed link` line and add the other two buttons:
```ts
    expect(html).toContain('>copy link</button>');
    expect(html).toContain('>download .ics</a>');
    expect(html).toContain('>subscribe</a>');
    expect(html).not.toContain('subscribe (webcal)');
    expect(html).toContain("button[data-copy-url]"); // the copy script shipped with the page
```

In `shows the week containing today, the away note under its date, the captions, and no strip`, rename it and replace the `<small>` assertion:
```ts
  it('shows the week containing today, the away note inside its block, the captions, and no strip', () => {
    const html = render();
    expect(html).toContain('sep 14 – 20');
    expect(html).toContain('<span class="off">← this week</span>');
    expect(html).toContain('href="?week=next"');
    // Tuesday and Thursday 7pm–10pm: the 7pm cell on each is free; Monday's is not.
    expect(html.match(/class="week-cell free/g)?.length).toBe(6);
    // The away entry (sat 19 – mon 21) is one label laid over saturday and sunday, rows 7
    // through 23 — two columns wide, so the server's guess is horizontal.
    expect(html).toContain('<div class="zlabel h" data-past="" style="grid-row:2/19;grid-column:7/9">out of town</div>');
    expect(html).not.toContain('<small>');
    expect(html).toContain('class="week-legend"');
    // The sentence is a caption now, with the freshness on the same line.
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm. · updated 6 days ago · good through Dec 31');
    expect(html).toContain('text first');
    expect(html).not.toContain('next two weeks');
    expect(html).not.toContain('grid-cols-14');
  });
```

In `next week shows the following seven days with links both ways`, replace the `<small>` assertion:
```ts
    // The same away entry ends on monday the 21st: one column wide, so vertical.
    expect(html).toContain('<div class="zlabel v" data-past="" style="grid-row:2/19;grid-column:2/3">out of town</div>');
```

In `strikes the whole day for an away entry with only half a window`, replace the `<small>away</small>` assertion:
```ts
    // Nothing to label: an entry with no note carries no zone.
    expect(html).not.toContain('zlabel');
    expect(html.match(/class="week-cell away/g)?.length).toBe(17);
```

In `links each free hour that is still ahead to a bluesky post at them, written already`, replace the caption assertion:
```ts
    expect(html).toContain('click a free hour to ping on bluesky.');
```

In `offers the owner an edit link, and nobody else`, replace the last two assertions:
```ts
    const html = await mineRes.text();
    expect(html).not.toContain('this is you');
    expect(html).toContain('>edit</a>');
    expect(html).toContain('href="https://letsmeet.lol/availability"');
```
and in the two `not.toContain('this is you')` lines above it, use the button instead:
```ts
    expect(guest).not.toContain('>edit</a>');
```
```ts
    expect(await (await app.request('/u/ken.wzrdz.cool', { headers: { cookie: other } })).text()).not.toContain('>edit</a>');
```

In `offers the owner the edit link on their own sez page, pointing at the apex`:
```ts
    expect(html).toContain('>edit</a>');
    expect(html).toContain('href="https://letsmeet.lol/availability"');
```

Add two new tests at the end of `describe('the week grid', …)`:

```ts
  it('places every cell and label explicitly, so a label overlaps rather than displaces', () => {
    const html = render();
    // Row 1 is the day headers; hour h is row h - 5. Column 1 is the axis.
    expect(html).toContain('style="grid-row:1;grid-column:2"');
    expect(html).toContain('style="grid-row:18;grid-column:8"');
    expect(html.match(/grid-row:\d+;grid-column:\d+"/g)?.length).toBe(1 + 7 + 17 * 8);
  });
  it('labels nothing shorter than three rows', () => {
    const html = render({ record: { ...rec, away: [{
      start: '2026-09-17', end: '2026-09-17', startTime: '19:00', endTime: '21:00', note: 'dentist',
    }] } });
    expect(html).not.toContain('zlabel');
    const tall = render({ record: { ...rec, away: [{
      start: '2026-09-17', end: '2026-09-17', startTime: '19:00', endTime: '22:00', note: 'dentist',
    }] } });
    expect(tall).toContain('>dentist</div>');
  });
```

And a describe for the script, at the end of the file:

```ts
describe('the zone-label script', () => {
  /** The bare environment a browser hands it: labels with boxes, and a resize listener. */
  const label = (text: string, w: number, h: number, past = false) => ({
    textContent: text, className: `zlabel ${w < h ? 'v' : 'h'}`,
    getAttribute: (n: string) => (n === 'data-past' && past ? '1' : null),
    getBoundingClientRect: () => ({ width: w, height: h }),
  });
  it('classifies each label with fitLabel, keeping the past flag, and follows a resize', () => {
    const els = [label('wedding', 200, 60), label('conference', 24, 90), label('out of town', 40, 60, true)];
    const events: string[] = [];
    new Function('document', 'window', ZONE_LABEL_SCRIPT)(
      { querySelectorAll: () => els },
      { addEventListener: (e: string) => events.push(e) },
    );
    // Wide box: one horizontal line. One column: down the column. The third fits neither
    // on one line, and wraps horizontally in two.
    expect(els.map((e) => e.className)).toEqual(['zlabel h one', 'zlabel v one', 'zlabel h past']);
    expect(events).toEqual(['resize']);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/web/publicAvailability.test.ts`
Expected: FAIL — `Failed to resolve import ".../zoneLabels.js"`, and once that exists, the `zlabel`, `>edit</a>` and `copy link` assertions.

- [ ] **Step 3: Write `src/web/pages/zoneLabels.ts`**

```ts
import { fitLabel } from '../../core/labelFit.js';

/**
 * The friend view's note labels, classified once the page has laid out and again on resize.
 * The server places each label in its away block and guesses an orientation from the shape
 * of it (vertical down one column, horizontal across a span) so a page with no JavaScript
 * reads sensibly; this measures the real box and asks `fitLabel` — the same function the
 * editor island calls — which of h/v, one line or wrapped, actually fits.
 *
 * The rule cannot drift because this ships `fitLabel`'s own source: `fitLabel.toString()`.
 * Two things that follows from that, both guarded by tests: the function must stay
 * self-contained (see its comment), and `__name` is defined here as a pass-through because
 * esbuild's keep-names transform calls it around inner functions and a browser has never
 * heard of it.
 *
 * Rebuilding `className` is deliberate — the server's guess has to go — so the "past" flag
 * comes back off `data-past` rather than surviving in the class list.
 */
export const ZONE_LABEL_SCRIPT = '(function(){'
  + 'var __name=function(f){return f};'
  + `var fitLabel=${fitLabel.toString()};`
  // The friend view's label metrics: 10px/12px with 2-3px of padding (see app.css).
  + 'var font={charWidth:5,lineHeight:12,pad:3};'
  + 'var run=function(){'
  + "var ls=document.querySelectorAll('.week .zlabel');"
  + 'for(var i=0;i<ls.length;i++){var el=ls[i];var r=el.getBoundingClientRect();'
  + "var f=fitLabel(el.textContent||'',r.width,r.height,font);"
  + "el.className='zlabel '+f.orient+(f.lines===1?' one':'')"
  + "+(el.getAttribute('data-past')==='1'?' past':'')}};"
  + "run();window.addEventListener('resize',run)})()";
```

- [ ] **Step 4: Rewrite the week grid and the page's chrome**

In `src/web/pages/PublicAvailability.tsx`:

Imports — add the zones, the label threshold and the script:

```ts
import {
  buildWeekView, dateRangeLabel, hourLabel, localToday, monthDayLabel, weekNoteZones,
  HOURS, MIN_LABEL_ROWS,
  type NoteZone, type WeekCell, type WeekChoice, type WeekDay, type WeekView,
} from '../../core/weekView.js';
```
and
```ts
import { ZONE_LABEL_SCRIPT } from './zoneLabels.js';
```

Replace `WeekGrid` (doc comment included) with:

```tsx
/**
 * Days across, hours down. Server-rendered, no script but the label classifier. Each hour is
 * a `.week-row` (`display: contents`, so the cells still sit in the grid) and every head and
 * cell carries its column index in `data-c`: that is all the hover rules in app.css need to
 * light the hovered cell's hour label and day header. A free hour still ahead is a link to
 * Bluesky's compose intent with a public post at the person already written — the one
 * hand-off Bluesky offers without a chat scope (there is no DM intent). Everything else is
 * an inert div.
 *
 * Every cell, head and label is placed explicitly (`grid-row`/`grid-column`): a note label
 * spans its away block, and an auto-placed grid would push the cells underneath it along.
 * Row 1 is the headers, hour `h` is row `h - 5`; column 1 is the time axis, day `ci` is
 * column `ci + 2`.
 */
function WeekGrid({ view, zones, handle }: { view: WeekView; zones: NoteZone[]; handle: string }) {
  return (
    <div className="week" aria-label={`usual week, ${view.title}`} role="group">
      <div className="week-corner" style={{ gridRow: 1, gridColumn: 1 }} />
      {view.days.map((d, ci) => (
        <div
          key={d.date}
          className={cn('week-head', d.past && 'past', d.today && 'today')}
          data-c={ci}
          style={{ gridRow: 1, gridColumn: ci + 2 }}
          title={d.awayAllDay !== null ? (d.awayAllDay || 'away') : undefined}
        >
          <b>{d.dom}</b>{d.dow}
        </div>
      ))}
      {HOURS.map((h, hi) => (
        <div key={h} className="week-row">
          <div className="week-axis" style={{ gridRow: hi + 2, gridColumn: 1 }}>{hourLabel(h)}</div>
          {view.days.map((d, ci) => {
            const c = d.cells[hi];
            const title = `${d.dow} ${d.dom} ${hourLabel(h)}${c.note ? ` · ${c.note}` : ''}`;
            const place = { gridRow: hi + 2, gridColumn: ci + 2 };
            return isReachable(d, c) ? (
              <a
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state)}
                data-c={ci}
                style={place}
                href={composeUrl(`hey @${handle}, let's meet (lol). ${hourLabel(h)} on ${d.dow} ${monthDayLabel(d.date)} looks good to me?`)}
                target="_blank"
                rel="noopener"
                title={`${title} · click to post at them`}
              />
            ) : (
              <div
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state, d.past && 'past')}
                data-c={ci}
                style={place}
                title={title}
              />
            );
          })}
        </div>
      ))}
      {/* A note lives inside the away block it belongs to. The orientation here is a guess
          from the block's shape, for a page with no JavaScript; ZONE_LABEL_SCRIPT measures
          the real box and replaces it. Anything under three rows carries no label at all.
          `data-past` carries the dimming through that rewrite, and the grid placement has no
          spaces around its slash — React writes a style value through verbatim, and the page
          tests match the rendered attribute. */}
      {zones.filter((z) => z.h1 - z.h0 + 1 >= MIN_LABEL_ROWS).map((z, i) => (
        <div
          key={`zone-${i}`}
          className={cn('zlabel', z.c1 > z.c0 ? 'h' : 'v', z.past && 'past')}
          data-past={z.past ? '1' : ''}
          style={{ gridRow: `${z.h0 - 5}/${z.h1 - 4}`, gridColumn: `${z.c0 + 2}/${z.c1 + 3}` }}
        >{z.note}</div>
      ))}
    </div>
  );
}
```

In `PublicAvailabilityPage`, after the `view` / `later` consts add:

```ts
  const zones = rec && view ? weekNoteZones(rec, view) : [];
```

Replace the `links` element with the three matching buttons:

```tsx
  const links = (
    <div className="feed-actions">
      <a href={feedUrl} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>download .ics</a>
      <a
        href={`webcal://${base.replace(/^https?:\/\//, '')}${path}/availability.ics`}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
      >subscribe</a>
      <button
        type="button"
        data-copy-url={feedUrl}
        hidden
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
      >copy link</button>
    </div>
  );
```

Replace the heading block (`<div className="grid gap-1"> … </div>`, down to the `times in` line) with:

```tsx
        <div className="fv-head">
          <div className="grid gap-1">
            <h1 className="pixel-heading">{data.handle}</h1>
            {/* `select-all`: one click selects the whole address, the thing worth copying. */}
            {data.sezAddress && <p className="pixel-label text-muted-foreground select-all">{data.sezAddress}</p>}
            {rec && !unreadable && <p className="text-sm text-muted-foreground">times in {rec.timezone}</p>}
          </div>
          {/* The owner's way back to the editor. Absolute: on the alias host `/availability`
              answers nothing. */}
          {data.own && (
            <a
              href={`${base}/availability`}
              className={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'fv-edit')}
            >edit</a>
          )}
        </div>
```

Pass the zones to the grid and fix the caption:

```tsx
              <WeekGrid view={view!} zones={zones} handle={data.handle} />
```
```tsx
              {reachable && (
                <p className="week-caption text-sm text-muted-foreground">click a free hour to ping on bluesky.</p>
              )}
```

Ship the classifier beside the copy script:

```tsx
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
        {view && zones.length > 0 && (
          <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: ZONE_LABEL_SCRIPT }} />
        )}
```

- [ ] **Step 5: Run the page tests**

Run: `npx vitest run tests/web/publicAvailability.test.ts`
Expected: PASS. If the exact `zlabel` strings differ, print what was rendered
(`console.log(html.match(/<div class="zlabel[^>]*>[^<]*/g))`) and fix the expectation to match the real attribute order rather than reordering the JSX — React emits attributes in source order.

- [ ] **Step 6: Follow the edit button in the e2e**

In `e2e/availability.spec.ts`, replace the two alias-host assertions:

```ts
  // The signed-in viewer is the owner, so the alias response carries the edit button too:
  // `page.request` shares the browser context's cookie jar, so the session rides along.
  expect(aliasText).toContain('>edit</a>');
  expect(aliasText).toContain('href="http://localhost:8787/availability"');
```

- [ ] **Step 7: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.
Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: PASS. (The grid is unstyled orange until Task 8; the e2e asserts no colours.)

- [ ] **Step 8: Commit**

```bash
git add src/web/pages/zoneLabels.ts src/web/pages/PublicAvailability.tsx tests/web/publicAvailability.test.ts e2e/availability.spec.ts
git commit -m "feat(availability): notes inside the away block, a pixel edit button, three feed buttons

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The CSS the two lenses are made of

Values are copied from the mock's `<style>`, with its palette swapped for the app's tokens. Nothing here is new behaviour on its own: the editor's markup arrives in Tasks 9 to 14, and these rules are waiting for it.

**Files:**
- Modify: `src/web/styles/app.css`
- Test: `tests/web/css.test.ts`

**Interfaces:**
- Produces the tokens `--away`, `--away-ink`, `--away-label`, and the class hooks `.bleed`, `.gridwrap`, `.cells`, `.col.deal`, `.col-head .num`, `.grid.dated`, `.pager`, `.pager-wrap`, `.weekpick`, `.note-chip`, `.zlabel`, `.away-list`, `.details`, `.feed-actions`, `.fv-head`, `.fv-edit`.

- [ ] **Step 1: Write the failing CSS tests**

Append to `tests/web/css.test.ts`, inside `describe('built app.css', …)`:

```ts
  it('defines the away tokens in every theme block and paints away solid on both grids', () => {
    const light = tokens(/:root\{([^}]*)\}/.exec(css)![1]);
    const dark = tokens(DARK_PINNED_TOKENS.exec(css)![1]);
    for (const t of ['--away', '--away-ink', '--away-label']) {
      expect([t, !!light[t]]).toEqual([t, true]);
      expect([t, !!dark[t]]).toEqual([t, true]);
    }
    // Orange is away everywhere: the friend view's gray hatch is gone.
    expect(css).toMatch(/\.week-cell\.away[^{]*\{[^}]*background:var\(--away\)/);
    expect(css).toMatch(/\.cell\.away[^{]*\{[^}]*background:var\(--away\)/);
    expect(css).not.toContain('repeating-linear-gradient(135deg');
  });

  it('sticks the day headers and bleeds the cards at phone width', () => {
    expect(css).toMatch(/\.col-head\{[^}]*position:sticky/);
    expect(css).toMatch(/\.week-head\{[^}]*position:sticky/);
    // The editor grid drops the horizontal scroller, which is what lets its header stick:
    // a horizontal scroll container is a vertical scrollport too, and a sticky child of a
    // scrollport that never scrolls never moves.
    expect(css).toMatch(/#availability-root \.grid\{[^}]*overflow(-x)?:visible/);
    expect(css).toContain('@media (max-width:480px)');
    expect(css).toMatch(/\.bleed\{[^}]*-16px/);
  });

  it('deals the columns on a page change and holds still under reduced motion', () => {
    expect(css).toContain('@keyframes deal');
    expect(css).toMatch(/\.col\.deal \.cells\{[^}]*animation/);
    const reduce = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\}\}/g;
    const blocks = [...css.matchAll(reduce)].map((m) => m[1]).join('\n');
    expect(blocks).toContain('.col.deal .cells');
    expect(blocks).toContain('animation:none');
  });

  it('ships the pager, the picker, the chip and the zone label', () => {
    expect(css).toMatch(/\.pager\.dated \.label\{[^}]*var\(--away/);
    expect(css).toMatch(/\.weekpick\{[^}]*position:absolute/);
    expect(css).toMatch(/\.note-chip\{[^}]*position:absolute/);
    expect(css).toMatch(/\.zlabel\{[^}]*pointer-events:none/);
    expect(css).toMatch(/\.zlabel\.v\{[^}]*writing-mode:vertical-rl/);
    expect(css).toMatch(/\.zlabel\.one\{[^}]*text-overflow:ellipsis/);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/web/css.test.ts`
Expected: FAIL on the away tokens (the first new test), and on each of the other three.

- [ ] **Step 3: Add the tokens**

In `src/web/styles/app.css`, in the `:root` block, after the `--lol` / `--lol-bright` pair:

```css
  /* Away is orange everywhere — the block on both grids, and the chrome that says a page is
     dated. --away-ink is the away colour as *text* on the page (the light fill is too pale
     against white for 11px type); --away-label is text drawn on a solid away block. */
  --away: var(--lol);
  --away-ink: #8a4306;
  --away-label: #fff;
```

and in **both** dark blocks (the `@media (prefers-color-scheme: dark)` one and the
`:root[data-theme="dark"]` one — `tests/web/css.test.ts` compares them), after the `--lol` line:

```css
    --away: var(--lol-bright);
    --away-ink: var(--lol-bright);
    --away-label: oklch(0.147 0.004 49.25);
```

- [ ] **Step 4: Solid away, sticky heads, and the pieces the columns are made of**

In the shared island block (`#grid-root, #reply-root, #availability-root`), replace the `.col-head` rule with:

```css
    /* The day headers stay put while the page scrolls under them, wherever the grid is not
       its own scroll container: `overflow-x: auto` on `.grid` above makes overflow-y compute
       to `auto` as well, and a sticky child of a scrollport that never scrolls vertically
       never moves. The availability editor drops the horizontal scroller (it always draws
       exactly seven columns) and gets a real sticky header; the poll grid, which can be
       twenty dates wide, would need a separate header band scrolled in step. */
    .col-head {
      position: sticky; top: 0; z-index: 3; background: var(--card);
      height: 34px; display: flex; flex-direction: column;
      align-items: center; justify-content: flex-end; gap: 2px; padding-bottom: 5px;
    }
    /* Each column's cells are one block, so the deal can animate them under a still head. */
    .cells { display: flex; flex-direction: column; }
```

In the `.week` block, replace the `.week-cell.away, .week-legend i.away` rule with:

```css
  .week-cell.away, .week-legend i.away { background: var(--away); }
```

and give the head a background to be sticky against, replacing the `.week-head` rule with:

```css
  .week-head {
    position: sticky; top: 0; z-index: 1; background: var(--card);
    text-align: center; font-size: 11px; line-height: 1.2; color: var(--muted-foreground);
    padding: 2px 0 4px; min-width: 0;
  }
```

- [ ] **Step 5: The zone label, shared by both grids**

Append a new `@layer island` block at the end of `src/web/styles/app.css`:

```css
@layer island {
  /* Keyframes cannot live inside a style rule (CSS nesting forbids it), so the three the
     editor uses are declared here, at the layer's top level, beside everything else that is
     shared by both grids. The deal: on a page change the columns cross-fade left to right,
     25ms apart, and the date numbers drop in behind them. */
  @keyframes deal {
    0% { opacity: 1; transform: translateY(0); }
    42% { opacity: 0; transform: translateY(-4px); }
    58% { opacity: 0; transform: translateY(4px); }
    100% { opacity: 1; transform: translateY(0); }
  }
  @keyframes num-drop {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes chip-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: none; }
  }

  /* A note drawn inside its own away block. On the friend view it is a grid item spanning
     the block (placed by the server); in the editor it is absolutely positioned inside
     `.grid` from the cells' own rects. Either way it never affects layout, never takes a
     pointer, and is clipped to the block rather than wrapping outside it. `fitLabel`
     (core/labelFit.ts) picks the orientation and whether it wraps. */
  .zlabel {
    z-index: 1; pointer-events: none; overflow: hidden; min-width: 0;
    padding: 3px 5px; font-size: 11px; line-height: 14px; color: var(--away-label);
  }
  .zlabel.h { overflow-wrap: normal; }
  .zlabel.v { writing-mode: vertical-rl; text-orientation: mixed; }
  .zlabel.one { white-space: nowrap; text-overflow: ellipsis; }
  .zlabel.past { opacity: 0.42; }
  .week .zlabel { font-size: 10px; line-height: 12px; padding: 2px 3px; }

  /* The heading row of the friend view, and the owner's button at the end of it. */
  .fv-head { display: flex; align-items: flex-start; gap: 10px; }
  .fv-edit { margin-left: auto; }
  /* Three matching buttons, left-aligned as a group, on both availability pages. */
  .feed-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

  /* At phone width the cards on the editor and the friend view bleed to the screen edges:
     the grid gets every pixel, text keeps a 16px inset. The negative margin is exactly
     <main>'s own padding (`px-4` in Layout.tsx), so the card's edges meet the screen. */
  @media (max-width: 480px) {
    [data-slot="card"].bleed {
      margin-left: -16px; margin-right: -16px;
      border-left: 0; border-right: 0; border-radius: 0;
    }
    [data-slot="card"].bleed > [data-slot="card-header"],
    [data-slot="card"].bleed > [data-slot="card-content"] {
      padding-left: 16px; padding-right: 16px;
    }
    /* The editor's grid takes the inset back: it is the widest thing on the page. */
    [data-slot="card"].bleed .gridwrap { margin-left: -16px; margin-right: -16px; }
  }
}
```

- [ ] **Step 6: The editor's own furniture**

In the `#availability-root { … }` block in `src/web/styles/app.css`, add (keeping the existing
`.sentence`, `.address-line`, `.address-field`, `.away`, `.away-form` and gradient rules where
they are — Tasks 12 and 13 remove the dead ones):

```css
    /* Exactly seven columns, always: they share the width rather than scrolling sideways,
       which is also what lets the sticky day header stick to the page. `position: relative`
       is the frame the zone labels are placed in. */
    .grid { overflow: visible; position: relative; }
    .col { flex: 1 1 0; min-width: 0; }
    /* The chip is positioned against this, not against the scrolling grid. */
    .gridwrap { position: relative; }
    /* Two lines of head on every page, so paging does not move the grid: the date number
       is empty on the usual week and keeps its row. */
    .col-head { height: 44px; }
    .col-head .num {
      font-family: var(--font-pixel); font-size: 11px; line-height: 16px; height: 16px;
      -webkit-font-smoothing: none;
    }
    /* A dated page says so in orange, and nothing else: no fills, no second grid. */
    .grid.dated .col-head { border-bottom: 2px solid var(--away); }
    .grid.dated .col-head.today .dow {
      text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--away);
    }
    .grid.dated .col-head { cursor: pointer; }
    .grid.dated .col.past .cell, .grid.dated .col.past .col-head { opacity: 0.42; }
    .grid.dated .col.past .cell { cursor: default; }
    /* Away wins over free, and over the half-hour gradients above (same specificity, later
       in the sheet): a cell that is both is simply away. */
    .grid .cell.away, .grid.canvas .cell.away { background: var(--away); border-color: var(--away); }

    /* The deal (keyframes at the top of the layer block above): the island sets `--i` per
       column, so each one starts 25ms after the one to its left. */
    .col.deal .cells { animation: deal 320ms ease both; animation-delay: calc(var(--i) * 25ms); }
    .col.deal .num { animation: num-drop 220ms ease both; animation-delay: calc(var(--i) * 25ms + 120ms); }
    @media (prefers-reduced-motion: reduce) {
      .col.deal .cells, .col.deal .num { animation: none; }
    }

    /* One pager: `‹ usual week ›`. Two lines always, so its height never moves. */
    .pager-wrap { position: relative; }
    .pager { display: flex; align-items: stretch; max-width: 360px; }
    .pager button {
      font-family: var(--font-pixel); font-size: 16px; line-height: 22px; padding: 4px 12px;
      border: 1px solid var(--border); background: var(--background); color: var(--foreground);
      -webkit-font-smoothing: none;
    }
    .pager button:disabled { opacity: 0.3; cursor: default; }
    .pager button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
    .pager .label {
      flex: 1; min-width: 0; display: grid; padding: 4px 10px;
      border-left: 0; border-right: 0; text-align: center; white-space: nowrap; overflow: hidden;
      transition: color 200ms ease, border-color 200ms ease;
    }
    .pager .label .name { overflow: hidden; text-overflow: ellipsis; }
    .pager .label small {
      font-family: var(--font-body, inherit); font-size: 11px; line-height: 14px;
      overflow: hidden; text-overflow: ellipsis;
    }
    .pager.dated .label { color: var(--away-ink); border-color: var(--away); }
    .pager.dated .label small { color: var(--away-ink); opacity: 0.8; }
    .pager.dated .arrow { border-color: var(--away); color: var(--away-ink); }
    @media (prefers-reduced-motion: reduce) { .pager .label { transition: none; } }

    /* The week picker: a small calendar whose rows are the choice. */
    .weekpick {
      position: absolute; top: calc(100% + 6px); left: 0; z-index: 6;
      width: 300px; max-width: 100%; padding: 10px; display: grid; gap: 6px;
      background: var(--popover); color: var(--popover-foreground);
      border: 1px solid var(--border); box-shadow: 0 10px 28px rgb(0 0 0 / 16%);
    }
    .weekpick .usual {
      font-family: var(--font-pixel); font-size: 11px; line-height: 22px; padding: 2px 8px;
      border: 1px solid var(--border); background: var(--background); color: var(--foreground);
      text-align: left; -webkit-font-smoothing: none;
    }
    .weekpick .usual.current { border-color: var(--foreground); }
    .weekpick .mh {
      display: flex; align-items: center; justify-content: space-between;
      font-family: var(--font-pixel); font-size: 11px; line-height: 22px;
    }
    .weekpick .mh button {
      font-family: var(--font-pixel); font-size: 16px; border: 0; background: none;
      color: var(--foreground); padding: 0 8px;
    }
    .weekpick .dows, .weekpick .wk { display: grid; grid-template-columns: repeat(7, 1fr); }
    .weekpick .dows span { font-size: 10px; color: var(--muted-foreground); text-align: center; }
    .weekpick .wk {
      border: 0; background: none; padding: 0; font: inherit; font-size: 12px;
      font-variant-numeric: tabular-nums; color: var(--foreground); border-radius: 4px;
    }
    .weekpick .wk span { position: relative; text-align: center; line-height: 24px; }
    .weekpick .wk span.out { color: var(--muted-foreground); opacity: 0.55; }
    .weekpick .wk span.today { text-decoration: underline; text-underline-offset: 3px; }
    .weekpick .wk span.away::after {
      content: ""; position: absolute; left: 50%; bottom: 2px; width: 4px; height: 4px;
      margin-left: -2px; background: var(--away); border-radius: 50%;
    }
    .weekpick .wk:hover:not(:disabled), .weekpick .wk:focus-visible { background: var(--muted); outline: none; }
    .weekpick .wk.current { box-shadow: inset 0 0 0 2px var(--away); }
    .weekpick .wk:disabled { opacity: 0.3; cursor: default; }
    .weekpick .foot { font-size: 11px; color: var(--muted-foreground); }

    /* The note chip: appears under the cells just marked away. */
    .note-chip {
      position: absolute; z-index: 4; display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; max-width: calc(100% - 8px);
      background: var(--card); border: 1px solid var(--away); box-shadow: 0 6px 18px rgb(0 0 0 / 14%);
      animation: chip-in 160ms ease both;
    }
    @media (prefers-reduced-motion: reduce) { .note-chip { animation: none; } }
    .note-chip .when {
      font-family: var(--font-pixel); font-size: 11px; line-height: 22px;
      color: var(--away-ink); white-space: nowrap; -webkit-font-smoothing: none;
    }
    .note-chip input { width: 15ch; min-width: 0; margin-top: 0; padding: 3px 6px; }
    .note-chip input:focus-visible { outline: 2px solid var(--away); outline-offset: 1px; }
    .note-chip .ok {
      font-family: var(--font-pixel); font-size: 11px; line-height: 22px; padding: 2px 8px;
      border: 1px solid var(--away); background: var(--away); color: var(--away-label);
      -webkit-font-smoothing: none;
    }

    /* The away list is the record: jump to a week, edit its note, remove it. */
    .awaybox { display: grid; gap: 8px; margin: 14px 0 18px; }
    .awaybox h3 {
      font-size: 11px; line-height: 22px; margin: 0; color: var(--muted-foreground);
      text-transform: uppercase; letter-spacing: 0.08em;
    }
    .away-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .away-list li { display: flex; align-items: center; gap: 10px; font-size: 14px; }
    .away-list .jump {
      background: none; border: 0; padding: 0; font: inherit; color: var(--foreground);
      text-decoration: underline; text-underline-offset: 4px; text-decoration-color: var(--away);
    }
    .away-list .when { font-variant-numeric: tabular-nums; }
    .away-list .note {
      color: var(--muted-foreground); font: inherit; font-size: 13px;
      background: none; border: 0; padding: 0;
    }
    .away-list .note.add { text-decoration: underline dashed; text-underline-offset: 4px; }
    .away-list .note:hover { color: var(--foreground); }
    .away-list input.note-edit { width: 12ch; margin-top: 0; padding: 2px 6px; font-size: 13px; }
    .away-list .x {
      margin-left: auto; font-family: var(--font-pixel); font-size: 11px;
      color: var(--muted-foreground); background: none; border: 0; -webkit-font-smoothing: none;
    }
    .away-list .x:hover { color: var(--foreground); }

    /* Details: timezone and good-through share a row, the note takes the width. */
    .details { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .details label { margin: 0; }
    .details .full { grid-column: 1 / -1; }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/web/css.test.ts && npm test && npm run typecheck`
Expected: PASS. If a new assertion misses because lightningcss folded a longhand into a
shorthand, read the built rule (`grep -o '<selector>{[^}]*}' public/assets/app.css`) and match
what it actually emits — do not change the source to satisfy a regex.

- [ ] **Step 8: Commit**

```bash
git add src/web/styles/app.css tests/web/css.test.ts
git commit -m "feat(styles): orange away, sticky day headers, full-bleed cards, the deal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
---

### Task 9: The editor page hands the card to the island

The card's heading was a fixed "usual week"; the pager inside the island says which page the grid is on now, and the hint under it changes with the page. So the page keeps the h1, the banners and the feed buttons, and the card is the island's.

**Files:**
- Modify: `src/web/pages/Availability.tsx`
- Test: `tests/web/availabilityRoutes.test.ts`

**Interfaces:** `AvailabilityPageData` unchanged. The island's mount point and `#availability-data` stay where they are, inside the card's content.

- [ ] **Step 1: Write the failing page assertions**

In `tests/web/availabilityRoutes.test.ts`, in `renders the editor with the current record as island data`, replace the two `copy feed link` lines with:

```ts
    expect(html).toContain('data-copy-url="http://localhost:8787/u/me.test/availability.ics"');
    expect(html).toContain('>copy link</button>');
    expect(html).toContain('>download .ics</a>');
    expect(html).toContain('>subscribe</a>');
    expect(html).toContain('class="feed-actions"');
    // The island owns the card now: no fixed heading, and no post button anywhere.
    expect(html).not.toContain('usual week');
    expect(html).not.toContain('post availability');
    expect(html).not.toContain('copy feed link');
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/web/availabilityRoutes.test.ts`
Expected: FAIL on `>copy link</button>` and on `not.toContain('usual week')`.

- [ ] **Step 3: Implement**

In `src/web/pages/Availability.tsx`, replace the `<Card>` element and the `publicPath` block that follows it with:

```tsx
        {/* The island owns this card: the pager at the top says which page the grid is on,
            and the hint under it changes with the page. `bleed` lets it reach the screen
            edges at phone width (app.css). */}
        <Card className="bleed">
          <CardContent>
            <script
              id="availability-data"
              type="application/json"
              nonce={useNonce()}
              dangerouslySetInnerHTML={{ __html: scriptJson(islandData) }}
            />
            <div id="availability-root" />
          </CardContent>
        </Card>
        {publicPath && (
          <div className="grid gap-2">
            <p className="hint text-sm text-muted-foreground">
              friends can see this at{' '}
              <a href={publicPath} className="text-primary underline underline-offset-4">
                {base.replace(/^https?:\/\//, '')}{publicPath}
              </a>
            </p>
            <div className="feed-actions">
              <a
                href={`${base}${publicPath}/availability.ics`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >download .ics</a>
              <a href={webcal!} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>subscribe</a>
              <button
                type="button"
                data-copy-url={`${base}${publicPath}/availability.ics`}
                hidden
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >copy link</button>
            </div>
          </div>
        )}
```

Drop `CardDescription`, `CardHeader` and `CardTitle` from the `ui/card.js` import (only `Card` and
`CardContent` are used now).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/web/availabilityRoutes.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/Availability.tsx tests/web/availabilityRoutes.test.ts
git commit -m "feat(availability): the editor card is the island's, with three feed buttons under it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The editor pages — one pager, dated pages drawn from the record, a week picker

The first of five island steps. After this the grid can be pointed at any week and shows what friends see there (free from the usual week, away on top, past days dimmed and inert) — but a dated page is still read-only: painting lands in Task 11. The usual week behaves exactly as it does today, and the post button still publishes.

**Files:**
- Modify: `src/web/islands/availability.tsx`
- Test: `e2e/availability.spec.ts`

**Interfaces:**
- Produces (module-level, used by the later island tasks): `type Page = 'usual' | number`, `WeekPicker`, `addMonths`, `monthTitle`, `DOW_MON`.
- DOM hooks: `.pager`, `.pager .name`, `.pager .arrow`, `.pager .label`, `.weekpick`, `.weekpick .wk`, `.gridwrap`, `.grid.usual` / `.grid.dated`, `.col[data-c]`, `.col-head[data-c]`, `.col-head .num`, `.cells`.

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/availability.spec.ts`, after the two `markCells` assertions (the `.cell.available` count and the
sentence), insert:

```ts
  // The pager: the usual week is page zero, and `›` pages into real weeks.
  await expect(page.locator('#availability-root .pager .name')).toHaveText('usual week');
  await expect(page.locator('#availability-root .grid.usual')).toBeVisible();
  await page.click('#availability-root .pager .arrow >> nth=1');
  await expect(page.locator('#availability-root .pager .name')).toHaveText('this week');
  await expect(page.locator('#availability-root .grid.dated')).toBeVisible();
  // Dates appear in the headers, and the marked Sunday still reads as free.
  await expect(page.locator('#availability-root .col[data-c="6"] .col-head .num')).not.toBeEmpty();
  await expect(page.locator('#availability-root .col[data-c="6"] .cell.available')).toHaveCount(2);
  // The week picker jumps back to the usual week.
  await page.click('#availability-root .pager .label');
  await expect(page.locator('#availability-root .weekpick')).toBeVisible();
  await page.click('#availability-root .weekpick .usual');
  await expect(page.locator('#availability-root .weekpick')).toHaveCount(0);
  await expect(page.locator('#availability-root .pager .name')).toHaveText('usual week');
```

- [ ] **Step 2: Run the e2e to see it fail**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: FAIL — `#availability-root .pager .name` never appears.

- [ ] **Step 3: Extend the island's imports and module-level helpers**

In `src/web/islands/availability.tsx`, replace the import block with:

```tsx
import {
  useEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import { DateTime } from 'luxon';
import type { AwayEntry, WeeklyBlock } from '../../atproto/records.js';
import {
  buildGeom, applyPaint, paintToIntervals, intervalsToPaint, type PaintMap,
} from '../../core/gridModel.js';
import { hourRows, hourState, hourStrokeOp, hourRectKeys, type HourCell } from '../../core/hourCells.js';
import {
  describeWeekly, endOfLocalDay, normalizeAvailability, splitAtTemplateStart, templateSlots,
  templateIntervalsToWeekly, weeklyOverDates, weeklyToTemplateIntervals, TEMPLATE_START,
} from '../../core/availability.js';
import {
  compactAway, expandAway, paintAway, toggleAllDay, type AwayDays,
} from '../../core/awayDays.js';
import { materializeSlots } from '../../core/slots.js';
import {
  dateRangeLabel, localToday, mondayOf, monthDayLabel, plusDays, weekOffsetOf,
} from '../../core/weekView.js';
import { UserError } from '../../core/errors.js';
import { isValidSezName, SEZ_NAME_RULE } from '../../core/sezName.js';
// Only the class-string generator, never the <Button> component: <Button> stamps
// data-slot="button", which would land inside #availability-root and start matching the
// same `[data-slot]` selector the grid cells use.
import { buttonVariants } from '../ui/button.js';
import { cn } from '../lib/cn.js';
```

Below the existing `DOW` constant, add:

```tsx
/** The columns' order, and the picker's header row. */
const DOW_MON = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** Where the grid is pointed: the usual week, or a week offset from this Monday. */
type Page = 'usual' | number;

/** A first-of-month ISO date, n months along. */
function addMonths(first: string, n: number): string {
  const d = new Date(`${first}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
}
const monthTitle = (first: string) => `${MONTHS[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;
const domOf = (date: string) => Number(date.slice(8, 10));

/**
 * A small calendar whose rows are the choice: click a row to show that week. Weeks already
 * over are disabled, today is underlined, a day with away carries an orange dot, and the
 * usual week sits above the calendar. Escape or a click outside closes it.
 */
function WeekPicker({ page, today, thisMonday, hasAway, onPick, onClose }: {
  page: Page;
  today: string;
  thisMonday: string;
  hasAway: (date: string) => boolean;
  onPick: (p: Page) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(
    () => `${(page === 'usual' ? today : plusDays(thisMonday, page * 7)).slice(0, 8)}01`);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const click = (e: MouseEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) onClose();
    };
    window.addEventListener('keydown', key);
    // A tick late: the click that opened the picker must not also close it.
    const t = window.setTimeout(() => window.addEventListener('click', click), 0);
    return () => {
      window.removeEventListener('keydown', key);
      window.clearTimeout(t);
      window.removeEventListener('click', click);
    };
  }, [onClose]);
  const weeks: string[] = [];
  const last = plusDays(addMonths(month, 1), -1);
  for (let m = mondayOf(month); m <= last; m = plusDays(m, 7)) weeks.push(m);
  return (
    <div className="weekpick" role="dialog" aria-label="pick a week" ref={box}>
      <button
        type="button"
        className={cn('usual', page === 'usual' && 'current')}
        onClick={() => onPick('usual')}
      >&gt; usual week</button>
      <div className="mh">
        <button type="button" aria-label="previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <span>{monthTitle(month)}</span>
        <button type="button" aria-label="next month" onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </div>
      <div className="dows">{DOW_MON.map((d) => <span key={d}>{d.slice(0, 2)}</span>)}</div>
      {weeks.map((mon) => {
        const off = weekOffsetOf(mon, thisMonday);
        return (
          <button
            key={mon}
            type="button"
            className={cn('wk', off === page && 'current')}
            disabled={off < 0}
            aria-label={`week of ${monthDayLabel(mon)}`}
            onClick={() => onPick(off)}
          >
            {Array.from({ length: 7 }, (_, i) => plusDays(mon, i)).map((d) => (
              <span
                key={d}
                className={cn(
                  d.slice(0, 7) !== month.slice(0, 7) && 'out',
                  d === today && 'today',
                  hasAway(d) && 'away',
                )}
              >{domOf(d)}</span>
            ))}
          </button>
        );
      })}
      <div className="foot">a row is a week. dots are away days.</div>
    </div>
  );
}
```

- [ ] **Step 4: Give the editor its pages**

Still in `src/web/islands/availability.tsx`, inside `Editor`, right after the `zone`/`zoneText` state
and before `const slots = …`, insert:

```tsx
  const [page, setPage] = useState<Page>('usual');
  const [pickerOpen, setPickerOpen] = useState(false);
  // "Today" is read once, in the record's zone: an editor left open across midnight keeps
  // the page it is on rather than shifting under the pointer.
  const [now] = useState(() => new Date());
  const today = useMemo(() => localToday(now, zone), [now, zone]);
  const thisMonday = useMemo(() => mondayOf(today), [today]);
  const dated = page !== 'usual';
  /** The seven dates the page shows, or null on the usual week (which has no dates). */
  const dates = useMemo(() => (page === 'usual'
    ? null
    : Array.from({ length: 7 }, (_, i) => plusDays(thisMonday, page * 7 + i))), [page, thisMonday]);
```

Replace the `slots` memo with:

```tsx
  // A dated page is the same grid over real dates: same 7am-to-midnight window, same
  // half-hour slots, so the hour rows and the stroke geometry are the template's.
  const slots = useMemo(() => (dates
    ? materializeSlots({
      dates, window: { start: TEMPLATE_START, end: '00:00' }, slotMinutes: 30, timezone: zone,
    })
    : templateSlots(zone)), [dates, zone]);
```

After the `cellByKey` memo, add:

```tsx
  /** Each slot key as the date and half hour it falls on in the record's zone. */
  const local = useMemo(() => {
    const m = new Map<string, { date: string; hm: string }>();
    for (const s of slots) {
      const d = DateTime.fromISO(s.start, { zone: 'utc' }).setZone(zone);
      m.set(s.start, { date: d.toISODate()!, hm: d.toFormat('HH:mm') });
    }
    return m;
  }, [slots, zone]);
  /** Where each hour cell sits, for the note chip's anchor (Task 12). */
  const pos = useMemo(() => {
    const m = new Map<string, { ri: number; ci: number }>();
    hours.forEach((r, ri) => r.cells.forEach((c, ci) => { if (c) m.set(c.keys[0], { ri, ci }); }));
    return m;
  }, [hours]);
```

Replace the `painted` memo with one that works on either page:

```tsx
  /** The usual week's free hours, drawn on whichever seven dates are on screen. */
  const painted = useMemo<PaintMap>(() => intervalsToPaint(
    dates ? weeklyOverDates(weekly, dates, zone) : weeklyToTemplateIntervals(weekly, zone),
    [], slots,
  ), [weekly, dates, zone, slots]);
```

After the `away` state, add the day map and the away test:

```tsx
  /** The away day map for the week on screen: what a stroke on a dated page edits. */
  const days = useMemo<AwayDays>(
    () => (dates ? expandAway(away, dates[0], dates[6]) : new Map()), [away, dates]);
  /** Any away at all in this hour cell — half an hour of it is enough to colour the cell. */
  const awayAt = (c: HourCell): boolean => {
    const at = local.get(c.keys[0]);
    const d = at && days.get(at.date);
    if (!d) return false;
    const set = d.away;
    if (set === 'all') return true;
    return c.keys.some((k) => {
      const l = local.get(k);
      return !!l && set.has(l.hm);
    });
  };
  /** The picker's orange dots. */
  const hasAway = (date: string) => away.some((a) => a.start <= date && date <= a.end);
  /** A page change: dismiss what belonged to the old page. */
  const switchPage = (next: Page) => {
    if (next === page) return;
    setPickerOpen(false);
    setPage(next);
  };
```

- [ ] **Step 5: Draw the pager, the hint and the two-line headers**

Keep a dated page read-only for now — the stroke still edits the *weekly* record, which a dated
page must not do. Add a guard as `startStroke`'s first statement (Task 11 replaces it with the
away branch):

```tsx
  const startStroke = (cell: HourCell, touch: boolean) => {
    // A dated page draws the record and takes no marks yet.
    if (dated) return;
    drag.current = { anchor: cell, op: hourStrokeOp(painted, cell), base: painted, touch };
    paintTo(cell);
  };
```

Replace `cell` (the render helper) with one that takes the away flag:

```tsx
  const cell = (c: HourCell, label: string, isAway: boolean) => {
    const state = hourState(painted, c);
    return (
      <div
        key={c.keys[0]}
        className={cn('cell', state !== 'none' && state, isAway && 'away')}
        data-slot={c.keys[0]}
        title={label}
        onPointerDown={onDown(c)}
        onPointerUp={onUp(c)}
      />
    );
  };
```

In the returned JSX, replace everything from the `address` label down to the closing `</div>` of the
grid (the `<label className="address">`, the `{!aliasOk && …}` hint, the touch hint and the
`<div ref={gridEl} className="grid canvas">` block) with:

```tsx
      <div className="pager-wrap">
        <div className={cn('pager', dated && 'dated')}>
          <button
            type="button"
            className="arrow"
            aria-label="previous week"
            disabled={!dated}
            onClick={() => switchPage(page === 0 ? 'usual' : (page as number) - 1)}
          >‹</button>
          {/* Always two lines — a name over a date range, or over "repeats every week" — so
              the pager's height never moves when the page changes. */}
          <button
            type="button"
            className="label"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            title="pick a week"
            onClick={() => setPickerOpen(!pickerOpen)}
          >
            <span className="name">{dated ? pageName(page as number) : 'usual week'}</span>
            <small>{dates ? dateRangeLabel(dates[0], dates[6]) : 'repeats every week'}</small>
          </button>
          <button
            type="button"
            className="arrow"
            aria-label="next week"
            onClick={() => switchPage(dated ? (page as number) + 1 : 0)}
          >›</button>
        </div>
        {pickerOpen && (
          <WeekPicker
            page={page}
            today={today}
            thisMonday={thisMonday}
            hasAway={hasAway}
            onPick={(p) => { switchPage(p); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
      <p className="hint">{dated
        ? 'free hours come from your usual week. drag hours to mark away. tap a day for all day.'
        : "mark when you're usually free. this is a public record in your own repo, like your polls."}</p>
      {/* Above the grid, which is taller than a phone screen: read before the first touch. */}
      <p className="hint touch-hint">tap an hour to mark it. hold, then drag, for a block.</p>
      <div className="gridwrap" ref={wrapEl}>
        <div
          ref={gridEl}
          className={cn('grid canvas', dated ? 'dated' : 'usual')}
          onPointerMove={onMove}
        >
          <div className="col axis">
            <div className="col-head" />
            <div className="cells">
              {hours.map((r) => (
                <div key={r.hour} className="axis-label">{r.label}</div>
              ))}
            </div>
          </div>
          {geom.dates.map((d, ci) => (
            <div
              className={cn('col', dated && d < today && 'past')}
              key={d}
              data-c={ci}
              style={{ '--i': ci + 1 } as CSSProperties}
            >
              <div
                className={cn('col-head', dated && d === today && 'today')}
                data-c={ci}
              >
                {/* Empty on the usual week, which has no dates — the row keeps its height. */}
                <span className="num">{dated ? domOf(d) : ''}</span>
                <span className="dow">{DOW[new Date(`${d}T12:00:00Z`).getUTCDay()]}</span>
              </div>
              <div className="cells">
                {hours.map((r) => {
                  const c = r.cells[ci];
                  // No slot at this hour on this day (a DST edge): hold the row open with an
                  // unmarkable blank so the columns stay aligned.
                  return c
                    ? cell(c, r.label, dated && awayAt(c))
                    : <div key={`gap-${r.hour}`} className="cell gap" aria-hidden="true" />;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {dated && (
        <p className="caption">what friends see this week. <b>marks here are away</b>, and stick to the date.</p>
      )}
      {dated && (
        <div className="week-legend">
          <span><i className="free" />usually free</span>
          <span><i className="away" />away</span>
        </div>
      )}
```

Add the `wrapEl` ref beside `gridEl`:

```tsx
  const gridEl = useRef<HTMLDivElement>(null);
  const wrapEl = useRef<HTMLDivElement>(null);
```

and, at module level beside `domOf`:

```tsx
/** `this week`, `next week`, `in 3 weeks` — the pager's name for a dated page. */
const pageName = (off: number) => (off === 0 ? 'this week' : off === 1 ? 'next week' : `in ${off} weeks`);
```

- [ ] **Step 6: Move the address field into the details block**

The pager is the first thing in the card now, so the address field moves down with the other
fields. In the returned JSX, replace the `details` heading and the three labels after it
(`timezone`, the zone hint, `good through`, `note for friends`) with:

```tsx
      <h3 className="pixel-heading">details</h3>
      <div className="details">
        <label>timezone
          <input
            type="text"
            value={zoneText}
            list="tz-list"
            onChange={(e) => {
              const v = e.target.value;
              setZoneText(v);
              if (knownZone(v)) setZone(v);
            }}
          />
          <datalist id="tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
        <label>good through
          <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </label>
        <label className="full">note for friends
          <input
            type="text"
            maxLength={300}
            placeholder="text me first, weeknights are flexible"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="full">your address
          <span className="address-field">
            <input
              type="text"
              name="alias"
              maxLength={32}
              value={alias}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="pick a name"
              onChange={(e) => setAlias(e.target.value.trim().toLowerCase())}
            />
            <span className="suffix">.{data.sezSuffix}</span>
          </span>
        </label>
      </div>
      {zoneText !== zone && (
        <p className="hint">not a timezone this browser knows. still using {zone}.</p>
      )}
      {!aliasOk && <p className="hint">{SEZ_NAME_RULE}</p>}
```

The `.sentence` and `.address-line` paragraphs stay where they are, under the grid.

- [ ] **Step 7: Run the e2e and the suite**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: PASS.
Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/islands/availability.tsx e2e/availability.spec.ts
git commit -m "feat(availability): one pager, and a dated page that draws what friends see

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
---

### Task 11: Painting away on a dated page

Marks on a dated page are away. A stroke edits the day map for the seven dates on screen and writes back through `compactAway`, so a rectangle across days becomes one entry with a window and nothing outside the week moves. The post button still publishes (autosave lands in Task 13).

**Files:**
- Modify: `src/web/islands/availability.tsx`
- Test: `e2e/availability.spec.ts`

**Interfaces:** no new exports. The stroke ref gains `last`, `days`, `entries`, `from`, `to`; `.col-head[data-c]` gains a click handler on dated pages.

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/availability.spec.ts`, after the week-picker assertions from Task 10, insert:

```ts
  // Marks on a dated page are away. Sunday 11am–3pm: cells 4 through 7 of the column
  // (the first is 7am). Sunday is today or later, so it is always paintable.
  await page.click('#availability-root .pager .arrow >> nth=1');
  // Named sundayCol, not sunday: the poll at the end of this spec already has a `sunday`.
  const sundayCol = page.locator('#availability-root .col[data-c="6"]');
  await markCells(page, sundayCol.locator('[data-slot]'), 4, 7);
  await expect(sundayCol.locator('.cell.away')).toHaveCount(4);

  // A day header taps all day on, and the column locks: a tap anywhere in it clears the day.
  await sundayCol.locator('.col-head').click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(17);
  await sundayCol.locator('[data-slot]').first().click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(0);

  // Painted again, so the rest of this flow has an away entry to name.
  await markCells(page, sundayCol.locator('[data-slot]'), 4, 7);
  await expect(sundayCol.locator('.cell.away')).toHaveCount(4);
```

- [ ] **Step 2: Run the e2e to see it fail**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: FAIL — the dated page is read-only, so `.cell.away` stays at 0.

- [ ] **Step 3: Teach the stroke about away**

In `src/web/islands/availability.tsx`, replace the `drag` ref declaration with:

```tsx
  // ---- the stroke, as in grid.tsx
  const drag = useRef<{
    anchor: HourCell;
    op: 'add' | 'remove';
    base: PaintMap;
    touch: boolean;
    /** The cell the stroke has reached; the note chip (Task 12) hangs off it. */
    last: HourCell;
    /** Set on a dated page only: the day map and entry list the stroke started from, and
        the week it may rewrite. Absent on the usual week, where a stroke edits `weekly`. */
    days?: AwayDays;
    entries?: AwayEntry[];
    from?: string;
    to?: string;
  } | null>(null);
```

Replace `paintTo` and `startStroke` with:

```tsx
  const paintTo = (cell: HourCell) => {
    const d = drag.current;
    if (!d) return;
    d.last = cell;
    const keys = hourRectKeys(hours, d.anchor, cell);
    if (!d.days) {
      setPainted(applyPaint(d.base, keys, d.op, 'available'));
      return;
    }
    const at = keys.map((k) => local.get(k)).filter((x): x is { date: string; hm: string } => !!x);
    // Past days are inert: a rectangle dragged across one paints the rest of it.
    const dates2 = [...new Set(at.map((x) => x.date))].filter((date) => date >= today);
    const halfHours = [...new Set(at.map((x) => x.hm))];
    setAway(compactAway(
      d.entries!, d.from!, d.to!, paintAway(d.days!, dates2, halfHours, d.op === 'add')));
  };
  /**
   * A stroke starts. On the usual week it paints free hours, as it always has. On a dated
   * page it paints away into the day map, with the op decided by the anchor cell as it is
   * now; a past day starts nothing, and an all-day column is locked — a tap anywhere in it
   * clears the day instead.
   */
  const startStroke = (cell: HourCell, touch: boolean) => {
    if (!dated) {
      drag.current = {
        anchor: cell, op: hourStrokeOp(painted, cell), base: painted, touch, last: cell,
      };
      paintTo(cell);
      return;
    }
    const at = local.get(cell.keys[0]);
    if (!at || at.date < today) return;
    if (days.get(at.date)?.away === 'all') {
      setAway(compactAway(away, dates![0], dates![6], toggleAllDay(days, at.date)));
      return;
    }
    drag.current = {
      anchor: cell, op: awayAt(cell) ? 'remove' : 'add', base: painted, touch, last: cell,
      days, entries: away, from: dates![0], to: dates![6],
    };
    paintTo(cell);
  };
  /**
   * A day header tap: a day with any away at all is cleared, note and window and all;
   * a clear day goes away all day.
   */
  const onHead = (date: string) => () => {
    if (!dated || date < today) return;
    setAway(compactAway(away, dates![0], dates![6], toggleAllDay(days, date)));
  };
```

Wire the header up in the JSX (the `col-head` div inside the column map):

```tsx
              <div
                className={cn('col-head', dated && d === today && 'today')}
                data-c={ci}
                onClick={dated ? onHead(d) : undefined}
              >
```

- [ ] **Step 4: Run the e2e and the suite**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: PASS.
Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/islands/availability.tsx e2e/availability.spec.ts
git commit -m "feat(availability): drag away on a dated page, tap a day for all of it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: The note chip, and the away list as the record

Marking away drops a chip under the marked cells with the range and a note field. The list under the grid becomes the record itself: each entry jumps the grid to its week, its note is editable in place, and it can be removed. The date form goes, and with it the "not posted yet" tags from 2026-09-17.

**Files:**
- Modify: `src/web/islands/availability.tsx`, `src/web/styles/app.css` (drop the dead `.away`/`.away-form` rules)
- Test: `e2e/availability.spec.ts`

**Interfaces:**
- Produces (module-level): `entryAt(list, date, hm)`, `withNote(list, on, note)`, `interface Chip`.
- DOM hooks: `.note-chip`, `.note-chip input`, `.note-chip .ok`, `.awaybox`, `.away-list li`, `.away-list .jump`, `.away-list .note`, `.away-list input.note-edit`, `.away-list .x`.
- Removed: `.away-form`, `button.add-away`, `.away .unposted`, `.away-hint`, the `postedAway` state.

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/availability.spec.ts`:

After the header-tap block, add the Escape that dismisses the chip the all-day tap offers, so the
next click lands on a cell and not on the chip:

```ts
  await sundayCol.locator('.col-head').click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(17);
  await page.keyboard.press('Escape');
  await sundayCol.locator('[data-slot]').first().click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(0);
```

After the final `markCells` (the re-paint), add the chip:

```ts
  // Marking away drops a chip under the cells: the range, and a note field.
  const chip = page.locator('#availability-root .note-chip');
  await expect(chip.locator('.when')).toContainText('away');
  await chip.locator('input').fill('out of town');
  await chip.locator('input').press('Enter');
  await expect(chip).toHaveCount(0);

  // The list under the grid is the record: the entry, with its note.
  await expect(page.locator('#availability-root .away-list li')).toHaveCount(1);
  await expect(page.locator('#availability-root .away-list li')).toContainText('out of town');
```

Delete the whole away-form block (the three `page.fill`/`page.click` lines on `.away-form` and
`button.add-away`, and the `.away li`, `.unposted` and `.away-hint` assertions that follow them),
and delete the two `.unposted` / `.away-hint` assertions after the post click. Replace the reload
assertions with:

```ts
  // Reload keeps it.
  await page.reload();
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .away-list li')).toContainText('out of town');
```

In the public-page section further down, the away entry is in *this* week now rather than a
fortnight out, so replace

```ts
  await expect(page.getByText('away later:')).toBeVisible();
```
with the orange block it draws instead:
```ts
  await expect(page.locator('.week-cell.away')).toHaveCount(4);
```

`FIXTURE_DATE_1` is still imported — the poll at the end of the spec is built from it — but
`pickDate`/`setTime` stay as they are.

- [ ] **Step 2: Run the e2e to see it fail**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: FAIL — no `.note-chip` appears.

- [ ] **Step 3: Add the two entry helpers**

In `src/web/islands/availability.tsx`, at module level (beside `pageName`):

```tsx
/**
 * The entry a chip or a note edit is about: the one covering `date` whose window holds `hm`
 * (a single day can carry two windows), else the first entry that covers the date at all.
 */
function entryAt(list: AwayEntry[], date: string, hm: string): AwayEntry | undefined {
  const covering = list.filter((a) => a.start <= date && date <= a.end);
  return covering.find((a) => !a.startTime || !a.endTime
    || (a.startTime <= hm && (a.endTime === '00:00' || hm < a.endTime))) ?? covering[0];
}

/**
 * `list` with `note` set on — or, for an empty note, cleared from — the entry `on`. Rebuilt
 * rather than spread, so the keys stay in the record's order (start, end, startTime,
 * endTime, note) and the save path's snapshot comparison still matches.
 */
function withNote(list: AwayEntry[], on: AwayEntry, note: string): AwayEntry[] {
  return list.map((a) => {
    if (a.start !== on.start || a.end !== on.end || a.startTime !== on.startTime) return a;
    const next: AwayEntry = { start: a.start, end: a.end };
    if (a.startTime && a.endTime) { next.startTime = a.startTime; next.endTime = a.endTime; }
    if (note) next.note = note;
    return next;
  });
}

/** The chip offered under a fresh away mark. */
interface Chip {
  /** A date the entry covers, and the half hour the stroke anchored on: which entry it is. */
  date: string;
  hm: string;
  note: string;
  /** A mouse stroke focuses the field; a touch one waits for a tap, so no keyboard jumps up. */
  focus: boolean;
  top: number;
  left: number;
}

/** Wide enough for the range, the field and the button; the chip is clamped to the grid. */
const CHIP_WIDTH = 260;

/** A touch device: the chip waits for a tap rather than raising the keyboard. */
function coarsePointer(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}
```

- [ ] **Step 4: Offer the chip at the end of a stroke**

In `Editor`, delete the `postedAway` state and the `unposted` helper, and add the chip state and
its handlers after `switchPage`:

```tsx
  const [chip, setChip] = useState<Chip | null>(null);
  /** The cell element for a slot key, for positioning the chip. */
  const cellEl = (key: string) =>
    gridEl.current?.querySelector<HTMLElement>(`.cell[data-slot="${key}"]`) ?? null;
  /**
   * Put a chip under `el` for the entry covering `date`. `list` is passed in rather than read
   * off state: the caller has usually just built the entry the chip is about.
   */
  const offerChip = (
    list: AwayEntry[], date: string, hm: string, el: HTMLElement | null, focus: boolean,
  ) => {
    const wrap = wrapEl.current;
    const entry = entryAt(list, date, hm);
    if (!wrap || !el || !entry) { setChip(null); return; }
    const r = el.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setChip({
      date,
      hm,
      note: entry.note ?? '',
      focus,
      top: r.bottom - w.top + 6,
      left: Math.max(4, Math.min(r.left - w.left, w.width - CHIP_WIDTH)),
    });
  };
  const chipEntry = chip ? entryAt(away, chip.date, chip.hm) : undefined;
  const saveChip = () => {
    if (!chip || !chipEntry) { setChip(null); return; }
    setAway(withNote(away, chipEntry, chip.note.trim()));
    setChip(null);
  };
```

`switchPage` and `startStroke` dismiss it — add `setChip(null);` as the first line of `switchPage`,
and to `startStroke`'s dated branch just after the past-day guard:

```tsx
    const at = local.get(cell.keys[0]);
    if (!at || at.date < today) return;
    setChip(null);
```

Replace the window pointer-end effect with one that ends the stroke through a ref, so the handler
always sees the current state:

```tsx
  /**
   * Where a stroke ends. On a dated page that added away, the chip is offered under the
   * bottom-most cell of the rectangle, in the column the pointer left from — which is where
   * the eye already is.
   */
  const endStroke = () => {
    cancelPress();
    const d = drag.current;
    drag.current = null;
    if (!d || !d.days || d.op !== 'add') return;
    const pa = pos.get(d.anchor.keys[0]);
    const pb = pos.get(d.last.keys[0]);
    const bottom = (pa && pb ? hours[Math.max(pa.ri, pb.ri)].cells[pb.ci] : null) ?? d.last;
    const at = local.get(bottom.keys[0]);
    const anchor = local.get(d.anchor.keys[0]);
    if (at && anchor) offerChip(away, at.date, anchor.hm, cellEl(bottom.keys[0]), !d.touch);
  };
  const endRef = useRef(endStroke);
  endRef.current = endStroke;
  // A pointer released off the grid (or cancelled by the OS) must still end the stroke.
  useEffect(() => {
    const end = () => endRef.current();
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, []);
```

And offer one after a header tap, replacing `onHead`:

```tsx
  const onHead = (date: string) => (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!dated || date < today) return;
    setChip(null);
    const had = days.has(date);
    const next = compactAway(away, dates![0], dates![6], toggleAllDay(days, date));
    setAway(next);
    // A fresh all-day column has something to say; clearing one has not.
    if (!had) offerChip(next, date, '07:00', e.currentTarget, !coarsePointer());
  };
```

- [ ] **Step 5: Draw the chip and the away list**

In the JSX, inside `.gridwrap` and after the `.grid` div (so it is positioned against the wrap,
not the grid):

```tsx
        {chip && chipEntry && (
          <div className="note-chip" style={{ top: chip.top, left: chip.left }}>
            <span className="when">{`away ${chipWhen(chipEntry)}`}</span>
            <input
              type="text"
              maxLength={80}
              placeholder="add a note"
              aria-label="note"
              autoFocus={chip.focus}
              value={chip.note}
              onChange={(e) => setChip({ ...chip, note: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveChip();
                if (e.key === 'Escape') setChip(null);
              }}
            />
            <button type="button" className="ok" onClick={saveChip}>add</button>
          </div>
        )}
```

Replace the whole away block — the `<h3>away</h3>`, its hint, the `<ul className="away">`, the
`away-hint` paragraph and the `.away-form` div — with:

```tsx
      <div className="awaybox">
        <h3>away</h3>
        <ul className="away-list">
          {upcoming.map(({ a, i }) => (
            <li key={`${a.start}-${a.startTime ?? ''}-${i}`}>
              <button
                type="button"
                className="jump"
                // A range that started in a week already over jumps to this week, not to a
                // page the pager has no name for.
                onClick={() => switchPage(Math.max(0, weekOffsetOf(a.start, thisMonday)))}
              >
                <span className="when">{dateRangeLabel(a.start, a.end)}</span>
                {a.startTime && a.endTime && ` ${fmtClock(a.startTime)}–${fmtClock(a.endTime)}`}
              </button>
              {editing === i ? (
                <input
                  className="note-edit"
                  type="text"
                  maxLength={80}
                  placeholder="wedding"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    // Escape puts the note back and lets the blur below save that, which is
                    // the same value the entry already has.
                    if (e.key === 'Escape') { setDraft(a.note ?? ''); e.currentTarget.blur(); }
                  }}
                  onBlur={() => { setEditing(null); setAway(withNote(away, a, draft.trim())); }}
                />
              ) : (
                <button
                  type="button"
                  className={cn('note', !a.note && 'add')}
                  onClick={() => { setEditing(i); setDraft(a.note ?? ''); }}
                >{a.note ? `· ${a.note}` : '+ note'}</button>
              )}
              <button
                type="button"
                className="x"
                aria-label="remove"
                onClick={() => { setChip(null); setAway(away.filter((_, j) => j !== i)); }}
              >remove</button>
            </li>
          ))}
        </ul>
        {upcoming.length === 0 && (
          <p className="hint">nothing yet. page to a week, then drag hours or tap a day.</p>
        )}
      </div>
```

Add the list's state and the two labels it needs, after the chip state:

```tsx
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  // Entries already over are not the record any more: nothing can be done about them, and
  // the list is a list of things to edit.
  const upcoming = away.map((a, i) => ({ a, i })).filter(({ a }) => a.end >= today);
```

and at module level, beside `entryAt`:

```tsx
/** `sep 19 11am–3pm`, or `oct 3 – 5 all day` — what the chip and the list call an entry. */
function chipWhen(a: AwayEntry): string {
  return `${dateRangeLabel(a.start, a.end)}${a.startTime && a.endTime
    ? ` ${fmtClock(a.startTime)}–${fmtClock(a.endTime)}`
    : ' all day'}`;
}
```

Delete the now-unused `fmtDate` helper (the list uses `dateRangeLabel`), and in `submit` delete the
`setPostedAway(…)` line.

- [ ] **Step 6: Drop the dead CSS**

In `src/web/styles/app.css`, inside the `#availability-root` block, delete the five rules for the
markup that is gone: `.away`, `.away li`, `.away .when`, `.away .note`, `.away-form`,
`.away-form label, .away-form input`, `.away .unposted` and `.away-hint`.

- [ ] **Step 7: Run the e2e and the suite**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: PASS.
Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/web/islands/availability.tsx src/web/styles/app.css e2e/availability.spec.ts
git commit -m "feat(availability): a note chip on the grid, and the away list as the record

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Autosave, and a status line instead of a post button

> **Amendment (2026-09-18, decided by the human after the plan was written):** the away list shows only entries ending today or later, so a past entry can never be removed by hand. To keep the record from growing toward the lexicon's 100-entry cap, the island prunes past entries when it builds a post: add a pure `pruneAway(entries: AwayEntry[], today: string): AwayEntry[]` to `src/core/awayDays.ts` that drops entries whose `end` is before `today` (ISO date in the record's zone), with a test (one past, one ending today, one future → only the past one goes), and call it in the autosave path right before the body is assembled so the pruned record is what is posted and compared. Pruning happens only as part of a user-initiated post, never on its own.

Every change posts about two seconds after the last one — never mid-stroke, and one post at a time. The sticky bottom line says where that stands, and carries the error and a `retry` when it fails.

**Files:**
- Modify: `src/web/islands/availability.tsx`, `src/web/styles/app.css`
- Test: `e2e/availability.spec.ts`

**Interfaces:**
- Produces: `SAVE_MS = 2000`; DOM hooks `.status`, `.status .dot`, `.status .retry`.
- Removed: `submit`, the `saving` and `dirty` state, `button.save`, `.save-bar`.

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/availability.spec.ts`:

Delete the early `.address-line` assertion with `(not saved yet)` (autosave clears it within
seconds, so it is a race), leaving the `page.fill` of the alias.

**Move** the timezone fill and its comment up, to just after that alias fill, so the record is in
UTC from the first post (the grid is redrawn in UTC, and the column/cell indexes below do not
change):

```ts
  // Timezone is what the grid is drawn in; the browser is pinned to UTC in the config.
  await page.fill('#availability-root input[list=tz-list]', 'UTC');
```

Then, where the post click used to be (after the chip's note is saved), **replace** the
`page.click('#availability-root button.save')` line and the `availability posted.` assertion with:

```ts
  // No post button: the status line posts two seconds after the last change.
  await expect(page.locator('#availability-root button.save')).toHaveCount(0);
  await expect(page.locator('#availability-root .status')).toHaveText('posted.', { timeout: 15_000 });
  await expect(page.locator('#availability-root .address-line'))
    .toHaveText(`your address: ${name}.sez.localhost:8787`);
```

- [ ] **Step 2: Run the e2e to see it fail**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: FAIL — `.status` never reads `posted.`; nothing posts without the button.

- [ ] **Step 3: Replace the submit path with autosave**

In `src/web/islands/availability.tsx`, add beside `HOLD_MS`:

```tsx
/** How long after the last change the record is posted. */
const SAVE_MS = 2000;
```

Replace the `saving` / `savedAt` / `dirty` state and the whole `submit` function with:

```tsx
  // ---- autosave: about two seconds after the last change, one post at a time
  const [savedAt, setSavedAt] = useState(
    snapshot(data.weekly, data.away, data.note, data.validUntil, data.timezone ?? HERE, data.aliasSaved));
  const [pending, setPending] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether there is anything up there at all: an editor opened on an empty record has
  // nothing posted, and should not claim it has.
  const [posted, setPosted] = useState(
    data.weekly.length > 0 || data.away.length > 0 || !!data.note || !!data.validUntil
    || !!data.aliasSaved);
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  const requeue = useRef(false);
  /**
   * The live record, read by a post that fires after the render which changed it — a
   * closure would still be holding the values from the render that scheduled it.
   */
  const latest = useRef({ zone, weekly, away, note, validUntil, alias });
  latest.current = { zone, weekly, away, note, validUntil, alias };

  /** Every change funnels through here. A stroke in progress schedules nothing: `endStroke` does. */
  const queueSave = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void post(); }, SAVE_MS);
    setPending(true);
    setError(null);
  };
  /** `retry`, and a text field losing focus: post now rather than in two seconds. */
  const saveNow = () => {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    void post();
  };
  /** A blur that follows a change. A blur that follows nothing posts nothing. */
  const flush = () => { if (pending) saveNow(); };

  const post = async () => {
    // One in flight at a time; a change made during a post schedules the next one.
    if (inFlight.current) { requeue.current = true; return; }
    const body = latest.current;
    const sent = snapshot(body.weekly, body.away, body.note, body.validUntil, body.zone, body.alias);
    if (sent === savedAt) { setPending(false); return; }
    inFlight.current = true;
    setPending(false);
    setPosting(true);
    try {
      const res = await fetch('/availability', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          timezone: body.zone, weekly: body.weekly, away: body.away, note: body.note,
          alias: body.alias,
          // A date the viewer picked, good until the end of that day where they are —
          // end-of-day UTC would expire an American record the evening before.
          validUntil: body.validUntil ? endOfLocalDay(body.validUntil, body.zone) : undefined,
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) { setError(out.error ?? 'could not post.'); return; }
      setError(null);
      setAliasSaved(body.alias);
      setSavedAt(sent);
      setPosted(true);
    } catch {
      setError('could not reach the server.');
    } finally {
      inFlight.current = false;
      setPosting(false);
      if (requeue.current) { requeue.current = false; queueSave(); }
    }
  };

  const statusText = error ? error
    : posting ? 'posting…'
      : pending ? 'not posted yet · posting in 2s'
        : posted ? 'posted.' : 'nothing posted yet.';
```

In `setPainted`, the two `setStatus` calls become `setError`:

```tsx
      setError(null);
    } catch (err) {
      setError(err instanceof UserError ? err.message : 'could not mark that.');
    }
```

and delete the `const [status, setStatus] = useState<string | null>(null);` line.

- [ ] **Step 4: Queue a save at every change**

Add `queueSave();` as the last statement of each of these, all in `Editor`:

- `endStroke` — right after `drag.current = null;`, before the `if (!d …) return;` guard, as
  `if (d) queueSave();` so a released pointer that was not a stroke posts nothing:
  ```tsx
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    queueSave();
    if (!d.days || d.op !== 'add') return;
  ```
- `startStroke`'s all-day unlock branch, after `setAway(…)`.
- `onHead`, after `setAway(next);`.
- `saveChip`, after `setAway(withNote(…));`.
- the away list's note `onBlur`, after `setAway(withNote(away, a, draft.trim()));`.
- the away list's `remove` button, after `setAway(away.filter(…));`.

And in the details block, queue on change and flush on blur:

```tsx
        <label>timezone
          <input
            type="text"
            value={zoneText}
            list="tz-list"
            onChange={(e) => {
              const v = e.target.value;
              setZoneText(v);
              if (knownZone(v)) { setZone(v); queueSave(); }
            }}
            onBlur={flush}
          />
          <datalist id="tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
        <label>good through
          <input
            type="date"
            value={validUntil}
            onChange={(e) => { setValidUntil(e.target.value); queueSave(); }}
            onBlur={flush}
          />
        </label>
        <label className="full">note for friends
          <input
            type="text"
            maxLength={300}
            placeholder="text me first, weeknights are flexible"
            value={note}
            onChange={(e) => { setNote(e.target.value); queueSave(); }}
            onBlur={flush}
          />
        </label>
        <label className="full">your address
          <span className="address-field">
            <input
              type="text"
              name="alias"
              maxLength={32}
              value={alias}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder="pick a name"
              onChange={(e) => {
                const v = e.target.value.trim().toLowerCase();
                setAlias(v);
                // A name that breaks the rule has nothing to post: the hint below says why.
                if (v === '' || isValidSezName(v)) queueSave();
              }}
              onBlur={flush}
            />
            <span className="suffix">.{data.sezSuffix}</span>
          </span>
        </label>
```

- [ ] **Step 5: The status line replaces the save bar**

Replace the `.save-bar` div at the end of the JSX with:

```tsx
      {/* Sticky at the bottom of the viewport while the editor is on screen: this line is
          the only thing that says whether what is on the grid is up there too. */}
      <div className={cn('status', (pending || posting) && 'busy')} role="status">
        <span className="dot" />
        <span>{statusText}</span>
        {error && <button type="button" className="retry" onClick={saveNow}>retry</button>}
      </div>
```

In `src/web/styles/app.css`, in the `#availability-root` block, replace the `.save-bar` rules
(`.save-bar`, `.save-bar .status`, `.save-bar .save`) with:

```css
    /* The status line rides the bottom of the viewport while the editor is on screen. */
    .status {
      position: sticky; bottom: 0; z-index: 3;
      display: flex; align-items: center; gap: 10px;
      margin: 12px 0 0; padding: 8px 0;
      background: var(--background); border-top: 1px solid var(--border);
      color: var(--muted-foreground);
    }
    .status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); flex: 0 0 auto; }
    .status.busy .dot { background: var(--lol); animation: blink 900ms steps(2, start) infinite; }
    @media (prefers-reduced-motion: reduce) { .status.busy .dot { animation: none; } }
    .status .retry {
      font-family: var(--font-pixel); font-size: 11px; background: none; border: 0; padding: 0;
      color: var(--primary-ink); text-decoration: underline; text-underline-offset: 3px;
      -webkit-font-smoothing: none;
    }
```

(The shared `:is(#grid-root, #reply-root, #availability-root) .status` rule above already gives it
the pixel face; `@keyframes blink` is defined in the components layer and is reused here.)

- [ ] **Step 6: Run everything**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: PASS.
Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web/islands/availability.tsx src/web/styles/app.css e2e/availability.spec.ts
git commit -m "feat(availability): autosave two seconds after the last change, no post button

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: Notes on the editor's grid, the deal, and the mobile pass

The last island step: the same note labels the friend view draws, placed from the cells' own rects; the columns re-deal themselves on a page change; and the e2e checks the public page and the phone.

**Files:**
- Modify: `src/web/islands/availability.tsx`
- Test: `e2e/availability.spec.ts`

**Interfaces:** consumes `weekNoteZones`, `MIN_LABEL_ROWS` (Task 3) and `fitLabel` (Task 4). DOM hooks: `.grid .zlabel`, `.col.deal`.

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/availability.spec.ts`, after the away-list reload assertions, add the label on the editor's
own grid:

```ts
  // The note is drawn inside its own away block, on the editor's grid too.
  await page.click('#availability-root .pager .arrow >> nth=1');
  await expect(page.locator('#availability-root .grid .zlabel')).toHaveText('out of town');
```

In the public-page section, add the label beside the orange-cell assertion Task 12 put there:

```ts
  // The away block is orange, four hours of it, with the note drawn inside it.
  await expect(page.locator('.week-cell.away')).toHaveCount(4);
  await expect(page.locator('.week .zlabel')).toHaveText('out of town');
```

At the end of the test, add the phone checks:

```ts
  // The mobile project only: the week card bleeds to the screen edges, and the day headers
  // stay put while the grid scrolls past them.
  if (test.info().project.name === 'mobile') {
    await page.goto('/availability');
    // The island's card is the first card on the page (the banners above it are <p>).
    const box = (await page.locator('[data-slot="card"]').first().boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(0.5);
    expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 0.5);
    // The day headers are sticky, and the grid is not its own scrollport — so scrolling the
    // grid's top past the viewport leaves the header at the top of it.
    expect(await page.evaluate(() => getComputedStyle(
      document.querySelector('#availability-root .col-head')!).position)).toBe('sticky');
    await page.evaluate(() => window.scrollBy(0, 400));
    const offsets = await page.evaluate(() => ({
      grid: document.querySelector('#availability-root .grid')!.getBoundingClientRect().top,
      head: document.querySelector('#availability-root .col[data-c="0"] .col-head')!
        .getBoundingClientRect().top,
    }));
    expect(offsets.grid).toBeLessThan(0);
    expect(offsets.head).toBeGreaterThanOrEqual(-1);
  }
```

- [ ] **Step 2: Run the e2e to see it fail**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
Expected: FAIL — `#availability-root .grid .zlabel` does not exist.

- [ ] **Step 3: Place the labels from the cells' rects**

In `src/web/islands/availability.tsx`, add to the core imports:

```tsx
import { fitLabel, type LabelFit } from '../../core/labelFit.js';
```
and add `weekNoteZones, MIN_LABEL_ROWS` to the `weekView.js` import.

Add beside `SAVE_MS`:

```tsx
/** The deal: seven columns, 25ms apart, 320ms each — plus the numbers dropping in behind. */
const DEAL_MS = 7 * 25 + 320;
```

In `Editor`, after the `pos` memo:

```tsx
  /** A note label, placed over the block it belongs to inside `.grid`. */
  interface Placed { note: string; past: boolean; fit: LabelFit; box: CSSProperties }
  const [labels, setLabels] = useState<Placed[]>([]);
  /**
   * The labels are the one thing on the grid that cannot come out of the record alone: a
   * rectangle of cells has a pixel size only the browser knows. So they are placed from the
   * cells' own rects — after every paint and page change (twice: once now, once when the
   * deal has landed and the columns have settled) and on every resize.
   */
  useEffect(() => {
    const place = () => {
      const grid = gridEl.current;
      if (!grid || !dates) { setLabels([]); return; }
      const frame = grid.getBoundingClientRect();
      const out: Placed[] = [];
      for (const z of weekNoteZones({ timezone: zone, weekly, away }, { monday: dates[0], today })) {
        if (z.h1 - z.h0 + 1 < MIN_LABEL_ROWS) continue;
        const rowA = hours.find((r) => r.hour === z.h0)?.cells[z.c0];
        const rowB = hours.find((r) => r.hour === z.h1)?.cells[z.c1];
        const a = rowA && cellEl(rowA.keys[0]);
        const b = rowB && cellEl(rowB.keys[0]);
        if (!a || !b) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const box = {
          left: ra.left - frame.left, top: ra.top - frame.top,
          width: rb.right - ra.left, height: rb.bottom - ra.top,
        };
        out.push({ note: z.note, past: z.past, fit: fitLabel(z.note, box.width, box.height), box });
      }
      setLabels(out);
    };
    place();
    const settled = window.setTimeout(place, DEAL_MS);
    window.addEventListener('resize', place);
    return () => {
      window.clearTimeout(settled);
      window.removeEventListener('resize', place);
    };
  }, [dates, zone, weekly, away, today, hours]);
```

Render them as the last children of `.grid`, after the column map:

```tsx
          {labels.map((l, i) => (
            <div
              key={`zone-${i}`}
              className={cn('zlabel', l.fit.orient, l.fit.lines === 1 && 'one', l.past && 'past')}
              style={l.box}
            >{l.note}</div>
          ))}
```

- [ ] **Step 4: Deal the columns on a page change**

In `Editor`, add the flag and set it in `switchPage`:

```tsx
  // The first page the editor opens on arrives without a deal; every change of page after
  // that re-deals the columns. The columns are keyed by date, so a page change remounts them
  // and the animation runs once, on its own.
  const [dealt, setDealt] = useState(false);
```
```tsx
  const switchPage = (next: Page) => {
    setChip(null);
    if (next === page) return;
    setPickerOpen(false);
    setPage(next);
    setDealt(true);
  };
```

and add the class to the column:

```tsx
            <div
              className={cn('col', dated && d < today && 'past', dealt && 'deal')}
              key={d}
              data-c={ci}
              style={{ '--i': ci + 1 } as CSSProperties}
            >
```

- [ ] **Step 5: Run the e2e on every project**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts`
Expected: PASS on chromium, firefox, tz-kolkata and mobile. The mobile run is the one that
exercises the tap path through the chip and the sticky header; if the sticky assertion fails,
check that `#availability-root .grid` really has `overflow: visible` in the built sheet
(`grep -o '#availability-root .grid{[^}]*}' public/assets/app.css`) — a horizontal scroll
container is also a vertical scrollport, and a sticky child of one never moves.

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/web/islands/availability.tsx e2e/availability.spec.ts
git commit -m "feat(availability): notes on the editor's grid, and the columns re-deal on a page change

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Whole-suite verification and the branch

Nothing new is written here: this is the pass that proves the branch is mergeable, and the place to
catch anything the task-by-task runs left behind.

**Files:** none (unless a failure sends you back into one).

- [ ] **Step 1: The whole vitest suite and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, with at least these new tests present: `tests/core/awayDays.test.ts` (16),
`tests/core/labelFit.test.ts` (8), plus the additions to `availability`, `weekView`, `auth`,
`availabilityRoutes`, `publicAvailability` and `css`.

- [ ] **Step 2: Every e2e project**

Run: `npm run build:client && npx playwright test`
Expected: PASS — `e2e/availability.spec.ts` and `e2e/poll.spec.ts` on all four projects. The poll
spec touches the same grid CSS (`.col-head` is now sticky for it too, and inert there); if a poll
test fails on geometry, the cause is in `app.css`, not in the poll island.

- [ ] **Step 3: Read the diff once, for the things tests do not see**

Run: `git diff main --stat && git log --oneline main..HEAD`
Expected: fourteen commits, and no file outside the list in "File Structure".

- [ ] **Step 4: Leave the branch ready**

The branch is `availability-lenses`. Deploy is automatic on a push to `main` (GitHub Actions), so
stop here: do not push. Report the commit list and hand over.
