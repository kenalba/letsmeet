import { describe, it, expect } from 'vitest';
import { resolvePds, PublicPdsReader } from '../../src/atproto/pds.js';

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
    const pds = await resolvePds('did:plc:abc', fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }));
    expect(pds).toBe('https://pds.example.com');
  });
  it('resolves did:web via .well-known', async () => {
    const pds = await resolvePds('did:web:example.org', fakeFetch({ 'https://example.org/.well-known/did.json': plcDoc }));
    expect(pds).toBe('https://pds.example.com');
  });
  it('throws when no PDS service is present', async () => {
    await expect(resolvePds('did:plc:abc', fakeFetch({ 'https://plc.directory/did:plc:abc': { service: [] } })))
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
  }));
  it('getRecord fetches from the resolved PDS', async () => {
    const rec = await reader.getRecord('did:plc:abc', 'c', 'rk');
    expect(rec?.value).toEqual({ hello: 1 });
  });
  it('getRecord returns null on 404-class errors', async () => {
    const r404 = new PublicPdsReader(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }));
    expect(await r404.getRecord('did:plc:abc', 'c', 'rk')).toBeNull();
  });
  it('getRecord throws — never returns null — when the PDS is merely broken', async () => {
    const getRecordUrl = 'https://pds.example.com/xrpc/com.atproto.repo.getRecord';
    const r503 = new PublicPdsReader(fakeFetch(
      { 'https://plc.directory/did:plc:abc': plcDoc, [getRecordUrl]: { error: 'upstream' } },
      { [getRecordUrl]: 503 },
    ));
    // A null here would read as "the host deleted this record" and tombstone the poll.
    await expect(r503.getRecord('did:plc:abc', 'c', 'rk')).rejects.toThrow(/getRecord failed/);
  });
  it('listRecords returns the records array', async () => {
    expect(await reader.listRecords('did:plc:abc', 'c')).toHaveLength(1);
  });
  it('listRecords throws on a non-OK page instead of returning partial results', async () => {
    const r = new PublicPdsReader(fakeFetch({ 'https://plc.directory/did:plc:abc': plcDoc }));
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
    const recs = await new PublicPdsReader(paged).listRecords('did:plc:abc', 'c');
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
    await expect(new PublicPdsReader(endless).listRecords('did:plc:abc', 'c'))
      .rejects.toThrow(/exceeded page cap/);
  });
});
