# Deploying wzrdz-poll

wzrdz-poll is a single Node process (Hono, server-rendered pages + one Preact
island for the grid) backed by SQLite. It is designed to run behind Caddy at
`poll.wzrdz.cool`, on the same home server that hosts the rest of the wzrdz.cool
stack, or on any small VPS.

The one thing worth internalizing before you deploy: **`DB_PATH` needs real
backups.** The records survive without it; the app does not.

Every poll and every response does live as an atproto record in someone's
PDS, and those records are untouched by anything that happens to this server.
But v1 has no way to find them again. A share link is `/p/<rkey>` — an rkey
and nothing else, no host DID — so the *only* thing that maps a share link to
the host repo it came from is the `poll_cache` row in this SQLite file. Lose
the DB and every share link ever handed out 404s, permanently, even though
the schedule and response records are still sitting in their PDSes. There is
no scan, no firehose index, and no rebuild path in v1.

So: back up `DB_PATH` (a periodic `sqlite3 "$DB_PATH" '.backup ...'` or a
volume snapshot is plenty — it is a small file), and treat losing it as data
loss, not cache eviction.

On top of the share links, a lost DB also costs:

- Host OAuth sessions (hosts have to sign in again — no data loss).
- Any outbox rows that hadn't yet flushed to a PDS (normally ~zero at any
  instant; see the outbox note in the environment table below).
- Guest edit-link tokens (a guest who lost their link submits fresh; no
  data loss, just an inconvenience).

*v1.1 notes:* put the host DID in the share URL (`/p/<did>/<rkey>`) so a poll
page is self-describing and the cache is genuinely rebuildable from the PDSes
— that, plus a `poll_cache` repair path, is what would make this DB
disposable for real.

## 1. Environment

All configuration is via environment variables, read once at boot in
`src/index.ts`. There is no config file.

