# letsmeet — Standing Availability Design Spec

**Date:** 2026-09-16
**Status:** Approved design, pre-implementation
**What:** One record per account in the user's PDS that says when they are generally around: a marked usual week plus dated "away" entries. Read by friends at a public URL, subscribed to as an ICS feed, and used to pre-mark a signed-in user's answer when they open a poll. This is the "reusable availability profile" the v1 spec deferred to v1.1.

## Product thesis

Two stories, one record:

1. **"Want to hang out? Look at my availability."** A friend opens `letsmeet.lol/u/<handle>` and sees, in words and a two-week strip, when you are usually free and when you are away. No account needed to read it. They can subscribe to `letsmeet.lol/u/<handle>/availability.ics` from iCloud or Google Calendar and it stays in sync.
2. **"Sign in and the poll is already marked."** When a signed-in user opens a poll they have not answered, the grid is pre-marked from their record. They fix the odd slot and save. The host only ever sees the response.

Manual entry only. No calendar sync in, ever, for this record: the whole point is a coarse, hand-maintained, honest "this is my week". Staleness is a first-class state, not an error.

## Decisions settled during brainstorming

| Decision | Choice |
|---|---|
| Ecosystem | No established availability lexicon exists (surveyed 2026-09-16: `chat.avails.scheduling.availability`, `app.convene.availability`, `app.studyplan.freeslot`, all single-app, unpublished schemas, ≤6 users). Define our own under `lol.letsmeet.*`. Events stay on `community.lexicon.calendar.event`. |
| Unit of availability | Half-hour blocks in local wall-clock time, per weekday. The when2meet grid stays the primary way to mark them. No dayparts, no sentence-first editing. |
| Exceptions | **Away only.** Dated ranges that subtract from the usual week, all-day or narrowed to a time window. No "extra free" kind: it is additive, rare, and the poll grid already covers it. |
| Middle state | None. No `ifNeedBe` on the standing record. "Usually free" is already soft. |
| Record cardinality | One record per account, rkey `self`. Overwritten in place with `putRecord`. |
| Staleness | Optional `validUntil`. Readers (friend view, prefill) treat an expired record as *unknown*, not empty: the friend view says so, prefill does nothing. |
| Vocabulary | User-facing copy says **mark** (as the poll grid does: "tap a slot to mark it. hold, then drag, for a block."). Code may say paint internally, matching `gridModel`. Lowercase copy, matching the site. |
| Storage | The record is the truth. The app keeps a disposable `availability_cache` row per DID with the same revalidate-in-background pattern as `poll_cache`. |
| Privacy | The record is public repo content, like every other letsmeet record. The editor says so once, above the save button. `note` is where "text me first" lives. |

## Lexicon

Authority `letsmeet.lol`; the DNS TXT record `_lexicon.letsmeet.lol` already points at the authority DID, so this NSID needs no DNS work. Published by `scripts/publishLexicons.ts` alongside the poll lexicons.

### `lol.letsmeet.availability` — owner's repo, rkey = `self` (`key: "literal:self"`)

```
timezone    string ≤64, IANA, required — every HH:MM below is wall-clock in this zone
weekly      [#block], maxLength 112, required (may be empty)
              day     integer 0–6, Sunday = 0
              start   "HH:MM", ≤5
              end     "HH:MM", ≤5 — end ≤ start means the block runs past midnight
away        [#away], maxLength 100, required (may be empty)
              start      "YYYY-MM-DD", ≤10, inclusive
              end        "YYYY-MM-DD", ≤10, inclusive, ≥ start
              startTime  "HH:MM", optional — with endTime, narrows each day in the range to a window
              endTime    "HH:MM", optional — required iff startTime is present
              note       string ≤80 graphemes / ≤320 bytes, optional ("out of town")
note        string ≤300 graphemes / ≤1200 bytes, optional — shown to friends
validUntil  datetime, optional — after this the record reads as unknown
updatedAt   datetime, required
```

Conventions carried over from the poll lexicons: `HH:MM` strings with `maxLength: 5`, IANA timezone `maxLength: 64`, text fields pair `maxGraphemes` with `maxLength`, times materialize to UTC per date with luxon so DST is per-date arithmetic.

**App-enforced rules the lexicon cannot express** (validated in `src/core/availability.ts` on every write, mirroring `snapPaint`):

- Weekly block edges snap to `:00` / `:30`; touching or overlapping blocks on the same day merge; `start ≠ end`.
- `away` entries: `end ≥ start`; both dates parse in `timezone`; `startTime`/`endTime` present together, half-hour aligned, `startTime < endTime`.
- Arrays are sorted (weekly by day then start; away by start) so identical availability produces byte-identical records and a no-op save writes nothing (the "stop churning records" rule from f8294bc).

