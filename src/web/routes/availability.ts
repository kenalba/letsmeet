import { createElement } from 'react';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { Deps } from '../../atproto/types.js';
import type { AvailabilityRecord } from '../../atproto/records.js';
import { UserError } from '../../core/errors.js';
import { describeWeekly, isKnownZone } from '../../core/availability.js';
import { readSession, type SessionEnv } from '../session.js';
import { explain, page } from '../respond.js';
import { TokenBucket } from '../rateLimit.js';
import { clientIp } from '../clientIp.js';
import { buildAvailabilityIcs } from '../../core/ics.js';
import { getOwnAvailability, saveAvailability, getAvailabilityCached } from '../../services/availability.js';
import {
  fallbackAddressFor, resolveSezName, sezAddressFor, sezSuffixFor, suggestedSezName,
} from '../../services/sezNames.js';
import { claimedSezNameFor, getSezName } from '../../db/sezNames.js';
import { AvailabilityPage } from '../pages/Availability.js';
import { PublicAvailabilityPage } from '../pages/PublicAvailability.js';
import { ErrorPage } from '../pages/ErrorPage.js';

/** A PDS refusing the write for want of scope: the session predates the availability scope. */
function needsReauth(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /scope|insufficient|forbidden|403/i.test(msg);
}

/** `.sez.<site>`: the one label before it in an alias host is a sez name. */
export const aliasSuffixFor = (publicUrl: string): string => '.sez.' + new URL(publicUrl).host;

/** One LDH label, which is all a wildcard certificate covers: `ken`, `ken-wzrdz-cool`. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A Host header is case-insensitive and may carry the root's trailing dot, and both forms
 * reach us verbatim: `KEN.sez.letsmeet.lol` and `ken.sez.letsmeet.lol.` are the same host
 * as the plain one, and matching them literally would let the alias origin slip past the
 * guard below and serve the whole app.
 */
const normalizeHost = (host: string | undefined): string => (host ?? '').toLowerCase().replace(/\.$/, '');

/** Anything at all under `.sez.<site>` — well-formed or not. */
export function isAliasHost(host: string | undefined, suffix: string): boolean {
  const name = normalizeHost(host);
  return name.endsWith(suffix) && name.length > suffix.length;
}

/**
 * The sez label an alias host names: exactly one label before the suffix. Null outside the
 * suffix, and null for more labels than one (`ken.wzrdz.cool.sez.letsmeet.lol`, the old
 * shape) — no certificate covers that, so nothing is ever served there.
 */
export function aliasLabelOf(host: string | undefined, suffix: string): string | null {
  if (!isAliasHost(host, suffix)) return null;
  const label = normalizeHost(host).slice(0, -suffix.length);
  return LABEL_RE.test(label) ? label : null;
}

/**
 * An alias host answers the friend view and the feed, and nothing else — the app proper
 * lives on the apex. Mounted ahead of every route (web/server.ts) so nothing new escapes
 * it; the static files the friend view itself loads are the only other paths allowed. A
 * malformed alias host (more than one label) answers nothing at all.
 */
export function aliasHostOnly(publicUrl: string): MiddlewareHandler {
  const suffix = aliasSuffixFor(publicUrl);
  const PUBLIC_VIEW = new Set(['/', '/availability.ics']);
  const STATIC = /^\/(assets|fonts)\/|^\/(favicon\.(ico|svg)|favicon-32\.png|apple-touch-icon\.png)$/;
  return async (c, next) => {
    const host = c.req.header('host');
    if (isAliasHost(host, suffix)) {
      const path = c.req.path;
      if (!aliasLabelOf(host, suffix) || (!PUBLIC_VIEW.has(path) && !STATIC.test(path))) return c.notFound();
    }
    await next();
  };
}

/** What a public read found: who, and what they posted. */
type Found = { handle: string; did: string; record: AvailabilityRecord | null };
type Deny = { deny: Response };

