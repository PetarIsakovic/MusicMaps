import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureMediaFixtures, musicalVideo } from './fixtures';
import { readMosaicAssets } from './mosaic-assertions';

const { mosaic, sources } = readMosaicAssets();

const longVideo = resolve('tests/.fixtures/test-location.mp4');
test.beforeAll(() => {
  ensureMediaFixtures();
  if (!existsSync(longVideo)) execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '3', '-i', musicalVideo,
    '-t', '32', '-c', 'copy', longVideo,
  ]);
});

async function open(page: Page) {
  await page.route('https://earth-search.aws.element84.com/**', route => route.abort());
  await page.addInitScript(() => {
    const readPixels = WebGLRenderingContext.prototype.readPixels;
    (window as any).pegmanReadbacks = 0;
    WebGLRenderingContext.prototype.readPixels = function (...args: Parameters<typeof readPixels>) {
      if ((this.canvas as HTMLCanvasElement).id === 'satellite-canvas') (window as any).pegmanReadbacks++;
      return readPixels.apply(this, args);
    };
  });
  await page.goto('/');
  await page.locator('#video-upload').setInputFiles(longVideo);
  await page.waitForFunction(() => document.querySelector<HTMLVideoElement>('#source-video')!.readyState >= 2);
  await page.locator('#source-video').evaluate((video: HTMLVideoElement) => { video.pause(); video.currentTime = 0; });
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-media-time', '0');
  await expect(page.locator('#play-toggle')).toBeEnabled();
}

async function dock(page: Page) {
  const bounds = (await page.locator('#streetview-toggle').boundingBox())!;
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
async function target(page: Page) {
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  return { x: Math.round(bounds.x + bounds.width * .73), y: Math.round(bounds.y + bounds.height * .43) };
}
// A drop must select exactly where a normal click would, without an offset.
async function aim(page: Page, point: { x: number; y: number }, steps = 12) {
  await page.mouse.move(point.x, point.y, { steps });
}
async function start(page: Page, point: { x: number; y: number }) {
  const home = await dock(page);
  await page.mouse.move(home.x, home.y);
  await page.mouse.down();
  await aim(page, point);
  await expect(page.locator('#pegman-drag')).toHaveAttribute('data-phase', 'drag');
  await expect(page.locator('#pegman-drag .pegman-figure')).toBeVisible();
}

async function expectLocation(page: Page, expectedSource?: string) {
  const map = page.locator('#location-map');
  await expect(page.locator('#location-view')).toBeVisible();
  await expect(page.locator('#location-banner')).toBeVisible();
  await expect(map).toHaveAttribute('data-location-state', 'ready');
  await expect(page.locator('#map-panel')).toBeHidden();
  if (expectedSource !== undefined) await expect(map).toHaveAttribute('data-source-index', expectedSource);
  const index = Number(await map.getAttribute('data-source-index'));
  const source = sources.find(source => source.index === index)!;
  const patch = mosaic.patches.find(patch => patch.sourceIndex === index)!;
  await expect(page.locator('#location-title')).toHaveText(source.region.split(' · ')[0]);
  await expect(page.locator('#location-photo img')).toHaveAttribute('src', patch.previewUrl);
  const { x, y, z } = source.mapTile;
  const longitude = (x + .5) / 2 ** z * 360 - 180;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + .5) / 2 ** z))) * 180 / Math.PI;
  expect(Number(await map.getAttribute('data-photo-latitude'))).toBeCloseTo(latitude, 5);
  expect(Number(await map.getAttribute('data-photo-longitude'))).toBeCloseTo(longitude, 5);
}

