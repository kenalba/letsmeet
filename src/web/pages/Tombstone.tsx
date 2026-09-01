import { Layout, pageTitle } from './Layout.js';

export function TombstonePage() {
  return (
    <Layout title={pageTitle('Poll withdrawn')}>
      <div className="mx-auto grid max-w-md gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Poll withdrawn</h1>
        <p className="text-muted-foreground">This poll was withdrawn by the host.</p>
        <p className="text-sm">
          <a href="/" className="text-primary underline underline-offset-4">
            Back to letsmeet
          </a>
        </p>
      </div>
    </Layout>
  );
}
