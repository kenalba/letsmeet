import { createElement } from 'react';
import { Hono } from 'hono';
import type { Deps } from '../../atproto/types.js';
import { UserError } from '../../core/errors.js';
import { describeWeekly } from '../../core/availability.js';
import { readSession, type SessionEnv } from '../session.js';
import { explain, page } from '../respond.js';
import { TokenBucket } from '../rateLimit.js';
import { clientIp } from '../clientIp.js';
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

  app.get('/u/:handle', async (c) => {
    const r = await lookup(c, c.req.param('handle'));
    if ('deny' in r) return r.deny;
    return page(c, createElement(PublicAvailabilityPage, {
      handle: r.handle, did: r.did, record: r.record, now: deps.now(), publicUrl: env.PUBLIC_URL,
    }));
  });

  app.get('/u/:handle/availability.ics', async (c) => {
    const r = await lookup(c, c.req.param('handle'));
    if ('deny' in r) return r.deny;
    if (!r.record) return c.notFound();
    const ics = buildAvailabilityIcs(r.record, {
      uidHost: new URL(env.PUBLIC_URL).host, name: r.handle, now: deps.now(),
    });
    return c.body(ics, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'cache-control': 'public, max-age=900',
    });
  });

  return app;
}
