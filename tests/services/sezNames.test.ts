import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db/db.js';
import { FakeRepo } from '../helpers/fakeRepo.js';
import {
  resolveSezName, applySezClaim, undoSezClaim, sezAddressFor, fallbackAddressFor, suggestedSezName,
  sezHost, sezSuffixFor,
} from '../../src/services/sezNames.js';
import { claimSezName, claimedSezNameFor, getSezName, rememberFallback } from '../../src/db/sezNames.js';
import type { Deps } from '../../src/atproto/types.js';

const KEN = 'did:plc:ken';
const ROSS = 'did:plc:ross';
const URL_ = 'https://letsmeet.lol';

function setup(resolveDid?: Deps['resolveDid'], revalidateTtlMs = 0) {
  const repo = new FakeRepo();
  const deps: Deps = {
    db: openDb(':memory:'), reader: repo, writerFor: async () => repo,
    now: () => new Date('2026-09-16T12:00:00Z'), revalidateTtlMs, resolveDid,
  };
  return { deps, repo };
}
const kenOnly = async (h: string) => (h === 'ken.wzrdz.cool' ? KEN : null);

describe('hosts', () => {
  it('builds the address from the site host', () => {
    expect(sezSuffixFor(URL_)).toBe('sez.letsmeet.lol');
    expect(sezHost('ken', URL_)).toBe('ken.sez.letsmeet.lol');
    expect(sezSuffixFor('http://localhost:8787')).toBe('sez.localhost:8787');
  });
  it('gives a handle its hyphenated address, and a did literal none', () => {
    expect(fallbackAddressFor('ken.wzrdz.cool', URL_)).toBe('ken-wzrdz-cool.sez.letsmeet.lol');
    expect(fallbackAddressFor(KEN, URL_)).toBeNull();
    expect(fallbackAddressFor(undefined, URL_)).toBeNull();
  });
  it('prefers the claimed name', () => {
    const { deps } = setup();
    expect(sezAddressFor(deps, KEN, 'ken.wzrdz.cool', URL_)).toBe('ken-wzrdz-cool.sez.letsmeet.lol');
    claimSezName(deps.db, 'ken', KEN, 0);
    expect(sezAddressFor(deps, KEN, 'ken.wzrdz.cool', URL_)).toBe('ken.sez.letsmeet.lol');
    expect(sezAddressFor(deps, KEN, undefined, URL_)).toBe('ken.sez.letsmeet.lol');
  });
});

describe('suggestedSezName', () => {
  it('offers the claimed name, else the record alias if free, else the first label, else the hyphenated handle', () => {
    const { deps } = setup();
    expect(suggestedSezName(deps, KEN, 'ken.wzrdz.cool', null)).toBe('ken');
    expect(suggestedSezName(deps, KEN, 'ken.wzrdz.cool', 'kenny')).toBe('kenny');
    claimSezName(deps.db, 'ken', ROSS, 0);
    expect(suggestedSezName(deps, KEN, 'ken.wzrdz.cool', null)).toBe('ken-wzrdz-cool');
    claimSezName(deps.db, 'kenny', ROSS, 0);
    // Ross's claim moved from 'ken' to 'kenny' (claimSezName drops the claimant's old
    // claimed row), so 'ken' has no row at all here and the first label wins over the
    // hyphenated fallback.
    expect(suggestedSezName(deps, KEN, 'ken.wzrdz.cool', 'kenny')).toBe('ken');
    claimSezName(deps.db, 'kwc', KEN, 0);
    expect(suggestedSezName(deps, KEN, 'ken.wzrdz.cool', null)).toBe('kwc');
  });
  it('skips a reserved first label, an implicit row counts as free, and a nameless session gets nothing', () => {
    const { deps } = setup();
    expect(suggestedSezName(deps, KEN, 'www.example.com', null)).toBe('www-example-com');
    rememberFallback(deps.db, 'ken', ROSS, 0);
    expect(suggestedSezName(deps, KEN, 'ken.wzrdz.cool', null)).toBe('ken');
    expect(suggestedSezName(deps, KEN, undefined, null)).toBe('');
    expect(suggestedSezName(deps, KEN, KEN, null)).toBe('');
    // A hyphenated handle past 32 characters cannot be claimed as a name; offer nothing.
    expect(suggestedSezName(deps, KEN, 'www.' + 'x'.repeat(40) + '.example', null)).toBe('');
  });
});

