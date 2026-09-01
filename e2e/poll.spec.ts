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

test('host creates, guest paints, host finalizes', async ({ page, browser }) => {
  // One host DID per project: the four projects run this flow concurrently against one
  // server, and the per-account rate limiter (create, edit, finalize — three writes each)
  // would otherwise count them all as one very busy host.
  const hostDid = `did:plc:e2ehost${test.info().project.name.replace(/[^a-z0-9]/gi, '')}`;
  // host signs in (dev route) and creates a poll
  await page.goto(`/dev/login?did=${hostDid}`);
  await expect(page.locator('code')).toHaveText(hostDid);
  const pollUrl = await createPoll(page, {
    title: 'Board games',
    dates: `${FIXTURE_DATE_1},${FIXTURE_DATE_2}`,
    windowStart: '17:00',
    windowEnd: '19:00',
    slotMinutes: '60',
  });

  // host edits the title while the poll is still untouched: the same form, pre-filled,
  // with the calendar island seeded from the poll's own dates.
  await page.click('a[href$="/edit"]');
  await expect(page.locator('input[name=title]')).toHaveValue('Board games');
  await page.fill('input[name=title]', 'Board games, revised');
  await page.click('form.create button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Board games, revised' })).toBeVisible();

  // guest responds in a clean context: paint two cells, name, save. Touch projects tap
  // each cell (Playwright's touchscreen has no drag primitive); pointer projects drag
  // across both, which also exercises the rectangle-stroke path.
  const { context: guestContext, page: guest } = await newGuest(browser);
  await guest.goto(pollUrl);
  const cells = guest.locator('#grid-root [data-slot]');
  await expect(cells.first()).toBeVisible();
  // Nothing painted, nothing to save.
  await expect(guest.locator('button.save')).toBeDisabled();
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
  // Painted but nameless is still not saveable for a guest; the name completes it.
  await expect(guest.locator('button.save')).toBeDisabled();
  await guest.fill('.name input', 'Sam');
  await expect(guest.locator('button.save')).toBeEnabled();
  await guest.click('button.save');
  await expect(guest.locator('.edit-link')).toBeVisible();
  await guestContext.close();

  // host sees the response and finalizes the top slot
  await page.reload();
  await expect(page.locator('.responders').getByText('Sam')).toBeVisible();
  await page.locator('form[action$="/finalize"] button').first().click();
  await expect(page.getByText(/happening|decided|finalized/i)).toBeVisible();
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
  // The address bar already carries it, so history and bookmarks do too.
  await expect(guest).toHaveURL(editLink!);

  await guest.goto(editLink!);
  await expect(guest.locator('.name input')).toHaveValue('Ana');
  await expect(guest.locator('.cell.available')).toHaveCount(1);
  // Reopened unchanged: the save button waits for an actual edit.
  await expect(guest.locator('button.save')).toBeDisabled();
  await guest.locator('#grid-root [data-slot]').nth(1).click();
  await expect(guest.locator('button.save')).toBeEnabled();

  // The plain share link, on this device, comes back to the response: nobody keeps the link.
  await guest.goto(pollUrl);
  await expect(guest).toHaveURL(editLink!);
  await expect(guest.locator('.name input')).toHaveValue('Ana');
  // A different device sees a blank grid.
  const { context: otherContext, page: elsewhere } = await newGuest(browser);
  await elsewhere.goto(pollUrl);
  await expect(elsewhere).toHaveURL(pollUrl);
  await expect(elsewhere.locator('.name input')).toHaveValue('');
  await otherContext.close();
  // A remembered secret that no longer works is forgotten, and the address put back.
  const storageKey = `letsmeet.edit.${pollUrl.split('/').pop()}`;
  await guest.evaluate((k) => localStorage.setItem(k, 'stale'), storageKey);
  await guest.goto(pollUrl);
  await expect(guest).toHaveURL(pollUrl);
  await expect(guest.locator('.name input')).toHaveValue('');
  expect(await guest.evaluate((k) => localStorage.getItem(k), storageKey)).toBeNull();
  await guestContext.close();
});