| Variable | Required in prod | Default | Notes |
|---|---|---|---|
| `PORT` | no | `8787` | TCP port the Node process listens on. Caddy proxies to this. |
| `PUBLIC_URL` | **yes** | `http://localhost:8787` | The externally-visible origin, no trailing slash — e.g. `https://poll.wzrdz.cool`. Used to build the OAuth `redirect_uri`, `client_id`, and `jwks_uri`, and to render share links. Leaving this at the `localhost` default in production breaks OAuth and produces poll links nobody outside the box can open. |
| `DB_PATH` | no | `./wzrdz-poll.db` | Path to the SQLite file. Point this at a persistent volume outside the deploy directory if you ever redeploy by replacing `/opt/wzrdz-poll` wholesale. |
| `COOKIE_SECRET` | **yes** | `dev-cookie-secret` | Signs the session cookie (`hono/cookie`'s signed-cookie HMAC). Use a random string, 32+ characters — e.g. `openssl rand -base64 32`. The insecure default is fine for local dev only, and the server refuses to boot on it (see below). |
| `SESSION_ENC_KEY` | **yes** | `00`×32 (all-zero) | 32-byte AES-256-GCM key, **hex-encoded (64 hex characters)** — this encrypts OAuth session/state rows at rest in the DB (`src/db/sessions.ts` does `Buffer.from(keyHex, 'hex')`). Generate with `openssl rand -hex 32`. The all-zero default is a real key, not a "disabled" sentinel — and, like the cookie default, the server refuses to boot on it. |
| `OAUTH_JWK` | **yes** (non-loopback `PUBLIC_URL`) | unset | A single ES256 private JWK, as JSON, produced by `npx tsx scripts/genJwk.ts`. Used for `private_key_jwt` client authentication to the PDS/authorization server when `PUBLIC_URL` is a real https origin. Ignored when `PUBLIC_URL` is a loopback address (see the dev sign-in note below). Generate it once and store it in your secrets, not in git. |
| `LEX_HANDLE` | only when publishing lexicons | unset | The wzrdz.cool atproto account's handle, for `scripts/publishLexicons.ts`. Not read by the server. |
| `LEX_APP_PASSWORD` | only when publishing lexicons | unset | An **app password** (not the account password, not OAuth) for that account. Not read by the server. |
| `LEX_PDS` | no | `https://bsky.social` | The PDS/entryway to authenticate `publishLexicons.ts` against. Only change this if the wzrdz.cool account lives on a self-hosted PDS. |
| `FAKE_PDS` | never in prod | unset | Dev/test-only. `1` swaps every atproto call for an in-process fake repo and mounts a password-free `/dev/login` route. `src/index.ts` prints a warning banner when this is on. **Do not set this in a deployment.** |

Generate the two secrets and the JWK once, keep them in whatever secrets
store you use (a `.env` file with restrictive permissions is fine for a
single-host deploy), and never commit them — `.gitignore` already excludes
`.env` and `*.db*`.

```bash
openssl rand -base64 32     # -> COOKIE_SECRET
openssl rand -hex 32        # -> SESSION_ENC_KEY
npx tsx scripts/genJwk.ts   # -> OAUTH_JWK (prints one line of JSON)
```

Unless `FAKE_PDS=1`, `src/index.ts` checks these two at boot and exits 1 with
a list of what's wrong if `COOKIE_SECRET` is still `dev-cookie-secret`, or if
`SESSION_ENC_KEY` isn't 64 hex characters or is still all zeroes. A unit that
won't start with "refusing to boot without real secrets:" in the journal is
missing its `EnvironmentFile`, not broken.

### Before you build

`public/grid.js` is gitignored and not checked in — it's the esbuild bundle
of the Preact grid island (`src/web/static/grid.tsx`), served as a static
file by `serveStatic` in `src/web/server.ts`. **Run the build before starting
the server, and after every deploy of new source:**

```bash
npm ci
npm run build:grid
```

If you skip this, the app boots fine but every poll/create/results page loads
with a broken grid (404 on `/grid.js`).

### A local dev-sign-in quirk

If you run the server locally with a real (non-`FAKE_PDS`) OAuth flow, use
`PUBLIC_URL=http://127.0.0.1:8787`, not `http://localhost:8787`. RFC 8252
requires a loopback OAuth `redirect_uri` to use the IP literal `127.0.0.1`
even though the loopback client metadata's `client_id` is spelled with
`localhost` — `src/atproto/oauthClient.ts` handles this rewrite for the
redirect URI, but the page you open your browser to (and the cookie/session
origin the app itself sees) still has to be `127.0.0.1` for the round trip to
line up. Opening `localhost:8787` in the browser while `PUBLIC_URL` is set to
`127.0.0.1` (or vice versa) produces a session cookie the callback can't see.

## 2. systemd unit

Run as an unprivileged user, restart on failure, load secrets from an
`EnvironmentFile`:

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

Deploy steps for a new release, in order:

```bash
sudo -u wzrdzpoll git -C /opt/wzrdz-poll pull
sudo -u wzrdzpoll bash -c 'cd /opt/wzrdz-poll && npm ci && npm run build:grid'
sudo systemctl restart wzrdz-poll
sudo systemctl status wzrdz-poll --no-pager
```

`/opt/wzrdz-poll/.env` holds `PUBLIC_URL`, `DB_PATH`, `COOKIE_SECRET`,
`SESSION_ENC_KEY`, `OAUTH_JWK`, and `PORT` if you don't want the default.
Leave `FAKE_PDS` unset. Make sure `DB_PATH` points somewhere that survives a
`git pull` (e.g. outside the working tree, or listed in `.gitignore`, which
`*.db`/`*.db-*` already cover for the default in-tree path).

## 3. Caddy

```
poll.wzrdz.cool {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8787
}
```

`encode zstd gzip` compresses the responses on the way out: the app serves
server-rendered HTML plus the (minified) grid bundle, and neither Hono nor
the Node adapter compresses anything itself.

The rest is enough — Caddy terminates TLS and, by default, sets
`X-Forwarded-For` on the request it forwards to the backend, appending the
real client IP as the last hop of that header. This matters concretely: the
guest-submission rate limiter in `src/web/routes/polls.ts`
(`app.post('/p/:rkey/respond', ...)`) reads `x-forwarded-for`, splits on
commas, and takes the **last** entry as the client IP:

```ts
const xff = c.req.header('x-forwarded-for');
const ip = xff ? xff.split(',').pop()!.trim() : 'local';
```

Because Caddy appends the real client IP as the last hop rather than trusting
whatever a client sent, a request forged with a fake `X-Forwarded-For`
prefix can't rotate the rate-limit bucket key — the limiter only ever sees
the hop Caddy itself added. If you ever put another proxy in front of Caddy,
confirm it preserves this "append, don't replace" behavior, or the limiter
degrades to keying everything under whatever the outer proxy sends.

## 4. Publishing the lexicons

The two custom record schemas (`cool.wzrdz.poll.schedule` and
`cool.wzrdz.poll.response`, in `lexicons/`) need to be discoverable per the
atproto lexicon-publishing convention: a DNS TXT record naming the owning
DID, plus a `com.atproto.lexicon.schema` record for each schema in that DID's
repo. This is a one-time (or one-time-per-schema-change) admin task, not
something the running server does.

1. **Add the DNS TXT record.** In the `wzrdz.cool` zone, add:

   ```
   _lexicon.wzrdz.cool.  TXT  "did=did:plc:<the wzrdz.cool account DID>"
   ```

   Look up the DID with `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=wzrdz.cool` (or whatever handle the account uses) if you don't already have it recorded.

2. **Get an app password.** Log into the wzrdz.cool atproto account and
   create an app password (Settings → App Passwords). Do **not** use the
   account's main password — `publishLexicons.ts` uses `agent.login()`,
   which is fine with an app password and doesn't need OAuth ceremony for a
   one-shot admin script.

3. **Run the publish script:**

   ```bash
   LEX_HANDLE=wzrdz.cool LEX_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
     npx tsx scripts/publishLexicons.ts
   ```

   Add `LEX_PDS=...` only if the account isn't on `bsky.social`. Expect two
   lines of output, one per lexicon:

   ```
   published cool.wzrdz.poll.schedule -> at://did:plc:.../com.atproto.lexicon.schema/cool.wzrdz.poll.schedule
   published cool.wzrdz.poll.response -> at://did:plc:.../com.atproto.lexicon.schema/cool.wzrdz.poll.response
   ```

   The script exits 1 with a usage message if `LEX_HANDLE`/`LEX_APP_PASSWORD`
   are missing, so it's safe to invoke accidentally in an empty shell — it
   won't try to log in with nothing.

4. **Verify.**

   ```bash
   dig TXT _lexicon.wzrdz.cool +short
   # -> "did=did:plc:..."

   curl -s 'https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=did:plc:...&collection=com.atproto.lexicon.schema&rkey=cool.wzrdz.poll.schedule' | jq .
   ```

   Repeat the `getRecord` check for `cool.wzrdz.poll.response`. Both should
   return the full lexicon JSON with `$type: "com.atproto.lexicon.schema"`
   added.

Re-run the script (same rkeys, since `rkey = lex.id`) whenever a lexicon JSON
changes — `putRecord` overwrites in place.

## 5. Real-PDS smoke test

There is no containerized atproto dev-env integration test in this repo (see
the design spec) — the substitute is this manual checklist, run once against
the real deployment before announcing it, and again after any change that
touches OAuth, record writing, or finalization.

**Pre-flight — confirm `jwks_uri` actually resolves.** With a real (non-loopback) `PUBLIC_URL`, the OAuth client metadata built in `src/atproto/oauthClient.ts` advertises `token_endpoint_auth_method: 'private_key_jwt'` and a `jwks_uri` of `${PUBLIC_URL}/oauth/jwks.json` — the authorization server fetches that URL to verify the JWTs the app signs with `OAUTH_JWK`. `src/web/routes/auth.ts` serves that route from the client's keyset (public halves only). Check it before testing sign-in:

```bash
curl -s https://poll.wzrdz.cool/oauth/jwks.json | jq .
# -> {"keys":[{"kty":"EC","crv":"P-256","x":"...","y":"...","kid":"...","alg":"ES256",...}]}
```

An empty `keys` array means `OAUTH_JWK` never reached the process (check the `EnvironmentFile`) — token exchange, and therefore every real non-`FAKE_PDS` sign-in, will fail. A `d` member in any key means a private key is being published: stop and fix that before anything else.

Once that's confirmed:

1. Deploy with real environment variables (not `FAKE_PDS`).
2. Sign in with a real handle via `/login` → OAuth. Confirm the redirect
   lands back on `/` signed in (no `/dev/login` involved — that route only
   exists when `FAKE_PDS=1`).
3. Create a poll from `/new`. Confirm the create form redirects to the new
   poll's `/p/<rkey>` page.
4. Verify the `cool.wzrdz.poll.schedule` record actually landed in your own
   PDS — don't just trust the app's cache:

   ```bash
   curl -s 'https://<your-pds>/xrpc/com.atproto.repo.getRecord?repo=<your-did>&collection=cool.wzrdz.poll.schedule&rkey=<rkey>' | jq .
   ```

   or paste `at://<your-did>/cool.wzrdz.poll.schedule/<rkey>` into
   [pdsls.dev](https://pdsls.dev). Confirm `title`, `time`, `status`, and
   `createdAt` match what you entered.
5. Open the poll's `/p/<rkey>` URL in a **private/incognito window** (no
   session) and submit a guest response: a name and a painted grid.
6. Verify the response record landed in the **host's** repo (guest
   responses are host-attested, written with the host's OAuth session, per
   the design), with `guest.name` set to what you typed:

   ```bash
   curl -s 'https://<host-pds>/xrpc/com.atproto.repo.listRecords?repo=<host-did>&collection=cool.wzrdz.poll.response' | jq .
   ```

   Find the record whose `subject` strongRef points at the schedule record
   from step 4, and confirm `guest.name` and `available[]` look right.
