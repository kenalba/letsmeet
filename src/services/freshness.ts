import type { Deps } from '../atproto/types.js';

/**
 * How long a poll page trusts its cache before asking the PDSes again. Every poll view
 * used to fan out one read per participant, uncached, so a share link that went round a
 * group chat — or anyone with `curl` in a loop — turned this server into a request
 * amplifier against other people's PDSes. Thirty seconds keeps "I just responded, refresh"
 * honest (our own writes update the cache directly, so they never wait on this) while
 * bounding outbound traffic per poll to a fixed rate no matter who is reloading.
 */
export const REVALIDATE_TTL_MS = 30_000;

/** Attacker-influenced keys (poll rkeys are public), so the map is capped. */
const MAX_KEYS = 20_000;

export class Freshness {
  private checked = new Map<string, number>();
  constructor(private ttlMs: number) {}

  /** True when `key` was marked within the TTL — the caller should skip the round trip. */
  isFresh(key: string, nowMs: number): boolean {
    const at = this.checked.get(key);
    return at !== undefined && nowMs - at < this.ttlMs;
  }

  mark(key: string, nowMs: number): void {
    if (this.checked.size >= MAX_KEYS && !this.checked.has(key)) {
      const oldest = this.checked.keys().next().value;
      if (oldest !== undefined) this.checked.delete(oldest);
    }
    this.checked.set(key, nowMs);
  }
}

// One tracker per Deps object, created on first use: tests build a fresh Deps per case and
// get isolated state for free; the server has one Deps for its whole life.
const trackers = new WeakMap<Deps, Freshness>();

export function freshnessFor(deps: Deps): Freshness {
  let f = trackers.get(deps);
  if (!f) {
    f = new Freshness(deps.revalidateTtlMs ?? REVALIDATE_TTL_MS);
    trackers.set(deps, f);
  }
  return f;
}

/**
 * Run `fn` over `items` with at most `limit` in flight, stopping the launch of new work
 * once `deadlineMs` (epoch ms) has passed. Each call's failure is contained: the result is
 * only ever "done" or "gave up", never a rejected batch.
 */
export async function mapLimit<T>(
  items: T[], limit: number, deadlineMs: number, fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && Date.now() < deadlineMs) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        // fn is expected to handle its own failures; this is the belt for the braces.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
