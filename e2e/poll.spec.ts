import { test, expect } from '@playwright/test';
import {
  projectContext, newGuest, isoDate, FIXTURE_BASE, FIXTURE_DATE_1, FIXTURE_DATE_2,
  pickDate, setTime, createPoll,
} from './helpers.js';

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
  // Hovering Sam's chip spotlights the two cells Sam painted; a click pins the spotlight
  // so it survives the pointer leaving, and a second click lets go.
  const chip = page.locator('.chip[data-who="Sam"]');
  await chip.hover();
  await expect(page.locator('.cell.lit')).toHaveCount(2);
  await page.mouse.move(0, 0);
  await expect(page.locator('.cell.lit')).toHaveCount(0);
  await chip.click();
  await page.mouse.move(0, 0);
  await expect(page.locator('.cell.lit')).toHaveCount(2);
  await chip.click();
  await expect(page.locator('.cell.lit')).toHaveCount(0);
  await page.locator('form[action$="/finalize"] button').first().click();
  await expect(page.getByText(/happening|decided|finalized/i)).toBeVisible();
  await expect(page.locator('a.ics[href$="/ics"]')).toBeVisible();
  // Deciding hides nothing: the grid is still there, locked, with the pick ringed and
  // Sam's chip still listed.
  await expect(page.locator('#grid-root .grid.readonly')).toBeVisible();
  await expect(page.locator('.cell.chosen')).toHaveCount(1);
  const picked = await page.locator('.cell.chosen').getAttribute('data-slot');
  await expect(page.locator('.responders').getByText('Sam')).toBeVisible();

  // The host changes their mind: the second-ranked slot becomes the pick instead.
  await page.locator('form[action$="/finalize"] button').first().click();
  await expect(page.locator('.cell.chosen')).toHaveCount(1);
  expect(await page.locator('.cell.chosen').getAttribute('data-slot')).not.toBe(picked);

  // ...then undoes the decision altogether: painting is back on, nothing is picked.
  await page.locator('form[action$="/reopen"] button').click();
  await expect(page.getByText(/happening/i)).toHaveCount(0);
  await expect(page.locator('.cell.chosen')).toHaveCount(0);
  await expect(page.locator('#grid-root .grid:not(.readonly)')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'pick the winner' })).toBeVisible();

  // ...and freezes the tally without deciding, then reopens once more.
  await page.locator('form[action$="/close"] button').click();
  await expect(page.getByText('responses are closed')).toBeVisible();
  await expect(page.locator('#grid-root .grid.readonly')).toBeVisible();
  await page.locator('form[action$="/reopen"] button').click();
  await expect(page.locator('#grid-root .grid:not(.readonly)')).toBeVisible();
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

/**
 * A guest picks how to answer with the toggle at the name field: a name, or the same
 * sign-in as the login page, inline. "sign in & save" carries the paint across the trip
 * (stashed for the tab on the way out) and finishes the save on the way back in.
 */
test('a guest can sign in at the name field and the paint is saved on return', async ({ page, browser }) => {
  const suffix = test.info().project.name.replace(/[^a-z0-9]/gi, '');
  await page.goto(`/dev/login?did=did:plc:e2efork${suffix}`);
  const pollUrl = await createPoll(page, {
    title: 'Fork test', dates: FIXTURE_DATE_1, windowStart: '17:00', windowEnd: '18:00', slotMinutes: '30',
  });

  const { context: guestContext, page: guest } = await newGuest(browser);
  await guest.goto(pollUrl);
  const cells = guest.locator('#grid-root [data-slot]');
  await cells.nth(0).click();
  await cells.nth(1).click();
  await expect(guest.locator('.cell.available')).toHaveCount(2);
  // Guest by default; a typed name survives a round trip through the other side.
  await guest.fill('.name input', 'Ana');
  const toggle = (id: string) => guest.locator('.whoami .modes button', { hasText: id });
  await expect(toggle('guest')).toHaveAttribute('aria-pressed', 'true');
  await toggle('bluesky').click();
  await expect(guest.locator('.name input')).toHaveCount(0);
  await expect(guest.locator('button.save', { hasText: 'save availability' })).toHaveCount(0);
  await toggle('guest').click();
  await expect(guest.locator('.name input')).toHaveValue('Ana');
  // The inline field is the login page's: same suggestions (the fake roster), same route.
  await toggle('bluesky').click();
  const handle = guest.locator('#handle');
  const signIn = guest.locator('form.handle button[type=submit]');
  await handle.fill('ali');
  // Not a handle yet: nothing to submit. Picking a suggestion makes it one.
  await expect(signIn).toBeDisabled();
  await expect(guest.getByRole('option').first()).toBeVisible();
  await guest.keyboard.press('ArrowDown');
  await guest.keyboard.press('Enter');
  await expect(handle).toHaveValue(/\./);
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(guest).toHaveURL(/\/login/);
  // The fake PDS signs in through /dev/login; coming back is a plain visit to the poll,
  // where the paint is already saved: no name field, no save button to press.
  await guest.goto(`/dev/login?did=did:plc:e2eforkguest${suffix}`);
  await guest.goto(pollUrl);
  await expect(guest.getByText('response stored')).toBeVisible();
  await expect(guest.locator('.whoami')).toHaveCount(0);
  await expect(guest.locator('.cell.available')).toHaveCount(2);
  // Read once, then gone: after the reload the saved answer is what shows, quietly.
  await expect(guest.locator('button.save')).toBeDisabled({ timeout: 10_000 });
  await expect(guest.locator('.cell.available')).toHaveCount(2);
  await expect(guest.getByText('your marks from before signing in')).toHaveCount(0);
  await guestContext.close();
});
