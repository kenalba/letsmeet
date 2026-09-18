import { Layout, SITE, pageTitle } from './Layout.js';
import { useNonce } from '../nonce.js';
import { Badge } from '../ui/badge.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Card, CardContent } from '../ui/card.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';

const STEPS = [
  "sign in with your atproto handle. the poll is a record in your own repo, so it's yours, not ours.",
  "pick the days and times you're willing to be a person.",
  "share a link with your friends. they say when they can make it (they don't have to log in, don't worry). you get the results. easy.",
];

/** What the landing needs to list a poll — a projection of the cache row, not the row. */
export interface PollListItem {
  rkey: string;
  title: string;
  status: string;
  /** The poll's calendar dates (YYYY-MM-DD), for the range in the meta line. */
  dates: string[];
  responses: number;
  /** The decided time, already formatted in the poll's zone; stands in for the dates. */
  chosen?: string;
}

/**
 * "Sep 14 – Sep 30" from the poll's calendar dates. Locale pinned: this renders on the
 * server, and the meta line shouldn't change shape with the box's locale env. Noon-UTC
 * anchoring for the same reason as the grid's fmtDow: a bare date parsed as UTC must not
 * drift a day when formatted.
 */
function fmtDateRange(dates: string[]): string {
  if (dates.length === 0) return '';
  const sorted = [...dates].sort();
  const fmt = (iso: string) => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
  const first = fmt(sorted[0]);
  const last = fmt(sorted[sorted.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

function pollMeta(p: PollListItem): string {
  const responses = `${p.responses} ${p.responses === 1 ? 'response' : 'responses'}`;
  // Once decided, when it is happening matters more than which days were on the table.
  if (p.chosen) return `${p.chosen} · ${responses}`;
  return [
    fmtDateRange(p.dates),
    `${p.dates.length} ${p.dates.length === 1 ? 'day' : 'days'}`,
    responses,
  ].filter(Boolean).join(' · ');
}

export function PollList({ polls }: { polls: PollListItem[] }) {
  return (
    <ul className="polls divide-y">
      {polls.map((p) => (
        // The row is a flex line, not one big <a>: the copy button can't nest inside an
        // anchor, so the anchor takes the growing left half (title + meta) and the
        // badge/button sit beside it.
        <li key={p.rkey} className="flex items-center gap-3 py-2.5">
          <a href={`/p/${p.rkey}`} className="min-w-0 flex-1 no-underline">
            <span className="block truncate text-sm font-medium hover:text-primary">
              {p.title}
            </span>
            <span className="pixel-label block text-muted-foreground">{pollMeta(p)}</span>
          </a>
          <Badge variant={p.status === 'active' ? 'secondary' : 'outline'}>
            {p.status}
          </Badge>
          <button
            type="button"
            data-copy-path={`/p/${p.rkey}`}
            hidden
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            copy link
          </button>
        </li>
      ))}
    </ul>
  );
}

export function LandingPage({ did, handle, polls = [], answered = [], archived = 0, availability }: {
  did: string | null;
  /** The handle stored at sign-in; a session from before that existed falls back to did. */
  handle?: string;
  polls?: PollListItem[];
  /** Polls the viewer answered from their own account and does not host. */
  answered?: PollListItem[];
  /** Over polls, hosted or answered, waiting on /archive; 0 hides the link. */
  archived?: number;
  /** The viewer's standing availability: a sentence, or `null` for no record. Absent when signed out. */
  availability?: {
    sentence: string; stale: boolean;
    /**
     * `ken.sez.letsmeet.lol` and the link to it: the one public link. The apex `/u/<handle>`
     * form is the same page, so it is not repeated here.
     */
    address?: { host: string; href: string };
  } | null;
}) {
  if (!did) {
    return (
      <Layout title={`${SITE} · does tuesday work?`} signInHref="/login">
        <div className="grid gap-10">
          <section className="grid gap-4">
            <h1 className="pixel-display text-balance">
              let's meet, <span className="text-lol">lol.</span>
              <span className="cursor" aria-hidden="true" />
            </h1>
            <p className="max-w-prose text-lg text-muted-foreground">
              pick your times. share the link. see who's free when. choose what works.
            </p>
            <div>
              <Button asChild>
                <a href="/login">sign in to make a poll</a>
              </Button>
            </div>
          </section>
          <section className="grid gap-4">
            <div className="rule pixel-label text-muted-foreground">=== how it works ===</div>
            <ol className="grid gap-3">
              {STEPS.map((step, i) => (
                <li key={step} className="grid grid-cols-[33px_1fr] gap-2">
                  <span className="pixel-heading leading-6 text-lol">{i + 1}</span>
                  <span className="max-w-prose text-muted-foreground">{step}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title={pageTitle('your polls')}>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="pixel-heading">your polls</h1>
            <p className="text-sm text-muted-foreground">
              signed in as{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {handle ?? did}
              </code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild size="sm">
              <a href="/new">new poll</a>
            </Button>
            <form method="post" action="/logout">
              <Button type="submit" variant="outline" size="sm">
                sign out
              </Button>
            </form>
          </div>
        </div>
        <Card>
          <CardContent>
            {polls.length === 0 ? (
              <p className="hint text-sm text-muted-foreground">
                no events planned yet. nobody needs anything from you, thank goodness.{' '}
                <a href="/new" className="text-primary underline underline-offset-4">make some obligations!</a>
              </p>
            ) : (
              <PollList polls={polls} />
            )}
            {/* Subtle on purpose: a muted label, not a button. Absent until there is something in it. */}
            {archived > 0 && (
              <p className="pixel-label mt-3 text-muted-foreground">
                <a href="/archive" className="hover:text-primary">{`archive · ${archived}`}</a>
              </p>
            )}
          </CardContent>
        </Card>
        <div className="availability grid gap-3">
          <h2 className="pixel-heading">your availability</h2>
          <Card>
            <CardContent className="flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-sm">
                {availability ? availability.sentence : 'nothing marked yet.'}
                {availability?.stale && <span className="text-muted-foreground"> (out of date)</span>}
              </p>
              <p className="text-sm">
                <a href="/availability" className="text-primary underline underline-offset-4">
                  {availability ? 'update' : 'mark your week'}
                </a>
                {availability?.address && (
                  <>{' '}· <a href={availability.address.href} className="text-primary underline underline-offset-4">{availability.address.host}</a></>
                )}
              </p>
            </CardContent>
          </Card>
        </div>
        {/* Only when there is something to list: an empty "you answered nothing" is noise. */}
        {answered.length > 0 ? (
          <div className="answered grid gap-3">
            <h2 className="pixel-heading">polls you answered</h2>
            <Card>
              <CardContent>
                <PollList polls={answered} />
              </CardContent>
            </Card>
          </div>
        ) : null}
        <script nonce={useNonce()} dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
      </div>
    </Layout>
  );
}
