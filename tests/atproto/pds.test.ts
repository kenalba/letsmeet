import { describe, it, expect } from 'vitest';
import { resolvePds, resolveHandle, PublicPdsReader } from '../../src/atproto/pds.js';
import type { LookupFn } from '../../src/atproto/safeUrl.js';

/** Every hostname is "public" as far as these tests care; the guard itself is tested in safeUrl.test.ts. */
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
const net = (f: typeof fetch) => ({ fetch: f, lookup: publicLookup });

const plcDoc = {
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
};
/**
 * `statuses` overrides the response code for a matching prefix, so a route can be present
 * (and still resolvable) while answering with a server error. The unused `_init` is there
 * because the reader now passes an abort signal as a second argument.
 */
const fakeFetch = (routes: Record<string, unknown>, statuses: Record<string, number> = {}) =>
  (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return new Response(JSON.stringify(body), { status: statuses[prefix] ?? 200 });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

describe('resolvePds', () => {
  it('resolves did:plc via plc.directory', async () => {
    const pds = await resolvePds('did:plc:abc', net(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc })));
    expect(pds).toBe('https://pds.example.com');
  });
  it('resolves did:web via .well-known', async () => {
    const pds = await resolvePds('did:web:example.org', net(fakeFetch({ 'https://example.org/.well-known/did.json': plcDoc })));
    expect(pds).toBe('https://pds.example.com');
  });
  it('throws when no PDS service is present', async () => {
    await expect(resolvePds('did:plc:abc', net(fakeFetch({ 'https://plc.directory/did:plc:abc': { service: [] } }))))
      .rejects.toThrow();
  });
});

describe('PublicPdsReader', () => {
  const reader = new PublicPdsReader(fakeFetch({
    'https://plc.directory/did:plc:abc': plcDoc,
    'https://pds.example.com/xrpc/com.atproto.repo.getRecord': {
      uri: 'at://did:plc:abc/c/rk', cid: 'bafyfake', value: { hello: 1 },
    },
    'https://pds.example.com/xrpc/com.atproto.repo.listRecords': {
      records: [{ uri: 'at://did:plc:abc/c/rk', cid: 'bafyfake', value: { hello: 1 } }],
    },
  }), publicLookup);
  it('getRecord fetches from the resolved PDS', async () => {
    const rec = await reader.getRecord('did:plc:abc', 'c', 'rk');
    expect(rec?.value).toEqual({ hello: 1 });
  });
  it('getRecord returns null on 404-class errors', async () => {
    const r404 = new PublicPdsReader(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }), publicLookup);
    expect(await r404.getRecord('did:plc:abc', 'c', 'rk')).toBeNull();
  });
  it('getRecord throws — never returns null — when the PDS is merely broken', async () => {
    const getRecordUrl = 'https://pds.example.com/xrpc/com.atproto.repo.getRecord';
    const r503 = new PublicPdsReader(fakeFetch(
      { 'https://plc.directory/did:plc:abc': plcDoc, [getRecordUrl]: { error: 'upstream' } },
      { [getRecordUrl]: 503 },
    ), publicLookup);
    // A null here would read as "the host deleted this record" and tombstone the poll.
    await expect(r503.getRecord('did:plc:abc', 'c', 'rk')).rejects.toThrow(/getRecord failed/);
  });
  it('listRecords returns the records array', async () => {
    expect(await reader.listRecords('did:plc:abc', 'c')).toHaveLength(1);
  });
  it('listRecords throws on a non-OK page instead of returning partial results', async () => {
    const r = new PublicPdsReader(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }), publicLookup);
    await expect(r.listRecords('did:plc:abc', 'c')).rejects.toThrow(/listRecords failed/);
  });
  it('listRecords follows the cursor and returns every page', async () => {
    const rec = (rk: string) => ({ uri: `at://did:plc:abc/c/${rk}`, cid: 'bafyfake', value: {} });
    const paged = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === 'plc.directory') {
        return new Response(JSON.stringify(plcDoc), { status: 200 });
      }
      const body = url.searchParams.get('cursor')
        ? { records: [rec('two')] }
        : { records: [rec('one')], cursor: 'page-2' };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const recs = await new PublicPdsReader(paged, publicLookup).listRecords('did:plc:abc', 'c');
    expect(recs.map((r) => r.uri)).toEqual([
      'at://did:plc:abc/c/one', 'at://did:plc:abc/c/two',
    ]);
  });
  it('listRecords gives up rather than paging forever', async () => {
    // A repo (or a broken PDS) that always hands back a cursor must not pin the process.
    const endless = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const body = url.hostname === 'plc.directory'
        ? plcDoc
        : { records: [], cursor: 'more' };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await expect(new PublicPdsReader(endless, publicLookup).listRecords('did:plc:abc', 'c'))
      .rejects.toThrow(/exceeded page cap/);
  });
});

