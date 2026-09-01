import type { ScheduleRecord } from '../../atproto/records.js';
import { fmtRange } from '../lib/fmtRange.js';
import { Layout, pageTitle } from './Layout.js';
import { Card, CardContent, CardDescription, CardHeader } from '../ui/card.js';

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
    <Layout
      title={pageTitle(record.title)}
      description={record.description ?? 'Decided — the time that works is set.'}
      canonical={`${base}/p/${rkey}`}
    >
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{record.title}</h1>
          {record.description ? (
            <p className="description text-muted-foreground">{record.description}</p>
          ) : null}
        </div>
        <Card>
          <CardHeader>
            <h2 className="leading-none font-semibold">Decided</h2>
            <CardDescription>The host picked a time.</CardDescription>
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
