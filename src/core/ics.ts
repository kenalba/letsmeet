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
