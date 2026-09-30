import { test, expect, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureMediaFixtures, musicalVideo, silentVideo } from './fixtures';
import { scanVideoLibrary } from '../scripts/video-library.mjs';

let folder: string;
let first: string;
let second: string;
let unusual: string;
const longVideo = resolve('tests/.fixtures/test-location.mp4');

test.beforeAll(() => {
  ensureMediaFixtures();
  if (!existsSync(longVideo)) execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '3', '-i', musicalVideo,
    '-t', '32', '-c', 'copy', longVideo,
  ]);
  folder = mkdtempSync(resolve('public/videos/Library test '));
  for (const [name, path] of [['Coast #2 & sky.MP4', longVideo], ['Other scene.mp4', silentVideo], ['<img onerror=alert(1)>.mp4', silentVideo]])
    copyFileSync(path, join(folder, name));
  first = `${basename(folder)}/Coast #2 & sky.MP4`;
  second = `${basename(folder)}/Other scene.mp4`;
  unusual = `${basename(folder)}/<img onerror=alert(1)>.mp4`;
});
test.afterAll(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });

async function choose(page: Page, name: string) {
  await page.locator('#map-search').fill(name);
  await page.locator('#search-results').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#search-results')).toBeHidden();
  await expect.poll(() => page.locator('#source-video').evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > .1)).toBe(true);
}

test('the folder scanner includes nested MP4s, encodes filenames, and skips hidden files and symlinks', async () => {
  const path = mkdtempSync(join(tmpdir(), 'musicmaps-video-index-'));
  try {
    mkdirSync(join(path, 'Concerts'));
    writeFileSync(join(path, 'Concerts', 'A #2 & B.MP4'), 'video');
    writeFileSync(join(path, '.private.mp4'), 'hidden');
    writeFileSync(join(path, 'empty.mp4'), '');
    writeFileSync(join(path, 'notes.txt'), 'notes');
    symlinkSync(join(path, 'Concerts'), join(path, 'linked-directory'));
    symlinkSync(join(path, 'Concerts', 'A #2 & B.MP4'), join(path, 'linked.mp4'));
    const entries = await scanVideoLibrary(path);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('Concerts/A #2 & B.MP4');
    expect(entries[0].url).toMatch(/^\/videos\/Concerts\/A%20%232%20%26%20B.MP4\?v=/);
    expect(await scanVideoLibrary(join(path, 'missing'))).toEqual([]);
  } finally { rmSync(path, { recursive: true, force: true }); }
});

