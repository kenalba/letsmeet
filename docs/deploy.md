# Deploying letsmeet

letsmeet is a single Node process (Hono, server-rendered pages + a couple of
React islands — the availability grid and the create-form date picker)
backed by SQLite. It runs as a Docker container behind nginx at
`letsmeet.lol` on the Linode box (§2–3), or on any small VPS.

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
- Browser sessions (everyone is signed out — no data loss).
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
| `PORT` | no | `8787` | TCP port the Node process listens on. nginx proxies to this (§3). |
| `PUBLIC_URL` | **yes** | `http://localhost:8787` | The externally-visible origin, no trailing slash — e.g. `https://letsmeet.lol`. Used to build the OAuth `redirect_uri`, `client_id`, and `jwks_uri`, and to render share links. Leaving this at the `localhost` default in production breaks OAuth and produces poll links nobody outside the box can open. |
| `DB_PATH` | no | `./letsmeet.db` | Path to the SQLite file. Point this at a persistent volume outside the deploy directory if you ever redeploy by replacing `/opt/letsmeet` wholesale. |
| `COOKIE_SECRET` | **yes** | `dev-cookie-secret` | Signs the session cookie (`hono/cookie`'s signed-cookie HMAC). Use a random string, 32+ characters — e.g. `openssl rand -base64 32`. The insecure default is fine for local dev only, and the server refuses to boot on it (see below). |
| `SESSION_ENC_KEY` | **yes** | `00`×32 (all-zero) | 32-byte AES-256-GCM key, **hex-encoded (64 hex characters)** — this encrypts OAuth session/state rows at rest in the DB (`src/db/sessions.ts` does `Buffer.from(keyHex, 'hex')`). Generate with `openssl rand -hex 32`. The all-zero default is a real key, not a "disabled" sentinel — and, like the cookie default, the server refuses to boot on it. |
| `OAUTH_JWK` | **yes** (non-loopback `PUBLIC_URL`) | unset | A single ES256 private JWK, as JSON, produced by `npx tsx scripts/genJwk.ts`. Used for `private_key_jwt` client authentication to the PDS/authorization server when `PUBLIC_URL` is a real https origin. Ignored when `PUBLIC_URL` is a loopback address (see the dev sign-in note below). Generate it once and store it in your secrets, not in git. |
| `LEX_HANDLE` | only when publishing lexicons | unset | The lexicon-authority account's **canonical** handle as it appears in its DID document (see §5 — `ken.wzrdz.cool`, not `wzrdz.cool`), for `scripts/publishLexicons.ts`. Not read by the server. |
| `LEX_APP_PASSWORD` | only when publishing lexicons | unset | An **app password** (not the account password, not OAuth) for that account. Not read by the server. |
| `LEX_PDS` | no | `https://bsky.social` | The PDS/entryway to authenticate `publishLexicons.ts` against. Only change this if the authority account lives on a self-hosted PDS. |
| `FAKE_PDS` | never in prod | unset | Dev/test-only. `1` swaps every atproto call for an in-process fake repo and mounts a password-free `/dev/login` route. `src/index.ts` prints a warning banner when this is on. **Do not set this in a deployment.** |

Generate the two secrets and the JWK once, keep them in whatever secrets
store you use (a `.env` file with restrictive permissions is fine for a
single-host deploy), and never commit them — `.gitignore` excludes `.env*`
(the glob, so an editor's `.env.save` or a `.env.bak` can't slip in) and
`*.db*`.

```bash
umask 077                   # everything below is created readable by you alone
openssl rand -base64 32     # -> COOKIE_SECRET
openssl rand -hex 32        # -> SESSION_ENC_KEY
# The JWK is a private key: write it straight into the env file rather than
# letting it land in a terminal scrollback.
printf 'OAUTH_JWK=%s\n' "$(npx tsx scripts/genJwk.ts)" >> .env
```

**`.env` is backup-critical, not just secret.** `SESSION_ENC_KEY` encrypts the
OAuth session rows in the database and `OAUTH_JWK` is the key the
authorization servers know this client by: a restored database without the
matching `.env` has no usable host sessions, and a new JWK means every host
signs in again. Keep a copy of `.env` wherever you keep the database backup.

Unless `FAKE_PDS=1`, `src/index.ts` checks these at boot and exits 1 with a
list of what's wrong if `COOKIE_SECRET` is still `dev-cookie-secret` or
shorter than 32 characters, or if `SESSION_ENC_KEY` isn't 64 hex characters
or is still all zeroes. A container that won't start with "refusing to boot
without real secrets:" in its logs is missing its `.env`, not broken. And
`FAKE_PDS=1` is refused outright when `NODE_ENV=production` (which the image
sets), so the fake repo and `/dev/login` cannot be switched on in a
deployment by a stray env line.

### Before you build

`public/assets/` is gitignored and not checked in — it's the build output
(`grid.js`, `createForm.js`, `app.css`), served as static files at `/assets/*`
by `serveStatic` in `src/web/server.ts`. `npm run build:client` chains the
three build steps (`build:grid`, `build:createform`, `build:css`) behind one
name. **Run it before starting the server, and after every deploy of new
source:**

```bash
npm ci
npm run build:client
```

If you skip this, the app boots fine but every page loads with 404s for
`/assets/grid.js`, `/assets/createForm.js`, and `/assets/app.css` — a broken
grid, a plain-text dates fallback on the create form, and unstyled markup.

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

## 2. Docker + CI/CD (the Linode box)

The deployment unit is the Docker image built by `Dockerfile`: a multi-stage
build that runs `npm ci` + `npm run build:client` (so `/assets/*` is baked
in — the "Before you build" section above is satisfied by the image itself),
prunes to production deps, and runs `tsx src/index.ts` as the unprivileged
`node` user under `tini`. The base image is pinned by digest (Dependabot
proposes bumps). The SQLite file lives at `/data/letsmeet.db` inside the
container, mounted from the host.

The pipeline (`.github/workflows/deploy.yml`) runs on every push to `main`,
and once a week on a schedule so the image is rebuilt on a current base even
when the code hasn't changed:

1. **test** — `npm audit` (production deps, high+), typecheck, the vitest
   suite, and the full Playwright matrix (chromium, firefox, tz-kolkata,
   mobile).
2. **build** — builds the image and pushes `ghcr.io/kenalba/letsmeet:<sha>`
   (plus `:latest`) using the workflow's own `GITHUB_TOKEN`. Only runs for
   `main`: a `workflow_dispatch` from another branch tests and stops.
3. **deploy** — SSHes to the box with plain OpenSSH (host key pinned, no
   third-party action holding the key) and sends exactly one line:
   `deploy <sha>`. Runs are serialized per branch, so two quick pushes land
   in order.

Every action in the workflow is pinned to a commit SHA, the workflow has
`permissions: contents: read` at the top (the build job raises `packages`
for itself; deploy has none), and checkouts don't persist credentials — the
test job runs third-party dev dependencies and must not be able to push.

The deploy job needs four repository secrets (Settings → Secrets → Actions):
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (a dedicated private key —
never a personal one), and `DEPLOY_KNOWN_HOSTS` (the box's host-key line,
from `ssh-keyscan -t ed25519 <host>`, cross-checked against a session you
trust).

**What the deploy key can do.** Its public half is in `authorized_keys` on
the box with a forced command and `restrict`:

```
restrict,command="/home/doceon/letsmeet/deploy.sh" ssh-ed25519 AAAA… letsmeet-deploy
```

Whatever the client sends is never executed — `deploy/deploy.sh` (this
repo's copy; installed at `~/letsmeet/deploy.sh`) reads it from
`SSH_ORIGINAL_COMMAND`, accepts only `deploy <40-hex commit>`, writes
`IMAGE_TAG=<sha>` into `~/letsmeet/.env` (which `compose.yaml` interpolates,
so any later `docker compose up` on the box means that commit, never a
moving `:latest`), pulls, starts, waits for the healthcheck (a build that
boots and dies fails the job instead of restart-looping), and removes older
letsmeet images. No pty, no forwarding, nothing else. The key is still a
member of the `docker` group's power by proxy — that is why the script is
the only thing it can invoke.

**One-time setup on the box:**

```bash
mkdir -p ~/letsmeet/data && chmod 700 ~/letsmeet ~/letsmeet/data
# uid 1000 is the container's `node` user; on this box that is also the login user.
# copy compose.yaml, deploy/deploy.sh and deploy/backup.sh from this repo into ~/letsmeet/
chmod 700 ~/letsmeet/deploy.sh ~/letsmeet/backup.sh
# create ~/letsmeet/.env (umask 077) with the §1 secrets:
#   PUBLIC_URL=https://letsmeet.lol
#   COOKIE_SECRET=...  SESSION_ENC_KEY=...  OAUTH_JWK=...
# add the forced-command line above to ~/.ssh/authorized_keys
# nightly backup, keeps 14:
( crontab -l; echo "17 4 * * * $HOME/letsmeet/backup.sh >> $HOME/letsmeet/backup.log 2>&1" ) | crontab -
```

`~/letsmeet` is mode 700 because the box hosts other things: the SQLite file
holds poll titles, guest names and DIDs, and nothing else on the machine
needs to read it. The repo is public, so no `docker login` is needed to pull.

**The container runs locked down** (`compose.yaml`): read-only root
filesystem with a tmpfs `/tmp`, all capabilities dropped,
`no-new-privileges`, 512 MB memory and 256 pids, rotated json logs, and
`tini` as PID 1 so a `docker compose stop` is a clean shutdown (the outbox
flushes on its own timer; nothing is lost either way, but a clean stop is
the polite one). Leave `FAKE_PDS` unset and don't set `DB_PATH` in `.env` —
the image pins it to `/data/letsmeet.db`, and compose mounts
`~/letsmeet/data` there.

**Backups.** `backup.sh` takes an online SQLite backup through the running
container into `~/letsmeet/backups/letsmeet-<date>.db`, nightly, keeping the
last 14. That lands on the same disk as the live file, which covers a bad
deploy or a fat-fingered delete but not a lost VM — pull the newest one
somewhere else too. From any machine with SSH access to the box:

```bash
scp box:letsmeet/backups/letsmeet-$(date +%F).db ~/Backups/letsmeet/
scp box:letsmeet/.env ~/Backups/letsmeet/env   # once, and again whenever it changes
```

(§0 explains why the database matters; §1 explains why `.env` goes with it.)

**Rollback:** set `IMAGE_TAG=<known-good sha>` in `~/letsmeet/.env` and
`docker compose up -d`; the next successful deploy overwrites it.

## 3. nginx

The box fronts everything with nginx + certbot (not Caddy — the rest of the
box's vhosts already live in `/etc/nginx/sites-available/`). The letsmeet
vhost is `deploy/nginx-letsmeet.lol.conf` in this repo, installed at
`/etc/nginx/sites-available/letsmeet.lol`; the TLS lines in it are certbot's
(`sudo certbot --nginx -d letsmeet.lol` once DNS resolves to the box), the
rest is ours:

- **Security headers** (HSTS, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy`), set with `always` and with the app's own copies hidden
  via `proxy_hide_header`, so every response — including a 413, 502 or 503
  nginx generates itself — carries exactly one set. The Content-Security-Policy
  stays with the app: it carries a per-response nonce (`src/web/server.ts`).
- **`client_max_body_size 256k`**, matching `MAX_BODY_BYTES` in the app.
- **`limit_req`** at 20 req/s per address with a burst of 40, ahead of the
  app's own per-IP and per-DID token buckets.
- **Proxy hygiene:** HTTP/1.1 keepalive to the upstream, 5s connect and 30s
  read/send timeouts, so a stalled client or upstream can't hold a worker.

Static assets need no dedicated nginx location — Node itself serves
`/assets/*` straight out of `public/assets/` (baked into the image), so
`proxy_pass` alone covers it.

**The `X-Forwarded-For` contract.** The app's rate limiters
(`src/web/clientIp.ts`) take the **last** entry of `X-Forwarded-For` as the
client, and `$proxy_add_x_forwarded_for` appends the real client as the last
hop rather than trusting whatever a client sent — so a request forged with a
fake prefix can't rotate its bucket key. This holds because the app's port
is bound to `127.0.0.1` and only nginx reaches it from outside; anything
else running *on the box* could talk to `:8787` directly and set that header
to anything, which is a reason to keep the box's other services honest, not
something the app can check. Without the header at all (a direct local
call), the limiter keys on the socket's peer address. If you ever put
another proxy in front of nginx, confirm it preserves the "append, don't
replace" behavior.

## 4. Publishing the lexicons

The two custom record schemas (`lol.letsmeet.poll.schedule` and
`lol.letsmeet.poll.response`, in `lexicons/`) need to be discoverable per the
atproto lexicon-publishing convention: a DNS TXT record naming the owning
DID, plus a `com.atproto.lexicon.schema` record for each schema in that DID's
repo. This is a one-time (or one-time-per-schema-change) admin task, not
something the running server does.

1. **Add the DNS TXT record.** In the `letsmeet.lol` zone, add:

   ```
   _lexicon.letsmeet.lol.  TXT  "did=did:plc:<the letsmeet.lol account DID>"
   ```

   The owning DID can be any account you control — no dedicated
   `letsmeet.lol` account is required. The TXT record is what makes that
   DID the authority for `lol.letsmeet.*`. Look up a DID with
   `https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=<handle>`
   if you don't already have it recorded.

   **Done 2026-09-01:** the record points at
   `did:plc:s6bsxutpplnkmlllri6nif6d` (the `ken.wzrdz.cool` account) and
   both lexicons are published there. Repeat steps 2–4 only when a lexicon
   changes — `putRecord` overwrites in place.

2. **Get an app password.** Log into that account and
   create an app password (Settings → App Passwords). Do **not** use the
   account's main password — `publishLexicons.ts` uses `agent.login()`,
   which is fine with an app password and doesn't need OAuth ceremony for a
   one-shot admin script.

3. **Run the publish script:**

   ```bash
   LEX_HANDLE=<authority handle> LEX_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
     npx tsx scripts/publishLexicons.ts
   ```

   `LEX_HANDLE` has to be the handle in the account's DID document
   (`ken.wzrdz.cool`). A domain that merely resolves to the same DID (e.g.
   `wzrdz.cool`) is rejected with `Invalid identifier or password` — which
   reads like a bad app password but isn't. Add `LEX_PDS=...` only if the
   account isn't behind the `bsky.social` entryway. Delete the app password
   afterwards; the script is one-shot. Expect two lines of output, one per
   lexicon:

   ```
   published lol.letsmeet.poll.schedule -> at://did:plc:.../com.atproto.lexicon.schema/lol.letsmeet.poll.schedule
   published lol.letsmeet.poll.response -> at://did:plc:.../com.atproto.lexicon.schema/lol.letsmeet.poll.response
   ```

   The script exits 1 with a usage message if `LEX_HANDLE`/`LEX_APP_PASSWORD`
   are missing, so it's safe to invoke accidentally in an empty shell — it
   won't try to log in with nothing.

4. **Verify.**

   ```bash
   dig TXT _lexicon.letsmeet.lol +short
   # -> "did=did:plc:..."

   curl -s 'https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=did:plc:...&collection=com.atproto.lexicon.schema&rkey=lol.letsmeet.poll.schedule' | jq .
   ```

   Repeat the `getRecord` check for `lol.letsmeet.poll.response`. Both should
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
curl -s https://letsmeet.lol/oauth/jwks.json | jq .
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
4. Verify the `lol.letsmeet.poll.schedule` record actually landed in your own
   PDS — don't just trust the app's cache:

   ```bash
   curl -s 'https://<your-pds>/xrpc/com.atproto.repo.getRecord?repo=<your-did>&collection=lol.letsmeet.poll.schedule&rkey=<rkey>' | jq .
   ```

   or paste `at://<your-did>/lol.letsmeet.poll.schedule/<rkey>` into
   [pdsls.dev](https://pdsls.dev). Confirm `title`, `time`, `status`, and
   `createdAt` match what you entered.
5. Open the poll's `/p/<rkey>` URL in a **private/incognito window** (no
   session) and submit a guest response: a name and a painted grid.
6. Verify the response record landed in the **host's** repo (guest
   responses are host-attested, written with the host's OAuth session, per
   the design), with `guest.name` set to what you typed:

   ```bash
   curl -s 'https://<host-pds>/xrpc/com.atproto.repo.listRecords?repo=<host-did>&collection=lol.letsmeet.poll.response' | jq .
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
- **OAuth scope is `atproto transition:generic`**, not a narrower `lol.letsmeet.poll.*`-scoped grant — atproto's scope model doesn't yet support per-collection write scoping, so a host's sign-in grants the app the same broad write access any `transition:generic` app gets.
- **Response cap is 60 per poll**, fixed in v1 (`GUEST_CAP` in `src/services/responses.ts`). Despite the name it counts *every* response row — guest and signed-in alike — so 60 signed-in responses lock guests out of the same poll entirely. The 61st new guest response is rejected with "this poll is full" (edits to an existing response still go through at the cap); there's no UI to raise it per-poll.
- **Painting the grid is pointer-only.** The cells respond to mouse/touch drag and nothing else: there is no keyboard interaction and no screen-reader affordance, so keyboard and assistive-technology users cannot submit a response in v1 at all. Planned for v1.1 (focusable cells, arrow-key/space painting, and an accessible non-grid fallback for entering availability).

Also out of scope for v1 (unaffected by anything in this runbook, but worth
knowing when triaging a bug report): recurring polls, teams/orgs, billing,
native apps, a Discord bot, deadlines UI, and a reusable cross-poll
availability profile. Public poll discovery is also out — there is no
firehose/Jetstream indexing, so polls are only reachable by whoever has the
share link.
