import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { AuthClient } from '../../atproto/oauthClient.js';

export async function getSessionDid(c: Context, cookieSecret: string): Promise<string | null> {
  const did = await getSignedCookie(c, cookieSecret, 'did');
  return did || null;
}

export function authRoutes(auth: AuthClient, cookieSecret: string): Hono {
  const app = new Hono();

  app.get('/oauth/client-metadata.json', (c) => c.json(auth.clientMetadata));

  app.get('/login', (c) =>
    c.html(
      `<form method="post" action="/login">
         <label>Your handle <input name="handle" placeholder="you.bsky.social" required></label>
         <button>Sign in</button>
       </form>`,
    ),
  );

  app.post('/login', async (c) => {
    const form = await c.req.formData();
    const handle = String(form.get('handle') ?? '').trim();
    if (!handle) return c.text('handle required', 400);
    try {
      const url = await auth.authorize(handle);
      return c.redirect(url.toString());
    } catch (err) {
      console.error('login authorize failed:', err);
      return c.text(`Could not start sign-in for "${handle}". Check the handle and try again.`, 400);
    }
  });

  app.get('/oauth/callback', async (c) => {
    try {
      const { did } = await auth.callback(new URL(c.req.url).searchParams);
      await setSignedCookie(c, 'did', did, cookieSecret, {
        httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30,
      });
      return c.redirect('/');
    } catch (err) {
      console.error('oauth callback failed:', err);
      return c.html('<p>Sign-in failed or was cancelled. <a href="/login">Try again</a></p>', 400);
    }
  });

  app.post('/logout', (c) => {
    deleteCookie(c, 'did', { path: '/' });
    return c.redirect('/');
  });

  return app;
}
