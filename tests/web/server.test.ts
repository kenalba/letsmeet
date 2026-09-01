import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
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
    expect(await res.text()).toContain('wzrdz-poll');
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
    expect(await repo.listRecords(HOST, 'cool.wzrdz.poll.response')).toHaveLength(1);
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
    repo.delete(HOST, 'cool.wzrdz.poll.schedule', poll.rkey);
    const res = await app.request(`/p/${poll.rkey}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('withdrawn by the host');
  });
});
