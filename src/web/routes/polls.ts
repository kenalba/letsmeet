import { createElement } from 'react';
import { Hono } from 'hono';
import type { Deps } from '../../atproto/types.js';
import type { AuthClient } from '../../atproto/oauthClient.js';
import type { Interval } from '../../core/intervals.js';
import type { SpecificDates } from '../../core/slots.js';
import { getSessionDid } from './auth.js';
import { createPoll, getPollWithRevalidate, finalizePoll } from '../../services/polls.js';
import { submitGuestResponse, submitAccountResponse } from '../../services/responses.js';
import { getResults } from '../../services/results.js';
import { lookupEditSecret } from '../../db/editSecrets.js';
import { listResponseCache } from '../../db/cache.js';
import { pendingOutboxCount } from '../../db/outbox.js';
import { buildIcs } from '../../core/ics.js';
import { TokenBucket } from '../rateLimit.js';
import { renderPage } from '../render.js';
import { LandingPage } from '../pages/Landing.js';
import { DecidedPage } from '../pages/Decided.js';
import { TombstonePage } from '../pages/Tombstone.js';
import { createFormPage, pollPage } from '../views.js';

export function pollRoutes(
  deps: Deps, auth: AuthClient, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();
  // Per-app, not module-global: two servers in one process must not share a budget.
  const guestLimiter = new TokenBucket(10, 0.1);

  app.get('/', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    return c.html(renderPage(createElement(LandingPage, { did })));
  });

  app.get('/new', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.redirect('/login');
    return c.html(createFormPage());
  });

  app.post('/polls', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.redirect('/login');
    const f = await c.req.formData();
    const time: SpecificDates = {
      dates: String(f.get('dates') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      window: { start: String(f.get('windowStart')), end: String(f.get('windowEnd')) },
      slotMinutes: Number(f.get('slotMinutes')) as 15 | 30 | 60,
      timezone: String(f.get('timezone')),
    };
    try {
      const { rkey } = await createPoll(deps, did, {
        title: String(f.get('title') ?? ''),
        description: String(f.get('description') ?? '') || undefined,
        time,
      });
      return c.redirect(`/p/${rkey}`);
    } catch (err) {
      return c.text(`Could not create poll: ${(err as Error).message}`, 400);
    }
  });

  const renderPoll = async (c: import('hono').Context, rkey: string, editToken?: string) => {
    const results = await getResults(deps, rkey);
    if (!results) return c.notFound();
    if (results.poll.tombstoned) return c.html(renderPage(createElement(TombstonePage)), 410);
    const viewerDid = await getSessionDid(c, env.COOKIE_SECRET);
    if (results.poll.record.status === 'finalized' && results.poll.record.finalized) {
      return c.html(renderPage(createElement(DecidedPage, {
        rkey, record: results.poll.record, publicUrl: env.PUBLIC_URL,
      })));
    }
    let prefill;
    if (editToken) {
      const respRkey = lookupEditSecret(deps.db, results.poll.uri, editToken);
      const row = respRkey
        ? listResponseCache(deps.db, rkey).find((r) => r.source === 'guest' && r.key === respRkey)
        : null;
      if (row) {
        prefill = {
          available: row.record.available,
          ifNeedBe: row.record.ifNeedBe ?? [],
          name: row.record.guest?.name,
        };
      }
    } else if (viewerDid) {
      // A signed-in responder needs no edit link: their own row is keyed by their DID, so
      // they come back to the grid they painted rather than a blank one. No name — an
      // account response carries no guest name.
      const row = listResponseCache(deps.db, rkey)
        .find((r) => r.source === 'account' && r.key === viewerDid);
      if (row) {
        prefill = { available: row.record.available, ifNeedBe: row.record.ifNeedBe ?? [] };
      }
    }
    const isHost = viewerDid === results.poll.hostDid;
    return c.html(pollPage({
      rkey,
      title: results.poll.record.title,
      description: results.poll.record.description,
      status: results.poll.record.status,
      time: results.poll.record.time,
      slots: results.slots,
      results,
      viewerDid,
      isHost,
      prefill,
      editToken,
      pendingCount: isHost ? pendingOutboxCount(deps.db, results.poll.hostDid) : 0,
    }));
  };

  app.get('/p/:rkey', (c) => renderPoll(c, c.req.param('rkey')));
  app.get('/p/:rkey/e/:token', (c) => renderPoll(c, c.req.param('rkey'), c.req.param('token')));

  app.post('/p/:rkey/respond', async (c) => {
    // Our own proxy appends the real client as the last hop, so a client-supplied
    // prefix cannot rotate bucket keys to escape the limit.
    const xff = c.req.header('x-forwarded-for');
    const ip = xff ? xff.split(',').pop()!.trim() : 'local';
    if (!guestLimiter.allow(ip, deps.now().getTime())) {
      return c.json({ error: 'Too many submissions — try again in a minute.' }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as {
      name?: string; available?: Interval[]; ifNeedBe?: Interval[];
      timezone?: string; note?: string; editToken?: string;
    } | null;
    if (!body) return c.json({ error: 'Malformed request body.' }, 400);
    try {
      const out = await submitGuestResponse(deps, c.req.param('rkey'), {
        name: String(body.name ?? '').trim() || 'Guest',
        available: body.available ?? [],
        ifNeedBe: body.ifNeedBe,
        timezone: body.timezone,
        note: body.note,
        editToken: body.editToken,
      });
      return c.json(out);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/p/:rkey/respond-auth', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.json({ error: 'sign in first' }, 401);
    const body = (await c.req.json().catch(() => null)) as {
      available?: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string;
    } | null;
    if (!body) return c.json({ error: 'Malformed request body.' }, 400);
    try {
      await submitAccountResponse(deps, did, c.req.param('rkey'), {
        available: body.available ?? [], ifNeedBe: body.ifNeedBe,
        timezone: body.timezone, note: body.note,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/p/:rkey/finalize', async (c) => {
    const did = await getSessionDid(c, env.COOKIE_SECRET);
    if (!did) return c.redirect('/login');
    const f = await c.req.formData();
    try {
      await finalizePoll(deps, did, c.req.param('rkey'), {
        start: String(f.get('start')), end: String(f.get('end')),
      });
      return c.redirect(`/p/${c.req.param('rkey')}`);
    } catch (err) {
      return c.text(`Could not finalize: ${(err as Error).message}`, 400);
    }
  });

  app.get('/p/:rkey/ics', async (c) => {
    const poll = await getPollWithRevalidate(deps, c.req.param('rkey'));
    if (!poll || poll.record.status !== 'finalized' || !poll.record.finalized) return c.notFound();
    const ics = buildIcs({
      uid: `${poll.rkey}@letsmeet.lol`,
      title: poll.record.title,
      start: poll.record.finalized.start,
      end: poll.record.finalized.end,
      url: `${env.PUBLIC_URL}/p/${poll.rkey}`,
      now: deps.now(),
    });
    return c.body(ics, 200, {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${poll.rkey}.ics"`,
    });
  });

  return app;
}