## Core semantics (`src/core/availability.ts`, pure, fully tested)

- `normalizeAvailability(input): AvailabilityRecord` — snap, merge, sort, validate; throws `UserError` with a person-readable message.
- `freeIntervals(rec, from: ISO date, to: ISO date): Interval[]` — materializes weekly blocks for each date in `[from, to]` in `rec.timezone` to UTC intervals (same per-date luxon approach as `materializeSlots`, including the past-midnight rule), then subtracts `away` (all-day entries remove the whole local day; timed entries remove that window on each day). Result merged.
- `prefillFromAvailability(rec, slots: Interval[], now): Interval[] | null` — `null` when `validUntil` has passed (unknown, do nothing). Otherwise the poll's materialized slots that are fully covered by `freeIntervals` over the poll's date span, merged. Reuses `snapToSlots`.
- `describeWeekly(rec): string` — the read-back sentence: "usually free tuesdays and thursdays 7pm to 10pm, and weekends 1pm to 5pm." Groups days by identical range; Mon–Fri collapses to "weekdays", Sat+Sun to "weekends". Used by the editor island (live) and the friend view (server).
- `isStale(rec, now): boolean`.

## Flows

**Edit (`GET /availability`, signed-in; redirects to `/login?returnTo=%2Favailability`).** Server reads the viewer's own record live (`reader.getRecord(did, NSID, 'self')`, no cache: it is one small read of your own repo), renders the editor page with the record as `#availability-data` JSON, and mounts the island into `#availability-root`.

**Save (`POST /availability`, JSON, signed-in).** Body is the record minus `$type`/`updatedAt`. Server normalizes, builds and lexicon-validates the record, compares with the live record ignoring `updatedAt`, and `putRecord`s to rkey `self` only if different. Updates `availability_cache`. Per-DID token bucket, same class as `respond-auth`.

**Friend view (`GET /u/:handle`, public).** Resolve handle → DID (`com.atproto.identity.resolveHandle` against the public API; in `FAKE_PDS` mode a `did:` literal is accepted as the handle). Read through `availability_cache` with `freshnessFor` revalidation. Render: handle, the sentence, upcoming `away` entries, a 14-day strip, the `note`, and a staleness line ("updated 3 days ago · good through dec 31" or "expired dec 31. treat as unknown and ask."). No record → "no availability posted." Per-IP token bucket.

**Feed (`GET /u/:handle/availability.ics`, public).** Same read path. `buildAvailabilityIcs` in `src/core/ics.ts`: one `VEVENT` per weekly block with `DTSTART;TZID=<zone>` and `RRULE:FREQ=WEEKLY;BYDAY=…` (`UNTIL` from `validUntil` when set), `SUMMARY:usually free`, `TRANSP:TRANSPARENT`; one `VEVENT` per away entry, all-day (`VALUE=DATE`, exclusive end) or timed with `RRULE:FREQ=DAILY;UNTIL` across multi-day ranges, `SUMMARY:away · <note>`, `TRANSP:OPAQUE`. Text escaped and lines folded with the existing `esc`/`foldLine`. `Content-Type: text/calendar`, `Cache-Control: public, max-age=900`. The decided-poll card's `webcal:` construction is reused for the link on the editor page.

