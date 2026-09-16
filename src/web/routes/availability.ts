import { createElement } from 'react';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Deps } from '../../atproto/types.js';
import { UserError } from '../../core/errors.js';
import { describeWeekly, isKnownZone } from '../../core/availability.js';
import { readSession, type SessionEnv } from '../session.js';
import { explain, page } from '../respond.js';
import { TokenBucket } from '../rateLimit.js';
import { clientIp, isLoopbackPeer } from '../clientIp.js';
import { buildAvailabilityIcs } from '../../core/ics.js';
import { getOwnAvailability, saveAvailability, getAvailabilityCached } from '../../services/availability.js';
import { AvailabilityPage } from '../pages/Availability.js';
import { PublicAvailabilityPage } from '../pages/PublicAvailability.js';
import { ErrorPage } from '../pages/ErrorPage.js';

/** A PDS refusing the write for want of scope: the session predates the availability scope. */
function needsReauth(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /scope|insufficient|forbidden|403/i.test(msg);
}

/** `.sez.<site>`: everything before it in an alias host is the handle. */
export const aliasSuffixFor = (publicUrl: string): string => '.sez.' + new URL(publicUrl).host;

/** A handle is dot-separated LDH labels — the only shape a certificate can be issued for. */
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * The handle `host` is an alias for: every label before `suffix`, verbatim. Null when the
 * host is not under the suffix at all, or when what precedes it is not handle-shaped —
 * `evil.example/?x=.sez.letsmeet.lol` ends in the suffix and is nobody's handle.
 */
export function aliasHandleOf(host: string | undefined, suffix: string): string | null {
  if (!host || !host.endsWith(suffix) || host.length === suffix.length) return null;
  const handle = host.slice(0, -suffix.length);
  return HANDLE_RE.test(handle) && handle.length <= 253 ? handle : null;
}

/**
 * An alias host answers the friend view and the feed, and nothing else — the app proper
 * lives on the apex. Mounted ahead of every route (web/server.ts) so nothing new escapes
 * it; the static files the friend view itself loads are the only other paths allowed.
 */
export function aliasHostOnly(publicUrl: string): MiddlewareHandler {
  const suffix = aliasSuffixFor(publicUrl);
  const PUBLIC_VIEW = new Set(['/', '/availability.ics']);
  const STATIC = /^\/(assets|fonts)\/|^\/(favicon\.(ico|svg)|favicon-32\.png|apple-touch-icon\.png)$/;
  return async (c, next) => {
    const path = c.req.path;
    if (aliasHandleOf(c.req.header('host'), suffix) && !PUBLIC_VIEW.has(path) && !STATIC.test(path)) {
      return c.notFound();
    }
    await next();
  };
}