describe('resolveSezName', () => {
  it('answers a claimed name from the table without asking anyone', async () => {
    const resolve = vi.fn(kenOnly);
    const { deps } = setup(resolve);
    claimSezName(deps.db, 'ken', KEN, 0);
    expect(await resolveSezName(deps, 'ken')).toBe(KEN);
    expect(resolve).not.toHaveBeenCalled();
  });
  it('decodes a hyphenated handle, most dots first, and remembers it as an implicit row', async () => {
    const seen: string[] = [];
    const { deps } = setup(async (h) => { seen.push(h); return kenOnly(h); });
    expect(await resolveSezName(deps, 'ken-wzrdz-cool')).toBe(KEN);
    expect(seen).toEqual(['ken.wzrdz.cool']);
    expect(getSezName(deps.db, 'ken-wzrdz-cool')).toMatchObject({ did: KEN, claimed: false });
  });
  it('reaches a handle that itself has a hyphen', async () => {
    const seen: string[] = [];
    const { deps } = setup(async (h) => { seen.push(h); return h === 'foo-bar.bsky.social' ? ROSS : null; });
    expect(await resolveSezName(deps, 'foo-bar-bsky-social')).toBe(ROSS);
    expect(seen).toEqual(['foo.bar.bsky.social', 'foo.bar.bsky-social', 'foo.bar-bsky.social', 'foo-bar.bsky.social']);
  });
  it('is null for an unknown label, a label with no hyphen, and — without a resolver — anything unclaimed', async () => {
    const { deps } = setup(kenOnly);
    expect(await resolveSezName(deps, 'nobody-example')).toBeNull();
    expect(await resolveSezName(deps, 'nobody')).toBeNull();
    expect(getSezName(deps.db, 'nobody-example')).toBeNull();
    const fake = setup();
    expect(await resolveSezName(fake.deps, 'ken-wzrdz-cool')).toBeNull();
  });
  it('serves an implicit row inside the window, then re-checks it', async () => {
    const resolve = vi.fn(kenOnly);
    const { deps } = setup(resolve, 30_000);
    expect(await resolveSezName(deps, 'ken-wzrdz-cool')).toBe(KEN);
    expect(await resolveSezName(deps, 'ken-wzrdz-cool')).toBe(KEN);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('forgets an implicit row whose handle moved or died', async () => {
    const { deps } = setup(kenOnly);
    rememberFallback(deps.db, 'ken-wzrdz-cool', ROSS, 0); // stale: it was Ross's once
    expect(await resolveSezName(deps, 'ken-wzrdz-cool')).toBe(KEN);
    expect(getSezName(deps.db, 'ken-wzrdz-cool')).toMatchObject({ did: KEN, claimed: false });
    deps.resolveDid = async () => null;
    expect(await resolveSezName(deps, 'ken-wzrdz-cool')).toBeNull();
    expect(getSezName(deps.db, 'ken-wzrdz-cool')).toBeNull();
  });
  it('serves the row when the resolver is down, and throws only with no row', async () => {
    const { deps } = setup(async () => { throw new Error('resolver down'); });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      rememberFallback(deps.db, 'ken-wzrdz-cool', KEN, 0);
      expect(await resolveSezName(deps, 'ken-wzrdz-cool')).toBe(KEN);
      await expect(resolveSezName(deps, 'ross-example')).rejects.toThrow(/resolver down/);
    } finally { warned.mockRestore(); }
  });
});

describe('applySezClaim', () => {
  it('claims a free name, moves to another, and releases on null', async () => {
    const { deps } = setup(kenOnly);
    await applySezClaim(deps, KEN, 'ken');
    expect(claimedSezNameFor(deps.db, KEN)).toBe('ken');
    await applySezClaim(deps, KEN, 'kenny');
    expect(claimedSezNameFor(deps.db, KEN)).toBe('kenny');
    expect(getSezName(deps.db, 'ken')).toBeNull();
    await applySezClaim(deps, KEN, null);
    expect(claimedSezNameFor(deps.db, KEN)).toBeNull();
  });
  it('says taken and reserved in words', async () => {
    const { deps } = setup(kenOnly);
    claimSezName(deps.db, 'ken', ROSS, 0);
    await expect(applySezClaim(deps, KEN, 'ken')).rejects.toThrow('that name is taken.');
    await expect(applySezClaim(deps, KEN, 'www')).rejects.toThrow('that name is reserved.');
    // Someone else's hyphenated handle is reserved too — nobody claims ken-wzrdz-cool from under Ken.
    await expect(applySezClaim(deps, ROSS, 'ken-wzrdz-cool')).rejects.toThrow('that name is reserved.');
    // ...but Ken may claim his own.
    await expect(applySezClaim(deps, KEN, 'ken-wzrdz-cool')).resolves.toBeUndefined();
    expect(claimedSezNameFor(deps.db, KEN)).toBe('ken-wzrdz-cool');
    expect(claimedSezNameFor(deps.db, ROSS)).toBe('ken');
  });
  it('will not grant a hyphenated name it cannot check', async () => {
    const { deps } = setup(async () => { throw new Error('resolver down'); });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(applySezClaim(deps, KEN, 'ken-wzrdz-cool')).rejects.toThrow(/couldn't check that name/);
      // A name with no hyphen has no handle reading: no resolver call, no failure.
      await expect(applySezClaim(deps, KEN, 'ken')).resolves.toBeUndefined();
    } finally { warned.mockRestore(); }
  });
  it('undo puts the previous state back, and swallows a race it lost', () => {
    const { deps } = setup();
    claimSezName(deps.db, 'kenny', KEN, 0);
    undoSezClaim(deps, KEN, 'ken');
    expect(claimedSezNameFor(deps.db, KEN)).toBe('ken');
    undoSezClaim(deps, KEN, null);
    expect(claimedSezNameFor(deps.db, KEN)).toBeNull();
    claimSezName(deps.db, 'ken', ROSS, 0);
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => undoSezClaim(deps, KEN, 'ken')).not.toThrow();
      expect(getSezName(deps.db, 'ken')!.did).toBe(ROSS);
    } finally { errored.mockRestore(); }
  });
});
