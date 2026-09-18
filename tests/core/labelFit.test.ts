import { describe, it, expect } from 'vitest';
import { fitLabel } from '../../src/core/labelFit.js';

/**
 * The default font is the editor label's: 11px/14px Departure-ish at about 6px a character,
 * with 5px of padding each side. Boxes below are in CSS pixels, as a cell rect is.
 */
describe('fitLabel', () => {
  it('lays a short note horizontally on one line where the width takes it', () => {
    // Both orientations take it on one line here, so this is the one-line tie-break too.
    expect(fitLabel('wedding', 200, 60)).toEqual({ orient: 'h', lines: 1 });
  });
  it('turns a note that is too wide for one horizontal line down the column', () => {
    // 'conference' is 60px of text in a 50px-wide inner box, but the 120px height takes it.
    expect(fitLabel('conference', 60, 120)).toEqual({ orient: 'v', lines: 1 });
  });
  it('wraps horizontally when no single line fits but every word does', () => {
    expect(fitLabel('family wedding weekend', 100, 60)).toEqual({ orient: 'h', lines: 2 });
  });
  it('wraps vertically when no word fits the width but the height takes two columns', () => {
    expect(fitLabel('family wedding weekend', 44, 100)).toEqual({ orient: 'v', lines: 2 });
    // One tall column is enough here, so it does not wrap at all.
    expect(fitLabel('family wedding weekend', 40, 220)).toEqual({ orient: 'v', lines: 1 });
  });
  it('truncates along the longer axis when the longest word fits neither', () => {
    expect(fitLabel('a very long note about the conference trip', 44, 48))
      .toEqual({ orient: 'v', lines: 1, truncate: true });
    expect(fitLabel('a very long note about the conference trip', 48, 44))
      .toEqual({ orient: 'h', lines: 1, truncate: true });
  });
  it('truncates in a box with no room for a single line', () => {
    expect(fitLabel('x', 30, 10)).toEqual({ orient: 'h', lines: 1, truncate: true });
  });
  it('prefers horizontal even where vertical would take fewer lines', () => {
    // 50px of inner width wraps this into 3 lines; 90px of inner height would take it in 2.
    // The preference order is horizontal-before-vertical, not fewest-lines, so h wins.
    expect(fitLabel('family wedding weekend', 60, 100)).toEqual({ orient: 'h', lines: 3 });
  });
  it('never reports fewer than one line, however degenerate the box', () => {
    // Callers divide the box by `lines`, so a zero would be a division by zero.
    for (const [w, h] of [[0, 0], [30, 10], [-5, -10]]) {
      expect(fitLabel('family wedding weekend', w, h).lines).toBeGreaterThanOrEqual(1);
    }
  });
  it('takes the friend view\'s smaller metrics', () => {
    const font = { charWidth: 5, lineHeight: 12, pad: 3 };
    expect(fitLabel('conference', 60, 40, font)).toEqual({ orient: 'h', lines: 1 });
    expect(fitLabel('conference', 24, 90, font)).toEqual({ orient: 'v', lines: 1 });
  });
  it('is written so a browser can be handed its own source', () => {
    // Task 7 inlines fitLabel.toString() in a nonce-tagged script: a backtick would end the
    // template literal that builds it, and a module reference would not travel.
    const src = fitLabel.toString();
    expect(src).not.toContain('`');
    expect(src).not.toContain('</script');
  });
});
