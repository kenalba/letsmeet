import { describe, it, expect } from 'vitest';
import { resolvePds, PublicPdsReader } from '../../src/atproto/pds.js';

const plcDoc = {
  service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
};
const fakeFetch = (routes: Record<string, unknown>) =>
  (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, body] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return new Response(JSON.stringify(body), { status: 200 });
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
  it('listRecords returns the records array', async () => {
    expect(await reader.listRecords('did:plc:abc', 'c')).toHaveLength(1);
  });
});
