# shadcn/ui Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw-HTML/CSS view layer with React 19 + Tailwind v4 + vendored shadcn/ui components, keeping every page server-rendered and the entire backend untouched, and fix the create form (multi-date calendar picker, local-timezone default, native time inputs) in the process.

**Architecture:** Hono handlers keep rendering full HTML via `react-dom/server`'s `renderToString`; two client islands (create-form calendar, availability grid) hydrate into mount points. shadcn components are vendored source under `src/web/ui/`. The Preact grid island is ported to React. No SPA, no client routing, no backend changes.

**Tech Stack:** React 19, react-dom/server, Tailwind CSS v4 (`@tailwindcss/cli`), shadcn/ui (vendored: button, input, label, select, card, badge, calendar), react-day-picker v9, Radix primitives (`@radix-ui/react-select`, `@radix-ui/react-label`, `@radix-ui/react-slot`), esbuild, lucide-react.

**Spec:** `docs/superpowers/specs/2026-08-31-wzrdz-poll-design.md` governs all behavior (records, flows, caps, security). This plan changes only presentation; the approved migration design lives in the session conversation and is summarized here. Where this plan and the spec conflict on *behavior*, the spec wins.

## Global Constraints

- TypeScript 7.0.2 strict ESM; `npm run typecheck` clean at every commit.
- End state has **zero** Preact: no `preact` dependency, no `@jsxImportSource preact` pragma. During migration a per-file pragma keeps the old grid compiling.
- All pages remain **server-rendered full HTML** (renderToString); islands hydrate/mount client-side. A guest with JS disabled still sees the poll page content (the grid itself has always required JS; the no-JS dates fallback input must still work).
- **Security contracts survive verbatim:** `scriptJson` escapes every `<` as `<` (the regression test asserting `<!--<script>` safety must still pass); session/cookie handling, rate limiting, and auth routes' logic are untouched — only the HTML they return may change.
- **Form field names are frozen:** `title`, `description`, `dates` (comma-joined `YYYY-MM-DD`), `windowStart`, `windowEnd` (`HH:mm`), `slotMinutes`, `timezone`, `handle`. Server-side parsing in `routes/polls.ts` and `routes/auth.ts` must not change.
- **DOM contracts frozen** (unit + e2e tests depend on them): `[data-slot]` on grid cells, `.cell.available` / `.cell.ifNeedBe` / `.cell.hatch` / `.cell.group`, `.grid.readonly`, `.name input`, `button.save`, `button.show-results`, `.responders`, `form[action$="/finalize"]`, `a.ics[href$="/ics"]`, `#poll-data` JSON script, "Keep this link" copy, `<code>` element containing the DID on the landing page when signed in, `form.create button[type=submit]`.
- **New DOM contracts introduced by this plan:** calendar day buttons carry `data-date="YYYY-MM-DD"`; calendar month-nav next button matches `button.cal-next`; selected-dates chips live under `.date-chips`; static assets are served at `/assets/grid.js`, `/assets/createForm.js`, `/assets/app.css`.
- Tailwind builds via `@tailwindcss/cli` to a static file — no CDN, no runtime compilation. shadcn tokens define light AND dark palettes (`prefers-color-scheme`); every page must be legible in both.
- No new routes, no route removals. Files outside `src/web/`, `public/`, `package.json`, `tsconfig.json`, `playwright.config.ts`, `e2e/`, `tests/web/`, `docs/` are off-limits.
- Every task ends with `npm run typecheck && npm test` green; Tasks 4–6 also run `npx playwright test` green.
- Commit trailers (every commit):
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Q1HQ6QBYCyjYRUdedoyfDz
  ```

## File Structure (end state)

```
src/web/
  render.tsx            renderPage(): renderToString + doctype shell   (Task 3)
  scriptJson.ts         scriptJson() moved out of views.ts, unchanged  (Task 3)
  styles/app.css        Tailwind v4 entry + shadcn tokens + grid CSS   (Tasks 1,2,5)
  lib/cn.ts             cn() = twMerge(clsx(...))                      (Task 2)
  ui/                   vendored shadcn: button input label select
                        card badge calendar                            (Task 2)
  pages/                Layout, Landing, Login, NewPoll, Poll,
                        Decided, Tombstone (.tsx, server-rendered)     (Tasks 3,4,5)
  islands/createForm.tsx  calendar/timezone island (React)             (Task 4)
  islands/grid.tsx        grid island ported from Preact               (Task 5)
  static/grid.tsx         DELETED in Task 5 (pragma-pinned until then)
  views.ts                DELETED in Task 6
