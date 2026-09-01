import { Layout } from './Layout.js';

export interface ErrorPageProps {
  /** Shown as the page's <h1> — pick something status-appropriate ("Not found", "Could not create poll"). */
  heading: string;
  message: string;
}

/**
 * The one page every user-facing error response renders through, in place of a bare
 * `c.text(...)`: 404s (unknown polls, unmatched routes) and the 400s a form submission
 * can hit. Mirrors TombstonePage's shape so an error looks like part of the app, not a
 * dropped connection.
 */
export function ErrorPage({ heading, message }: ErrorPageProps) {
  return (
    <Layout title={`${heading} — letsmeet`}>
      <div className="mx-auto grid max-w-md gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="text-muted-foreground">{message}</p>
        <p className="text-sm">
          <a href="/" className="text-primary underline underline-offset-4">
            Back to letsmeet
          </a>
        </p>
      </div>
    </Layout>
  );
}
