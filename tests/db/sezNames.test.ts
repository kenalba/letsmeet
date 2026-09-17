import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/db.js';
import {
  getSezName, claimedSezNameFor, claimSezName, releaseSezName, rememberFallback, forgetSezName,
} from '../../src/db/sezNames.js';

const KEN = 'did:plc:ken';
const ROSS = 'did:plc:ross';
const NOW = 1_800_000_000_000;

describe('sez_name', () => {
  it('is empty until claimed, then answers by name and by did', () => {
    const db = openDb(':memory:');
    expect(getSezName(db, 'ken')).toBeNull();
    expect(claimedSezNameFor(db, KEN)).toBeNull();
    claimSezName(db, 'ken', KEN, NOW);
    expect(getSezName(db, 'ken')).toEqual({ name: 'ken', did: KEN, claimed: true, createdAt: NOW });
    expect(claimedSezNameFor(db, KEN)).toBe('ken');
  });
  it('holds one claim per did: a new claim releases the old name', () => {
    const db = openDb(':memory:');
    claimSezName(db, 'ken', KEN, NOW);
    claimSezName(db, 'kenny', KEN, NOW + 1);
    expect(getSezName(db, 'ken')).toBeNull();
    expect(claimedSezNameFor(db, KEN)).toBe('kenny');
    // The partial unique index is the last line: two claimed rows for one did cannot exist.
    expect(() => db.prepare(
      'INSERT INTO sez_name (name, did, claimed, created_at) VALUES (?, ?, 1, ?)').run('ken', KEN, NOW),
    ).toThrow(/UNIQUE/);
  });
  it('refuses a name another did holds, and lets the holder re-claim it', () => {
    const db = openDb(':memory:');
    claimSezName(db, 'ken', KEN, NOW);
    expect(() => claimSezName(db, 'ken', ROSS, NOW)).toThrow(/held by/);
    expect(getSezName(db, 'ken')!.did).toBe(KEN);
    expect(() => claimSezName(db, 'ken', KEN, NOW + 5)).not.toThrow();
  });
  it('releases immediately: the name is free for the next claimant', () => {
    const db = openDb(':memory:');
    claimSezName(db, 'ken', KEN, NOW);
    releaseSezName(db, KEN);
    expect(getSezName(db, 'ken')).toBeNull();
    expect(claimedSezNameFor(db, KEN)).toBeNull();
    claimSezName(db, 'ken', ROSS, NOW + 1);
    expect(getSezName(db, 'ken')!.did).toBe(ROSS);
  });
  it('remembers a decoded fallback as an implicit row that a claim overwrites silently', () => {
    const db = openDb(':memory:');
    rememberFallback(db, 'ken-wzrdz-cool', KEN, NOW);
    expect(getSezName(db, 'ken-wzrdz-cool')).toMatchObject({ did: KEN, claimed: false });
    expect(claimedSezNameFor(db, KEN)).toBeNull(); // implicit rows are not "their name"
    // Any number of implicit rows may point at one did.
    rememberFallback(db, 'ken-old-handle', KEN, NOW);
    expect(getSezName(db, 'ken-old-handle')!.did).toBe(KEN);
    claimSezName(db, 'ken-wzrdz-cool', ROSS, NOW + 1);
    expect(getSezName(db, 'ken-wzrdz-cool')).toMatchObject({ did: ROSS, claimed: true });
  });
  it('never lets a fallback touch an existing row, and forgets only implicit ones', () => {
    const db = openDb(':memory:');
    claimSezName(db, 'ken', KEN, NOW);
    rememberFallback(db, 'ken', ROSS, NOW);
    expect(getSezName(db, 'ken')).toMatchObject({ did: KEN, claimed: true });
    forgetSezName(db, 'ken');
    expect(getSezName(db, 'ken')).not.toBeNull();
    rememberFallback(db, 'ross-example', ROSS, NOW);
    forgetSezName(db, 'ross-example');
    expect(getSezName(db, 'ross-example')).toBeNull();
  });
});
