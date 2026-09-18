import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';

/**
 * Browser sessions are server rows, not bearer cookies. The cookie carries only a random
 * session id (signed, so a forged id is rejected before the lookup); the DID it stands for,
 * the handle to display, and the expiry all live here. That is what makes logout a real
 * revocation and expiry a server decision — a copied cookie stops working when its row
 * goes, whatever Max-Age the client claims.
 */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

/** The cookie shape a row is stamped with today. See `WebSession.cookieV` for the versions. */
export const COOKIE_V = 1;

export interface WebSession {
  did: string;
  handle: string | null;
  /** 0: the host-only cookie from before the Domain attribute. 1: the domain cookie. */
  cookieV: number;
}

export function createWebSession(
  db: Database.Database, did: string, handle: string | null, nowMs: number,
): string {
  const sid = randomBytes(32).toString('base64url');
  // Stamped current even in local dev, where `env.domain` is null and the cookie really is
  // host-only: the re-issue path checks `env.domain` itself before it does anything, so a 0
  // here would never be acted on — it would only leave every local row looking stale.
  db.prepare(
    'INSERT INTO web_session (sid, did, handle, created_at, expires_at, cookie_v) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(sid, did, handle, nowMs, nowMs + SESSION_TTL_MS, COOKIE_V);
  return sid;
}

export function getWebSession(db: Database.Database, sid: string, nowMs: number): WebSession | null {
  const row = db.prepare('SELECT did, handle, expires_at, cookie_v FROM web_session WHERE sid = ?').get(sid) as
    | { did: string; handle: string | null; expires_at: number; cookie_v: number } | undefined;
  if (!row || row.expires_at <= nowMs) return null;
  return { did: row.did, handle: row.handle, cookieV: row.cookie_v };
}

/** This session now holds the domain cookie: do not re-issue it again. */
export function markCookieIssued(db: Database.Database, sid: string): void {
  db.prepare('UPDATE web_session SET cookie_v = ? WHERE sid = ?').run(COOKIE_V, sid);
}

export function deleteWebSession(db: Database.Database, sid: string): void {
  db.prepare('DELETE FROM web_session WHERE sid = ?').run(sid);
}

export function pruneWebSessions(db: Database.Database, nowMs: number): number {
  return db.prepare('DELETE FROM web_session WHERE expires_at <= ?').run(nowMs).changes;
}
