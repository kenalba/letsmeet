import { describe, it, expect } from 'vitest';
import { authRoutes } from '../../src/web/routes/auth.js';
import type { AuthClient } from '../../src/atproto/oauthClient.js';

const stub: AuthClient = {
  clientMetadata: { client_id: 'https://poll.example/oauth/client-metadata.json' },
  authorize: async () => new URL('https://pds.example.com/authorize?x=1'),
  callback: async () => ({ did: 'did:plc:host' }),
  restore: async () => { throw new Error('not used here'); },
};
const app = authRoutes(stub, 'test-cookie-secret');

describe('auth routes', () => {
  it('serves client metadata as JSON', async () => {
    const res = await app.request('/oauth/client-metadata.json');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { client_id: string }).client_id).toContain('poll.example');
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
});
