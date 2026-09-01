import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { scriptJson } from '../../src/web/scriptJson.js';
import { createPoll } from '../../src/services/polls.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const HOST = 'did:plc:host';
const time = {
  dates: ['2026-09-02'], window: { start: '17:00', end: '19:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};
const PAINT = [{ start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T18:00:00.000Z' }];

const stubAuth: AuthClient = {
  clientMetadata: {},
  jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: HOST }),
  restore: async () => { throw new Error('not used'); },
};

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo,
    writerFor: async () => repo, now: () => new Date('2026-08-31T12:00:00Z'),
  };
  const app = createServer(deps, stubAuth, {
    COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787',
  });
  const poll = await createPoll(deps, HOST, { title: 'Movie night', time });
  return { app, deps, repo, poll };
}

describe('server', () => {
  it('serves the landing page', async () => {
    const { app } = await setup();
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('letsmeet');
    // The built Tailwind sheet is the only stylesheet the migrated pages carry.
    expect(body).toContain('rel="stylesheet"');
    expect(body).toContain('/assets/app.css');
    expect(body).toContain('Sign in to create a poll');
  });

  it('shows the signed-in DID in exactly one <code> element on the landing page', async () => {
    const { deps } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const login = await dev.request('/dev/login?did=did:plc:sam');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const body = await (await dev.request('/', { headers: { cookie } })).text();
    expect(body).toContain('/assets/app.css');
    expect(body).toMatch(/<code[^>]*>did:plc:sam<\/code>/);
    // The e2e suite locates the DID with a bare `code` locator, which is strict-mode:
    // a second <code> anywhere on this page would break it.
    expect(body.match(/<code[\s>]/g)).toHaveLength(1);
    // ...and the create form the e2e helper fills is still here, field names intact.
    expect(body).toMatch(/<form [^>]*class="create[ "]/);
    expect(body).toContain('name="slotMinutes"');
  });

  it('serves a full sign-in page at GET /login', async () => {
    const { app } = await setup();
    const res = await app.request('/login');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('action="/login"');
    expect(body).toContain('name="handle"');
    expect(body).toContain('/assets/app.css');
  });

  it('renders a poll page with embedded grid data', async () => {
    const { app, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('Movie night');
    expect(body).toContain('poll-data');
    expect(body).toContain('Shown publicly on this poll');
  });

  it('accepts a guest response and returns an edit token', async () => {
    const { app, repo, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: PAINT }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { editToken: string; pending: boolean };
    expect(body.editToken).toBeTruthy();
    expect(await repo.listRecords(HOST, 'lol.letsmeet.poll.response')).toHaveLength(1);
  });

  it('returns 400 for a malformed JSON body instead of throwing', async () => {
    const { app, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('neutralizes a script-breaking guest name in the embedded JSON', async () => {
    const { app, poll } = await setup();
    const evil = '<!--<script>';
    const posted = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: evil, available: PAINT }),
    });
    expect(posted.status).toBe(200);

    const body = await (await app.request(`/p/${poll.rkey}`)).text();
    // The raw sequence must not survive anywhere: inside #poll-data it would flip the
    // HTML tokenizer into script-data-escaped state and swallow the rest of the page.
    expect(body).not.toContain(evil);
    // ...so everything after the JSON block is still parsed as markup.
    expect(body).toContain('src="/assets/grid.js"');
    // ...and the name still shows up, HTML-escaped, in the responders list.
    expect(body).toContain('&lt;!--&lt;script&gt;');
  });

  it('returns 400 with a message for unusable paint', async () => {
    const { app, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits bursts of guest submissions from one IP', async () => {
    const { app, poll } = await setup();
    let denied = 0;
    for (let i = 0; i < 15; i++) {
      const res = await app.request(`/p/${poll.rkey}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9' },
        body: JSON.stringify({ name: `G${i}`, available: PAINT }),
      });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('blocks poll creation without a session cookie', async () => {
    const { app } = await setup();
    const res = await app.request('/polls', {
      method: 'POST',
      body: new URLSearchParams({
        title: 'X', dates: '2026-09-02', windowStart: '17:00', windowEnd: '19:00',
        slotMinutes: '30', timezone: 'UTC',
      }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('serves ICS only once finalized', async () => {
    const { app, deps, poll } = await setup();
    expect((await app.request(`/p/${poll.rkey}/ics`)).status).toBe(404);
    const { finalizePoll } = await import('../../src/services/polls.js');
    await finalizePoll(deps, HOST, poll.rkey, {
      start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z',
    });
    const res = await app.request(`/p/${poll.rkey}/ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    expect(await res.text()).toContain('BEGIN:VEVENT');
  });

  it('renders a tombstone page for withdrawn polls', async () => {
    const { app, repo, poll } = await setup();
    repo.delete(HOST, 'lol.letsmeet.poll.schedule', poll.rkey);
    const res = await app.request(`/p/${poll.rkey}`);
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).toContain('withdrawn by the host');
    expect(body).toContain('Back to letsmeet');
  });

  it('renders the decided page with .ics and webcal links once finalized', async () => {
    const { app, deps, poll } = await setup();
    const { finalizePoll } = await import('../../src/services/polls.js');
    await finalizePoll(deps, HOST, poll.rkey, {
      start: '2026-09-02T17:00:00.000Z', end: '2026-09-02T17:30:00.000Z',
    });
    const res = await app.request(`/p/${poll.rkey}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Decided');
    expect(body).toMatch(new RegExp(`<a href="/p/${poll.rkey}/ics" class="ics[ "]`));
    expect(body).toContain('webcal://localhost:8787');
    expect(body).toContain('/assets/app.css');
  });

  it('prefills the grid for a signed-in responder without an edit link', async () => {
    const { deps, poll } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const login = await dev.request('/dev/login?did=did:plc:sam');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const posted = await dev.request(`/p/${poll.rkey}/respond-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ available: PAINT }),
    });
    expect(posted.status).toBe(200);

    const body = await (await dev.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    expect(body).toContain('"prefill"');
    expect(body).toContain(PAINT[0].start);
    // ...and a signed-out visitor still gets a blank grid.
    const anon = await (await dev.request(`/p/${poll.rkey}`)).text();
    expect(anon).not.toContain('"prefill"');
  });

  it('does not mount /dev/login unless the dev flag is set', async () => {
    const { app } = await setup();
    expect((await app.request('/dev/login?did=did:plc:sneaky')).status).toBe(404);
  });

  it('mounts /dev/login, setting a signed did cookie, when the dev flag is set', async () => {
    const { deps } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const res = await dev.request('/dev/login?did=did:plc:devguest');
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toMatch(/^did=did%3Aplc%3Adevguest\./);
  });
});

describe('scriptJson', () => {
  it('escapes every < so an embedded value cannot flip the script tokenizer', () => {
    // Same rule the poll page's #poll-data block depends on, asserted against the module
    // that now owns it (views.ts only re-exports it until the poll page ports).
    const out = scriptJson({ name: '<!--<script>' });
    expect(out).toBe('{"name":"\\u003c!--\\u003cscript>"}');
    expect(out).not.toContain('<');
  });
});
