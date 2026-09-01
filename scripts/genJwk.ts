import { JoseKey } from '@atproto/oauth-client-node';

// The kid is required: the client advertises private_key_jwt, and
// @atproto/oauth-client refuses a signing key without one at construction time.
const key = await JoseKey.generate(['ES256'], `letsmeet-${Date.now()}`);
console.log(JSON.stringify(key.privateJwk));
