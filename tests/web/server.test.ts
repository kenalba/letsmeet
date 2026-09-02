import { readFileSync } from 'node:fs';
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
    expect(body).toContain('sign in to make a poll');
    // The call to action is a green ring, not a green slab.
    expect(body).toMatch(/<a[^>]*class="btn-pixel[^"]*border-primary-ink[^"]*"[^>]*>sign in to make a poll<\/a>/);
    expect(body).not.toMatch(/class="btn-pixel[^"]*bg-primary text-primary-foreground/);
    // The type credit links to the designer's tip jar, in the footer's prompt dialect.
    expect(body).toMatch(/<a[^>]*href="https:\/\/buymeacoffee\.com\/helenazhang"[^>]*class="prompt[^"]*"[^>]*>helena zhang<\/a>/);
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
    expect(otherBody).toContain('no events planned yet');
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
    // A signed-out viewer's header link signs in and comes back to this poll. The fork
    // at the name field is the island's, so it is not in the server's HTML.
    expect(body).toMatch(new RegExp(
      `href="/login\\?returnTo=${encodeURIComponent(`/p/${poll.rkey}`)}"[^>]*>sign in<span[^>]*> with bluesky</span></a>`,
    ));
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
    // Chips: the name in brackets, and it sits above the host's card.
    expect(body).toMatch(/class="responders[^"]*">[\s\S]*?\[<span[^>]*>Sam<\/span>\]/);
    expect(body.indexOf('class="responders')).toBeLessThan(body.indexOf('pick the winner'));
    expect(body).toContain(`action="/p/${poll.rkey}/finalize"`);
    expect(body).toContain('pick this time');
    expect(body).toContain(
      '1 responses are still syncing to your account. '
      + 'if this keeps up for more than a day, sign in again to reconnect.',
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

    // The edit link renders the response with its token embedded for the island; a token
    // that no longer resolves renders the plain poll, with none (the island forgets any copy
    // it kept, and a save files a fresh response instead of failing on "invalid edit link").
    const live = await (await app.request(`/p/${poll.rkey}/e/${body.editToken}`)).text();
    expect(live).toContain(`"editToken":"${body.editToken}"`);
    expect(live).toContain('"name":"Sam"');
    const dead = await app.request(`/p/${poll.rkey}/e/no-such-token`);
    expect(dead.status).toBe(200);
    expect(await dead.text()).not.toContain('"editToken"');
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

    // The name is rendered for everyone (the chips) and must come out escaped in both
    // the guest's and the host's view.
    expect(body).toContain('&lt;!--&lt;script&gt;');
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
    expect(body).toContain('called it off');
    expect(body).toContain('back home');
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
    expect(body).toContain('happening');
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
    // Signed in: no sign-in link anywhere.
    expect(body).not.toMatch(/href="\/login\?returnTo=/);
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

  it('mounts /dev/login, opening a session, when the dev flag is set', async () => {
    const { deps } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const res = await dev.request('/dev/login?did=did:plc:devguest');
    expect(res.status).toBe(302);
    // The cookie is an opaque session id; assert it round-trips to the right DID rather
    // than pinning its encoding.
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    expect(cookie.startsWith('sid=')).toBe(true);
    expect(cookie).not.toContain('devguest');
    const landing = await (await dev.request('/', { headers: { cookie } })).text();
    expect(landing).toContain('did:plc:devguest');
  });

  it('a tampered or foreign session cookie is simply signed out', async () => {
    const { deps } = await setup();
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const res = await dev.request('/dev/login?did=did:plc:devguest');
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    // Same secret, different cookie name: the name-bound payload must not verify as sid.
    const renamed = cookie.replace(/^sid=/, 'other=');
    const flipped = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
    for (const bad of [renamed, flipped, 'sid=garbage']) {
      const landing = await (await dev.request('/', { headers: { cookie: bad } })).text();
      expect(landing).not.toContain('did:plc:devguest');
      expect(landing).toContain('sign in to make a poll');
    }
  });
});

