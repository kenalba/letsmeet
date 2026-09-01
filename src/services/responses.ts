import { TID } from '@atproto/common';
import type { Deps } from '../atproto/types.js';
import type { Interval } from '../core/intervals.js';
import { snapToSlots } from '../core/intervals.js';
import { materializeSlots } from '../core/slots.js';
import {
  buildResponseRecord, validateResponseRecord, RESPONSE_NSID, type ResponseRecord,
} from '../atproto/records.js';
import { getPollWithRevalidate, parseRkey } from './polls.js';
import { createEditSecret, lookupEditSecret } from '../db/editSecrets.js';
import {
  enqueueOutbox, dueOutbox, markOutboxDone, markOutboxFailed,
} from '../db/outbox.js';
import {
  upsertResponseCache, listResponseCache, countResponses, addParticipant,
} from '../db/cache.js';
import type { CachedPoll } from '../db/cache.js';

export const GUEST_CAP = 60;

async function loadOpenPoll(deps: Deps, pollRkey: string): Promise<CachedPoll> {
  const poll = await getPollWithRevalidate(deps, pollRkey);
  if (!poll || poll.tombstoned) throw new Error('poll not found');
  if (poll.record.status !== 'active') throw new Error('poll is not open for responses');
  return poll;
}

function snapPaint(poll: CachedPoll, available: Interval[], ifNeedBe?: Interval[]) {
  const slots = materializeSlots(poll.record.time);
  const snappedAvailable = available.length ? snapToSlots(available, slots) : [];
  const snappedIfNeedBe = ifNeedBe?.length ? snapToSlots(ifNeedBe, slots) : [];
  if (snappedAvailable.length === 0 && snappedIfNeedBe.length === 0) {
    throw new Error('no valid availability painted');
  }
  return { snappedAvailable, snappedIfNeedBe };
}

function buildFromPaint(
  poll: CachedPoll,
  snapped: { snappedAvailable: Interval[]; snappedIfNeedBe: Interval[] },
  extra: { guestName?: string; timezone?: string; note?: string },
): ResponseRecord {
  return buildResponseRecord({
    subject: { uri: poll.uri, cid: poll.cid ?? '' },
    available: snapped.snappedAvailable, // may be [] when only ifNeedBe was painted
    ifNeedBe: snapped.snappedIfNeedBe.length ? snapped.snappedIfNeedBe : undefined,
    ...extra,
  });
}

/**
 * Everything that identifies a response except `createdAt`, which is stamped fresh on every
 * build: repainting the same cells must not churn the host's repo or the outbox.
 */
function paintIdentity(r: ResponseRecord): string {
  return JSON.stringify({
    subject: r.subject, available: r.available, ifNeedBe: r.ifNeedBe,
    guest: r.guest, timezone: r.timezone, note: r.note,
  });
}

export async function submitGuestResponse(
  deps: Deps, pollRkey: string,
  input: {
    name: string; available: Interval[]; ifNeedBe?: Interval[];
    timezone?: string; note?: string; editToken?: string;
  },
): Promise<{ editToken: string; pending: boolean }> {
  const poll = await loadOpenPoll(deps, pollRkey);
  const existingRkey = input.editToken ? lookupEditSecret(deps.db, poll.uri, input.editToken) : null;
  if (input.editToken && !existingRkey) throw new Error('invalid edit link');
  if (!existingRkey && countResponses(deps.db, pollRkey) >= GUEST_CAP) {
    throw new Error('this poll is full');
  }
  const snapped = snapPaint(poll, input.available, input.ifNeedBe);
  const record = buildFromPaint(poll, snapped, {
    guestName: input.name, timezone: input.timezone, note: input.note,
  });

  if (existingRkey) {
    const cached = listResponseCache(deps.db, pollRkey)
      .find((r) => r.source === 'guest' && r.key === existingRkey);
    if (cached && paintIdentity(cached.record) === paintIdentity(record)) {
      return { editToken: input.editToken!, pending: cached.pending };
    }
  }

  const rkey = existingRkey ?? TID.nextStr();
  const now = deps.now().getTime();
  const outboxId = enqueueOutbox(
    deps.db, { hostDid: poll.hostDid, pollUri: poll.uri, rkey, record }, now,
  );
  upsertResponseCache(deps.db, pollRkey, 'guest', rkey, record, true);
  const editToken = existingRkey && input.editToken
    ? input.editToken
    : createEditSecret(deps.db, poll.uri, rkey);

  // best-effort immediate flush; failure just leaves it pending
  let pending = true;
  try {
    const writer = await deps.writerFor(poll.hostDid);
    await writer.putRecord(poll.hostDid, RESPONSE_NSID, rkey, record);
    markOutboxDone(deps.db, outboxId);
    upsertResponseCache(deps.db, pollRkey, 'guest', rkey, record, false);
    pending = false;
  } catch (err) {
    markOutboxFailed(deps.db, outboxId, (err as Error).message, now);
  }
  return { editToken, pending };
}

export async function submitAccountResponse(
  deps: Deps, did: string, pollRkey: string,
  input: { available: Interval[]; ifNeedBe?: Interval[]; timezone?: string; note?: string },
): Promise<void> {
  const poll = await loadOpenPoll(deps, pollRkey);
  const snapped = snapPaint(poll, input.available, input.ifNeedBe);

  // find an existing response for this poll in the responder's repo → upsert its rkey
  const existing = (await deps.reader.listRecords(did, RESPONSE_NSID)).find(
    (r) => (r.value as unknown as ResponseRecord).subject?.uri === poll.uri,
  );
  const rkey = existing ? parseRkey(existing.uri) : TID.nextStr();

  const record = buildFromPaint(poll, snapped, { timezone: input.timezone, note: input.note });
  const writer = await deps.writerFor(did);
  await writer.putRecord(did, RESPONSE_NSID, rkey, record);
  addParticipant(deps.db, pollRkey, did);
  upsertResponseCache(deps.db, pollRkey, 'account', did, record, false);
}

export async function flushOutbox(deps: Deps): Promise<{ flushed: number; failed: number }> {
  const now = deps.now().getTime();
  let flushed = 0;
  let failed = 0;
  for (const item of dueOutbox(deps.db, now)) {
    try {
      const writer = await deps.writerFor(item.hostDid);
      const record = validateResponseRecord(item.record);
      await writer.putRecord(item.hostDid, RESPONSE_NSID, item.rkey, record);
      markOutboxDone(deps.db, item.id);
      upsertResponseCache(deps.db, parseRkey(item.pollUri), 'guest', item.rkey, record, false);
      flushed++;
    } catch (err) {
      markOutboxFailed(deps.db, item.id, (err as Error).message, now);
      failed++;
    }
  }
  return { flushed, failed };
}
