import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CSS_PATH = path.resolve(process.cwd(), 'public/assets/app.css');

/**
 * Every assertion here reads the *compiled* sheet, built fresh rather than trusting whatever
 * public/assets/app.css happens to hold — that way a regression in the source is caught
 * regardless of build order elsewhere. The output is minified, and lightningcss drops the
 * quotes from attribute selectors (`[data-theme=dark]`), so the matchers below tolerate
 * either spelling.
 */
let css = '';

/** Custom-property declarations of one minified rule body, as a name -> value map. */
function tokens(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of body.split(';')) {
    const trimmed = decl.trim();
    if (!trimmed.startsWith('--')) continue;
    const at = trimmed.indexOf(':');
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

const DARK_MEDIA_TOKENS =
  /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=["']?light["']?\]\)\{([^}]*)\}/;
const DARK_PINNED_TOKENS = /:root\[data-theme=["']?dark["']?\]\{([^}]*)\}/;

describe('built app.css', () => {
  beforeAll(() => {
    execSync('npm run build:css', { stdio: 'pipe' });
    if (!existsSync(CSS_PATH)) throw new Error(`build:css produced no ${CSS_PATH}`);
    css = readFileSync(CSS_PATH, 'utf8');
  });

  it('emits @layer island after @layer utilities', () => {
    // The grid island's `.cell`/`.col` etc. share names with Tailwind's own utility classes
    // (e.g. `.grid`), and layer order beats specificity — so `island` has to come after
    // `utilities` in the compiled sheet or the island loses that fight.
    const utilitiesIdx = css.indexOf('@layer utilities');
    const islandIdx = css.indexOf('@layer island');
    expect(utilitiesIdx).toBeGreaterThan(-1);
    expect(islandIdx).toBeGreaterThan(-1);
    expect(islandIdx).toBeGreaterThan(utilitiesIdx);
  });

  it('gates the prefers-color-scheme dark tokens behind :not([data-theme="light"])', () => {
    // Without the guard, a viewer who pinned Light on an OS-dark machine would keep the
    // dark palette — the whole reason the toggle exists.
    expect(css).toMatch(DARK_MEDIA_TOKENS);
  });

  it('ships a pinned [data-theme="dark"] token block and a color-scheme to match', () => {
    const pinned = DARK_PINNED_TOKENS.exec(css);
    expect(pinned).not.toBeNull();
    expect(tokens(pinned![1])['--background']).toBeTruthy();
    // Native controls have to follow the pin too, or a pinned-dark page renders white
    // selects and scrollbars. (The minifier folds this declaration into the token rule.)
    expect(css).toMatch(/:root\[data-theme=["']?dark["']?\][^{]*\{[^}]*color-scheme:dark/);
    expect(css).toMatch(/:root\[data-theme=["']?light["']?\][^{]*\{[^}]*color-scheme:light/);
  });

  it('defines the text-safe green in every token block', () => {
    // Primary buttons are rings drawn in --primary-ink; a theme block without it would fall
    // back to the *inherited* colour and the ring would silently vanish in that theme.
    const light = /:root\{([^}]*)\}/.exec(css);
    expect(light).not.toBeNull();
    expect(tokens(light![1])['--primary-ink']).toBeTruthy();
    expect(tokens(DARK_PINNED_TOKENS.exec(css)![1])['--primary-ink']).toBeTruthy();
    expect(css).toContain('.border-primary-ink');
  });

  it('leaves touch scrolling of the grid to the browser', () => {
    // `touch-action: none` on the scroll container is what made a phone unable to scroll
    // the grid (or the page, from a finger on it): the island paints from a held finger.
    const grid = /#grid-root \.grid\{([^}]*)\}/.exec(css);
    expect(grid).not.toBeNull();
    expect(grid![1]).toContain('touch-action:manipulation');
    expect(css).not.toContain('touch-action:none');
  });

  it('keeps the two dark token blocks identical', () => {
    // They are duplicated in source because a media-gated selector and an unconditional one
    // cannot share a rule; this is the guard that stops them drifting.
    const media = DARK_MEDIA_TOKENS.exec(css);
    const pinned = DARK_PINNED_TOKENS.exec(css);
    expect(media).not.toBeNull();
    expect(pinned).not.toBeNull();
    expect(tokens(pinned![1])).toEqual(tokens(media![1]));
    expect(Object.keys(tokens(media![1])).length).toBeGreaterThan(10);
  });

  it('compiles the dark: variant to honour data-theme in both directions', () => {
    // `dark:bg-input/30` is what the outline buttons (including the theme toggle itself)
    // use, so it is the canonical check that the @custom-variant override took.
    const utility = String.raw`\.dark\\:bg-input\\/30`;
    expect(css).toMatch(new RegExp(
      `@media \\(prefers-color-scheme:dark\\)\\{${utility}:where\\(:root:not\\(\\[data-theme=["']?light["']?\\]\\)`,
    ));
    expect(css).toMatch(new RegExp(`${utility}:where\\(\\[data-theme=["']?dark["']?\\] \\*`));
  });
});
