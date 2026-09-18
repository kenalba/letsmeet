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
    // The island's rules are scoped to the grid mount, the reply slot and the availability
    // editor together — the editor marks a template week on the same grid.
    const grid = /:is\(#grid-root,\s*#reply-root,\s*#availability-root\) \.grid\{([^}]*)\}/.exec(css);
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

  it('emits the select-all utility the address line uses', () => {
    expect(css).toMatch(/\.select-all\{[^}]*user-select:all/);
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

  it('lights the hovered week cell, its hour and its day, only where there is a pointer', () => {
    const hover = /@media \(hover:hover\)\{([\s\S]*?)\}\}/g;
    const blocks = [...css.matchAll(hover)].map((m) => m[1]).join('\n');
    expect(blocks).toMatch(/\.week-cell:hover\{[^}]*outline:2px solid var\(--foreground\)/);
    expect(blocks).toContain('.week-row:hover .week-axis');
    expect(blocks).toMatch(/\.week:has\(\.week-cell\[data-c=["']?6["']?\]:hover\) \.week-head\[data-c=["']?6["']?\]/);
    expect(css).toMatch(/\.week-row\{display:contents\}/);
  });

  it("ships the editor's half-hour gradients, hover outline and axis collapse", () => {
    // The editor marks by the hour over a half-hour record, so an hour with only one half
    // marked has to draw half full — without these two rules a saved 5:30pm reads as blank.
    // (lightningcss keeps the space after each gradient comma; the selectors carry an
    // `#availability-root` prefix, which the leading `[^{]*` absorbs.)
    const gradient = (cls: string, top: string, bottom: string) => new RegExp(
      String.raw`\.grid\.canvas \.cell\.${cls}\{background:`
      + String.raw`linear-gradient\(to bottom, ?var\(--${top}\) 50%, ?var\(--${bottom}\) 50%\)`,
    );
    expect(css).toMatch(gradient('early', 'primary', 'card'));
    expect(css).toMatch(gradient('late', 'card', 'primary'));
    // The hovered-cell outline is pointer-only, the same ink the week grid uses.
    const hover = /@media \(hover:hover\)\{([\s\S]*?)\}\}/g;
    const blocks = [...css.matchAll(hover)].map((m) => m[1]).join('\n');
    expect(blocks).toMatch(/\.cell\[data-slot\]:hover\{outline:2px solid var\(--foreground\)/);
    // The cells collapse a pixel of border per row; without the matching rule the axis stays
    // 24px a row and its labels drift off the rows they name.
    expect(css).toMatch(/[^{}]*\.axis-label\+\.axis-label\{margin-top:-1px\}/);
  });
  it('defines the away tokens in every theme block and paints away solid on both grids', () => {
    const light = tokens(/:root\{([^}]*)\}/.exec(css)![1]);
    const dark = tokens(DARK_PINNED_TOKENS.exec(css)![1]);
    for (const t of ['--away', '--away-ink', '--away-label']) {
      expect([t, !!light[t]]).toEqual([t, true]);
      expect([t, !!dark[t]]).toEqual([t, true]);
    }
    // Orange is away everywhere: the friend view's gray hatch is gone.
    expect(css).toMatch(/\.week-cell\.away[^{]*\{[^}]*background:var\(--away\)/);
    expect(css).toMatch(/\.cell\.away[^{]*\{[^}]*background:var\(--away\)/);
    expect(css).not.toContain('repeating-linear-gradient(135deg');
  });

  it('sticks the day headers and bleeds the cards at phone width', () => {
    expect(css).toMatch(/\.col-head\{[^}]*position:sticky/);
    expect(css).toMatch(/\.week-head\{[^}]*position:sticky/);
    // The editor grid drops the horizontal scroller, which is what lets its header stick:
    // a horizontal scroll container is a vertical scrollport too, and a sticky child of a
    // scrollport that never scrolls never moves.
    expect(css).toMatch(/#availability-root \.grid\{[^}]*overflow(-x)?:visible/);
    expect(css).toContain('@media (max-width:480px)');
    expect(css).toMatch(/\.bleed\{[^}]*-16px/);
  });

  it('deals the columns on a page change and holds still under reduced motion', () => {
    expect(css).toContain('@keyframes deal');
    expect(css).toMatch(/\.col\.deal \.cells\{[^}]*animation/);
    const reduce = /@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\}\}/g;
    const blocks = [...css.matchAll(reduce)].map((m) => m[1]).join('\n');
    expect(blocks).toContain('.col.deal .cells');
    expect(blocks).toContain('animation:none');
  });

  it('ships the pager, the picker, the chip and the zone label', () => {
    expect(css).toMatch(/\.pager\.dated \.label\{[^}]*var\(--away/);
    expect(css).toMatch(/\.weekpick\{[^}]*position:absolute/);
    expect(css).toMatch(/\.note-chip\{[^}]*position:absolute/);
    expect(css).toMatch(/\.zlabel\{[^}]*pointer-events:none/);
    expect(css).toMatch(/\.zlabel\.v\{[^}]*writing-mode:vertical-rl/);
    expect(css).toMatch(/\.zlabel\.one\{[^}]*text-overflow:ellipsis/);
  });
});
