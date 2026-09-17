# Feed names, copy feed link, owner edit link, unposted away entries, reach out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five feedback items from 2026-09-17: named calendar events with away exclusions, a copy-feed-link button on both availability pages, an owner edit link on the friend view backed by a subdomain-wide session cookie, "not posted yet" tags on away entries with a sticky post bar, and free hours in the friend view that open the person's Bluesky profile and copy a prefilled message.

**Architecture:** Every change is a small edit to an existing flow. The feed change lives entirely in `src/core/ics.ts`. The cookie change is one helper in `src/web/session.ts` that every route mounts through. The friend view stays server-rendered with two tiny nonce-tagged inline scripts (the existing copy-link script and a new reach-out script); the editor island gains one piece of state. Each task is one commit.

**Tech Stack:** TypeScript, Hono, React 19 server rendering (`renderToString`), a React island bundled by esbuild, luxon, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-17-feed-share-edit-reach-out-design.md`

## Global Constraints

- Copy is lowercase, in the site's voice (`copy feed link`, `not posted yet`, `this is you · edit`).
- Every inline script carries the response nonce via `useNonce()` (CSP is `script-src 'self' 'nonce-…'`).
- Server-rendered pages must work without JavaScript: buttons the script reveals are rendered `hidden`; links work on their own.
- The alias host `<name>.sez.<site>` answers only `/` and `/availability.ics`; links to anything else on the friend view are absolute to `PUBLIC_URL`.
- Run `npm test` (vitest) after every task; `npm run typecheck` before every commit. `npm run build:client` before the e2e in Task 4 (Playwright serves `public/assets`).
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

### Task 1: Feed event names and EXDATE for all-day away

**Files:**
- Modify: `src/core/ics.ts` (`buildAvailabilityIcs`, lines ~85–140)
- Test: `tests/core/availabilityIcs.test.ts`, `tests/web/publicAvailability.test.ts:106-118`

**Interfaces:**
- Consumes: `buildAvailabilityIcs(rec, { uidHost, name, now })` as it exists.
- Produces: the same signature; `SUMMARY` lines change and `EXDATE` lines appear. No caller changes.

- [ ] **Step 1: Update the existing summary assertions and add the EXDATE tests**

In `tests/core/availabilityIcs.test.ts` change the two summary expectations:

```ts
    expect(lines).toContain('SUMMARY:@ken.wzrdz.cool usually free');
```
(in `repeats each weekly block …`) and
```ts
    expect(lines).toContain('SUMMARY:@ken.wzrdz.cool away · out of town');
```
(in `emits an all-day away entry …`) and
```ts
    expect(lines).toContain('SUMMARY:@ken.wzrdz.cool away · a\\; note\\, with punctuation');
```
(in `emits a timed multi-day away entry …`).

Append inside the `describe('buildAvailabilityIcs', …)` block:

```ts
  it('names a plain away entry after the account too', () => {
    const plain = buildAvailabilityIcs({ ...rec, away: [{ start: '2026-10-20', end: '2026-10-20' }] }, opts);
    expect(plain.split('\r\n')).toContain('SUMMARY:@ken.wzrdz.cool away');
  });
  it('excludes a weekly block on every date an all-day away entry covers on that weekday', () => {
    // Tue 22 Sep through Tue 29 Sep 2026: two Tuesdays inside one all-day entry.
    const ics = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-09-22', end: '2026-09-29', note: 'trip' }],
    }, opts);
    expect(ics.split('\r\n')).toContain('EXDATE;TZID=America/New_York:20260922T190000,20260929T190000');
  });
  it('emits no EXDATE when no all-day entry lands on the block\'s weekday, nor for timed windows', () => {
    // The fixture: sat 19 – mon 21 all day (no Tuesday), and a timed window mon 12 – wed 14 oct.
    expect(lines.some((l) => l.startsWith('EXDATE'))).toBe(false);
    const timed = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-09-22', end: '2026-09-22', startTime: '18:00', endTime: '23:00' }],
    }, opts);
    expect(timed.split('\r\n').some((l) => l.startsWith('EXDATE'))).toBe(false);
  });
  it('merges and sorts the dates of overlapping all-day entries', () => {
    const ics = buildAvailabilityIcs({
      ...rec, away: [
        { start: '2026-09-29', end: '2026-09-29' },
        { start: '2026-09-21', end: '2026-09-29' },
      ],
    }, opts);
    expect(ics.split('\r\n')).toContain('EXDATE;TZID=America/New_York:20260922T190000,20260929T190000');
  });
  it('excludes at most a year of a very long away entry', () => {
    const ics = buildAvailabilityIcs({
      ...rec, away: [{ start: '2026-09-22', end: '2099-12-31' }],
    }, opts);
    // Unfold first (RFC 5545 continuation lines), then read the one EXDATE property.
    const unfolded = ics.replace(/\r\n /g, '').split('\r\n');
    const ex = unfolded.find((l) => l.startsWith('EXDATE;TZID=America/New_York:'))!;
    expect(ex.slice('EXDATE;TZID=America/New_York:'.length).split(',').length).toBe(53);
  });