test('sign-in handle field suggests accounts as you type', async ({ page }) => {
  await page.goto('/login');
  const handle = page.locator('#handle');
  await handle.fill('ali');
  const options = page.getByRole('option');
  // The fake-PDS server answers /api/handles from a fixed roster (handleSearch.ts).
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText('alice.test');
  await expect(handle).toHaveAttribute('aria-expanded', 'true');

  // Keyboard: down twice lands on the second suggestion; Enter picks it without submitting.
  await handle.press('ArrowDown');
  await handle.press('ArrowDown');
  await handle.press('Enter');
  await expect(handle).toHaveValue('alicia.example.com');
  await expect(options).toHaveCount(0);
  await expect(page).toHaveURL(/\/login$/);

  // Escape closes; a query with no match shows nothing.
  await handle.fill('zzz');
  await expect(options).toHaveCount(0);
});

/**
 * A phone paints with a held finger and scrolls with a swipe. Playwright's touchscreen has
 * only `tap`, so the gestures are raw CDP touch events, which makes this Chromium-only —
 * and the mobile project is the only one with a touch screen anyway.
 */
test('touch: a swipe scrolls the grid, a held finger paints it', async ({ page, browser, browserName }) => {
  test.skip(!projectContext().hasTouch || browserName !== 'chromium', 'needs a touch screen and CDP');
  const hostDid = `did:plc:e2etouch${test.info().project.name.replace(/[^a-z0-9]/gi, '')}`;
  await page.goto(`/dev/login?did=${hostDid}`);
  await expect(page.locator('code')).toHaveText(hostDid);
  // Two weeks of days: wider than a phone, so the grid has somewhere to scroll to; a long
  // window, so the page does too.
  const dates = Array.from({ length: 14 }, (_, i) =>
    isoDate(new Date(FIXTURE_BASE.getTime() + i * 24 * 60 * 60 * 1000))).join(',');
  const created = await page.request.post('/polls', {
    form: { title: 'two weeks', dates, windowStart: '09:00', windowEnd: '21:00', slotMinutes: '30', timezone: 'UTC' },
    maxRedirects: 0,
  });
  const pollUrl = created.headers()['location']!;
  expect(pollUrl).toMatch(/\/p\//);

  const { context: guestContext, page: guest } = await newGuest(browser);
  await guest.goto(pollUrl);
  const cells = guest.locator('#grid-root [data-slot]');
  await expect(cells.first()).toBeVisible();
  const grid = guest.locator('#grid-root .grid');
  expect(await grid.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

  const cdp = await guestContext.newCDPSession(guest);
  const swipe = async (from: { x: number; y: number }, to: { x: number; y: number }, holdMs = 0) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    if (holdMs) await guest.waitForTimeout(holdMs);
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
        x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps,
      }] });
      await guest.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const painted = guest.locator('#grid-root .cell.available');
  // Where the page and the grid have scrolled to; a swipe flings, so wait for it to settle
  // before trusting any bounding box measured afterwards.
  const offsets = () => guest.evaluate(() =>
    [window.scrollY, document.querySelector('#grid-root .grid')!.scrollLeft].join(','));
  const settled = async () => {
    await expect.poll(async () => {
      const before = await offsets();
      await guest.waitForTimeout(100);
      return (await offsets()) === before;
    }).toBe(true);
  };

  // A sideways swipe scrolls the grid and paints nothing.
  const box = (await grid.boundingBox())!;
  await swipe({ x: box.x + 300, y: box.y + 200 }, { x: box.x + 60, y: box.y + 200 });
  await expect.poll(() => grid.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await expect(painted).toHaveCount(0);
  await settled();
  // An upward swipe that starts on the grid scrolls the page.
  await swipe({ x: box.x + 200, y: box.y + 300 }, { x: box.x + 200, y: box.y + 100 });
  await expect.poll(() => guest.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await expect(painted).toHaveCount(0);
  await settled();

  // A held finger, dragged two rows down its column, paints those three cells.
  await guest.evaluate(() => window.scrollTo(0, 0));
  await grid.evaluate((el) => { el.scrollLeft = 0; });
  await expect.poll(offsets).toBe('0,0');
  await settled();
  const centre = (b: { x: number; y: number; width: number; height: number }) =>
    ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  await swipe(centre((await cells.nth(0).boundingBox())!), centre((await cells.nth(2).boundingBox())!), 500);
  await expect(painted).toHaveCount(3);
  // A tap toggles a single cell without any hold.
  await guest.touchscreen.tap(...Object.values(centre((await cells.nth(5).boundingBox())!)) as [number, number]);
  await expect(painted).toHaveCount(4);
  await guestContext.close();
});
