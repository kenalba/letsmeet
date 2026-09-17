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

function setup(resolveDid?: Deps['resolveDid'], publicUrl = 'http://localhost:8787') {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'), revalidateTtlMs: 0, resolveDid,
    resolveHandle: resolveDid ? async (d) => (d === KEN ? 'ken.wzrdz.cool' : null) : undefined,
  };
  const app = createServer(deps, stubAuth, { COOKIE_SECRET: 's', PUBLIC_URL: publicUrl });
  return { app, deps, repo };
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
    expect(body).toContain('SUMMARY:away · out of town');
    expect((await app.request('/u/did:plc:nobody/availability.ics')).status).toBe(404);
  });
});

describe('the two-week strip', () => {
  it('marks a day away when an away entry covers it with only half a window', () => {
    // The lexicon allows startTime without endTime, and freeIntervals treats a lone one as
    // all day — the strip has to agree, or the bar reads empty with no away marking on it.
    const html = renderToString(createElement(PublicAvailabilityPage, {
      handle: 'ken.wzrdz.cool', now: new Date('2026-09-16T12:00:00Z'),
      publicUrl: 'https://letsmeet.lol',
      record: {
        ...rec, away: [{ start: '2026-09-18', end: '2026-09-18', startTime: '09:00' }],
      },
    }));
    expect(html).toContain('Sep 18 · away');
    // Half a window is not a window: no clock line for it either.
    expect(html).not.toContain('9am');
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
});
