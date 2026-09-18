import type { AvailabilityRecord } from '../../atproto/records.js';
import { describeWeekly, isKnownZone, isStale, localDateOf } from '../../core/availability.js';
import {
  buildWeekView, dateRangeLabel, hourLabel, labelZones, localToday, monthDayLabel, HOURS,
  type NoteZone, type WeekCell, type WeekChoice, type WeekDay, type WeekView,
} from '../../core/weekView.js';
import { cn } from '../lib/cn.js';
import { buttonVariants } from '../ui/button.js';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { useNonce } from '../nonce.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
import { ZONE_LABEL_SCRIPT } from './zoneLabels.js';
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
  /** The viewer is this person: offer the way back to the editor. */
  own?: boolean;
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

/**
 * Days across, hours down. Server-rendered, no script but the label classifier. Each hour is
 * a `.week-row` (`display: contents`, so the cells still sit in the grid) and every head and
 * cell carries its column index in `data-c`: that is all the hover rules in app.css need to
 * light the hovered cell's hour label and day header. A free hour still ahead is a link to
 * Bluesky's compose intent with a public post at the person already written — the one
 * hand-off Bluesky offers without a chat scope (there is no DM intent). Everything else is
 * an inert div.
 *
 * Every cell, head and label is placed explicitly (`grid-row`/`grid-column`): a note label
 * spans its away block, and an auto-placed grid would push the cells underneath it along.
 */
/**
 * Where a thing goes in `.week`. Row 1 is the day headers and the hours follow in order;
 * column 1 is the time axis and the seven days follow. One definition each, so a cell and
 * the label laid over it can never disagree about which line they are on. Both are the
 * grid's *start* line: a span ends at the next one (`rowOf(h1) + 1`).
 */
const rowOf = (h: number) => h - HOURS[0] + 2;
const colOf = (ci: number) => ci + 2;
/**
 * The day headers and the corner span every row, not just row 1. A grid item's containing
 * block is its own grid area, and a `position: sticky` box can only move inside that block:
 * an item that fits row 1 exactly has nowhere to stick to. Spanning the whole grid gives the
 * head the run of its column, `align-self: start` keeps it at the top of it, and `.week`'s
 * first row track carries the height the header would otherwise have set (see app.css).
 */
const HEAD_SPAN = `1/${rowOf(HOURS[HOURS.length - 1]) + 1}`;

function WeekGrid({ view, zones, handle }: { view: WeekView; zones: NoteZone[]; handle: string }) {
  return (
    <div className="week" aria-label={`usual week, ${view.title}`} role="group">
      <div className="week-corner" style={{ gridRow: HEAD_SPAN, gridColumn: 1 }} />
      {view.days.map((d, ci) => (
        <div
          key={d.date}
          className={cn('week-head', d.past && 'past', d.today && 'today')}
          data-c={ci}
          style={{ gridRow: HEAD_SPAN, gridColumn: colOf(ci) }}
          title={d.awayAllDay !== null ? (d.awayAllDay || 'away') : undefined}
        >
          {/* The weekday rides in a span of its own so a past day can be dimmed by its
              contents: `opacity` on the head itself would make the sticky background
              translucent and let the cells scroll through it. */}
          <b>{d.dom}</b><span className="dow">{d.dow}</span>
        </div>
      ))}
      {HOURS.map((h, hi) => (
        <div key={h} className="week-row">
          <div className="week-axis" style={{ gridRow: rowOf(h), gridColumn: 1 }}>{hourLabel(h)}</div>
          {view.days.map((d, ci) => {
            const c = d.cells[hi];
            const title = `${d.dow} ${d.dom} ${hourLabel(h)}${c.note ? ` · ${c.note}` : ''}`;
            const place = { gridRow: rowOf(h), gridColumn: colOf(ci) };
            return isReachable(d, c) ? (
              <a
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state)}
                data-c={ci}
                style={place}
                href={composeUrl(`hey @${handle}, let's meet (lol). ${hourLabel(h)} on ${d.dow} ${monthDayLabel(d.date)} looks good to me?`)}
                target="_blank"
                rel="noopener"
                title={`${title} · click to post at them`}
              />
            ) : (
              <div
                key={`${d.date}-${h}`}
                className={cn('week-cell', c.state, d.past && 'past')}
                data-c={ci}
                style={place}
                title={title}
              />
            );
          })}
        </div>
      ))}
      {/* A note lives inside the away block it belongs to; anything under three rows arrived
          here already dropped. The orientation is a guess from the block's shape, for a page
          with no JavaScript; ZONE_LABEL_SCRIPT measures the real box and replaces it.
          `data-past` carries the dimming through that rewrite, and the grid placement has no
          spaces around its slash — React writes a style value through verbatim, and the page
          tests match the rendered attribute. */}
      {zones.map((z) => (
        <div
          key={`${z.note}-${z.c0}-${z.h0}`}
          className={cn('zlabel', z.c1 > z.c0 ? 'h' : 'v', z.past && 'past')}
          data-past={z.past ? '1' : ''}
          style={{
            gridRow: `${rowOf(z.h0)}/${rowOf(z.h1) + 1}`,
            gridColumn: `${colOf(z.c0)}/${colOf(z.c1) + 1}`,
          }}
        >{z.note}</div>
      ))}
    </div>
  );
}

