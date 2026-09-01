import { test, expect, type Page } from '@playwright/test';

/**
 * Click one day in the calendar island, paging forward until its cell exists. The island
 * mounts on today's month, so a date a few months out needs a few hops; 12 is a year, past
 * which the date is wrong rather than far away.
 */
async function pickDate(page: Page, iso: string): Promise<void> {
  for (let hop = 0; hop < 12; hop++) {
    const day = page.locator(`button[data-date="${iso}"]`);
    if (await day.count()) { await day.click(); return; }
    await page.click('button.cal-next');
  }
  throw new Error(`date ${iso} not reachable in calendar`);
}

/** Fill the create form the landing page shows to a signed-in host, and submit it. */
async function createPoll(page: Page, fields: {
  title: string; dates: string; windowStart: string; windowEnd: string; slotMinutes: string;
}): Promise<string> {
  await page.fill('input[name=title]', fields.title);
  for (const d of fields.dates.split(',')) await pickDate(page, d);
  await page.fill('input[name=windowStart]', fields.windowStart);
  await page.fill('input[name=windowEnd]', fields.windowEnd);
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
    dates: '2026-09-02,2026-09-03',
    windowStart: '17:00',
    windowEnd: '19:00',
    slotMinutes: '60',
  });

  // guest responds in a clean context: drag-paint two cells, name, save
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(pollUrl);
  const cells = guest.locator('[data-slot]');
  await expect(cells.first()).toBeVisible();
  const a = (await cells.nth(0).boundingBox())!;
  const b = (await cells.nth(1).boundingBox())!;
  await guest.mouse.move(a.x + 5, a.y + 5);
  await guest.mouse.down();
  await guest.mouse.move(b.x + 5, b.y + 5);
  await guest.mouse.up();
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
    dates: '2026-09-02',
    windowStart: '17:00',
    windowEnd: '18:00',
    slotMinutes: '30',
  });

  // A signed-in viewer posts to /respond-auth and is never offered a name or an edit link,
  // so the guest half of this flow needs its own cookie-free context.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(pollUrl);
  await guest.locator('[data-slot]').first().click();
  await guest.fill('.name input', 'Ana');
  await guest.click('button.save');
  const editLink = await guest.locator('.edit-link code').textContent();
  expect(editLink).toBeTruthy();

  await guest.goto(editLink!);
  await expect(guest.locator('.name input')).toHaveValue('Ana');
  await expect(guest.locator('.cell.available')).toHaveCount(1);
  await guestContext.close();
});