test('a drop opens the same zoomed tile on the world map, with no picking during movement', async ({ page }) => {
  await open(page);
  await page.locator('#zoom-in').click();
  const point = await target(page);
  await page.mouse.click(point.x, point.y);
  const panel = page.locator('#map-panel');
  await expect(panel).toHaveAttribute('data-mode', 'tile');
  const selected = await panel.evaluate(e => ({ source: e.dataset.sourceIndex, patch: e.dataset.patchIndex }));
  await page.locator('#panel-close').click();
  const camera = await page.locator('#satellite-canvas').evaluate(e => ({ zoom: e.dataset.zoom, pan: e.dataset.pan }));
  await page.evaluate(() => { (window as any).pegmanReadbacks = 0; });
  await start(page, point);
  await expect(page.locator('#pegman-drag')).toHaveAttribute('data-valid', 'true');
  const marker = (await page.locator('.pegman-target').boundingBox())!;
  expect(marker.x + marker.width / 2).toBeCloseTo(point.x, 0);
  expect(marker.y + marker.height / 2).toBeCloseTo(point.y, 0);
  expect(await page.evaluate(() => (window as any).pegmanReadbacks)).toBe(0);
  await page.screenshot({ path: '/tmp/musicmaps-pegman-drag.png' });
  await page.mouse.up();
  await expectLocation(page, selected.source);
  await page.screenshot({ path: '/tmp/musicmaps-pegman-location.png' });
  await expect(page.locator('#pegman-drag .pegman-figure')).toBeHidden();
  expect(await page.evaluate(() => (window as any).pegmanReadbacks)).toBe(1);
  expect(await page.locator('#satellite-canvas').evaluate(e => ({ zoom: e.dataset.zoom, pan: e.dataset.pan }))).toEqual(camera);
  expect(await page.locator('#source-video').evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime })))
    .toEqual({ paused: true, time: 0 });
});

test('click and drop agree after panning and near the lower canvas edge', async ({ page }) => {
  await open(page);
  await page.locator('#zoom-in').click({ clickCount: 2 });
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .6, bounds.height * .5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .6 + 100, bounds.height * .5 - 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('#satellite-canvas')).not.toHaveAttribute('data-pan', '0,0');
  const points = [await target(page), { x: bounds.x + bounds.width * .15, y: bounds.y + bounds.height - 36 }];
  const picked: string[] = [];
  for (const point of points) {
    expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.id, point)).toBe('satellite-canvas');
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'tile');
    const source = (await page.locator('#map-panel').getAttribute('data-source-index'))!;
    picked.push(source);
    await page.locator('#panel-close').click();
    await start(page, point);
    await expect(page.locator('#pegman-drag')).toHaveAttribute('data-valid', 'true');
    await page.mouse.up();
    await expectLocation(page, source);
    await page.locator('#back-to-video').click();
  }
  expect(new Set(picked).size).toBe(2);
});

