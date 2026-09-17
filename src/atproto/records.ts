import { Lexicons, type LexiconDoc } from '@atproto/lexicon';
import scheduleLex from '../../lexicons/lol.letsmeet.poll.schedule.json' with { type: 'json' };
import responseLex from '../../lexicons/lol.letsmeet.poll.response.json' with { type: 'json' };
import availabilityLex from '../../lexicons/lol.letsmeet.availability.json' with { type: 'json' };
import strongRefLex from '../../lexicons/com.atproto.repo.strongRef.json' with { type: 'json' };
import { mergeIntervals, normalizeIso, type Interval } from '../core/intervals.js';
import type { SpecificDates } from '../core/slots.js';
import type { RecordRef } from './types.js';

export const SCHEDULE_NSID = 'lol.letsmeet.poll.schedule';
export const RESPONSE_NSID = 'lol.letsmeet.poll.response';
/** The community calendar event filed in the host's repo when a time is picked. */
export const EVENT_NSID = 'community.lexicon.calendar.event';

export const lexicons = new Lexicons(
  [scheduleLex, responseLex, availabilityLex, strongRefLex] as unknown as LexiconDoc[],
);

export type PollStatus = 'active' | 'closed' | 'finalized' | 'cancelled';

export interface ScheduleRecord {
  $type: typeof SCHEDULE_NSID;
  title: string;
  description?: string;
  time: SpecificDates & { $type: string };
  status: PollStatus;
  finalized?: Interval;
  /** The `community.lexicon.calendar.event` records filed for the chosen time, by ref. */
  events?: RecordRef[];
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

export const AVAILABILITY_NSID = 'lol.letsmeet.availability';
export const AVAILABILITY_RKEY = 'self';

export interface WeeklyBlock { day: number; start: string; end: string }
export interface AwayEntry {
  start: string; end: string; startTime?: string; endTime?: string; note?: string;
}
export interface AvailabilityRecord {
  $type: typeof AVAILABILITY_NSID;
  timezone: string;
  weekly: WeeklyBlock[];
  away: AwayEntry[];
  note?: string;
  validUntil?: string;
  /** The sez name the owner claimed (`ken` in `ken.sez.letsmeet.lol`). */
  alias?: string;
  updatedAt: string;
}

export function validateAvailabilityRecord(v: unknown): AvailabilityRecord {
  lexicons.assertValidRecord(AVAILABILITY_NSID, v);
  return v as AvailabilityRecord;
}

/** Stamp and validate. Snapping, merging and ordering happen in core/availability.ts first. */
export function buildAvailabilityRecord(
  input: Omit<AvailabilityRecord, '$type' | 'updatedAt'>, now: Date,
): AvailabilityRecord {
  const rec: AvailabilityRecord = {
    $type: AVAILABILITY_NSID,
    timezone: input.timezone,
    weekly: input.weekly,
    away: input.away,
    ...(input.note ? { note: input.note } : {}),
    ...(input.validUntil ? { validUntil: normalizeIso(input.validUntil) } : {}),
    ...(input.alias ? { alias: input.alias } : {}),
    updatedAt: now.toISOString(),
  };
  return validateAvailabilityRecord(rec);
}