export function availabilityRoutes(
  deps: Deps, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();
  const session: SessionEnv = {
    db: deps.db, cookieSecret: env.COOKIE_SECRET, secure: env.PUBLIC_URL.startsWith('https'),
  };
  // 20 saves per ten minutes per account: a save is two PDS round trips (a claim rides on one).
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
    const claimed = claimedSezNameFor(deps.db, who.did);
    const recordAlias = record?.alias ?? null;
    // The record names a claim the table does not hold for them. Free again (the table was
    // rebuilt): offered back silently through the suggestion. Someone else's now: said so.
    const lost = recordAlias !== null && claimed !== recordAlias
      && getSezName(deps.db, recordAlias)?.claimed === true ? recordAlias : null;
    return page(c, createElement(AvailabilityPage, {
      handle: who.handle ?? undefined, record, readFailed, publicUrl: env.PUBLIC_URL,
      sez: {
        alias: suggestedSezName(deps, who.did, who.handle, recordAlias),
        aliasSaved: claimed ?? '',
        suffix: sezSuffixFor(env.PUBLIC_URL),
        addressFallback: fallbackAddressFor(who.handle, env.PUBLIC_URL),
        lost,
      },
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
      return c.json({
        ok: true, written, sentence: describeWeekly(record.weekly),
        address: sezAddressFor(deps, who.did, who.handle, env.PUBLIC_URL),
      });
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

  /**
   * The DID behind `/u/<handle>`, or null. With no resolver configured — fake mode, which
   * is what the e2e rig runs — a `did:` literal stands in for a handle. Where there is a
   * resolver, the literal is not accepted: only a real resolution says that this DID is
   * the one behind the name in the URL.
   */
  const didFor = async (handle: string): Promise<string | null> => {
    if (deps.resolveDid) return deps.resolveDid(handle);
    return /^did:(plc|web):[a-zA-Z0-9._:%-]+$/.test(handle) ? handle : null;
  };

  const tooMany = (c: Context): Deny => ({
    deny: page(c, createElement(ErrorPage, { heading: 'slow down', message: 'easy there. try again in a minute.' }), 429),
  });
  // The resolver is down, not the name wrong: 404 would tell the visitor this person does
  // not exist, and would be wrong again in a minute.
  const cannotResolve = (c: Context): Deny => ({
    deny: page(c, createElement(ErrorPage, {
      heading: 'could not look them up', message: "couldn't resolve that handle right now. try again in a minute.",
    }), 503),
  });

  /** Their record, or the response that says why not. */
  const read = async (c: Context, handle: string, did: string): Promise<Found | Deny> => {
    try {
      return { handle, did, record: await getAvailabilityCached(deps, did) };
    } catch (err) {
      console.error(`availability read failed for ${did}:`, err);
      return { deny: page(c, createElement(ErrorPage, {
        heading: 'their pds is not answering', message: "couldn't reach their pds right now. try again in a minute.",
      }), 503) };
    }
  };

  /** `/u/<handle>`: resolve + read. */
  const lookupHandle = async (c: Context, handle: string): Promise<Found | Deny> => {
    if (!readLimiter.allow(clientIp(c), deps.now().getTime())) return tooMany(c);
    let did: string | null;
    try {
      did = await didFor(handle);
    } catch (err) {
      console.warn(`handle resolution failed for ${handle}:`, err);
      return cannotResolve(c);
    }
    if (!did) return { deny: await c.notFound() };
    return read(c, handle, did);
  };

  /**
   * `<label>.sez.<site>`: a claimed name or a hyphenated handle, then the handle the DID's
   * document declares — the page is headed by it and canonicalised to `/u/<handle>`. Fake
   * mode has no resolver; there the DID literal is the handle, as `/u/<did>` accepts.
   */
  const lookupLabel = async (c: Context, label: string): Promise<Found | Deny> => {
    if (!readLimiter.allow(clientIp(c), deps.now().getTime())) return tooMany(c);
    let did: string | null;
    try {
      did = await resolveSezName(deps, label);
    } catch (err) {
      console.warn(`sez name resolution failed for ${label}:`, err);
      return cannotResolve(c);
    }
    if (!did) return { deny: await c.notFound() };
    let handle: string | null;
    try {
      handle = deps.resolveHandle ? await deps.resolveHandle(did) : did;
    } catch (err) {
      console.warn(`handle lookup failed for ${did}:`, err);
      handle = null;
    }
    if (!handle) return cannotResolve(c);
    return read(c, handle, did);
  };

  /** The friend view. Shared by `/u/:handle` and the `<name>.sez.<site>` alias. */
  const friendView = (c: Context, r: Found) => page(c, createElement(PublicAvailabilityPage, {
    handle: r.handle, record: r.record, now: deps.now(), publicUrl: env.PUBLIC_URL,
    sezAddress: sezAddressFor(deps, r.did, r.handle, env.PUBLIC_URL) ?? undefined,
  }));

  /** The ICS feed. Shared by `/u/:handle/availability.ics` and the alias. */
  const feed = (c: Context, r: Found) => {
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

  app.get('/u/:handle', async (c) => {
    const r = await lookupHandle(c, c.req.param('handle'));
    return 'deny' in r ? r.deny : friendView(c, r);
  });
  app.get('/u/:handle/availability.ics', async (c) => {
    const r = await lookupHandle(c, c.req.param('handle'));
    return 'deny' in r ? r.deny : feed(c, r);
  });

  // `<name>.sez.<site>`: an alternate host that serves the same friend view and feed as
  // `/u/<handle>`, so a share can read `ken.sez.letsmeet.lol` instead of a path. One
  // wildcard DNS record and one wildcard certificate (docs/deploy.md §3) make the host
  // exist; this dispatch is what makes it answer.
  const aliasSuffix = aliasSuffixFor(env.PUBLIC_URL);

  app.get('/', async (c, next) => {
    const label = aliasLabelOf(c.req.header('host'), aliasSuffix);
    if (!label) return next();
    const r = await lookupLabel(c, label);
    return 'deny' in r ? r.deny : friendView(c, r);
  });
  app.get('/availability.ics', async (c, next) => {
    const label = aliasLabelOf(c.req.header('host'), aliasSuffix);
    if (!label) return next();
    const r = await lookupLabel(c, label);
    return 'deny' in r ? r.deny : feed(c, r);
  });

  return app;
}
