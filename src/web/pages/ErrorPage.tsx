import { Layout, pageTitle } from './Layout.js';

export interface ErrorPageProps {
  /** Shown as the page's <h1> — pick something status-appropriate ("not found", "could not create poll"). */
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
    <Layout title={pageTitle(heading)}>
      <div className="mx-auto grid max-w-md gap-3">
        <h1 className="pixel-heading text-lol">{heading}</h1>
        <p className="text-muted-foreground">{message}</p>
        <p className="text-sm">
          <a href="/" className="text-primary underline underline-offset-4">
            back home
          </a>
        </p>
      </div>
    </Layout>
  );
}
