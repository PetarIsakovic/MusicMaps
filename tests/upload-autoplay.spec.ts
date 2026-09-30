import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ensureMediaFixtures, musicalVideo } from './fixtures';

// Exercise the normal browser policy, without the suite's autoplay bypass.
test.use({ launchOptions: {
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [],
} });
test.beforeAll(ensureMediaFixtures);

async function expectPlaying(page: Page) {
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) =>
    !video.paused && !video.muted && video.volume > 0 && video.currentTime > 0.1)).toBe(true);
}

test('choosing an upload starts playback with audio without pressing Play', async ({ page }) => {
  await page.goto('/');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#upload-button').click();
  await (await chooser).setFiles(musicalVideo);
  await expectPlaying(page);
});

test('dropping a video starts playback without pressing Play', async ({ page }) => {
  await page.goto('/');
  // Establish user activation, as a real pointer drag does.
  await page.locator('#map-search').click();
  const transfer = await page.evaluateHandle(bytes => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], 'Dropped video.mp4', { type: 'video/mp4' }));
    return data;
  }, [...readFileSync(musicalVideo)]);
  await page.locator('body').dispatchEvent('drop', { dataTransfer: transfer });
  await expectPlaying(page);
});
