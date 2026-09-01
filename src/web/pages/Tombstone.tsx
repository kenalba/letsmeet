import { Layout, pageTitle } from './Layout.js';

export function TombstonePage() {
  return (
    <Layout title={pageTitle('poll withdrawn')}>
      <div className="mx-auto grid max-w-md gap-3">
        <h1 className="pixel-heading">the host called it off.</h1>
        <p className="text-muted-foreground">your afternoon is free again.</p>
        <p className="text-sm">
          <a href="/" className="text-primary underline underline-offset-4">
            back home
          </a>
        </p>
      </div>
    </Layout>
  );
}
