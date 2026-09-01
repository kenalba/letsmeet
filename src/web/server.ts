import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Deps } from '../atproto/types.js';
import type { AuthClient } from '../atproto/oauthClient.js';
import { authRoutes } from './routes/auth.js';
import { pollRoutes } from './routes/polls.js';

export function createServer(
  deps: Deps, auth: AuthClient, env: { COOKIE_SECRET: string; PUBLIC_URL: string },
): Hono {
  const app = new Hono();
  app.use('/grid.js', serveStatic({ root: './public', rewriteRequestPath: () => '/grid.js' }));
  app.route('/', authRoutes(auth, env.COOKIE_SECRET));
  app.route('/', pollRoutes(deps, auth, env));
  return app;
}
