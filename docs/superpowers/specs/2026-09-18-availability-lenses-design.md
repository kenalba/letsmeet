# Availability lenses — design

Date: 2026-09-18. Status: approved in chat, from the interactive mock.

Mock (approved 2026-09-18): https://claude.ai/code/artifact/fe1e0dfe-6de4-4f2a-b2fb-ff663f8726c9,
committed beside this file as `2026-09-18-availability-lenses-mock.html`. Where this document
and the mock disagree, the mock's behaviour wins and this document should be corrected.

One round of feedback on the availability editor and friend view, plus a mobile pass. The
create-poll redesign ("creating a poll is giving your own availability") raised in the same
conversation is **not** in this spec; it gets its own.

## Product thesis

**Dates are the mode.** The editor keeps one grid. The usual week has no dates, so anything
marked there is free and repeats weekly. Page forward to a real week and the same grid shows
dates, so anything marked there is away and sticks to the date. No "mark as" toggle, no second
grid, and a dated page is exactly what friends see on `/u/<handle>`.

Everything autosaves. The post button goes.

## Decisions

| Decision | Choice |
|---|---|
| Away by dragging | On a dated page of the editor grid. Paint toggles away for those hours on those dates; a rectangle across days becomes one entry with a time window on each day. A day header tap: if the day has any away (timed or all-day) it clears the day; otherwise it sets all-day. An all-day column is locked: a tap on any of its cells also clears the day. Past days are dimmed and inert. |
| The usual week | Unchanged in meaning; now runs **Monday to Sunday** (was Sunday-first) so columns keep their identity across pages and match the friend view. `TEMPLATE_SUNDAY` becomes a template Monday. |
| Page control | One pager: `‹ usual week ›`. Usual week is page zero; `›` goes to this week, next week, `in 3 weeks`… The label is always two lines (name over date range, or "repeats every week"), so its height never changes. Tapping the label opens a week picker. |
| Week picker | A small popover calendar whose rows are the choice: click a row to show that week. Weeks already over are disabled; today is underlined; days with away carry an orange dot; a "usual week" row sits above the calendar. Month arrows page ahead. |
| Away colour | Solid orange, the site's `--lol` (`--lol-bright` in dark). Replaces the gray hatch on the friend view too, so "orange is away" is true everywhere. The legend follows. |
| Mode signal | No fills. On a dated page the pager label is orange text with an orange border, the arrows follow, and the sticky day-header band gets a 2px orange bottom rule. Usual week is neutral. |
| The deal | On a page change the columns cross-fade left to right, 25ms stagger per column, ~320ms total, and the date numbers drop into the headers. Instant under `prefers-reduced-motion`. |
| Notes | Live **inside the away zone**: a label laid over the entry's own rectangle, clipped to the zone. Orientation and wrapping are chosen per label by the fit rule below, not by column count. Zones under three hours tall carry no label. Headers are number and weekday only; the friend view's `<small>` note under the header goes. |
| Label fit | One pure function, `fitLabel(text, w, h, font)` in `src/core/labelFit.ts`, decides `{ orient: 'h' \| 'v', lines }` from the zone's box and an estimate of the text's length (`chars × font.charWidth`, longest word likewise). Order of preference: horizontal on one line; vertical on one line; horizontal wrapped (needs every word to fit the width and `lines × lineHeight` to fit the height); vertical wrapped (columns of text, same test with the axes swapped); otherwise truncate with an ellipsis along the longer axis. The editor measures real boxes; the friend view ships a tiny nonce-tagged script that runs the same function after layout and, without JavaScript, falls back to vertical for one-column zones and horizontal otherwise. |
| Adding a note | Marking away drops a **chip** under the marked cells: "away sat 19 11am–3pm" and a note field with an "add" button. Enter or "add" saves; Escape, a click or tap outside the chip, or the next mark dismisses — a phone has no Escape, so the outside tap is the free way out there. Focus goes to the field on mouse; on touch the chip waits for a tap so the keyboard does not jump. One hour tapped with a finger offers no chip at all: it would hang over the next two rows of a column being tapped down, and the list's "+ note" is the way into that note instead. Touch drags and header taps still offer one. |
| The away form | Removed. The list under the grid is the record: each entry is a link that jumps the grid to its week, its note is editable inline ("+ note" when empty), and it has remove. Away windows before 7am or after 11pm can no longer be entered; accepted. |
| Autosave | Every change posts about two seconds after the last one: grid strokes on pointer-up, header taps, chip and list notes, remove, timezone, good-through, note for friends, sez name. Text fields also post on blur. Never mid-stroke. The server's identical-write skip stays, so a no-op edit writes nothing. |
| Status | A sticky bottom line replaces the save bar: `posted.` / `not posted yet · posting in 2s` / `posting…` / the error with a `retry` link. No post button. |
| Save limit | 20 per DID per 10 minutes becomes 90, so autosave cannot trip it. |
| Owner edit | The friend view's `this is you · edit` text becomes a pixel button, `> edit`, right-aligned in the heading row, on `/u/<handle>` and the alias host. |
| Old cookies | Sessions minted before the domain cookie (2026-09-17) are host-only and never reach `<name>.sez.letsmeet.lol`, so their owners see no edit button. On the next apex request such a session is re-issued with `Domain` and marked, so nobody has to sign in again. |
| Feed actions | The links row becomes a row of three matching pixel buttons, left-aligned as a group: `> download .ics`, `> subscribe`, `> copy link`. The first two stay anchors (`href` to the `.ics` and the `webcal:` address) styled with `.btn-pixel`; the third is a real `<button>`. Same on both pages; the editor keeps its "friends can see this at <address>" line above the row. No `·` separators. Fits one line at phone width. |
| Reach-out caption | The friend view's line under the grid reads `click a free hour to ping on bluesky.` (was "to post at them", which sat oddly above a first-person note). The post text itself is unchanged. |
| Mobile | At phone width every card on the editor and friend view bleeds to the screen edges (no side borders or padding; text keeps a 16px inset); day headers are sticky on the editor and friend-view grids; the poll grid keeps its horizontal scroller and no sticky header; timezone and good-through share a row with the note full width. |

