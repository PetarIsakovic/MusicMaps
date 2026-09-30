import { test, expect, type Page } from '@playwright/test';
import { ensureMediaFixtures, musicalVideo, silentVideo } from './fixtures';
import { expectMosaicPreview, readMosaicAssets, type MosaicMode } from './mosaic-assertions';

type Mode = MosaicMode;
const modes: Mode[] = ['coasts', 'terrain', 'satellite'];
const { sources } = readMosaicAssets();
const canvasScreenshotOptions = {
  style: '#player *:not(#satellite-canvas) { visibility: hidden !important; } #satellite-canvas { visibility: visible !important; }',
};

test.beforeAll(ensureMediaFixtures);

async function upload(page: Page, path = musicalVideo) {
  await page.locator('#video-upload').setInputFiles(path);
  await expect(page.locator('#play-toggle')).toBeEnabled();
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-media-time', '0');
  await page.waitForLoadState('networkidle');
}

async function setRange(page: Page, selector: string, value: number) {
  await page.locator(selector).evaluate((input: HTMLInputElement, nextValue) => {
    input.value = String(nextValue);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function expectMode(page: Page, mode: Mode) {
  await expect(page.locator('#player')).toHaveAttribute('data-imagery-mode', mode);
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-imagery-mode', mode);
  for (const candidate of modes) {
    const buttons = page.locator(`button[data-imagery-mode="${candidate}"]`);
    expect(await buttons.count(), 'The strip and Layers should both offer every imagery type').toBe(2);
    for (const button of await buttons.all()) {
      await expect(button).toHaveAttribute('aria-pressed', String(mode === candidate));
    }
  }
}

async function expectRenderedTime(page: Page, target: number) {
  await expect.poll(async () => Math.abs(Number(await page.locator('#satellite-canvas')
    .getAttribute('data-media-time')) - target)).toBeLessThan(0.1);
}

async function expectTileSource(page: Page, mode: Mode) {
  const panel = page.locator('#map-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-mode', 'tile');
  await expect(panel).toHaveAttribute('data-imagery-mode', mode);
  const index = Number(await panel.getAttribute('data-source-index'));
  const source = sources.find(source => source.index === index)!;
  expect(source, 'The selected image must have a real source scene').toBeDefined();
  expect(source.imageryModes, `The ${mode} selection must use imagery from that landscape group`).toContain(mode);
  await expect(page.locator('#panel-title')).toHaveText(source.region.split(' · ')[0]);
  await expect(page.locator('.tile-title')).toHaveText(source.region.split(' · ')[0]);
  await expect(page.locator('.tile-coordinates')).toBeVisible();
  const preview = page.locator('#tile-preview');
  await expect(preview).toHaveAttribute('data-source-index', String(index));
  await expect(preview).toHaveAttribute('aria-label', new RegExp(source.region));
  await expectMosaicPreview(page, index);
  return index;
}

async function clickTile(page: Page, x = 0.72, y = 0.45) {
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
  await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'tile');
}

test('all three imagery types repaint the same paused frame and restore its exact original pixels', async ({ page }) => {
  await page.goto('/');
  await upload(page, silentVideo);
  await setRange(page, '#seek', 2.5);
  await expectRenderedTime(page, 2.5);
  await expectMode(page, 'satellite');
  const canvas = page.locator('#satellite-canvas');
  const original = await canvas.screenshot(canvasScreenshotOptions);
  const imageryRequests: string[] = [];
  page.on('request', request => {
    if (/satellite-(?:atlas|mosaic|lookup)|sentinel-cogs/.test(request.url())) imageryRequests.push(request.url());
  });

  await page.locator('#mode-coasts').click();
  await expectMode(page, 'coasts');
  const coasts = await canvas.screenshot(canvasScreenshotOptions);
  expect(coasts.equals(original), 'Coasts must change the rendered landscape, not just the controls').toBe(false);
  await page.locator('#mode-terrain').click();
  await expectMode(page, 'terrain');
  const terrain = await canvas.screenshot(canvasScreenshotOptions);
  expect(terrain.equals(coasts)).toBe(false);
  expect(terrain.equals(original)).toBe(false);
  await page.locator('#mode-satellite').click();
  await expectMode(page, 'satellite');
  expect((await canvas.screenshot(canvasScreenshotOptions)).equals(original),
    'Returning to Satellite at the same timestamp must restore the original reconstruction').toBe(true);

  await page.locator('#layers-toggle').click();
  await page.locator('#settings-panel button[data-imagery-mode="coasts"]').click();
  await expectMode(page, 'coasts');
  await page.locator('#settings-close').click();
  expect((await canvas.screenshot(canvasScreenshotOptions)).equals(coasts)).toBe(true);
  expect(imageryRequests, 'Mode changes should reuse the already loaded atlas').toEqual([]);
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
    .toEqual({ paused: true, time: 2.5 });
  await expectRenderedTime(page, 2.5);
});

test('live imagery switching preserves audio, and the chosen type survives view changes, seeking and replacement', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await setRange(page, '#volume', 0.37);
  await page.locator('#source-video').evaluate((video: HTMLVideoElement) => { video.playbackRate = 1.25; });
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    const state = window as typeof window & { imageryMedia?: HTMLVideoElement; imageryInterruptions?: string[] };
    state.imageryMedia = video;
    state.imageryInterruptions = [];
    for (const event of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange']) {
      video.addEventListener(event, () => state.imageryInterruptions!.push(event));
    }
    return { source: video.currentSrc, time: video.currentTime, volume: video.volume, muted: video.muted, rate: video.playbackRate };
  });
  for (const mode of ['coasts', 'terrain', 'satellite', 'terrain'] as const) {
    await page.locator(`#mode-${mode}`).click();
    await expectMode(page, mode);
  }
  await page.setViewportSize({ width: 1060, height: 740 });
  await setRange(page, '#density', 42);
  await page.locator('#fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await expectMode(page, 'terrain');
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

  const after = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    const state = window as typeof window & { imageryMedia?: HTMLVideoElement; imageryInterruptions?: string[] };
    return { source: video.currentSrc, time: video.currentTime, sameElement: video === state.imageryMedia,
      paused: video.paused, rate: video.playbackRate, volume: video.volume, muted: video.muted,
      interruptions: state.imageryInterruptions };
  });
  expect(after).toMatchObject({ source: before.source, sameElement: true, paused: false,
    rate: before.rate, volume: before.volume, muted: before.muted, interruptions: [] });
  expect(after.time).toBeGreaterThan(before.time);
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector<HTMLVideoElement>('#source-video')!.currentTime
    - Number(document.querySelector<HTMLElement>('#satellite-canvas')!.dataset.mediaTime)))).toBeLessThan(0.2);

  await page.locator('#play-toggle').click();
  await setRange(page, '#seek', 5.25);
  await expectRenderedTime(page, 5.25);
  await expectMode(page, 'terrain');
  await upload(page, silentVideo);
  await expectMode(page, 'terrain');
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentSrc)).not.toBe(before.source);
});

