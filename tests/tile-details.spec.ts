import { test, expect, type Page } from '@playwright/test';
import { ensureMediaFixtures, musicalVideo, silentVideo } from './fixtures';
import { expectMosaicPreview, readMosaicAssets } from './mosaic-assertions';

const { sources } = readMosaicAssets();

test.beforeAll(ensureMediaFixtures);

async function upload(page: Page, path = musicalVideo) {
  await page.locator('#video-upload').setInputFiles(path);
  await expect(page.locator('#play-toggle')).toBeEnabled();
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-media-time', '0');
  await page.waitForLoadState('networkidle');
}

async function clickTile(page: Page, x = 0.72, y = 0.45) {
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
  const panel = page.locator('#map-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-mode', 'tile');
  await expect(panel).toHaveAttribute('data-source-index', /^\d+$/);
  const index = Number(await panel.getAttribute('data-source-index'));
  expect(sources.some(source => source.index === index), 'Clicked imagery must have source-scene metadata').toBe(true);
  return index;
}

async function expectSourceDetails(page: Page, index: number) {
  const source = sources.find(source => source.index === index)!;
  await expect(page.locator('#panel-title')).toHaveText(source.region.split(' · ')[0]);
  await expect(page.locator('.tile-title')).toHaveText(source.region.split(' · ')[0]);
  await expect(page.locator('.tile-coordinates')).toBeVisible();
  const preview = page.locator('#tile-preview');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('role', 'img');
  await expect(preview).toHaveAttribute('aria-label', new RegExp(source.region));
  return expectMosaicPreview(page, index);
}

test('a paused satellite tile opens its source image and metadata, and selecting another updates the panel', async ({ page }) => {
  // The enlarged picture must use the bundled map photograph even if the remote mosaic is unavailable.
  await page.route('https://tiles.maps.eox.at/**', route => route.abort());
  await page.goto('/');
  await upload(page, silentVideo);
  const canvas = page.locator('#satellite-canvas');
  const screenshotOptions = {
    style: '#player *:not(#satellite-canvas) { visibility: hidden !important; } #satellite-canvas { visibility: visible !important; }',
  };
  const before = await canvas.screenshot(screenshotOptions);
  const initialIndex = await clickTile(page);
  const initialPatch = await expectSourceDetails(page, initialIndex);
  const bounds = (await page.locator('#tile-preview').boundingBox())!;
  expect(bounds.width).toBeGreaterThan(240);
  expect(bounds.height).toBeGreaterThan(240);
  const selected = await canvas.screenshot(screenshotOptions);
  expect(selected.equals(before), 'A paused selection should visibly outline the clicked satellite cell').toBe(false);

  let nextIndex = initialIndex;
  let nextPatch = initialPatch;
  for (const [x, y] of [[0.85, 0.4], [0.65, 0.6], [0.8, 0.55], [0.65, 0.3]]) {
    nextIndex = await clickTile(page, x, y);
    nextPatch = await expectSourceDetails(page, nextIndex);
    if (nextPatch !== initialPatch) break;
  }
  expect(nextPatch, 'Different video colors should resolve to different actual imagery patches').not.toBe(initialPatch);
  await page.screenshot({ path: '/tmp/tile-details-desktop.png' });
  await page.locator('#panel-close').click();
  await expect(page.locator('#map-panel')).toBeHidden();
  expect((await canvas.screenshot(screenshotOptions)).equals(before), 'Closing details removes the selection from the unchanged frame').toBe(true);
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
    .toEqual({ paused: true, time: 0 });
});

test('tile selection, zoom, pan and resize preserve uninterrupted original audio', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    const state = window as typeof window & { tileMedia?: HTMLVideoElement; tileInterruptions?: string[] };
    state.tileMedia = video;
    state.tileInterruptions = [];
    for (const event of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange']) {
      video.addEventListener(event, () => state.tileInterruptions!.push(event));
    }
    return { source: video.currentSrc, time: video.currentTime, volume: video.volume, muted: video.muted };
  });

  await clickTile(page);
  await page.locator('#panel-close').click();
  await page.locator('#zoom-in').click();
  const canvas = page.locator('#satellite-canvas');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.55, { steps: 5 });
  await page.mouse.up();
  await expect(canvas).not.toHaveAttribute('data-pan', '0,0');
  await expect(page.locator('#map-panel')).toBeHidden();
  await page.setViewportSize({ width: 1060, height: 740 });
  const index = await clickTile(page, 0.78, 0.45);
  await expectSourceDetails(page, index);
  await page.keyboard.press('Escape');
  await expect(page.locator('#map-panel')).toBeHidden();

  const after = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    const state = window as typeof window & { tileMedia?: HTMLVideoElement; tileInterruptions?: string[] };
    return { source: video.currentSrc, time: video.currentTime, sameElement: video === state.tileMedia,
      paused: video.paused, rate: video.playbackRate, volume: video.volume, muted: video.muted,
      interruptions: state.tileInterruptions };
  });
  expect(after).toMatchObject({ source: before.source, sameElement: true, paused: false, rate: 1,
    volume: before.volume, muted: before.muted, interruptions: [] });
  expect(after.time).toBeGreaterThan(before.time);
  await expect.poll(() => page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    return Math.abs(video.currentTime - Number(document.querySelector<HTMLElement>('#satellite-canvas')!.dataset.mediaTime));
  })).toBeLessThan(0.2);
});

test('a phone tap opens a large image while close and playback controls stay reachable', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173/');
  await upload(page);
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.touchscreen.tap(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.42);
  await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'tile');
  const preview = page.locator('#tile-preview');
  await expect(preview).toBeVisible();
  const imageBounds = (await preview.boundingBox())!;
  expect(imageBounds.width).toBe(140);
  expect(imageBounds.height).toBe(140);
  expect(imageBounds.x).toBeGreaterThanOrEqual(0);
  expect(imageBounds.x + imageBounds.width).toBeLessThanOrEqual(390);
  expect(imageBounds.y + imageBounds.height).toBeLessThanOrEqual(844);
  await page.locator('#panel-close').click({ trial: true });
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  await page.screenshot({ path: '/tmp/tile-details-mobile.png' });
  await page.locator('#panel-close').click();
  await expect(page.locator('#map-panel')).toBeHidden();
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});
