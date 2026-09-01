import { createElement } from 'react';
import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { AuthClient } from '../../atproto/oauthClient.js';
import { TokenBucket } from '../rateLimit.js';
import { renderPage } from '../render.js';
import { LoginPage, SignInFailedPage } from '../pages/Login.js';

export async function getSessionDid(c: Context, cookieSecret: string): Promise<string | null> {
  const did = await getSignedCookie(c, cookieSecret, 'did');
  return did || null;
}

export function authRoutes(auth: AuthClient, cookieSecret: string, publicUrl: string): Hono {
  const app = new Hono();
  // Per-app, not module-global, for the same reason as the guest limiter in polls.ts.
  // Sign-in is a handle resolution plus an authorization-server round trip: cheap for the
  // client, not for us, so the budget is small and refills slowly (5 burst, ~1 per 20s).
  const loginLimiter = new TokenBucket(5, 0.05);
  const secure = publicUrl.startsWith('https');

  app.get('/oauth/client-metadata.json', (c) => c.json(auth.clientMetadata));

  // Advertised as `jwks_uri` by the non-loopback client metadata; the authorization server
  // fetches it to verify the private_key_jwt assertions this app signs.
  app.get('/oauth/jwks.json', (c) => c.json(auth.jwks));

  app.get('/login', (c) => c.html(renderPage(createElement(LoginPage))));

  /** Every sign-in failure is the same page with the handler's own sanitized string. */
  const loginError = (c: Context, message: string, status: 400 | 429) =>
    c.html(renderPage(createElement(LoginPage, { error: message })), status);

  app.post('/login', async (c) => {
    // Same last-hop rule as the guest limiter: our proxy appends the real client.
    const xff = c.req.header('x-forwarded-for');
    const ip = xff ? xff.split(',').pop()!.trim() : 'local';
    if (!loginLimiter.allow(ip, Date.now())) {
      return loginError(c, 'Too many sign-in attempts — try again in a minute.', 429);
    }
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '').trim();
    if (!handle) return loginError(c, 'handle required', 400);
    try {
      const url = await auth.authorize(handle);
      return c.redirect(url.toString());
    } catch (err) {
      console.error('login authorize failed:', err);
      return loginError(
        c, `Could not start sign-in for "${handle}". Check the handle and try again.`, 400,
      );
    }
  });

  app.get('/oauth/callback', async (c) => {
    try {
      const { did } = await auth.callback(new URL(c.req.url).searchParams);
      await setSignedCookie(c, 'did', did, cookieSecret, {
        httpOnly: true, sameSite: 'Lax', path: '/', secure, maxAge: 60 * 60 * 24 * 30,
      });
      return c.redirect('/');
    } catch (err) {
      console.error('oauth callback failed:', err);
      return c.html(renderPage(createElement(SignInFailedPage)), 400);
    }
  });

  app.post('/logout', (c) => {
    deleteCookie(c, 'did', { path: '/' });
    return c.redirect('/');
  });

  return app;
}
