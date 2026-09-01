import { createElement } from 'react';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders, NONCE } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Deps } from '../atproto/types.js';
import type { AuthClient } from '../atproto/oauthClient.js';
import { GENERIC_ERROR } from '../core/errors.js';
import { authRoutes } from './routes/auth.js';
import { pollRoutes } from './routes/polls.js';
import { page } from './respond.js';
import { startSession, type SessionEnv } from './session.js';
import { ErrorPage } from './pages/ErrorPage.js';

/**
 * Largest request body any route accepts. The biggest legitimate one is the create form
 * with an 8000-grapheme description, which percent-encoding can inflate several-fold;
 * a response payload is a few KB. nginx enforces the same figure in front (deploy.md §3).
 */
export const MAX_BODY_BYTES = 256 * 1024;

export function createServer(
  deps: Deps,
  auth: AuthClient,
  /** `devLogin` mounts a password-free sign-in; only the fake-PDS test rig may set it. */
  env: { COOKIE_SECRET: string; PUBLIC_URL: string; devLogin?: boolean },
): Hono {
  const app = new Hono();
  const session: SessionEnv = {
    db: deps.db, cookieSecret: env.COOKIE_SECRET, secure: env.PUBLIC_URL.startsWith('https'),
  };

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // Every inline script carries this response's nonce (see nonce.ts); the islands
      // and stylesheet are same-origin files. Nothing else may run.
      scriptSrc: ["'self'", NONCE],
      // Inline `style=` attributes are how the grid paints heat and how the theme icons
      // hide; CSS is not a script-execution vector, so this is the pragmatic line.
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      // The sign-in form's response is a redirect to the visitor's authorization server;
      // browsers apply form-action to that redirect, so https: must be allowed.
      formAction: ["'self'", 'https:'],
    },
    xFrameOptions: 'DENY',
    // Edit links carry their token in the path: a third party gets at most our origin as
    // the Referer, never the path. (Not `no-referrer` — Chrome then sends `Origin: null`
    // on our own form posts, which the cross-site check above must treat as foreign.)
    referrerPolicy: 'strict-origin-when-cross-origin',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    crossOriginEmbedderPolicy: false,
  }));

  /**
   * Cross-site write protection beyond SameSite=Lax. Every current browser labels the
   * request itself with Sec-Fetch-Site, which a page cannot forge: that is the verdict
   * when present. Older browsers fall back to Origin, which must name this host (an
   * `Origin: null` — a sandboxed frame, a data: page — is cross-site for our purposes). A
   * request with neither header (curl, the test rig) has no browser ambient authority
   * to abuse and passes.
   */
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      const site = c.req.header('sec-fetch-site');
      const origin = c.req.header('origin');
      let crossSite: boolean;
      if (site !== undefined) {
        crossSite = site === 'cross-site';
      } else if (origin !== undefined) {
        let originHost: string | null = null;
        try { originHost = new URL(origin).host; } catch { originHost = null; }
        crossSite = originHost !== c.req.header('host');
      } else {
        crossSite = false;
      }
      if (crossSite) {
        console.warn(`rejected cross-site ${c.req.method} ${c.req.path} (origin=${origin} sec-fetch-site=${site})`);
        return c.text('Cross-site requests are not accepted.', 403);
      }
    }
    await next();
  });

  app.use('*', bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'Request body too large.' }, 413),
  }));

  app.notFound((c) => page(c, createElement(ErrorPage, {
    heading: 'Not found',
    message: "That page doesn't exist.",
  }), 404));

  /**
   * The last line of defence for anything a handler did not catch: log the real error
   * here, show the visitor a line with nothing in it. Messages meant for a person are
   * UserErrors and are handled (and shown) by the route that raised them.
   */
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`${c.req.method} ${c.req.path} failed:`, err);
    const wantsJson = c.req.header('accept')?.includes('application/json')
      || c.req.header('content-type')?.includes('application/json');
    if (wantsJson) return c.json({ error: GENERIC_ERROR }, 500);
    return page(c, createElement(ErrorPage, {
      heading: 'Something went wrong', message: GENERIC_ERROR,
    }), 500);
  });

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
      await startSession(c, session, did, null, deps.now().getTime());
      return c.redirect('/');
    });
  }
  app.route('/', authRoutes(auth, { ...session, publicUrl: env.PUBLIC_URL, now: deps.now }));
  app.route('/', pollRoutes(deps, auth, env));
  return app;
}
