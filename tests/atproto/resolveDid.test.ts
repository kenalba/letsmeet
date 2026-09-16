import { describe, it, expect, vi } from 'vitest';
import { resolveDid, cachedResolveDid } from '../../src/atproto/pds.js';
import type { LookupFn } from '../../src/atproto/safeUrl.js';

// Matches the LookupFn contract in safeUrl.ts (address + family), not a bare address list —
// otherwise assertPublicHttpsUrl treats the resolved address as unroutable and throws.
const okLookup: LookupFn = async () => [{ address: '1.2.3.4', family: 4 }];
const fetchWith = (status: number, body: unknown) => vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('resolveDid', () => {
  it('asks the public api and returns the did', async () => {
    const f = fetchWith(200, { did: 'did:plc:abc' });
    expect(await resolveDid('ken.wzrdz.cool', { fetch: f as unknown as typeof fetch, lookup: okLookup })).toBe('did:plc:abc');
    expect(String(f.mock.calls[0][0])).toContain('resolveHandle?handle=ken.wzrdz.cool');
  });
  it('is null for an unknown handle or a malformed one, without a request', async () => {
    const f = fetchWith(400, { error: 'InvalidRequest' });
    expect(await resolveDid('nobody.example', { fetch: f as unknown as typeof fetch, lookup: okLookup })).toBeNull();
    expect(await resolveDid('not a handle!', { fetch: f as unknown as typeof fetch, lookup: okLookup })).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('caches hits and misses', async () => {
    const inner = vi.fn(async (h: string) => (h === 'a.b' ? 'did:plc:a' : null));
    const r = cachedResolveDid(inner);
    expect(await r('a.b')).toBe('did:plc:a');
    expect(await r('a.b')).toBe('did:plc:a');
    expect(await r('x.y')).toBeNull();
    expect(await r('x.y')).toBeNull();
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
