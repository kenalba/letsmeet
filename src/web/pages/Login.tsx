import { Layout, pageTitle } from './Layout.js';

/** The typeahead island — see src/web/islands/login.ts. Without it the form still works. */
export const LOGIN_SCRIPTS = ['/assets/login.js'];
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
    <Layout title={pageTitle('sign in')} scripts={LOGIN_SCRIPTS}>
      <div className="mx-auto grid max-w-md gap-6">
        <h1 className="pixel-heading">sign in</h1>
        <Card>
          <CardHeader>
            <CardTitle>your atproto account</CardTitle>
            <CardDescription>
              polls write to your pds, guests either sign in via atproto or stay anonymous, i don't
              know, i'm not a cop.
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
                <Label htmlFor="handle">your handle</Label>
                <Input
                  id="handle"
                  name="handle"
                  placeholder="you.bsky.social"
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  required
                />
              </div>
              <div>
                <Button type="submit">sign in</Button>
              </div>
            </form>
            <p className="text-sm text-muted-foreground">
              don't have an atproto account?{' '}
              <a
                href="https://bsky.app/"
                className="text-primary underline underline-offset-4"
                rel="noopener"
              >
                make one on bluesky
              </a>
              , or{' '}
              <a
                href="https://selfhosted.social/"
                className="text-primary underline underline-offset-4"
                rel="noopener"
              >
                host your own at selfhosted.social
              </a>
              . any account works here. you sign in with its handle.
            </p>
            <p className="text-sm text-muted-foreground">
              on the next screen, letsmeet asks only to write its own poll and response
              records in your account, plus a calendar event when a time is picked. no
              posting, no reading your stuff, nothing towards other services.
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
    <Layout title={pageTitle('sign-in failed')}>
      <div className="mx-auto grid max-w-md gap-4">
        <h1 className="pixel-heading">sign-in failed</h1>
        <p className="text-muted-foreground">
          sign-in failed or got cancelled.{' '}
          <a href="/login" className="text-primary underline underline-offset-4">
            try again
          </a>
        </p>
      </div>
    </Layout>
  );
}
