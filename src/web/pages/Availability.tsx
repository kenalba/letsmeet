import type { AvailabilityRecord } from '../../atproto/records.js';
import { localDateOf } from '../../core/availability.js';
import { cn } from '../lib/cn.js';
import { buttonVariants } from '../ui/button.js';
import { useNonce } from '../nonce.js';
import { scriptJson } from '../scriptJson.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
import { Card, CardContent } from '../ui/card.js';
import { Layout, pageTitle } from './Layout.js';

/**
 * The editor island's bundle. It reads `#availability-data` and mounts into
 * `#availability-root`, both rendered inside <main> — Layout appends scripts after <main>,
 * so the mount point and the JSON are in the DOM by the time the module runs.
 */
export const AVAILABILITY_SCRIPTS = ['/assets/availability.js'];

export interface AvailabilityPageData {
  handle?: string;
  record: AvailabilityRecord | null;
  /** The live read failed: the editor opens empty and says a save will overwrite. */
  readFailed: boolean;
  publicUrl: string;
  /** The address field's state: what to prefill, what is saved, and where names live. */
  sez: {
    alias: string;
    aliasSaved: string;
    suffix: string;
    addressFallback: string | null;
    /** The record's alias is someone else's claim now; the banner names it. */
    lost: string | null;
  };
}

/** What the island mounts with. The record (or an empty one) plus who the viewer is. */
export function AvailabilityPage(data: AvailabilityPageData) {
  const rec = data.record;
  const islandData = {
    timezone: rec?.timezone ?? null,
    weekly: rec?.weekly ?? [],
    away: rec?.away ?? [],
    note: rec?.note ?? '',
    // The island's <input type="date"> speaks calendar dates; the record stamps an instant,
    // which is the end of that date where the record's own zone is.
    validUntil: rec?.validUntil ? localDateOf(rec.validUntil, rec.timezone) : '',
    alias: data.sez.alias,
    aliasSaved: data.sez.aliasSaved,
    sezSuffix: data.sez.suffix,
    addressFallback: data.sez.addressFallback,
  };
  const base = data.publicUrl.replace(/\/$/, '');
  const publicPath = data.handle ? `/u/${data.handle}` : null;
  const webcal = publicPath
    ? `webcal://${base.replace(/^https?:\/\//, '')}${publicPath}/availability.ics`
    : null;
  return (
    <Layout title={pageTitle('your availability')} scripts={AVAILABILITY_SCRIPTS}>
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="pixel-heading">your availability</h1>
        </div>
        {data.readFailed && (
          <p className="banner rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            couldn't read your current availability from your pds. saving will overwrite whatever is there.
          </p>
        )}
        {data.sez.lost && (
          <p className="banner rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            {/* A single template literal, not adjacent {} expressions: React's renderToString
                inserts <!-- --> markers between adjacent text children, which would split
                this sentence and break a plain-text match on the rendered HTML. */}
            {`your address ${data.sez.lost}.${data.sez.suffix} is someone else's now. pick another below and save.`}
          </p>
        )}
        {/* The island owns this card: the pager at the top says which page the grid is on,
            and the hint under it changes with the page. `bleed` lets it reach the screen
            edges at phone width (app.css). */}
        <Card className="bleed">
          <CardContent>
            <script
              id="availability-data"
              type="application/json"
              nonce={useNonce()}
              dangerouslySetInnerHTML={{ __html: scriptJson(islandData) }}
            />
            <div id="availability-root" />
          </CardContent>
        </Card>
        {publicPath && (
          <div className="grid gap-2">
            <p className="hint text-sm text-muted-foreground">
              friends can see this at{' '}
              <a href={publicPath} className="text-primary underline underline-offset-4">
                {base.replace(/^https?:\/\//, '')}{publicPath}
              </a>
            </p>
            <div className="feed-actions">
              <a
                href={`${base}${publicPath}/availability.ics`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >download .ics</a>
              <a
                href={webcal!}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                title="subscribe in your calendar (webcal)"
              >subscribe</a>
              <button
                type="button"
                data-copy-url={`${base}${publicPath}/availability.ics`}
                hidden
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >copy link</button>
            </div>
          </div>
        )}
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
      </div>
    </Layout>
  );
}
