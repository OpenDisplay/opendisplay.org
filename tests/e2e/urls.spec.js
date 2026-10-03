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
