import { DateTime } from 'luxon';
import type { ScheduleRecord } from '../atproto/records.js';

/**
 * A poll that is over leaves the landing for the archive: decided, once the chosen time has
 * ended; undecided, once the last day it offered has ended where the poll lives. Status on
 * its own decides nothing — a cancelled poll for next week is still news this week. What
 * cannot be read (no dates, a zone luxon does not know) is never archived: better a stale
 * row on the landing than a poll that vanishes.
 */
export function isOver(record: ScheduleRecord, now: Date): boolean {
  if (record.finalized) return new Date(record.finalized.end).getTime() <= now.getTime();
  const last = [...record.time.dates].sort().at(-1);
  if (!last) return false;
  const end = DateTime.fromISO(last, { zone: record.time.timezone }).endOf('day');
  return end.isValid && end.toMillis() < now.getTime();
}
