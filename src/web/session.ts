import type { Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import type { Database } from '../db/db.js';
import {
  createWebSession, deleteWebSession, getWebSession, SESSION_TTL_MS, type WebSession,
} from '../db/webSessions.js';

export interface SessionEnv {
  db: Database.Database;
  cookieSecret: string;
  /** Mark the cookie Secure — true for any https PUBLIC_URL. */
  secure: boolean;
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

/** Mint a session row for `did` and hand the browser its id. */
export async function startSession(
  c: Context, env: SessionEnv, did: string, handle: string | null, nowMs: number,
): Promise<void> {
  const sid = createWebSession(env.db, did, handle, nowMs);
  await setNamedCookie(c, env.cookieSecret, COOKIE, sid, {
    httpOnly: true, sameSite: 'Lax', path: '/', secure: env.secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/** The live session behind the request's cookie, or null — expired and revoked both read as null. */
export async function readSession(c: Context, env: SessionEnv, nowMs: number): Promise<WebSession | null> {
  const sid = await getNamedCookie(c, env.cookieSecret, COOKIE);
  return sid ? getWebSession(env.db, sid, nowMs) : null;
}

/** Revoke the row (a copied cookie is now dead too) and clear the cookie. */
export async function endSession(c: Context, env: SessionEnv): Promise<void> {
  const sid = await getNamedCookie(c, env.cookieSecret, COOKIE);
  if (sid) deleteWebSession(env.db, sid);
  deleteCookie(c, COOKIE, { path: '/' });
}
