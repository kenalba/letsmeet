import type { AvailabilityRecord } from '../../atproto/records.js';
import { describeWeekly, freeIntervals, isKnownZone, isStale, localDateOf } from '../../core/availability.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Layout, pageTitle } from './Layout.js';

export interface PublicAvailabilityData {
  handle: string;
  record: AvailabilityRecord | null;
  now: Date;
  publicUrl: string;
}

const fmtDate = (d: string) => new Date(d + 'T12:00:00Z')
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtClock = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
};
const daysAgo = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

/**
 * Fourteen days from today in the record's zone, each with the fraction of the 7am–midnight
 * day the record calls free, and whether an away entry covers it. Rendered as a row of bars.
 */
function strip(rec: AvailabilityRecord, now: Date) {
  const todayIso = now.toLocaleDateString('en-CA', { timeZone: rec.timezone }); // YYYY-MM-DD
  const days: Array<{ date: string; dow: string; free: number; away: boolean }> = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(`${todayIso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const ivs = freeIntervals(rec, date, date);
    const minutes = ivs.reduce((n, iv) => n + (new Date(iv.end).getTime() - new Date(iv.start).getTime()) / 60_000, 0);
    days.push({
      date, dow: d.toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' }),
      free: Math.min(1, minutes / (17 * 60)),
      // Half a window is not a window: freeIntervals cuts the whole day for a lone
      // startTime or endTime, so the strip has to mark the whole day too.
      away: rec.away.some((a) => (!a.startTime || !a.endTime) && a.start <= date && date <= a.end),
    });
  }
  return days;
}

export function PublicAvailabilityPage(data: PublicAvailabilityData) {
  const path = `/u/${data.handle}`;
  const base = data.publicUrl.replace(/\/$/, '');
  const rec = data.record;
  // Every clock in the record is read in its timezone; one this app cannot use makes the
  // whole record unreadable (the sentence would be the only honest part, and the strip
  // below would throw). Say so rather than guess a zone or claim they posted nothing.
  const unreadable = !!rec && !isKnownZone(rec.timezone);
  const stale = rec ? isStale(rec, data.now) : false;
  const upcoming = rec ? rec.away.filter((a) => a.end >= data.now.toISOString().slice(0, 10)) : [];
  return (
    <Layout
      title={pageTitle(`${data.handle} · availability`)}
      description={!rec || unreadable ? 'no availability posted.' : describeWeekly(rec.weekly)}
      canonical={`${base}${path}`}
    >
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="pixel-heading">{data.handle}</h1>
          {rec && !unreadable && <p className="text-sm text-muted-foreground">times in {rec.timezone}</p>}
        </div>
        {!rec ? (
          <Card><CardContent><p className="hint text-sm text-muted-foreground">no availability posted. ask them.</p></CardContent></Card>
        ) : unreadable ? (
          <Card><CardContent><p className="hint text-sm text-muted-foreground">
            couldn't read this one — it is posted in a timezone this app doesn't know. ask them.
          </p></CardContent></Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{stale ? 'this might be out of date' : describeWeekly(rec.weekly)}</CardTitle>
              <CardDescription>
                {stale
                  ? `expired ${fmtDate(localDateOf(rec.validUntil!, rec.timezone))}. treat as unknown and ask.`
                  : `updated ${daysAgo(rec.updatedAt, data.now) === 0 ? 'today' : `${daysAgo(rec.updatedAt, data.now)} days ago`}`
                    + (rec.validUntil ? ` · good through ${fmtDate(localDateOf(rec.validUntil, rec.timezone))}` : '')}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {stale && <p className="text-sm text-muted-foreground">last they said: {describeWeekly(rec.weekly)}</p>}
              {upcoming.length > 0 && (
                <div className="grid gap-1">
                  <p className="pixel-label text-muted-foreground">away</p>
                  <ul className="grid gap-1 text-sm">
                    {upcoming.map((a, i) => (
                      <li key={i} className="tabular-nums">
                        <strong>{a.start === a.end ? fmtDate(a.start) : `${fmtDate(a.start)} – ${fmtDate(a.end)}`}</strong>
                        {a.startTime && a.endTime && ` ${fmtClock(a.startTime)}–${fmtClock(a.endTime)}`}
                        {a.note && <span className="text-muted-foreground"> · {a.note}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rec.note && <p className="text-sm">{rec.note}</p>}
              {!stale && (
                <div className="grid gap-1">
                  <p className="pixel-label text-muted-foreground">next two weeks</p>
                  <div className="strip grid grid-cols-14 gap-1" style={{ gridTemplateColumns: 'repeat(14, minmax(0, 1fr))' }}>
                    {strip(rec, data.now).map((d) => (
                      <div key={d.date} className="grid gap-1 text-center text-[10px] text-muted-foreground" title={`${fmtDate(d.date)}${d.away ? ' · away' : ''}`}>
                        <div className="relative h-7 overflow-hidden rounded border border-border bg-muted">
                          {d.away
                            ? <div className="absolute inset-0 bg-destructive/30" />
                            : <div className="absolute inset-x-0 bottom-0 bg-primary" style={{ height: `${Math.round(d.free * 100)}%` }} />}
                        </div>
                        <span>{d.dow}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <p className="hint text-sm text-muted-foreground">
                <a href={`${path}/availability.ics`} className="text-primary underline underline-offset-4">download .ics</a>
                {' '}·{' '}
                <a href={`webcal://${base.replace(/^https?:\/\//, '')}${path}/availability.ics`} className="text-primary underline underline-offset-4">subscribe (webcal)</a>
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
