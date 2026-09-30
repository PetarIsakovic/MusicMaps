import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';

const { fixtures } = JSON.parse(readFileSync('tests/data/scene-locations.json', 'utf8'));
const collection = JSON.parse(readFileSync('public/imagery-collection.json', 'utf8'));

test('a mismatched or unversioned photo library is rejected and can retry with the matching collection', async ({ page }) => {
  // Keep the app's startup fetch out of this contract check so each response
  // below belongs to one explicit loadMosaicLibrary attempt.
  await page.route('**/__collection-check', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Collection check</title>' }));
  const ids = ['different-imagery-collection', undefined, collection.id];
  let requests = 0;
  await page.route('**/satellite-mosaic.json', route => route.fulfill({ json: {
    collectionId: ids[requests++], atlas: '/unused-atlas.jpg', sourceManifest: '/unused-sources.json',
    layout: { columns: 1, rows: 1, tileSize: 64, width: 64, height: 64 }, patches: [],
    features: { url: '/unused-features.png', columns: 1, rows: 1, texelsPerPatch: 2 },
    lookup: { size: 2, urls: { satellite: '/unused.png', terrain: '/unused.png', coasts: '/unused.png' } },
  } }));
  await page.goto('/__collection-check');
  const results = await page.evaluate(async () => {
    const moduleURL = '/src/mosaic-library.ts';
    const { loadMosaicLibrary } = await import(moduleURL);
    const attempts = [];
    for (let index = 0; index < 3; index++) {
      try { attempts.push({ collectionId: (await loadMosaicLibrary()).collectionId }); }
      catch (error) { attempts.push({ error: (error as Error).message }); }
    }
    return attempts;
  });
  expect(results[0].error).toMatch(/same imagery collection/);
  expect(results[1].error).toMatch(/same imagery collection/);
  expect(results[2]).toEqual({ collectionId: collection.id });
  expect(requests).toBe(3);
});

test('map tiles wrap longitude while retaining the pinned collection for cached and surrounding imagery', async ({ page }) => {
  await page.goto('/');
  const [x, y] = collection.cachedBlocks[0];
  const z = collection.cachedZoom;
  const size = collection.cachedBlockSize;
  const result = await page.evaluate(async ({ x, y, z, size }) => {
    const moduleURL = '/src/imagery-collection.ts';
    const { mapTileUrl } = await import(moduleURL);
    return {
      cached: [[x, y], [x + size - 1, y + size - 1], [x - 2 ** z, y], [x + 2 ** z, y]]
        .map(([x, y]) => mapTileUrl({ x, y, z })),
      uncached: mapTileUrl({ x, y, z: z + 1 }),
    };
  }, { x, y, z, size });
  const local = (x: number, y: number) => collection.localTileUrl
    .replace('{x}', String(x)).replace('{y}', String(y)).replace('{z}', String(z));
  expect(result.cached).toEqual([local(x, y), local(x + size - 1, y + size - 1), local(x, y), local(x, y)]);
  expect(result.uncached).toBe(collection.remoteTileUrl
    .replace('{x}', String(x)).replace('{y}', String(y)).replace('{z}', String(z + 1)));
});

test('pinned map photographs locate every corner and pixel on the same Web Mercator grid', async ({ page }) => {
  const samples = [[0, 0, 2], [3, 3, 2], [122, 128, 9], [322, 278, 9], [511, 256, 9], [16383, 16383, 14]];
  const pixels = [[0, 0], [256, 0], [256, 256], [0, 256], [56.25, 203.75], [128, 128]];
  await page.goto('/');
  const result = await page.evaluate(async ({ samples, pixels, id }) => {
    const moduleURL = '/src/scene-location.ts';
    const { mapPhotoLocation } = await import(moduleURL);
    const base = { collectionId: id, x: 122, y: 128, z: 9, tileSize: 256 };
    const invalid = [{ ...base, collectionId: 'different-mosaic' }, { ...base, x: -1 },
      { ...base, y: 512 }, { ...base, z: 9.5 }, { ...base, x: NaN }, { ...base, tileSize: 512 },
      { ...base, x: 512 }, { ...base, y: -1 }, { ...base, z: -1 }, { ...base, z: 23 }];
    return {
      photos: samples.map(([x, y, z]) => {
        const location = mapPhotoLocation({ ...base, x, y, z });
        return { center: location.center, bounds: location.bounds, footprint: location.footprint,
          points: pixels.map(([px, py]) => location.pointAt(px, py)),
          clamped: [location.pointAt(-20, -40), location.pointAt(300, 400)] };
      }),
      rejected: invalid.map(tile => { try { mapPhotoLocation(tile); return false; } catch { return true; } }),
    };
  }, { samples, pixels, id: collection.id });
  expect(result.rejected).toEqual(Array(10).fill(true));
  const extent = 20037508.342789244;
  samples.forEach(([x, y, z], index) => {
    const photo = result.photos[index];
    expect(photo.bounds[2] - photo.bounds[0]).toBeCloseTo(360 / 2 ** z, 8);
    for (const [pointIndex, [px, py]] of pixels.entries()) {
      const [lon, lat] = proj4('EPSG:3857', 'EPSG:4326', [
        -extent + (x + px / 256) * extent * 2 / 2 ** z,
        extent - (y + py / 256) * extent * 2 / 2 ** z,
      ]);
      const actual = photo.points[pointIndex];
      expect(actual[0]).toBeCloseTo(lat, 8);
      // -180° and +180° are the same meridian. PROJ can round the latter
      // just past 180°, so compare their shortest angular separation.
      const longitudeError = Math.abs(actual[1] - lon) % 360;
      expect(Math.min(longitudeError, 360 - longitudeError)).toBeLessThan(1e-8);
      if (pointIndex < 4) {
        expect(photo.footprint[pointIndex][0]).toBeCloseTo(lat, 8);
        expect(photo.footprint[pointIndex][1]).toBeCloseTo(lon, 8);
      }
    }
    expect(photo.center).toEqual(photo.points[5]);
    expect(photo.clamped).toEqual([photo.points[0], photo.points[2]]);
    expect(photo.bounds).toEqual([
      photo.footprint[0][1], photo.footprint[2][0], photo.footprint[2][1], photo.footprint[0][0],
    ]);
  });
});

for (const fixture of fixtures) {
  test(`photo pixel coordinates agree with independent PROJ reference: ${fixture.region}`, async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async f => {
      const moduleUrl = '/src/scene-georeference.ts';
      const { readSceneGrid, photoProjection } = await import(moduleUrl);
      const projection = photoProjection(readSceneGrid(f.metadata, f.itemId), f);
      return {
        points: f.points.map((p: { pixel: number[] }) => projection.geographic(...p.pixel)),
        bounds: projection.bounds,
      };
    }, fixture);
    fixture.points.forEach((point: { lonLat: number[] }, i: number) => {
      expect(result.points[i][0]).toBeCloseTo(point.lonLat[0], 7);
      expect(result.points[i][1]).toBeCloseTo(point.lonLat[1], 7);
    });
    expect(result.bounds[2] - result.bounds[0]).toBeLessThan(5);
    expect(result.bounds[3] - result.bounds[1]).toBeLessThan(2);
  });
}

