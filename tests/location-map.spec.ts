import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import proj4 from 'proj4';
import { ensureMediaFixtures, musicalVideo } from './fixtures';
import { readMosaicAssets, type MosaicScene } from './mosaic-assertions';

const { sources } = readMosaicAssets();
const collection = JSON.parse(readFileSync(resolve('public/imagery-collection.json'), 'utf8')) as {
  remoteTileUrl: string;
  attribution: string;
  licenseUrl: string;
};
const tileService = collection.remoteTileUrl.replace(/\{[zxy]\}/g, '*');
const tileServicePattern = new RegExp('^' + collection.remoteTileUrl.split(/\{[zxy]\}/)
  .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\d+') + '$');
const metadataService = 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/**';
const locationVideo = resolve('tests/.fixtures/test-location.mp4');
test.beforeAll(() => {
  ensureMediaFixtures();
  if (!existsSync(locationVideo)) execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '3', '-i', musicalVideo,
    '-t', '32', '-c', 'copy', locationVideo,
  ]);
});

// New map photos locate themselves from their pinned tile grid; no STAC request.
async function mockMetadata(page: Page) {
  const requests: string[] = [];
  await page.route(metadataService, route => {
    requests.push(route.request().url());
    return route.abort();
  });
  return requests;
}

async function exploreSelectedScene(page: Page, beforeExplore?: () => Promise<void>, doubleClick = false) {
  const index = Number(await page.locator('#map-panel').getAttribute('data-source-index'));
  await expect(page.locator('#tile-preview')).toHaveAttribute('data-quality', 'native');
  const previewUrl = await page.locator('#tile-preview img').getAttribute('src');
  await beforeExplore?.();
  if (doubleClick) await page.locator('#explore-tile-location').dblclick();
  else await page.locator('#explore-tile-location').click();
  await expect(page.locator('#location-view')).toBeVisible();
  const source = sources.find(source => source.index === index);
  expect(source, 'The explored image must use the selected scene metadata').toBeDefined();
  return { source: source!, previewUrl: previewUrl! };
}

async function openScene(page: Page, beforeExplore?: () => Promise<void>, doubleClick = false) {
  await page.locator('#video-upload').setInputFiles(locationVideo);
  await expect(page.locator('#play-toggle')).toBeEnabled();
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-media-time', '0');
  await page.waitForLoadState('networkidle');
  expect(sources.length, 'Location navigation must load the expanded library').toBeGreaterThan(255);
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  let index = -1;
  for (const [x, y] of [[.72, .45], [.83, .34], [.6, .55], [.8, .6]]) {
    if (await page.locator('#map-panel').isVisible()) await page.locator('#panel-close').click();
    await page.mouse.click(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
    await expect(page.locator('#tile-preview')).toBeVisible();
    index = Number(await page.locator('#map-panel').getAttribute('data-source-index'));
    if (sources.some(source => source.index === index)) break;
  }
  expect(sources.some(source => source.index === index),
    'Location navigation must resolve a scene from the expanded library').toBe(true);
  return exploreSelectedScene(page, beforeExplore, doubleClick);
}

async function mockTiles(page: Page, shouldFail: () => boolean = () => false) {
  const requests: string[] = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHZkAAAAASUVORK5CYII=', 'base64');
  await page.route(tileService, route => {
    requests.push(route.request().url());
    return shouldFail() ? route.abort() : route.fulfill({
      contentType: 'image/png', body: png, headers: { 'access-control-allow-origin': '*' },
    });
  });
  return requests;
}

/** Independent EPSG:3857 → WGS84 reference using PROJ rather than app math. */
function expectedPhotoPoint(source: MosaicScene, xRatio = .5, yRatio = .5) {
  const { x, y, z } = source.mapTile;
  const extent = 20037508.342789244;
  const resolution = extent * 2 / 2 ** z;
  const [longitude, latitude] = proj4('EPSG:3857', 'EPSG:4326', [
    -extent + (x + xRatio) * resolution, extent - (y + yRatio) * resolution,
  ]);
  return { latitude, longitude };
}

async function expectLocation(page: Page, source: MosaicScene) {
  const map = page.locator('#location-map');
  const photo = page.locator('#location-banner #location-photo');
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute('data-location-state', 'ready');
  await expect(map).toHaveAttribute('data-source-index', String(source.index));
  await expect(photo).toBeVisible();
  await expect(photo).toHaveAttribute('data-source-index', String(source.index));
  await expect(photo).toHaveAttribute('data-quality', 'native');
  const latitude = Number(await map.getAttribute('data-photo-latitude'));
  const longitude = Number(await map.getAttribute('data-photo-longitude'));
  const expected = expectedPhotoPoint(source);
  expect(latitude).toBeCloseTo(expected.latitude, 6);
  expect(longitude).toBeCloseTo(expected.longitude, 6);
  await expect(page.locator('#location-coordinates')).toHaveText(latitude.toFixed(5) + ', ' + longitude.toFixed(5));
  await expect(page.locator('#location-title')).toHaveText(source.region.replace(/ · [^·]+$/, ''));
  await expect(map.locator('.leaflet-image-layer')).toHaveCount(0);
  await expect(map.locator('.leaflet-overlay-pane path')).toHaveCount(1);
}

async function zoomMapTo(page: Page, target: number) {
  const map = page.locator('#location-map');
  const current = Number(await map.getAttribute('data-zoom'));
  for (let zoom = current; zoom !== target; zoom += zoom > target ? -1 : 1)
    await page.locator(zoom > target ? '#zoom-out' : '#zoom-in').click();
  await expect(map).toHaveAttribute('data-zoom', String(target));
}

test('the interactive satellite map opens with the original photo in a compact card and uninterrupted audio', async ({ page, context }) => {
  const geographicRequests = await mockTiles(page);
  const metadataRequests = await mockMetadata(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  let before!: { source: string; time: number };
  const { source, previewUrl } = await openScene(page, async () => {
    await page.locator('#play-toggle').click();
    await expect.poll(() => page.locator('#source-video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(.2);
    before = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('#source-video')!;
      Object.assign(window, { locationVideo: v, locationInterruptions: [] });
      for (const event of ['pause', 'seeking', 'emptied', 'loadstart', 'ratechange'])
        v.addEventListener(event, () => (window as any).locationInterruptions.push(event));
      return { source: v.currentSrc, time: v.currentTime };
    });
  });
  const map = page.locator('#location-map');
  const image = page.locator('#location-banner #location-photo img');
  await expectLocation(page, source);
  await expect(page.locator('.map-footer')).toContainText(collection.attribution);
  await expect(map.locator('.leaflet-control-attribution')).toContainText(collection.attribution);
  await expect(page.locator(`.map-footer a[href="${collection.licenseUrl}"]`)).toBeVisible();
  await expect(map.locator('.leaflet-tile-loaded').first()).toBeVisible();
  await expect(image).toHaveAttribute('src', previewUrl);
  const imageAppearance = await image.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth, height: image.naturalHeight,
    renderedWidth: image.getBoundingClientRect().width, renderedHeight: image.getBoundingClientRect().height,
    filter: getComputedStyle(image).filter, opacity: getComputedStyle(image).opacity,
  }));
  expect(imageAppearance.width).toBeGreaterThan(64);
  expect(imageAppearance).toMatchObject({ filter: 'none', opacity: '1' });
  expect(imageAppearance.renderedWidth / imageAppearance.renderedHeight)
    .toBeCloseTo(imageAppearance.width / imageAppearance.height, 2);
  await expect(page.locator('#location-photo-toggle, #location-satellite-toggle, #location-details, #location-imagery-note')).toHaveCount(0);
  await expect(page.locator('#location-copy-coordinates')).toHaveAccessibleName('Copy coordinates');
  await expect(page.locator('#location-copy-coordinates')).toHaveText('');
  const coordinates = (await page.locator('#location-coordinates').textContent())!;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#location-copy-coordinates').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(coordinates);
  const zoom = Number(await map.getAttribute('data-zoom'));
  await page.locator('#zoom-in').click();
  await expect(map).toHaveAttribute('data-zoom', String(zoom + 1));
  const initialLongitude = Number(await map.getAttribute('data-longitude'));
  await map.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Math.abs(Number(await map.getAttribute('data-longitude')) - initialLongitude)).toBeGreaterThan(.001);
  await page.locator('#locate-button').click();
  await expect(map).toHaveAttribute('data-zoom', String(zoom));
  await page.setViewportSize({ width: 1050, height: 750 });
  await expectLocation(page, source);
  expect(metadataRequests, 'Tile coordinates must not depend on a separate acquisition service').toEqual([]);
  expect(geographicRequests.length).toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/musicmaps-map-photo-card.png' });
  await page.locator('#back-to-video').click();
  await expect(page.locator('#location-view')).toBeHidden();
  const after = await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#source-video')!;
    return { source: v.currentSrc, time: v.currentTime, same: v === (window as any).locationVideo,
      interruptions: (window as any).locationInterruptions, paused: v.paused, muted: v.muted, rate: v.playbackRate };
  });
  expect(after).toMatchObject({ source: before.source, same: true, interruptions: [], paused: false, muted: false, rate: 1 });
  expect(after.time).toBeGreaterThan(before.time);
  await expect.poll(() => page.evaluate(() => Math.abs(document.querySelector<HTMLVideoElement>('#source-video')!.currentTime - Number(document.querySelector<HTMLElement>('#satellite-canvas')!.dataset.mediaTime)))).toBeLessThan(.2);
  expect(context.pages()).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('double-clicking the preview opens the real map and a feature in the card navigates to its projected location', async ({ page }) => {
  await mockTiles(page);
  await mockMetadata(page);
  await page.goto('/');
  const { source, previewUrl } = await openScene(page, undefined, true);
  await expectLocation(page, source);
  const map = page.locator('#location-map');
  const image = page.locator('#location-banner #location-photo img');
  const bounds = (await image.boundingBox())!;
  // Dispatch whole CSS pixels so the browser's integer MouseEvent coordinates
  // are known, then compare the geographic result at subpixel precision.
  const click = { x: Math.floor(bounds.x + bounds.width * .63), y: Math.floor(bounds.y + bounds.height * .37) };
  await page.mouse.dblclick(click.x, click.y);
  await expect(map).toHaveAttribute('data-zoom', '12');
  const expected = expectedPhotoPoint(source,
    (click.x - bounds.x) / bounds.width, (click.y - bounds.y) / bounds.height);
  await expect.poll(async () => Math.abs(Number(await map.getAttribute('data-latitude')) - expected.latitude)).toBeLessThan(1e-7);
  await expect.poll(async () => Math.abs(Number(await map.getAttribute('data-longitude')) - expected.longitude)).toBeLessThan(1e-7);
  await expect(map).toHaveAttribute('data-location-state', 'ready');
  const latitude = Number(await map.getAttribute('data-photo-latitude'));
  const longitude = Number(await map.getAttribute('data-photo-longitude'));
  expect(latitude).toBeCloseTo(expected.latitude, 7);
  expect(longitude).toBeCloseTo(expected.longitude, 7);
  await expect(page.locator('#location-coordinates')).toHaveText(latitude.toFixed(5) + ', ' + longitude.toFixed(5));
  await expect(map.locator('.leaflet-overlay-pane path')).toHaveCount(1);
  await expect(image).toHaveAttribute('src', previewUrl);
  expect(await page.locator('#source-video').evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime }))).toEqual({ paused: true, time: 0 });
});

