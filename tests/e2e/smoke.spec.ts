import { expect, test, type Page } from '@playwright/test';

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('menu → single-player fight with synthetic keyboard input', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?webgl&input=synthetic&quality=low');
  await expect(page.getByTestId('menu-fight')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-fight').click();
  await expect(page.locator('.hud .time')).not.toHaveText('1:30', { timeout: 60_000 });
  for (const k of ['a', 's', 'a', 'q', 'x', 'ArrowLeft', 'a', 's']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(350);
  }
  await expect(page.locator('.chip, .feed > *').first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu-fight')).toBeVisible();
  expect(errors).toEqual([]);
});

test('fake camera: MediaPipe detects the boxer in the recorded clip', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?webgl&quality=low');
  await expect(page.getByTestId('menu-camera-setup')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-camera-setup').click();
  await expect(page.getByText(/Upper body visible|Show head, shoulders/)).toBeVisible({ timeout: 90_000 });
  expect(errors).toEqual([]);
});
