import { test, expect, type Page, type Route } from '@playwright/test';
import { ensureMediaFixtures, musicalVideo } from './fixtures';
import { expectMosaicPreview, mosaicAtlasPages, readMosaicAssets } from './mosaic-assertions';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const { mosaic } = readMosaicAssets();
const previewPaths = new Set(mosaic.patches.map(patch => patch.previewUrl));
const nativePhotoURL = (url: URL) => previewPaths.has(url.pathname);
const clarityVideo = resolve('tests/.fixtures/test-clarity.mp4');
test.beforeAll(() => {
  ensureMediaFixtures();
  if (!existsSync(clarityVideo)) execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '3', '-i', musicalVideo,
    '-t', '32', '-c', 'copy', clarityVideo,
  ]);
});

async function openTile(page: Page) {
  await page.goto('/');
  await page.locator('#video-upload').setInputFiles(clarityVideo);
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-imagery-resolution', '64');
  await expect(page.locator('#play-toggle')).toBeEnabled();
  const b = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.mouse.click(b.x + b.width * .72, b.y + b.height * .45);
  await expect(page.locator('#tile-preview')).toBeVisible();
}

test('individual images use their native full-scene pixels without cover cropping', async ({ page }) => {
  await openTile(page);
  const preview = page.locator('#tile-preview');
  await expect(preview).toHaveAttribute('data-quality', 'native');
  const patchId = Number(await preview.getAttribute('data-patch-index'));
  const patch = mosaic.patches[patchId];
  const photo = preview.locator('img');
  await expect(photo).toHaveAttribute('src', patch.previewUrl);
  const display = await photo.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth, height: image.naturalHeight, fit: getComputedStyle(image).objectFit,
  }));
  expect(display).toEqual({ width: patch.previewWidth, height: patch.previewHeight, fit: 'contain' });
  expect(display.width).toBeGreaterThanOrEqual(256);
  expect(display.width).toBeGreaterThanOrEqual(mosaic.layout.tileSize * 4);
  const photoBounds = (await photo.boundingBox())!;
  const previewBounds = (await preview.boundingBox())!;
  expect(photoBounds.width).toBeCloseTo(previewBounds.width, 0);
  expect(photoBounds.height).toBeCloseTo(previewBounds.height, 0);
  const panelBounds = (await page.locator('#map-panel').boundingBox())!;
  const detailBounds = (await page.locator('#detail-density').boundingBox())!;
  expect(panelBounds.y + panelBounds.height, 'Tile details must leave the detail slider unobstructed').toBeLessThan(detailBounds.y);
  await page.screenshot({ path: '/tmp/musicmaps-sharp-preview.png' });
});

test('late detail images cannot overwrite a newer tile, and missing images retain the atlas fallback', async ({ page }) => {
  let held: Route | undefined;
  let firstUrl = '';
  await page.route(nativePhotoURL, async route => {
    if (!held) { held = route; firstUrl = route.request().url(); return; }
    await route.continue();
  });
  await openTile(page);
  await expect(page.locator('#tile-preview')).toHaveAttribute('data-quality', 'loading');
  const oldPatch = await page.locator('#tile-preview').getAttribute('data-patch-index');
  // An image may legitimately belong to multiple imagery modes. Select a
  // different visible cell instead of assuming a mode switch changes its ID.
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  for (const [x,y] of [[.43,.3],[.9,.2],[.55,.5],[.4,.7]]) {
    await page.mouse.click(bounds.x + bounds.width*x, bounds.y + bounds.height*y);
    await page.waitForFunction(() => document.querySelector('#tile-preview')?.getAttribute('data-patch-index')
      === document.querySelector('#map-panel')?.getAttribute('data-patch-index'));
    if (await page.locator('#tile-preview').getAttribute('data-patch-index') !== oldPatch) break;
  }
  await expect(page.locator('#tile-preview')).not.toHaveAttribute('data-patch-index', oldPatch!);
  await expect(page.locator('#tile-preview')).toHaveAttribute('data-quality', 'native');
  const newPatch = await page.locator('#tile-preview').getAttribute('data-patch-index');
  await held!.fulfill({ response: await held!.fetch() });
  await expect(page.locator('#tile-preview')).toHaveAttribute('data-patch-index', newPatch!);
  expect(await page.locator('#tile-preview img').evaluate((image: HTMLImageElement) => image.currentSrc)).not.toBe(firstUrl);

  await page.unroute(nativePhotoURL);
  await page.route(nativePhotoURL, route => route.abort());
  await openTile(page);
  await expect(page.locator('#tile-preview')).toHaveAttribute('data-quality', 'fallback');
  await expect(page.locator('#tile-preview img')).toHaveCount(0);
  await expect(page.locator('#tile-preview')).toBeVisible();
  const patchId = Number(await page.locator('#tile-preview').getAttribute('data-patch-index'));
  await expectMosaicPreview(page, mosaic.patches[patchId].sourceIndex);
});