public/assets/          grid.js createForm.js app.css (built, gitignored)
```

---

### Task 1: Toolchain — React, Tailwind build, asset serving

**Files:**
- Modify: `package.json` (deps + scripts), `tsconfig.json`, `playwright.config.ts`, `src/web/server.ts`, `src/web/static/grid.tsx` (pragma only), `.gitignore`
- Create: `src/web/styles/app.css`

**Interfaces:**
- Produces: `npm run build:client` (all later tasks' build step); `/assets/*` static route; React JSX as the tsconfig default.

- [ ] **Step 1: Install dependencies**

```bash
npm i react react-dom
npm i -D @types/react @types/react-dom tailwindcss @tailwindcss/cli
```

(Preact stays installed until Task 6.)

- [ ] **Step 2: Switch default JSX to React, pin the old grid to Preact**

In `tsconfig.json`: `"jsxImportSource": "react"`. At the very top of `src/web/static/grid.tsx` add:

```tsx
/** @jsxImportSource preact */
```

- [ ] **Step 3: Create the Tailwind entry**

`src/web/styles/app.css`:

```css
@import "tailwindcss";
/* shadcn tokens land here in Task 2; grid CSS moves here in Task 5 */
```

- [ ] **Step 4: Replace the build script**

In `package.json` scripts, replace `build:grid` with three explicit scripts (no `||` fallbacks — a failed build must fail loudly):

```json
"build:grid": "esbuild src/web/static/grid.tsx --bundle --minify --format=esm --jsx=automatic --jsx-import-source=preact --outfile=public/assets/grid.js",
"build:css": "tailwindcss -i src/web/styles/app.css -o public/assets/app.css --minify",
"build:client": "npm run build:grid && npm run build:css"
```

(Task 4 adds `build:createform` and chains it into `build:client`; Task 5 flips `build:grid`'s flags to react and its entry to `src/web/islands/grid.tsx`.) Update `playwright.config.ts` webServer command from `npm run build:grid && …` to `npm run build:client && …`. Add `public/assets/` to `.gitignore` and remove the stale committed `public/grid.js` (`git rm public/grid.js`).

- [ ] **Step 5: Serve `/assets/*` and keep `/grid.js` until Task 5**

In `src/web/server.ts` replace the `/grid.js` line with:

```ts
app.use('/assets/*', serveStatic({ root: './public' }));
```

Then check `src/web/views.ts` for `<script type="module" src="/grid.js">` and change it to `/assets/grid.js`.

- [ ] **Step 6: Verify**

Run: `npm run build:client && npm run typecheck && npm test`
Expected: builds produce `public/assets/grid.js` + `app.css`; typecheck and all 126 tests pass.

- [ ] **Step 7: Commit** — `build: react jsx default, tailwind v4 pipeline, /assets serving`

---

### Task 2: Vendored shadcn/ui kit + design tokens

**Files:**
- Create: `src/web/lib/cn.ts`, `src/web/ui/button.tsx`, `ui/input.tsx`, `ui/label.tsx`, `ui/select.tsx`, `ui/card.tsx`, `ui/badge.tsx`, `ui/calendar.tsx`
- Modify: `src/web/styles/app.css`, `package.json`
- Test: `tests/web/ui.test.tsx`

**Interfaces:**
- Produces: `cn(...inputs: ClassValue[]): string`; shadcn components with their standard shadcn v4 props (`Button` with `variant`/`size`/`asChild`, `Input`, `Label`, `Select` + `SelectTrigger/SelectValue/SelectContent/SelectItem`, `Card` + `CardHeader/CardTitle/CardContent/CardFooter`, `Badge` with `variant`, `Calendar` wrapping react-day-picker v9). Later tasks import these; keep the canonical shadcn export names.
- `Calendar` additionally guarantees: every day button renders `data-date="YYYY-MM-DD"` (ISO, in the calendar's display month) and the next-month nav button has class `cal-next`. Implement via react-day-picker v9 `components={{ DayButton }}` override that spreads props onto a `<button>` and adds `data-date={props.day.date.toISOString().slice(0,10)}` — compute the ISO from the day's local year/month/day parts, NOT `toISOString()` (UTC off-by-one), i.e. `` `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}` ``.

- [ ] **Step 1: Install component deps**

```bash
npm i class-variance-authority clsx tailwind-merge lucide-react react-day-picker @radix-ui/react-select @radix-ui/react-label @radix-ui/react-slot
```

- [ ] **Step 2: `cn` util**

```ts
// src/web/lib/cn.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Tokens in `app.css`**

Use the standard shadcn Tailwind-v4 token block (`:root` light palette, `@media (prefers-color-scheme: dark)` dark palette, `@theme inline` mapping `--color-background: var(--background)` etc.). Palette: keep the app's existing green identity — set `--primary` to the current `#2b8a5f` family (oklch equivalent), neutral stone greys, radius `0.5rem`. Include react-day-picker's required styles (import `react-day-picker/style.css` into the calendar island is NOT possible server-side — instead copy rdp v9's class hooks into `app.css` the way shadcn's calendar does, styling via the shadcn calendar's own classNames prop; rely on the shadcn v4 calendar component which styles entirely through Tailwind classes and needs no rdp stylesheet).

- [ ] **Step 4: Vendor the components**

Write each component following the shadcn/ui "new-york" v4 source (the implementer writes these from the canonical shadcn source structure: cva variants for button/badge, Radix wrappers for select/label, plain styled elements for input/card). Every import uses relative paths (`../lib/cn.js`) — **no `@/` path aliases** (NodeNext resolution, ESM `.js` suffixes as the rest of the repo does).

- [ ] **Step 5: SSR smoke test**

```tsx
// tests/web/ui.test.tsx
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { Button } from '../../src/web/ui/button.js';
import { Badge } from '../../src/web/ui/badge.js';
import { Calendar } from '../../src/web/ui/calendar.js';

describe('ui kit', () => {
  it('renders Button/Badge server-side', () => {
    const html = renderToString(<Button variant="outline">Create poll</Button>);
    expect(html).toContain('Create poll');
    expect(renderToString(<Badge>3 replies</Badge>)).toContain('3 replies');
  });
  it('calendar day buttons expose data-date and nav exposes cal-next', () => {
    const html = renderToString(
      <Calendar mode="multiple" selected={[]} defaultMonth={new Date(2026, 8, 1)} />,
    );
    expect(html).toContain('data-date="2026-09-15"');
    expect(html).toContain('cal-next');
  });
});
```

- [ ] **Step 6: Run** `npm run build:css && npm run typecheck && npm test` — all green (129 tests).

- [ ] **Step 7: Commit** — `feat: vendored shadcn ui kit + design tokens`

---

### Task 3: SSR shell + static pages (landing, login, decided, tombstone)

**Files:**
- Create: `src/web/render.tsx`, `src/web/scriptJson.ts`, `src/web/pages/Layout.tsx`, `pages/Landing.tsx`, `pages/Login.tsx`, `pages/Decided.tsx`, `pages/Tombstone.tsx`
- Modify: `src/web/routes/polls.ts` (landing/decided/tombstone call sites), `src/web/routes/auth.ts` (GET /login + callback-failure page), `src/web/views.ts` (delete migrated exports; `scriptJson` moves out)
- Test: `tests/web/server.test.ts`, `tests/web/views.test.ts` (wherever the `scriptJson` regression test lives — move it to target `src/web/scriptJson.ts`, assertions unchanged)

**Interfaces:**
- Produces: `renderPage(node: ReactElement): Response`-compatible string:

```tsx
// src/web/render.tsx
import type { ReactElement } from 'react';
import { renderToString } from 'react-dom/server';

/** Full-document render; every route returns c.html(renderPage(<Page …/>)). */
export function renderPage(node: ReactElement): string {
  return '<!doctype html>' + renderToString(node);
}
```

- `Layout` props: `{ title: string; children: ReactNode; scripts?: string[] }` — renders `<html lang="en">`, `<head>` (charset, viewport, `<title>`, `<link rel="stylesheet" href="/assets/app.css">`), header with the `letsmeet` brand link, `<main>{children}</main>`, then a `<script type="module" src=…>` per entry in `scripts`.
- `scriptJson(value: unknown): string` moves verbatim to `src/web/scriptJson.ts` including its comment block; `views.ts` re-exports it until Task 5 so the old poll page keeps compiling.
- Consumes: Task 2 components (`Button`, `Card`, `Input`, `Label`).

- [ ] **Step 1: Write failing markup tests** — update `tests/web/server.test.ts` landing-page test to also assert `/assets/app.css` is linked and the signed-in landing still wraps the DID in `<code>`; add a `GET /login` test asserting a `form[action="/login"]`… wait — assert via string: `action="/login"` and `name="handle"` present. Run; the new assertions fail against old markup.

- [ ] **Step 2: Implement** Layout/renderPage/scriptJson move + the four pages, porting content faithfully: Landing (signed-out: hero + sign-in link + "how it works" copy; signed-in: `<code>{did}</code>`, create-poll button, logout form — exactly the links/forms the current `landingPage` emits, restyled with Card/Button); Login (the handle form, plus when a `?error=1`-free flow fails the POST handler's existing sanitized error strings render above the form — keep the POST handler's response *strings* by rendering them through the Login page; the two existing auth tests asserting no leakage must pass unchanged); Decided and Tombstone (same copy incl. "Back to letsmeet", `a.ics[href$="/ics"]` on Decided if present today — check current `decidedPage` and keep its links).

- [ ] **Step 3: Wire routes** — `c.html(renderPage(<Landing …/>))` etc. Auth route line 62's inline callback-failure `<p>` becomes the Tombstone-style minimal page or stays an inline string — keep behavior: status 400, contains "Try again" link.

- [ ] **Step 4: Run** `npm run typecheck && npm test` — green.

- [ ] **Step 5: Commit** — `feat: react ssr shell; landing/login/decided/tombstone pages`

---

### Task 4: Create-form page + calendar island

**Files:**
- Create: `src/web/pages/NewPoll.tsx`, `src/web/islands/createForm.tsx`
- Modify: `src/web/routes/polls.ts` (GET `/new` call site), `package.json` (`build:createform` chained into `build:client`), `src/web/views.ts` (delete `createFormPage`)
- Test: `tests/web/server.test.ts` (new-form markup contract), `e2e/poll.spec.ts` (createPoll helper)

**Interfaces:**
- Consumes: `Calendar` (mode="multiple"), `Input`, `Label`, `Select`, `Button`, `Badge`, `renderPage`, `Layout`.
- Produces: the create form DOM contract — all frozen field names present; `#create-dates` hidden-by-default `<div>` island mount; the fallback `<label class="dates-fallback">` containing the original `dates` text input (`required` attribute present server-side); `input[type=time]` for both window fields; timezone `Input` with server-rendered `value="UTC"`; `<script type="module" src="/assets/createForm.js">` emitted via Layout `scripts`.

