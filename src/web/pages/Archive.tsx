import { Layout, pageTitle } from './Layout.js';
import { useNonce } from '../nonce.js';
import { Card, CardContent } from '../ui/card.js';
import { COPY_LINK_SCRIPT } from './copyLink.js';
import { PollList, type PollListItem } from './Landing.js';

/**
 * Polls that are over (core/archive.ts): the same rows as the landing, kept out of the way.
 * Reached from the muted `archive · N` under "your polls"; there is no other way in.
 */
export function ArchivePage({ handle, polls, answered }: {
  handle: string;
  polls: PollListItem[];
  /** Over polls the viewer answered and does not host. */
  answered: PollListItem[];
}) {
  return (
    <Layout title={pageTitle('archive')}>
      <div className="grid gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h1 className="pixel-heading">archive</h1>
            <p className="text-sm text-muted-foreground">
              signed in as{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{handle}</code>
            </p>
          </div>
          <p className="text-sm">
            <a href="/" className="text-primary underline underline-offset-4">← your polls</a>
          </p>
        </div>
        {/* An empty "your polls" card under a full "polls you answered" one reads as a fault:
            the archive plainly has something in it. So the empty state is only shown when the
            whole archive is empty, where it is the page's one and only answer. */}
        {polls.length > 0 || answered.length === 0 ? (
          <div className="grid gap-3">
            <h2 className="pixel-heading">your polls</h2>
            <Card>
              <CardContent>
                {polls.length === 0 ? (
                  <p className="hint text-sm text-muted-foreground">nothing here yet. polls land here once their day has passed.</p>
                ) : (
                  <PollList polls={polls} />
                )}
              </CardContent>
            </Card>
          </div>
        ) : null}
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