describe('outbound request vetting (SSRF)', () => {
  const docWith = (endpoint: string) => ({
    service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint }],
  });
  const attempted: string[] = [];
  const recording = (routes: Record<string, unknown>) => (async (input: RequestInfo | URL) => {
    const url = String(input);
    attempted.push(url);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  it('refuses a DID document that points the PDS at loopback, and never dials it', async () => {
    const f = recording({ 'https://plc.directory/did:plc:evil': docWith('http://127.0.0.1:8787') });
    await expect(resolvePds('did:plc:evil', net(f))).rejects.toThrow(/refusing to fetch/);
    expect(attempted.some((u) => u.includes('127.0.0.1'))).toBe(false);
  });
  it('refuses a plain-http PDS and the cloud metadata address', async () => {
    for (const bad of ['http://pds.example.com', 'https://169.254.169.254', 'https://[::1]']) {
      const f = recording({ 'https://plc.directory/did:plc:evil': docWith(bad) });
      await expect(resolvePds('did:plc:evil', net(f))).rejects.toThrow(/refusing to fetch/);
    }
  });
  it('refuses a public hostname that resolves to a private address', async () => {
    const f = recording({ 'https://plc.directory/did:plc:evil': docWith('https://rebind.example.com') });
    const rebinding: LookupFn = async (host) =>
      host === 'rebind.example.com' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }];
    await expect(resolvePds('did:plc:evil', { fetch: f, lookup: rebinding })).rejects.toThrow(/private address/);
  });
  it('refuses did:web hosts that are local names or IPs', async () => {
    for (const did of ['did:web:localhost', 'did:web:127.0.0.1', 'did:web:pds.internal', 'did:web:foo%3A8080']) {
      await expect(resolvePds(did, net(recording({})))).rejects.toThrow();
    }
    expect(attempted.filter((u) => /localhost|127\.0\.0\.1|internal|8080/.test(u))).toHaveLength(0);
  });
  it('does not follow a redirect off a vetted host', async () => {
    const f = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://plc.directory/')) {
        return new Response(JSON.stringify(docWith('https://pds.example.com')), { status: 200 });
      }
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8787/xrpc/x' } });
    }) as typeof fetch;
    const reader = new PublicPdsReader(f, publicLookup);
    await expect(reader.getRecord('did:plc:abc', 'c', 'rk')).rejects.toThrow(/redirect/);
  });
});

describe('resolveHandle', () => {
  it('returns the at:// alias from the DID document', async () => {
    const doc = { ...plcDoc, alsoKnownAs: ['at://alice.example.com'] };
    expect(await resolveHandle('did:plc:abc', net(fakeFetch({ 'https://plc.directory/did:plc:abc': doc }))))
      .toBe('alice.example.com');
  });
  it('is null, not an error, when the document has no usable alias or cannot be fetched', async () => {
    expect(await resolveHandle('did:plc:abc', net(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc })))).toBeNull();
    const junk = { ...plcDoc, alsoKnownAs: ['at://<script>'] };
    expect(await resolveHandle('did:plc:abc', net(fakeFetch({ 'https://plc.directory/did:plc:abc': junk })))).toBeNull();
    expect(await resolveHandle('did:plc:abc', net(fakeFetch({})))).toBeNull();
  });
});
