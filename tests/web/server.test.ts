import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { scriptJson } from '../../src/web/scriptJson.js';
import { createPoll } from '../../src/services/polls.js';
import { enqueueOutbox } from '../../src/db/outbox.js';
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

  it('states the slot length on the poll page', async () => {
    const { app, poll } = await setup();
    const body = await (await app.request(`/p/${poll.rkey}`)).text();
    expect(body).toContain('30-minute slots');
  });

  it('ships the theme toggle and its FOUC-preventing head script', async () => {
    const { app } = await setup();
    const body = await (await app.request('/')).text();
    // The init script has to run *before* the stylesheet, or a viewer who pinned Dark gets
    // one light frame first. Ordering in the markup is the whole guarantee.
    const initIdx = body.indexOf("localStorage.getItem('theme')");
    expect(initIdx).toBeGreaterThan(-1);
    expect(body.indexOf('/assets/app.css')).toBeGreaterThan(initIdx);
    // The button itself, server-rendered in the System state; the wiring script that cycles
    // it comes after <main>, so the button is in the DOM by the time it runs.
    const buttonIdx = body.indexOf('id="theme-toggle"');
    expect(buttonIdx).toBeGreaterThan(-1);
    expect(body).toContain('Theme: System');
    expect(body.indexOf("getElementById('theme-toggle')")).toBeGreaterThan(buttonIdx);
  });

  it('shows the signed-in DID and their polls on the landing page, create form on /new', async () => {
    const { deps, poll } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    // setup()'s poll belongs to HOST; a stranger's landing must not list it.
    const login = await dev.request(`/dev/login?did=${encodeURIComponent(HOST)}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const body = await (await dev.request('/', { headers: { cookie } })).text();
    expect(body).toContain('/assets/app.css');
    expect(body).toMatch(new RegExp(`<code[^>]*>${HOST}</code>`));
    // The e2e suite locates the DID with a bare `code` locator, which is strict-mode:
    // a second <code> anywhere on this page would break it.
    expect(body.match(/<code[\s>]/g)).toHaveLength(1);
    // The landing lists the host's polls with links, meta and a copy button; the create
    // form lives on /new now.
    expect(body).toContain(`href="/p/${poll.rkey}"`);
    expect(body).toContain(`data-copy-path="/p/${poll.rkey}"`);
    expect(body).toContain('0 responses');
    expect(body).toContain('href="/new"');
    expect(body).not.toContain('name="slotMinutes"');

    // Someone else's landing lists nothing.
    const other = await dev.request('/dev/login?did=did:plc:stranger');
    const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
    const otherBody = await (await dev.request('/', { headers: { cookie: otherCookie } })).text();
    expect(otherBody).not.toContain(`/p/${poll.rkey}`);
    expect(otherBody).toContain('No polls yet');
  });

  it('serves the create form with the calendar island at GET /new', async () => {
    const { deps } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const login = await dev.request('/dev/login?did=did:plc:sam');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await dev.request('/new', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    // No-JS still gets the frozen text input, still required until the island mounts.
    // (A bare `toContain('required')` would pass on any of the other required fields —
    // anchor it to the dates input specifically.)
    expect(body).toMatch(
      /<input[^>]*required[^>]*name="dates"|<input[^>]*name="dates"[^>]*required/,
    );
    expect(body).toContain('name="dates"');
    expect(body).toContain('class="dates-fallback"');
    // The island's mount point, plus the two window fields as native time inputs — still
    // `required` server-side, because with no JS they are the control.
    expect(body).toContain('id="create-dates"');
    expect(body).toMatch(/id="create-dates"[^>]*hidden/);
    expect(body.match(/type="time"/g)).toHaveLength(2);
    expect(body.match(/<input[^>]*type="time"[^>]*required/g)).toHaveLength(2);
    // ...and the two hidden spans the island unhides to mount a segmented TimeField over
    // each of them. Hidden here, or a no-JS visitor would see an empty box beside the input.
    expect(body).toMatch(/id="window-start-field"[^>]*hidden/);
    expect(body).toMatch(/id="window-end-field"[^>]*hidden/);
    expect(body).toContain('name="timezone"');
    expect(body).toContain('value="UTC"');
    expect(body).toContain('name="slotMinutes"');
    expect(body).toContain('/assets/createForm.js');
    expect(body).toContain('/assets/app.css');
  });

  it('sends a signed-out visitor at /new to sign in', async () => {
    const { app } = await setup();
    const res = await app.request('/new');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
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
    // The island's mount point, its data block and its bundle are one contract: drop any
    // one of them and the grid silently never appears.
    expect(body).toContain('id="grid-root"');
    expect(body).toContain('<script id="poll-data" type="application/json">');
    expect(body).toContain('src="/assets/grid.js"');
  });

  it('shows the host the responders, a finalize form and the pending-sync banner', async () => {
    const { deps, poll } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const login = await dev.request(`/dev/login?did=${encodeURIComponent(HOST)}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const posted = await dev.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: PAINT }),
    });
    expect(posted.status).toBe(200);
    // One response the host's PDS has not accepted yet, which is what the banner counts.
    enqueueOutbox(
      deps.db,
      { hostDid: HOST, pollUri: poll.uri, rkey: 'queued-response', record: {} },
      deps.now().getTime(),
    );

    const body = await (await dev.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    expect(body).toContain('class="responders');
    expect(body).toMatch(/class="responders[^"]*">\s*<li[^>]*>Sam</);
    expect(body).toContain(`action="/p/${poll.rkey}/finalize"`);
    expect(body).toContain('Pick this time');
    expect(body).toContain(
      '1 responses are still syncing to your account. '
      + 'If this persists for more than a day, sign in again to reconnect.',
    );

    // ...and a guest sees neither the finalize form nor the host's sync banner.
    const guest = await (await dev.request(`/p/${poll.rkey}`)).text();
    expect(guest).not.toContain('/finalize');
    expect(guest).not.toContain('still syncing to your account');
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
    const { deps, poll } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const evil = '<!--<script>';
    const posted = await dev.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: evil, available: PAINT }),
    });
    expect(posted.status).toBe(200);

    const body = await (await dev.request(`/p/${poll.rkey}`)).text();
    // The raw sequence must not survive anywhere: inside #poll-data it would flip the
    // HTML tokenizer into script-data-escaped state and swallow the rest of the page.
    expect(body).not.toContain(evil);
    // ...so everything after the JSON block is still parsed as markup.
    expect(body).toContain('src="/assets/grid.js"');

    // The responders list is host-only now, so the HTML-escaped rendering of the name is
    // asserted on the host's view of the page.
    const login = await dev.request(`/dev/login?did=${encodeURIComponent(HOST)}`);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const hostBody = await (await dev.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    expect(hostBody).not.toContain(evil);
    expect(hostBody).toContain('&lt;!--&lt;script&gt;');
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
    // The signed value carries the name-binding prefix now (did\x00…), so assert the
    // cookie round-trips to the right DID rather than pinning its raw encoding.
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect(cookie.startsWith('did=')).toBe(true);
    const landing = await (await dev.request('/', { headers: { cookie } })).text();
    expect(landing).toContain('did:plc:devguest');
  });
});

describe('scriptJson', () => {
  it('escapes every < so an embedded value cannot flip the script tokenizer', () => {
    // Same rule the poll page's #poll-data block depends on.
    const out = scriptJson({ name: '<!--<script>' });
    expect(out).toBe('{"name":"\\u003c!--\\u003cscript>"}');
    expect(out).not.toContain('<');
  });
});