/**
 * Bluesky's compose sheet with `text` filled in; the visitor still has to hit post. The
 * text names no URL on purpose: a bare domain gets a link card under the post. The
 * apostrophe is encoded by hand — encodeURIComponent leaves it, and React would then
 * HTML-escape it in the attribute; harmless, but the source reads cleaner without.
 */
const composeUrl = (text: string) =>
  `https://bsky.app/intent/compose?text=${encodeURIComponent(text).replace(/'/g, '%27')}`;

/** A free (or half-free) hour on a day that is not over: worth a message. */
const isReachable = (d: WeekDay, c: WeekCell) =>
  !d.past && (c.state === 'free' || c.state === 'early' || c.state === 'late');

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
  // `labelZones` drops the ones too short to carry a note and orders the rest biggest-first,
  // so an entry inside another paints on top of it. Resolved here rather than in the grid so
  // the classifier ships only when there is something for it to classify.
  const zones = rec && view ? labelZones(rec, view) : [];
  const reachable = !!view && view.days.some((d) => d.cells.some((c) => isReachable(d, c)));
  const awayLaterCaption = later.length > 0 ? (
    <p className="week-caption text-sm text-muted-foreground">
      {`away later: ${later.map((a) => `${dateRangeLabel(a.start, a.end)}${a.note ? ` · ${a.note}` : ''}`).join(', ')}`}
    </p>
  ) : null;
  const feedUrl = `${base}${path}/availability.ics`;
  // Absolute, like the webcal link beside it: this page also serves on `<name>.sez.<site>`,
  // where only `/` and `/availability.ics` answer — a relative `/u/<handle>/availability.ics`
  // would 404 there. The week links, by contrast, are query-only so they stay on either host.
  // The copy button hands over the plain https address: Google Calendar's "from URL" box
  // and a pasted chat message both want that, and neither can take a click on webcal://.
  const links = (
    <div className="feed-actions">
      <a href={feedUrl} className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>download .ics</a>
      <a
        href={`webcal://${base.replace(/^https?:\/\//, '')}${path}/availability.ics`}
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
        title="subscribe in your calendar (webcal)"
      >subscribe</a>
      <button
        type="button"
        data-copy-url={feedUrl}
        hidden
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
      >copy link</button>
    </div>
  );
  return (
    <Layout
      title={pageTitle(`${data.handle} · availability`)}
      description={!rec || unreadable ? 'no availability posted.' : describeWeekly(rec.weekly)}
      canonical={`${base}${path}`}
      homeHref={`${base}/`}
    >
      <div className="grid gap-6">
        <div className="fv-head">
          <div className="grid gap-1">
            <h1 className="pixel-heading">{data.handle}</h1>
            {/* `select-all`: one click selects the whole address, the thing worth copying. */}
            {data.sezAddress && <p className="pixel-label text-muted-foreground select-all">{data.sezAddress}</p>}
            {rec && !unreadable && <p className="text-sm text-muted-foreground">times in {rec.timezone}</p>}
          </div>
          {/* The owner's way back to the editor. Absolute: on the alias host `/availability`
              answers nothing. */}
          {data.own && (
            <a
              href={`${base}/availability`}
              className={cn(buttonVariants({ variant: 'default', size: 'sm' }), 'fv-edit')}
            >edit</a>
          )}
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
              <CardAction className="week-nav">
                <a href="?week=next">← last week</a>
                <span className="off" aria-disabled="true">next week →</span>
              </CardAction>
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
                  ? <span className="off" aria-disabled="true">← last week</span>
                  : <a href="?week=this">← last week</a>}
                <a href={week === 'this' ? '?week=next' : '?week=later'}>
                  next week →
                </a>
              </CardAction>
            </CardHeader>
            <CardContent className="grid gap-4">
              <WeekGrid view={view!} zones={zones} handle={data.handle} />
              {view!.hasAway && (
                <div className="week-legend">
                  <span><i className="free" />free</span>
                  <span><i className="away" />away</span>
                </div>
              )}
              {reachable && (
                <p className="week-caption text-sm text-muted-foreground">click a free hour to ping on bluesky.</p>
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
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
        {zones.length > 0 && (
          <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: ZONE_LABEL_SCRIPT }} />
        )}
      </div>
    </Layout>
  );
}
