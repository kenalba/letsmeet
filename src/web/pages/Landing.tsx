import { Layout } from './Layout.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

/**
 * The create form, still on the landing page for a signed-in host — that is where the e2e
 * flow fills it, and `form.create button[type=submit]` is a frozen DOM contract. Field
 * names are frozen too: `routes/polls.ts` parses them straight off the FormData.
 * Task 4 replaces the dates input with the calendar island and shares that form with /new.
 */
function CreateForm() {
  const selectClass =
    'border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm ' +
    'shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 ' +
    'focus-visible:ring-[3px] dark:bg-input/30';
  return (
    <form method="post" action="/polls" className="create grid gap-5">
      <div className="grid gap-2">
        <Label htmlFor="poll-title">Title</Label>
        <Input id="poll-title" name="title" required placeholder="Movie night" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="poll-description">Description</Label>
        <Input id="poll-description" name="description" placeholder="Optional" />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="poll-dates">Dates</Label>
        <Input id="poll-dates" name="dates" required placeholder="2026-09-02,2026-09-03" />
        <p className="text-xs text-muted-foreground">Comma-separated ISO dates.</p>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="poll-window-start">Window start</Label>
          <Input id="poll-window-start" name="windowStart" required placeholder="17:00" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="poll-window-end">Window end</Label>
          <Input id="poll-window-end" name="windowEnd" required placeholder="19:00" />
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="poll-slot-minutes">Slot length</Label>
          <select
            id="poll-slot-minutes"
            name="slotMinutes"
            defaultValue="30"
            className={selectClass}
          >
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">60 minutes</option>
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="poll-timezone">Timezone</Label>
          <Input
            id="poll-timezone"
            name="timezone"
            required
            defaultValue="UTC"
            placeholder="America/New_York"
          />
        </div>
      </div>
      <div>
        <Button type="submit">Create poll</Button>
      </div>
    </form>
  );
}

const STEPS = [
  'Sign in with your atproto handle — the poll is a record in your own repo.',
  'Pick the dates and the daily window you want to meet in.',
  'Share the link. Guests paint their availability without an account; you pick the winner.',
];

export function LandingPage({ did }: { did: string | null }) {
  if (!did) {
    return (
      <Layout title="letsmeet">
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
            <h1 className="text-2xl font-semibold tracking-tight">New poll</h1>
            <p className="text-sm text-muted-foreground">
              Signed in as{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {did}
              </code>
            </p>
          </div>
          <form method="post" action="/logout">
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Poll details</CardTitle>
            <CardDescription>
              Times are interpreted in the poll's timezone; guests see their own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateForm />
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
