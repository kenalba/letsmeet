import type { Interval } from '../../core/intervals.js';
import type { SpecificDates } from '../../core/slots.js';
import type { PollResults } from '../../services/results.js';
import { scriptJson } from '../scriptJson.js';
import { fmtRange } from '../lib/fmtRange.js';
import { buttonVariants } from '../ui/button.js';
import { Card, CardHeader, CardContent } from '../ui/card.js';
import { Layout } from './Layout.js';

export interface PollPageData {
  rkey: string;
  title: string;
  description?: string;
  status: string;
  time: SpecificDates;
  slots: Interval[];
  results: PollResults;
  viewerDid: string | null;
  isHost: boolean;
  prefill?: { available: Interval[]; ifNeedBe: Interval[]; name?: string };
  editToken?: string;
  /** Guest responses still queued for the host's PDS; drives the "still syncing" banner. */
  pendingCount?: number;
}

/**
 * The grid island's bundle. It reads `#poll-data` and mounts into `#grid-root`, both of
 * which this page renders inside <main> — Layout appends scripts after <main>, so the
 * mount point and the JSON are in the DOM by the time the module runs.
 */
const GRID_SCRIPTS = ['/assets/grid.js'];

export function PollPage(data: PollPageData) {
  const zone = data.time.timezone;
  const { responses, ranked } = data.results;
  const counts: Record<string, { available: string[]; ifNeedBe: string[] }> = {};
  for (const r of ranked) counts[r.slot.start] = { available: r.available, ifNeedBe: r.ifNeedBe };

  const isActive = data.status === 'active';

  const gridData = {
    rkey: data.rkey,
    time: data.time,
    slots: data.slots,
    prefill: data.prefill,
    editToken: data.editToken,
    viewerDid: data.viewerDid,
    timezone: zone,
    counts,
    // A closed/cancelled poll still shows the grid — heatmap, tallies and any paint the
    // viewer already filed — but painting it is pointless: `submitGuestResponse` refuses
    // anything that is not active.
    readonly: !isActive,
  };
  const showRanked = responses.length > 0 || data.isHost;
  const pending = data.isHost ? data.pendingCount ?? 0 : 0;

  return (
    <Layout title={`${data.title} — letsmeet`} scripts={GRID_SCRIPTS}>
      <div className="flex flex-col gap-6">
        {pending > 0 ? (
          <p className="banner rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            {`${pending} responses are still syncing to your account. If this persists for more than a day, sign in again to reconnect.`}
          </p>
        ) : null}

        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{data.title}</h1>
          {data.description ? (
            <p className="description text-muted-foreground">{data.description}</p>
          ) : null}
          <p className="hint text-sm text-muted-foreground">
            {`Grid times are shown in your timezone; listed times are in the poll's timezone (${zone}).`}
          </p>
          {isActive ? null : (
            <p className="hint text-sm text-muted-foreground">
              {`This poll is ${data.status} — responses are closed.`}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <p className="name-note text-sm text-muted-foreground">
            Guests are asked for a name when they save.{' '}
            <small>Shown publicly on this poll</small>.
          </p>
          <div id="grid-root" />
          <script
            id="poll-data"
            type="application/json"
            dangerouslySetInnerHTML={{ __html: scriptJson(gridData) }}
          />
        </div>

        <Card className="results">
          <CardHeader>
            <h2 className="text-lg font-semibold tracking-tight">Results</h2>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {responses.length === 0 ? (
              <p className="hint text-sm text-muted-foreground">No responses yet — share this page.</p>
            ) : null}
            {showRanked ? (
              <ol className="ranked list-decimal space-y-2 pl-5 text-sm">
                {ranked.slice(0, 5).map((r) => (
                  <li key={r.slot.start}>
                    <span className="slot font-medium tabular-nums">{fmtRange(r.slot, zone)}</span>
                    {` — ${r.available.length} available + ${r.ifNeedBe.length} if needed`}
                    {r.missing.length ? `, missing: ${r.missing.join(', ')}` : null}
                    {data.isHost && isActive ? (
                      <form method="post" action={`/p/${data.rkey}/finalize`} className="ml-2 inline">
                        <input type="hidden" name="start" value={r.slot.start} />
                        <input type="hidden" name="end" value={r.slot.end} />
                        <button type="submit" className={buttonVariants({ size: 'sm' })}>
                          Pick this time
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
            {responses.length > 0 ? (
              <>
                <h3 className="text-sm font-semibold tracking-tight">Responses</h3>
                <ul className="responders text-sm">
                  {responses.map((r, i) => (
                    <li
                      key={`${r.who}-${i}`}
                      className={r.pending ? 'py-0.5 pending opacity-60' : 'py-0.5'}
                    >
                      {r.pending ? `${r.who} (syncing)` : r.who}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