## Where it lives

### Core (`src/core/`, pure, tested)

- `availability.ts`: `TEMPLATE_SUNDAY` → `TEMPLATE_MONDAY` (`2026-01-05`), template dates Monday-first; `weeklyToTemplateIntervals` / `templateIntervalsToWeekly` follow. `describeWeekly` unchanged.
- New `awayDays.ts`: the day-map the dated page edits.
  - `type DayAway = 'all' | Set<string>` (half-hour `HH:MM` starts).
  - `expandAway(entries, from, to): Map<date, { away: DayAway, note: string }>` for dates in `[from, to]`.
  - `compactAway(entries, from, to, days): AwayEntry[]` — replaces the entries' coverage of `[from, to]` with `days` and returns the full list, merging consecutive dates with identical windows and note into ranges, windows from runs of half-hours, sorted, normalized through `normalizeAvailability`'s rules. Dates outside `[from, to]` are untouched, including the parts of a range that straddle the edge (a range `oct 3 – 10` edited on the week of oct 5 splits cleanly).
  - `toggleAllDay(days, date, note?)`, `paintAway(days, dates, halfHours, on)`: pure helpers the island calls.
- `weekView.ts`: `weekNoteZones(record, week)` → `[{ c0, c1, h0, h1, note, past }]`, one per (entry, window) rectangle in the shown week, clipped to 7am–11pm, for both pages' labels.
- New `labelFit.ts`: `fitLabel(text, w, h, font = { charWidth: 6, lineHeight: 14, pad: 5 })`. `main` is the axis the text runs along (`w` for horizontal, `h` for vertical), `cross` the other. A layout fits when the longest word's width `≤ main − 2·pad` and `ceil(textWidth / (main − 2·pad)) × lineHeight ≤ cross − 2·pad`. Returns the first that fits in the order: `h` one line, `v` one line, `h` wrapped, `v` wrapped; else `{ orient: h > w ? 'v' : 'h', lines: 1, truncate: true }`. CSS: `.zlabel.h` wraps with `overflow-wrap: normal`; `.zlabel.v` uses `writing-mode: vertical-rl`; `.zlabel.one` adds `white-space: nowrap; text-overflow: ellipsis`. The island calls it with each label's measured box; the friend view's inline script (`src/web/pages/zoneLabels.ts`, exported as `ZONE_LABEL_SCRIPT`, built from the same source so the rule cannot drift) does the same after layout and on resize.

### Editor island (`src/web/islands/availability.tsx`)

