import { createElement } from 'react';
import { Hono } from 'hono';
import { ValidationError } from '@atproto/lexicon';
import type { Deps } from '../../atproto/types.js';
import { GENERIC_ERROR, UserError } from '../../core/errors.js';
import { describeWeekly } from '../../core/availability.js';
import { readSession, type SessionEnv } from '../session.js';
import { page } from '../respond.js';
import { TokenBucket } from '../rateLimit.js';
import { getOwnAvailability, saveAvailability } from '../../services/availability.js';
import { AvailabilityPage } from '../pages/Availability.js';

/**
 * What a failed save tells the editor. Messages written for a person (UserError) and the
 * lexicon's own field-level complaints are shown as they are; anything else is logged here
 * and replaced with a line that names nothing. Same rule as `routes/polls.ts`.
 */
function explain(err: unknown, where: string): string {
  if (err instanceof UserError || err instanceof ValidationError) return err.message;
  console.error(`${where} failed:`, err);
  return GENERIC_ERROR;
}

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

  return app;
}
