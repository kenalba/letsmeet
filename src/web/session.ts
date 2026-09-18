import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { Database } from '../db/db.js';
import {
  createWebSession, deleteWebSession, getWebSession, markCookieIssued, SESSION_TTL_MS,
  type WebSession,
} from '../db/webSessions.js';

export interface SessionEnv {
  db: Database.Database;
  cookieSecret: string;
  /** Mark the cookie Secure — true for any https PUBLIC_URL. */
  secure: boolean;
  /**
   * The cookie's Domain attribute, or null for a host-only cookie. With one, every host
   * under it (`<name>.sez.<site>`) gets the session, so the friend view served there can
   * tell its owner. Null for local dev: browsers refuse `Domain=localhost` and any IP.
   */
  domain: string | null;
}

/** The public host behind PUBLIC_URL, or null when a browser would not take it as Domain. */
export function cookieDomainFor(publicUrl: string): string | null {
  const host = new URL(publicUrl).hostname; // no port; an IPv6 literal keeps its brackets
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

/** The one way to build a SessionEnv: every route mounts through this so they agree. */
export function sessionEnvFor(db: Database.Database, cookieSecret: string, publicUrl: string): SessionEnv {
  return { db, cookieSecret, secure: publicUrl.startsWith('https'), domain: cookieDomainFor(publicUrl) };
}

const COOKIE = 'sid';

/**
 * Hono's signed cookies sign the value but NOT the cookie name, so a value signed for one
 * name verifies under any other name using the same secret. Binding the name into the
 * signed payload (`name\x00value`) and checking it back closes that. Everything the app
 * signs goes through this pair.
 */
export async function setNamedCookie(
  c: Context, secret: string, name: string, value: string, opts: Parameters<typeof setSignedCookie>[4],
): Promise<void> {
  await setSignedCookie(c, name, `${name}\x00${value}`, secret, opts);
}

export async function getNamedCookie(c: Context, secret: string, name: string): Promise<string | null> {
  const raw = await getSignedCookie(c, secret, name);
  if (!raw) return null;
  const sep = raw.indexOf('\x00');
  return sep > 0 && raw.slice(0, sep) === name ? raw.slice(sep + 1) : null;
}

/** The attributes every session cookie carries, whichever shape it is. */
const cookieOpts = (env: SessionEnv) => ({
  httpOnly: true, sameSite: 'Lax' as const, path: '/', secure: env.secure,
  maxAge: Math.floor(SESSION_TTL_MS / 1000),
});

/** Mint a session row for `did` and hand the browser its id. */
export async function startSession(
  c: Context, env: SessionEnv, did: string, handle: string | null, nowMs: number,
): Promise<void> {
  const sid = createWebSession(env.db, did, handle, nowMs);
  if (env.domain) {
    // A cookie set before the Domain attribute existed is host-only, and a browser holding
    // one would send both on the apex. Clear it in the same response; the browser matches
    // the clear to the host-only cookie and the set to the domain one.
    deleteCookie(c, COOKIE, { path: '/' });
    await setNamedCookie(c, env.cookieSecret, COOKIE, sid, { ...cookieOpts(env), domain: env.domain });
  } else {
    await setNamedCookie(c, env.cookieSecret, COOKIE, sid, cookieOpts(env));
  }
}

/**
 * The request is on the apex itself, whatever case, trailing dot or port the Host carries.
 * The counterpart of `isAliasHost` (`src/web/routes/availability.ts`): between them they
 * name the two kinds of host this app is ever served on.
 */
export function isApexHost(host: string | undefined, domain: string): boolean {
  return (host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '') === domain;
}

/**
 * A session minted before the domain cookie (2026-09-17) is host-only: it never reaches
 * `<name>.sez.<site>`, so its owner sees no edit button on their own alias page and nothing
 * tells them why. Re-issue it with `Domain` the next time they are on the apex and mark the
 * row, so nobody has to sign in again. Only on the apex — a Set-Cookie from the alias host
 * would be scoped to that host, and the alias serves nothing a session acts on. A failed
 * write is logged and dropped: the next request tries again.
 */
async function reissueCookie(c: Context, env: SessionEnv, sid: string): Promise<void> {
  if (!env.domain || !isApexHost(c.req.header('host'), env.domain)) return;
  deleteCookie(c, COOKIE, { path: '/' });
  await setNamedCookie(c, env.cookieSecret, COOKIE, sid, { ...cookieOpts(env), domain: env.domain });
  try {
    markCookieIssued(env.db, sid);
  } catch (err) {
    console.warn('session cookie re-issue not recorded:', err);
  }
}

/**
 * The live session behind the request's cookie, or null — expired and revoked both read as
 * null. Not a pure read: on the apex, a session minted before the domain cookie is migrated
 * here, once, which adds a `Set-Cookie` pair to the response and writes one row. Callers
 * that cache or short-circuit around this need to know it has that side effect.
 */
export async function readSession(c: Context, env: SessionEnv, nowMs: number): Promise<WebSession | null> {
  const sid = await getNamedCookie(c, env.cookieSecret, COOKIE);
  if (!sid) return null;
  const who = getWebSession(env.db, sid, nowMs);
  if (who && who.cookieV === 0) await reissueCookie(c, env, sid);
  return who;
}

/** Revoke the row (a copied cookie is now dead too) and clear the cookie. */
export async function endSession(c: Context, env: SessionEnv): Promise<void> {
  const sid = await getNamedCookie(c, env.cookieSecret, COOKIE);
  if (sid) deleteWebSession(env.db, sid);
  // Both shapes: the domain cookie, and a host-only one from before the Domain attribute.
  deleteCookie(c, COOKIE, { path: '/' });
  if (env.domain) deleteCookie(c, COOKIE, { path: '/', domain: env.domain });
}
