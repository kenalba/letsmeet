import type { ReactNode } from 'react';
import { useNonce } from '../nonce.js';
import { Moon, Sun, SunMoon } from 'lucide-react';
import { buttonVariants } from '../ui/button.js';

export const SITE = 'letsmeet.lol';
const DEFAULT_DESCRIPTION = 'does tuesday work? availability polls that live in your own atproto account.';

export interface LayoutProps {
  /** The full document title. Pages pass `pageTitle(...)` so the suffix is uniform. */
  title: string;
  /** One line for search results and link previews; the site's own line when omitted. */
  description?: string;
  /** The page's public URL, for the link-preview `og:url`. Omitted for pages nobody shares. */
  canonical?: string;
  children: ReactNode;
  /**
   * Module scripts appended after <main>, so an island's mount point is in the DOM by the
   * time its bundle runs. One entry per built bundle, e.g. `/assets/grid.js`.
   */
  scripts?: string[];
  /**
   * Where the header's "Sign in" link goes — `/login`, usually with a `returnTo` back to
   * the current page. Omitted (the default) hides the link: pages that don't know their
   * viewer, and pages whose viewer is already signed in, render no dangling invitation.
   */
  signInHref?: string;
}

/**
 * Theme states, in the order the toggle cycles them. "system" means no `data-theme`
 * attribute at all — the token blocks in app.css then fall through to
 * `prefers-color-scheme`. The button is icon-only (sun-moon / sun / moon); this label is
 * its accessible name, kept in sync by THEME_TOGGLE below.
 */
const THEME_LABEL = 'Theme: System';

/**
 * FOUC guard: runs in <head> *before* the stylesheet, so the pinned theme is on <html>
 * by the time the first rule is applied and the page never paints light-then-dark. Inline
 * and dependency-free on purpose — an island bundle would land far too late, and a page
 * whose localStorage throws (private mode, blocked storage) must still render.
 */
const THEME_INIT = "try{var t=localStorage.getItem('theme');"
  + "if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t}}catch(e){}";

/**
 * The toggle's behaviour, wired at the end of <body> once the button exists. Kept out of
 * every island bundle for the same reason: it is three lines of DOM work, and the pages are
 * `renderToString`'d static HTML that nothing hydrates, so mutating the button's own text
 * here is safe — no React root owns the header.
 */
const THEME_TOGGLE = "(function(){var b=document.getElementById('theme-toggle');if(!b)return;"
  + "var order=['system','light','dark'];"
  + "function read(){try{var t=localStorage.getItem('theme');"
  + "return t==='light'||t==='dark'?t:'system'}catch(e){return 'system'}}"
  + "function apply(t){var r=document.documentElement;"
  + "if(t==='system'){delete r.dataset.theme}else{r.dataset.theme=t}"
  // Icon swap via style.display, not the hidden attribute: these are SVGs, and the UA's
  // `[hidden]` rule is an HTML-namespace affair that author styles out-rank anyway.
  + "var ic=b.querySelectorAll('[data-theme-icon]');"
  + "for(var i=0;i<ic.length;i++){ic[i].style.display=ic[i].getAttribute('data-theme-icon')===t?'':'none'}"
  + "var l='Theme: '+t.charAt(0).toUpperCase()+t.slice(1);"
  + "b.setAttribute('aria-label',l);b.title=l+' — click to cycle'}"
  + "var cur=read();apply(cur);"
  + "b.addEventListener('click',function(){cur=order[(order.indexOf(cur)+1)%order.length];"
  + "try{if(cur==='system'){localStorage.removeItem('theme')}else{localStorage.setItem('theme',cur)}}"
  + "catch(e){}apply(cur)})})()";

/**
 * The full document every server-rendered page returns. `scheme-light-dark` is what tells
 * the browser to paint native controls (selects, date pickers, scrollbars) in whichever
 * theme the token block in app.css is currently resolving to; when the viewer pins a theme,
 * the `[data-theme]` rules in app.css override that with a single `color-scheme`.
 */
/** `"Movie night · letsmeet.lol"` — one shape for every tab and link preview. */
export function pageTitle(name: string): string {
  return `${name} · ${SITE}`;
}

export function Layout({ title, description, canonical, children, scripts, signInHref }: LayoutProps) {
  const nonce = useNonce();
  const desc = description ?? DEFAULT_DESCRIPTION;
  return (
    <html lang="en" className="scheme-light-dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={desc} />
        <meta name="theme-color" content="#2b8a5f" />
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* Link previews: a poll link pasted into a chat shows its title, not a bare URL. */}
        <meta property="og:site_name" content={SITE} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={desc} />
        {canonical ? <meta property="og:url" content={canonical} /> : null}
        {canonical ? <link rel="canonical" href={canonical} /> : null}
        <meta name="twitter:card" content="summary" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body className="flex min-h-screen flex-col bg-background text-foreground">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-4xl items-center gap-4 px-4">
            <a
              className="brand pixel-heading no-underline hover:text-primary"
              href="/"
            >
              letsmeet<span className="inline-block origin-bottom-left -translate-y-px -rotate-6 text-lol">.lol</span>
            </a>
            <div className="ml-auto flex items-center gap-2">
              {signInHref ? (
                <a
                  className="prompt pixel-label mr-2 text-muted-foreground no-underline hover:text-foreground"
                  href={signInHref}
                >
                  sign in
                </a>
              ) : null}
              {/*
                Server-rendered in the "system" state (sun-moon icon, the other two hidden)
                — corrected by THEME_TOGGLE on load, which is also the only thing that can
                know what this viewer stored. Without JS the button is inert and the page
                follows `prefers-color-scheme`, as it did before the toggle existed.
              */}
              <button
                id="theme-toggle"
                type="button"
                aria-label={THEME_LABEL}
                title={`${THEME_LABEL} — click to cycle`}
                className={buttonVariants({ variant: 'outline', size: 'icon' })}
              >
                <SunMoon data-theme-icon="system" aria-hidden="true" />
                <Sun data-theme-icon="light" aria-hidden="true" style={{ display: 'none' }} />
                <Moon data-theme-icon="dark" aria-hidden="true" style={{ display: 'none' }} />
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">{children}</main>
        <footer className="border-t">
          <div className="pixel-label mx-auto flex max-w-4xl flex-wrap gap-x-6 px-4 py-6 text-muted-foreground">
            <span>
              made on atproto by{' '}
              <a
                href="https://bsky.app/profile/wzrdz.cool"
                className="prompt no-underline hover:text-foreground"
                rel="noopener"
              >
                ken
              </a>
            </span>
            <a
              href="https://github.com/kenalba/letsmeet"
              className="prompt no-underline hover:text-foreground"
              rel="noopener"
            >
              source
            </a>
            <span>
              type: departure mono by{' '}
              <a
                href="https://buymeacoffee.com/helenazhang"
                className="prompt no-underline hover:text-foreground"
                rel="noopener"
              >
                helena zhang
              </a>
            </span>
          </div>
        </footer>
        {scripts?.map((src) => <script key={src} type="module" src={src} />)}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_TOGGLE }} />
      </body>
    </html>
  );
}