test('invalid drops, Escape and pointer cancellation restore the dock without opening a tile', async ({ page }) => {
  await open(page);
  const point = await target(page);
  for (const reason of ['control', 'escape', 'cancel', 'blur']) {
    await start(page, point);
    if (reason === 'control') {
      const search = (await page.locator('#map-search').boundingBox())!;
      await aim(page, { x: search.x + 20, y: search.y + 15 });
      await expect(page.locator('#pegman-drag')).toHaveAttribute('data-valid', 'false');
    } else if (reason === 'escape') await page.keyboard.press('Escape');
    else if (reason === 'cancel') {
      await page.locator('#streetview-toggle').evaluate(button => button.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    } else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await expect(page.locator('#pegman-drag .pegman-figure')).toBeHidden();
    await expect(page.locator('#player')).not.toHaveClass(/is-dragging-pegman/);
    await expect(page.locator('#streetview-toggle')).not.toHaveClass(/pegman-away/);
    await expect(page.locator('#map-panel')).toBeHidden();
    await expect(page.locator('#location-view')).toBeHidden();
  }
  // A click and keyboard activation retain the existing imagery gallery.
  await page.locator('#streetview-toggle').click();
  await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'gallery');
  await page.locator('#panel-close').click();
  await page.locator('#streetview-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'gallery');
});

test('the original hanging poses trail both directions and settle upright at the drop marker', async ({ page }) => {
  await open(page);
  await start(page, await target(page));
  const flyer = page.locator('#pegman-drag');
  await expect(flyer).toHaveAttribute('data-pose', '8');
  await flyer.evaluate(element => {
    (window as any).pegmanPoses = [];
    new MutationObserver(() => (window as any).pegmanPoses.push(Number((element as HTMLElement).dataset.pose)))
      .observe(element, { attributes: true, attributeFilter: ['data-pose'] });
  });
  await aim(page, { x: 320, y: 400 }, 24);
  await expect.poll(() => page.evaluate(() => (window as any).pegmanPoses.some((pose: number) => pose >= 10))).toBe(true);
  await aim(page, { x: 1000, y: 400 }, 24);
  await expect.poll(() => page.evaluate(() => (window as any).pegmanPoses.some((pose: number) => pose <= 6))).toBe(true);
  await expect(flyer).toHaveAttribute('data-pose', '8');
  const poses: number[] = await page.evaluate(() => (window as any).pegmanPoses);
  expect(poses.every(pose => pose >= 0 && pose <= 16)).toBe(true);
  const marker = (await page.locator('.pegman-target').boundingBox())!;
  expect(marker.x + marker.width / 2).toBeCloseTo(1000, 0);
  expect(marker.y + marker.height / 2).toBeCloseTo(400, 0);
  await page.mouse.up();
  await expectLocation(page);
  await expect(flyer.locator('.pegman-figure')).toBeHidden();
});

test('dragging during playback and resize never changes the media source, clock or camera', async ({ page }) => {
  await open(page);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    Object.assign(window, { pegmanVideo: video, pegmanInterruptions: [] });
    for (const type of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange'])
      video.addEventListener(type, () => (window as any).pegmanInterruptions.push(type));
    return { time: video.currentTime, source: video.currentSrc };
  });
  await start(page, await target(page));
  await page.setViewportSize({ width: 1050, height: 750 });
  const point = await target(page);
  await aim(page, point);
  await page.mouse.up();
  await expectLocation(page);
  const after = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    return { time: video.currentTime, source: video.currentSrc, same: video === (window as any).pegmanVideo,
      paused: video.paused, rate: video.playbackRate, interruptions: (window as any).pegmanInterruptions,
      pan: document.querySelector<HTMLElement>('#satellite-canvas')!.dataset.pan };
  });
  expect(after).toMatchObject({ source: before.source, same: true, paused: false, rate: 1, interruptions: [], pan: '0,0' });
  expect(after.time).toBeGreaterThan(before.time + .2);
});

test('touch dragging works on a phone and reduced motion skips decorative animation', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const home = await dock(page);
  const point = await target(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: home.x, y: home.y, id: 7 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y, id: 7 }] });
  await expect(page.locator('#pegman-drag')).toHaveAttribute('data-valid', 'true');
  expect(await page.locator('#pegman-drag .pegman-figure').evaluate(e => getComputedStyle(e).animationName)).toBe('none');
  await page.screenshot({ path: '/tmp/musicmaps-pegman-touch.png' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expectLocation(page);
  await expect(page.locator('#pegman-drag .pegman-figure')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('#satellite-canvas').getAttribute('data-pan')).toBe('0,0');
});

