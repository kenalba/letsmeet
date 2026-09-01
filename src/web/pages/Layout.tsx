import type { ReactNode } from 'react';
import { useNonce } from '../nonce.js';
import { Moon, Sun, SunMoon } from 'lucide-react';
import { buttonVariants } from '../ui/button.js';

export interface LayoutProps {
  title: string;
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
export function Layout({ title, children, scripts, signInHref }: LayoutProps) {
  const nonce = useNonce();
  return (
    <html lang="en" className="scheme-light-dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body className="min-h-screen bg-background text-foreground">
        <header className="border-b">
          <div className="mx-auto flex h-14 max-w-4xl items-center gap-4 px-4">
            <a
              className="brand text-sm font-semibold tracking-tight no-underline hover:text-primary"
              href="/"
            >
              letsmeet.lol
            </a>
            <div className="ml-auto flex items-center gap-2">
              {signInHref ? (
                <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={signInHref}>
                  Sign in
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
        <main className="mx-auto w-full max-w-4xl px-4 py-8">{children}</main>
        {scripts?.map((src) => <script key={src} type="module" src={src} />)}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_TOGGLE }} />
      </body>
    </html>
  );
}
