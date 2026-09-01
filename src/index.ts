import { serve } from '@hono/node-server';
import { openDb } from './db/db.js';
import { createOAuthClient } from './atproto/oauthClient.js';
import { PublicPdsReader, writerForAgent } from './atproto/pds.js';
import { flushOutbox } from './services/responses.js';
import { createServer } from './web/server.js';
import type { Deps } from './atproto/types.js';

const env = {
  PORT: Number(process.env.PORT ?? 8787),
  PUBLIC_URL: process.env.PUBLIC_URL ?? 'http://localhost:8787',
  DB_PATH: process.env.DB_PATH ?? './wzrdz-poll.db',
  COOKIE_SECRET: process.env.COOKIE_SECRET ?? 'dev-cookie-secret',
  SESSION_ENC_KEY: process.env.SESSION_ENC_KEY ?? '00'.repeat(32),
  OAUTH_JWK: process.env.OAUTH_JWK,
};

const db = openDb(env.DB_PATH);
const auth = await createOAuthClient(db, env);
const deps: Deps = {
  db,
  reader: new PublicPdsReader(),
  writerFor: async (did) => writerForAgent(await auth.restore(did)),
  now: () => new Date(),
};

setInterval(() => {
  void flushOutbox(deps).catch((err) => console.error('outbox flush failed:', err));
}, 60_000);

serve({ fetch: createServer(deps, auth, env).fetch, port: env.PORT });
console.log(`wzrdz-poll listening on :${env.PORT} (${env.PUBLIC_URL})`);
