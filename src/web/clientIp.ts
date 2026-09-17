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
