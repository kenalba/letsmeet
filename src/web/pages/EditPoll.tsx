import { Layout, pageTitle } from './Layout.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { CreatePollForm, CREATE_FORM_SCRIPTS, type PollFormDefaults } from './CreatePollForm.js';

/**
 * GET /p/:rkey/edit — the host's own poll, in the same form that created it. Once anyone
 * has answered, the geometry is frozen (their paint is in terms of it) and the form says so
 * instead of letting the host find out on submit; the withdraw card is the only way to
 * change the days after that point — make a new poll.
 */
export function EditPollPage(
  { rkey, defaults, responses }: { rkey: string; defaults: PollFormDefaults; responses: number },
) {
  const frozen = responses > 0;
  const who = responses === 1 ? '1 person has' : `${responses} people have`;
  return (
    <Layout title={pageTitle('edit poll')} scripts={frozen ? undefined : CREATE_FORM_SCRIPTS}>
      <div className="grid gap-6">
        <div className="grid gap-1">
          <h1 className="pixel-heading">edit poll</h1>
          <p>
            <a
              href={`/p/${rkey}`}
              className="prompt pixel-label text-muted-foreground no-underline hover:text-foreground"
            >
              back to the poll
            </a>
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>the details</CardTitle>
            <CardDescription>
              {frozen
                ? `${who} already answered, so the days and times are frozen. the title and description are still yours.`
                : 'nobody has answered yet, so everything is still up for grabs.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreatePollForm
              action={`/p/${rkey}/edit`}
              defaults={defaults}
              frozen={frozen}
              submitLabel="save changes"
            />
          </CardContent>
        </Card>
        <Card className="withdraw">
          <CardHeader>
            <CardTitle>call it off</CardTitle>
            <CardDescription>
              the poll leaves your repo and the share link stops working for everyone. there is
              no undo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form method="post" action={`/p/${rkey}/withdraw`} className="grid gap-3">
              {/* No confirm() dialog: inline handlers are exactly what the CSP forbids, and a
                  required checkbox is a confirmation that works without any script. */}
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="sure" value="1" required />
                i'm sure.
              </label>
              <div>
                <Button type="submit" variant="destructive">withdraw this poll</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
