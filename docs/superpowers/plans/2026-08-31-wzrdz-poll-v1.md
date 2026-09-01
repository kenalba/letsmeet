# wzrdz-poll v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v1 availability-grid scheduling app: hosts create polls via atproto OAuth, guests respond with just a link (records written into the host's PDS via an outbox), results render a heat map + ranked answer, finalize emits ICS + a community calendar event.

**Architecture:** Single TypeScript server (Hono) with SQLite as a disposable index; all durable poll data lives in PDS repos as `cool.wzrdz.poll.*` records. Pure logic (intervals, slots, ranking, paint model) is isolated in `src/core/` and fully test-driven; PDS access is behind `RepoReader`/`RepoWriter` interfaces with an in-memory `FakeRepo` for tests. A small Preact island renders the paint grid; everything else is server-rendered.

**Tech Stack:** Node ≥22, TypeScript (strict, ESM), Hono + @hono/node-server, better-sqlite3, luxon, @atproto/api + @atproto/oauth-client-node + @atproto/lexicon + @atproto/common, Preact + esbuild (grid island only), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-31-wzrdz-poll-design.md`

## Global Constraints

- Node ≥ 22, `"type": "module"` (ESM), TypeScript `strict: true`. Run TS directly with `tsx`.
- All datetimes in records are UTC ISO strings normalized via `new Date(x).toISOString()`. Lexicon `format: "datetime"` fields must pass that normalization.
- NSIDs are fixed constants: `cool.wzrdz.poll.schedule`, `cool.wzrdz.poll.response`. Response arrays: `maxLength` 200 intervals; guest name ≤64 graphemes; note ≤300 graphemes; title ≤200 graphemes; ≤31 dates per poll; `slotMinutes` ∈ {15, 30, 60}.
- Schedule records are NEVER deleted; lifecycle is `status`: `active | closed | finalized | cancelled`.
- Frozen geometry: `time` may only change while the poll has zero responses (enforced by API shape: `updatePollMeta` cannot touch `time`; `updatePollTime` checks the response count).
- Guest response cap per poll: 60 (`GUEST_CAP`). Outbox backoff: `min(30s * 2^attempts, 6h)`.
- OAuth scope for v1 is `atproto transition:generic` (deliberate choice; migrating to granular `repo:` scopes is post-v1).
- TDD: every task writes the failing test first, sees it fail, implements, sees it pass, commits. Run a task's tests with `npx vitest run <path>`; run everything with `npm test`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Q1HQ6QBYCyjYRUdedoyfDz`

## File Structure

```
package.json / tsconfig.json                 — Task 1
lexicons/cool.wzrdz.poll.schedule.json       — Task 6
lexicons/cool.wzrdz.poll.response.json       — Task 6
lexicons/com.atproto.repo.strongRef.json     — Task 6 (vendored copy)
src/core/intervals.ts                        — Task 2: Interval type, merge, snap
src/core/slots.ts                            — Task 3: date×window×tz → UTC slots (DST-safe)
src/core/ranking.ts                          — Task 4: rankSlots
src/core/gridModel.ts                        — Task 5: pure paint-state model for the grid
src/core/ics.ts                              — Task 14: buildIcs
src/atproto/records.ts                       — Task 6: build/validate records
src/atproto/types.ts                         — Task 10: RepoReader/RepoWriter/Deps
src/atproto/pds.ts                           — Task 10: resolvePds, PublicPdsReader, oauth writer
src/atproto/oauthClient.ts                   — Task 11: NodeOAuthClient wiring
src/db/db.ts                                 — Task 7: openDb + schema
src/db/sessions.ts                           — Task 7: encrypted OAuth state/session stores
src/db/editSecrets.ts                        — Task 8
src/db/outbox.ts                             — Task 8
src/db/cache.ts                              — Task 9: poll/response index
src/services/polls.ts                        — Tasks 12, 14: create/get/update/finalize
src/services/responses.ts                    — Task 13: guest+account submit, outbox flush
src/services/results.ts                      — Task 15
src/web/rateLimit.ts                         — Task 16
src/web/views.ts                             — Task 17: hono/html pages
src/web/routes/auth.ts                       — Task 11
src/web/routes/polls.ts                      — Task 17
src/web/server.ts                            — Task 17: app assembly
src/web/static/grid.tsx                      — Task 18: Preact island
src/index.ts                                 — Task 17: entrypoint (+ FAKE_PDS wiring Task 19)
scripts/genJwk.ts                            — Task 11
scripts/publishLexicons.ts                   — Task 20
tests/helpers/fakeRepo.ts                    — Task 10
tests/** mirrors src/**                      — per task
e2e/poll.spec.ts + playwright.config.ts      — Task 19
docs/deploy.md                               — Task 20
```

---

### Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (vitest), `npm run typecheck` (tsc), `tsx` execution; every later task assumes these work.

- [ ] **Step 1: Init npm and install dependencies**

```bash
cd ~/Projects/wzrdz-poll
npm init -y
npm pkg set type=module private=true name=wzrdz-poll \
  scripts.dev="tsx watch src/index.ts" \
  scripts.test="vitest run" \
  scripts.typecheck="tsc --noEmit" \
  scripts.build:grid="esbuild src/web/static/grid.tsx --bundle --format=esm --jsx=automatic --jsx-import-source=preact --outfile=public/grid.js"
npm i hono @hono/node-server @atproto/api @atproto/oauth-client-node @atproto/lexicon @atproto/common better-sqlite3 luxon preact
npm i -D typescript tsx vitest esbuild @playwright/test @types/node @types/better-sqlite3 @types/luxon
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "jsxImportSource": "preact",
    "types": ["node"]
  },
  "include": ["src", "tests", "scripts", "e2e"]
}
```

- [ ] **Step 3: Write .gitignore**

```
node_modules/
public/grid.js
*.db
*.db-*
.env
test-results/
playwright-report/
```

- [ ] **Step 4: Write the smoke test** — `tests/smoke.test.ts`

```ts
import { describe, it, expect } from 'vitest';

describe('toolchain', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Verify test and typecheck pass**

Run: `npm test && npm run typecheck`
Expected: 1 test passes; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold TypeScript/Hono/Vitest toolchain"
```

---

### Task 2: Interval math

**Files:**
- Create: `src/core/intervals.ts`
- Test: `tests/core/intervals.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Interval { start: string; end: string }` (UTC ISO, start < end); `normalizeIso(s: string): string`; `mergeIntervals(ivs: Interval[]): Interval[]`; `snapToSlots(ivs: Interval[], slots: Interval[]): Interval[]`. Used by Tasks 3, 4, 5, 6, 13.

- [ ] **Step 1: Write the failing tests** — `tests/core/intervals.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mergeIntervals, snapToSlots, normalizeIso } from '../../src/core/intervals.js';

const iv = (start: string, end: string) => ({ start, end });

describe('normalizeIso', () => {
  it('normalizes to UTC ISO with milliseconds', () => {
    expect(normalizeIso('2026-09-02T17:00:00Z')).toBe('2026-09-02T17:00:00.000Z');
  });
  it('throws on garbage', () => {
    expect(() => normalizeIso('not a date')).toThrow();
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and touching intervals', () => {
    expect(mergeIntervals([
      iv('2026-09-02T18:00:00.000Z', '2026-09-02T19:00:00.000Z'),
      iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:00:00.000Z'),
      iv('2026-09-02T18:30:00.000Z', '2026-09-02T20:00:00.000Z'),
    ])).toEqual([iv('2026-09-02T17:00:00.000Z', '2026-09-02T20:00:00.000Z')]);
  });
  it('keeps disjoint intervals separate', () => {
    expect(mergeIntervals([
      iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:00:00.000Z'),
      iv('2026-09-02T19:00:00.000Z', '2026-09-02T20:00:00.000Z'),
    ])).toHaveLength(2);
  });
  it('returns [] for []', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
  it('throws when start >= end', () => {
    expect(() => mergeIntervals([iv('2026-09-02T18:00:00.000Z', '2026-09-02T18:00:00.000Z')])).toThrow();
  });
});

describe('snapToSlots', () => {
  const slots = [
    iv('2026-09-02T17:00:00.000Z', '2026-09-02T17:30:00.000Z'),
    iv('2026-09-02T17:30:00.000Z', '2026-09-02T18:00:00.000Z'),
    iv('2026-09-02T18:00:00.000Z', '2026-09-02T18:30:00.000Z'),
  ];
  it('keeps only fully covered slots, merged', () => {
    expect(snapToSlots([iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:10:00.000Z')], slots))
      .toEqual([iv('2026-09-02T17:00:00.000Z', '2026-09-02T18:00:00.000Z')]);
  });
  it('drops paint entirely outside the slots', () => {
    expect(snapToSlots([iv('2026-09-02T21:00:00.000Z', '2026-09-02T22:00:00.000Z')], slots)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/intervals.test.ts`
Expected: FAIL — cannot find module `src/core/intervals.js`.

- [ ] **Step 3: Implement** — `src/core/intervals.ts`

```ts
export interface Interval {
  start: string; // UTC ISO, normalized
  end: string;   // UTC ISO, normalized; end > start
}

export function normalizeIso(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${s}`);
  return d.toISOString();
}

/** Sort, validate, and merge overlapping/touching intervals. Pure. */
export function mergeIntervals(ivs: Interval[]): Interval[] {
  const norm = ivs.map((i) => ({ start: normalizeIso(i.start), end: normalizeIso(i.end) }));
  for (const i of norm) {
    if (i.end <= i.start) throw new Error(`invalid interval: ${i.start}..${i.end}`);
  }
  norm.sort((a, b) => a.start.localeCompare(b.start));
  const out: Interval[] = [];
  for (const i of norm) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) {
      if (i.end > last.end) last.end = i.end;
    } else {
      out.push({ ...i });
    }
  }
  return out;
}

