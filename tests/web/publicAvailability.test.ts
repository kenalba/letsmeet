import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { PublicAvailabilityPage } from '../../src/web/pages/PublicAvailability.js';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY, type AvailabilityRecord } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';
import { claimSezName, getSezName } from '../../src/db/sezNames.js';

const KEN = 'did:plc:ken';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: KEN }),
  restore: async () => { throw new Error('not used'); },
};
const rec: AvailabilityRecord = {
  $type: AVAILABILITY_NSID, timezone: 'America/New_York',
  weekly: [{ day: 2, start: '19:00', end: '22:00' }, { day: 4, start: '19:00', end: '22:00' }],
  away: [{ start: '2026-09-19', end: '2026-09-21', note: 'out of town' }],
  note: 'text first', validUntil: '2026-12-31T23:59:59.000Z', updatedAt: '2026-09-10T12:00:00.000Z',
};

function setup(
  resolveDid?: Deps['resolveDid'], publicUrl = 'http://localhost:8787',
  resolveHandle?: Deps['resolveHandle'],
) {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'), revalidateTtlMs: 0, resolveDid,
    resolveHandle: resolveHandle
      ?? (resolveDid ? async (d) => (d === KEN ? 'ken.wzrdz.cool' : null) : undefined),
  };
  const app = createServer(deps, stubAuth, { COOKIE_SECRET: 's', PUBLIC_URL: publicUrl, devLogin: true });
  return { app, deps, repo };
}

/** Sign in through the dev route; the live cookie, not the host-only clear a domain sign-in also emits. */
async function signIn(app: ReturnType<typeof setup>['app'], did: string): Promise<string> {
  const res = await app.request(`/dev/login?did=${encodeURIComponent(did)}&handle=ken.wzrdz.cool`);
  return res.headers.getSetCookie().find((s) => s.startsWith('sid=') && !s.startsWith('sid=;'))!.split(';')[0];
}

