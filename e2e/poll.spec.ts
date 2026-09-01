import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * The per-project emulation options that matter to these flows, so guest contexts (opened
 * via `browser.newContext`, which inherits nothing) render like the project's main page.
 * Cherry-picked rather than spreading `project.use` wholesale: that object also carries
 * test-only options (`baseURL` aside) that `newContext` would reject.
 */
function projectContext(): {
  viewport?: { width: number; height: number } | null; userAgent?: string;
  deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean;
  timezoneId?: string; baseURL?: string;
} {
  const use = test.info().project.use;
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, timezoneId, baseURL } = use;
  return { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, timezoneId, baseURL };
}

async function newGuest(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(projectContext());
  return { context, page: await context.newPage() };
}

/**
 * Fixture dates, computed relative to the runner clock instead of pinned to a fixed pair
 * that eventually lands in the past (`pickDate` only ever pages the calendar forward — a
 * fixed past date would never be reachable). ~2-3 weeks out keeps well clear of "today" no
 * matter when this runs; both dates are derived from the same base so a month boundary can't
 * put them on different, inconsistently-adjusted footings. `playwright.config.ts` pins the
 * browser's `timezoneId` to UTC, so the calendar island renders "today" in UTC — compute the
 * base in UTC too, or a host machine in a different zone could disagree with the browser
 * about which day is 14 days out. (The tz-kolkata project runs the browser ahead of UTC,
 * where the same base is at most one day *less* far out — still future, still reachable by
 * paging forward. A behind-UTC project would be equally safe, at one day further out.)
 */
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
const FIXTURE_DATE_2 = isoDate(new Date(FIXTURE_BASE.getTime() + 24 * 60 * 60 * 1000));

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

/** Fill the create form the landing page shows to a signed-in host, and submit it. */
async function createPoll(page: Page, fields: {
  title: string; dates: string; windowStart: string; windowEnd: string; slotMinutes: string;
}): Promise<string> {
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

test('host creates, guest paints, host finalizes', async ({ page, browser }) => {
  // host signs in (dev route) and creates a poll
  await page.goto('/dev/login?did=did:plc:e2ehost');
  await expect(page.locator('code')).toHaveText('did:plc:e2ehost');
  const pollUrl = await createPoll(page, {
    title: 'Board games',
    dates: `${FIXTURE_DATE_1},${FIXTURE_DATE_2}`,
    windowStart: '17:00',
    windowEnd: '19:00',
    slotMinutes: '60',
  });

  // guest responds in a clean context: paint two cells, name, save. Touch projects tap
  // each cell (Playwright's touchscreen has no drag primitive); pointer projects drag
  // across both, which also exercises the rectangle-stroke path.
  const { context: guestContext, page: guest } = await newGuest(browser);
  await guest.goto(pollUrl);
  const cells = guest.locator('#grid-root [data-slot]');
  await expect(cells.first()).toBeVisible();
  const a = (await cells.nth(0).boundingBox())!;
  const b = (await cells.nth(1).boundingBox())!;
  if (projectContext().hasTouch) {
    await guest.touchscreen.tap(a.x + 5, a.y + 5);
    await guest.touchscreen.tap(b.x + 5, b.y + 5);
  } else {
    await guest.mouse.move(a.x + 5, a.y + 5);
    await guest.mouse.down();
    await guest.mouse.move(b.x + 5, b.y + 5);
    await guest.mouse.up();
  }
  await expect(guest.locator('.cell.available')).toHaveCount(2);
  await guest.fill('.name input', 'Sam');
  await guest.click('button.save');
  await expect(guest.getByText('Keep this link')).toBeVisible();
  await guestContext.close();

  // host sees the response and finalizes the top slot
  await page.reload();
  await expect(page.locator('.responders').getByText('Sam')).toBeVisible();
  await page.locator('form[action$="/finalize"] button').first().click();
  await expect(page.getByText(/decided|finalized/i)).toBeVisible();
  await expect(page.locator('a.ics[href$="/ics"]')).toBeVisible();
});

test('guest edit link round-trips', async ({ page, browser }) => {
  await page.goto('/dev/login?did=did:plc:e2ehost2');
  const pollUrl = await createPoll(page, {
    title: 'Edit test',
    dates: FIXTURE_DATE_1,
    windowStart: '17:00',
    windowEnd: '18:00',
    slotMinutes: '30',
  });

  // A signed-in viewer posts to /respond-auth and is never offered a name or an edit link,
  // so the guest half of this flow needs its own cookie-free context.
  const { context: guestContext, page: guest } = await newGuest(browser);
  await guest.goto(pollUrl);
  await guest.locator('#grid-root [data-slot]').first().click();
  await guest.fill('.name input', 'Ana');
  await guest.click('button.save');
  const editLink = await guest.locator('.edit-link code').textContent();
  expect(editLink).toBeTruthy();

  await guest.goto(editLink!);
  await expect(guest.locator('.name input')).toHaveValue('Ana');
  await expect(guest.locator('.cell.available')).toHaveCount(1);
  await guestContext.close();
});
