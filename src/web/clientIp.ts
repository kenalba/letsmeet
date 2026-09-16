import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

/**
 * The address a rate limiter should key on. Behind nginx, X-Forwarded-For's LAST hop is
 * the one nginx itself appended (docs/deploy.md §3), so a client-supplied prefix cannot
 * rotate buckets. Without the header — a direct connection on the box, the test rig —
 * fall back to the socket's peer rather than one shared key that every direct caller
 * would otherwise pool into.
 */
export function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',').pop()!.trim();
  try {
    return getConnInfo(c).remote.address ?? 'local';
  } catch {
    return 'local';
  }
}

/** Addresses a socket reports for a peer on this same box. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True when the request came straight from a process on this box rather than in through the
 * public reverse proxy — the gate on `/internal/*`, which only Caddy's on-demand-TLS `ask`
 * may reach. A loopback socket proves nothing by itself: nginx and Caddy run on the box too
 * and dial `127.0.0.1:8787` (docs/deploy.md §3). What separates them is the header they both
 * append — a request carrying any `X-Forwarded-For` came through a proxy, whatever address
 * it claims, and a request without one never did.
 */
export function isLoopbackPeer(c: Context): boolean {
  if (c.req.header('x-forwarded-for') !== undefined) return false;
  try {
    const address = getConnInfo(c).remote.address;
    return address === undefined || LOOPBACK.has(address);
  } catch {
    // No socket to inspect (the in-process test rig, a non-node adapter). The header check
    // above is the one that decides; nothing arrives from outside the box without it.
    return true;
  }
}
