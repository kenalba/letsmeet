import type { AvailabilityInput } from './availability.js';
import { TEMPLATE_SUNDAY } from './availability.js';
import { localWindow } from './slots.js';

const toBasic = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * RFC 5545 TEXT escaping. Every line-break form is folded into a literal `\n` — a bare CR
 * in a title would otherwise start a new content line and let a poll title inject
 * arbitrary properties into the calendar file.
 */
const esc = (s: string) => s
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r\n|\r|\n/g, '\\n');

/**
 * RFC 5545 §3.1: content lines are at most 75 octets; longer ones continue on the next
 * line after a single space. Split on UTF-8 byte count, never inside a multi-byte
 * character, so a long title with accents or emoji stays valid.
 */
export function foldLine(line: string): string {
  const MAX = 75;
  const enc = new TextEncoder();
  if (enc.encode(line).length <= MAX) return line;
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = MAX;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > limit) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
      limit = MAX;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function buildIcs(input: {
  uid: string; title: string; start: string; end: string; url?: string; now: Date;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//letsmeet//EN',
    'BEGIN:VEVENT',
    `UID:${esc(input.uid)}`,
    `DTSTAMP:${toBasic(input.now.toISOString())}`,
    `DTSTART:${toBasic(input.start)}`,
    `DTEND:${toBasic(input.end)}`,
    `SUMMARY:${esc(input.title)}`,
    ...(input.url ? [`URL:${esc(input.url)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const ymd = (d: string) => d.replace(/-/g, '');
const hm = (t: string) => `${t.replace(':', '')}00`;
/** ISO date + n days, as YYYYMMDD; noon anchoring keeps the arithmetic away from DST. */
function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The standing record as a subscribable calendar: each weekly block is a repeating
 * transparent event anchored on the editor's template week (so BYDAY and DTSTART agree),
 * each away entry a busy event, all-day or timed. TZID names the record's IANA zone
 * without a VTIMEZONE block — Apple and Google resolve IANA names; revisit if a client
 * refuses the feed.
 *
 * `rec` must have been through `sanitizeForeignRecord` and its timezone through
 * `isKnownZone` — a wall clock this app cannot read has no calendar to become.
 */
export function buildAvailabilityIcs(
  rec: AvailabilityInput & { updatedAt: string },
  opts: { uidHost: string; name: string; now: Date },
): string {
  const stamp = toBasic(opts.now.toISOString());
  const tz = rec.timezone;
  const until = rec.validUntil ? `;UNTIL=${toBasic(rec.validUntil)}` : '';
  const L: string[] = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//letsmeet//availability//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${opts.name} · availability`)}`,
    `X-WR-TIMEZONE:${esc(tz)}`,
  ];
  for (const b of rec.weekly) {
    const date = plusDays(TEMPLATE_SUNDAY, b.day);
    // A past-midnight block ends on the next calendar day.
    const endDate = b.end <= b.start ? plusDays(TEMPLATE_SUNDAY, b.day + 1) : date;
    L.push(
      'BEGIN:VEVENT',
      `UID:weekly-${BYDAY[b.day]}-${b.start.replace(':', '')}@${opts.uidHost}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${tz}:${date}T${hm(b.start)}`,
      `DTEND;TZID=${tz}:${endDate}T${hm(b.end)}`,
      `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[b.day]}${until}`,
      'SUMMARY:usually free', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    );
  }
  for (const a of rec.away) {
    const summary = `SUMMARY:${esc(a.note ? `away · ${a.note}` : 'away')}`;
    // A record can arrive from another client that only validated against the lexicon,
    // which allows startTime or endTime alone — treat a lone one as all-day, same as the
    // DTSTART/DTEND branch below, rather than asserting the pairing normalizeAvailability
    // enforces on our own writes.
    const window = a.startTime && a.endTime ? { start: a.startTime, end: a.endTime } : undefined;
    L.push('BEGIN:VEVENT',
      `UID:away-${ymd(a.start)}-${ymd(a.end)}-${window ? `${window.start.replace(':', '')}-${window.end.replace(':', '')}` : 'allday'}@${opts.uidHost}`,
      `DTSTAMP:${stamp}`);
    if (window) {
      L.push(`DTSTART;TZID=${tz}:${ymd(a.start)}T${hm(window.start)}`,
        `DTEND;TZID=${tz}:${ymd(a.start)}T${hm(window.end)}`);
      if (a.end !== a.start) {
        // RFC 5545 §3.3.10: UNTIL must be UTC when DTSTART carries a TZID, and it bounds
        // the series by the last occurrence's *start*. A local `T235959` is neither, and a
        // strict client drops the final day of an evening window (22:00 PDT is already
        // tomorrow in UTC).
        const last = localWindow(a.end, window.start, window.end, tz).start.toUTC();
        L.push(`RRULE:FREQ=DAILY;UNTIL=${toBasic(last.toISO()!)}`);
      }
    } else {
      L.push(`DTSTART;VALUE=DATE:${ymd(a.start)}`, `DTEND;VALUE=DATE:${plusDays(a.end, 1)}`);
    }
    L.push(summary, 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(foldLine).join('\r\n') + '\r\n';
}
