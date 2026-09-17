import type { Database } from './db.js';

/**
 * The index behind `<name>.sez.<site>`. Unlike `poll_cache` and `availability_cache`
 * this is not rebuildable from the network: it is what makes a name one person's. A
 * claimed row (`claimed = 1`) is a name its owner chose; an implicit row (`claimed = 0`)
 * is a hyphenated handle this server once decoded, kept so the next visit is one lookup.
 */
export interface SezNameRow { name: string; did: string; claimed: boolean; createdAt: number }

type Raw = { name: string; did: string; claimed: number; created_at: number };
const row = (r: Raw | undefined): SezNameRow | null =>
  r ? { name: r.name, did: r.did, claimed: r.claimed === 1, createdAt: r.created_at } : null;

export function getSezName(db: Database.Database, name: string): SezNameRow | null {
  return row(db.prepare('SELECT * FROM sez_name WHERE name = ?').get(name) as Raw | undefined);
}

export function claimedSezNameFor(db: Database.Database, did: string): string | null {
  const r = db.prepare('SELECT name FROM sez_name WHERE did = ? AND claimed = 1').get(did) as
    { name: string } | undefined;
  return r?.name ?? null;
}

/**
 * Make `name` this DID's claimed name, letting go of whatever it held before. An implicit
 * row for `name` is overwritten; another DID's claim is refused — callers say "taken" in
 * words before getting here, this is the last line.
 */
export function claimSezName(db: Database.Database, name: string, did: string, nowMs: number): void {
  db.transaction(() => {
    const holder = getSezName(db, name);
    if (holder?.claimed && holder.did !== did) throw new Error(`sez name ${name} is held by ${holder.did}`);
    db.prepare('DELETE FROM sez_name WHERE did = ? AND claimed = 1').run(did);
    db.prepare(
      'INSERT OR REPLACE INTO sez_name (name, did, claimed, created_at) VALUES (?, ?, 1, ?)',
    ).run(name, did, nowMs);
  })();
}

/** Drop this DID's claimed name. The name is free the moment this returns. */
export function releaseSezName(db: Database.Database, did: string): void {
  db.prepare('DELETE FROM sez_name WHERE did = ? AND claimed = 1').run(did);
}

/** Remember a decoded hyphenated handle. Never touches a row that already exists. */
export function rememberFallback(db: Database.Database, name: string, did: string, nowMs: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO sez_name (name, did, claimed, created_at) VALUES (?, ?, 0, ?)',
  ).run(name, did, nowMs);
}

/** Drop an implicit row whose handle no longer decodes to its DID. A claim is never touched. */
export function forgetSezName(db: Database.Database, name: string): void {
  db.prepare('DELETE FROM sez_name WHERE name = ? AND claimed = 0').run(name);
}