```

In `tests/web/publicAvailability.test.ts`, in `serves the feed as text/calendar`, change:
```ts
    expect(body).toContain('SUMMARY:@did:plc:ken away · out of town');
```
(`opts.name` is the handle, and in fake mode the handle is the DID literal.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/core/availabilityIcs.test.ts tests/web/publicAvailability.test.ts`
Expected: the three renamed summary assertions and the new EXDATE tests FAIL; the rest pass.

- [ ] **Step 3: Implement**

In `src/core/ics.ts`, add below `plusDays`:

```ts
/** ISO date + n days as ISO (plusDays returns the basic YYYYMMDD form). */
function plusDaysIso(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** How many occurrences one all-day entry may exclude per block: a year of weeks. */
const MAX_EXDATES_PER_ENTRY = 53;

/**
 * The dates on weekday `day` that any all-day away entry covers, sorted and deduped.
 * A week the person is away should not also say "usually free" in a subscriber's
 * calendar, and RRULE has no way to say "except when" other than naming each occurrence.
 * An entry longer than a year excludes its first year only: the away event itself
 * still covers the rest, and an open-ended `end` must not spin this loop for centuries.
 */
function awayDatesOn(away: AwayEntry[], day: number): string[] {
  const dates = new Set<string>();
  for (const a of away) {
    if (a.startTime && a.endTime) continue; // timed windows are left to the away event
    // First date >= start on the wanted weekday, then every seventh day to end.
    let d = plusDaysIso(a.start, (day - weekdayOf(a.start) + 7) % 7);
    for (let n = 0; d <= a.end && n < MAX_EXDATES_PER_ENTRY; n++, d = plusDaysIso(d, 7)) dates.add(d);
  }
  return [...dates].sort();
}
```

Add `import type { AwayEntry } from '../atproto/records.js';` at the top.

In the weekly loop, replace the `L.push('BEGIN:VEVENT', … 'SUMMARY:usually free', 'TRANSP:TRANSPARENT', 'END:VEVENT')` call with:

