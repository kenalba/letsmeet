import { Layout } from './Layout.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';

/**
 * `error` carries the POST handler's own sanitized string, unchanged — the handler decides
 * what a visitor may be told (and what status it ships with); this page only frames it.
 */
export function LoginPage({ error, returnTo }: { error?: string; returnTo?: string }) {
  return (
    <Layout title="Sign in — letsmeet">
      <div className="mx-auto grid max-w-md gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <Card>
          <CardHeader>
            <CardTitle>Your atproto account</CardTitle>
            <CardDescription>
              Polls you create are written to your own repo. Answering one needs no account.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
            <form method="post" action="/login" className="grid gap-4">
              {/* Already validated by the route; rides the form so the POST (and the OAuth
                  state after it) can put the visitor back where they came from. */}
              {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
              <div className="grid gap-2">
                <Label htmlFor="handle">Your handle</Label>
                <Input
                  id="handle"
                  name="handle"
                  placeholder="you.bsky.social"
                  autoComplete="username"
                  required
                />
              </div>
              <div>
                <Button type="submit">Sign in</Button>
              </div>
            </form>
            <p className="text-sm text-muted-foreground">
              Don't have an atproto account?{' '}
              <a
                href="https://bsky.app/"
                className="text-primary underline underline-offset-4"
                rel="noopener"
              >
                Create one on Bluesky
              </a>
              , or{' '}
              <a
                href="https://selfhosted.social/"
                className="text-primary underline underline-offset-4"
                rel="noopener"
              >
                host your own at selfhosted.social
              </a>
              . Any account works here — you sign in with its handle.
            </p>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

/** The OAuth callback's failure page: same copy and same "Try again" link as before. */
export function SignInFailedPage() {
  return (
    <Layout title="Sign-in failed — letsmeet">
      <div className="mx-auto grid max-w-md gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Sign-in failed</h1>
        <p className="text-muted-foreground">
          Sign-in failed or was cancelled.{' '}
          <a href="/login" className="text-primary underline underline-offset-4">
            Try again
          </a>
        </p>
      </div>
    </Layout>
  );
}
