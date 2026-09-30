import { test, expect, type Page } from '@playwright/test';
import { ensureMediaFixtures, musicalVideo, silentVideo } from './fixtures';

test.beforeAll(ensureMediaFixtures);

async function upload(page: Page, path = musicalVideo) {
  await page.locator('#video-upload').setInputFiles(path);
  await expect.poll(() => page.locator('#source-video').evaluate(
    (element: HTMLVideoElement) => element.readyState,
  )).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.locator('#source-video').evaluate(
    (element: HTMLVideoElement) => element.duration,
  )).toBeGreaterThan(7.9);
}

async function mediaState(page: Page) {
  return page.locator('#source-video').evaluate((video: HTMLVideoElement) => ({
    currentTime: video.currentTime,
    paused: video.paused,
    muted: video.muted,
    volume: video.volume,
    playbackRate: video.playbackRate,
    source: video.currentSrc,
    audioBytes: (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number })
      .webkitAudioDecodedByteCount ?? 0,
  }));
}

async function setRange(page: Page, selector: string, value: number) {
  await page.locator(selector).evaluate((element: HTMLInputElement, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function expectRenderedTime(page: Page, target: number, tolerance = 0.1) {
  await expect.poll(async () => {
    const time = await page.locator('#satellite-canvas').getAttribute('data-media-time');
    return time === null ? Number.POSITIVE_INFINITY : Math.abs(Number(time) - target);
  }).toBeLessThan(tolerance);
}

async function expectRendererCaughtUp(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const source = document.querySelector<HTMLVideoElement>('#source-video')!;
    const canvas = document.querySelector<HTMLCanvasElement>('#satellite-canvas')!;
    if (!canvas.dataset.mediaTime) return Number.POSITIVE_INFINITY;
    return Math.abs(source.currentTime - Number(canvas.dataset.mediaTime));
  })).toBeLessThan(0.2);
}

test('the native video plays original audio, and all playback controls affect it', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  expect((await mediaState(page)).source).toMatch(/^blob:/);
  await expect(page.locator('#duration')).toContainText('0:08');
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.35);
  await expect.poll(async () => (await mediaState(page)).audioBytes).toBeGreaterThan(0);
  expect(await mediaState(page)).toMatchObject({ paused: false, muted: false, playbackRate: 1 });
  await expectRendererCaughtUp(page);

  await setRange(page, '#volume', 0.35);
  await expect.poll(async () => (await mediaState(page)).volume).toBeCloseTo(0.35, 2);
  await page.locator('#mute-toggle').click();
  expect((await mediaState(page)).muted).toBe(true);
  await page.locator('#mute-toggle').click();
  expect((await mediaState(page)).muted).toBe(false);

  await page.locator('#play-toggle').click();
  expect((await mediaState(page)).paused).toBe(true);
  const pausedTime = (await mediaState(page)).currentTime;
  await page.waitForTimeout(250);
  expect((await mediaState(page)).currentTime).toBeCloseTo(pausedTime, 3);
  await expectRenderedTime(page, pausedTime);
});

test('paused and playing scrubs render the source frame at the selected media timestamp', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await expectRenderedTime(page, 0);
  // Let the local imagery atlas finish loading before comparing source frames.
  await page.waitForLoadState('networkidle');
  const canvasScreenshotOptions = {
    style: '.transport, .canvas-topline, .media-message { visibility: hidden !important; }',
  };
  const initialFrame = await page.locator('#satellite-canvas').screenshot(canvasScreenshotOptions);
  await setRange(page, '#seek', 3.5);
  await expect.poll(async () => Math.abs((await mediaState(page)).currentTime - 3.5)).toBeLessThan(0.05);
  await expectRenderedTime(page, 3.5);
  expect((await mediaState(page)).paused).toBe(true);
  await expect(page.locator('#current-time')).toContainText('0:03');
  const soughtFrame = await page.locator('#satellite-canvas').screenshot(canvasScreenshotOptions);
  expect(soughtFrame.equals(initialFrame), 'Seeking must change rendered canvas pixels, not just its timestamp').toBe(false);

  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(3.65);
  await setRange(page, '#seek', 1.25);
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeLessThan(2);
  expect((await mediaState(page)).paused).toBe(false);
  await expectRendererCaughtUp(page);
});