- [ ] **Step 1: Failing tests** — in `tests/web/server.test.ts` assert GET `/new` (signed in via the tests' session helper) contains: `name="dates"`, `class="dates-fallback"`, `id="create-dates"`, `type="time"` twice, `name="timezone"`, `/assets/createForm.js`. Run: fails (old form).

- [ ] **Step 2: NewPoll page** — shadcn Card containing the form; every current field, `slotMinutes` as a **native** `<select name="slotMinutes">` styled with the select trigger classes (the Radix `Select` doesn't submit a form value without a hidden input — a native select keeps the form contract with zero JS; style it, don't Radix it). Time inputs `<Input type="time" name="windowStart" required />` etc. Fallback hint under the dates input stays ("Comma-separated ISO dates — or use the picker.").

- [ ] **Step 3: Island** — `src/web/islands/createForm.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// DatesPicker component in the same file

const mount = document.getElementById('create-dates');
const fallback = document.querySelector<HTMLElement>('.dates-fallback');
const datesInput = document.querySelector<HTMLInputElement>('input[name="dates"]');
const form = datesInput?.closest('form');
if (mount && fallback && datesInput && form) {
  fallback.hidden = true;            // input stays in the DOM and submits
  datesInput.required = false;       // a display:none required input blocks submit unfocusably
  createRoot(mount).render(<StrictMode><DatesPicker input={datesInput} form={form} /></StrictMode>);
}
const tz = document.querySelector<HTMLInputElement>('input[name="timezone"]');
if (tz && tz.value === 'UTC') {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (local) tz.value = local;
}
```

`DatesPicker` behavior: `useState<Set<string>>` seeded from `input.value`; renders `Calendar mode="multiple"` (selected = the set as `Date`s, `onSelect` recomputes the set), writes the sorted comma-joined ISO list back into `input.value` on every change; renders chips (`.date-chips`, one `Badge` per date with an × button that removes it); on `form` submit with an empty set, `preventDefault()` and show "Pick at least one date." in a `[role=alert]` element. Date↔ISO conversion uses local-time parts both directions (never `toISOString`).

- [ ] **Step 4: Build script** — add `"build:createform": "esbuild src/web/islands/createForm.tsx --bundle --minify --format=esm --jsx=automatic --jsx-import-source=react --outfile=public/assets/createForm.js"`, chain into `build:client`.

- [ ] **Step 5: e2e helper** — rewrite `createPoll` in `e2e/poll.spec.ts`:

```ts
async function pickDate(page: Page, iso: string): Promise<void> {
  for (let hop = 0; hop < 12; hop++) {
    const day = page.locator(`button[data-date="${iso}"]`);
    if (await day.count()) { await day.click(); return; }
    await page.click('button.cal-next');
  }
  throw new Error(`date ${iso} not reachable in calendar`);
}
```

and in the helper replace `page.fill('input[name=dates]', …)` with `for (const d of fields.dates.split(',')) await pickDate(page, d);` — everything else (time fills, slot select, timezone fill to `'UTC'`, submit) stays. Note `slotMinutes` stays a native select so `selectOption` still works.

- [ ] **Step 6: Run** `npm run build:client && npm run typecheck && npm test && npx playwright test` — all green.

- [ ] **Step 7: Commit** — `feat: shadcn create form with multi-date calendar + local tz default`

---

### Task 5: Poll page + grid island port (Preact → React)

**Files:**
- Create: `src/web/pages/Poll.tsx`, `src/web/islands/grid.tsx`
- Delete: `src/web/static/grid.tsx`, remaining page functions in `src/web/views.ts` (file deleted in Task 6 if anything still imports types from it — move `PollPageData` to `pages/Poll.tsx` and update importers)
- Modify: `src/web/routes/polls.ts` (poll-page call site), `package.json` (`build:grid` now `esbuild src/web/islands/grid.tsx … --jsx-import-source=react --outfile=public/assets/grid.js`)
- Test: `tests/web/server.test.ts` poll-page assertions (keep: title, `#poll-data`, `/assets/grid.js`, `.responders`, finalize form for hosts, pending-sync banner contract)

**Interfaces:**
- Consumes: `renderPage`, `Layout`, `scriptJson`, Task 2 components for the page chrome (Cards for results/responders, Buttons for finalize).
- Produces: `Poll.tsx` renders everything `views.ts pollPage` renders today — same data in, same links/forms/banners out, same `#poll-data` embedded JSON shape (the island's `PollData` interface is unchanged). The island keeps its full behavior: pointer painting, three paint states, zone toggle, Me/Group views, edit-token handling, fresh-edit-token reload suppression, `button.show-results`.

- [ ] **Step 1: Port the island** — copy `src/web/static/grid.tsx` to `src/web/islands/grid.tsx`; remove the Preact pragma; imports become `react` / `react-dom/client` / `react` hooks; `render(<App/>, el)` becomes `createRoot(el).render(<App/>)`; Preact-specific types (`JSX.TargetedEvent` etc.) become React equivalents (`React.PointerEvent`). **No logic changes** — `gridModel.ts` imports and all handlers stay line-for-line where React allows. Keep every class name and `data-slot` attribute byte-identical.
- [ ] **Step 2: Grid CSS** — move the grid/cell rules from the old `STYLE` constant into `app.css` under `@layer components`, unchanged selectors; delete only rules for markup that no longer exists after the page ports.
- [ ] **Step 3: Poll page** — port `pollPage` to `pages/Poll.tsx` (host view: results ranking, responders list `.responders`, finalize forms, close/reopen if present — mirror the current file exactly; guest view: grid mount + name field + save). Wire the route; delete `pollPage`/`createFormPage` leftovers from `views.ts`; `views.ts` may now be empty enough to delete — if `decidedPage` consumers or types remain, migrate them and delete the file here rather than Task 6.
- [ ] **Step 4: Flip `build:grid`** flags/entry as above; delete `src/web/static/grid.tsx`.
- [ ] **Step 5: Run** `npm run build:client && npm run typecheck && npm test && npx playwright test` — the full e2e suite (both flows) must pass with **no changes to the e2e file beyond Task 4's helper**; that is the proof the port preserved behavior.
- [ ] **Step 6: Commit** — `feat: react poll page + grid island; retire preact grid`

---

### Task 6: Remove Preact, docs, final polish

**Files:**
- Modify: `package.json` (remove `preact`; remove `build:grid`/`build:createform` indirection if now trivial — keep `build:client` as the one public name), `docs/deploy.md` (build command references, systemd `ExecStartPre`/runbook lines mentioning `build:grid`, static-assets note), `.gitignore` sanity
- Delete: `src/web/views.ts` if it still exists, any orphaned helpers/styles

**Interfaces:** none new — this task removes.

- [ ] **Step 1:** `npm rm preact` and grep the repo for `preact` / `views.js` / `build:grid` (docs included) — zero hits outside this plan file and historical docs (`docs/superpowers/plans/2026-08-31-*` stays untouched).
- [ ] **Step 2:** Update `docs/deploy.md`: `npm run build:client` in the deploy runbook, `/assets/` note in the Caddy section (Caddy config itself needs no change — Node serves assets), mention `public/assets/` is build output and gitignored.
- [ ] **Step 3:** Full verification: `npm run build:client && npm run typecheck && npm test && npx playwright test`.
- [ ] **Step 4: Commit** — `chore: drop preact; update deploy docs for build:client`
