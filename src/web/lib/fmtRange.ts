import { DateTime } from 'luxon';
import type { Interval } from '../../core/intervals.js';

/** "17:00–18:00 Wed Sep 2", rendered in the poll's own timezone. */
export function fmtRange(slot: Interval, zone: string): string {
  const s = DateTime.fromISO(slot.start, { zone });
  const e = DateTime.fromISO(slot.end, { zone });
  return `${s.toFormat('HH:mm')}–${e.toFormat('HH:mm')} ${s.toFormat('ccc LLL d')}`;
}
