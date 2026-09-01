import { NodeOAuthClient, JoseKey } from '@atproto/oauth-client-node';
import { Agent } from '@atproto/api';
import type { Database } from '../db/db.js';
import { StateStore, SessionStore } from '../db/sessions.js';
import { resolveHandle } from './pds.js';

export interface AuthClient {
  clientMetadata: Record<string, unknown>;
  /** Public half of the keyset, served at /oauth/jwks.json. Never contains a private key. */
  jwks: Record<string, unknown>;
  /**
   * `state` rides the OAuth `state` parameter through the authorization round trip and
   * comes back from `callback` — the only thing that survives the PDS redirect. The auth
   * routes use it to carry a JSON envelope (the returnTo path, the typed handle) and are
   * responsible for validating every field on the way back; this layer just carries it.
   */
  authorize(handle: string, state?: string): Promise<URL>;
  /**
   * `handle` is the one the authenticated DID's document declares — resolved after the
   * fact, never the value the visitor typed (that was only a login hint) — or null when
   * the document has none or could not be read. For display only.
   */
  callback(params: URLSearchParams): Promise<{ did: string; handle?: string | null; state?: string }>;
  restore(did: string): Promise<Agent>;
}

const SCOPE = 'atproto transition:generic';

export async function createOAuthClient(
  db: Database.Database,
  env: { PUBLIC_URL: string; SESSION_ENC_KEY: string; OAUTH_JWK?: string },
): Promise<AuthClient> {
  const pub = env.PUBLIC_URL.replace(/\/$/, '');
  const isLoopback = pub.startsWith('http://localhost') || pub.startsWith('http://127.0.0.1');
  // RFC 8252: a loopback redirect_uri must use an IP literal, never the "localhost" name,
  // even though the loopback client_id origin itself is spelled "http://localhost".
  const redirectBase = isLoopback ? pub.replace('//localhost', '//127.0.0.1') : pub;
  const redirectUri = `${redirectBase}/oauth/callback`;

  const client = new NodeOAuthClient({
    clientMetadata: isLoopback
      ? {
          client_id: `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPE)}`,
          redirect_uris: [redirectUri],
          scope: SCOPE,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'web',
          dpop_bound_access_tokens: true,
          client_name: 'letsmeet (dev)',
        }
      : {
          client_id: `${pub}/oauth/client-metadata.json`,
          client_name: 'letsmeet',
          client_uri: pub,
          redirect_uris: [redirectUri],
          scope: SCOPE,
          token_endpoint_auth_method: 'private_key_jwt',
          token_endpoint_auth_signing_alg: 'ES256',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          application_type: 'web',
          dpop_bound_access_tokens: true,
          jwks_uri: `${pub}/oauth/jwks.json`,
        },
    keyset: isLoopback || !env.OAUTH_JWK
      ? undefined
      : [await JoseKey.fromImportable(JSON.parse(env.OAUTH_JWK))],
    stateStore: new StateStore(db, env.SESSION_ENC_KEY),
    sessionStore: new SessionStore(db, env.SESSION_ENC_KEY),
  });

  return {
    clientMetadata: client.clientMetadata as unknown as Record<string, unknown>,
    // `client.jwks` is derived from the keyset's *public* JWKs, and is `{ keys: [] }` for the
    // loopback client, which authenticates with `none` and has no keyset at all.
    jwks: client.jwks as unknown as Record<string, unknown>,
    async authorize(handle, state) {
      return client.authorize(handle, { scope: SCOPE, state });
    },
    async callback(params) {
      const { session, state } = await client.callback(params);
      return { did: session.did, handle: await resolveHandle(session.did), state: state ?? undefined };
    },
    async restore(did) {
      const session = await client.restore(did);
      return new Agent(session);
    },
  };
}