```ts
    const exdates = awayDatesOn(rec.away, b.day);
    L.push(
      'BEGIN:VEVENT',
      `UID:weekly-${BYDAY[b.day]}-${b.start.replace(':', '')}@${opts.uidHost}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${tz}:${date}T${hm(b.start)}`,
      `DTEND;TZID=${tz}:${endDate}T${hm(b.end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[b.day]}${until}`,
      // Each excluded occurrence is named by its own start, which is what EXDATE requires.
      ...(exdates.length > 0
        ? [`EXDATE;TZID=${tz}:${exdates.map((d) => `${ymd(d)}T${hm(b.start)}`).join(',')}`]
        : []),
      `SUMMARY:${esc(`@${opts.name} usually free`)}`, 'TRANSP:TRANSPARENT', 'END:VEVENT',
    );
```

In the away loop change the summary line to:

```ts
    const summary = `SUMMARY:${esc(`@${opts.name} away${a.note ? ` · ${a.note}` : ''}`)}`;
```

Update the doc comment above `buildAvailabilityIcs`: after "each away entry a busy event, all-day or timed" add "; every weekly event is titled with the account so several friends' feeds tell apart, and skips (EXDATE) the dates an all-day away entry covers."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/core/availabilityIcs.test.ts tests/web/publicAvailability.test.ts`
Expected: all PASS. Then `npm test` and `npm run typecheck`: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/ics.ts tests/core/availabilityIcs.test.ts tests/web/publicAvailability.test.ts
git commit -m "feat(feed): events named for the account, weekly blocks skip all-day away dates

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Copy feed link on the friend view and the editor

**Files:**
- Modify: `src/web/pages/copyLink.ts`
- Modify: `src/web/pages/PublicAvailability.tsx` (the `links` element and the page's closing markup)
- Modify: `src/web/pages/Availability.tsx` (the "friends can see this at" line)
- Test: `tests/web/publicAvailability.test.ts`, `tests/web/availabilityRoutes.test.ts`

**Interfaces:**
- Produces: `COPY_LINK_SCRIPT` now wires `button[data-copy-url]` (absolute URL, verbatim) as well as `button[data-copy-path]`.

- [ ] **Step 1: Write the failing tests**

In `tests/web/publicAvailability.test.ts`, in the first `/u/:handle` test (`renders the sentence…`) append:

```ts
    expect(html).toContain('data-copy-url="http://localhost:8787/u/ken.wzrdz.cool/availability.ics"');
    expect(html).toContain('>copy feed link</button>');
    expect(html).toContain("button[data-copy-url]"); // the copy script shipped with the page
```

In the sez describe's first test (`serves the friend view and feed for a claimed name…`) append after the webcal assertion:

```ts
    // Absolute: on the alias host the page's own origin is not where the feed lives.
    expect(html).toContain('data-copy-url="https://letsmeet.lol/u/ken.wzrdz.cool/availability.ics"');
```

In `tests/web/availabilityRoutes.test.ts`, in `renders the editor with the current record as island data` append:

```ts
    expect(html).toContain('data-copy-url="http://localhost:8787/u/me.test/availability.ics"');
    expect(html).toContain('>copy feed link</button>');
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/web/publicAvailability.test.ts tests/web/availabilityRoutes.test.ts`
Expected: the three edited tests FAIL on the `data-copy-url` assertion.

- [ ] **Step 3: Implement**

`src/web/pages/copyLink.ts`: replace the doc comment's first sentence and the selector/url lines so the file reads:

```ts
/**
 * Wires every `button[data-copy-path]` and `button[data-copy-url]` on the page. A path
 * button copies the CANONICAL path from the attribute (origin-prefixed at click time),
 * never `location.href` — a guest viewing through an edit link is on `/p/<rkey>/e/<token>`,
 * and sharing that would hand their private edit token to the group chat. A url button
 * copies its absolute URL verbatim: the availability feed's address is the same whichever
 * host the page is served on, and on `<name>.sez.<site>` the page's own origin is not it.
 * Buttons are server-rendered `hidden` and revealed here, so a no-JS page shows no button
 * that does nothing. Inline, not an island: three lines of DOM work per button don't earn
 * a bundle.
 */
export const COPY_LINK_SCRIPT = "(function(){var bs=document.querySelectorAll('button[data-copy-path],button[data-copy-url]');"
  + 'for(var i=0;i<bs.length;i++)(function(b){b.hidden=false;var t=b.textContent;'
  + "var url=b.getAttribute('data-copy-url')||location.origin+b.getAttribute('data-copy-path');"
  + "b.addEventListener('click',function(){"
  + "var done=function(){b.textContent='copied.';setTimeout(function(){b.textContent=t},1500)};"
  + "var ask=function(){window.prompt('copy this link:',url)};"
  + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
  + 'navigator.clipboard.writeText(url).then(done,ask)}else{ask()}})})(bs[i])})()';
```

`src/web/pages/PublicAvailability.tsx`: add imports
```ts
import { useNonce } from '../nonce.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
```
Replace the `links` constant with:

```tsx
  const feedUrl = `${base}${path}/availability.ics`;
  // Absolute, like the webcal link beside it: this page also serves on `<name>.sez.<site>`,
  // where only `/` and `/availability.ics` answer — a relative `/u/<handle>/availability.ics`
  // would 404 there. The week links, by contrast, are query-only so they stay on either host.
  // The copy button hands over the plain https address: Google Calendar's "from URL" box
  // and a pasted chat message both want that, and neither can take a click on webcal://.
  const links = (
    <p className="hint feed-links text-sm text-muted-foreground">
      <a href={feedUrl} className="text-primary underline underline-offset-4">download .ics</a>
      {' '}·{' '}
      <a href={`webcal://${base.replace(/^https?:\/\//, '')}${path}/availability.ics`} className="text-primary underline underline-offset-4">subscribe (webcal)</a>
      {' '}·{' '}
      <button
        type="button"
        data-copy-url={feedUrl}
        hidden
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
      >copy feed link</button>
    </p>
  );
```
(delete the old comment above the old `links`, it moved.) At the end of the page, inside the outer `<div className="grid gap-6">` after the card branches' closing `)}`, add:
```tsx
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
```

`src/web/pages/Availability.tsx`: add imports
```ts
import { cn } from '../lib/cn.js';
import { buttonVariants } from '../ui/button.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
```
Replace the `{publicPath && (<p className="hint …">…</p>)}` block with:

```tsx
        {publicPath && (
          <p className="hint feed-links text-sm text-muted-foreground">
            friends can see this at{' '}
            <a href={publicPath} className="text-primary underline underline-offset-4">
              {base.replace(/^https?:\/\//, '')}{publicPath}
            </a>
            {' '}·{' '}
            <a href={webcal!} className="text-primary underline underline-offset-4">
              subscribe in your calendar (webcal)
            </a>
            {' '}·{' '}
            <button
              type="button"
              data-copy-url={`${base}${publicPath}/availability.ics`}
              hidden
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >copy feed link</button>
          </p>
        )}
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
```
(`useNonce` is already imported in that file.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/web/publicAvailability.test.ts tests/web/availabilityRoutes.test.ts tests/web/server.test.ts`
Expected: PASS (the poll page's `data-copy-path` assertion in server.test still holds). Then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/copyLink.ts src/web/pages/PublicAvailability.tsx src/web/pages/Availability.tsx tests/web/publicAvailability.test.ts tests/web/availabilityRoutes.test.ts
git commit -m "feat(availability): copy feed link on the friend view and the editor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3a: Session cookie covers every subdomain

**Files:**
- Modify: `src/web/session.ts`
- Modify: `src/web/server.ts:36-38`, `src/web/routes/polls.ts:56-58`, `src/web/routes/availability.ts:91-93` (the three `session: SessionEnv = {…}` literals)
- Modify: `docs/deploy.md:325-326`
- Test: `tests/web/auth.test.ts`

**Interfaces:**
- Produces: `cookieDomainFor(publicUrl: string): string | null` and `sessionEnvFor(db: Database.Database, cookieSecret: string, publicUrl: string): SessionEnv`, both exported from `src/web/session.ts`. `SessionEnv` gains a required `domain: string | null`.

- [ ] **Step 1: Write the failing tests**

In `tests/web/auth.test.ts`:

Change the imports/env helper:
```ts
import { cookieDomainFor, sessionEnvFor } from '../../src/web/session.js';
…
const env = (publicUrl = 'https://poll.example') => ({
  ...sessionEnvFor(openDb(':memory:'), 'test-cookie-secret', publicUrl), publicUrl,
});
```
Replace `cookieOf` with one that skips the host-only clear the sign-in now emits:
```ts
/** The live session cookie: the Set-Cookie that carries a value, not the host-only clear. */
const cookieOf = (res: Response) =>
  res.headers.getSetCookie().find((s) => s.startsWith('sid=') && !s.startsWith('sid=;'))!.split(';')[0];
```
Edit `marks the session cookie Secure, HttpOnly and Lax on an https origin` to read the live cookie, not the joined header:
```ts
  it('marks the session cookie Secure, HttpOnly, Lax and Domain-wide on an https origin', async () => {
    const res = await app.request('/oauth/callback?code=abc&state=xyz');
    const all = res.headers.getSetCookie();
    const live = all.find((s) => s.startsWith('sid=') && !s.startsWith('sid=;'))!;
    expect(live).toContain('Secure');
    expect(live).toContain('HttpOnly');
    expect(live).toContain('SameSite=Lax');
    // Every `<name>.sez.poll.example` gets it too: the friend view can know its owner there.
    expect(live).toContain('Domain=poll.example');
    // A cookie set before the Domain attribute existed is host-only and would ride beside
    // this one on the apex: it is cleared in the same response.
    expect(all.some((s) => s.startsWith('sid=;') && s.includes('Max-Age=0') && !s.includes('Domain='))).toBe(true);
  });
  it('sets a host-only cookie and no clear on a host with no dots (local dev)', async () => {
    const http = authRoutes(stub, env('http://localhost:8787'));
    const res = await http.request('/oauth/callback?code=abc&state=xyz');
    const all = res.headers.getSetCookie();
    expect(all.length).toBe(1);
    expect(all[0]).not.toContain('Domain=');
    expect(all[0]).not.toContain('Secure');
  });
  it('cookieDomainFor: the public host without its port; null for localhost and ip literals', () => {
    expect(cookieDomainFor('https://letsmeet.lol')).toBe('letsmeet.lol');
    expect(cookieDomainFor('https://poll.example:8443')).toBe('poll.example');
    expect(cookieDomainFor('http://localhost:8787')).toBeNull();
    expect(cookieDomainFor('http://127.0.0.1:8787')).toBeNull();
    expect(cookieDomainFor('http://[::1]:8787')).toBeNull();
  });
```
Delete the old `leaves the session cookie non-Secure on a plain-http origin` test (the localhost test above covers it).

Edit `logout revokes the session row…` so its last assertion becomes:
```ts
    const clears = res.headers.getSetCookie();
    expect(clears.some((s) => s.startsWith('sid=;') && s.includes('Domain=poll.example'))).toBe(true);
    expect(clears.some((s) => s.startsWith('sid=;') && !s.includes('Domain='))).toBe(true);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/web/auth.test.ts`
Expected: FAIL to compile (`cookieDomainFor`/`sessionEnvFor` not exported).

- [ ] **Step 3: Implement**

`src/web/session.ts`:

```ts
export interface SessionEnv {
  db: Database.Database;
  cookieSecret: string;
  /** Mark the cookie Secure — true for any https PUBLIC_URL. */
  secure: boolean;
  /**
   * The cookie's Domain attribute, or null for a host-only cookie. With one, every host
   * under it (`<name>.sez.<site>`) gets the session, so the friend view served there can
   * tell its owner. Null for local dev: browsers refuse `Domain=localhost` and any IP.
   */
  domain: string | null;
}

/** The registrable host behind PUBLIC_URL, or null when a browser would not take it as Domain. */
export function cookieDomainFor(publicUrl: string): string | null {
  const host = new URL(publicUrl).hostname; // no port; an IPv6 literal keeps its brackets
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

/** The one way to build a SessionEnv: every route mounts through this so they agree. */
export function sessionEnvFor(db: Database.Database, cookieSecret: string, publicUrl: string): SessionEnv {
  return { db, cookieSecret, secure: publicUrl.startsWith('https'), domain: cookieDomainFor(publicUrl) };
}
```

`startSession` becomes:

```ts
export async function startSession(
  c: Context, env: SessionEnv, did: string, handle: string | null, nowMs: number,
): Promise<void> {
  const sid = createWebSession(env.db, did, handle, nowMs);
  const opts = {
    httpOnly: true, sameSite: 'Lax' as const, path: '/', secure: env.secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
  if (env.domain) {
    // A cookie set before the Domain attribute existed is host-only, and a browser holding
    // one would send both on the apex. Clear it in the same response; the browser matches
    // the clear to the host-only cookie and the set to the domain one.
    deleteCookie(c, COOKIE, { path: '/' });
    await setNamedCookie(c, env.cookieSecret, COOKIE, sid, { ...opts, domain: env.domain });
  } else {
    await setNamedCookie(c, env.cookieSecret, COOKIE, sid, opts);
  }
}
```

`endSession` becomes:

```ts
export async function endSession(c: Context, env: SessionEnv): Promise<void> {
  const sid = await getNamedCookie(c, env.cookieSecret, COOKIE);
  if (sid) deleteWebSession(env.db, sid);
  // Both shapes: the domain cookie, and a host-only one from before the Domain attribute.
  deleteCookie(c, COOKIE, { path: '/' });
  if (env.domain) deleteCookie(c, COOKIE, { path: '/', domain: env.domain });
}
```

Replace the three `session` literals:

`src/web/server.ts` — import `sessionEnvFor` instead of `type SessionEnv` (keep `startSession`), and:
```ts
  const session = sessionEnvFor(deps.db, env.COOKIE_SECRET, env.PUBLIC_URL);
```
`src/web/routes/polls.ts` and `src/web/routes/availability.ts` — same replacement; change their `import { readSession, type SessionEnv }` to `import { readSession, sessionEnvFor }` and delete the `: SessionEnv` annotation with the literal.

`docs/deploy.md` lines 325–326: replace "The session cookie is scoped to the apex, so the alias could not show a signed-in page even if it routed one." with "The session cookie carries `Domain=letsmeet.lol`, so every sez host receives it; the friend view uses it for one thing, the owner's `this is you · edit` link, and the alias host still routes nothing a session could act on."

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS. `tests/web/availabilityRoutes.test.ts`, `server.test.ts`, `pollPrefill.test.ts` run on `http://localhost:8787` (domain null, one Set-Cookie) so their `split(';')[0]` helpers still work.

- [ ] **Step 5: Commit**

```bash
git add src/web/session.ts src/web/server.ts src/web/routes/polls.ts src/web/routes/availability.ts docs/deploy.md tests/web/auth.test.ts
git commit -m "feat(session): the cookie covers every subdomain, so the sez host knows its owner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3b: Owner edit link on the friend view

**Files:**
- Modify: `src/web/routes/availability.ts` (`friendView`, and the two routes that call it)
- Modify: `src/web/pages/PublicAvailability.tsx` (`PublicAvailabilityData`, the heading block)
- Test: `tests/web/publicAvailability.test.ts`

**Interfaces:**
- Consumes: `readSession(c, session, nowMs)` from `src/web/session.ts`; `sessionEnvFor` from Task 3a.
- Produces: `PublicAvailabilityData.own?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `tests/web/publicAvailability.test.ts` change `setup` so the dev login is mounted:
```ts
  const app = createServer(deps, stubAuth, { COOKIE_SECRET: 's', PUBLIC_URL: publicUrl, devLogin: true });
```
Add above `describe('/u/:handle'…)`:
```ts
/** Sign in through the dev route; the live cookie, not the host-only clear a domain sign-in also emits. */
async function signIn(app: ReturnType<typeof setup>['app'], did: string): Promise<string> {
  const res = await app.request(`/dev/login?did=${encodeURIComponent(did)}&handle=ken.wzrdz.cool`);
  return res.headers.getSetCookie().find((s) => s.startsWith('sid=') && !s.startsWith('sid=;'))!.split(';')[0];
}
```
Add to `describe('/u/:handle'…)`:
```ts
  it('offers the owner an edit link, and nobody else', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const guest = await (await app.request('/u/ken.wzrdz.cool')).text();
    expect(guest).not.toContain('this is you');
    const other = await signIn(app, 'did:plc:other');
    expect(await (await app.request('/u/ken.wzrdz.cool', { headers: { cookie: other } })).text()).not.toContain('this is you');
    const mine = await signIn(app, KEN);
    const html = await (await app.request('/u/ken.wzrdz.cool', { headers: { cookie: mine } })).text();
    expect(html).toContain('this is you');
    expect(html).toContain('href="https://letsmeet.lol/availability"');
  });
```
Add to `describe('<name>.sez.letsmeet.lol'…)`:
```ts
  it('offers the owner the edit link on their own sez page, pointing at the apex', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    // The browser sends the Domain=letsmeet.lol cookie to ken.sez.letsmeet.lol; here it is
    // the header that arrives with it.
    const cookie = await signIn(app, KEN);
    const html = await (await app.request('/', { headers: { host: 'ken.sez.letsmeet.lol', cookie } })).text();
    expect(html).toContain('this is you');
    expect(html).toContain('href="https://letsmeet.lol/availability"');
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/web/publicAvailability.test.ts`
Expected: the two new tests FAIL on `toContain('this is you')`.

- [ ] **Step 3: Implement**

`src/web/routes/availability.ts` — `friendView` reads the session:

```ts
  /**
   * The friend view. Shared by `/u/:handle` and the `<name>.sez.<site>` alias; the address
   * line is for the apex page only — on the alias host the address bar already shows it.
   * The session is read for one thing: whether the viewer is the person on the page, who
   * gets a link back to the editor.
   */
  const friendView = async (c: Context, r: Found, opts: { address: boolean }) => {
    const who = await readSession(c, session, deps.now().getTime());
    return page(c, createElement(PublicAvailabilityPage, {
      handle: r.handle, record: r.record, now: deps.now(), publicUrl: env.PUBLIC_URL,
      sezAddress: opts.address ? sezAddressFor(deps, r.did, r.handle, env.PUBLIC_URL) ?? undefined : undefined,
      week: weekChoice(c.req.query('week')),
      own: who?.did === r.did,
    }));
  };
```
The two callers (`app.get('/u/:handle', …)` and the alias `app.get('/', …)`) already `return` the value; they now return a promise, which Hono awaits. No change needed there.

`src/web/pages/PublicAvailability.tsx` — add to `PublicAvailabilityData`:
```ts
  /** The viewer is this person: offer the way back to the editor. */
  own?: boolean;
```
In the heading block, after the `sezAddress` line:
```tsx
          {data.own && (
            <p className="pixel-label text-muted-foreground">
              {/* Absolute: on the alias host `/availability` answers nothing. */}
              this is you · <a href={`${base}/availability`} className="text-primary underline underline-offset-4">edit</a>
            </p>
          )}
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/availability.ts src/web/pages/PublicAvailability.tsx tests/web/publicAvailability.test.ts
git commit -m "feat(availability): the friend view offers its owner an edit link, on either host

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Away entries say when they are not posted yet; sticky post bar

**Files:**
- Modify: `src/web/islands/availability.tsx`
- Modify: `src/web/styles/app.css` (the `#availability-root` block, ~lines 534–561)
- Test: `e2e/availability.spec.ts`

**Interfaces:**
- Produces: DOM hooks `#availability-root .away .unposted`, `#availability-root .away-hint`, `#availability-root .save-bar`. `button.save` and `.status` keep their classes.

- [ ] **Step 1: Write the failing e2e assertions**

In `e2e/availability.spec.ts`, after
```ts
  await expect(page.locator('#availability-root .away li')).toContainText('out of town');
```
add:
```ts
  // Added, not posted: the entry says so until the post button below publishes it.
  await expect(page.locator('#availability-root .away li .unposted')).toHaveText('not posted yet');
  await expect(page.locator('#availability-root .away-hint')).toHaveText('post availability below to publish these.');
```
and after
```ts
  await expect(page.locator('#availability-root .status')).toHaveText('availability posted.');
```
add:
```ts
  await expect(page.locator('#availability-root .away li .unposted')).toHaveCount(0);
  await expect(page.locator('#availability-root .away-hint')).toHaveCount(0);
```

- [ ] **Step 2: Run the e2e to see it fail**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts --project=chromium`
(If the project is named differently, list them with `npx playwright test --list | head` and pick the first.)
Expected: FAIL at the `.unposted` assertion.

- [ ] **Step 3: Implement the island**

In `src/web/islands/availability.tsx`, right after `const [away, setAway] = useState<AwayEntry[]>(data.away);` add:

```ts
  // What the server has been told about away, entry by entry, so a new one can say it is
  // not up yet: "i'm away" only adds to this list, and the post button — a long page below
  // — is what publishes. Compared as JSON: the editor builds entries in the same key order
  // the record comes back in (start, end, startTime, endTime, note).
  const [postedAway, setPostedAway] = useState<Set<string>>(
    () => new Set(data.away.map((a) => JSON.stringify(a))));
  const unposted = (a: AwayEntry) => !postedAway.has(JSON.stringify(a));
```
In `submit`, after `setAliasSaved(alias);` add:
```ts
      setPostedAway(new Set(away.map((a) => JSON.stringify(a))));
```
In the away list item, after the `{a.note && <span className="note"> {a.note}</span>}` line add:
```tsx
            {unposted(a) && <span className="unposted">not posted yet</span>}
```
After the closing `</ul>` of the away list, before `<div className="away-form">`, add:
```tsx
      {away.some(unposted) && <p className="hint away-hint">post availability below to publish these.</p>}
```
Replace the post button and status at the end of the component with:
```tsx
      {/* Sticky at the bottom of the viewport while the editor is on screen: the page is
          long, and a change made at the top must not hide the one button that saves it. */}
      <div className="save-bar">
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'default' }), 'save')}
          disabled={saving || !dirty || !aliasOk}
          onClick={submit}
        >post availability</button>
        {status && <p className="status" role="status">{status}</p>}
      </div>