test('an open tile follows its active imagery source and new picks use the selected landscape type', async ({ page }) => {
  await page.route('https://sentinel-cogs.s3.us-west-2.amazonaws.com/**', route => route.abort());
  await page.goto('/');
  await upload(page, silentVideo);
  await clickTile(page);
  const original = await expectTileSource(page, 'satellite');
  for (const mode of modes) {
    await page.locator(`#mode-${mode}`).click();
    await expectMode(page, mode);
    const index = await expectTileSource(page, mode);
    if (mode === 'satellite') expect(index, 'The same selected cell must restore its original satellite source').toBe(original);
  }
  for (const mode of modes) {
    await page.locator(`#mode-${mode}`).click();
    for (const [x, y] of [[0.8, 0.34], [0.65, 0.55], [0.85, 0.62]]) {
      await clickTile(page, x, y);
      await expectTileSource(page, mode);
    }
  }
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
    .toEqual({ paused: true, time: 0 });
});

test('phone users can tap every imagery thumbnail while tile details and playback stay open', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5173/');
  await page.locator('#mode-coasts').tap();
  await expectMode(page, 'coasts');
  await upload(page);
  await expectMode(page, 'coasts');
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.touchscreen.tap(bounds.x + bounds.width * 0.6, bounds.y + bounds.height * 0.42);
  await expectTileSource(page, 'coasts');
  for (const mode of ['terrain', 'satellite', 'coasts'] as const) {
    const button = page.locator(`#mode-${mode}`);
    await expect(button).toBeVisible();
    const buttonBounds = (await button.boundingBox())!;
    expect(buttonBounds.x).toBeGreaterThanOrEqual(0);
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(390);
    expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(844);
    await button.tap();
    await expectMode(page, mode);
    await expectTileSource(page, mode);
  }
  await page.locator('#play-toggle').tap();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0.2);
  await page.locator('#mode-terrain').tap();
  await expectMode(page, 'terrain');
  await expectTileSource(page, 'terrain');
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.paused)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/maps-imagery-mobile.png' });
  await context.close();
});
