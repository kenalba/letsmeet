import type { Interval } from '../../core/intervals.js';
import { useNonce } from '../nonce.js';
import type { SpecificDates } from '../../core/slots.js';
import type { PollResults } from '../../services/results.js';
import { scriptJson } from '../scriptJson.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
import { fmtRange } from '../lib/fmtRange.js';
import { buttonVariants } from '../ui/button.js';
import { cn } from '../lib/cn.js';
import { Card, CardHeader, CardContent } from '../ui/card.js';
import { Layout, pageTitle } from './Layout.js';

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
  /** The viewer's own name in `results`, when they have answered before. */
  self?: string;
  editToken?: string;
  /** The site origin, for the link-preview URL; absent in tests that don't care. */
  publicUrl?: string;
  /** Guest responses still queued for the host's PDS; drives the "still syncing" banner. */
  pendingCount?: number;
}

/**
 * The grid island's bundle. It reads `#poll-data` and mounts into `#grid-root`, both of
 * which this page renders inside <main> — Layout appends scripts after <main>, so the
 * mount point and the JSON are in the DOM by the time the module runs.
 */
const GRID_SCRIPTS = ['/assets/grid.js'];

/** "30-minute" / "1-hour" / "1.5-hour" — mirrors the create form's option labels. */
function fmtSlotLength(minutes: number): string {
  if (minutes % 60 !== 0) return minutes < 60 ? `${minutes}-minute` : `${minutes / 60}-hour`;
  return minutes === 60 ? '1-hour' : `${minutes / 60}-hour`;
}

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
    self: data.self,
    editToken: data.editToken,
    viewerDid: data.viewerDid,
    timezone: zone,
    counts,
    // A closed/cancelled poll still shows the grid — heatmap, tallies and any paint the
    // viewer already filed — but painting it is pointless: `submitGuestResponse` refuses
    // anything that is not active.
    readonly: !isActive,
  };
  const pending = data.isHost ? data.pendingCount ?? 0 : 0;

  const path = `/p/${data.rkey}`;
  const signInHref = data.viewerDid ? undefined : `/login?returnTo=${encodeURIComponent(path)}`;
  return (
    <Layout
      title={pageTitle(data.title)}
      description={data.description ?? `${fmtSlotLength(data.time.slotMinutes)} slots · ${
        data.results.responses.length === 1 ? '1 response' : `${data.results.responses.length} responses`
      } so far. mark the times you're free.`}
      canonical={data.publicUrl ? `${data.publicUrl}${path}` : undefined}
      scripts={GRID_SCRIPTS}
      signInHref={signInHref}
    >
      <div className="flex flex-col gap-6">
        {pending > 0 ? (
          <p className="banner rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            {`${pending} responses are still syncing to your account. if this keeps up for more than a day, sign in again to reconnect.`}
          </p>
        ) : null}

        <div className="flex flex-col gap-1">
          {/* Bottom-aligned: the buttons are taller than the title's line, and centred they
              hung below it. */}
          <div className="flex flex-wrap items-end gap-3">
            <h1 className="pixel-heading">{data.title}</h1>
            {/* Actions at the right edge, away from the title they act on. */}
            <div className="ml-auto flex items-end gap-3">
              <button
                type="button"
                data-copy-path={path}
                hidden
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                copy share link
              </button>
              {data.isHost && isActive ? (
                <a
                  href={`/p/${data.rkey}/edit`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  edit
                </a>
              ) : null}
            </div>
          </div>
          {data.description ? (
            <p className="description text-muted-foreground">{data.description}</p>
          ) : null}
          {isActive ? null : (
            <p className="hint text-sm text-muted-foreground">
              {`this poll is ${data.status}. responses are closed.`}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div id="grid-root" />
          <script
            id="poll-data"
            type="application/json"
            dangerouslySetInnerHTML={{ __html: scriptJson(gridData) }}
          />
        </div>

        {/* Who has answered, as bracketed chips: guests by the name they gave, accounts
            by handle with the `>` prompt, linking to their profile. Everyone sees this —
            the same names are already in every cell's hover title. `data-who` is the name
            the island tallies by: hovering (or tapping) a chip spotlights that answer. */}
        {responses.length > 0 ? (
          <p className="responders pixel-label flex flex-wrap items-baseline gap-x-3">
            <span className="text-muted-foreground">
              {responses.length === 1 ? '1 response:' : `${responses.length} responses:`}
            </span>
            {responses.map((r, i) => (
              <span
                key={`${r.who}-${i}`}
                data-who={r.who}
                className={cn('chip text-muted-foreground', r.pending && 'pending opacity-60')}
                title={r.pending ? 'still syncing to the host’s repo' : undefined}
              >
                [
                {r.source === 'account' ? (
                  <a
                    href={`https://bsky.app/profile/${r.who}`}
                    className="prompt text-foreground no-underline hover:text-primary"
                    rel="noopener"
                  >
                    {r.who}
                  </a>
                ) : (
                  <span className="text-foreground">{r.who}</span>
                )}
                {r.pending ? ' (syncing)' : null}
                ]
              </span>
            ))}
          </p>
        ) : null}
        {/* The island puts the reply block (who you are, the field, the button) here,
            below the chips, so the page reads grid → who answered → your reply → the pick. */}
        <div id="reply-root" />

        {/* Host-only: what the grid cannot carry is the host's side — picking the final
            slot, seeing who is *missing* from each top slot, and which guest responses
            are still syncing to their PDS. */}
        {data.isHost ? (
          <Card className="results">
            <CardHeader>
              <h2 className="pixel-heading">pick the winner</h2>
              {/* The grid may be showing the viewer's zone; this list is always the poll's. */}
              <p className="hint text-sm text-muted-foreground">{`times in ${zone}`}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {responses.length === 0 ? (
                <p className="hint text-sm text-muted-foreground">no responses yet. share this page around.</p>
              ) : null}
              {responses.length > 0 ? (
                <ol className="ranked list-decimal space-y-2 pl-5 text-sm">
                  {ranked.slice(0, 5).map((r) => (
                    <li key={r.slot.start}>
                      <span className="slot font-medium tabular-nums">{fmtRange(r.slot, zone)}</span>
                      {` · ${r.available.length} available + ${r.ifNeedBe.length} if need be`}
                      {r.missing.length ? `, missing: ${r.missing.join(', ')}` : null}
                      {isActive ? (
                        <form method="post" action={`/p/${data.rkey}/finalize`} className="ml-2 inline">
                          <input type="hidden" name="start" value={r.slot.start} />
                          <input type="hidden" name="end" value={r.slot.end} />
                          {/* Five of these in a row; the host is choosing, not being pushed, so grey. */}
                          <button type="submit" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                            pick this time
                          </button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
      </div>
    </Layout>
  );
}
