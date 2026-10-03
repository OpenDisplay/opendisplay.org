// Every URL the site has ever published must keep working. legacy-urls.json is the
// list as of the start of the SvelteKit port; entries are only ever added.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const urls = JSON.parse(readFileSync(new URL('./legacy-urls.json', import.meta.url), 'utf8'));

for (const url of urls) {
  test(`${url} loads`, async ({ request }) => {
    const res = await request.get(url);
    expect(res.status(), url).toBe(200);
    expect(await res.text()).toMatch(/<title>[^<]+<\/title>/);
  });
}

// Firmware and py-opendisplay put https://opendisplay.org/l/?<base64url payload> in the
// QR code on the display. Payload: tag_type u16, 3-byte device id, 16-byte key,
// manufacturer u16 (see py-opendisplay landing.py). This one is device OD A1B2C3.
test('a device QR link opens the landing page for that device', async ({ page }) => {
  await page.goto('/l/?AAGhssMAAAAAAAAAAAAAAAAAAAAAAAE');
  await expect(page.locator('#out-name')).toHaveText('ODA1B2C3');
});

// Every moved page redirects, keeping the query string and #hash.
const { REDIRECTS } = await import('../../src/lib/redirects.js');
for (const [from, to] of Object.entries(REDIRECTS)) {
  test(`${from} redirects to ${to}`, async ({ page }) => {
    await page.goto(`${from}?ref=readme#top`);
    await expect(page).toHaveURL(`${to}?ref=readme#top`);
    await expect(page.locator('h1')).toBeVisible();
  });
}

// On a short page the footer starts below the fold, not in the middle of the screen.
test('the footer of a short page sits below the fold', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.goto('/impressum/');
  const top = await page.locator('footer').evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(1600);
});
