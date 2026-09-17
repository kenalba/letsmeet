# Feed names, copy feed link, owner edit link, unposted away entries, reach out

Date: 2026-09-17. Status: approved in chat.

Five changes from one round of feedback on letsmeet.lol. Each is a bounded change to
an existing flow; they ship in the order below, one commit each.

## 1. Calendar feed: event names and away exclusions

Where: `src/core/ics.ts` (`buildAvailabilityIcs`), `tests/core/availabilityIcs.test.ts`.

- Weekly events are titled `@<handle> usually free`; away events `@<handle> away` or
  `@<handle> away · <note>`. `<handle>` is `opts.name`, which the feed already uses for
  `X-WR-CALNAME`. A subscriber with several friends' feeds can tell them apart in a day view.
- Each weekly recurrence carries `EXDATE;TZID=<tz>:<date>T<start>` for every date an
  all-day away entry covers that falls on that block's weekday. Dates are joined with
  commas on one EXDATE property (folding handles length). The time is the block's start,
  because an EXDATE must name an occurrence exactly. Only all-day entries exclude; timed
  windows are left alone (a partial overlap has no clean exclusion, and the opaque away
  event sits beside the block anyway). A "half" entry (one of startTime/endTime) counts
  as all-day, as everywhere else.
- Blocks with no matching away dates emit no EXDATE line.

## 2. Copy feed link, on both pages

Where: `src/web/pages/copyLink.ts`, `src/web/pages/PublicAvailability.tsx`,
`src/web/pages/Availability.tsx`, tests in `tests/web/publicAvailability.test.ts` and
`tests/web/availabilityRoutes.test.ts`.

- `COPY_LINK_SCRIPT` also honours `data-copy-url` (an absolute URL, used verbatim) and
  falls back to `location.origin + data-copy-path` as today. The friend view also serves on
  `<name>.sez.<site>`, where the origin-prefixed path would be wrong.
- Both pages add a `copy feed link` button (server-rendered `hidden`, revealed by the
  script, "copied." for 1.5s on click) beside the existing "download .ics · subscribe
  (webcal)" anchors. It copies the plain https address of the feed,
  `<PUBLIC_URL>/u/<handle>/availability.ics`: what Google Calendar's "from URL" box and a
  pasted chat message both need. Both pages ship the script with the response nonce, as
  the poll page does.

## 3. Owner edit link, with the session cookie widened to subdomains

Where: `src/web/session.ts`, `src/web/routes/auth.ts` (no change expected),
`src/web/routes/availability.ts`, `src/web/pages/PublicAvailability.tsx`,
`docs/deploy.md`, tests in `tests/web/auth.test.ts` and `tests/web/publicAvailability.test.ts`.

Cookie:
- `SessionEnv` gains `domain: string | null`, computed once from `PUBLIC_URL` by a
  `cookieDomainFor(publicUrl)` helper: the host without its port, or `null` when the host
  has no dot or is an IP literal (browsers refuse `Domain=localhost`). `createServer` and
  the auth routes' env both fill it.
- `startSession` sets the cookie with `domain` when one exists. It also emits a host-only
  clear (`sid=; Max-Age=0`, no Domain) first, so a cookie set before this change cannot
  ride alongside the new one on the apex.
- `endSession` clears both forms: with the domain and host-only.
- Security note: every host under the public domain receives the cookie. Only this app
  serves them, and `aliasHostOnly` keeps the alias host to two GET routes, so a session on
  the alias host reads the friend view and nothing else. The cookie stays HttpOnly,
  SameSite=Lax and Secure on https; HSTS already includes subdomains.

Friend view:
- `friendView` reads the session (`readSession`, same as the editor) and passes
  `own: boolean` (viewer DID equals the page's DID) to `PublicAvailabilityPage`.
- When `own`, the heading block shows `this is you · edit`, where `edit` links to
  `<PUBLIC_URL>/availability` (absolute: on the alias host a relative link would 404).
- `docs/deploy.md` §sez: replace "The session cookie is scoped to the apex, so the alias
  could not show a signed-in page even if it routed one" with the new truth: the cookie
  covers every subdomain, the alias host still only routes the friend view and the feed,
  and the friend view uses it for the owner's edit link.

## 4. Away entries: say what is not posted yet

Where: `src/web/islands/availability.tsx`, `src/web/styles/app.css`, `e2e/availability.spec.ts`.

- The island keeps the last-posted away list (`data.away` at mount, updated on a
  successful post). Each away entry not in that list (compared as JSON) renders a
  `not posted yet` tag after its note, the wording the address line already uses.
- While any entry is unposted, a hint under the away list reads
  `post availability below to publish these.`
- The post button and the status line move into a `.save-bar` wrapper that is
  `position: sticky; bottom: 0` with the page background and a top border, so it stays on
  screen while the editor is. The button keeps its `.save` class and behaviour; nothing
  about when it enables changes.

## 5. Click a free hour to reach out

> Superseded the same day: the clipboard-and-profile flow below shipped, then was replaced
> by a link to Bluesky's compose intent (`https://bsky.app/intent/compose?text=…`) carrying
> a public post at the person — "hey @<handle>, <site>. <hour> on <dow> <mon d> looks good
> to me?". No script, no `.week-ping` line, no `reachOut.ts`. The rest of this section is
> kept as the record of what was tried first.

Where: `src/web/pages/PublicAvailability.tsx`, `src/web/pages/reachOut.ts` (new),
`src/web/styles/app.css`, tests in `tests/web/publicAvailability.test.ts`.

- In the week grid, a cell whose state is `free`, `early` or `late` and whose day is not
  past renders as `<a class="week-cell ..." href="https://bsky.app/profile/<handle>"
  target="_blank" rel="noopener" data-ping="<message>">`. Every other cell stays a `div`.
  Cells still carry `data-c` and the title; a linked cell's title ends with
  `· click to message them`.
- The message is `hey, free <dow> <mon d> around <hour>? <PUBLIC_URL host>/u/<handle>`,
  for example `hey, free thu sep 17 around 7pm? letsmeet.lol/u/smarmy.space`. Times are
  the record's zone, which the page already states above the grid.
- An inline nonce-tagged script (`REACH_OUT_SCRIPT` in `src/web/pages/reachOut.ts`)
  binds click on `a[data-ping]`: copies the message with `navigator.clipboard.writeText`
  when available, then sets the text of a `.week-ping` caption under the grid to
  `copied "<message>". paste it into their dms.` The anchor's own navigation opens the
  profile in a new tab. Without JavaScript the link alone works and the caption is absent.
- The grid loses `role="img"` (it now has interactive children) and becomes
  `role="group"` with the same aria-label. `a.week-cell` gets `cursor: pointer` and keeps
  the hover outline. A line under the grid says `click a free hour to message them on
  bluesky.` whenever the week has at least one linked cell.

## Out of scope

- A sign-in link on the friend view.
- Any change to which routes the alias host answers.
- Excluding weekly blocks for timed away windows.
