import { describe, it, expect } from 'vitest';
import { authRoutes } from '../../src/web/routes/auth.js';
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
  callback: async () => ({ did: 'did:plc:host' }),
  restore: async () => { throw new Error('not used here'); },
};
const app = authRoutes(stub, 'test-cookie-secret', 'https://poll.example');

const failingStub: AuthClient = {
  clientMetadata: { client_id: 'https://poll.example/oauth/client-metadata.json' },
  jwks: { keys: [] },
  authorize: async () => { throw new Error('secret-internal-detail'); },
  callback: async () => { throw new Error('secret-internal-detail'); },
  restore: async () => { throw new Error('not used here'); },
};
const failingApp = authRoutes(failingStub, 'test-cookie-secret', 'https://poll.example');

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

  it('marks the session cookie Secure on an https origin', async () => {
    const res = await app.request('/oauth/callback?code=abc&state=xyz');
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('leaves the session cookie non-Secure on a plain-http origin', async () => {
    const http = authRoutes(stub, 'test-cookie-secret', 'http://localhost:8787');
    const res = await http.request('/oauth/callback?code=abc&state=xyz');
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('rate-limits a burst of sign-in attempts from one IP', async () => {
    // A fresh app so the shared module-level one keeps its full budget.
    const limited = authRoutes(stub, 'test-cookie-secret', 'https://poll.example');
    let denied = 0;
    for (let i = 0; i < 6; i++) {
      const res = await limited.request('/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '10.0.0.7' },
        body: new URLSearchParams({ handle: 'ken.wzrdz.cool' }),
      });
      if (res.status === 429) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('POST /login redirects to the authorization URL', async () => {
    const res = await app.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ handle: 'ken.wzrdz.cool' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('pds.example.com/authorize');
  });
  it('callback sets a signed did cookie and redirects home', async () => {
    const res = await app.request('/oauth/callback?code=abc&state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('did=');
  });
  it('logout clears the cookie', async () => {
    const res = await app.request('/logout', { method: 'POST' });
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('did=;');
  });
  it('POST /login does not leak internal error details when authorize() throws', async () => {
    const res = await failingApp.request('/login', {
      method: 'POST',
      body: new URLSearchParams({ handle: 'ken.wzrdz.cool' }),
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
