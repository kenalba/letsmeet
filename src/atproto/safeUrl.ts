import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/**
 * Where this server is willing to send a request it did not choose the address of.
 *
 * Every participant's DID document names their PDS, and this app fetches from it. Without
 * a check, a DID whose document says `http://127.0.0.1:8787` or
 * `https://169.254.169.254` turns a poll view into a request from inside this box —
 * classic SSRF. The rule: https only, a public hostname, and every address that hostname
 * resolves to must be publicly routable. Redirects are refused separately at the fetch
 * (`redirect: 'manual'`), since a public host can otherwise bounce us anywhere.
 *
 * DNS rebinding (a public answer now, a private one at connect time) is not fully closed
 * here — that needs a pinned-address dispatcher — but the check runs immediately before
 * each connection and the responses are only ever parsed as JSON records, so the
 * remaining window buys an attacker very little.
 */

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;

const v4ToInt = (ip: string): number =>
  ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;

function isPrivateV4(ip: string): boolean {
  const n = v4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (v4ToInt(base) & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms delegate to the v4 table.
  const mapped = lower.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  if (lower === '::' || lower === '::1') return true;
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast,
  // 64:ff9b::/96 NAT64 (maps to v4 — treat as untrusted), 2001:db8::/32 documentation.
  return /^(f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|fec[0-9a-f]:|ff[0-9a-f]{2}:|64:ff9b:|2001:db8:)/.test(lower);
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip);
  if (family === 6) return isPrivateV6(ip);
  return true; // not an IP at all: refuse rather than guess
}

/** Names that never denote a public host, whatever DNS says. */
const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|arpa|localdomain|test|example|invalid)$/i;

/**
 * Throws unless `raw` is an https URL to a public host. Returns the parsed URL. The
 * `lookup` seam exists so tests never touch real DNS.
 */
export async function assertPublicHttpsUrl(raw: string, lookup: LookupFn = systemLookup): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`refusing to fetch: not a URL (${raw})`);
  }
  if (u.protocol !== 'https:') throw new Error(`refusing to fetch: not https (${u.origin})`);
  if (u.username || u.password) throw new Error(`refusing to fetch: credentials in URL (${u.host})`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`refusing to fetch: private address (${host})`);
    return u;
  }
  if (LOCAL_NAMES.test(host)) throw new Error(`refusing to fetch: local hostname (${host})`);
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host);
  } catch {
    throw new Error(`refusing to fetch: ${host} does not resolve`);
  }
  if (addrs.length === 0) throw new Error(`refusing to fetch: ${host} does not resolve`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`refusing to fetch: ${host} resolves to a private address`);
    }
  }
  return u;
}
