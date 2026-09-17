import { Fragment } from 'react';
import type { AvailabilityRecord } from '../../atproto/records.js';
import { describeWeekly, isKnownZone, isStale, localDateOf } from '../../core/availability.js';
import {
  buildWeekView, dateRangeLabel, hourLabel, localToday, HOURS, type WeekChoice, type WeekView,
} from '../../core/weekView.js';
import { cn } from '../lib/cn.js';
import { buttonVariants } from '../ui/button.js';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Layout, pageTitle } from './Layout.js';

export interface PublicAvailabilityData {
  handle: string;
  record: AvailabilityRecord | null;
  now: Date;
  publicUrl: string;
  /** Where this person's page is shared. */
  sezAddress?: string;
  /** Which week the grid shows; `later` is the poll prompt. From `?week=`. */
  week?: WeekChoice;
}

const fmtDate = (d: string) => new Date(d + 'T12:00:00Z')
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtClock = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
};
const daysAgo = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));

/** "· updated today · good through Dec 31", appended to the sentence caption. */
function freshness(rec: AvailabilityRecord, now: Date): string {
  const ago = daysAgo(rec.updatedAt, now);
  return ` · updated ${ago === 0 ? 'today' : `${ago} days ago`}`
    + (rec.validUntil ? ` · good through ${fmtDate(localDateOf(rec.validUntil, rec.timezone))}` : '');
}

/** Days across, hours down. Server-rendered; no script. */
function WeekGrid({ view }: { view: WeekView }) {
  return (
    <div className="week" aria-label={`usual week, ${view.title}`} role="img">
      <div className="week-corner" />
      {view.days.map((d) => (
        <div
          key={d.date}
          className={cn('week-head', d.past && 'past', d.today && 'today')}
          title={d.awayAllDay !== null ? (d.awayAllDay || 'away') : undefined}
        >
          <b>{d.dom}</b>{d.dow}
          {d.awayAllDay !== null && <small>{d.awayAllDay || 'away'}</small>}
        </div>
      ))}
      {HOURS.map((h, hi) => (
        <Fragment key={h}>
          <div key={`axis-${h}`} className="week-axis">{hourLabel(h)}</div>
          {view.days.map((d) => {
            const c = d.cells[hi];
            return (
              <div
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state, d.past && 'past')}
                title={`${d.dow} ${d.dom} ${hourLabel(h)}${c.note ? ` · ${c.note}` : ''}`}
              />
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

export function PublicAvailabilityPage(data: PublicAvailabilityData) {
  const path = `/u/${data.handle}`;
  const base = data.publicUrl.replace(/\/$/, '');
  const rec = data.record;
  const week = data.week ?? 'this';
  // Every clock in the record is read in its timezone; one this app cannot use makes the
  // whole record unreadable (the sentence would be the only honest part, and the grid
  // below would throw). Say so rather than guess a zone or claim they posted nothing.
  const unreadable = !!rec && !isKnownZone(rec.timezone);
  const stale = rec ? isStale(rec, data.now) : false;
  const upcoming = rec && !unreadable ? rec.away.filter((a) => a.end >= localToday(data.now, rec.timezone)) : [];
  const view = rec && !unreadable && !stale && week !== 'later'
    ? buildWeekView(rec, data.now, week === 'next' ? 1 : 0) : null;
  const later = rec && !unreadable && !stale
    ? buildWeekView(rec, data.now, 0).later : [];
  const awayLaterCaption = later.length > 0 ? (
    <p className="week-caption text-sm text-muted-foreground">
      {`away later: ${later.map((a) => `${dateRangeLabel(a.start, a.end)}${a.note ? ` · ${a.note}` : ''}`).join(', ')}`}
    </p>
  ) : null;
  // Absolute, like the webcal link beside it: this page also serves on `<name>.sez.<site>`,
  // where only `/` and `/availability.ics` answer — a relative `/u/<handle>/availability.ics`
  // would 404 there. The week links, by contrast, are query-only so they stay on either host.
  const links = (
    <p className="hint text-sm text-muted-foreground">
      <a href={`${base}${path}/availability.ics`} className="text-primary underline underline-offset-4">download .ics</a>
      {' '}·{' '}
      <a href={`webcal://${base.replace(/^https?:\/\//, '')}${path}/availability.ics`} className="text-primary underline underline-offset-4">subscribe (webcal)</a>
    </p>
  );
  return (
    <Layout
      title={pageTitle(`${data.handle} · availability`)}
      description={!rec || unreadable ? 'no availability posted.' : describeWeekly(rec.weekly)}
      canonical={`${base}${path}`}
      homeHref={`${base}/`}
    >
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="pixel-heading">{data.handle}</h1>
          {/* `select-all`: one click selects the whole address, the thing worth copying. */}
          {data.sezAddress && <p className="pixel-label text-muted-foreground select-all">{data.sezAddress}</p>}
          {rec && !unreadable && <p className="text-sm text-muted-foreground">times in {rec.timezone}</p>}
        </div>
        {!rec ? (
          <Card><CardContent><p className="hint text-sm text-muted-foreground">no availability posted. ask them.</p></CardContent></Card>
        ) : unreadable ? (
          <Card><CardContent><p className="hint text-sm text-muted-foreground">
            couldn't read this one — it is posted in a timezone this app doesn't know. ask them.
          </p></CardContent></Card>
        ) : stale ? (
          <Card>
            <CardHeader>
              <CardTitle>this might be out of date</CardTitle>
              <CardDescription>
                {`expired ${fmtDate(localDateOf(rec.validUntil!, rec.timezone))}. treat as unknown and ask.`}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <p className="text-sm text-muted-foreground">{`last they said: ${describeWeekly(rec.weekly)}`}</p>
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
              {links}
            </CardContent>
          </Card>
        ) : week === 'later' ? (
          <Card>
            <CardHeader>
              <CardTitle>further out</CardTitle>
              <CardAction className="week-nav"><a href="?week=next">← next week</a></CardAction>
            </CardHeader>
            <CardContent>
              <div className="week-prompt">
                <p>a usual week only says so much that far ahead.</p>
                <a href={`${base}/new`} className={cn(buttonVariants({ variant: 'default' }))}>
                  {`make a poll with ${data.handle}`}
                </a>
                <p className="text-sm text-muted-foreground">pick some dates, they mark what works.</p>
              </div>
              {awayLaterCaption}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{view!.title}</CardTitle>
              <CardAction className="week-nav">
                {week === 'this'
                  ? <span className="off">← this week</span>
                  : <a href="?week=this">← this week</a>}
                <a href={week === 'this' ? '?week=next' : '?week=later'}>
                  {week === 'this' ? 'next week →' : 'further out →'}
                </a>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4">
              <WeekGrid view={view!} />
              {view!.hasAway && (
                <div className="week-legend">
                  <span><i className="free" />free</span>
                  <span><i className="away" />away</span>
                </div>
              )}
              {/* One template literal per caption: React's renderToString puts <!-- -->
                  between adjacent text children, which would split a plain-text match. */}
              <p className="week-caption text-sm text-muted-foreground">{`${describeWeekly(rec.weekly)}${freshness(rec, data.now)}`}</p>
              {rec.note && <p className="week-caption text-sm text-muted-foreground">{rec.note}</p>}
              {awayLaterCaption}
              {links}
            </CardContent>
          </Card>
        )}
      </div>
    </Layout>
  );
}
