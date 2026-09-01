import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { setSignedCookie } from 'hono/cookie';
import type { Deps } from '../atproto/types.js';
import type { AuthClient } from '../atproto/oauthClient.js';
import { authRoutes } from './routes/auth.js';
import { pollRoutes } from './routes/polls.js';

export function createServer(
  deps: Deps,
  auth: AuthClient,
  /** `devLogin` mounts a password-free sign-in; only the fake-PDS test rig may set it. */
  env: { COOKIE_SECRET: string; PUBLIC_URL: string; devLogin?: boolean },
): Hono {
  const app = new Hono();
  app.use('/grid.js', serveStatic({ root: './public', rewriteRequestPath: () => '/grid.js' }));
  if (env.devLogin) {
    app.get('/dev/login', async (c) => {
      const did = c.req.query('did') ?? 'did:plc:devhost';
      await setSignedCookie(c, 'did', did, env.COOKIE_SECRET, {
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
