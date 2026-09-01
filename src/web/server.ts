import { createElement } from 'react';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Deps } from '../atproto/types.js';
import type { AuthClient } from '../atproto/oauthClient.js';
import { authRoutes, setNamedCookie } from './routes/auth.js';
import { pollRoutes } from './routes/polls.js';
import { renderPage } from './render.js';
import { ErrorPage } from './pages/ErrorPage.js';

export function createServer(
  deps: Deps,
  auth: AuthClient,
  /** `devLogin` mounts a password-free sign-in; only the fake-PDS test rig may set it. */
  env: { COOKIE_SECRET: string; PUBLIC_URL: string; devLogin?: boolean },
): Hono {
  const app = new Hono();
  app.notFound((c) => c.html(renderPage(createElement(ErrorPage, {
    heading: 'Not found',
    message: "That page doesn't exist.",
  })), 404));
  // Bundle filenames are stable across deploys (no content hash), so tell browsers to
  // revalidate every load rather than cache a stale build indefinitely.
  app.use('/assets/*', serveStatic({
    root: './public',
    onFound: (_path, c) => {
      c.header('Cache-Control', 'no-cache');
    },
  }));
  if (env.devLogin) {
    app.get('/dev/login', async (c) => {
      const did = c.req.query('did') ?? 'did:plc:devhost';
      await setNamedCookie(c, env.COOKIE_SECRET, 'did', did, {
        httpOnly: true, sameSite: 'Lax', path: '/',
        secure: env.PUBLIC_URL.startsWith('https'),
      });
      return c.redirect('/');
    });
  }
  app.route('/', authRoutes(auth, env.COOKIE_SECRET, env.PUBLIC_URL));
  app.route('/', pollRoutes(deps, auth, env));
  return app;
}
