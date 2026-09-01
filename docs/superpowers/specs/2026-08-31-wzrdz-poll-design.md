# letsmeet — Design Spec

**Date:** 2026-08-31
**Status:** Approved design, pre-implementation
**What:** An availability-grid scheduling app (When2meet archetype, not the Doodle date-option archetype) built on atproto, hosted at `letsmeet.lol`, with lexicons under `lol.letsmeet.poll.*`.

## Product thesis

Three promises on the landing page: no ads, no account wall for participants, no expiry. Differentiators over the incumbent grid tools (When2meet, LettuceMeet, Crab.fit):

1. A real "last mile": finalizing a poll produces ICS/webcal output and a `community.lexicon.calendar.event` record readable by Smoke Signal and other atproto calendar apps.
2. "If need be" as a second paint state, free (Doodle paywalls it at $11/mo).
3. Polls and signed-in responses are atproto records the participants themselves own; the app's database is a disposable index.
4. (v1.1, not v1) A reusable availability profile stored in the user's PDS.

## Core architectural decisions (settled during brainstorming)

| Decision | Choice |
|---|---|
| Archetype | Availability grid, not date-option poll |
| Creator auth | **Hosts must log in with atproto OAuth.** Guests never need an account. |
| Guest storage | Guest responses are written **into the host's PDS repo** by the app, using the host's OAuth session. Host-attested, sign-up-sheet model. |
| Guest privacy | Guest display name + painted grid are public record content. The name input carries "visible publicly" microcopy — the input is the consent moment. |
| Write failures | **Outbox pattern**: guest submissions always succeed instantly into a pending queue in the app DB, flushed to the PDS with retry/backoff. Results merge outbox rows, marked pending. |
| Time model | v1 = specific dates only. The lexicon `time` field is a union so a `#weeklyPattern` variant can be added later without breaking records. |
| Paint encoding | Explicit merged UTC intervals (`[{start, end}]`), self-describing. Not slot bitmasks, not per-slot vote objects. |
| Maybe votes | Yes: optional `ifNeedBe[]` intervals array; second paint state in UI. |
| Deletion | Never delete poll records; `status` transitions only (Smoke Signal orphaned-reference lesson). |

## Lexicons

Namespace authority: `letsmeet.lol`. Publish via DNS TXT `_lexicon.letsmeet.lol` → host DID, plus `com.atproto.lexicon.schema` records in that repo.

### `lol.letsmeet.poll.schedule` — host's repo, rkey = TID

```
title        string, ≤200 chars, required
description  string, optional
time         union, required → #specificDates:
               dates        string[] of ISO dates, explicit list (non-contiguous OK), ≤31 items
               window       { start: "HH:MM", end: "HH:MM" } in the poll's reference timezone
               slotMinutes  10 | 15 | 20 | 30 | 45 | 60 | 90 | 120 (create form default: 30)
               timezone     IANA string — the grid's "home" zone
status       enum: active | closed | finalized | cancelled, required
finalized    { start, end } UTC datetimes, optional — set when status becomes finalized
closesAt     datetime, optional — seam for auto-close later; no v1 UI
createdAt    datetime, required
```

### `lol.letsmeet.poll.response` — respondent's repo; host's repo for guests. rkey = TID

```
subject    strongRef { uri, cid } → the schedule record, required
available  [{ start, end }] UTC, contiguous slots merged, required; array maxLength enforced
ifNeedBe   [{ start, end }], optional; same constraints
guest      { name: string ≤64 }, optional — present only for host-attested guest rows
timezone   IANA string, optional — respondent's zone, for display/interop
note       string ≤300, optional
createdAt  datetime, required
```

Rules:
- One response per identity per poll; app enforces upsert (re-`putRecord` with the same rkey). Guests keyed by edit-secret.
- The presence of `guest` marks attestation; identical shape otherwise, so results rendering has one code path.
- App validates/snaps intervals to the poll's slot granularity on write.
- **Frozen geometry:** title/description editable forever; `time` freezes at the first response. A stale `cid` in a strongRef therefore only ever means the words changed, never the grid.
- Finalization = update the schedule record + emit `community.lexicon.calendar.event` to the host's repo. No third custom record type.

## Flows

**Create:** OAuth (scoped to `lol.letsmeet.poll.*` writes) → write schedule record → cache → share URL `letsmeet.lol/p/<rkey>` (pretty pointer to the `at://` URI).

