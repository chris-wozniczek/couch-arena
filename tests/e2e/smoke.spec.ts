import { expect, test, type Page } from '@playwright/test';

/** Minimal view of the debug handle `main.ts` exposes on `window`. */
interface ArenaWindow {
  couchArena: { mode?: { player?: { stats: { thrown: number } } } };
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('menu → single-player fight with synthetic keyboard input', async ({ page }) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  await page.goto('/?webgl&input=synthetic&quality=low&maxfps=4');
  await expect(page.getByTestId('menu-fight')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-fight').click();
  await expect(page.locator('.hud .time')).not.toHaveText('1:30', { timeout: 60_000 });
  const thrown = () =>
    page.evaluate(() => (window as unknown as ArenaWindow).couchArena.mode?.player?.stats.thrown ?? 0);
  const keys = ['a', 's', 'q', 'x', 'ArrowLeft', 'w', 'z'];
  for (let i = 0; i < 40 && (await thrown()) === 0; i++) {
    await page.keyboard.press(keys[i % keys.length]!);
    await page.waitForTimeout(600);
  }
  expect(await thrown()).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('menu-fight')).toBeVisible();
  expect(errors).toEqual([]);
});

test('fake camera: MediaPipe detects the boxer in the recorded clip', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/?webgl&quality=low&maxfps=4');
  await expect(page.getByTestId('menu-camera-setup')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('menu-camera-setup').click();
  await expect(page.getByText(/Upper body visible|Show head, shoulders/)).toBeVisible({ timeout: 90_000 });
  expect(errors).toEqual([]);
});