test('resize, aspect ratio, settings and fullscreen preserve the same uninterrupted media source', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.3);
  await page.evaluate(() => {
    const state = window as typeof window & {
      originalMedia?: HTMLVideoElement;
      playbackInterruptions?: string[];
    };
    state.originalMedia = document.querySelector<HTMLVideoElement>('#source-video')!;
    state.playbackInterruptions = [];
    for (const type of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange']) {
      state.originalMedia.addEventListener(type, () => state.playbackInterruptions!.push(type));
    }
  });
  const before = await mediaState(page);
  await page.setViewportSize({ width: 620, height: 1000 });
  await page.setViewportSize({ width: 1440, height: 640 });
  for (const selector of ['#density', '#organic', '#contrast']) {
    const nextValue = await page.locator(selector).evaluate((input: HTMLInputElement) => {
      const minimum = Number(input.min || 0);
      const maximum = Number(input.max || 100);
      return minimum + (maximum - minimum) * 0.7;
    });
    await setRange(page, selector, nextValue);
  }
  await page.locator('#fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(before.currentTime + 0.3);
  const after = await mediaState(page);
  expect(after).toMatchObject({ source: before.source, paused: false, playbackRate: 1 });
  expect(await page.evaluate(() => {
    const state = window as typeof window & {
      originalMedia?: HTMLVideoElement;
      playbackInterruptions?: string[];
    };
    return {
      sameElement: document.querySelector('#source-video') === state.originalMedia,
      interruptions: state.playbackInterruptions,
    };
  })).toEqual({ sameElement: true, interruptions: [] });
  await expectRendererCaughtUp(page);
});

test('a renderer stall skips to the current media time without slowing playback', async ({ page }) => {
  await page.goto('/');
  await upload(page);
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.3);
  const before = await mediaState(page);
  await page.evaluate(() => {
    const finish = performance.now() + 1100;
    while (performance.now() < finish) { /* Deliberately block visual work. */ }
  });
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(before.currentTime + 0.85);
  expect(await mediaState(page)).toMatchObject({ paused: false, playbackRate: 1 });
  await expectRendererCaughtUp(page);
});

test('a video without an audio track plays and seeks silently', async ({ page }) => {
  await page.goto('/');
  await upload(page, silentVideo);
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.3);
  expect((await mediaState(page)).audioBytes).toBe(0);
  await expectRendererCaughtUp(page);
  await page.locator('#play-toggle').click();
  await setRange(page, '#seek', 5.25);
  await expectRenderedTime(page, 5.25);
});

test('the animation-frame fallback uses media time for playback and paused seeks', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true, value: undefined,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true, value: undefined,
    });
  });
  await page.goto('/');
  await upload(page);
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.3);
  await expectRendererCaughtUp(page);
  await page.locator('#play-toggle').click();
  await setRange(page, '#seek', 4.5);
  await expectRenderedTime(page, 4.5);
});

test('replacing an upload releases its object URL and renders playback on the same source element', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { revokedMediaURLs?: string[] };
    state.revokedMediaURLs = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url: string) => {
      state.revokedMediaURLs!.push(url);
      revoke(url);
    };
  });
  await page.goto('/');
  await upload(page);
  const original = await mediaState(page);
  const element = await page.locator('#source-video').elementHandle();
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.3);
  await expectRendererCaughtUp(page);
  await upload(page, silentVideo);
  expect((await mediaState(page)).source).not.toBe(original.source);
  expect(await element!.evaluate(video => video === document.querySelector('#source-video'))).toBe(true);
  expect(await page.evaluate(() => (
    window as typeof window & { revokedMediaURLs?: string[] }
  ).revokedMediaURLs)).toContain(original.source);
  expect((await mediaState(page)).paused).toBe(true);
  await expectRenderedTime(page, 0);
  await page.locator('#play-toggle').click();
  await expect.poll(async () => (await mediaState(page)).currentTime).toBeGreaterThan(0.6);
  await expectRendererCaughtUp(page);
});
