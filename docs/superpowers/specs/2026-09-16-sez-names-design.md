# sez names — design

`ken.sez.letsmeet.lol` as the address of a person's standing availability, backed by one
wildcard certificate and nginx, replacing the per-handle on-demand-TLS alias from the
standing-availability spec (`2026-09-16-standing-availability-design.md`, "Host alias").

## Why this shape

The first alias design served `ken.wzrdz.cool.sez.letsmeet.lol`: the handle verbatim, every
label of it. A certificate only covers one label under a wildcard, so every handle needed
its own certificate, minted on first visit, which forced Caddy's on-demand TLS onto a box
that otherwise runs nginx for eleven sites. That is more infrastructure than the feature
deserves.

One label under `sez.letsmeet.lol` is covered by a single `*.sez.letsmeet.lol` certificate
forever. So the alias becomes one label, and the label is either a **claimed short name**
(`ken`) or, for anyone who has not claimed one, the **hyphenated handle**
(`ken-wzrdz-cool`). Both resolve to the same friend view and feed.

Decisions taken with Ken on 2026-09-16: short names are first come, first served; a
released name is free immediately (scale makes a hold pointless); a name is claimed by
saving availability, and an empty record is fine.

## The name

- Lowercase `a–z`, `0–9`, hyphen. 1 to 32 characters. No leading or trailing hyphen, no
  `--` anywhere (keeps the hyphenated-handle fallback unambiguous, see below).
- Unique across letsmeet, case-insensitive (stored lowercase).
- Reserved and never claimable: `www`, `api`, `app`, `admin`, `mail`, `smtp`, `imap`,
  `ftp`, `ns1`, `ns2`, `sez`, `letsmeet`, `letssuite`, `letseat`, `letsyeet`, `status`,
  `docs`, `dev`, `test`, `internal`, `internal-tls`, `u`, `p`, `availability`, plus
  anything that, read as a hyphenated handle, would decode to a handle that resolves to a
  DID other than the claimant's (so nobody claims `ken-wzrdz-cool` out from under Ken).

## The fallback: hyphenated handle

`ken.wzrdz.cool` → `ken-wzrdz-cool`. Dots become hyphens. A handle that itself contains a
hyphen (`foo-bar.bsky.social`) is encoded the same way (`foo-bar-bsky-social`), which is
why decoding must try candidates.

Decoding a label with no claimed name: enumerate the ways to turn hyphens back into dots
(a label with *n* hyphens has 2ⁿ candidates; `MAX_FALLBACK_CANDIDATES = 16`, so labels with
more than four hyphens are not decoded and answer 404), keep only well-formed handles
(each label non-empty, at least two labels), resolve each in order, first DID wins. The
first successful decode is cached in `sez_names` as an *implicit* row (`claimed = 0`) so it
is one lookup next time. Implicit rows are never shown to the owner as "their name" and are
overwritten silently by an explicit claim of the same label.

## Storage

A new table, **not** disposable — same class as `poll_cache` (it is what maps a share to a
person and cannot be rebuilt from the network):

```sql
CREATE TABLE IF NOT EXISTS sez_name (
  name       TEXT PRIMARY KEY,           -- lowercase label
  did        TEXT NOT NULL,
  claimed    INTEGER NOT NULL DEFAULT 1, -- 1 = the owner chose it; 0 = decoded fallback
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sez_name_did_claimed ON sez_name(did) WHERE claimed = 1;
```

One claimed name per DID (the partial unique index). Any number of implicit rows may point
at a DID (a handle change produces a new fallback label; the old one keeps working until
the old handle stops resolving to that DID, at which point a lookup re-resolves and the row
is deleted).

The chosen name is also written into the availability record in the PDS as an optional
`alias` field (lexicon `lol.letsmeet.availability`, `"alias": { "type": "string",
"maxLength": 32 }`). The record says what its owner claimed; the table enforces uniqueness
and is the index a visit reads. If the two disagree (table lost and rebuilt), the table
wins for routing and the editor shows the owner that their claim is gone.

## Claiming

- The `/availability` editor gains a "your address" field above the grid: a text input
  showing `<name>.sez.letsmeet.lol` with the name editable. Prefilled with the owner's
  current claimed name; if none, with the first label of their handle when that name is
  free and not reserved, otherwise with the hyphenated handle (which is always theirs).
