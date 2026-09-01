# Security review — deployment/infrastructure surface (2026-09-01)

Verdict: No critical exposure and no vulnerable production dependency, but the
CI/CD path is the weak link — a floating-tag third-party action holds an SSH
key that is root-equivalent on a box hosting unrelated services.

## High
- H1 deploy.yml: every action pinned to a mutable tag; appleboy/ssh-action@v1
  holds DEPLOY_* secrets (tj-actions-style retag attack). Fix: pin all six
  actions to 40-char commit SHAs + Dependabot github-actions.
- H2 deploy key = docker group = root on a shared box, unrestricted login.
  Fix: authorized_keys forced command (command="/usr/local/bin/deploy-letsmeet",
  no-pty,restrict,...) running only the three docker commands.
- H3 no top-level `permissions:` — test/deploy jobs inherit repo default
  GITHUB_TOKEN scope; malicious postinstall in dev deps could push to main.
  Fix: top-level `permissions: contents: read`, `permissions: {}` on deploy,
  persist-credentials: false on test checkout.

## Medium
- M1 workflow_dispatch from any ref can overwrite :latest and deploy it.
  Fix: `if: github.ref == 'refs/heads/main'` on build+deploy (or environment
  with required reviewers).
- M2 prod deploys mutable :latest; box can't prove what's running. Fix:
  IMAGE_TAG variable in compose, deploy writes the sha.
- M3 FAKE_PDS backdoor ships in prod image, gated on one env var that also
  skips the secret guard. Fix: `&& process.env.NODE_ENV !== 'production'`.
- M4 no container hardening: mem_limit, pids_limit, cap_drop ALL,
  no-new-privileges, read_only+tmpfs, log rotation.
- M5 base image unpinned; rebuilds only on push — CVE staleness. Fix: cron
  schedule + digest pin + scan step.
- M6 backup lands on the same volume; .env (SESSION_ENC_KEY/OAUTH_JWK) never
  named as backup-critical — DB without .env is unrestorable. Fix: off-box
  backup + rotate + document .env.
- M7 ~/letsmeet 0755 on a shared box: any local user can read the sqlite db
  (poll titles, guest names, DIDs). Fix: chmod 700 ~/letsmeet ~/letsmeet/data;
  umask 077 when creating .env.
- M8 no HSTS/security headers anywhere (nginx or app). Fix: add_header HSTS,
  nosniff, Referrer-Policy, X-Frame-Options in TLS block; CSP as follow-up.
- M9 XFF rate-limit contract holds only via nginx; anything loopback-local
  (incl. SSRF in unrelated services on the box) controls XFF fully. Document;
  consider trusting XFF only from nginx.

## Low
- L1 .gitignore/.dockerignore ignore `.env` exactly, not `.env*` (nano .env.save!).
- L2 vhost hygiene: proxy_http_version 1.1, timeouts, client_max_body_size 64k,
  nginx-level limit_req, confirm a default_server 444 catch-all exists.
- L3 PID 1 is npx (3 processes above the server); deploys are hard kills —
  matters for outbox flush. Fix: CMD ./node_modules/.bin/tsx + init: true.
- L4 ssh-action: no fingerprint (host-key pin), no script_stop (failed pull
  still ups), no concurrency group (out-of-order deploys), prune is daemon-wide.
- L5 genJwk prints the private JWK to stdout/scrollback; document umask 077 +
  redirect straight to .env.

## Notes
- N1 docker bypasses ufw (loopback bind is right; check route_localnet=0,
  DOCKER-USER default deny). N2 no provenance verification on box. N3 no
  npm audit / image scan in CI. N4 compose.yaml + deploy.md intro still say
  Caddy. N5 docker login stores PAT base64 in ~/.docker/config.json.

## Dependencies (manual check vs advisories; re-verify with npm audit in CI)
- hono 4.13.5, undici 6.28.0/7.29.0, @hono/node-server 2.1.1, better-sqlite3
  13.0.3, jose 5.10.0, @atproto/* — all at/above patched versions; nothing open.

## Checked and sound
No fork-PR path to secrets (push+dispatch only); secrets never echoed; build
job token correctly scoped; image runs unprivileged with root-owned code (no
writable-code-path escalation); toolchain confined to build stage; nothing
sensitive can reach the image (no COPY . .); loopback port binding; env by
reference; healthcheck sane; boot-time secret validation; edit tokens hashed
and OAuth rows encrypted at rest; XFF last-hop contract correct via nginx;
§5 JWKS pre-flight is a genuinely good control.

## Status (2026-09-01, later the same day)

Addressed in the infra commit that follows `076aaa5`: actions pinned to SHAs
with Dependabot (H1); plain OpenSSH with a pinned host key and a forced
command on the box accepting only `deploy <sha>` (H2, L4, M2); top-level
`permissions: contents: read`, `permissions: {}` on deploy,
`persist-credentials: false` (H3); build/deploy gated to `main` (M1);
FAKE_PDS refused under NODE_ENV=production (M3); read-only/cap-drop/limits/
log rotation/tini (M4, L3); base image pinned by digest, weekly rebuild,
`npm audit` in CI (M5, N3); nightly online backup + `.env` documented as
backup-critical, off-box copy documented as the operator's step (M6);
`~/letsmeet` and data 700/600 (M7); headers at nginx with `always` (M8);
XFF trust documented (M9); `.env*` ignored (L1); vhost hygiene + limit_req
(L2); genJwk umask/redirect documented (L5); Caddy references gone (N4).
No docker login on the box (N5 n/a). N1: `route_localnet=0` confirmed, and
nothing is published beyond loopback.
