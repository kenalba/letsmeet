import { Layout } from './Layout.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';

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
                  <li key={p.rkey}>
                    <a
                      href={`/p/${p.rkey}`}
                      className="flex items-center justify-between gap-3 py-2.5 no-underline hover:text-primary"
                    >
                      <span className="text-sm font-medium">{p.title}</span>
                      <Badge variant={p.status === 'active' ? 'secondary' : 'outline'}>
                        {p.status}
                      </Badge>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
