import { test, expect, type Locator, type Page } from '@playwright/test';
import { FIXTURE_DATE_1, pickDate, setTime, createPoll } from './helpers.js';

/**
 * Stroke `from`..`to` (inclusive, by cell index) inside `root`'s grid, the same drag/tap
 * split `poll.spec.ts` uses for the poll grid: a touch project taps each cell (Playwright's
 * touchscreen has no drag primitive), a pointer project drags across both.
 */
async function markCells(page: Page, cells: Locator, from: number, to: number) {
  await expect(cells.first()).toBeVisible();
  // The editor's address field sits below the grid, so measuring straight after filling it
  // would find cells off the top of the screen — and a sticky day header parked over row one
  // would swallow the press even once they were. Start from the top of the page, then let
  // Playwright place each press itself: `hover`/`tap` re-measure the cell immediately before
  // the pointer moves and refuse to act through anything covering it, where a bounding box
  // read a moment earlier goes stale the instant the page scrolls (Firefox on CI did).
  await page.evaluate(() => window.scrollTo(0, 0));
  const at = { position: { x: 5, y: 5 } };
  if (test.info().project.use.hasTouch) {
    for (let i = from; i <= to; i++) await cells.nth(i).tap(at);
  } else {
    await cells.nth(from).hover(at);
    await page.mouse.down();
    await cells.nth(to).hover(at);
    await page.mouse.up();
  }
}

/**
 * Dismiss the note chip the way the project's device can: Escape where there is a keyboard,
 * a tap off the chip where there is not — which is the only free way out on a phone, and so
 * the one worth asserting there.
 */
async function dismissChip(page: Page) {
  if (test.info().project.use.hasTouch) await page.locator('#availability-root .hint').first().tap();
  else await page.keyboard.press('Escape');
}