describe('host edits', () => {
  const form = (fields: Record<string, string>, cookie: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(fields).toString(),
  });
  const hostSession = async (deps: Deps, did = HOST) => {
    const dev = createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
    });
    const login = await dev.request(`/dev/login?did=${encodeURIComponent(did)}`);
    return { dev, cookie: login.headers.get('set-cookie')!.split(';')[0] };
  };

  it('shows the host a pre-filled form, and nobody else', async () => {
    const { deps, poll } = await setup();
    const { dev, cookie } = await hostSession(deps);
    const res = await dev.request(`/p/${poll.rkey}/edit`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`action="/p/${poll.rkey}/edit"`);
    expect(body).toContain('value="Movie night"');
    expect(body).toContain('value="2026-09-02"');
    expect(body).toContain('value="17:00"');
    expect(body).toContain('data-explicit="1"');
    expect(body).toContain('save changes');
    expect(body).toContain(`action="/p/${poll.rkey}/withdraw"`);
    // Nobody has answered: the geometry is editable, and the calendar island ships.
    expect(body).not.toContain('frozen');
    expect(body).toContain('/assets/createForm.js');
    // The poll page links the host there…
    const own = await (await dev.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    expect(own).toContain(`href="/p/${poll.rkey}/edit"`);
    // …and a guest neither sees the link nor gets the page.
    const guest = await (await dev.request(`/p/${poll.rkey}`)).text();
    expect(guest).not.toContain('/edit"');
    const signedOut = await dev.request(`/p/${poll.rkey}/edit`);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get('location')).toContain('/login?returnTo=');
    const { cookie: other } = await hostSession(deps, 'did:plc:stranger');
    expect((await dev.request(`/p/${poll.rkey}/edit`, { headers: { cookie: other } })).status).toBe(403);
  });

  it('saves title, description and geometry while nobody has answered', async () => {
    const { deps, repo, poll } = await setup();
    const { dev, cookie } = await hostSession(deps);
    const res = await dev.request(`/p/${poll.rkey}/edit`, form({
      title: 'Game night', description: '', dates: '2026-09-03,2026-09-04',
      windowStart: '18:00', windowEnd: '20:00', slotMinutes: '60', timezone: 'UTC',
    }, cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/p/${poll.rkey}`);
    const live = (await repo.getRecord(HOST, 'lol.letsmeet.poll.schedule', poll.rkey))!.value as {
      title: string; description?: string; time: { dates: string[]; slotMinutes: number };
    };
    expect(live.title).toBe('Game night');
    expect(live).not.toHaveProperty('description');
    expect(live.time.dates).toEqual(['2026-09-03', '2026-09-04']);
    expect(live.time.slotMinutes).toBe(60);
    expect(await (await dev.request(`/p/${poll.rkey}`)).text()).toContain('Game night');
  });

  it('freezes the geometry once a response exists, but still takes a new title', async () => {
    const { deps, repo, poll } = await setup();
    const { dev, cookie } = await hostSession(deps);
    await dev.request(`/p/${poll.rkey}/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: PAINT }),
    });
    const body = await (await dev.request(`/p/${poll.rkey}/edit`, { headers: { cookie } })).text();
    expect(body).toContain('1 person has already answered, so the days and times are frozen');
    expect(body).toMatch(/<input[^>]*disabled=""[^>]*name="dates"/);
    expect(body).not.toContain('/assets/createForm.js');
    // A hand-rolled POST that carries new dates anyway: title taken, geometry kept.
    const res = await dev.request(`/p/${poll.rkey}/edit`, form({
      title: 'Game night', dates: '2026-09-09', windowStart: '09:00', windowEnd: '10:00',
      slotMinutes: '10', timezone: 'UTC',
    }, cookie));
    expect(res.status).toBe(302);
    const live = (await repo.getRecord(HOST, 'lol.letsmeet.poll.schedule', poll.rkey))!.value as {
      title: string; time: { dates: string[]; slotMinutes: number };
    };
    expect(live.title).toBe('Game night');
    expect(live.time.dates).toEqual(['2026-09-02']);
    expect(live.time.slotMinutes).toBe(30);
  });

  it('withdraws: the record is gone, the link answers 410, the list forgets it', async () => {
    const { deps, repo, poll } = await setup();
    const { dev, cookie } = await hostSession(deps);
    const res = await dev.request(`/p/${poll.rkey}/withdraw`, form({ sure: '1' }, cookie));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(await repo.getRecord(HOST, 'lol.letsmeet.poll.schedule', poll.rkey)).toBeNull();
    const gone = await dev.request(`/p/${poll.rkey}`);
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain('called it off');
    const home = await (await dev.request('/', { headers: { cookie } })).text();
    expect(home).not.toContain(`/p/${poll.rkey}`);
    // The edit page is gone with it, and a stranger still cannot withdraw anything.
    expect((await dev.request(`/p/${poll.rkey}/edit`, { headers: { cookie } })).status).toBe(410);
  });

  it('refuses a stranger\'s withdraw', async () => {
    const { deps, repo, poll } = await setup();
    const { dev, cookie } = await hostSession(deps, 'did:plc:stranger');
    const res = await dev.request(`/p/${poll.rkey}/withdraw`, form({ sure: '1' }, cookie));
    expect(res.status).toBe(403);
    expect(await repo.getRecord(HOST, 'lol.letsmeet.poll.schedule', poll.rkey)).not.toBeNull();
  });
});