test('native-image failures retain the correct atlas photograph across page boundaries', async ({ page }) => {
  await page.route(nativePhotoURL, route => route.abort());
  await page.goto('/');
  const boundaries: number[] = [];
  let first = 0;
  for (const atlas of mosaicAtlasPages(mosaic)) {
    const count = atlas.columns * atlas.rows;
    boundaries.push(first, Math.min(first + count, mosaic.patches.length) - 1);
    first += count;
  }
  for (const patchIndex of boundaries) {
    await page.evaluate(async index => {
      const moduleURL = '/src/tile-details.ts';
      const { buildTileDetails } = await import(moduleURL);
      const library = await (await fetch('/satellite-mosaic.json')).json();
      const { sources } = await (await fetch(library.sourceManifest)).json();
      const patch = library.patches[index];
      const source = sources.find((candidate: { index: number }) => candidate.index === patch.sourceIndex);
      document.querySelector('#panel-content')!.replaceChildren(buildTileDetails(source, 'satellite', () => {}, { library, patch }));
      (document.querySelector('#map-panel') as HTMLElement).hidden = false;
    }, patchIndex);
    await expect(page.locator('#tile-preview')).toHaveAttribute('data-quality', 'fallback');
    await expect(page.locator('#tile-preview img')).toHaveCount(0);
    expect(await expectMosaicPreview(page, mosaic.patches[patchIndex].sourceIndex)).toBe(patchIndex);
  }
});

test('zoom loads sharper scene textures only when needed, without interrupting original audio', async ({ page }) => {
  let pending: Route | undefined;
  const requests: string[] = [];
  let releaseDownloads = false;
  let holdDetail = false;
  await page.route(nativePhotoURL, route => {
    requests.push(new URL(route.request().url()).pathname);
    if (!holdDetail) return route.continue();
    if (releaseDownloads) return route.continue();
    pending = route;
  });
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { value: 8 }));
  await openTile(page);
  await page.locator('#panel-close').click();
  requests.length = 0;
  expect(requests).toHaveLength(0);
  const supported = await page.locator('#satellite-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl')!;
    return gl.getParameter(gl.MAX_TEXTURE_SIZE) >= 8192;
  });
  test.skip(!supported, 'This GPU retains the base atlas when its texture limit is below 8192.');
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(.2);
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    Object.assign(window, { clarityVideo: video, clarityInterruptions: [] });
    for (const event of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange'])
      video.addEventListener(event, () => (window as any).clarityInterruptions.push(event));
    return { time: video.currentTime, source: video.currentSrc };
  });
  await page.locator('#layers-toggle').click();
  await page.locator('#density').evaluate((input: HTMLInputElement) => {
    input.value = '24'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#settings-close').click();
  holdDetail = true;
  requests.length = 0;
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-detail-quality', 'loading');
  await expect.poll(() => !!pending).toBe(true);
  expect(previewPaths.has(new URL(pending!.request().url()).pathname)).toBe(true);
  // Camera changes during the held request may focus another page. Let that
  // latest requested page finish as well; ordinary media frames must not churn.
  releaseDownloads = true;
  await pending!.fulfill({ response: await pending!.fetch() });
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-imagery-resolution', '256');
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-detail-quality', 'ready');
  expect(await page.locator('#satellite-canvas').getAttribute('data-detail-page')).not.toBe('-1');
  const after = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    return { same: video === (window as any).clarityVideo, source: video.currentSrc, time: video.currentTime,
      paused: video.paused, interruptions: (window as any).clarityInterruptions };
  });
  expect(after).toMatchObject({ same: true, source: before.source, paused: false, interruptions: [] });
  expect(after.time).toBeGreaterThan(before.time);
  const settledRequests = requests.length;
  expect(settledRequests).toBeLessThanOrEqual(2);
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(after.time + .3);
  expect(requests).toHaveLength(settledRequests);
});

test('an unavailable sharper atlas leaves the current image and media source intact', async ({ page }) => {
  await page.route(nativePhotoURL, route => route.abort());
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { value: 8 }));
  await openTile(page);
  await page.locator('#panel-close').click();
  await page.locator('#layers-toggle').click();
  await page.locator('#density').evaluate((input: HTMLInputElement) => {
    input.value = '24'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#settings-close').click();
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-detail-quality', 'unavailable');
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-imagery-resolution', '64');
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ time: video.currentTime, paused: video.paused }))).toEqual({ time: 0, paused: true });
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(.2);
});