**Respond (signed-in):** OAuth → response record in own repo; upsert on return. App indexes DID → poll.

**Respond (guest):** name + paint → outbox → write to host's repo via host session (immediate flush in happy path). Guest receives edit link `/p/<rkey>/e/<token>`; server stores only a token hash → rkey. Lost link = submit fresh, no data loss.

**Finalize:** host picks a slot from the ranked list → schedule record updated (`status: finalized`, `finalized`) → `community.lexicon.calendar.event` written → poll page flips to decided mode: chosen slot, ICS download, `webcal:` link.

**Results read path:** serve from cache, revalidate in background — `getRecord` on the schedule, `listRecords` per participating repo (participants known; **no firehose, no Jetstream, no AppView**). Merge unflushed outbox rows marked pending. Host PDS 404 on the poll = tombstone: render "withdrawn by host", don't resurrect from cache.

## Server state (complete list)

1. Host OAuth sessions — encrypted at rest (write capabilities to repos).
2. Outbox — pending guest writes with retry/backoff.
3. Edit-secret hashes → rkeys.
4. Index/cache — fully reconstructable from PDSes.

Recovery property: losing the DB costs host re-logins, any unflushed outbox rows (~zero at any instant), and guest edit links. Every poll survives in PDSes.

## Failure handling

- Outbox item failing after ~24h backoff → surface to host in-app ("2 responses waiting — reconnect your account"). Never silently drop.
- Host revokes app access mid-poll → existing records stand; new guest writes queue + reconnect prompt.
- Duplicate guest names allowed; disambiguated visually. Edit-secret is identity; name is a label.

## Grid interaction

- Columns = poll dates, rows = slots; rendered in the **viewer's** timezone by default, switchable, poll home zone one tap away.
- Drag-to-paint; first-touched cell decides paint vs erase (When2meet convention).
- Segmented toggle: Available / If need be. If-need-be renders hatched/muted.
- Mobile: one finger paints (`touch-action: none` on grid), two fingers scroll; floating scroll/paint toggle as escape hatch. Default poll shape (evening window, 30-min slots, ≤7 days) must fit a phone viewport with no scrolling.
- DST: each date × window materializes to UTC individually. Windows crossing viewer-local midnight render as a continuous column labeled with the viewer-local landing date.
- Results: heat map + ranked list ("everyone", then "all but one — missing X"); ifNeedBe counts 0.5 in sort, shown separately ("4 available + 2 if needed"). Tap cell → who's in/iffy/silent. Tabs on mobile, side-by-side wide.

## Abuse limits

- Per-poll response cap (~60, fixed in v1).
- Per-IP token bucket on guest submissions.
- Lexicon `maxLength` on interval arrays, name, note.
- Outbox smooths bursts against host PDS rate limits.
- No CAPTCHA in v1; revisit only if spammed in practice.

## Testing

- Property tests: paint → record → render round-trip is identity; interval snap/merge.
- Named DST fixtures: US spring-forward; EU/US mismatch weeks.
- Integration: OAuth + record writes against the atproto dev-env PDS container; outbox retry with a deliberately killed session.
- E2E (Playwright): create → guest respond → results → finalize; touch-paint simulation.

## Stack & hosting

- TypeScript; `@atproto/oauth-client-node` + first-party SDKs.
- Single light server (Hono), server-rendered pages, small Preact island for the grid. SQLite.
- One process behind Caddy at `letsmeet.lol`; runs on the existing home server or any small VPS. Lexicon DNS records on `letsmeet.lol`.

## Explicitly out of scope for v1

- Google/Microsoft calendar OAuth (the scope trap).
- atproto Spaces / permissioned data (alpha; design allows responses to migrate later).
- Firehose/Jetstream indexing, public poll discovery.
- Recurring polls (`#weeklyPattern`), teams, billing, native apps, Discord bot, notifications/SMTP, deadlines UI, reusable availability profile (v1.1).

## Known risks (accepted)

- Public PDS records = public availability history for signed-in users; guests expose only what they type in the name field.
- "You own your data" pitch carries an asterisk for guest rows (host-attested, in host's repo) — stated plainly in the UI/FAQ.
- Timezone math and mobile painting are the effort centers; the atproto layer is the easy half.