describe('/u/:handle', () => {
  it('renders the sentence, away entries, note and freshness for a resolved handle', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null));
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const res = await app.request('/u/ken.wzrdz.cool');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('ken.wzrdz.cool');
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain('out of town');
    expect(html).toContain('text first');
    expect(html).toContain('good through');
    expect(html).toContain('/u/ken.wzrdz.cool/availability.ics');
    expect(html).toContain('data-copy-url="http://localhost:8787/u/ken.wzrdz.cool/availability.ics"');
    expect(html).toContain('>copy feed link</button>');
    expect(html).toContain("button[data-copy-url]"); // the copy script shipped with the page
  });
  it('accepts a did literal when no resolver is configured (fake mode)', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    expect((await app.request(`/u/${KEN}`)).status).toBe(200);
  });
  it('takes no did literal once a real resolver is configured', async () => {
    // The literal is a fake-mode stand-in for a handle. In production only a resolution
    // proves the DID is the one behind the name in the URL.
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null));
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    expect((await app.request(`/u/${KEN}`)).status).toBe(404);
  });
  it('says so when there is no record, and 404s an unknown handle', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null));
    const none = await app.request('/u/ken.wzrdz.cool');
    expect(none.status).toBe(200);
    expect(await none.text()).toContain('no availability posted');
    expect((await app.request('/u/nobody.example')).status).toBe(404);
  });
  it('503s the page and the feed when the handle lookup itself fails', async () => {
    const { app } = setup(async () => { throw new Error('resolver down'); }, 'https://letsmeet.lol');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await app.request('/u/ken.wzrdz.cool')).status).toBe(503);
      expect((await app.request('/u/ken.wzrdz.cool/availability.ics')).status).toBe(503);
    } finally { warned.mockRestore(); }
  });
  it('names the good-through day in the record\'s zone, not in UTC', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, {
      ...rec, validUntil: '2027-01-01T04:59:59.999Z', // the end of Dec 31 in New York
    });
    const html = await (await app.request(`/u/${KEN}`)).text();
    expect(html).toContain('good through Dec 31');
  });
  it('reads an expired record as unknown', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, { ...rec, validUntil: '2026-09-01T00:00:00.000Z' });
    const html = await (await app.request(`/u/${KEN}`)).text();
    expect(html).toContain('treat as unknown and ask');
  });
  it('503s when the pds is down and nothing is cached', async () => {
    const { app, repo } = setup();
    vi.spyOn(repo, 'getRecord').mockRejectedValue(new Error('down'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await app.request(`/u/${KEN}`)).status).toBe(503);
    } finally { warned.mockRestore(); errored.mockRestore(); }
  });
  it('serves the feed as text/calendar', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const res = await app.request(`/u/${KEN}/availability.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(res.headers.get('cache-control')).toContain('max-age=900');
    const body = await res.text();
    expect(body).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
    expect(body).toContain('SUMMARY:@did:plc:ken away · out of town');
    expect((await app.request('/u/did:plc:nobody/availability.ics')).status).toBe(404);
  });
  it('offers the owner an edit link, and nobody else', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const guestRes = await app.request('/u/ken.wzrdz.cool');
    // The header must not depend on who is asking: the page carries the owner's edit link
    // only for the owner, so no shared cache may hold one viewer's copy for the next.
    expect(guestRes.headers.get('cache-control')).toBe('private');
    const guest = await guestRes.text();
    expect(guest).not.toContain('this is you');
    const other = await signIn(app, 'did:plc:other');
    expect(await (await app.request('/u/ken.wzrdz.cool', { headers: { cookie: other } })).text()).not.toContain('this is you');
    const mine = await signIn(app, KEN);
    const mineRes = await app.request('/u/ken.wzrdz.cool', { headers: { cookie: mine } });
    expect(mineRes.headers.get('cache-control')).toBe('private');
    const html = await mineRes.text();
    expect(html).toContain('this is you');
    expect(html).toContain('href="https://letsmeet.lol/availability"');
  });
});

describe('the week grid', () => {
  const render = (extra: Partial<Parameters<typeof PublicAvailabilityPage>[0]> = {}) =>
    renderToString(createElement(PublicAvailabilityPage, {
      handle: 'ken.wzrdz.cool', now: new Date('2026-09-16T12:00:00Z'), publicUrl: 'https://letsmeet.lol',
      record: rec, ...extra,
    }));

  it('shows the week containing today, the away note under its date, the captions, and no strip', () => {
    const html = render();
    expect(html).toContain('sep 14 – 20');
    expect(html).toContain('<span class="off">← this week</span>');
    expect(html).toContain('href="?week=next"');
    // Tuesday and Thursday 7pm–10pm: the 7pm cell on each is free; Monday's is not.
    expect(html.match(/class="week-cell free/g)?.length).toBe(6);
    // The away entry (sat 19 – mon 21) sits under saturday's and sunday's dates.
    expect(html.match(/<small>out of town<\/small>/g)?.length).toBe(2);
    expect(html).toContain('class="week-legend"');
    // The sentence is a caption now, with the freshness on the same line.
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm. · updated 6 days ago · good through Dec 31');
    expect(html).toContain('text first');
    expect(html).not.toContain('next two weeks');
    expect(html).not.toContain('grid-cols-14');
  });
  it('next week shows the following seven days with links both ways', () => {
    const html = render({ week: 'next' });
    expect(html).toContain('sep 21 – 27');
    expect(html).toContain('href="?week=this"');
    expect(html).toContain('href="?week=later"');
    expect(html).toContain('further out →');
    expect(html).not.toContain('next week →');
    // The same away entry ends on monday the 21st.
    expect(html.match(/<small>out of town<\/small>/g)?.length).toBe(1);
  });
  it('further out is a prompt to make a poll, not a grid', () => {
    const html = render({
      week: 'later',
      record: { ...rec, away: [{ start: '2026-10-03', end: '2026-10-05', note: 'wedding' }] },
    });
    expect(html).toContain('further out');
    expect(html).toContain('a usual week only says so much that far ahead.');
    expect(html).toContain('make a poll with ken.wzrdz.cool');
    expect(html).toContain('href="https://letsmeet.lol/new"');
    expect(html).toContain('href="?week=next"');
    expect(html).toContain('pick some dates, they mark what works.');
    expect(html).toContain('away later: oct 3 – 5 · wedding');
    expect(html).not.toContain('week-cell');
    expect(html).not.toContain('no sign-in');
  });
  it('lists away entries beyond next week on one later line', () => {
    const html = render({ record: { ...rec, away: [
      { start: '2026-10-03', end: '2026-10-05', note: 'wedding' },
      { start: '2026-10-20', end: '2026-10-20' },
    ] } });
    expect(html).toContain('away later: oct 3 – 5 · wedding, oct 20');
    expect(html).not.toContain('week-legend');
  });
  it('strikes the whole day for an away entry with only half a window', () => {
    // The lexicon allows startTime without endTime, and freeIntervals treats a lone one as
    // all day — the grid has to agree, or the day reads free with no mark on it.
    const html = render({ record: { ...rec, away: [{ start: '2026-09-18', end: '2026-09-18', startTime: '09:00' }] } });
    expect(html).toContain('<small>away</small>');
    expect(html.match(/class="week-cell away/g)?.length).toBe(17);
  });
  it('keeps the stale card as it was, without a grid', () => {
    const html = render({ record: { ...rec, validUntil: '2026-09-01T00:00:00.000Z' } });
    expect(html).toContain('treat as unknown and ask');
    expect(html).toContain('last they said: usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain('out of town');
    expect(html).not.toContain('week-cell');
  });
  it('keeps a stale record\'s away entry that ends today in the record zone, even when utc is already tomorrow', () => {
    // 02:00Z on the 17th is the evening of the 16th in New York.
    const html = render({
      now: new Date('2026-09-17T02:00:00Z'),
      record: { ...rec, validUntil: '2026-09-01T00:00:00.000Z', away: [{ start: '2026-09-16', end: '2026-09-16', note: 'ends today' }] },
    });
    expect(html).toContain('treat as unknown and ask');
    expect(html).toContain('ends today');
  });
  it('is chosen by the week query on the route', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    expect(await (await app.request('/u/ken.wzrdz.cool?week=next')).text()).toContain('sep 21 – 27');
    expect(await (await app.request('/u/ken.wzrdz.cool?week=later')).text()).toContain('further out');
    expect(await (await app.request('/u/ken.wzrdz.cool?week=whatever')).text()).toContain('sep 14 – 20');
  });
  it('wraps each hour in a row and tags columns, so hover can light the axis and the day', () => {
    const html = render();
    expect(html.match(/class="week-row"/g)?.length).toBe(17);
    // Seven heads and 7×17 cells carry their column index.
    expect(html.match(/class="week-head[^"]*" data-c="6"/g)?.length).toBe(1);
    expect(html.match(/class="week-cell[^"]*" data-c="0"/g)?.length).toBe(17);
    expect(html.match(/class="week-cell/g)?.length).toBe(7 * 17);
  });
  it('links each free hour that is still ahead to a bluesky post at them, written already', () => {
    const html = render();
    // Now is Wed 16 Sep: Tuesday's three free hours are past and stay inert, Thursday's link.
    expect(html.match(/<a class="week-cell free/g)?.length).toBe(3);
    expect(html.match(/<div class="week-cell free/g)?.length).toBe(3);
    const text = "hey @ken.wzrdz.cool, let's meet (lol). 7pm on thu sep 17 looks good to me?";
    expect(html).toContain(`href="https://bsky.app/intent/compose?text=${encodeURIComponent(text).replace("'", '%27')}" target="_blank" rel="noopener"`);
    expect(html).toContain('title="thu 17 7pm · click to post at them"');
    expect(html).toContain('click a free hour to post at them on bluesky.');
    expect(html).not.toContain('week-ping');
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="img"');
  });
  it('links nothing, and says nothing about it, when the week has no free hour ahead', () => {
    const html = render({ record: { ...rec, weekly: [{ day: 1, start: '19:00', end: '22:00' }] } }); // Mondays only: past
    expect(html).not.toContain('<a class="week-cell');
    expect(html).not.toContain('click a free hour');
  });
});