test('search lists folder videos before any upload and streams a selection with original audio', async ({ page, request }) => {
  await page.goto('/');
  await page.locator('#map-search').click();
  const results = page.locator('#search-results');
  await expect(results.getByRole('button', { name: first, exact: true })).toBeVisible();
  await expect(results.getByRole('button', { name: second, exact: true })).toBeVisible();
  await expect(results.getByRole('button', { name: unusual, exact: true })).toBeVisible();
  // Filenames remain text; only the dedicated thumbnail may contain an image.
  await expect(results.getByRole('button', { name: unusual, exact: true }).locator('span')).toHaveText(unusual);
  await expect(results.locator('.video-search-result > span img')).toHaveCount(0);
  await page.locator('#map-search').fill('COAST #2');
  await expect(results.locator('.video-search-result')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(results.getByRole('button', { name: first, exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.locator('#source-video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
  const original = await page.locator('#source-video').evaluate((v: HTMLVideoElement) => ({
    src: v.currentSrc, paused: v.paused, muted: v.muted, rate: v.playbackRate,
    audioBytes: (v as any).webkitAudioDecodedByteCount,
  }));
  expect(original).toMatchObject({ paused: false, muted: false, rate: 1 });
  expect(original.audioBytes).toBeGreaterThan(0);
  expect(new URL(original.src).pathname).toContain('/videos/');
  expect(original.src).not.toMatch(/^blob:/);
  const range = await request.get(original.src, { headers: { Range: 'bytes=0-31' } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(32);
  const suffix = await request.get(original.src, { headers: { Range: 'bytes=-16' } });
  expect(suffix.status()).toBe(206);
  expect((await suffix.body()).length).toBe(16);
  expect((await request.get(original.src, { headers: { Range: 'bytes=999999999999-' } })).status()).toBe(416);
  const head = await request.head(original.src);
  expect(head.status()).toBe(200);
  expect(head.headers()['accept-ranges']).toBe('bytes');
  await page.locator('#play-toggle').click();
  await page.locator('#seek').evaluate((input: HTMLInputElement) => {
    input.value = '2.5'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => page.locator('#satellite-canvas').evaluate(e => Math.abs(Number(e.dataset.mediaTime) - 2.5))).toBeLessThan(.1);
  await page.locator('#saved-toggle').click();
  await page.getByRole('button', { name: 'Save this moment', exact: true }).click();
  await page.locator('#panel-close').click();
  await choose(page, second);
  await page.locator('#saved-toggle').click();
  await page.locator('#panel-content .library-item').click();
  await expect.poll(() => page.locator('#source-video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(2.5, 1);
  expect(await page.locator('#source-video').evaluate((v: HTMLVideoElement) => v.currentSrc)).toBe(original.src);
});

test('a catalog refresh during a thumbnail click preserves autoplay', async ({ page }) => {
  await page.goto('/');
  await page.locator('#map-search').fill(first);
  const result = page.locator('#search-results').getByRole('button', { name: first, exact: true });
  await expect(result).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForLoadState('networkidle');

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/video-library.json', async route => { await gate; await route.continue(); });
  await page.locator('#map-search').click();
  const bounds = (await result.boundingBox())!;
  // Release the background refresh between pressing and releasing the row.
  await page.mouse.move(bounds.x + 35, bounds.y + bounds.height / 2);
  await page.mouse.down();
  const refreshed = page.waitForResponse('**/video-library.json');
  release();
  await refreshed;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.mouse.up();
  await expect.poll(() => page.locator('#source-video').evaluate((v: HTMLVideoElement) =>
    !v.paused && !v.muted && v.currentTime > .2)).toBe(true);
  await page.unroute('**/video-library.json');

  await page.locator('#play-toggle').click();
  await choose(page, first);
  await choose(page, second);
});

test('adding and removing folder videos refreshes search without reloading or interrupting playback', async ({ page, request }) => {
  await page.goto('/');
  await choose(page, first);
  const before = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    Object.assign(window, { libraryVideo: video, libraryInterruptions: [] });
    for (const event of ['pause', 'seeking', 'emptied', 'loadstart'])
      video.addEventListener(event, () => (window as any).libraryInterruptions.push(event));
    return { src: video.currentSrc, time: video.currentTime };
  });
  const addition = 'Fresh arrival.mp4';
  copyFileSync(silentVideo, join(folder, addition));
  await page.locator('#map-search').click();
  const result = page.locator('#search-results').getByRole('button', { name: `${basename(folder)}/${addition}`, exact: true });
  await expect(result).toBeVisible();
  const catalog = await (await request.get('/video-library.json')).json();
  const entry = catalog.videos.find((entry: { name: string }) => entry.name === `${basename(folder)}/${addition}`);
  expect((await request.get(entry.url, { headers: { Range: 'bytes=0-31' } })).status()).toBe(206);
  await page.keyboard.press('Escape');
  rmSync(join(folder, addition));
  const refreshed = page.waitForResponse('**/video-library.json');
  await page.locator('#map-search').click();
  await refreshed;
  await expect(result).toHaveCount(0);
  const after = await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('#source-video')!;
    return { same: video === (window as any).libraryVideo, interruptions: (window as any).libraryInterruptions,
      src: video.currentSrc, time: video.currentTime, paused: video.paused };
  });
  expect(after).toMatchObject({ same: true, interruptions: [], src: before.src, paused: false });
  expect(after.time).toBeGreaterThan(before.time);
});

test('a delayed catalog cannot reopen closed search, and library errors can be retried', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/video-library.json', async route => { await gate; await route.continue(); });
  await page.goto('/');
  await page.locator('#map-search').click();
  await expect(page.locator('#search-results')).toContainText('Loading videos');
  await page.keyboard.press('Escape');
  const loaded = page.waitForResponse('**/video-library.json');
  release();
  await loaded;
  await expect(page.locator('#search-results')).toBeHidden();
  await page.unroute('**/video-library.json');
  await page.route('**/video-library.json', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.locator('#map-search').click();
  await expect(page.locator('#search-results')).toContainText('The video folder could not load.');
  await page.unroute('**/video-library.json');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('#search-results')).not.toContainText('The video folder could not load.');
  await expect(page.locator('#search-results').getByRole('button', { name: first, exact: true })).toBeVisible();
});
