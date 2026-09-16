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
});
