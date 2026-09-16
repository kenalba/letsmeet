import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY } from '../../src/atproto/records.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const KEN = 'did:plc:ken';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: KEN }),
  restore: async () => { throw new Error('not used'); },
};
const rec = {
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
  it('says so when there is no record, and 404s an unknown handle', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null));
    const none = await app.request('/u/ken.wzrdz.cool');
    expect(none.status).toBe(200);
    expect(await none.text()).toContain('no availability posted');
    expect((await app.request('/u/nobody.example')).status).toBe(404);
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

/** A request whose socket peer is `address` — what @hono/node-server's getConnInfo reads. */
const conn = (address: string) => ({ incoming: { socket: { remoteAddress: address, remoteFamily: 'IPv4' } } });

describe('<handle>.sez.letsmeet.lol', () => {
  it('serves the friend view and feed on <handle>.sez.letsmeet.lol', async () => {
    const { app, repo } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    await repo.putRecord(KEN, AVAILABILITY_NSID, AVAILABILITY_RKEY, rec);
    const html = await (await app.request('/', { headers: { host: 'ken.wzrdz.cool.sez.letsmeet.lol' } })).text();
    expect(html).toContain('usually free tuesdays and thursdays 7pm to 10pm.');
    expect(html).toContain('<link rel="canonical" href="https://letsmeet.lol/u/ken.wzrdz.cool"');
    const ics = await app.request('/availability.ics', { headers: { host: 'ken.wzrdz.cool.sez.letsmeet.lol' } });
    expect(ics.headers.get('content-type')).toContain('text/calendar');
  });
  it("answers caddy's ask endpoint only for handles that resolve", async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    expect((await app.request('/internal/tls-ask?domain=ken.wzrdz.cool.sez.letsmeet.lol')).status).toBe(200);
    expect((await app.request('/internal/tls-ask?domain=nobody.example.sez.letsmeet.lol')).status).toBe(404);
    expect((await app.request('/internal/tls-ask?domain=evil.example')).status).toBe(404);
  });
  it('rejects a did: literal on the ask endpoint even though /u/:handle accepts one in fake mode', async () => {
    // No resolver configured: fake mode, where didFor's `did:` shortcut is meant for
    // /u/:handle only. The ask endpoint must not let it mint a certificate.
    const { app } = setup(undefined, 'https://letsmeet.lol');
    const res = await app.request(`/internal/tls-ask?domain=${KEN}.sez.letsmeet.lol`);
    expect(res.status).toBe(404);
  });
  it('answers 429 once a domain has spent its ask budget, without touching another domain', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    const ask = (domain: string) => app.request(`/internal/tls-ask?domain=${domain}.sez.letsmeet.lol`);
    // The budget is per asked-about domain — the thing an attacker varies — so spending
    // one made-up name's 20 must leave a real handle's first ask untouched.
    for (let i = 0; i < 20; i++) expect((await ask('junk.example')).status).toBe(404);
    expect((await ask('junk.example')).status).toBe(429);
    expect((await ask('ken.wzrdz.cool')).status).toBe(200);
  });
  it('refuses the ask from anything but a caller on this box', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    const ask = (init?: RequestInit, env?: unknown) =>
      app.request('/internal/tls-ask?domain=ken.wzrdz.cool.sez.letsmeet.lol', init, env);
    // Through the public proxy: nginx and Caddy both append X-Forwarded-For, and both dial
    // 127.0.0.1 — so the header, not the socket, is what gives a proxied request away.
    expect((await ask({ headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(404);
    // ...and a spoofed loopback claim in that header must not buy anything either.
    expect((await ask({ headers: { 'x-forwarded-for': '127.0.0.1' } })).status).toBe(404);
    expect((await ask({}, conn('203.0.113.9'))).status).toBe(404);
    expect((await ask({}, conn('127.0.0.1'))).status).toBe(200);
  });
  it('refuses a domain that only looks like it is under the alias suffix', async () => {
    const { app } = setup(async () => KEN, 'https://letsmeet.lol');
    const ask = (domain: string) =>
      app.request(`/internal/tls-ask?domain=${encodeURIComponent(domain)}`);
    expect((await ask('evil.example/?x=.sez.letsmeet.lol')).status).toBe(404);
    expect((await ask('.sez.letsmeet.lol')).status).toBe(404);
    expect((await ask('sez.letsmeet.lol')).status).toBe(404);
  });
  it('serves nothing but the friend view and the feed on an alias host', async () => {
    const { app } = setup(async (h) => (h === 'ken.wzrdz.cool' ? KEN : null), 'https://letsmeet.lol');
    const headers = { host: 'ken.wzrdz.cool.sez.letsmeet.lol' };
    for (const path of ['/availability', '/new', '/login', '/api/handles?q=ken',
      '/internal/tls-ask?domain=ken.wzrdz.cool.sez.letsmeet.lol']) {
      expect([path, (await app.request(path, { headers })).status]).toEqual([path, 404]);
    }
    // The friend view is a page: the static files it loads still have to answer.
    expect((await app.request('/favicon.svg', { headers })).status).toBe(200);
  });
});