describe('request hardening', () => {
  const devServer = (deps: Deps) => createServer(deps, stubAuth, {
    COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', devLogin: true,
  });
  const signIn = async (dev: ReturnType<typeof createServer>, did: string) => {
    const res = await dev.request(`/dev/login?did=${encodeURIComponent(did)}`);
    return res.headers.get('set-cookie')!.split(';')[0];
  };

  it('names a signed-in responder by the handle from their session, not their DID', async () => {
    const { deps, poll } = await setup();
    const dev = devServer(deps);
    const login = await dev.request('/dev/login?did=did:plc:sam&handle=sam.example');
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const posted = await dev.request(`/p/${poll.rkey}/respond-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ available: PAINT }),
    });
    expect(posted.status).toBe(200);
    const body = await (await dev.request(`/p/${poll.rkey}`)).text();
    expect(body).toContain('sam.example');
    expect(body).not.toContain('did:plc:sam');
    // An account chip carries the prompt and links to the profile.
    expect(body).toMatch(/\[<a href="https:\/\/bsky\.app\/profile\/sam\.example"[^>]*class="prompt[^"]*"[^>]*>sam\.example<\/a>\]/);
    // Their own view tells the grid which name in the counts is theirs.
    const own = await (await dev.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    expect(own).toContain('"self":"sam.example"');
    expect(body).not.toContain('"self"');
  });

  it('sends a CSP whose nonce matches every inline script, plus the other headers', async () => {
    const { app, poll } = await setup();
    for (const path of ['/', `/p/${poll.rkey}`, '/login']) {
      const res = await app.request(path);
      const csp = res.headers.get('content-security-policy')!;
      const m = csp.match(/script-src 'self' 'nonce-([^']+)'/);
      expect(m, path).not.toBeNull();
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'self' https:");
      const body = await res.text();
      // Every executable inline script carries this response's nonce; none is bare.
      const inline = body.match(/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/g) ?? [];
      expect(inline.length, path).toBeGreaterThan(0);
      for (const tag of inline) expect(tag, `${path}: ${tag}`).toContain(`nonce="${m![1]}"`);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000');
    }
    // Nonces are per response.
    const a = (await app.request('/')).headers.get('content-security-policy');
    const b = (await app.request('/')).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('rejects an oversized body with 413 before any handler runs', async () => {
    const { app, poll } = await setup();
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(300 * 1024), available: PAINT }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects a paint with more intervals than any grid could produce', async () => {
    const { app, poll } = await setup();
    const many = Array.from({ length: 401 }, (_, i) => ({
      start: new Date(Date.UTC(2026, 8, 2, 17, 0, i)).toISOString(),
      end: new Date(Date.UTC(2026, 8, 2, 17, 0, i + 1)).toISOString(),
    }));
    const res = await app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: many }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/too many intervals/);
  });

  it('rate-limits a signed-in responder by DID on /respond-auth', async () => {
    const { deps, poll } = await setup();
    const dev = devServer(deps);
    const cookie = await signIn(dev, 'did:plc:sam');
    let denied = 0;
    for (let i = 0; i < 15; i++) {
      const res = await dev.request(`/p/${poll.rkey}/respond-auth`, {
        method: 'POST',
        // A different address every time: the key is the account, not the IP.
        headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': `10.0.1.${i}` },
        body: JSON.stringify({ available: PAINT }),
      });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('rate-limits poll creation by DID', async () => {
    const { deps } = await setup();
    const dev = devServer(deps);
    const cookie = await signIn(dev, HOST);
    let denied = 0;
    for (let i = 0; i < 15; i++) {
      const res = await dev.request('/polls', {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({
          title: `P${i}`, dates: '2026-09-02', windowStart: '17:00', windowEnd: '19:00',
          slotMinutes: '30', timezone: 'UTC',
        }),
      });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('refuses a poll whose timezone or date could never render, at creation', async () => {
    const { deps } = await setup();
    const dev = devServer(deps);
    const cookie = await signIn(dev, HOST);
    for (const bad of [
      { timezone: 'Eastern' }, { dates: '2026-13-45' }, { windowStart: '17:00', windowEnd: '17:10' },
    ]) {
      const res = await dev.request('/polls', {
        method: 'POST',
        headers: { cookie },
        body: new URLSearchParams({
          title: 'X', dates: '2026-09-02', windowStart: '17:00', windowEnd: '19:00',
          slotMinutes: '30', timezone: 'UTC', ...bad,
        }),
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(await res.text()).toContain('could not create poll');
    }
    expect(deps.db.prepare('SELECT COUNT(*) AS n FROM poll_cache').get()).toEqual({ n: 1 });
  });

  it('blocks a cross-site POST while letting same-site and header-less ones through', async () => {
    const { app, poll } = await setup();
    const post = (headers: Record<string, string>) => app.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:8787', ...headers },
      body: JSON.stringify({ name: 'Sam', available: PAINT }),
    });
    expect((await post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })).status).toBe(403);
    // No Sec-Fetch-Site (an older browser): Origin decides, and `null` is foreign.
    expect((await post({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await post({ origin: 'null' })).status).toBe(403);
    expect((await post({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:8787' })).status).toBe(200);
    // Chrome sends `Origin: null` on same-origin form posts under some referrer policies;
    // Sec-Fetch-Site is the browser's own verdict and wins when present.
    expect((await post({ 'sec-fetch-site': 'same-origin', origin: 'null' })).status).toBe(200);
    expect((await post({ 'sec-fetch-site': 'none' })).status).toBe(200);
    expect((await post({})).status).toBe(200);
  });

  it('answers an unexpected failure with a generic line, never the internal message', async () => {
    const { deps, poll } = await setup();
    deps.writerFor = async () => { throw new Error('secret-internal-detail https://pds.internal/xrpc'); };
    // Account responses have no outbox: the writer failure surfaces to the route.
    const dev = devServer(deps);
    const cookie = await signIn(dev, 'did:plc:sam');
    const res = await dev.request(`/p/${poll.rkey}/respond-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ available: PAINT }),
    });
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain('secret-internal-detail');
    expect(body).not.toContain('pds.internal');
    // ...while a message written for the person still comes through.
    const full = await dev.request(`/p/${poll.rkey}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sam', available: [], editToken: 'nope' }),
    });
    expect(((await full.json()) as { error: string }).error).toBe('invalid edit link');
  });

  it('renders the generic error page for a thrown route rather than a stack or bare 500', async () => {
    const { deps, poll } = await setup();
    // Corrupt the cached record so the page render itself throws — and take the PDS away
    // so revalidation cannot quietly repair it first.
    deps.db.prepare('UPDATE poll_cache SET record_json = ? WHERE rkey = ?').run('{"broken":true}', poll.rkey);
    deps.reader = { getRecord: async () => { throw new Error('down'); }, listRecords: async () => [] };
    const res = await createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787',
    }).request(`/p/${poll.rkey}`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('something broke');
    expect(body).not.toContain('TypeError');
    expect(body).not.toContain('    at ');
  });
});

describe('page chrome', () => {
  it('serves the icons and links them from every page', async () => {
    const { app, poll } = await setup();
    for (const [path, type] of [
      ['/favicon.ico', 'image/x-icon'], ['/favicon.svg', 'image/svg+xml'],
      ['/favicon-32.png', 'image/png'], ['/apple-touch-icon.png', 'image/png'],
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(type);
      expect(res.headers.get('cache-control'), path).toContain('max-age=86400');
    }
    const body = await (await app.request(`/p/${poll.rkey}`)).text();
    expect(body).toContain('rel="icon" href="/favicon.svg" type="image/svg+xml"');
    expect(body).toContain('rel="apple-touch-icon" href="/apple-touch-icon.png"');
  });

  it('serves the display face from its own origin, cached hard', async () => {
    const { app } = await setup();
    const res = await app.request('/fonts/DepartureMono-Regular.woff2');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('woff2');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // The licence travels with the file: OFL asks for it, and it costs nothing.
    expect((await app.request('/fonts/DepartureMono-LICENSE.txt')).status).toBe(200);
    // ...and the stylesheet actually asks for it from there. The *source* sheet: CI runs
    // these tests before the client build, so /assets/app.css does not exist yet there.
    const css = readFileSync('src/web/styles/app.css', 'utf8');
    expect(css).toContain('/fonts/DepartureMono-Regular.woff2');
  });

  it('titles every page uniformly and describes it for link previews', async () => {
    const { app, poll } = await setup();
    const home = await (await app.request('/')).text();
    expect(home).toContain('<title>letsmeet.lol · does tuesday work?</title>');
    expect(home).toContain('property="og:site_name" content="letsmeet.lol"');
    expect(home).toMatch(/<meta name="description" content="[^"]+"/);

    const page = await (await app.request(`/p/${poll.rkey}`)).text();
    expect(page).toContain('<title>Movie night · letsmeet.lol</title>');
    expect(page).toContain('property="og:title" content="Movie night · letsmeet.lol"');
    expect(page).toContain(`property="og:url" content="http://localhost:8787/p/${poll.rkey}"`);
    expect(page).toMatch(/property="og:description" content="30-minute slots · 0 responses so far[^"]*"/);

    const login = await (await app.request('/login')).text();
    expect(login).toContain('<title>sign in with bluesky · letsmeet.lol</title>');
  });
});

describe('handle typeahead', () => {
  const withSearch = (deps: Deps, search: (q: string) => Promise<Array<{ handle: string }>>) =>
    createServer(deps, stubAuth, {
      COOKIE_SECRET: 'test-secret', PUBLIC_URL: 'http://localhost:8787', handleSearch: search,
    });

  it('answers /api/handles from the injected search and marks it privately cacheable', async () => {
    const { deps } = await setup();
    const app = withSearch(deps, async (q) => [{ handle: `${q}.test` }]);
    const res = await app.request('/api/handles?q=ali');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actors: [{ handle: 'ali.test' }] });
    expect(res.headers.get('cache-control')).toContain('private');
  });

  it('rejects an empty or overlong query', async () => {
    const { deps } = await setup();
    const app = withSearch(deps, async () => { throw new Error('must not be called'); });
    expect((await app.request('/api/handles')).status).toBe(400);
    expect((await app.request('/api/handles?q=%20%20')).status).toBe(400);
    expect((await app.request(`/api/handles?q=${'a'.repeat(65)}`)).status).toBe(400);
  });

  it('degrades to an empty list when the upstream fails', async () => {
    const { deps } = await setup();
    const app = withSearch(deps, async () => { throw new Error('AppView down'); });
    const res = await app.request('/api/handles?q=ali');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ actors: [] });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rate-limits a burst from one address and memoizes repeats', async () => {
    const { deps } = await setup();
    let calls = 0;
    const app = withSearch(deps, async (q) => { calls++; return [{ handle: `${q}.test` }]; });
    let denied = 0;
    for (let i = 0; i < 60; i++) {
      const res = await app.request(`/api/handles?q=q${i % 5}`, { headers: { 'x-forwarded-for': '10.0.2.1' } });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
    expect(calls).toBe(5);
  });

  it('ships the island on the login page and allows only Bluesky avatars in the CSP', async () => {
    const { app } = await setup();
    const res = await app.request('/login');
    const body = await res.text();
    expect(body).toContain('src="/assets/login.js"');
    expect(body).toMatch(/<input[^>]*id="handle"[^>]*autoComplete="username"|<input[^>]*id="handle"[^>]*autocomplete="username"/i);
    expect(res.headers.get('content-security-policy')).toContain("img-src 'self' data: https://cdn.bsky.app");
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
