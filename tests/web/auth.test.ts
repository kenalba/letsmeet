import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../../src/web/routes/auth.js';
import { cookieDomainFor, isApexHost, readSession, sessionEnvFor } from '../../src/web/session.js';
import { openDb } from '../../src/db/db.js';
import { getWebSession } from '../../src/db/webSessions.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

/** A real ES256 *public* JWK: the served JWKS must never grow a `d` (private) member. */
const publicJwk = {
  kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: 'k1',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
};
const stub: AuthClient = {
  clientMetadata: { client_id: 'https://poll.example/oauth/client-metadata.json' },
  jwks: { keys: [publicJwk] },
  authorize: async () => new URL('https://pds.example.com/authorize?x=1'),
  callback: async () => ({ did: 'did:plc:host', handle: 'ken.wzrdz.cool' }),
  restore: async () => { throw new Error('not used here'); },
};
const env = (publicUrl = 'https://poll.example') => ({
  ...sessionEnvFor(openDb(':memory:'), 'test-cookie-secret', publicUrl), publicUrl,
});
const app = authRoutes(stub, env());

const failingStub: AuthClient = {
  clientMetadata: { client_id: 'https://poll.example/oauth/client-metadata.json' },
  jwks: { keys: [] },
  authorize: async () => { throw new Error('secret-internal-detail'); },
  callback: async () => { throw new Error('secret-internal-detail'); },
  restore: async () => { throw new Error('not used here'); },
};
const failingApp = authRoutes(failingStub, env());

/** The live session cookie: the Set-Cookie that carries a value, not the host-only clear. */
const cookieOf = (res: Response) =>
  res.headers.getSetCookie().find((s) => s.startsWith('sid=') && !s.startsWith('sid=;'))!.split(';')[0];

