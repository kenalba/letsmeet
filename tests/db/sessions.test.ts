import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb } from '../../src/db/db.js';
import { StateStore, SessionStore, encrypt, decrypt } from '../../src/db/sessions.js';

const KEY = randomBytes(32).toString('hex');

describe('encrypt/decrypt', () => {
  it('round-trips', () => {
    expect(decrypt(KEY, encrypt(KEY, 'secret'))).toBe('secret');
  });
  it('fails with the wrong key', () => {
    const other = randomBytes(32).toString('hex');
    expect(() => decrypt(other, encrypt(KEY, 'secret'))).toThrow();
  });
});

describe('StateStore / SessionStore', () => {
  it('stores and retrieves oauth state', async () => {
    const store = new StateStore(openDb(':memory:'), KEY);
    await store.set('k1', { dpopKey: 'x' } as never);
    expect(await store.get('k1')).toEqual({ dpopKey: 'x' });
    await store.del('k1');
    expect(await store.get('k1')).toBeUndefined();
  });
  it('stores sessions keyed by did and overwrites on set', async () => {
    const store = new SessionStore(openDb(':memory:'), KEY);
    await store.set('did:plc:abc', { tokenSet: { v: 1 } } as never);
    await store.set('did:plc:abc', { tokenSet: { v: 2 } } as never);
    expect(await store.get('did:plc:abc')).toEqual({ tokenSet: { v: 2 } });
  });
});
