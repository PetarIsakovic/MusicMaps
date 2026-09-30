import { test, expect, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ensureMediaFixtures, musicalVideo } from './fixtures';
import { readMosaicAssets } from './mosaic-assertions';

const previewPaths = new Set(readMosaicAssets().mosaic.patches.map(patch => patch.previewUrl));
const nativePhotoURL = (url: URL) => previewPaths.has(url.pathname);
const zoomVideo = resolve('tests/.fixtures/test-zoom.mp4');
test.beforeAll(() => {
  ensureMediaFixtures();
  if (!existsSync(zoomVideo)) execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '3', '-i', musicalVideo,
    '-t', '32', '-c', 'copy', zoomVideo,
  ]);
});

/** Count costly GPU operations without GPU queries or machine-specific FPS limits. */
async function instrument(page: Page, deviceMemory = 4) {
  await page.addInitScript(({ deviceMemory, detailUrls }) => {
    Object.defineProperty(navigator, 'deviceMemory', { value: deviceMemory });
    const stats = {
      active: false, displayDraws: 0, offscreenDraws: 0, readbacks: 0,
      videoUploads: 0, largeUploads: 0, subImageUploads: 0, frameCallbacks: 0,
      wheelEvents: 0, detailLoads: 0, interruptions: [] as string[],
    };
    (window as any).zoomStats = stats;
    const isPlayer = (gl: WebGLRenderingContext) => (gl.canvas as HTMLCanvasElement).id === 'satellite-canvas';
    const targets = new WeakMap<WebGLRenderingContext, WebGLFramebuffer | null>();
    const prototype = WebGLRenderingContext.prototype;
    const bindFramebuffer = prototype.bindFramebuffer;
    prototype.bindFramebuffer = function (target, framebuffer) {
      targets.set(this, framebuffer);
      return bindFramebuffer.call(this, target, framebuffer);
    };
    const drawArrays = prototype.drawArrays;
    prototype.drawArrays = function (...args) {
      if (stats.active && isPlayer(this)) {
        if (targets.get(this)) stats.offscreenDraws++;
        else stats.displayDraws++;
      }
      return drawArrays.apply(this, args);
    };
    const readPixels = prototype.readPixels;
    prototype.readPixels = function (...args) {
      if (stats.active && isPlayer(this)) stats.readbacks++;
      return readPixels.apply(this, args);
    };
    const texImage2D = prototype.texImage2D;
    prototype.texImage2D = function (...args: any[]) {
      if (stats.active && isPlayer(this)) {
        const source = args[args.length - 1];
        if (source instanceof HTMLVideoElement) stats.videoUploads++;
        else {
          const width = args.length === 9 ? args[3] : source?.width;
          const height = args.length === 9 ? args[4] : source?.height;
          if (width * height >= 1024 * 1024) stats.largeUploads++;
        }
      }
      return (texImage2D as any).apply(this, args);
    };
    const texSubImage2D = prototype.texSubImage2D;
    prototype.texSubImage2D = function (...args: any[]) {
      if (stats.active && isPlayer(this)) {
        if (args[args.length - 1] instanceof HTMLVideoElement) stats.videoUploads++;
        else stats.subImageUploads++;
      }
      return (texSubImage2D as any).apply(this, args);
    };
    const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      return requestFrame.call(this, (time, metadata) => {
        if (stats.active && this.id === 'source-video') stats.frameCallbacks++;
        callback(time, metadata);
      });
    };
    // Detail images are decoded while detached from the DOM. Observe their
    // load events directly, without changing pixels or bypassing the loader.
    const sourceProperty = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...sourceProperty,
      set(value: string) {
        if (detailUrls.includes(new URL(value, location.href).pathname))
          this.addEventListener('load', () => { stats.detailLoads++; }, { once: true });
        sourceProperty.set!.call(this, value);
      },
    });
    document.addEventListener('wheel', event => {
      if (stats.active && (event.target as HTMLElement).id === 'satellite-canvas') stats.wheelEvents++;
    }, true);
    for (const event of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange']) {
      document.addEventListener(event, target => {
        if (stats.active && (target.target as HTMLElement).id === 'source-video') stats.interruptions.push(event);
      }, true);
    }
  }, { deviceMemory, detailUrls: [...previewPaths] });
}

async function openVideo(page: Page, density = 90) {
  await page.goto('/');
  await page.locator('#video-upload').setInputFiles(zoomVideo);
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-imagery-resolution', '64');
  await expect(page.locator('#play-toggle')).toBeEnabled();
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-media-time', '0');
  if (density !== 90) {
    await page.locator('#density').evaluate((input: HTMLInputElement, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, density);
  }
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });
}

async function beginProfile(page: Page) {
  return page.evaluate(() => {
    const stats = (window as any).zoomStats;
    for (const key of Object.keys(stats)) if (typeof stats[key] === 'number') stats[key] = 0;
    stats.interruptions = [];
    stats.active = true;
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    (window as any).zoomVideoElement = video;
    return { time: video.currentTime, source: video.currentSrc, volume: video.volume, muted: video.muted };
  });
}

async function wheelBurst(page: Page, frames = 24) {
  await page.evaluate(async frames => {
    const canvas = document.querySelector('#satellite-canvas')!;
    for (let frame = 0; frame < frames; frame++) {
      await new Promise(requestAnimationFrame);
      // Multiple trackpad events per display frame should share one draw.
      for (let event = 0; event < 6; event++) canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: frame % 8 < 4 ? -10 : 10, bubbles: true, cancelable: true,
      }));
    }
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
  }, frames);
}