7. As the host, finalize the poll (pick a slot from the ranked results).
   Confirm the poll page flips to "decided" mode showing the chosen slot.
8. Verify the `community.lexicon.calendar.event` record's field names
   against the schema published at
   [github.com/lexicon-community/lexicon](https://github.com/lexicon-community/lexicon)
   — `src/services/polls.ts` (`finalizePoll`) has a `NOTE for the
   implementer` comment flagging that only `name` is asserted by the test
   suite; `startsAt`/`endsAt`/`description`/`createdAt` need a manual diff
   against the real schema before this step is considered passed. Fetch the
   record the same way as step 4/6 (`collection=community.lexicon.calendar.event`)
   and compare field-by-field.
9. Download the ICS file from the decided page (or its `webcal:` link) and
   import it into an actual calendar app (Google Calendar's "Import" screen,
   Apple Calendar's File → Import, or similar). Confirm the event appears
   with the right title, start/end time, and timezone.

If any step fails, do not consider the deploy announcement-ready — fix
forward and re-run the whole checklist from step 2, since OAuth, the outbox,
and finalization all interact.

## 6. Known limits

Carried over from the design spec (`docs/superpowers/specs/2026-08-31-wzrdz-poll-design.md`) — these are intentional v1 scope cuts, not bugs:

- **No notifications.** Nobody gets emailed or pinged when a poll is created, someone responds, or a poll is finalized. Hosts and respondents have to check back on the poll page themselves.
- **No calendar OAuth.** The app never talks to Google/Microsoft calendar APIs (deliberately — "the scope trap"). The only calendar interop is the ICS/webcal export and the `community.lexicon.calendar.event` atproto record on finalize.
- **OAuth scope is `atproto transition:generic`**, not a narrower `cool.wzrdz.poll.*`-scoped grant — atproto's scope model doesn't yet support per-collection write scoping, so a host's sign-in grants the app the same broad write access any `transition:generic` app gets.
- **Response cap is 60 per poll**, fixed in v1 (`GUEST_CAP` in `src/services/responses.ts`). Despite the name it counts *every* response row — guest and signed-in alike — so 60 signed-in responses lock guests out of the same poll entirely. The 61st new response is rejected with "this poll is full" (edits to an existing response still go through at the cap); there's no UI to raise it per-poll.
- **Painting the grid is pointer-only.** The cells respond to mouse/touch drag and nothing else: there is no keyboard interaction and no screen-reader affordance, so keyboard and assistive-technology users cannot submit a response in v1 at all. Planned for v1.1 (focusable cells, arrow-key/space painting, and an accessible non-grid fallback for entering availability).

Also out of scope for v1 (unaffected by anything in this runbook, but worth
knowing when triaging a bug report): recurring polls, teams/orgs, billing,
native apps, a Discord bot, deadlines UI, and a reusable cross-poll
availability profile. Public poll discovery is also out — there is no
firehose/Jetstream indexing, so polls are only reachable by whoever has the
share link.
