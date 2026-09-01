import { createElement } from 'react';
import { Hono } from 'hono';
import { ValidationError } from '@atproto/lexicon';
import type { Deps } from '../../atproto/types.js';
import type { AuthClient } from '../../atproto/oauthClient.js';
import type { Interval } from '../../core/intervals.js';
import type { SlotMinutes, SpecificDates } from '../../core/slots.js';
import { GENERIC_ERROR, UserError } from '../../core/errors.js';
import { readSession, type SessionEnv } from '../session.js';
import { countResponsesByPoll, listPollsByHost } from '../../db/cache.js';
import { createPoll, getPollWithRevalidate, finalizePoll } from '../../services/polls.js';
import { submitGuestResponse, submitAccountResponse } from '../../services/responses.js';
import { getResults } from '../../services/results.js';
import { lookupEditSecret } from '../../db/editSecrets.js';
import { listResponseCache } from '../../db/cache.js';
import { pendingOutboxCount } from '../../db/outbox.js';
import { buildIcs } from '../../core/ics.js';
import { TokenBucket } from '../rateLimit.js';
import { clientIp } from '../clientIp.js';
import { page } from '../respond.js';
import { LandingPage } from '../pages/Landing.js';
import { DecidedPage } from '../pages/Decided.js';
import { TombstonePage } from '../pages/Tombstone.js';
import { NewPollPage } from '../pages/NewPoll.js';
import { PollPage } from '../pages/Poll.js';
import { ErrorPage } from '../pages/ErrorPage.js';

/**
 * What a failed request tells the client. Messages written for a person (UserError) and
 * the lexicon's own field-level complaints ("title must not be longer than…") are shown
 * as they are; anything else is logged here and replaced with a line that names nothing.
 */
function explain(err: unknown, where: string): string {
  if (err instanceof UserError || err instanceof ValidationError) return err.message;
  console.error(`${where} failed:`, err);
  return GENERIC_ERROR;
}

export function pollRoutes(
  deps: Deps, auth: AuthClient, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();
  const session: SessionEnv = {
    db: deps.db, cookieSecret: env.COOKIE_SECRET, secure: env.PUBLIC_URL.startsWith('https'),
  };
  const sessionDid = async (c: import('hono').Context) =>
    (await readSession(c, session, deps.now().getTime()))?.did ?? null;

  // Per-app, not module-global: two servers in one process must not share a budget.
  // Guests are keyed by address; signed-in writers by DID, since every one of those
  // routes costs PDS round trips and a free account is no harder to get than an IP.
  const guestLimiter = new TokenBucket(10, 0.1);
  const accountLimiter = new TokenBucket(10, 0.1);
  const tooMany = { error: 'Too many submissions — try again in a minute.' };

  app.get('/', async (c) => {
    const who = await readSession(c, session, deps.now().getTime());
    const did = who?.did ?? null;
    const counts = did ? countResponsesByPoll(deps.db) : new Map<string, number>();
    const polls = did
      ? listPollsByHost(deps.db, did).map((p) => ({
          rkey: p.rkey, title: p.record.title, status: p.record.status,
          dates: p.record.time.dates, responses: counts.get(p.rkey) ?? 0,
        }))
      : [];
    return page(c, createElement(LandingPage, {
      did, handle: who?.handle ?? undefined, polls,
    }));
  });

  app.get('/new', async (c) => {
    const did = await sessionDid(c);
    if (!did) return c.redirect('/login?returnTo=%2Fnew');
    return page(c, createElement(NewPollPage));
  });

  app.post('/polls', async (c) => {
    const did = await sessionDid(c);
    if (!did) return c.redirect('/login');
    if (!accountLimiter.allow(did, deps.now().getTime())) {
      return page(c, createElement(ErrorPage, {
        heading: 'Slow down', message: tooMany.error,
      }), 429);
    }
    const f = await c.req.formData();
    const time: SpecificDates = {
      dates: String(f.get('dates') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      window: { start: String(f.get('windowStart')), end: String(f.get('windowEnd')) },
      // Unchecked cast: the <select> only offers lexicon-legal values, and a hand-rolled
      // POST carrying anything else is rejected by the lexicon on record build below.
      slotMinutes: Number(f.get('slotMinutes')) as SlotMinutes,
      timezone: String(f.get('timezone')),
    };
    if (time.dates.length === 0) {
      return page(c, createElement(ErrorPage, {
        heading: 'Could not create poll',
        message: 'Could not create poll: no dates selected.',
      }), 400);
    }
    try {
      const { rkey } = await createPoll(deps, did, {
        title: String(f.get('title') ?? ''),
        description: String(f.get('description') ?? '') || undefined,
        time,
      });
      return c.redirect(`/p/${rkey}`);
    } catch (err) {
      return page(c, createElement(ErrorPage, {
        heading: 'Could not create poll',
        message: `Could not create poll: ${explain(err, 'createPoll')}`,
      }), 400);
    }
  });

  const renderPoll = async (c: import('hono').Context, rkey: string, editToken?: string) => {
    const results = await getResults(deps, rkey);
    if (!results) return c.notFound();
    if (results.poll.tombstoned) return page(c, createElement(TombstonePage), 410);
    const viewerDid = await sessionDid(c);
    if (results.poll.record.status === 'finalized' && results.poll.record.finalized) {
      return page(c, createElement(DecidedPage, {
        rkey, record: results.poll.record, publicUrl: env.PUBLIC_URL,
      }));
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
    return page(c, createElement(PollPage, {
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
    if (!guestLimiter.allow(clientIp(c), deps.now().getTime())) return c.json(tooMany, 429);
    const body = (await c.req.json().catch(() => null)) as {
      name?: string; available?: Interval[]; ifNeedBe?: Interval[];
      timezone?: string; note?: string; editToken?: string;
    } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'Malformed request body.' }, 400);
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
      return c.json({ error: explain(err, 'submitGuestResponse') }, 400);
    }
  });

  app.post('/p/:rkey/respond-auth', async (c) => {
    const did = await sessionDid(c);
    if (!did) return c.json({ error: 'sign in first' }, 401);
    if (!accountLimiter.allow(did, deps.now().getTime())) return c.json(tooMany, 429);
    const body = (await c.req.json().catch(() => null)) as {
      available?: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string;
    } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'Malformed request body.' }, 400);
    try {
      await submitAccountResponse(deps, did, c.req.param('rkey'), {
        available: body.available ?? [], ifNeedBe: body.ifNeedBe,
        timezone: body.timezone, note: body.note,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: explain(err, 'submitAccountResponse') }, 400);
    }
  });

  app.post('/p/:rkey/finalize', async (c) => {
    const did = await sessionDid(c);
    if (!did) return c.redirect('/login');
    if (!accountLimiter.allow(did, deps.now().getTime())) {
      return page(c, createElement(ErrorPage, { heading: 'Slow down', message: tooMany.error }), 429);
    }
    const f = await c.req.formData();
    try {
      await finalizePoll(deps, did, c.req.param('rkey'), {
        start: String(f.get('start')), end: String(f.get('end')),
      });
      return c.redirect(`/p/${c.req.param('rkey')}`);
    } catch (err) {
      return page(c, createElement(ErrorPage, {
        heading: 'Could not finalize',
        message: `Could not finalize: ${explain(err, 'finalizePoll')}`,
      }), 400);
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
