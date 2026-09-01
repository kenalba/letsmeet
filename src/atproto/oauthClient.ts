import { NodeOAuthClient, JoseKey } from '@atproto/oauth-client-node';
import { Agent } from '@atproto/api';
import type { Database } from '../db/db.js';
import { StateStore, SessionStore } from '../db/sessions.js';

export interface AuthClient {
  clientMetadata: Record<string, unknown>;
  authorize(handle: string): Promise<URL>;
  callback(params: URLSearchParams): Promise<{ did: string }>;
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
          client_name: 'wzrdz-poll (dev)',
        }
      : {
          client_id: `${pub}/oauth/client-metadata.json`,
          client_name: 'wzrdz-poll',
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
    async authorize(handle) {
      return client.authorize(handle, { scope: SCOPE });
    },
    async callback(params) {
      const { session } = await client.callback(params);
      return { did: session.did };
    },
    async restore(did) {
      const session = await client.restore(did);
      return new Agent(session);
    },
  };
}
