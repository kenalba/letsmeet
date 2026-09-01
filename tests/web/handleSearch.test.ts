import { describe, it, expect } from 'vitest';
import {
  parseActors, bskyHandleSearch, cachedHandleSearch, fakeHandleSearch,
} from '../../src/web/handleSearch.js';

describe('parseActors', () => {
  it('keeps only well-formed hits and only the fields the list shows', () => {
    const hits = parseActors({ actors: [
      { did: 'did:plc:x', handle: 'alice.example.com', displayName: 'Alice', avatar: 'https://cdn.bsky.app/img/avatar/plain/x@jpeg', labels: [] },
      { handle: 'handle.invalid', displayName: 'Ghost' },
      { handle: 'bad handle!', displayName: 'Nope' },
      { handle: 'noavatar.test', avatar: 'https://evil.example/x.png', displayName: '   ' },
      { notAHandle: true },
      'junk',
    ] });
    expect(hits).toEqual([
      { handle: 'alice.example.com', displayName: 'Alice', avatar: 'https://cdn.bsky.app/img/avatar/plain/x@jpeg' },
      { handle: 'noavatar.test' },
    ]);
  });
  it('is empty for anything that is not an actors array', () => {
    expect(parseActors(null)).toEqual([]);
    expect(parseActors({ actors: 'x' })).toEqual([]);
  });
  it('caps the list at eight', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ handle: `u${i}.test` }));
    expect(parseActors({ actors: many })).toHaveLength(8);
  });
});

describe('bskyHandleSearch', () => {
  it('asks the public AppView with the query and a limit, and parses the answer', async () => {
    let seen = '';
    const f = (async (input: RequestInfo | URL) => {
      seen = String(input);
      return new Response(JSON.stringify({ actors: [{ handle: 'ken.wzrdz.cool' }] }), { status: 200 });
    }) as typeof fetch;
    const hits = await bskyHandleSearch(f)('ken');
    expect(seen).toBe('https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead?q=ken&limit=8');
    expect(hits).toEqual([{ handle: 'ken.wzrdz.cool' }]);
  });
  it('throws on a non-OK upstream so the route can degrade', async () => {
    const f = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(bskyHandleSearch(f)('ken')).rejects.toThrow(/503/);
  });
});

describe('cachedHandleSearch', () => {
  it('answers a repeated query from memory, case-insensitively', async () => {
    let calls = 0;
    const s = cachedHandleSearch(async (q) => { calls++; return [{ handle: `${q}.test` }]; });
    await s('Ali');
    await s('ali');
    await s('ALI');
    expect(calls).toBe(1);
    await s('bob');
    expect(calls).toBe(2);
  });
});

describe('fakeHandleSearch', () => {
  it('prefix-matches the roster on handle or display name', async () => {
    expect((await fakeHandleSearch('ali')).map((h) => h.handle)).toEqual(['alice.test', 'alicia.example.com']);
    expect((await fakeHandleSearch('Bo')).map((h) => h.handle)).toEqual(['bob.test']);
    expect(await fakeHandleSearch('zzz')).toEqual([]);
  });
});