```

- [ ] **Step 4: Style it**

In `src/web/styles/app.css`, inside the `#availability-root { … }` block: replace `.save { margin-top: 12px; }` with

```css
    .away .unposted { font-size: 12px; color: var(--muted-foreground); }
    .away-hint { margin: 0 0 10px; }
    /* The post button rides the bottom of the viewport while the editor is on screen. */
    .save-bar {
      position: sticky; bottom: 0; z-index: 1;
      display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
      margin-top: 12px; padding: 10px 0;
      background: var(--card); border-top: 1px solid var(--border);
    }
    .save-bar .status { margin: 0; }
```

Check the `:is(#grid-root, #reply-root, #availability-root) .status` rule a few lines above still applies (it does; the bar only zeroes the margin).

- [ ] **Step 5: Run the e2e and the unit suite**

Run: `npm run build:client && npx playwright test e2e/availability.spec.ts` (all projects), then `npm test && npm run typecheck`.
Expected: PASS. The `.status` locator and `button.save` still resolve inside the bar.

- [ ] **Step 6: Commit**

```bash
git add src/web/islands/availability.tsx src/web/styles/app.css e2e/availability.spec.ts public/assets/availability.js public/assets/app.css
git commit -m "feat(editor): away entries say when they are not posted yet; the post button sticks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
(Only add `public/assets/*` if the repo tracks them: check `git ls-files public/assets | head`. If it does not, leave them out.)

---

### Task 5: A free hour in the friend view reaches out

**Files:**
- Create: `src/web/pages/reachOut.ts`
- Modify: `src/core/weekView.ts` (export `monthDayLabel`)
- Modify: `src/web/pages/PublicAvailability.tsx` (`WeekGrid`, the grid card)
- Modify: `src/web/styles/app.css` (the `.week` block, ~lines 565–624)
- Test: `tests/core/weekView.test.ts`, `tests/web/publicAvailability.test.ts`

**Interfaces:**
- Produces: `monthDayLabel(date: string): string` from `src/core/weekView.ts` (`'sep 17'`); `REACH_OUT_SCRIPT` from `src/web/pages/reachOut.ts`; DOM hooks `a.week-cell[data-ping]`, `.week-ping`, `.week-reach`.

- [ ] **Step 1: Write the failing tests**

`tests/core/weekView.test.ts` — add (imports: extend the existing import from `../../src/core/weekView.js` with `monthDayLabel`):
```ts
describe('monthDayLabel', () => {
  it('is the lowercase month and day', () => {
    expect(monthDayLabel('2026-09-17')).toBe('sep 17');
    expect(monthDayLabel('2026-10-03')).toBe('oct 3');
  });
});
```

`tests/web/publicAvailability.test.ts`, in `describe('the week grid'…)`:
```ts
  it('links each free hour that is still ahead to their bluesky profile with a message to copy', () => {
    const html = render();
    // Now is Wed 16 Sep: Tuesday's three free hours are past and stay inert, Thursday's link.
    expect(html.match(/<a class="week-cell free/g)?.length).toBe(3);
    expect(html.match(/<div class="week-cell free/g)?.length).toBe(3);
    expect(html).toContain('href="https://bsky.app/profile/ken.wzrdz.cool" target="_blank" rel="noopener"');
    expect(html).toContain('data-ping="hey, free thu sep 17 around 7pm? letsmeet.lol/u/ken.wzrdz.cool"');
    expect(html).toContain('title="thu 17 7pm · click to message them"');
    expect(html).toContain('click a free hour to message them on bluesky.');
    expect(html).toContain('class="week-ping');
    expect(html).toContain("a[data-ping]"); // the reach-out script shipped with the page
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="img"');
  });
  it('links nothing, and says nothing about it, when the week has no free hour ahead', () => {
    const html = render({ record: { ...rec, weekly: [{ day: 1, start: '19:00', end: '22:00' }] } }); // Mondays only: past
    expect(html).not.toContain('<a class="week-cell');
    expect(html).not.toContain('click a free hour');
  });
```
Also, in the existing `wraps each hour in a row and tags columns…` test the regex `/class="week-cell[^"]*" data-c="0"/` must keep matching anchors: the anchor's attribute order below keeps `class` then `data-c`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/core/weekView.test.ts tests/web/publicAvailability.test.ts`
Expected: `monthDayLabel` not exported; the two new grid tests FAIL.

- [ ] **Step 3: Implement**

`src/core/weekView.ts`: rename the private `monthDay` to an exported function and keep the two internal callers:
```ts
/** 'sep 17'. Lowercase, like the rest of the grid chrome. */
export function monthDayLabel(date: string): string {
  return iso(date).toFormat('LLL d').toLowerCase();
}
```
(replace `monthDay(` with `monthDayLabel(` in `dateRangeLabel`.)

`src/web/pages/reachOut.ts` (new):
```ts
/**
 * Wires every `a[data-ping]` in the friend view's week grid — the free hours still ahead.
 * The anchor itself opens the person's Bluesky profile in a new tab (no script needed);
 * this copies the prefilled message in the same click and says so in the `.week-ping`
 * line under the grid, so one paste into their DMs finishes the job. Bluesky has no DM
 * intent URL and sending one needs a chat scope this app does not ask for, so the
 * clipboard is the whole bridge. Inline, nonce-tagged, no bundle: a page nothing hydrates.
 */
export const REACH_OUT_SCRIPT = "(function(){var as=document.querySelectorAll('a[data-ping]');"
  + "var out=document.querySelector('.week-ping');var say=function(t){if(out){out.textContent=t}};"
  + "for(var i=0;i<as.length;i++)(function(a){a.addEventListener('click',function(){"
  + "var m=a.getAttribute('data-ping');"
  + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
  + "navigator.clipboard.writeText(m).then(function(){say('copied \"'+m+'\". paste it into their dms.')},"
  + "function(){say('could not copy. your message: '+m)})}"
  + "else{say('your message: '+m)}})})(as[i])})()";
```

`src/web/pages/PublicAvailability.tsx`:
- imports: add `monthDayLabel` to the `weekView.js` import; add `import { REACH_OUT_SCRIPT } from './reachOut.js';`.
- `WeekGrid` takes the person and the page address:

```tsx
/**
 * Days across, hours down. Server-rendered; the only script is the reach-out one. Each hour
 * is a `.week-row` (`display: contents`, so the cells still sit in the grid) and every head
 * and cell carries its column index in `data-c`: that is all the hover rules in app.css
 * need to light the hovered cell's hour label and day header. A free hour still ahead is a
 * link to the person's Bluesky profile carrying the message to copy; everything else is
 * an inert div.
 */
function WeekGrid({ view, handle, site }: { view: WeekView; handle: string; site: string }) {
  const profile = `https://bsky.app/profile/${handle}`;
  return (
    <div className="week" aria-label={`usual week, ${view.title}`} role="group">
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
            const title = `${d.dow} ${d.dom} ${hourLabel(h)}${c.note ? ` · ${c.note}` : ''}`;
            return isReachable(d, c) ? (
              <a
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state)}
                data-c={ci}
                href={profile}
                target="_blank"
                rel="noopener"
                data-ping={`hey, free ${d.dow} ${monthDayLabel(d.date)} around ${hourLabel(h)}? ${site}/u/${handle}`}
                title={`${title} · click to message them`}
              />
            ) : (
              <div
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state, d.past && 'past')}
                data-c={ci}
                title={title}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** A free (or half-free) hour on a day that is not over: worth a message. */
const isReachable = (d: WeekDay, c: WeekCell) =>
  !d.past && (c.state === 'free' || c.state === 'early' || c.state === 'late');
```
Import `WeekDay` and `WeekCell` types from `weekView.js` alongside `WeekView`.

In `PublicAvailabilityPage`: after `const later = …` add
```ts
  const site = base.replace(/^https?:\/\//, '');
  const reachable = !!view && view.days.some((d) => d.cells.some((c) => isReachable(d, c)));
```
In the grid card, replace `<WeekGrid view={view!} />` with `<WeekGrid view={view!} handle={data.handle} site={site} />`, and right after the legend block (`{view!.hasAway && (…)}`) add:
```tsx
              {reachable && (
                <p className="week-caption text-sm text-muted-foreground">click a free hour to message them on bluesky.</p>
              )}
              <p className="week-ping week-caption text-sm text-primary" aria-live="polite" />
```
Next to the copy-link `<script>` at the end of the page add:
```tsx
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: REACH_OUT_SCRIPT }} />
```

`src/web/styles/app.css`, in the `.week` block: after `.week-cell.past { opacity: 0.42; }` add
```css
  a.week-cell { cursor: pointer; }
  .week-ping:empty { display: none; }
