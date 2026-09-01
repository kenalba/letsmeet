const toBasic = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

export function buildIcs(input: {
  uid: string; title: string; start: string; end: string; url?: string; now: Date;
}): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//wzrdz-poll//EN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${toBasic(input.now.toISOString())}`,
    `DTSTART:${toBasic(input.start)}`,
    `DTEND:${toBasic(input.end)}`,
    `SUMMARY:${esc(input.title)}`,
    ...(input.url ? [`URL:${input.url}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
