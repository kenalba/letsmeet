import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { createEditSecret, lookupEditSecret } from '../../src/db/editSecrets.js';

describe('edit secrets', () => {
  const db = openDb(':memory:');
  const POLL = 'at://did:plc:host/lol.letsmeet.poll.schedule/3kabc';

  it('round-trips a token to its rkey', () => {
    const token = createEditSecret(db, POLL, '3kresp1');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
    expect(lookupEditSecret(db, POLL, token)).toBe('3kresp1');
  });
  it('rejects a bad token and the right token on the wrong poll', () => {
    const token = createEditSecret(db, POLL, '3kresp2');
    expect(lookupEditSecret(db, POLL, 'nope')).toBeNull();
    expect(lookupEditSecret(db, 'at://other/uri/1', token)).toBeNull();
  });
  it('never stores the raw token', () => {
    const token = createEditSecret(db, POLL, '3kresp3');
    const rows = db.prepare('SELECT token_hash FROM edit_secret').all() as { token_hash: string }[];
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
  });
});
