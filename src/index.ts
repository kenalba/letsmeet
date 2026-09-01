import { serve } from '@hono/node-server';
import { openDb } from './db/db.js';
import { createOAuthClient, type AuthClient } from './atproto/oauthClient.js';
import { PublicPdsReader, writerForAgent } from './atproto/pds.js';
import { FakeRepo } from './atproto/fakeRepo.js';
import { flushOutbox } from './services/responses.js';
import { createServer } from './web/server.js';
import type { Deps } from './atproto/types.js';

/**
 * Fake mode swaps every atproto dependency for one in-process repo and replaces OAuth with
 * a cookie-setting dev route. It exists for the end-to-end suite; it must never be enabled
 * in a deployment, so it is opt-in via an env var and shouts on boot.
 */
const FAKE_PDS = process.env.FAKE_PDS === '1';

const env = {
  PORT: Number(process.env.PORT ?? 8787),
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:8787',
  DB_PATH: process.env.DB_PATH ?? (FAKE_PDS ? ':memory:' : './wzrdz-poll.db'),
  COOKIE_SECRET: process.env.COOKIE_SECRET ?? 'dev-cookie-secret',
  SESSION_ENC_KEY: process.env.SESSION_ENC_KEY ?? '00'.repeat(32),
  OAUTH_JWK: process.env.OAUTH_JWK,
};

const db = openDb(env.DB_PATH);

let auth: AuthClient;
let deps: Deps;

if (FAKE_PDS) {
  const repo = new FakeRepo();
  const noAuth = () => { throw new Error('fake PDS mode: sign in through /dev/login'); };
  auth = {
    clientMetadata: {},
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
}, 60_000);

const app = createServer(deps, auth, { ...env, devLogin: FAKE_PDS });
serve({ fetch: app.fetch, port: env.PORT });
console.log(`wzrdz-poll listening on :${env.PORT} (${env.PUBLIC_URL})`);
