import { describe, it, expect, vi } from 'vitest';
import { resolveDid, cachedResolveDid, cachedResolveHandle } from '../../src/atproto/pds.js';
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
  it('throws rather than answering null when the lookup itself fails', async () => {
    // A 5xx, a rate-limit, a timeout: the handle is not known to be missing, and a null
    // here would be cached as "no such handle" for an hour.
    const down = fetchWith(503, { error: 'Upstream' });
    await expect(resolveDid('ken.wzrdz.cool', { fetch: down as unknown as typeof fetch, lookup: okLookup }))
      .rejects.toThrow(/503/);
    const refused = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(resolveDid('ken.wzrdz.cool', { fetch: refused as unknown as typeof fetch, lookup: okLookup }))
      .rejects.toThrow(/ECONNREFUSED/);
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
  it('does not cache a failure, so a blip does not 404 a real handle for an hour', async () => {
    let calls = 0;
    const inner = vi.fn(async () => {
      if (++calls === 1) throw new Error('resolver down');
      return 'did:plc:a';
    });
    const r = cachedResolveDid(inner);
    await expect(r('a.b')).rejects.toThrow(/resolver down/);
    expect(await r('a.b')).toBe('did:plc:a');
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe('cachedResolveHandle', () => {
  it('serves a handle from the memo, keyed by the did exactly as given', async () => {
    const inner = vi.fn(async () => 'ken.wzrdz.cool');
    const r = cachedResolveHandle(inner);
    expect(await r('did:web:Ken.Example')).toBe('ken.wzrdz.cool');
    expect(await r('did:web:Ken.Example')).toBe('ken.wzrdz.cool');
    expect(inner).toHaveBeenCalledWith('did:web:Ken.Example');
    expect(inner).toHaveBeenCalledTimes(1);
  });
  it('does not memoize a null, which may be a read that failed rather than a handleless did', async () => {
    const inner = vi.fn(async () => null);
    const r = cachedResolveHandle(inner);
    expect(await r('did:plc:ken')).toBeNull();
    expect(await r('did:plc:ken')).toBeNull();
    expect(inner).toHaveBeenCalledTimes(2);
  });
  it('does not memoize a throw', async () => {
    let calls = 0;
    const inner = vi.fn(async () => {
      if (++calls === 1) throw new Error('plc down');
      return 'ken.wzrdz.cool';
    });
    const r = cachedResolveHandle(inner);
    await expect(r('did:plc:ken')).rejects.toThrow(/plc down/);
    expect(await r('did:plc:ken')).toBe('ken.wzrdz.cool');
    expect(inner).toHaveBeenCalledTimes(2);
  });
});
