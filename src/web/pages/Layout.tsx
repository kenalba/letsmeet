import type { ReactNode } from 'react';

export interface LayoutProps {
  title: string;
  children: ReactNode;
  /**
   * Module scripts appended after <main>, so an island's mount point is in the DOM by the
   * time its bundle runs. One entry per built bundle, e.g. `/assets/grid.js`.
   */
  scripts?: string[];
}

/**
 * The full document every server-rendered page returns. `scheme-light-dark` is what tells
 * the browser to paint native controls (selects, date pickers, scrollbars) in whichever
 * theme the token block in app.css is currently resolving to.
 */
export function Layout({ title, children, scripts }: LayoutProps) {
  return (
    <html lang="en" className="scheme-light-dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-3xl items-center px-4">
            <a
              className="brand text-sm font-semibold tracking-tight no-underline hover:text-primary"
              href="/"
            >
              letsmeet
            </a>
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl px-4 py-8">{children}</main>
        {scripts?.map((src) => <script key={src} type="module" src={src} />)}
      </body>
    </html>
  );
}