test('the photo location can be opened from the keyboard', async ({ page }) => {
  await mockTiles(page);
  await mockMetadata(page);
  await page.goto('/');
  await openScene(page);
  const photo = page.locator('#location-photo');
  await expect(photo).toHaveAttribute('role', 'button');
  await photo.focus();
  await photo.press('Enter');
  await expect(page.locator('#location-map')).toHaveAttribute('data-location-state', 'ready');
  await expect(page.locator('#location-map')).toHaveAttribute('data-zoom', '12');
});

test('the mobile card contains the photo and leaves the interactive map and playback controls accessible', async ({ page }) => {
  await mockTiles(page);
  await mockMetadata(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const { source, previewUrl } = await openScene(page);
  await expectLocation(page, source);
  const image = page.locator('#location-banner #location-photo img');
  await expect(image).toHaveAttribute('src', previewUrl);
  const imageBounds = (await image.boundingBox())!;
  const bannerBounds = (await page.locator('#location-banner').boundingBox())!;
  const transportBounds = (await page.locator('.transport').boundingBox())!;
  expect(imageBounds.y).toBeGreaterThan(bannerBounds.y);
  expect(imageBounds.y + imageBounds.height).toBeLessThan(bannerBounds.y + bannerBounds.height);
  expect(bannerBounds.y + bannerBounds.height).toBeLessThan(transportBounds.y - 100);
  await expect(page.locator('#location-map .leaflet-tile-loaded').first()).toBeVisible();
  await expect(page.locator('#location-map-status')).toBeHidden();
  await page.locator('#play-toggle').click({ trial: true });
  await page.locator('#back-to-video').click({ trial: true });
  const map = page.locator('#location-map');
  const longitude = Number(await map.getAttribute('data-longitude'));
  const dragY = (bannerBounds.y + bannerBounds.height + transportBounds.y) / 2;
  await page.mouse.move(290, dragY);
  await page.mouse.down();
  await page.mouse.move(200, dragY, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(Number(await map.getAttribute('data-longitude')) - longitude)).toBeGreaterThan(.001);
  await page.screenshot({ path: '/tmp/musicmaps-map-photo-card-mobile.png' });
  await page.locator('#fullscreen-toggle').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expectLocation(page, source);
  await page.locator('#fullscreen-toggle').click();
  await page.locator('#back-to-video').click();
  expect(await page.locator('#source-video').evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime }))).toEqual({ paused: true, time: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('failed geographic tiles can be retried without losing the native card photograph', async ({ page }) => {
  let fail = true;
  const requests = await mockTiles(page, () => fail);
  await mockMetadata(page);
  await page.goto('/');
  const { source, previewUrl } = await openScene(page);
  await expectLocation(page, source);
  // Native photos are cached locally. Exercise a different scale so this
  // checks failed map requests independently of the selected cache block.
  await zoomMapTo(page, source.mapTile.z + 1);
  await expect(page.locator('#location-map-retry')).toBeVisible();
  await expect(page.locator('#location-banner #location-photo img')).toHaveAttribute('src', previewUrl);
  const failedRequests = requests.length;
  fail = false;
  await page.locator('#location-map-retry').click();
  await expect(page.locator('#location-map .leaflet-tile-loaded').first()).toBeVisible();
  await expect(page.locator('#location-map-retry')).toBeHidden();
  await expect(page.locator('#location-map-status')).toBeHidden();
  expect(requests.length).toBeGreaterThan(failedRequests);
  await expectLocation(page, source);
});

test('the card and geographic tile use identical pixels, and adjacent tiles use the same collection', async ({ page }) => {
  const remoteRequests = await mockTiles(page);
  const metadataRequests = await mockMetadata(page);
  const foreign: string[] = [];
  page.on('request', request => {
    if (/arcgisonline|googleapis.*tile|sentinel-cogs/.test(request.url())) foreign.push(request.url());
  });
  await page.goto('/');
  const { source, previewUrl } = await openScene(page);
  await expectLocation(page, source);
  const map = page.locator('#location-map');
  await zoomMapTo(page, source.mapTile.z);
  const tile = map.locator(`.leaflet-tile[src="${previewUrl}"]`);
  await expect(tile).toHaveCount(1);
  await expect(tile).toHaveClass(/leaflet-tile-loaded/);
  expect(await page.evaluate(url => {
    const photo = document.querySelector<HTMLImageElement>('#location-photo img')!;
    const tile = Array.from(document.querySelectorAll<HTMLImageElement>('#location-map .leaflet-tile'))
      .find(image => image.getAttribute('src') === url)!;
    const pixels = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const a = pixels(photo), b = pixels(tile);
    return { same: a.length === b.length && a.every((v, i) => v === b[i]),
      filter: getComputedStyle(tile).filter, width: tile.naturalWidth };
  }, previewUrl)).toEqual({ same: true, filter: 'none', width: 256 });
  const tileBounds = (await tile.boundingBox())!;
  const pinBounds = (await map.locator('.leaflet-overlay-pane path').boundingBox())!;
  expect(Math.abs(tileBounds.x + tileBounds.width / 2 - pinBounds.x - pinBounds.width / 2)).toBeLessThan(2);
  expect(Math.abs(tileBounds.y + tileBounds.height / 2 - pinBounds.y - pinBounds.height / 2)).toBeLessThan(2);
  await expect(map.locator('.leaflet-image-layer')).toHaveCount(0);
  await expect(map).toHaveAttribute('data-collection', source.mapTile.collectionId);
  await map.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
  await page.locator('#zoom-in').click();
  await page.locator('#zoom-in').click();
  await expect.poll(() => remoteRequests.length).toBeGreaterThan(0);
  expect(remoteRequests.every(url => tileServicePattern.test(url))).toBe(true);
  expect(foreign).toEqual([]);
  expect(metadataRequests).toEqual([]);
});

test('switching places keeps each card and map attached to the same new photograph', async ({ page }) => {
  await mockTiles(page);
  await page.goto('/');
  const first = await openScene(page);
  await expectLocation(page, first.source);
  await page.locator('#back-to-video').click();
  await page.locator('#streetview-toggle').click();
  await page.locator('.satellite-place').first().click();
  const second = await exploreSelectedScene(page);
  expect(second.source.index).not.toBe(first.source.index);
  await expectLocation(page, second.source);
  await expect(page.locator('#location-photo img')).toHaveAttribute('src', second.previewUrl);
});

test('stale source collections cannot attach a photograph to old coordinates and details can retry safely', async ({ page }) => {
  await mockTiles(page);
  const metadataRequests = await mockMetadata(page);
  const collectionId = sources[0].mapTile.collectionId;
  let requests = 0;
  await page.route('**/satellite-scenes.json', route => {
    requests++;
    return route.fulfill({ json: {
      collectionId: requests === 1 ? 'old-acquisition-library' : collectionId,
      sources: requests === 2 ? sources.map((source, index) => index === 0
        ? { ...source, mapTile: { ...source.mapTile, collectionId: 'different-mosaic' } } : source) : sources,
    } });
  });
  await page.goto('/');
  await page.locator('#video-upload').setInputFiles(locationVideo);
  await expect(page.locator('#satellite-canvas')).toHaveAttribute('data-media-time', '0');
  await page.waitForLoadState('networkidle');
  const bounds = (await page.locator('#satellite-canvas').boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width * .72, bounds.y + bounds.height * .45);
  const index = await page.locator('#map-panel').getAttribute('data-source-index');
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(page.locator('#panel-content')).toContainText('The image details could not load. Please try again.');
    await expect(page.locator('#explore-tile-location')).toHaveCount(0);
    await expect(page.locator('#location-view')).toBeHidden();
    await expect(page.locator('#map-panel')).toHaveAttribute('data-source-index', index!);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
  }
  await expect(page.locator('#tile-preview')).toHaveAttribute('data-quality', 'native');
  const { source } = await exploreSelectedScene(page);
  await expectLocation(page, source);
  expect(requests).toBe(3);
  expect(metadataRequests, 'A rejected source must never fall through to acquisition georeferencing').toEqual([]);
  expect(await page.locator('#source-video').evaluate((v: HTMLVideoElement) => ({ paused: v.paused, time: v.currentTime })))
    .toEqual({ paused: true, time: 0 });
});
