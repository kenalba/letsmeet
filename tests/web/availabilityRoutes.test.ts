import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { AVAILABILITY_NSID, AVAILABILITY_RKEY } from '../../src/atproto/records.js';
import type { Deps, RepoReader, RepoWriter } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';
import { claimSezName, claimedSezNameFor } from '../../src/db/sezNames.js';

const ME = 'did:plc:me';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: ME }),
  restore: async () => { throw new Error('not used'); },
};

function setup(over: { reader?: RepoReader; writer?: RepoWriter } = {}) {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: over.reader ?? repo, writerFor: async () => over.writer ?? repo,
    now: () => new Date('2026-09-16T12:00:00Z'),
  };
  const app = createServer(deps, stubAuth, {
    COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
  });
  return { app, deps, repo };
}

/** Sign in through the dev route and hand back the cookie header. */
async function signIn(app: ReturnType<typeof setup>['app'], did: string): Promise<string> {
  const res = await app.request(`/dev/login?did=${did}&handle=me.test`);
  return res.headers.get('set-cookie')!.split(';')[0];
}

const body = {
  timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }],
  away: [{ start: '2026-09-19', end: '2026-09-21', note: 'out of town' }], note: 'text first',
};

describe('/availability', () => {
  it('redirects a signed-out visitor to sign in and come back', async () => {
    const { app } = setup();
    const res = await app.request('/availability');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?returnTo=%2Favailability');
  });
  it('renders the editor with the current record as island data', async () => {
    const { app, repo } = setup();
    const cookie = await signIn(app, ME);
    await repo.putRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY, {
      $type: AVAILABILITY_NSID, ...body, updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const res = await app.request('/availability', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="availability-data"');
    expect(html).toContain('id="availability-root"');
    expect(html).toContain('/assets/availability.js');
    expect(html).toContain('out of town');
    expect(html).toContain('usually free tuesdays 7pm to 10pm.');
  });
  it('shows "good through" as the date the viewer picked, read in the record\'s zone', async () => {
    const { app, repo } = setup();
    const cookie = await signIn(app, ME);
    await repo.putRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY, {
      $type: AVAILABILITY_NSID, ...body, timezone: 'America/New_York',
      // The end of 2026-12-31 in New York — already January in UTC.
      validUntil: '2027-01-01T04:59:59.999Z', updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const html = await (await app.request('/availability', { headers: { cookie } })).text();
    expect(html).toContain('2026-12-31');
    expect(html).not.toContain('2027-01-01');
  });
  it('saves a record for the signed-in viewer and reports the sentence', async () => {
    const { app, repo } = setup();
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    // signIn's handle (me.test) has claimed nothing, so the address is its hyphenated fallback.
    expect(await res.json()).toEqual({
      ok: true, written: true, sentence: 'usually free tuesdays 7pm to 10pm.', address: 'me-test.sez.localhost:8787',
    });
    const stored = await repo.getRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY);
    expect((stored?.value as { note: string }).note).toBe('text first');
  });
  it('rejects a save with no session, and explains a bad body', async () => {
    const { app } = setup();
    expect((await app.request('/availability', { method: 'POST', body: '{}' })).status).toBe(401);
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, timezone: 'Nowhere/Here' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/timezone/);
  });
  it('explains a body that is not json at all', async () => {
    const { app } = setup();
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: 'not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('malformed request body.');
  });
  it('turns saves away once the account has spent its budget', async () => {
    const { app } = setup();
    const cookie = await signIn(app, ME);
    const save = () => app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The bucket holds 20 and the clock does not move, so the 21st finds it empty.
    for (let i = 0; i < 20; i++) expect((await save()).status).toBe(200);
    const res = await save();
    expect(res.status).toBe(429);
    expect((await res.json() as { error: string }).error).toBe('easy there. try again in a minute.');
  });
  it('opens the editor empty, and says so, when the pds will not answer the read', async () => {
    const reader: RepoReader = {
      getRecord: async () => { throw new Error('pds unreachable'); },
      listRecords: async () => { throw new Error('pds unreachable'); },
    };
    const { app } = setup({ reader });
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('saving will overwrite whatever is there');
    expect(html).toContain('"weekly":[]');
  });
  it('asks the viewer to sign in again when the pds refuses the write for want of scope', async () => {
    const writer: RepoWriter = {
      createRecord: async () => { throw new Error('not used'); },
      deleteRecord: async () => { throw new Error('not used'); },
      putRecord: async () => { throw new Error('Bad token scope'); },
    };
    const { app } = setup({ writer });
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error)
      .toBe('sign in again to post your availability (this app needs a new permission).');
  });
  it('claims the posted alias, reports the address, and shows it in the editor', async () => {
    const { app, deps, repo } = setup();
    const cookie = await signIn(app, ME);
    const res = await app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, alias: ' Me ' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, written: true, sentence: 'usually free tuesdays 7pm to 10pm.', address: 'me.sez.localhost:8787',
    });
    expect(claimedSezNameFor(deps.db, ME)).toBe('me');
    expect((await repo.getRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY))?.value).toMatchObject({ alias: 'me' });
    const html = await (await app.request('/availability', { headers: { cookie } })).text();
    expect(html).toContain('"alias":"me"');
    expect(html).toContain('"aliasSaved":"me"');
    expect(html).toContain('"sezSuffix":"sez.localhost:8787"');
  });
  it('suggests the first label of the handle, or the hyphenated handle when that is taken', async () => {
    const { app, deps } = setup();
    const cookie = await signIn(app, ME);
    let html = await (await app.request('/availability', { headers: { cookie } })).text();
    expect(html).toContain('"alias":"me"');
    expect(html).toContain('"aliasSaved":""');
    expect(html).toContain('"addressFallback":"me-test.sez.localhost:8787"');
    claimSezName(deps.db, 'me', 'did:plc:other', 0);
    html = await (await app.request('/availability', { headers: { cookie } })).text();
    expect(html).toContain('"alias":"me-test"');
  });
  it('says taken, reserved, or what a name looks like', async () => {
    const { app, deps } = setup();
    const cookie = await signIn(app, ME);
    claimSezName(deps.db, 'ross', 'did:plc:ross', 0);
    const save = (alias: string) => app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, alias }),
    });
    for (const [alias, error] of [['ross', 'that name is taken.'], ['www', 'that name is reserved.']]) {
      const res = await save(alias);
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe(error);
    }
    const bad = await save('-me');
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toMatch(/no hyphen at either end/);
  });
  it('releases the name on an empty alias, and reports the fallback address', async () => {
    const { app, deps } = setup();
    const cookie = await signIn(app, ME);
    const save = (alias: string) => app.request('/availability', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, alias }),
    });
    await save('me');
    const res = await save('');
    expect((await res.json() as { address: string | null }).address).toBe('me-test.sez.localhost:8787');
    expect(claimedSezNameFor(deps.db, ME)).toBeNull();
  });
  it('tells the owner when the name in their record is someone else\'s now', async () => {
    const { app, deps, repo } = setup();
    const cookie = await signIn(app, ME);
    await repo.putRecord(ME, AVAILABILITY_NSID, AVAILABILITY_RKEY, {
      $type: AVAILABILITY_NSID, ...body, alias: 'me', updatedAt: '2026-09-01T00:00:00.000Z',
    });
    // Table rebuilt, name still free: offered back silently.
    let html = await (await app.request('/availability', { headers: { cookie } })).text();
    expect(html).toContain('"alias":"me"');
    expect(html).not.toContain('is someone else');
    claimSezName(deps.db, 'me', 'did:plc:other', 0);
    html = (await (await app.request('/availability', { headers: { cookie } })).text()).replaceAll('&#x27;', "'");
    expect(html).toContain("your address me.sez.localhost:8787 is someone else's now");
    expect(html).toContain('"alias":"me-test"');
  });
});
