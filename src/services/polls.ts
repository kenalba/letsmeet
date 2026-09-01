import type { Deps } from '../atproto/types.js';
import type { SpecificDates } from '../core/slots.js';
import {
  buildScheduleRecord, validateScheduleRecord, SCHEDULE_NSID, type ScheduleRecord,
} from '../atproto/records.js';
import {
  upsertPollCache, getPollCache, tombstonePoll, countResponses, type CachedPoll,
} from '../db/cache.js';

export function parseRkey(uri: string): string {
  const rkey = uri.split('/').pop();
  if (!rkey) throw new Error(`malformed at-uri: ${uri}`);
  return rkey;
}

export async function createPoll(
  deps: Deps, hostDid: string,
  input: { title: string; description?: string; time: SpecificDates },
): Promise<{ rkey: string; uri: string; cid: string }> {
  const record = buildScheduleRecord(input);
  const writer = await deps.writerFor(hostDid);
  const ref = await writer.createRecord(hostDid, SCHEDULE_NSID, record);
  const rkey = parseRkey(ref.uri);
  upsertPollCache(deps.db, { rkey, uri: ref.uri, hostDid, cid: ref.cid, record });
  return { rkey, uri: ref.uri, cid: ref.cid };
}

export async function getPollWithRevalidate(deps: Deps, rkey: string): Promise<CachedPoll | null> {
  const cached = getPollCache(deps.db, rkey);
  if (!cached) return null;
  try {
    const live = await deps.reader.getRecord(cached.hostDid, SCHEDULE_NSID, rkey);
    if (live === null) {
      tombstonePoll(deps.db, rkey);
    } else {
      upsertPollCache(deps.db, {
        rkey, uri: live.uri, hostDid: cached.hostDid, cid: live.cid,
        record: validateScheduleRecord(live.value),
      });
    }
  } catch {
    // network trouble: stale cache is fine
  }
  return getPollCache(deps.db, rkey);
}

async function putUpdated(
  deps: Deps, hostDid: string, rkey: string, next: ScheduleRecord,
): Promise<void> {
  const writer = await deps.writerFor(hostDid);
  const ref = await writer.putRecord(hostDid, SCHEDULE_NSID, rkey, next);
  upsertPollCache(deps.db, { rkey, uri: ref.uri, hostDid, cid: ref.cid, record: next });
}

function loadOwned(deps: Deps, hostDid: string, rkey: string): CachedPoll {
  const poll = getPollCache(deps.db, rkey);
  if (!poll) throw new Error(`unknown poll: ${rkey}`);
  if (poll.hostDid !== hostDid) throw new Error('only the host may edit a poll');
  return poll;
}

export async function updatePollMeta(
  deps: Deps, hostDid: string, rkey: string,
  input: { title?: string; description?: string },
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  const next = validateScheduleRecord({ ...poll.record, ...input });
  await putUpdated(deps, hostDid, rkey, next);
}

export async function updatePollTime(
  deps: Deps, hostDid: string, rkey: string, time: SpecificDates,
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (countResponses(deps.db, rkey) > 0) {
    throw new Error('geometry is frozen once responses exist');
  }
  const next = validateScheduleRecord({
    ...poll.record,
    time: { $type: `${SCHEDULE_NSID}#specificDates`, ...time },
  });
  await putUpdated(deps, hostDid, rkey, next);
}
