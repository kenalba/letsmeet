import { test, expect, type Page } from '@playwright/test';
import { FIXTURE_DATE_1, pickDate, setTime, createPoll } from './helpers.js';

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

  // Claim a name of our own (one per project, so the four runs never contend for it).
  const name = `e2e-${test.info().project.name.replace(/[^a-z0-9-]/gi, '')}`;
  await page.fill('#availability-root input[name=alias]', name);
  await expect(page.locator('#availability-root .address-line'))
    .toHaveText(`your address: ${name}.sez.localhost:8787 (not saved yet)`);

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
  await expect(page.locator('#availability-root .address-line'))
    .toHaveText(`your address: ${name}.sez.localhost:8787`);

  // Reload keeps it.
  await page.reload();
  await expect(page.locator('#availability-root .cell.available')).toHaveCount(2);
  await expect(page.locator('#availability-root .away li')).toContainText('out of town');

  // The public page reads the same record.
  await page.goto(`/u/${did}`);
  await expect(page.getByText('usually free sundays 7am to 8am.')).toBeVisible();
  await expect(page.getByText('out of town')).toBeVisible();

  // The week grid: sunday 7am is the one free cell in the week containing today; the away
  // date is at least two weeks out, so it reads on the "away later" line. Next week is a
  // link, and one past that is the poll prompt.
  await expect(page.locator('.week-cell')).toHaveCount(7 * 17);
  await expect(page.locator('.week-cell.free')).toHaveCount(1);
  await expect(page.getByText('away later:')).toBeVisible();
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
  expect(await alias.text()).toContain('usually free sundays 7am to 8am.');
  const aliasIcs = await page.request.get('/availability.ics', { headers: { host: aliasHost } });
  expect(aliasIcs.headers()['content-type']).toContain('text/calendar');
  expect((await page.request.get('/new', { headers: { host: aliasHost } })).status()).toBe(404);

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
