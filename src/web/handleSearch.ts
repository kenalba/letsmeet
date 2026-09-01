/**
 * Handle suggestions for the sign-in form, from Bluesky's public typeahead. The browser
 * never talks to Bluesky itself: keystrokes go to our own `/api/handles`, which asks the
 * AppView, trims the answer to the three fields the list needs, and caches it briefly.
 * Self-hosted accounts are included — the AppView indexes every repo it has crawled,
 * whichever PDS it lives on.
 */

export interface HandleHit {
  handle: string;
  displayName?: string;
  avatar?: string;
}

export type HandleSearch = (q: string) => Promise<HandleHit[]>;

const TYPEAHEAD_URL = 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead';
const TIMEOUT_MS = 3_000;
const LIMIT = 8;

const isHandle = (s: unknown): s is string => typeof s === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(s);
/** Avatars come from Bluesky's CDN and nowhere else (matches the CSP img-src allowance). */
const isAvatar = (s: unknown): s is string => typeof s === 'string' && /^https:\/\/cdn\.bsky\.app\/[^\s"'<>]+$/.test(s);

/** Parse the AppView's answer defensively: only well-formed hits, only the fields we show. */
export function parseActors(body: unknown): HandleHit[] {
  const actors = (body as { actors?: unknown })?.actors;
  if (!Array.isArray(actors)) return [];
  const out: HandleHit[] = [];
  for (const a of actors) {
    const handle = (a as { handle?: unknown })?.handle;
    if (!isHandle(handle) || handle === 'handle.invalid') continue;
    const displayName = (a as { displayName?: unknown }).displayName;
    const avatar = (a as { avatar?: unknown }).avatar;
    out.push({
      handle,
      ...(typeof displayName === 'string' && displayName.trim() ? { displayName: displayName.slice(0, 64) } : {}),
      ...(isAvatar(avatar) ? { avatar } : {}),
    });
    if (out.length >= LIMIT) break;
  }
  return out;
}

export function bskyHandleSearch(fetchImpl: typeof fetch = fetch): HandleSearch {
  return async (q) => {
    const u = new URL(TYPEAHEAD_URL);
    u.searchParams.set('q', q);
    u.searchParams.set('limit', String(LIMIT));
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!res.ok) throw new Error(`typeahead upstream ${res.status}`);
    return parseActors(await res.json());
  };
}

/** The e2e rig's stand-in: a fixed roster, prefix-matched on handle or display name. */
export const fakeHandleSearch: HandleSearch = async (q) => {
  const roster: HandleHit[] = [
    { handle: 'alice.test', displayName: 'Alice' },
    { handle: 'alicia.example.com', displayName: 'Alicia Example' },
    { handle: 'bob.test', displayName: 'Bob' },
    { handle: 'wzrdz.cool' },
  ];
  const needle = q.toLowerCase();
  return roster.filter((h) =>
    h.handle.startsWith(needle) || (h.displayName?.toLowerCase().startsWith(needle) ?? false));
};

/** Memoize a search for a minute per query; bounded, since queries are attacker-chosen. */
export function cachedHandleSearch(inner: HandleSearch, ttlMs = 60_000, max = 2_000): HandleSearch {
  const cache = new Map<string, { at: number; hits: HandleHit[] }>();
  return async (q) => {
    const key = q.toLowerCase();
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < ttlMs) return hit.hits;
    const hits = await inner(q);
    if (cache.size >= max && !cache.has(key)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: now, hits });
    return hits;
  };
}
