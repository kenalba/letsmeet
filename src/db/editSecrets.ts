import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './db.js';

const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export function createEditSecret(db: Database.Database, pollUri: string, rkey: string): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO edit_secret (poll_uri, token_hash, rkey, created_at) VALUES (?, ?, ?, ?)',
  ).run(pollUri, hash(token), rkey, Date.now());
  return token;
}

export function lookupEditSecret(db: Database.Database, pollUri: string, token: string): string | null {
  const row = db.prepare(
    'SELECT rkey FROM edit_secret WHERE poll_uri = ? AND token_hash = ?',
  ).get(pollUri, hash(token)) as { rkey: string } | undefined;
  return row?.rkey ?? null;
}