test('mark a week, go away, see it public, answer a poll pre-marked', async ({ page }) => {
  const did = `did:plc:e2eavail${test.info().project.name.replace(/[^a-z0-9]/gi, '')}`;
  await page.goto(`/dev/login?did=${did}&handle=avail.test`);

  // The landing offers the block.
  await expect(page.getByRole('heading', { name: 'your availability' })).toBeVisible();
  await page.click('a[href="/availability"]');

  // Claim a name of our own (one per project, so the four runs never contend for it).
  const name = `e2e-${test.info().project.name.replace(/[^a-z0-9-]/gi, '')}`;
  await page.fill('#availability-root input[name=alias]', name);
  // Timezone is what the grid is drawn in; the browser is pinned to UTC in the config. Filled
  // before any mark, so the cell indexes below are UTC's on every project. (On tz-kolkata the
  // alias field's blur flushes a Kolkata post first; the next post overwrites it.)
  await page.fill('#availability-root input[list=tz-list]', 'UTC');
  // Leave the field before marking: its blur flushes an autosave, and Firefox keeps a datalist
  // popup open on a focused input. Neither should be in flight when the first stroke lands.
  await page.locator('#availability-root input[list=tz-list]').blur();
  await expect(page.locator('#availability-root .status')).toHaveText('posted.', { timeout: 15_000 });

  // Mark Sunday 7am–9am. The Sunday column is the last of seven, each seventeen rows deep,
  // so its 7am cell is number 102. Sunday is the last day of a Monday-first week, so it is
  // never in the past — which the reach-out step below needs.
  await markCells(page, page.locator('#availability-root [data-slot]'), 6 * 17, 6 * 17 + 1);
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .sentence')).toHaveText('usually free sundays 7am to 9am.');
  await expect(page.getByText('usually free sundays 7am to 9am.', { exact: true })).toHaveCount(1);

  // The pager: the usual week is page zero, and `›` pages into real weeks.
  await expect(page.locator('#availability-root .pager .name')).toHaveText('usual week');
  await expect(page.locator('#availability-root .grid.usual')).toBeVisible();
  await page.click('#availability-root .pager .arrow >> nth=1');
  await expect(page.locator('#availability-root .pager .name')).toHaveText('this week');
  await expect(page.locator('#availability-root .grid.dated')).toBeVisible();
  // Dates appear in the headers, and the marked Sunday still reads as free.
  await expect(page.locator('#availability-root .col[data-c="6"] .col-head .num')).not.toBeEmpty();
  await expect(page.locator('#availability-root .col[data-c="6"] .cell.available')).toHaveCount(2);
  // The week picker jumps back to the usual week.
  await page.click('#availability-root .pager .label');
  await expect(page.locator('#availability-root .weekpick')).toBeVisible();
  await page.click('#availability-root .weekpick .usual');
  await expect(page.locator('#availability-root .weekpick')).toHaveCount(0);
  await expect(page.locator('#availability-root .pager .name')).toHaveText('usual week');

  // Marks on a dated page are away. Sunday 11am–3pm: cells 4 through 7 of the column
  // (the first is 7am). Sunday is today or later, so it is always paintable.
  await page.click('#availability-root .pager .arrow >> nth=1');
  // Named sundayCol, not sunday: the poll at the end of this spec already has a `sunday`.
  const sundayCol = page.locator('#availability-root .col[data-c="6"]');
  await markCells(page, sundayCol.locator('[data-slot]'), 4, 7);
  await expect(sundayCol.locator('.cell.away')).toHaveCount(4);

  // A day header tap clears a day that has any away at all, window and note and all; the
  // next one takes all day, and the column locks: a tap anywhere in it clears the day.
  await sundayCol.locator('.col-head').click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(0);
  await sundayCol.locator('.col-head').click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(17);
  // A header tap offers a chip for the column it just marked, on every device — it hangs
  // over the top of the column, so dismissing it is also what lets the next click land on a
  // cell. Escape, or a tap off the chip where there is no keyboard: neither writes anything.
  const chip = page.locator('#availability-root .note-chip');
  await expect(chip.locator('.when')).toContainText('away');
  await dismissChip(page);
  await expect(chip).toHaveCount(0);
  await sundayCol.locator('[data-slot]').first().click();
  await expect(sundayCol.locator('.cell.away')).toHaveCount(0);

  // Painted again, so the rest of this flow has an away entry to name. The stroke is an
  // entry on the record, not just paint: one sunday, 11am to 3pm.
  await markCells(page, sundayCol.locator('[data-slot]'), 4, 7);
  await expect(sundayCol.locator('.cell.away')).toHaveCount(4);

  const noteEdit = page.locator('#availability-root .away-list input.note-edit');
  if (test.info().project.use.hasTouch) {
    // One hour tapped with a finger offers no chip — it would land over the rows being
    // tapped next. The note for it comes from the list instead.
    await expect(chip).toHaveCount(0);
    await page.locator('#availability-root .away-list .note').tap();
    await noteEdit.fill('out of town');
    await noteEdit.press('Enter');
  } else {
    // A stroke drops a chip under the cells: the range it wrote, and a note field.
    await expect(chip.locator('.when')).toContainText('away');
    await chip.locator('input').fill('out of town');
    await chip.locator('input').press('Enter');
    await expect(chip).toHaveCount(0);
  }

  // The list under the grid is the record: the entry, with its window and its note.
  await expect(page.locator('#availability-root .away-list li')).toHaveCount(1);
  await expect(page.locator('#availability-root .away-list li')).toContainText('out of town');
  await expect(page.locator('#availability-root .away-list .jump')).toContainText('11am–3pm');

  // No post button: the status line posts two seconds after the last change.
  await expect(page.locator('#availability-root button.save')).toHaveCount(0);
  await expect(page.locator('#availability-root .status')).toHaveText('posted.', { timeout: 15_000 });
  await expect(page.locator('#availability-root .address-line')).toHaveCount(0);
  await expect(page.locator('#availability-root .copy-address')).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { document.documentElement.dataset.copiedUrl = text; } },
    });
  });
  await page.locator('#availability-root .copy-address').click();
  await expect(page.locator('#availability-root .copy-address')).toHaveText('copied.');
  await expect(page.locator('html')).toHaveAttribute('data-copied-url', `http://${name}.sez.localhost:8787`);

  // Reload keeps it.
  await page.reload();
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .away-list li')).toContainText('out of town');

  // The note is drawn inside its own away block, on the editor's grid too.
  await page.click('#availability-root .pager .arrow >> nth=1');
  await expect(page.locator('#availability-root .grid .zlabel')).toHaveText('out of town');

  // The public page reads the same record.
  await page.goto(`/u/${did}`);
  await expect(page.getByText('usually free sundays 7am to 9am.')).toBeVisible();
  await expect(page.getByText('out of town')).toBeVisible();

  // The week grid: sunday 7am and 8am are the free cells in the week containing today, and
  // the four away hours are this sunday's, in orange. Next week is a link, and one past
  // that is the poll prompt.
  await expect(page.locator('.week-cell')).toHaveCount(7 * 17);
  await expect(page.locator('.week-cell.free')).toHaveCount(2);
  // The shareable grid uses the editor's column and date motion, with the same
  // accessible opt-out. Past days must stay dim after the animation finishes.
  await expect(page.locator('.week-cell').first()).toHaveCSS('animation-name', 'deal');
  await expect(page.locator('.week-head b').first()).toHaveCSS('animation-name', 'num-drop');
  await page.locator('.week').evaluate(async (grid) => {
    await Promise.all(grid.getAnimations({ subtree: true }).map((animation) => animation.finished));
  });
  const pastCells = page.locator('.week-cell.past');
  if (await pastCells.count()) await expect(pastCells.first()).toHaveCSS('opacity', '0.42');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.week-cell').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.week-head b').first()).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // Sensitive to the clock in the one project that is not in UTC: the editor drew (and this
  // count expects) the sunday of the browser's own week, while the record saves in UTC — so
  // between 00:00 and 05:30 IST on a monday that sunday belongs to the week just gone, and
  // this page would draw it on no week at all.
  await expect(page.locator('.week-cell.away')).toHaveCount(4);
  // The away block is orange, four hours of it, with the note drawn inside it.
  await expect(page.locator('.week .zlabel')).toHaveText('out of town');
  // The day headers stay on screen while the hours scroll under them. Only worth checking
  // where the grid is taller than the viewport, which is the phone: `.week-head` is a grid
  // item, so it can only stick inside its own grid area — it spans every row for that
  // reason (HEAD_SPAN in PublicAvailability.tsx), and this is the guard on it. The Pixel 7's
  // 839px of viewport is taller than the whole page, so shorten it first: without room to
  // scroll there is nothing for `top: 0` to do.
  if (test.info().project.use.hasTouch) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: 400 });
    await page.evaluate(() => window.scrollTo(0, 300));
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(300);
    // Read the rects in the page: `locator.boundingBox()` scrolls its element into view
    // first, which would undo the very scroll this is measuring.
    const rects = await page.evaluate(() => {
      const box = (sel: string) => {
        const { top, height } = document.querySelector(sel)!.getBoundingClientRect();
        return { top, height };
      };
      return { monday: box('.week-head[data-c="0"]'), firstHour: box('.week-cell[data-c="0"]') };
    });
    expect(rects.monday.top, 'monday stays on screen').toBeGreaterThanOrEqual(0);
    expect(rects.monday.top, 'monday stays at the top of it').toBeLessThan(60);
    expect(rects.firstHour.top, '7am has scrolled under the head')
      .toBeLessThan(rects.monday.top + rects.monday.height);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize(size);
  }
  await page.click('.week-nav a[href="?week=next"]');
  await expect(page.locator('.week-cell')).toHaveCount(7 * 17);
  await page.click('.week-nav a[href="?week=later"]');
  await expect(page.getByRole('link', { name: `make a poll with ${did}` })).toBeVisible();
  await page.goto(`/u/${did}`);
  const ics = await page.request.get(`/u/${did}/availability.ics`);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  expect(await ics.text()).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU');

  // The same page and feed answer on <name>.sez.<site>. Playwright's request context hands
  // its headers to Node's http client, so the Host header names the alias host while the
  // socket still goes to localhost:8787 — which is exactly what nginx does in production.
  const aliasHost = `${name}.sez.localhost:8787`;
  const alias = await page.request.get('/', { headers: { host: aliasHost } });
  expect(alias.status()).toBe(200);
  const aliasText = await alias.text();
  expect(aliasText).toContain('usually free sundays 7am to 9am.');
  // The signed-in viewer is the owner, so the alias response carries the edit button too:
  // `page.request` shares the browser context's cookie jar, so the session rides along.
  expect(aliasText).toContain('fv-edit');
  expect(aliasText).toContain('href="http://localhost:8787/availability"');
  const aliasIcs = await page.request.get('/availability.ics', { headers: { host: aliasHost } });
  expect(aliasIcs.headers()['content-type']).toContain('text/calendar');
  expect((await page.request.get('/new', { headers: { host: aliasHost } })).status()).toBe(404);

  // Two bits only chromium is asked to cover (the other projects already exercise the pages
  // themselves above): the scripted feed-link copy, and the reach-out popup. Guarded on the
  // project, not `test.skip`, which would skip the whole test on every project.
  if (test.info().project.name === 'chromium') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    // copy feed link: the button is hidden until the script reveals it.
    const copyButton = page.locator('button[data-copy-url]');
    await expect(copyButton).toBeVisible();
    await copyButton.click();
    await expect(copyButton).toHaveText('copied.');
    const copiedFeedUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedFeedUrl).toBe(`http://localhost:8787/u/${did}/availability.ics`);

    // reach out: clicking a free hour opens bluesky's compose sheet with a post at the
    // person already written.
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.click('a.week-cell.free >> nth=0'),
    ]);
    const popupUrl = new URL(popup.url());
    // The rig may be offline for a real bsky.app fetch: close without waiting for it to load.
    await popup.close();
    expect(popupUrl.origin + popupUrl.pathname).toBe('https://bsky.app/intent/compose');
    expect(popupUrl.searchParams.get('text')).toMatch(
      /^hey @did:plc:\S+, let's meet \(lol\)\. 7am on sun [a-z]{3} \d{1,2} looks good to me\?$/,
    );
  }

  // A poll on the next Sunday, 7–9am UTC in 30-minute slots, hosted by someone else (hosts
  // never get the canvas): sign in as a second account to create it, then back as `did` to
  // answer. The marked week covers that whole window, so all four slots come pre-marked.
  const sunday = (() => {
    const d = new Date(`${FIXTURE_DATE_1}T12:00:00Z`);
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  await page.goto(`/dev/login?did=${did}host`);
  const pollUrl = await createPoll(page, {
    title: 'Sunday coffee', dates: sunday, windowStart: '07:00', windowEnd: '09:00', slotMinutes: '30',
  });
  await page.goto(`/dev/login?did=${did}`);
  await page.goto(pollUrl);
  await expect(page.locator('#grid-root .from-availability'))
    .toHaveText("marked from your availability. fix what's off, then save.");
  await expect(page.locator('#grid-root .cell.available')).toHaveCount(4);
  await expect(page.locator('button.save')).toBeEnabled();

  // The mobile project only: the week card bleeds to the screen edges, and the day headers
  // stay put while the grid scrolls past them.
  if (test.info().project.name === 'mobile') {
    await page.goto('/availability');
    await expect(page.locator('#availability-root .grid')).toBeVisible();
    // The island's card is the first card on the page (the banners above it are <p>).
    const box = (await page.locator('[data-slot="card"]').first().boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(0.5);
    expect(box.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 0.5);
    // The day headers are sticky, and the grid is not its own scrollport — so scrolling the
    // grid's top past the viewport leaves the header at the top of it.
    expect(await page.evaluate(() => getComputedStyle(
      document.querySelector('#availability-root .col-head')!).position)).toBe('sticky');
    await page.evaluate(() => window.scrollBy(0, 400));
    const offsets = await page.evaluate(() => ({
      grid: document.querySelector('#availability-root .grid')!.getBoundingClientRect().top,
      head: document.querySelector('#availability-root .col[data-c="0"] .col-head')!
        .getBoundingClientRect().top,
    }));
    expect(offsets.grid).toBeLessThan(0);
    expect(offsets.head).toBeGreaterThanOrEqual(-1);
  }
});
