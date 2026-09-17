import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ArchivePage } from '../../src/web/pages/Archive.js';
import type { PollListItem } from '../../src/web/pages/Landing.js';

const item = (rkey: string, title: string): PollListItem => ({
  rkey, title, status: 'open', dates: ['2026-09-14'], responses: 2,
});

// The page's inline script reads the CSP nonce off a context whose default is `undefined`,
// so a bare renderToString is enough — no provider, as PublicAvailability's tests do it.
const render = (polls: PollListItem[], answered: PollListItem[]) =>
  renderToString(<ArchivePage handle="ken.wzrdz.cool" polls={polls} answered={answered} />);

// `← your polls` is the back link, on every state; the section is the <h2>.
const hasYourPollsHeading = (html: string) => html.includes('>your polls</h2>');

describe('ArchivePage', () => {
  it('offers the empty state when the whole archive is empty', () => {
    const html = render([], []);
    expect(hasYourPollsHeading(html)).toBe(true);
    expect(html).toContain('nothing here yet.');
    expect(html).not.toContain('polls you answered');
  });

  it('drops the "your polls" block entirely when only answered polls are over', () => {
    // An empty card under a full one would read as a fault: the archive plainly has
    // something in it.
    const html = render([], [item('a1', 'their brunch')]);
    expect(hasYourPollsHeading(html)).toBe(false);
    expect(html).not.toContain('nothing here yet.');
    expect(html).toContain('polls you answered');
    expect(html).toContain('their brunch');
  });

  it('lists both sections when the viewer hosts over polls too', () => {
    const html = render([item('m1', 'my picnic')], [item('a1', 'their brunch')]);
    expect(hasYourPollsHeading(html)).toBe(true);
    expect(html).toContain('my picnic');
    expect(html).toContain('polls you answered');
    expect(html).toContain('their brunch');
    expect(html).not.toContain('nothing here yet.');
  });
});