test('invalid location metadata is rejected and dateline crops keep a local extent', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async f => {
    const moduleUrl = '/src/scene-georeference.ts';
    const { readSceneGrid, photoProjection } = await import(moduleUrl);
    const rejects = [];
    const invalid = [
      { ...f.metadata, id: 'another-scene' },
      { ...f.metadata, properties: {} },
      { ...f.metadata, assets: {} },
      { ...f.metadata, assets: { visual: { 'proj:shape': [10980, 10980], 'proj:transform': [0, 0, 0, 0, 0, 0] } } },
    ];
    for (const item of invalid) {
      try { readSceneGrid(item, f.itemId); rejects.push(false); } catch { rejects.push(true); }
    }
    const grid = { epsg: 32660, shape: [10980, 10980], transform: [10, 0, 700000, 0, -10, 7600020] };
    const projection = photoProjection(grid, { thumbnailDimensions: [343, 343], cropPixels: [0, 0, 340, 340] });
    return { rejects, bounds: projection.bounds, center: projection.geographic(170, 170) };
  }, fixtures[0]);
  expect(result.rejects).toEqual([true, true, true, true]);
  expect(result.bounds[2] - result.bounds[0]).toBeLessThan(4);
  // This UTM tile crosses 180 degrees. Its camera extent must stay in one world.
  expect(result.bounds[0]).toBeGreaterThan(180);
  expect(result.bounds[2]).toBeLessThan(186);
  expect(result.center[1]).toBeGreaterThan(67);
});
