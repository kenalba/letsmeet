# week view — design

The friend view at `letsmeet.lol/u/<handle>` (and `<name>.sez.letsmeet.lol`) shows one
calendar week as a compact hour grid, replacing the fourteen-bar "next two weeks" strip
from the standing-availability spec (`2026-09-16-standing-availability-design.md`). The
editor's move from half-hour to hour rows is a separate, later branch and is not in this
spec.

Mockup, approved 2026-09-16: https://claude.ai/artifact/HqkF6q1ZaPrvXfmMyYxgnr (three
states). Decisions in this document were taken with Ken in that conversation.

## Why this shape

The strip showed fourteen bars, each "how much of the 7am–midnight day is free", headed by
one-letter day names. It scaled badly, "S S" was unreadable, and the dots gave no real
information: a friend wants to know *which evenings*, not what fraction of Tuesday. The
sentence under it carried the actual detail and was hard to parse.

A week at a time as a grid — days across, hours down, a filled cell for a free hour — is
what a calendar already taught everyone to read. The usual week only says so much further
ahead, so the view goes one week forward and then hands off to a poll.

## What the page shows

Three states, chosen by the `week` query parameter on the same URL. No JavaScript.

| `?week=` | State | Card title | Grid |
|---|---|---|---|
| absent, or anything else | this week | `sep 14 – 20` | the calendar week containing today |
| `next` | next week | `sep 21 – 27` | the following calendar week |
| `later` | further out | `further out` | none: a prompt to make a poll |

- **The week** is Monday to Sunday in the record's timezone; "today" is today in that zone.
- **Columns** are headed by the day number over the three-letter day name (`14` / `mon`).
  Days before today are dimmed. Today's header is underlined. An all-day away entry puts
  its note, or the word `away`, in small type under the header.
- **Rows** are the hours 7am through 11pm (seventeen rows), labelled down the left. A
  block that runs past midnight fills the 11pm row and stops; blocks before 7am are not
  drawn (the sentence still names them).
- **Cells:** free (filled), half-early (top half filled: free `:00`–`:30` only), half-late
  (bottom half), away (striped), or empty. The record stays half-hour aligned; the grid
  only draws it by the hour.
- **Away** is cut out of the grid: an all-day entry strikes the whole column; a timed one
  strikes the hours it overlaps. Away wins over free. A lone `startTime` or `endTime`
  (which the lexicon allows and `freeIntervals` reads as all day) is all day here too.
  When any cell in the shown week is away, a two-item legend (free / away) sits under the
  grid.
- **Navigation** sits beside the title: `← this week` and `next week →`. On this week the
  back link is muted text, not a link. On next week, forward goes to `?week=later`. On
  further out, the only link is `← next week`. The links are query-only relative URLs
  (`?week=next`, `?week=this`), so the same markup works on `/u/<handle>` and on the
  alias host, where only `/` answers.
- **Further out** replaces the grid with: "a usual week only says so much that far
  ahead.", a button `make a poll with <handle>` linking to `<PUBLIC_URL>/new` (absolute,
  because the alias host does not serve `/new`), and a muted line "pick some dates, they
  mark what works." (The mockup's "no sign-in needed for them" is dropped: responders
  sign in to save.)
- **Captions under the grid**, muted, in this order: the sentence from `describeWeekly`
  followed by ` · updated today` / ` · updated 3 days ago` and, when set, ` · good through
  dec 31`; the record's `note`, if any; `away later: oct 3 – 5 · wedding, oct 20 · conference`
  for away entries that start after the Sunday of next week (entries already over are
  dropped; entries touching the two visible weeks appear in the grid and not here); the
  `download .ics` · `subscribe (webcal)` links, unchanged.
- **The header** above the card is unchanged: handle, sez address, `times in <zone>`.
- **Dates in grid chrome are lowercase** (`sep 14 – 20`, `sep 28 – oct 4` across a month
  boundary, `mon`). The existing `good through Dec 31` phrasing elsewhere is untouched.

Unchanged from before: no record → "no availability posted. ask them."; an unreadable
timezone → the "couldn't read this one" card; an expired record (`validUntil` past) →
the "this might be out of date" card with "last they said: <sentence>", the upcoming away
list as it is today, the note and the links, and no grid. The ICS feed is untouched.

## Where it lives

- `src/core/weekView.ts` — pure: which Monday a date belongs to, the week's days and
  their cell states from a record, the title, the "later" entries. Wall-clock arithmetic
  in local minutes (the grid draws wall-clock, so DST never moves a cell).
- `src/web/pages/PublicAvailability.tsx` — renders the states; the strip and the
  non-stale away list go.
- `src/web/routes/availability.ts` — reads `?week=` and passes it to the page, on both
  `/u/:handle` and the alias `/`.
- `src/web/styles/app.css` — the grid's own rules, in the `island` layer beside the
  editor's, on tokens so dark mode follows.

## Testing

- **Core (vitest):** Monday-of for a Wednesday, a Sunday and a Monday; every cell state;
  a past-midnight block; all-day and timed away; a lone `startTime`; past/today flags;
  the title inside and across a month; "later" selection and ordering.
- **Page (vitest, `renderToString` and HTTP):** each state's title, links and grid or
  prompt; the alias host with `?week=next`; the stale card unchanged; the existing
  "renders the sentence, away entries…" test kept passing (its away entry falls inside the
  shown week and appears under the date).
- **E2E:** the existing availability spec's public-page assertions keep passing; one
  added click on `next week →` lands on the next-week title.

## Out of scope

- Hour rows in the editor (next branch).
- Anything beyond next week other than the poll prompt; a `/new` prefilled with the
  host's handle.
- Timed-away notes anywhere but the cell's hover title.
