import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type {
  NodeSavedSession, NodeSavedSessionStore, NodeSavedState, NodeSavedStateStore,
} from '@atproto/oauth-client-node';
import type { Database } from './db.js';

export function encrypt(keyHex: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(keyHex: string, blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export class StateStore implements NodeSavedStateStore {
  constructor(private db: Database.Database, private key: string) {}
  async get(k: string): Promise<NodeSavedState | undefined> {
    const row = this.db.prepare('SELECT data FROM oauth_state WHERE key = ?').get(k) as
      | { data: string } | undefined;
    return row ? (JSON.parse(decrypt(this.key, row.data)) as NodeSavedState) : undefined;
  }
  async set(k: string, v: NodeSavedState): Promise<void> {
    this.db.prepare(
      'INSERT OR REPLACE INTO oauth_state (key, data, created_at) VALUES (?, ?, ?)',
    ).run(k, encrypt(this.key, JSON.stringify(v)), Date.now());
  }
  async del(k: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_state WHERE key = ?').run(k);
  }
}

export class SessionStore implements NodeSavedSessionStore {
  constructor(private db: Database.Database, private key: string) {}
  async get(did: string): Promise<NodeSavedSession | undefined> {
    const row = this.db.prepare('SELECT data FROM oauth_session WHERE did = ?').get(did) as
      | { data: string } | undefined;
    return row ? (JSON.parse(decrypt(this.key, row.data)) as NodeSavedSession) : undefined;
  }
  async set(did: string, v: NodeSavedSession): Promise<void> {
    this.db.prepare(
      'INSERT OR REPLACE INTO oauth_session (did, data, updated_at) VALUES (?, ?, ?)',
    ).run(did, encrypt(this.key, JSON.stringify(v)), Date.now());
  }
  async del(did: string): Promise<void> {
    this.db.prepare('DELETE FROM oauth_session WHERE did = ?').run(did);
  }
}
