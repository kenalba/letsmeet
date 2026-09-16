import { test, expect, type Page } from '@playwright/test';

// ---- copied from poll.spec.ts: isoDate, isWeekday, FIXTURE_BASE, FIXTURE_DATE_1, pickDate,
// ---- setTime, createPoll. The spec files are independent, so these are pasted rather than
// ---- imported — see the header comment in poll.spec.ts for why FIXTURE_BASE is computed
// ---- relative to the runner clock instead of pinned to a fixed date.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWeekday(d: Date): boolean {
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

const FIXTURE_BASE = (() => {
  const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  while (!isWeekday(d)) d.setUTCDate(d.getUTCDate() + 1);
  // Friday would make the "adjacent day" a Saturday; roll to the following Monday instead
  // so both fixture dates land on weekdays.
  if (d.getUTCDay() === 5) d.setUTCDate(d.getUTCDate() + 3);
  return d;
})();
const FIXTURE_DATE_1 = isoDate(FIXTURE_BASE);

/**
 * Click one day in the calendar island, paging forward until its cell exists. The island
 * mounts on today's month, so a date a few months out needs a few hops; 12 is a year, past
 * which the date is wrong rather than far away.
 */
async function pickDate(page: Page, iso: string): Promise<void> {
  await page.waitForSelector('[data-slot="calendar"]');
  for (let hop = 0; hop < 12; hop++) {
    const day = page.locator(`button[data-date="${iso}"]`);
    if (await day.count()) { await day.click(); return; }
    await page.click('button.cal-next');
  }
  throw new Error(`date ${iso} not reachable in calendar`);
}

/**
 * Set one window field to a 24h `"HH:mm"`. The island hides the native `<input type=time>`
 * (it stays as the value carrier the form posts) and mounts a segmented field over it, so
 * `page.fill` has nothing fillable to aim at: type into the segments instead. The hour
 * commits and auto-advances on its own — instantly for 2-9, after the "could this still be
 * 10/11/12?" wait for a lone 1 — so the helper waits for the minute segment to take focus
 * rather than assuming it already has, then types the minute pair and the period key.
 */
async function setTime(page: Page, name: string, hhmm: string): Promise<void> {
  const [h24, minute] = hhmm.split(':').map(Number);
  const field = `[data-time-field="${name}"]`;
  // On a coarse pointer the island leaves the native time inputs alone (segments have no
  // virtual keyboard), so there is no segmented field to drive: fill the input directly.
  // The island is already mounted by now — `pickDate` waited for the calendar — so a zero
  // count means "won't mount", not "hasn't yet".
  if ((await page.locator(field).count()) === 0) {
    await page.fill(`input[name=${name}]`, hhmm);
    return;
  }
  await page.click(`${field} [data-segment="hour"]`);
  await page.keyboard.type(String(h24 % 12 === 0 ? 12 : h24 % 12));
  await expect(page.locator(`${field} [data-segment="minute"]`)).toBeFocused();
  await page.keyboard.type(String(minute).padStart(2, '0'));
  await page.keyboard.press(h24 < 12 ? 'a' : 'p');
  // The hidden input is what actually submits; nothing else here proves it was written.
  await expect(page.locator(`input[name=${name}]`)).toHaveValue(hhmm);
}

/** Fill the create form on /new (the signed-in landing links to it), and submit it. */
async function createPoll(page: Page, fields: {
  title: string; dates: string; windowStart: string; windowEnd: string; slotMinutes: string;
}): Promise<string> {
  await page.goto('/new');
  await page.fill('input[name=title]', fields.title);
  for (const d of fields.dates.split(',')) await pickDate(page, d);
  await setTime(page, 'windowStart', fields.windowStart);
  await setTime(page, 'windowEnd', fields.windowEnd);
  await page.selectOption('select[name=slotMinutes]', fields.slotMinutes);
  await page.fill('input[name=timezone]', 'UTC');
  await page.click('form.create button[type=submit]');
  await expect(page.getByRole('heading', { name: fields.title })).toBeVisible();
  return page.url();
}

/**
 * Stroke `from`..`to` (inclusive, by cell index) inside `root`'s grid, the same drag/tap
 * split `poll.spec.ts` uses for the poll grid: a touch project taps each cell (Playwright's
 * touchscreen has no drag primitive), a pointer project drags across both.
 */
async function markCells(page: Page, root: string, from: number, to: number) {
  const cells = page.locator(`${root} [data-slot]`);
  await expect(cells.first()).toBeVisible();
  const a = (await cells.nth(from).boundingBox())!;
  const b = (await cells.nth(to).boundingBox())!;
  if (test.info().project.use.hasTouch) {
    for (let i = from; i <= to; i++) {
      const box = (await cells.nth(i).boundingBox())!;
      await page.touchscreen.tap(box.x + 5, box.y + 5);
    }
  } else {
    await page.mouse.move(a.x + 5, a.y + 5);
    await page.mouse.down();
    await page.mouse.move(b.x + 5, b.y + 5);
    await page.mouse.up();
  }
}

test('mark a week, go away, see it public, answer a poll pre-marked', async ({ page }) => {
  const did = `did:plc:e2eavail${test.info().project.name.replace(/[^a-z0-9]/gi, '')}`;
  await page.goto(`/dev/login?did=${did}&handle=avail.test`);

  // The landing offers the block.
  await expect(page.getByRole('heading', { name: 'your availability' })).toBeVisible();
  await page.click('a[href="/availability"]');

  // Mark Sunday 7:00–8:00 (the first two cells of the first column) and read it back.
  await markCells(page, '#availability-root', 0, 1);
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .sentence')).toHaveText('usually free sundays 7am to 8am.');

  // Away on the fixture date, all day, with a note.
  await page.fill('#availability-root .away-form input[type=date] >> nth=0', FIXTURE_DATE_1);
  await page.fill('#availability-root .away-form input[type=text]', 'out of town');
  await page.click('#availability-root button.add-away');
  await expect(page.locator('#availability-root .away li')).toContainText('out of town');

  // Timezone is what the grid was drawn in; the browser is pinned to UTC in the config.
  await page.fill('#availability-root input[list=tz-list]', 'UTC');
  await page.click('#availability-root button.save');
  await expect(page.locator('#availability-root .status')).toHaveText('availability posted.');

  // Reload keeps it.
  await page.reload();
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .away li')).toContainText('out of town');

  // The public page reads the same record.
  await page.goto(`/u/${did}`);
  await expect(page.getByText('usually free sundays 7am to 8am.')).toBeVisible();
  await expect(page.getByText('out of town')).toBeVisible();
  const ics = await page.request.get(`/u/${did}/availability.ics`);
  expect(ics.headers()['content-type']).toContain('text/calendar');
  expect(await ics.text()).toContain('RRULE:FREQ=WEEKLY;BYDAY=SU');

  // A poll on the next Sunday, 7–9am UTC, hosted by someone else (hosts never get the
  // canvas): sign in as a second account to create it, then back as `did` to answer.
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
  await expect(page.locator('#grid-root .cell.available')).toHaveCount(2);
  await expect(page.locator('button.save')).toBeEnabled();
});
