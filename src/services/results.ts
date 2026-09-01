import type { Deps } from '../atproto/types.js';
import type { Interval } from '../core/intervals.js';
import { materializeSlots } from '../core/slots.js';
import { rankSlots, type RankedSlot, type ResponseSummary } from '../core/ranking.js';
import { validateResponseRecord, RESPONSE_NSID } from '../atproto/records.js';
import { getPollWithRevalidate } from './polls.js';
import { findOwnResponse } from './responses.js';
import {
  addParticipant, listParticipants, listResponseCache, upsertResponseCache, type CachedPoll,
} from '../db/cache.js';
import { freshnessFor, mapLimit } from './freshness.js';

/** Participant PDS reads in flight at once, and the wall-clock budget for all of them. */
const FANOUT_CONCURRENCY = 4;
const FANOUT_BUDGET_MS = 8_000;

export interface PollResults {
  poll: CachedPoll;
  slots: Interval[];
  responses: ResponseSummary[];
  ranked: RankedSlot[];
}

export async function getResults(deps: Deps, pollRkey: string): Promise<PollResults | null> {
  const poll = await getPollWithRevalidate(deps, pollRkey);
  if (!poll) return null;

  // Revalidate account responses straight from each participant's PDS — but at most once
  // per TTL per poll, a few at a time, and never past a fixed budget. Unbounded, this loop
  // was N sequential outbound reads per anonymous page view: a self-DoS and a reflector.
  const fresh = freshnessFor(deps);
  const key = `responses:${pollRkey}`;
  const nowMs = deps.now().getTime();
  if (!fresh.isFresh(key, nowMs)) {
    fresh.mark(key, nowMs);
    const participants = listParticipants(deps.db, pollRkey);
    await mapLimit(participants, FANOUT_CONCURRENCY, Date.now() + FANOUT_BUDGET_MS, async ({ did, handle }) => {
      try {
        // A participant recorded before their handle was captured (or whose session had
        // none) is named from their DID document, once found; until then the DID shows.
        if (!handle && deps.resolveHandle) {
          const found = await deps.resolveHandle(did);
          if (found) addParticipant(deps.db, pollRkey, did, found);
        }
        const mine = findOwnResponse(await deps.reader.listRecords(did, RESPONSE_NSID), poll.uri);
        if (mine) {
          let record;
          try {
            record = validateResponseRecord(mine.value);
          } catch (err) {
            // Distinct from a read failure: this participant's record is unusable until
            // they (or the schema) change, so say so rather than silently keeping the
            // stale row.
            console.warn(`invalid live response record for ${did}:`, err);
            throw err;
          }
          upsertResponseCache(deps.db, pollRkey, 'account', did, record, false);
        }
      } catch {
        // read failure or unusable record: stale cache is fine for a read
      }
    });
  }

  // An account response is keyed by DID; people are shown the handle when one is known.
  const handles = new Map(listParticipants(deps.db, pollRkey).map((p) => [p.did, p.handle]));
  const rows = listResponseCache(deps.db, pollRkey);
  const responses: ResponseSummary[] = rows.map((row) => ({
    who: row.source === 'guest'
      ? row.record.guest?.name ?? 'Guest'
      : handles.get(row.key) ?? row.key,
    pending: row.pending || undefined,
    available: row.record.available,
    ifNeedBe: row.record.ifNeedBe ?? [],
  }));

  const slots = materializeSlots(poll.record.time);
  return { poll, slots, responses, ranked: rankSlots(slots, responses) };
}