**Poll prefill.** In `renderPoll`, when the viewer is signed in, has no response to this poll, and the poll is active: load their availability through the cache, compute `prefillFromAvailability`, and pass it as `prefill` with a new `prefillSource: 'availability'` flag. The island treats an availability prefill as *unsaved* (so `canSave` is true immediately and the cells draw as the viewer's own marks) and shows one line above the grid: "marked from your availability. fix what's off, then save." A viewer with no record, an expired record, or a prefill that covers zero slots sees the grid as today.

**Host alias (optional, last).** `https://<handle>.sez.letsmeet.lol` serves the same friend view and, at `/availability.ics`, the same feed. The handle is every label before `.sez.letsmeet.lol`, verbatim (`ken.wzrdz.cool.sez.letsmeet.lol`), so the mapping is lossless and needs no encoding; underscores and hyphen-encoding are rejected because certificates cannot be issued for the former and handles already contain the latter. Infra: one wildcard DNS record `*.sez.letsmeet.lol` (DNS wildcards match multiple labels) and **Caddy on-demand TLS** in front of the app for that host, since wildcard certificates cover a single label. The app exposes `GET /internal/tls-ask?domain=` (loopback only) that answers 200 only when the handle resolves, so Caddy never requests a certificate for junk. The canonical URL stays `/u/<handle>`; the alias issues no redirects and sets `<link rel="canonical">`. Sessions never cross: the editor lives on `letsmeet.lol` only.

**Landing.** Signed-in landing gets a third block, "your availability", with the sentence (or "nothing marked yet") and links to edit and to your public page.

## Editor island (`src/web/islands/availability.tsx`)

Reuse the poll grid's model rather than writing a second one. Build a **template week**: seven consecutive dates starting on a fixed Sunday (`2026-01-04`) in the record's timezone, one 30-minute slot from 07:00 to 24:00 each day, materialized with `materializeSlots`. `buildGeom`, `strokeOp`, `rectKeys`, `applyPaint`, `paintToIntervals` and `intervalsToPaint` then work unchanged, with the pointer handling lifted from `grid.tsx`. Weekly blocks ↔ template-week intervals is a pure two-way conversion in `core/availability.ts`. Single paint mode (`available` only).

Below the grid: the live sentence from `describeWeekly`. Below that: the away list (date range, optional time window, note, remove) and a one-row add form whose button reads "i'm away". Then timezone select, "good through" date, "note for friends", the public-record line, and save. The island posts JSON to `/availability` and shows the same status/error treatment as the poll grid.

## Server state

- `availability_cache(did TEXT PRIMARY KEY, uri, cid, record TEXT, fetched_at INTEGER)` — disposable; rebuilt from any read.
- Nothing else. Handle → DID resolution is cached in memory for an hour like the handle search.

## OAuth scope

Add `repo:lol.letsmeet.availability?action=create&action=update` to `SCOPE` in `src/atproto/oauthClient.ts` (put on a missing rkey is a create). Update `tests/atproto/oauthScope.test.ts` from three `repo:` scopes to four. Existing sessions keep the old scope until next sign-in, as the code already documents; the save route turns a scope error into "sign in again to post your availability".

## Failure handling

- Own-record read fails on the editor page → render the editor empty with a banner "couldn't read your current availability; saving will overwrite it."
- Save fails → JSON error, island shows it, marks stay in the browser.
- Friend view / feed: PDS unreachable and cache empty → 503 with "their PDS isn't answering right now." Cache present → serve it, revalidate later.
- Prefill: any failure degrades to no prefill, logged, never blocks the poll page.

## Abuse limits

- Save: 20 per DID per 10 minutes (same `TokenBucket` shape as `accountLimiter`).
- Public reads (`/u/*`): 120 per IP per 10 minutes; handle resolution cached.

## Testing

- **Core (vitest):** normalization (snap, merge, sort, rejections), `freeIntervals` across a DST transition and a past-midnight block, `away` subtraction all-day and timed, `prefillFromAvailability` against a real poll geometry and an expired record, `describeWeekly` phrasing table.
- **Records:** lexicon validates a full record, rejects a 7th weekday value of 7, rejects `startTime` without `endTime` (app rule, tested at normalize), enforces text limits.
- **ICS:** golden-file test for a record with one weekly block, one all-day away, one timed multi-day away; folding of a long note.
- **Services (FakeRepo):** save creates then updates rkey `self`; identical save writes nothing; prefill uses cache then revalidates; friend view of a DID with no record.
- **Routes:** `/u/:handle` 200/404/503 shapes; feed content-type; `/availability` redirects when signed out.
- **E2E (Playwright, fake PDS):** sign in, mark two blocks, add an away, save; reload shows them and the sentence; open an active poll covering those days and see cells pre-marked and the hint; the public `/u/` page renders the sentence.

## Explicitly out of scope

- Calendar import or sync of any kind.
- "Extra free" exceptions, `ifNeedBe` on the standing record, per-audience scopes.
- A weekly-pattern poll type (`#weeklyPattern`) — still the v1 spec's seam, unrelated to this record.
- Intersecting two people's availability at a URL. Tempting; later.
- Sentence-shaped paths beyond the host alias (`/this/weekend`, `/on/<date>`). That is the eaten.at project's design goal, not letsmeet's.
- Backfilling `events` backlinks on polls finalized before 2026-09-09.

## Known risks (accepted)

- `TZID` without a `VTIMEZONE` component is technically non-conforming ICS; Apple and Google both resolve IANA names. Revisit if a client rejects the feed.
- A record's `timezone` differs from the viewer's: the friend view shows times in the record's zone and says so, the same compromise the poll page makes.
- `weekly` capped at 112 blocks (16 per day) is arbitrary but far above anything a half-hour grid produces after merging.
