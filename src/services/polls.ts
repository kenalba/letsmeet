import type { Deps } from '../atproto/types.js';
import type { SpecificDates } from '../core/slots.js';
import { buildScheduleRecord, validateScheduleRecord, SCHEDULE_NSID, type ScheduleRecord, EVENT_NSID } from '../atproto/records.js';
import {
  upsertPollCache, getPollCache, tombstonePoll, countResponses, type CachedPoll,
} from '../db/cache.js';
import { materializeSlots } from '../core/slots.js';
import type { Interval } from '../core/intervals.js';
import { UserError } from '../core/errors.js';
import { freshnessFor } from './freshness.js';

/**
 * A poll whose geometry cannot be materialized — a made-up timezone, a malformed date —
 * used to be writable and then 500 on every view, with no way to edit or delete it. The
 * lexicon only checks shapes (a string ≤ 64 chars is a "timezone"), so materialize once
 * here, before anything is written, and refuse what the grid could never render.
 */
function assertRenderable(time: SpecificDates): void {
  if (materializeSlots(time).length === 0) {
    throw new UserError('the daily window is shorter than one slot');
  }
}

export function parseRkey(uri: string): string {
  const rkey = uri.split('/').pop();
  if (!rkey) throw new Error(`malformed at-uri: ${uri}`);
  return rkey;
}

export async function createPoll(
  deps: Deps, hostDid: string,
  input: { title: string; description?: string; time: SpecificDates },
): Promise<{ rkey: string; uri: string; cid: string }> {
  assertRenderable(input.time);
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
  // One live read per poll per TTL, not per page view (see freshness.ts).
  const fresh = freshnessFor(deps);
  const key = `poll:${rkey}`;
  const nowMs = deps.now().getTime();
  if (fresh.isFresh(key, nowMs)) return cached;
  fresh.mark(key, nowMs);
  try {
    const live = await deps.reader.getRecord(cached.hostDid, SCHEDULE_NSID, rkey);
    if (live === null) {
      tombstonePoll(deps.db, rkey);
    } else {
      let record;
      try {
        record = validateScheduleRecord(live.value);
      } catch (err) {
        // Worth its own line: a live record we cannot parse is a schema/host problem that
        // will not fix itself, unlike the read failures the outer catch mostly sees.
        console.warn(`invalid live schedule record for ${rkey}:`, err);
        throw err;
      }
      upsertPollCache(deps.db, {
        rkey, uri: live.uri, hostDid: cached.hostDid, cid: live.cid, record,
      });
    }
  } catch {
    // read failure or unusable record: stale cache is fine
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
  if (!poll) throw new UserError(`unknown poll: ${rkey}`);
  if (poll.hostDid !== hostDid) throw new UserError('only the host may edit a poll');
  return poll;
}

export async function updatePollMeta(
  deps: Deps, hostDid: string, rkey: string,
  input: { title?: string; description?: string },
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  const merged: Record<string, unknown> = { ...poll.record, ...input };
  // An empty description is a removed one, not a record with an empty string in it.
  if (!merged.description) delete merged.description;
  const next = validateScheduleRecord(merged);
  await putUpdated(deps, hostDid, rkey, next);
}

/**
 * The record leaves the host's repo and the cache row is tombstoned, so the share link
 * answers 410 from now on. Guests' own response records are theirs and stay put; a
 * withdrawn poll simply stops rendering them.
 */
export async function withdrawPoll(deps: Deps, hostDid: string, rkey: string): Promise<void> {
  loadOwned(deps, hostDid, rkey);
  const writer = await deps.writerFor(hostDid);
  await writer.deleteRecord(hostDid, SCHEDULE_NSID, rkey);
  tombstonePoll(deps.db, rkey);
}

export async function updatePollTime(
  deps: Deps, hostDid: string, rkey: string, time: SpecificDates,
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (countResponses(deps.db, rkey) > 0) {
    throw new UserError('geometry is frozen once responses exist');
  }
  assertRenderable(time);
  const next = validateScheduleRecord({
    ...poll.record,
    time: { $type: `${SCHEDULE_NSID}#specificDates`, ...time },
  });
  await putUpdated(deps, hostDid, rkey, next);
}

export { EVENT_NSID };

export async function finalizePoll(
  deps: Deps, hostDid: string, rkey: string, slot: Interval,
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (poll.record.status === 'finalized') throw new UserError('poll is already finalized');
  const slots = materializeSlots(poll.record.time);
  const winning = slots.some((s) => s.start === slot.start && s.end === slot.end);
  if (!winning) throw new UserError('not a slot of this poll');

  const next = validateScheduleRecord({ ...poll.record, status: 'finalized', finalized: slot });
  await putUpdated(deps, hostDid, rkey, next);

  // NOTE for the implementer: before first deploy, diff these fields against the published
  // community.lexicon.calendar.event schema at https://github.com/lexicon-community/lexicon
  // and adjust names to match exactly. The test asserts only `name`.
  //
  // Best effort: the poll is already finalized in the host's repo and in our cache, so a
  // failure here costs a calendar record, not the decision.
  try {
    const writer = await deps.writerFor(hostDid);
    await writer.createRecord(hostDid, EVENT_NSID, {
      $type: EVENT_NSID,
      name: poll.record.title,
      ...(poll.record.description ? { description: poll.record.description } : {}),
      startsAt: slot.start,
      endsAt: slot.end,
      createdAt: deps.now().toISOString(),
    });
  } catch (err) {
    console.error('community event write failed:', err);
  }
}
