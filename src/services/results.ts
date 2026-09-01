import type { Deps } from '../atproto/types.js';
import type { Interval } from '../core/intervals.js';
import { materializeSlots } from '../core/slots.js';
import { rankSlots, type RankedSlot, type ResponseSummary } from '../core/ranking.js';
import { validateResponseRecord, RESPONSE_NSID, type ResponseRecord } from '../atproto/records.js';
import { getPollWithRevalidate } from './polls.js';
import {
  listParticipants, listResponseCache, upsertResponseCache, type CachedPoll,
} from '../db/cache.js';

export interface PollResults {
  poll: CachedPoll;
  slots: Interval[];
  responses: ResponseSummary[];
  ranked: RankedSlot[];
}

export async function getResults(deps: Deps, pollRkey: string): Promise<PollResults | null> {
  const poll = await getPollWithRevalidate(deps, pollRkey);
  if (!poll) return null;

  // revalidate account responses straight from each participant's PDS
  for (const did of listParticipants(deps.db, pollRkey)) {
    try {
      const recs = await deps.reader.listRecords(did, RESPONSE_NSID);
      const mine = recs.find((r) => (r.value as unknown as ResponseRecord).subject?.uri === poll.uri);
      if (mine) {
        upsertResponseCache(deps.db, pollRkey, 'account', did, validateResponseRecord(mine.value), false);
      }
    } catch {
      // stale cache is fine for a read
    }
  }

  const rows = listResponseCache(deps.db, pollRkey);
  const responses: ResponseSummary[] = rows.map((row) => ({
    who: row.source === 'guest' ? row.record.guest?.name ?? 'Guest' : row.key,
    pending: row.pending || undefined,
    available: row.record.available,
    ifNeedBe: row.record.ifNeedBe ?? [],
  }));

  const slots = materializeSlots(poll.record.time);
  return { poll, slots, responses, ranked: rankSlots(slots, responses) };
}