describe('auth routes', () => {
  it('serves client metadata as JSON', async () => {
    const res = await app.request('/oauth/client-metadata.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { client_id: string }).client_id).toContain('poll.example');
  });
  it('serves the JWKS the client metadata advertises, with no private key material', async () => {
    const res = await app.request('/oauth/jwks.json');
    expect(res.status).toBe(200);
    const raw = await res.text();
    const body = JSON.parse(raw) as { keys: Array<Record<string, unknown>> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys[0]).toMatchObject({ kty: 'EC', kid: 'k1' });
    // The private half must never leave the process, in any key of any shape.
    expect(raw).not.toContain('"d"');
    for (const k of body.keys) expect(k).not.toHaveProperty('d');
  });

  it('marks the session cookie Secure, HttpOnly, Lax and Domain-wide on an https origin', async () => {
    const res = await app.request('/oauth/callback?code=abc&state=xyz');
    const all = res.headers.getSetCookie();
    const live = all.find((s) => s.startsWith('sid=') && !s.startsWith('sid=;'))!;
    expect(live).toContain('Secure');
    expect(live).toContain('HttpOnly');
    expect(live).toContain('SameSite=Lax');
    // Every `<name>.sez.poll.example` gets it too: the friend view can know its owner there.
    expect(live).toContain('Domain=poll.example');
    // A cookie set before the Domain attribute existed is host-only and would ride beside
    // this one on the apex: it is cleared in the same response.
    expect(all.some((s) => s.startsWith('sid=;') && s.includes('Max-Age=0') && !s.includes('Domain='))).toBe(true);
  });
  it('sets a host-only cookie and no clear on a host with no dots (local dev)', async () => {
    const http = authRoutes(stub, env('http://localhost:8787'));
    const res = await http.request('/oauth/callback?code=abc&state=xyz');
    const all = res.headers.getSetCookie();
    expect(all.length).toBe(1);
    expect(all[0]).not.toContain('Domain=');
    expect(all[0]).not.toContain('Secure');
  });
  it('cookieDomainFor: the public host without its port; null for localhost and ip literals', () => {
    expect(cookieDomainFor('https://letsmeet.lol')).toBe('letsmeet.lol');
    expect(cookieDomainFor('https://poll.example:8443')).toBe('poll.example');
    expect(cookieDomainFor('http://localhost:8787')).toBeNull();
    expect(cookieDomainFor('http://127.0.0.1:8787')).toBeNull();
    expect(cookieDomainFor('http://[::1]:8787')).toBeNull();
  });

  it('rate-limits a burst of sign-in attempts from one IP', async () => {
    // A fresh app so the shared module-level one keeps its full budget.
    const limited = authRoutes(stub, env());
    let denied = 0;
    for (let i = 0; i < 6; i++) {
      const res = await limited.request('/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '10.0.0.7' },
        body: new URLSearchParams({ handle: 'ken.letsmeet.lol' }),
      });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('POST /login redirects to the authorization URL', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ handle: 'ken.letsmeet.lol' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('pds.example.com/authorize');
  });
  it('the login page points people without an account at Bluesky and selfhosted.social', async () => {
    const body = await (await app.request('/login')).text();
    expect(body).toContain('https://bsky.app/');
    expect(body).toContain('https://selfhosted.social/');
  });
  it('callback opens a server-side session and redirects home', async () => {
    const e = env();
    const a = authRoutes(stub, e);
    const res = await a.request('/oauth/callback?code=abc&state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('sid=');
    // The cookie is an opaque id; the DID and handle live in the row it points at.
    expect(res.headers.get('set-cookie')).not.toContain('did:plc:host');
    const rows = e.db.prepare('SELECT sid, did, handle FROM web_session').all() as
      Array<{ sid: string; did: string; handle: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].did).toBe('did:plc:host');
    expect(rows[0].handle).toBe('ken.wzrdz.cool');
  });
  it('the displayed handle comes from the callback (the authenticated DID), not the typed one', async () => {
    const e = env();
    const a = authRoutes({ ...stub, callback: async () => ({ did: 'did:plc:host', handle: null }) }, e);
    await a.request('/login', {
      method: 'POST', body: new URLSearchParams({ handle: 'someone.else.example' }),
    });
    await a.request('/oauth/callback?code=abc&state=xyz');
    const row = e.db.prepare('SELECT handle FROM web_session').get() as { handle: string | null };
    expect(row.handle).toBeNull();
  });
  it('logout revokes the session row, so a copied cookie is dead afterwards', async () => {
    const e = env();
    const a = authRoutes(stub, e);
    const login = await a.request('/oauth/callback?code=abc&state=xyz');
    const cookie = cookieOf(login);
    const sid = e.db.prepare('SELECT sid FROM web_session').get() as { sid: string };
    expect(getWebSession(e.db, sid.sid, Date.now())).not.toBeNull();
    const res = await a.request('/logout', { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(302);
    const clears = res.headers.getSetCookie();
    expect(clears.some((s) => s.startsWith('sid=;') && s.includes('Domain=poll.example'))).toBe(true);
    expect(clears.some((s) => s.startsWith('sid=;') && !s.includes('Domain='))).toBe(true);
    expect(getWebSession(e.db, sid.sid, Date.now())).toBeNull();
  });
  it('a session expires server-side after 30 days whatever the cookie claims', async () => {
    const e = env();
    const a = authRoutes(stub, e);
    await a.request('/oauth/callback?code=abc&state=xyz');
    const sid = (e.db.prepare('SELECT sid FROM web_session').get() as { sid: string }).sid;
    const thirtyOneDays = Date.now() + 31 * 24 * 3600_000;
    expect(getWebSession(e.db, sid, thirtyOneDays)).toBeNull();
  });
  it('POST /login does not leak internal error details when authorize() throws', async () => {
    const res = await failingApp.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ handle: 'ken.letsmeet.lol' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('secret-internal-detail');
  });
  it('GET /oauth/callback does not leak internal error details when callback() throws', async () => {
    const res = await failingApp.request('/oauth/callback?code=x&state=y');
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('/login');
    expect(body).not.toContain('secret-internal-detail');
  });
});

describe('returnTo round trip', () => {
  const withState = (state?: string): AuthClient => ({
    ...stub,
    callback: async () => ({ did: 'did:plc:host', handle: 'ken.wzrdz.cool', state }),
  });

  it('renders a validated returnTo as a hidden form field', async () => {
    const res = await app.request('/login?returnTo=%2Fp%2Fabc123');
    const body = await res.text();
    expect(body).toContain('name="returnTo"');
    expect(body).toContain('value="/p/abc123"');
  });

  it('drops a returnTo that is not a same-site path', async () => {
    for (const evil of [
      'https://evil.example/p/x', '//evil.example/p/x', 'javascript:alert(1)',
      // Backslash and tab/newline tricks the browser normalises into an off-site host —
      // a leading-slash regex admits all of these; the URL parser rejects them.
      '/\\evil.example', '/\t/evil.example', '/\n/evil.example',
    ]) {
      const res = await app.request(`/login?returnTo=${encodeURIComponent(evil)}`);
      const body = await res.text();
      expect(body).not.toContain('name="returnTo"');
      expect(body).not.toContain('evil.example');
    }
  });

  it('callback lands on the state envelope\'s returnTo', async () => {
    const rt = authRoutes(withState(JSON.stringify({ returnTo: '/p/abc123' })), env());
    const res = await rt.request('/oauth/callback?code=x&state=y');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/p/abc123');
    expect(res.headers.get('set-cookie')).toContain('sid=');
  });

  it('callback refuses an off-site returnTo from the state and lands on /', async () => {
    const rt = authRoutes(withState(JSON.stringify({ returnTo: 'https://evil.example/' })), env());
    const res = await rt.request('/oauth/callback?code=x&state=y');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('a malformed handle from the callback is dropped rather than stored', async () => {
    const e = env();
    const rt = authRoutes({ ...stub, callback: async () => ({ did: 'did:plc:host', handle: 'bad<name>' }) }, e);
    await rt.request('/oauth/callback?code=x&state=y');
    const row = e.db.prepare('SELECT handle FROM web_session').get() as { handle: string | null };
    expect(row.handle).toBeNull();
  });

  it('callback with no state still signs in and lands on /', async () => {
    const rt = authRoutes(withState(undefined), env());
    const res = await rt.request('/oauth/callback?code=x&state=y');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.get('set-cookie')).toContain('sid=');
  });
});

describe('sessions minted before the domain cookie', () => {
  /** A one-route app that does what every real route does: read the session. */
  const probe = (e: ReturnType<typeof env>) => {
    const app = new Hono();
    app.get('/probe', async (c) =>
      c.json({ did: (await readSession(c, e, Date.now()))?.did ?? null }));
    return app;
  };

  it('re-issues the cookie with Domain once, on the apex only', async () => {
    const e = env();
    const signedIn = await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz');
    const cookie = cookieOf(signedIn);
    // Pretend this row predates the Domain attribute.
    e.db.prepare('UPDATE web_session SET cookie_v = 0').run();
    const app = probe(e);

    // The alias host issues nothing: a cookie set there would be scoped to it.
    const alias = await app.request('/probe', { headers: { cookie, host: 'ken.sez.poll.example' } });
    expect(alias.headers.getSetCookie()).toEqual([]);
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 0 });

    const apex = await app.request('/probe', { headers: { cookie, host: 'poll.example' } });
    const set = apex.headers.getSetCookie();
    expect(set.some((s) => s.startsWith('sid=') && !s.startsWith('sid=;') && s.includes('Domain=poll.example'))).toBe(true);
    // The host-only cookie the browser still holds is cleared in the same response.
    expect(set.some((s) => s.startsWith('sid=;') && !s.includes('Domain='))).toBe(true);
    expect((await apex.json() as { did: string }).did).toBe('did:plc:host');
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 1 });

    // Marked: the next apex request issues nothing.
    expect((await app.request('/probe', { headers: { cookie, host: 'poll.example' } }))
      .headers.getSetCookie()).toEqual([]);
  });

  it('issues nothing where no Domain is possible (local dev)', async () => {
    const e = env('http://localhost:8787');
    const cookie = cookieOf(await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz'));
    e.db.prepare('UPDATE web_session SET cookie_v = 0').run();
    const res = await probe(e).request('/probe', { headers: { cookie, host: 'localhost:8787' } });
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await res.json() as { did: string }).did).toBe('did:plc:host');
  });

  it('a fresh sign-in is already marked, whatever host it happened on', async () => {
    const e = env();
    await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz');
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 1 });
  });

  it('a write that fails leaves the row for the next request to retry', async () => {
    const e = env();
    const signedIn = await authRoutes(stub, e).request('/oauth/callback?code=abc&state=xyz');
    const cookie = cookieOf(signedIn);
    e.db.prepare('UPDATE web_session SET cookie_v = 0').run();
    const app = probe(e);

    // The SELECT still works, so the session reads fine; only the mark fails.
    e.db.exec("CREATE TRIGGER no_mark BEFORE UPDATE ON web_session BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await app.request('/probe', { headers: { cookie, host: 'poll.example' } });

    // The user is served: the cookie is re-issued even though nothing recorded it.
    expect(first.status).toBe(200);
    expect((await first.json() as { did: string }).did).toBe('did:plc:host');
    expect(first.headers.getSetCookie().some((c) =>
      c.startsWith('sid=') && !c.startsWith('sid=;') && c.includes('Domain=poll.example'))).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 0 });

    // Still 0, so the next request tries the whole thing again — and this time it sticks.
    e.db.exec('DROP TRIGGER no_mark');
    const second = await app.request('/probe', { headers: { cookie, host: 'poll.example' } });
    expect(second.headers.getSetCookie().some((c) =>
      c.startsWith('sid=') && !c.startsWith('sid=;') && c.includes('Domain=poll.example'))).toBe(true);
    expect(e.db.prepare('SELECT cookie_v FROM web_session').get()).toEqual({ cookie_v: 1 });
  });

  it('isApexHost reads the apex through case, a trailing dot and a port', () => {
    expect(isApexHost('poll.example', 'poll.example')).toBe(true);
    expect(isApexHost('POLL.example.', 'poll.example')).toBe(true);
    expect(isApexHost('poll.example:443', 'poll.example')).toBe(true);
    expect(isApexHost('ken.sez.poll.example', 'poll.example')).toBe(false);
    expect(isApexHost(undefined, 'poll.example')).toBe(false);
  });

  it('isApexHost takes nothing that merely contains the apex', () => {
    // Every one of these is a host a browser could send; none of them is letsmeet.lol.
    expect(isApexHost('LETSMEET.LOL', 'letsmeet.lol')).toBe(true);
    expect(isApexHost('letsmeet.lol.', 'letsmeet.lol')).toBe(true);
    expect(isApexHost('letsmeet.lol:8443', 'letsmeet.lol')).toBe(true);
    expect(isApexHost('evil-letsmeet.lol', 'letsmeet.lol')).toBe(false);
    expect(isApexHost('letsmeet.lol.evil', 'letsmeet.lol')).toBe(false);
    expect(isApexHost('letsmeet.lol@evil.com', 'letsmeet.lol')).toBe(false);
    expect(isApexHost('ken.sez.letsmeet.lol', 'letsmeet.lol')).toBe(false);
  });
});
