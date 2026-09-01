import { createElement } from 'react';
import { Hono, type Context } from 'hono';
import type { AuthClient } from '../../atproto/oauthClient.js';
import { TokenBucket } from '../rateLimit.js';
import { page } from '../respond.js';
import { clientIp } from '../clientIp.js';
import { startSession, endSession, type SessionEnv } from '../session.js';
import { LoginPage, SignInFailedPage } from '../pages/Login.js';

export interface AuthEnv extends SessionEnv {
  publicUrl: string;
  now?: () => Date;
}

export function authRoutes(auth: AuthClient, env: AuthEnv): Hono {
  const app = new Hono();
  const now = env.now ?? (() => new Date());
  // Per-app, not module-global, for the same reason as the guest limiter in polls.ts.
  // Sign-in is a handle resolution plus an authorization-server round trip: cheap for the
  // client, not for us, so the budget is small and refills slowly (5 burst, ~1 per 20s).
  const loginLimiter = new TokenBucket(5, 0.05);

  app.get('/oauth/client-metadata.json', (c) => c.json(auth.clientMetadata));

  // Advertised as `jwks_uri` by the non-loopback client metadata; the authorization server
  // fetches it to verify the private_key_jwt assertions this app signs.
  app.get('/oauth/jwks.json', (c) => c.json(auth.jwks));

  /**
   * A place to land after sign-in, but only ever a same-site path. Parsed against a
   * throwaway base rather than pattern-matched: a regex that "looks for a leading slash"
   * misses that a URL special scheme treats `\` as `/` (so `/\evil.com` is an off-site
   * host), plus tab/newline variants the browser strips before parsing. If the value
   * resolves to any origin but the base's, it is not same-site — reject it. Applied to the
   * query on the way in AND to what the OAuth state hands back: the round trip through the
   * authorization server is no reason to trust the value more.
   */
  const safeReturnTo = (v: unknown): string | undefined => {
    if (typeof v !== 'string' || v.length > 512) return undefined;
    try {
      const base = 'https://letsmeet.invalid';
      const u = new URL(v, base);
      return u.origin === base ? u.pathname + u.search + u.hash : undefined;
    } catch {
      return undefined;
    }
  };

  app.get('/login', (c) =>
    page(c, createElement(LoginPage, { returnTo: safeReturnTo(c.req.query('returnTo')) })));

  /** Every sign-in failure is the same page with the handler's own sanitized string. */
  const loginError = (c: Context, message: string, status: 400 | 429, returnTo?: string) =>
    page(c, createElement(LoginPage, { error: message, returnTo }), status);

  app.post('/login', async (c) => {
    if (!loginLimiter.allow(clientIp(c), now().getTime())) {
      return loginError(c, 'Too many sign-in attempts — try again in a minute.', 429);
    }
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '').trim();
    const returnTo = safeReturnTo(form.get('returnTo'));
    if (!handle) return loginError(c, 'handle required', 400, returnTo);
    try {
      // Only the landing path rides the state. The handle to display is NOT carried
      // through: what the visitor typed is a hint the authorization server may ignore
      // (they can sign in as any account there), so the callback resolves the handle from
      // the DID that actually authenticated.
      const url = await auth.authorize(handle, JSON.stringify({ returnTo }));
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
      const { did, handle, state } = await auth.callback(new URL(c.req.url).searchParams);
      let returnTo: string | undefined;
      // Our own envelope, but it made a round trip through the authorization server:
      // parse defensively and re-validate rather than trusting the trip.
      try {
        const parsed = JSON.parse(state ?? '') as { returnTo?: unknown };
        returnTo = safeReturnTo(parsed.returnTo);
      } catch { /* no or malformed state: land on "/" */ }
      const shown = typeof handle === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(handle) ? handle : null;
      await startSession(c, env, did, shown, now().getTime());
      return c.redirect(returnTo ?? '/');
    } catch (err) {
      console.error('oauth callback failed:', err);
      return page(c, createElement(SignInFailedPage), 400);
    }
  });

  app.post('/logout', async (c) => {
    await endSession(c, env);
    return c.redirect('/');
  });

  return app;
}
