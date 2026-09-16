import type { Deps } from '../atproto/types.js';
import {
  AVAILABILITY_NSID, AVAILABILITY_RKEY, buildAvailabilityRecord, validateAvailabilityRecord,
  type AvailabilityRecord,
} from '../atproto/records.js';
import { normalizeAvailability, prefillFromAvailability } from '../core/availability.js';
import type { Interval } from '../core/intervals.js';
import { getAvailabilityCache, upsertAvailabilityCache } from '../db/availabilityCache.js';
import { freshnessFor } from './freshness.js';

/** Live read of a DID's own record; the cache is refreshed as a side effect. */
async function readLive(deps: Deps, did: string): Promise<AvailabilityRecord | null> {
  const found = await deps.reader.getRecord(did, AVAILABILITY_NSID, AVAILABILITY_RKEY);
  if (!found) { upsertAvailabilityCache(deps.db, did, null); return null; }
  const record = validateAvailabilityRecord(found.value);
  upsertAvailabilityCache(deps.db, did, { uri: found.uri, cid: found.cid, record });
  freshnessFor(deps).mark(`avail:${did}`, deps.now().getTime());
  return record;
}

/** The editor's read: always live. It is one small read of the viewer's own repo. */
export function getOwnAvailability(deps: Deps, did: string): Promise<AvailabilityRecord | null> {
  return readLive(deps, did);
}

/**
 * `JSON.stringify` with object keys sorted (arrays keep their order), so two objects
 * that differ only in key order serialize identically. A live record answers by a real
 * PDS comes back through a dag-cbor round trip, which canonicalises (sorts) map keys —
 * a plain `JSON.stringify` compare would then see every save as a change.
 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.keys(v as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v);
}

const sameButForStamp = (a: AvailabilityRecord, b: AvailabilityRecord): boolean => {
  const { updatedAt: _a, ...ra } = a;
  const { updatedAt: _b, ...rb } = b;
  return stableStringify(ra) === stableStringify(rb);
};

/**
 * Normalize what the editor posted, then put it at rkey `self` — unless the live record
 * already says exactly this, in which case nothing is written (no churn, no new CID).
 */
export async function saveAvailability(
  deps: Deps, did: string, input: unknown,
): Promise<{ record: AvailabilityRecord; written: boolean }> {
  const normalized = normalizeAvailability(input);
  const record = buildAvailabilityRecord(normalized, deps.now());
  const live = await readLive(deps, did);
  if (live && sameButForStamp(live, record)) return { record: live, written: false };
  const writer = await deps.writerFor(did);
  const ref = await writer.putRecord(did, AVAILABILITY_NSID, AVAILABILITY_RKEY, record);
  upsertAvailabilityCache(deps.db, did, { uri: ref.uri, cid: ref.cid, record });
  freshnessFor(deps).mark(`avail:${did}`, deps.now().getTime());
  return { record, written: true };
}

/**
 * Anyone else's record: cache first, revalidated in the background window `poll_cache`
 * uses. A cached row (even one that says "none") is served when the PDS will not answer;
 * only a cold miss propagates the failure.
 */
export async function getAvailabilityCached(deps: Deps, did: string): Promise<AvailabilityRecord | null> {
  const cached = getAvailabilityCache(deps.db, did);
  const fresh = freshnessFor(deps);
  const nowMs = deps.now().getTime();
  if (cached && fresh.isFresh(`avail:${did}`, nowMs)) return cached.record;
  fresh.mark(`avail:${did}`, nowMs);
  try {
    return await readLive(deps, did);
  } catch (err) {
    if (!cached) throw err;
    console.warn(`availability revalidate failed for ${did}; serving cache:`, err);
    return cached.record;
  }
}

/** Slots the viewer's standing record says they can make, or null for "don't know". Never throws. */
export async function prefillForPoll(deps: Deps, did: string, slots: Interval[]): Promise<Interval[] | null> {
  try {
    const rec = await getAvailabilityCached(deps, did);
    if (!rec) return null;
    return prefillFromAvailability(rec, slots, deps.now());
  } catch (err) {
    console.warn(`availability prefill skipped for ${did}:`, err);
    return null;
  }
}
