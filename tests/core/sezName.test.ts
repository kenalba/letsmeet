import { describe, it, expect } from 'vitest';
import {
  isValidSezName, normalizeSezName, isReservedSezName, hyphenateHandle, fallbackHandles,
  RESERVED_NAMES, SEZ_NAME_RULE, MAX_FALLBACK_CANDIDATES,
} from '../../src/core/sezName.js';

describe('isValidSezName', () => {
  it('takes 1 to 32 lowercase letters, digits and inner hyphens', () => {
    for (const ok of ['k', 'ken', 'ken-wzrdz-cool', 'a1', '1a', 'x'.repeat(32)]) {
      expect([ok, isValidSezName(ok)]).toEqual([ok, true]);
    }
  });
  it('refuses the empty string, 33 chars, edge hyphens, double hyphens, uppercase and dots', () => {
    for (const bad of ['', 'x'.repeat(33), '-ken', 'ken-', 'ken--wzrdz', 'Ken', 'ken.wzrdz', 'ken_w', 'ken w']) {
      expect([bad, isValidSezName(bad)]).toEqual([bad, false]);
    }
  });
});

describe('normalizeSezName', () => {
  it('lowercases and trims, and reads nothing as null', () => {
    expect(normalizeSezName('  Ken ')).toBe('ken');
    expect(normalizeSezName('')).toBeNull();
    expect(normalizeSezName('   ')).toBeNull();
    expect(normalizeSezName(undefined)).toBeNull();
    expect(normalizeSezName(null)).toBeNull();
  });
  it('explains a bad shape in words', () => {
    expect(() => normalizeSezName('ken--w')).toThrow(SEZ_NAME_RULE);
    expect(() => normalizeSezName(42)).toThrow(/text/);
  });
});

describe('the reserved list', () => {
  it('holds every name the spec names', () => {
    for (const n of ['www', 'api', 'app', 'admin', 'mail', 'smtp', 'imap', 'ftp', 'ns1', 'ns2', 'sez',
      'letsmeet', 'letssuite', 'letseat', 'letsyeet', 'status', 'docs', 'dev', 'test', 'internal',
      'internal-tls', 'u', 'p', 'availability']) {
      expect([n, isReservedSezName(n)]).toEqual([n, true]);
    }
    expect(RESERVED_NAMES.size).toBe(24);
    expect(isReservedSezName('ken')).toBe(false);
  });
});

describe('hyphenateHandle', () => {
  it('turns dots into hyphens, lowercased, without the root dot', () => {
    expect(hyphenateHandle('ken.wzrdz.cool')).toBe('ken-wzrdz-cool');
    expect(hyphenateHandle('Foo-Bar.bsky.social.')).toBe('foo-bar-bsky-social');
  });
});

describe('fallbackHandles', () => {
  it('lists every way back to a handle, most dots first', () => {
    expect(fallbackHandles('ken-wzrdz-cool')).toEqual(['ken.wzrdz.cool', 'ken.wzrdz-cool', 'ken-wzrdz.cool']);
  });
  it('keeps a hyphen-bearing handle reachable, after the all-dots reading', () => {
    expect(fallbackHandles('foo-bar-bsky-social')).toEqual([
      'foo.bar.bsky.social',
      'foo.bar.bsky-social', 'foo.bar-bsky.social', 'foo-bar.bsky.social',
      'foo.bar-bsky-social', 'foo-bar.bsky-social', 'foo-bar-bsky.social',
    ]);
  });
  it('is empty for a label with no hyphen (a handle needs two labels) and for one with too many', () => {
    expect(fallbackHandles('ken')).toEqual([]);
    expect(fallbackHandles('a-b-c-d-e-f')).toEqual([]); // 5 hyphens: 32 readings > MAX_FALLBACK_CANDIDATES
    expect(fallbackHandles('a-b-c-d-e').length).toBe(15); // 4 hyphens: every reading but "no dots"
    expect(MAX_FALLBACK_CANDIDATES).toBe(16);
  });
  it('drops readings that are not handles: a label that would start or end with a hyphen', () => {
    // 'a--b' as a label is fine (a handle label may hold '--'); 'a-' or '-b' is not.
    expect(fallbackHandles('a--b')).toEqual([]); // 'a.-b' and 'a-.b' both malformed, 'a..b' too
  });
});