test('a drop inside fullscreen opens the map and photo card and clears the floating figure', async ({ page }) => {
  await open(page);
  await page.locator('#fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await start(page, await target(page));
  await page.mouse.up();
  await expectLocation(page);
  await expect(page.locator('#pegman-drag .pegman-figure')).toBeHidden();
  await page.locator('#back-to-video').click();
  await expect(page.locator('#location-view')).toBeHidden();
  await page.locator('#fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
});

test('closing a pending drop cancels its delayed navigation to the world map', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/satellite-scenes.json', async route => {
    requested = true;
    await gate;
    await route.continue();
  });
  await open(page);
  await start(page, await target(page));
  await page.mouse.up();
  await expect(page.locator('#map-panel')).toBeVisible();
  await expect.poll(() => requested).toBe(true);
  await page.locator('#panel-close').click();
  const response = page.waitForResponse('**/satellite-scenes.json');
  release();
  await response;
  // Drain the asynchronous source load and its guarded navigation continuation.
  await page.waitForTimeout(400);
  await expect(page.locator('#map-panel')).toBeHidden();
  await expect(page.locator('#location-view')).toBeHidden();
  await expect(page.locator('#player')).not.toHaveAttribute('data-view', 'location');
});

test('fast movement updates the marker immediately and release picks its final coordinates before RAF', async ({ page }) => {
  await open(page);
  const point = await target(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'tile');
  const source = (await page.locator('#map-panel').getAttribute('data-source-index'))!;
  await page.locator('#panel-close').click();
  await start(page, { x: point.x - 200, y: point.y + 150 });
  const transform = await page.evaluate(point => {
    const button = document.querySelector('#streetview-toggle')!;
    // A single JS task prevents an animation frame between movement and release.
    button.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, isPrimary: true,
      clientX: point.x + 30, clientY: point.y + 20, buttons: 1, bubbles: true }));
    const transform = document.querySelector<HTMLElement>('#pegman-drag')!.style.transform;
    button.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, isPrimary: true,
      clientX: point.x, clientY: point.y, button: 0, bubbles: true }));
    return transform;
  }, point);
  await page.mouse.up();
  expect(transform).toBe(`translate3d(${point.x + 30}px, ${point.y + 20}px, 0px)`);
  await expectLocation(page, source);
});

test('a quick pickup and release still drops when no intermediate move event arrives', async ({ page }) => {
  await open(page);
  const point = await target(page);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#map-panel')).toHaveAttribute('data-mode', 'tile');
  const source = (await page.locator('#map-panel').getAttribute('data-source-index'))!;
  await page.locator('#panel-close').click();
  const home = await dock(page);
  await page.mouse.move(home.x, home.y);
  await page.mouse.down();
  await page.locator('#streetview-toggle').evaluate((button, point) => {
    button.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, isPrimary: true,
      clientX: point.x, clientY: point.y, button: 0, bubbles: true }));
  }, point);
  await page.mouse.up();
  await expectLocation(page, source);
});

test('a stopped drop keeps its selected photograph while playback advances and map details load', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/satellite-scenes.json', async route => {
    await gate;
    await route.continue();
  });
  await open(page);
  await page.locator('#play-toggle').click();
  await start(page, await target(page));
  await expect(page.locator('#pegman-drag')).toHaveAttribute('data-pose', '8');
  await page.mouse.up();
  const source = (await page.locator('#map-panel').getAttribute('data-source-index'))!;
  const time = await page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime);
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(time + .5);
  release();
  await expectLocation(page, source);
  await expect(page.locator('#source-video')).toHaveJSProperty('paused', false);
});

test('losing pointer capture during a stopped drag does not cancel the eventual drop', async ({ page }) => {
  await open(page);
  const point = await target(page);
  await start(page, point);
  await page.locator('#streetview-toggle').evaluate(button => button.releasePointerCapture(1));
  await page.mouse.move(point.x + 2, point.y + 2);
  await expect(page.locator('#pegman-drag')).toHaveAttribute('data-phase', 'drag');
  await page.mouse.up();
  await expectLocation(page);
});

test('decorative text over the video does not reject a drop', async ({ page }) => {
  await open(page);
  const wordmark = (await page.locator('.map-wordmark').boundingBox())!;
  await start(page, { x: wordmark.x + wordmark.width / 2, y: wordmark.y + wordmark.height / 2 });
  await expect(page.locator('#pegman-drag')).toHaveAttribute('data-valid', 'true');
  await page.mouse.up();
  await expectLocation(page);
});