- State gains `page: 'usual' | number` (week offset from this Monday, in the record's zone) and `pickerOpen`.
- Slots/geometry for a dated page come from `materializeSlots` over that week's seven dates, same 7am–midnight window as the template; hour rows via `hourRows`. Cells draw the usual week's free (`free`/`early`/`late`) with away on top, past days dimmed and inert.
- Painting on a dated page edits the day-map for the seven shown dates and writes back through `compactAway`; the stroke op is decided by the anchor cell as today. A column that is all-day is locked: any tap on it or its header clears the day. Header tap on a non-away day sets all-day.
- The chip (`.note-chip`) is positioned under the stroke's bottom-most cell inside `.gridwrap`; the list's inline note editor reuses the same save path.
- Zone labels are absolutely positioned inside `.grid` (which becomes `position: relative`) from cell rects; re-placed after every paint, page change (after the deal lands), resize, and page/width change.
- The pager and week picker are plain React; the picker computes rows from Monday-of arithmetic in the record's zone. The picker's "usual week" row and disabled past rows are buttons; Escape and outside click close it.
- Autosave: a 2s debounce over the whole record (`snapshot()` as today); a stroke in progress defers it; text fields flush on blur. One in-flight post at a time; a change during a post schedules another. Errors show in the status line with `retry`.
- The `postedAway` / "not posted yet" tags from 2026-09-17 go; the status line carries that state now.

### Friend view (`src/web/pages/PublicAvailability.tsx`, `src/core/weekView.ts`)

- Away cells solid orange; legend follows; `<small>` under headers removed; zone labels from `weekNoteZones` rendered server-side as grid items of `.week`: every cell and label gets an explicit `grid-row` / `grid-column` (so a label spanning a zone overlaps the cells without displacing auto-placed ones), labels sit above cells with `z-index`, `pointer-events: none`, `overflow: hidden`, and `writing-mode: vertical-rl` when one column wide. No pixel math on the server.
- Heading row: `> edit` pixel button at the right when `own`.
- Feed actions: three `.btn-pixel` controls in a flex row with an 8px gap, `> download .ics` (anchor to the feed), `> subscribe` (anchor to the `webcal:` address), `> copy link` (button, revealed by `COPY_LINK_SCRIPT` as today, "copied." for 1.5s). The editor page uses the same three, under its "friends can see this at <address>" line. Caption under the friend view's grid: `click a free hour to ping on bluesky.`

### Session (`src/web/session.ts`, `src/db/`)

- `web_session` gains `cookie_v INTEGER NOT NULL DEFAULT 0` through the existing `ALTER TABLE` migration list. `startSession` writes `1`. `readSession`, when the row has `0`, `env.domain` is set and the request host equals the public host, re-sets the cookie (host-only clear, then the domain cookie) and updates the row to `1`. The alias host never issues cookies.

### Styles (`src/web/styles/app.css`)

- Pager, picker, chip, zone labels, status line, solid orange away (both grids), sticky `.col-head` / `.week-head` (`position: sticky; top: 0`, card background, z-index above cells), full-bleed cards at `max-width: 480px`, the deal keyframes with the reduced-motion override, details row layout.
- Tokens: `--away` (light `--lol`, dark `--lol-bright`), `--away-ink` (label/text on the page), `--away-label` (text on a solid zone: white in light, near-black in dark).

### Routes

- `POST /availability` unchanged in shape. `saveLimiter` 20 → 90 per 10 minutes.
- `GET /u/:handle` and the alias `/`: unchanged routes; the page reads `own` as today.

## Failure handling

- Autosave failure: status line shows the server's message and `retry`; marks stay in the browser; the next change retries as well. A scope error still says "sign in again to post your availability".
- Cookie re-issue failure (DB write fails): log, serve the page; the next request tries again.
- Zone labels never affect layout (absolutely positioned, `pointer-events: none`); a note that does not fit is clipped, never wrapped outside its zone.

## Testing

- **Core (vitest):** `expandAway`/`compactAway` round-trip on the fixture (timed single day, all-day multi-day with note, later range); painting a rectangle across two days yields one entry with a window; painting over part of a multi-day range splits it; header toggle on a noted day removes the note; edges of a range outside the edited week survive; Monday-first template conversions; `weekNoteZones` for all-day, timed, and a range crossing the week edge.
- **Session:** a row with `cookie_v = 0` gets a `Set-Cookie` with `Domain` on the apex and none on the alias host; a row with `1` gets none.
- **Page (vitest):** friend view renders `> edit` as a button for the owner, the right-aligned copy button, solid-orange legend, a zone label for a noted entry, and no `<small>` under headers; editor page ships no post button.
- **Routes:** `saveLimiter` allows the 21st save in ten minutes.
- **E2E (Playwright, fake PDS):** sign in, mark the usual week, page to this week, drag two hours on a future day, type a note in the chip, wait for `posted.`; reload and see the entry in the list with its note; open the public page and see the orange cells and the label; tap a header for all day and see the column lock. Mobile project: cards are full-bleed and the header stays visible after scrolling the grid.

## Out of scope

- The create-poll redesign (own spec, next).
- Away windows outside 7am–11pm.
- Half-hour painting on dated pages (hour cells, as the editor already draws).
- Any ICS change.
