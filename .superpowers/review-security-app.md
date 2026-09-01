# Security review — application source (2026-09-01)

Verdict: No RCE/SQLi/XSS, crypto sound. But the in-flight returnTo change ships
an exploitable open redirect, and response/poll-page paths let an
unauthenticated user burn unbounded CPU/outbound requests.

## HIGH
- H1 auth.ts:40 open redirect: safeReturnTo regex `/^\/(?!\/)/` accepts
  `/\evil.com` (backslash = slash in URL special-scheme parsing). Genuine
  letsmeet.lol sign-in ends on evil.com. Fix: parse with `new URL(v, base)`
  and require origin === base.
- H2 responses.ts snapPaint runs O(slots×intervals) BEFORE the lexicon 200
  cap; ~15k disjoint intervals → ~67M comparisons ×2, single-threaded. Fix:
  reject >400 intervals at top of snapPaint/route.
- H3 POST /respond-auth has NO rate limit (its guest twin does); any free
  Bluesky account loops it, each call = several PDS round trips + snapPaint.
  Fix: TokenBucket keyed on session DID; extend to /polls and /finalize.
- H4 GET /p/:rkey fans out N sequential PDS fetches (up to 1+20N), unauth,
  uncached — self-DoS and an amplification reflector against third-party
  PDSes. Fix: response_cache TTL, bounded Promise.all + deadline, per-IP limit.

## MEDIUM
- M1 Hono signed cookies don't bind the cookie NAME; `handle` value re-sent as
  `did` verifies. Blocked today only by the handle regex excluding colons.
  Fix: sign {n,v} or collapse to one session cookie.
- M2 session cookie is a bearer token, no expiry/nonce/server row; logout
  doesn't revoke. Fix: sign {did,iat,jti} + session table.
- M3 SSRF: DID-doc serviceEndpoint fetched with no scheme/address restriction,
  redirects followed → 127.0.0.1 / 169.254.169.254. Fix: require https, block
  private ranges, redirect:'manual'.
- M4 `handle` cookie is a user-typed claim, not the authenticated handle
  (resolver accepts a service URL). Display-only today. Fix: derive from
  session after callback.
- M5 free-text timezone (or bad date) throws in materializeSlots outside any
  try/catch → poll page 500s forever, no edit/delete. Fix: validate tz+date at
  creation; wrap renderPoll.
- M6 no app-level body size limit; only nginx default 1MB (implicit). Fix:
  hono bodyLimit + explicit client_max_body_size.
- M7 outbox and edit_secret never pruned; alternating repaints defeat the
  dedupe and write to the host's repo at 6/min/IP, bypassing GUEST_CAP on the
  edit branch. Fix: prune done outbox rows + edit_secret TTL, rate-limit edits.

## LOW/NOTE
- L1 ics.ts esc() misses bare \r → ICS injection in title; also no 75-octet
  folding. L2 no CSP/nosniff/frame-ancestors (finalize form clickjackable).
  L3 error .message echoed to clients (polls.ts). L4 CSRF rests only on
  SameSite=Lax. L5 limiter fallback key 'local' shared if reached direct.
  L6 COOKIE_SECRET boot check is exact-match only (no min length). L7 edit
  tokens in URL path. L8 pdsCache never evicts.

## Checked and sound
Prepared statements throughout (incl. new listPollsByHost); AES-256-GCM
sessions correct (per-op IV, auth tag); edit tokens 256-bit, SHA-256 stored,
scoped by poll_uri; scriptJson escapes every `<`; host authz enforced
server-side in loadOwned (finalize/edit), isHost is presentation-only;
finalize re-derives slots and blocks double-finalize; guest rkey never
client-supplied; serveStatic traversal-safe; /dev/login gated on FAKE_PDS;
JWKS public-only; rate limiter internals bounded; materializeSlots hard-capped.

## Status (2026-09-01, later the same day)

Every finding above is addressed in `076aaa5` (app) — H1/M1 earlier in
`85158fc`. Residuals worth knowing: DNS rebinding after the pre-connect check
(M3) is narrowed, not closed — it needs a pinned-address dispatcher; edit
tokens still travel in the URL path by design (L7), now with a referrer
policy that never sends the path cross-origin; CSRF (L4) is
Sec-Fetch-Site-first with an Origin fallback and SameSite=Lax underneath.
