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

/**
 * Delete the calendar events a decision filed in the host's repo. Best effort, like the
 * write that made them: the decision itself is already recorded, and a missing or
 * unreachable event costs a stale calendar entry, not the poll.
 */
async function dropEvents(deps: Deps, hostDid: string, poll: CachedPoll): Promise<void> {
  const writer = await deps.writerFor(hostDid);
  for (const ref of poll.record.events ?? []) {
    try {
      await writer.deleteRecord(hostDid, EVENT_NSID, parseRkey(ref.uri));
    } catch (err) {
      console.error('community event delete failed:', err);
    }
  }
}

/**
 * Pick the time. From an open or closed poll this decides it; from a decided poll it is a
 * repick: the earlier event leaves the host's repo and a fresh one is filed for the new
 * slot. The event refs ride on the schedule record so the cleanup is exact — and so a
 * later "several sessions" poll can carry more than one.
 */
export async function finalizePoll(
  deps: Deps, hostDid: string, rkey: string, slot: Interval,
): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  const before = poll.record.finalized;
  if (poll.record.status === 'finalized' && before
    && before.start === slot.start && before.end === slot.end) {
    throw new UserError('that time is already picked');
  }
  const slots = materializeSlots(poll.record.time);
  const winning = slots.some((s) => s.start === slot.start && s.end === slot.end);
  if (!winning) throw new UserError('not a slot of this poll');

  if (poll.record.status === 'finalized') await dropEvents(deps, hostDid, poll);

  // Field names checked against the published community.lexicon.calendar.event schema on
  // 2026-09-16: name, description, startsAt, endsAt, createdAt all match.
  //
  // Best effort: a failure here costs a calendar record, not the decision, which is
  // written below either way.
  let events: ScheduleRecord['events'];
  try {
    const writer = await deps.writerFor(hostDid);
    const ref = await writer.createRecord(hostDid, EVENT_NSID, {
      $type: EVENT_NSID,
      name: poll.record.title,
      ...(poll.record.description ? { description: poll.record.description } : {}),
      startsAt: slot.start,
      endsAt: slot.end,
      createdAt: deps.now().toISOString(),
    });
    events = [{ uri: ref.uri, cid: ref.cid }];
  } catch (err) {
    console.error('community event write failed:', err);
  }

  const { events: _dropped, ...rest } = poll.record;
  const next = validateScheduleRecord({
    ...rest, status: 'finalized', finalized: slot, ...(events ? { events } : {}),
  });
  await putUpdated(deps, hostDid, rkey, next);
}

/** Stop taking responses without deciding anything; the tally freezes where it is. */
export async function closePoll(deps: Deps, hostDid: string, rkey: string): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (poll.record.status !== 'active') throw new UserError('poll is not open');
  await putUpdated(deps, hostDid, rkey, validateScheduleRecord({ ...poll.record, status: 'closed' }));
}

/**
 * Back to taking responses, from closed or decided. A decision is undone entirely: the
 * slot is forgotten and its calendar event leaves the host's repo.
 */
export async function reopenPoll(deps: Deps, hostDid: string, rkey: string): Promise<void> {
  const poll = loadOwned(deps, hostDid, rkey);
  if (poll.record.status === 'active') throw new UserError('poll is already open');
  if (poll.record.status === 'finalized') await dropEvents(deps, hostDid, poll);
  const { finalized: _slot, events: _events, ...rest } = poll.record;
  await putUpdated(deps, hostDid, rkey, validateScheduleRecord({ ...rest, status: 'active' }));
}