describe('a record only the lexicon has ever seen', () => {
  // The lexicon checks lengths, not shapes: a 12-character timezone and a 3-character
  // `start` both validate. Another client can write this; the public page must survive it.
  const foreign = {
    $type: AVAILABILITY_NSID,
    timezone: 'Mars/Olympus',
    weekly: [{ day: 2, start: '7am', end: '10pm' }],
    away: [{ start: 'next week', end: 'next week' }],
    updatedAt: '2026-09-10T12:00:00.000Z',
  };

  it('says it cannot read a record in a timezone it does not know, and serves no feed for it', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, foreign);
    const res = await app.request(`/u/${KEN}`);
    expect(res.status).toBe(200);
    // React escapes the apostrophe in the copy; read it back the way a browser would.
    const html = (await res.text()).replaceAll('&#x27;', "'");
    expect(html).toContain("couldn't read this one");
    expect(html).not.toContain('NaN');
    expect((await app.request(`/u/${KEN}/availability.ics`)).status).toBe(404);
  });

  it('drops the blocks and away entries it cannot read and shows the rest', async () => {
    const { app, repo } = setup();
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, {
      ...foreign,
      timezone: 'America/New_York',
      weekly: [{ day: 2, start: '7am', end: '10pm' }, { day: 4, start: '19:00', end: '22:00' }],
      away: [{ start: 'next week', end: 'next week' }, { start: '2026-09-19', end: '2026-09-21', note: 'out of town' }],
    });
    const html = await (await app.request(`/u/${KEN}`)).text();
    expect(html).toContain('usually free thursdays 7pm to 10pm.');
    expect(html).toContain('out of town');
    expect(html).not.toContain('NaN');
    const ics = await app.request(`/u/${KEN}/availability.ics`);
    expect(ics.status).toBe(200);
    const body = await ics.text();
    expect(body).toContain('RRULE:FREQ=WEEKLY;BYDAY=TH');
    expect(body).not.toContain('NaN');
  });
});