export function availabilityRoutes(
  deps: Deps, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();
  const session: SessionEnv = {
    db: deps.db, cookieSecret: env.COOKIE_SECRET, secure: env.PUBLIC_URL.startsWith('https'),
  };
  // 20 saves per ten minutes per account: a save is two PDS round trips.
  const saveLimiter = new TokenBucket(20, 20 / 600);

  app.get('/availability', async (c) => {
    const who = await readSession(c, session, deps.now().getTime());
    if (!who) return c.redirect('/login?returnTo=%2Favailability');
    let record = null;
    // A PDS that will not answer must not cost the viewer the editor: it opens empty, with
    // a line saying a save overwrites whatever is up there.
    let readFailed = false;
    try {
      record = await getOwnAvailability(deps, who.did);
    } catch (err) {
      console.warn(`own availability read failed for ${who.did}:`, err);
      readFailed = true;
    }
    return page(c, createElement(AvailabilityPage, {
      did: who.did, handle: who.handle ?? undefined, record, readFailed, publicUrl: env.PUBLIC_URL,
    }));
  });

  app.post('/availability', async (c) => {
    const who = await readSession(c, session, deps.now().getTime());
    if (!who) return c.json({ error: 'sign in first' }, 401);
    if (!saveLimiter.allow(who.did, deps.now().getTime())) {
      return c.json({ error: 'easy there. try again in a minute.' }, 429);
    }
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') return c.json({ error: 'malformed request body.' }, 400);
    try {
      const { record, written } = await saveAvailability(deps, who.did, body);
      return c.json({ ok: true, written, sentence: describeWeekly(record.weekly) });
    } catch (err) {
      // A UserError is our own complaint about the posted body — never the PDS's about the
      // token — even when its wording happens to trip the scope pattern.
      if (needsReauth(err) && !(err instanceof UserError)) {
        console.error('availability save refused by PDS:', err);
        return c.json({
          error: 'sign in again to post your availability (this app needs a new permission).',
        }, 403);
      }
      return c.json({ error: explain(err, 'saveAvailability') }, 400);
    }
  });

  // 120 public reads per ten minutes per address: each cold read is a PDS round trip.
  const readLimiter = new TokenBucket(120, 120 / 600);

  /** The DID behind `/u/<handle>`, or null. Fake mode has no resolver and takes a DID literal. */
  const didFor = async (handle: string): Promise<string | null> => {
    if (handle.startsWith('did:')) return /^did:(plc|web):[a-zA-Z0-9._:%-]+$/.test(handle) ? handle : null;
    return deps.resolveDid ? deps.resolveDid(handle) : null;
  };

  /** Resolve + read, or the response that says why not. Shared by the page and the feed. */
  const lookup = async (c: import('hono').Context, handle: string) => {
    if (!readLimiter.allow(clientIp(c), deps.now().getTime())) {
      return { deny: page(c, createElement(ErrorPage, { heading: 'slow down', message: 'easy there. try again in a minute.' }), 429) };
    }
    const did = await didFor(handle);
    if (!did) return { deny: c.notFound() };
    try {
      return { handle, did, record: await getAvailabilityCached(deps, did) };
    } catch (err) {
      console.error(`availability read failed for ${did}:`, err);
      return { deny: page(c, createElement(ErrorPage, {
        heading: 'their pds is not answering', message: "couldn't reach their pds right now. try again in a minute.",
      }), 503) };
    }
  };

  /** The friend view for `handle`. Shared by `/u/:handle` and the `<handle>.sez.<site>` alias. */
  const friendView = async (c: import('hono').Context, handle: string) => {
    const r = await lookup(c, handle);
    if ('deny' in r) return r.deny;
    return page(c, createElement(PublicAvailabilityPage, {
      handle: r.handle, did: r.did, record: r.record, now: deps.now(), publicUrl: env.PUBLIC_URL,
    }));
  };

  /** The ICS feed for `handle`. Shared by `/u/:handle/availability.ics` and the alias. */
  const feed = async (c: import('hono').Context, handle: string) => {
    const r = await lookup(c, handle);
    if ('deny' in r) return r.deny;
    // Every DTSTART in the feed is anchored to the record's timezone. One this app cannot
    // read has no feed to serve — the page says as much in words.
    if (!r.record || !isKnownZone(r.record.timezone)) return c.notFound();
    const ics = buildAvailabilityIcs(r.record, {
      uidHost: new URL(env.PUBLIC_URL).host, name: r.handle, now: deps.now(),
    });
    return c.body(ics, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'public, max-age=900',
    });
  };

  app.get('/u/:handle', (c) => friendView(c, c.req.param('handle')));
  app.get('/u/:handle/availability.ics', (c) => feed(c, c.req.param('handle')));

  // `<handle>.sez.<site>`: an alternate host that serves the same friend view and feed as
  // `/u/<handle>`, so a share can read `ken.wzrdz.cool.sez.letsmeet.lol` instead of a path.
  // A wildcard DNS record and Caddy's on-demand TLS (deploy/Caddyfile, docs/deploy.md §3)
  // are what make the certificate exist; this dispatch is what makes the host answer.
  const aliasSuffix = aliasSuffixFor(env.PUBLIC_URL);
  const aliasHandle = (host: string | undefined): string | null => aliasHandleOf(host, aliasSuffix);

  app.get('/', async (c, next) => {
    const handle = aliasHandle(c.req.header('host'));
    if (!handle) return next();
    return friendView(c, handle);
  });
  app.get('/availability.ics', async (c, next) => {
    const handle = aliasHandle(c.req.header('host'));
    if (!handle) return next();
    return feed(c, handle);
  });

  /**
   * One ask per handle per thirty seconds is far more than Caddy needs (it asks once, on
   * the first handshake for a name it has no certificate for), and the key is the domain
   * being asked about — the thing an attacker varies — so a flood of made-up names can
   * never spend the budget a real first visit needs. Keying on the caller instead would
   * pool every legitimate ask into one bucket, since the caller is always Caddy.
   */
  const askLimiter = new TokenBucket(20, 20 / 600);

  /**
   * Caddy's on-demand TLS `ask` (deploy/Caddyfile): issue a certificate only for a host
   * that is both under the alias suffix and a handle that actually resolves — otherwise
   * anyone could mint a valid cert for `whatever.sez.letsmeet.lol`.
   *
   * Caddy makes this call itself, server-side, over loopback; nothing arriving through the
   * public proxy may reach it (the `handle /internal/*` and `location /internal/` blocks in
   * deploy/ say the same thing one layer out, but this app must not depend on them being
   * deployed). A burst of bogus SNI hostnames from the internet still makes Caddy ask, so
   * the answer stays cheap to produce.
   */
  app.get('/internal/tls-ask', async (c) => {
    if (!isLoopbackPeer(c)) return c.text('no', 404);
    const handle = aliasHandle(c.req.query('domain'));
    // The alias suffix is stripped off a hostname, never a `did:` literal — that shortcut
    // in `didFor` exists only for fake-mode `/u/:handle` and matches by regex alone, so
    // without this check `?domain=did:plc:anything.sez.letsmeet.lol` would mint a cert for
    // an unverified DID.
    if (!handle || handle.startsWith('did:')) return c.text('no', 404);
    if (!askLimiter.allow(handle.toLowerCase(), deps.now().getTime())) return c.text('no', 429);
    return (await didFor(handle)) ? c.text('ok') : c.text('no', 404);
  });

  return app;
}