/** A slot survives only if some painted interval fully covers it. Result is merged. */
export function snapToSlots(ivs: Interval[], slots: Interval[]): Interval[] {
  const merged = mergeIntervals(ivs);
  const covered = slots.filter((s) =>
    merged.some((m) => m.start <= s.start && m.end >= s.end),
  );
  return covered.length ? mergeIntervals(covered) : [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/intervals.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/intervals.ts tests/core/intervals.test.ts
git commit -m "feat: interval normalization, merge, and slot snapping"
```

---

### Task 3: Slot materialization (DST-safe)

**Files:**
- Create: `src/core/slots.ts`
- Test: `tests/core/slots.test.ts`

**Interfaces:**
- Consumes: `Interval` from `src/core/intervals.js`.
- Produces: `interface SpecificDates { dates: string[]; window: { start: string; end: string }; slotMinutes: 15 | 30 | 60; timezone: string }`; `materializeSlots(t: SpecificDates): Interval[]`. Used by Tasks 5, 12, 13, 14, 15.

- [ ] **Step 1: Write the failing tests** — `tests/core/slots.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { materializeSlots } from '../../src/core/slots.js';

describe('materializeSlots', () => {
  it('materializes a plain evening window to UTC', () => {
    const slots = materializeSlots({
      dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
      slotMinutes: 60, timezone: 'America/New_York',
    });
    // EDT is UTC-4 in September
    expect(slots).toEqual([
      { start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T22:00:00.000Z' },
      { start: '2026-09-02T22:00:00.000Z', end: '2026-09-02T23:00:00.000Z' },
    ]);
  });

  it('US spring-forward: nominal 3h window yields 2 real hours', () => {
    // 2026-03-08 America/New_York, clocks jump 02:00 -> 03:00
    const slots = materializeSlots({
      dates: ['2026-03-08'], window: { start: '01:00', end: '04:00' },
      slotMinutes: 60, timezone: 'America/New_York',
    });
    expect(slots).toEqual([
      { start: '2026-03-08T06:00:00.000Z', end: '2026-03-08T07:00:00.000Z' },
      { start: '2026-03-08T07:00:00.000Z', end: '2026-03-08T08:00:00.000Z' },
    ]);
  });

  it('EU fall-back: nominal 3h window yields 4 real hours', () => {
    // 2026-10-25 Europe/Berlin, clocks fall back 03:00 -> 02:00
    const slots = materializeSlots({
      dates: ['2026-10-25'], window: { start: '01:00', end: '04:00' },
      slotMinutes: 60, timezone: 'Europe/Berlin',
    });
    expect(slots).toHaveLength(4);
    expect(slots[0].start).toBe('2026-10-24T23:00:00.000Z');
    expect(slots[3].end).toBe('2026-10-25T03:00:00.000Z');
  });

  it('window crossing midnight extends into the next day', () => {
    const slots = materializeSlots({
      dates: ['2026-09-02'], window: { start: '22:00', end: '01:00' },
      slotMinutes: 60, timezone: 'UTC',
    });
    expect(slots).toHaveLength(3);
    expect(slots[2].end).toBe('2026-09-03T01:00:00.000Z');
  });

  it('handles non-contiguous date lists', () => {
    const slots = materializeSlots({
      dates: ['2026-09-02', '2026-09-04'], window: { start: '10:00', end: '11:00' },
      slotMinutes: 30, timezone: 'UTC',
    });
    expect(slots).toHaveLength(4);
  });

  it('rejects an unknown timezone', () => {
    expect(() => materializeSlots({
      dates: ['2026-09-02'], window: { start: '10:00', end: '11:00' },
      slotMinutes: 30, timezone: 'Mars/Olympus_Mons',
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/slots.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/core/slots.ts`

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/slots.test.ts`
Expected: PASS (6 tests). If the spring-forward expectation fails, check the assertion against luxon's actual output before touching the implementation — the fixture comments state the intended civil-time behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/slots.ts tests/core/slots.test.ts
git commit -m "feat: DST-safe slot materialization from poll time model"
```

---

### Task 4: Slot ranking

**Files:**
- Create: `src/core/ranking.ts`
- Test: `tests/core/ranking.test.ts`

**Interfaces:**
- Consumes: `Interval`.
- Produces: `interface ResponseSummary { who: string; pending?: boolean; available: Interval[]; ifNeedBe: Interval[] }`; `interface RankedSlot { slot: Interval; available: string[]; ifNeedBe: string[]; missing: string[]; score: number }`; `rankSlots(slots: Interval[], responses: ResponseSummary[]): RankedSlot[]`. Used by Task 15, 17.

- [ ] **Step 1: Write the failing tests** — `tests/core/ranking.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { rankSlots } from '../../src/core/ranking.js';

const iv = (start: string, end: string) => ({ start, end });
const S1 = iv('2026-09-02T17:00:00.000Z', '2026-09-02T17:30:00.000Z');
const S2 = iv('2026-09-02T17:30:00.000Z', '2026-09-02T18:00:00.000Z');

describe('rankSlots', () => {
  it('ranks everyone-free slots first and lists the missing', () => {
    const ranked = rankSlots([S1, S2], [
      { who: 'ken', available: [iv(S1.start, S2.end)], ifNeedBe: [] },
      { who: 'sam', available: [S1], ifNeedBe: [] },
    ]);
    expect(ranked[0].slot).toEqual(S1);
    expect(ranked[0].available).toEqual(['ken', 'sam']);
    expect(ranked[0].missing).toEqual([]);
    expect(ranked[1].missing).toEqual(['sam']);
  });

  it('weights ifNeedBe at half and reports it separately', () => {
    const ranked = rankSlots([S1, S2], [
      { who: 'ken', available: [S1], ifNeedBe: [] },
      { who: 'sam', available: [], ifNeedBe: [S1] },
      { who: 'ana', available: [S2], ifNeedBe: [] },
    ]);
    // S1: 1 + 0.5 = 1.5; S2: 1
    expect(ranked[0].slot).toEqual(S1);
    expect(ranked[0].score).toBe(1.5);
    expect(ranked[0].ifNeedBe).toEqual(['sam']);
  });

  it('breaks score ties by earlier start', () => {
    const ranked = rankSlots([S2, S1], [{ who: 'ken', available: [iv(S1.start, S2.end)], ifNeedBe: [] }]);
    expect(ranked[0].slot).toEqual(S1);
  });

  it('available wins over ifNeedBe for the same person', () => {
    const ranked = rankSlots([S1], [{ who: 'ken', available: [S1], ifNeedBe: [S1] }]);
    expect(ranked[0].available).toEqual(['ken']);
    expect(ranked[0].ifNeedBe).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/ranking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/core/ranking.ts`

```ts
import type { Interval } from './intervals.js';

export interface ResponseSummary {
  who: string;
  pending?: boolean;
  available: Interval[];
  ifNeedBe: Interval[];
}

export interface RankedSlot {
  slot: Interval;
  available: string[];
  ifNeedBe: string[];
  missing: string[];
  score: number;
}

const covers = (ivs: Interval[], s: Interval) =>
  ivs.some((iv) => iv.start <= s.start && iv.end >= s.end);

export function rankSlots(slots: Interval[], responses: ResponseSummary[]): RankedSlot[] {
  const ranked = slots.map((slot) => {
    const available = responses.filter((r) => covers(r.available, slot)).map((r) => r.who);
    const ifNeedBe = responses
      .filter((r) => !covers(r.available, slot) && covers(r.ifNeedBe, slot))
      .map((r) => r.who);
    const missing = responses
      .map((r) => r.who)
      .filter((w) => !available.includes(w) && !ifNeedBe.includes(w));
    return { slot, available, ifNeedBe, missing, score: available.length + 0.5 * ifNeedBe.length };
  });
  return ranked.sort((a, b) => b.score - a.score || a.slot.start.localeCompare(b.slot.start));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/ranking.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/ranking.ts tests/core/ranking.test.ts
git commit -m "feat: slot ranking with half-weight ifNeedBe"
```

---

### Task 5: Grid paint model (pure)

**Files:**
- Create: `src/core/gridModel.ts`
- Test: `tests/core/gridModel.test.ts`

**Interfaces:**
- Consumes: `Interval`, `mergeIntervals`; `DateTime` from luxon.
- Produces: `type PaintMode = 'available' | 'ifNeedBe'`; `type PaintMap = Map<string, PaintMode>` (key = slot `start`); `interface GridGeom { dates: string[]; columns: Map<string, string[]> }` (viewer-local date → ordered slot keys); `buildGeom(slots: Interval[], timezone: string): GridGeom`; `strokeOp(painted: PaintMap, key: string, mode: PaintMode): 'add' | 'remove'`; `rectKeys(geom: GridGeom, a: string, b: string): string[]`; `applyPaint(painted: PaintMap, keys: string[], op: 'add' | 'remove', mode: PaintMode): PaintMap`; `paintToIntervals(painted: PaintMap, slots: Interval[], mode: PaintMode): Interval[]`; `intervalsToPaint(available: Interval[], ifNeedBe: Interval[], slots: Interval[]): PaintMap`. Used by Task 18 (the island imports this module).

- [ ] **Step 1: Write the failing tests** — `tests/core/gridModel.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint,
  type PaintMap,
} from '../../src/core/gridModel.js';
import { materializeSlots } from '../../src/core/slots.js';

const slots = materializeSlots({
  dates: ['2026-09-02', '2026-09-03'], window: { start: '17:00', end: '18:00' },
  slotMinutes: 30, timezone: 'UTC',
});
// 4 slots: two per date
const [a1, a2, b1, b2] = slots.map((s) => s.start);
const geom = buildGeom(slots, 'UTC');

describe('buildGeom', () => {
  it('groups slot keys into viewer-local date columns, ordered', () => {
    expect(geom.dates).toEqual(['2026-09-02', '2026-09-03']);
    expect(geom.columns.get('2026-09-02')).toEqual([a1, a2]);
    expect(geom.columns.get('2026-09-03')).toEqual([b1, b2]);
  });
});

describe('strokeOp', () => {
  it('adds when the cell is unpainted or painted in the other mode', () => {
    const p: PaintMap = new Map([[a1, 'ifNeedBe']]);
    expect(strokeOp(p, a2, 'available')).toBe('add');
    expect(strokeOp(p, a1, 'available')).toBe('add');
  });
  it('removes when the cell already has this mode', () => {
    const p: PaintMap = new Map([[a1, 'available']]);
    expect(strokeOp(p, a1, 'available')).toBe('remove');
  });
});

describe('rectKeys', () => {
  it('spans the rectangle across date columns', () => {
    expect(new Set(rectKeys(geom, a1, b2))).toEqual(new Set([a1, a2, b1, b2]));
  });
  it('a single cell is its own rectangle', () => {
    expect(rectKeys(geom, a2, a2)).toEqual([a2]);
  });
});

describe('applyPaint + paintToIntervals', () => {
  it('round-trips contiguous paint into one merged interval', () => {
    let p: PaintMap = new Map();
    p = applyPaint(p, [a1, a2], 'add', 'available');
    expect(paintToIntervals(p, slots, 'available'))
      .toEqual([{ start: a1, end: slots[1].end }]);
  });
  it('remove erases regardless of mode', () => {
    let p: PaintMap = new Map([[a1, 'ifNeedBe']]);
    p = applyPaint(p, [a1], 'remove', 'available');
    expect(p.size).toBe(0);
  });
});

describe('intervalsToPaint', () => {
  it('rebuilds a PaintMap from record intervals (edit prefill)', () => {
    const p = intervalsToPaint([{ start: a1, end: slots[1].end }], [{ start: b1, end: slots[2].end }], slots);
    expect(p.get(a1)).toBe('available');
    expect(p.get(a2)).toBe('available');
    expect(p.get(b1)).toBe('ifNeedBe');
    expect(p.get(b2)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/gridModel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/core/gridModel.ts`

```ts
import { DateTime } from 'luxon';
import { mergeIntervals, type Interval } from './intervals.js';

export type PaintMode = 'available' | 'ifNeedBe';
export type PaintMap = Map<string, PaintMode>;

export interface GridGeom {
  dates: string[];                  // viewer-local ISO dates, ordered
  columns: Map<string, string[]>;   // date -> ordered slot keys (slot.start)
}

export function buildGeom(slots: Interval[], timezone: string): GridGeom {
  const columns = new Map<string, string[]>();
  for (const s of slots) {
    const d = DateTime.fromISO(s.start, { zone: 'utc' }).setZone(timezone).toISODate()!;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(s.start);
  }
  return { dates: [...columns.keys()].sort(), columns };
}

export function strokeOp(painted: PaintMap, key: string, mode: PaintMode): 'add' | 'remove' {
  return painted.get(key) === mode ? 'remove' : 'add';
}

/** All keys in the rectangle between anchor cell a and current cell b. */
export function rectKeys(geom: GridGeom, a: string, b: string): string[] {
  const pos = new Map<string, { c: number; r: number }>();
  geom.dates.forEach((d, c) =>
    geom.columns.get(d)!.forEach((k, r) => pos.set(k, { c, r })),
  );
  const pa = pos.get(a); const pb = pos.get(b);
  if (!pa || !pb) return [];
  const [c0, c1] = [Math.min(pa.c, pb.c), Math.max(pa.c, pb.c)];
  const [r0, r1] = [Math.min(pa.r, pb.r), Math.max(pa.r, pb.r)];
  const out: string[] = [];
  for (const [k, p] of pos) {
    if (p.c >= c0 && p.c <= c1 && p.r >= r0 && p.r <= r1) out.push(k);
  }
  return out;
}

export function applyPaint(
  painted: PaintMap, keys: string[], op: 'add' | 'remove', mode: PaintMode,
): PaintMap {
  const next = new Map(painted);
  for (const k of keys) {
    if (op === 'add') next.set(k, mode);
    else next.delete(k);
  }
  return next;
}

export function paintToIntervals(painted: PaintMap, slots: Interval[], mode: PaintMode): Interval[] {
  const chosen = slots.filter((s) => painted.get(s.start) === mode);
  return chosen.length ? mergeIntervals(chosen) : [];
}

export function intervalsToPaint(
  available: Interval[], ifNeedBe: Interval[], slots: Interval[],
): PaintMap {
  const covers = (ivs: Interval[], s: Interval) =>
    ivs.some((iv) => iv.start <= s.start && iv.end >= s.end);
  const p: PaintMap = new Map();
  for (const s of slots) {
    if (covers(available, s)) p.set(s.start, 'available');
    else if (covers(ifNeedBe, s)) p.set(s.start, 'ifNeedBe');
  }
  return p;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/gridModel.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/gridModel.ts tests/core/gridModel.test.ts
git commit -m "feat: pure paint-state model for the availability grid"
```

---

### Task 6: Lexicons and record builders

**Files:**
- Create: `lexicons/cool.wzrdz.poll.schedule.json`, `lexicons/cool.wzrdz.poll.response.json`, `lexicons/com.atproto.repo.strongRef.json`, `src/atproto/records.ts`
- Test: `tests/atproto/records.test.ts`

**Interfaces:**
- Consumes: `SpecificDates`, `Interval`, `mergeIntervals`, `normalizeIso`.
- Produces: `SCHEDULE_NSID`, `RESPONSE_NSID` constants; `interface ScheduleRecord`, `interface ResponseRecord`; `buildScheduleRecord(input: { title: string; description?: string; time: SpecificDates; closesAt?: string }): ScheduleRecord`; `validateScheduleRecord(v: unknown): ScheduleRecord`; `buildResponseRecord(input: { subject: { uri: string; cid: string }; available: Interval[]; ifNeedBe?: Interval[]; guestName?: string; timezone?: string; note?: string }): ResponseRecord`; `validateResponseRecord(v: unknown): ResponseRecord`. Used by Tasks 12, 13, 14, 15, 20.

- [ ] **Step 1: Write the lexicon JSON files**

`lexicons/com.atproto.repo.strongRef.json` (vendored from the atproto repo):

```json
{
  "lexicon": 1,
  "id": "com.atproto.repo.strongRef",
  "description": "A URI with a content-hash fingerprint.",
  "defs": {
    "main": {
      "type": "object",
      "required": ["uri", "cid"],
      "properties": {
        "uri": { "type": "string", "format": "at-uri" },
        "cid": { "type": "string", "format": "cid" }
      }
    }
  }
}
```

`lexicons/cool.wzrdz.poll.schedule.json`:

```json
{
  "lexicon": 1,
  "id": "cool.wzrdz.poll.schedule",
  "defs": {
    "main": {
      "type": "record",
      "description": "An availability poll: date range, daily window, granularity.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["title", "time", "status", "createdAt"],
        "properties": {
          "title": { "type": "string", "maxGraphemes": 200, "maxLength": 800 },
          "description": { "type": "string", "maxGraphemes": 2000, "maxLength": 8000 },
          "time": { "type": "union", "refs": ["#specificDates"] },
          "status": { "type": "string", "enum": ["active", "closed", "finalized", "cancelled"] },
          "finalized": { "type": "ref", "ref": "#interval" },
          "closesAt": { "type": "string", "format": "datetime" },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "specificDates": {
      "type": "object",
      "required": ["dates", "window", "slotMinutes", "timezone"],
      "properties": {
        "dates": { "type": "array", "maxLength": 31, "items": { "type": "string" } },
        "window": { "type": "ref", "ref": "#dayWindow" },
        "slotMinutes": { "type": "integer", "enum": [15, 30, 60] },
        "timezone": { "type": "string", "maxLength": 64 }
      }
    },
    "dayWindow": {
      "type": "object",
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "maxLength": 5 },
        "end": { "type": "string", "maxLength": 5 }
      }
    },
    "interval": {
      "type": "object",
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "format": "datetime" },
        "end": { "type": "string", "format": "datetime" }
      }
    }
  }
}
```

`lexicons/cool.wzrdz.poll.response.json`:

```json
{
  "lexicon": 1,
  "id": "cool.wzrdz.poll.response",
  "defs": {
    "main": {
      "type": "record",
      "description": "One person's availability for a poll. Lives in the respondent's repo, or the host's repo (with `guest`) for host-attested guest responses.",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["subject", "available", "createdAt"],
        "properties": {
          "subject": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
          "available": { "type": "array", "maxLength": 200, "items": { "type": "ref", "ref": "#interval" } },
          "ifNeedBe": { "type": "array", "maxLength": 200, "items": { "type": "ref", "ref": "#interval" } },
          "guest": { "type": "ref", "ref": "#guestInfo" },
          "timezone": { "type": "string", "maxLength": 64 },
          "note": { "type": "string", "maxGraphemes": 300, "maxLength": 1200 },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    },
    "guestInfo": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name": { "type": "string", "maxGraphemes": 64, "maxLength": 256 }
      }
    },
    "interval": {
      "type": "object",
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "format": "datetime" },
        "end": { "type": "string", "format": "datetime" }
      }
    }
  }
}
```

- [ ] **Step 2: Write the failing tests** — `tests/atproto/records.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  buildScheduleRecord, validateScheduleRecord,
  buildResponseRecord, validateResponseRecord,
  SCHEDULE_NSID, RESPONSE_NSID,
} from '../../src/atproto/records.js';

const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'America/New_York',
};
// any syntactically valid CID works for validation tests
const CID = 'bafyreidfayvfuwqa2qskciqhtcc73ipe2f2wgib3fmyk6ssqrlkln5dcvy';
const SUBJECT = { uri: 'at://did:plc:host123/cool.wzrdz.poll.schedule/3kabc', cid: CID };

describe('schedule records', () => {
  it('builds a valid active record', () => {
    const rec = buildScheduleRecord({ title: 'DnD night', time });
    expect(rec.$type).toBe(SCHEDULE_NSID);
    expect(rec.status).toBe('active');
    expect(rec.time.$type).toBe(`${SCHEDULE_NSID}#specificDates`);
    expect(() => validateScheduleRecord(rec)).not.toThrow();
  });
  it('rejects a title over 200 graphemes', () => {
    expect(() => buildScheduleRecord({ title: 'x'.repeat(201), time })).toThrow();
  });
  it('rejects an invalid status on validate', () => {
    const rec = buildScheduleRecord({ title: 'ok', time });
    expect(() => validateScheduleRecord({ ...rec, status: 'meh' })).toThrow();
  });
  it('rejects more than 31 dates', () => {
    const many = Array.from({ length: 32 }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, '0')}`);
    expect(() => buildScheduleRecord({ title: 'ok', time: { ...time, dates: many } })).toThrow();
  });
});

describe('response records', () => {
  const available = [{ start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T22:00:00.000Z' }];
  it('builds a valid guest response', () => {
    const rec = buildResponseRecord({ subject: SUBJECT, available, guestName: 'Sam L.' });
    expect(rec.$type).toBe(RESPONSE_NSID);
    expect(rec.guest?.name).toBe('Sam L.');
    expect(() => validateResponseRecord(rec)).not.toThrow();
  });
  it('builds a valid account response (no guest field)', () => {
    const rec = buildResponseRecord({ subject: SUBJECT, available });
    expect(rec.guest).toBeUndefined();
  });
  it('merges overlapping paint on build', () => {
    const rec = buildResponseRecord({
      subject: SUBJECT,
      available: [
        { start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T21:30:00.000Z' },
        { start: '2026-09-02T21:30:00.000Z', end: '2026-09-02T22:00:00.000Z' },
      ],
    });
    expect(rec.available).toHaveLength(1);
  });
  it('rejects a guest name over 64 graphemes', () => {
    expect(() => buildResponseRecord({ subject: SUBJECT, available, guestName: 'x'.repeat(65) })).toThrow();
  });
  it('rejects a missing subject on validate', () => {
    const rec = buildResponseRecord({ subject: SUBJECT, available });
    const { subject: _drop, ...rest } = rec as Record<string, unknown> & { subject: unknown };
    expect(() => validateResponseRecord(rest)).toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/atproto/records.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** — `src/atproto/records.ts`

```ts
import { Lexicons, type LexiconDoc } from '@atproto/lexicon';
import scheduleLex from '../../lexicons/cool.wzrdz.poll.schedule.json' with { type: 'json' };
import responseLex from '../../lexicons/cool.wzrdz.poll.response.json' with { type: 'json' };
import strongRefLex from '../../lexicons/com.atproto.repo.strongRef.json' with { type: 'json' };
import { mergeIntervals, normalizeIso, type Interval } from '../core/intervals.js';
import type { SpecificDates } from '../core/slots.js';

export const SCHEDULE_NSID = 'cool.wzrdz.poll.schedule';
export const RESPONSE_NSID = 'cool.wzrdz.poll.response';

export const lexicons = new Lexicons(
  [scheduleLex, responseLex, strongRefLex] as unknown as LexiconDoc[],
);

export type PollStatus = 'active' | 'closed' | 'finalized' | 'cancelled';

export interface ScheduleRecord {
  $type: typeof SCHEDULE_NSID;
  title: string;
  description?: string;
  time: SpecificDates & { $type: string };
  status: PollStatus;
  finalized?: Interval;
  closesAt?: string;
  createdAt: string;
}

export interface ResponseRecord {
  $type: typeof RESPONSE_NSID;
  subject: { uri: string; cid: string };
  available: Interval[];
  ifNeedBe?: Interval[];
  guest?: { name: string };
  timezone?: string;
  note?: string;
  createdAt: string;
}

export function validateScheduleRecord(v: unknown): ScheduleRecord {
  lexicons.assertValidRecord(SCHEDULE_NSID, v);
  return v as ScheduleRecord;
}

export function validateResponseRecord(v: unknown): ResponseRecord {
  lexicons.assertValidRecord(RESPONSE_NSID, v);
  return v as ResponseRecord;
}

export function buildScheduleRecord(input: {
  title: string; description?: string; time: SpecificDates; closesAt?: string;
}): ScheduleRecord {
  const rec: ScheduleRecord = {
    $type: SCHEDULE_NSID,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    time: { $type: `${SCHEDULE_NSID}#specificDates`, ...input.time },
    status: 'active',
    ...(input.closesAt ? { closesAt: normalizeIso(input.closesAt) } : {}),
    createdAt: new Date().toISOString(),
  };
  return validateScheduleRecord(rec);
}

export function buildResponseRecord(input: {
  subject: { uri: string; cid: string };
  available: Interval[];
  ifNeedBe?: Interval[];
  guestName?: string;
  timezone?: string;
  note?: string;
}): ResponseRecord {
  const ifNeedBe = input.ifNeedBe?.length ? mergeIntervals(input.ifNeedBe) : undefined;
  const rec: ResponseRecord = {
    $type: RESPONSE_NSID,
    subject: input.subject,
    available: mergeIntervals(input.available),
    ...(ifNeedBe ? { ifNeedBe } : {}),
    ...(input.guestName ? { guest: { name: input.guestName } } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: new Date().toISOString(),
  };
  return validateResponseRecord(rec);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/atproto/records.test.ts && npm run typecheck`
Expected: PASS (10 tests); tsc clean. If the `with { type: 'json' }` import attributes trip the toolchain, switch those imports to `const require = createRequire(import.meta.url)` + `require('../../lexicons/....json')` (from `node:module`) — behavior is identical. If `assertValidRecord` rejects the union `$type` shape, log the thrown message and fix the lexicon JSON, not the builder — the record shape in this task is the contract everything else uses.

- [ ] **Step 6: Commit**

```bash
git add lexicons src/atproto/records.ts tests/atproto/records.test.ts
git commit -m "feat: cool.wzrdz.poll lexicons and validated record builders"
```

---

### Task 7: SQLite core and encrypted OAuth stores

**Files:**
- Create: `src/db/db.ts`, `src/db/sessions.ts`
- Test: `tests/db/sessions.test.ts`

**Interfaces:**
- Consumes: better-sqlite3; `NodeSavedSession`, `NodeSavedSessionStore`, `NodeSavedState`, `NodeSavedStateStore` types from `@atproto/oauth-client-node`.
- Produces: `openDb(path: string): Database` (`':memory:'` works, WAL on file DBs, schema auto-migrated — tables `oauth_state`, `oauth_session`, `edit_secret`, `outbox`, `poll_cache`, `response_cache`, `participant`); `encrypt(keyHex: string, plaintext: string): string`; `decrypt(keyHex: string, blob: string): string`; `class StateStore implements NodeSavedStateStore` and `class SessionStore implements NodeSavedSessionStore`, both constructed `(db, encKeyHex)`. Used by Tasks 8, 9, 11.

- [ ] **Step 1: Write the failing tests** — `tests/db/sessions.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../src/db/db.js';
import { StateStore, SessionStore, encrypt, decrypt } from '../../src/db/sessions.js';

const KEY = randomBytes(32).toString('hex');

describe('encrypt/decrypt', () => {
  it('round-trips', () => {
    expect(decrypt(KEY, encrypt(KEY, 'secret'))).toBe('secret');
  });
  it('fails with the wrong key', () => {
    const other = randomBytes(32).toString('hex');
    expect(() => decrypt(other, encrypt(KEY, 'secret'))).toThrow();
  });
});

describe('StateStore / SessionStore', () => {
  it('stores and retrieves oauth state', async () => {
    const store = new StateStore(openDb(':memory:'), KEY);
    await store.set('k1', { dpopKey: 'x' } as never);
    expect(await store.get('k1')).toEqual({ dpopKey: 'x' });
    await store.del('k1');
    expect(await store.get('k1')).toBeUndefined();
  });
  it('stores sessions keyed by did and overwrites on set', async () => {
    const store = new SessionStore(openDb(':memory:'), KEY);
    await store.set('did:plc:abc', { tokenSet: { v: 1 } } as never);
    await store.set('did:plc:abc', { tokenSet: { v: 2 } } as never);
    expect(await store.get('did:plc:abc')).toEqual({ tokenSet: { v: 2 } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/db/db.ts`

```ts
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_state (
  key TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_session (
  did TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS edit_secret (
  poll_uri TEXT NOT NULL, token_hash TEXT NOT NULL, rkey TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (poll_uri, token_hash));
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_did TEXT NOT NULL, poll_uri TEXT NOT NULL, rkey TEXT NOT NULL,
  record_json TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS poll_cache (
  rkey TEXT PRIMARY KEY, uri TEXT NOT NULL, host_did TEXT NOT NULL,
  cid TEXT, record_json TEXT NOT NULL,
  tombstoned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS response_cache (
  poll_rkey TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
  record_json TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY (poll_rkey, source, key));
CREATE TABLE IF NOT EXISTS participant (
  poll_rkey TEXT NOT NULL, did TEXT NOT NULL, PRIMARY KEY (poll_rkey, did));
`;

export type { Database };

export function openDb(path: string): Database.Database {
  const db = new Database(path);
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Implement** — `src/db/sessions.ts`

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  NodeSavedSession, NodeSavedSessionStore, NodeSavedState, NodeSavedStateStore,
} from '@atproto/oauth-client-node';
import type { Database } from './db.js';

export function encrypt(keyHex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(keyHex: string, blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export class StateStore implements NodeSavedStateStore {
  constructor(private db: Database.Database, private key: string) {}
  async get(k: string): Promise<NodeSavedState | undefined> {
    const row = this.db.prepare('SELECT data FROM oauth_state WHERE key = ?').get(k) as
      | { data: string } | undefined;
    return row ? (JSON.parse(decrypt(this.key, row.data)) as NodeSavedState) : undefined;
  }
  async set(k: string, v: NodeSavedState): Promise<void> {
    this.db.prepare(
      'INSERT OR REPLACE INTO oauth_state (key, data, created_at) VALUES (?, ?, ?)',
    ).run(k, encrypt(this.key, JSON.stringify(v)), Date.now());
  }
  async del(k: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_state WHERE key = ?').run(k);
  }
}

export class SessionStore implements NodeSavedSessionStore {
  constructor(private db: Database.Database, private key: string) {}
  async get(did: string): Promise<NodeSavedSession | undefined> {
    const row = this.db.prepare('SELECT data FROM oauth_session WHERE did = ?').get(did) as
      | { data: string } | undefined;
    return row ? (JSON.parse(decrypt(this.key, row.data)) as NodeSavedSession) : undefined;
  }
  async set(did: string, v: NodeSavedSession): Promise<void> {
    this.db.prepare(
      'INSERT OR REPLACE INTO oauth_session (did, data, updated_at) VALUES (?, ?, ?)',
    ).run(did, encrypt(this.key, JSON.stringify(v)), Date.now());
  }
  async del(did: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_session WHERE did = ?').run(did);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/db/sessions.test.ts && npm run typecheck`
Expected: PASS (4 tests); tsc clean (the `implements` clauses are the real check here).

- [ ] **Step 6: Commit**

```bash
git add src/db/db.ts src/db/sessions.ts tests/db/sessions.test.ts
git commit -m "feat: sqlite schema and encrypted oauth state/session stores"
```

---

### Task 8: Edit secrets and outbox stores

**Files:**
- Create: `src/db/editSecrets.ts`, `src/db/outbox.ts`
- Test: `tests/db/editSecrets.test.ts`, `tests/db/outbox.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Database`.
- Produces: `createEditSecret(db, pollUri: string, rkey: string): string` (returns the raw token; only its sha256 is stored); `lookupEditSecret(db, pollUri: string, token: string): string | null` (returns rkey); `interface OutboxItem { id: number; hostDid: string; pollUri: string; rkey: string; record: Record<string, unknown>; attempts: number }`; `enqueueOutbox(db, item: { hostDid; pollUri; rkey; record }, now: number): number` (returns id); `dueOutbox(db, now: number): OutboxItem[]`; `markOutboxDone(db, id: number): void`; `markOutboxFailed(db, id: number, error: string, now: number): void` (backoff `min(30s * 2^attempts, 6h)`); `pendingOutboxCount(db, hostDid: string): number`. Used by Tasks 13, 17.

- [ ] **Step 1: Write the failing tests** — `tests/db/editSecrets.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { createEditSecret, lookupEditSecret } from '../../src/db/editSecrets.js';

describe('edit secrets', () => {
  const db = openDb(':memory:');
  const POLL = 'at://did:plc:host/cool.wzrdz.poll.schedule/3kabc';

  it('round-trips a token to its rkey', () => {
    const token = createEditSecret(db, POLL, '3kresp1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(lookupEditSecret(db, POLL, token)).toBe('3kresp1');
  });
  it('rejects a bad token and the right token on the wrong poll', () => {
    const token = createEditSecret(db, POLL, '3kresp2');
    expect(lookupEditSecret(db, POLL, 'nope')).toBeNull();
    expect(lookupEditSecret(db, 'at://other/uri/1', token)).toBeNull();
  });
  it('never stores the raw token', () => {
    const token = createEditSecret(db, POLL, '3kresp3');
    const rows = db.prepare('SELECT token_hash FROM edit_secret').all() as { token_hash: string }[];
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });
});
```

And `tests/db/outbox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import {
  enqueueOutbox, dueOutbox, markOutboxDone, markOutboxFailed, pendingOutboxCount,
} from '../../src/db/outbox.js';

const item = {
  hostDid: 'did:plc:host', pollUri: 'at://did:plc:host/cool.wzrdz.poll.schedule/3k',
  rkey: '3kresp1', record: { $type: 'cool.wzrdz.poll.response' },
};

describe('outbox', () => {
  it('enqueued items are due immediately and carry the record', () => {
    const db = openDb(':memory:');
    enqueueOutbox(db, item, 1000);
    const due = dueOutbox(db, 1000);
    expect(due).toHaveLength(1);
    expect(due[0].record).toEqual(item.record);
  });
  it('done items stop being due', () => {
    const db = openDb(':memory:');
    const id = enqueueOutbox(db, item, 1000);
    markOutboxDone(db, id);
    expect(dueOutbox(db, 999999)).toHaveLength(0);
    expect(pendingOutboxCount(db, 'did:plc:host')).toBe(0);
  });
  it('failures back off exponentially and cap at 6h', () => {
    const db = openDb(':memory:');
    const id = enqueueOutbox(db, item, 0);
    markOutboxFailed(db, id, 'boom', 0);           // attempts=1, next = 60s
    expect(dueOutbox(db, 59_000)).toHaveLength(0);
    expect(dueOutbox(db, 61_000)).toHaveLength(1);
    for (let i = 0; i < 20; i++) markOutboxFailed(db, id, 'boom', 0);
    expect(dueOutbox(db, 6 * 3600_000 - 1000)).toHaveLength(0);
    expect(dueOutbox(db, 6 * 3600_000 + 1000)).toHaveLength(1);
    expect(pendingOutboxCount(db, 'did:plc:host')).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/editSecrets.test.ts tests/db/outbox.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** — `src/db/editSecrets.ts`

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './db.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function createEditSecret(db: Database.Database, pollUri: string, rkey: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO edit_secret (poll_uri, token_hash, rkey, created_at) VALUES (?, ?, ?, ?)',
  ).run(pollUri, hash(token), rkey, Date.now());
  return token;
}

export function lookupEditSecret(db: Database.Database, pollUri: string, token: string): string | null {
  const row = db.prepare(
    'SELECT rkey FROM edit_secret WHERE poll_uri = ? AND token_hash = ?',
  ).get(pollUri, hash(token)) as { rkey: string } | undefined;
  return row?.rkey ?? null;
}
```

- [ ] **Step 4: Implement** — `src/db/outbox.ts`

```ts
import type { Database } from './db.js';

export interface OutboxItem {
  id: number;
  hostDid: string;
  pollUri: string;
  rkey: string;
  record: Record<string, unknown>;
  attempts: number;
}

export function enqueueOutbox(
  db: Database.Database,
  item: { hostDid: string; pollUri: string; rkey: string; record: object },
  now: number,
): number {
  const res = db.prepare(
    `INSERT INTO outbox (host_did, poll_uri, rkey, record_json, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(item.hostDid, item.pollUri, item.rkey, JSON.stringify(item.record), now, now);
  return Number(res.lastInsertRowid);
}

export function dueOutbox(db: Database.Database, now: number): OutboxItem[] {
  const rows = db.prepare(
    'SELECT * FROM outbox WHERE done = 0 AND next_attempt_at <= ? ORDER BY id',
  ).all(now) as Array<{
    id: number; host_did: string; poll_uri: string; rkey: string;
    record_json: string; attempts: number;
  }>;
  return rows.map((r) => ({
    id: r.id, hostDid: r.host_did, pollUri: r.poll_uri, rkey: r.rkey,
    record: JSON.parse(r.record_json) as Record<string, unknown>, attempts: r.attempts,
  }));
}

export function markOutboxDone(db: Database.Database, id: number): void {
  db.prepare('UPDATE outbox SET done = 1 WHERE id = ?').run(id);
}

export function markOutboxFailed(db: Database.Database, id: number, error: string, now: number): void {
  const row = db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number };
  const attempts = row.attempts + 1;
  const backoff = Math.min(30_000 * 2 ** attempts, 6 * 3600_000);
  db.prepare(
    'UPDATE outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
  ).run(attempts, error, now + backoff, id);
}

export function pendingOutboxCount(db: Database.Database, hostDid: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM outbox WHERE done = 0 AND host_did = ?',
  ).get(hostDid) as { n: number };
  return row.n;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/db/editSecrets.test.ts tests/db/outbox.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/db/editSecrets.ts src/db/outbox.ts tests/db/editSecrets.test.ts tests/db/outbox.test.ts
git commit -m "feat: edit-secret and outbox stores with exponential backoff"
```

---

### Task 9: Poll and response cache

**Files:**
- Create: `src/db/cache.ts`
- Test: `tests/db/cache.test.ts`

**Interfaces:**
- Consumes: `Database`, `ScheduleRecord`, `ResponseRecord`.
- Produces: `interface CachedPoll { rkey: string; uri: string; hostDid: string; cid: string | null; record: ScheduleRecord; tombstoned: boolean }`; `upsertPollCache(db, p: { rkey; uri; hostDid; cid; record }): void`; `getPollCache(db, rkey: string): CachedPoll | null`; `tombstonePoll(db, rkey: string): void`; `upsertResponseCache(db, pollRkey: string, source: 'guest' | 'account', key: string, record: ResponseRecord, pending: boolean): void` (key = rkey for guests, DID for accounts); `listResponseCache(db, pollRkey: string): Array<{ source: 'guest' | 'account'; key: string; record: ResponseRecord; pending: boolean }>`; `countResponses(db, pollRkey: string): number`; `addParticipant(db, pollRkey: string, did: string): void`; `listParticipants(db, pollRkey: string): string[]`. Used by Tasks 12, 13, 15.

- [ ] **Step 1: Write the failing tests** — `tests/db/cache.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import {
  upsertPollCache, getPollCache, tombstonePoll,
  upsertResponseCache, listResponseCache, countResponses,
  addParticipant, listParticipants,
} from '../../src/db/cache.js';
import { buildScheduleRecord, buildResponseRecord } from '../../src/atproto/records.js';

const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const CID = 'bafyreidfayvfuwqa2qskciqhtcc73ipe2f2wgib3fmyk6ssqrlkln5dcvy';
const poll = {
  rkey: '3kpoll', uri: 'at://did:plc:host/cool.wzrdz.poll.schedule/3kpoll',
  hostDid: 'did:plc:host', cid: CID, record: buildScheduleRecord({ title: 'T', time }),
};
const resp = buildResponseRecord({
  subject: { uri: poll.uri, cid: CID },
  available: [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' }],
  guestName: 'Sam',
});

describe('poll cache', () => {
  it('round-trips and tombstones', () => {
    const db = openDb(':memory:');
    upsertPollCache(db, poll);
    expect(getPollCache(db, '3kpoll')?.record.title).toBe('T');
    expect(getPollCache(db, '3kpoll')?.tombstoned).toBe(false);
    tombstonePoll(db, '3kpoll');
    expect(getPollCache(db, '3kpoll')?.tombstoned).toBe(true);
    expect(getPollCache(db, 'missing')).toBeNull();
  });
});

describe('response cache', () => {
  it('upserts by (source, key), counts, and flags pending', () => {
    const db = openDb(':memory:');
    upsertResponseCache(db, '3kpoll', 'guest', '3kresp1', resp, true);
    upsertResponseCache(db, '3kpoll', 'guest', '3kresp1', resp, false); // flushed
    upsertResponseCache(db, '3kpoll', 'account', 'did:plc:sam', resp, false);
    const rows = listResponseCache(db, '3kpoll');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === 'guest')?.pending).toBe(false);
    expect(countResponses(db, '3kpoll')).toBe(2);
  });
});

describe('participants', () => {
  it('dedupes and lists', () => {
    const db = openDb(':memory:');
    addParticipant(db, '3kpoll', 'did:plc:sam');
    addParticipant(db, '3kpoll', 'did:plc:sam');
    expect(listParticipants(db, '3kpoll')).toEqual(['did:plc:sam']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db/cache.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/db/cache.ts`

```ts
import type { Database } from './db.js';
import type { ScheduleRecord, ResponseRecord } from '../atproto/records.js';

export interface CachedPoll {
  rkey: string;
  uri: string;
  hostDid: string;
  cid: string | null;
  record: ScheduleRecord;
  tombstoned: boolean;
}

export function upsertPollCache(
  db: Database.Database,
  p: { rkey: string; uri: string; hostDid: string; cid: string | null; record: ScheduleRecord },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO poll_cache (rkey, uri, host_did, cid, record_json, tombstoned, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  ).run(p.rkey, p.uri, p.hostDid, p.cid, JSON.stringify(p.record), Date.now());
}

export function getPollCache(db: Database.Database, rkey: string): CachedPoll | null {
  const r = db.prepare('SELECT * FROM poll_cache WHERE rkey = ?').get(rkey) as
    | { rkey: string; uri: string; host_did: string; cid: string | null; record_json: string; tombstoned: number }
    | undefined;
  if (!r) return null;
  return {
    rkey: r.rkey, uri: r.uri, hostDid: r.host_did, cid: r.cid,
    record: JSON.parse(r.record_json) as ScheduleRecord, tombstoned: r.tombstoned === 1,
  };
}

export function tombstonePoll(db: Database.Database, rkey: string): void {
  db.prepare('UPDATE poll_cache SET tombstoned = 1, updated_at = ? WHERE rkey = ?')
    .run(Date.now(), rkey);
}

export function upsertResponseCache(
  db: Database.Database, pollRkey: string, source: 'guest' | 'account',
  key: string, record: ResponseRecord, pending: boolean,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO response_cache (poll_rkey, source, key, record_json, pending, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(pollRkey, source, key, JSON.stringify(record), pending ? 1 : 0, Date.now());
}

export function listResponseCache(
  db: Database.Database, pollRkey: string,
): Array<{ source: 'guest' | 'account'; key: string; record: ResponseRecord; pending: boolean }> {
  const rows = db.prepare('SELECT * FROM response_cache WHERE poll_rkey = ? ORDER BY updated_at')
    .all(pollRkey) as Array<{ source: string; key: string; record_json: string; pending: number }>;
  return rows.map((r) => ({
    source: r.source as 'guest' | 'account', key: r.key,
    record: JSON.parse(r.record_json) as ResponseRecord, pending: r.pending === 1,
  }));
}

export function countResponses(db: Database.Database, pollRkey: string): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM response_cache WHERE poll_rkey = ?')
    .get(pollRkey) as { n: number };
  return r.n;
}

export function addParticipant(db: Database.Database, pollRkey: string, did: string): void {
  db.prepare('INSERT OR IGNORE INTO participant (poll_rkey, did) VALUES (?, ?)').run(pollRkey, did);
}

export function listParticipants(db: Database.Database, pollRkey: string): string[] {
  const rows = db.prepare('SELECT did FROM participant WHERE poll_rkey = ? ORDER BY did')
    .all(pollRkey) as Array<{ did: string }>;
  return rows.map((r) => r.did);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db/cache.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/db/cache.ts tests/db/cache.test.ts
git commit -m "feat: poll/response cache and participant index"
```

---

### Task 10: Repo interfaces, FakeRepo, and the real PDS adapters

**Files:**
- Create: `src/atproto/types.ts`, `src/atproto/pds.ts`, `tests/helpers/fakeRepo.ts`
- Test: `tests/atproto/pds.test.ts`, `tests/helpers/fakeRepo.test.ts`

**Interfaces:**
- Consumes: `Agent` from `@atproto/api`; `TID`, `cidForCbor` from `@atproto/common`.
- Produces (in `types.ts`):
  ```ts
  export interface RecordRef { uri: string; cid: string }
  export interface FoundRecord extends RecordRef { value: Record<string, unknown> }
  export interface RepoReader {
    getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null>;
    listRecords(did: string, collection: string): Promise<FoundRecord[]>;
  }
  export interface RepoWriter {
    createRecord(repo: string, collection: string, record: object): Promise<RecordRef>;
    putRecord(repo: string, collection: string, rkey: string, record: object): Promise<RecordRef>;
  }
  export interface Deps {
    db: import('../db/db.js').Database.Database;
    reader: RepoReader;
    writerFor(did: string): Promise<RepoWriter>;
    now(): Date;
  }
  ```
- Produces (in `pds.ts`): `resolvePds(did: string, fetchImpl?: typeof fetch): Promise<string>`; `class PublicPdsReader implements RepoReader` (constructor takes optional `fetchImpl` for tests); `writerForAgent(agent: Agent): RepoWriter`.
- Produces (in `tests/helpers/fakeRepo.ts`): `class FakeRepo implements RepoReader, RepoWriter` with a `failWrites: boolean` toggle and a `delete(did, collection, rkey)` test helper. Real TID rkeys, real CIDs via `cidForCbor`.
- Used by Tasks 12-15, 17, 19.

- [ ] **Step 1: Write `src/atproto/types.ts`** exactly as shown in Interfaces above (pure types; no test of its own — `tsc` covers it).

- [ ] **Step 2: Write the failing FakeRepo tests** — `tests/helpers/fakeRepo.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { FakeRepo } from './fakeRepo.js';

describe('FakeRepo', () => {
  it('createRecord assigns a TID rkey and real CID; getRecord round-trips', async () => {
    const repo = new FakeRepo();
    const ref = await repo.createRecord('did:plc:host', 'cool.wzrdz.poll.schedule', { a: 1 });
    expect(ref.uri).toMatch(/^at:\/\/did:plc:host\/cool\.wzrdz\.poll\.schedule\/[a-z2-7]+$/);
    expect(ref.cid).toMatch(/^bafy/);
    const rkey = ref.uri.split('/').pop()!;
    const found = await repo.getRecord('did:plc:host', 'cool.wzrdz.poll.schedule', rkey);
    expect(found?.value).toEqual({ a: 1 });
  });
  it('putRecord upserts at a fixed rkey and changes the CID on new content', async () => {
    const repo = new FakeRepo();
    const r1 = await repo.putRecord('did:plc:x', 'c', 'rk', { v: 1 });
    const r2 = await repo.putRecord('did:plc:x', 'c', 'rk', { v: 2 });
    expect(r1.cid).not.toBe(r2.cid);
    expect(await repo.listRecords('did:plc:x', 'c')).toHaveLength(1);
  });
  it('failWrites makes writes throw; delete removes records', async () => {
    const repo = new FakeRepo();
    const ref = await repo.createRecord('did:plc:x', 'c', {});
    const rkey = ref.uri.split('/').pop()!;
    repo.failWrites = true;
    await expect(repo.putRecord('did:plc:x', 'c', 'rk', {})).rejects.toThrow();
    repo.failWrites = false;
    repo.delete('did:plc:x', 'c', rkey);
    expect(await repo.getRecord('did:plc:x', 'c', rkey)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement** — `tests/helpers/fakeRepo.ts`

Run: `npx vitest run tests/helpers/fakeRepo.test.ts` — expected: FAIL (module not found). Then:

```ts
import { TID, cidForCbor } from '@atproto/common';
import type { FoundRecord, RecordRef, RepoReader, RepoWriter } from '../../src/atproto/types.js';

export class FakeRepo implements RepoReader, RepoWriter {
  failWrites = false;
  private repos = new Map<string, Map<string, { cid: string; value: Record<string, unknown> }>>();

  private bucket(did: string, collection: string) {
    const key = `${did} ${collection}`;
    if (!this.repos.has(key)) this.repos.set(key, new Map());
    return this.repos.get(key)!;
  }

  async createRecord(repo: string, collection: string, record: object): Promise<RecordRef> {
    return this.putRecord(repo, collection, TID.nextStr(), record);
  }

  async putRecord(repo: string, collection: string, rkey: string, record: object): Promise<RecordRef> {
    if (this.failWrites) throw new Error('FakeRepo: writes disabled');
    const cid = (await cidForCbor(record)).toString();
    this.bucket(repo, collection).set(rkey, { cid, value: record as Record<string, unknown> });
    return { uri: `at://${repo}/${collection}/${rkey}`, cid };
  }

  async getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null> {
    const hit = this.bucket(did, collection).get(rkey);
    return hit ? { uri: `at://${did}/${collection}/${rkey}`, cid: hit.cid, value: hit.value } : null;
  }

  async listRecords(did: string, collection: string): Promise<FoundRecord[]> {
    return [...this.bucket(did, collection).entries()].map(([rkey, r]) => ({
      uri: `at://${did}/${collection}/${rkey}`, cid: r.cid, value: r.value,
    }));
  }

  delete(did: string, collection: string, rkey: string): void {
    this.bucket(did, collection).delete(rkey);
  }
}
```

Run again — expected: PASS (3 tests).

- [ ] **Step 4: Write the failing pds tests** — `tests/atproto/pds.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { resolvePds, PublicPdsReader } from '../../src/atproto/pds.js';

const plcDoc = {
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
};
const fakeFetch = (routes: Record<string, unknown>) =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

describe('resolvePds', () => {
  it('resolves did:plc via plc.directory', async () => {
    const pds = await resolvePds('did:plc:abc', fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }));
    expect(pds).toBe('https://pds.example.com');
  });
  it('resolves did:web via .well-known', async () => {
    const pds = await resolvePds('did:web:example.org', fakeFetch({ 'https://example.org/.well-known/did.json': plcDoc }));
    expect(pds).toBe('https://pds.example.com');
  });
  it('throws when no PDS service is present', async () => {
    await expect(resolvePds('did:plc:abc', fakeFetch({ 'https://plc.directory/did:plc:abc': { service: [] } })))
      .rejects.toThrow();
  });
});

describe('PublicPdsReader', () => {
  const reader = new PublicPdsReader(fakeFetch({
    'https://plc.directory/did:plc:abc': plcDoc,
    'https://pds.example.com/xrpc/com.atproto.repo.getRecord': {
      uri: 'at://did:plc:abc/c/rk', cid: 'bafyfake', value: { hello: 1 },
    },
    'https://pds.example.com/xrpc/com.atproto.repo.listRecords': {
      records: [{ uri: 'at://did:plc:abc/c/rk', cid: 'bafyfake', value: { hello: 1 } }],
    },
  }));
  it('getRecord fetches from the resolved PDS', async () => {
    const rec = await reader.getRecord('did:plc:abc', 'c', 'rk');
    expect(rec?.value).toEqual({ hello: 1 });
  });
  it('getRecord returns null on 404-class errors', async () => {
    const r404 = new PublicPdsReader(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }));
    expect(await r404.getRecord('did:plc:abc', 'c', 'rk')).toBeNull();
  });
  it('listRecords returns the records array', async () => {
    expect(await reader.listRecords('did:plc:abc', 'c')).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run to verify failure, then implement** — `src/atproto/pds.ts`

Run: `npx vitest run tests/atproto/pds.test.ts` — expected: FAIL. Then:

```ts
import type { Agent } from '@atproto/api';
import type { FoundRecord, RecordRef, RepoReader, RepoWriter } from './types.js';

interface DidDoc {
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export async function resolvePds(did: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let url: string;
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${did}`;
  } else if (did.startsWith('did:web:')) {
    url = `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  } else {
    throw new Error(`unsupported DID method: ${did}`);
  }
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`DID resolution failed for ${did}: ${res.status}`);
  const doc = (await res.json()) as DidDoc;
  const svc = doc.service?.find((s) => s.type === 'AtprotoPersonalDataServer');
  if (!svc) throw new Error(`no PDS service in DID document for ${did}`);
  return svc.serviceEndpoint.replace(/\/$/, '');
}

/** Unauthenticated reads straight from each participant's PDS. No firehose, no appview. */
export class PublicPdsReader implements RepoReader {
  private pdsCache = new Map<string, string>();
  constructor(private fetchImpl: typeof fetch = fetch) {}

  private async pdsFor(did: string): Promise<string> {
    if (!this.pdsCache.has(did)) this.pdsCache.set(did, await resolvePds(did, this.fetchImpl));
    return this.pdsCache.get(did)!;
  }

  async getRecord(did: string, collection: string, rkey: string): Promise<FoundRecord | null> {
    const pds = await this.pdsFor(did);
    const u = new URL(`${pds}/xrpc/com.atproto.repo.getRecord`);
    u.searchParams.set('repo', did);
    u.searchParams.set('collection', collection);
    u.searchParams.set('rkey', rkey);
    const res = await this.fetchImpl(u);
    if (!res.ok) return null;
    const body = (await res.json()) as { uri: string; cid: string; value: Record<string, unknown> };
    return { uri: body.uri, cid: body.cid, value: body.value };
  }

  async listRecords(did: string, collection: string): Promise<FoundRecord[]> {
    const pds = await this.pdsFor(did);
    const out: FoundRecord[] = [];
    let cursor: string | undefined;
    do {
      const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
      u.searchParams.set('repo', did);
      u.searchParams.set('collection', collection);
      u.searchParams.set('limit', '100');
      if (cursor) u.searchParams.set('cursor', cursor);
      const res = await this.fetchImpl(u);
      if (!res.ok) return out;
      const body = (await res.json()) as { records: FoundRecord[]; cursor?: string };
      out.push(...body.records);
      cursor = body.cursor;
    } while (cursor);
    return out;
  }
}

/** Authenticated writes through an OAuth-restored Agent. */
export function writerForAgent(agent: Agent): RepoWriter {
  return {
    async createRecord(repo, collection, record): Promise<RecordRef> {
      const res = await agent.com.atproto.repo.createRecord({ repo, collection, record });
      return { uri: res.data.uri, cid: res.data.cid };
    },
    async putRecord(repo, collection, rkey, record): Promise<RecordRef> {
      const res = await agent.com.atproto.repo.putRecord({ repo, collection, rkey, record });
      return { uri: res.data.uri, cid: res.data.cid };
    },
  };
}
```

Run again — expected: PASS (6 tests). `writerForAgent` is covered by typecheck here and exercised for real in the Task 20 smoke test.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — expected: clean.

```bash
git add src/atproto/types.ts src/atproto/pds.ts tests/helpers/fakeRepo.ts tests/helpers/fakeRepo.test.ts tests/atproto/pds.test.ts
git commit -m "feat: repo reader/writer interfaces, FakeRepo double, PDS adapters"
```

---

### Task 11: OAuth client and auth routes

**Files:**
- Create: `src/atproto/oauthClient.ts`, `src/web/routes/auth.ts`, `scripts/genJwk.ts`
- Test: `tests/web/auth.test.ts`

**Interfaces:**
- Consumes: `NodeOAuthClient`, `JoseKey` from `@atproto/oauth-client-node`; `StateStore`, `SessionStore` (Task 7); Hono.
- Produces:
  - `interface AuthClient { clientMetadata: Record<string, unknown>; authorize(handle: string): Promise<URL>; callback(params: URLSearchParams): Promise<{ did: string }>; restore(did: string): Promise<import('@atproto/api').Agent> }` — the narrow surface routes and services depend on, so tests can stub it.
  - `createOAuthClient(db, env: { PUBLIC_URL: string; SESSION_ENC_KEY: string; OAUTH_JWK?: string }): Promise<AuthClient>` — wraps `NodeOAuthClient`. Loopback client (`http://localhost?...` client_id, no keyset) when `PUBLIC_URL` starts with `http://localhost` or `http://127.0.0.1`; confidential client with `JoseKey.fromImportable(JSON.parse(OAUTH_JWK))` otherwise. Scope: `atproto transition:generic`.
  - `authRoutes(auth: AuthClient, cookieSecret: string): Hono` mounting `GET /oauth/client-metadata.json`, `GET /login`, `POST /login` (form field `handle`), `GET /oauth/callback`, `POST /logout`. Signed cookie name: `did`.
  - `getSessionDid(c: Context, cookieSecret: string): Promise<string | null>` helper.
- Used by Tasks 17, 19, 20.

- [ ] **Step 1: Write `scripts/genJwk.ts`**

```ts
import { JoseKey } from '@atproto/oauth-client-node';

const key = await JoseKey.generate(['ES256']);
console.log(JSON.stringify(key.privateJwk));
```

Run once to sanity-check: `npx tsx scripts/genJwk.ts` prints a JWK JSON object (do NOT commit its output).

- [ ] **Step 2: Write the failing route tests (stub AuthClient)** — `tests/web/auth.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { authRoutes } from '../../src/web/routes/auth.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const stub: AuthClient = {
  clientMetadata: { client_id: 'https://poll.example/oauth/client-metadata.json' },
  authorize: async () => new URL('https://pds.example.com/authorize?x=1'),
  callback: async () => ({ did: 'did:plc:host' }),
  restore: async () => { throw new Error('not used here'); },
};
const app = authRoutes(stub, 'test-cookie-secret');

describe('auth routes', () => {
  it('serves client metadata as JSON', async () => {
    const res = await app.request('/oauth/client-metadata.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { client_id: string }).client_id).toContain('poll.example');
  });
  it('POST /login redirects to the authorization URL', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ handle: 'ken.wzrdz.cool' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('pds.example.com/authorize');
  });
  it('callback sets a signed did cookie and redirects home', async () => {
    const res = await app.request('/oauth/callback?code=abc&state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('did=');
  });
  it('logout clears the cookie', async () => {
    const res = await app.request('/logout', { method: 'POST' });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('did=;');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement** — `src/atproto/oauthClient.ts`

```ts
import { NodeOAuthClient, JoseKey } from '@atproto/oauth-client-node';
import { Agent } from '@atproto/api';
import type { Database } from '../db/db.js';
import { StateStore, SessionStore } from '../db/sessions.js';

export interface AuthClient {
  clientMetadata: Record<string, unknown>;
  authorize(handle: string): Promise<URL>;
  callback(params: URLSearchParams): Promise<{ did: string }>;
  restore(did: string): Promise<Agent>;
}

const SCOPE = 'atproto transition:generic';

export async function createOAuthClient(
  db: Database.Database,
  env: { PUBLIC_URL: string; SESSION_ENC_KEY: string; OAUTH_JWK?: string },
): Promise<AuthClient> {
  const pub = env.PUBLIC_URL.replace(/\/$/, '');
  const isLoopback = pub.startsWith('http://localhost') || pub.startsWith('http://127.0.0.1');
  const redirectUri = `${pub}/oauth/callback`;

  const client = new NodeOAuthClient({
    clientMetadata: isLoopback
      ? {
          client_id: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`,
          redirect_uris: [redirectUri],
          scope: SCOPE,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'web',
          dpop_bound_access_tokens: true,
          client_name: 'wzrdz-poll (dev)',
        }
      : {
          client_id: `${pub}/oauth/client-metadata.json`,
          client_name: 'wzrdz-poll',
          client_uri: pub,
          redirect_uris: [redirectUri],
          scope: SCOPE,
          token_endpoint_auth_method: 'private_key_jwt',
          token_endpoint_auth_signing_alg: 'ES256',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'web',
          dpop_bound_access_tokens: true,
          jwks_uri: `${pub}/oauth/jwks.json`,
        },
    keyset: isLoopback || !env.OAUTH_JWK
      ? undefined
      : [await JoseKey.fromImportable(JSON.parse(env.OAUTH_JWK))],
    stateStore: new StateStore(db, env.SESSION_ENC_KEY),
    sessionStore: new SessionStore(db, env.SESSION_ENC_KEY),
  });

  return {
    clientMetadata: client.clientMetadata as unknown as Record<string, unknown>,
    async authorize(handle) {
      return client.authorize(handle, { scope: SCOPE });
    },
    async callback(params) {
      const { session } = await client.callback(params);
      return { did: session.did };
    },
    async restore(did) {
      const session = await client.restore(did);
      return new Agent(session);
    },
  };
}
```

- [ ] **Step 5: Implement** — `src/web/routes/auth.ts`

```ts
import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { AuthClient } from '../../atproto/oauthClient.js';

export async function getSessionDid(c: Context, cookieSecret: string): Promise<string | null> {
  const did = await getSignedCookie(c, cookieSecret, 'did');
  return did || null;
}

export function authRoutes(auth: AuthClient, cookieSecret: string): Hono {
  const app = new Hono();

  app.get('/oauth/client-metadata.json', (c) => c.json(auth.clientMetadata));

  app.get('/login', (c) =>
    c.html(
      `<form method="post" action="/login">
         <label>Your handle <input name="handle" placeholder="you.bsky.social" required></label>
         <button>Sign in</button>
       </form>`,
    ),
  );

  app.post('/login', async (c) => {
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '').trim();
    if (!handle) return c.text('handle required', 400);
    try {
      const url = await auth.authorize(handle);
      return c.redirect(url.toString());
    } catch (err) {
      return c.text(`Could not start sign-in for "${handle}": ${(err as Error).message}`, 400);
    }
  });

  app.get('/oauth/callback', async (c) => {
    const { did } = await auth.callback(new URL(c.req.url).searchParams);
    await setSignedCookie(c, 'did', did, cookieSecret, {
      httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect('/');
  });

  app.post('/logout', (c) => {
    deleteCookie(c, 'did', { path: '/' });
    return c.redirect('/');
  });

  return app;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/auth.test.ts && npm run typecheck`
Expected: PASS (4 tests); tsc clean. If `NodeOAuthClient`'s constructor or `JoseKey` signatures disagree with the installed version, adjust `oauthClient.ts` to the installed API — the `AuthClient` interface is the stable contract; nothing else may change.

- [ ] **Step 7: Commit**

```bash
git add src/atproto/oauthClient.ts src/web/routes/auth.ts scripts/genJwk.ts tests/web/auth.test.ts
git commit -m "feat: atproto oauth client wiring and auth routes"
```

---

### Task 12: Poll service — create, read-with-revalidate, frozen geometry

**Files:**
- Create: `src/services/polls.ts`
- Test: `tests/services/polls.test.ts`

**Interfaces:**
- Consumes: `Deps`, `FakeRepo`, record builders, cache (Tasks 6, 9, 10), `SCHEDULE_NSID`.
- Produces: `parseRkey(uri: string): string`; `createPoll(deps: Deps, hostDid: string, input: { title: string; description?: string; time: SpecificDates }): Promise<{ rkey: string; uri: string; cid: string }>`; `getPollWithRevalidate(deps: Deps, rkey: string): Promise<CachedPoll | null>`; `updatePollMeta(deps: Deps, hostDid: string, rkey: string, input: { title?: string; description?: string }): Promise<void>`; `updatePollTime(deps: Deps, hostDid: string, rkey: string, time: SpecificDates): Promise<void>` (throws `Error('geometry is frozen once responses exist')` when `countResponses > 0`). Used by Tasks 13-15, 17.

- [ ] **Step 1: Write the failing tests** — `tests/services/polls.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import {
  createPoll, getPollWithRevalidate, updatePollMeta, updatePollTime, parseRkey,
} from '../../src/services/polls.js';
import { upsertResponseCache } from '../../src/db/cache.js';
import { buildResponseRecord, SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};

function makeDeps() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  return { deps, repo };
}

describe('createPoll', () => {
  it('writes the record to the host repo and caches it', async () => {
    const { deps, repo } = makeDeps();
    const { rkey, uri } = await createPoll(deps, HOST, { title: 'Movie night', time });
    expect(parseRkey(uri)).toBe(rkey);
    const inRepo = await repo.getRecord(HOST, SCHEDULE_NSID, rkey);
    expect((inRepo?.value as { title: string }).title).toBe('Movie night');
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('Movie night');
  });
});

describe('getPollWithRevalidate', () => {
  it('picks up an edit made directly in the repo', async () => {
    const { deps, repo } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'Old', time });
    const cur = await repo.getRecord(HOST, SCHEDULE_NSID, rkey);
    await repo.putRecord(HOST, SCHEDULE_NSID, rkey, { ...cur!.value, title: 'New' });
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('New');
  });
  it('tombstones when the record is gone from the repo', async () => {
    const { deps, repo } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'Doomed', time });
    repo.delete(HOST, SCHEDULE_NSID, rkey);
    expect((await getPollWithRevalidate(deps, rkey))?.tombstoned).toBe(true);
  });
  it('serves stale cache when the reader throws', async () => {
    const { deps } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'Sturdy', time });
    deps.reader = {
      getRecord: async () => { throw new Error('net down'); },
      listRecords: async () => [],
    };
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('Sturdy');
  });
  it('returns null for an unknown rkey', async () => {
    const { deps } = makeDeps();
    expect(await getPollWithRevalidate(deps, 'nope')).toBeNull();
  });
});

describe('frozen geometry', () => {
  it('meta edits are always allowed; time edits blocked once a response exists', async () => {
    const { deps } = makeDeps();
    const { rkey, uri, cid } = await createPoll(deps, HOST, { title: 'T', time });
    await updatePollMeta(deps, HOST, rkey, { title: 'T2' });
    expect((await getPollWithRevalidate(deps, rkey))?.record.title).toBe('T2');

    const resp = buildResponseRecord({
      subject: { uri, cid },
      available: [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' }],
      guestName: 'Sam',
    });
    upsertResponseCache(deps.db, rkey, 'guest', '3kresp', resp, false);

    await expect(updatePollTime(deps, HOST, rkey, { ...time, slotMinutes: 60 }))
      .rejects.toThrow(/frozen/);
    await updatePollMeta(deps, HOST, rkey, { description: 'still fine' });
  });
  it('rejects edits by a non-host', async () => {
    const { deps } = makeDeps();
    const { rkey } = await createPoll(deps, HOST, { title: 'T', time });
    await expect(updatePollMeta(deps, 'did:plc:mallory', rkey, { title: 'hax' }))
      .rejects.toThrow(/host/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/polls.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/services/polls.ts`

```ts
import type { Deps } from '../atproto/types.js';
import type { SpecificDates } from '../core/slots.js';
import {
  buildScheduleRecord, validateScheduleRecord, SCHEDULE_NSID, type ScheduleRecord,
} from '../atproto/records.js';
import {
  upsertPollCache, getPollCache, tombstonePoll, countResponses, type CachedPoll,
} from '../db/cache.js';

export function parseRkey(uri: string): string {
  const rkey = uri.split('/').pop();
  if (!rkey) throw new Error(`malformed at-uri: ${uri}`);
  return rkey;
}

export async function createPoll(
  deps: Deps, hostDid: string,
  input: { title: string; description?: string; time: SpecificDates },
): Promise<{ rkey: string; uri: string; cid: string }> {
  const record = buildScheduleRecord(input);
  const writer = await deps.writerFor(hostDid);
  const ref = await writer.createRecord(hostDid, SCHEDULE_NSID, record);
  const rkey = parseRkey(ref.uri);
  upsertPollCache(deps.db, { rkey, uri: ref.uri, hostDid, cid: ref.cid, record });
  return { rkey, uri: ref.uri, cid: ref.cid };
}

export async function getPollWithRevalidate(deps: Deps, rkey: string): Promise<CachedPoll | null> {
  const cached = getPollCache(deps.db, rkey);
  if (!cached) return null;
  try {
    const live = await deps.reader.getRecord(cached.hostDid, SCHEDULE_NSID, rkey);
    if (live === null) {
      tombstonePoll(deps.db, rkey);
    } else {
      upsertPollCache(deps.db, {
        rkey, uri: live.uri, hostDid: cached.hostDid, cid: live.cid,
        record: validateScheduleRecord(live.value),
      });
    }
  } catch {
    // network trouble: stale cache is fine
  }
  return getPollCache(deps.db, rkey);
}

async function putUpdated(
  deps: Deps, hostDid: string, rkey: string, next: ScheduleRecord,
): Promise<void> {
  const writer = await deps.writerFor(hostDid);
  const ref = await writer.putRecord(hostDid, SCHEDULE_NSID, rkey, next);
  upsertPollCache(deps.db, { rkey, uri: ref.uri, hostDid, cid: ref.cid, record: next });
}

function loadOwned(deps: Deps, hostDid: string, rkey: string): CachedPoll {
  const poll = getPollCache(deps.db, rkey);
  if (!poll) throw new Error(`unknown poll: ${rkey}`);
  if (poll.hostDid !== hostDid) throw new Error('only the host may edit a poll');
  return poll;
}

export async function updatePollMeta(
  deps: Deps, hostDid: string, rkey: string,
  input: { title?: string; description?: string },
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  const next = validateScheduleRecord({ ...poll.record, ...input });
  await putUpdated(deps, hostDid, rkey, next);
}

export async function updatePollTime(
  deps: Deps, hostDid: string, rkey: string, time: SpecificDates,
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (countResponses(deps.db, rkey) > 0) {
    throw new Error('geometry is frozen once responses exist');
  }
  const next = validateScheduleRecord({
    ...poll.record,
    time: { $type: `${SCHEDULE_NSID}#specificDates`, ...time },
  });
  await putUpdated(deps, hostDid, rkey, next);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/polls.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/polls.ts tests/services/polls.test.ts
git commit -m "feat: poll service with revalidating reads and frozen geometry"
```

---

### Task 13: Response service — guest outbox flow and account upsert

**Files:**
- Create: `src/services/responses.ts`
- Test: `tests/services/responses.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 6, 8, 9, 10, 12; `TID` from `@atproto/common`.
- Produces: `GUEST_CAP = 60`; `submitGuestResponse(deps: Deps, pollRkey: string, input: { name: string; available: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string; editToken?: string }): Promise<{ editToken: string; pending: boolean }>`; `submitAccountResponse(deps: Deps, did: string, pollRkey: string, input: { available: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string }): Promise<void>`; `flushOutbox(deps: Deps): Promise<{ flushed: number; failed: number }>`. Used by Tasks 15, 17, 19.

- [ ] **Step 1: Write the failing tests** — `tests/services/responses.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createPoll, getPollWithRevalidate } from '../../src/services/polls.js';
import {
  submitGuestResponse, submitAccountResponse, flushOutbox, GUEST_CAP,
} from '../../src/services/responses.js';
import { listResponseCache } from '../../src/db/cache.js';
import { RESPONSE_NSID, SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const PAINT = [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' }];

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const poll = await createPoll(deps, HOST, { title: 'T', time });
  return { deps, repo, poll };
}

describe('submitGuestResponse', () => {
  it('lands a guest record in the host repo when the writer works', async () => {
    const { deps, repo, poll } = await setup();
    const { editToken, pending } = await submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', available: PAINT,
    });
    expect(editToken).toBeTruthy();
    expect(pending).toBe(false);
    const recs = await repo.listRecords(HOST, RESPONSE_NSID);
    expect(recs).toHaveLength(1);
    expect((recs[0].value as { guest: { name: string } }).guest.name).toBe('Sam');
  });

  it('queues as pending when writes fail, then flushes when they recover', async () => {
    const { deps, repo, poll } = await setup();
    repo.failWrites = true;
    const { pending } = await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    expect(pending).toBe(true);
    expect(listResponseCache(deps.db, poll.rkey)[0].pending).toBe(true);

    repo.failWrites = false;
    deps.now = () => new Date('2027-01-01T00:00:00Z'); // jump past any backoff
    const { flushed } = await flushOutbox(deps);
    expect(flushed).toBe(1);
    expect(listResponseCache(deps.db, poll.rkey)[0].pending).toBe(false);
    expect(await repo.listRecords(HOST, RESPONSE_NSID)).toHaveLength(1);
  });

  it('an edit token reuses the same rkey (upsert, not duplicate)', async () => {
    const { deps, repo, poll } = await setup();
    const { editToken } = await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    await submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', editToken,
      available: [{ start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:30:00.000Z' }],
    });
    expect(await repo.listRecords(HOST, RESPONSE_NSID)).toHaveLength(1);
    expect(listResponseCache(deps.db, poll.rkey)).toHaveLength(1);
  });

  it('rejects paint that snaps to nothing', async () => {
    const { deps, poll } = await setup();
    await expect(submitGuestResponse(deps, poll.rkey, {
      name: 'Sam', available: [{ start: '2026-09-02T05:00:00.000Z', end: '2026-09-02T05:30:00.000Z' }],
    })).rejects.toThrow(/no valid availability/);
  });

  it('enforces the guest cap', async () => {
    const { deps, poll } = await setup();
    for (let i = 0; i < GUEST_CAP; i++) {
      await submitGuestResponse(deps, poll.rkey, { name: `G${i}`, available: PAINT });
    }
    await expect(submitGuestResponse(deps, poll.rkey, { name: 'Late', available: PAINT }))
      .rejects.toThrow(/full/);
  });

  it('rejects responses to a non-active poll', async () => {
    const { deps, repo, poll } = await setup();
    const cur = await repo.getRecord(HOST, SCHEDULE_NSID, poll.rkey);
    await repo.putRecord(HOST, SCHEDULE_NSID, poll.rkey, { ...cur!.value, status: 'closed' });
    await getPollWithRevalidate(deps, poll.rkey); // refresh cache
    await expect(submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT }))
      .rejects.toThrow(/not open/);
  });
});

describe('submitAccountResponse', () => {
  it('writes to the responder repo and upserts on resubmit', async () => {
    const { deps, repo, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:sam', poll.rkey, { available: PAINT });
    await submitAccountResponse(deps, 'did:plc:sam', poll.rkey, {
      available: [{ start: '2026-09-02T18:00:00.000Z', end: '2026-09-02T18:30:00.000Z' }],
    });
    const recs = await repo.listRecords('did:plc:sam', RESPONSE_NSID);
    expect(recs).toHaveLength(1);
    expect((recs[0].value as { guest?: unknown }).guest).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/responses.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/services/responses.ts`

```ts
import { TID } from '@atproto/common';
import type { Deps } from '../atproto/types.js';
import type { Interval } from '../core/intervals.js';
import { snapToSlots } from '../core/intervals.js';
import { materializeSlots } from '../core/slots.js';
import {
  buildResponseRecord, validateResponseRecord, RESPONSE_NSID, type ResponseRecord,
} from '../atproto/records.js';
import { getPollWithRevalidate, parseRkey } from './polls.js';
import { createEditSecret, lookupEditSecret } from '../db/editSecrets.js';
import {
  enqueueOutbox, dueOutbox, markOutboxDone, markOutboxFailed,
} from '../db/outbox.js';
import { upsertResponseCache, countResponses, addParticipant } from '../db/cache.js';
import type { CachedPoll } from '../db/cache.js';

export const GUEST_CAP = 60;

async function loadOpenPoll(deps: Deps, pollRkey: string): Promise<CachedPoll> {
  const poll = await getPollWithRevalidate(deps, pollRkey);
  if (!poll || poll.tombstoned) throw new Error('poll not found');
  if (poll.record.status !== 'active') throw new Error('poll is not open for responses');
  return poll;
}

function snapPaint(poll: CachedPoll, available: Interval[], ifNeedBe?: Interval[]) {
  const slots = materializeSlots(poll.record.time);
  const snappedAvailable = available.length ? snapToSlots(available, slots) : [];
  const snappedIfNeedBe = ifNeedBe?.length ? snapToSlots(ifNeedBe, slots) : [];
  if (snappedAvailable.length === 0 && snappedIfNeedBe.length === 0) {
    throw new Error('no valid availability painted');
  }
  return { snappedAvailable, snappedIfNeedBe };
}

function buildFromPaint(
  poll: CachedPoll,
  snapped: { snappedAvailable: Interval[]; snappedIfNeedBe: Interval[] },
  extra: { guestName?: string; timezone?: string; note?: string },
): ResponseRecord {
  return buildResponseRecord({
    subject: { uri: poll.uri, cid: poll.cid ?? '' },
    available: snapped.snappedAvailable, // may be [] when only ifNeedBe was painted
    ifNeedBe: snapped.snappedIfNeedBe.length ? snapped.snappedIfNeedBe : undefined,
    ...extra,
  });
}

export async function submitGuestResponse(
  deps: Deps, pollRkey: string,
  input: {
    name: string; available: Interval[]; ifNeedBe?: Interval[];
    timezone?: string; note?: string; editToken?: string;
  },
): Promise<{ editToken: string; pending: boolean }> {
  const poll = await loadOpenPoll(deps, pollRkey);
  const existingRkey = input.editToken ? lookupEditSecret(deps.db, poll.uri, input.editToken) : null;
  if (input.editToken && !existingRkey) throw new Error('invalid edit link');
  if (!existingRkey && countResponses(deps.db, pollRkey) >= GUEST_CAP) {
    throw new Error('this poll is full');
  }
  const snapped = snapPaint(poll, input.available, input.ifNeedBe);
  const record = buildFromPaint(poll, snapped, {
    guestName: input.name, timezone: input.timezone, note: input.note,
  });

  const rkey = existingRkey ?? TID.nextStr();
  const now = deps.now().getTime();
  const outboxId = enqueueOutbox(
    deps.db, { hostDid: poll.hostDid, pollUri: poll.uri, rkey, record }, now,
  );
  upsertResponseCache(deps.db, pollRkey, 'guest', rkey, record, true);
  const editToken = existingRkey && input.editToken
    ? input.editToken
    : createEditSecret(deps.db, poll.uri, rkey);

  // best-effort immediate flush; failure just leaves it pending
  let pending = true;
  try {
    const writer = await deps.writerFor(poll.hostDid);
    await writer.putRecord(poll.hostDid, RESPONSE_NSID, rkey, record);
    markOutboxDone(deps.db, outboxId);
    upsertResponseCache(deps.db, pollRkey, 'guest', rkey, record, false);
    pending = false;
  } catch (err) {
    markOutboxFailed(deps.db, outboxId, (err as Error).message, now);
  }
  return { editToken, pending };
}

export async function submitAccountResponse(
  deps: Deps, did: string, pollRkey: string,
  input: { available: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string },
): Promise<void> {
  const poll = await loadOpenPoll(deps, pollRkey);
  const snapped = snapPaint(poll, input.available, input.ifNeedBe);

  // find an existing response for this poll in the responder's repo → upsert its rkey
  const existing = (await deps.reader.listRecords(did, RESPONSE_NSID)).find(
    (r) => (r.value as ResponseRecord).subject?.uri === poll.uri,
  );
  const rkey = existing ? parseRkey(existing.uri) : TID.nextStr();

  const record = buildFromPaint(poll, snapped, { timezone: input.timezone, note: input.note });
  const writer = await deps.writerFor(did);
  await writer.putRecord(did, RESPONSE_NSID, rkey, record);
  addParticipant(deps.db, pollRkey, did);
  upsertResponseCache(deps.db, pollRkey, 'account', did, record, false);
}

export async function flushOutbox(deps: Deps): Promise<{ flushed: number; failed: number }> {
  const now = deps.now().getTime();
  let flushed = 0;
  let failed = 0;
  for (const item of dueOutbox(deps.db, now)) {
    try {
      const writer = await deps.writerFor(item.hostDid);
      const record = validateResponseRecord(item.record);
      await writer.putRecord(item.hostDid, RESPONSE_NSID, item.rkey, record);
      markOutboxDone(deps.db, item.id);
      upsertResponseCache(deps.db, parseRkey(item.pollUri), 'guest', item.rkey, record, false);
      flushed++;
    } catch (err) {
      markOutboxFailed(deps.db, item.id, (err as Error).message, now);
      failed++;
    }
  }
  return { flushed, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/responses.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/responses.ts tests/services/responses.test.ts
git commit -m "feat: guest outbox flow and account response upsert"
```

---

### Task 14: Finalization and ICS

**Files:**
- Create: `src/core/ics.ts`
- Modify: `src/services/polls.ts` (append `finalizePoll`)
- Test: `tests/core/ics.test.ts`, `tests/services/finalize.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6, 9, 10, 12.
- Produces: `buildIcs(input: { uid: string; title: string; start: string; end: string; url?: string; now: Date }): string`; `EVENT_NSID = 'community.lexicon.calendar.event'`; `finalizePoll(deps: Deps, hostDid: string, rkey: string, slot: Interval): Promise<void>` — validates the slot is one of the poll's materialized slots, updates the schedule record (`status: 'finalized'`, `finalized: slot`), and creates a `community.lexicon.calendar.event` record in the host's repo. Used by Tasks 17, 19.

- [ ] **Step 1: Write the failing ICS tests** — `tests/core/ics.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildIcs } from '../../src/core/ics.js';

describe('buildIcs', () => {
  const ics = buildIcs({
    uid: '3kpoll@poll.wzrdz.cool', title: 'Movie night; bring snacks',
    start: '2026-09-02T21:00:00.000Z', end: '2026-09-02T23:00:00.000Z',
    url: 'https://poll.wzrdz.cool/p/3kpoll', now: new Date('2026-08-31T12:00:00.000Z'),
  });
  it('produces a VCALENDAR with UTC times in basic format', () => {
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('DTSTART:20260902T210000Z');
    expect(ics).toContain('DTEND:20260902T230000Z');
    expect(ics).toContain('DTSTAMP:20260831T120000Z');
    expect(ics).toContain('UID:3kpoll@poll.wzrdz.cool');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
  it('escapes ICS special characters in the summary', () => {
    expect(ics).toContain('SUMMARY:Movie night\\; bring snacks');
  });
  it('uses CRLF line endings throughout', () => {
    expect(ics.includes('\n')).toBe(true);
    expect(ics.split('\r\n').some((line) => line.includes('\n'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement** — `src/core/ics.ts`

Run: `npx vitest run tests/core/ics.test.ts` — expected: FAIL. Then:

```ts
const toBasic = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export function buildIcs(input: {
  uid: string; title: string; start: string; end: string; url?: string; now: Date;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//wzrdz-poll//EN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${toBasic(input.now.toISOString())}`,
    `DTSTART:${toBasic(input.start)}`,
    `DTEND:${toBasic(input.end)}`,
    `SUMMARY:${esc(input.title)}`,
    ...(input.url ? [`URL:${input.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
```

Run again — expected: PASS (3 tests).

- [ ] **Step 3: Write the failing finalize tests** — `tests/services/finalize.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createPoll, finalizePoll, getPollWithRevalidate, EVENT_NSID } from '../../src/services/polls.js';
import { SCHEDULE_NSID } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 60 as const, timezone: 'UTC',
};
const SLOT = { start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' };

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const poll = await createPoll(deps, HOST, { title: 'T', time });
  return { deps, repo, poll };
}

describe('finalizePoll', () => {
  it('flips status, records the slot, and emits a community calendar event', async () => {
    const { deps, repo, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    const updated = await repo.getRecord(HOST, SCHEDULE_NSID, poll.rkey);
    expect((updated?.value as { status: string }).status).toBe('finalized');
    expect((updated?.value as { finalized: unknown }).finalized).toEqual(SLOT);
    const events = await repo.listRecords(HOST, EVENT_NSID);
    expect(events).toHaveLength(1);
    expect((events[0].value as { name: string }).name).toBe('T');
    expect((await getPollWithRevalidate(deps, poll.rkey))?.record.status).toBe('finalized');
  });
  it('rejects a slot that is not one of the poll slots', async () => {
    const { deps, poll } = await setup();
    await expect(finalizePoll(deps, HOST, poll.rkey, {
      start: '2026-09-02T05:00:00.000Z', end: '2026-09-02T06:00:00.000Z',
    })).rejects.toThrow(/not a slot/);
  });
  it('rejects a non-host', async () => {
    const { deps, poll } = await setup();
    await expect(finalizePoll(deps, 'did:plc:mallory', poll.rkey, SLOT)).rejects.toThrow(/host/);
  });
  it('rejects double finalization', async () => {
    const { deps, poll } = await setup();
    await finalizePoll(deps, HOST, poll.rkey, SLOT);
    await expect(finalizePoll(deps, HOST, poll.rkey, SLOT)).rejects.toThrow(/already/);
  });
});
```

- [ ] **Step 4: Run to verify failure, then implement** — append to `src/services/polls.ts`

Run: `npx vitest run tests/services/finalize.test.ts` — expected: FAIL. Then append:

```ts
import { materializeSlots } from '../core/slots.js';
import type { Interval } from '../core/intervals.js';

export const EVENT_NSID = 'community.lexicon.calendar.event';

export async function finalizePoll(
  deps: Deps, hostDid: string, rkey: string, slot: Interval,
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (poll.record.status === 'finalized') throw new Error('poll is already finalized');
  const slots = materializeSlots(poll.record.time);
  const winning = slots.some((s) => s.start === slot.start && s.end === slot.end);
  if (!winning) throw new Error('not a slot of this poll');

  const next = validateScheduleRecord({ ...poll.record, status: 'finalized', finalized: slot });
  await putUpdated(deps, hostDid, rkey, next);

  // NOTE for the implementer: before first deploy, diff these fields against the published
  // community.lexicon.calendar.event schema at https://github.com/lexicon-community/lexicon
  // and adjust names to match exactly. The test asserts only `name`.
  const writer = await deps.writerFor(hostDid);
  await writer.createRecord(hostDid, EVENT_NSID, {
    $type: EVENT_NSID,
    name: poll.record.title,
    ...(poll.record.description ? { description: poll.record.description } : {}),
    startsAt: slot.start,
    endsAt: slot.end,
    createdAt: deps.now().toISOString(),
  });
}
```

(Move the two `import` lines to the top of `polls.ts` with the existing imports.)

Run again — expected: PASS (4 tests).

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`
Expected: all tests pass.

```bash
git add src/core/ics.ts src/services/polls.ts tests/core/ics.test.ts tests/services/finalize.test.ts
git commit -m "feat: poll finalization with ICS and community calendar event"
```

---

### Task 15: Results service

**Files:**
- Create: `src/services/results.ts`
- Test: `tests/services/results.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 9, 10, 12, 13.
- Produces:
  ```ts
  export interface PollResults {
    poll: CachedPoll;
    slots: Interval[];
    responses: ResponseSummary[]; // who = guest name or account DID; pending flagged
    ranked: RankedSlot[];
  }
  export function getResults(deps: Deps, pollRkey: string): Promise<PollResults | null>;
  ```
  Account responses are revalidated per participant via `reader.listRecords(did, RESPONSE_NSID)` filtered by `subject.uri`. Used by Tasks 17, 19.

- [ ] **Step 1: Write the failing tests** — `tests/services/results.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createPoll } from '../../src/services/polls.js';
import { submitGuestResponse, submitAccountResponse } from '../../src/services/responses.js';
import { getResults } from '../../src/services/results.js';
import type { Deps } from '../../src/atproto/types.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '18:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const PAINT = [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z' }];

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const poll = await createPoll(deps, HOST, { title: 'T', time });
  return { deps, repo, poll };
}

describe('getResults', () => {
  it('merges guest and account responses and ranks slots', async () => {
    const { deps, poll } = await setup();
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses.map((r) => r.who).sort()).toEqual(['Sam', 'did:plc:ana']);
    expect(results?.ranked[0].slot).toEqual(PAINT[0]);
    expect(results?.ranked[0].available).toHaveLength(2);
    expect(results?.slots).toHaveLength(2);
  });

  it('marks unflushed guest responses pending', async () => {
    const { deps, repo, poll } = await setup();
    repo.failWrites = true;
    await submitGuestResponse(deps, poll.rkey, { name: 'Sam', available: PAINT });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses[0].pending).toBe(true);
  });

  it('picks up an account response edited directly in the PDS', async () => {
    const { deps, repo, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    const recs = await repo.listRecords('did:plc:ana', 'cool.wzrdz.poll.response');
    const rkey = recs[0].uri.split('/').pop()!;
    await repo.putRecord('did:plc:ana', 'cool.wzrdz.poll.response', rkey, {
      ...recs[0].value,
      available: [{ start: '2026-09-02T17:30:00.000Z', end: '2026-09-02T18:00:00.000Z' }],
    });
    const results = await getResults(deps, poll.rkey);
    const ana = results?.responses.find((r) => r.who === 'did:plc:ana');
    expect(ana?.available[0].start).toBe('2026-09-02T17:30:00.000Z');
  });

  it('ignores an account record referencing a different poll', async () => {
    const { deps, repo, poll } = await setup();
    await submitAccountResponse(deps, 'did:plc:ana', poll.rkey, { available: PAINT });
    await repo.createRecord('did:plc:ana', 'cool.wzrdz.poll.response', {
      subject: { uri: 'at://did:plc:other/cool.wzrdz.poll.schedule/xyz', cid: 'bafyfake' },
      available: PAINT, createdAt: '2026-08-31T12:00:00.000Z',
    });
    const results = await getResults(deps, poll.rkey);
    expect(results?.responses).toHaveLength(1);
  });

  it('returns null for an unknown poll', async () => {
    const { deps } = await setup();
    expect(await getResults(deps, 'nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/services/results.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/services/results.ts`

```ts
import type { Deps } from '../atproto/types.js';
import type { Interval } from '../core/intervals.js';
import { materializeSlots } from '../core/slots.js';
import { rankSlots, type RankedSlot, type ResponseSummary } from '../core/ranking.js';
import { validateResponseRecord, RESPONSE_NSID, type ResponseRecord } from '../atproto/records.js';
import { getPollWithRevalidate } from './polls.js';
import {
  listParticipants, listResponseCache, upsertResponseCache, type CachedPoll,
} from '../db/cache.js';

export interface PollResults {
  poll: CachedPoll;
  slots: Interval[];
  responses: ResponseSummary[];
  ranked: RankedSlot[];
}

export async function getResults(deps: Deps, pollRkey: string): Promise<PollResults | null> {
  const poll = await getPollWithRevalidate(deps, pollRkey);
  if (!poll) return null;

  // revalidate account responses straight from each participant's PDS
  for (const did of listParticipants(deps.db, pollRkey)) {
    try {
      const recs = await deps.reader.listRecords(did, RESPONSE_NSID);
      const mine = recs.find((r) => (r.value as ResponseRecord).subject?.uri === poll.uri);
      if (mine) {
        upsertResponseCache(deps.db, pollRkey, 'account', did, validateResponseRecord(mine.value), false);
      }
    } catch {
      // stale cache is fine for a read
    }
  }

  const rows = listResponseCache(deps.db, pollRkey);
  const responses: ResponseSummary[] = rows.map((row) => ({
    who: row.source === 'guest' ? row.record.guest?.name ?? 'Guest' : row.key,
    pending: row.pending || undefined,
    available: row.record.available,
    ifNeedBe: row.record.ifNeedBe ?? [],
  }));

  const slots = materializeSlots(poll.record.time);
  return { poll, slots, responses, ranked: rankSlots(slots, responses) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/results.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/results.ts tests/services/results.test.ts
git commit -m "feat: results service merging PDS and outbox state"
```

---

### Task 16: Per-IP rate limiter

**Files:**
- Create: `src/web/rateLimit.ts`
- Test: `tests/web/rateLimit.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class TokenBucket { constructor(capacity: number, refillPerSecond: number); allow(key: string, nowMs: number): boolean }`. Used by Task 17 (guest submission route, capacity 10, refill 0.1/s).

- [ ] **Step 1: Write the failing tests** — `tests/web/rateLimit.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { TokenBucket } from '../../src/web/rateLimit.js';

describe('TokenBucket', () => {
  it('allows up to capacity, then denies', () => {
    const tb = new TokenBucket(3, 0.1);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip1', 0)).toBe(false);
  });
  it('keys are independent', () => {
    const tb = new TokenBucket(1, 0.1);
    expect(tb.allow('ip1', 0)).toBe(true);
    expect(tb.allow('ip2', 0)).toBe(true);
  });
  it('refills over time up to capacity', () => {
    const tb = new TokenBucket(2, 0.1); // one token per 10s
    tb.allow('ip1', 0); tb.allow('ip1', 0);
    expect(tb.allow('ip1', 5_000)).toBe(false);
    expect(tb.allow('ip1', 10_000)).toBe(true);
    expect(tb.allow('ip1', 1_000_000)).toBe(true); // capped at capacity, not unbounded
    expect(tb.allow('ip1', 1_000_000)).toBe(true);
    expect(tb.allow('ip1', 1_000_000)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement** — `src/web/rateLimit.ts`

Run: `npx vitest run tests/web/rateLimit.test.ts` — expected: FAIL. Then:

```ts
export class TokenBucket {
  private state = new Map<string, { tokens: number; at: number }>();
  constructor(private capacity: number, private refillPerSecond: number) {}

  allow(key: string, nowMs: number): boolean {
    const cur = this.state.get(key) ?? { tokens: this.capacity, at: nowMs };
    const refilled = Math.min(
      this.capacity,
      cur.tokens + ((nowMs - cur.at) / 1000) * this.refillPerSecond,
    );
    if (refilled < 1) {
      this.state.set(key, { tokens: refilled, at: nowMs });
      return false;
    }
    this.state.set(key, { tokens: refilled - 1, at: nowMs });
    return true;
  }
}
```

Run again — expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add src/web/rateLimit.ts tests/web/rateLimit.test.ts
git commit -m "feat: token-bucket rate limiter for guest submissions"
```

---

### Task 17: Server assembly, poll routes, and views

**Files:**
- Create: `src/web/views.ts`, `src/web/routes/polls.ts`, `src/web/server.ts`, `src/index.ts`
- Test: `tests/web/server.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `views.ts`: `layout(title: string, body: HtmlEscapedString | string)`, `landingPage(loggedInDid: string | null)`, `createFormPage()`, `pollPage(data: PollPageData)`, `decidedPage(...)` using `html` from `hono/html`. `interface PollPageData { rkey: string; title: string; description?: string; status: string; time: SpecificDates; results: { responses: Array<{ who: string; pending?: boolean }>; rankedTop: Array<{ slot: Interval; available: string[]; ifNeedBe: string[]; missing: string[] }> }; viewerDid: string | null; isHost: boolean; prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string } }`. The poll page embeds `<script id="poll-data" type="application/json">` with `{ rkey, time, slots, prefill, editToken, viewerDid, timezone: time.timezone, counts }` where `counts` maps each slot start to `{ available: string[]; ifNeedBe: string[] }` from the ranked results and `<script type="module" src="/grid.js">`, plus a `<div id="grid-root">` mount point and the guest-name field with the public-visibility notice: "Shown publicly on this poll". Markup contracts the tests depend on: `layout` renders the app name "wzrdz-poll" in the header; `createFormPage` has `input[name=title]`, `input[name=description]`, `input[name=dates]` (comma-separated ISO dates), `input[name=windowStart]`, `input[name=windowEnd]`, `select[name=slotMinutes]` (options 15/30/60), `input[name=timezone]`, and a `button[type=submit]`; each host finalize form posts to `/p/:rkey/finalize` with hidden `start`/`end` inputs and one visible button; `decidedPage` includes the word "Decided"; when the viewer is the host and `pendingOutboxCount(deps.db, hostDid) > 0`, the poll page shows a banner: "N responses are still syncing to your account. If this persists for more than a day, sign in again to reconnect." (import `pendingOutboxCount` from `../db/outbox.js` and pass the count into `pollPage`).
  - `routes/polls.ts`: `pollRoutes(deps: Deps, auth: AuthClient, env: { COOKIE_SECRET: string; PUBLIC_URL: string }): Hono` mounting:
    - `GET /` — landing (create form if logged in, otherwise login link)
    - `POST /polls` — host only (signed cookie), fields `title`, `description`, `dates` (comma-separated ISO), `windowStart`, `windowEnd`, `slotMinutes`, `timezone` → `createPoll` → redirect `/p/:rkey`
    - `GET /p/:rkey` — poll page (or decided page when finalized; "withdrawn by host" page when tombstoned)
    - `GET /p/:rkey/e/:token` — poll page with guest prefill loaded via the edit token
    - `POST /p/:rkey/respond` — guest submit, JSON body `{ name, available, ifNeedBe?, timezone?, note?, editToken? }`, rate-limited (429 on deny), returns `{ editToken, pending }`; 400 with the error message on validation failure
    - `POST /p/:rkey/respond-auth` — same body minus name/editToken; requires cookie; 401 otherwise
    - `POST /p/:rkey/finalize` — host only; fields `start`, `end`
    - `GET /p/:rkey/ics` — `text/calendar` via `buildIcs` (only when finalized; 404 otherwise)
  - `server.ts`: `createServer(deps: Deps, auth: AuthClient, env): Hono` — mounts auth routes + poll routes + `serveStatic` for `public/`.
  - `index.ts`: reads env (`PORT` default 8787, `PUBLIC_URL`, `DB_PATH` default `./wzrdz-poll.db`, `COOKIE_SECRET`, `SESSION_ENC_KEY`, `OAUTH_JWK`), builds real deps (`PublicPdsReader`, `writerFor: (did) => auth.restore(did).then(writerForAgent)`), starts `@hono/node-server`, and runs `flushOutbox(deps)` on a 60-second `setInterval`.
- Used by Tasks 18, 19, 20.

- [ ] **Step 1: Write the failing tests** — `tests/web/server.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { createPoll } from '../../src/services/polls.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const PAINT = [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' }];

const stubAuth: AuthClient = {
  clientMetadata: {},
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: HOST }),
  restore: async () => { throw new Error('not used'); },
};

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const app = createServer(deps, stubAuth, {
    COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787',
  });
  const poll = await createPoll(deps, HOST, { title: 'Movie night', time });
  return { app, deps, repo, poll };
}

describe('server', () => {
  it('serves the landing page', async () => {
    const { app } = await setup();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('wzrdz-poll');
  });

  it('renders a poll page with embedded grid data', async () => {
    const { app, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('Movie night');
    expect(body).toContain('poll-data');
    expect(body).toContain('Shown publicly on this poll');
  });

  it('accepts a guest response and returns an edit token', async () => {
    const { app, repo, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: PAINT }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editToken: string; pending: boolean };
    expect(body.editToken).toBeTruthy();
    expect(await repo.listRecords(HOST, 'cool.wzrdz.poll.response')).toHaveLength(1);
  });

  it('returns 400 with a message for unusable paint', async () => {
    const { app, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits bursts of guest submissions from one IP', async () => {
    const { app, poll } = await setup();
    let denied = 0;
    for (let i = 0; i < 15; i++) {
      const res = await app.request(`/p/${poll.rkey}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9' },
        body: JSON.stringify({ name: `G${i}`, available: PAINT }),
      });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('blocks poll creation without a session cookie', async () => {
    const { app } = await setup();
    const res = await app.request('/polls', {
      method: 'POST',
      body: new URLSearchParams({
        title: 'X', dates: '2026-09-02', windowStart: '17:00', windowEnd: '19:00',
        slotMinutes: '30', timezone: 'UTC',
      }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('serves ICS only once finalized', async () => {
    const { app, deps, poll } = await setup();
    expect((await app.request(`/p/${poll.rkey}/ics`)).status).toBe(404);
    const { finalizePoll } = await import('../../src/services/polls.js');
    await finalizePoll(deps, HOST, poll.rkey, {
      start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z',
    });
    const res = await app.request(`/p/${poll.rkey}/ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(await res.text()).toContain('BEGIN:VEVENT');
  });

  it('renders a tombstone page for withdrawn polls', async () => {
    const { app, repo, poll } = await setup();
    repo.delete(HOST, 'cool.wzrdz.poll.schedule', poll.rkey);
    const res = await app.request(`/p/${poll.rkey}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('withdrawn by the host');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/web/server.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/web/views.ts`**

Keep markup semantic and minimal; one inline `<style>` block in `layout` (system font stack, a simple responsive column, `.pending { opacity: .6 }`, button/input basics). The poll page must include: the title/description; the guest name input labeled with "Shown publicly on this poll"; the Available / If need be segmented toggle (two radio buttons `name="paintMode"`); `<div id="grid-root"></div>`; the embedded JSON (`<script id="poll-data" type="application/json">${raw(JSON.stringify(data))}</script>` — use `raw` from `hono/html` and escape `</` as `<\/` in the JSON string); `<script type="module" src="/grid.js"></script>`; a results section listing `rankedTop` (top 5) as "17:00–17:30 Wed Sep 2 — 4 available + 1 if needed, missing: X" with pending responders marked "(syncing)"; for the host on an active poll, a finalize form per ranked slot. The decided page shows the chosen slot, an `/ics` download link, and a `webcal://` link derived from `PUBLIC_URL`. The tombstone page says "This poll was withdrawn by the host."

- [ ] **Step 4: Implement `src/web/routes/polls.ts`**

```ts
import { Hono } from 'hono';
import type { Deps } from '../../atproto/types.js';
import type { AuthClient } from '../../atproto/oauthClient.js';
import type { Interval } from '../../core/intervals.js';
import { materializeSlots, type SpecificDates } from '../../core/slots.js';
import { getSessionDid } from './auth.js';
import { createPoll, getPollWithRevalidate, finalizePoll } from '../../services/polls.js';
import { submitGuestResponse, submitAccountResponse } from '../../services/responses.js';
import { getResults } from '../../services/results.js';
import { lookupEditSecret } from '../../db/editSecrets.js';
import { listResponseCache } from '../../db/cache.js';
import { buildIcs } from '../../core/ics.js';
import { TokenBucket } from '../rateLimit.js';
import { landingPage, createFormPage, pollPage, decidedPage, tombstonePage } from '../views.js';

const guestLimiter = new TokenBucket(10, 0.1);

export function pollRoutes(
  deps: Deps, auth: AuthClient, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();

  app.get('/', async (c) => c.html(landingPage(await getSessionDid(c, env.COOKIE_SECRET))));

  app.post('/polls', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.redirect('/login');
    const f = await c.req.formData();
    const time: SpecificDates = {
      dates: String(f.get('dates') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      window: { start: String(f.get('windowStart')), end: String(f.get('windowEnd')) },
      slotMinutes: Number(f.get('slotMinutes')) as 15 | 30 | 60,
      timezone: String(f.get('timezone')),
    };
    try {
      const { rkey } = await createPoll(deps, did, {
        title: String(f.get('title') ?? ''),
        description: String(f.get('description') ?? '') || undefined,
        time,
      });
      return c.redirect(`/p/${rkey}`);
    } catch (err) {
      return c.text(`Could not create poll: ${(err as Error).message}`, 400);
    }
  });

  const renderPoll = async (c: import('hono').Context, rkey: string, editToken?: string) => {
    const results = await getResults(deps, rkey);
    if (!results) return c.notFound();
    if (results.poll.tombstoned) return c.html(tombstonePage(), 410);
    const viewerDid = await getSessionDid(c, env.COOKIE_SECRET);
    if (results.poll.record.status === 'finalized' && results.poll.record.finalized) {
      return c.html(decidedPage(rkey, results.poll.record, env.PUBLIC_URL));
    }
    let prefill;
    if (editToken) {
      const respRkey = lookupEditSecret(deps.db, results.poll.uri, editToken);
      const row = respRkey
        ? listResponseCache(deps.db, rkey).find((r) => r.source === 'guest' && r.key === respRkey)
        : null;
      if (row) {
        prefill = {
          available: row.record.available,
          ifNeedBe: row.record.ifNeedBe ?? [],
          name: row.record.guest?.name,
        };
      }
    }
    return c.html(pollPage({
      rkey,
      title: results.poll.record.title,
      description: results.poll.record.description,
      status: results.poll.record.status,
      time: results.poll.record.time,
      slots: results.slots,
      results,
      viewerDid,
      isHost: viewerDid === results.poll.hostDid,
      prefill,
      editToken,
    }));
  };

  app.get('/p/:rkey', (c) => renderPoll(c, c.req.param('rkey')));
  app.get('/p/:rkey/e/:token', (c) => renderPoll(c, c.req.param('rkey'), c.req.param('token')));

  app.post('/p/:rkey/respond', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    if (!guestLimiter.allow(ip, deps.now().getTime())) {
      return c.json({ error: 'Too many submissions — try again in a minute.' }, 429);
    }
    const body = (await c.req.json()) as {
      name?: string; available?: Interval[]; ifNeedBe?: Interval[];
      timezone?: string; note?: string; editToken?: string;
    };
    try {
      const out = await submitGuestResponse(deps, c.req.param('rkey'), {
        name: String(body.name ?? '').trim() || 'Guest',
        available: body.available ?? [],
        ifNeedBe: body.ifNeedBe,
        timezone: body.timezone,
        note: body.note,
        editToken: body.editToken,
      });
      return c.json(out);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/p/:rkey/respond-auth', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.json({ error: 'sign in first' }, 401);
    const body = (await c.req.json()) as {
      available?: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string;
    };
    try {
      await submitAccountResponse(deps, did, c.req.param('rkey'), {
        available: body.available ?? [], ifNeedBe: body.ifNeedBe,
        timezone: body.timezone, note: body.note,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/p/:rkey/finalize', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.redirect('/login');
    const f = await c.req.formData();
    try {
      await finalizePoll(deps, did, c.req.param('rkey'), {
        start: String(f.get('start')), end: String(f.get('end')),
      });
      return c.redirect(`/p/${c.req.param('rkey')}`);
    } catch (err) {
      return c.text(`Could not finalize: ${(err as Error).message}`, 400);
    }
  });

  app.get('/p/:rkey/ics', async (c) => {
    const poll = await getPollWithRevalidate(deps, c.req.param('rkey'));
    if (!poll || poll.record.status !== 'finalized' || !poll.record.finalized) return c.notFound();
    const ics = buildIcs({
      uid: `${poll.rkey}@poll.wzrdz.cool`,
      title: poll.record.title,
      start: poll.record.finalized.start,
      end: poll.record.finalized.end,
      url: `${env.PUBLIC_URL}/p/${poll.rkey}`,
      now: deps.now(),
    });
    return c.body(ics, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${poll.rkey}.ics"`,
    });
  });

  return app;
}
```

Note for the implementer: `pollPage`'s data argument here includes `slots` and `editToken` beyond the `PollPageData` sketch — define `PollPageData` in `views.ts` to match this call site exactly.

- [ ] **Step 5: Implement `src/web/server.ts` and `src/index.ts`**

`server.ts`:

```ts
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Deps } from '../atproto/types.js';
import type { AuthClient } from '../atproto/oauthClient.js';
import { authRoutes } from './routes/auth.js';
import { pollRoutes } from './routes/polls.js';

export function createServer(
  deps: Deps, auth: AuthClient, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();
  app.use('/grid.js', serveStatic({ root: './public', rewriteRequestPath: () => '/grid.js' }));
  app.route('/', authRoutes(auth, env.COOKIE_SECRET));
  app.route('/', pollRoutes(deps, auth, env));
  return app;
}
```

`index.ts`:

```ts
import { serve } from '@hono/node-server';
import { openDb } from './db/db.js';
import { createOAuthClient } from './atproto/oauthClient.js';
import { PublicPdsReader, writerForAgent } from './atproto/pds.js';
import { flushOutbox } from './services/responses.js';
import { createServer } from './web/server.js';
import type { Deps } from './atproto/types.js';

const env = {
  PORT: Number(process.env.PORT ?? 8787),
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:8787',
  DB_PATH: process.env.DB_PATH ?? './wzrdz-poll.db',
  COOKIE_SECRET: process.env.COOKIE_SECRET ?? 'dev-cookie-secret',
  SESSION_ENC_KEY: process.env.SESSION_ENC_KEY ?? '00'.repeat(32),
  OAUTH_JWK: process.env.OAUTH_JWK,
};

const db = openDb(env.DB_PATH);
const auth = await createOAuthClient(db, env);
const deps: Deps = {
  db,
  reader: new PublicPdsReader(),
  writerFor: async (did) => writerForAgent(await auth.restore(did)),
  now: () => new Date(),
};

setInterval(() => {
  void flushOutbox(deps).catch((err) => console.error('outbox flush failed:', err));
}, 60_000);

serve({ fetch: createServer(deps, auth, env).fetch, port: env.PORT });
console.log(`wzrdz-poll listening on :${env.PORT} (${env.PUBLIC_URL})`);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/web/server.test.ts && npm run typecheck`
Expected: PASS (8 tests); tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/web src/index.ts tests/web/server.test.ts
git commit -m "feat: server assembly, poll routes, and server-rendered views"
```

---

### Task 18: Grid island (Preact)

**Files:**
- Create: `src/web/static/grid.tsx`
- Verify via: `npm run build:grid`, `npm run typecheck`, and the Task 19 e2e suite (the paint logic itself was TDD'd in Task 5).

**Interfaces:**
- Consumes: `gridModel.ts` (Task 5), the `#poll-data` JSON block and `#grid-root` mount from Task 17's `pollPage`.
- Produces: `public/grid.js` bundle. POSTs to `/p/:rkey/respond` (guest) or `/p/:rkey/respond-auth` (signed-in), body per Task 17's routes. After a guest submit it shows the edit link `/p/:rkey/e/:editToken` and a "syncing to the host's account" note when `pending` is true.

- [ ] **Step 1: Implement** — `src/web/static/grid.tsx`

```tsx
import { render } from 'preact';
import { useMemo, useState, useRef } from 'preact/hooks';
import {
  buildGeom, strokeOp, rectKeys, applyPaint, paintToIntervals, intervalsToPaint,
  type PaintMap, type PaintMode,
} from '../../core/gridModel.js';
import type { Interval } from '../../core/intervals.js';

interface PollData {
  rkey: string;
  slots: Interval[];
  timezone: string; // the poll's home zone; grid renders in the viewer's zone
  viewerDid: string | null;
  editToken?: string;
  prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string };
}

const data = JSON.parse(document.getElementById('poll-data')!.textContent!) as PollData;
const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone || data.timezone;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d: string): string {
  return new Date(`${d}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function Grid() {
  const geom = useMemo(() => buildGeom(data.slots, viewerZone), []);
  const slotByKey = useMemo(() => new Map(data.slots.map((s) => [s.start, s])), []);
  const [painted, setPainted] = useState<PaintMap>(() =>
    data.prefill
      ? intervalsToPaint(data.prefill.available, data.prefill.ifNeedBe, data.slots)
      : new Map(),
  );
  const [mode, setMode] = useState<PaintMode>('available');
  const [name, setName] = useState(data.prefill?.name ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [editLink, setEditLink] = useState<string | null>(null);
  const drag = useRef<{ anchor: string; op: 'add' | 'remove'; base: PaintMap } | null>(null);

  const paintTo = (key: string) => {
    if (!drag.current) return;
    setPainted(applyPaint(
      drag.current.base, rectKeys(geom, drag.current.anchor, key), drag.current.op, mode,
    ));
  };
  const onDown = (key: string) => (e: PointerEvent) => {
    e.preventDefault();
    drag.current = { anchor: key, op: strokeOp(painted, key, mode), base: painted };
    paintTo(key);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const key = el instanceof HTMLElement ? el.dataset.slot : undefined;
    if (key) paintTo(key);
  };
  const onUp = () => { drag.current = null; };

  const submit = async () => {
    const body = {
      name: name.trim(),
      available: paintToIntervals(painted, data.slots, 'available'),
      ifNeedBe: paintToIntervals(painted, data.slots, 'ifNeedBe'),
      timezone: viewerZone,
      editToken: data.editToken,
    };
    const url = data.viewerDid
      ? `/p/${data.rkey}/respond-auth`
      : `/p/${data.rkey}/respond`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = (await res.json()) as { editToken?: string; pending?: boolean; error?: string };
    if (!res.ok) { setStatus(out.error ?? 'Something went wrong.'); return; }
    setStatus(out.pending
      ? 'Saved — syncing to the host’s account in the background.'
      : 'Saved!');
    if (out.editToken) setEditLink(`${location.origin}/p/${data.rkey}/e/${out.editToken}`);
    setTimeout(() => location.reload(), out.editToken ? 4000 : 1200);
  };

  return (
    <div>
      <div class="toolbar" role="radiogroup" aria-label="Paint mode">
        <button
          class={mode === 'available' ? 'mode active' : 'mode'}
          onClick={() => setMode('available')}
        >Available</button>
        <button
          class={mode === 'ifNeedBe' ? 'mode active' : 'mode'}
          onClick={() => setMode('ifNeedBe')}
        >If need be</button>
        <span class="zone">Times shown in {viewerZone}</span>
      </div>
      <div
        class="grid"
        style={{ touchAction: 'none', display: 'flex', gap: '4px', overflowX: 'auto' }}
        onPointerMove={onMove as never}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        {geom.dates.map((d) => (
          <div class="col" key={d}>
            <div class="col-head">{fmtDate(d)}</div>
            {geom.columns.get(d)!.map((key) => (
              <div
                key={key}
                data-slot={key}
                class={`cell ${painted.get(key) ?? ''}`}
                onPointerDown={onDown(key) as never}
                title={`${fmtTime(key)}–${fmtTime(slotByKey.get(key)!.end)}`}
              >{fmtTime(key)}</div>
            ))}
          </div>
        ))}
      </div>
      {!data.viewerDid && (
        <label class="name">
          Your name <small>(shown publicly on this poll)</small>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
      )}
      <button class="save" onClick={submit} disabled={!data.viewerDid && !name.trim()}>
        Save availability
      </button>
      {status && <p class="status" role="status">{status}</p>}
      {editLink && (
        <p class="edit-link">Keep this link to edit your response later:<br /><code>{editLink}</code></p>
      )}
    </div>
  );
}

render(<Grid />, document.getElementById('grid-root')!);
```

Two additions to make while wiring the component up (both use data already in scope):
- **Zone toggle:** make the `.zone` label a button that toggles a `zone` state between `viewerZone` and `data.timezone` (label: "Times shown in {zone} — switch"); pass `zone` to `buildGeom` and `fmtTime`/`fmtDate` (`toLocaleTimeString`/`toLocaleDateString` accept `{ timeZone: zone }`).
- **Group view:** add a "Me / Group" toggle; in Group mode cells stop accepting paint and instead render `data.counts[key]` — background opacity proportional to `available.length / totalResponders`, hatched overlay when only ifNeedBe voters exist, and a `title` listing who is available / if-need-be for that slot.

Add the matching cell styles to `layout`'s `<style>` in `views.ts`: `.cell { border: 1px solid #ccc; padding: 2px 8px; font-size: 12px; user-select: none; cursor: pointer; min-width: 64px; }`, `.cell.available { background: #2b8a5f; color: white; }`, `.cell.ifNeedBe { background: repeating-linear-gradient(45deg, #9fd6bd, #9fd6bd 4px, #d8efe4 4px, #d8efe4 8px); }`, `.mode.active { outline: 2px solid #2b8a5f; }`.

- [ ] **Step 2: Build and typecheck**

Run: `npm run build:grid && npm run typecheck`
Expected: `public/grid.js` produced; tsc clean.

- [ ] **Step 3: Manual sanity check**

Run: `PUBLIC_URL=http://localhost:8787 npx tsx src/index.ts` and open `http://localhost:8787`. Expected at this stage: the landing page renders; real login requires a PDS so the full flow waits for the e2e task's fake wiring. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add src/web/static/grid.tsx src/web/views.ts
git commit -m "feat: preact paint-grid island with pointer painting and dual modes"
```

---

### Task 19: End-to-end tests (Playwright, fake PDS wiring)

**Files:**
- Create: `e2e/poll.spec.ts`, `playwright.config.ts`
- Modify: `src/index.ts` (add `FAKE_PDS=1` wiring), `src/web/server.ts` (add `/dev/login` when fake auth is enabled)

**Interfaces:**
- Consumes: everything.
- Produces: a runnable `npx playwright test` suite. `FAKE_PDS=1` swaps deps for a process-wide `FakeRepo` and enables `GET /dev/login?did=<did>` which sets the signed `did` cookie directly. Guard both behind the env var; the route must not exist otherwise.

- [ ] **Step 1: Wire fake mode**

In `src/index.ts`, when `process.env.FAKE_PDS === '1'`: import `FakeRepo` from `../tests/helpers/fakeRepo.js` (move the class to `src/atproto/fakeRepo.ts` and re-export from the old path if the import boundary feels wrong — keep the test import path working), construct one instance, and use it as both `reader` and the result of `writerFor`; `auth` becomes a stub whose `authorize` throws (`/dev/login` replaces it).

In `src/web/server.ts`, accept an optional `devLogin: boolean` flag in `env`; when true, mount:

```ts
app.get('/dev/login', async (c) => {
  const did = c.req.query('did') ?? 'did:plc:devhost';
  const { setSignedCookie } = await import('hono/cookie');
  await setSignedCookie(c, 'did', did, env.COOKIE_SECRET, {
    httpOnly: true, sameSite: 'Lax', path: '/',
  });
  return c.redirect('/');
});
```

- [ ] **Step 2: Write `playwright.config.ts`**

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:8787' },
  webServer: {
    command: 'FAKE_PDS=1 npm run build:grid && FAKE_PDS=1 npx tsx src/index.ts',
    port: 8787,
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 3: Write `e2e/poll.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

test('host creates, guest paints, host finalizes', async ({ page }) => {
  // host signs in (dev route) and creates a poll
  await page.goto('/dev/login?did=did:plc:e2ehost');
  await page.goto('/');
  await page.fill('input[name=title]', 'Board games');
  await page.fill('input[name=dates]', '2026-09-02,2026-09-03');
  await page.fill('input[name=windowStart]', '17:00');
  await page.fill('input[name=windowEnd]', '19:00');
  await page.selectOption('select[name=slotMinutes]', '60');
  await page.fill('input[name=timezone]', 'UTC');
  await page.click('button[type=submit]');
  await expect(page.getByText('Board games')).toBeVisible();
  const pollUrl = page.url();

  // guest responds in a clean context: drag-paint two cells, name, save
  const guestContext = await page.context().browser()!.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(pollUrl);
  const cells = guest.locator('[data-slot]');
  await expect(cells.first()).toBeVisible();
  const a = await cells.nth(0).boundingBox();
  const b = await cells.nth(1).boundingBox();
  await guest.mouse.move(a!.x + 5, a!.y + 5);
  await guest.mouse.down();
  await guest.mouse.move(b!.x + 5, b!.y + 5);
  await guest.mouse.up();
  await guest.fill('.name input', 'Sam');
  await guest.click('button.save');
  await expect(guest.getByText('Keep this link')).toBeVisible();
  await guestContext.close();

  // host sees the response and finalizes the top slot
  await page.reload();
  await expect(page.getByText('Sam')).toBeVisible();
  await page.locator('form[action$="/finalize"] button').first().click();
  await expect(page.getByText(/decided|finalized/i)).toBeVisible();
  await expect(page.locator('a[href$="/ics"]')).toBeVisible();
});

test('guest edit link round-trips', async ({ page }) => {
  await page.goto('/dev/login?did=did:plc:e2ehost2');
  await page.goto('/');
  await page.fill('input[name=title]', 'Edit test');
  await page.fill('input[name=dates]', '2026-09-02');
  await page.fill('input[name=windowStart]', '17:00');
  await page.fill('input[name=windowEnd]', '18:00');
  await page.selectOption('select[name=slotMinutes]', '30');
  await page.fill('input[name=timezone]', 'UTC');
  await page.click('button[type=submit]');

  const cells = page.locator('[data-slot]');
  await cells.first().click();
  await page.fill('.name input', 'Ana');
  await page.click('button.save');
  const editLink = await page.locator('.edit-link code').textContent();
  await page.goto(editLink!);
  await expect(page.locator('.name input')).toHaveValue('Ana');
  await expect(page.locator('.cell.available')).toHaveCount(1);
});
```

- [ ] **Step 4: Install browsers and run**

Run: `npx playwright install chromium && npx playwright test`
Expected: 2 tests pass. Selector drift against the actual `views.ts` markup is expected on first run — fix selectors or markup so they agree, keeping the semantic names above (`.name input`, `button.save`, `.edit-link code`, `[data-slot]`, `form[action$="/finalize"]`).

- [ ] **Step 5: Full suite and commit**

Run: `npm test && npx playwright test`
Expected: everything green.

```bash
git add e2e playwright.config.ts src/index.ts src/web/server.ts src/atproto/fakeRepo.ts tests/helpers/fakeRepo.ts
git commit -m "test: end-to-end flows against in-process fake PDS"
```

---

### Task 20: Ops runbook, lexicon publishing, and real-PDS smoke test

**Files:**
- Create: `docs/deploy.md`, `scripts/publishLexicons.ts`
- No unit tests; verified by review and by the manual smoke checklist inside `deploy.md`.

**Interfaces:**
- Consumes: lexicon JSONs (Task 6); `@atproto/api` `AtpAgent`.
- Produces: deployable documentation and a one-shot lexicon publish script.

- [ ] **Step 1: Write `scripts/publishLexicons.ts`**

Publishes each lexicon as a `com.atproto.lexicon.schema` record (rkey = the NSID) in the wzrdz.cool account's repo, using an app password (one-shot admin script; OAuth is unnecessary ceremony here):

```ts
import { AtpAgent } from '@atproto/api';
import scheduleLex from '../lexicons/cool.wzrdz.poll.schedule.json' with { type: 'json' };
import responseLex from '../lexicons/cool.wzrdz.poll.response.json' with { type: 'json' };

const { LEX_HANDLE, LEX_APP_PASSWORD, LEX_PDS = 'https://bsky.social' } = process.env;
if (!LEX_HANDLE || !LEX_APP_PASSWORD) {
  console.error('Set LEX_HANDLE and LEX_APP_PASSWORD (an app password for the wzrdz.cool account).');
  process.exit(1);
}

const agent = new AtpAgent({ service: LEX_PDS });
await agent.login({ identifier: LEX_HANDLE, password: LEX_APP_PASSWORD });

for (const lex of [scheduleLex, responseLex]) {
  const res = await agent.com.atproto.repo.putRecord({
    repo: agent.session!.did,
    collection: 'com.atproto.lexicon.schema',
    rkey: lex.id,
    record: { ...lex, $type: 'com.atproto.lexicon.schema' },
  });
  console.log(`published ${lex.id} -> ${res.data.uri}`);
}
```

- [ ] **Step 2: Write `docs/deploy.md`**

Cover, concretely:

1. **Environment table** — `PORT`, `PUBLIC_URL=https://poll.wzrdz.cool`, `DB_PATH`, `COOKIE_SECRET` (random 32+ chars), `SESSION_ENC_KEY` (`openssl rand -hex 32`), `OAUTH_JWK` (output of `npx tsx scripts/genJwk.ts`), plus `LEX_*` for the publish script. Note plainly: the DB is a disposable index — losing it costs host re-logins, unflushed outbox rows, and guest edit links; polls survive in PDSes.
2. **systemd unit**:
   ```ini
   [Unit]
   Description=wzrdz-poll
   After=network-online.target
   [Service]
   WorkingDirectory=/opt/wzrdz-poll
   EnvironmentFile=/opt/wzrdz-poll/.env
   ExecStart=/usr/bin/npx tsx src/index.ts
   Restart=on-failure
   User=wzrdzpoll
   [Install]
   WantedBy=multi-user.target
   ```
3. **Caddy block**:
   ```
   poll.wzrdz.cool {
       reverse_proxy 127.0.0.1:8787
   }
   ```
   (Caddy sets `X-Forwarded-For`, which the rate limiter reads.)
4. **Lexicon publishing runbook**: add DNS TXT `_lexicon.wzrdz.cool` with value `did=did:plc:<the wzrdz.cool account DID>`; run `LEX_HANDLE=... LEX_APP_PASSWORD=... npx tsx scripts/publishLexicons.ts`; verify with `dig TXT _lexicon.wzrdz.cool` and by fetching the schema record from the account's PDS.
5. **Real-PDS smoke checklist** (the substitute for container integration tests, run once before announcing): deploy with real env; sign in with a real handle via OAuth; create a poll; verify the `cool.wzrdz.poll.schedule` record exists via `com.atproto.repo.getRecord` against your own PDS (e.g. pdsls.dev or curl); submit a guest response from a private browser window; verify the response record landed in the host repo with `guest.name` set; finalize; verify the `community.lexicon.calendar.event` record's field names against the published schema at https://github.com/lexicon-community/lexicon and confirm the ICS file imports into a calendar app.
6. **Known limits** (copy from the spec): no notifications, no calendar OAuth, `atproto transition:generic` scope, guest cap 60.

- [ ] **Step 3: Commit**

```bash
git add scripts/publishLexicons.ts docs/deploy.md
git commit -m "docs: deploy runbook and lexicon publishing script"
```

---

## Plan Self-Review Notes (already applied)

- The `time` union member requires `$type: 'cool.wzrdz.poll.schedule#specificDates'` on the wire; builders add it and `SpecificDates` consumers (`materializeSlots`) ignore the extra property — `slots.ts` destructures only the four fields it needs, and TypeScript structural typing accepts the intersection type.
- `finalizePoll` emits the community event with field names asserted only loosely in tests (`name`); the deploy checklist pins verifying the exact schema before first real use.
- The host-facing "still syncing" banner (spec: surface outbox failures in-app) is covered in Task 17 via `pendingOutboxCount`; the 24h threshold from the spec is simplified to "shown whenever pending > 0" with copy that mentions the one-day mark — same information, no scheduler needed.
- If `@atproto/*` API signatures differ from those written here at install time (these packages move), the stable contracts are this plan's `Interfaces` blocks — adjust the adapter internals (`oauthClient.ts`, `pds.ts`), never the interfaces.
