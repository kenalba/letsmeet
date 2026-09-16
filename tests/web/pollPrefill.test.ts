import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import { createServer } from '../../src/web/server.js';
import { createPoll } from '../../src/services/polls.js';
import { saveAvailability } from '../../src/services/availability.js';
import { submitAccountResponse } from '../../src/services/responses.js';
import type { Deps } from '../../src/atproto/types.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const HOST = 'did:plc:host';
const ME = 'did:plc:me';
const stubAuth: AuthClient = {
  clientMetadata: {}, jwks: { keys: [] },
  authorize: async () => new URL('https://pds.example.com/authorize'),
  callback: async () => ({ did: ME }),
  restore: async () => { throw new Error('not used'); },
};
// 2026-10-13 is a Tuesday, 2026-10-15 a Thursday.
const time = {
  dates: ['2026-10-13', '2026-10-15'], window: { start: '19:00', end: '21:00' },
  slotMinutes: 30 as const, timezone: 'UTC',
};

async function setup() {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'),
  };
  const app = createServer(deps, stubAuth, { COOKIE_SECRET: 's', PUBLIC_URL: 'http://localhost:8787', devLogin: true });
  const poll = await createPoll(deps, HOST, { title: 'Book club', time });
  const cookie = (await app.request(`/dev/login?did=${ME}`)).headers.get('set-cookie')!.split(';')[0];
  return { app, deps, poll, cookie };
}

const islandData = (html: string) => {
  const m = html.match(/<script id="poll-data"[^>]*>([^<]*)<\/script>/);
  return JSON.parse(m![1].replace(/\\u003c/g, '<')) as { prefill?: { available: unknown[]; source?: string } };
};

describe('poll prefill from availability', () => {
  it('pre-marks a signed-in viewer with no response yet', async () => {
    const { app, deps, poll, cookie } = await setup();
    await saveAvailability(deps, ME, { timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] });
    const html = await (await app.request(`/p/${poll.rkey}`, { headers: { cookie } })).text();
    const data = islandData(html);
    expect(data.prefill?.source).toBe('availability');
    expect(data.prefill?.available).toEqual([{ start: '2026-10-13T19:00:00.000Z', end: '2026-10-13T21:00:00.000Z' }]);
  });
  it('prefers a saved response over the record', async () => {
    const { app, deps, poll, cookie } = await setup();
    await saveAvailability(deps, ME, { timezone: 'UTC', weekly: [{ day: 2, start: '19:00', end: '22:00' }], away: [] });
    await submitAccountResponse(deps, ME, poll.rkey, {
      available: [{ start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T19:30:00.000Z' }],
    });
    const data = islandData(await (await app.request(`/p/${poll.rkey}`, { headers: { cookie } })).text());
    expect(data.prefill?.source).toBeUndefined();
    expect(data.prefill?.available).toEqual([{ start: '2026-10-15T19:00:00.000Z', end: '2026-10-15T19:30:00.000Z' }]);
  });
  it('sends no prefill when the record has nothing for this poll, or when signed out', async () => {
    const { app, deps, poll, cookie } = await setup();
    await saveAvailability(deps, ME, { timezone: 'UTC', weekly: [{ day: 6, start: '19:00', end: '22:00' }], away: [] });
    expect(islandData(await (await app.request(`/p/${poll.rkey}`, { headers: { cookie } })).text()).prefill).toBeUndefined();
    expect(islandData(await (await app.request(`/p/${poll.rkey}`)).text()).prefill).toBeUndefined();
  });
});
