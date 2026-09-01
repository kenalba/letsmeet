import { Layout } from './Layout.js';
import { Badge } from '../ui/badge.js';
import { Button, buttonVariants } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';

const STEPS = [
  'Sign in with your atproto handle — the poll is a record in your own repo.',
  'Pick the dates and the daily window you want to meet in.',
  'Share the link. Guests paint their availability without an account; you pick the winner.',
];

/** What the landing needs to list a poll — a projection of the cache row, not the row. */
export interface PollListItem {
  rkey: string;
  title: string;
  status: string;
  /** The poll's calendar dates (YYYY-MM-DD), for the range in the meta line. */
  dates: string[];
  responses: number;
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
  return [
    fmtDateRange(p.dates),
    `${p.dates.length} ${p.dates.length === 1 ? 'day' : 'days'}`,
    `${p.responses} ${p.responses === 1 ? 'response' : 'responses'}`,
  ].filter(Boolean).join(' · ');
}

export function LandingPage({ did, handle, polls = [] }: {
  did: string | null;
  /** The handle stored at sign-in; a session from before that existed falls back to did. */
  handle?: string;
  polls?: PollListItem[];
}) {
  if (!did) {
    return (
      <Layout title="letsmeet" signInHref="/login">
        <div className="grid gap-10">
          <section className="grid gap-4">
            <h1 className="text-3xl font-semibold tracking-tight">Pick a time, together</h1>
            <p className="max-w-prose text-muted-foreground">
              Polls live in your own atproto repo. Guests can answer without an account.
            </p>
            <div>
              <Button asChild>
                <a href="/login">Sign in to create a poll</a>
              </Button>
            </div>
          </section>
          <Card>
            <CardHeader>
              <CardTitle>How it works</CardTitle>
              <CardDescription>Three steps, no accounts for your guests.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-3 text-sm">
                {STEPS.map((step, i) => (
                  <li key={step} className="flex gap-3">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                      {i + 1}
                    </span>
                    <span className="text-muted-foreground">{step}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="letsmeet">
      <div className="grid gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">Your polls</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {handle ?? did}
              </code>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild size="sm">
              <a href="/new">New poll</a>
            </Button>
            <form method="post" action="/logout">
              <Button type="submit" variant="outline" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </div>
        <Card>
          <CardContent>
            {polls.length === 0 ? (
              <p className="hint text-sm text-muted-foreground">
                No polls yet — <a href="/new" className="text-primary underline underline-offset-4">create your first</a>.
              </p>
            ) : (
              <ul className="polls divide-y">
                {polls.map((p) => (
                  // The row is a flex line, not one big <a>: the copy button can't nest
                  // inside an anchor, so the anchor takes the growing left half (title +
                  // meta) and the badge/button sit beside it.
                  <li key={p.rkey} className="flex items-center gap-3 py-2.5">
                    <a href={`/p/${p.rkey}`} className="min-w-0 flex-1 no-underline">
                      <span className="block truncate text-sm font-medium hover:text-primary">
                        {p.title}
                      </span>
                      <span className="block text-xs text-muted-foreground">{pollMeta(p)}</span>
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
                      Copy link
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <script dangerouslySetInnerHTML={{ __html: COPY_LINK_SCRIPT }} />
      </div>
    </Layout>
  );
}
