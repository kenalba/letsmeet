# Editor hour rows, grid hover, address line, poll archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four small, approved polish items on letsmeet: the availability editor marks by the hour; the friend view's grid has hover states; the sez address line is hidden on the alias host and selects itself on click elsewhere; polls that are over leave the landing for an archive page.

**Architecture:** No schema or database change. Editor hour rows are a view over the existing half-hour slots (a core module pairs slots into hour cells; the island renders and strokes by hour cell). Hover is CSS only, on data attributes the friend view already can emit. The address line is a route flag. The archive is a pure `isOver(record, now)` predicate applied in the landing route plus one new page and route.

**Tech Stack:** Hono, React 19 SSR + esbuild islands, luxon, Tailwind v4 (`src/web/styles/app.css`, `@layer island`), Vitest, Playwright (`npm run e2e`, FAKE_PDS server on :8787).

**Spec:** Bounded path, no spec file. The design, approved by Ken in chat on 2026-09-16, is restated in full under "Design" below; it is the authority for the tasks. Ken's words on the additions: "clicking the thing worth copying should automatically select it. great on the hover. editor hour rows sounds right. otherwise looks good, yes."

## Global Constraints

- Copy on pages is lowercase, in the site's plain voice (`nothing here yet.`), never title case.
- CSS: colours only via tokens (`var(--primary)`, `var(--foreground)`, `var(--muted)`, `var(--card)`, `var(--muted-foreground)`, `var(--border)`), so dark mode follows. New rules go in the `@layer island` blocks of `src/web/styles/app.css`. Hover rules are wrapped in `@media (hover: hover)` so touch devices get no sticky hover.
- No new dependencies.
- Tests: `npm test` (Vitest, 427 passing on main) must stay green after every task; `npm run build:client` must succeed. The e2e suite (`npm run e2e`) is run at Task 4 and Task 6.
- Commit messages: lowercase conventional prefix (`feat(availability): …`, `fix(landing): …`), one commit per task unless the task says otherwise, and every commit ends with exactly these two trailer lines:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01B5KngXbJkihaNmGg5hVfPV
  ```
- Never run `pkill -f` with a pattern that could match your own shell; to free port 8787 use `fuser -k 8787/tcp`.
- The half-hour record format is untouched: `weekly` blocks stay half-hour aligned; the friend view, ICS feed and poll prefill keep working unchanged.

## Design (approved)

1. **Address line on the friend view.** `/u/<handle>` keeps the `<name>.sez.<site>` line under the handle; the alias host (`<name>.sez.<site>/`) omits it, because the address bar already shows it. Where shown, one click selects the whole address (`user-select: all`, Tailwind's `select-all` utility).
2. **Hover on the friend-view grid.** The hovered cell gets a 2px ink outline (`var(--foreground)`, readable on both a free green cell and a muted empty one). Its hour label and its day header turn from muted to ink so "thu 5pm" reads without hunting. CSS only: each hour row is wrapped in a `display: contents` `.week-row`, so `.week-row:hover .week-axis` lights the label; columns carry `data-c="0".."6"` on head and cells, and seven `:has()` rules light the head. The native `title` tooltip stays. The editor's cells get the same ink outline on hover.
3. **Editor hour rows.** The half-hour slots stay underneath; each visible cell is one hour made of its two slots (one at a DST edge). A cell is `available` when every half is marked, `early` (top half filled) when only the first is, `late` (bottom half) when only the second is. A stroke over a rectangle of hour cells marks or clears both halves of every hour in it; the operation is `remove` only when the anchor hour is fully marked, so a half-filled anchor fills. Seventeen rows (7am..11pm) instead of thirty-four. The sentence still reads a saved 5:30pm until that hour is touched. The poll grid (`grid.tsx`) is untouched.
4. **Archive.** A poll is *over* when it is finalized and the chosen time has ended, or, undecided, when the last day it offered has ended in the poll's own timezone. Over polls leave "your polls" and "polls you answered" on the landing. The "your polls" card ends with a muted `archive · N` link to `/archive` when N > 0 (N counts both hosted and answered over polls). `/archive` needs sign-in and lists the over polls with the same rows, under "your polls" and (only when any) "polls you answered", with a `← your polls` link back to `/`. Empty: `nothing here yet. polls land here once their day has passed.`

## File map

- `src/core/hourCells.ts` (new): `hourRows`, `hourState`, `hourStrokeOp`, `hourRectKeys`.
- `src/core/archive.ts` (new): `isOver`.
- `src/web/islands/availability.tsx`: render and stroke by hour cell.
- `src/web/pages/PublicAvailability.tsx`: `.week-row` wrappers, `data-c`, `select-all` on the address.
- `src/web/routes/availability.ts`: `friendView` takes whether to show the address.
- `src/web/routes/polls.ts`: landing filters over polls, counts them; new `GET /archive`.
- `src/web/pages/Landing.tsx`: export `PollList`; `archived` prop and link.
- `src/web/pages/Archive.tsx` (new).
- `src/web/styles/app.css`: hover rules, `.week-row`, editor `.early`/`.late`.
- Tests: `tests/core/hourCells.test.ts` (new), `tests/core/archive.test.ts` (new), `tests/web/publicAvailability.test.ts`, `tests/web/css.test.ts`, `tests/web/server.test.ts`, `e2e/availability.spec.ts`.

---

### Task 1: The address line — off the alias host, click to select

**Files:**
- Modify: `src/web/routes/availability.ts` (the `friendView` helper, ~line 248, and its two callers)
- Modify: `src/web/pages/PublicAvailability.tsx` (the `<p>` with `data.sezAddress`, ~line 112)
- Test: `tests/web/publicAvailability.test.ts`, `tests/web/css.test.ts`

**Interfaces:**
- Consumes: `sezAddressFor(deps, did, handle, publicUrl)` (existing), `PublicAvailabilityData.sezAddress?: string` (existing).
- Produces: `friendView(c, r, { address: boolean })`.

- [ ] **Step 1: Write the failing tests**

In `tests/web/publicAvailability.test.ts`, inside `describe('<name>.sez.letsmeet.lol', …)`, extend the existing test `'shows the address on the friend view: the claimed name, else the hyphenated handle'` so its last two assertions become:

```ts
    html = await (await app.request('/u/ken.wzrdz.cool')).text();
    expect(html).toContain('ken.sez.letsmeet.lol');
    expect(html).not.toContain('ken-wzrdz-cool.sez');
    // One click selects the whole address.
    expect(html).toContain('<p class="pixel-label text-muted-foreground select-all">ken.sez.letsmeet.lol</p>');
