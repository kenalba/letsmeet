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

/** The handle stored at sign-in, for display only — authorization always keys on the did. */
export async function getSessionHandle(c: Context, cookieSecret: string): Promise<string | null> {
  const handle = await getSignedCookie(c, cookieSecret, 'handle');
  return handle || null;
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

  /**
   * A place to land after sign-in, but only ever a same-site path: one leading slash (two
   * would be a scheme-relative URL to another host), nothing else accepted. Applied to the
   * query on the way in AND to what the OAuth state hands back — the round trip through
   * the authorization server is no reason to trust the value more.
   */
  const safeReturnTo = (v: unknown): string | undefined =>
    typeof v === 'string' && /^\/(?!\/)/.test(v) && v.length <= 512 ? v : undefined;

  app.get('/login', (c) =>
    c.html(renderPage(createElement(LoginPage, { returnTo: safeReturnTo(c.req.query('returnTo')) }))));

  /** Every sign-in failure is the same page with the handler's own sanitized string. */
  const loginError = (c: Context, message: string, status: 400 | 429, returnTo?: string) =>
    c.html(renderPage(createElement(LoginPage, { error: message, returnTo })), status);

  app.post('/login', async (c) => {
    // Same last-hop rule as the guest limiter: our proxy appends the real client.
    const xff = c.req.header('x-forwarded-for');
    const ip = xff ? xff.split(',').pop()!.trim() : 'local';
    if (!loginLimiter.allow(ip, Date.now())) {
      return loginError(c, 'Too many sign-in attempts — try again in a minute.', 429);
    }
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '').trim();
    const returnTo = safeReturnTo(form.get('returnTo'));
    if (!handle) return loginError(c, 'handle required', 400, returnTo);
    try {
      // The handle rides along so the callback can remember it for display ("Signed in as
      // ken.wzrdz.cool", not a bare did) without a resolution round trip per page view.
      // It's the handle the OAuth flow is about to authenticate, not a free claim.
      const url = await auth.authorize(handle, JSON.stringify({ returnTo, handle }));
      return c.redirect(url.toString());
    } catch (err) {
      console.error('login authorize failed:', err);
      return loginError(
        c, `Could not start sign-in for "${handle}". Check the handle and try again.`, 400,
        returnTo,
      );
    }
  });

  app.get('/oauth/callback', async (c) => {
    try {
      const { did, state } = await auth.callback(new URL(c.req.url).searchParams);
      let returnTo: string | undefined;
      let handle: string | undefined;
      // Our own envelope, but it made a round trip through the authorization server:
      // parse defensively and re-validate every field rather than trusting the trip.
      try {
        const parsed = JSON.parse(state ?? '') as { returnTo?: unknown; handle?: unknown };
        returnTo = safeReturnTo(parsed.returnTo);
        if (typeof parsed.handle === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(parsed.handle)) {
          handle = parsed.handle;
        }
      } catch { /* no or malformed state: fall back to did display and a "/" landing */ }
      const cookieOpts = {
        httpOnly: true, sameSite: 'Lax', path: '/', secure, maxAge: 60 * 60 * 24 * 30,
      } as const;
      await setSignedCookie(c, 'did', did, cookieSecret, cookieOpts);
      if (handle) await setSignedCookie(c, 'handle', handle, cookieSecret, cookieOpts);
      return c.redirect(returnTo ?? '/');
    } catch (err) {
      console.error('oauth callback failed:', err);
      return c.html(renderPage(createElement(SignInFailedPage)), 400);
    }
  });

  app.post('/logout', (c) => {
    deleteCookie(c, 'did', { path: '/' });
    deleteCookie(c, 'handle', { path: '/' });
    return c.redirect('/');
  });

  return app;
}