```

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && npm run build:css`
Expected: PASS; the css test rebuilds the sheet itself.

- [ ] **Step 5: Look at it once**

Run: `npm run build:client && npm run dev` (or the project's `run` skill), sign in via `/dev/login?did=did:plc:x&handle=x.test`, post a week, open `/u/did:plc:x`, click a free hour: a new tab opens on bsky.app and the line under the grid reads `copied "hey, free … ". paste it into their dms.` Stop the server.

- [ ] **Step 6: Commit**

```bash
git add src/web/pages/reachOut.ts src/core/weekView.ts src/web/pages/PublicAvailability.tsx src/web/styles/app.css tests/core/weekView.test.ts tests/web/publicAvailability.test.ts
git commit -m "feat(availability): a free hour on the friend view opens their profile with a message to paste

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

- Spec §1 → Task 1 (names, EXDATE, all-day only, half entries count as all-day via the `startTime && endTime` check, no line when empty). The one-year cap is an addition the spec did not name; it is documented in code and tested.
- Spec §2 → Task 2 (both pages, `data-copy-url`, hidden until the script runs, absolute https URL).
- Spec §3 → Tasks 3a and 3b (domain helper, host-only clear on sign-in, both clears on logout, `sessionEnvFor` in all three mount points, deploy note, `own` on both hosts).
- Spec §4 → Task 4 (JSON-compared posted set, tag wording, hint wording, sticky bar, no enable-rule change).
- Spec §5 → Task 5 (anchor cells for free/early/late and not past, message shape, script copies then reports, `role="group"`, cursor, caption only when something is linked).
- Names used across tasks: `sessionEnvFor`/`cookieDomainFor` (3a → 3b via `session`), `monthDayLabel` (5), `isReachable` (5, one file), `REACH_OUT_SCRIPT`, `COPY_LINK_SCRIPT`. Consistent.
