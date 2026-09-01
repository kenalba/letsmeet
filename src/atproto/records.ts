import { Lexicons, type LexiconDoc } from '@atproto/lexicon';
import scheduleLex from '../../lexicons/cool.wzrdz.poll.schedule.json' with { type: 'json' };
import responseLex from '../../lexicons/cool.wzrdz.poll.response.json' with { type: 'json' };
import strongRefLex from '../../lexicons/com.atproto.repo.strongRef.json' with { type: 'json' };
import { mergeIntervals, normalizeIso, type Interval } from '../core/intervals.js';
import type { SpecificDates } from '../core/slots.js';

export const SCHEDULE_NSID = 'cool.wzrdz.poll.schedule';
export const RESPONSE_NSID = 'cool.wzrdz.poll.response';

export const lexicons = new Lexicons(
  [scheduleLex, responseLex, strongRefLex] as unknown as LexiconDoc[],
);

export type PollStatus = 'active' | 'closed' | 'finalized' | 'cancelled';

export interface ScheduleRecord {
  $type: typeof SCHEDULE_NSID;
  title: string;
  description?: string;
  time: SpecificDates & { $type: string };
  status: PollStatus;
  finalized?: Interval;
  closesAt?: string;
  createdAt: string;
}

export interface ResponseRecord {
  $type: typeof RESPONSE_NSID;
  subject: { uri: string; cid: string };
  available: Interval[];
  ifNeedBe?: Interval[];
  guest?: { name: string };
  timezone?: string;
  note?: string;
  createdAt: string;
}

export function validateScheduleRecord(v: unknown): ScheduleRecord {
  lexicons.assertValidRecord(SCHEDULE_NSID, v);
  return v as ScheduleRecord;
}

export function validateResponseRecord(v: unknown): ResponseRecord {
  lexicons.assertValidRecord(RESPONSE_NSID, v);
  return v as ResponseRecord;
}

export function buildScheduleRecord(input: {
  title: string; description?: string; time: SpecificDates; closesAt?: string;
}): ScheduleRecord {
  const rec: ScheduleRecord = {
    $type: SCHEDULE_NSID,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    time: { $type: `${SCHEDULE_NSID}#specificDates`, ...input.time },
    status: 'active',
    ...(input.closesAt ? { closesAt: normalizeIso(input.closesAt) } : {}),
    createdAt: new Date().toISOString(),
  };
  return validateScheduleRecord(rec);
}

export function buildResponseRecord(input: {
  subject: { uri: string; cid: string };
  available: Interval[];
  ifNeedBe?: Interval[];
  guestName?: string;
  timezone?: string;
  note?: string;
}): ResponseRecord {
  const ifNeedBe = input.ifNeedBe?.length ? mergeIntervals(input.ifNeedBe) : undefined;
  const rec: ResponseRecord = {
    $type: RESPONSE_NSID,
    subject: input.subject,
    available: mergeIntervals(input.available),
    ...(ifNeedBe ? { ifNeedBe } : {}),
    ...(input.guestName ? { guest: { name: input.guestName } } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: new Date().toISOString(),
  };
  return validateResponseRecord(rec);
}