```

and add, right after it:

```ts
  it('leaves the address off the alias host, where the address bar already shows it', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    const html = await (await app.request('/', host('ken.sez.letsmeet.lol'))).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).not.toContain('>ken.sez.letsmeet.lol<');
    expect(html).not.toContain('select-all');
  });
```

In `tests/web/css.test.ts`, add inside `describe('built app.css', …)`:

```ts
  it('emits the select-all utility the address line uses', () => {
    expect(css).toMatch(/\.select-all\{[^}]*user-select:all/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/web/publicAvailability.test.ts tests/web/css.test.ts`
Expected: the extended test fails on the `select-all` markup; the new alias test fails on `not.toContain('>ken.sez.letsmeet.lol<')`; the css test fails (no `.select-all` rule yet, because no source file uses the class).

- [ ] **Step 3: Implement**

`src/web/routes/availability.ts` — change `friendView` to:

```ts
  /**
   * The friend view. Shared by `/u/:handle` and the `<name>.sez.<site>` alias; the address
   * line is for the apex page only — on the alias host the address bar already shows it.
   */
  const friendView = (c: Context, r: Found, opts: { address: boolean }) =>
    page(c, createElement(PublicAvailabilityPage, {
      handle: r.handle, record: r.record, now: deps.now(), publicUrl: env.PUBLIC_URL,
      sezAddress: opts.address ? sezAddressFor(deps, r.did, r.handle, env.PUBLIC_URL) ?? undefined : undefined,
      week: weekChoice(c.req.query('week')),
    }));
```

The `/u/:handle` handler calls `friendView(c, r, { address: true })`; the alias `app.get('/', …)` handler calls `friendView(c, r, { address: false })`.

`src/web/pages/PublicAvailability.tsx` — the address line becomes:

```tsx
          {/* `select-all`: one click selects the whole address, the thing worth copying. */}
          {data.sezAddress && <p className="pixel-label text-muted-foreground select-all">{data.sezAddress}</p>}
```

Tailwind v4 scans the source tree, so using the `select-all` class in a `.tsx` file is what makes the rule appear in the built sheet. If `npm run build:css` does not emit `.select-all{…user-select:all…}` (check with `grep -c 'select-all' public/assets/app.css`), add `@source "../pages";` is NOT the fix (pages are already scanned — the existing `pixel-label` proves it); instead check the class is spelled exactly `select-all`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/web/publicAvailability.test.ts tests/web/css.test.ts`
Expected: PASS. Then `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/availability.ts src/web/pages/PublicAvailability.tsx tests/web/publicAvailability.test.ts tests/web/css.test.ts
git commit -m "feat(availability): the address line selects on click and stays off the alias host"
```
(with the two trailer lines from Global Constraints)

---

### Task 2: Hover states on the friend-view grid

**Files:**
- Modify: `src/web/pages/PublicAvailability.tsx` (`WeekGrid`, ~lines 38–68)
- Modify: `src/web/styles/app.css` (the `@layer island { .week … }` block at the end of the file)
- Test: `tests/web/publicAvailability.test.ts`, `tests/web/css.test.ts`

**Interfaces:**
- Consumes: `WeekView` (`view.days[]`, `d.cells[hi]`), `HOURS`, `hourLabel` from `src/core/weekView.ts`.
- Produces: markup — `.week-head[data-c]`, `.week-row` (one per hour, `display: contents`), `.week-cell[data-c]`. The e2e count `page.locator('.week-cell')` = 119 must not change.

- [ ] **Step 1: Write the failing tests**

In `tests/web/publicAvailability.test.ts`, `describe('the week grid', …)`, add:

```ts
  it('wraps each hour in a row and tags columns, so hover can light the axis and the day', () => {
    const html = render();
    expect(html.match(/class="week-row"/g)?.length).toBe(17);
    // Seven heads and 7×17 cells carry their column index.
    expect(html.match(/class="week-head[^"]*" data-c="6"/g)?.length).toBe(1);
    expect(html.match(/class="week-cell[^"]*" data-c="0"/g)?.length).toBe(17);
    expect(html.match(/class="week-cell/g)?.length).toBe(7 * 17);
  });
```

In `tests/web/css.test.ts` add:

```ts
  it('lights the hovered week cell, its hour and its day, only where there is a pointer', () => {
    const hover = /@media \(hover:hover\)\{([\s\S]*?)\}\}/g;
    const blocks = [...css.matchAll(hover)].map((m) => m[1]).join('\n');
    expect(blocks).toMatch(/\.week-cell:hover\{[^}]*outline:2px solid var\(--foreground\)/);
    expect(blocks).toContain('.week-row:hover .week-axis');
    expect(blocks).toMatch(/\.week:has\(\.week-cell\[data-c=["']?6["']?\]:hover\) \.week-head\[data-c=["']?6["']?\]/);
    expect(css).toMatch(/\.week-row\{display:contents\}/);
  });
```

If the minifier merges or reorders the `@media (hover:hover)` blocks so the regex above misses, relax the regex to search the whole `css` string for each selector rather than inside the media block — but keep an assertion that `@media (hover:hover)` exists in the sheet.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/web/publicAvailability.test.ts tests/web/css.test.ts`
Expected: FAIL (no `week-row`, no `data-c`, no hover rules).

- [ ] **Step 3: Implement the markup**

Replace `WeekGrid` in `src/web/pages/PublicAvailability.tsx` with:

```tsx
/**
 * Days across, hours down. Server-rendered; no script. Each hour is a `.week-row`
 * (`display: contents`, so the cells still sit in the grid) and every head and cell
 * carries its column index in `data-c`: that is all the hover rules in app.css need to
 * light the hovered cell's hour label and day header without a line of JavaScript.
 */
function WeekGrid({ view }: { view: WeekView }) {
  return (
    <div className="week" aria-label={`usual week, ${view.title}`} role="img">
      <div className="week-corner" />
      {view.days.map((d, ci) => (
        <div
          key={d.date}
          className={cn('week-head', d.past && 'past', d.today && 'today')}
          data-c={ci}
          title={d.awayAllDay !== null ? (d.awayAllDay || 'away') : undefined}
        >
          <b>{d.dom}</b>{d.dow}
          {d.awayAllDay !== null && <small>{d.awayAllDay || 'away'}</small>}
        </div>
      ))}
      {HOURS.map((h, hi) => (
        <div key={h} className="week-row">
          <div className="week-axis">{hourLabel(h)}</div>
          {view.days.map((d, ci) => {
            const c = d.cells[hi];
            return (
              <div
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state, d.past && 'past')}
                data-c={ci}
                title={`${d.dow} ${d.dom} ${hourLabel(h)}${c.note ? ` · ${c.note}` : ''}`}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
```

Remove the now-unused `Fragment` import.

- [ ] **Step 4: Implement the CSS**

In `src/web/styles/app.css`, in the final `@layer island { … .week … }` block, after the `.week-head.past, .week-cell.past { opacity: 0.42; }` line, add:

```css
  /* Each hour is a wrapper that takes no box of its own, so the cells still lay out in the
     grid — and so hovering any cell in the row is hovering the row. */
  .week-row { display: contents; }
  /* Hover: the cell under the pointer gets an ink outline (ink reads on both a free green
     cell and an empty muted one), and its hour label and day header step up from muted to
     ink so the time can be read without hunting. Pointer devices only: a touch would leave
     the last tapped cell lit. The seven column rules are the whole of what CSS needs to
     match a cell to its header — there is no variable attribute selector. */
  @media (hover: hover) {
    .week-cell:hover { outline: 2px solid var(--foreground); outline-offset: 1px; }
    .week-row:hover .week-axis { color: var(--foreground); }
    .week:has(.week-cell[data-c="0"]:hover) .week-head[data-c="0"],
    .week:has(.week-cell[data-c="1"]:hover) .week-head[data-c="1"],
    .week:has(.week-cell[data-c="2"]:hover) .week-head[data-c="2"],
    .week:has(.week-cell[data-c="3"]:hover) .week-head[data-c="3"],
    .week:has(.week-cell[data-c="4"]:hover) .week-head[data-c="4"],
    .week:has(.week-cell[data-c="5"]:hover) .week-head[data-c="5"],
    .week:has(.week-cell[data-c="6"]:hover) .week-head[data-c="6"] { color: var(--foreground); }
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/web/publicAvailability.test.ts tests/web/css.test.ts`, then `npm test`.
Expected: PASS.

- [ ] **Step 6: Look at it**

Run: `npm run build:client && npx vitest run tests/web/publicAvailability.test.ts` is not a visual check; instead render one page to a file and screenshot it with Playwright's CLI hovering a cell is not possible from the CLI, so verify by reading the built sheet: `grep -o '@media (hover:hover){[^@]*' public/assets/app.css | head -c 600`. The rules must be present and inside the media block.

- [ ] **Step 7: Commit**

```bash
git add src/web/pages/PublicAvailability.tsx src/web/styles/app.css tests/web/publicAvailability.test.ts tests/web/css.test.ts
git commit -m "feat(availability): hover lights a week cell, its hour and its day"
```
(with the two trailer lines)

---

### Task 3: Hour cells over half-hour slots (core)

**Files:**
- Create: `src/core/hourCells.ts`
- Test: `tests/core/hourCells.test.ts`

**Interfaces:**
- Consumes: `GridGeom`, `PaintMap`, `rectKeys` from `src/core/gridModel.ts`; `templateSlots(zone)` from `src/core/availability.ts` (returns `Interval[]` of 30-minute slots over a template week, 7am to midnight, in `zone`); luxon.
- Produces:
  ```ts
  export interface HourCell { keys: string[] }             // slot-start keys in this hour, in time order: two, or one at a DST edge
  export interface HourRow { hour: number; label: string; cells: (HourCell | null)[] } // one entry per geom.dates column; null = no slot this hour on that day
  export type HourState = 'none' | 'early' | 'late' | 'available';
  export function hourRows(geom: GridGeom, zone: string): HourRow[];
  export function hourState(painted: PaintMap, cell: HourCell): HourState;
  export function hourStrokeOp(painted: PaintMap, cell: HourCell): 'add' | 'remove';
  export function hourRectKeys(geom: GridGeom, a: HourCell, b: HourCell): string[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `tests/core/hourCells.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildGeom, applyPaint, type PaintMap } from '../../src/core/gridModel.js';
import { templateSlots } from '../../src/core/availability.js';
import { hourRows, hourState, hourStrokeOp, hourRectKeys } from '../../src/core/hourCells.js';

const geomIn = (zone: string) => buildGeom(templateSlots(zone), zone);

describe('hourRows', () => {
  it('pairs the template week\'s half hours into seventeen hour rows of seven cells', () => {
    const rows = hourRows(geomIn('America/New_York'), 'America/New_York');
    expect(rows.map((r) => r.hour)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(rows[0].label).toBe('7am');
    expect(rows[5].label).toBe('12pm');
    expect(rows[16].label).toBe('11pm');
    for (const r of rows) {
      expect(r.cells).toHaveLength(7);
      for (const c of r.cells) expect(c?.keys).toHaveLength(2);
    }
    // The first cell of the first row is Sunday 7:00 then 7:30, New York time.
    expect(rows[0].cells[0]!.keys).toEqual(['2026-01-04T12:00:00.000Z', '2026-01-04T12:30:00.000Z']);
  });
  it('is the same shape in utc', () => {
    const rows = hourRows(geomIn('UTC'), 'UTC');
    expect(rows).toHaveLength(17);
    expect(rows[0].cells[0]!.keys).toEqual(['2026-01-04T07:00:00.000Z', '2026-01-04T07:30:00.000Z']);
  });
  it('holds a null where a day has no slot at that hour', () => {
    // A hand-built geometry: Monday is missing its 8:00 and 8:30 slots.
    const zone = 'UTC';
    const slots = templateSlots(zone).filter((s) => !s.start.startsWith('2026-01-05T08:'));
    const rows = hourRows(buildGeom(slots, zone), zone);
    expect(rows[1].hour).toBe(8);
    expect(rows[1].cells[1]).toBeNull();
    expect(rows[1].cells[0]!.keys).toHaveLength(2);
  });
  it('keeps a lone half hour as a one-key cell', () => {
    const zone = 'UTC';
    const slots = templateSlots(zone).filter((s) => s.start !== '2026-01-05T08:30:00.000Z');
    const rows = hourRows(buildGeom(slots, zone), zone);
    expect(rows[1].cells[1]!.keys).toEqual(['2026-01-05T08:00:00.000Z']);
  });
});

describe('hourState and hourStrokeOp', () => {
  const cell = { keys: ['a', 'b'] };
  const paint = (...keys: string[]): PaintMap => new Map(keys.map((k) => [k, 'available' as const]));
  it('reads none, early, late and available', () => {
    expect(hourState(paint(), cell)).toBe('none');
    expect(hourState(paint('a'), cell)).toBe('early');
    expect(hourState(paint('b'), cell)).toBe('late');
    expect(hourState(paint('a', 'b'), cell)).toBe('available');
  });
  it('a one-key cell is available or none', () => {
    expect(hourState(paint('a'), { keys: ['a'] })).toBe('available');
    expect(hourState(paint(), { keys: ['a'] })).toBe('none');
  });
  it('removes only from a full hour; a half-filled anchor fills', () => {
    expect(hourStrokeOp(paint('a', 'b'), cell)).toBe('remove');
    expect(hourStrokeOp(paint('a'), cell)).toBe('add');
    expect(hourStrokeOp(paint(), cell)).toBe('add');
  });
});

describe('hourRectKeys', () => {
  const zone = 'UTC';
  const geom = geomIn(zone);
  const rows = hourRows(geom, zone);
  it('covers both halves of every hour in the rectangle, whichever corner is the anchor', () => {
    const sun7 = rows[0].cells[0]!; const tue9 = rows[2].cells[2]!;
    const down = hourRectKeys(geom, sun7, tue9);
    const up = hourRectKeys(geom, tue9, sun7);
    expect(down).toHaveLength(3 * 3 * 2);
    expect(new Set(up)).toEqual(new Set(down));
    expect(down).toContain('2026-01-04T07:00:00.000Z');
    expect(down).toContain('2026-01-06T09:30:00.000Z');
    expect(down).not.toContain('2026-01-06T10:00:00.000Z');
    expect(down).not.toContain('2026-01-07T07:00:00.000Z');
  });
  it('a single cell is its own two keys', () => {
    const c = rows[3].cells[4]!;
    expect(hourRectKeys(geom, c, c)).toEqual(c.keys);
  });
  it('applies through applyPaint like any key list', () => {
    const c = rows[0].cells[0]!;
    const next = applyPaint(new Map(), hourRectKeys(geom, c, c), 'add', 'available');
    expect(hourState(next, c)).toBe('available');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/hourCells.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/hourCells.ts`:

```ts
import { DateTime } from 'luxon';
import { rectKeys, type GridGeom, type PaintMap } from './gridModel.js';

/**
 * The availability editor marks by the hour while the record stays half-hour aligned: each
 * visible cell is one hour of one day, made of the half-hour slot keys underneath it. Two
 * keys as a rule; one where a DST edge leaves a day with a lone half hour; none (null in
 * the row) where a day has no slot at that hour at all.
 */
export interface HourCell { keys: string[] }
export interface HourRow { hour: number; label: string; cells: (HourCell | null)[] }
export type HourState = 'none' | 'early' | 'late' | 'available';

/** `7am`, `12pm`, `11pm`. */
function label(hour: number): string {
  return hour === 0 ? '12am' : hour === 12 ? '12pm' : hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/** The grid's rows: every wall-clock hour any column has a slot in, in order, with one cell per column. */
export function hourRows(geom: GridGeom, zone: string): HourRow[] {
  // column index -> hour -> keys in time order (columns are already sorted by start)
  const byCol = geom.dates.map((d) => {
    const m = new Map<number, string[]>();
    for (const k of geom.columns.get(d)!) {
      const h = DateTime.fromISO(k, { zone: 'utc' }).setZone(zone).hour;
      if (!m.has(h)) m.set(h, []);
      m.get(h)!.push(k);
    }
    return m;
  });
  const hours = [...new Set(byCol.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
  return hours.map((hour) => ({
    hour, label: label(hour),
    cells: byCol.map((m) => (m.has(hour) ? { keys: m.get(hour)! } : null)),
  }));
}

/** Full when every half is marked; early/late when only the first/second is; none otherwise. */
export function hourState(painted: PaintMap, cell: HourCell): HourState {
  const on = cell.keys.map((k) => painted.has(k));
  if (on.every(Boolean)) return 'available';
  if (!on.some(Boolean)) return 'none';
  return on[0] ? 'early' : 'late';
}

/** A stroke clears only a full hour; a half-filled anchor fills, which is the safe direction. */
export function hourStrokeOp(painted: PaintMap, cell: HourCell): 'add' | 'remove' {
  return hourState(painted, cell) === 'available' ? 'remove' : 'add';
}

/**
 * Every slot key in the rectangle of hours between two cells. `rectKeys` spans rows by slot,
 * so the two diagonals — first half of one corner to last half of the other, and back —
 * together cover both halves of every hour whichever corner the anchor is.
 */
export function hourRectKeys(geom: GridGeom, a: HourCell, b: HourCell): string[] {
  const first = (c: HourCell) => c.keys[0];
  const last = (c: HourCell) => c.keys[c.keys.length - 1];
  return [...new Set([...rectKeys(geom, first(a), last(b)), ...rectKeys(geom, last(a), first(b))])];
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/hourCells.test.ts`, then `npm test`.
Expected: PASS. If the `2026-01-04T12:00:00.000Z` expectation fails only on the millisecond format, check what `templateSlots` emits (`Interval.start` is "UTC ISO, normalized") and match that spelling in the test — but do not change the shape of the assertion.

- [ ] **Step 5: Commit**

```bash
git add src/core/hourCells.ts tests/core/hourCells.test.ts
git commit -m "feat(availability): hour cells over the editor's half-hour slots"
```
(with the two trailer lines)

---

### Task 4: The editor marks by the hour

**Files:**
- Modify: `src/web/islands/availability.tsx` (the `rows`/`colMaps` memos, the stroke handlers, `cell()`, and the grid JSX)
- Modify: `src/web/styles/app.css` (the `#availability-root { … }` block at ~line 533, the one holding `.away` and `.away-form` rules)
- Modify: `e2e/availability.spec.ts`
- Test: `npm test`, `npm run e2e`

**Interfaces:**
- Consumes: `hourRows`, `hourState`, `hourStrokeOp`, `hourRectKeys`, `HourCell` from `src/core/hourCells.ts` (Task 3); `applyPaint` from gridModel (existing).
- Produces: editor markup — `.cell[data-slot]` per hour (`data-slot` = the hour's first key), classes `available` / `early` / `late`; `.cell.gap` where a day has no slot that hour. 17 rows.

- [ ] **Step 1: Update the e2e expectations first**

In `e2e/availability.spec.ts`, replace the three "Mark Sunday 7:00–8:00" lines and the reload check:

```ts
  // Mark Sunday 7am–8am (the first hour cell of the first column) and read it back: one
  // hour cell, which is two half-hour blocks in the record.
  await markCells(page, '#availability-root', 0, 0);
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(1);
  await expect(page.locator('#availability-root .sentence')).toHaveText('usually free sundays 7am to 8am.');
```

and after `await page.reload();`:

```ts
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(1);
```

Leave the poll-grid assertion (`#grid-root .cell.available` → 2) as it is: the poll grid still has half-hour slots.

- [ ] **Step 2: Implement the island**

In `src/web/islands/availability.tsx`:

Imports — add after the gridModel import:

```ts
import { hourRows, hourState, hourStrokeOp, hourRectKeys, type HourCell } from '../../core/hourCells.js';
```

Remove `minutesInZone` (no longer used) and keep `fmtAxisTime` only if still referenced (it is not after this change — remove it too, and the `rows`/`colMaps` memos). Replace the `rows` and `colMaps` memos with:

```ts
  // Hour rows over the half-hour slots (core/hourCells.ts): the record stays half-hour
  // aligned; the grid draws and strokes by the hour.
  const hours = useMemo(() => hourRows(geom, zone), [geom, zone]);
  // The element under a moving pointer names its hour by the hour's first slot key.
  const cellByKey = useMemo(() => {
    const m = new Map<string, HourCell>();
    for (const r of hours) for (const c of r.cells) if (c) m.set(c.keys[0], c);
    return m;
  }, [hours]);
```

The stroke refs and handlers: `drag` holds `{ anchor: HourCell; op; base; touch }`; `press` holds `{ key: string; timer }` where `key` is the cell's first slot key.

```ts
  const paintTo = (cell: HourCell) => {
    const d = drag.current;
    if (!d) return;
    setPainted(applyPaint(d.base, hourRectKeys(geom, d.anchor, cell), d.op, 'available'));
  };
  const startStroke = (cell: HourCell, touch: boolean) => {
    drag.current = { anchor: cell, op: hourStrokeOp(painted, cell), base: painted, touch };
    paintTo(cell);
  };
  const onDown = (cell: HourCell) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') {
      cancelPress();
      press.current = {
        key: cell.keys[0],
        timer: window.setTimeout(() => {
          press.current = null;
          startStroke(cell, true);
          try { navigator.vibrate?.(8); } catch { /* not this device */ }
        }, HOLD_MS),
      };
      return;
    }
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported id */ }
    startStroke(cell, false);
  };
  const onUp = (cell: HourCell) => () => {
    if (press.current?.key !== cell.keys[0]) return;
    cancelPress();
    startStroke(cell, true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const hit = el instanceof Element ? el.closest<HTMLElement>('.cell[data-slot]') : null;
    const cell = hit?.dataset.slot ? cellByKey.get(hit.dataset.slot) : undefined;
    if (cell) paintTo(cell);
  };
```

Keep the existing comments on those handlers (the "A nudge to say…", "Capture keeps the move stream…", "A finger that lifts…" and "`.cell[data-slot]` skips…" lines) where they still apply.

The cell renderer and grid:

```tsx
  const cell = (c: HourCell, label: string) => {
    const state = hourState(painted, c);
    return (
      <div
        key={c.keys[0]}
        className={cn('cell', state !== 'none' && state)}
        data-slot={c.keys[0]}
        title={label}
        onPointerDown={onDown(c)}
        onPointerUp={onUp(c)}
      />
    );
  };
```

and in the JSX, the axis column and day columns become:

```tsx
        <div className="col axis">
          <div className="col-head" />
          {hours.map((r) => (
            <div key={r.hour} className="axis-label">{r.label}</div>
          ))}
        </div>
        {geom.dates.map((d, ci) => (
          <div className="col" key={d}>
            <div className="col-head">
              <span className="dow">{DOW[new Date(d + 'T12:00:00Z').getUTCDay()]}</span>
            </div>
            {hours.map((r) => {
              const c = r.cells[ci];
              // No slot at this hour on this day (a DST edge): hold the row open with an
              // unmarkable blank so the columns stay aligned.
              return c ? cell(c, r.label) : <div key={`gap-${r.hour}`} className="cell gap" aria-hidden="true" />;
            })}
          </div>
        ))}
```

Update the touch hint copy to `tap an hour to mark it. hold, then drag, for a block. swipe to scroll.`

- [ ] **Step 3: Implement the CSS**

In `src/web/styles/app.css`, inside the `#availability-root { … }` block that holds the `.away` rules (~line 533), after `.away-form label, .away-form input { margin: 0; }`, add:

```css
    /* Hour cells over a half-hour record: an hour with only one half marked is drawn half
       full (top: the :00 half, bottom: the :30 half), so a saved 5:30pm still reads as
       5:30pm until that hour is touched. */
    .grid.canvas .cell.early { background: linear-gradient(to bottom, var(--primary) 50%, var(--card) 50%); }
    .grid.canvas .cell.late { background: linear-gradient(to bottom, var(--card) 50%, var(--primary) 50%); }
    /* The same ink outline the friend view's week grid gives a hovered cell. */
    @media (hover: hover) {
      .cell[data-slot]:hover { outline: 2px solid var(--foreground); outline-offset: -2px; }
    }
```

- [ ] **Step 4: Build and run everything**

Run: `npm run build:client && npm test`
Expected: build succeeds, tests PASS.

Then the e2e: `fuser -k 8787/tcp 2>/dev/null; npm run e2e -- e2e/availability.spec.ts`
Expected: all four projects pass. If the touch project fails on `markCells(…, 0, 0)`, the tap path (`onUp` → `startStroke`) is what to inspect; the pointer path drags from cell 0 to cell 0.

- [ ] **Step 5: Commit**

```bash
git add src/web/islands/availability.tsx src/web/styles/app.css e2e/availability.spec.ts
git commit -m "feat(availability): the editor marks by the hour"
```
(with the two trailer lines)

---

### Task 5: `isOver` — when a poll leaves the landing (core)

**Files:**
- Create: `src/core/archive.ts`
- Test: `tests/core/archive.test.ts`

**Interfaces:**
- Consumes: `ScheduleRecord` from `src/atproto/records.ts` (`finalized?: Interval` with UTC ISO `end`; `time.dates: string[]` YYYY-MM-DD; `time.timezone: string`), luxon.
- Produces: `export function isOver(record: ScheduleRecord, now: Date): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/archive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isOver } from '../../src/core/archive.js';
import type { ScheduleRecord } from '../../src/atproto/records.js';

const poll = (over: Partial<ScheduleRecord> & { dates: string[]; timezone?: string }): ScheduleRecord => ({
  $type: 'lol.letsmeet.schedule', title: 't', status: 'active', createdAt: '2026-08-01T00:00:00.000Z',
  time: { dates: over.dates, window: { start: '17:00', end: '19:00' }, slotMinutes: 30, timezone: over.timezone ?? 'UTC' },
  ...(over.finalized ? { finalized: over.finalized, status: 'finalized' } : {}),
  ...(over.status ? { status: over.status } : {}),
} as ScheduleRecord);

describe('isOver', () => {
  it('a decided poll is over once its chosen time has ended', () => {
    const p = poll({ dates: ['2026-09-02'], finalized: { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' } });
    expect(isOver(p, new Date('2026-09-02T17:29:00Z'))).toBe(false);
    expect(isOver(p, new Date('2026-09-02T17:30:00Z'))).toBe(true);
  });
  it('a decided poll with a future time stays, even when every offered day has passed', () => {
    const p = poll({ dates: ['2026-08-01'], finalized: { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' } });
    expect(isOver(p, new Date('2026-08-31T12:00:00Z'))).toBe(false);
  });
  it('an undecided poll is over once its last day has ended in its own zone', () => {
    const p = poll({ dates: ['2026-09-02', '2026-08-20'], timezone: 'America/Los_Angeles' });
    // 2026-09-03T05:00Z is still 22:00 on the 2nd in Los Angeles.
    expect(isOver(p, new Date('2026-09-03T05:00:00Z'))).toBe(false);
    // 2026-09-03T07:00Z is 00:00 on the 3rd there.
    expect(isOver(p, new Date('2026-09-03T07:00:00Z'))).toBe(true);
  });
  it('status alone does not archive: a closed or cancelled poll waits for its day', () => {
    expect(isOver(poll({ dates: ['2026-09-02'], status: 'closed' }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
    expect(isOver(poll({ dates: ['2026-09-02'], status: 'cancelled' }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
    expect(isOver(poll({ dates: ['2026-08-02'], status: 'cancelled' }), new Date('2026-08-31T12:00:00Z'))).toBe(true);
  });
  it('never archives what it cannot read: no dates, or a zone luxon does not know', () => {
    expect(isOver(poll({ dates: [] }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
    expect(isOver(poll({ dates: ['2026-08-02'], timezone: 'Mars/Olympus' }), new Date('2026-08-31T12:00:00Z'))).toBe(false);
  });
});
```

If `ScheduleRecord` requires fields the factory above does not set (check `src/atproto/records.ts` — `$type`, `createdAt`, `title`, `status`, `time` are expected), add them to the factory rather than loosening the cast.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/archive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/archive.ts`:

```ts
import { DateTime } from 'luxon';
import type { ScheduleRecord } from '../atproto/records.js';

/**
 * A poll that is over leaves the landing for the archive: decided, once the chosen time has
 * ended; undecided, once the last day it offered has ended where the poll lives. Status on
 * its own decides nothing — a cancelled poll for next week is still news this week. What
 * cannot be read (no dates, a zone luxon does not know) is never archived: better a stale
 * row on the landing than a poll that vanishes.
 */
export function isOver(record: ScheduleRecord, now: Date): boolean {
  if (record.finalized) return new Date(record.finalized.end).getTime() <= now.getTime();
  const last = [...record.time.dates].sort().at(-1);
  if (!last) return false;
  const end = DateTime.fromISO(last, { zone: record.time.timezone }).endOf('day');
  return end.isValid && end.toMillis() < now.getTime();
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/archive.test.ts`, then `npm test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/archive.ts tests/core/archive.test.ts
git commit -m "feat(polls): isOver says when a poll leaves the landing"
```
(with the two trailer lines)

---

### Task 6: The archive page and the landing link

**Files:**
- Modify: `src/web/routes/polls.ts` (`app.get('/')`, ~lines 61–95; add `app.get('/archive')` right after it)
- Modify: `src/web/pages/Landing.tsx` (export `PollList`; `archived` prop; the link)
- Create: `src/web/pages/Archive.tsx`
- Test: `tests/web/server.test.ts`

**Interfaces:**
- Consumes: `isOver` (Task 5); `listPollsByHost`, `listPollsAnswered`, `countResponsesByPoll`, `CachedPoll` from `src/db/cache.ts`; `readSession`; `page`; `PollListItem`, `PollList`; `Layout`, `pageTitle`; `Card`, `CardContent`; `COPY_LINK_SCRIPT`; `useNonce`.
- Produces: `GET /archive` (signed-in only; redirect `/login?returnTo=%2Farchive` otherwise); `LandingPage` prop `archived?: number`; `ArchivePage({ handle, polls, answered })`.

- [ ] **Step 1: Write the failing tests**

In `tests/web/server.test.ts`, after the test `'lists the polls you answered below your own, and names the chosen time'`, add:

```ts
  it('moves a poll whose day has passed off the landing and into the archive', async () => {
    const { deps, poll } = await setup();
    const old = await createPoll(deps, HOST, {
      title: 'Old picnic', time: { ...time, dates: ['2026-08-20'] },
    });
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const login = await dev.request(`/dev/login?did=${encodeURIComponent(HOST)}&handle=host.test`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    // The landing keeps the live poll, drops the old one, and points at the archive.
    const home = await (await dev.request('/', { headers: { cookie } })).text();
    expect(home).toContain(`href="/p/${poll.rkey}"`);
    expect(home).not.toContain(`href="/p/${old.rkey}"`);
    expect(home).toContain('href="/archive"');
    expect(home).toContain('archive · 1');

    // The archive lists only the old one, with the same row and the way back.
    const res = await dev.request('/archive', { headers: { cookie } });
    expect(res.status).toBe(200);
    const archive = await res.text();
    expect(archive).toContain('Old picnic');
    expect(archive).toContain(`href="/p/${old.rkey}"`);
    expect(archive).not.toContain(`href="/p/${poll.rkey}"`);
    expect(archive).toContain('href="/"');
    expect(archive).not.toContain('polls you answered');

    // Signed out, the archive is a sign-in.
    const anon = await dev.request('/archive');
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toBe('/login?returnTo=%2Farchive');

    // Nothing archived: no link at all, and the archive says so.
    const other = await dev.request('/dev/login?did=did:plc:stranger');
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
    expect(await (await dev.request('/', { headers: { cookie: otherCookie } })).text())
      .not.toContain('href="/archive"');
    expect(await (await dev.request('/archive', { headers: { cookie: otherCookie } })).text())
      .toContain('nothing here yet. polls land here once their day has passed.');
  });
```

If `createPoll` refuses a past date (read `assertRenderable` in `src/services/polls.ts` — it only checks the window renders a slot, so it should not), write the row with `upsertPollCache(deps.db, …)` from `src/db/cache.ts` and a record built with `buildScheduleRecord` from `src/atproto/records.ts` instead.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/web/server.test.ts -t "archive"`
Expected: FAIL — the old poll is still on the landing and `/archive` is a 404.

- [ ] **Step 3: The landing route and the archive route**

In `src/web/routes/polls.ts`, add the import `import { isOver } from '../../core/archive.js';` and `import { ArchivePage } from '../pages/Archive.js';`. Above `app.get('/')`, hoist the row projection:

```ts
  /** What the landing and the archive list for a poll — a projection of the cache row. */
  const listItem = (counts: Map<string, number>) => (p: CachedPoll): PollListItem => ({
    rkey: p.rkey, title: p.record.title, status: p.record.status,
    dates: p.record.time.dates, responses: counts.get(p.rkey) ?? 0,
    chosen: p.record.finalized ? fmtRange(p.record.finalized, p.record.time.timezone) : undefined,
  });
```

Rewrite the body of `app.get('/')` so the poll lists read:

```ts
    const now = deps.now();
    const item = listItem(did ? countResponsesByPoll(deps.db) : new Map());
    const mine = did ? listPollsByHost(deps.db, did) : [];
    const theirs = did ? listPollsAnswered(deps.db, did) : [];
    // Over polls (core/archive.ts) leave the landing for /archive; the count is the link's label.
    const live = (p: CachedPoll) => !isOver(p.record, now);
    const archived = mine.length + theirs.length - mine.filter(live).length - theirs.filter(live).length;
```

(keep the availability block as it is) and pass to `LandingPage`:

```ts
      polls: mine.filter(live).map(item),
      answered: theirs.filter(live).map(item),
      archived,
```

Add, right after `app.get('/')`:

```ts
  // Polls that are over: decided and done, or every offered day behind us (core/archive.ts).
  app.get('/archive', async (c) => {
    const who = await readSession(c, session, deps.now().getTime());
    if (!who) return c.redirect('/login?returnTo=%2Farchive');
    const now = deps.now();
    const item = listItem(countResponsesByPoll(deps.db));
    const over = (p: CachedPoll) => isOver(p.record, now);
    return page(c, createElement(ArchivePage, {
      handle: who.handle ?? who.did,
      polls: listPollsByHost(deps.db, who.did).filter(over).map(item),
      answered: listPollsAnswered(deps.db, who.did).filter(over).map(item),
    }));
  });
```

Check `safeReturnTo` in `src/web/routes/auth.ts` accepts `/archive` (it accepts same-origin paths; `/new` already round-trips the same way).

- [ ] **Step 4: The landing link**

In `src/web/pages/Landing.tsx`: change `function PollList` to `export function PollList`. Add `archived = 0` to `LandingPage`'s props with the doc line `/** Over polls, hosted or answered, waiting on /archive; 0 hides the link. */ archived?: number;`. In the "your polls" `<CardContent>`, wrap the existing empty-state/list in a fragment and append the link:

```tsx
          <CardContent>
            {polls.length === 0 ? (
              <p className="hint text-sm text-muted-foreground">
                no events planned yet. nobody needs anything from you, thank goodness.{' '}
                <a href="/new" className="text-primary underline underline-offset-4">make some obligations!</a>
              </p>
            ) : (
              <PollList polls={polls} />
            )}
            {/* Subtle on purpose: a muted label, not a button. Absent until there is something in it. */}
            {archived > 0 && (
              <p className="pixel-label mt-3 text-muted-foreground">
                <a href="/archive" className="hover:text-primary">{`archive · ${archived}`}</a>
              </p>
            )}
          </CardContent>
```

- [ ] **Step 5: The archive page**

Create `src/web/pages/Archive.tsx`:

```tsx
import { Layout, pageTitle } from './Layout.js';
import { useNonce } from '../nonce.js';
import { Card, CardContent } from '../ui/card.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
import { PollList, type PollListItem } from './Landing.js';

/**
 * Polls that are over (core/archive.ts): the same rows as the landing, kept out of the way.
 * Reached from the muted `archive · N` under "your polls"; there is no other way in.
 */
export function ArchivePage({ handle, polls, answered }: {
  handle: string;
  polls: PollListItem[];
  /** Over polls the viewer answered and does not host. */
  answered: PollListItem[];
}) {
  return (
    <Layout title={pageTitle('archive')}>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="pixel-heading">archive</h1>
            <p className="text-sm text-muted-foreground">
              signed in as{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{handle}</code>
            </p>
          </div>
          <p className="text-sm">
            <a href="/" className="text-primary underline underline-offset-4">← your polls</a>
          </p>
        </div>
        <div className="grid gap-3">
          <h2 className="pixel-heading">your polls</h2>
          <Card>
            <CardContent>
              {polls.length === 0 ? (
                <p className="hint text-sm text-muted-foreground">nothing here yet. polls land here once their day has passed.</p>
              ) : (
                <PollList polls={polls} />
              )}
            </CardContent>
          </Card>
        </div>
        {answered.length > 0 ? (
          <div className="answered grid gap-3">
            <h2 className="pixel-heading">polls you answered</h2>
            <Card>
              <CardContent>
                <PollList polls={answered} />
              </CardContent>
            </Card>
          </div>
        ) : null}
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
      </div>
    </Layout>
  );
}
```

- [ ] **Step 6: Run the tests, then everything**

Run: `npx vitest run tests/web/server.test.ts`, then `npm run build:client && npm test`, then `fuser -k 8787/tcp 2>/dev/null; npm run e2e`.
Expected: all PASS. The existing e2e specs touch the landing (`your availability` heading) and must still pass.

- [ ] **Step 7: Commit**

```bash
git add src/web/routes/polls.ts src/web/pages/Landing.tsx src/web/pages/Archive.tsx tests/web/server.test.ts
git commit -m "feat(landing): over polls leave for the archive"
```
(with the two trailer lines)
