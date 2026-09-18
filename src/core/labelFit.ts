/**
 * Which way a note label runs inside its away block, and on how many lines.
 *
 * Text width is estimated, not measured: characters times `charWidth`, the longest word
 * likewise. That is enough to choose a layout — the label is clipped to its block either
 * way, so the cost of being a few pixels out is one word wrapping, never an overflow.
 *
 * Preference order, first that fits: horizontal on one line (easiest to read), vertical on
 * one line, horizontal wrapped, vertical wrapped. Nothing fits: truncate with an ellipsis
 * along the longer axis, which is where the most of the note will show.
 *
 * NOTE: this function's own source is shipped to the browser by
 * `src/web/pages/zoneLabels.ts` (`fitLabel.toString()`), so the friend view and the editor
 * cannot drift apart. Keep it self-contained — no module-level references, they would not
 * travel — and keep backticks and the string `</script` out of it.
 */
export interface LabelFont {
  /** Average glyph advance, px. */
  charWidth: number;
  lineHeight: number;
  /** Padding on each side of the label, px. */
  pad: number;
}
export interface LabelFit {
  orient: 'h' | 'v';
  lines: number;
  /** Nothing fit: one line, clipped with an ellipsis. */
  truncate?: boolean;
}

export function fitLabel(
  text: string, w: number, h: number,
  font: LabelFont = { charWidth: 6, lineHeight: 14, pad: 5 },
): LabelFit {
  // How many lines this text needs along main, or 0 when it cannot sit there at all:
  // either the longest unbreakable word overflows, or the lines overflow cross.
  const lines = [0, 0];
  for (let i = 0; i < 2; i++) {
    const main = (i === 0 ? w : h) - 2 * font.pad;
    const cross = (i === 0 ? h : w) - 2 * font.pad;
    if (main <= 0 || cross < font.lineHeight) continue;
    let longest = 0;
    for (const word of text.split(/\s+/)) {
      if (word.length * font.charWidth > longest) longest = word.length * font.charWidth;
    }
    if (longest > main) continue;
    const n = Math.max(1, Math.ceil((text.length * font.charWidth) / main));
    if (n * font.lineHeight <= cross) lines[i] = n;
  }
  if (lines[0] === 1) return { orient: 'h', lines: 1 };
  if (lines[1] === 1) return { orient: 'v', lines: 1 };
  if (lines[0] > 0) return { orient: 'h', lines: lines[0] };
  if (lines[1] > 0) return { orient: 'v', lines: lines[1] };
  return { orient: h > w ? 'v' : 'h', lines: 1, truncate: true };
}
