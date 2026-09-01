import { Layout } from './Layout.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { CreatePollForm, CREATE_FORM_SCRIPTS } from './CreatePollForm.js';

/**
 * GET /new — the same create form the signed-in landing page shows, on a page of its own.
 * Both call sites must ship `CREATE_FORM_SCRIPTS`, or the dates field silently stays a
 * comma-separated text box.
 */
export function NewPollPage() {
  return (
    <Layout title="New poll — letsmeet" scripts={CREATE_FORM_SCRIPTS}>
      <div className="grid gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">New poll</h1>
        <Card>
          <CardHeader>
            <CardTitle>Poll details</CardTitle>
            <CardDescription>
              Times are interpreted in the poll's timezone; guests see their own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreatePollForm />
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