- Validation as the person types is client-side shape only; availability of the name is
  checked on save (`POST /availability`, which already exists — the body gains
  `alias?: string`).
- On save: normalise (lowercase, trim); if empty → release any claimed name (delete the
  row) and clear `alias` in the record; if unchanged → nothing; else in one transaction:
  refuse if reserved (`UserError: that name is reserved.`), refuse if another DID holds it
  (`UserError: that name is taken.`), delete this DID's previous claimed row, upsert the
  new one with `claimed = 1`, then write the record with `alias` set. If the PDS write
  fails after the table changed, roll the table back (the transaction wraps both; the PDS
  write happens inside it, and a failure throws out of the transaction).
- Rate limit: the existing save limiter covers it (a claim is a save).
- The editor's live sentence under the grid gains a second line:
  `your address: ken.sez.letsmeet.lol` (lowercase, "mark" vocabulary unaffected).

## Resolving a visit

Host `X.sez.letsmeet.lol` (case-insensitive, trailing dot stripped, exactly one label
before the suffix — anything with more labels is 404, since no certificate covers it):

1. Look up `X` in `sez_name`. Hit → that DID.
2. Miss → decode `X` as a hyphenated handle (above). Hit → cache implicit row, that DID.
3. Miss → 404 with the existing "unknown handle" page.

Then serve exactly what `/u/<handle>` serves for that DID (friend view at `/`, feed at
`/availability.ics`, static assets), with `canonical` and the feed links pointing at the
apex `/u/<handle>` as today. The alias host answers nothing else (existing
`aliasHostOnly` middleware, unchanged in intent).

The landing block and the friend view show the sez address when the owner has claimed
one (`ken.sez.letsmeet.lol`), otherwise the hyphenated form.

## What goes away

- `deploy/Caddyfile`, the `/internal/tls-ask` route, `isLoopbackPeer`, `askLimiter`, and
  their tests.
- The multi-label alias parsing (`aliasHandleOf` becomes single-label).
- The deploy doc's "Caddy for the alias host" subsection, replaced by the recipe below.

## Certificate and proxy

- DNS: the wildcard `A *.sez.letsmeet.lol → 172.232.27.10` already exists (added
  2026-09-16). Add the matching `AAAA` to the box's IPv6 if the apex has one.
- Certificate: `*.sez.letsmeet.lol` via certbot **DNS-01** using Marque's certbot
  auth/cleanup hooks and a dedicated `MARQUE_DNS01_TOKEN` (the zone is on mqdns via
  marque.at). Wildcards cannot use HTTP-01. Renewal is certbot's normal timer with the same
  hooks. The token lives in `/etc/letsencrypt/marque.env`, mode 600, root-owned.
- nginx: one more server block, `server_name *.sez.letsmeet.lol;`, identical to the
  `letsmeet.lol` block (same headers, body cap, rate limit zone, `/internal/` 404, proxy to
  `127.0.0.1:8787`) but with the wildcard certificate paths. Lives in
  `deploy/nginx-letsmeet.lol.conf` next to the apex block so the two stay in step.
- Nothing else on the box changes. nginx stays the front for every site.

## Out of scope

- `<name>.sez.letsmeet.lol/for/<poll>` (pretty poll URLs). Designed to slot in later.
- Holding a released name for its previous owner.
- Transferring a name between DIDs.
- Moving the box to Caddy (a separate decision about the other ten sites).

## Testing

- Unit: name validation and reserved list; hyphen encode/decode with candidate order and
  the 16-candidate cap; table claim/release/uniqueness including the partial index.
- Routes: claim on save (new, taken, reserved, release, unchanged); alias host resolves a
  claimed name, a fallback label, an unknown label, and a multi-label host; canonical and
  feed links on the alias host; nothing but the two paths and assets answers there.
- e2e: claim a name in the editor, visit `<name>.sez…` via a Host header override in the
  Playwright request context, see the friend view.
- Deploy checklist: certbot dry run for the wildcard, `nginx -t`, curl the alias with the
  real hostname after DNS resolves.
