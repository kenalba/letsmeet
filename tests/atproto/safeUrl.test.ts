import { describe, it, expect } from 'vitest';
import { assertPublicHttpsUrl, isPrivateAddress, type LookupFn } from '../../src/atproto/safeUrl.js';

const pub: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

describe('isPrivateAddress', () => {
  it('flags every non-routable v4 range this server must never dial', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('flags loopback, link-local, unique-local and v4-mapped v6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd12::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
  it('passes public addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it('treats a non-address as private (refuse rather than guess)', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('assertPublicHttpsUrl', () => {
  it('accepts an https URL to a host that resolves publicly', async () => {
    const u = await assertPublicHttpsUrl('https://pds.example.com/xrpc/x', pub);
    expect(u.host).toBe('pds.example.com');
  });
  it('rejects http, file, and credential-bearing URLs', async () => {
    for (const bad of ['http://pds.example.com', 'file:///etc/passwd', 'https://user:pw@pds.example.com', 'not a url']) {
      await expect(assertPublicHttpsUrl(bad, pub)).rejects.toThrow(/refusing to fetch/);
    }
  });
  it('rejects IP literals in private ranges without consulting DNS', async () => {
    const never: LookupFn = async () => { throw new Error('DNS must not be consulted'); };
    for (const bad of ['https://127.0.0.1', 'https://10.0.0.1:8443', 'https://[::1]', 'https://169.254.169.254/latest/meta-data']) {
      await expect(assertPublicHttpsUrl(bad, never)).rejects.toThrow(/private address/);
    }
  });
  it('rejects local-only hostnames without consulting DNS', async () => {
    const never: LookupFn = async () => { throw new Error('DNS must not be consulted'); };
    for (const bad of ['https://localhost', 'https://db.localhost', 'https://pds.internal', 'https://box.local', 'https://x.home.arpa']) {
      await expect(assertPublicHttpsUrl(bad, never)).rejects.toThrow(/local hostname/);
    }
  });
  it('rejects a public name whose answers include a private address', async () => {
    const mixed: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.9', family: 4 }];
    await expect(assertPublicHttpsUrl('https://sneaky.example.com', mixed)).rejects.toThrow(/private address/);
  });
  it('rejects a name that does not resolve', async () => {
    const nx: LookupFn = async () => { throw new Error('ENOTFOUND'); };
    await expect(assertPublicHttpsUrl('https://nope.example.com', nx)).rejects.toThrow(/does not resolve/);
  });
});