async function endProfile(page: Page) {
  return page.evaluate(() => {
    const stats = (window as any).zoomStats;
    stats.active = false;
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    return { ...stats, media: { time: video.currentTime, source: video.currentSrc,
      sameElement: video === (window as any).zoomVideoElement, paused: video.paused,
      volume: video.volume, muted: video.muted, rate: video.playbackRate } };
  });
}

test('rapid paused zoom reuses the decoded frame and batches camera-only drawing', async ({ page }) => {
  await instrument(page);
  await openVideo(page);
  const before = await beginProfile(page);
  await wheelBurst(page);
  const result = await endProfile(page);
  expect(result.wheelEvents).toBe(144);
  expect(result.displayDraws, 'Camera movement must actually redraw the mosaic').toBeGreaterThan(0);
  expect(result.displayDraws, 'Trackpad bursts should be coalesced into display frames').toBeLessThan(result.wheelEvents / 2);
  expect(result.videoUploads, 'Camera changes must reuse the paused decoded video texture').toBe(0);
  expect(result.offscreenDraws, 'Camera changes must reuse cell matching and photo bounds').toBe(0);
  expect(result.readbacks, 'Zoom must not synchronously read pixels from the GPU').toBe(0);
  expect(result.largeUploads).toBe(0);
  expect(result.subImageUploads).toBe(0);
  expect(result.interruptions).toEqual([]);
  expect(result.media).toMatchObject({ ...before, sameElement: true, paused: true, rate: 1 });
});

test('rapid playing zoom keeps original audio running and only uploads decoded media frames', async ({ page }) => {
  await instrument(page);
  await openVideo(page, 24);
  await page.locator('#play-toggle').click();
  await expect.poll(() => page.locator('#source-video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(.3);
  const before = await beginProfile(page);
  await wheelBurst(page);
  const result = await endProfile(page);
  expect(result.frameCallbacks).toBeGreaterThan(0);
  expect(result.videoUploads).toBeGreaterThan(0);
  expect(result.videoUploads, 'Zoom must not add media uploads between decoded frames').toBeLessThanOrEqual(result.frameCallbacks + 1);
  expect(result.readbacks).toBe(0);
  expect(result.largeUploads).toBe(0);
  expect(result.subImageUploads).toBe(0);
  expect(result.interruptions).toEqual([]);
  expect(result.media).toMatchObject({ source: before.source, sameElement: true,
    paused: false, muted: before.muted, volume: before.volume, rate: 1 });
  expect(result.media.time).toBeGreaterThan(before.time);
});

test('a decoded detail page waits for zoom to settle before GPU upload, then restores sharp imagery', async ({ page }) => {
  test.setTimeout(60_000);
  await instrument(page, 8);
  let pending: Route | undefined;
  let release = false;
  await page.route(nativePhotoURL, route => {
    if (release) return route.continue();
    pending = route;
  });
  await openVideo(page, 24);
  await expect.poll(() => !!pending).toBe(true);
  await beginProfile(page);
  await page.evaluate(() => {
    let tick = 0;
    const canvas = document.querySelector('#satellite-canvas')!;
    const pump = window.setInterval(() => {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: tick++ % 10 < 5 ? -8 : 8, bubbles: true, cancelable: true,
      }));
    }, 16);
    (window as any).zoomPump = pump;
  });
  release = true;
  await pending!.fulfill({ response: await pending!.fetch() });
  await expect.poll(() => page.evaluate(() => (window as any).zoomStats.detailLoads), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    clearInterval((window as any).zoomPump);
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
  });
  const result = await endProfile(page);
  expect(result.wheelEvents).toBeGreaterThan(4);
  expect(result.videoUploads).toBe(0);
  expect(result.offscreenDraws).toBe(0);
  expect(result.readbacks).toBe(0);
  expect(result.largeUploads, 'Loading a detail image must not allocate or upload it during zoom').toBe(0);
  expect(result.subImageUploads, 'Even incremental detail uploads must yield while the camera is moving').toBe(0);
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-detail-quality', 'ready', { timeout: 20_000 });
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-imagery-resolution', '256');
  expect(await page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({ paused: video.paused, time: video.currentTime })))
    .toEqual({ paused: true, time: 0 });
});

test('trackpad momentum at the maximum zoom keeps optional texture work deferred', async ({ page }) => {
  await instrument(page, 8);
  await openVideo(page);
  await beginProfile(page);
  await page.evaluate(async () => {
    const canvas = document.querySelector('#satellite-canvas')!;
    // Reach the limit immediately, then continue scrolling for longer than the
    // detail idle delay. A clamped camera must still register active input.
    for (let frame = 0; frame < 40; frame++) {
      await new Promise(requestAnimationFrame);
      for (let i = 0; i < 8; i++) canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -500, bubbles: true, cancelable: true,
      }));
    }
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
  });
  const result = await endProfile(page);
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-zoom', '4');
  expect(result.wheelEvents).toBe(320);
  expect(result.displayDraws).toBeLessThanOrEqual(2);
  expect(result.videoUploads).toBe(0);
  expect(result.readbacks).toBe(0);
  expect(result.offscreenDraws).toBe(0);
  expect(result.largeUploads).toBe(0);
  expect(result.subImageUploads).toBe(0);
});
