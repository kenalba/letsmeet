import { DateTime } from 'luxon';
import type { Interval } from '../../core/intervals.js';
import type { ScheduleRecord } from '../../atproto/records.js';
import { Layout } from './Layout.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';

/** Same formatting the poll page uses; it moves into one place when views.ts goes away. */
function fmtRange(slot: Interval, zone: string): string {
  const s = DateTime.fromISO(slot.start, { zone });
  const e = DateTime.fromISO(slot.end, { zone });
  return `${s.toFormat('HH:mm')}–${e.toFormat('HH:mm')} ${s.toFormat('ccc LLL d')}`;
}

export function DecidedPage(
  { rkey, record, publicUrl }: { rkey: string; record: ScheduleRecord; publicUrl: string },
) {
  const zone = record.time.timezone;
  const slot = record.finalized;
  const base = publicUrl.replace(/\/$/, '');
  const icsPath = `/p/${rkey}/ics`;
  const webcal = `webcal://${base.replace(/^https?:\/\//, '')}${icsPath}`;
  const linkClass = 'text-primary underline underline-offset-4';

  return (
    <Layout title={`${record.title} — letsmeet`}>
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{record.title}</h1>
          {record.description ? (
            <p className="description text-muted-foreground">{record.description}</p>
          ) : null}
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Decided</CardTitle>
            <CardDescription>Everyone answered; the host picked a time.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="chosen text-xl font-medium tabular-nums">
              {slot ? fmtRange(slot, zone) : 'a time'} ({zone})
            </p>
            <p className="text-sm">
              <a href={icsPath} className={`ics ${linkClass}`}>
                Download .ics
              </a>{' '}
              ·{' '}
              <a href={webcal} className={`webcal ${linkClass}`}>
                Add to calendar (webcal)
              </a>
            </p>
          </CardContent>
        </Card>
        <p className="hint text-sm text-muted-foreground">
          Responses are closed. The event also lives in the host's atproto repo.
        </p>
      </div>
    </Layout>
  );
}
