import { serve } from '@hono/node-server';
import { openDb } from './db/db.js';
import { createOAuthClient, type AuthClient } from './atproto/oauthClient.js';
import { PublicPdsReader, writerForAgent } from './atproto/pds.js';
import { FakeRepo } from './atproto/fakeRepo.js';
import { flushOutbox } from './services/responses.js';
import { pruneOutbox } from './db/outbox.js';
import { pruneWebSessions } from './db/webSessions.js';
import { createServer } from './web/server.js';
import { fakeHandleSearch } from './web/handleSearch.js';
import type { Deps } from './atproto/types.js';

/**
 * Fake mode swaps every atproto dependency for one in-process repo and replaces OAuth with
 * a cookie-setting dev route. It exists for the end-to-end suite; it must never be enabled
 * in a deployment, so it is opt-in via an env var and shouts on boot.
 */
const FAKE_PDS = process.env.FAKE_PDS === '1';

// The production image sets NODE_ENV=production. Whatever else is in the environment,
// fake mode cannot come up there: the flag would otherwise be one typo in a .env away
// from a password-free sign-in on the public site.
if (FAKE_PDS && process.env.NODE_ENV === 'production') {
  console.error('FAKE_PDS=1 is refused when NODE_ENV=production.');
  process.exit(1);
}

const env = {
  PORT: Number(process.env.PORT ?? 8787),
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:8787',
  DB_PATH: process.env.DB_PATH ?? (FAKE_PDS ? ':memory:' : './letsmeet.db'),
  COOKIE_SECRET: process.env.COOKIE_SECRET ?? 'dev-cookie-secret',
  SESSION_ENC_KEY: process.env.SESSION_ENC_KEY ?? '00'.repeat(32),
  OAUTH_JWK: process.env.OAUTH_JWK,
};

/**
 * The dev defaults above are conveniences, not fallbacks: booting a real deployment on them
 * would sign cookies with a public string and encrypt OAuth sessions with a published key.
 * Fake mode is exempt — the e2e rig runs on the defaults deliberately.
 */
if (!FAKE_PDS) {
  const problems: string[] = [];
  if (env.COOKIE_SECRET === 'dev-cookie-secret') {
    problems.push('COOKIE_SECRET is unset or still the dev default (openssl rand -base64 32)');
  } else if (env.COOKIE_SECRET.length < 32) {
    problems.push('COOKIE_SECRET is too short: use at least 32 characters (openssl rand -base64 32)');
  }
  if (!/^[0-9a-f]{64}$/i.test(env.SESSION_ENC_KEY)) {
    problems.push('SESSION_ENC_KEY must be 64 hex characters (openssl rand -hex 32)');
  }
  if (env.SESSION_ENC_KEY === '00'.repeat(32)) {
    problems.push('SESSION_ENC_KEY is still the all-zero dev default (openssl rand -hex 32)');
  }
  if (problems.length) {
    console.error('refusing to boot without real secrets:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('See docs/deploy.md §1. Set FAKE_PDS=1 only for local dev/e2e.');
    process.exit(1);
  }
}

const db = openDb(env.DB_PATH);

let auth: AuthClient;
let deps: Deps;

if (FAKE_PDS) {
  const repo = new FakeRepo();
  const noAuth = () => { throw new Error('fake PDS mode: sign in through /dev/login'); };
  auth = {
    clientMetadata: {},
    jwks: { keys: [] },
    authorize: async () => noAuth(),
    callback: async () => noAuth(),
    restore: async () => noAuth(),
  };
  deps = { db, reader: repo, writerFor: async () => repo, now: () => new Date() };
  console.warn('FAKE_PDS=1 — in-process fake repo and /dev/login are enabled. Never in prod.');
} else {
  auth = await createOAuthClient(db, env);
  deps = {
    db,
    reader: new PublicPdsReader(),
    writerFor: async (did) => writerForAgent(await auth.restore(did)),
    now: () => new Date(),
  };
}

setInterval(() => {
  void flushOutbox(deps).catch((err) => console.error('outbox flush failed:', err));
  // Authorization requests that never came back leave an encrypted row behind; an hour is
  // far longer than any real round trip.
  db.prepare('DELETE FROM oauth_state WHERE created_at < ?').run(Date.now() - 3600_000);
  // Delivered outbox rows are history, not state; expired browser sessions are dead weight.
  pruneOutbox(db, Date.now() - 7 * 24 * 3600_000);
  pruneWebSessions(db, Date.now());
}, 60_000);

const app = createServer(deps, auth, {
  ...env, devLogin: FAKE_PDS, handleSearch: FAKE_PDS ? fakeHandleSearch : undefined,
});
serve({ fetch: app.fetch, port: env.PORT });
console.log(`letsmeet listening on :${env.PORT} (${env.PUBLIC_URL})`);