describe('<name>.sez.letsmeet.lol', () => {
  const kenOnly = async (h: string) => (h === 'ken.wzrdz.cool' ? KEN : null);
  const host = (h: string) => ({ headers: { host: h } });

  it('serves the friend view and feed for a claimed name, canonicalised to /u/<handle>', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    const html = await (await app.request('/', host('ken.sez.letsmeet.lol'))).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain('<link rel="canonical" href="https://letsmeet.lol/u/ken.wzrdz.cool"');
    expect(html).toContain('href="https://letsmeet.lol/u/ken.wzrdz.cool/availability.ics"');
    expect(html).toContain('webcal://letsmeet.lol/u/ken.wzrdz.cool/availability.ics');
    expect(html).toMatch(/class="brand[^"]*"\s+href="https:\/\/letsmeet\.lol\/"/);
    // Absolute: on the alias host the page's own origin is not where the feed lives.
    expect(html).toContain('data-copy-url="https://letsmeet.lol/u/ken.wzrdz.cool/availability.ics"');
    const ics = await app.request('/availability.ics', host('ken.sez.letsmeet.lol'));
    expect(ics.headers.get('content-type')).toContain('text/calendar');
  });
  it('serves the hyphenated handle for anyone who has not claimed a name', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const res = await app.request('/', host('ken-wzrdz-cool.sez.letsmeet.lol'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(getSezName(deps.db, 'ken-wzrdz-cool')).toMatchObject({ did: KEN, claimed: false });
  });
  it('404s an unknown label and any host with more than one label under the suffix', async () => {
    const { app } = setup(kenOnly, 'https://letsmeet.lol');
    expect((await app.request('/', host('nobody-example.sez.letsmeet.lol'))).status).toBe(404);
    expect((await app.request('/', host('nobody.sez.letsmeet.lol'))).status).toBe(404);
    // The old shape. No certificate covers it, and the app must not serve the apex there.
    for (const path of ['/', '/availability.ics', '/new', '/favicon.svg']) {
      expect([path, (await app.request(path, host('ken.wzrdz.cool.sez.letsmeet.lol'))).status]).toEqual([path, 404]);
    }
  });
  it('scopes the alias host whatever case or trailing dot the Host header arrives in', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    for (const h of ['ken.sez.LETSMEET.lol', 'ken.sez.letsmeet.lol.', 'KEN.sez.letsmeet.lol']) {
      expect([h, (await app.request('/new', host(h))).status]).toEqual([h, 404]);
    }
    const html = await (await app.request('/', host('KEN.sez.LETSMEET.lol.'))).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
  });
  it('reads a Host header that carries the site\'s default port as the same alias host', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    const res = await app.request('/', host('ken.sez.letsmeet.lol:443'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    // And the guard still holds there: the app proper must not leak onto the alias host.
    expect((await app.request('/new', host('ken.sez.letsmeet.lol:443'))).status).toBe(404);
  });
  it('serves nothing but the friend view and the feed on an alias host', async () => {
    const { app, deps } = setup(kenOnly, 'https://letsmeet.lol');
    claimSezName(deps.db, 'ken', KEN, 0);
    for (const path of ['/availability', '/new', '/login', '/api/handles?q=ken', '/internal/tls-ask?domain=x']) {
      expect([path, (await app.request(path, host('ken.sez.letsmeet.lol'))).status]).toEqual([path, 404]);
    }
    expect((await app.request('/favicon.svg', host('ken.sez.letsmeet.lol'))).status).toBe(200);
  });
  it('503s when the resolver is down and the label is not in the table', async () => {
    const { app } = setup(async () => { throw new Error('resolver down'); }, 'https://letsmeet.lol');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await app.request('/', host('ken-wzrdz-cool.sez.letsmeet.lol'))).status).toBe(503);
    } finally { warned.mockRestore(); }
  });
  it('has no ask endpoint any more', async () => {
    const { app } = setup(kenOnly, 'https://letsmeet.lol');
    expect((await app.request('/internal/tls-ask?domain=ken.sez.letsmeet.lol')).status).toBe(404);
  });
  it('in fake mode (no resolver) a claimed name resolves and a hyphenated label does not', async () => {
    const { app, deps, repo } = setup(undefined, 'http://localhost:8787');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    const html = await (await app.request('/', host('ken.sez.localhost:8787'))).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain(`<link rel="canonical" href="http://localhost:8787/u/${KEN}"`);
    expect((await app.request('/', host('ken-wzrdz-cool.sez.localhost:8787'))).status).toBe(404);
  });
  it('503s a name whose did declares a handle belonging to someone else', async () => {
    // An alsoKnownAs is a claim, not a proof: without the forward check, anyone could point
    // their did document at ken.wzrdz.cool and have their own alias page headed by it.
    const NOTKEN = 'did:plc:notken';
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol', async () => 'ken.wzrdz.cool');
    await repo.putRecord(NOTKEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'notken', NOTKEN, 0);
    const res = await app.request('/', host('notken.sez.letsmeet.lol'));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('ken.wzrdz.cool');
  });
  it('503s a name whose did declares no handle at all', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol', async () => null);
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    expect((await app.request('/', host('ken.sez.letsmeet.lol'))).status).toBe(503);
  });
  it('shows the address on the friend view: the claimed name, else the hyphenated handle', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    let html = await (await app.request('/u/ken.wzrdz.cool')).text();
    expect(html).toContain('ken-wzrdz-cool.sez.letsmeet.lol');
    claimSezName(deps.db, 'ken', KEN, 0);
    html = await (await app.request('/u/ken.wzrdz.cool')).text();
    expect(html).toContain('ken.sez.letsmeet.lol');
    expect(html).not.toContain('ken-wzrdz-cool.sez');
    // One click selects the whole address.
    expect(html).toContain('<p class="pixel-label text-muted-foreground select-all">ken.sez.letsmeet.lol</p>');
  });
  it('leaves the address off the alias host, where the address bar already shows it', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    const html = await (await app.request('/', host('ken.sez.letsmeet.lol'))).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).not.toContain('>ken.sez.letsmeet.lol<');
    expect(html).not.toContain('select-all');
  });
  it('turns the week on the alias host too, with the poll button pointing at the apex', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    const next = await (await app.request('/?week=next', host('ken.sez.letsmeet.lol'))).text();
    expect(next).toContain('sep 21 – 27');
    const later = await (await app.request('/?week=later', host('ken.sez.letsmeet.lol'))).text();
    expect(later).toContain('make a poll with ken.wzrdz.cool');
    expect(later).toContain('href="https://letsmeet.lol/new"');
  });
  it('offers the owner the edit link on their own sez page, pointing at the apex', async () => {
    const { app, deps, repo } = setup(kenOnly, 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    claimSezName(deps.db, 'ken', KEN, 0);
    // The browser sends the Domain=letsmeet.lol cookie to ken.sez.letsmeet.lol; here it is
    // the header that arrives with it.
    const cookie = await signIn(app, KEN);
    const html = await (await app.request('/', { headers: { host: 'ken.sez.letsmeet.lol', cookie } })).text();
    expect(html).toContain('this is you');
    expect(html).toContain('href="https://letsmeet.lol/availability"');
  });
});
